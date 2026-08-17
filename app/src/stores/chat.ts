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

export type { ChatMessage, ThinkingBlock, ToolCallBlock, Step };

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
    appendUserMessage(sessionId, text);
    streamingBySession.value = { ...streamingBySession.value, [sessionId]: true };
    errorBySession.value = { ...errorBySession.value, [sessionId]: null };
    // touch session updated time
    sessionStore.touchSession(sessionId);

    // assistantId 提前生成, message_start 事件到了再 push assistant message
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
      let idx = d2.messages.findIndex((m) => m.id === assistantId);
      // v0.4.2.x fix: error / config_error / agent_end / message_end 可能在 message_start
      //   之前到达 (modelRuntime.checkAuth 失败 → session.prompt 抛错 → sidecar emit error),
      //   之前 `if (idx < 0) return` 把这些事件全吞了, 用户看不到任何错误, 看起来"没回复".
      //   修法: 提前 push 一个 placeholder assistant message, 让 ChatMain 的 error banner
      //   有一个挂载点. placeholder 跟正常 assistant 一样在 messages 数组, 渲染逻辑通用.
      if (
        idx < 0 &&
        (event.type === 'error' ||
          event.type === 'agent_end' ||
          event.type === 'message_end')
      ) {
        d2.messages.push({
          id: assistantId,
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
          off();
          return;
        case 'agent_end':
          // v0.5.0: Pi SDK AgentSessionEvent.agent_end: { messages: AgentMessage[]; willRetry: boolean }
          // 跟 v0.4.x 比, 多了 messages 全量 + willRetry 字段 (v0.4.x 自定义事件)
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
          streamingBySession.value = { ...streamingBySession.value, [sessionId]: false };
          retryBySession.value = { ...retryBySession.value, [sessionId]: null };
          // v0.5.1: phase 切回 idle
          setPhase(sessionId, 'idle');
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
          // v0.5.0: Pi SDK AgentEvent.message_start: { message: AgentMessage }
          // 跟 v0.4.x 比, message 嵌套在 event.message 字段, 不是顶层 role/content
          if (idx < 0) {
            d2.messages.push({
              id: assistantId,
              role: 'assistant',
              content: '',
              createdAt: new Date().toISOString(),
            });
            const tbNew = d2.thinking.find((t) => t.messageId === assistantId);
            if (tbNew) tbNew.content = '';
            break;
          }
          // 后续 message_start: 重置内容
          d2.messages[idx].content = '';
          const tbRst = d2.thinking.find((t) => t.messageId === assistantId);
          if (tbRst) tbRst.content = '';
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
              // v0.5.0: event.assistantMessageEvent 嵌套 + .type 标 kind (text_delta / thinking_delta / tool_call_delta)
              // 跟 v0.4.x 的 event.delta + event.kind 不同
              {
                const ame = event.assistantMessageEvent;
                if (ame.type === 'thinking_delta') {
                  // thinking 路由到 currentStep
                  const step = getCurrentStep();
                  if (step) {
                    let tb2 = step.thinking[step.thinking.length - 1];
                    if (!tb2) {
                      tb2 = {
                        id: `think-${step.id}`,
                        messageId: assistantId,
                        content: '',
                        collapsed: false,  // step 内 thinking 默认展开
                      };
                      step.thinking.push(tb2);
                    }
                    tb2.content += ame.delta;
                  } else {
                    // fallback: 顶层 thinking (兼容无 step 数据)
                    let tb2 = d2.thinking.find((t) => t.messageId === assistantId);
                    if (!tb2) {
                      tb2 = {
                        id: `think-${assistantId}`,
                        messageId: assistantId,
                        content: '',
                        collapsed: true,
                      };
                      d2.thinking.push(tb2);
                    }
                    tb2.content += ame.delta;
                  }
                  // v0.5.1: phase 切到 thinking
                  setPhase(sessionId, 'thinking');
                } else if (ame.type === 'text_delta') {
                  // text delta: 既累积到 message.content (final reply 兼容旧 UI), 也累积到 currentStep.stepText
                  assistant.content += ame.delta;
                  const step = getCurrentStep();
                  if (step) step.stepText += ame.delta;
                  // v0.5.1: phase 切到 text (文字生成)
                  setPhase(sessionId, 'text');
                }
                // tool_call_delta: Pi SDK 增量发送 tool call args, 当前 FE 不展示 (tool_execution_start
                //   事件已经包含完整 args). 这里吞掉, 不弹错.
              }
              break;
            case 'message_end':
              break;
            case 'tool_execution_start':
              {
                const step = getCurrentStep();
                const target = step ? step.toolCalls : d2.toolCalls;
                target.push({
                  id: event.toolCallId,
                  messageId: assistantId,
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
          break;
        case 'auto_retry_end':
          // v0.5.0: event.attempt 单数 (不是 v0.4.x 的 attempts)
          retryBySession.value = { ...retryBySession.value, [sessionId]: null };
          console.log(`[chat] auto_retry_end: success=${event.success}, attempt=${event.attempt}${event.finalError ? ', err=' + event.finalError.slice(0, 80) : ''}`);
          break;
        // v0.4.2 step 1: AgentSession 内置 compaction (手动 / 自动 threshold / overflow)
        case 'compaction_start':
          console.log(`[chat] compaction_start: reason=${event.reason}`);
          break;
        case 'compaction_end':
          // v0.5.0: Pi SDK CompactionResult + aborted + willRetry + errorMessage?
          console.log(`[chat] compaction_end: reason=${event.reason} aborted=${event.aborted} willRetry=${event.willRetry}${event.errorMessage ? ', err=' + event.errorMessage.slice(0, 80) : ''}`);
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
      // v0.4.2 step 1+: 注入 per-workspace stable sessionId, 让 sidecar 加载同一 session 历史
      // undefined 时 sidecar 内部生成新 id (跟 v0.4.1 兼容)
      const piSessionId = workspacePath ? config.getSessionIdForWorkspace(workspacePath) : undefined;
      await piTauri.sendPrompt(sessionId, text, () => ({
        providerId: active.id,
        provider: active.type,
        model: model.id,
        baseUrl: active.baseUrl,
        thinkingLevel: config.thinkingLevel,
        workspacePath,
        permissionMode,
        sessionId: piSessionId,
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

  return {
    chatData,
    streamingBySession,
    errorBySession,
    retryBySession, // v0.4.2+ LLM 重试状态 (UI 显示"重试中 1/5...")
    phaseBySession, // v0.5.1: 当前 phase (thinking/text/tool/idle) — UI status icon 轮换用
    isStreamingSession: isStreaming,
    getSessionData,
    getMessages,
    getThinking,
    getToolCalls,
    getError,
    getPhase, // v0.5.1 helper
    appendUserMessage,
    clearSession,
    sendPrompt,
    sendPromptViaWs, // deprecated, kept for backward compat
    setThinkingCollapsed,
    setStepCollapsed, // v0.4.1 step 累加
    setStepThinkingCollapsed,
  };
});
