/**
 * Pi Agent API types — client 端, 跟 server/src/types.ts 镜像
 *
 * 实际生产可以改成 monorepo 共享, Phase 2+ 阶段先复制一份.
 *
 * v3.37 (2026-08-24): apiKey 存 settings.json 明文 (ProviderConfigDto.api_key 字段)
 *   之前 v0.2 走 server .env, 之后 v3.22-v3.36 走 OS keychain (keyring SERVICE_LLM),
 *   v3.37 改存 settings.json (跟 baseUrl 一样). 跟 MCP / external tool 配置文件同 pattern.
 * - config 消息只发 provider + model + thinkingLevel + (openai-compatible 的 baseUrl)
 * - apiKey 在 Tauri 端 send_prompt 内部从 settings.json 找 (FE 不传)
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
      // P2 #1 fix: 删 apiKeyEnv dead code. 旧 v0.2 设计, BYOK 走 keychain (v3.22-v3.36) / settings.json (v3.37), 字段没人用.
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
