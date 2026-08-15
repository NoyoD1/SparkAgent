/**
 * Chat store — 真实 session 消息管理 (Phase 3 v0.3.2+)
 *
 * 数据: messagesBySession[sessionId] = { messages, thinking, toolCalls }
 * 持久化: localStorage `pi-agent:chat:v1`
 * 跟 session store 联动: session 删除时清 messages
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
   * 发 prompt + 接流. 走 Tauri invoke('send_prompt') → Rust 读 keychain + 启 sidecar.
   * 监听 Tauri 事件累加 delta, message_end 收尾.
   */
  async function sendPromptViaWs(sessionId: string, content: string) {
    if (!content.trim()) return;
    console.log('[chat] sendPromptViaWs: sessionId=', sessionId, 'contentLen=', content.length);

    // 1. append user msg + assistant placeholder
    appendUserMessage(sessionId, content);
    const d = getSessionData(sessionId);
    const assistantId = genMessageId('a');
    d.messages.push({
      id: assistantId,
      role: 'assistant',
      content: '',
      createdAt: new Date().toISOString(),
    });
    chatData.value = { ...chatData.value, [sessionId]: { ...d } };
    streamingBySession.value = { ...streamingBySession.value, [sessionId]: true };
    errorBySession.value = { ...errorBySession.value, [sessionId]: null };
    // touch session updated time
    sessionStore.touchSession(sessionId);

    // 2. 临时 listener
    const off = piTauri.on((event) => {
      if ('sessionId' in event && event.sessionId !== sessionId) return;
      const d2 = getSessionData(sessionId);
      const idx = d2.messages.findIndex((m) => m.id === assistantId);
      if (idx < 0) return;
      const assistant = d2.messages[idx];
      switch (event.type) {
        case 'message_start':
          assistant.content = '';
          break;
        case 'message_update':
          assistant.content += event.delta;
          break;
        case 'message_end':
          break;
        case 'tool_start':
          console.log('[chat] tool_start', event.toolName);
          break;
        case 'tool_end':
          console.log('[chat] tool_end', event.toolCallId);
          break;
        case 'agent_end':
          streamingBySession.value = { ...streamingBySession.value, [sessionId]: false };
          chatData.value = { ...chatData.value, [sessionId]: { ...d2 } };
          off();
          // 自动用首条消息给 session 命名
          maybeAutoNameSession(sessionId, content);
          break;
        case 'error':
          errorBySession.value = { ...errorBySession.value, [sessionId]: event.message };
          streamingBySession.value = { ...streamingBySession.value, [sessionId]: false };
          off();
          break;
      }
      chatData.value = { ...chatData.value, [sessionId]: { ...d2 } };
    });

    // 3. 触发 prompt
    try {
      const config = useConfigStore();
      const active = config.activeProvider;
      const model = config.activeModel;
      console.log('[chat] sendPromptViaWs: active=', active?.label, 'model=', model?.id);
      if (!active || !model) {
        throw new Error('请先在 Settings → Providers 添加并选一个 active provider + model');
      }
      await piTauri.sendPrompt(sessionId, content, () => ({
        providerId: active.id,
        provider: active.type,
        model: model.id,
        baseUrl: active.baseUrl,
        thinkingLevel: config.thinkingLevel,
      }));
      console.log('[chat] sendPromptViaWs: piTauri.sendPrompt resolved');
    } catch (e) {
      console.error('[chat] sendPromptViaWs FAILED', e);
      errorBySession.value = { ...errorBySession.value, [sessionId]: e instanceof Error ? e.message : String(e) };
      streamingBySession.value = { ...streamingBySession.value, [sessionId]: false };
      off();
    }
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
    sendPromptViaWs,
  };
});
