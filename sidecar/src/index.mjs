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
import { existsSync, readFileSync, readdirSync, lstatSync, readlinkSync, statSync, appendFileSync, renameSync, unlinkSync } from 'node:fs';
// ADR-0021 P0-3: 写 web_search / web_fetch tool definition, 用 Type.Object 跟 Pi SDK builtin tool 一致
import { Type } from '@sinclair/typebox';
import { join, resolve as pathResolve } from 'node:path';

import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
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
// 2026-08-21 P2-1: MCP (Model Context Protocol) 集成 — 通用框架, 接任意 MCP server
//   用官方 SDK (@modelcontextprotocol/sdk) 走 JSON-RPC over stdio.
//   跟 P1-5 user tool 走同一个 customTools path (merge 到 LLM 可见的 tools list).
import { McpServerClient, McpServerError, jsonSchemaToTypeBox } from './mcpClient.mjs';
// v0.6.3-rc1 P2-6: 工具错误分类 + 人类可读化 (401/403/5xx/网络错误 → user 看得懂的提示)
import { classifyToolError, formatToolError } from './errorSanitizer.mjs';
// v0.6.3-rc1 P2-2: MCP config dir 热重载 watcher (fs.watch + debounce)
import { watchMcpConfigDirs } from './mcpWatcher.mjs';

// v0.6.3-rc1 P2-2: MCP subsystem 模块级状态, 让热重载 callback 能访问
//   - clients: 当前运行的 McpServerClient[] (cleanup 跟 reload 用)
//   - customTools: 当前 wrap 好的 Pi SDK ToolDefinition[] (createAgentSession 拼 allCustomTools 用)
//   - results: 本次 (re)load 的结果, 含每个 server 的 status / reason (给后续 FE 反馈用)
//   - watcherClose: 关闭 watcher 的 fn (sidecar 退出时调)
//   - workspacePath / agentDir: reload 时需要重新读 config, 保留 init 时的路径
const mcpState = {
  clients: [],
  customTools: [],
  results: [],
  watcherClose: null,
  workspacePath: null,
  agentDir: null,
};

// 2026-08-21: Skills 模块级可变状态 — 支持 in-session hot reload
//   allSkills: 所有扫描到的 skill (按 name 去重)
//   enabledSkillNames: 当前启用的 skill name Set (来自 config)
//   skillsPromptFragment: 格式化后的 skill 内容, spread 进 system prompt (line ~563)
//   config: 保留 init 时的 config 引用 (reload 时用 workspacePath/agentDir/skills 配置)
let allSkills: any[] = [];
let enabledSkillNames = new Set<string>();
let skillsPromptFragment = '';
let skillsState: {
  config: any;
  workspacePath: string;
  agentDir: string;
} | null = null;
let skillsReloadInProgress = false;

/**
 * 2026-08-21: 重新加载 skills 文件并重建 skillsPromptFragment.
 * 跟 MCP reload 同模式: 下一轮 prompt 生效, 当前 session 已有消息不受影响.
 */
function rebuildSkillsFragment(wsPath: string, agDir: string, cfg: any) {
  const sc = cfg?.skills ?? { enabledNames: [], extraPaths: [] };
  const result = loadSkills({
    cwd: wsPath,
    agentDir: agDir,
    skillPaths: sc.extraPaths ?? [],
    includeDefaults: true,
  });
  const enabled = new Set(sc.enabledNames ?? []);
  const enabledList = result.skills.filter((s: any) => enabled.has(s.name));
  const fragment = enabledList.length > 0
    ? '\n\n' + formatSkillsForPrompt(enabledList)
    : '';
  allSkills = result.skills;
  enabledSkillNames = enabled;
  skillsPromptFragment = fragment;
  console.error(
    `[sidecar] skills hot-reload: ${result.skills.length} total, ${enabledList.length} enabled, ` +
    `${result.diagnostics.length} diags, fragment=${fragment.length} chars`
  );
  return {
    skills: result.skills,
    enabledCount: enabledList.length,
    diagnostics: result.diagnostics,
  };
}

/**
 * v0.6.3-rc1 P2-2: 抽 initMcpSubsystem — 之前是 createAgentSession 内联逻辑, 现在抽出来
 *   给 hot reload 复用. 读 configs → spawn → wrap, 返回完整结果.
 * 错误降级: 单个 server start 失败不影响其它, 也不影响 sidecar 自身 (跟 P2-1 一致).
 */
async function initMcpSubsystem(workspacePath, agentDir) {
  const configs = loadMcpServerConfigs(workspacePath, agentDir);
  const results = [];
  const clients = [];
  for (const config of configs) {
    const client = new McpServerClient(config);
    try {
      await client.start();
      clients.push(client);
      results.push({
        name: config.name,
        status: 'started',
        toolCount: client.toolCount,
        durationMs: client.startDurationMs,
      });
      console.error(`[sidecar] P2-1: MCP server '${config.name}' started (${client.toolCount} tools, ${client.startDurationMs}ms)`);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      results.push({ name: config.name, status: 'failed', reason });
      console.error(`[sidecar] P2-1: MCP server '${config.name}' failed to start, skip: ${reason}`);
    }
  }
  const customTools = wrapMcpToolsAsCustomTools(clients);
  if (customTools.length > 0) {
    console.error(`[sidecar] P2-1: ${customTools.length} MCP tool(s) merged into customTools: [${customTools.map((t) => t.name).join(', ')}]`);
  }
  return { clients, customTools, results };
}

/**
 * v0.6.3-rc1 P2-2: 热重载 MCP — 关所有 client + 重 init + 更新 mcpState.
 *
 * 关键: 不重建 Pi SDK agent session, 保留对话状态. Pi SDK 0.84.2 不支持 mid-conversation
 *   改 tool 白名单, 新的 tool 会在 LLM 下一轮 turn 看到 (跟 Claude Code / Cursor 同款体验).
 * 老 session 持有的 customTools 引用不变, 但我们替换 mcpState.customTools 后,
 *   下次 wrapMcpToolsAsCustomTools 被调时会用新引用 (也支持运行时重 wrap).
 *
 * 错误降级: 新一轮 init 失败的 server 不影响已经运行好的 (只是不更新其引用).
 *   旧的 clients 数组先关再换, 避免泄漏 stdio 子进程 / HTTP 长连接.
 *
 * 并发保护: 用 mcpState.reloadInProgress 标志, 防止上一个 reload 没跑完下一个又进来
 *   (e.g. user 连改 2 个文件, debounce 300ms 内可能触发 2 次). 第二个进来直接 skip,
 *   已经被 debounce 合并的 1 次就够了.
 */
let reloadInProgress = false;
async function reloadMcpSubsystem() {
  if (reloadInProgress) {
    console.error('[sidecar] P2-2: reload already in progress, skip (concurrent trigger)');
    return;
  }
  reloadInProgress = true;
  const t0 = Date.now();
  console.error('[sidecar] P2-2: MCP config change detected, reloading...');

  try {
    // 1. 关所有现有 client (best effort, 不 throw)
    const oldClients = mcpState.clients;
    for (const client of oldClients) {
      try {
        await client.stop();
      } catch (e) {
        console.error(`[sidecar] P2-2: stop old client '${client.config.name}' failed (ignored):`, e instanceof Error ? e.message : String(e));
      }
    }

    // 2. 重新 init
    const { clients, customTools, results } = await initMcpSubsystem(mcpState.workspacePath, mcpState.agentDir);

    // 3. 更新 module-level state
    mcpState.clients = clients;
    mcpState.customTools = customTools;
    mcpState.results = results;

    const elapsed = Date.now() - t0;
    const started = results.filter((r) => r.status === 'started').length;
    const failed = results.filter((r) => r.status === 'failed');
    const oldNames = new Set(oldClients.map((c) => c.config.name));
    const newNames = new Set(clients.map((c) => c.config.name));
    const removed = [...oldNames].filter((n) => !newNames.has(n));
    const added = [...newNames].filter((n) => !oldNames.has(n));
    console.error(
      `[sidecar] P2-2: reload done in ${elapsed}ms — ${started} started, ${failed.length} failed, ` +
      `${added.length} added [${added.join(', ') || '-'}], ${removed.length} removed [${removed.join(', ') || '-'}]`
    );
    if (failed.length > 0) {
      for (const f of failed) {
        console.error(`[sidecar] P2-2:   ❌ ${f.name}: ${f.reason}`);
      }
    }
    // 重要: LLM 下一轮 turn 才能看到新 tool (Pi SDK 0.84.2 不支持 mid-conversation 改 tool 白名单).
    // 旧 tool 在 LLM tool 白名单里仍可见 (如果它原本是 started 状态), 但 client 已关, 调用会失败.
    // 给 user 一个清晰提示 — 改完文件, 下一条 prompt 生效.
    if (added.length > 0 || removed.length > 0) {
      console.error(`[sidecar] P2-2: tool list changed (added=${added.length}, removed=${removed.length}), LLM will see updates on next turn`);
    }
  } catch (e) {
    console.error('[sidecar] P2-2: reload failed:', e instanceof Error ? e.message : String(e));
  } finally {
    reloadInProgress = false;
  }
}

/**
 * v0.6.3-rc1 P2-2: 装 fs watcher, 触发 reload. 在 createAgentSession 末尾调一次.
 *   - 第一次调用时 (sidecar 启动), 路径为 initMcpSubsystem 时用过的
 *   - reload 内部会自己读 mcpState.workspacePath / agentDir
 */
function installMcpWatcher() {
  // 先关旧的 (理论上只有 createAgentSession 走一次, 防御)
  if (mcpState.watcherClose) {
    try { mcpState.watcherClose(); } catch { /* ignore */ }
  }
  const handle = watchMcpConfigDirs(mcpState.workspacePath, mcpState.agentDir, () => {
    // fire-and-forget: watcher callback 是同步的, reload 是 async
    reloadMcpSubsystem().catch((e) => {
      console.error('[sidecar] P2-2: reload failed:', e instanceof Error ? e.message : String(e));
    });
  });
  mcpState.watcherClose = handle.close;
}
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
// 2026-08-21: 初始化 skills (用模块级变量, 支持 hot reload)
skillsState = { config, workspacePath, agentDir };
const skillsInitResult = rebuildSkillsFragment(workspacePath, agentDir, config);
console.error(`[sidecar] system prompt: 5 segments [base=Pi-SDK-default skills=${skillsInitResult.enabledCount}(${skillsPromptFragment.length} chars) skill_realtime=约束 LLM 每次用 skill 前读最新文件 project_context=AGENTS.md-auto(Pi-SDK) context_awareness=set]`);
if (skillsInitResult.diagnostics.length > 0) {
  for (const d of skillsInitResult.diagnostics.slice(0, 5)) {
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
  diagnostics: skillsInitResult.diagnostics,
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
      // P2 #5 fix: 缺省 200K, 跟 FE stores/chat.ts 的 DEFAULT_CONTEXT_WINDOW 对齐 (现代 LLM 默认)
      //   之前 sidecar 128K vs FE 200K 对不上, Composer 显示的 "X.XK / 200K" 跟 Pi SDK 内部用的
      //   contextWindow 不一致 (侧车拿 128K 算百分比, FE 用 200K 算百分比), 视觉上混乱
      contextWindow: mm.contextWindow ?? 200000,
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

  // v0.5.0-D 第10轮: 简化 RESPONSE_STYLE_INSTRUCTION 为 1+1 规则.
  //   第2-9轮加的 5 条规则太长, model (sensenova-6.7-flash-lite) 实际只遵守第 1 条但
  //   不彻底, 还是会有 echo. 第 2-4 条都是 "软" 规则 (简洁/不重复/事件流), 跟 echo 关系不大,
  //   而且稀释了第 1 条的权重. 第 5 条 (HTML 包代码块) 保留, 简短 + 配反例, model 实际遵守率
  //   更高. 用户 D194 反馈 "9 轮原地打转" 后, 整体改回 v0.5.0-PR3 极简 prompt.
  //
  // 关键: **第 1 条带反例** — 实测 model (尤其 flash-lite 类小模型) 对 "Do NOT X" 这种
  //   否定指令不敏感, 改成 "Bad: ... / Good: ..." 配具体反例后, 遵守率显著提升.
  const RESPONSE_STYLE_INSTRUCTION = `<rules>
1. Never start your reply by repeating the user's question. Jump straight to the answer.
   Bad:  User: "What's the weather?"  Assistant: "What's the weather? It's sunny."
   Good: User: "What's the weather?"  Assistant: "It's sunny today."

2. When you generate or quote HTML, wrap it in a \`\`\`html code block. Never paste raw HTML.
</rules>`;

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
      // P1 #5: maxRounds extension 跟 permission 独立, mode=allow 也注册 (限制是 model 行为,
      //   不是 user 行为). null 时 (maxRounds 没设) 自动跳过.
      // 2026-08-20 fix: 之前 P1 #5 commit 585c23a 写 `createMaxRoundsExtension(mm.maxRounds)` 但 `mm` 是
      //   createUserCustomProvider 内的 const,不在这个 scope,运行时 ReferenceError → sidecar 启动即崩.
      //   修: 直接从 config.modelMetadata 取 (FE 传进来的对象,user 没配 maxRounds 时是 undefined,自然跳过).
      extensionFactories: (() => {
        const factories = [];
        const maxRoundsExt = createMaxRoundsExtension(config.modelMetadata?.maxRounds);
        if (maxRoundsExt) factories.push(maxRoundsExt);
        if (config.permissionMode !== 'allow') {
          factories.push(createPermissionExtension(config.permissionMode));
        }
        // ADR-0019 P0-2: 危险命令 deny list + 用户白名单 (不受 permissionMode 控制,
        //   永远注册 — 危险命令是 model 行为, 不是 user 行为, allow 模式也该拦)
        //   2026-08-23 bug fix: 之前传数组引用 + 工厂立即 compile, 跟 loadUserTools 填白名单
        //   有时序竞争 — 工厂跑的时候 dangerousWhitelist 还是 [], 编译出来 compiledWhitelist
        //   锁死成空, 之后 push 进去也看不到. 改成传 getter, handler 内 lazy 编译 + 缓存.
        factories.push(createDangerousCommandExtension(() => dangerousWhitelist));
        return factories;
      })(),
      appendSystemPromptOverride: (base) => [
        ...base,
        CONTEXT_AWARENESS_INSTRUCTION,
        // v0.5.0-D 第10轮: 简化到 1+1 规则 (no-echo 带反例 + HTML 包代码块).
        //   之前 5 条规则太长被 model 忽略, 用户 D194 反馈 9 轮原地打转.
        RESPONSE_STYLE_INSTRUCTION,
        // v0.4.4 Skills: 把 enabled skills 格式化进 system prompt (Pi SDK 0.84.2 formatSkillsForPrompt
        //   返回 XML 格式, 跟 <context_awareness> 风格一致). enabledSkillNames 从 config 传, 改 enabled
        //   必须重启 sidecar (D165 systemPrompt 不可动态改).
        ...(skillsPromptFragment ? [skillsPromptFragment] : []),
        // 2026-08-21: Skill 实时读取约束 — 解决 LLM 用对话历史中的旧 skill 描述而不读最新文件的问题
        //   LLM 没有自动版本对比机制, 需要显式约束. 这段加在 skills fragment 之后, 每次 prompt 都生效.
        //
        // v2 修订 (D_D209): LLM 把"before following"理解成"第一次需要 read, 之后 fall through 到
        //   上下文缓存", 实测 LLM 会诚实说"首次加载本地路径, 后续复用上下文记忆".
        //   修法: 改成强协议格式 (numbered steps + absolute rules), 显式声明 "EVERY invocation",
        //   禁止"用之前对话里读过的版本".
        `<skill_realtime>
MANDATORY skill re-read protocol — applies to EVERY skill invocation, not just the first.

When the user references a skill — by mentioning its name, via [[skill:xxx]], or by saying "用 xxx skill" / "按 xxx skill 做" / "use the xxx skill" / "用之前保存的 skill" — you MUST execute this protocol IN ORDER before following the skill's instructions:

  Step 1: Identify the skill's file path from <available_skills>.
  Step 2: Call the read tool to fetch the file's CURRENT contents from disk.
  Step 3: Read the returned content.
  Step 4: Follow the instructions in the freshly-read file.

ABSOLUTE RULES (violating any of these means you are acting on outdated instructions):

  - Re-read on EVERY skill invocation, not just the first turn. A second or third mention of the same skill in the same conversation still requires a fresh read.
  - Do NOT reuse skill content you remember from earlier turns of this conversation. The file may have been edited by the user between your reads.
  - Do NOT trust the description in <available_skills> as a substitute for the file content. The description is a brief summary, not the authoritative instructions.
  - Do NOT skip the read because "I just read it" or "the user is repeating the same request". Every mention of a skill is a fresh invocation.
  - The conversation history is NOT a reliable cache for skill files. Skill files are user-editable artifacts that change independently of this conversation.

The re-read is a single tool call — a small cost for correctness. Skipping it risks acting on outdated instructions, which the user has explicitly asked to prevent. When in doubt, re-read.
</skill_realtime>`,
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
  // 2026-08-21 P2-1 fix: 把 customTools 的名字也加进 tools 白名单
  //   Pi SDK 0.84.2 isAllowedTool (agent-session.ts:2468) 只允许在 tools 数组里的工具,
  //   customTools 不在白名单会被静默过滤掉 → LLM 看不到 MCP/user tool.
  //   修法: 拼一个 toolsAll = builtin + customTools 名字, 传给 Pi SDK.
  const builtinTools = config.tools ?? ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'];

  // 2026-08-20 P1-5: 加载 user-defined tools (从 builtin 派生的 args 预设模板).
  //   跟 builtin 7 个一起 merge 到 Pi SDK customTools, LLM 可见的 tools list = builtin + user.
  //   cwd 走 workspacePath (跟 builtin tool 自己定位 relative path 一致)
  const userTools = loadUserTools(workspacePath, agentDir);
  if (userTools.length > 0) {
    console.error(`[sidecar] P1-5: loaded ${userTools.length} user tool(s): [${userTools.map((t) => t.name).join(', ')}]`);
  }

  // 2026-08-21 P2-1: 加载 MCP servers (通用框架, 接任意 MCP server).
  //   跟 user tool 走同一个 customTools path, LLM 看到 mcp_<server>_<tool> 名字 + (MCP: server) 标识.
  //   错误降级: 1 个 server 启动失败不影响其它 server, 不影响 sidecar 自身.
  // v0.6.3-rc1 P2-2: 抽 initMcpSubsystem + 装 watcher (hot reload 改完文件自动生效)
  mcpState.workspacePath = workspacePath;
  mcpState.agentDir = agentDir;
  const { clients: mcpClients, customTools: mcpCustomTools, results: mcpResults } = await initMcpSubsystem(workspacePath, agentDir);
  mcpState.clients = mcpClients;
  mcpState.customTools = mcpCustomTools;
  mcpState.results = mcpResults;

  // 注册 sidecar 关闭时 stop 所有 MCP clients (SIGTERM 子进程, 防僵尸)
  // P2-2: 不再传 fixed clients, registerMcpCleanup 内部读 mcpState.clients
  //   (reload 后的 clients 也要在 sidecar 关闭时被 stop)
  registerMcpCleanup();

  // P2-2: 装 fs watcher, config 改完自动 reload
  installMcpWatcher();

  // 合并 user tool + MCP tool + ADR-0021 web tool 成一个 customTools 列表
  const webTools = loadWebTools(config.webSearchKey);
  const allCustomTools = [...userTools, ...mcpCustomTools, ...webTools];
  if (allCustomTools.length > 0) {
    console.error(`[sidecar] total customTools: ${allCustomTools.length} (user=${userTools.length}, mcp=${mcpCustomTools.length}, web=${webTools.length})`);
  }

  // 2026-08-21 P2-1 fix: tools 白名单合并 builtin + customTools 名字.
  //   Pi SDK 0.84.2 isAllowedTool (agent-session.ts:2468) 只放行 tools 数组里有的工具名,
  //   customTools 不在白名单会被静默过滤掉. 这里把 customTools.name 也加进白名单,
  //   LLM 才会真正看到 mcp_*/user_* 工具.
  const allTools = [...builtinTools, ...allCustomTools.map((t) => t.name)];

  console.error(`[sidecar] creating agent session: model=${model.provider}/${model.id} thinking=${config.thinkingLevel ?? 'medium'} tools=${allTools.join(',')} userTools=${userTools.length} mcpTools=${mcpCustomTools.length} webTools=${webTools.length} permissionMode=${config.permissionMode ?? 'ask'}`);

  return createAgentSessionFromServices({
    services,
    sessionManager: sm,
    model,
    thinkingLevel: config.thinkingLevel,
    tools: allTools,
    customTools: allCustomTools.length > 0 ? allCustomTools : undefined,
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
 *
 * 2026-08-20 P0-1 修 (D-tool-permission-smart): 之前 'smart' 模式只是 UI 摆了个 option,
 *   sidecar 实际行为跟 'ask' 一模一样 (任何 tool call 都弹窗) — 用户切过去没效果, 跟 ADR-0014
 *   标的 ✅ 严重不符. 根因: createPermissionExtension 漏了 smart 分支, 默认走 confirm 路径.
 *   修法: 显式区分 read-only 工具集 (read/ls/find/grep), mode='smart' 时静默放行, 跟 ADR
 *   "smart: 读类自动放行, 写类+bash 弹 confirm" 对齐. 用 Set 避免每次构造数组, hot path
 *   (每个 tool call 都查一次) 用 O(1) 命中.
 */
const READ_ONLY_TOOLS = new Set(['read', 'ls', 'find', 'grep']);

// ====== ADR-0019 P0-2 (2026-08-23): 内置危险命令 deny list ======
//   当 bash 工具被调, Extension.on('tool_call') 用这些 regex 匹配 command.
//   匹配 + 不在用户白名单 → block with reason (LMM 收到 reason 后可改命令).
//   匹配 + 在用户白名单 → 放行 + stderr log 一行 [sidecar] DANGEROUS_USED, 供 chat UI 检测 badge.
//   12 条覆盖 80% 常见危险. 用户可在 Settings → 通用 → 高级权限 加白名单 / 自定义扩展.
const BUILTIN_DENY_LIST = [
  // 通用: 危险删除
  /\brm\s+(-[a-zA-Z]*[rRfF][a-zA-Z]*|--recursive)\b/,     // rm -rf / rm -fr / rm -r
  /\brmdir\s+\/s\b/i,                                      // Windows rmdir /s
  /\bdel\s+\/[a-z]*f[a-z]*\b/i,                            // Windows del /f
  /\brd\s+\/s(\s+\/q)?\b/i,                                // Windows rd /s /q
  // 磁盘级
  /\bformat(\.com)?\b/i,                                   // format C:
  /\bmkfs(\.[a-z0-9]+)?\b/i,                               // mkfs.ext4 etc.
  /\bdd\s+if=/i,                                           // dd if=/dev/zero of=/dev/sda
  // Fork bomb (经典)
  /:\(\)\s*\{.*:\|:.*&\s*\}\s*;\s*:/,                     // :(){ :|:& };:
  // Pipe-to-shell (下载执行)
  /\b(wget|curl)\s+[^|]*\|\s*(ba)?sh\b/i,                  // wget/curl | bash
  // 远程代码执行
  /\b(sh|bash)\s+<\s*(\(|curl|wget)/i,                     // sh <(curl ...) 等
  // 系统关停
  /\bshutdown\s+(-h|-r\s+now)/i,                           // shutdown -h now
  /\b(init\s+0|init\s+6)\b/,                               // init 0/6
  // /dev/sda 直接写
  />\s*\/dev\/(sda|nvme|hd)/i,
];

// ====== ADR-0019 P0-2: 危险命令白名单 (从 settings.json 读) ======
//   必须在模块顶层, 不能在 loadUserTools 函数内!
//   extensionFactories IIFE 在 line 580 引用, 而 loadUserTools 调在 line 675 之后.
//   函数内 const 不会 hoisted, 引用即 ReferenceError, sidecar module 加载失败.
//   顶层 let/const 在 module 加载时进入 TDZ, 但我们在 IIFE 执行时 (line 549 module top-level await 阶段)
//   这个变量在词法上已声明, 不会 ReferenceError. 真正的填充在 loadUserTools 内 (下面有 4 处 push).
let dangerousWhitelist = [];


/**
 * 2026-08-20 P1-5: 加载 user-defined tools (从 builtin 派生的"args 预设"模板)
 *
 * 文件位置 (跟 Skills / Commands 同 pattern, workspace 优先):
 *   - <workspacePath>/.pi/tools/*.json
 *   - <agentDir>/tools/*.json
 *
 * JSON schema (跟 Rust 端 parse_user_tool_name + validate_user_tool_body 一致):
 *   {
 *     "name": "my_grep_todo",
 *     "description": "在 src 下所有 .ts 文件里找 TODO 注释, 排除测试文件",
 *     "basedOn": "grep",
 *     "args": { "pattern": "TODO", "path": "src", "include": "*.ts", "exclude": "*.test.ts" }
 *   }
 *
 * 实现: 对每个 user tool 拿 builtin tool 的 ToolDefinition (parameters zod schema),
 *   包装 execute 闭包 (merge preset args + LLM 传的 args, 调 builtin execute).
 *   这样 LLM 把 user tool 跟 builtin 看成同一种东西, 但 user tool 的 description 引导
 *   LLM 啥时候用、args 预填省事.
 *
 * 错误处理: 文件格式错 / basedOn 不合法 / etc, **log warn + 跳过**, 不让一个坏文件拖垮整个
 *   session. 跟 Skills 扫描同 pattern.
 */
const BUILTIN_TOOL_NAMES_P1_5 = new Set(['read', 'write', 'edit', 'bash', 'ls', 'find', 'grep']);

function loadUserTools(cwd, agentDir) {
  if (!cwd && !agentDir) return [];
  // 拿 builtin tool definitions (parameters zod schema + execute 闭包)
  // cwd 给 builtin tool 让它定位 relative path (跟 builtin 自己跑命令时一致)
  // Pi SDK 0.84.2 顶层 index.ts 没 export createAllToolDefinitions, 只 export 各个 createXxxToolDefinition,
  //   走 createAgentSessionFromServices 时它内部也是按名字查 ToolName union 创建.
  //   这里我们自己组装一个 dict, 跟 createAllToolDefinitions 等价.
  const cwdResolved = cwd || process.cwd();

  // ====== ADR-0019 P0-1 (2026-08-23): 读 user-configured bash 路径 ======
  //   优先用 settings.bash.path (FE 端 Settings → Bash 路径配置, user 手动填 / 自动检测写入)
  //   没设 → fallback Pi SDK 自带 search (3 路径 + PATH, 跟旧行为一致)
  //   shellPath 设了但文件不存在 → Pi SDK 内部 throw, sidecar 走 errorSanitizer
  let userBashShellPath = null;
  // ADR-0019 P0-2: 危险命令白名单 — 推到模块顶层 (line 779), 这里直接 push
  try {
    const settingsPath = join(agentDir || process.cwd(), 'settings.json');
    if (existsSync(settingsPath)) {
      const raw = readFileSync(settingsPath, 'utf-8');
      const settings = JSON.parse(raw);
      const bashCfg = settings?.bash;
      if (bashCfg && typeof bashCfg.path === 'string' && bashCfg.path) {
        userBashShellPath = bashCfg.path;
        console.error(`[sidecar] P0-1: bash shell from settings: ${userBashShellPath} (source=${bashCfg.source ?? '?'}, version=${bashCfg.version ?? '?'})`);
      }

      // ADR-0019 P0-2: 读 user 自定义危险命令白名单 (regex pattern 列表)
      //   来自 Settings → 通用 → 高级权限 的输入
      //   格式: [{ pattern: string, note?: string, addedAt?: string }, ...]
      const dwl = settings?.dangerousWhitelist;
      if (Array.isArray(dwl)) {
        for (const item of dwl) {
          if (item && typeof item.pattern === 'string' && item.pattern) {
            dangerousWhitelist.push({
              pattern: item.pattern,
              note: typeof item.note === 'string' ? item.note : '',
              addedAt: typeof item.addedAt === 'string' ? item.addedAt : new Date().toISOString(),
            });
          }
        }
      }
    }
  } catch (e) {
    console.error(`[sidecar] P0-1: failed to read settings.bash, fallback to Pi SDK auto-discovery: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!userBashShellPath) {
    console.error('[sidecar] P0-1: bash shell: (unset in settings, fallback to Pi SDK auto-discovery)');
  }

  // ====== ADR-0019 P0-2 (2026-08-23): bash 沙箱 - settings.shellCommandPrefix 路径 ======
  //   Pi SDK 0.84.2 agent-session.ts:2562-2574 启动时读 settings.shellCommandPrefix + settings.shellPath,
  //   注入到 createBashToolDefinition 的 options. 我们这里 mirror 我自己写的 bash.path 到 Pi SDK
  //   标准字段, 让 Pi SDK 自动用. 改动 settings.json 后, 现有 sidecar 进程不重新读 (Pi SDK 已经在
  //   内存里 load 了), 需重启 sidecar 才生效.
  if (userBashShellPath) {
    try {
      const settingsPath = join(agentDir || process.cwd(), 'settings.json');
      if (existsSync(settingsPath)) {
        const raw = readFileSync(settingsPath, 'utf-8');
        const s = JSON.parse(raw);
        let changed = false;
        // 1) shellPath: mirror 我的 bash.path 到 Pi SDK 标准字段
        if (s.shellPath !== userBashShellPath) {
          s.shellPath = userBashShellPath;
          changed = true;
        }
        // 2) shellCommandPrefix: 强制每次 cd 回 workspace cwd (cwdResolved)
        //    Pi SDK bash.ts:345 用 `${prefix}\n${command}` 追加, 每次 invocation 自动 cd 回 workspace
        //    Pi SDK agent-session.ts:2573 在 bash tool 创建时设: bash: { commandPrefix: shellCommandPrefix, shellPath }
        const desiredPrefix = `cd "${cwdResolved}" &&`;
        if (s.shellCommandPrefix !== desiredPrefix) {
          s.shellCommandPrefix = desiredPrefix;
          changed = true;
        }
        if (changed) {
          const pretty = JSON.stringify(s, null, 2);
          writeFileSync(settingsPath, pretty, 'utf-8');
          console.error(`[sidecar] P0-2: mirrored bash.path to settings.shellPath + settings.shellCommandPrefix (cwd=${cwdResolved})`);
        }
      }
    } catch (e) {
      console.error(`[sidecar] P0-2: failed to mirror bash config to Pi SDK fields: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ====== ADR-0019 P0-2 (2026-08-23): bash 沙箱 (settings.shellCommandPrefix 路径) ======
  //   重要设计纠正 (2026-08-23): 我之前 wrapBashWithSandbox 写在了 builtinToolDefs 对象里,
  //   但 Pi SDK 0.84.2 内部有自己的 _baseToolDefinitions (agent-session.ts:348, 2564),
  //   不会用我传进去的 builtinToolDefs. wrap 函数是 dead code.
  //   正确路径: Pi SDK 从 settings.json 读 shellCommandPrefix + shellPath (agent-session.ts:2562-2574,
  //   bash.ts:345), 把这两个字段写进 settings.json 即可生效.
  //
  //   deny list 之前 wrap 路径到不了, 走 Pi SDK 的 Extension API (tool_call event) 才能实现.
  //   Extension 改造比 P0-2 范围大, 留 P1 (P0-2 退化为只做 cwd 限定, 不做硬 deny).

  const builtinToolDefs = {
    read: createReadToolDefinition(cwdResolved),
    write: createWriteToolDefinition(cwdResolved),
    edit: createEditToolDefinition(cwdResolved),
    bash: createBashToolDefinition(cwdResolved, userBashShellPath ? { shellPath: userBashShellPath } : undefined),
    ls: createLsToolDefinition(cwdResolved),
    find: createFindToolDefinition(cwdResolved),
    grep: createGrepToolDefinition(cwdResolved),
  };

  const customTools = [];
  // 顺序: 先 global, 后 workspace, 同名时 workspace 覆盖 global (跟 Rust 端 list_user_tools 一致)
  const seen = new Set();
  const seenGlobal = new Set();  // 跟踪 global 哪些名字被加进去了, workspace 出现时删 global 那条

  // 1. global scope: <agentDir>/tools/*.json
  if (agentDir) {
    const globalDir = join(agentDir, 'tools');
    if (existsSync(globalDir)) {
      try {
        for (const entry of readdirSync(globalDir)) {
          if (!entry.endsWith('.json')) continue;
          const fullPath = join(globalDir, entry);
          const def = tryParseUserToolJson(fullPath, builtinToolDefs);
          if (def) {
            seen.add(def.name);
            seenGlobal.add(def.name);
            customTools.push(def);
          }
        }
      } catch (e) {
        console.error(`[sidecar] P1-5: scan global tools/ failed:`, e instanceof Error ? e.message : String(e));
      }
    }
  }
  // 2. workspace scope: <workspacePath>/.pi/tools/*.json (同名覆盖 global)
  if (cwd) {
    const workspaceDir = join(cwd, '.pi', 'tools');
    if (existsSync(workspaceDir)) {
      try {
        for (const entry of readdirSync(workspaceDir)) {
          if (!entry.endsWith('.json')) continue;
          const fullPath = join(workspaceDir, entry);
          const def = tryParseUserToolJson(fullPath, builtinToolDefs);
          if (def) {
            if (seen.has(def.name)) {
              // workspace 覆盖: 删掉 global 那条
              const idx = customTools.findIndex((t) => t.name === def.name);
              if (idx >= 0) customTools.splice(idx, 1);
            }
            seen.add(def.name);
            customTools.push(def);
          }
        }
      } catch (e) {
        console.error(`[sidecar] P1-5: scan workspace tools/ failed:`, e instanceof Error ? e.message : String(e));
      }
    }
  }
  return customTools;
}

// ====== ADR-0021 P0-3 (2026-08-23): Web 工具 (web_search + web_fetch) ======
//   - key 走 Tauri keychain → sidecar stdin config.webSearchKey (跟 LLM apiKey 同 path)
//   - 5 分钟 LRU 缓存 (per ADR-0019 S-2, 节流省 Brave 配额)
//   - web_fetch HTML→text 用手写 strip (P1 换 html-to-text)
const WEB_CACHE_TTL_MS = 5 * 60 * 1000;  // 5 分钟
const WEB_CACHE_MAX = 100;  // LRU 上限
const webCache = new Map();  // key -> { value: string, expiresAt: number }

function webCacheGet(cacheKey) {
  const entry = webCache.get(cacheKey);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    webCache.delete(cacheKey);
    return null;
  }
  return entry.value;
}

function webCacheSet(cacheKey, value) {
  // 简化 LRU: 超过上限删最早插入的 (Map 保插入序)
  if (webCache.size >= WEB_CACHE_MAX) {
    const firstKey = webCache.keys().next().value;
    if (firstKey !== undefined) webCache.delete(firstKey);
  }
  webCache.set(cacheKey, { value, expiresAt: Date.now() + WEB_CACHE_TTL_MS });
}

/**
 * 手写 HTML→text (P0-3 MVP 80 分够用, P1 换 html-to-text crate 升 90 分)
 *   1. 剥 <script> / <style> 整块
 *   2. block tags (p/div/br/li 等) → 换行
 *   3. 剥剩余 <tag>
 *   4. 解码常见 HTML entities
 *   5. 压缩多空行
 */
function htmlToText(html) {
  let s = html;
  // script / style 整块剥
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '');
  s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '');
  // block tags → \n
  s = s.replace(/<\/?(p|div|br|h[1-6]|li|tr|td|th|blockquote|pre|hr|section|article|header|footer|nav|aside)\b[^>]*>/gi, '\n');
  // 剥剩余 tag
  s = s.replace(/<[^>]+>/g, '');
  // HTML entities
  s = s.replace(/&nbsp;/g, ' ');
  s = s.replace(/&amp;/g, '&');
  s = s.replace(/&lt;/g, '<');
  s = s.replace(/&gt;/g, '>');
  s = s.replace(/&quot;/g, '"');
  s = s.replace(/&#39;/g, "'");
  s = s.replace(/&#x27;/g, "'");
  // 压缩多空行
  s = s.replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
  return s;
}

/**
 * ADR-0021 P0-3: web 工具 LLM definition
 *   - web_search: 调 Brave Search API, 返回 markdown snippet 列表
 *   - web_fetch: 任意 URL GET 抓 HTML, 转 text 给 LLM
 *   - key 通过 config.webSearchKey (Tauri 从 keychain 读)
 *   - key 缺失 → tool 返回明确 error, LLM 知道去 Settings 配
 *   - 5min 内存 cache, 跟 ADR-0019 S-2 一致
 *
 * @param webSearchKey: Brave Search API key (来自 stdin config), null 表示 user 还没配
 * @returns ToolDefinition[] (0-2 个, key 缺失时只返回 web_fetch, web_search 给 error 提示)
 */
function loadWebTools(webSearchKey) {
  const tools = [];

  // ====== web_search: 调 Brave Search API ======
  tools.push({
    name: 'web_search',
    description: 'Search the web using Brave Search. Returns up to 10 results as markdown (title, url, description). Use this when the user asks about current events, latest versions, recent news, or any information that may have changed after the model\'s training cutoff. Requires a Brave Search API key configured in Settings → Web 搜索.',
    parameters: Type.Object({
      query: Type.String({ description: 'Search query (Brave Search supports the same syntax as a web search engine, e.g. "Pi Agent Desktop latest version" or "TypeScript 5.5 release notes")' }),
      count: Type.Optional(Type.Number({ description: 'Number of results to return (1-20, default 10)' })),
    }),
    execute: async (_toolCallId, params) => {
      const query = params?.query;
      if (typeof query !== 'string' || !query.trim()) {
        return { content: [{ type: 'text', text: 'Error: web_search 需要 query 参数 (非空字符串)' }] };
      }

      // key 缺失 → 明确报错
      if (!webSearchKey) {
        return { content: [{ type: 'text', text: 'Error: Brave Search API key 未配置. 请到 Settings → Web 搜索 录入 API key, 重启 Tauri.' }] };
      }

      // 缓存
      const count = Math.min(Math.max(params?.count ?? 10, 1), 20);
      const cacheKey = `search:${count}:${query}`;
      const cached = webCacheGet(cacheKey);
      if (cached) {
        console.error(`[web] cache hit: search "${query.slice(0, 60)}"`);
        return { content: [{ type: 'text', text: cached }] };
      }

      // 调 Brave API
      const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`;
      let response;
      try {
        response = await fetch(url, {
          method: 'GET',
          headers: {
            'X-Subscription-Token': webSearchKey,
            'Accept': 'application/json',
          },
          signal: AbortSignal.timeout(10_000),  // 10s 超时
        });
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: Brave Search API 调用失败 (网络错误): ${e instanceof Error ? e.message : String(e)}` }] };
      }

      if (!response.ok) {
        // 错误分类 (跟 P2-6 errorSanitizer 同思路)
        let hint = '';
        if (response.status === 401) hint = ' (API key 无效, 请检查 Settings → Web 搜索)';
        else if (response.status === 429) hint = ' (rate limit, 5 分钟后再试)';
        return { content: [{ type: 'text', text: `Error: Brave Search 返回 ${response.status}${hint}` }] };
      }

      let body;
      try {
        body = await response.json();
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: Brave Search 响应解析失败: ${e instanceof Error ? e.message : String(e)}` }] };
      }

      // 解析 results
      const results = body?.web?.results;
      if (!Array.isArray(results) || results.length === 0) {
        return { content: [{ type: 'text', text: `Brave Search 无结果: "${query}"` }] };
      }

      // 转 markdown
      const lines = [`# 搜索: ${query}\n`];
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const title = r.title || '(无标题)';
        const url = r.url || '';
        const desc = r.description || '';
        lines.push(`${i + 1}. [${title}](${url})\n   ${desc}\n`);
      }
      const md = lines.join('\n');

      // 缓存
      webCacheSet(cacheKey, md);
      console.error(`[web] search ok: "${query.slice(0, 60)}" → ${results.length} results`);
      return { content: [{ type: 'text', text: md }] };
    },
  });

  // ====== web_fetch: 抓 URL, HTML→text ======
  // 不需要 API key, 任何 URL 都能抓
  tools.push({
    name: 'web_fetch',
    description: 'Fetch a web page by URL and return the text content (HTML stripped). Use this when the user gives a specific URL and wants its content, or to read articles found via web_search. Output is truncated to 50KB.',
    parameters: Type.Object({
      url: Type.String({ description: 'Full URL to fetch, e.g. "https://github.com/user/repo"' }),
    }),
    execute: async (_toolCallId, params) => {
      const url = params?.url;
      if (typeof url !== 'string' || !url) {
        return { content: [{ type: 'text', text: 'Error: web_fetch 需要 url 参数' }] };
      }

      // 简单 URL 校验
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        return { content: [{ type: 'text', text: `Error: 无效 URL: ${url}` }] };
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { content: [{ type: 'text', text: `Error: 只支持 http/https, got ${parsed.protocol}` }] };
      }

      // 缓存
      const cacheKey = `fetch:${url}`;
      const cached = webCacheGet(cacheKey);
      if (cached) {
        console.error(`[web] cache hit: fetch ${url.slice(0, 80)}`);
        return { content: [{ type: 'text', text: cached }] };
      }

      // 抓
      let response;
      try {
        response = await fetch(url, {
          method: 'GET',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) PiAgent/0.7',
            'Accept': 'text/html,application/xhtml+xml,text/plain',
          },
          signal: AbortSignal.timeout(10_000),  // 10s 超时
        });
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: GET ${url} 失败: ${e instanceof Error ? e.message : String(e)}` }] };
      }

      if (!response.ok) {
        return { content: [{ type: 'text', text: `Error: GET ${url} 返回 ${response.status}` }] };
      }

      let html;
      try {
        html = await response.text();
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: 读取响应失败: ${e instanceof Error ? e.message : String(e)}` }] };
      }

      // HTML→text
      const text = htmlToText(html);
      const MAX_BYTES = 50_000;
      let output = text;
      if (text.length > MAX_BYTES) {
        output = text.slice(0, MAX_BYTES) + `\n\n[truncated, total ${text.length} bytes]`;
      }

      // 缓存
      webCacheSet(cacheKey, output);
      console.error(`[web] fetch ok: ${url.slice(0, 80)} → ${output.length} bytes`);
      return { content: [{ type: 'text', text: output }] };
    },
  });

  console.error(`[sidecar] P0-3 web tools: ${tools.length} loaded (webSearchKey configured: ${webSearchKey ? 'yes' : 'no'})`);
  return tools;
}

/**
 * 2026-08-21 P2-1: 加载 MCP server 列表 (跟 loadUserTools 同 pattern).
 *   读 <workspacePath>/.pi/mcp/*.json + <agentDir>/mcp/*.json
 *   workspace 优先 (同名时 workspace 覆盖 global)
 *   返回 McpServerClient[] (每个 client 包含一份 .pi/mcp/<name>.json 配置)
 *
 * 跟 P1-5 user tool 的差异:
 *   - 这里**不**做 connect / initialize, 那是 client.start() 干的事
 *   - 加载阶段只 parse JSON + 校验, 启动阶段才 spawn 子进程
 *   - 配置坏的文件 log warn + 跳过, 不影响其它 server
 */
function loadMcpServerConfigs(cwd, agentDir) {
  const seen = new Set();
  const configs = [];

  // 1. global scope: <agentDir>/mcp/*.json
  if (agentDir) {
    const globalDir = join(agentDir, 'mcp');
    if (existsSync(globalDir)) {
      try {
        for (const entry of readdirSync(globalDir)) {
          if (!entry.endsWith('.json')) continue;
          const config = tryParseMcpServerJson(join(globalDir, entry), 'global');
          if (config && !seen.has(config.name)) {
            seen.add(config.name);
            configs.push(config);
          }
        }
      } catch (e) {
        console.error(`[sidecar] P2-1: scan global mcp/ failed:`, e instanceof Error ? e.message : String(e));
      }
    }
  }
  // 2. workspace scope: <workspacePath>/.pi/mcp/*.json (同名覆盖 global)
  if (cwd) {
    const workspaceDir = join(cwd, '.pi', 'mcp');
    if (existsSync(workspaceDir)) {
      try {
        for (const entry of readdirSync(workspaceDir)) {
          if (!entry.endsWith('.json')) continue;
          const config = tryParseMcpServerJson(join(workspaceDir, entry), 'workspace');
          if (config) {
            if (seen.has(config.name)) {
              // workspace 覆盖 global: 删掉 global 那条
              const idx = configs.findIndex((c) => c.name === config.name);
              if (idx >= 0) configs.splice(idx, 1);
            }
            seen.add(config.name);
            configs.push(config);
          }
        }
      } catch (e) {
        console.error(`[sidecar] P2-1: scan workspace mcp/ failed:`, e instanceof Error ? e.message : String(e));
      }
    }
  }
  return configs;
}

function tryParseMcpServerJson(filePath, scope) {
  let body;
  try {
    body = readFileSync(filePath, 'utf-8');
  } catch (e) {
    console.error(`[sidecar] P2-1: read ${filePath} failed:`, e instanceof Error ? e.message : String(e));
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    console.error(`[sidecar] P2-1: parse ${filePath} failed (not valid JSON):`, e instanceof Error ? e.message : String(e));
    return null;
  }
  if (!parsed || typeof parsed !== 'object') {
    console.error(`[sidecar] P2-1: ${filePath} body 必须是 JSON object, 跳过`);
    return null;
  }
  if (typeof parsed.name !== 'string' || !parsed.name) {
    console.error(`[sidecar] P2-1: ${filePath} 缺 'name' 字段, 跳过`);
    return null;
  }
  // v0.6.3-rc1 P2-1.8: type 决定必填字段
  //   - stdio (default): command 必填
  //   - http / sse:     url 必填 (http:// 或 https:// 开头)
  // 之前只校验 command, http/sse config 会被这里拒绝. P2-1.8 修.
  const serverType = (typeof parsed.type === 'string') ? parsed.type : 'stdio';
  if (!['stdio', 'http', 'sse'].includes(serverType)) {
    console.error(`[sidecar] P2-1.8: ${filePath} type 必须是 'stdio' | 'http' | 'sse', got '${parsed.type}', 跳过`);
    return null;
  }
  if (serverType === 'stdio') {
    if (typeof parsed.command !== 'string' || !parsed.command) {
      console.error(`[sidecar] P2-1: ${filePath} type=stdio 缺 'command' 字段, 跳过`);
      return null;
    }
  } else {
    // http / sse
    if (typeof parsed.url !== 'string' || !parsed.url) {
      console.error(`[sidecar] P2-1.8: ${filePath} type=${serverType} 缺 'url' 字段, 跳过`);
      return null;
    }
    if (!parsed.url.startsWith('http://') && !parsed.url.startsWith('https://')) {
      console.error(`[sidecar] P2-1.8: ${filePath} type=${serverType} 的 'url' 必须是 http:// 或 https:// 开头, got '${parsed.url}', 跳过`);
      return null;
    }
  }

  // 校验 name 跟 builtin tool 不重 (跟 P1-5 一样, 防 mcp_<name>_<tool> 前缀撞 builtin)
  // 这里只查 mcp server 名字本身, 实际 LLM 看到的 tool 名字是 mcp_<server>_<tool>, 不会撞
  // 但 server name 也不能跟 builtin 重, 否则 tools 列表里 mcp_<server>_<tool> 会跟 builtin 同名前缀
  if (BUILTIN_TOOL_NAMES_P1_5.has(parsed.name)) {
    console.error(`[sidecar] P2-1: ${filePath} name '${parsed.name}' 跟 builtin tool 重, 跳过`);
    return null;
  }
  return {
    name: parsed.name,
    type: serverType,
    // stdio 时传 command, http/sse 时为 undefined (McpServerClient 按 type 分支取字段)
    command: typeof parsed.command === 'string' ? parsed.command : undefined,
    url: typeof parsed.url === 'string' ? parsed.url : undefined,
    args: Array.isArray(parsed.args) ? parsed.args : undefined,
    env: (parsed.env && typeof parsed.env === 'object') ? parsed.env : undefined,
    cwd: typeof parsed.cwd === 'string' ? parsed.cwd : undefined,
    timeout: typeof parsed.timeout === 'number' ? parsed.timeout : undefined,
    scope,
  };
}

/**
 * 2026-08-21 P2-1: 把 MCP tool 转 Pi SDK ToolDefinition.
 *   跟 P1-5 user tool 包装 builtin 的 pattern 类似, 但走 JSON-RPC tools/call.
 *   工具名加 mcp_<server>_<tool> 前缀, 防跟 builtin / user tool 撞名.
 *   description 加 "(MCP: serverName)" 标识, LLM 知道这是 MCP tool.
 *   parameters 走 jsonSchemaToTypeBox 把 MCP JSON Schema 转 Pi SDK TypeBox.
 *
 * @param mcpClients: 已经 start() 成功的 McpServerClient[]
 * @returns: ToolDefinition[] (跟 P1-5 user tool 同一个格式)
 */
function wrapMcpToolsAsCustomTools(mcpClients) {
  const out = [];
  for (const client of mcpClients) {
    const mcpTools = client.getTools();
    for (const mcpTool of mcpTools) {
      // LLM 看到的 tool name: mcp_<server>_<tool>
      // 例: server="filesystem", mcpTool.name="read_file" → "mcp_filesystem_read_file"
      const toolName = `mcp_${client.config.name}_${mcpTool.name}`;
      // parameters: MCP inputSchema (JSON Schema) → Pi SDK TypeBox
      const parameters = jsonSchemaToTypeBox(mcpTool.inputSchema);
      // description: 加 (MCP: serverName) 标识, LLM 知道这是 MCP tool 不是 builtin
      const description = mcpTool.description
        ? `${mcpTool.description} (MCP: ${client.config.name})`
        : `(MCP: ${client.config.name})`;
      // execute 闭包: 转发到 MCP server
      out.push({
        name: toolName,
        label: toolName,
        description,
        parameters,
        execute: async (toolCallId, params, signal, onUpdate, ctx) => {
          // Pi SDK 0.84.2 的 AgentToolResult.content 是 (TextContent | ImageContent)[]
          // MCP content 也是类似的数组, 直接转
          // 错误处理: throw 走 Pi SDK isError=true
          try {
            const result = await client.callTool(mcpTool.name, params ?? {});
            return mcpCallResultToAgentToolResult(result);
          } catch (e) {
            // v0.6.3-rc1 P2-6: 用 classifyToolError 翻译成 user 看得懂的分类 + 行动提示
            //   之前是 raw error message, user 看到 "fetch failed" 不知道是 key 过期还是 rate limit
            const timeoutMs = client.config.timeout;
            const classified = classifyToolError(e, { timeoutMs });
            console.error(`[sidecar] P2-6: MCP callTool failed (${toolName}): [${classified.category}] ${classified.original}`);
            throw new Error(formatToolError(classified));
          }
        },
      });
    }
  }
  return out;
}

/**
 * MCP tool/call 返回的 result.content 转 Pi SDK AgentToolResult.content.
 * MCP 三种 content type 映射:
 *   - 'text' → 直接 textContent
 *   - 'image' → imageContent (data 是 base64 字符串)
 *   - 'resource' → 暂时降级为 text (ResourceLink / EmbeddedResource 还没处理, P2.2 增强)
 *   isError 时只返回 1 个 text content 含错误消息 (跟 builtin tool 一致)
 */
function mcpCallResultToAgentToolResult(result) {
  if (result.isError) {
    const errText = (result.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n') || 'MCP tool returned isError=true (no content)';
    return {
      content: [{ type: 'text', text: `❌ MCP error: ${errText}` }],
    };
  }
  const content = [];
  for (const item of result.content ?? []) {
    if (item.type === 'text') {
      content.push({ type: 'text', text: item.text });
    } else if (item.type === 'image') {
      content.push({ type: 'image', data: item.data, mimeType: item.mimeType });
    } else if (item.type === 'resource') {
      // P2.2 增强: ResourceLink / EmbeddedResource 完整处理
      content.push({ type: 'text', text: `[MCP resource: ${JSON.stringify(item).slice(0, 200)}]` });
    }
  }
  if (content.length === 0) {
    // 兜底: MCP 返回空 content (正常返回但没数据)
    content.push({ type: 'text', text: '(MCP tool returned no content)' });
  }
  return { content };
}

/**
 * 2026-08-21 P2-1: 注册 sidecar 关闭时 stop 所有 MCP clients (SIGTERM 子进程, 防僵尸).
 *   走 process.on('exit' / 'SIGTERM' / 'SIGINT') 三个事件, 任一触发就 stop 所有 client.
 *   best-effort: stop 失败不抛 (子进程可能已死), exit 钩子同步执行不能 await, 用 Promise.race 加 timeout.
 *
 * v0.6.3-rc1 P2-2: 不再接 clients 参数, 内部读 mcpState.clients (保证 reload 后的 clients
 *   也会在 sidecar 关闭时被 stop). 同时关掉 fs watcher 防 fd 泄漏.
 */
function registerMcpCleanup() {
  const cleanup = () => {
    // 关 fs watcher
    if (mcpState.watcherClose) {
      try { mcpState.watcherClose(); } catch { /* ignore */ }
      mcpState.watcherClose = null;
    }
    // stop 所有 client
    for (const client of mcpState.clients) {
      try {
        // exit 钩子是同步, 不能 await. SDK close 内部 await child.kill, 但这里 fire-and-forget
        client.stop().catch(() => {});
      } catch {
        // ignore
      }
    }
  };
  // exit 事件: 进程正常退出 (Tauri killSidecar, normal exit)
  process.on('exit', cleanup);
  // SIGTERM: Tauri / OS 发送的 kill 信号
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(0);
  });
  // SIGINT: Ctrl+C (开发场景, 跑 sidecar 测时常用)
  process.on('SIGINT', () => {
    cleanup();
    process.exit(0);
  });
  // SIGHUP: 终端关闭 (Tauri 桌面端不常见, 但 dev 模式可能)
  process.on('SIGHUP', () => {
    cleanup();
    process.exit(0);
  });
  console.error(`[sidecar] P2-1: registered cleanup for MCP clients + watcher (SIGTERM/SIGINT/SIGHUP/exit)`);
}

function tryParseUserToolJson(filePath, builtinToolDefs) {
  let body;
  try {
    body = readFileSync(filePath, 'utf-8');
  } catch (e) {
    console.error(`[sidecar] P1-5: read ${filePath} failed:`, e instanceof Error ? e.message : String(e));
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    console.error(`[sidecar] P1-5: parse ${filePath} failed (not valid JSON):`, e instanceof Error ? e.message : String(e));
    return null;
  }
  if (!parsed || typeof parsed !== 'object') {
    console.error(`[sidecar] P1-5: ${filePath} body 必须是 JSON object, 跳过`);
    return null;
  }
  const { name, description, basedOn, args } = parsed;
  if (!name || typeof name !== 'string') {
    console.error(`[sidecar] P1-5: ${filePath} 缺 'name' 字段, 跳过`);
    return null;
  }
  if (!description || typeof description !== 'string') {
    console.error(`[sidecar] P1-5: ${filePath} 缺 'description' 字段, 跳过`);
    return null;
  }
  if (!basedOn || typeof basedOn !== 'string' || !BUILTIN_TOOL_NAMES_P1_5.has(basedOn)) {
    console.error(`[sidecar] P1-5: ${filePath} basedOn='${basedOn}' 不合法 (必须是 [read,write,edit,bash,ls,find,grep] 之一), 跳过`);
    return null;
  }
  if (!args || typeof args !== 'object') {
    console.error(`[sidecar] P1-5: ${filePath} 'args' 字段必须是 object, 跳过`);
    return null;
  }
  const builtinDef = builtinToolDefs[basedOn];
  if (!builtinDef) {
    // 理论上不会到这里 (basedOn 校验过了), 兜底
    console.error(`[sidecar] P1-5: ${filePath} builtin tool '${basedOn}' 不存在, 跳过`);
    return null;
  }
  // 包装 execute: merge preset args + LLM 调的 args, 调 builtin tool 的 execute
  const presetArgs = args;
  return {
    ...builtinDef,
    name,
    label: name,
    description,
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      const merged = { ...presetArgs, ...(params || {}) };
      return builtinDef.execute(toolCallId, merged, signal, onUpdate, ctx);
    },
  };
}

/**
 * 2026-08-20 P1-4: bash 命令分类.
 *   bash 工具的"破坏性 / 跨目录"风险之前只能靠 user 看 string 决定,体验差 + 容易看漏.
 *   改成 3 类:
 *     - read-only (白名单): grep / rg / ag / find / ls / cat / head / tail / less / wc / tree
 *       静默放行, 跟 P0-1 smart 模式对 read-only 工具的策略一致
 *     - destructive (黑名单): rm / mv / cp / chmod / chown / curl / wget / ssh
 *       / powershell / cmd / reg / dd / mkfs / fdisk / shutdown
 *       弹窗文案加 ⚠ 警告 (跟普通命令弹窗视觉区分)
 *     - 其它 (开发工具链): npm / git / node / tsc / python / cargo / make
 *       普通 confirm 弹窗, 现状
 *
 * 链式命令解析: 用 ; / && / || / | 拆, 每个 command 拿 first word 作为命令名.
 *   边缘情况 (e.g. `echo "rm -rf /"` 里 "rm" 是字符串) 接受误判, 弹窗视觉上 user 能看清.
 *   不做 AST 级别的解析, 得不偿失.
 */
const BASH_READ_ONLY_COMMANDS = new Set([
  'grep', 'rg', 'ag',  // search content
  'find', 'ls', 'tree',  // list files
  'cat', 'head', 'tail', 'less', 'more', 'wc',  // read file content
  'echo', 'printf',  // output (纯显示, 不影响文件)
  'pwd', 'whoami', 'date', 'env', 'set', 'type', 'which',  // environment info
  'git',  // git status / log / diff 都是 read, 写操作后面会有 destructive 拦截
  'npm', 'pnpm', 'yarn',  // install / test / run 都是开发流程, 不动 workspace 外
  'node', 'python', 'python3', 'ruby', 'go', 'rustc', 'cargo', 'make',
  'tsc', 'eslint', 'prettier',
  'file', 'stat', 'diff', 'md5sum', 'sha256sum',  // inspect
]);
const BASH_DESTRUCTIVE_COMMANDS = new Set([
  'rm', 'mv', 'cp',  // file ops
  'chmod', 'chown', 'chgrp',  // permission
  'curl', 'wget', 'fetch',  // network
  'ssh', 'scp', 'rsync', 'nc',  // remote
  'powershell', 'pwsh', 'cmd', 'cmd.exe',  // Windows shell
  'reg', 'regini',  // Windows registry
  'dd', 'mkfs', 'fdisk', 'format', 'diskpart',  // disk ops
  'shutdown', 'reboot', 'poweroff', 'init',  // system
  'kill', 'killall', 'taskkill',  // process
  'iptables', 'netsh', 'firewall',  // network config
  'sudo', 'su', 'runas',  // privilege escalation
  'eval', 'exec', 'source',  // arbitrary code execution
]);

/**
 * 解析 bash command string, 拆出命令名 (first word of each segment).
 * 简化: 按 shell 操作符 (; / && / || / |) 拆, trim, 拿每段第一个非空白 token.
 * 不处理嵌套引号 / 重定向 / 变量 — 边缘情况接受误判, 弹窗文案兜底.
 *
 * @returns {{ segments: string[], allReadOnly: boolean, anyDestructive: boolean, names: string[] }}
 *   - segments: 拆出的命令片段 (trim 后, 过滤空)
 *   - allReadOnly: 全部片段的第一个命令名都在 BASH_READ_ONLY_COMMANDS 里
 *   - anyDestructive: 任一片段的第一个命令名在 BASH_DESTRUCTIVE_COMMANDS 里
 *   - names: 所有抽出的命令名 (去重), 给弹窗文案用
 */
function parseBashCommand(commandString) {
  if (typeof commandString !== 'string' || !commandString.trim()) {
    return { segments: [], allReadOnly: false, anyDestructive: false, names: [] };
  }
  // 拆: ; / && / || / | (在 shell 里都是 command separator)
  // 不用 regex 全拆 — 简单 split, 接受 false positive
  const segments = commandString
    .split(/[;&|]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const names = new Set();
  let allReadOnly = true;
  let anyDestructive = false;
  for (const seg of segments) {
    // first word: 切到第一个空白 (空格 / tab)
    const firstWordMatch = seg.match(/^(\S+)/);
    if (!firstWordMatch) continue;
    const cmdName = firstWordMatch[1];
    // 去掉路径前缀 (e.g. /usr/bin/rm → rm, .\rm.cmd → rm.cmd)
    const baseName = cmdName.replace(/^.*[\\\/]/, '').toLowerCase();
    names.add(baseName);
    if (!BASH_READ_ONLY_COMMANDS.has(baseName)) {
      allReadOnly = false;
    }
    if (BASH_DESTRUCTIVE_COMMANDS.has(baseName)) {
      anyDestructive = true;
    }
  }
  return {
    segments,
    allReadOnly: segments.length > 0 && allReadOnly,
    anyDestructive,
    names: Array.from(names),
  };
}

function createPermissionExtension(permissionMode) {
  return (pi) => {
    pi.on('tool_call', async (event, ctx) => {
      // event.toolName, event.toolCallId, event.input
      const toolName = event.toolName;
      const toolArgs = event.input || {};
      const argsPreview = JSON.stringify(toolArgs).slice(0, 200);

      // v0.5.0-D 第2轮: workspace 沙箱 — write / edit 工具的 path 必须在 workspacePath
      //   之下, 否则 block 并附带 reason. 防止 LLM 误把文件写到 Pi Agent Desktop 自身目录
      //   (e.g. D:\UnityWork\Tools\Pi) 或其他无关位置 ("agent 把桌面端程序给改掉了" 用户反馈).
      //   - bash 工具无法静态检查 (command 字符串里可能塞路径), 由 permission mode 兜底.
      //   - read / ls / grep / find 通常不破坏, 不强制沙箱 (避免影响跨目录查询).
      // 注意: 沙箱检查放在 mode 分支之前, 跟 mode 无关 — 即使 allow 模式也不能写 workspace 外
      //   (P0-1 之前 allow 走的是 mode 分支早返回, 沙箱跳过了; 这是 ADR 已知妥协, 保留原行为).
      if ((toolName === 'write' || toolName === 'edit') && workspacePath) {
        const filePath = toolArgs.path || toolArgs.filePath;
        if (filePath && typeof filePath === 'string' && !isPathWithinWorkspace(filePath, workspacePath)) {
          const resolved = pathResolve(workspacePath, filePath);
          console.error(`[perm] BLOCK ${toolName} outside workspace: ${filePath} (resolved=${resolved}, workspace=${workspacePath})`);
          return {
            block: true,
            reason: `Path "${filePath}" is outside the active workspace "${workspacePath}". Use a path within the workspace, or switch workspace via the sidebar.`,
          };
        }
      }

      if (permissionMode === 'deny') {
        console.error(`[perm] deny ${toolName} (mode=deny)`);
        return { block: true, reason: 'Tool use denied (permission mode=deny)' };
      }

      // P0-1 修: 'smart' 模式 + read-only 工具 → 静默放行, 跟 ADR-0014 承诺对齐.
      // 之前这个分支缺失, smart 模式行为 = ask (每个 tool 都弹窗), 等于摆设.
      if (permissionMode === 'smart' && READ_ONLY_TOOLS.has(toolName)) {
        console.error(`[perm] smart auto-allow read-only ${toolName} args=${argsPreview}`);
        return undefined;
      }

      // 2026-08-20 P1-4: bash 命令分类 — 跟 P0-1 同样的 read-only 静默放行策略,
      //   但覆盖 bash 工具内部命令 (不仅限 builtin 工具名).
      //   - 全部是 read-only 命令 (grep / find / cat 等) → 静默放行, 不弹窗
      //   - 任一含破坏性命令 (rm / curl 等) → 弹窗文案加 ⚠ 警告 (跟 P1-1 弹窗链路无缝衔接)
      //   - 其它 → 普通 confirm 弹窗 (跟 ask 模式现状一致)
      // 适用于所有 permission mode (ask / smart / allow 兜底) — bash 分类是工具层策略,
      //   跟 mode 解耦. 但 mode=deny 早 return 不会到这里.
      if (toolName === 'bash') {
        const parsed = parseBashCommand(toolArgs.command || '');
        if (parsed.allReadOnly) {
          console.error(`[perm] P1-4: bash read-only auto-allow commands=[${parsed.names.join(', ')}] args=${argsPreview}`);
          return undefined;
        }
        if (parsed.anyDestructive) {
          console.error(`[perm] P1-4: bash has destructive commands=[${parsed.names.join(', ')}] args=${argsPreview}`);
        }
      }

      if (permissionMode === 'allow') {
        // 理论上不会到这里 (mode=allow 不传 extensionFactories), 兜底
        console.error(`[perm] allow ${toolName} (mode=allow fallback)`);
        return undefined;
      }

      // mode = 'ask' / 'smart'+ 写类工具 / 其他未知: 弹 confirm 弹窗
      // 2026-08-20 P1-4: bash 含破坏性命令时, 弹窗文案加 ⚠ 警告前缀, user 一眼识别高风险
      let confirmTitle = `Allow tool: ${toolName}`;
      let confirmMessage = JSON.stringify(toolArgs, null, 2);
      if (toolName === 'bash') {
        const parsed = parseBashCommand(toolArgs.command || '');
        if (parsed.anyDestructive) {
          confirmTitle = `⚠ Allow tool: ${toolName} (含破坏性命令)`;
          confirmMessage = `⚠ 检测到破坏性命令: [${parsed.names.join(', ')}]\n\n` +
            `完整命令:\n${JSON.stringify(toolArgs, null, 2)}\n\n` +
            `确认前请检查: 路径是否在 workspace 内 / 不会误删文件 / 不会调用外部网络`;
        }
      }
      console.error(`[perm] ask ${toolName} (mode=${permissionMode}) args=${argsPreview}`);
      // 2026-08-20 P1-1: confirm 链路埋点 — 排查 "弹窗 lost" 根因 (ADR 0008 / 0014 已知问题)
      //   4 个时点都 log: confirm 调用前 / resolved / rejected / throw
      //   每次带 PERM-LOST/PERM-OK 标记 + elapsed, dev 排查时直接 grep 这两个 tag
      //   lost 排查: 找到 PERM-LOST 但无 PERM-OK 对应 → 弹窗挂了, 走 P1-6 60s 超时兜底
      //   影响: 仅 console 输出, 不改主流程 (Tauri Rust 端 log::info 收集到 .tauri-debug.log)
      const permStart = Date.now();
      const permMark = `PERM-LOST: ${toolName} ${event.toolCallId.slice(0, 8)}`;
      try {
        const allowed = await ctx.ui.confirm(
          confirmTitle,
          confirmMessage,
        );
        const elapsed = Date.now() - permStart;
        if (allowed) {
          console.error(`[perm] PERM-OK: user allowed ${toolName} (elapsed=${elapsed}ms)`);
          return undefined;
        } else {
          console.error(`[perm] PERM-OK: user denied ${toolName} (elapsed=${elapsed}ms)`);
          return { block: true, reason: 'User denied permission' };
        }
      } catch (e) {
        const elapsed = Date.now() - permStart;
        // confirm 抛错 (e.g. RPC stream closed, FE disconnected) — 默认 block
        // P1-1: lost 的最可能根因 — confirm 等不到 user respond, RPC stream 断了
        console.error(`[perm] ${permMark}: confirm failed after ${elapsed}ms:`, e instanceof Error ? e.message : String(e));
        return { block: true, reason: `Permission prompt failed: ${e instanceof Error ? e.message : String(e)}` };
      }
    });
  };
}

/**
 * P1 #5: maxRounds Extension. 限制单次 user turn 内连续 tool call 数量.
 *
 * 工作流:
 *   - turn_start: 重置 toolCallCount = 0
 *   - tool_call: 计数 +1, 超过 maxRounds 就 block
 *
 * maxRounds 来源: config.modelMetadata.maxRounds (FE 配的 model metadata)
 *   - undefined / 0 / 负数 → 不限制 (走 Pi SDK 默认)
 *   - 正整数 → 限制
 *
 * 注意: maxRounds 是"连续 tool call 轮数", 跟"LLM thinking 步数"不完全等价 (一个 turn 里
 *   LLM 可能多次调工具). 这里按"tool_call event 计数"实现, 跟 FE 字段语义对齐.
 */
function createMaxRoundsExtension(maxRounds) {
  if (!maxRounds || maxRounds <= 0) {
    return null;  // 不限制, 不注册 extension (空跑浪费)
  }
  let toolCallCount = 0;
  return (pi) => {
    pi.on('turn_start', () => {
      toolCallCount = 0;
    });
    pi.on('tool_call', async (event, ctx) => {
      toolCallCount++;
      if (toolCallCount > maxRounds) {
        console.error(`[maxRounds] BLOCK tool call #${toolCallCount} (limit=${maxRounds}) tool=${event.toolName}`);
        return {
          block: true,
          reason: `Reached maxRounds limit (${maxRounds} continuous tool calls per user turn). If you need more iterations, ask the user for guidance or break the task into smaller steps.`,
        };
      }
      return undefined;
    });
  };
}

/**
 * ADR-0019 P0-2 (2026-08-23): 危险命令 deny list + 用户白名单 extension.
 *
 * 行为:
 *   - bash tool call → 检查 command 匹配 BUILTIN_DENY_LIST 任一条
 *   - 匹配 + 不在 whitelist → block with reason (LMM 收到 reason 后会改命令或要求加白名单)
 *   - 匹配 + 在 whitelist → 放行 + stderr log "[DANGEROUS_USED] pattern=xxx cmd=yyy" (供 chat UI 检测)
 *   - 不匹配 deny list → 放行
 *
 * 白名单是 user 在 Settings → 通用 → 高级权限 维护的 regex pattern 列表. 走 settings.json 的
 *   dangerousWhitelist 字段, Pi SDK 完全不知道, 我们自己用 (跟 P0-1 bash.path 同 pattern).
 *
 * 关键设计: block 的 reason 文案明确告诉 LLM 怎么改 (加白名单 / 改命令), 不要用模棱两可的拒绝.
 */
// ====== ADR-0020 P-Sec1.2 (2026-08-23): 审计日志 ======
//   持久化每次 bash tool call (allow / block 都写), 写到 <agentDir>/audit.log (JSONL)
//   rotate 策略: 单文件 > 10MB → audit.log.1 (覆盖旧的, 保留 1 份历史)
//   字段: ts (ISO8601), session, tool, command (truncate 1000 char), cwd, allowed,
//         block_reason, matched_pattern, whitelisted
//   错误降级: 写失败只 log 到 stderr, 不阻塞 LLM agent
const AUDIT_LOG_PATH = join(agentDir, 'audit.log');
const AUDIT_LOG_MAX_BYTES = 10 * 1024 * 1024;  // 10MB

function appendAuditLog(entry) {
  try {
    if (existsSync(AUDIT_LOG_PATH)) {
      const stat = statSync(AUDIT_LOG_PATH);
      if (stat.size > AUDIT_LOG_MAX_BYTES) {
        const rotated = AUDIT_LOG_PATH + '.1';
        if (existsSync(rotated)) {
          unlinkSync(rotated);
        }
        renameSync(AUDIT_LOG_PATH, rotated);
      }
    }
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      // command 截断到 1000 字符, 防 log 爆炸 (含 base64 之类奇葩命令)
      command: (entry.command || '').slice(0, 1000),
      ...entry,
    }) + '\n';
    appendFileSync(AUDIT_LOG_PATH, line, 'utf-8');
  } catch (e) {
    console.error(`[audit] failed to write: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function createDangerousCommandExtension(getWhitelist) {
  // 2026-08-23 bug fix: 之前工厂立即预编译 (line 1536), 跟 loadUserTools 填白名单有时序竞争 —
  //   createAgentSessionServices 跑的时候 (line 549) dangerousWhitelist 还是 [],
  //   编译出空 compiledWhitelist 锁死, 之后 push 进去也看不到.
  //   修: 传 getter + handler 内 lazy 编译, 第一次 tool_call 触发编译, 此时 loadUserTools 已跑完.
  //   缓存逻辑: 用 source 数组 length 当 key, list 变了就重编译 (覆盖未来热更场景).
  return (pi) => {
    let cachedCompiled = null;
    let cachedSourceLen = -1;  // 强制首次编译

    const getCompiledWhitelist = () => {
      const list = getWhitelist() || [];
      if (list.length !== cachedSourceLen || cachedCompiled === null) {
        const fresh = [];
        for (const item of list) {
          if (!item || typeof item.pattern !== 'string' || !item.pattern) continue;
          try {
            fresh.push(new RegExp(item.pattern, 'i'));
          } catch (e) {
            console.error(`[danger] invalid whitelist pattern "${item.pattern}": ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        cachedCompiled = fresh;
        cachedSourceLen = list.length;
        if (fresh.length > 0) {
          console.error(`[danger] whitelist: ${fresh.length} pattern(s) loaded (lazy compiled on first tool_call)`);
        }
      }
      return cachedCompiled;
    };

    pi.on('tool_call', async (event) => {
      if (event.toolName !== 'bash') return undefined;
      const command = event.input?.command;
      if (typeof command !== 'string' || !command) return undefined;

      // 默认值 (普通 bash 调用)
      let allowed = true;
      let blockReason = null;
      let matchedPattern = null;
      let whitelisted = false;

      // 检查 deny list
      const matchedDeny = BUILTIN_DENY_LIST.find((re) => re.test(command));
      if (matchedDeny) {
        matchedPattern = matchedDeny.source;
        // 检查 whitelist (lazy 编译, 第一次 tool_call 才真正 compile)
        const compiledWhitelist = getCompiledWhitelist();
        const isWhitelisted = compiledWhitelist.some((re) => re.test(command));
        if (isWhitelisted) {
          whitelisted = true;
          console.error(`[DANGEROUS_USED] whitelisted command allowed: pattern=${matchedDeny.source} cmd=${command.slice(0, 200)}`);
        } else {
          allowed = false;
          const preview = command.slice(0, 120);
          blockReason = `危险命令被沙箱拦截 (匹配: ${matchedDeny.source.slice(0, 60)}). 原命令前 120 字: ${preview}`;
          console.error(`[danger] BLOCK dangerous bash: ${matchedDeny.source} cmd=${preview}`);
        }
      }

      // ADR-0020 P-Sec1.2: 审计日志 (每次 bash 调用都记, 无论 allow/block)
      appendAuditLog({
        session: event.sessionId ?? 'unknown',
        tool: 'bash',
        command,
        cwd: process.cwd(),
        allowed,
        block_reason: blockReason,
        matched_pattern: matchedPattern,
        whitelisted,
      });

      if (!allowed) {
        return {
          block: true,
          reason: `危险命令被沙箱拦截 (匹配: ${matchedDeny.source.slice(0, 60)}).\n` +
            `原命令前 120 字: ${command.slice(0, 120)}\n\n` +
            `两种处理方式:\n` +
            `  1) 改写命令避免危险模式 (推荐, 95% 情况可以)\n` +
            `  2) 到 Settings → 通用 → 高级权限, 加白名单 (仅当用户明确想用此命令时)\n\n` +
            `内置检测: rm -rf / format / mkfs / dd if= / pipe-to-shell / fork bomb / shutdown 等.`,
        };
      }
      return undefined;
    });
  };
}

/**
 * v0.5.0-D 第2轮: workspace 沙箱 path 校验.
 *   - 把 filePath 跟 workspacePath 都 resolve 成绝对路径 (跨平台)
 *   - Windows 大小写不敏感 + 反斜杠统一转 /
 *   - 边界: filePath === workspacePath 视为在内部
 *   - 防 prefix 误判: workspace=D:\work, filePath=D:\workspace-evil\foo.txt → reject
 *     (path.resolve 已 normalize 掉 ../, 后续 startsWith(w + '/') 保证边界对齐)
 *
 * 2026-08-20 P1-2: 加 symlink 防御. 之前 path.resolve 不解析 symlink, 攻击者建一个
 *   workspace 内的 symlink 指向 C:\Windows\System32, LLM 写这个 symlink 实际写到 C 盘,
 *   沙箱被骗. 修: 走 readlink 链路解析真实路径, 真实路径再校验. 上限 10 层防死循环.
 *   workspacePath 不解析 (workspace 是合法的根目录, 不应该因为被 symlink 链到外面就被拒).
 */
function realpathNoFollow(p, maxDepth = 10) {
  // 把 p 的所有组件逐个 lstat, 是 symlink 就 readlink 拿真实目标, 拼到累积路径上.
  // 简化实现: 用 lstat 看 p 本身, 是 symlink 就 readlink 拼上去, 递归解析.
  let cur = p;
  for (let i = 0; i < maxDepth; i++) {
    let st;
    try {
      st = lstatSync(cur);
    } catch (e) {
      // 路径不存在 — 走 statSync (跨 symlink 解析, 跟 path.resolve 行为一致, 用于"目标应该存在但还没建"的写场景)
      try {
        return statSync(cur).isDirectory() ? cur : cur;
      } catch {
        return cur;  // 都查不到就返回原路径
      }
    }
    if (!st.isSymbolicLink()) return cur;  // 不是 symlink, 是真实路径
    let target;
    try {
      target = readlinkSync(cur);
    } catch (e) {
      return cur;  // readlink 失败 (Windows 上可能权限不足), 保守返回原路径
    }
    // 相对路径: 拼到当前路径的目录; 绝对路径: 直接用
    const isAbsolute = process.platform === 'win32'
      ? /^[A-Z]:/i.test(target) || target.startsWith('\\\\')
      : target.startsWith('/');
    cur = isAbsolute ? target : pathResolve(cur, '..', target);
  }
  // 超过 maxDepth, 可能是 symlink 环, 保守返回最后路径
  console.warn(`[perm] realpath: maxDepth ${maxDepth} reached, returning last path: ${cur}`);
  return cur;
}

function isPathWithinWorkspace(filePath, workspacePath) {
  try {
    const resolvedWorkspace = pathResolve(process.cwd(), workspacePath);
    const resolvedFile = pathResolve(resolvedWorkspace, filePath);
    // 2026-08-20 P1-2: filePath 走 realpath 解析真实路径, 防 symlink 绕过
    //   workspace 不解析 (workspace 本身被 symlink 链到外面也不应该被拒 — user 配置)
    const realFile = realpathNoFollow(resolvedFile);
    const normalize = process.platform === 'win32'
      ? (p) => p.replace(/\\/g, '/').toLowerCase()
      : (p) => p.replace(/\\/g, '/');
    const w = normalize(resolvedWorkspace).replace(/\/+$/, '');
    const f = normalize(realFile);
    if (f === w) return true;
    if (!f.startsWith(w + '/')) return false;
    return true;
  } catch (e) {
    console.error(`[perm] path check error:`, e instanceof Error ? e.message : String(e));
    return true; // 出错时保守放行, 避免误伤
  }
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
