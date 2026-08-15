/**
 * OpenAI-compatible client — 直接 fetch + SSE 解析
 *
 * 为什么不用 Pi SDK:
 *   SDK 的 getBuiltinModel 只接受内置 provider (anthropic/openai/deepseek/...),
 *   不接受 'openai-compatible' 自定义 baseUrl. SDK 的 createProvider 是动态注册 API,
 *   但需要 Model<TApi> 对象 (display name + api + headers + cost 等元数据),
 *   client 端只传 model id 字符串, 元数据不全.
 *
 * 实现:
 *   收到 prompt → fetch {baseUrl}/chat/completions with stream=true
 *   读 SSE (text/event-stream), 解析 data: {...}, 提取 delta.content
 *   转发成 { type: 'message_update', delta } 到 WS
 *
 * 适用: openai-compatible 第三方代理 (商汤/OpenRouter/Fireworks/...)
 * 不走 SDK 的 agent loop / tools, 只做单轮 chat completion, 流式转发.
 *
 * 安全:
 *   - apiKey 走 server .env, 不会进 client bundle / 协议
 *   - console.log / error 不打 apiKey
 */
import type { ServerToClient } from './types.js';

export interface OpenAICompatibleConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 'off' | 'low' | 'medium' | 'high' — 翻译成 reasoning_effort */
  thinkingLevel?: 'off' | 'low' | 'medium' | 'high';
}

const REASONING_MAP: Record<string, string> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
};

/** 把 stream chunks 转成 SDK 的 ServerToClient events */
export async function runOpenAICompatiblePrompt(
  config: OpenAICompatibleConfig,
  userContent: string,
  send: (e: ServerToClient) => void,
  signal?: AbortSignal,
): Promise<void> {
  const cleanBase = config.baseUrl.replace(/\/+$/, '');
  const url = `${cleanBase}/chat/completions`;

  // OpenAI-compatible Chat Completions API body
  const body: Record<string, unknown> = {
    model: config.model,
    messages: [{ role: 'user', content: userContent }],
    stream: true,
  };
  // 把 thinkingLevel 翻译成 OpenAI 的 reasoning_effort (部分代理支持)
  if (config.thinkingLevel && config.thinkingLevel !== 'off') {
    const effort = REASONING_MAP[config.thinkingLevel];
    if (effort) body.reasoning_effort = effort;
  }

  send({ type: 'agent_start' });
  send({ type: 'message_start' });

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    send({ type: 'error', message: `Network error: ${e instanceof Error ? e.message : String(e)}` });
    return;
  }

  if (!resp.ok || !resp.body) {
    const errText = await resp.text().catch(() => '(no body)');
    send({ type: 'error', message: `HTTP ${resp.status}: ${errText.slice(0, 500)}` });
    return;
  }

  // Read SSE stream
  const reader = resp.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE 格式: "data: {json}\n\n" 多个 events
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? ''; // 最后一行可能不完整, 留给下次

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') {
          // OpenAI-compatible 标准结束标记
          send({ type: 'message_end' });
          send({ type: 'agent_end' });
          return;
        }
        try {
          const parsed = JSON.parse(data) as {
            choices?: Array<{
              delta?: { content?: string; reasoning_content?: string };
              finish_reason?: string;
            }>;
          };
          const choice = parsed.choices?.[0];
          if (!choice) continue;
          // 优先 reasoning_content (DeepSeek R1 等), fallback content
          const delta = choice.delta?.reasoning_content || choice.delta?.content;
          if (delta) {
            send({ type: 'message_update', delta });
          }
          if (choice.finish_reason === 'stop' || choice.finish_reason === 'length') {
            send({ type: 'message_end' });
            send({ type: 'agent_end' });
            return;
          }
        } catch {
          // 忽略非 JSON 行 (注释, 心跳等)
        }
      }
    }
    // 流结束但没收到 [DONE] — 兼容性收尾
    send({ type: 'message_end' });
    send({ type: 'agent_end' });
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      send({ type: 'error', message: 'Aborted' });
    } else {
      send({ type: 'error', message: `Stream read error: ${e instanceof Error ? e.message : String(e)}` });
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}
