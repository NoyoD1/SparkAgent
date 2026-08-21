/**
 * 2026-08-21 v0.6.3-rc1 P2-1: MCP servers Pinia store
 *
 * 数据:
 *   - servers: Tauri 端 list_mcp_servers 返回的 MCP server 配置列表 (含 workspace + global 两层 scope)
 *
 * 集成:
 *   - 跟 Skills / Commands / User tools 一样, 存储走 Tauri command (Rust 端读写 .json 文件)
 *   - UI: Settings → MCP tab (新 tab, 跟 Tools tab 同级, 取代原来的"扩展 / MCP"占位)
 *   - sidecar 启动时自动加载 MCP server JSON 文件, spawn 每个 server, 走 @modelcontextprotocol/sdk
 *     拉 tools/list 转 Pi SDK ToolDefinition (mcp_<server>_<tool> 前缀), merge 到 LLM 可见的 tools list
 *
 * 跟 builtin tool / user tool 的关系:
 *   - builtin 7 个 (read/write/edit/bash/ls/find/grep) 是 Pi SDK 内置, 不存文件
 *   - user tool 是 builtin 的"args 预设包装", 存文件, 派生 builtin
 *   - MCP server 是独立的子进程, 走 JSON-RPC 协议跟 sidecar 通信, 由 MCP server 自己提供 tool
 *
 * 不存 localStorage: MCP server JSON 文件本身就是 source of truth (workspace/.pi/mcp/*.json),
 *   Tauri command 写文件, FE 调 refresh() 重新拉 list.
 */
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { piTauri, type TauriMcpServerInfo } from '@/lib/tauri';
import { useSessionStore } from './session';

export type McpServerScope = 'workspace' | 'global';

// 跟 Rust 端 parse_mcp_server_name / BUILTIN_TOOL_NAMES 校验同步
export const BUILTIN_TOOL_NAMES_MCP = ['read', 'write', 'edit', 'bash', 'ls', 'find', 'grep'] as const;

export const useMcpServersStore = defineStore('mcpServers', () => {
  // 列表 (含 workspace + global, workspace 优先, 跟 Rust 端 list_mcp_servers 一致)
  const servers = ref<TauriMcpServerInfo[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);

  /**
   * 拉取 MCP server 列表. 从当前 active workspace + agentDir 拉.
   * 跟 Skills/Commands/User tools 同 pattern: 写完/导入后立刻 refresh, 不等 sidecar 重启.
   */
  async function refresh() {
    const wsPath = await ensureActiveWorkspace();
    loading.value = true;
    error.value = null;
    try {
      servers.value = await piTauri.listMcpServers({
        workspacePath: wsPath,
        agentDir: null,
      });
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
      console.error('[mcpServers] refresh failed', e);
    } finally {
      loading.value = false;
    }
  }

  /**
   * 2026-08-21 v0.6.3-rc1 P2-1.2: 确保有 active workspace.
   *   - 如果 sessionStore.activeWorkspace 有, 用它
   *   - 没有但 workspaces 列表非空, 用第一个 (跟 sessionStore.activeWorkspace computed 行为一致)
   *   - 都没有, 调 Tauri ensureDefaultWorkspace 建默认 + addWorkspace
   *   - 全程 log, 排查 "list 拿 None" 之类的 bug
   *
   * 返回: 实际用的 workspace path (永不返回 null, 失败 throw)
   */
  async function ensureActiveWorkspace(): Promise<string> {
    const sessionStore = useSessionStore();
    let ws = sessionStore.activeWorkspace;
    if (ws) {
      console.log('[mcpServers] ensureActiveWorkspace: hit active, path=', ws.path);
      return ws.path;
    }
    if (sessionStore.workspaces.length > 0) {
      // 没 active 但有 workspaces, 选第一个 (跟 computed activeWorkspace 一致)
      const first = sessionStore.workspaces[0];
      sessionStore.activeWorkspaceId = first.id;
      console.log('[mcpServers] ensureActiveWorkspace: no active, fall back to workspaces[0]=', first.path);
      return first.path;
    }
    // 啥都没, 建默认
    console.log('[mcpServers] ensureActiveWorkspace: no workspaces, calling Tauri ensureDefaultWorkspace');
    try {
      const path = await piTauri.ensureDefaultWorkspace();
      const newWs = sessionStore.addWorkspace({ path, isDefault: true });
      sessionStore.activeWorkspaceId = newWs.id;
      console.log('[mcpServers] ensureActiveWorkspace: created default, path=', path);
      return path;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`无法创建默认工作区 (MCP 需要工作区才能读写): ${msg}`);
    }
  }

  /**
   * 读 MCP server 完整 JSON body. 给编辑 dialog 用 (填默认值).
   */
  async function read(scope: McpServerScope, name: string): Promise<string> {
    const wsPath = await ensureActiveWorkspace();
    return await piTauri.readMcpServer({
      scope,
      workspacePath: wsPath,
      agentDir: null,
      name,
    });
  }

  /**
   * 写 MCP server JSON. name / command / args / env / cwd / timeout 校验由 Rust 端
   *   validate_mcp_server_body 兜底, FE 端做基本检查给用户即时反馈.
   *
   * 走 active workspace (跟 P2-1.2 之前行为一致). 如果 user 在 dialog 选了别的 workspace
   *   或要写 global scope, 用 writeWithPath 显式传路径.
   */
  async function write(scope: McpServerScope, name: string, body: string): Promise<string> {
    validateName(name);
    validateBody(body);
    const wsPath = await ensureActiveWorkspace();
    return await piTauri.writeMcpServer({
      scope,
      workspacePath: wsPath,
      agentDir: null,
      name,
      body,
    });
  }

  /**
   * v0.6.3-rc1 P2-1.4: 显式传 workspace / agent dir 的 write (绕开 ensureActiveWorkspace).
   *   - workspace scope: 传 wsPath (用户从 dialog 选中的那个, 不一定是 active)
   *   - global scope: 传 agDir (Tauri 端兜底逻辑会用 <user.home>/.pi/agent)
   *   不做 ensureActiveWorkspace, 让 caller 完全控制路径.
   */
  async function writeWithPath(
    scope: McpServerScope,
    name: string,
    body: string,
    workspacePath: string | null,
    agentDir: string | null,
  ): Promise<string> {
    validateName(name);
    validateBody(body);
    if (scope === 'workspace' && !workspacePath) {
      throw new Error('workspace scope 需要 workspacePath (请先选择工作区)');
    }
    if (scope === 'global' && !agentDir) {
      throw new Error('global scope 需要 agentDir (Tauri 端应该用 <user.home>/.pi/agent 兜底, 但这次没拿到)');
    }
    return await piTauri.writeMcpServer({
      scope,
      workspacePath,
      agentDir,
      name,
      body,
    });
  }

  async function remove(scope: McpServerScope, name: string): Promise<boolean> {
    const wsPath = await ensureActiveWorkspace();
    return await piTauri.deleteMcpServer({
      scope,
      workspacePath: wsPath,
      agentDir: null,
      name,
    });
  }

  /**
   * 2026-08-21 v0.6.3-rc1 P2-1: 批量导入 MCP server (JSON 方式).
   *   - 解析 + 校验 (走 lib/mcpImport.ts, 支持 3 种格式 auto-detect)
   *   - 冲突检测: 跟当前列表里 name 撞的默认 SKIP (不覆盖, 保护 user 已有配置)
   *   - 全部走 store.write, 一次 refresh
   *
   * 返回: { imported: name[], skipped: [{name, reason}], failed: [{name, reason}] }
   *   - imported: 成功写入的 server name 列表
   *   - skipped: 因为跟现有冲突被跳过的 (name + reason)
   *   - failed: 写入过程中 Tauri 报错的 (单个 server 失败不影响其它)
   *
   * 调用方根据返回值给 user 展示反馈 (toast / dialog summary).
   */
  async function importServers(
    serversToImport: Array<{ name: string; body: string }>,
    scope: McpServerScope,
  ): Promise<{
    imported: string[];
    skipped: Array<{ name: string; reason: string }>;
    failed: Array<{ name: string; reason: string }>;
  }> {
    // 先 refresh 一次拿到最新列表, 避免 stale data 导致误判冲突
    await refresh();
    const existingNames = new Set(servers.value.map((s) => s.name));

    const imported: string[] = [];
    const skipped: Array<{ name: string; reason: string }> = [];
    const failed: Array<{ name: string; reason: string }> = [];

    for (const { name, body } of serversToImport) {
      if (existingNames.has(name)) {
        skipped.push({
          name,
          reason: `已存在 (scope=${servers.value.find((s) => s.name === name)?.scope ?? '?'}), 跳过 — 如需覆盖请先删除旧的`,
        });
        continue;
      }
      try {
        await write(scope, name, body);
        imported.push(name);
        existingNames.add(name);  // 同一 batch 内的重复也防住
      } catch (e) {
        failed.push({
          name,
          reason: e instanceof Error ? e.message : String(e),
        });
      }
    }

    // 写完整体 refresh 一次, 让 UI 看到最新列表
    if (imported.length > 0) {
      await refresh();
    }

    return { imported, skipped, failed };
  }

  /**
   * 构造一个新 MCP server 的默认 JSON body. 给"新建"按钮用:
   *   user 点 "新建" → 弹 dialog 表单填 name / command / args / env
   *   默认 body = { name, command: 'node', args: [], env: {} }
   *   user 填好后保存到 <workspace>/.pi/mcp/<name>.json
   */
  function buildDefaultBody(name: string, command: string, args: string[]): string {
    const body = {
      type: 'stdio',
      name,
      command,
      args,
      env: {},
      timeout: 30000,
    };
    return JSON.stringify(body, null, 2);
  }

  /**
   * v0.6.3-rc1 P2-1.3: 拼装 MCP server body (form 模式用, 接受 type + env).
   *   - type 必填, 必须是 stdio | http | sse
   *   - HTTP/SSE 暂时不实现 (sidecar 只接 stdio), 但 UI 允许写 (P2.3 接上)
   *
   * @param params 含 type/name/command/args/env/timeout
   * @returns 完整 JSON body string
   */
  function buildBodyFromForm(params: {
    type: 'stdio' | 'http' | 'sse';
    name: string;
    command: string;
    args: string[];
    env: Record<string, string>;
    timeout?: number;
  }): string {
    const body: Record<string, unknown> = {
      type: params.type,
      name: params.name,
      command: params.command,
      args: params.args,
      env: params.env,
    };
    if (params.timeout !== undefined) body.timeout = params.timeout;
    return JSON.stringify(body, null, 2);
  }

  return {
    // state
    servers,
    loading,
    error,
    // actions
    refresh,
    read,
    write,
    writeWithPath,  // v0.6.3-rc1 P2-1.4: dialog 显式传 workspace / agent dir (绕开 ensureActiveWorkspace)
    remove,
    importServers,
    buildDefaultBody,
    buildBodyFromForm,  // v0.6.3-rc1 P2-1.3: form 模式拼 body
    ensureActiveWorkspace,  // v0.6.3-rc1 P2-1.2: UI 用来同步 ws path 显示 + 排查
    // 暴露给 UI
    BUILTIN_TOOL_NAMES_MCP,
  };
});

/**
 * FE 端 name 预校验 (跟 Rust 端 parse_mcp_server_name 一致).
 *  规则: 1-64 char, [A-Za-z0-9._@-], 不跟 builtin 7 个重
 */
function validateName(name: string) {
  if (!name || name.length < 1 || name.length > 64) {
    throw new Error(`mcp server name 长度必须 1-64, got ${name.length}`);
  }
  if (!/^[A-Za-z0-9._@-]+$/.test(name)) {
    throw new Error(`mcp server name 只能含 [A-Za-z0-9._@-], got '${name}'`);
  }
  if (name === '.' || name === '..') {
    throw new Error("mcp server name 不能是 '.' 或 '..'");
  }
  if ((BUILTIN_TOOL_NAMES_MCP as readonly string[]).includes(name)) {
    throw new Error(`mcp server name '${name}' 跟 builtin tool 重名, 加个前缀 (e.g. mcp_${name})`);
  }
}

/**
 * FE 端 body 预校验 (跟 Rust 端 validate_mcp_server_body 一致).
 *  必填: name (string) + command (string, 非空)
 *  可选: type (stdio | http | sse, 默认 stdio), args (string[]), env (Record<string, string>),
 *        cwd (string), timeout (number)
 */
function validateBody(body: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    throw new Error(`mcp server body 不是合法 JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('mcp server body 必须是 JSON object');
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.name !== 'string' || !obj.name) {
    throw new Error("mcp server body 缺 'name' 字段或为空");
  }
  if (typeof obj.command !== 'string' || !obj.command) {
    // v0.6.3-rc1 P2-1.8: type=http/sse 时允许没 command (改用 url)
    const t = obj.type;
    if (t === 'http' || t === 'sse') {
      // 允许 command 缺失 (http/sse 走 url)
    } else {
      throw new Error("mcp server body (type=stdio) 缺 'command' 字段或为空");
    }
  }
  if (obj.args !== undefined) {
    if (!Array.isArray(obj.args)) {
      throw new Error("mcp server body 'args' 字段必须是 array");
    }
    for (let i = 0; i < obj.args.length; i++) {
      if (typeof obj.args[i] !== 'string') {
        throw new Error(`mcp server body 'args[${i}]' 必须是 string`);
      }
    }
  }
  if (obj.env !== undefined) {
    if (!obj.env || typeof obj.env !== 'object' || Array.isArray(obj.env)) {
      throw new Error("mcp server body 'env' 字段必须是 object");
    }
    for (const [k, v] of Object.entries(obj.env)) {
      if (typeof v !== 'string') {
        throw new Error(`mcp server body 'env.${k}'' 必须是 string`);
      }
    }
  }
  if (obj.cwd !== undefined && typeof obj.cwd !== 'string') {
    throw new Error("mcp server body 'cwd' 字段必须是 string");
  }
  if (obj.timeout !== undefined && typeof obj.timeout !== 'number') {
    throw new Error("mcp server body 'timeout' 字段必须是 number");
  }
  // v0.6.3-rc1 P2-1.3: type 校验
  if (obj.type !== undefined) {
    if (typeof obj.type !== 'string') {
      throw new Error("mcp server body 'type' 字段必须是 string");
    }
    if (!['stdio', 'http', 'sse'].includes(obj.type)) {
      throw new Error("mcp server body 'type' 必须是 'stdio' | 'http' | 'sse'");
    }
    // v0.6.3-rc1 P2-1.8: 跨字段校验 — http/sse 必填 url, stdio 必填 command
    if (obj.type === 'http' || obj.type === 'sse') {
      const url = obj.url;
      if (typeof url !== 'string' || !url) {
        throw new Error(`mcp server body (type=${obj.type}) 缺 'url' 字段或不是 string`);
      }
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        throw new Error(`mcp server body 'url' 必须是 http:// 或 https:// 开头, got '${url}'`);
      }
    } else if (obj.type === 'stdio') {
      if (typeof obj.command !== 'string' || !obj.command) {
        throw new Error("mcp server body (type=stdio) 缺 'command' 字段或为空");
      }
    }
  }
  // v0.6.3-rc1 P2-1.8: url 字段类型校验 (兜底, type 缺失时也能识别)
  if (obj.url !== undefined) {
    if (typeof obj.url !== 'string') {
      throw new Error("mcp server body 'url' 字段必须是 string");
    }
  }
}
