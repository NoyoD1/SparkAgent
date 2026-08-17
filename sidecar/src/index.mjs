// Pi Agent Desktop — Sidecar (v0.5.0)
//
// v0.5.0 重大重构: 不再手写 stdin/stdout 协议、不再手写 5x retry / 30s hang / permission
// Extension / event mapping. 全部走 @earendil-works/pi-coding-agent 0.84.2 提供的
// runRpcMode() + createAgentSessionRuntime() 轮子.
//
// 协议 (stdin/stdout 都是 strict LF-only JSONL):
//   - 第 1 行 (one-shot config): 初始化 runtime (workspacePath / provider / model /
//     apiKey / baseUrl / sessionId / thinkingLevel / tools / permissionMode)
//   - 第 2 行起: Pi SDK RpcCommand 协议 (prompt/steer/follow_up/abort/set_model/
//     cycle_model/set_thinking_level/compact/fork/clone/switch_session/get_state/
//     get_messages/...) — 40+ 类型, 完整 list 见 @earendil-works/pi-coding-agent/modes/rpc/rpc-types
//   - stdout: Pi SDK RpcResponse + RpcEvent (AgentSessionEvent 全套) + extension_ui_request
//     (permission 弹窗走这条)
//
// 跟之前 v0.4.2 step 1 相比:
//   - 836 行 → ~180 行 (-78%)
//   - 不再手写 40+ case event 映射
//   - 不再手写 5x retry (Pi SDK AgentSession 内置 auto_retry_*)
//   - 不再手写 30s hang watch (Pi SDK AgentSession 内置)
//   - 不再手写 permission Extension (Pi SDK 内置 extension UI, 走 RPC 协议)
//   - 不再手写 backpressure (Pi SDK output-guard takeOverStdout)
//   - 不再手写 strict JSONL (Pi SDK attachJsonlLineReader)
//
// Tauri 端 (sidecar.rs) 改动:
//   - 之前: 写 config + prompt 2 行, 写 permission_response / set_permission_mode /
//     compact_session 3 个 stdin 命令
//   - 现在: 写 config 1 行, 后续 RpcCommand 走 passthrough (Tauri 不用解析)

import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  DefaultResourceLoader,
  getAgentDir,
  runRpcMode,
  SessionManager,
} from '@earendil-works/pi-coding-agent';
import { createProvider } from '@earendil-works/pi-ai';
import {
  stream as openaiCompletionsStream,
  streamSimple as openaiCompletionsStreamSimple,
} from '@earendil-works/pi-ai/api/openai-completions';

// ====== 0. 读 config from process.argv[2] ======
// v0.5.0 fix: 之前用 raw stdin 读 line 1 (config) + 后续 stdin 走 RpcCommand 模式, 但:
//   - readline 模式: rl.close() 触发 stdin 'end' → runRpcMode.onInputEnd → 立即 shutdown
//   - raw on('data') 模式: flowing → paused → flowing 多次 mode switch, Windows + Node pipe
//     在 runRpcMode 接管时容易丢 line 2+ data 事件, 沉默 30s 没任何 output
//   - paused on('readable') + unshift() 模式: 也是 unshift 后让 runRpcMode 接管, 但 runRpcMode
//     内部 attachJsonlLineReader 注册 on('data') 时 stream 状态可能异常, 同样收不到 data
// **改用 process.argv[2] 传 config JSON** — 跟 Pi SDK main.ts 的 pattern 一致, 完全绕开
//   stdin pipe mode switch 问题. stdin 100% 归 runRpcMode 接管, 接 line 1 = RpcCommand.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const configArg = process.argv[2];
if (!configArg) {
  console.error('[sidecar] no config arg in process.argv[2], exiting');
  process.exit(1);
}
const config = JSON.parse(configArg);

if (config.type !== 'config') {
  console.error(`[sidecar] first stdin line must be {type: "config"}, got ${config.type}`);
  process.exit(1);
}

console.error(`[sidecar] config: provider=${config.provider} model=${config.model} workspace=${config.workspacePath ?? process.cwd()} sessionId=${config.sessionId?.slice(0, 16) ?? 'new'} baseUrl=${config.baseUrl ? 'set' : 'none'} tools=${(config.tools ?? []).join(',') || 'default'}`);

// ====== 1. workspace + session 隔离 ======
const workspacePath = config.workspacePath || process.cwd();
const sessionId = config.sessionId || `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// per-workspace 隔离: workspace 路径 → sha256 前 16 位 → 目录
//   <agentDir>/sessions/<hash>/<timestamp>_<sessionId>.jsonl
const agentDir = getAgentDir();
const hash = createHash('sha256').update(workspacePath).digest('hex').slice(0, 16);
const sessionDir = join(agentDir, 'sessions', hash);

// Pi SDK 0.84.2 SessionManager.create(cwd, sessionDir, {id}) 每次用新 timestamp 创 file,
// 不支持用 id resume. 走跟 v0.4.2 step 1 一样 setSessionFile() 走 load 模式.
let sessionManager = SessionManager.create(workspacePath, sessionDir, { id: sessionId });
if (existsSync(sessionDir)) {
  const files = readdirSync(sessionDir).filter((f) => f.endsWith('.jsonl'));
  const matchSuffix = `_${sessionId}.jsonl`;
  const matched = files.find((f) => f.endsWith(matchSuffix));
  if (matched) {
    console.error(`[sidecar] resume existing session file: ${matched}`);
    sessionManager.setSessionFile(join(sessionDir, matched));
  } else {
    console.error(`[sidecar] new session, file will be at ${sessionManager.getSessionFile()}`);
  }
}

// ====== 2. user-custom provider (FE 用 baseUrl 走 OpenAI-compatible 时) ======
let userCustomProvider = null;
if (config.baseUrl) {
  // v0.4.2.x fix 保留: resolver 接 credential 参数 (Pi SDK 0.84.2 resolveProviderAuth 会
  // 调 apiKey.resolve({ ctx, credential, signal })), 优先用 credential?.key (来自
  // RuntimeCredentials override = setRuntimeApiKey 写的真 key), 退到 config.apiKey (closure 初始).
  const initialApiKey = config.apiKey || '';
  userCustomProvider = createProvider({
    id: 'user-custom',
    name: config.providerLabel || 'Custom',
    baseUrl: config.baseUrl,
    auth: {
      apiKey: {
        name: 'Custom OpenAI-compatible API key',
        resolve: async ({ credential }) => {
          const apiKey = credential?.key || initialApiKey;
          return { auth: { apiKey }, source: 'sidecar config' };
        },
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
  });
}

// ====== 3. createAgentSessionRuntime factory ======
// 跟 Pi SDK main.ts 的 createRuntime 一样, 走完整 services + modelRuntime + sessionManager 流程.
// 我们的 factory 注入 user-custom provider + setRuntimeApiKey + permission extension.
const createRuntime = async ({
  cwd,
  agentDir: dir,
  sessionManager: sm,
}) => {
  // v0.5.5 hotfix: 修 DeepSeek V4 Flash model 在 user 问 "我们之前聊过什么" 这种 meta 问题时
  //   主动 assume "this is a new conversation session, no prior history" 的幻觉 bug.
  //
  // 背景 (D168 调查):
  //   - v0.5.4 hotfix 修了 sync 链: 每次 spawn node 进程后, 把 sessionManager.loadEntries 灌
  //     进 agent.state.messages. LLM 实际收到 5538 tokens (cacheRead=5120), 包含完整 history.
  //   - 但 AI 在 user 问 "我们之前聊过什么" 时, 自己 assume "this is a new conversation
  //     session", 答 "这是第一次对话". session file id=1953e8d7 thinking 字段:
  //     "The user keeps asking the same question... I need to clarify that this is a new
  //     conversation session and there is no prior chat history."
  //   - 同一 session 里, AI 在 #4 答了 "工作区目前的状态和之前一样, 没有变化" — AI 知道
  //     有之前对话 (隐含记忆), 但被 meta-history 问题的训练先验劫持.
  //
  // 修法 (Pi SDK 0.84.2 DefaultResourceLoader 接受 appendSystemPromptOverride):
  //   - 在 system prompt 追加 <context_awareness> 段, 强制 LLM:
  //     1) 明确知道它有完整 conversation history
  //     2) 当 user 问 "我们之前聊过什么" / "what did we discuss" 这种 meta-history 问题时,
  //        必须从 history 里找答案, 不能默认 assume "新 session"
  //   - 这段是 model behavior 修正, 不影响 sync 链 / session persistence / tool flow.
  //
  // 跨项目通用: 任何接 DeepSeek V4 Flash / V3 / R1 这种带强 "stateless assistant" 训练先验的
  //   model, 都建议加 <context_awareness> 段避免 meta-history 幻觉.
  const CONTEXT_AWARENESS_INSTRUCTION = `<context_awareness>
You have full access to the complete conversation history in this session. Every prior user message,
your previous responses, and all tool calls/results are visible to you in the messages list above.

When the user asks meta-history questions like "我们之前聊过什么", "what did we discuss", "what did
you do earlier", "上次你做了什么", or refers to prior turns, ground your answer in the actual
messages above. Read the conversation history and answer based on what actually happened.

Do NOT default to "this is a new conversation session with no prior history" unless the conversation
history is genuinely empty. Even if a previous turn was a 429 retry or empty response, the user's
intent across the session is still part of the conversation.
</context_awareness>`;

  const services = await createAgentSessionServices({
    cwd,
    agentDir: dir,
    modelRuntimeSignal: AbortSignal.timeout(15_000),
    // v0.5.0 fix: 传 InlineExtension extensionFactories, 让 Pi SDK 在 on('tool_call') 时
    //   弹 confirm 弹窗 (跟 v0.4.x sidecar 自写 Extension 行为一致).
    //   之前 v0.5.0 我们没传, 导致 no handlers → beforeToolCall 永远 return undefined →
    //   tool call 直接放行, 即使 permission mode = 'ask' 也不弹窗.
    //   配合 runRpcMode 内部 ExtensionUIContext, handler 调 ctx.ui.confirm() 会
    //   emit extension_ui_request → FE 弹窗 → user 选 → extension_ui_response →
    //   handler 据此 return { block: true } (拒绝) 或 undefined (放行).
    //   mode = 'allow' 时不传 extensionFactories, 走 Pi SDK 默认 (tool 直接放行, 不弹窗).
    // v0.5.5: 同时传 appendSystemPromptOverride, 修 model behavior meta-history 幻觉.
    resourceLoaderOptions: {
      // permissionMode === 'allow' 时不传 InlineExtension (Pi SDK 默认 tool 放行),
      //   但 appendSystemPromptOverride 仍要传 (Context awareness 是 model behavior 修正,
      //   跟 permission 无关).
      extensionFactories: config.permissionMode === 'allow'
        ? []
        : [createPermissionExtension(config.permissionMode)],
      appendSystemPromptOverride: (base) => [...base, CONTEXT_AWARENESS_INSTRUCTION],
    },
  });

  const providerId = config.baseUrl ? 'user-custom' : config.provider;

  // 1) 写真 key 到 ModelRuntime (走 RuntimeCredentials override, 不写文件)
  if (config.apiKey) {
    try {
      await services.modelRuntime.setRuntimeApiKey(providerId, config.apiKey);
      console.error(`[sidecar] setRuntimeApiKey ok: ${providerId} key_len=${config.apiKey.length}`);
    } catch (e) {
      console.error(`[sidecar] setRuntimeApiKey failed:`, e instanceof Error ? e.message : String(e));
    }
  }

  // 2) 注册 user-custom provider (modelRuntime 不知道 user-custom, 走 registerNativeProvider)
  if (userCustomProvider) {
    try {
      services.modelRuntime.registerNativeProvider(userCustomProvider);
      await services.modelRuntime.refresh({ allowNetwork: false });
      console.error(`[sidecar] user-custom provider registered, hasConfiguredAuth=${services.modelRuntime.hasConfiguredAuth('user-custom')}`);
    } catch (e) {
      console.error(`[sidecar] registerNativeProvider failed:`, e instanceof Error ? e.message : String(e));
    }
  }

  // 3) 选 model. 优先用 resolveModelScope 走标准 pipeline, 失败 fallback 到 modelRuntime.getModel.
  let model;
  try {
    const scoped = await services.modelRuntime.getAvailable();
    model = scoped.find((m) => m.provider === providerId && m.id === config.model);
  } catch (e) {
    console.error(`[sidecar] getAvailable failed:`, e instanceof Error ? e.message : String(e));
  }
  if (!model) {
    model = services.modelRuntime.getModel(providerId, config.model);
  }
  if (!model) {
    throw new Error(`Model not found: ${providerId}/${config.model}`);
  }

  // 4) tools: 7 内置 (read/bash/edit/write/grep/find/ls), 跟 v0.4.2 step 1 一致
  const tools = config.tools ?? ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'];

  console.error(`[sidecar] creating agent session: model=${model.provider}/${model.id} thinking=${config.thinkingLevel ?? 'medium'} tools=${tools.join(',')} permissionMode=${config.permissionMode ?? 'ask'}`);

  return createAgentSessionFromServices({
    services,
    sessionManager: sm,
    model,
    thinkingLevel: config.thinkingLevel,
    tools,
  });
};

/**
 * v0.5.0 权限 extension: 把 v0.4.x 自写的 beforeToolCall hook 走 InlineExtension
 *   on('tool_call') 重新实现, 跟 Pi SDK 0.84.2 的 runRpcMode 配对.
 *
 * 工作流:
 *   1. tool call 之前 Pi SDK 调 extension 全部 on('tool_call') handler
 *   2. handler 调 ctx.ui.confirm(title, message) — runRpcMode 内部把 confirm 翻译成
 *      extension_ui_request RPC event emit 给 FE
 *   3. FE 弹窗 → user 选 → FE 写 extension_ui_response RpcCommand 到 sidecar stdin
 *   4. runRpcMode 路由回 pendingExtensionRequests.get(id) → resolve → handler 拿到 boolean
 *   5. handler 据此 return { block: true, reason } (拒绝) 或 undefined (放行)
 *   6. Pi SDK 继续或终止 tool call
 *
 * 跟 v0.4.x 区别: v0.4.x 是我们 sidecar 直接 emit permission_request 跟 FE 通信.
 *   v0.5.0 走 Pi SDK 标准 extension_ui_request 协议, 跟 Pi 生态兼容.
 */
function createPermissionExtension(permissionMode) {
  return (pi) => {
    pi.on('tool_call', async (event, ctx) => {
      // event.toolName, event.toolCallId, event.input
      const toolName = event.toolName;
      const toolArgs = event.input || {};
      const argsPreview = JSON.stringify(toolArgs).slice(0, 200);

      if (permissionMode === 'deny') {
        console.error(`[perm] deny ${toolName} (mode=deny)`);
        return { block: true, reason: 'Tool use denied (permission mode=deny)' };
      }

      if (permissionMode === 'allow') {
        // 理论上不会到这里 (mode=allow 不传 extensionFactories), 兜底
        console.error(`[perm] allow ${toolName} (mode=allow fallback)`);
        return undefined;
      }

      // mode = 'ask' (默认): 弹 confirm 弹窗
      console.error(`[perm] ask ${toolName} args=${argsPreview}`);
      try {
        const allowed = await ctx.ui.confirm(
          `Allow tool: ${toolName}`,
          JSON.stringify(toolArgs, null, 2),
        );
        if (allowed) {
          console.error(`[perm] user allowed ${toolName}`);
          return undefined;
        } else {
          console.error(`[perm] user denied ${toolName}`);
          return { block: true, reason: 'User denied permission' };
        }
      } catch (e) {
        // confirm 抛错 (e.g. RPC stream closed, FE disconnected) — 默认 block
        console.error(`[perm] confirm failed for ${toolName}:`, e instanceof Error ? e.message : String(e));
        return { block: true, reason: `Permission prompt failed: ${e instanceof Error ? e.message : String(e)}` };
      }
    });
  };
}

// ====== 4. 创 runtime ======
const runtime = await createAgentSessionRuntime(createRuntime, {
  cwd: workspacePath,
  agentDir,
  sessionManager,
});

console.error(`[sidecar] runtime ready, model=${runtime.session.model?.provider}/${runtime.session.model?.id}`);

// ====== v0.5.4 hotfix: sync sessionManager history → agent.state.messages ======
// 背景: Pi SDK 0.84.2 createAgentSessionFromServices 不会自动把 sessionManager.loadEntries
//   加载的 history 同步到 agent.state.messages. Pi SDK 只在 switchSession / newSession 流程
//   (agent-session-runtime.ts:256) 才同步. 我们的 sidecar 每次 send_prompt 都新 spawn node
//   进程, 新 Agent 实例 state.messages 默认只有 [system], 即使 setSessionFile 已经 load 了
//   session file, agent 看不到 history → 答"第一次对话" bug.
// 修法: sidecar 启动 runtime 后, 手动调 buildSessionContext() 把 sessionManager 的 entries
//   灌进 agent.state.messages. 这一行解决了单 session 上下文丢失 bug.
// 同 Pi SDK compaction 流程 (agent-session.ts:1880-1881) 一样的 sync, 只不过我们每次启动都做.
const initialMessages = runtime.session.sessionManager.buildSessionContext().messages;
runtime.session.agent.state.messages = initialMessages;
console.error(`[sidecar] synced ${initialMessages.length} messages from session to agent state`);

// ====== 5. (无 readline 要关) ======
// v0.5.0 fix: 不需要 rl.close() — 我们用 raw process.stdin 读了 line 1, 没用 readline.
//   runRpcMode 用 attachJsonlLineReader 从 line 2 开始接管 stdin.

// ====== 6. 启动 RPC mode ======
// runRpcMode 接管 stdin (attachJsonlLineReader 严格 LF-only JSONL) + stdout (takeOverStdout
// backpressure). 后续 RpcCommand 走 stdin, RpcResponse + RpcEvent + extension_ui_request
// 走 stdout. 我们不再 parse 任何 events.
//
// 包含但不限:
//   - prompt / steer / follow_up / abort / new_session
//   - set_model / cycle_model / set_thinking_level / set_steering_mode
//   - compact / set_auto_compaction / set_auto_retry
//   - fork / clone / switch_session / get_messages / get_tree / get_state
//   - extension_ui_response (permission 弹窗响应走这个)
//
// 5x retry / 30s hang watch / auto_compaction / backpressure 都 Pi SDK 内置.
// runRpcMode 返回 Promise<never> (永远不 resolve), 用 IIFE 避免 Node v22 top-level await
// 警告让进程退出.

(async () => {
  try {
    await runRpcMode(runtime);
  } catch (e) {
    console.error('[sidecar] runRpcMode failed:', e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
})();
