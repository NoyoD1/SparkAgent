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
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

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
// v0.5.0 之前用 `import.meta.url` + `fileURLToPath` 算 __filename/__dirname, 但:
//   - bun build --compile 出的 standalone .exe 里 import.meta.dir / __dirname 是开发机绝对路径
//     (D144 / D163 跨项目规则), 拷到别机器找不到 sibling files → sidecar 直接 fail
//   - v0.5.0 改造后, sidecar 不依赖 sibling files (config 走 argv[2], workspace 走 cwd or
//     config.workspacePath, agentDir 走 getAgentDir() 用 USERPROFILE / HOME)
//   - 所以 __filename / __dirname 是 dead code, bun compile 时不会嵌入路径, 删了避免误导
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

// ====== v0.4.4 Skills (Pi SDK 暴露) ======
// Pi SDK 0.84.2 loadSkills({cwd, agentDir, skillPaths, includeDefaults}) 自动扫
//   - {agentDir}/skills/ (user global)
//   - {cwd}/.pi/skills/ (project local)
//   - skillPaths 额外路径
// 我们 includeDefaults: true, skillPaths 从 config 透传 (FE 后续可加, 现在默认 []).
// FE 维护 enabledSkillNames, send_prompt 时一起传 config, sidecar 据此 format
// + 注入 system prompt (Pi SDK 0.84.2 D165 systemPrompt 不可动态改, 必须重启).
// enabled 改变 → FE restart sidecar (新 config 传新 enabledSkillNames).
// list_skills 不走 RpcCommand (Pi SDK 没内置), 走 sidecar 启动时 stdout 一次性
// emit {type:'skills_snapshot', skills:[...]} (类似 v0.4.x config_ok, runRpcMode
// 接管 stdout 之前), FE 同步解析存 skills store.
import { loadSkills, formatSkillsForPrompt } from '@earendil-works/pi-coding-agent';
// v0.4.5: Pi SDK 0.84.2 BUILTIN_SLASH_COMMANDS 不在主入口 export, 走 subpath 不稳
//   (package.json 没声明 ./core/* exports). 复制 21 个常量过来, 跟 Pi SDK 0.84.2 一致.
//   源: pi-sdk/packages/coding-agent/src/core/slash-commands.ts
const BUILTIN_SLASH_COMMANDS = [
  { name: 'settings', description: 'Open settings menu' },
  { name: 'model', description: 'Select model (opens selector UI)', argumentHint: '<provider/model>' },
  { name: 'scoped-models', description: 'Enable/disable models for Ctrl+P cycling' },
  { name: 'export', description: 'Export session (HTML default, or specify path: .html/.jsonl)' },
  { name: 'import', description: 'Import and resume a session from a JSONL file' },
  { name: 'share', description: 'Share session as a secret GitHub gist' },
  { name: 'copy', description: 'Copy last agent message to clipboard' },
  { name: 'name', description: 'Set session display name' },
  { name: 'session', description: 'Show session info and stats' },
  { name: 'changelog', description: 'Show changelog entries' },
  { name: 'hotkeys', description: 'Show all keyboard shortcuts' },
  { name: 'fork', description: 'Create a new fork from a previous user message' },
  { name: 'clone', description: 'Duplicate the current session at the current position' },
  { name: 'tree', description: 'Navigate session tree (switch branches)' },
  { name: 'trust', description: 'Save project trust decision for future sessions' },
  { name: 'login', description: 'Configure provider authentication', argumentHint: '<provider>' },
  { name: 'logout', description: 'Remove provider authentication' },
  { name: 'new', description: 'Start a new session' },
  { name: 'compact', description: 'Manually compact the session context' },
  { name: 'resume', description: 'Resume a different session' },
  { name: 'reload', description: 'Reload keybindings, extensions, skills, prompts, themes, and context files' },
  { name: 'quit', description: 'Quit Pi Agent' },
];
const skillsConfig = config.skills ?? { enabledNames: [], extraPaths: [] };
const skillsResult = loadSkills({
  cwd: workspacePath,
  agentDir,
  skillPaths: skillsConfig.extraPaths ?? [],
  includeDefaults: true,
});
const allSkills = skillsResult.skills;
const skillsDiagnostics = skillsResult.diagnostics;
const enabledSkillNames = new Set(skillsConfig.enabledNames ?? []);
const enabledSkills = allSkills.filter((s) => enabledSkillNames.has(s.name));
const skillsPromptFragment = enabledSkills.length > 0
  ? '\n\n' + formatSkillsForPrompt(enabledSkills)
  : '';
console.error(`[sidecar] skills: loaded ${allSkills.length} total, ${enabledSkills.length} enabled, ${skillsDiagnostics.length} diagnostics`);

// v0.5.0-v0.1: 删 multi-agent persona 段 (回滚 v0.4.6.1 + v0.4.6.2 + v0.5.0-PR1)
//   user 16:24 拍板: agent 是边界定义/思维指导, 永远是 1 个通用 agent, single agent 链路
//   Pi SDK 0.84.2 DefaultResourceLoader 自动 load <agentDir>/AGENTS.md + <cwd>/AGENTS.md
//   (resource-loader.ts:71) → 注入 system prompt 段. AGENTS.md 编辑走 Settings → Custom Instructions tab.
//   sidecar 不用拼 persona 段, 也不需要 active_agent 字段.
// v0.5.0-v0.1: 3 段 system prompt 显式 log (Base / Skills / Context Awareness) + Project context
//  Pi SDK auto-load. 让 user 装 .msi 跑端到端能从 sidecar stderr 看拼装.
console.error(`[sidecar] system prompt: 4 segments [base=Pi-SDK-default skills=${enabledSkills.length}(${skillsPromptFragment.length} chars) project_context=AGENTS.md-auto(Pi-SDK) context_awareness=set]`);
if (skillsDiagnostics.length > 0) {
  for (const d of skillsDiagnostics.slice(0, 5)) {
    console.error(`[sidecar] skills diag: ${d.type} ${d.message} ${d.path ?? ''}`);
  }
}
// v0.4.4: sidecar 启动时 emit skills_snapshot (走 stdout 一次性, 跟 RpcEvent 区分)
//   FE 收后存 skills store (list + name + description + baseDir + disableModelInvocation).
//   Tauri 端 sidecar.rs spawn 后, stdout 第一行非 RpcEvent (v0.5.0 RpcResponse 有 type:'response'),
//   这里走 type:'skills_snapshot' 区分.
//   ⚠️ 必须 runRpcMode() 之前 emit, 一旦 runRpcMode 接管 stdout 走 takeOverStdout 后, 我们写
//   process.stdout.write 会被 buffer / 拦截. 实际 runRpcMode 接管前 stdout 已被我们占用,
//   emit 写一行 JSON 即可, 后续 runRpcMode 接管时这一行已经 flush.
process.stdout.write(JSON.stringify({
  type: 'skills_snapshot',
  skills: allSkills.map((s) => ({
    name: s.name,
    description: s.description,
    filePath: s.filePath,
    baseDir: s.baseDir,
    disableModelInvocation: s.disableModelInvocation,
  })),
  diagnostics: skillsDiagnostics,
}) + '\n');

// ====== v0.4.5: slash_snapshot (Pi SDK BUILTIN_SLASH_COMMANDS 21 个 + 自定义 command 路径) ======
// 跟 skills_snapshot 同 pattern: sidecar 启动时 emit 一次性 snapshot, FE 同步存 slash store.
// source: 'builtin' (21 个 Pi SDK 内置) / 'custom' (.pi/commands/*.md 后续 v0.4.5c 加)
// 实际触发: 走 RpcCommand 'slash' (v0.4.5d), Pi SDK _tryExecuteExtensionCommand
//   只支持 extension command, 所以 BUILTIN_SLASH_COMMANDS 走 Pi CLI 内部, 标 "不支持 RPC 触发"
import { join as pathJoin } from 'node:path';
const builtinSlashCommands = BUILTIN_SLASH_COMMANDS.map((cmd) => ({
  name: cmd.name,
  description: cmd.description,
  argumentHint: cmd.argumentHint ?? null,
  source: 'builtin',  // 标记不能 RPC 触发, UI 灰显
}));

// v0.4.5.2: 扫描 <workspace>/.pi/commands/*.md 作为 user 自定义快捷提示词模板
//   (D184 v9 ❷ user 14:30 原话: "Slash tab是单独用于给用户自定义快捷提示词模板的,
//   不是用来显示builtin的")
const customCommands = [];
try {
  const commandsDir = pathJoin(workspacePath, '.pi', 'commands');
  if (existsSync(commandsDir)) {
    for (const file of readdirSync(commandsDir)) {
      if (!file.endsWith('.md')) continue;
      const name = file.slice(0, -3);
      const filePath = pathJoin(commandsDir, file);
      let content = '';
      try { content = readFileSync(filePath, 'utf-8'); } catch { continue; }
      // 极简 frontmatter 解析 (跟 v0.4.6.1 agents 一样)
      let description = '';
      let body = content;
      if (content.startsWith('---')) {
        const rest = content.slice(3);
        const endIdx = rest.indexOf('\n---');
        if (endIdx >= 0) {
          const header = rest.slice(0, endIdx);
          const after = rest.slice(endIdx + 4);
          const bodyStart = after.indexOf('\n') >= 0 ? after.indexOf('\n') + 1 : 0;
          body = after.slice(bodyStart);
          for (const line of header.split('\n')) {
            const colon = line.indexOf(':');
            if (colon < 0) continue;
            const k = line.slice(0, colon).trim();
            const v = line.slice(colon + 1).trim();
            if (k === 'description') description = v.replace(/^["']|["']$/g, '');
          }
        }
      }
      customCommands.push({
        name,
        description: description || '(无描述)',
        argumentHint: null,
        body,
        source: 'custom',  // v0.4.5.2: 跟 builtin 区分
      });
    }
  }
} catch (e) {
  console.error(`[sidecar] failed to scan .pi/commands/: ${e instanceof Error ? e.message : String(e)}`);
}
console.error(`[sidecar] slash commands: ${builtinSlashCommands.length} builtin (Pi CLI 内部, 不支持 RPC 触发) + ${customCommands.length} custom`);
process.stdout.write(JSON.stringify({
  type: 'slash_snapshot',
  commands: builtinSlashCommands,
  custom: customCommands,  // v0.4.5.2: FE 端用这个显示, 不显示 builtin
}) + '\n');

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
  // v0.4.4.6: 从 config.modelMetadata 拿 user 配的 model 参数, 拼到 model object.
  //   缺省 → 用 hardcoded 默认值 (跟 v0.4.4.5 之前一致, 向后兼容).
  const mm = config.modelMetadata ?? {};
  const hasVision = mm.vision === true;
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
      // Pi SDK 0.84.2 input 字段: vision → ['text', 'image'], 默认 'text' only
      input: hasVision ? ['text', 'image'] : ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: mm.contextWindow ?? 128000,  // v0.4.4.6: user 配的上下文, 缺省 128K
      maxTokens: mm.maxOutput ?? 8192,           // v0.4.4.6: user 配的单次回复上限, 缺省 8K
      // Pi SDK reasoning: true 走 thinking mode (DeepSeek-R1 / Claude extended thinking)
      ...(mm.reasoning === true ? { reasoning: true } : {}),
    }],
    api: {
      stream: openaiCompletionsStream,
      streamSimple: openaiCompletionsStreamSimple,
    },
  });
  // v0.4.4.6: modelType (我们自己的路由概念) + maxRounds (后续 Extension 层拦截) 存到
  //   config 上, sidecar 不直接传给 Pi SDK (Pi SDK 没对应 schema). 这样 FE / Tauri 端
  //   都能读, 后续 v0.4.4.7 polish 加 maxRounds enforcement 时直接用 config.modelMetadata.maxRounds.
  console.error(`[sidecar] user-custom model: id=${config.model} type=${mm.modelType ?? 'chat'} vision=${hasVision} contextWindow=${mm.contextWindow ?? 128000} maxOutput=${mm.maxOutput ?? 8192} maxRounds=${mm.maxRounds ?? 'unset'} reasoning=${mm.reasoning === true}`);
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
      appendSystemPromptOverride: (base) => [
        ...base,
        CONTEXT_AWARENESS_INSTRUCTION,
        // v0.4.4 Skills: 把 enabled skills 格式化进 system prompt (Pi SDK 0.84.2 formatSkillsForPrompt
        //   返回 XML 格式, 跟 <context_awareness> 风格一致). enabledSkillNames 从 config 传, 改 enabled
        //   必须重启 sidecar (D165 systemPrompt 不可动态改).
        ...(skillsPromptFragment ? [skillsPromptFragment] : []),
        // v0.5.0-v0.1: 删 active agent persona 段 (multi-agent persona 回滚)
        //   Pi SDK 0.84.2 DefaultResourceLoader 自动 load AGENTS.md (resource-loader.ts:71)
        //   → 注入 project_context 段. sidecar 不用拼 persona.
      ],
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
