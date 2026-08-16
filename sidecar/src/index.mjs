// Sidecar entrypoint — wires stdin/stdout JSON Lines to the Pi Agent runtime.
//
// v0.4 重写: 不再 import ./openai-compatible.mjs (v0.3 手写 fetch 实现),
// 改为在 index.mjs 直接集成 @earendil-works/pi-ai + @earendil-works/pi-agent-core.
//
// IPC: stdin/stdout JSON lines.
//   - input:  { type: 'config', provider, model, baseUrl?, apiKey, thinkingLevel?, workspacePath? }
//             { type: 'prompt', sessionId, content }
//             { type: 'abort' }
//   - output: { type: 'config_ok' | 'config_error' | 'agent_start' | 'message_start'
//             | 'message_update' | 'tool_start' | 'tool_update' | 'tool_end'
//             | 'message_end' | 'agent_end' | 'error' }
//
// 协议跟 v0.3.x 完全一致 (FE 不感知改动):
//   - 7 内置 provider 用 Pi SDK 工厂 (anthropic/openai/deepseek/moonshotai/groq/google/minimax)
//   - 任意自定义 (商汤/自建) 用 createProvider({ baseUrl, api: openaiCompletionsApi })
//   - 流式 / thinking / tool call 协议由 pi-agent-core Agent.subscribe 提供
//   - 我们只做 "AgentEvent -> JSON Lines 协议" 映射
//
// Security:
//   - apiKey 走 stdin (Tauri 端从 OS keychain 读, 不进 FE)
//   - 错误信息 sanitize 401/403 含 key 模式
//   - 一次 prompt 进程结束即丢 (sidecar 一次 spawn 模型, ADR-0009)
import readline from 'node:readline';

import { Agent } from '@earendil-works/pi-agent-core';

import {
  createModels,
  createProvider,
} from '@earendil-works/pi-ai';

// v0.4: pi-ai 0.84.2 顶层不 re-export provider factory, 走 './providers/*' 子路径
// (npm 包 package.json 声明了 './providers/*' -> 'dist/providers/*.js')
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek';
import { moonshotaiProvider } from '@earendil-works/pi-ai/providers/moonshotai';
import { groqProvider } from '@earendil-works/pi-ai/providers/groq';
import { googleProvider } from '@earendil-works/pi-ai/providers/google';
import { minimaxProvider } from '@earendil-works/pi-ai/providers/minimax';

// OpenAI-compatible API stream 函数 (用于 createProvider 通用 endpoint, 如商汤/任意 OpenAI-compatible)
import { stream as openaiCompletionsStream, streamSimple as openaiCompletionsStreamSimple } from '@earendil-works/pi-ai/api/openai-completions';

// v0.4.1: 用 pi-coding-agent 的 7 个 tool (read / bash / edit / write / grep / find / ls),
// 不再自实现. cwd = workspace path, 各 tool 内部用 ExecutionEnv 抽象在 Node 跑文件系统.
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
} from '@earendil-works/pi-coding-agent';

const REASONING_MAP = { low: 'low', medium: 'medium', high: 'high' };

/** @type {any} 当前 config (从 stdin { type: 'config' } 写入) */
let globalConfig = null;

/** @type {Agent | null} 当前正在跑的 agent, 用来 abort */
let currentAgent = null;

/** @type {AbortController | null} 备用 abort (pi-agent-core AbortSignal 走这里) */
let currentAbortController = null;

function send(event) {
  process.stdout.write(JSON.stringify(event) + '\n');
}

// R4: 401/403 错误信息可能含 key 字面量 (e.g. "Invalid API key sk-AB***").
// sanitize 去掉常见 key 模式 + bearer 头, 跟 Rust 端 mask 风格一致.
const KEY_PATTERNS = [
  /\bsk-[A-Za-z0-9_\-]{4,}/g,
  /\bsk-proj-[A-Za-z0-9_\-]{4,}/g,
  /\bAKIA[0-9A-Z]{4,}/g,
  /\bghp_[A-Za-z0-9]{4,}/g,
  /\bxai-[A-Za-z0-9]{4,}/g,
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
 * 根据 config 构建 pi-ai Models 集合.
 *
 * - 7 内置 provider 用 Pi SDK 工厂 (anthropic/openai/deepseek/moonshotai/groq/google/minimax)
 * - 自定义 (config.baseUrl) 用 createProvider({ baseUrl, api: openaiCompletionsApi })
 *   覆盖商汤/任意 OpenAI-compatible 端点
 *
 * @param {any} config
 * @returns {MutableModels}
 */
function buildModels(config) {
  const models = createModels();

  // v0.3.x 7 内置 provider — 用 Pi SDK 官方工厂
  // (Pi SDK 内置 25+, 我们的 7 个是 v0.3 阶段用户能用得最多的; 后续按需加)
  models.setProvider(anthropicProvider());
  models.setProvider(openaiProvider());
  models.setProvider(deepseekProvider());
  models.setProvider(moonshotaiProvider());
  models.setProvider(groqProvider());
  models.setProvider(googleProvider());
  models.setProvider(minimaxProvider());

  // 自定义: config.baseUrl 存在时, 走 createProvider 通用 OpenAI-compatible
  // (v0.3 阶段叫 "openai-platform", 现在改成 user-custom, FE 端通过 baseUrl 字段判断)
  if (config.baseUrl) {
    // v0.4 fix: auth 字段不是 { apiKey: 'string' }, 是 { apiKey: { name, resolve } } 对象
    // resolve 总是返回 config.apiKey (从 stdin 传进来, 来自 Tauri keychain)
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
        provider: 'user-custom',        // v0.4 fix: 必须显式带 provider 字段, createProvider 工厂不自动注入
        name: config.model,
        api: 'openai-completions',
        baseUrl: config.baseUrl,         // v0.4.1 fix: 必须带 baseUrl, 否则 line 510 model.baseUrl = undefined → OpenAI SDK fallback 到 api.openai.com
        input: ['text'],                 // v0.4.2 fix: 必须带 input 数组, line 1021 model.input.includes("image") 假设 array
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
 * 把 pi-agent-core AgentEvent 映射到 v0.3.x JSON Lines 协议.
 * FE 端协议不变 (chat store handler 不动).
 *
 * 事件映射 (待 pi-agent-core 实测 verify):
 *   AgentEvent.type:
 *     - 'message_start'                  -> { type: 'message_start' }
 *     - 'message_update'                 -> { type: 'message_update', kind, delta }
 *     - 'tool_execution_start'           -> { type: 'tool_start', toolName, toolCallId, args }   (v0.4.1 fix: 之前错写成 tool_call_*)
 *     - 'tool_execution_update'          -> { type: 'tool_update', toolCallId, toolName, partialResult }
 *     - 'tool_execution_end'             -> { type: 'tool_end', toolCallId, toolName, result, error } (result 来自 event.result, error 来自 isError)
 *     - 'message_end'                    -> { type: 'message_end' } (留到 finishUp)
 *     - 'agent_end'                      -> { type: 'agent_end' }
 *     - 'error'                          -> { type: 'error', message }
 *
 * assistantMessageEvent (inside message_update):
 *     - 'text_delta'                     -> kind: 'content'
 *     - 'thinking_delta'                 -> kind: 'thinking'
 *
 * @param {any} event AgentEvent from pi-agent-core
 * @param {string} sessionId
 */
function mapAgentEventToIPC(event, sessionId) {
  switch (event.type) {
    case 'agent_start':
      // agent.subscribe 收到 agent_start → emit 一次
      // (之前手动 send agent_start 删了, 避免重复)
      send({ type: 'agent_start', sessionId });
      return;
    case 'turn_start':
    case 'turn_end':
      // 内部事件, 不映射到 IPC 协议
      return;
    case 'message_start':
      // agent.subscribe 收到 message_start (user + assistant 各一次), 全发
      // FE 端 chat store 自己处理 user vs assistant (event.message.role)
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
      // text_start / text_end / thinking_start / thinking_end 都不带 delta, 跳过
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
      // v0.4.1: pi-agent-core 用 isError 布尔, 我们 v0.3 协议用 error 字符串.
      // 把 AgentToolResult.content[0].text 当 error (tool 自己 throw 也走这里)
      const isError = event.isError === true;
      const result = event.result;
      let errorText;
      if (isError) {
        // 错误时 result.content 是 text 数组, 提取第一条
        const first = Array.isArray(result?.content) ? result.content[0] : null;
        errorText = first?.text || 'Tool execution failed';
      }
      send({
        type: 'tool_end',
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        result: isError ? undefined : result,
        error: errorText,
        sessionId,
      });
      return;
    }
    case 'message_end': {
      // v0.4 fix: 检查 message.stopReason === 'error' && message.errorMessage
      // Pi SDK Agent 把 streamSimple 的 error 写到 assistant message 的 errorMessage 字段
      // (不 emit 顶层 'error' event) — 我们在 message_end 时主动 emit 错误
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
    case 'error':
      // v0.4 fix: Pi SDK error event 结构是 { type, reason, error: AssistantMessage }
      // 错误信息在 event.error.errorMessage (不是 event.error.message)
      {
        const assistantMessage = event.error;  // AssistantMessage 对象 (含 errorMessage, stopReason, content)
        const errorMessage = assistantMessage?.errorMessage
          || event.reason
          || 'Unknown error from Pi SDK';
        send({ type: 'error', message: sanitizeErrBody(String(errorMessage)), sessionId });
      }
      return;
    default:
      // 未知事件 — log 后忽略 (避免污染协议)
      console.error(`[sidecar] unknown event type: ${event.type}`);
      return;
  }
}

/**
 * 跑一次 LLM 调用. Abort 旧的, 起新的 Agent, 订阅事件.
 * @param {any} config
 * @param {string} userContent
 * @param {string} sessionId
 */
async function runPrompt(config, userContent, sessionId) {
  // Abort 旧的 (如果有)
  if (currentAbortController) {
    currentAbortController.abort();
  }
  const ac = new AbortController();
  currentAbortController = ac;

  const models = buildModels(config);

  // 决定 provider id: 7 内置用 Pi SDK 工厂名, 自定义走 'user-custom'
  const providerId = config.baseUrl ? 'user-custom' : config.provider;
  const model = models.getModel(providerId, config.model);
  if (!model) {
    send({ type: 'config_error', message: `Model not found: ${providerId}/${config.model}`, sessionId });
    return;
  }

  // workspace system prompt (v0.3.8.11+)
  const systemPrompt = config.workspacePath
    ? `你是 Pi Agent, 你的工作目录 (workspace) 是: ${config.workspacePath}\n`
      + '当用户要求你读写文件时, 你应该按这个目录为根路径操作.'
    : '你是 Pi Agent.';

  const agent = new Agent({
    initialState: { systemPrompt, model, tools: buildTools(config.workspacePath) },
    streamFn: models.streamSimple.bind(models),
  });
  currentAgent = agent;

  let agentEndSent = false;
  const finishUp = () => {
    if (!agentEndSent) {
      send({ type: 'message_end', sessionId });
      send({ type: 'agent_end', sessionId });
      agentEndSent = true;
    }
  };

  // 订阅 Agent 事件 → 映射 IPC
  const unsubscribe = agent.subscribe((event) => {
    try {
      mapAgentEventToIPC(event, sessionId);
      if (event.type === 'agent_end' || event.type === 'error') {
        finishUp();
      }
    } catch (e) {
      console.error('[sidecar] event handler threw:', e);
    }
  });

  // v0.4 fix: 不手动 send agent_start / message_start — agent.subscribe 收到
  // 这些事件会自动 emit (带 role 字段), 避免重复

  try {
    // pi-agent-core Agent.prompt 不直接吃 AbortSignal — 走 ac.signal 通过 transport 注入
    // (v0.4 实测时若 Agent.prompt 不支持 signal, 用 race + ac.abort() 兜底)
    await agent.prompt(userContent);
  } catch (e) {
    console.error('[sidecar] agent.prompt threw:', e);
    if (!agentEndSent) {
      send({ type: 'error', message: sanitizeErrBody(e instanceof Error ? e.message : String(e)), sessionId });
      finishUp();
    }
  } finally {
    try { unsubscribe?.(); } catch {}
    if (currentAbortController === ac) currentAbortController = null;
    if (currentAgent === agent) currentAgent = null;
  }
}

/**
 * 用 pi-coding-agent 的 7 个 tool 工厂构造 Agent 的 tool 数组.
 * cwd 走 workspace path, tool 内部用 ExecutionEnv 抽象 (node 跑 fs).
 *
 * v0.4.1 phase 1 全部 7 个都注册, 不做 dangerous 拦截 (FE 端 v0.3.8.6+ 协议已支持 confirm UI).
 * 工作目录外的路径保护由各 tool 的 ExecutionEnv (默认) + Tauri 端 fs capability 共同承担.
 *
 * @param {string} workspacePath
 * @returns {import('@earendil-works/pi-agent-core').AgentTool[]}
 */
function buildTools(workspacePath) {
  const cwd = workspacePath || process.cwd();
  return [
    createReadTool(cwd),
    createWriteTool(cwd),
    createEditTool(cwd),
    createBashTool(cwd),
    createLsTool(cwd),
    createFindTool(cwd),
    createGrepTool(cwd),
  ];
}

// ===== IPC: stdin JSON Lines =====
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch (e) {
    send({ type: 'error', message: `IPC parse error: ${e instanceof Error ? e.message : String(e)}` });
    return;
  }
  try {
    switch (msg.type) {
      case 'config': {
        // validate 必填字段
        if (!msg.provider || !msg.model) {
          send({ type: 'config_error', message: 'Missing provider or model in config' });
          return;
        }
        if (msg.baseUrl && !msg.apiKey) {
          send({ type: 'config_error', message: 'baseUrl provided but apiKey missing' });
          return;
        }
        globalConfig = msg;
        send({ type: 'config_ok', provider: msg.provider, model: msg.model, sessionId: msg.sessionId });
        return;
      }
      case 'prompt': {
        if (!globalConfig) {
          send({ type: 'error', message: 'No config set — send { type: "config" } first' });
          return;
        }
        // 不 await — 协议是异步流, 事件通过 subscribe 持续发
        runPrompt(globalConfig, msg.content, msg.sessionId).catch((e) => {
          console.error('[sidecar] runPrompt unhandled:', e);
        });
        return;
      }
      case 'abort': {
        if (currentAbortController) {
          currentAbortController.abort();
          send({ type: 'agent_end', sessionId: msg.sessionId });
        }
        return;
      }
      default:
        send({ type: 'error', message: `Unknown IPC type: ${msg.type}` });
    }
  } catch (e) {
    send({ type: 'error', message: `IPC handler error: ${e instanceof Error ? e.message : String(e)}` });
  }
});

console.error('[sidecar] booted, listening on stdin (Pi Agent v0.4 — pi-ai + pi-agent-core)');
