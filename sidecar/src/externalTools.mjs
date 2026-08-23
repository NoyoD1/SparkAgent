// ADR-0023 P3-B (2026-08-23): External tools 框架
//
// 设计:
//   - user 在 <workspace>/.pi/tools/external/<name>/ 或 <agentDir>/tools/external/<name>/
//     drop 一个文件夹, 里面 manifest.json + 实际代码
//   - sidecar 启动时扫这两个目录, 读 manifest, 启 subprocess, 包成 Pi SDK ToolDefinition
//   - 跟 MCP 同款 stdio JSON-RPC 协议 (subprocess 跟 sidecar 走 stdin/stdout 通信)
//   - LLM 看到的 tool 跟 builtin 一样, 走 Pi SDK AgentToolResult.content
//
// JSON-RPC 协议 (跟 MCP 类似, 但简化):
//   subprocess → sidecar (stdout, 一行一个 JSON):
//     { "type": "ready" }                                       — 启动完成
//     { "id": "...", "type": "result", "content": [...] }       — tool call 成功
//     { "id": "...", "type": "error", "error": "..." }          — tool call 失败
//
//   sidecar → subprocess (stdin, 一行一个 JSON):
//     { "id": "...", "type": "call", "args": {...} }            — 调用 tool
//
// Pi SDK AgentToolResult.content 格式 (跟现有 web_* / mcp_* 一致):
//   - { type: "text", text: "..." }
//   - { type: "image", data: "<base64>", mimeType: "image/png" }
//
// Manifest schema:
//   {
//     "name": "tavily_search",                          // LLM 看到的 tool name (1-64 char, [A-Za-z0-9._-])
//     "description": "...",                             // LLM 看到的功能描述
//     "parameters": { "type": "object", "properties": {...}, "required": [...] },  // JSON Schema
//     "runtime": "python" | "node" | "bun",             // 解释器类型
//     "entry": "tavily_search.py",                      // 入口文件 (相对 manifest 所在目录)
//     "timeout": 30000                                  // 可选, tool call 超时 ms (默认 30000)
//   }
//
// 跟 builtin 22 tool / user tool / MCP tool 的关系:
//   - 全是 Pi SDK ToolDefinition, 走 createAgentSession 的 allCustomTools merge
//   - 命名空间: 不加前缀 (跟 user tool 一致, 不像 MCP 那样 mcp_<server>_<tool>)
//     user 自己保证不跟 builtin / user tool 撞名
//     dedupe by name: workspace 覆盖 global (跟 user tool 一致)

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { jsonSchemaToTypeBox } from './mcpClient.mjs';

// ====== ADR-0023 P3-E (2026-08-24): external tool registry ======
//   Pi SDK 0.84.2 启动时通过 ToolDefinition.execute 拿 closure 调到 subprocess,
//   但 user-driven 调用 (slash 选 tool, 直接 modal 调) 没法走 Pi SDK.
//   维护一份 name → { proc, manifest, scope } map, 暴露给 index.mjs file queue watcher
//   用, 让 Tauri 可以直接调 tool 而不走 LLM turn.
//
//   跟 P3-B ToolDefinition 共享同一个 subprocess 实例 (不重复 spawn), 跟 builtin 7 + MCP
//   tool 隔离 (builtin / MCP 不走这条路径).
const externalToolRegistry = new Map();

/**
 * ADR-0023 P3-E: 给 FE / Tauri 看 — 列出当前 sidecar 里所有 external tool 快照
 *   返回: [{ name, description, source, scope, parameters, runtime, entry }]
 *     - source: "browser" (内置 web_*) / "external" (user 装的)
 *     - scope: "global" / "workspace"
 *     - parameters: manifest 里的 JSON Schema object (空 {} 表示 no args)
 *
 *   browser_* 走 builtin 路径, 不在 registry 里, 但这里也列出来 (让 modal 知道这些
 *   也能 user-driven 调). 实际 user-driven 调走 builtin 的 execute 路径, 不走 file queue.
 */
export function getExternalToolsSnapshot() {
  const out = [];
  // 1. external tools (subprocess-backed)
  for (const [name, entry] of externalToolRegistry.entries()) {
    out.push({
      name,
      description: entry.manifest.description || '',
      source: 'external',
      scope: entry.scope,
      parameters: entry.manifest.parameters || { type: 'object', properties: {} },
      runtime: entry.manifest.runtime || '',
      entry: entry.manifest.entry || '',
    });
  }
  return out;
}

/**
 * ADR-0023 P3-E: 走 registry 直接调 tool (不经过 LLM)
 *   跟 ToolDefinition.execute 一样调 subprocess.call, 但 args 是 parsed JSON object.
 *   返 { ok, content, error }: ok=true 时 content 是 AgentToolResult.content array.
 *
 *   fail 模式:
 *     - unknown tool: { ok:false, error: "tool 'xxx' 未注册" }
 *     - subprocess crash: { ok:false, error: "CRASH: ..." }
 *     - timeout: { ok:false, error: "TIMEOUT: ..." }
 *   调用方 (file queue watcher) 把 error 写回 response.
 */
export async function callExternalToolByName(name, args) {
  const entry = externalToolRegistry.get(name);
  if (!entry) {
    return { ok: false, error: `tool '${name}' 未注册 (可能 subprocess 未启动或 scope 被覆盖)` };
  }
  try {
    const content = await entry.proc.call(args ?? {});
    return { ok: true, content: content ?? [] };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}

/**
 * Scan 2 个目录 (global + workspace), 给每个 manifest 启 subprocess, 包成 Pi SDK ToolDefinition.
 *
 * @param workspacePath 当前 active workspace 绝对路径 (可以 null, 表示没 workspace)
 * @param agentDir 全局 agent dir (通常 <user.home>/.pi/agent, 必有)
 * @param resolveSecretEnv ADR-0023 P3-C 注入: 把 manifest.env 里 keychain: 引用解析成明文
 *   (来自 index.mjs, 走 callTauriCommand("resolve_secrets") 通道)
 * @returns ToolDefinition[] (跟 builtin 22 tool 同样的 schema)
 */
export function loadExternalTools(workspacePath, agentDir, resolveSecretEnv) {
  const out = [];
  const seen = new Set();

  // 1. global scope: <agentDir>/tools/external/*/manifest.json
  if (agentDir) {
    const globalDir = join(agentDir, 'tools', 'external');
    scanAndAppend(globalDir, out, seen, 'global', resolveSecretEnv);
  }
  // 2. workspace scope: <workspacePath>/.pi/tools/external/*/manifest.json (同名覆盖 global)
  if (workspacePath) {
    const wsDir = join(workspacePath, '.pi', 'tools', 'external');
    scanAndAppend(wsDir, out, seen, 'workspace', resolveSecretEnv);
  }
  return out;
}

function scanAndAppend(dir, out, seen, scope, resolveSecretEnv) {
  if (!existsSync(dir)) return;
  let entries;
  try {
    entries = readdirSync(dir);
  } catch (e) {
    console.error(`[externalTools] scan ${dir} failed:`, e);
    return;
  }
  for (const entry of entries) {
    const fullDir = join(dir, entry);
    try {
      const stat = statSync(fullDir);
      if (!stat.isDirectory()) continue;
    } catch {
      continue;
    }
    const manifestPath = join(fullDir, 'manifest.json');
    if (!existsSync(manifestPath)) continue;
    const def = tryBuildToolFromManifest(manifestPath, scope, resolveSecretEnv);
    if (!def) continue;
    if (seen.has(def.name)) {
      // 同名: workspace 覆盖 global (跟 user tool 一致)
      const idx = out.findIndex((t) => t.name === def.name);
      if (idx >= 0) out.splice(idx, 1);
    }
    seen.add(def.name);
    out.push(def);
  }
}

/**
 * 读 manifest.json, 校验 schema, 启 subprocess, 包成 ToolDefinition.
 * 任何一步失败: log warn + return null, 不让一个坏 tool 拖垮其他 tool.
 */
async function tryBuildToolFromManifest(manifestPath, scope, resolveSecretEnv) {
  let manifest;
  try {
    const raw = readFileSync(manifestPath, 'utf-8');
    manifest = JSON.parse(raw);
  } catch (e) {
    console.error(`[externalTools] ${scope} ${manifestPath}: parse failed:`, e);
    return null;
  }

  // 1. 校验必填字段
  const { name, description, parameters, runtime, entry, timeout } = manifest;
  if (typeof name !== 'string' || !name) {
    console.error(`[externalTools] ${manifestPath}: missing or invalid 'name'`);
    return null;
  }
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    console.error(`[externalTools] ${manifestPath}: name '${name}' 含非法字符, 只能 [A-Za-z0-9._-]`);
    return null;
  }
  if (name.length > 64) {
    console.error(`[externalTools] ${manifestPath}: name 长度 ${name.length} > 64`);
    return null;
  }
  if (typeof description !== 'string' || !description) {
    console.error(`[externalTools] ${manifestPath}: missing 'description'`);
    return null;
  }
  if (typeof runtime !== 'string' || !['python', 'node', 'bun'].includes(runtime)) {
    console.error(`[externalTools] ${manifestPath}: runtime 必须是 python|node|bun, got '${runtime}'`);
    return null;
  }
  if (typeof entry !== 'string' || !entry) {
    console.error(`[externalTools] ${manifestPath}: missing 'entry'`);
    return null;
  }

  // 2. 校验 entry 文件存在
  const toolDir = dirname(manifestPath);
  const entryPath = resolve(toolDir, entry);
  if (!existsSync(entryPath)) {
    console.error(`[externalTools] ${manifestPath}: entry file '${entryPath}' 不存在`);
    return null;
  }

  // 3. parameters 走 jsonSchemaToTypeBox (跟 MCP 一致, 把 JSON Schema 转 Pi SDK TypeBox)
  let parametersTb;
  try {
    parametersTb = jsonSchemaToTypeBox(parameters ?? { type: 'object', properties: {} });
  } catch (e) {
    console.error(`[externalTools] ${manifestPath}: parameters 不是合法 JSON Schema:`, e);
    return null;
  }

  // 4. 启 subprocess
  // ADR-0023 P3-C: 解析 manifest.env 里的 keychain: 引用
  //   跟 MCP 同 pattern — 拿到明文 secret 后再传给 spawn
  //   注意: externalTools.mjs 不直接 import index.mjs (避免循环), resolveSecretEnv
  //   通过构造函数注入
  let resolvedEnv;
  try {
    if (manifest.env && typeof manifest.env === 'object' && Object.keys(manifest.env).length > 0) {
      resolvedEnv = await resolveSecretEnv(manifest.env);
    }
  } catch (e) {
    console.error(`[externalTools] ${name}: env 解析失败, 跳过这个 tool:`, e);
    return null;
  }

  const subprocess = new ExternalToolProcess({
    name,
    runtime,
    entryPath,
    toolDir,
    timeoutMs: typeof timeout === 'number' && timeout > 0 ? timeout : 30000,
    extraEnv: resolvedEnv,
  });

  // ready 是 async, 但我们不 await (tryBuildToolFromManifest 是 sync, ready 等价于 spawn OK)
  // 实际上 spawn 是 sync, ready 协议是 subprocess 发 stdout 第一行 {type:ready}
  // 如果 subprocess 启动后立即 crash (语法错等), 走 subprocess.error 事件
  // 整个外部 tool 不可用, 但其他 tool 不受影响
  if (!subprocess.spawnOk()) {
    // spawn 失败 (e.g. python3 不在 PATH), 不注册这个 tool
    return null;
  }

  // ADR-0023 P3-E: 注册到全局 registry, 让 user-driven 调用 (file queue 路径) 能找到
  //   注意: workspace 覆盖 global (line 92-95 scanAndAppend 已 splice), 所以同名只最后一个
  //   的 manifest 生效, registry 覆盖也只最后一个生效 (跟 scanAndAppend 行为一致)
  externalToolRegistry.set(name, { proc: subprocess, manifest, scope });
  console.error(`[externalTools] P3-E: registered '${name}' (scope=${scope}) for user-driven invoke`);

  // 5. 包成 Pi SDK ToolDefinition
  return {
    name,
    label: name,
    description: `${description} (external: ${scope})`,
    parameters: parametersTb,
    execute: async (_toolCallId, params) => {
      try {
        const content = await subprocess.call(params ?? {});
        return { content };
      } catch (e) {
        // throw 走 Pi SDK isError=true 路径 (跟 web_* / mcp_* 同 pattern)
        const msg = e instanceof Error ? e.message : String(e);
        // 区分 timeout / 业务错误
        if (msg.startsWith('TIMEOUT:')) {
          return { content: [{ type: 'text', text: `❌ External tool '${name}' timeout: ${msg.slice(8)}` }] };
        }
        if (msg.startsWith('CRASH:')) {
          return { content: [{ type: 'text', text: `❌ External tool '${name}' subprocess 崩溃: ${msg.slice(6)}` }] };
        }
        return { content: [{ type: 'text', text: `❌ External tool '${name}' 错误: ${msg}` }] };
      }
    },
  };
}

/**
 * External tool subprocess 管理 + stdio JSON-RPC.
 *
 * 生命周期:
 *   - spawn 同步启, 失败 → spawnOk() = false, 不注册
 *   - 启后等 {type:"ready"} 5s, 不等也不报错 (subprocess 第一次 call 时再 fail)
 *     简化: spawn 后立即标记 "ready 状态未知", 第一次 call 时 lazy 确认
 *   - 每次 tool call: 写一行 JSON 到 stdin, 等一行 JSON 从 stdout
 *   - subprocess 退出 / crash: 记录状态, 后续 call 返 CRASH 错误
 *   - timeout: setTimeout + kill subprocess + 返 TIMEOUT 错误
 */
class ExternalToolProcess {
  constructor({ name, runtime, entryPath, toolDir, timeoutMs, extraEnv }) {
    this.name = name;
    this.toolDir = toolDir;
    this.timeoutMs = timeoutMs;
    this.started = false;        // spawn 同步成功
    this.ready = false;          // subprocess 发过 {type:"ready"}
    this.crashed = false;        // subprocess 异常退出
    this.crashReason = '';
    this.pendingCalls = new Map();  // id → { resolve, reject, timer }
    this.stdoutBuf = '';
    this.stderrBuf = '';
    this.proc = null;

    // 找解释器
    const interpreter = findInterpreter(runtime);
    if (!interpreter) {
      console.error(`[externalTools] ${name}: 找不到 ${runtime} 解释器, 跳过`);
      this.spawnOkResult = false;
      return;
    }

    try {
      this.proc = spawn(interpreter, [entryPath], {
        cwd: toolDir,
        // ADR-0023 P3-C: extraEnv 是 manifest.env 经过 resolveSecretEnv 解析后的明文 secret dict,
        //   跟 process.env 合并, manifest 的值优先 (跟 MCP 同 pattern)
        env: { ...process.env, ...(extraEnv ?? {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      this.started = true;
      this.spawnOkResult = true;
      console.error(`[externalTools] ${name}: spawned (runtime=${runtime} entry=${entryPath} pid=${this.proc.pid})`);

      this.proc.stdout.on('data', (chunk) => this._onStdout(chunk));
      this.proc.stderr.on('data', (chunk) => this._onStderr(chunk));
      this.proc.on('error', (e) => this._onProcError(e));
      this.proc.on('exit', (code, signal) => this._onProcExit(code, signal));
    } catch (e) {
      console.error(`[externalTools] ${name}: spawn failed:`, e);
      this.spawnOkResult = false;
    }
  }

  spawnOk() {
    return this.spawnOkResult === true;
  }

  _onStdout(chunk) {
    this.stdoutBuf += chunk.toString('utf-8');
    // 按行切, 处理每行 JSON
    let nlIdx;
    while ((nlIdx = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, nlIdx).trim();
      this.stdoutBuf = this.stdoutBuf.slice(nlIdx + 1);
      if (!line) continue;
      this._handleLine(line);
    }
  }

  _onStderr(chunk) {
    const text = chunk.toString('utf-8');
    this.stderrBuf += text;
    // log 到 sidecar stderr, 不超过 4KB (防 spam)
    if (this.stderrBuf.length < 4096) {
      console.error(`[externalTools:${this.name} stderr] ${text.trimEnd()}`);
    }
  }

  _handleLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      console.error(`[externalTools:${this.name}] bad json line: ${line.slice(0, 200)}`);
      return;
    }
    if (msg.type === 'ready') {
      this.ready = true;
      console.error(`[externalTools:${this.name}] ready (pid=${this.proc?.pid})`);
      return;
    }
    if (msg.id && this.pendingCalls.has(msg.id)) {
      const { resolve, reject, timer } = this.pendingCalls.get(msg.id);
      clearTimeout(timer);
      this.pendingCalls.delete(msg.id);
      if (msg.type === 'result') {
        // content: Pi SDK AgentToolResult.content 数组
        resolve(msg.content ?? []);
      } else if (msg.type === 'error') {
        reject(new Error(msg.error ?? 'unknown external tool error'));
      } else {
        reject(new Error(`Unknown message type from external tool: ${msg.type}`));
      }
    }
  }

  _onProcError(e) {
    console.error(`[externalTools:${this.name}] proc error:`, e);
    this.crashed = true;
    this.crashReason = e.message ?? String(e);
    // reject 所有 pending
    for (const [id, { reject, timer }] of this.pendingCalls) {
      clearTimeout(timer);
      reject(new Error(`CRASH: ${this.crashReason}`));
    }
    this.pendingCalls.clear();
  }

  _onProcExit(code, signal) {
    if (code !== 0 && !this.crashed) {
      console.error(`[externalTools:${this.name}] unexpected exit: code=${code} signal=${signal}`);
      this.crashed = true;
      this.crashReason = `exit code=${code} signal=${signal}`;
    }
    // reject 所有 pending (即使 code=0, 也 reject 因为是 tool 调用中途退出)
    for (const [id, { reject, timer }] of this.pendingCalls) {
      clearTimeout(timer);
      reject(new Error(`CRASH: subprocess exited (code=${code} signal=${signal})`));
    }
    this.pendingCalls.clear();
  }

  /**
   * 调 tool, 返 Pi SDK AgentToolResult.content 数组.
   * 失败抛 Error (caller 决定怎么渲染, 通常 catch 后转 text content 走 isError).
   */
  async call(args) {
    if (!this.started) {
      throw new Error('subprocess 未启动');
    }
    if (this.crashed) {
      throw new Error(`CRASH: ${this.crashReason}`);
    }
    if (!this.proc || !this.proc.stdin || this.proc.stdin.destroyed) {
      throw new Error('subprocess stdin 不可写');
    }

    const id = randomUUID();
    const payload = JSON.stringify({ id, type: 'call', args }) + '\n';

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCalls.delete(id);
        // 超时: kill subprocess 释放资源
        try { this.proc?.kill(); } catch {}
        reject(new Error(`TIMEOUT: tool call 超时 ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      this.pendingCalls.set(id, { resolve, reject, timer });
      try {
        this.proc.stdin.write(payload, (err) => {
          if (err) {
            clearTimeout(timer);
            this.pendingCalls.delete(id);
            reject(new Error(`stdin write 失败: ${err.message}`));
          }
        });
      } catch (e) {
        clearTimeout(timer);
        this.pendingCalls.delete(id);
        reject(new Error(`stdin write 异常: ${e instanceof Error ? e.message : String(e)}`));
      }
    });
  }

  /**
   * 关闭 subprocess (sidecar 关闭时调, 防僵尸进程)
   */
  kill() {
    if (this.proc && !this.proc.killed) {
      try { this.proc.kill(); } catch {}
    }
  }
}

/**
 * 找 runtime 解释器.
 * - python: 试 python3 / python / py (Windows 上有 launcher)
 * - node: 试 node (PATH 查找)
 * - bun: 试 bun (跟 sidecar 同 runtime, 优先)
 */
function findInterpreter(runtime) {
  // 跟现有 PATH 查找一致, 不强制 absolute path
  // subprocess 用 shell: false spawn, 解释器名直接走 PATH
  switch (runtime) {
    case 'python': return pickFirst(['python3', 'python', 'py']);
    case 'node':   return pickFirst(['node']);
    case 'bun':    return pickFirst(['bun']);
    default:       return null;
  }
}

function pickFirst(candidates) {
  for (const c of candidates) {
    if (commandExists(c)) return c;
  }
  return null;
}

function commandExists(cmd) {
  // 简化: 用 spawn 试 --version, 成功就算存在
  try {
    const r = spawnSync(cmd, ['--version'], { stdio: 'ignore', windowsHide: true });
    return r.status === 0;
  } catch {
    return false;
  }
}
