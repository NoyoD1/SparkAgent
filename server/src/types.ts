/**
 * WebSocket 消息协议 — server ↔ client
 *
 * 关键设计 (v0.2): API key 不走协议
 * - client → server: config 只传 provider + model + thinkingLevel + (baseUrl for openai-compatible)
 * - server 自己从 .env 读 apiKey (${PROVIDER_UPPER}_API_KEY)
 * - 好处: key 永远不出 server, 不进 client bundle, 不进 localStorage, 不进日志
 *
 * Frontend → Server:
 *   { type: "config", provider, model, thinkingLevel?, baseUrl? }   // 每次连上发一次
 *   { type: "prompt", sessionId, content }
 *
 * Server → Frontend (stream events from createAgentSession + AgentSession):
 *   { type: "ready" }                              // 首次连接确认
 *   { type: "config_ok" }                          // config 收到 + 已加载
 *   { type: "config_error", message }              // config 失败 (e.g. model 不存在 / env 没配 key)
 *   { type: "agent_start" }
 *   { type: "message_start" }
 *   { type: "message_update", delta: string }      // 流式文本 delta
 *   { type: "tool_start", toolName, toolCallId, args }  // 工具调用开始
 *   { type: "tool_update", toolCallId, delta }     // bash streaming output
 *   { type: "tool_end", toolCallId, result?, error? }
 *   { type: "message_end" }
 *   { type: "agent_end" }
 *   { type: "error", message: string }              // 任何错误 (apiKey 已 redact)
 */

export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high';

export type ClientToServer =
  | {
      type: 'config';
      provider: string;
      model: string;
      thinkingLevel?: ThinkingLevel;
      /** OpenAI-compatible custom baseUrl. 内置 provider 不需要. */
      baseUrl?: string;
      /**
       * v0.2+: 自定义 API key env 变量名. 只对 openai-compatible 有效.
       * server 会从 process.env[apiKeyEnv] 读 key.
       * 例: 'OPENAI_COMPATIBLE_KEY' / 'MYPROXY_KEY' / 'SHANGTANG_KEY'.
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
