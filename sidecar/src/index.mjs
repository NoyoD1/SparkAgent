// Sidecar entrypoint — wires stdin/stdout JSON Lines to the Pi Agent runtime.
//
// v0.4 重写: 不再 import ./openai-compatible.mjs (v0.3 手写 fetch 实现),
// 改为在 index.mjs 直接集成 @earendil-works/pi-ai + @earendil-works/pi-agent-core.
//
// v0.4.1+ 加 tool permission confirm:
//   - 初始 mode 走 config.permissionMode (FE 端每次 send config 时带上, 默认 'ask')
//   - 运行时 mode 可改 (FE 发 set_permission_mode)
//   - 每次 mutating tool 走 beforeToolCall hook → emit permission_request → 等 FE permission_response
//   - ask 模式每个 tool 都 confirm, smart 模式读类 (read/ls/find/grep) 自动放行, allow 模式全部放行
//
// IPC: stdin/stdout JSON lines.
//   - input:  { type: 'config', provider, model, baseUrl?, apiKey, thinkingLevel?, workspacePath?, permissionMode? }
//             { type: 'prompt', sessionId, content }
//             { type: 'abort' }
//             { type: 'permission_response', toolCallId, allow, reason? }    // v0.4.1+
//             { type: 'set_permission_mode', mode }                          // v0.4.1+
//   - output: { type: 'config_ok' | 'config_error' | 'agent_start' | 'message_start'
//             | 'message_update' | 'tool_start' | 'tool_update' | 'tool_end'
//             | 'message_end' | 'agent_end' | 'error'
//             | 'permission_request' }                                     // v0.4.1+
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

// v0.4.1+ 测试用: PI_FAUX=1 环境变量时, 额外注册 faux provider (smoke test 用).
// 跟 7 内置 + user-custom 互不影响. 不设 PI_FAUX 时不 import 不 register, 0 副作用.
if (process.env.PI_FAUX === '1') {
  // fauxProvider 在 @earendil-works/pi-ai 主包导出 (不在 subpath providers/)
  const { fauxProvider, fauxText, fauxThinking, fauxToolCall, fauxAssistantMessage } = await import('@earendil-works/pi-ai');
  // 存到 global, buildModels 时按需 register
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
  // v0.4.1+ PI_FAUX_RESPONSES env: JSON 数组, 每个元素是 { thinking?, text?, toolCall? } 对象
  // smoke test 通过 env 注入预设 response, 避免依赖 stdin 时序
  if (process.env.PI_FAUX_RESPONSES) {
    try {
      const responsesJson = JSON.parse(process.env.PI_FAUX_RESPONSES);
      const responses = responsesJson.map((r) => () => fauxAssistantMessage([
        ...(r.thinking ? [fauxThinking(r.thinking)] : []),
        ...(r.text ? [fauxText(r.text)] : []),
        ...(r.toolCall ? [fauxToolCall(r.toolCall.name, r.toolCall.args, { id: r.toolCall.id })] : []),
      ]));
      // v0.4.1.4+ PI_FAUX_HANG=1: 让最后一个 response 永远 pending (模拟商汤 stream hang, 不 emit done)
      // 验证 sidecar 30s watchdog 兜底.
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

/** @type {string | null} 当前 runPrompt 的 sessionId, beforeToolCall hook emit permission_request 时带 */
let currentSessionId = null;

/** v0.4.1.4+ module-level 暴露 finishUp 给 watchdog (runPrompt 内的 closure 没法被 setInterval 访问) */
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
      // 先 abort, 让 Pi SDK stream 走 error 路径 emit message_end
      if (currentAbortController) {
        currentAbortController.abort();
      }
      // 兜底: 1s 后如果 Pi SDK 没响应 abort, sidecar 自己 emit finishUp
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
 *  beforeToolCall hook 把 resolve 存这里, 等 FE permission_response 来了再 resolve.
 * @type {Map<string, { resolve: any }>}
 */
const pendingPermissionRequests = new Map();

/** smart 模式自动放行的读类工具 (看东西, 不改东西) */
const SMART_READ_ONLY_TOOLS = new Set(['read', 'ls', 'find', 'grep']);

function send(event) {
  // v0.4.1+ fix: Node.js 在 pipe (stdio: 'pipe') 模式下, process.stdout.write 默认
  // 异步 flush + 内部 highWaterMark buffer. 当 tool.execute() 之后并发 emit 多个
  // event (e.g. tool_execution_end → toolResult message → turn_end → turn_start
  // → message_start) 可能在同一个 microtask 内串行 write, 但 Node.js 内部会把
  // 部分 write 合并到下一个 chunk, 导致 readline 收不到完整 line 报 timeout.
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

  // v0.4.1+ 测试用: PI_FAUX=1 时 register faux (sidecar 启动时存到 globalThis.__piFauxProvider)
  if (globalThis.__piFauxProvider) {
    const fauxProviderObj = globalThis.__piFauxProvider;
    if (process.env.PI_FAUX === '1') {
      console.error(`[sidecar] PI_FAUX: fauxProviderObj.provider.id=${fauxProviderObj.provider.id} models count=${fauxProviderObj.provider.getModels().length}`);
    }
    models.setProvider(fauxProviderObj.provider);
    if (process.env.PI_FAUX === '1') {
      const fauxModels = models.getModels('faux');
      console.error(`[sidecar] PI_FAUX: after setProvider, faux models=${JSON.stringify(fauxModels.map((m) => m.id))}`);
    }
  }

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
        cost: {                          // v0.4.1.2 fix: 必须带 cost (ModelCost 必填, 没值就 0 模板), 否则 calculateCost() line 882 读 model.cost.tiers 抛 "Cannot read properties of undefined (reading 'tiers')"
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
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
 *     - 'turn_start'                     -> { type: 'turn_start' }  (v0.4.1 step 边界, FE 用来切 step group)
 *     - 'turn_end'                       -> { type: 'turn_end' }    (同上)
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
      // v0.4.1 (step 累加): Pi SDK 一次 prompt 可能跑多个 turn (tool_call 链), 每个 turn = 1 step
      // 透传给 FE, FE 用 turn_start/turn_end 标 step 边界
      send({ type: 'turn_start', sessionId });
      return;
    case 'turn_end':
      send({ type: 'turn_end', sessionId });
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
      console.error(`[sidecar] mapAgentEventToIPC: tool_start ${event.toolName} ${event.toolCallId}`);
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
      console.error(`[sidecar] mapAgentEventToIPC: tool_execution_end ${event.toolName} ${event.toolCallId} isError=${event.isError}`);
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
      try {
        const toolEndEvent = {
          type: 'tool_end',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          result: isError ? undefined : result,
          error: errorText,
          sessionId,
        };
        console.error(`[sidecar:dbg] about to send tool_end, isError=${isError}, event keys=${Object.keys(toolEndEvent).join(',')}`);
        send(toolEndEvent);
        console.error('[sidecar:dbg] sent tool_end OK');
      } catch (e) {
        console.error('[sidecar] SEND tool_end threw:', e);
      }
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
    // v0.4.1+ tool permission: beforeToolCall hook 走 Pi SDK 官方接口.
    // 返回 undefined = 允许执行; 返回 { block: true, reason } = 阻止 (Pi SDK emit error tool result)
    beforeToolCall: async (ctx, signal) => {
      const toolName = ctx.toolCall.name;
      const toolCallId = ctx.toolCall.id;
      const mode = currentPermissionMode;

      // allow 模式 → 全部放行
      if (mode === 'allow') {
        return undefined;
      }
      // smart 模式 + 读类工具 → 自动放行 (read/ls/find/grep 不改东西, 安全)
      if (mode === 'smart' && SMART_READ_ONLY_TOOLS.has(toolName)) {
        return undefined;
      }
      // ask 模式 / smart 模式的写类工具 → 走 confirm 流程
      // emit permission_request 给 FE, 等 FE 响应 permission_response
      // (v0.4.1+ 协议, FE 端 chat store + PermissionDialog.vue 处理)
      console.error(`[sidecar] permission_request: tool=${toolName} id=${toolCallId} mode=${mode} args=${JSON.stringify(ctx.args).slice(0, 200)}`);

      return new Promise((resolve) => {
        // abort 时直接拒绝 (避免 hang 死)
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
          args: ctx.args,
          sessionId,
        });
      });
    },
  });
  currentAgent = agent;
  currentSessionId = sessionId;  // beforeToolCall closure 用

  let agentEndSent = false;
  const finishUp = () => {
    if (!agentEndSent) {
      send({ type: 'message_end', sessionId });
      send({ type: 'agent_end', sessionId });
      agentEndSent = true;
    }
  };
  // v0.4.1.4+ stream hang watchdog: 把 finishUp 暴露给 module-level watchdog 用
  // (sidecar 30s 没新 stream event 时强制 finishUp, 防商汤 stream 不 emit done)
  currentFinishUp = finishUp;
  // 启动 stream hang watchdog (30s 没新 event 强制 finishUp, 防商汤 stream 不 emit done)
  startHangWatchdog();

  // 订阅 Agent 事件 → 映射 IPC
  const unsubscribe = agent.subscribe((event) => {
    try {
      resetHangWatchdog();  // v0.4.1.4+ 任何 event 都 reset watchdog
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
    // v0.4.1.4+ 停 watchdog, 清理 currentFinishUp 避免下一次 runPrompt 误用
    stopHangWatchdog();
    currentFinishUp = null;
    if (currentAbortController === ac) currentAbortController = null;
    if (currentAgent === agent) currentAgent = null;
    if (currentSessionId === sessionId) currentSessionId = null;
    // v0.4.1+ abort 时清掉所有 pending permission request, 避免 FE 弹窗卡死等永远不来的 response
    for (const [toolCallId, { resolve }] of pendingPermissionRequests) {
      resolve({ block: true, reason: 'Aborted' });
    }
    pendingPermissionRequests.clear();
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
    // v0.4.1+ 健壮性: 去掉 UTF-8 BOM 头 (PowerShell echo 会注入). Tauri 实际 pipe 不带 BOM, 但本地测试 / 调试会.
    msg = JSON.parse(line.replace(/^\uFEFF/, ''));
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
        // v0.4.1+ 把 config.permissionMode 同步到运行时, 走默认值 'ask'
        if (msg.permissionMode === 'ask' || msg.permissionMode === 'smart' || msg.permissionMode === 'allow') {
          currentPermissionMode = msg.permissionMode;
        } else {
          currentPermissionMode = 'ask';
        }
        console.error(`[sidecar] config received: provider=${msg.provider} model=${msg.model} permissionMode=${currentPermissionMode}`);
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
      case 'permission_response': {
        // v0.4.1+ FE 端 PermissionDialog 点了 允许/拒绝, 走 toolCallId 配对
        // - allow=true  → resolve(undefined) (Pi SDK 继续执行)
        // - allow=false → resolve({ block: true, reason }) (Pi SDK 走 error tool result)
        const pending = pendingPermissionRequests.get(msg.toolCallId);
        if (!pending) {
          // 可能 race: abort 后才到; 静默忽略
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
        // v0.4.1+ FE 端用户从 Composer 切换了 permission mode
        if (msg.mode === 'ask' || msg.mode === 'smart' || msg.mode === 'allow') {
          currentPermissionMode = msg.mode;
          console.error(`[sidecar] permission mode updated: ${currentPermissionMode}`);
        } else {
          console.warn(`[sidecar] set_permission_mode invalid: ${msg.mode}`);
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
