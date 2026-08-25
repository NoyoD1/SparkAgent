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
import { useComposerAttachmentsStore } from './composerAttachments';
import { estimateTokens } from '@/lib/tokenEstimate';
import type { ContextBreakdown, ContextBreakdownReal } from '@/lib/tokenEstimate';
import {
  loadFromStorage,
  saveToStorage,
  genMessageId,
  emptySessionData,
  type SessionChatData,
} from './chatStorage';
// v3.64: streaming / retry / hang / phase / listener 状态抽到 chatStream.ts
import {
  streamingBySession,
  retryBySession,
  streamHangBySession,
  phaseBySession,
  listenerOffBySession,
  touchStreamEvent,
  startStreamHangWatchdog,
  stopStreamHangWatchdog,
  setPhase,
  getPhase,
  cleanupListenerForSession,
} from './chatStream';
// v3.65: send queue 抽到 chatQueue.ts
import {
  sendQueueBySession,
  getQueueLength,
  clearSendQueue,
  removeFromQueue,
} from './chatQueue';

export type { ChatMessage, ThinkingBlock, ToolCallBlock, Step };

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

  // 持久化 — v3.67 OOM fix (ADR-0026 真凶 #3):
  //   之前 watch(chatData, { deep: true }) 在每次事件末尾的 `chatData.value = {...}`
  //   (含每个 text_delta 的 message_update, 1 turn 20-50 次) 都触发 saveToStorage →
  //   sanitizeForStorage 全量深拷贝 + JSON.stringify + localStorage.setItem (同步阻塞
  //   主线程, 瞬时内存 2x). 长 session 累积 base64 时峰值叠加 → WebView2 OOM.
  //   修法: flush:'post' (DOM 更新后跑, 不阻塞渲染) + 500ms debounce (1 turn 内所有
  //   mutation 合并成 1 次 save) + sanitizeForStorage 改按需浅拷贝 (见 chatStorage.ts).
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  const flushSave = () => {
    if (saveTimer !== null) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    saveToStorage(chatData.value);
  };
  watch(
    chatData,
    () => {
      if (saveTimer !== null) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        saveTimer = null;
        saveToStorage(chatData.value);
      }, 500);
    },
    { deep: true, flush: 'post' },
  );
  // debounce 的代价: 变更后 500ms 内关窗口会丢最后一次 save. 用 beforeunload flush 兜底
  // (Tauri WebView2 关闭会触发 beforeunload). setup 只跑一次, listener 不需要 off.
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', flushSave);
  }

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
      // D214 v7: 同步清孤儿 recent refs (per-session last-mentioned tracking)
      //   session 删了 recent refs 也无意义, 清掉避免内存泄漏
      const nextRecent = { ...recentRefsBySession.value };
      let recentChanged = false;
      for (const k of Object.keys(nextRecent)) {
        if (!idSet.has(k)) { delete nextRecent[k]; recentChanged = true; }
      }
      if (recentChanged) {
        recentRefsBySession.value = nextRecent;
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

  // ===== Streaming state (v3.64 抽到 chatStream.ts, module-level singleton) =====
  // 共享 ref: streamingBySession / retryBySession / streamHangBySession / phaseBySession,
  // 闭包函数: isStreaming / clearStreamHang / touchStreamEvent / startStreamHangWatchdog /
  // stopStreamHangWatchdog / setPhase / getPhase / cleanupListenerForSession
  // 抽到 module-level 是因为这些状态在 chat store 外也被 watch 触发 (e.g. ChatMain.vue
  // 的 rAF 滚动跟随 watch isSessionStreaming 状态, v3.60), 共享 ref 避免循环 import.
  const errorBySession = ref<Record<string, string | null>>({});
  // 2026-08-20 P0-1 补充 A: send queue (per-session FIFO) — 抽到 chatQueue.ts (v3.65)
  // 业务约束: 用户在 LLM 还在回的时候可以继续编辑+点 send, 但不能再 spawn 一个 sidecar (状态机冲突),
  //   所以消息先进队, 等当前 turn 走完 (agent_end willRetry=false) 再自动出队发送.

  // v0.4.2+ retryBySession / v0.5.0-D hang / v0.5.0-D D210.2 listener 状态 — 全部抽到 chatStream.ts
  // (v3.64 抽) — module-level singleton 跟 chat.ts Pinia store 共享.
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
    // v0.6 (N4): 压缩成功时只清 contextTokens (4 分类不清, 下次 message_end 覆盖)
    //   之前 D209 清 4 分类 + contextTokens, 修后只清 contextTokens
    //   4 分类由 per-turn 覆盖, 压缩后下一轮 LLM 报的 usage 会重写, 没必要现在清
    if (!event.aborted && !event.errorMessage) {
      contextTokensBySession.value = {
        ...contextTokensBySession.value,
        [sessionId]: 0,
      };
      console.log(`[chat] compaction_end: reset contextTokens (compaction freed context, 4 分类下次 message_end 覆盖)`);
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
        // v0.6 (P0-C): 算 freedTokens (success 时 = beforeCompact, 因为 contextTokens 已清零)
        //   失败时 freedTokens = 0 (没释放)
        const beforeCompact = d2.messages[updateIdx].compactionMarker?.beforeCompact ?? 0;
        const freedTokens = finalState === 'success' ? Math.max(0, beforeCompact) : 0;
        // 原地更新 marker (不要 push 新消息)
        d2.messages[updateIdx] = {
          ...d2.messages[updateIdx],
          compactionMarker: { state: finalState, errorMessage, freedTokens },
        };
        console.log(`[chat] compaction divider updated: in_progress → ${finalState}${errorMessage ? ' (' + errorMessage.slice(0, 60) + ')' : ''} (freed=${freedTokens})`);
      } else {
        // 兜底: 找不到 in_progress marker (Pi SDK 内部自动 compaction, 没经过 compact()
        // 推过 in_progress), 直接 push 一条 success / failure
        // 注意: auto-compaction 路径没有 beforeCompact, freedTokens 不算 (Pi SDK 自身不报"释放量")
        d2.messages.push({
          id: `sys-compact-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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
    // 2026-08-20 P1-3: friendlyErrorMessage 返回 { friendly, raw, category } 三段
    //   friendly 展示给 user, raw 折叠显示给 dev 排查, category 给 UI 调样式 (401/403/429/5xx/network 各不同色)
    const classified = friendlyErrorMessage(errorMessage);
    d.messages.push({
      id: `sys-error-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      role: 'system',
      content: '__LLM_ERROR_DIVIDER__',
      createdAt: new Date().toISOString(),
      errorMarker: {
        errorMessage: classified.friendly,
        rawError: classified.raw,
        category: classified.category,
        reason,
        at: Date.now(),
        hasPartialContent,
      },
    } as ChatMessage);
    chatData.value = { ...chatData.value, [sessionId]: { ...d } };
    // 2026-08-20 P1-3: errorBySession 保持 string 类型 (UI toast / 状态指示用, 不需要 raw + category)
    //   raw + category 在 errorMarker 字段里, ChatMessage.vue 渲染时读
    errorBySession.value = { ...errorBySession.value, [sessionId]: classified.friendly };
    console.log(
      `[chat] D212: error divider pushed (reason=${reason}, category=${classified.category}, ` +
      `hasPartialContent=${hasPartialContent}, errorMessage=${errorMessage.slice(0, 80)})`
    );
  }

  /**
   * 2026-08-20 P1-7: 推一条 warning 横线 (跟 error divider 同款, 区别是黄色不是红色).
   *   触发场景: LLM 调用结束但 assistant message 没创建 (idx=-1) — Pi SDK 协议层"静默失败",
   *   可能原因: LLM 拒绝 / 限流 / provider 协议层不兼容 / Pi SDK bug.
   *   不算 error (没捕获到具体 errorMessage),所以视觉上用 warning 黄,user 一眼知道是
   *   "AI 没回复 + 大概原因" 而不是 "AI 调用失败 + 具体错误".
   *
   * 防重复: 跟 error divider 一样, 看最后一条 system message 是不是 warningMarker,
   *   是就 skip (LLM 抽风时可能连续 emit 多个 event 触发 push).
   */
  function pushWarningDivider(
    sessionId: string,
    title: string,
    hint: string,
    rawEventLog?: string,
  ) {
    const d = getSessionData(sessionId);
    if (!d) return;
    const lastMsg = d.messages[d.messages.length - 1];
    if (lastMsg && lastMsg.role === 'system' && lastMsg.warningMarker) {
      console.log(`[chat] P1-7: skip warning divider (already pushed: ${lastMsg.warningMarker.title.slice(0, 60)})`);
      return;
    }
    d.messages.push({
      id: `sys-warn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      role: 'system',
      content: '__LLM_WARNING_DIVIDER__',
      createdAt: new Date().toISOString(),
      warningMarker: {
        title,
        hint,
        rawEventLog,
        at: Date.now(),
      },
    } as ChatMessage);
    chatData.value = { ...chatData.value, [sessionId]: { ...d } };
    console.log(`[chat] P1-7: warning divider pushed (title=${title})`);
  }

  /**
   * v0.6.1: 把 provider 的 raw 错误转成 user 友好的中文提示.
   * 2026-08-20 P1-3: 扩展分类 (401 / 403 / 5xx) + raw error 折叠.
   * 分类匹配用 keyword includes (不严格, 接受误判 — 优先覆盖常见情况).
   * 命中后返回 { friendly, raw } 两段, raw 留给 UI 折叠显示给 dev 排查.
   */
  function friendlyErrorMessage(raw: string): { friendly: string; raw: string; category: string } {
    const lower = raw.toLowerCase();
    // 401 / unauthorized / invalid api key → v3.37 改: settings.json 里 ProviderConfigDto.apiKey 字段失效/填错
    //   (之前是 keychain 失效, v3.37 整个 keychain 移除, apiKey 走 settings.json)
    if (lower.includes('401') ||
        lower.includes('unauthorized') ||
        lower.includes('invalid api') ||
        lower.includes('invalid_api_key') ||
        lower.includes('authentication')) {
      return {
        friendly: 'API Key 无效 (401 Unauthorized). 可能原因: \n' +
                  '  • Settings → Providers 里的 apiKey 失效 / 填错\n' +
                  '  • settings.json 里保存的 apiKey 跟当前 provider 不匹配\n' +
                  '  • provider 账号被封 / key 已过期\n' +
                  '下一步: 去 Settings → Providers 重新填 apiKey, 或检查 provider 官网控制台。',
        raw,
        category: 'auth_401',
      };
    }
    // 403 / forbidden / model not allowed → model 名错 / 权限不够
    if (lower.includes('403') ||
        lower.includes('forbidden') ||
        lower.includes('permission denied') ||
        lower.includes('not allowed') ||
        lower.includes('model_not_found') ||
        lower.includes('model not found')) {
      return {
        friendly: '权限不足 / Model 不支持 (403 Forbidden). 可能原因: \n' +
                  '  • active model 名拼错 (检查 model id 跟 provider 控制台对不对)\n' +
                  '  • provider 没给当前 model 权限 (需要升级套餐 / 申请白名单)\n' +
                  '  • baseUrl 跟 model 不匹配 (e.g. sensenova baseUrl 不能调 deepseek model)\n' +
                  '下一步: 切到 Settings → Providers 检查 model 名, 或换一个 model 试。',
        raw,
        category: 'forbidden_403',
      };
    }
    // 429 / 限流 / quota
    if (lower.includes('429') ||
        lower.includes('rate limit') ||
        lower.includes('rate_limit') ||
        lower.includes('tpm') ||
        lower.includes('tokens per minute') ||
        lower.includes('quota')) {
      return {
        friendly: 'LLM 限流 (429: TPM/Quota 触发). 可能原因: \n' +
                  '  • provider 免费层 TPM 配额较小, 当前会话累计 token 已超\n' +
                  '  • 1 分钟内重新发送会自动恢复\n' +
                  '长 session 历史会占 token, 建议开新 session 或压缩 (右上角 \n',
        raw,
        category: 'rate_limit_429',
      };
    }
    // 5xx / internal server error / bad gateway / service unavailable
    if (lower.includes('500') ||
        lower.includes('502') ||
        lower.includes('503') ||
        lower.includes('504') ||
        lower.includes('internal server error') ||
        lower.includes('bad gateway') ||
        lower.includes('service unavailable')) {
      return {
        friendly: 'Provider 服务异常 (5xx). 可能原因: \n' +
                  '  • provider 端服务挂了 / 维护中\n' +
                  '  • 临时网络抖动\n' +
                  '下一步: 等 1-2 分钟重试, 或切到别的 provider 临时顶一下。',
        raw,
        category: 'server_5xx',
      };
    }
    // network / timeout / econnrefused / fetch failed
    if (lower.includes('econnrefused') ||
        lower.includes('enotfound') ||
        lower.includes('etimedout') ||
        lower.includes('fetch failed') ||
        lower.includes('network') ||
        lower.includes('timeout')) {
      return {
        friendly: '网络错误. 可能原因: \n' +
                  '  • 断网 / VPN 不稳\n' +
                  '  • provider baseUrl 拼错 (检查 Settings → Providers 里的 baseUrl)\n' +
                  '  • provider 服务挂 (海外 API 偶尔不稳)\n' +
                  '下一步: 检查网络 + baseUrl, 重试。',
        raw,
        category: 'network',
      };
    }
    // 未命中分类: 原样返回, user 看 raw error
    return { friendly: raw, raw, category: 'unknown' };
  }

  // startStreamHangWatchdog / stopStreamHangWatchdog 抽到 chatStream.ts (v3.64)
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

  // ====== D214 v7: last-mentioned tracking (隐式 ref 续接) ======
  // 背景: user 上一句引用了 huashu-design, 这一句说"再分析一下" — 没 chip marker,
  //   旧逻辑 fall through 到 cache, LLM 看不到 huashu-design. 解法: 维护"最近提到的
  //   ref 列表", 每次 send 拼 prompt 时, 把 recent refs 中**不在当前 message 显式
  //   提到的**也读 body 注入 `<recent_refs>` section. 显式 mention 走 `<reference>`,
  //   隐式最近提到走 `<recent_refs>` (LLM 内部协议, 不显示在 user 气泡).
  //
  // 上限 3 条: cap token 成本. LLM 真要上下文还有 system prompt 兜底, 不至于
  //   完全丢失. 长文件 (几 KB skill) × 3 = 几十 KB, 还能接受.
  //
  // 显式 vs 隐式区分: sendPrompt 解析 [[ref:kind:name]] marker 时, 收集
  //   explicitRefKeys (Set<string>); recentRefs 不在 Set 里的才算"隐式".
  type RecentRef = { kind: 'skill' | 'tool' | 'mcp' | 'extension' | 'command'; name: string };
  const RECENT_REFS_MAX = 3;
  const recentRefsBySession = ref<Record<string, RecentRef[]>>({});

  /**
   * 加一个 recent ref. deduped (同 kind+name move to 末尾) + cap.
   * Composer.insertMarkerAtCursor 调这里, 把刚插入的 chip 推到末尾.
   */
  function addRecentRef(sessionId: string, ref: RecentRef) {
    const list = recentRefsBySession.value[sessionId] ?? [];
    // 去掉已存在的 (按 kind+name dedupe)
    const filtered = list.filter((r) => !(r.kind === ref.kind && r.name === ref.name));
    // 末尾追加, cap 上限 (slice 留最后 N 个)
    const newList = [...filtered, ref].slice(-RECENT_REFS_MAX);
    recentRefsBySession.value = { ...recentRefsBySession.value, [sessionId]: newList };
  }

  function getRecentRefs(sessionId: string): RecentRef[] {
    return recentRefsBySession.value[sessionId] ?? [];
  }

  function clearRecentRefs(sessionId: string) {
    if (!recentRefsBySession.value[sessionId]?.length) return;
    const next = { ...recentRefsBySession.value };
    delete next[sessionId];
    recentRefsBySession.value = next;
  }
  // v0.5.1: 当前 phase (thinking / text / tool / idle) — 用来在 streaming 状态
  //   显示 "思考中…" / "正在下笔…" / "调用工具…" 等不同文字, 文字轮换 (每 1.8s 换一次).
  //   用户反馈 "实际当前任务还在后台继续跑, 但是因为是一段一段回复的, 正文可能有多条,
  //   导致看起来像是卡了, 需要加适当的提示icon动画, 表示当前是在走的"
  // phaseBySession / setPhase / getPhase 抽到 chatStream.ts (v3.64)

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
  /**
   * 2026-08-24 v3.29: per-session contextWindow. 之前 v0.4.4.6 只读全局 activeModel.contextWindow,
   *   user 反馈: '我切换了模型, 明明设置的是100W, 但显示200K' — Composer 切的是 per-session
   *   model (getSessionModelId), 但 getContextWindow 拿全局, 导致切了 model 仍显示旧 ctx.
   *   修法: 跟 currentModelLabel 一致, 先拿 session modelId, fallback 到全局 active.
   *   sessionId 不传时 (向后兼容), 退到 v0.4.4.6 全局行为.
   */
  function getContextWindow(sessionId?: string): number {
    const sid = sessionId ?? sessionStore.activeSessionId;
    const models = configStore.allEnabledModels;
    const findCw = (id: string | null | undefined): number => {
      if (!id) return 0;
      const found = models.find((x) => x.model.id === id);
      return found?.model.contextWindow ?? 0;
    };
    // 1. per-session 优先 (跟 getSessionModelId 同步)
    if (sid) {
      const sessionModelId = sessionStore.getSessionModelId(sid);
      const cw = findCw(sessionModelId);
      if (cw > 0) return cw;
    }
    // 2. 全局 active fallback (老 config 没 per-session modelId 时的兜底)
    const activeModelId = configStore.activeModel?.id;
    const cw = findCw(activeModelId);
    return cw > 0 ? cw : DEFAULT_CONTEXT_WINDOW;
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
  // v0.6+ ADR-0022 v3.7: 加 images / files 字段, 渲染 user 气泡里的图片缩略图 + file chip
  // v3.9: images 改用 MessageImage schema (savedPath + thumbnail + in-memory data)
  function appendUserMessage(
    sessionId: string,
    content: string,
    quoteContent: string | null = null,
    images?: import('@/lib/mock/types').MessageImage[],
    files?: Array<{ path: string; filename: string; mimeType: string; bytes: number }>,
  ) {
    const d = getSessionData(sessionId);
    d.messages.push({
      id: genMessageId('u'),
      role: 'user',
      content,
      quoteContent: quoteContent ?? undefined,
      images: images && images.length > 0 ? images : undefined,
      files: files && files.length > 0 ? files : undefined,
      createdAt: new Date().toISOString(),
    });
    // 触发响应式更新
    chatData.value = { ...chatData.value, [sessionId]: { ...d } };
  }

  function clearSession(sessionId: string) {
    chatData.value = { ...chatData.value, [sessionId]: emptySessionData() };
    // D214 v7: clear chat 上下文也清掉 recent refs (新会话不需要上一段的 ref)
    clearRecentRefs(sessionId);
  }

  /**
   * 发 prompt. v0.3.5+ 自动确保 session 存在.
   * - 有 active session → 直接发
   * - 没 active session + 有 workspace → 新建 session, 再发
   * - 没 workspace → 用 piTauri.ensureDefaultWorkspace() (<home>/PiAgent) 建 workspace + session, 再发
   *   (用户可手动通过 sidebar / tab strip 的"本地"下拉选别的路径)
   */
  async function sendPrompt(content: string, opts: { fromQueue?: boolean; userText?: string } = {}) {
    const text = content.trim();
    if (!text) return;
    // ADR-0022 v3.5: 把 composer attachments 拼到 LLM input
    //   images 走 Pi SDK images[] 字段 (vision model 看图)
    //   files 走 <file path="..." /> tag 拼到 message text (LLM 调 read 工具读)
    const attachmentsStore = useComposerAttachmentsStore();
    const { images: attachmentImages, textAppend: attachmentFileTags } = attachmentsStore.buildForPrompt();
    // D214 v5: userText = 干净 user 文本 (无 <reference> section, 但有 [[ref:...]] marker),
    //   用于 user 气泡渲染. 不传则 fallback 到 text (旧行为, reference 块会显示在 user 气泡).
    const userBaseText = (opts.userText ?? text).trim();
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
        [targetSessionIdForQueue]: [...list, { llm: text, user: userBaseText }],
      };
      console.log('[chat] sendPrompt: enqueued (streaming), session=', targetSessionIdForQueue, 'queueLen=', list.length + 1, 'preview=', userBaseText.slice(0, 40));
      return;
    }
    console.log('[chat] sendPrompt: contentLen=', text.length, 'activeSession=', sessionStore.activeSessionId, 'fromQueue=', !!opts.fromQueue);

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
      const sess = sessionStore.addSession(wid, userBaseText.slice(0, 30) || '新任务');
      sessionId = sess.id;
      wasNewlyCreated = true;
      console.log('[chat] sendPrompt: created new session', sessionId);
    }

    // Phase 6: 检测 first message (用于触发 ghost title prompt).
    //   条件: 新建 session 或 (已有 session 但 0 messages) + 没 autoTitle + title 是默认.
    //   ghostTriggeredForSession 防重 (从队列取出来的 resend 也不重复触发).
    const sessMeta = sessionStore.sessions.find((s) => s.id === sessionId);
    const isFirstMessageForGhost =
      !opts.fromQueue &&
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
    const fileRefs = fileRefsBySession.value[sessionId] ?? [];
    let quoteContent: string | null = null;
    let quotedLines = '';
    let refsBlock = '';
    let refsHeader = '';
    if (quote && quote.content.trim()) {
      // markdown blockquote 标记: 每行加 "> " 前缀
      //   保留原文 (不剥离 think), model 自己处理
      quotedLines = quote.content
        .split('\n')
        .map((line) => line.trim() ? `> ${line}` : '>')
        .join('\n');
      quoteContent = quote.content;
    }
    if (fileRefs.length > 0) {
      // v0.6+ 文件引用 (file reference) — sidebar 文件树点文件收集的 refs
      //   拼成 markdown code block 放在 quote 之后, user text 之前. LLM 看到路径能直接 read.
      refsBlock = fileRefs.map((r) => `\`${r.path}\``).join('\n');
      refsHeader = '以下文件被引用 (来自当前工作区):';
    }
    // D214 v5: 拆 LLM text 和 user bubble text
    //   - llmText = quote + file refs + text (text 含 <reference> section, 给 LLM 看到完整 context)
    //   - fullUserText = quote + file refs + userBaseText (userBaseText 不含 reference section, 给 user 看)
    //   顺序一致: quote 在前, file refs 在中, base text 在后
    let llmText = text;
    let fullUserText = userBaseText;
    if (quote) {
      llmText = `${quotedLines}\n\n${llmText}`;
      fullUserText = `${quotedLines}\n\n${fullUserText}`;
    }
    if (fileRefs.length > 0) {
      llmText = `${quotedLines}\n\n${refsHeader}\n${refsBlock}\n\n${text}`;
      fullUserText = `${quotedLines}\n\n${refsHeader}\n${refsBlock}\n\n${userBaseText}`;
    }
    // ADR-0022 v3.5: 把 pendingFiles 拼成 <file path="..." /> tag 拼到 message text
    //   images 走 Pi SDK images[] 字段 (上面 sendPrompt 调用传 attachmentImages)
    //   file tag 走这里 — Pi SDK 不支持 file content block, 用 tag 提示 LLM 调 read 工具
    if (attachmentFileTags) {
      llmText = llmText ? `${llmText}\n\n${attachmentFileTags}` : attachmentFileTags;
    }
    // ADR-0022 v3.7+v3.9: 把 images + files 也存到 user message, 渲染 user 气泡里的
    //   图片缩略图 / file chip (跟 sidebar file-ref chip 类似视觉)
    //   v3.9: image 存 MessageImage 全字段 (savedPath + thumbnail + data),
    //         data 在持久化时会被 sanitizeForStorage 剥掉, reload 后变 undefined
    //         但 savedPath + thumbnail 还在 — click preview 时从 savedPath 重读
    // v3.67 OOM fix (ADR-0026 真凶 #2): 不再把 base64 data 放进 message.images.
    //   chatData 是常驻内存 + deep watch 全量追踪的对象, base64 放这里会让每个
    //   session 累积 6.7MB+ (实测 .tauri-debug.log: 5 个 user event 共 6.7MB base64),
    //   且切 session 不释放 → WebView2 JS heap 爆 OOM.
    //   base64 只通过 attachmentsStore.buildForPrompt() 传给 Pi SDK (vision 发送),
    //   不落 store. message.images 只留持久化字段 (savedPath + thumbnail + mimeType
    //   + bytes):
    //     - 渲染: ChatMessage.vue 用 thumbnail (200x200 JPEG, ~10-30KB)
    //     - 点击预览: openAttachmentPreviewImage 走 savedPath → openImageFromPath
    //       (Tauri command 已存在, reload 后也是这条路径, 行为一致)
    //     - TaskDrawer: base64 是 optional, 预览同样走 savedPath fallback
    const attachmentImagesForMsg = attachmentsStore.pendingImages.map((img) => ({
      mimeType: img.mimeType,
      bytes: img.bytes,
      savedPath: img.savedPath,
      thumbnail: img.thumbnail,
    }));
    const attachmentFilesForMsg = attachmentsStore.pendingFiles.map((f) => ({
      path: f.path,
      filename: f.filename,
      mimeType: f.mimeType,
      bytes: f.bytes,
    }));
    if (quote) {
      console.log('[chat] sendPrompt: with quote (messageId=', quote.messageId, ', len=', quote.content.length, ', llmLen=', llmText.length, ', userLen=', fullUserText.length, ')');
      // 调试: 打印实际发送的两份文本, F12 console 可验证
      console.log('[chat] sendPrompt: llmText =\n', llmText);
      console.log('[chat] sendPrompt: fullUserText =\n', fullUserText);
    }
    if (fileRefs.length > 0) {
      console.log('[chat] sendPrompt: with fileRefs (count=', fileRefs.length, ', paths=', fileRefs.map((r) => r.path).join(', '), ')');
    }
    appendUserMessage(
      sessionId,
      fullUserText,
      quoteContent,
      attachmentImagesForMsg,
      attachmentFilesForMsg,
    );
    streamingBySession.value = { ...streamingBySession.value, [sessionId]: true };
    errorBySession.value = { ...errorBySession.value, [sessionId]: null };
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
    //   清理掉. (v0.6.3-rc1: 不再有 tryAutoRetry 后续 resend)
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
          //   Rust 端 error 通常对应 LLM 没真正开始 / spawn 失败 / settings.json 里
          //   apiKey 错误等 (v3.37 改: 之前是 keychain 错误, 现在 settings.json apiKey 字段)
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
          // 2026-08-20 P1-7: idx=-1 = LLM 协议层"静默失败" (没 emit message_start)
          //   之前 user 看到 "AI 没回复" 一脸懵 (跟 2026-08-20 sidecar 崩溃场景类似但根因不同,
          //   sidecar 崩溃是工具层 bug, 这条是 Pi SDK 协议层 edge case).
          //   修: 推 warning divider 告诉 user 原因, 引导他下一步怎么排查.
          if (idx < 0) {
            const totalMsgs = d2.messages.length;
            pushWarningDivider(
              sessionId,
              'AI 没返回内容',
              // hint 给几种最常见根因 + 下一步行动, user 知道该改什么
              'LLM 调用结束但没产生 assistant message (Pi SDK 协议层静默失败). 常见原因: ' +
              '① LLM 拒绝请求 (限流 / model 不支持 / 内容违规) ' +
              '② Provider 协议层不兼容 Pi SDK 0.84.2 的 stream 协议 ' +
              '③ LLM 返回了空响应 (无 content, 无 thinking, 无 tool_call). ' +
              '建议: 切到 ask 模式重试 / 换 model / 看 .tauri-debug.log sidecar stderr 找 raw 错误。',
              `agent_end event: willRetry=${event.willRetry}, totalMsgs=${totalMsgs}, ` +
                `lastEventType=${event.type}`,
            );
          }
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
            console.log('[chat] agent_end: dequeue sendPrompt, remaining=', remaining.length, 'preview=', next.user.slice(0, 40));
            queueMicrotask(() => {
              void sendPrompt(next.llm, { fromQueue: true, userText: next.user });
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
              //   v0.6 (N4+N7): 取消 D209 跨 turn 累加, per-turn 覆盖
              //     之前 D209: cumulativeUsageBySession 跨 turn 累加 input/output/cacheRead/cacheWrite,
              //       contextTokensBySession 累加 input + cacheRead. 修后: 全部 per-turn 覆盖.
              //     根因: Pi SDK 0.84.2 各 provider usage.input/cacheRead/cacheWrite 是 per-request (LLM 视角),
              //       cacheRead 跨 turn 是同一批 cache 命中, 累加会重复计算. 数字虚高, 跟真实 context 不符.
              //     修后: contextTokens = input + cacheRead + cacheWrite (不含 output, LLM 报的最准).
              //       跟 Claude Code 主流算法一致, 跟 Pi SDK 0.84.2 trigger 逻辑一致.
              //     跨 turn "累加" 的效果天然发生 (history 越来越长, totalTokens 自然变大), 不需要 FE 累加.
              //   lastUsageBySession / cumulativeUsageBySession 字段保留 (popover 4 分类展示用),
              //     改成 per-turn 覆盖 (跟 N4 一致).
              //   user 反馈: "上下文窗口的计数应该是累加的" — 修复后跨 turn 数字还是会越来越大
              //     (因为 history 越来越长), 只不过不是手动累加, 是 LLM 视角的真实 current context.
              if (event.message?.usage && idx >= 0) {
                const finalUsage = event.message.usage;
                // per-turn (单次, 覆盖) - 调试 / 单次显示用
                lastUsageBySession.value = { ...lastUsageBySession.value, [sessionId]: finalUsage };
                // v0.6 (N4): 4 分类 per-turn 覆盖 (跟 N4 一致, popover 4 分类展示用)
                cumulativeUsageBySession.value = {
                  ...cumulativeUsageBySession.value,
                  [sessionId]: finalUsage,
                };
                // v0.6 (N4): current context = input + cacheRead + cacheWrite (Claude Code 主流算法)
                //   不含 output (output 是回复不在 context 里), per-turn 覆盖不跨 turn 累加
                //   跨 turn 数字会自然增长 (history 越来越长 LLM 报 totalTokens 也越来越大)
                const totalCtx = (finalUsage.input ?? 0) + (finalUsage.cacheRead ?? 0) + (finalUsage.cacheWrite ?? 0);
                contextTokensBySession.value = {
                  ...contextTokensBySession.value,
                  [sessionId]: totalCtx,
                };
                // v0.4.3: 写到 assistant message.usage, 后续从 store 读
                assistant.usage = finalUsage;
                // v0.6 (N4): 改 per-turn 覆盖, cumulative 字段名保留但语义是 "per-turn" (跟 D209 反向)
                console.log(
                  `[chat] message_end: turn usage=${finalUsage.input}+${finalUsage.cacheRead} (cache) + ${finalUsage.cacheWrite} (write); ` +
                  `context=${contextTokensBySession.value[sessionId]} (current turn, formula=input+cacheRead+cacheWrite)`
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
          // 2026-08-20 P1-1: extension_ui_request 埋点 — 排查 "弹窗 lost" 根因
          //   跟 sidecar confirm 链路配对, dev 排查时 grep "PERM-FE:" + "PERM-OK:" 对比 elapsed
          //   lost 排查: 找到 "PERM-FE: extension_ui_request" 但无后续 "PERM-FE: respond sent" → 中间卡住
          if (event.method === 'confirm') {
            // tool permission 弹窗 (跟 v0.4.x permission_request 行为一致)
            console.log(`[chat] PERM-FE: extension_ui_request received id=${event.id.slice(0, 8)} title=${event.title} sessionId=${event.sessionId}`);
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
    //   这时候老 listener 必须保留. 但下次 sendPrompt 进来前必须能调 off() 把老 listener 清掉
    //   (否则 N 个老 listener 活着, 每个事件处理 N 次).
    listenerOffBySession.set(sessionId, off);
    console.log('[chat] listener ready, invoking send_prompt');

    // 4. 触发 prompt
    try {
      const config = useConfigStore();
      const active = config.activeProvider;
      const model = config.activeModel;
      console.log('[chat] sendPrompt: active=', active?.label, 'model=', model?.id);
      // 2026-08-24 v3.27: 之前这里 throw '请先在 Settings → Providers...' 把 user 痛点触发了.
      //   移到下面 effective fallback 之后, 走三段 fallback + provider.models[0] 兜底 + toast 提示.
      //   (line 1810 那段才是真正的 final check, 这里只 log)
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
      // 2026-08-24 v3.27: 显式 narrowing 让 TS 知道 effectiveProvider 非空 (后面 ?? null 兜底);
      //   final check 在 line 1818 还会再判, 这里 narrowing 是局部优化.
      const provider = effectiveProvider;
      let effectiveModel: typeof model = sessionModelId && provider
        ? provider.models.find((m) => m.id === sessionModelId) ?? null
        : null;
      if (!effectiveModel && provider) {
        effectiveModel = provider.models.find((m) => m.id === provider.activeModelId) ?? null;
      }
      if (!effectiveModel) effectiveModel = model;  // 全局 active
      // 2026-08-24 v3.27: 兜底 — provider.models[0] (之前是 throw, 但 user 痛点说 '用户在会话时自己选模型',
      //   不应阻塞发消息). 实际场景: user 选了 provider 但没设 activeModelId, 或 model 字段没保存.
      //   兜底用 provider 第一个 model, 弹 toast 提示, 让 user 在 model picker 显式选.
      let autoFallbackUsed = false;
      if (!effectiveModel && provider?.models.length) {
        effectiveModel = provider.models[0];
        autoFallbackUsed = true;
      }
      console.log('[chat] sendPrompt: session=', sessionId, 'effectiveProvider=', effectiveProvider?.label, 'model=', effectiveModel?.id, 'permissionMode=', sessionPermissionMode);
      if (!effectiveProvider || !effectiveModel) {
        // 真没 model (provider.models 也是空) — 弹 toast + return, 不 throw
        //   user 痛点: '应该不阻塞发消息', 但完全没 model 还是没法 send. 给明确提示.
        useUiStore().showToast(
          `未配置 model: ${effectiveProvider?.label ?? '无 provider'}. 去 Settings → Providers 选 model`,
          'error',
          5000,
        );
        return;
      }
      if (autoFallbackUsed) {
        // 一次性提示, 引导 user 在 model picker 显式选
        useUiStore().showToast(
          `未选 model, 用 provider 默认: ${effectiveModel.id}. (model picker 可改)`,
          'info',
          3500,
        );
      }
      // 2026-08-24 v3.29: 超 contextWindow 自动压缩.
      //   user 反馈: '如果当前会话已经超过切换后模型最大支持的上下文窗口了, 那么在发送消息后
      //   会自动压缩'. 场景: 之前用大模型 (e.g. 200K) 累积了 150K 历史, 切到 100K 模型
      //   (effectiveModel.contextWindow 变了) → 实际超 100K. send 前 await 压缩, 让
      //   压缩后 history 落到新 ctx window 内再 send. 压缩完后 Pi SDK 走 same session,
      //   activeModel 已经是新模型, 接着 send 不会超.
      //   阈值: 跟 Pi SDK overflow 触发同 (>= contextWindow), 给 user 留点 buffer
      //   (Pi SDK 内部 reserveTokens=16384 算 auto threshold, 我们保守 95% 触发避免
      //   一次压缩压不到位).
      //   isCompacting 守卫: 防止重入 (e.g. 上次没完又触发).
      const cw = effectiveModel.contextWindow ?? 0;
      const currentTokens = getContextTokens(sessionId!);
      const sessionActive = sessionStore.activeSessionId === sessionId;
      const fmtCtx = (n: number): string => {
        if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
        if (n >= 1000) return `${(n / 1000).toFixed(0)}K`;
        return String(n);
      };
      if (cw > 0 && currentTokens >= cw * 0.95 && !isCompacting(sessionId!)) {
        console.log(
          `[chat] sendPrompt: 历史 ${currentTokens} >= ${cw} * 0.95, 自动压缩 before send (session=${sessionId})`,
        );
        useUiStore().showToast(
          `context 超过新模型 ${effectiveModel.id} 的 ${fmtCtx(cw)} (已用 ${fmtCtx(currentTokens)}), 自动压缩中…`,
          'warning',
          3000,
        );
        try {
          await compact(sessionId!);
          // 压缩完 send 接着走 (effectiveModel 还是新模型, compact 不改 model)
        } catch (e) {
          // 压缩失败仍让 send 走 (Pi SDK overflow 会兜底, 或 send fail), 不阻塞
          const msg = e instanceof Error ? e.message : String(e);
          console.warn(`[chat] auto-compact failed: ${msg}`);
        }
        void sessionActive;  // 占位, 防止 lint 报 unused
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
      await piTauri.sendPrompt(sessionId, llmText, attachmentImages, cfgFn);
      // ADR-0022 v3.5: send 完清理 attachments (避免下次 send 重复带)
      // 走 store.clear() 集中处理 (revoke preview URL, 清 pending 列表)
      attachmentsStore.clear();
      console.log('[chat] sendPrompt: piTauri.sendPrompt resolved, attachments cleared');

      // Phase 6: fire-and-forget ghost title prompt (仅 first message, 不阻塞主流程)
      if (isFirstMessageForGhost) {
        ghostTriggeredForSession.add(sessionId);
        const baseCfg = cfgFn();
        // D214 v5: ghost title 用 userBaseText (干净 user 文本), 不用 text (含 reference block)
        triggerGhostTitlePrompt(sessionId, userBaseText, baseCfg).catch((e) => {
          console.warn('[chat] ghost: trigger failed (ignored)', e);
        });
      }
    } catch (e) {
      console.error('[chat] sendPrompt FAILED', e);
      const rawMsg = e instanceof Error ? e.message : String(e);
      // 2026-08-20 P1-3: friendlyErrorMessage 现在返 { friendly, raw, category } 对象, 取 friendly
      const classified = friendlyErrorMessage(rawMsg);
      errorBySession.value = { ...errorBySession.value, [sessionId]: classified.friendly };
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
   * - 自动场景: Pi SDK 内部 `shouldCompact(ctx, win, settings)` 检测到
   *   `ctx > win - reserveTokens` (默认 reserveTokens=16384, 200K 窗口下约 92% 触发), 走 auto
   *   compaction (event.reason = 'threshold' / 'overflow'). FE 不用管, 也改不了阈值 (Pi SDK 0.84.2
   *   settingsManager 只暴露 enabled setter, reserveTokens/keepRecentTokens 是只读 getter).
   *   ⚠️ 注意: 70% 是 `isContextHigh()` 的 UI 高亮阈值, 不是 auto-compaction 触发阈值.
   *   自动压缩走的是 Pi SDK settings, 不是 isContextHigh.
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
    // v0.6 (P0-C): 记录压缩前 contextTokens, 用来在 success divider 上显示"释放 X tokens"
    const beforeCompact = getContextTokens(sid);
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
    // 2026-08-24 v3.27: 兜底 provider.models[0] (跟 sendPrompt 同 pattern)
    if (!effectiveModel && effectiveProvider?.models.length) {
      effectiveModel = effectiveProvider.models[0];
    }
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
      //   v0.6 (P0-C): 推 in_progress 时带 beforeCompact, 压缩成功时算 freedTokens = beforeCompact
      const dInProg = getSessionData(sid);
      if (dInProg) {
        dInProg.messages.push({
          id: `sys-compact-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          role: 'system',
          content: '__COMPACTION_DIVIDER__',
          createdAt: new Date().toISOString(),
          compactionMarker: { state: 'in_progress', beforeCompact },
        } as ChatMessage);
        chatData.value = { ...chatData.value, [sid]: { ...dInProg } };
        console.log(`[chat] compaction divider pushed: in_progress (manual, session=${sid}, beforeCompact=${beforeCompact})`);
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
      console.log('[chat] forceStopStreaming: dequeue sendPrompt, remaining=', remaining.length, 'preview=', next.user.slice(0, 40));
      queueMicrotask(() => {
        void sendPrompt(next.llm, { fromQueue: true, userText: next.user });
      });
    }
  }

  // v0.5.0-D 第23轮 (D210) → v0.6.3-rc1 取消: FE 端 auto-retry 已移除
  //   业务: user 反馈 "AI 真的在回复时, 30s 强制打断不合理"
  //   之前行为: stream hang (30s 无事件) → force stop + 自动 resend last user msg 1 次
  //   现在行为: 30s watchdog 只 warn + UI 提示 "AI 响应较慢", **不** force stop, **不** 自动重发
  //   流走完后由 Pi SDK 正常 emit agent_end 收尾. 真 hang 住时, user 手动 stop 重发.
  //   相关 cleanup:
  //     - autoRetryCountBySession ref 移除
  //     - isAssistantMessageEmpty / getLastUserMessageContent helpers 移除 (仅 tryAutoRetry 用)
  //     - sendPrompt 的 fromAutoRetry option 移除
  //     - watchdog 不再 force stop, 只更新 streamHangBySession 给 UI

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
      await piTauri.sendPrompt(ghostSessionId, ghostPrompt, [], () => ghostCfg);
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
    // D214 v7: last-mentioned tracking (隐式 ref 续接) — Composer 调 addRecentRef, sendPrompt 拼 recent_refs
    addRecentRef,
    getRecentRefs,
    clearRecentRefs,
    recentRefsBySession,
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
