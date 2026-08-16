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

// R4: 401/403 错误体可能回显 apiKey 字面量 (e.g. "Invalid API key sk-AB***"),
// 原样转给前端会泄露 key 片段. sanitize 掉常见 key 模式 + bearer 头痕迹.
const KEY_PATTERNS = [
  /\bsk-[A-Za-z0-9_\-]{4,}/g,         // OpenAI / 多数 openai-compatible
  /\bsk-proj-[A-Za-z0-9_\-]{4,}/g,
  /\bAKIA[0-9A-Z]{4,}/g,               // AWS
  /\bghp_[A-Za-z0-9]{4,}/g,            // GitHub
  /\bxai-[A-Za-z0-9]{4,}/g,            // xAI
  /\bAIza[0-9A-Za-z_\-]{4,}/g,         // Google
  /Bearer\s+[A-Za-z0-9_\-\.]{8,}/gi,   // 任何 "Bearer xxx" 头
];
function sanitizeErrBody(text) {
  let out = text;
  for (const re of KEY_PATTERNS) {
    out = out.replace(re, (m) => {
      // 保留前 2 字符 + "***" (跟 Rust mask 一致)
      return m.length > 4 ? `${m.slice(0, 2)}***` : '***';
    });
  }
  return out.slice(0, 300);  // 截断防日志爆炸
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

  // 30s fetch 超时: 避免 host 端 network 死 / DNS hang 时静默卡死
  const FETCH_TIMEOUT_MS = 30000;
  const timeoutId = setTimeout(() => {
    console.error(`[sidecar] !!! fetch timeout ${FETCH_TIMEOUT_MS}ms, aborting`);
    ac.abort(new Error(`fetch timeout ${FETCH_TIMEOUT_MS}ms`));
  }, FETCH_TIMEOUT_MS);

  console.error(`[sidecar] >>> POST ${url} model=${config.model} stream=true`);
  console.error(`[sidecar] >>> body keys: ${JSON.stringify(Object.keys(body))}, contentLen=${userContent.length}`);

  send({ type: 'agent_start' });
  send({ type: 'message_start' });

  // 跟踪是否已发过 agent_end, 防止重复
  let agentEndSent = false;
  const finishUp = () => {
    if (!agentEndSent) {
      send({ type: 'message_end' });
      send({ type: 'agent_end' });
      agentEndSent = true;
    }
  };

  // 5s 心跳: 区分"网络慢" vs "卡死"
  let heartbeat = 0;
  const heartbeatInterval = setInterval(() => {
    heartbeat += 5;
    console.error(`[sidecar] ... waiting ${heartbeat}s (fetch + stream)`);
    if (heartbeat >= 25) clearInterval(heartbeatInterval); // 30s 之前都打, 超时后让 timeout 接管
  }, 5000);

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
    clearTimeout(timeoutId);
    clearInterval(heartbeatInterval);
    console.error(`[sidecar] <<< fetch threw: ${e instanceof Error ? e.message : String(e)}`);
    send({ type: 'error', message: `Network error: ${e instanceof Error ? e.message : String(e)}` });
    finishUp();
    return;
  }
  clearTimeout(timeoutId);
  clearInterval(heartbeatInterval);

  console.error(`[sidecar] <<< HTTP ${resp.status} content-type=${resp.headers.get('content-type')}`);

  if (!resp.ok || !resp.body) {
    const errText = await resp.text().catch(() => '(no body)');
    // R4: 不直接 dump 错误体, 先 sanitize 掉可能含 apiKey 字面量的模式
    const safeErr = sanitizeErrBody(errText);
    console.error(`[sidecar] <<< errBody (sanitized, first 300): ${safeErr}`);
    send({ type: 'error', message: `HTTP ${resp.status}: ${safeErr}` });
    finishUp();
    return;
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let totalBytes = 0;
  let totalLines = 0;
  let dataLines = 0;
  let deltaChars = 0;
  const logFirstChunks = 3; // 头 3 个 chunk 原样 dump 出来
  let chunksLogged = 0;
  let streamHeartbeat = 0;
  const streamHeartbeatInterval = setInterval(() => {
    streamHeartbeat += 5;
    console.error(`[sidecar] ... streaming ${streamHeartbeat}s, deltas=${deltaChars} bytes=${totalBytes}`);
    if (streamHeartbeat >= 60) clearInterval(streamHeartbeatInterval); // 60s 上限
  }, 5000);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      buffer += decoder.decode(value, { stream: true });

      if (chunksLogged < logFirstChunks) {
        const raw = decoder.decode(value, { stream: false });
        console.error(`[sidecar] <<< chunk#${chunksLogged + 1} ${value.byteLength}B: ${raw.slice(0, 600)}`);
        chunksLogged += 1;
      }

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        totalLines += 1;
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;
        dataLines += 1;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') {
          console.error(`[sidecar] <<< [DONE] total bytes=${totalBytes} lines=${totalLines} dataLines=${dataLines} deltas=${deltaChars}`);
          finishUp();
          return;
        }
        try {
          const parsed = JSON.parse(data);
          const choice = parsed.choices?.[0];
          if (!choice) continue;
          const delta = choice.delta;
          if (!delta) continue;
          // v0.3.8.6: 拆开 reasoning_content (thinking) 和 content, 各自发
          // kind: 'thinking' → 前端写入 ThinkingBlock (折叠灰字)
          // kind: 'content'  → 前端追加到 assistant.content (主内容)
          if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
            deltaChars += delta.reasoning_content.length;
            send({ type: 'message_update', kind: 'thinking', delta: delta.reasoning_content });
          }
          if (typeof delta.content === 'string' && delta.content.length > 0) {
            deltaChars += delta.content.length;
            send({ type: 'message_update', kind: 'content', delta: delta.content });
          }
          if (choice.finish_reason === 'stop' || choice.finish_reason === 'length') {
            console.error(`[sidecar] <<< finish_reason=${choice.finish_reason} bytes=${totalBytes} dataLines=${dataLines} deltas=${deltaChars}`);
            finishUp();
            return;
          }
        } catch (e) {
          console.error(`[sidecar] <<< JSON.parse err: ${e instanceof Error ? e.message : String(e)} line=${data.slice(0, 200)}`);
          // 忽略非 JSON 行 (注释, 心跳等)
        }
      }
    }
    console.error(`[sidecar] <<< stream done bytes=${totalBytes} dataLines=${dataLines} deltas=${deltaChars}`);
    clearInterval(streamHeartbeatInterval);
    finishUp();
  } catch (e) {
    clearInterval(streamHeartbeatInterval);
    if (e instanceof Error && e.name === 'AbortError') {
      console.error('[sidecar] <<< AbortError');
      send({ type: 'error', message: 'Aborted' });
    } else {
      console.error(`[sidecar] <<< stream read err: ${e instanceof Error ? e.message : String(e)}`);
      send({ type: 'error', message: `Stream read error: ${e instanceof Error ? e.message : String(e)}` });
    }
    finishUp();
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
  // v0.3.5+: 不要立即 process.exit(0) — 此时 fetch / stream 还在 await 中,
  // 立即退出会让 AbortController 传播不及, catch / finishUp 跑不到,
  // 前端就只看到 agent_start / message_start 然后被 Rust fallback agent_end,
  // 没有任何 error 反馈, 给人感觉"调通了但内容空".
  //
  // 正确做法: 先 abort 当前请求, 给 800ms 让 catch / finishUp 跑完发完 error / message_end,
  // 再退出. 如果 800ms 内还在 hang (极少见), 超时强制退出.
  console.error('[sidecar] stdin closed, aborting current request + waiting 800ms for cleanup');
  if (currentAbortController) currentAbortController.abort();
  setTimeout(() => {
    console.error('[sidecar] exit (after cleanup)');
    process.exit(0);
  }, 800);
});
