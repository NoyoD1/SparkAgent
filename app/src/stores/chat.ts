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
import type { ContextBreakdown } from '@/lib/tokenEstimate';

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
  // v0.4.2+ LLM 错误重试: retryBySession 记录当前 retry 状态 (attempt 进度 + 上次错误)
  // FE UI 可以根据这个显示"重试中 1/5..."提示
  const retryBySession = ref<Record<string, { attempt: number; maxAttempts: number; errorMessage: string } | null>>({});
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
  const usageInitial = loadUsageFromStorage();
  const lastUsageBySession = ref<Record<string, import('@/lib/mock/types').MessageUsage | undefined>>(usageInitial.lastUsage);
  const contextTokensBySession = ref<Record<string, number>>(usageInitial.contextTokens);
  // watch 持久化 (deep: true 跟踪 ref 内部变化)
  watch(
    [lastUsageBySession, contextTokensBySession],
    ([u, c]) => saveUsageToStorage(u, c),
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
  const DEFAULT_CONTEXT_WINDOW = 200_000;

  function getContextTokens(sessionId: string): number {
    return contextTokensBySession.value[sessionId] ?? 0;
  }
  function getContextWindow(): number {
    // v0.4.4.6: 优先读 activeModel.contextWindow, 缺省回退到 200K.
    //   activeModel 来自 configStore.activeProvider?.activeModelId 找到的 model
    const active = sessionStore.activeSessionId;  // sessionId 不会影响 getContextWindow, 保留为了语义
    void active;
    const activeModel = configStore.activeModel;
    return activeModel?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
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

  // ===== Actions ====

  function appendUserMessage(sessionId: string, content: string) {
    const d = getSessionData(sessionId);
    d.messages.push({
      id: genMessageId('u'),
      role: 'user',
      content,
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
  async function sendPrompt(content: string) {
    const text = content.trim();
    if (!text) return;
    console.log('[chat] sendPrompt: contentLen=', text.length, 'activeSession=', sessionStore.activeSessionId);

    // 1. 确保有 active session
    let sessionId = sessionStore.activeSessionId;
    if (!sessionId) {
      let wid = sessionStore.activeWorkspaceId;
      if (!wid || sessionStore.workspaces.length === 0) {
        // 没 workspace: 用默认 C: 盘路径 (e.g. C:\Users\<user>\PiAgent), 不弹 picker
        try {
          const path = await piTauri.ensureDefaultWorkspace();
          console.log('[chat] sendPrompt: using default workspace', path);
          const ws = sessionStore.addWorkspace({ path });
          wid = ws.id;
        } catch (e) {
          console.error('[chat] sendPrompt: ensureDefaultWorkspace failed', e);
          errorBySession.value = { ...errorBySession.value, ['']: `创建默认工作区失败: ${e}` };
          return;
        }
      }
      const sess = sessionStore.addSession(wid, text.slice(0, 30) || '新任务');
      sessionId = sess.id;
      console.log('[chat] sendPrompt: created new session', sessionId);
    }

    // 2. append user msg + streaming marker (assistant placeholder 等 message_start 真的来再 push)
    // v0.5.0-D 第12轮: 引用回复 — 如果有 quote, 把 quote 作为 markdown blockquote 前缀拼到 user message.
    //   引用格式: "> <quote content>\n\n<user text>" (跟 markdown 通用 blockquote 语法一致, LLM 能识别)
    //   引用本意: 让 LLM 知道 user 在哪条历史消息基础上回复 (跟 "fork from message N" 不同的轻量版).
    const quote = quoteBySession.value[sessionId];
    let fullUserText = text;
    if (quote && quote.content.trim()) {
      // 引用内容可能多行, 逐行加 "> " 前缀 (markdown blockquote 语法)
      const quotedLines = quote.content.split('\n').map((line) => line.trim() ? `> ${line}` : '>').join('\n');
      fullUserText = `${quotedLines}\n\n${text}`;
      console.log('[chat] sendPrompt: with quote (messageId=', quote.messageId, ', len=', quote.content.length, ')');
    }
    appendUserMessage(sessionId, fullUserText);
    streamingBySession.value = { ...streamingBySession.value, [sessionId]: true };
    errorBySession.value = { ...errorBySession.value, [sessionId]: null };
    // 引用用完即清, 跟发完就消失的 UX 一致 (避免下次发还残留)
    if (quote) clearQuote(sessionId);
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
    const off = await piTauri.on((event) => {
      console.log(
        '[chat] event:',
        event.type,
        'sessionMatch=',
        !('sessionId' in event) || event.sessionId === sessionId,
      );
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
          // Bug #5 修 (2026-08-18): error event 加 UI toast (之前用户视觉无反馈)
          useUiStore().showToast(`生成失败: ${event.message.slice(0, 120)}`, 'error', 6000);
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
          if (idx < 0) {
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
              if (event.message?.usage && idx >= 0) {
                const finalUsage = event.message.usage;
                lastUsageBySession.value = { ...lastUsageBySession.value, [sessionId]: finalUsage };
                contextTokensBySession.value = {
                  ...contextTokensBySession.value,
                  [sessionId]: finalUsage.input + finalUsage.cacheRead,
                };
                // v0.4.3: 写到 assistant message.usage, 后续从 store 读
                assistant.usage = finalUsage;
                console.log(`[chat] message_end: usage=${finalUsage.input}+${finalUsage.cacheRead} (cache) + ${finalUsage.cacheWrite} (write) → contextTokens=${contextTokensBySession.value[sessionId]}`);
              }
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
        case 'compaction_start':
          console.log(`[chat] compaction_start: reason=${event.reason}`);
          // v0.4.3: UI 状态 — 按钮变 "压缩中..." spinner
          compactionBySession.value = { ...compactionBySession.value, [sessionId]: 'in_progress' };
          break;
        case 'compaction_end':
          // v0.5.0: Pi SDK CompactionResult + aborted + willRetry + errorMessage?
          console.log(`[chat] compaction_end: reason=${event.reason} aborted=${event.aborted} willRetry=${event.willRetry}${event.errorMessage ? ', err=' + event.errorMessage.slice(0, 80) : ''}`);
          // v0.4.3: UI 状态 — 按钮恢复, 记录结果 (用于 toast / 状态条)
          compactionBySession.value = { ...compactionBySession.value, [sessionId]: 'idle' };
          lastCompactionBySession.value = {
            ...lastCompactionBySession.value,
            [sessionId]: {
              reason: event.reason,
              aborted: event.aborted,
              willRetry: event.willRetry,
              errorMessage: event.errorMessage,
              at: Date.now(),
            },
          };
          // Bug #2 修: compaction 终态 toast 反馈 (手动 compact 成功 / 失败 / 拒绝)
          if (event.reason === 'manual') {
            if (event.aborted) {
              useUiStore().showToast('压缩已中止', 'warning', 3000);
            } else if (event.errorMessage) {
              useUiStore().showToast(`压缩失败: ${event.errorMessage.slice(0, 80)}`, 'error', 6000);
            } else {
              useUiStore().showToast('压缩完成, context 已释放', 'success', 3000);
            }
          }
          // v0.4.6 Bug 修 (新1): 压缩完成时, 在 chat 流里插入"分界线"消息 + 同步收尾
          //   之前只 toast 提示, 位置太靠下不直观. 现在在最后一条 assistant 消息后插一条
          //   system 角色消息, ChatMessage.vue 渲染为 "── 已压缩 N tokens ──" 分界线.
          //   走 d2.messages.push 不走 streamingBySession, 立刻可见.
          //   Pi SDK 0.84.2 emit event.result 含 CompactionResult, tokens 字段不一定稳定 → 简化
          //   显示"上下文已压缩" + "X 条消息被合并".
          {
            const beforeCount = d2.messages.length;
            d2.messages.push({
              id: `sys-compact-${Date.now()}`,
              role: 'system',
              content: '__COMPACTION_DIVIDER__',  // ChatMessage.vue 检测这个 marker
              createdAt: new Date().toISOString(),
              compactionMarker: true,  // 标记这条 system 消息是压缩分界线
            } as ChatMessage);
            chatData.value = { ...chatData.value, [sessionId]: { ...d2 } };
            console.log(`[chat] compaction divider pushed (msgs ${beforeCount} → ${d2.messages.length})`);
          }
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
      // v0.4.1+: 注入当前 permission mode 作为初始值
      const permissionMode = config.permissionMode;
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
      await piTauri.sendPrompt(sessionId, text, () => ({
        providerId: active.id,
        provider: active.type,
        model: model.id,
        baseUrl: active.baseUrl,
        thinkingLevel: config.thinkingLevel,
        workspacePath,
        permissionMode,
        sessionId: piSessionId,
        skills: { enabledNames },
        modelMetadata: {
          type: model.type,
          vision: model.vision,
          contextWindow: model.contextWindow,
          maxOutput: model.maxOutput,
          maxRounds: model.maxRounds,
          reasoning: model.reasoning,
        },
      }));
      console.log('[chat] sendPrompt: piTauri.sendPrompt resolved');
    } catch (e) {
      console.error('[chat] sendPrompt FAILED', e);
      errorBySession.value = { ...errorBySession.value, [sessionId]: e instanceof Error ? e.message : String(e) };
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
    // Bug #1 修: 用当前 active session 的独立 piSessionId (不用 per-workspace 固定)
    const piSessionId = sessionStore.ensurePiSessionId(sid);
    const skills = useSkillsStore();
    const enabledNames = skills.getEnabledNames();
    try {
      await piTauri.compactSession(sid, () => ({
        providerId: active.id,
        provider: active.type,
        model: model.id,
        baseUrl: active.baseUrl,
        thinkingLevel: config.thinkingLevel,
        workspacePath,
        permissionMode: config.permissionMode,
        sessionId: piSessionId,
        skills: { enabledNames },
        modelMetadata: {
          type: model.type,
          vision: model.vision,
          contextWindow: model.contextWindow,
          maxOutput: model.maxOutput,
          maxRounds: model.maxRounds,
          reasoning: model.reasoning,
        },
      }));
      useUiStore().showToast('开始压缩 context…', 'info', 2000);
    } catch (e) {
      console.error('[chat] compactSession invoke failed', e);
      // 失败时清掉 in_progress 状态, 避免 UI 卡住
      compactionBySession.value = { ...compactionBySession.value, [sid]: 'idle' };
      useUiStore().showToast(`压缩失败: ${e instanceof Error ? e.message : String(e)}`, 'error', 6000);
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
  }

  return {
    chatData,
    streamingBySession,
    errorBySession,
    retryBySession, // v0.4.2+ LLM 重试状态 (UI 显示"重试中 1/5...")
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
    // v0.5.0-D 第12轮: 引用回复 (quote & reply)
    setQuote,
    clearQuote,
    quoteBySession,
    appendUserMessage,
    clearSession,
    sendPrompt,
    sendPromptViaWs, // deprecated, kept for backward compat
    setThinkingCollapsed,
    setStepCollapsed, // v0.4.1 step 累加
    setStepThinkingCollapsed,
    compact, // v0.4.3: 手动触发 context 压缩
    forceStopStreaming, // v0.5.0-PR3: 强制把 streaming 翻 false (abort 30s timeout / catch 兜底)
  };
});
