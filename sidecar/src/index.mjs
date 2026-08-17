// Sidecar entrypoint — wires stdin/stdout JSON Lines to the Pi Agent runtime.
//
// v0.4 重写: 集成 @earendil-works/pi-ai + pi-agent-core + pi-coding-agent.
// v0.4.1+ 加 tool permission confirm (ask/smart/allow 3 模式, 通过 Extension API).
// v0.4.2 step 1 切 createAgentSession + SessionManager + per-workspace 隔离:
//   - 切 new Agent → createAgentSession (自动 persistence + compaction + auto-retry)
//   - 切 beforeToolCall hook → Extension pi.on("tool_call", handler) (AgentSession 内部桥接)
//   - 切 sidecar 自写 retry 状态机 → 订阅 AgentSession auto_retry_start/_end (跟 SDK 对齐)
//   - 加 4 个 IPC 事件: compaction_start / compaction_end / auto_retry_start / auto_retry_end
//   - 加 1 个 IPC 入口: compact_session (手动压缩)
//   - 加 per-workspace 隔离: ~/.pi/agent/sessions/<sha256(workspace).slice(0,16)>/<sessionId>.jsonl
//   - sessionId 走 stdin config, FE 端 perWorkspaceSessionId Map 持久化
//
// IPC: stdin/stdout JSON lines.
//   - input:  { type: 'config', provider, model, baseUrl?, apiKey, thinkingLevel?, workspacePath?, permissionMode?, sessionId? }
//             { type: 'prompt', content }                                  (sessionId 走 config 时的 sessionId)
//             { type: 'abort' }
//             { type: 'permission_response', toolCallId, allow, reason? }  // 走 Extension permission hook
//             { type: 'set_permission_mode', mode }
//             { type: 'compact_session' }                                  // v0.4.2 step 1
//   - output: { type: 'config_ok' | 'config_error' | 'agent_start' | 'message_start'
//             | 'message_update' | 'tool_start' | 'tool_update' | 'tool_end'
//             | 'message_end' | 'agent_end' | 'error'
//             | 'permission_request'
//             | 'auto_retry_start' | 'auto_retry_end'                      // v0.4.2 step 1 (替代 retry_*)
//             | 'compaction_start' | 'compaction_end' }                    // v0.4.2 step 1
//
// Security:
//   - apiKey 走 stdin (Tauri 端从 OS keychain 读, 不进 FE)
//   - 错误信息 sanitize 401/403 含 key 模式
//   - 一次 prompt 进程结束即丢 (sidecar 一次 spawn 模型, ADR-0009)
import readline from 'node:readline';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
} from '@earendil-works/pi-coding-agent';

import { createModels, createProvider } from '@earendil-works/pi-ai';

// v0.4: pi-ai 0.84.2 顶层不 re-export provider factory, 走 './providers/*' 子路径
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek';
import { moonshotaiProvider } from '@earendil-works/pi-ai/providers/moonshotai';
import { groqProvider } from '@earendil-works/pi-ai/providers/groq';
import { googleProvider } from '@earendil-works/pi-ai/providers/google';
import { minimaxProvider } from '@earendil-works/pi-ai/providers/minimax';

// OpenAI-compatible API stream 函数 (用于 createProvider 通用 endpoint, 如商汤/任意 OpenAI-compatible)
import { stream as openaiCompletionsStream, streamSimple as openaiCompletionsStreamSimple } from '@earendil-works/pi-ai/api/openai-completions';

// v0.4.1+ 测试用: PI_FAUX=1 环境变量时, 额外注册 faux provider (smoke test 用).
// 跟 7 内置 + user-custom 互不影响. 不设 PI_FAUX 时不 import 不 register, 0 副作用.
if (process.env.PI_FAUX === '1') {
  const { fauxProvider, fauxText, fauxThinking, fauxToolCall, fauxAssistantMessage } = await import('@earendil-works/pi-ai');
  // @ts-ignore
  globalThis.__piFauxProvider = fauxProvider({
    models: [{
      id: 'faux-model',
      name: 'Faux Test Model',
      api: 'faux',
      contextWindow: 8000,
      maxTokens: 4000,
    }],
  });
  // v0.4.2 step 1: AgentSession 走 ModelRuntime → 读 auth.json 验证 hasConfiguredAuth(providerId).
  // PI_FAUX 时自动写 fake auth.json 让 ModelRuntime 通过验证. 写到 agentDir (PI_CODING_AGENT_DIR
  // 或 ~/.pi/agent/), 字段 'faux' (api_key type, key='faux-fake-key'). 不污染 production 因为
  // 'faux' provider 在 production 不存在. test 结束不需要清理 (faux 字段不会被 production 用).
  try {
    const { writeFileSync, existsSync, readFileSync, mkdirSync } = await import('node:fs');
    const agentDir = getAgentDir();
    const authPath = join(agentDir, 'auth.json');
    if (!existsSync(agentDir)) mkdirSync(agentDir, { recursive: true });
    let authData = {};
    if (existsSync(authPath)) {
      try { authData = JSON.parse(readFileSync(authPath, 'utf-8')); } catch {}
    }
    if (!authData.faux) {
      authData.faux = { type: 'api_key', key: 'faux-fake-key' };
      writeFileSync(authPath, JSON.stringify(authData, null, 2), 'utf-8');
      console.error(`[sidecar] PI_FAUX=1: wrote fake 'faux' credential to ${authPath}`);
    }
  } catch (e) {
    console.error(`[sidecar] PI_FAUX auth.json setup failed: ${e.message}`);
  }
  if (process.env.PI_FAUX_RESPONSES) {
    try {
      const responsesJson = JSON.parse(process.env.PI_FAUX_RESPONSES);
      const responses = responsesJson.map((r) => () => fauxAssistantMessage([
        ...(r.thinking ? [fauxThinking(r.thinking)] : []),
        ...(r.text ? [fauxText(r.text)] : []),
        ...(r.toolCall ? [fauxToolCall(r.toolCall.name, r.toolCall.args, { id: r.toolCall.id })] : []),
      ]));
      if (process.env.PI_FAUX_HANG === '1' && responses.length > 0) {
        const lastIdx = responses.length - 1;
        responses[lastIdx] = () => new Promise(() => { /* never resolves - hang */ });
        console.error(`[sidecar] PI_FAUX_HANG=1: last response replaced with never-resolving Promise (simulates stream hang)`);
      }
      globalThis.__piFauxProvider.setResponses(responses);
      console.error(`[sidecar] PI_FAUX_RESPONSES loaded: ${responses.length} responses`);
    } catch (e) {
      console.error(`[sidecar] PI_FAUX_RESPONSES parse failed: ${e.message}`);
    }
  }
  console.error('[sidecar] PI_FAUX=1 detected, faux provider registered (test mode)');
}

// v0.4.2 step 1: 7 tool 不再显式注册, AgentSession._buildRuntime 自动调 createAllToolDefinitions(cwd)
//   (agent-session.ts:2571) 注册全部 7 个. 但 active tool 走 options.tools 显式传 (sdk.ts:247-254
//   默认只 4 个 read/bash/edit/write, grep/find/ls 不会激活). 所以 createAgentSession 时传
//   tools: ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'].

/** @type {any} 当前 config (从 stdin { type: 'config' } 写入) */
let globalConfig = null;

/** @type {any | null} 当前 AgentSession, 用于 prompt / subscribe / compact / abort */
let currentSession = null;

/** @type {string | null} 当前 session 的 sessionId (FE 给的 stable id, 用来 per-workspace 持久化) */
let currentSessionId = null;

/** v0.4.1.4+ module-level 暴露 finishUp 给 watchdog (session.subscribe 内的 closure 没法被 setInterval 访问) */
let currentFinishUp = null;

/** v0.4.1.4+ stream hang watchdog.
 * 商汤 deepseek-v4-flash 偶尔在 tool_call 之后不 emit 'done' event,
 * 让 Pi SDK `for await` 永远 hang, sidecar 永远不 emit message_end,
 * FE 永远 "生成中". watchdog 检测 30s 没新 event 强制 finishUp.
 */
const STREAM_HANG_TIMEOUT_MS = 30_000;
const STREAM_HANG_CHECK_MS = 5_000;
let lastStreamEventTime = 0;
let hangWatchdog = null;
function resetHangWatchdog() {
  lastStreamEventTime = Date.now();
}
function startHangWatchdog() {
  stopHangWatchdog();
  resetHangWatchdog();
  hangWatchdog = setInterval(() => {
    const idle = Date.now() - lastStreamEventTime;
    if (idle > STREAM_HANG_TIMEOUT_MS) {
      console.error(`[sidecar] WATCHDOG: ${Math.round(idle / 1000)}s no stream event, force finish`);
      if (currentSession) {
        try { currentSession.abort(); } catch (e) { console.error('[sidecar] WATCHDOG abort threw:', e); }
      }
      setTimeout(() => {
        if (currentFinishUp) {
          console.error('[sidecar] WATCHDOG: emit finishUp manually (Pi SDK not responding to abort)');
          currentFinishUp();
        }
      }, 1000);
      stopHangWatchdog();
    }
  }, STREAM_HANG_CHECK_MS);
}
function stopHangWatchdog() {
  if (hangWatchdog) {
    clearInterval(hangWatchdog);
    hangWatchdog = null;
  }
}

/** v0.4.1+ tool permission 模式. 初始走 config.permissionMode, 运行时可被 set_permission_mode 改.
 *  - 'ask'   每次都 confirm (最安全, 默认)
 *  - 'smart' 读类 (read/ls/find/grep) 自动放行, 写/命令/编辑 confirm
 *  - 'allow' 全部放行 (最危险, 不推荐)
 * @type {'ask' | 'smart' | 'allow'}
 */
let currentPermissionMode = 'ask';

/** v0.4.1+ 把 permission request 跟 response 配对.
 *  - key: toolCallId
 *  - value: { resolve: (result: { block?: boolean, reason?: string } | undefined) => void }
 *  pi.on("tool_call") handler 把 resolve 存这里, 等 FE permission_response 来了再 resolve.
 * @type {Map<string, { resolve: any }>}
 */
const pendingPermissionRequests = new Map();

/** smart 模式自动放行的读类工具 (看东西, 不改东西) */
const SMART_READ_ONLY_TOOLS = new Set(['read', 'ls', 'find', 'grep']);

function send(event) {
  // v0.4.1+ fix: Node.js 在 pipe (stdio: 'pipe') 模式下, process.stdout.write 默认
  // 异步 flush + 内部 highWaterMark buffer. 当 tool.execute() 之后并发 emit 多个
  // event 可能在同一个 microtask 内串行 write, 但 Node.js 内部会把部分 write 合并
  // 到下一个 chunk, 导致 readline 收不到完整 line 报 timeout.
  // 修法: process.stdout.cork() 包裹 write, uncork() 强制 flush.
  process.stdout.cork();
  const line = JSON.stringify(event) + '\n';
  process.stdout.write(line);
  process.stdout.uncork();
}

// R4: 401/403 错误信息可能含 key 字面量 (e.g. "Invalid API key sk-AB***").
// sanitize 去掉常见 key 模式 + bearer 头, 跟 Rust 端 mask 风格一致.
const KEY_PATTERNS = [
  /\bsk-[A-Za-z0-9_\-]{4,}/g,
  /\bsk-proj-[A-Za-z0-9_\-]{4,}/g,
  /\bAKIA[0-9A-Z]{4,}/g,
  /\bghp_[A-Za-z0-9]{4,}/g,
  /\bxai-[A-Za-z0-9_\-]{4,}/g,
  /\bAIza[0-9A-Za-z_\-]{4,}/g,
  /Bearer\s+[A-Za-z0-9_\-\.]{8,}/gi,
];
function sanitizeErrBody(text) {
  let out = String(text || '');
  for (const re of KEY_PATTERNS) {
    out = out.replace(re, (m) => (m.length > 4 ? `${m.slice(0, 2)}***` : '***'));
  }
  return out.slice(0, 300);
}

/**
 * v0.4.2 step 1: per-workspace 隔离 session 目录.
 * workspace 路径 → sha256 前 16 位 → 目录 <agentDir>/sessions/<hash>/<sessionId>.jsonl.
 * 不同 workspace 走不同目录, sessionId 复用, 互不污染.
 *
 * 走 getAgentDir() 而不是 homedir() 是因为 getAgentDir() 接受 PI_CODING_AGENT_DIR env var 覆盖
 * (smoke test 用临时目录隔离 production data, 见 test-smoke-session-persistence.mjs).
 */
function sessionDirFor(workspacePath) {
  const hash = createHash('sha256').update(workspacePath || process.cwd()).digest('hex').slice(0, 16);
  return join(getAgentDir(), 'sessions', hash);
}

/**
 * v0.4.2 step 1: 找 dir 里匹配 sessionId 的现有 session file (走 resume).
 * Pi SDK 0.84.2 SessionManager.create({id}) 每次用新 timestamp 创 file, 不支持用 id resume.
 * 修法: sidecar 启动时先扫 dir 找旧 file, 找到就 setSessionFile() 走 load 模式.
 *
 * @param {string} dir
 * @param {string} sessionId
 * @returns {string|null} 旧 file path, 或 null
 */
function findExistingSessionFile(dir, sessionId) {
  if (!sessionId || !existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  // 文件名格式: <timestamp>_<sessionId>.jsonl
  const matchSuffix = `_${sessionId}.jsonl`;
  const matched = files.find((f) => f.endsWith(matchSuffix));
  return matched ? join(dir, matched) : null;
}

/**
 * 根据 config 构建 pi-ai Models 集合.
 *
 * - 7 内置 provider 用 Pi SDK 工厂 (anthropic/openai/deepseek/moonshotai/groq/google/minimax)
 * - 自定义 (config.baseUrl) 用 createProvider({ baseUrl, api: openaiCompletionsApi })
 *   覆盖商汤/任意 OpenAI-compatible 端点
 */
function buildModels(config) {
  const models = createModels();
  models.setProvider(anthropicProvider());
  models.setProvider(openaiProvider());
  models.setProvider(deepseekProvider());
  models.setProvider(moonshotaiProvider());
  models.setProvider(groqProvider());
  models.setProvider(googleProvider());
  models.setProvider(minimaxProvider());

  if (globalThis.__piFauxProvider) {
    const fauxProviderObj = globalThis.__piFauxProvider;
    if (process.env.PI_FAUX === '1') {
      console.error(`[sidecar] PI_FAUX: fauxProviderObj.provider.id=${fauxProviderObj.provider.id} models count=${fauxProviderObj.provider.getModels().length}`);
    }
    models.setProvider(fauxProviderObj.provider);
  }

  if (config.baseUrl) {
    const customApiKey = config.apiKey || '';
    models.setProvider(createProvider({
      id: 'user-custom',
      name: config.providerLabel || 'Custom',
      baseUrl: config.baseUrl,
      auth: {
        apiKey: {
          name: 'Custom OpenAI-compatible API key',
          resolve: async () => ({
            auth: { apiKey: customApiKey },
            source: 'sidecar config',
          }),
        },
      },
      models: [{
        id: config.model,
        provider: 'user-custom',
        name: config.model,
        api: 'openai-completions',
        baseUrl: config.baseUrl,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 8192,
      }],
      api: {
        stream: openaiCompletionsStream,
        streamSimple: openaiCompletionsStreamSimple,
      },
    }));
  }

  return models;
}

/**
 * v0.4.2 step 1: Extension factory 接管 tool permission 3 模式.
 *
 * 走 Extension API `pi.on("tool_call", handler)`:
 *  - AgentSession 创建时自动装 `agent.beforeToolCall = runner.emitToolCall` 桥接
 *  - 我们注册 handler 后, 所有 tool call 自动走这里
 *  - 返回 `undefined` = 放行, 返回 `{ block: true, reason }` = 阻止 (Pi SDK emit error tool result)
 *
 * mode 决策:
 *  - 'allow' → undefined (全部放行)
 *  - 'smart' + 读类工具 (read/ls/find/grep) → undefined (自动放行)
 *  - 'ask' / 'smart' + 写类工具 → emit permission_request 给 FE, 等 permission_response
 */
function permissionExtensionFactory(pi) {
  pi.on('tool_call', async (event, ctx) => {
    const toolName = event.toolName;
    const toolCallId = event.toolCallId;
    const mode = currentPermissionMode;

    if (mode === 'allow') {
      return;
    }
    if (mode === 'smart' && SMART_READ_ONLY_TOOLS.has(toolName)) {
      return;
    }

    console.error(`[sidecar] permission_request: tool=${toolName} id=${toolCallId} mode=${mode} args=${JSON.stringify(event.input).slice(0, 200)}`);

    return new Promise((resolve) => {
      const signal = ctx?.signal;
      if (signal) {
        signal.addEventListener('abort', () => {
          pendingPermissionRequests.delete(toolCallId);
          resolve({ block: true, reason: 'Aborted by user' });
        }, { once: true });
      }
      pendingPermissionRequests.set(toolCallId, { resolve });
      send({
        type: 'permission_request',
        toolCallId,
        toolName,
        args: event.input,
        sessionId: currentSessionId,
      });
    });
  });
}

/**
 * v0.4.2 step 1: 把 AgentSessionEvent 映射到 v0.4.x JSON Lines 协议.
 * FE 端协议增量: 旧事件 (agent_start / message_start / ... / retry_*) + 4 新事件
 * (auto_retry_start / auto_retry_end / compaction_start / compaction_end).
 *
 * event.type 列表 (agent-session.ts:140+):
 *  - 'agent_start' | 'agent_end' | 'agent_settled'
 *  - 'turn_start' | 'turn_end'
 *  - 'message_start' | 'message_update' | 'message_end'
 *  - 'tool_execution_start' | 'tool_execution_update' | 'tool_execution_end'
 *  - 'compaction_start' | 'compaction_end'         // v0.4.2 step 1 新
 *  - 'auto_retry_start' | 'auto_retry_end'         // v0.4.2 step 1 新 (替代 retry_*)
 *  - 'entry_appended'                              // v0.4.2 step 1 跳过 (sidecar 内部用)
 *  - 'bash_execution_update' | 'queue_update' | 'session_info_changed' | 'thinking_level_changed' | 'summarization_*'
 *    — 未实现, 跳过 (PI_FAUX_RESPONSES 不依赖这些)
 */
function mapAgentSessionEventToIPC(event, sessionId) {
  switch (event.type) {
    case 'agent_start':
      send({ type: 'agent_start', sessionId });
      return;
    case 'turn_start':
      send({ type: 'turn_start', sessionId });
      return;
    case 'turn_end':
      send({ type: 'turn_end', sessionId });
      return;
    case 'message_start':
      send({ type: 'message_start', sessionId, role: event.message?.role });
      return;
    case 'message_update': {
      const inner = event.assistantMessageEvent;
      if (!inner) return;
      if (inner.type === 'text_delta') {
        send({ type: 'message_update', kind: 'content', delta: inner.delta, sessionId });
      } else if (inner.type === 'thinking_delta') {
        send({ type: 'message_update', kind: 'thinking', delta: inner.delta, sessionId });
      }
      return;
    }
    case 'tool_execution_start':
      send({
        type: 'tool_start',
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        args: event.args,
        sessionId,
      });
      console.error(`[sidecar] mapAgentSessionEventToIPC: tool_start ${event.toolName} ${event.toolCallId}`);
      return;
    case 'tool_execution_update':
      send({
        type: 'tool_update',
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        partialResult: event.partialResult,
        sessionId,
      });
      return;
    case 'tool_execution_end': {
      console.error(`[sidecar] mapAgentSessionEventToIPC: tool_execution_end ${event.toolName} ${event.toolCallId} isError=${event.isError}`);
      const isError = event.isError === true;
      const result = event.result;
      let errorText;
      if (isError) {
        const first = Array.isArray(result?.content) ? result.content[0] : null;
        errorText = first?.text || 'Tool execution failed';
      }
      try {
        send({
          type: 'tool_end',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          result: isError ? undefined : result,
          error: errorText,
          sessionId,
        });
      } catch (e) {
        console.error('[sidecar] SEND tool_end threw:', e);
      }
      return;
    }
    case 'message_end': {
      // AgentSession 把 LLM error 写到 assistant message 的 errorMessage 字段 (跟 v0.4.1 Agent 一致)
      if (event.message?.stopReason === 'error' && event.message?.errorMessage) {
        send({
          type: 'error',
          message: sanitizeErrBody(String(event.message.errorMessage)),
          sessionId,
        });
      }
      // 由 finishUp 统一发 message_end, 这里不重复
      return;
    }
    case 'agent_end':
      // 由 finishUp 统一发
      return;
    case 'error': {
      // 顶层 error event (rare, AgentSession 通常走 message_end + errorMessage)
      const assistantMessage = event.error;
      const errorMessage = assistantMessage?.errorMessage
        || event.reason
        || 'Unknown error from Pi SDK';
      send({ type: 'error', message: sanitizeErrBody(String(errorMessage)), sessionId });
      return;
    }
    case 'auto_retry_start': {
      // v0.4.2 step 1: AgentSession 内置 retry 状态机 emit
      send({
        type: 'auto_retry_start',
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
        errorMessage: event.errorMessage,
        sessionId,
      });
      return;
    }
    case 'auto_retry_end': {
      send({
        type: 'auto_retry_end',
        success: event.success,
        attempts: event.attempt,
        finalError: event.finalError,
        sessionId,
      });
      return;
    }
    case 'compaction_start': {
      // reason: 'manual' | 'threshold' | 'overflow'
      send({ type: 'compaction_start', reason: event.reason, sessionId });
      return;
    }
    case 'compaction_end': {
      // result 是 CompactionResult | undefined, aborted boolean, willRetry boolean
      send({
        type: 'compaction_end',
        reason: event.reason,
        success: !!event.result && !event.aborted,
        willRetry: event.willRetry,
        errorMessage: event.errorMessage,
        sessionId,
      });
      return;
    }
    case 'entry_appended':
      // v0.4.2 step 1: SessionManager 内部持久化事件, FE 不需要, 跳过
      return;
    default:
      // 其他 event (queue_update / session_info_changed / thinking_level_changed / agent_settled / bash_execution_update / summarization_*)
      // v0.4.2 step 1 暂不实现, log 后忽略
      console.error(`[sidecar] unmapped AgentSessionEvent type: ${event.type}`);
      return;
  }
}

/**
 * v0.4.2 step 1: 跑一次 LLM 调用. 用 currentSession.prompt() (不是 agent.prompt, 那是 v0.4.1 旧 API).
 * session 已经在 createSession 阶段建好了, 这里只跑 prompt + 订阅事件.
 *
 * abort / retry / compaction 都由 AgentSession 内部管理:
 *  - abort: 调 currentSession.abort() (IPC abort 入口)
 *  - retry: AgentSession auto_retry_* 事件自动 emit, 我们转发给 FE
 *  - compaction: AgentSession 内部 shouldCompact 检查, 或 FE 调 compact_session
 *
 * @param {string} userContent
 * @param {string} sessionId
 */
async function runPrompt(userContent, sessionId) {
  if (!currentSession) {
    send({ type: 'error', message: 'No session — send { type: "config" } first', sessionId });
    return;
  }

  let agentEndSent = false;
  const finishUp = () => {
    if (!agentEndSent) {
      send({ type: 'message_end', sessionId });
      send({ type: 'agent_end', sessionId });
      agentEndSent = true;
    }
  };
  currentFinishUp = finishUp;
  startHangWatchdog();

  // 订阅 AgentSession 事件 → 映射 IPC
  const unsubscribe = currentSession.subscribe((event) => {
    try {
      resetHangWatchdog();  // 任何 event 都 reset watchdog
      mapAgentSessionEventToIPC(event, sessionId);
      if (event.type === 'agent_end') {
        finishUp();
      }
    } catch (e) {
      console.error('[sidecar] session event handler threw:', e);
    }
  });

  try {
    await currentSession.prompt(userContent);
  } catch (e) {
    console.error('[sidecar] session.prompt threw:', e);
    if (!agentEndSent) {
      send({
        type: 'error',
        message: sanitizeErrBody(e instanceof Error ? e.message : String(e)),
        sessionId,
      });
      finishUp();
    }
  }

  try { unsubscribe?.(); } catch {}
  stopHangWatchdog();
  currentFinishUp = null;
  // v0.4.1+ abort 时清掉所有 pending permission request, 避免 FE 弹窗卡死
  for (const [toolCallId, { resolve }] of pendingPermissionRequests) {
    resolve({ block: true, reason: 'Aborted' });
  }
  pendingPermissionRequests.clear();
}

// ===== IPC: stdin JSON Lines =====
const rl = readline.createInterface({ input: process.stdin });
// v0.4.2 step 1 fix: race condition — Rust 端写完 config + prompt 不等 sidecar 处理 config,
//   case 'config' IIFE 异步 build session (~150-300ms), readline 立即处理下一行 (case 'prompt'),
//   currentSession 还是 null → emit "No session" 错误. 修复:
//   1. case 'config' capture promise 到 sessionBuildPromise
//   2. case 'prompt' 看到 sessionBuildPromise 时 await 它, 等 session ready
let sessionBuildPromise = null;
rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line.replace(/^\uFEFF/, ''));
  } catch (e) {
    send({ type: 'error', message: `IPC parse error: ${e instanceof Error ? e.message : String(e)}` });
    return;
  }
  try {
    switch (msg.type) {
      case 'config': {
        if (!msg.provider || !msg.model) {
          send({ type: 'config_error', message: 'Missing provider or model in config' });
          return;
        }
        if (msg.baseUrl && !msg.apiKey) {
          send({ type: 'config_error', message: 'baseUrl provided but apiKey missing' });
          return;
        }
        globalConfig = msg;
        if (msg.permissionMode === 'ask' || msg.permissionMode === 'smart' || msg.permissionMode === 'allow') {
          currentPermissionMode = msg.permissionMode;
        } else {
          currentPermissionMode = 'ask';
        }

        // v0.4.2 step 1: 创建 SessionManager + customResourceLoader + createAgentSession
        const workspacePath = msg.workspacePath || process.cwd();
        const sessionId = msg.sessionId || `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const sessionDir = sessionDirFor(workspacePath);

        console.error(`[sidecar] config: provider=${msg.provider} model=${msg.model} workspace=${workspacePath} sessionId=${sessionId} permissionMode=${currentPermissionMode}`);

        // 异步 build (createAgentSession 内部可能 fetch 模型列表 / 加载 resource)
        // v0.4.2 step 1 fix: capture promise 给后续 'prompt' case await, 避免 race
        sessionBuildPromise = (async () => {
          try {
            const models = buildModels(globalConfig);
            const providerId = globalConfig.baseUrl ? 'user-custom' : globalConfig.provider;
            const model = models.getModel(providerId, globalConfig.model);
            if (!model) {
              send({ type: 'config_error', message: `Model not found: ${providerId}/${globalConfig.model}` });
              return;
            }

            // 1. SessionManager: per-workspace 隔离 + 稳定 sessionId
            //    Pi SDK 0.84.2 SessionManager.create({id}) 每次创新 file (新 timestamp), 不支持 resume.
            //    走 setSessionFile 走 load 模式: 先扫 dir 找旧 file
            let sessionManager = SessionManager.create(workspacePath, sessionDir, { id: sessionId });
            const existingFile = findExistingSessionFile(sessionDir, sessionId);
            if (existingFile) {
              console.error(`[sidecar] session manager: resume existing file ${existingFile}`);
              sessionManager.setSessionFile(existingFile);
            } else {
              console.error(`[sidecar] session manager: new session, file will be at ${sessionManager.getSessionFile()}`);
            }

            // 2. ResourceLoader: 注入 permission Extension
            const customResourceLoader = new DefaultResourceLoader({
              cwd: workspacePath,
              agentDir: getAgentDir(),
              extensionFactories: [
                { name: 'pi-agent-permission', factory: permissionExtensionFactory, hidden: true },
              ],
            });
            await customResourceLoader.reload();

            // 3. createAgentSession: 7 tool 全激活 + sessionManager + resourceLoader
            const { session } = await createAgentSession({
              cwd: workspacePath,
              agentDir: getAgentDir(),
              model,
              tools: ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'],
              sessionManager,
              resourceLoader: customResourceLoader,
            });

            currentSession = session;
            currentSessionId = sessionId;

            // v0.4.2 step 1 PI_FAUX: faux provider 不在 Pi SDK 内置 catalog, 必须显式注册.
            // registerNativeProvider 走 ModelRuntime._nativeExtensionProviders + recomposeProvider,
            // 让 MutableModels 知道 faux provider, hasConfiguredAuth('faux') 走通.
            if (process.env.PI_FAUX === '1' && globalThis.__piFauxProvider) {
              try {
                session.modelRuntime.registerNativeProvider(globalThis.__piFauxProvider.provider);
                // 触发 async refresh, 等 configuredProviders 包含 faux
                await session.modelRuntime.refresh({ allowNetwork: false });
                console.error(`[sidecar] PI_FAUX: registered faux provider, hasConfiguredAuth(faux)=${session.modelRuntime.hasConfiguredAuth('faux')}`);
              } catch (e) {
                console.error('[sidecar] PI_FAUX registerNativeProvider failed:', e);
              }
            }

            send({ type: 'config_ok', provider: msg.provider, model: msg.model, sessionId });
          } catch (e) {
            console.error('[sidecar] createAgentSession failed:', e);
            send({
              type: 'config_error',
              message: sanitizeErrBody(e instanceof Error ? `${e.message}\n${e.stack?.split('\n').slice(0, 3).join('\n')}` : String(e)),
            });
            sessionBuildPromise = null;  // build 失败, 清 promise 避免后续 prompt 永久 hang
          }
        })();
        return;
      }
      case 'prompt': {
        // v0.4.2 step 1 fix: session 还在 build 时 await sessionBuildPromise (race fix 详细见 line 583 area 注释)
        (async () => {
          if (!currentSession && sessionBuildPromise) {
            try { await sessionBuildPromise; } catch (e) { console.error('[sidecar] sessionBuildPromise failed:', e); }
          }
          if (!currentSession) {
            send({ type: 'error', message: 'No session — send { type: "config" } first', sessionId: msg.sessionId });
            return;
          }
          // 不 await — 协议是异步流, 事件通过 session.subscribe 持续发
          runPrompt(msg.content, msg.sessionId || currentSessionId).catch((e) => {
            console.error('[sidecar] runPrompt unhandled:', e);
          });
        })();
        return;
      }
      case 'abort': {
        if (currentSession) {
          try { currentSession.abort(); } catch (e) { console.error('[sidecar] abort threw:', e); }
          send({ type: 'agent_end', sessionId: msg.sessionId || currentSessionId });
        }
        return;
      }
      case 'permission_response': {
        const pending = pendingPermissionRequests.get(msg.toolCallId);
        if (!pending) {
          console.warn(`[sidecar] permission_response for unknown toolCallId: ${msg.toolCallId}`);
          return;
        }
        pendingPermissionRequests.delete(msg.toolCallId);
        if (msg.allow) {
          pending.resolve(undefined);
        } else {
          pending.resolve({ block: true, reason: msg.reason || 'User denied' });
        }
        console.error(`[sidecar] permission_response: toolCallId=${msg.toolCallId} allow=${msg.allow}`);
        return;
      }
      case 'set_permission_mode': {
        if (msg.mode === 'ask' || msg.mode === 'smart' || msg.mode === 'allow') {
          currentPermissionMode = msg.mode;
          console.error(`[sidecar] permission mode updated: ${currentPermissionMode}`);
        } else {
          console.warn(`[sidecar] set_permission_mode invalid: ${msg.mode}`);
        }
        return;
      }
      case 'compact_session': {
        // v0.4.2 step 1: FE 端手动触发压缩
        if (!currentSession) {
          send({ type: 'error', message: 'No session — send { type: "config" } first', sessionId: msg.sessionId });
          return;
        }
        const sid = msg.sessionId || currentSessionId;
        (async () => {
          try {
            await currentSession.compact();
            // compaction_start / compaction_end 由 AgentSession 自动 emit
            // 不需要额外 send, 也不需要 finishUp (compaction 不是 agent run)
          } catch (e) {
            console.error('[sidecar] session.compact threw:', e);
            send({
              type: 'error',
              message: sanitizeErrBody(e instanceof Error ? e.message : String(e)),
              sessionId: sid,
            });
          }
        })();
        return;
      }
      default:
        send({ type: 'error', message: `Unknown IPC type: ${msg.type}` });
    }
  } catch (e) {
    send({ type: 'error', message: `IPC handler error: ${e instanceof Error ? e.message : String(e)}` });
  }
});

console.error('[sidecar] booted, listening on stdin (Pi Agent v0.4.2 — createAgentSession + Extension API + auto_retry_*)');
