// v0.5.0-D 第10轮 revert: 删 splitMessageContentIntoStep + stripLeadingUserEcho 整套函数.
//   用户反馈 9 轮 filter 迭代原地打转 (D194 起 每轮加规则漏 case), text-based echo
//   filter 不可靠 (model 复读有空格/标点/重复/无标点变体). 改回 v0.5.0-PR3 简单 append
//   (在 message_update 块直接 assistant.content += ame.delta + step.stepText += ame.delta).
//   真正 fix 在 sidecar system prompt + model 选择层, 不在 chat store 文本层.

/**
 * Chat store — 真实 session 消息管理 (Phase 3 v0.3.2+)
 *
 * 数据: messagesBySession[sessionId] = { messages, thinking, toolCalls }
 * 持久化: localStorage `pi-agent:chat:v1`
 * 跟 session store 联动: session 删除时清 messages
 *
 * v0.3.5+ sendPrompt(content) — 不再要求调用方传 sessionId.
 * - 有 active session → 直接发
 * - 没 active session → 自动确保有 workspace (没就 picker), 新建 session, 再发
 *
 * v0.6.0 Phase 6: autoTitle ghost prompt (first message trigger).
 *   - sendPrompt 检测 first message (新建 session 或 0 messages + 无 autoTitle + title 默认)
 *   - fire-and-forget 触发 triggerGhostTitlePrompt, 内部 spawn 独立 sidecar (ghostSessionId
 *     = `__ghost_<mainId>__<ts>__`), 走同样 LLM 跑"生成 title" prompt
 *   - ghost sidecar 创建独立 jsonl, 主 session history 不受影响 (等价"sidecar skips append")
 *   - LLM 返的 title 经 cleanGhostTitle 清洗 → session.setAutoTitle
 *   - ghostTriggeredForSession Set 防重 (retry / 重新 sendPrompt 不再触发)
 *   - 失败 (网络/timeout/空 title) 不抛, 仅 log warn
 */
import { defineStore } from 'pinia';
import { ref, watch } from 'vue';
import type { ChatMessage, ThinkingBlock, ToolCallBlock, Step } from '@/lib/mock/types';
import { piTauri } from '@/lib/tauri';
import { useConfigStore } from './config';
import { useSessionStore } from './session';
import { useUiStore } from './ui';
import { useSkillsStore } from './skills';
import { estimateTokens } from '@/lib/tokenEstimate';
import type { ContextBreakdown, ContextBreakdownReal } from '@/lib/tokenEstimate';

export type { ChatMessage, ThinkingBlock, ToolCallBlock, Step };

// ===== Helper types & functions (session data shape) =====
interface SessionChatData {
  messages: ChatMessage[];
  thinking: ThinkingBlock[];
  toolCalls: ToolCallBlock[];
}

const STORAGE_KEY = 'pi-agent:chat:v1';

function loadFromStorage(): Record<string, SessionChatData> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    return parsed as Record<string, SessionChatData>;
  } catch {
    return {};
  }
}

function saveToStorage(data: Record<string, SessionChatData>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (e) {
    console.warn('[chat] localStorage save failed', e);
  }
}

function genMessageId(role: 'u' | 'a'): string {
  return `msg-${Date.now()}-${role}`;
}

function emptySessionData(): SessionChatData {
  return { messages: [], thinking: [], toolCalls: [] };
}

export const useChatStore = defineStore('chat', () => {
  const sessionStore = useSessionStore();
  const configStore = useConfigStore();  // v0.4.4.6: getContextWindow 读 activeModel.contextWindow
  const initial = loadFromStorage();

  // 清理已删除 session 的 messages (在 session 列表初始化后)
  function pruneOrphanedMessages() {
    const validIds = new Set(sessionStore.sessions.map((s) => s.id));
    let changed = false;
    const cleaned: Record<string, SessionChatData> = {};
    for (const [id, data] of Object.entries(initial)) {
      if (validIds.has(id)) {
        cleaned[id] = data;
      } else {
        changed = true;
      }
    }
    return changed ? cleaned : initial;
  }
  const data = pruneOrphanedMessages();
  const chatData = ref<Record<string, SessionChatData>>(data);

  // 持久化
  watch(
    chatData,
    (v) => saveToStorage(v),
    { deep: true },
  );

  // 监听 session 删除, 同步删 messages
  watch(
    () => sessionStore.sessions.map((s) => s.id),
    (ids) => {
      const idSet = new Set(ids);
      let changed = false;
      const next = { ...chatData.value };
      for (const k of Object.keys(next)) {
        if (!idSet.has(k)) {
          delete next[k];
          changed = true;
        }
      }
      if (changed) chatData.value = next;
    },
  );

  // v0.4.4.6: 同步删除 session 时清理对应的 usage (避免 localStorage 越积越多)
  watch(
    () => sessionStore.sessions.map((s) => s.id),
    (ids) => {
      const idSet = new Set(ids);
      let usageChanged = false;
      const nextUsage = { ...lastUsageBySession.value };
      const nextCtx = { ...contextTokensBySession.value };
      for (const k of Object.keys(nextUsage)) {
        if (!idSet.has(k)) { delete nextUsage[k]; usageChanged = true; }
      }
      for (const k of Object.keys(nextCtx)) {
        if (!idSet.has(k)) { delete nextCtx[k]; usageChanged = true; }
      }
      if (usageChanged) {
        lastUsageBySession.value = nextUsage;
        contextTokensBySession.value = nextCtx;
      }
      // 2026-08-20 P0-1 补充 A: 同步清孤儿 send queue (防内存泄漏).
      //   session 删了但队列残留 → 永远取不出来,纯浪费内存. 跟 messages / usage 同 pattern.
      const nextQueue = { ...sendQueueBySession.value };
      let queueChanged = false;
      for (const k of Object.keys(nextQueue)) {
        if (!idSet.has(k)) { delete nextQueue[k]; queueChanged = true; }
      }
      if (queueChanged) {
        sendQueueBySession.value = nextQueue;
        console.log('[chat] sendQueueBySession pruned: removed queues for deleted sessions');
      }
    },
  );

  // ===== Getters =====
  function getSessionData(sessionId: string): SessionChatData {
    return chatData.value[sessionId] ?? emptySessionData();
  }
  function getMessages(sessionId: string): ChatMessage[] {
    return getSessionData(sessionId).messages;
  }
  function getThinking(sessionId: string): ThinkingBlock[] {
    return getSessionData(sessionId).thinking;
  }
  function getToolCalls(sessionId: string): ToolCallBlock[] {
    return getSessionData(sessionId).toolCalls;
  }
  function isStreaming(sessionId: string): boolean {
    return !!streamingBySession.value[sessionId];
  }
  function getError(sessionId: string): string | null {
    return errorBySession.value[sessionId] ?? null;
  }

  // ===== Streaming state =====
  const streamingBySession = ref<Record<string, boolean>>({});
  const errorBySession = ref<Record<string, string | null>>({});
  // 2026-08-20 P0-1 补充 A: send queue (per-session FIFO, 多消息支持)
  // 业务约束: 用户在 LLM 还在回的时候可以继续编辑+点 send, 但不能再 spawn 一个 sidecar (状态机冲突),
  //   所以消息先进队, 等当前 turn 走完 (agent_end willRetry=false) 再自动出队发送.
  // 设计选择: 不在内存里限上限 (用户连发 100 条也允许), session 切换 / force stop 都不清空 (用户随时能看到).
  //   session 删除 (removeSession) 才清队列, 防内存泄漏.
  const sendQueueBySession = ref<Record<string, string[]>>({});

  /** 取某 session 队列长度, UI 用来显示 "队列中 N 条" 徽标. */
  function getQueueLength(sessionId: string): number {
    return sendQueueBySession.value[sessionId]?.length ?? 0;
  }

  /** 清空某 session 队列. 用户在 Composer 队列气泡上点 × 调. */
  function clearSendQueue(sessionId: string) {
    if (!sendQueueBySession.value[sessionId]?.length) return;
    sendQueueBySession.value = { ...sendQueueBySession.value, [sessionId]: [] };
    console.log('[chat] clearSendQueue: session=', sessionId);
  }

  /** 删队列里某条 (按 index). 用户点队列气泡里某条 × 调. */
  function removeFromQueue(sessionId: string, index: number) {
    const list = sendQueueBySession.value[sessionId];
    if (!list || index < 0 || index >= list.length) return;
    const next = list.filter((_, i) => i !== index);
    sendQueueBySession.value = { ...sendQueueBySession.value, [sessionId]: next };
    console.log('[chat] removeFromQueue: session=', sessionId, 'index=', index, 'remaining=', next.length);
  }
  // v0.4.2+ LLM 错误重试: retryBySession 记录当前 retry 状态 (attempt 进度 + 上次错误)
  // FE UI 可以根据这个显示"重试中 1/5..."提示
  const retryBySession = ref<Record<string, { attempt: number; maxAttempts: number; errorMessage: string } | null>>({});
  // v0.5.0-D 第23轮 (D210): FE 端 auto-retry
  //   之前 (D209): stream hang 30s → force stop streaming → user 看横线手动重发
  //   user 反馈 (D210): "发送消息后 LLM 异常后, 不会主动重试发送, 会一直卡着"
  //   修法: FE 主动检测 LLM 异常 (stream hang + 空 response), 自动重发 last user msg 1 次
  //   Pi SDK 内部 retry 不可靠 (不 emit auto_retry_start events, user 看不到进度),
  //   FE 端重发可控、可视化、有上限 (防 spam).
  //   autoRetryCountBySession: 每个 session 计数, user 新发消息时清零 (允许再次 auto-retry)
  const autoRetryCountBySession = ref<Record<string, number>>({});
  // v0.5.0-D 第17轮 (D204): stream hang detector — 30s 无事件 + 仍 isStreaming → 标 hang
  //   替代 D200/D202/D203 的 emptyResponse 主动告警 (那个有 false positive: model 合法的空 message)
  //   这个是真正兜底: 只有 stream 真的 hang 住 (没新事件, 也等不到 agent_end) 才告警
  //   UI 在 chat 区域显示横线 (不是 popup), user 自行决定重发
  const streamHangBySession = ref<Record<string, boolean>>({});
  const lastStreamEventAt = new Map<string, number>();
  const streamHangTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // v0.5.0-D 第25轮 (D210.2) BUG FIX: listener off 函数 Map
  //   之前 sendPrompt 创建的 listener (const off = await piTauri.on(...)) 是 local 变量,
  //   sendPrompt 返回后 off 函数就丢了. agent_end willRetry=true 分支不调 off (因为它要
  //   继续等 Pi SDK 内部 retry 的 events), 但这样就再也没机会调 off() 了 — 下次 sendPrompt
  //   又调 piTauri.on() 加新 listener, 老 listener 一直活着. 多次 retry 后 N 个老 listener
  //   都活着, 每个事件被处理 N 次.
  //   修法: Map 跟踪 off 函数, sendPrompt 进来前 + watchdog force stop 时 + agent_end
  //   willRetry=false (正常收尾) 都调 cleanupListenerForSession 清掉.
  const listenerOffBySession = new Map<string, () => void>();
  function cleanupListenerForSession(sessionId: string) {
    const off = listenerOffBySession.get(sessionId);
    if (off) {
      try { off(); } catch (e) { console.warn('[chat] D210.2: listener off() failed (ignored)', e); }
      listenerOffBySession.delete(sessionId);
    }
  }
  const STREAM_HANG_TIMEOUT_MS = 30_000;
  function touchStreamEvent(sessionId: string) {
    lastStreamEventAt.set(sessionId, Date.now());
  }
  // ====== v0.5.0-D 第26轮 (D210.3) BUG FIX: compaction 事件 helper
  //   之前 compaction_start / compaction_end 的处理逻辑全部内联在 sendPrompt 创建的
  //   listener 闭包里. 但 compact() 不创建 listener (它直接调 piTauri.compactSession
  //   spawn 一个独立 sidecar 跑 compact, 跟 sendPrompt 的 sidecar 没关系), 所以
  //   compaction 事件 emit 出来没人接, UI 永远卡在"压缩中...", divider 也插不进来.
  //   修法: 把 compaction 事件处理逻辑提到 helper 函数, sendPrompt listener + compact()
  //   临时 listener 都调它. 临时 listener 在 compact() 开始时注册, 收到 compaction_end
  //   后自动 unregister.
  function handleCompactionStart(sessionId: string, event: { reason: string }) {
    console.log(`[chat] compaction_start: reason=${event.reason} (session=${sessionId})`);
    compactionBySession.value = { ...compactionBySession.value, [sessionId]: 'in_progress' };
  }
  function handleCompactionEnd(sessionId: string, event: {
    reason: string;
    aborted: boolean;
    willRetry: boolean;
    errorMessage?: string;
  }) {
    console.log(`[chat] compaction_end: reason=${event.reason} aborted=${event.aborted} willRetry=${event.willRetry}${event.errorMessage ? ', err=' + event.errorMessage.slice(0, 80) : ''} (session=${sessionId})`);
    compactionBySession.value = { ...compactionBySession.value, [sessionId]: 'idle' };
    lastCompactionBySession.value = {
      ...lastCompactionBySession.value,
      [sessionId]: {
        reason: event.reason as 'manual' | 'threshold' | 'overflow',
        aborted: event.aborted,
        willRetry: event.willRetry,
        errorMessage: event.errorMessage,
        at: Date.now(),
      },
    };
    // v0.5.0-D 第22轮 (D209): 压缩成功时重置累加的 token count
    if (!event.aborted && !event.errorMessage) {
      cumulativeUsageBySession.value = {
        ...cumulativeUsageBySession.value,
        [sessionId]: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      };
      contextTokensBySession.value = {
        ...contextTokensBySession.value,
        [sessionId]: 0,
      };
      console.log(`[chat] compaction_end: reset cumulative usage (compaction freed context)`);
    }
    // v0.5.0-D 第27轮 (D210.4) 改 UX: 不再用 toast 弹窗, 全部走分隔线
    //   user 反馈: "压缩失败要在上面提示, 包括压缩进行中都不要通过弹窗形式提示,
    //   而是统一使用分隔线的形式, 做的整体一些"
    //   修法: 找到最近一条 in_progress 的 compactionMarker system message,
    //   更新成 success / failure (在原地更新, 不 push 新消息, 避免累积多个 divider)
    const d2 = getSessionData(sessionId);
    if (d2) {
      // 找最近一条 in_progress 的 marker (从尾部向前找, 通常就是最后一条 system)
      let updateIdx = -1;
      for (let i = d2.messages.length - 1; i >= 0; i--) {
        const m = d2.messages[i];
        if (m.role === 'system' && m.compactionMarker && m.compactionMarker.state === 'in_progress') {
          updateIdx = i;
          break;
        }
      }
      // 状态判断: aborted 或 errorMessage → failure, 否则 success
      const finalState: 'success' | 'failure' = (event.aborted || event.errorMessage) ? 'failure' : 'success';
      const errorMessage = event.errorMessage || (event.aborted ? '压缩已中止' : undefined);
      if (updateIdx >= 0) {
        // 原地更新 marker (不要 push 新消息)
        d2.messages[updateIdx] = {
          ...d2.messages[updateIdx],
          compactionMarker: { state: finalState, errorMessage },
        };
        console.log(`[chat] compaction divider updated: in_progress → ${finalState}${errorMessage ? ' (' + errorMessage.slice(0, 60) + ')' : ''}`);
      } else {
        // 兜底: 找不到 in_progress marker (Pi SDK 内部自动 compaction, 没经过 compact()
        // 推过 in_progress), 直接 push 一条 success / failure
        d2.messages.push({
          id: `sys-compact-${Date.now()}`,
          role: 'system',
          content: '__COMPACTION_DIVIDER__',
          createdAt: new Date().toISOString(),
          compactionMarker: { state: finalState, errorMessage },
        } as ChatMessage);
        console.log(`[chat] compaction divider pushed (no in_progress found, push ${finalState})`);
      }
      chatData.value = { ...chatData.value, [sessionId]: { ...d2 } };
    }
  }
  // v0.5.0-D 第29轮 (D212): LLM 异常错误分界线 helper
  //   抽取出来让 message_end (LLM error) + 顶层 error 事件 (Rust 端 error) 都调,
  //   行为一致: 防重复 push + 同步更新 errorBySession.
  //   跟 handleCompactionStart/End 一样的 helper 模式, 避免 sendPrompt listener 闭包
  //   里重复逻辑.
  function pushErrorDivider(
    sessionId: string,
    errorMessage: string,
    reason: 'message_end_stop_reason_error' | 'agent_end_no_retry' | 'rust_error',
    hasPartialContent: boolean,
  ) {
    const d = getSessionData(sessionId);
    if (!d) return;
    // 防重复: 检查最后一条 system message 是否已经是 errorMarker
    //   场景: message_end 推了 error divider, 后续顶层 error 事件又来, 不再 push
    const lastMsg = d.messages[d.messages.length - 1];
    if (lastMsg && lastMsg.role === 'system' && lastMsg.errorMarker) {
      console.log(`[chat] D212: skip error divider (already pushed: ${lastMsg.errorMarker.errorMessage.slice(0, 60)})`);
      return;
    }
    // v0.6.1: 把 raw 429 / TPM 错误转成中文友好提示
    const friendly = friendlyErrorMessage(errorMessage);
    d.messages.push({
      id: `sys-error-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      role: 'system',
      content: '__LLM_ERROR_DIVIDER__',
      createdAt: new Date().toISOString(),
      errorMarker: {
        errorMessage: friendly,
        reason,
        at: Date.now(),
        hasPartialContent,
      },
    } as ChatMessage);
    chatData.value = { ...chatData.value, [sessionId]: { ...d } };
    errorBySession.value = { ...errorBySession.value, [sessionId]: friendly };
    console.log(
      `[chat] D212: error divider pushed (reason=${reason}, hasPartialContent=${hasPartialContent}, ` +
      `errorMessage=${errorMessage.slice(0, 80)})`
    );
  }

  /**
   * v0.6.1: 把 provider 的 raw 错误转成 user 友好的中文提示.
   * 当前支持:
   *   - 429 / "rate limit" / "tpm" / "quota" / "tokens per minute" → 限流提示
   *   - 其他原样返回
   * 后续可以扩展 (401 → keychain 失效, 5xx → 服务异常 等)
   */
  function friendlyErrorMessage(raw: string): string {
    const lower = raw.toLowerCase();
    if (lower.includes('429') ||
        lower.includes('rate limit') ||
        lower.includes('rate_limit') ||
        lower.includes('tpm') ||
        lower.includes('tokens per minute') ||
        lower.includes('quota')) {
      return `LLM 限流 (429: TPM/Quota 触发). 可能原因: \n` +
             `  • provider 免费层 TPM 配额较小, 当前会话累计 token 已超\n` +
             `  • 1 分钟内重新发送会自动恢复\n` +
             `  • 长 session 历史会占 token, 建议开新 session 或压缩 (右上角 \n` +
             `\n原始错误: ${raw.slice(0, 200)}`;
    }
    return raw;
  }
  function startStreamHangWatchdog(sessionId: string): ReturnType<typeof setTimeout> {
    stopStreamHangWatchdog(sessionId);
    const timer = setTimeout(() => {
      // 30s 没事件 + 仍 isStreaming → 标 hang + force stop streaming
      // v0.5.0-D 第22轮 (D209) BUG FIX: 之前只 set streamHang=true + 等 user × 关
      //   但 isStreaming 仍 true, retry banner 还挂着 (willRetry=true 卡住), user 看到
      //   "等待 LLM 重试中..." 一直不消失, 也无法发新消息
      //   修法: 30s 无事件兜底时, 强制 force stop streaming (跟 forceStopStreaming 一样
      //   清理 streaming + retry + active step), 跟 Composer.stop() 30s timeout 行为一致.
      //   UI: 触发后会显示 stream hang error line, user 可以在 composer 重发或换 model
      //   v0.5.0-D 第23轮 (D210) 增强: force stop 后立即触发 tryAutoRetry
      //     如果最新 assistant message 是空的 (LLM 完全没产出), FE 主动重发 last user msg 1 次
      //     user 反馈 "LLM 异常后, 不会主动重试发送, 会一直卡着" → 让 FE 主动 resend
      //     Pi SDK 内部 retry 不可靠 (不 emit events), FE 端重发可控 + 有上限 (max 1)
      const last = lastStreamEventAt.get(sessionId) || 0;
      const stillStreaming = !!streamingBySession.value[sessionId];
      if (stillStreaming && Date.now() - last >= STREAM_HANG_TIMEOUT_MS) {
        streamHangBySession.value = { ...streamHangBySession.value, [sessionId]: true };
        // D209: 强制 force stop, 跟 Composer.stop() 30s timeout 一样的清理路径
        //   跟 willRetry stuck 场景特别相关 — 之前只 set 标记, retry banner 一直挂着
        streamingBySession.value = { ...streamingBySession.value, [sessionId]: false };
        retryBySession.value = { ...retryBySession.value, [sessionId]: null };
        setPhase(sessionId, 'idle');
        // v0.5.0-D 第25轮 (D210.2) BUG FIX: 清理老 listener
        //   agent_end willRetry=true 分支不调 off() (要继续等 Pi SDK 内部 retry events),
        //   30s 兜底时 watchdog 调 cleanupListenerForSession 把老 listener 清掉,
        //   然后 tryAutoRetry 的 sendPrompt 会再加新的. 不清的话老 listener 活着,
        //   后面 sendPrompt 进来前 cleanupListenerForSession 也会清, 但中间窗口老 listener
        //   还会接到新 events (如果 sidecar 还活着发的话) 造成重复处理.
        cleanupListenerForSession(sessionId);
        // 关 active step (跟 forceStopStreaming 一样, 不动已累积的 thinking/text)
        const d2 = getSessionData(sessionId);
        if (d2) {
          const assistant = d2.messages[d2.messages.length - 1];
          if (assistant && assistant.role === 'assistant' && assistant.steps) {
            const lastStep = assistant.steps[assistant.steps.length - 1];
            if (lastStep && lastStep.isActive) {
              lastStep.isActive = false;
              lastStep.collapsed = true;
            }
          }
          chatData.value = { ...chatData.value, [sessionId]: { ...d2 } };
        }
        console.warn(
          `[chat] D209: stream hang detected for ${sessionId} (no events for ${STREAM_HANG_TIMEOUT_MS}ms). ` +
          `Force stopped streaming (was willRetry: ${!!retryBySession.value[sessionId]} — cleared). ` +
          `UI shows inline error line. User can re-send or switch model.`,
        );
        // D210: 同步触发 tryAutoRetry (会检查空 message, 决定是否真重发)
        //   注意: tryAutoRetry 是 async, 但这里不 await — 立即返回, 不阻塞 watchdog timer
        tryAutoRetry(sessionId).catch((e) => {
          console.warn('[chat] D210: tryAutoRetry failed (ignored)', e);
        });
      }
    }, STREAM_HANG_TIMEOUT_MS);
    streamHangTimers.set(sessionId, timer);
    return timer;
  }
  function stopStreamHangWatchdog(sessionId: string) {
    const t = streamHangTimers.get(sessionId);
    if (t) {
      clearTimeout(t);
      streamHangTimers.delete(sessionId);
    }
  }
  // v0.5.0-D 第12轮: 引用回复 (quote & reply)
  //   user 在 assistant 消息点 "引用" button → quoteBySession[sid] 存一条引用.
  //   Composer 显示引用预览, 发送时自动把引用作为 markdown blockquote 前缀拼到 user message.
  //   spec: 🟡 引用回复 (拖选消息 → 插入到 composer). v1 实现: 整个 message body 引用 (D198)
  //   后续可加 "选中文字 → 引用部分文字" (用 window.getSelection() 拿选中范围).
  const quoteBySession = ref<Record<string, { messageId: string; content: string; createdAt: number } | null>>({});
  function setQuote(sessionId: string, quote: { messageId: string; content: string } | null) {
    if (!quote) {
      const { [sessionId]: _, ...rest } = quoteBySession.value;
      quoteBySession.value = { ...rest, [sessionId]: null };
      return;
    }
    quoteBySession.value = {
      ...quoteBySession.value,
      [sessionId]: { ...quote, createdAt: Date.now() },
    };
  }
  function clearQuote(sessionId: string) {
    setQuote(sessionId, null);
  }
  // v0.6+ 文件引用 (file reference) — sidebar 文件树点文件 → 加到 pending refs.
  //   跟 quote 的区别: quote 是引用历史消息, file ref 是引用 workspace 里的文件路径.
  //   发送时: 把所有 pending refs 作为 markdown code block 前缀拼到 user message.
  //   per-session 存储 (切 session 不丢, 跟 quote 一致).
  //   UI 行为: Composer 渲染成可删除的 chip, sendPrompt 后清空 (跟 quote 一致).
  const fileRefsBySession = ref<Record<string, Array<{ path: string; name: string; addedAt: number }>>>({});
  function addFileRef(sessionId: string, ref: { path: string; name: string }) {
    const list = fileRefsBySession.value[sessionId] ?? [];
    // 同 path 重复不加
    if (list.some((r) => r.path === ref.path)) return;
    fileRefsBySession.value = {
      ...fileRefsBySession.value,
      [sessionId]: [...list, { ...ref, addedAt: Date.now() }],
    };
  }
  function removeFileRef(sessionId: string, path: string) {
    const list = fileRefsBySession.value[sessionId] ?? [];
    fileRefsBySession.value = {
      ...fileRefsBySession.value,
      [sessionId]: list.filter((r) => r.path !== path),
    };
  }
  function clearFileRefs(sessionId: string) {
    fileRefsBySession.value = {
      ...fileRefsBySession.value,
      [sessionId]: [],
    };
  }
  // v0.5.1: 当前 phase (thinking / text / tool / idle) — 用来在 streaming 状态
  //   显示 "思考中…" / "正在下笔…" / "调用工具…" 等不同文字, 文字轮换 (每 1.8s 换一次).
  //   用户反馈 "实际当前任务还在后台继续跑, 但是因为是一段一段回复的, 正文可能有多条,
  //   导致看起来像是卡了, 需要加适当的提示icon动画, 表示当前是在走的"
  const phaseBySession = ref<Record<string, 'idle' | 'thinking' | 'text' | 'tool'>>({});
  function setPhase(sessionId: string, phase: 'idle' | 'thinking' | 'text' | 'tool') {
    if (phaseBySession.value[sessionId] === phase) return;
    phaseBySession.value = { ...phaseBySession.value, [sessionId]: phase };
  }
  function getPhase(sessionId: string): 'idle' | 'thinking' | 'text' | 'tool' {
    return phaseBySession.value[sessionId] ?? 'idle';
  }

  // v0.4.3: context window 占用跟踪 + compaction 状态
  // - lastUsageBySession[sessionId] = Pi SDK AgentMessageLite.usage (上次 assistant 消息的 cumulative usage)
  // - contextTokensBySession[sessionId] = lastUsage.input + lastUsage.cacheRead (LLM 实际看到的 context size)
  // - compactionBySession[sessionId] = 'idle' | 'in_progress' (Pi SDK 5x 报告的 compaction 状态)
  // - lastCompactionBySession[sessionId] = { reason, aborted, willRetry, errorMessage, at } (最近一次结果)
  //
  // UI 怎么用:
  // - Composer 显示 "12.5K / 200K" (contextTokens / contextWindow)
  // - contextTokens 超过 ~70% contextWindow 时高亮 "压缩" 按钮
  // - 手动点 "压缩" → compact(sessionId) → sendRpcCommand({ type: 'compact' })
  // - Pi SDK emit compaction_start → 按钮变 "压缩中..." (spinner)
  // - Pi SDK emit compaction_end → 按钮恢复, lastCompaction 更新 (用于 toast "压缩成功, 节省 X tokens")
  //
  // v0.4.4.6: 持久化 lastUsageBySession / contextTokensBySession 到 localStorage
  //   修 user 反馈: 重启 .exe 后 contextTokens 从 0 开始, 不显示之前的用量
  //   只持久化 lastUsage (够恢复 contextTokens, 后者能从 lastUsage.input+cacheRead 重算)
  //   compaction 状态不持久化 (重启时所有 session 都视作 idle, 是合理默认)
  const USAGE_STORAGE_KEY = 'pi-agent:usage:v1';
  function loadUsageFromStorage(): {
    lastUsage: Record<string, import('@/lib/mock/types').MessageUsage | undefined>;
    contextTokens: Record<string, number>;
  } {
    try {
      const raw = localStorage.getItem(USAGE_STORAGE_KEY);
      if (!raw) return { lastUsage: {}, contextTokens: {} };
      const parsed = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) return { lastUsage: {}, contextTokens: {} };
      return {
        lastUsage: (parsed.lastUsage ?? {}) as Record<string, import('@/lib/mock/types').MessageUsage | undefined>,
        contextTokens: (parsed.contextTokens ?? {}) as Record<string, number>,
      };
    } catch {
      return { lastUsage: {}, contextTokens: {} };
    }
  }
  function saveUsageToStorage(lastUsage: Record<string, import('@/lib/mock/types').MessageUsage | undefined>, contextTokens: Record<string, number>) {
    try {
      // 不持久化 compaction 状态 (in_progress 重启后归零, 是合理默认)
      localStorage.setItem(USAGE_STORAGE_KEY, JSON.stringify({ lastUsage, contextTokens }));
    } catch (e) {
      console.warn('[chat] usage localStorage save failed', e);
    }
  }
  // v0.5.0-D 第22轮 (D209): 累加 usage 持久化
  //   cumulativeUsageBySession 也存 localStorage, 跨 session 也能恢复累加数字
  function loadCumulativeFromStorage(): Record<string, import('@/lib/mock/types').MessageUsage> {
    try {
      const raw = localStorage.getItem('pi-agent:cumulative-usage:v1');
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) return {};
      return parsed as Record<string, import('@/lib/mock/types').MessageUsage>;
    } catch {
      return {};
    }
  }
  function saveCumulativeToStorage(cumulative: Record<string, import('@/lib/mock/types').MessageUsage>) {
    try {
      localStorage.setItem('pi-agent:cumulative-usage:v1', JSON.stringify(cumulative));
    } catch (e) {
      console.warn('[chat] cumulative usage localStorage save failed', e);
    }
  }
  const usageInitial = loadUsageFromStorage();
  const lastUsageBySession = ref<Record<string, import('@/lib/mock/types').MessageUsage | undefined>>(usageInitial.lastUsage);
  const contextTokensBySession = ref<Record<string, number>>(usageInitial.contextTokens);
  // v0.5.0-D 第22轮 (D209): 累加 usage 跟踪 (跨 turn 求和)
  //   之前 (D208) lastUsageBySession 是覆盖式 (单次 turn), contextTokensBySession 也是
  //   单次 turn 的 input + cacheRead. user 反馈 "上下文窗口的计数应该是累加的,
  //   只有再主动压缩之后, 上下文可能会消减; 而不是每次请求都先清0"
  //   修法: 新加 cumulativeUsageBySession 累加 input/output/cacheRead/cacheWrite 4 字段,
  //   contextTokensBySession 也改成累加 (input + cacheRead 总和).
  //   lastUsageBySession 保留 (per-turn, 调试/单次显示用)
  const cumulativeUsageBySession = ref<Record<string, import('@/lib/mock/types').MessageUsage>>(loadCumulativeFromStorage());
  // watch 持久化 (deep: true 跟踪 ref 内部变化)
  watch(
    [lastUsageBySession, contextTokensBySession],
    ([u, c]) => saveUsageToStorage(u, c),
    { deep: true },
  );
  watch(
    cumulativeUsageBySession,
    (c) => saveCumulativeToStorage(c),
    { deep: true },
  );
  const compactionBySession = ref<Record<string, 'idle' | 'in_progress'>>({});
  const lastCompactionBySession = ref<Record<string, {
    reason: 'manual' | 'threshold' | 'overflow';
    aborted: boolean;
    willRetry: boolean;
    errorMessage?: string;
    at: number;  // Date.now()
  } | undefined>>({});

  // v0.4.3: contextWindow (硬编码 200K, 跟主流 LLM 默认对齐; 后续可走 config)
  // v0.4.4.6: 改从 user 配置的 activeModel.contextWindow 读, 缺省 200K (向后兼容)
  // 之前: 硬编码 200K (跟主流 LLM 默认对齐, 但 user 配小模型时 context % 永远不触发压缩)
  // 现在: user 在 Settings → Provider tab 配 model.contextWindow 后, Composer 显示的
  //   "X.XK / YK" 跟压缩阈值都用 user 配的值.
  // P2 #5 fix: 跟 sidecar/src/index.mjs 的 `mm.contextWindow ?? 200000` 对齐 (之前 128K vs 200K)
  const DEFAULT_CONTEXT_WINDOW = 200_000;

  function getContextTokens(sessionId: string): number {
    return contextTokensBySession.value[sessionId] ?? 0;
  }
  function getContextWindow(): number {
    // v0.4.4.6: 优先读 activeModel.contextWindow, 缺省回退到 200K.
    //   activeModel 来自 configStore.activeProvider?.activeModelId 找到的 model
    //   v0.5.0-D 第21轮 (D208) BUG FIX: 之前用 `??` 只处理 null/undefined, 但 model
    //   配了 contextWindow=0 (Settings 留空 / 导入 / 用户填 0) 时 ?? 不回退, 直接返 0
    //   → contextWindow=0 → percent = tokens/0 = 0% (用户看到的"上下文 0%"现象)
    //   修法: 用 `||` 把 0 也视为 fallback. 任何非正数都回退到 DEFAULT_CONTEXT_WINDOW
    const active = sessionStore.activeSessionId;  // sessionId 不会影响 getContextWindow, 保留为了语义
    void active;
    const activeModel = configStore.activeModel;
    const cw = activeModel?.contextWindow;
    return cw && cw > 0 ? cw : DEFAULT_CONTEXT_WINDOW;
  }
  function isCompacting(sessionId: string): boolean {
    return compactionBySession.value[sessionId] === 'in_progress';
  }
  function getLastCompaction(sessionId: string) {
    return lastCompactionBySession.value[sessionId];
  }
  function isContextHigh(sessionId: string): boolean {
    const tokens = getContextTokens(sessionId);
    return tokens > getContextWindow() * 0.7;
  }

  // ===== v0.5.0-D 第12轮: 6 分类 context breakdown =====
  //  按 token 来源分, 给 ContextIndicator popover 用. 跟 Pi SDK 0.84.2 usage.input
  //  (LLM 端实际) 不同, 这是 FE 端估算, 给用户看"token 都被哪些东西占了"的参考.
  //  精度: rough heuristic, 真实 LLM token 数可能差 10-20%, 但比例趋势对.
  //
  //  6 分类定义 (D198 spec 跟图2):
  //  - 消息: user + assistant 所有 content 累加 (FE 端有完整数据)
  //  - 工具: 7 tool definitions (read/write/edit/bash/ls/find/grep) + Pi SDK 自动 emit
  //    估算 ~800 tokens (7 × 115 字符 / def, 跟 openai function schema 实际字节数接近)
  //  - 系统提示词: Pi SDK base + <context_awareness> + <response_style> (3 段)
  //    估算 ~2500 tokens (实测 sidecar 启动 log: 3 段加起来约 8K 字符, 中文 token 率高)
  //  - 技能: enabled skills 的 SKILL.md content 累加. 0 个 enabled = 0
  //    FE 端从 skills store 拿 enabledByName keys, 估算 "description + body" 字符数
  //  - 记忆: AGENTS.md content. FE 暂未读取 (CustomInstructionsTab 编辑但未入 Pi SDK prompt),
  //    估算 0. 后续可在 chat store 维护 memory 缓存
  //  - 其他: contextTokens - 上 5 项之和 (含 thinking / tool result 残留 / 序列化等)
  const TOOLS_TOKEN_ESTIMATE = 800;
  const SYSTEM_PROMPTS_TOKEN_ESTIMATE = 2500;
  const MEMORY_TOKEN_ESTIMATE = 0;  // FE 暂未读 AGENTS.md
  function getContextBreakdown(sessionId: string): ContextBreakdown {
    const total = getContextTokens(sessionId);
    const data = getSessionData(sessionId);
    // 1. 消息: sum of user + assistant content
    let messagesTokens = 0;
    for (const m of data.messages) {
      const content = m.content || '';
      if (content) messagesTokens += estimateTokens(content);
      // v0.5.0-D 还在 stepText 里: 算上 step text (assistant 主内容), 跟 content 同步
      const steps = (m as any).steps;
      if (Array.isArray(steps)) {
        for (const s of steps) {
          if (s.stepText) messagesTokens += estimateTokens(s.stepText);
        }
      }
    }
    // 2. 工具: 固定估算 (7 tools def)
    const toolsTokens = TOOLS_TOKEN_ESTIMATE;
    // 3. 系统提示词: 固定估算 (base + 2 fragments)
    const systemPromptsTokens = SYSTEM_PROMPTS_TOKEN_ESTIMATE;
    // 4. 技能: enabled skills 的 .md content 估算. 实际 FE 端无 skill content,
    //    用 skills store enabledByName count × 平均 300 tokens / skill (rough).
    //    SkillsTab 里 SKILL.md 通常 100-500 行, 平均 ~300 tokens.
    const skillsStore = useSkillsStore();
    const enabledCount = Object.values(skillsStore.enabledByName).filter(Boolean).length;
    const skillsTokens = enabledCount * 300;
    // 5. 记忆: AGENTS.md 暂估 0
    const memoryTokens = MEMORY_TOKEN_ESTIMATE;
    // 6. 其他: total - 上面 5 项
    const otherTokens = Math.max(0,
      total - messagesTokens - toolsTokens - systemPromptsTokens - skillsTokens - memoryTokens,
    );
    return {
      messages: messagesTokens,
      tools: toolsTokens,
      systemPrompts: systemPromptsTokens,
      skills: skillsTokens,
      memory: memoryTokens,
      other: otherTokens,
    };
  }
  function getContextBreakdownPercent(breakdown: ContextBreakdown): {
    messages: number;
    tools: number;
    systemPrompts: number;
    skills: number;
    memory: number;
    other: number;
  } {
    const sum = breakdown.messages + breakdown.tools + breakdown.systemPrompts
      + breakdown.skills + breakdown.memory + breakdown.other;
    if (sum === 0) {
      return { messages: 0, tools: 0, systemPrompts: 0, skills: 0, memory: 0, other: 0 };
    }
    const pct = (n: number) => Math.round((n / sum) * 1000) / 10;  // 1 位小数
    return {
      messages: pct(breakdown.messages),
      tools: pct(breakdown.tools),
      systemPrompts: pct(breakdown.systemPrompts),
      skills: pct(breakdown.skills),
      memory: pct(breakdown.memory),
      other: pct(breakdown.other),
    };
  }

  // v0.5.0-D 第21轮 (D208) + 第22轮 (D209): Token breakdown REAL 数据 (Pi SDK lastUsage 4 分类)
  //   跟 getContextBreakdown (6 分类 FE 估算) 互补, 都是给 user 看的:
  //   - 6 分类 (FE 估算): "用在哪里" (消息/工具/系统提示词/技能/记忆/其他)
  //   - 4 分类 (REAL): "用多少" (input/output/cacheRead/cacheWrite, LLM 端实测)
  //   D208 加这个是因为 user 反馈: 当前 6 分类是 FE 估算不准, 想看 LLM 端真实数据.
  //   数据源: cumulativeUsageBySession[sid] (D209 累加, 跨 turn 求和)
  //   之前 (D208) 用 lastUsageBySession (per-turn, 每次新 turn 覆盖 → 显示 0)
  //   user 反馈: "上下文窗口的计数应该是累加的" → 改用 cumulativeUsageBySession 累加
  //   缺数据时 (没发过 message): 全 0, UI 兜底显示 "暂无数据"
  function getContextBreakdownReal(sessionId: string): ContextBreakdownReal {
    const usage = cumulativeUsageBySession.value[sessionId];
    if (!usage) {
      return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    }
    return {
      input: usage.input ?? 0,
      output: usage.output ?? 0,
      cacheRead: usage.cacheRead ?? 0,
      cacheWrite: usage.cacheWrite ?? 0,
    };
  }
  function getContextBreakdownRealPercent(real: ContextBreakdownReal): {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  } {
    // 分母用 total (input + output + cacheRead + cacheWrite), 不是仅 context
    //   让 user 看到完整 token 流量分布 (input 是 context, output 是 response,
    //   cacheRead 是命中, cacheWrite 是新写)
    const sum = real.input + real.output + real.cacheRead + real.cacheWrite;
    if (sum === 0) {
      return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    }
    const pct = (n: number) => Math.round((n / sum) * 1000) / 10;
    return {
      input: pct(real.input),
      output: pct(real.output),
      cacheRead: pct(real.cacheRead),
      cacheWrite: pct(real.cacheWrite),
    };
  }

  // ===== Actions ====

  // v0.5.0-D 第19轮 (D206): appendUserMessage 加 quoteContent 参数
  //   当 user 用 quote 功能发消息时, quoteContent 存原始引用文本 (没 `> ` 前缀)
  //   给 ChatMessage 渲染 user 气泡时用 (引用部分 blockquote 样式可视化)
  function appendUserMessage(sessionId: string, content: string, quoteContent: string | null = null) {
    const d = getSessionData(sessionId);
    d.messages.push({
      id: genMessageId('u'),
      role: 'user',
      content,
      quoteContent: quoteContent ?? undefined,
      createdAt: new Date().toISOString(),
    });
    // 触发响应式更新
    chatData.value = { ...chatData.value, [sessionId]: { ...d } };
  }

  function clearSession(sessionId: string) {
    chatData.value = { ...chatData.value, [sessionId]: emptySessionData() };
  }

  /**
   * 发 prompt. v0.3.5+ 自动确保 session 存在.
   * - 有 active session → 直接发
   * - 没 active session + 有 workspace → 新建 session, 再发
   * - 没 workspace → 用 piTauri.ensureDefaultWorkspace() (<home>/PiAgent) 建 workspace + session, 再发
   *   (用户可手动通过 sidebar / tab strip 的"本地"下拉选别的路径)
   */
  async function sendPrompt(content: string, opts: { fromAutoRetry?: boolean; fromQueue?: boolean } = {}) {
    const text = content.trim();
    if (!text) return;
    // 0.3: 切 workspace in-flight 期间拒绝发. sidecar 还没就绪, 发过去会用旧 cwd 写到错位置.
    if (sessionStore.isSwitchingWorkspace) {
      const msg = '[chat] sendPrompt rejected: workspace 切换中, 等切换完成再发';
      console.warn(msg);
      errorBySession.value = { ...errorBySession.value, ['']: '工作区切换中, 请稍候再发' };
      return;
    }
    // 2026-08-20 P0-1 补充 A: streaming 时入队 (不直接发, 避免冲突)
    // 业务: 用户在 LLM 回复中也可以编辑+send, 但要排队. 等当前 turn 走完, agent_end 自动从队列取下一条发.
    // fromQueue=true 时跳过入队判断 (从队列取出来发不能再入队, 死循环).
    // 注意: activeSession 可能为 null (initial hero), 这种情况下 sessionId 后面会创建, sendQueueBySession
    //   按 session 索引, 新 session 创建后 push 到对应 key.
    const targetSessionIdForQueue = sessionStore.activeSessionId;
    if (targetSessionIdForQueue && isStreaming(targetSessionIdForQueue) && !opts.fromQueue) {
      const list = sendQueueBySession.value[targetSessionIdForQueue] ?? [];
      sendQueueBySession.value = {
        ...sendQueueBySession.value,
        [targetSessionIdForQueue]: [...list, text],
      };
      console.log('[chat] sendPrompt: enqueued (streaming), session=', targetSessionIdForQueue, 'queueLen=', list.length + 1, 'preview=', text.slice(0, 40));
      return;
    }
    console.log('[chat] sendPrompt: contentLen=', text.length, 'activeSession=', sessionStore.activeSessionId, 'fromAutoRetry=', !!opts.fromAutoRetry, 'fromQueue=', !!opts.fromQueue);

    // 1. 确保有 active session
    let sessionId = sessionStore.activeSessionId;
    let wasNewlyCreated = false;
    if (!sessionId) {
      let wid = sessionStore.activeWorkspaceId;
      if (!wid || sessionStore.workspaces.length === 0) {
        // 没 workspace: 用默认 C: 盘路径 (e.g. C:\Users\<user>\PiAgent), 不弹 picker
        try {
          const path = await piTauri.ensureDefaultWorkspace();
          console.log('[chat] sendPrompt: using default workspace', path);
          // 0.4: 标记为默认 workspace, UI 徽标 + 删时保护用
          const ws = sessionStore.addWorkspace({ path, isDefault: true });
          wid = ws.id;
        } catch (e) {
          console.error('[chat] sendPrompt: ensureDefaultWorkspace failed', e);
          errorBySession.value = { ...errorBySession.value, ['']: `创建默认工作区失败: ${e}` };
          return;
        }
      }
      const sess = sessionStore.addSession(wid, text.slice(0, 30) || '新任务');
      sessionId = sess.id;
      wasNewlyCreated = true;
      console.log('[chat] sendPrompt: created new session', sessionId);
    }

    // Phase 6: 检测 first message (用于触发 ghost title prompt).
    //   条件: 新建 session 或 (已有 session 但 0 messages) + 没 autoTitle + title 是默认.
    //   ghostTriggeredForSession 防重 (retry / 重新 sendPrompt 不重复触发).
    const sessMeta = sessionStore.sessions.find((s) => s.id === sessionId);
    const isFirstMessageForGhost =
      !opts.fromAutoRetry &&
      (wasNewlyCreated || getMessages(sessionId).length === 0) &&
      !sessMeta?.autoTitle &&
      (!sessMeta?.title || sessMeta.title === '新任务') &&
      text.length >= 4 &&  // 太短的消息 (e.g. "hi") 不值得生成 title
      !ghostTriggeredForSession.has(sessionId);

    // 2. append user msg + streaming marker (assistant placeholder 等 message_start 真的来再 push)
    // v0.5.0-D 第12轮: 引用回复 — 如果有 quote, 把 quote 内容拼到 user message 前面.
    //   v0.5.0-D 第18轮 (D205) SIMPLIFY: 完全去掉结构化标记 (plain text 拼接)
    //   v0.5.0-D 第19轮 (D206) 调整: D205 走过头, 小模型识别不出"哪段是引用"
    //     D206 方案 — 用 markdown blockquote `> ` 标记 (LLM 训练集里大量 markdown, 通用识别):
    //     1. AI 端 fullUserText = "> <quoted content>\n\n<user text>"
    //        (markdown blockquote 语法, 最简结构化标记)
    //     2. store 存的 user message.content = fullUserText (跟 AI 看到的一致)
    //     3. user message.quoteContent = <原始引用文本> (没 `> ` 前缀), 给前端渲染做可视化
    //        (ChatMessage 看到 quoteContent 就把 user 气泡里的引用部分用 blockquote 样式呈现)
    //   不加 [标签] (D201/D203 那种角色标签 — 大模型冗余小模型更乱)
    //   不剥离 <think> (D203 那种 — 副作用多, 改回让 model 看到原文)
    const quote = quoteBySession.value[sessionId];
    let fullUserText = text;
    let quoteContent: string | null = null;
    if (quote && quote.content.trim()) {
      // markdown blockquote 标记: 每行加 "> " 前缀
      //   保留原文 (不剥离 think), model 自己处理
      const quotedLines = quote.content
        .split('\n')
        .map((line) => line.trim() ? `> ${line}` : '>')
        .join('\n');
      fullUserText = `${quotedLines}\n\n${text}`;
      quoteContent = quote.content;
      console.log('[chat] sendPrompt: with quote (messageId=', quote.messageId, ', len=', quote.content.length, ', fullLen=', fullUserText.length, ')');
      // 调试: 打印实际发送的 user message 全文, F12 console 可验证
      console.log('[chat] sendPrompt: fullUserText =\n', fullUserText);
    }
    // v0.6+ 文件引用 (file reference) — sidebar 文件树点文件收集的 refs
    //   拼成 markdown code block 放在 quote 之后, user text 之前. LLM 看到路径能直接 read.
    //   没 quote 时直接拼在最前面. 不引号 quoteContent 单独存 (file refs 不是 "历史消息引用",
    //   是当前 workspace 内的资源; 不需要 ChatMessage 单独 blockquote 样式, markdown 已经够清晰).
    const fileRefs = fileRefsBySession.value[sessionId] ?? [];
    if (fileRefs.length > 0) {
      const refsBlock = fileRefs.map((r) => `\`${r.path}\``).join('\n');
      const refsHeader = '以下文件被引用 (来自当前工作区):';
      if (fullUserText === text) {
        fullUserText = `${refsHeader}\n${refsBlock}\n\n${text}`;
      } else {
        // 有 quote 在前面, refs 插 quote 之后
        const quotedLines = quote!.content
          .split('\n')
          .map((line) => line.trim() ? `> ${line}` : '>')
          .join('\n');
        fullUserText = `${quotedLines}\n\n${refsHeader}\n${refsBlock}\n\n${text}`;
      }
      console.log('[chat] sendPrompt: with fileRefs (count=', fileRefs.length, ', paths=', fileRefs.map((r) => r.path).join(', '), ')');
    }
    appendUserMessage(sessionId, fullUserText, quoteContent);
    streamingBySession.value = { ...streamingBySession.value, [sessionId]: true };
    errorBySession.value = { ...errorBySession.value, [sessionId]: null };
    // v0.5.0-D 第23轮 (D210): user 新发消息 → 清零 auto-retry count
    //   之前失败 + auto-retry 用完的 session, user 主动发新消息 → 允许下次再 auto-retry
    // v0.5.0-D 第25轮 (D210.2) BUG FIX: 只在 user 主动发 (非 auto-retry resend) 时清零.
    //   之前无脑 clearAutoRetryCount, 导致 auto-retry 的 sendPrompt 调 clearAutoRetryCount
    //   把 count 清回 0, 下次 watchdog 触发时 count 还是 0 又能 retry 一次 (无限循环).
    if (!opts.fromAutoRetry) {
      clearAutoRetryCount(sessionId);
    }
    // 引用用完即清, 跟发完就消失的 UX 一致 (避免下次发还残留)
    if (quote) clearQuote(sessionId);
    if (fileRefs.length > 0) clearFileRefs(sessionId);
    // touch session updated time
    sessionStore.touchSession(sessionId);

    // v0.4.7 修 (B 方案实际生效 + 多 turn 不重复 message):
    //   - assistantId 改回 const: 每次 sendPrompt 1 个 id, **整个 agent loop 共用**
    //     (含多 turn / multi message_start). 之前 let + 每次 message_start 重新生成 → 推多个
    //     message + 重复 thinking 区. 改回 const 保证: 同 sendPrompt → 1 个 message + N 个 step.
    //   - placeholder 逻辑大改 (见下面): 只 case 'error' 推 placeholder, 其他 event
    //     (agent_end / message_end) 不推 (它们由 message_start 之后才到, message_start 已
    //     推 message, 不需要 placeholder). 旧逻辑 line 410 if 块同时推 agent_end/message_end
    //     placeholder → 每次 agent_end 都多一个空 message → ChatMessage 渲染"AI 没有回复内容".
    const assistantId = genMessageId('a');

    // 3. 临时 listener (await 确保 listener 起来, 避免 sidecar 早早 emit 丢事件)
    // v0.5.0-D 第17轮 (D204): stream hang detector
    //   track 每 session 最近一次事件时间, 30s 内没事件 + 仍 isStreaming → 标 streamHang=true
    //   UI 在 chat 区域显示横线错误 (不是 popup). 真正的兜底, 替代之前 D200 在 message_end
    //   提前告警的误判.
    streamHangBySession.value = { ...streamHangBySession.value, [sessionId]: false };
    touchStreamEvent(sessionId);
    // 启动 watchdog, timer 句柄存到 streamHangTimers map 统一管理
    // (agent_end / error / forceStopStreaming 调 stopStreamHangWatchdog 清掉)
    startStreamHangWatchdog(sessionId);
    // v0.5.0-D 第25轮 (D210.2) BUG FIX: 清理上一次的 listener
    //   之前 sendPrompt 直接 piTauri.on() 加新 listener, 但 agent_end willRetry=true 分支
    //   return 时不调 off(), 导致上次的 listener 一直活着. 下次 sendPrompt 又加新的, 多次
    //   retry 后老 listener 都活着, 每个事件被处理 N 次 → content 重复 N 次 / cumulative
    //   context 累加 N 次 / user 看到 "重发三次后, 三个同样结果".
    //   修法: listenerOffBySession map 跟踪 off 函数, 新 sendPrompt 进来前先调旧 off()
    //   清理掉. watchdog force stop 时也调 off() 清理老 listener (然后 tryAutoRetry 的
    //   sendPrompt 会再加新的).
    cleanupListenerForSession(sessionId);
    const off = await piTauri.on((event) => {
      // 每个事件到达就 reset watchdog + 清 hang 标记
      // v0.5.0-D 第24轮 (D210.1) BUG FIX: 之前只 touchStreamEvent 记录 lastStreamEventAt 时间戳,
      //   但 startStreamHangWatchdog 里 setTimeout(..., 30_000) 是固定的 30s 后触发 (从
      //   sendPrompt 算起), 不会因为后续事件自动延后. 如果最后事件在 t=5s 到达, timer 在
      //   t=30s 触发, 此时 Date.now() - last = 25s < 30s, 条件不满足, watchdog 直接返回不做事.
      //   user 反馈: "等待 LLM 重试中..." banner 永远挂着, 30s 兜底永不触发.
      //   修法: 每个事件都重新调 startStreamHangWatchdog (stop 旧的 + start 新的 30s timer),
      //   这样 setTimeout 真正每次从最后事件算起 30s, 触发时 Date.now() - last 必 >= 30s.
      //   touchStreamEvent 保留作为 Date.now() - last >= 30s 的 safety net 双重检查.
      touchStreamEvent(sessionId);
      startStreamHangWatchdog(sessionId);
      if (streamHangBySession.value[sessionId]) {
        streamHangBySession.value = { ...streamHangBySession.value, [sessionId]: false };
        chatData.value = { ...chatData.value };  // 触发 UI 更新
      }
      // v0.6.1.1: 抑制高频 event log — `message_update` 在 LLM 流式响应时每 token chunk 触发一次,
      //   一个 turn 经常 20-50 次, 跟 text_delta 类似. 真正调试聊天流应该看 streaming 状态,
      //   不是 console. 关掉这个的 per-event log, 其它事件保留 (message_start / end, turn_start / end,
      //   tool_*, error 等都是有意义的).
      if (event.type !== 'message_update') {
        console.log(
          '[chat] event:',
          event.type,
          'sessionMatch=',
          !('sessionId' in event) || event.sessionId === sessionId,
        );
      }
      if ('sessionId' in event && event.sessionId !== sessionId) return;
      const d2 = getSessionData(sessionId);
      // v0.3.8.12 fix: 之前 `if (idx < 0) return` 在 switch 之前, 导致 message_start
      // 事件永远到不了 case 块 (因为 message_start 时还没 push assistant message, idx=-1).
      // 现在改成: message_start 允许 idx<0 (它负责 push), 其他 case 必须 idx>=0.
      // v0.4.7: assistantId 改回 const (一次 sendPrompt 1 个), 所以 curId = assistantId.
      const curId = assistantId;
      let idx = d2.messages.findIndex((m) => m.id === curId);
      // v0.4.7 placeholder 大改: **只 case 'error' 推 placeholder** (modelRuntime.checkAuth 失败
      //   → session.prompt 抛错 → sidecar emit error, 此时 message_start 没到, 强 push 让
      //   ChatMain error banner 有挂载点). 其他 event (agent_end / message_end) **不** 推
      //   placeholder — 因为它们由 message_start 之后才到, message_start 已 push message.
      //   旧逻辑同时推 agent_end/message_end placeholder → 每次 agent_end 都多 1 个空
      //   message → ChatMessage 渲染"AI 没有回复内容"灰色字 (B 方案失效主因).
      if (idx < 0 && event.type === 'error') {
        d2.messages.push({
          id: curId,
          role: 'assistant',
          content: '',
          createdAt: new Date().toISOString(),
        });
        idx = d2.messages.length - 1;
        console.log(`[chat] pushed placeholder assistant for early ${event.type}`);
      }
      switch (event.type) {
        case 'error':
          // v0.5.0: Rust 端 emit_error 触发的顶层 error 事件 (跟 v0.4.x 兼容)
          // v0.4.2.x fix: 之前 error 跟其他 message_start 后事件分组, 触发 `if (idx < 0) return`
          //   吞掉, 看起来"发送没回复". 拉出来独立处理, 始终 set errorBySession.
          //   placeholder 已经在前面 push 过了 (如果 idx < 0).
          errorBySession.value = { ...errorBySession.value, [sessionId]: event.message };
          streamingBySession.value = { ...streamingBySession.value, [sessionId]: false };
          // v0.5.0-D 第17轮 (D204): 清 stream hang 标记 + 停 watchdog
          stopStreamHangWatchdog(sessionId);
          streamHangBySession.value = { ...streamHangBySession.value, [sessionId]: false };
          // v0.4.2+ 清 retry 状态 (5 次重试都失败, 终态错误)
          retryBySession.value = { ...retryBySession.value, [sessionId]: null };
          // v0.4.2.x fix: 跟 agent_end 一样, 关闭还在 active 的 step
          if (idx >= 0) {
            const assistantMsg = d2.messages[idx];
            if (assistantMsg.steps) {
              const lastStep = assistantMsg.steps[assistantMsg.steps.length - 1];
              if (lastStep && lastStep.isActive) {
                lastStep.isActive = false;
                lastStep.collapsed = true;
              }
            }
          }
          console.error('[chat] error event:', event.message);
          chatData.value = { ...chatData.value, [sessionId]: { ...d2 } };
          // v0.5.0-D 第29轮 (D212): 走分隔线 UX, 不用 toast (跟压缩 D210.4 一致)
          //   推 error divider 替代之前的 showToast, user 一眼看到 chat 流里
          //   哪里失败 + 原因, 不用回忆 toast
          //   pushErrorDivider 内部有防重复 (如果 message_end 已经推过 error divider,
          //   这里 skip 不会重复 push)
          //   Rust 端 error 通常对应 LLM 没真正开始 / spawn 失败 / keychain 错误等
          //   hasPartialContent=false (没 assistant content / thinking / tools)
          pushErrorDivider(
            sessionId,
            event.message,
            'rust_error',
            false,
          );
          off();
          return;
        case 'agent_end':
          // v0.5.0: Pi SDK AgentSessionEvent.agent_end: { messages: AgentMessage[]; willRetry: boolean }
          // 跟 v0.4.x 比, 多了 messages 全量 + willRetry 字段 (v0.4.x 自定义事件)
          // v0.4.6 Bug 修 (willRetry=true 但 UI 显示"AI 没回复"):
          //   Pi SDK 0.84.2 emit agent_end willRetry=true 时, agent loop 还没拿到满意结果, 要 retry.
          //   这种情况下, **保持 streaming=true** (等下次 agent_start), 不要翻 streaming=false 触
          //   发"AI 没回复内容"灰色提示. FE 应该把 willRetry=true 当成"还在重试".
          if (idx >= 0) {
            const assistantMsg = d2.messages[idx];
            if (assistantMsg.steps) {
              const lastStep = assistantMsg.steps[assistantMsg.steps.length - 1];
              if (lastStep && lastStep.isActive) {
                lastStep.isActive = false;
                lastStep.collapsed = true;
              }
            }
          }
          // v0.4.7 willRetry 分支处理: **不要** 兜底设 retryBySession (卡 1/5 根因)
          //   之前 attempt:1 maxAttempts:5 是硬编码, Pi SDK 0.84.2 实际 maxRetries 取决于 settings
          //   (默认不一定是 5), 而且 Pi SDK 内部 retry 不 emit auto_retry_start events → 永远卡 1/5.
          //   修法: willRetry=true 时 **静默** 等下次 agent_start, UI 不显示"X/5 retry"
          //   (auto_retry_start 真 emit 时才设 retryBySession).
          if (event.willRetry) {
            // 保持 streaming=true, 等下次 agent_start / error / agent_end (会 retry 真 emit events)
            // 翻 retryBySession 显示"等待 LLM 重试中..." (无数字, 真 retry emit 才更新)
            retryBySession.value = {
              ...retryBySession.value,
              [sessionId]: retryBySession.value[sessionId] || {
                attempt: 0,
                maxAttempts: 0,  // 0 = 不知道, 等真 retry emit
                errorMessage: 'LLM 内部重试, 等待下次 agent_start',
              },
            };
            chatData.value = { ...chatData.value, [sessionId]: { ...d2 } };
            console.log(
              '[chat] agent_end willRetry=true: 保持 streaming=true, 静默等下次 agent_start / error',
            );
            return;  // 不 off, 不翻 streaming, 继续等 events
          }
          // 正常 agent_end (willRetry=false): 翻 streaming, 走完成路径
          streamingBySession.value = { ...streamingBySession.value, [sessionId]: false };
          retryBySession.value = { ...retryBySession.value, [sessionId]: null };
          // v0.5.0-D 第17轮 (D204): 清 stream hang 标记 + 停 watchdog
          stopStreamHangWatchdog(sessionId);
          streamHangBySession.value = { ...streamHangBySession.value, [sessionId]: false };
          // v0.5.1: phase 切回 idle
          setPhase(sessionId, 'idle');
          // v0.4.7: assistantId 是 const (整个 sendPrompt 共用 1 个), 不再 reset
          //   (下个 sendPrompt 重新跑 listener closure → outer const 重新初始化)
          chatData.value = { ...chatData.value, [sessionId]: { ...d2 } };
          console.log(
            '[chat] agent_end: idx=',
            idx,
            'total msgs=',
            d2.messages.length,
            'willRetry=',
            event.willRetry,
          );
          off();
          maybeAutoNameSession(sessionId, text);
          // 2026-08-20 P0-1 补充 A: 当前 turn 走完, 自动从队列取下一条发.
          // 关键时序: 必须先 streaming=false, 再调 sendPrompt (否则 sendPrompt 会入队死循环).
          // 业务期望: 用户在 streaming 期间发的消息, LLM 一回完就自动按顺序发, 用户不用手动操作.
          // 用 queueMicrotask 推到下一个 tick, 避免 listener 闭包内同步重入 sendPrompt
          // 引发"on/off 顺序"问题 (off 上面刚调, sendPrompt 会创建新 listener, 同步重入可能跟老 listener 互锁).
          // 注意: 只在 active session 还是这个 sessionId 时发 (用户可能已切到别的 session, 那个 session 自己有队列, 别混).
          const queue = sendQueueBySession.value[sessionId] ?? [];
          if (queue.length > 0 && sessionStore.activeSessionId === sessionId) {
            const next = queue[0];
            const remaining = queue.slice(1);
            sendQueueBySession.value = { ...sendQueueBySession.value, [sessionId]: remaining };
            console.log('[chat] agent_end: dequeue sendPrompt, remaining=', remaining.length, 'preview=', next.slice(0, 40));
            queueMicrotask(() => {
              void sendPrompt(next, { fromQueue: true });
            });
          }
          return;
        case 'agent_settled':
          // v0.5.0: Pi SDK AgentSession 内部最后的事件 (turn 收尾 + tool 清理完后)
          // 不需要动 store, 仅日志
          console.log('[chat] agent_settled');
          break;
        case 'agent_start':
          console.log('[chat] agent_start');
          break;
        case 'turn_start':
          // v0.4.1 step 累加: 创建新 step group, 后续 message_update/tool_execution_* 路由到这里
          if (idx >= 0) {
            const assistant = d2.messages[idx];
            if (!assistant.steps) assistant.steps = [];
            const newStep: Step = {
              id: `step-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              thinking: [],
              toolCalls: [],
              stepText: '',
              isActive: true,
              collapsed: true,  // 默认折叠, 包括 current step
            };
            assistant.steps.push(newStep);
            console.log('[chat] turn_start: created step', newStep.id, 'total=', assistant.steps.length);
          }
          break;
        case 'turn_end':
          // turn_end 收到: 关闭最后一个 step
          if (idx >= 0) {
            const assistant = d2.messages[idx];
            const steps = assistant.steps || [];
            const last = steps[steps.length - 1];
            if (last && last.isActive) {
              last.isActive = false;
              console.log('[chat] turn_end: closed step', last.id);
            }
          }
          break;
        case 'message_start':
          // v0.4.7 大改: assistantId 是 const (一次 sendPrompt 1 个) → 整个 agent loop 共用
          //   1 个 message. Pi SDK 0.84.2 emit 多 message_start (每个 turn / 每个 content
          //   块独立) 都进同一个 message, 由 step 拆分.
          //
          //   流程:
          //   1. 第一次 message_start (idx < 0): push new message + lazy step 0
          //      + 拆 event.message.content 数组进 step
          //   2. 后续 message_start (idx >= 0): 同 message, **no-op** (不 push, 不 reset content,
          //      不拆 content — 避免重复累积)
          //   3. message_end: 拆 final content 数组覆盖 step (final authoritative)
          //
          //   v0.4.6 之前 let 每次重生成 id → 每个 turn push 新 message → 多个空 message
          //   → "AI 没有回复内容" 灰色字 + thinking 重复 3 次 (用户实测反馈).
          //
          //   0.3: 第一次 message_start 也代表 sidecar 切 ws 完, 清 in-flight flag 早于 1.5s timer.
          if (idx < 0) {
            // 第一次 message_start → sidecar 已就绪, 切 workspace 完
            sessionStore.finishWorkspaceSwitch();

            // 第一次: push new message (用 curId = assistantId) + lazy step 0
            d2.messages.push({
              id: curId,  // v0.4.7: 用同一个 assistantId,后续 message_start 找得到
              role: 'assistant',
              content: '',
              createdAt: new Date().toISOString(),
              steps: [],  // 先建空数组,下面 lazy 创建 step 0
            });
            const newStep: Step = {
              id: `step-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              thinking: [],
              toolCalls: [],
              stepText: '',
              isActive: true,
              collapsed: true,
            };
            d2.messages[d2.messages.length - 1].steps!.push(newStep);
            // v0.5.0-D 第10轮 revert: 删 splitMessageContentIntoStep 死循环依赖.
            //   message_start 不再拆 content 数组 (v0.5.0-PR3 行为: 只 push placeholder,
            //   content 由 text_delta 累积). 第5轮加这个拆是为了修 deepseek-v4-flash 不
            //   emit text_delta 时的空 step 问题 — 但 Pi SDK 0.84.2 + sensenova 都正常 emit
            //   deltas, 拆 content 反而引入 REPLACE/APPEND 顺序复杂度 + 跟 text_delta 重复累积.
            break;
          }
          // 后续 message_start (同 message 的多段): **no-op** (不 push 不 reset 不拆)
          // Pi SDK 0.84.2 emit 顺序: turn_start → message_start* → message_update* → message_end* → turn_end
          //   同 turn 内的多个 message_start (thinking / tool result / final answer) 都进
          //   同一个 message, 由 message_end 一次性拆 final content 覆盖.
          break;
        case 'message_update':
        case 'message_end':
        case 'tool_execution_start':
        case 'tool_execution_update':
        case 'tool_execution_end':
          // v0.5.0: tool_execution_* (Pi SDK) 替代 v0.4.x tool_*
          // v0.4.2.x fix: agent_end + error 已经在 switch 开头独立处理 (返回), 不会到这里.
          if (idx < 0) {
            console.warn(`[chat] ${event.type} before assistant message created, ignoring`);
            return;
          }
          const assistant = d2.messages[idx];
          const getCurrentStep = (): Step | undefined => {
            const steps = assistant.steps || [];
            if (steps.length === 0) return undefined;
            return steps[steps.length - 1];
          };
          switch (event.type) {
            case 'message_update':
              // v0.4.3.2.4 修正 (D182 修正版): Pi SDK 0.84.2 JsonAgentSessionEvent.message_update
              //   顶层有 `usage` (json-event.ts:6-15 + 31-45 显式构造), **没有顶层 message**.
              //   v0.4.3.2 我之前 v0.5.0 commit 7ef5b8b 写顶层 usage? optional 是错的 (optional
              //   让 chat store 永远不读), 修成 event.message?.usage 仍错 (message_update RPC
              //   事件根本没顶层 message 字段). 正确读法: event.usage (顶层, 必填).
              //   message_start 提供 initial message, deltas build it, message_end 提供 final
              //   authoritative message — 所以 message_update 不带 message 是 by design.
              if (event.usage) {
                const u = event.usage;
                lastUsageBySession.value = {
                  ...lastUsageBySession.value,
                  [sessionId]: u,
                };
                contextTokensBySession.value = {
                  ...contextTokensBySession.value,
                  [sessionId]: u.input + u.cacheRead,
                };
              }
              // v0.5.0: event.assistantMessageEvent 嵌套 + .type 标 kind (text_delta / thinking_delta / tool_call_delta)
              // v0.5.0: event.assistantMessageEvent 嵌套 + .type 标 kind (text_delta / thinking_delta / tool_call_delta)
              // 跟 v0.4.x 的 event.delta + event.kind 不同
              {
                const ame = event.assistantMessageEvent;
                if (ame.type === 'thinking_delta') {
                  // thinking 路由到 currentStep
                  const step = getCurrentStep();
                  if (step) {
                    // v0.4.6: tb2 是 possibly undefined, ts strict null check 兜底
                    const lastTb = step.thinking[step.thinking.length - 1];
                    if (lastTb) {
                      lastTb.content += ame.delta;
                    } else {
                      step.thinking.push({
                        id: `think-${step.id}`,
                        messageId: curId,
                        content: ame.delta,
                        collapsed: false,  // step 内 thinking 默认展开
                      });
                    }
                  } else {
                    // fallback: 顶层 thinking (兼容无 step 数据)
                    const existTb = d2.thinking.find((t) => t.messageId === curId);
                    if (existTb) {
                      existTb.content += ame.delta;
                    } else {
                      d2.thinking.push({
                        id: `think-${curId}`,
                        messageId: curId,
                        content: ame.delta,
                        collapsed: true,
                      });
                    }
                  }
                  // v0.5.1: phase 切到 thinking
                  setPhase(sessionId, 'thinking');
                } else if (ame.type === 'text_delta') {
                  // v0.5.0-D 第10轮 revert: 删 echo filter 死循环 (9 轮迭代原地打转).
                  //   text-based echo filter 不可靠 (model 复读有空格/标点/重复/无标点变体,
                  //   9 轮规则一加一个, 漏一个 case). 改回 v0.5.0-PR3 简单 append.
                  //   真正 fix 在 sidecar system prompt (短/明确/有反例) + model 选择层.
                  assistant.content += ame.delta;
                  const step = getCurrentStep();
                  if (step) step.stepText += ame.delta;
                  setPhase(sessionId, 'text');
                }
                // tool_call_delta: Pi SDK 增量发送 tool call args, 当前 FE 不展示 (tool_execution_start
                //   事件已经包含完整 args). 这里吞掉, 不弹错.
              }
              break;
            case 'message_end':
              // v0.4.3.2.4 确认: message_end 保持原 AgentSessionEvent schema (json-event.ts:32-34),
              //   顶层**无 usage**, 用 event.message.usage (AssistantMessage 必填字段).
              //   v0.4.3.2 修对了, 不动.
              //   写到 assistant message.usage (持久化到 store), 切别的 session / 切回能读回
              //   v0.5.0-D 第22轮 (D209): 累加 usage
              //     之前: contextTokensBySession = finalUsage.input + finalUsage.cacheRead
              //       (单次 turn, 每次新 turn 覆盖. user 反馈 "上下文窗口的计数应该是累加的")
              //     现在: 累加 (input + cacheRead 总和), 跨 turn 求和
              //     lastUsageBySession 仍 per-turn (单次 turn 调试用, 不影响显示)
              //     cumulativeUsageBySession 累加 4 字段 (input/output/cacheRead/cacheWrite)
              //     只有 user 主动 compaction 才会"消减" (compaction_end 成功时清零重计)
              if (event.message?.usage && idx >= 0) {
                const finalUsage = event.message.usage;
                // per-turn (单次, 覆盖) - 调试 / 单次显示用
                lastUsageBySession.value = { ...lastUsageBySession.value, [sessionId]: finalUsage };
                // 累加 (跨 turn 求和) - UI 主显示
                const prevCum = cumulativeUsageBySession.value[sessionId];
                const newCum: import('@/lib/mock/types').MessageUsage = {
                  input: (prevCum?.input ?? 0) + (finalUsage.input ?? 0),
                  output: (prevCum?.output ?? 0) + (finalUsage.output ?? 0),
                  cacheRead: (prevCum?.cacheRead ?? 0) + (finalUsage.cacheRead ?? 0),
                  cacheWrite: (prevCum?.cacheWrite ?? 0) + (finalUsage.cacheWrite ?? 0),
                  cost: {
                    input: (prevCum?.cost?.input ?? 0) + (finalUsage.cost?.input ?? 0),
                    output: (prevCum?.cost?.output ?? 0) + (finalUsage.cost?.output ?? 0),
                    cacheRead: (prevCum?.cost?.cacheRead ?? 0) + (finalUsage.cost?.cacheRead ?? 0),
                    cacheWrite: (prevCum?.cost?.cacheWrite ?? 0) + (finalUsage.cost?.cacheWrite ?? 0),
                  },
                };
                cumulativeUsageBySession.value = {
                  ...cumulativeUsageBySession.value,
                  [sessionId]: newCum,
                };
                // contextTokens 累加 (input + cacheRead 总和)
                const prevCtx = contextTokensBySession.value[sessionId] ?? 0;
                contextTokensBySession.value = {
                  ...contextTokensBySession.value,
                  [sessionId]: prevCtx + (finalUsage.input ?? 0) + (finalUsage.cacheRead ?? 0),
                };
                // v0.4.3: 写到 assistant message.usage, 后续从 store 读
                assistant.usage = finalUsage;
                console.log(
                  `[chat] message_end: turn usage=${finalUsage.input}+${finalUsage.cacheRead} (cache) + ${finalUsage.cacheWrite} (write); ` +
                  `cumulative context=${contextTokensBySession.value[sessionId]} (input=${newCum.input}, output=${newCum.output}, cacheRead=${newCum.cacheRead}, cacheWrite=${newCum.cacheWrite})`
                );
                // v0.5.0-D 第29轮 (D212): LLM 异常错误分界线
                //   之前 (D204 前): message_end 带 errorMessage + stopReason='error' 时
                //   只 console.error, 走顶层 error 事件 + showToast, user 视觉"突然终止"
                //   没明显标记. 实测 TPM 限流 (429 quota) / network error 时 Pi SDK 会:
                //     1. 成功 emit 前面的 message (有 thinking / toolCall)
                //     2. 后续 message_end 时 errorMessage 报错 + stopReason='error'
                //     3. turn_end + agent_end (willRetry=false, 配额错误 Pi SDK 不重试)
                //   修法: 检测到 errorMessage, 调 pushErrorDivider 推一条 system 角色消息
                //   (跟 compaction 同款风格), ChatMessage.vue 渲染为居中橙色横线
                //   "── ⚠ 生成失败: ... ───". user 一眼能看到失败位置 + 错误原因,
                //   跟压缩 UX 保持一致.
                if (event.message.errorMessage && event.message.stopReason === 'error') {
                  // 检查是否已有部分内容 (thinking / toolCall 累积过)
                  const hasPartialContent = !!(
                    assistant.content?.trim() ||
                    assistant.steps?.some(s =>
                      s.stepText?.trim() || s.thinking?.length || s.toolCalls?.length
                    )
                  );
                  pushErrorDivider(
                    sessionId,
                    event.message.errorMessage,
                    'message_end_stop_reason_error',
                    hasPartialContent,
                  );
                }
              }  // ← close if (event.message?.usage && idx >= 0)
              // v0.5.0-D 第17轮 (D204) REVERT D200/D202/D203 emptyResponse 主动告警:
              //   之前 D200 (b379f76) 在 message_end 探测"空 message" → D202/D203 在 UI 弹 AlertTriangle.
              //   实测 D202 截图暴露的问题: sensenova-6.7-flash-lite 合法地先发空 message (warmup / control),
              //   再发 thinking + toolCall, D200 提前告警 → 底部 status bar 弹错误 → user 困惑.
              //   D204 修法: 不在 message_end 主动检测 (model 自己控制, 可能后续 message 还有内容).
              //   改成真正的兜底: stream hang detector 在 30s 无事件 + 仍 isStreaming 时, 才标
              //   streamHang=true, UI 在 chat 区域中间显示一条横线 (不是 popup).
              //
              // v0.5.0-D 第10轮 revert: 删 message_end 拆 final content 覆盖 (跟 message_start
              //   一起删, 整套 splitMessageContentIntoStep 死循环去掉). v0.5.0-PR3 行为:
              //   message_end 只处理 usage, content 由 text_delta 累积, 流式显示一直正确.
              //   v0.4.6 加这个拆是为了修 LLM 不 emit deltas 时的空 step — 但 Pi SDK 0.84.2
              //   + sensenova/deepseek 都正常 emit text_delta, 不需要拆. 真遇到不 emit deltas
              //   的 model 时再单独处理, 不要在 text_delta 已经 ok 的情况下继续叠加 REPLACE 复杂度.
              // v0.4.7: 不再 reset outer assistantId (它是 const, 整个 sendPrompt 共用)
              break;
            case 'tool_execution_start':
              {
                const step = getCurrentStep();
                const target = step ? step.toolCalls : d2.toolCalls;
                target.push({
                  id: event.toolCallId,
                  // v0.4.6: curId fallback (assistantId 是 let 可能 null)
                  messageId: curId,
                  name: event.toolName,
                  args: event.args || {},
                  status: 'running',
                  startedAt: new Date().toISOString(),
                });
                // v0.5.1: phase 切到 tool (调用工具)
                setPhase(sessionId, 'tool');
                console.log('[chat] tool_execution_start', event.toolName, 'routed to', step ? 'step' : 'legacy');
              }
              break;
            case 'tool_execution_update':
              {
                const step = getCurrentStep();
                const target = step ? step.toolCalls : d2.toolCalls;
                const tc = target.find((x) => x.id === event.toolCallId);
                if (tc && event.partialResult !== undefined) {
                  // v0.5.0: partialResult 是 any 类型 (string / object / 等), FE 简化累积字符串
                  const partial = typeof event.partialResult === 'string'
                    ? event.partialResult
                    : JSON.stringify(event.partialResult, null, 2);
                  tc.result = (tc.result || '') + partial;
                }
              }
              break;
            case 'tool_execution_end':
              {
                // v0.5.0: event.isError (不是 v0.4.x 的 event.error)
                const step = getCurrentStep();
                const target = step ? step.toolCalls : d2.toolCalls;
                const tc = target.find((x) => x.id === event.toolCallId);
                if (tc) {
                  tc.status = event.isError ? 'error' : 'success';
                  tc.endedAt = new Date().toISOString();
                  if (typeof event.result === 'string') tc.result = event.result;
                  else if (event.result !== undefined) tc.result = JSON.stringify(event.result, null, 2);
                }
                // v0.5.1: tool 跑完, 切回 thinking (等下一个 LLM delta 再切 text)
                setPhase(sessionId, 'thinking');
              }
              break;
          }
          break;
        // v0.4.2 step 1: AgentSession 内置 retry 5 次指数退避, sidecar 转发 auto_retry_start / auto_retry_end
        case 'auto_retry_start':
          retryBySession.value = {
            ...retryBySession.value,
            [sessionId]: {
              attempt: event.attempt,
              maxAttempts: event.maxAttempts,
              errorMessage: event.errorMessage,
            },
          };
          console.log(`[chat] auto_retry_start: ${event.attempt}/${event.maxAttempts}, delayMs=${event.delayMs}, err=${event.errorMessage.slice(0, 80)}`);
          // Bug #5/#6 修 (2026-08-18): auto_retry_start 加 UI toast, 告诉用户 LLM 失败在重试
          //   (之前 Pi SDK 静默重试, 用户视觉"卡住了不知道在干什么")
          useUiStore().showToast(
            `LLM 失败, 正在重试 (${event.attempt}/${event.maxAttempts}): ${event.errorMessage.slice(0, 60)}`,
            'warning',
            3500,
          );
          break;
        case 'auto_retry_end': {
          // v0.5.0: event.attempt 单数 (不是 v0.4.x 的 attempts)
          // 用 block 包裹避免 const 跨 case 共享 scope 的 lint 警告
          const wasRetrying = retryBySession.value[sessionId] !== null;
          retryBySession.value = { ...retryBySession.value, [sessionId]: null };
          console.log(`[chat] auto_retry_end: success=${event.success}, attempt=${event.attempt}${event.finalError ? ', err=' + event.finalError.slice(0, 80) : ''}`);
          // Bug #5/#6 修: retry 终态 toast 反馈
          if (wasRetrying) {
            if (event.success) {
              useUiStore().showToast(`重试成功, 已恢复生成`, 'success', 3000);
            } else {
              useUiStore().showToast(`重试 ${event.attempt} 次仍失败: ${(event.finalError || '未知错误').slice(0, 60)}`, 'error', 6000);
            }
          }
          break;
        }
        // v0.4.2 step 1: AgentSession 内置 compaction (手动 / 自动 threshold / overflow)
        // v0.5.0-D 第26轮 (D210.3) BUG FIX: 改调 helper 函数 (handleCompactionStart / End)
        //   之前逻辑全部内联在这里, 但 compact() 不走 sendPrompt listener, compaction
        //   事件没人接. helper 化后 compact() 注册临时 listener 也调同样的 helper, 行为一致.
        case 'compaction_start':
          handleCompactionStart(sessionId, { reason: event.reason });
          break;
        case 'compaction_end':
          handleCompactionEnd(sessionId, {
            reason: event.reason,
            aborted: event.aborted,
            willRetry: event.willRetry,
            errorMessage: event.errorMessage,
          });
          break;
        case 'extension_ui_request': {
          // v0.5.0: Pi SDK RPC 协议的 extension UI, 替代 v0.4.x 的 permission_request
          // 跟 v0.4.x 比, 走的是通用 dialog (method: select/confirm/input/editor/notify) 而不只 tool permission
          // 当前 v0.4.x FE UI 只展示 confirm (tool permission), 其它 method 只日志不弹窗
          if (event.method === 'confirm') {
            // tool permission 弹窗 (跟 v0.4.x permission_request 行为一致)
            console.log('[chat] extension_ui_request confirm:', event.title, 'message=', event.message);
            useUiStore().openPermissionDialog({
              toolCallId: event.id,        // 弹窗用 id 字段存 (跟 extension_ui_response 的 id 配对)
              toolName: event.title || 'Tool',
              args: { message: event.message },
              sessionId: event.sessionId,
              // 关键: 弹窗的 respond 调 sendRpcCommand({ type: 'extension_ui_response', id, confirmed: true })
              // 替代 v0.4.x 的 sendPermissionResponse(sessionId, toolCallId, allow)
            });
          } else {
            // 其它 method (select / input / editor / notify) 当前不弹窗, 只日志
            console.log(`[chat] extension_ui_request: method=${event.method} (not yet handled in UI)`, event);
          }
          break;
        }
        default:
          console.warn('[chat] unhandled event type:', (event as any).type);
          break;
      }
      chatData.value = { ...chatData.value, [sessionId]: { ...d2 } };
    });
    // v0.5.0-D 第25轮 (D210.2) BUG FIX: 存 off 到 map, 让 cleanupListenerForSession 能清理
    //   agent_end willRetry=true 分支 (line 786 附近) 不调 off() 因为要继续等 Pi SDK 内部 retry,
    //   这时候老 listener 必须保留. 但下次 sendPrompt / watchdog force stop / 新 tryAutoRetry
    //   resend 时必须能调 off() 把老 listener 清掉 (否则 N 个老 listener 活着, 每个事件处理 N 次).
    listenerOffBySession.set(sessionId, off);
    console.log('[chat] listener ready, invoking send_prompt');

    // 4. 触发 prompt
    try {
      const config = useConfigStore();
      const active = config.activeProvider;
      const model = config.activeModel;
      console.log('[chat] sendPrompt: active=', active?.label, 'model=', model?.id);
      if (!active || !model) {
        throw new Error('请先在 Settings → Providers 添加并选一个 active provider + model');
      }
      // v0.3.8.11: 注入当前 active workspace 的 path 作为 system message
      // (从 sessionStore 取 activeWorkspace.path, 让 LLM 知道在哪个目录下操作)
      const activeWs = sessionStore.activeWorkspace;
      const workspacePath = activeWs?.path ?? null;
      // 2026-08-20 P0-1 补充 B: permissionMode 改用 session 自己的 (下面计算 sessionPermissionMode),
      //   不再用全局 config.permissionMode (那样多 session 并行不可能, 切 session 跟着切).
      // Bug #1 修 (2026-08-18): 改用 per-session 独立 piSessionId (不用 per-workspace 固定)
      //   之前 per-workspace 固定 id  → 不同 FE session 串了 (都写到同一个 jsonl)
      //   现在每个 FE session 独立   → 各自独立 jsonl, 切 session 真隔离
      //   旧 data: 旧 session 升级时 piSessionId undefined → ensurePiSessionId lazy 生成
      const piSessionId = sessionId ? sessionStore.ensurePiSessionId(sessionId) : undefined;
      // v0.4.4 Skills (Pi SDK 暴露): 传 enabled skill names 给 sidecar, 走 formatSkillsForPrompt
      //   注入 system prompt override. enabledByName 改后必须重启 sidecar (D165 systemPrompt
      //   不可动态改), SkillsButton toggle 触发 Tauri sidecar kill+spawn.
      const skills = useSkillsStore();
      const enabledNames = skills.getEnabledNames();
      // v0.5.0-D 第12轮 fix (D199): 之前传的是 `text` (原始 user 输入), 漏了 quote 块.
      //   store 里 `appendUserMessage(sessionId, fullUserText)` 存了完整版本 (含 quote),
      //   但 sidecar 收到的是不含 quote 的版本 → AI 看不到引用, 报 "你没引用任何外部来源".
      //   修法: sendPrompt 传 fullUserText, 跟 store 保持一致.
      // 2026-08-20 P0-1 补充 B: provider / model / permissionMode 改用 session 自己的设置
      //   (sessionStore.getSessionXxx fallback 到全局). 旧实现全用 configStore.activeXxx
      //   → 多 session 并行不可能 (切 session 时全切), 用户被迫每次新建都要重选.
      const sessionProviderId = sessionStore.getSessionProviderId(sessionId!);
      const sessionModelId = sessionStore.getSessionModelId(sessionId!);
      const sessionPermissionMode = sessionStore.getSessionPermissionMode(sessionId!);
      // 三段 fallback: session 指定 → 找不到回 session provider active → 再回全局 active
      let effectiveProvider = sessionProviderId
        ? config.providers.find((p) => p.id === sessionProviderId) ?? null
        : null;
      if (!effectiveProvider) effectiveProvider = active;
      let effectiveModel = sessionModelId
        ? effectiveProvider.models.find((m) => m.id === sessionModelId) ?? null
        : null;
      if (!effectiveModel) effectiveModel = effectiveProvider.models.find((m) => m.id === effectiveProvider.activeModelId) ?? null;
      if (!effectiveModel) effectiveModel = model;  // 最后兜底: 全局 active
      console.log('[chat] sendPrompt: session=', sessionId, 'effectiveProvider=', effectiveProvider?.label, 'model=', effectiveModel?.id, 'permissionMode=', sessionPermissionMode);
      if (!effectiveProvider || !effectiveModel) {
        throw new Error('请先在 Settings → Providers 添加并选一个 active provider + model');
      }
      const cfgFn = () => ({
        providerId: effectiveProvider.id,
        provider: effectiveProvider.type,
        model: effectiveModel.id,
        baseUrl: effectiveProvider.baseUrl,
        thinkingLevel: config.thinkingLevel,
        workspacePath,
        permissionMode: sessionPermissionMode,
        sessionId: piSessionId,
        skills: { enabledNames },
        modelMetadata: {
          type: effectiveModel.type,
          vision: effectiveModel.vision,
          contextWindow: effectiveModel.contextWindow,
          maxOutput: effectiveModel.maxOutput,
          maxRounds: effectiveModel.maxRounds,
          reasoning: effectiveModel.reasoning,
        },
      });
      await piTauri.sendPrompt(sessionId, fullUserText, cfgFn);
      console.log('[chat] sendPrompt: piTauri.sendPrompt resolved');

      // Phase 6: fire-and-forget ghost title prompt (仅 first message, 不阻塞主流程)
      if (isFirstMessageForGhost) {
        ghostTriggeredForSession.add(sessionId);
        const baseCfg = cfgFn();
        triggerGhostTitlePrompt(sessionId, text, baseCfg).catch((e) => {
          console.warn('[chat] ghost: trigger failed (ignored)', e);
        });
      }
    } catch (e) {
      console.error('[chat] sendPrompt FAILED', e);
      const rawMsg = e instanceof Error ? e.message : String(e);
      errorBySession.value = { ...errorBySession.value, [sessionId]: friendlyErrorMessage(rawMsg) };
      streamingBySession.value = { ...streamingBySession.value, [sessionId]: false };
      off();
    }
  }

  /** @deprecated 旧 API, 保留以防外部代码引用. 新代码请用 sendPrompt(content) */
  async function sendPromptViaWs(sessionId: string, content: string) {
    console.warn('[chat] sendPromptViaWs() is deprecated, use sendPrompt(content) instead');
    if (sessionId) sessionStore.selectSession(sessionId);
    return sendPrompt(content);
  }

  /**
   * v0.4.3: 手动触发 context 压缩 (走 Pi SDK compact RpcCommand).
   *
   * - 自动场景: Pi SDK 内部 `shouldCompact()` 检测到 context 超过 70% window, 走 auto compaction
   *   (event.reason = 'threshold' / 'overflow'). FE 不用管.
   * - 手动场景: user 点 Composer 上的 "压缩" 按钮, 主动触发, event.reason = 'manual'.
   *
   * Pi SDK 0.84.2 compact RpcCommand 走 sidecar runRpcMode → sidecar 调 AgentSession.compact()
   * → 走 LLM 总结 + 替换 message history. 完成 emit compaction_start / compaction_end 事件.
   *
   * 限制: 当前 session 正在 streaming 时不能触发 (会冲突), 调用方自己保证.
   *
   * Bug #2 修 (2026-08-18): 改走独立 `compact_session` invoke (force-spawn sidecar),
   *   跟 send_prompt 解耦, 闲置 session 也能压缩. 同时加 UI toast 反馈成功/失败
   *   (之前 silently 失败用户视觉"没反应").
   */
  async function compact(sessionId?: string) {
    const sid = sessionId ?? sessionStore.activeSessionId;
    if (!sid) {
      console.warn('[chat] compact: no active session, ignoring');
      useUiStore().showToast('没有 active session, 无法压缩', 'warning');
      return;
    }
    if (isStreaming(sid)) {
      console.warn('[chat] compact: session is streaming, ignoring (用户应先 abort)');
      useUiStore().showToast('当前 session 正在生成, 请先停止后再压缩', 'warning');
      return;
    }
    if (isCompacting(sid)) {
      console.warn('[chat] compact: already compacting, ignoring');
      useUiStore().showToast('已在压缩中, 请等待完成', 'info');
      return;
    }
    console.log(`[chat] compact: triggering manual compaction for session=${sid}, currentContextTokens=${getContextTokens(sid)}`);
    // Bug #2 修: 走 force-spawn 路径 (compact_session invoke), 不依赖 active sidecar
    const config = useConfigStore();
    const active = config.activeProvider;
    const model = config.activeModel;
    if (!active || !model) {
      useUiStore().showToast('未配置 provider + model, 无法压缩', 'error');
      return;
    }
    const activeWs = sessionStore.activeWorkspace;
    const workspacePath = activeWs?.path ?? null;
    // 2026-08-20 P0-1 补充 B: compact 独立算 session 自己的 settings (跟 sendPrompt 一样的三段 fallback)
    const sessionProviderId = sessionStore.getSessionProviderId(sid);
    const sessionModelId = sessionStore.getSessionModelId(sid);
    const sessionPermissionMode = sessionStore.getSessionPermissionMode(sid);
    let effectiveProvider = sessionProviderId
      ? config.providers.find((p) => p.id === sessionProviderId) ?? null
      : null;
    if (!effectiveProvider) effectiveProvider = active;
    let effectiveModel = sessionModelId
      ? effectiveProvider.models.find((m) => m.id === sessionModelId) ?? null
      : null;
    if (!effectiveModel) effectiveModel = effectiveProvider.models.find((m) => m.id === effectiveProvider.activeModelId) ?? null;
    if (!effectiveModel) effectiveModel = model;
    if (!effectiveProvider || !effectiveModel) {
      useUiStore().showToast('未配置 provider + model, 无法压缩', 'error');
      return;
    }
    // Bug #1 修: 用当前 active session 的独立 piSessionId (不用 per-workspace 固定)
    const piSessionId = sessionStore.ensurePiSessionId(sid);
    const skills = useSkillsStore();
    const enabledNames = skills.getEnabledNames();
    try {
      // v0.5.0-D 第26轮 (D210.3) BUG FIX: 注册临时 listener 收 compaction 事件
      //   之前 compact() 只调 piTauri.compactSession 启独立 sidecar, 但 chat store 没有任何
      //   handler 处理 emit 出来的 compaction_start / compaction_end → UI 永远卡在"压缩中",
      //   divider 也不插. 修法: 启 sidecar 前先 piTauri.on() 注册临时 handler (调 handleCompactionStart
      //   / handleCompactionEnd helper), 收到 compaction_end 后自动 off() 注销.
      //   filter sessionId === sid, 避免被其他 session 事件污染.
      let compactOff: (() => void) | null = null;
      compactOff = await piTauri.on((event) => {
        if (('sessionId' in event) && event.sessionId !== sid) return;
        if (event.type === 'compaction_start') {
          handleCompactionStart(sid, { reason: event.reason });
        } else if (event.type === 'compaction_end') {
          handleCompactionEnd(sid, {
            reason: event.reason,
            aborted: event.aborted,
            willRetry: event.willRetry,
            errorMessage: event.errorMessage,
          });
          // 收到 compaction_end 就 unregister, 不再处理后续事件
          if (compactOff) {
            try { compactOff(); } catch (e) { console.warn('[chat] D210.3: compact listener off() failed (ignored)', e); }
            compactOff = null;
          }
        }
        // 其他事件类型 (agent_start / message_* / etc.) 不是 compact 流程, 忽略
      });
      await piTauri.compactSession(sid, () => ({
        // 2026-08-20 P0-1 补充 B: compact 也用 session 自己的 settings (跟 sendPrompt 同步)
        providerId: effectiveProvider.id,
        provider: effectiveProvider.type,
        model: effectiveModel.id,
        baseUrl: effectiveProvider.baseUrl,
        thinkingLevel: config.thinkingLevel,
        workspacePath,
        permissionMode: sessionPermissionMode,
        sessionId: piSessionId,
        skills: { enabledNames },
        modelMetadata: {
          type: effectiveModel.type,
          vision: effectiveModel.vision,
          contextWindow: effectiveModel.contextWindow,
          maxOutput: effectiveModel.maxOutput,
          maxRounds: effectiveModel.maxRounds,
          reasoning: effectiveModel.reasoning,
        },
      }));
      // v0.5.0-D 第27轮 (D210.4) 改 UX: 不用 toast, 走分隔线
      //   推一条 in_progress system message, handleCompactionEnd 时原地更新成 success / failure.
      //   user 反馈: "压缩进行中不要通过弹窗形式提示, 而是统一使用分隔线的形式, 做的整体一些"
      const dInProg = getSessionData(sid);
      if (dInProg) {
        dInProg.messages.push({
          id: `sys-compact-${Date.now()}`,
          role: 'system',
          content: '__COMPACTION_DIVIDER__',
          createdAt: new Date().toISOString(),
          compactionMarker: { state: 'in_progress' },
        } as ChatMessage);
        chatData.value = { ...chatData.value, [sid]: { ...dInProg } };
        console.log(`[chat] compaction divider pushed: in_progress (manual, session=${sid})`);
      }
    } catch (e) {
      console.error('[chat] compactSession invoke failed', e);
      // 失败时清掉 in_progress 状态, 避免 UI 卡住
      compactionBySession.value = { ...compactionBySession.value, [sid]: 'idle' };
      // v0.5.0-D 第27轮 (D210.4) 改 UX: 不用 toast, 走分隔线
      //   找到刚才推的 in_progress divider, 原地更新成 failure
      const dFail = getSessionData(sid);
      if (dFail) {
        for (let i = dFail.messages.length - 1; i >= 0; i--) {
          const m = dFail.messages[i];
          if (m.role === 'system' && m.compactionMarker && m.compactionMarker.state === 'in_progress') {
            dFail.messages[i] = {
              ...m,
              compactionMarker: { state: 'failure', errorMessage: e instanceof Error ? e.message : String(e) },
            };
            break;
          }
        }
        chatData.value = { ...chatData.value, [sid]: { ...dFail } };
      }
    }
  }

  // v0.3.8.11: 用户手动切换 thinking 折叠状态
  // v0.3.8.6 引入流式自动展开, message_end 自动收起 — 跟用户预期矛盾,
  // 改为完全由用户控制. ChatMessage toggle 时调这个
  function setThinkingCollapsed(sessionId: string, thinkingId: string, collapsed: boolean) {
    const d = getSessionData(sessionId);
    const tb = d.thinking.find((t) => t.id === thinkingId);
    if (!tb) return;
    tb.collapsed = collapsed;
    chatData.value = { ...chatData.value, [sessionId]: { ...d } };
  }

  // v0.4.1 step 累加: 用户手动切换 step 折叠状态
  function setStepCollapsed(sessionId: string, messageId: string, stepId: string, collapsed: boolean) {
    const d = getSessionData(sessionId);
    const msg = d.messages.find((m) => m.id === messageId);
    if (!msg || !msg.steps) return;
    const step = msg.steps.find((s) => s.id === stepId);
    if (!step) return;
    step.collapsed = collapsed;
    chatData.value = { ...chatData.value, [sessionId]: { ...d } };
  }

  // v0.4.1 step 累加: 切换 step 内 thinking block 折叠
  function setStepThinkingCollapsed(sessionId: string, messageId: string, stepId: string, collapsed: boolean) {
    const d = getSessionData(sessionId);
    const msg = d.messages.find((m) => m.id === messageId);
    if (!msg || !msg.steps) return;
    const step = msg.steps.find((s) => s.id === stepId);
    if (!step || step.thinking.length === 0) return;
    const tb = step.thinking[step.thinking.length - 1];
    tb.collapsed = collapsed;
    chatData.value = { ...chatData.value, [sessionId]: { ...d } };
  }

  /** 如果 session 还是默认名 "新任务", 用首条消息前 30 字命名 */
  function maybeAutoNameSession(sessionId: string, firstMessage: string) {
    const s = sessionStore.sessions.find((x) => x.id === sessionId);
    if (!s) return;
    if (s.title !== '新任务' && s.title.trim() !== '') return;
    const title = firstMessage.trim().slice(0, 30) || '新任务';
    sessionStore.renameSession(sessionId, title);
  }

  /**
   * v0.5.0-PR3 (D_Stop_Hang): 强制把 session 翻成"非 streaming" 状态.
   *
   * 用途: Pi SDK 0.84.2 在某些 OpenAI-compatible provider (MiniMax / DeepSeek V4 Flash 等)
   *   上, abort 后 emit `agent_end` event 偶尔 lost → 跑马灯一直转, stop 按钮卡死.
   *   Composer.stop() 30s timeout 或 abort 失败 catch 时调这个, 强制恢复 UI 状态.
   *
   * 副作用: 当前 active step 关闭 (isActive=false, collapsed=true), 但不修改已累积的
   *   thinking / toolCalls / stepText — 用户能继续发下一条消息, 已生成的回复保留.
   *
   * v0.4.6 Bug 修 (abort 后重发继续走): 同时调 Rust 端 killSidecar, force kill 旧 sidecar
   *   child 进程 (Pi SDK AgentSession state 不再 hold, 下次 send_prompt 启新 sidecar
   *   resume 不会看到 incomplete message).
   */
  async function forceStopStreaming(sessionId: string) {
    streamingBySession.value = { ...streamingBySession.value, [sessionId]: false };
    retryBySession.value = { ...retryBySession.value, [sessionId]: null };
    // v0.5.0-D 第17轮 (D204): 用户点 Stop 强制终止 → 也清 stream hang 标记 + 停 watchdog
    stopStreamHangWatchdog(sessionId);
    streamHangBySession.value = { ...streamHangBySession.value, [sessionId]: false };
    const d2 = getSessionData(sessionId);
    if (d2) {
      const assistant = d2.messages[d2.messages.length - 1];
      if (assistant && assistant.role === 'assistant' && assistant.steps) {
        const last = assistant.steps[assistant.steps.length - 1];
        if (last && last.isActive) {
          last.isActive = false;
          last.collapsed = true;
        }
      }
      chatData.value = { ...chatData.value, [sessionId]: { ...d2 } };
    }
    setPhase(sessionId, 'idle');
    console.warn('[chat] forceStopStreaming:', sessionId, '(abort 30s timeout or catch 兜底)');
    // v0.4.6: force kill 旧 sidecar 避免 state 残留
    try {
      await piTauri.killSidecar(sessionId);
    } catch (e) {
      console.warn('[chat] forceStopStreaming: killSidecar failed (ignored)', e);
    }
    // 2026-08-20 P0-1 补充 A: 用户主动 stop 后, 也尝试从队列取下一条发.
    //   业务: 用户 stop 完想立即发下一条, 不用再手敲. 跟 agent_end 一样的"自动续传"语义.
    //   forceStop 后 streaming 已经被翻成 false (上面), 调 sendPrompt 不会被入队.
    //   只在 active session 还是这个时取, 避免切到别的 session 时把别人的队列搞乱.
    const queue = sendQueueBySession.value[sessionId] ?? [];
    if (queue.length > 0 && sessionStore.activeSessionId === sessionId) {
      const next = queue[0];
      const remaining = queue.slice(1);
      sendQueueBySession.value = { ...sendQueueBySession.value, [sessionId]: remaining };
      console.log('[chat] forceStopStreaming: dequeue sendPrompt, remaining=', remaining.length, 'preview=', next.slice(0, 40));
      queueMicrotask(() => {
        void sendPrompt(next, { fromQueue: true });
      });
    }
  }

  // v0.5.0-D 第23轮 (D210): FE 端 auto-retry 核心函数
  //   触发条件: stream hang (30s 无事件) 后, 检查最新 assistant message 是不是空
  //     - 空 = 没 text content, 没 thinking, 没 toolCall, 没 toolResult (model 完全失败)
  //     - 这种情况下 Pi SDK 内部 retry 不可靠 (不 emit events), FE 主动重发
  //   上限: 每个 session 最多 1 次 auto-retry (防 spam)
  //     - user 新发消息时清零 (允许下次再 auto-retry)
  //     - max=1 是 D210 保守选择: 第一次重试还失败 → 让 user 决定 (不无限循环)
  //   行为: resend last user message (用完整 sendPrompt 流程, quote 不带)
  //     - 2s 延迟 (让 sidecar 清理 + user 看到"正在重试..."指示)
  //   user 取消: forceStopStreaming 会清空 autoRetryCount, 下次不重试
  const AUTO_RETRY_MAX = 1;
  const AUTO_RETRY_DELAY_MS = 2_000;
  function isAssistantMessageEmpty(assistantMsg: { content?: string; steps?: Step[] } | null | undefined): boolean {
    if (!assistantMsg) return true;
    // 1. 检查 content (顶层)
    if ((assistantMsg.content || '').trim().length > 0) return false;
    // 2. 检查 steps: text / thinking / toolCalls / 任何一项非空都不算空
    const steps = assistantMsg.steps || [];
    for (const s of steps) {
      if ((s.stepText || '').trim().length > 0) return false;
      if ((s.thinking || []).length > 0) return false;
      if ((s.toolCalls || []).length > 0) return false;
    }
    return true;
  }
  function getLastUserMessageContent(sessionId: string): string | null {
    const d = getSessionData(sessionId);
    if (!d) return null;
    for (let i = d.messages.length - 1; i >= 0; i--) {
      if (d.messages[i].role === 'user') {
        return d.messages[i].content || null;
      }
    }
    return null;
  }
  async function tryAutoRetry(sessionId: string) {
    const count = autoRetryCountBySession.value[sessionId] ?? 0;
    if (count >= AUTO_RETRY_MAX) {
      console.log(`[chat] D210: auto-retry skipped (already retried ${count}/${AUTO_RETRY_MAX} times)`);
      return false;
    }
    // 1. 找最新 assistant message
    const d = getSessionData(sessionId);
    if (!d) return false;
    let lastAssistant: { role: string; content?: string; steps?: Step[] } | null = null;
    for (let i = d.messages.length - 1; i >= 0; i--) {
      if (d.messages[i].role === 'assistant') {
        lastAssistant = d.messages[i];
        break;
      }
    }
    if (!isAssistantMessageEmpty(lastAssistant)) {
      console.log('[chat] D210: auto-retry skipped (assistant message has content)');
      return false;
    }
    // 2. 找 user message (要重发的内容)
    const userContent = getLastUserMessageContent(sessionId);
    if (!userContent || !userContent.trim()) {
      console.log('[chat] D210: auto-retry skipped (no user message to resend)');
      return false;
    }
    // 3. 增加计数 + 设置 retryBySession (UI 显示 "正在重试 1/1...")
    autoRetryCountBySession.value = {
      ...autoRetryCountBySession.value,
      [sessionId]: count + 1,
    };
    retryBySession.value = {
      ...retryBySession.value,
      [sessionId]: {
        attempt: count + 1,
        maxAttempts: AUTO_RETRY_MAX,
        errorMessage: 'LLM 异常, FE 主动重发中...',
      },
    };
    chatData.value = { ...chatData.value };
    console.log(`[chat] D210: auto-retry triggered (${count + 1}/${AUTO_RETRY_MAX}), resend in ${AUTO_RETRY_DELAY_MS}ms`);
    // 4. 延迟 2s 后重发 (让 sidecar 清理 + user 看到 retry 指示)
    setTimeout(async () => {
      // 再次检查 session 是否还有效 (user 可能在这 2s 内关闭了 session / 切了 session)
      // 修 (D210): 之前用 activeSession.value?.id 是未定义 ref (编译过但 runtime 永远 true,
      //   任意 session 都重发). 正确是 sessionStore.activeSessionId.
      if (sessionStore.activeSessionId !== sessionId) {
        console.log('[chat] D210: auto-retry aborted (active session changed during delay)');
        return;
      }
      // 5. 重发 (用 sendPrompt 完整流程, quote 不带 — auto-retry 不重复 quote)
      // v0.5.0-D 第25轮 (D210.2) BUG FIX: fromAutoRetry=true 告诉 sendPrompt 这是 resend,
      //   不要清零 autoRetryCount. 之前 sendPrompt 入口无脑 clearAutoRetryCount, 导致
      //   auto-retry 调 sendPrompt 又把 count 清回 0, 下次 watchdog 触发时 count 还是 0
      //   又能 retry 一次 → 无限循环, user 看到 3 次重发.
      await sendPrompt(userContent, { fromAutoRetry: true });
    }, AUTO_RETRY_DELAY_MS);
    return true;
  }
  // v0.5.0-D 第23轮 (D210): user 新发消息时清零 auto-retry count
  //   让 user 的"再来一段"也能享受 auto-retry 保护
  function clearAutoRetryCount(sessionId: string) {
    if (autoRetryCountBySession.value[sessionId]) {
      autoRetryCountBySession.value = {
        ...autoRetryCountBySession.value,
        [sessionId]: 0,
      };
    }
  }

  // ===== Phase 6: autoTitle ghost prompt (first message trigger) =====
  // 思路: 主 session sendPrompt 进来后, 如果是 first message (no messages + no autoTitle +
  //   title 是默认 "新任务" 或空), spawn 一个 separate sidecar (用 ghostSessionId), 走
  //   同样的 LLM, prompt 是 "generate a concise title for this user message". 拿到 LLM
  //   返的 title → session.setAutoTitle. 完事 kill sidecar.
  // 关键: ghost sidecar 用一个独立的 session id, sidecar 自己会创建独立的 jsonl 文件, 主
  //   session 的 history 不受影响 (跟"sidecar skips append"效果等价, 实现走单独 sidecar).
  const ghostTriggeredForSession = new Set<string>();
  const GHOST_TIMEOUT_MS = 45_000;

  /** 清洗 LLM 返的 title: 去 "Title:" 前缀 / 引号 / markdown, cap 60 字 */
  function cleanGhostTitle(raw: string): string {
    let t = raw.trim();
    // 去 leading "Title:" / "标题:" prefix
    t = t.replace(/^(标题|title)\s*[:：]\s*/i, '');
    // 去外层引号 (英文/中文)
    t = t.replace(/^["'`「《]+/, '').replace(/["'`」》]+$/, '');
    // 去 markdown 标记 (###, **, __)
    t = t.replace(/^[#*_~`]+/, '').replace(/[#*_~`]+$/, '');
    // cap 60 chars
    if (t.length > 60) t = t.slice(0, 60);
    return t.trim();
  }

  /** 从 AgentMessage.content (string | AgentContentBlock[]) 提纯 text */
  function extractTextFromMessage(content: string | Array<{ type: string; text?: string; thinking?: string }>): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text!)
      .join('');
  }

  /**
   * Trigger ghost title prompt (fire-and-forget). cfg 来自 sendPrompt 内部统一构造的
   * ClientConfig snapshot, 这里强制把 sessionId 改 null 让 sidecar 走独立 jsonl.
   * 不抛错给 caller — 任何失败都 catch log, 不影响主 sendPrompt.
   */
  async function triggerGhostTitlePrompt(
    mainSessionId: string,
    userMessage: string,
    baseCfg: any,
  ): Promise<void> {
    const ghostSessionId = `__ghost_${mainSessionId}__${Date.now().toString(36)}__`;
    const ghostPrompt = [
      'You are a title generator. Given the user\'s first message in a chat, output a concise title (max 8 words, 30 characters) that captures the topic.',
      '',
      'Strict constraints:',
      '- Output ONLY the title, nothing else',
      '- No quotes, no markdown, no bullet points, no leading labels',
      '- Match the language of the user message (Chinese → Chinese title, English → English title)',
      '- No trailing punctuation',
      '',
      'User message:',
      '"""',
      userMessage,
      '"""',
      '',
      'Title:',
    ].join('\n');

    console.log('[chat] ghost: triggering for main=', mainSessionId, 'ghost=', ghostSessionId, 'userMsgLen=', userMessage.length);

    // 临时 listener 收集 assistant 文本
    let accumulatedTitle = '';
    let agentEnded = false;
    const off = await piTauri.on((event) => {
      // 只关心 ghost session
      if (!('sessionId' in event) || event.sessionId !== ghostSessionId) return;
      if (event.type === 'message_end' && event.message?.role === 'assistant') {
        const text = extractTextFromMessage(event.message.content);
        if (text) accumulatedTitle = text;  // 用 message_end 的 final (比 streaming 准)
      } else if (event.type === 'agent_end') {
        agentEnded = true;
        const finalTitle = cleanGhostTitle(accumulatedTitle);
        if (finalTitle && finalTitle.length >= 1) {
          sessionStore.setAutoTitle(mainSessionId, finalTitle);
          console.log('[chat] ghost: setAutoTitle for', mainSessionId, '=', JSON.stringify(finalTitle));
        } else {
          console.warn('[chat] ghost: empty/invalid title, skip setAutoTitle. raw=', JSON.stringify(accumulatedTitle));
        }
        try { off(); } catch (e) { /* ignore */ }
        piTauri.killSidecar(ghostSessionId).catch((e) => {
          console.warn('[chat] ghost: killSidecar failed (ignored)', e);
        });
      } else if (event.type === 'error') {
        console.warn('[chat] ghost: error event, aborting', event);
        try { off(); } catch (e) { /* ignore */ }
        piTauri.killSidecar(ghostSessionId).catch(() => { /* ignore */ });
      }
    });

    // Timeout 兜底
    const timeoutTimer = setTimeout(() => {
      if (!agentEnded) {
        console.warn('[chat] ghost: timeout after', GHOST_TIMEOUT_MS, 'ms, killing sidecar');
        try { off(); } catch (e) { /* ignore */ }
        piTauri.killSidecar(ghostSessionId).catch(() => { /* ignore */ });
      }
    }, GHOST_TIMEOUT_MS);

    // Spawn ghost sidecar + 发 prompt
    // 关键: 复用 send_prompt invoke, sessionId 传 ghostId, cfg.sessionId 改 null
    //   (让 sidecar 创建独立的 jsonl 文件, 主 session history 不受影响)
    try {
      const ghostCfg = { ...baseCfg, sessionId: null };
      await piTauri.sendPrompt(ghostSessionId, ghostPrompt, () => ghostCfg);
      console.log('[chat] ghost: sidecar spawned + prompt sent', ghostSessionId);
    } catch (e) {
      clearTimeout(timeoutTimer);
      try { off(); } catch (e2) { /* ignore */ }
      console.warn('[chat] ghost: spawn failed (ignored)', e);
    }
  }

  return {
    chatData,
    streamingBySession,
    errorBySession,
    retryBySession, // v0.4.2+ LLM 重试状态 (UI 显示"重试中 1/5...")
    // v0.5.0-D 第17轮 (D204): stream hang detector
    streamHangBySession,
    clearStreamHang(sessionId: string) {
      streamHangBySession.value = { ...streamHangBySession.value, [sessionId]: false };
      touchStreamEvent(sessionId);
      startStreamHangWatchdog(sessionId);
    },
    phaseBySession, // v0.5.1: 当前 phase (thinking/text/tool/idle) — UI status icon 轮换用
    // v0.4.3: context window 占用跟踪 + compaction 状态
    lastUsageBySession,
    contextTokensBySession,
    compactionBySession,
    lastCompactionBySession,
    isStreamingSession: isStreaming,
    getSessionData,
    getMessages,
    getThinking,
    getToolCalls,
    getError,
    getPhase, // v0.5.1 helper
    // v0.4.3: context + compaction helpers
    getContextTokens,
    getContextWindow,
    isContextHigh,
    isCompacting,
    getLastCompaction,
    // v0.5.0-D 第12轮: 6 分类 context breakdown
    getContextBreakdown,
    getContextBreakdownPercent,
    // v0.5.0-D 第21轮 (D208) + 第22轮 (D209): 4 分类 REAL 数据 (Pi SDK lastUsage, 累加)
    getContextBreakdownReal,
    getContextBreakdownRealPercent,
    cumulativeUsageBySession, // D209 累加 (input/output/cacheRead/cacheWrite)
    // v0.5.0-D 第12轮: 引用回复 (quote & reply)
    setQuote,
    clearQuote,
    quoteBySession,
    // v0.6+ 文件引用 (file reference) — sidebar 文件树点文件 → composer chip
    addFileRef,
    removeFileRef,
    clearFileRefs,
    fileRefsBySession,
    appendUserMessage,
    clearSession,
    sendPrompt,
    sendPromptViaWs, // deprecated, kept for backward compat
    setThinkingCollapsed,
    setStepCollapsed, // v0.4.1 step 累加
    setStepThinkingCollapsed,
    compact, // v0.4.3: 手动触发 context 压缩
    forceStopStreaming, // v0.5.0-PR3: 强制把 streaming 翻 false (abort 30s timeout / catch 兜底)
    // 2026-08-20 P0-1 补充 A: send queue (per-session FIFO, 队列里消息等 LLM 回完自动发)
    sendQueueBySession,
    getQueueLength,
    clearSendQueue,
    removeFromQueue,
  };
});
