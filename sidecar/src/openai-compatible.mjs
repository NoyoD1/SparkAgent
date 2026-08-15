/**
 * OpenAI-compatible streaming client (ported from server/src/openai-compatible.ts)
 *
 * IPC: stdin/stdout JSON lines.
 *   - input:  { type: 'config', provider, model, baseUrl, apiKey, thinkingLevel? }
 *             { type: 'prompt', sessionId, content }
 *             { type: 'abort' }
 *   - output: { type: 'agent_start' | 'message_start' | 'message_update' | 'message_end' | 'agent_end' | 'error' }
 *
 * Why not Pi SDK:
 *   SDK getBuiltinModel only takes built-in provider names (anthropic/openai/...),
 *   not 'openai-compatible' with custom baseUrl. createProvider needs Model<TApi> objects.
 *   We just need single-turn chat completion + streaming, so direct fetch is simpler.
 *
 * Security:
 *   - apiKey comes via stdin from Rust (Rust read from OS keychain)
 *   - never logged, never written to stdout
 */
import readline from 'node:readline';

const REASONING_MAP = {
  low: 'low',
  medium: 'medium',
  high: 'high',
};

let currentAbortController = null;

function send(event) {
  process.stdout.write(JSON.stringify(event) + '\n');
}

async function runOpenAICompatiblePrompt(config, userContent) {
  const cleanBase = config.baseUrl.replace(/\/+$/, '');
  const url = `${cleanBase}/chat/completions`;

  const body = {
    model: config.model,
    messages: [{ role: 'user', content: userContent }],
    stream: true,
  };
  if (config.thinkingLevel && config.thinkingLevel !== 'off') {
    const effort = REASONING_MAP[config.thinkingLevel];
    if (effort) body.reasoning_effort = effort;
  }

  // Abort previous if any
  if (currentAbortController) currentAbortController.abort();
  const ac = new AbortController();
  currentAbortController = ac;

  send({ type: 'agent_start' });
  send({ type: 'message_start' });

  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
  } catch (e) {
    send({ type: 'error', message: `Network error: ${e instanceof Error ? e.message : String(e)}` });
    send({ type: 'agent_end' });
    return;
  }

  if (!resp.ok || !resp.body) {
    const errText = await resp.text().catch(() => '(no body)');
    send({ type: 'error', message: `HTTP ${resp.status}: ${errText.slice(0, 500)}` });
    send({ type: 'agent_end' });
    return;
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') {
          send({ type: 'message_end' });
          send({ type: 'agent_end' });
          return;
        }
        try {
          const parsed = JSON.parse(data);
          const choice = parsed.choices?.[0];
          if (!choice) continue;
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
    send({ type: 'message_end' });
    send({ type: 'agent_end' });
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      send({ type: 'error', message: 'Aborted' });
    } else {
      send({ type: 'error', message: `Stream read error: ${e instanceof Error ? e.message : String(e)}` });
    }
    send({ type: 'agent_end' });
  } finally {
    try { reader.releaseLock(); } catch {}
    if (currentAbortController === ac) currentAbortController = null;
  }
}

// ====== main: stdin JSON-lines loop ======
let currentConfig = null;

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', async (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    send({ type: 'error', message: 'Invalid JSON from host' });
    return;
  }
  if (msg.type === 'config') {
    currentConfig = {
      provider: msg.provider,
      model: msg.model,
      baseUrl: msg.baseUrl,
      apiKey: msg.apiKey,
      thinkingLevel: msg.thinkingLevel,
    };
  } else if (msg.type === 'prompt') {
    if (!currentConfig) {
      send({ type: 'error', message: 'No config. Send { type: "config" } first.' });
      send({ type: 'agent_end' });
      return;
    }
    if (currentConfig.provider !== 'openai-compatible') {
      send({ type: 'error', message: `Sidecar MVP: only openai-compatible. Got ${currentConfig.provider}` });
      send({ type: 'agent_end' });
      return;
    }
    await runOpenAICompatiblePrompt(currentConfig, msg.content);
  } else if (msg.type === 'abort') {
    if (currentAbortController) currentAbortController.abort();
  } else {
    send({ type: 'error', message: `Unknown message type: ${msg.type}` });
  }
});

rl.on('close', () => {
  if (currentAbortController) currentAbortController.abort();
  process.exit(0);
});
