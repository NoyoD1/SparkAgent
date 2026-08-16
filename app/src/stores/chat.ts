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
import type { ChatMessage, ThinkingBlock, ToolCallBlock } from '@/lib/mock/types';
import { piTauri } from '@/lib/tauri';
import { useConfigStore } from './config';
import { useSessionStore } from './session';

export type { ChatMessage, ThinkingBlock, ToolCallBlock };

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

  // ===== Actions =====

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
      const idx = d2.messages.findIndex((m) => m.id === assistantId);
      if (idx < 0) return;
      const assistant = d2.messages[idx];
      switch (event.type) {
        case 'message_start':
          // v0.3.8.12: assistant message 之前在 sendPrompt 时立即 push (空 content),
          // 现在改成 message_start 真的到了才 push — 避免 send 后立即出现空 placeholder
          if (idx < 0) {
            d2.messages.push({
              id: assistantId,
              role: 'assistant',
              content: '',
              createdAt: new Date().toISOString(),
            });
            chatData.value = { ...chatData.value, [sessionId]: { ...d2 } };
            return;  // 这次没 idx, 重置 assistant.content 的逻辑跳过
          }
          assistant.content = '';
          // 重置 thinking 内容
          const tb = d2.thinking.find((t) => t.messageId === assistantId);
          if (tb) tb.content = '';
          break;
        case 'message_update':
          // v0.3.8.6: sidecar 现在发 kind: 'thinking' | 'content', 拆开写
          if (event.kind === 'thinking') {
            // v0.3.8.12: thinking 块按需创建 (之前 sendPrompt 时立即 push 空的, 现在等真来再 create)
            // 避免 send 后立即出现空 "思考过程 >" 标签占位
            let tb2 = d2.thinking.find((t) => t.messageId === assistantId);
            if (!tb2) {
              tb2 = {
                id: `think-${assistantId}`,
                messageId: assistantId,
                content: '',
                collapsed: true,  // 默认折叠, 用户主动展开
              };
              d2.thinking.push(tb2);
            }
            tb2.content += event.delta;
            console.log('[chat] thinking_update len=', tb2?.content.length);
          } else {
            // 默认当 content (兼容没带 kind 的旧 sidecar)
            assistant.content += event.delta;
            console.log('[chat] content_update len=', assistant.content.length);
          }
          break;
        case 'message_end':
          // v0.3.8.11: 不再自动收起 thinking, 用户自己决定何时折叠
          break;
        case 'tool_start':
          // v0.3.8.6: 工具调用折叠提示
          d2.toolCalls.push({
            id: event.toolCallId,
            messageId: assistantId,
            name: event.toolName,
            args: event.args || {},
            status: 'running',
            startedAt: new Date().toISOString(),
          });
          console.log('[chat] tool_start', event.toolName);
          break;
        case 'tool_update':
          // 工具输出流式更新 (append 到 result)
          {
            const tc = d2.toolCalls.find((x) => x.id === event.toolCallId);
            if (tc) {
              tc.result = (tc.result || '') + event.delta;
            }
          }
          break;
        case 'tool_end':
          {
            const tc = d2.toolCalls.find((x) => x.id === event.toolCallId);
            if (tc) {
              tc.status = event.error ? 'error' : 'success';
              tc.endedAt = new Date().toISOString();
              if (typeof event.result === 'string') {
                tc.result = event.result;
              } else if (event.result !== undefined) {
                tc.result = JSON.stringify(event.result, null, 2);
              }
            }
          }
          break;
        case 'agent_end':
          streamingBySession.value = { ...streamingBySession.value, [sessionId]: false };
          chatData.value = { ...chatData.value, [sessionId]: { ...d2 } };
          console.log(
            '[chat] agent_end: assistant.content.length=',
            assistant.content.length,
            'preview=',
            assistant.content.slice(0, 80),
          );
          off();
          // 自动用首条消息给 session 命名 (仅在 title 仍是默认 "新任务" 时)
          maybeAutoNameSession(sessionId, text);
          break;
        case 'error':
          errorBySession.value = { ...errorBySession.value, [sessionId]: event.message };
          streamingBySession.value = { ...streamingBySession.value, [sessionId]: false };
          off();
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
      await piTauri.sendPrompt(sessionId, text, () => ({
        providerId: active.id,
        provider: active.type,
        model: model.id,
        baseUrl: active.baseUrl,
        thinkingLevel: config.thinkingLevel,
        workspacePath,
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
  };
});
