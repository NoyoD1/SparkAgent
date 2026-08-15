/**
 * Pi Agent API types — client 端, 跟 server/src/types.ts 镜像
 *
 * 实际生产可以改成 monorepo 共享, Phase 2+ 阶段先复制一份.
 *
 * v0.2 安全改造: apiKey 不再走协议, 走 server .env
 * - config 消息只发 provider + model + thinkingLevel + (openai-compatible 的 baseUrl)
 * - apiKey 在 server 端从 process.env[${PROVIDER}_API_KEY] 读
 * - 前端 localStorage 也不存 apiKey (config store 删字段)
 */

export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high';

export type ClientToServer =
  | {
      type: 'config';
      provider: string;
      model: string;
      thinkingLevel: ThinkingLevel;
      /** OpenAI-compatible custom baseUrl (Phase 3+ LLM 调支持). 内置 provider 不需要. */
      baseUrl?: string;
      /**
       * v0.2+: openai-compatible 专用, server 从 process.env[apiKeyEnv] 读 key.
       * 传的是 env 变量名 (不是 key 本身), 比如 'MYPROXY_KEY'.
       * 内置 provider 走固定 ${PROVIDER}_API_KEY 约定, 忽略此字段.
       */
      apiKeyEnv?: string;
    }
  | { type: 'prompt'; sessionId: string; content: string };

export type ServerToClient =
  | { type: 'ready' }
  | { type: 'config_ok'; provider: string; model: string }
  | { type: 'config_error'; message: string }
  | { type: 'agent_start' }
  | { type: 'message_start' }
  | { type: 'message_update'; delta: string }
  | { type: 'tool_start'; toolName: string; toolCallId: string; args: Record<string, unknown> }
  | { type: 'tool_update'; toolCallId: string; delta: string }
  | { type: 'tool_end'; toolCallId: string; result?: unknown; error?: string }
  | { type: 'message_end' }
  | { type: 'agent_end' }
  | { type: 'error'; message: string };
