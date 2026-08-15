/**
 * Pi Agent Server — Hono + WebSocket
 *
 * v0.2 BYOK 流程 (apiKey 走 .env, 不走协议):
 * 1. client 连上 → server 发 { type: 'ready' }
 * 2. client 发 { type: 'config', provider, model, thinkingLevel, baseUrl? }
 * 3. server 从 process.env[${PROVIDER}_API_KEY] 读 apiKey, 验证 + 回复 config_ok / config_error
 *    (env 没设 → config_error, 提示 "Add ANTHROPIC_API_KEY=... to server/.env")
 * 4. client 发 { type: 'prompt', sessionId, content }
 * 5. server 调 createAgentSession (用 connection 存下来的 config), 流式回推
 *
 * 端口 3001.
 */
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { WebSocketServer, WebSocket } from 'ws';
import type { ClientToServer, ServerToClient } from './types.js';
import {
  getOrCreateSession,
  runPrompt,
  abortTurn,
  listSessions,
  healthCheck,
  type ConnectionConfig,
} from './session.js';
import { fetchProviderModels, getApiKeyFromEnv, type FetchModelsRequest } from './providers.js';
import { runOpenAICompatiblePrompt } from './openai-compatible.js';

const PORT = Number(process.env.PORT ?? 3001);

const app = new Hono();

app.get('/health', (c) => c.json(healthCheck()));

/** POST /api/providers/fetch-models
 *  body: { type, apiKey, baseUrl? }
 *  resp: { ok, models: [{id, label?}], warning?, error? }
 */
app.post('/api/providers/fetch-models', async (c) => {
  let body: FetchModelsRequest;
  try {
    body = (await c.req.json()) as FetchModelsRequest;
  } catch {
    return c.json({ ok: false, error: 'Invalid JSON body' }, 400);
  }
  if (!body.type || !body.apiKey) {
    return c.json({ ok: false, error: 'type and apiKey are required' }, 400);
  }
  // ⚠️ 不 log body.apiKey
  console.log(`[pi-server] fetch-models: type=${body.type}, baseUrl=${body.baseUrl ?? '(default)'}`);
  const result = await fetchProviderModels(body);
  return c.json(result);
});

const server = serve(
  {
    fetch: app.fetch,
    port: PORT,
  },
  (info) => {
    console.log(`[pi-server] HTTP listening on http://localhost:${info.port}`);
  },
);

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  if (url.pathname !== '/api/chat') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws: WebSocket) => {
  console.log('[pi-server] WS connected');
  let currentSessionId: string | null = null;
  // 每条连接的配置 (内存 only, 断开即销毁)
  let config: ConnectionConfig | null = null;

  const send = (event: ServerToClient) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(event));
    }
  };

  send({ type: 'ready' });

  ws.on('message', async (raw) => {
    let msg: ClientToServer;
    try {
      msg = JSON.parse(raw.toString()) as ClientToServer;
    } catch {
      send({ type: 'error', message: 'Invalid JSON' });
      return;
    }

    if (msg.type === 'config') {
      // v0.2: apiKey 从 .env 读, 不从 client 协议取
      // openai-compatible 支持 client 指定 env 名 (apiKeyEnv)
      // v0.2 demo: 'mock' provider 跳过 apiKey 检查 (演示用)
      if (msg.provider === 'mock') {
        config = { provider: 'mock', model: msg.model, apiKey: 'mock-no-key' };
        send({ type: 'config_ok', provider: 'mock', model: msg.model });
        console.log(`[pi-server] config set: mock/${msg.model} (no key, demo mode)`);
        return;
      }
      const apiKey = getApiKeyFromEnv(msg.provider, msg.apiKeyEnv);
      if (!apiKey) {
        const envHint = msg.provider === 'openai-compatible' && msg.apiKeyEnv
          ? `Env \`${msg.apiKeyEnv}\` not set in server/.env.`
          : `Add \`${msg.provider.toUpperCase()}_API_KEY=...\` to server/.env and restart server.`;
        send({
          type: 'config_error',
          message: `No API key for provider "${msg.provider}". ${envHint}`,
        });
        return;
      }
      config = {
        provider: msg.provider,
        model: msg.model,
        apiKey,
        baseUrl: msg.baseUrl,
      };
      // 验证 provider/model 合法 (apiKey 真实有效性等调 LLM 时再 fail)
      try {
        const { getBuiltinModel } = await import('@earendil-works/pi-ai/providers/all');
        getBuiltinModel(
          msg.provider as Parameters<typeof getBuiltinModel>[0],
          msg.model as Parameters<typeof getBuiltinModel>[1],
        );
        send({ type: 'config_ok', provider: msg.provider, model: msg.model });
        const envLabel = msg.provider === 'openai-compatible' && msg.apiKeyEnv
          ? `key from env ${msg.apiKeyEnv}`
          : 'key from env';
        console.log(`[pi-server] config set: ${msg.provider}/${msg.model} (${envLabel})`);
      } catch (e) {
        config = null;
        send({
          type: 'config_error',
          message: `Unknown provider/model: ${msg.provider}/${msg.model}`,
        });
      }
      return;
    }

    if (msg.type === 'prompt') {
      if (!config) {
        send({
          type: 'error',
          message: 'No config. Send { type: "config", provider, model, apiKey } first.',
        });
        return;
      }
      currentSessionId = msg.sessionId;
      try {
        // v0.2 demo: '/mock ' 前缀触发 mock stream (不依赖 SDK + 真 LLM)
        if (msg.content.startsWith('/mock ')) {
          await runMockStream(send, msg.content.slice(6));
          return;
        }
        // v0.2+: openai-compatible 走自实现 fetch + SSE (绕过 SDK getBuiltinModel 限制)
        if (config.provider === 'openai-compatible') {
          if (!config.baseUrl) {
            send({ type: 'error', message: 'openai-compatible needs baseUrl' });
            return;
          }
          await runOpenAICompatiblePrompt(
            {
              baseUrl: config.baseUrl,
              apiKey: config.apiKey,
              model: config.model,
              thinkingLevel: config.thinkingLevel,
            },
            msg.content,
            send,
          );
          return;
        }
        const entry = await getOrCreateSession(msg.sessionId, config, send);
        await runPrompt(msg.sessionId, config, msg.content);
        entry.fullText = '';
      } catch (err) {
        // err.message 可能含 apiKey leak (Pi SDK error), 走 safeStringify
        const safeMsg = err instanceof Error ? err.message : String(err);
        send({ type: 'error', message: safeMsg.slice(0, 500) });
      }
      return;
    }

    send({ type: 'error', message: `Unknown message type: ${(msg as { type: string }).type}` });
  });

  ws.on('close', () => {
    console.log(`[pi-server] WS closed (session=${currentSessionId})`);
    // 销毁 config (内存清理)
    config = null;
  });

  ws.on('error', (err) => {
    console.error('[pi-server] WS error:', err);
  });
});

console.log(`[pi-server] WS endpoint ws://localhost:${PORT}/api/chat`);

/**
 * v0.2 demo: mock stream pipeline
 * 触发条件: client 发的 content 以 '/mock ' 开头 (不依赖真 LLM, 走 fake stream)
 * agent_start → message_start → message_update chunks → message_end → agent_end
 */
async function runMockStream(
  send: (e: ServerToClient) => void,
  userContent: string,
): Promise<void> {
  const reply = `你好! 你说的是: "${userContent.slice(0, 80)}". 这是 mock 流式响应 — server 端不调真 LLM, 直接发 fake chunks 演示 stream pipeline.`;
  const chunks: string[] = [];
  for (let i = 0; i < reply.length; i += 4) chunks.push(reply.slice(i, i + 4));

  send({ type: 'agent_start' });
  send({ type: 'message_start' });
  for (const chunk of chunks) {
    await new Promise((r) => setTimeout(r, 60));
    send({ type: 'message_update', delta: chunk });
  }
  send({ type: 'message_end' });
  send({ type: 'agent_end' });
  console.log(`[pi-server] mock stream sent: ${chunks.length} chunks`);
}

const shutdown = () => {
  console.log('\n[pi-server] shutting down...');
  wss.clients.forEach((c) => c.close());
  server.close(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
