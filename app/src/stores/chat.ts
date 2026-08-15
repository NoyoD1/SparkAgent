import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { ChatMessage, ThinkingBlock, ToolCallBlock } from '@/lib/mock/types';
import { mockMessages, mockThinking, mockToolCalls } from '@/lib/mock/messages';
import { piWs } from '@/lib/ws';
import { useConfigStore } from './config';

export type { ChatMessage, ThinkingBlock, ToolCallBlock };

export const useChatStore = defineStore('chat', () => {
  // message list keyed by sessionId
  const messagesBySession = ref<Record<string, ChatMessage[]>>({
    'sess-1': mockMessages,
  });

  // thinking / tool-call state per session
  const thinkingBySession = ref<Record<string, ThinkingBlock[]>>({
    'sess-1': mockThinking,
  });
  const toolCallsBySession = ref<Record<string, ToolCallBlock[]>>({
    'sess-1': mockToolCalls,
  });

  // is any agent running (per session)
  const streamingBySession = ref<Record<string, boolean>>({});
  // error message per session
  const errorBySession = ref<Record<string, string | null>>({});

  function getMessages(sessionId: string): ChatMessage[] {
    return messagesBySession.value[sessionId] ?? [];
  }
  function getThinking(sessionId: string): ThinkingBlock[] {
    return thinkingBySession.value[sessionId] ?? [];
  }
  function getToolCalls(sessionId: string): ToolCallBlock[] {
    return toolCallsBySession.value[sessionId] ?? [];
  }
  function isStreaming(sessionId: string): boolean {
    return !!streamingBySession.value[sessionId];
  }
  function getError(sessionId: string): string | null {
    return errorBySession.value[sessionId] ?? null;
  }

  function appendUserMessage(sessionId: string, content: string) {
    if (!messagesBySession.value[sessionId]) {
      messagesBySession.value[sessionId] = [];
    }
    messagesBySession.value[sessionId].push({
      id: `msg-${Date.now()}-u`,
      role: 'user',
      content,
      createdAt: new Date().toISOString(),
    });
  }

  /**
   * 走 WS 发 prompt + 接流.
   * - 先 append user msg
   * - append 一个空 assistant placeholder
   * - 监听 WS 事件累加 delta, message_end 时收尾
   * - agent_end / error 时清 streaming flag
   */
  async function sendPromptViaWs(sessionId: string, content: string) {
    if (!content.trim()) return;

    // 1. append user msg
    appendUserMessage(sessionId, content);

    // 2. append assistant placeholder
    const assistantId = `msg-${Date.now()}-a`;
    if (!messagesBySession.value[sessionId]) {
      messagesBySession.value[sessionId] = [];
    }
    messagesBySession.value[sessionId].push({
      id: assistantId,
      role: 'assistant',
      content: '',
      createdAt: new Date().toISOString(),
    });
    streamingBySession.value[sessionId] = true;
    errorBySession.value[sessionId] = null;

    // 3. 临时 listener, message_end 收尾
    const off = piWs.on((event) => {
      const msgs = messagesBySession.value[sessionId];
      if (!msgs) return;
      const idx = msgs.findIndex((m) => m.id === assistantId);
      if (idx < 0) return;
      const assistant = msgs[idx];

      switch (event.type) {
        case 'message_start':
          // 重置 content (防御)
          assistant.content = '';
          break;
        case 'message_update':
          assistant.content += event.delta;
          break;
        case 'message_end':
          // 收尾
          break;
        case 'tool_start':
          // Phase 2 demo: 不渲染 tool call UI, 仅 log
          console.log('[chat] tool_start', event.toolName);
          break;
        case 'tool_end':
          console.log('[chat] tool_end', event.toolName ?? event.toolCallId);
          break;
        case 'agent_end':
          streamingBySession.value[sessionId] = false;
          off();
          break;
        case 'error':
          errorBySession.value[sessionId] = event.message;
          streamingBySession.value[sessionId] = false;
          off();
          break;
        default:
          break;
      }
    });

    // 4. 触发 prompt (自动带上 active provider/model config)
    //    v0.2: 不传 apiKey, server 从 .env 读
    //    v0.2+: openai-compatible 传 apiKeyEnv (env 变量名, 不是 key)
    try {
      const config = useConfigStore();
      const active = config.activeProvider;
      const model = config.activeModel;
      if (!active || !model) {
        throw new Error('请先在 Settings → Providers 添加并选一个 active provider + model');
      }
      await piWs.sendPrompt(sessionId, content, () => ({
        provider: active.type,
        model: model.id,
        baseUrl: active.baseUrl,
        apiKeyEnv: active.apiKeyEnv,
        thinkingLevel: config.thinkingLevel,
      }));
    } catch (e) {
      errorBySession.value[sessionId] = e instanceof Error ? e.message : String(e);
      streamingBySession.value[sessionId] = false;
      off();
    }
  }

  // 向后兼容: 旧的同步 append (Phase 1 用的, 留作 fallback)
  function appendAssistantMessage(sessionId: string, content: string) {
    if (!messagesBySession.value[sessionId]) {
      messagesBySession.value[sessionId] = [];
    }
    messagesBySession.value[sessionId].push({
      id: `msg-${Date.now()}`,
      role: 'assistant',
      content,
      createdAt: new Date().toISOString(),
    });
  }

  return {
    isStreaming,
    errorBySession,
    getMessages,
    getThinking,
    getToolCalls,
    isStreamingSession: isStreaming,
    getError,
    appendUserMessage,
    appendAssistantMessage,
    sendPromptViaWs,
  };
});
