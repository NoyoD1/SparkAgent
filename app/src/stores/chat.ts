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
          event.type === 'config_error' ||
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
        case 'config_ok':
          // v0.4.2.x fix: 之前 config_ok 走 default 警告 'unhandled event type: config_ok'.
          //   实际是 sidecar 启动成功 (createAgentSession 完成) 的信号, 仅日志.
          console.log('[chat] config_ok: provider=', event.provider, 'model=', event.model);
          break;
        case 'config_error':
          // v0.4.2.x fix: config_error (e.g. Model not found / session build 失败) 必须始终处理,
          //   跟 error 一样展示给用户, 不能被 idx < 0 吞掉.
          //   placeholder 已经在前面 push 过了 (如果 idx < 0), 这里直接 set errorBySession.
          errorBySession.value = { ...errorBySession.value, [sessionId]: event.message };
          streamingBySession.value = { ...streamingBySession.value, [sessionId]: false };
          retryBySession.value = { ...retryBySession.value, [sessionId]: null };
          console.error('[chat] config_error:', event.message);
          chatData.value = { ...chatData.value, [sessionId]: { ...d2 } };
          off();
          return;
        case 'error':
          // v0.4.2.x fix: 之前 error 跟其他 message_start 后事件分组, 触发 `if (idx < 0) return`
          //   吞掉, 看起来"发送没回复". 拉出来独立处理, 始终 set errorBySession.
          //   placeholder 已经在前面 push 过了 (如果 idx < 0).
          errorBySession.value = { ...errorBySession.value, [sessionId]: event.message };
          streamingBySession.value = { ...streamingBySession.value, [sessionId]: false };
          // v0.4.2+ 清 retry 状态 (5 次重试都失败, 终态错误)
          retryBySession.value = { ...retryBySession.value, [sessionId]: null };
          console.error('[chat] error event:', event.message);
          chatData.value = { ...chatData.value, [sessionId]: { ...d2 } };
          off();
          return;
        case 'agent_end':
          // v0.4.2.x fix: agent_end 跟 error 一样, 可能在 message_start 之前到达 (error flow),
          //   placeholder 已经在前面 push 过了 (如果 idx < 0). 这里始终做清理 + auto-name.
          //   正常 flow 时 placeholder 不会被 push, 走原本的 `assistant.steps` 关闭逻辑.
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
          // v0.4.2+ 清 retry 状态 (agent_end 正常结束)
          retryBySession.value = { ...retryBySession.value, [sessionId]: null };
          chatData.value = { ...chatData.value, [sessionId]: { ...d2 } };
          console.log(
            '[chat] agent_end: idx=',
            idx,
            'total msgs=',
            d2.messages.length,
          );
          off();
          maybeAutoNameSession(sessionId, text);
          return;
        case 'agent_start':
          // v0.3.8.14: agent_start 之前 v0.3.8.13 漏了, 走 default 警告
          // agent_start 是 sidecar 启动信号, 不需要动 store, 仅日志
          console.log('[chat] agent_start');
          break;
        case 'turn_start':
          // v0.4.1 step 累加: 创建新 step group, 后续 message_update/tool_* 路由到这里
          // v0.4.1 fix: collapsed 默认 true (用户反馈"默认展开太占地方"),
          // 包括 current step — 当前 step 通过 isActive 标 accent 边 + spinner 提示, 不强制展开
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
          // v0.4.1 fix: turn_end 不再设 collapsed (默认就是 true), 只标 isActive = false
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
          // 第一次 message_start: 懒创建 assistant message
          if (idx < 0) {
            d2.messages.push({
              id: assistantId,
              role: 'assistant',
              content: '',
              createdAt: new Date().toISOString(),
            });
            // 同时重置 thinking (legacy, v0.4.1+ 不再累积到顶层 thinking, 但兼容旧数据)
            const tbNew = d2.thinking.find((t) => t.messageId === assistantId);
            if (tbNew) tbNew.content = '';
            break;
          }
          // 后续 message_start (少见, 但有些 API 会重发): 重置内容
          d2.messages[idx].content = '';
          const tbRst = d2.thinking.find((t) => t.messageId === assistantId);
          if (tbRst) tbRst.content = '';
          break;
        case 'message_update':
        case 'message_end':
        case 'tool_start':
        case 'tool_update':
        case 'tool_end':
          // v0.4.2.x fix: agent_end + error 已经在 switch 开头独立处理 (返回), 不会到这里.
          //   这里只对 'message_update' / 'tool_*' 等真正需要 assistant message 才有意义的事件
          //   做 idx < 0 检查. 这些事件 idx < 0 是不正常的, 警告后丢弃.
          if (idx < 0) {
            console.warn(`[chat] ${event.type} before assistant message created, ignoring`);
            return;
          }
          const assistant = d2.messages[idx];
          // v0.4.1 step 累加: 找当前 step (最后一个), 没 step 就 fallback 创建
          const getCurrentStep = (): Step | undefined => {
            const steps = assistant.steps || [];
            if (steps.length === 0) return undefined;
            return steps[steps.length - 1];
          };
          // 走对应 case 处理
          switch (event.type) {
            case 'message_update':
              if (event.kind === 'thinking') {
                // v0.4.1: thinking 路由到 currentStep (不再累积到顶层 d2.thinking)
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
                  tb2.content += event.delta;
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
                  tb2.content += event.delta;
                }
                console.log('[chat] thinking_update len=', (getCurrentStep()?.thinking[getCurrentStep()!.thinking.length - 1]?.content.length) ?? 0);
              } else {
                // text_delta: 既累积到 message.content (final reply 兼容旧 UI), 也累积到 currentStep.stepText
                assistant.content += event.delta;
                const step = getCurrentStep();
                if (step) step.stepText += event.delta;
                console.log('[chat] content_update len=', assistant.content.length);
              }
              break;
            case 'message_end':
              break;
            case 'tool_start':
              {
                // v0.4.1: tool 路由到 currentStep
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
                console.log('[chat] tool_start', event.toolName, 'routed to', step ? 'step' : 'legacy');
              }
              break;
            case 'tool_update':
              {
                const step = getCurrentStep();
                const target = step ? step.toolCalls : d2.toolCalls;
                const tc = target.find((x) => x.id === event.toolCallId);
                if (tc) tc.result = (tc.result || '') + event.delta;
              }
              break;
            case 'tool_end':
              {
                const step = getCurrentStep();
                const target = step ? step.toolCalls : d2.toolCalls;
                const tc = target.find((x) => x.id === event.toolCallId);
                if (tc) {
                  tc.status = event.error ? 'error' : 'success';
                  tc.endedAt = new Date().toISOString();
                  if (typeof event.result === 'string') tc.result = event.result;
                  else if (event.result !== undefined) tc.result = JSON.stringify(event.result, null, 2);
                }
              }
              break;
            // v0.4.2.x fix: agent_end + error 已经在外层 case 处理 (外层早 return, 不会到内层 switch),
            //   这里删掉 dead code 避免误导.
          }
          break;
        // v0.4.2 step 1: AgentSession 内置 retry 5 次指数退避, sidecar 转发 auto_retry_start / auto_retry_end
        // 关键: retry 期间 AgentSession 不发 agent_end, 所以 streaming 状态保留,
        // is-streaming 类的 shimmer 不会断. retryBySession 让 UI 显示"重试中 1/5...".
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
          // 清理 retry 状态 (success 或 final failure 都已经发过)
          retryBySession.value = { ...retryBySession.value, [sessionId]: null };
          console.log(`[chat] auto_retry_end: success=${event.success}, attempts=${event.attempts}${event.finalError ? ', err=' + event.finalError.slice(0, 80) : ''}`);
          break;
        // v0.4.2 step 1: AgentSession 内置 compaction (手动 / 自动 threshold / overflow), sidecar 转发 compaction_start / compaction_end
        case 'compaction_start':
          console.log(`[chat] compaction_start: reason=${event.reason}`);
          // FE 暂不显示 toast (简单 log), 后续如果用户反馈需要再加 ui store
          break;
        case 'compaction_end':
          console.log(`[chat] compaction_end: reason=${event.reason} success=${event.success} willRetry=${event.willRetry}${event.errorMessage ? ', err=' + event.errorMessage.slice(0, 80) : ''}`);
          break;
        case 'permission_request': {
          // v0.4.1+ tool permission: sidecar 问 "LLM 想跑 X tool, 允许吗"
          // 转发给 ui store 弹 PermissionDialog, 弹窗点击后调 tauri.sendPermissionResponse
          // 弹窗同时缓存 sessionId, 因为 permission_response IPC 需要
          console.log('[chat] permission_request:', event.toolName, 'args=', event.args);
          useUiStore().openPermissionDialog({
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            args: event.args,
            sessionId: event.sessionId,
          });
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
    isStreamingSession: isStreaming,
    getSessionData,
    getMessages,
    getThinking,
    getToolCalls,
    getError,
    appendUserMessage,
    clearSession,
    sendPrompt,
    sendPromptViaWs, // deprecated, kept for backward compat
    setThinkingCollapsed,
    setStepCollapsed, // v0.4.1 step 累加
    setStepThinkingCollapsed,
  };
});
