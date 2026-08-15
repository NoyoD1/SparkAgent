/**
 * Pi SDK session manager — 1:1 映射 sessionId → AgentSession
 *
 * Phase 2 BYOK:
 * - 每条 WS 连接先发 { type: 'config', provider, model, apiKey }
 * - server 在内存里保留 apiKey (per-connection), 不写盘
 * - 创建 session 时用 connection 的 config 而不是 env
 * - 永不 console.log apiKey, 错误消息 redact key
 */
import {
  createAgentSession,
  type AgentSession,
  type AgentSessionEvent,
} from '@earendil-works/pi-coding-agent';
import { getBuiltinModel } from '@earendil-works/pi-ai/providers/all';
import type { ServerToClient } from './types.js';

export interface SessionEntry {
  session: AgentSession;
  /** 当前正在 stream 的 assistant 文本累积 (调试用) */
  fullText: string;
  /** WS 推送回调 */
  send: (event: ServerToClient) => void;
}

const sessions = new Map<string, SessionEntry>();

/** 把 apiKey redact 成 ***, 防止 leak 到日志/错误 */
function redactApiKey(s: string): string {
  if (s.length <= 8) return '***';
  return `${s.slice(0, 4)}***${s.slice(-4)}`;
}

/** 安全 stringify — 替换 key-like 字段 */
function safeStringify(obj: unknown): string {
  const seen = new WeakSet();
  return JSON.stringify(obj, (_k, v) => {
    if (typeof v === 'string' && (v.startsWith('sk-') || v.startsWith('sk_') || v.length > 30 && /^[A-Za-z0-9_-]+$/.test(v))) {
      return redactApiKey(v);
    }
    if (typeof v === 'object' && v !== null) {
      if (seen.has(v)) return '[Circular]';
      seen.add(v);
    }
    return v;
  });
}

/** 拿一个 session, 不存在就创建. config 由调用方提供 (per-connection). */
export async function getOrCreateSession(
  sessionId: string,
  config: ConnectionConfig,
  send: SessionEntry['send'],
): Promise<SessionEntry> {
  // 内部 key 包含 provider+model, 切换 active 时自动起新 session
  // 同一个 (sessionId, provider, model) 才复用
  const internalKey = `${sessionId}#${config.provider}#${config.model}`;
  const existing = sessions.get(internalKey);
  if (existing) {
    existing.send = send;
    return existing;
  }

  // 动态 pick up provider/model, validate built-in catalog 里有
  let model;
  try {
    model = getBuiltinModel(
      config.provider as Parameters<typeof getBuiltinModel>[0],
      config.model as Parameters<typeof getBuiltinModel>[1],
    );
  } catch (e) {
    throw new Error(
      `Unknown provider/model: ${config.provider}/${config.model}. ` +
        `Check pi-ai built-in catalog. (${e instanceof Error ? e.message : 'unknown'})`,
    );
  }

  // 创 per-session ModelRuntime, 把 apiKey 写进去
  // Pi SDK 的 ModelRuntime.create() 默认从 agentDir/auth.json 读, 我们走 setRuntimeApiKey 注入
  const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
  const runtime = await ModelRuntime.create();
  // setRuntimeApiKey 内部会更新 in-memory auth, 调用 LLM 时 env 不会再 pick up
  await runtime.setRuntimeApiKey(config.provider, config.apiKey);

  const { session } = await createAgentSession({
    model,
    modelRuntime: runtime,
    // demo 默认只给 read / ls / grep / find 四个只读工具
    tools: ['read', 'ls', 'grep', 'find'],
  });

  // 订阅 SDK 事件, 转发到 WS
  const unsubscribe = session.subscribe((event) => {
    forwardEvent(sessionId, event);
  });

  const entry: SessionEntry = {
    session,
    fullText: '',
    send,
  };

  const origDispose = session.dispose.bind(session);
  session.dispose = () => {
    unsubscribe();
    sessions.delete(internalKey);
    return origDispose();
  };

  sessions.set(internalKey, entry);
  // ⚠️ 不 log config (apiKey), 只 log provider/model
  console.log(`[pi-server] session ${internalKey} created`);
  return entry;
}

export interface ConnectionConfig {
  provider: string;
  model: string;
  /** ⚠️ 不要 console.log, 不要 return 给 client. v0.2 来自 server .env */
  apiKey: string;
  /** OpenAI-compatible baseUrl (从 client 协议层传, server 端转发给 SDK) */
  baseUrl?: string;
}

function forwardEvent(
  sessionId: string,
  event: AgentSessionEvent,
): void {
  const entry = sessions.get(sessionId);
  if (!entry) return;

  switch (event.type) {
    case 'agent_start':
      entry.send({ type: 'agent_start' });
      break;

    case 'message_start':
      entry.send({ type: 'message_start' });
      break;

    case 'message_update': {
      const inner = event.assistantMessageEvent;
      if (inner.type === 'text_delta') {
        entry.fullText += inner.delta;
        entry.send({ type: 'message_update', delta: inner.delta });
      }
      break;
    }

    case 'message_end':
      entry.send({ type: 'message_end' });
      break;

    case 'tool_execution_start':
      entry.send({
        type: 'tool_start',
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        args: redactArgs(event.args as Record<string, unknown>),
      });
      break;

    case 'tool_execution_update':
      if (event.partialResult && typeof (event.partialResult as { stdout?: string }).stdout === 'string') {
        entry.send({
          type: 'tool_update',
          toolCallId: event.toolCallId,
          delta: (event.partialResult as { stdout?: string }).stdout ?? '',
        });
      }
      break;

    case 'tool_execution_end':
      entry.send({
        type: 'tool_end',
        toolCallId: event.toolCallId,
        result: event.isError ? '[error]' : event.result,
        error: event.isError ? safeStringify(event.result).slice(0, 500) : undefined,
      });
      break;

    case 'agent_end':
      entry.send({ type: 'agent_end' });
      break;

    case 'agent_settled':
      break;

    default:
      break;
  }
}

/** tool args 里可能有 key-like 字段, 走 redact */
function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string' && v.length > 20 && /^[A-Za-z0-9_-]+$/.test(v)) {
      out[k] = redactApiKey(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** 收到 prompt, 调 session.prompt() */
export async function runPrompt(
  sessionId: string,
  config: ConnectionConfig,
  content: string,
): Promise<void> {
  const internalKey = `${sessionId}#${config.provider}#${config.model}`;
  const entry = sessions.get(internalKey);
  if (!entry) {
    throw new Error(`session ${internalKey} not found`);
  }
  // v0.2 demo: 'mock' provider 走 fake stream pipeline (演示流式 UI 跟转发)
  if (config.provider === 'mock') {
    await runMockPrompt(entry, content);
    return;
  }
  await entry.session.prompt(content);
}

/**
 * v0.2 demo: mock provider 流式 (证明 stream pipeline 走通)
 * - agent_start → message_start → message_update chunks → message_end → agent_end
 * - 50ms 一个 chunk, 10 chunks = 你好!  (中文)
 */
async function runMockPrompt(entry: SessionEntry, content: string): Promise<void> {
  const reply = `你好! 你说的是: ${content.slice(0, 50)}${content.length > 50 ? '...' : ''}`;
  const chunks = chunkify(reply, 3);
  entry.send({ type: 'agent_start' });
  entry.send({ type: 'message_start' });
  for (const chunk of chunks) {
    await new Promise((r) => setTimeout(r, 60));
    entry.fullText += chunk;
    entry.send({ type: 'message_update', delta: chunk });
  }
  entry.send({ type: 'message_end' });
  entry.send({ type: 'agent_end' });
}

function chunkify(s: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}

/** 主动 abort 当前 turn */
export async function abortTurn(
  sessionId: string,
  config: ConnectionConfig,
): Promise<void> {
  const internalKey = `${sessionId}#${config.provider}#${config.model}`;
  const entry = sessions.get(internalKey);
  if (!entry) return;
  await entry.session.abort();
}

/** 列所有活跃 session (调试用) */
export function listSessions(): string[] {
  return Array.from(sessions.keys());
}

/** 健康检查 - 不暴露任何 session 内容 */
export function healthCheck(): {
  ok: boolean;
  sessions: number;
} {
  return { ok: true, sessions: sessions.size };
}
