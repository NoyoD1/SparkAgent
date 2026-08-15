import type { ChatMessage, ThinkingBlock, ToolCallBlock } from './types';

// Mirrors chat.html: 1 user msg "你好" + 1 assistant msg from "TraeWork" with thinking block
export const mockMessages: ChatMessage[] = [
  {
    id: 'msg-1',
    role: 'user',
    content: '你好',
    createdAt: '2025-07-29T17:38:00Z',
  },
  {
    id: 'msg-2',
    role: 'assistant',
    content: '你好！我是你的全栈开发搭档，有什么可以帮你的吗？',
    createdAt: '2025-07-29T17:38:05Z',
  },
];

export const mockThinking: ThinkingBlock[] = [
  {
    id: 'think-1',
    messageId: 'msg-2',
    content: '用户发送了问候，我需要友好回应并询问可以提供哪些帮助。',
    collapsed: false,
  },
];

export const mockToolCalls: ToolCallBlock[] = [];
