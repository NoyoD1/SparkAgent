/**
 * 2026-08-20 P1-5: User tools Pinia store
 *
 * 数据:
 *   - tools: Tauri 端 list_user_tools 返回的 user-defined tool 列表 (含 workspace + global 两层 scope)
 *
 * 集成:
 *   - 跟 Skills / Commands 一样, 存储走 Tauri command (Rust 端读写 .json 文件)
 *   - UI: Settings → Tools tab (新 tab, 跟 Skills/Commands/CustomInstructions 同级)
 *   - sidecar 启动时自动加载 user tool JSON 文件, 包装 builtin tool 的 ToolDefinition,
 *     通过 customTools 参数 merge 到 LLM 可见的 tools list (详见 sidecar/src/index.mjs loadUserTools)
 *
 * 跟 builtin tool 的关系:
 *   - builtin 7 个 (read/write/edit/bash/ls/find/grep) 是 Pi SDK 内置, 不存文件, LLM 永远可见
 *   - user tool 是 builtin 的"args 预设包装", 存文件, 派生时填 description + basedOn + args
 *   - LLM 调 user tool → sidecar 拦截 (其实是 Pi SDK 调 customTool execute) → 合并 preset args
 *     + LLM 传的 args → 调 builtin tool 的 execute
 *
 * 不存 localStorage: user tool 文件本身就是 source of truth (workspace/.pi/tools/*.json),
 *   Tauri command 写文件, FE 调 refresh() 重新拉 list. 跟 Skills refreshFromTauri 同 pattern.
 */
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { piTauri, type TauriUserToolInfo } from '@/lib/tauri';
import { useSessionStore } from './session';

export const BUILTIN_TOOL_NAMES = ['read', 'write', 'edit', 'bash', 'ls', 'find', 'grep'] as const;
export type BuiltinToolName = typeof BUILTIN_TOOL_NAMES[number];

export const BUILTIN_TOOL_LABEL: Record<BuiltinToolName, string> = {
  read: '读取文件',
  write: '写入文件',
  edit: '编辑文件',
  bash: '执行命令',
  ls: '列出目录',
  find: '查找文件',
  grep: '搜索内容',
};

export type UserToolScope = 'workspace' | 'global';

export const useUserToolsStore = defineStore('userTools', () => {
  // 列表 (含 workspace + global, workspace 优先, 跟 Rust 端 list_user_tools 一致)
  const tools = ref<TauriUserToolInfo[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);

  /**
   * 拉取 user tool 列表. 从当前 active workspace + agentDir 拉.
   * 跟 Skills/Commands 同 pattern: 写完/导入后立刻 refresh, 不等 sidecar 重启.
   */
  async function refresh() {
    const sessionStore = useSessionStore();
    const ws = sessionStore.activeWorkspace;
    // agentDir 跟 Skills/Commands 一样, 从 settings.json? 不, agentDir 是固定的 OS 路径
    //   (Pi SDK 0.84.2 getAgentDir() = <userHome>/.pi/agent 或 <APPDATA>/pi-agent)
    //   FE 端没有直接 invoke getAgentDir, 但 Rust 端 list_user_tools / read / write / delete
    //   接受 agentDir=null 时 fallback. 这里我们直接传 null, 让 Rust 端 fallback.
    loading.value = true;
    error.value = null;
    try {
      tools.value = await piTauri.listUserTools({
        workspacePath: ws?.path ?? null,
        agentDir: null,
      });
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
      console.error('[userTools] refresh failed', e);
    } finally {
      loading.value = false;
    }
  }

  /**
   * 读 user tool 完整 JSON body. 给派生 dialog 用 (填默认值).
   */
  async function read(scope: UserToolScope, name: string): Promise<string> {
    const sessionStore = useSessionStore();
    return await piTauri.readUserTool({
      scope,
      workspacePath: sessionStore.activeWorkspace?.path ?? null,
      agentDir: null,
      name,
    });
  }

  /**
   * 写 user tool JSON. name / basedOn / args 校验由 Rust 端 validate_user_tool_body 兜底,
   *   FE 端做基本检查 (name 1-64 char, name 跟 builtin 不重) 给用户即时反馈.
   */
  async function write(scope: UserToolScope, name: string, body: string): Promise<string> {
    // FE 端预校验 (跟 Rust 端 parse_user_tool_name / BUILTIN_TOOL_NAMES 一致)
    validateName(name);
    validateBody(body);
    const sessionStore = useSessionStore();
    const result = await piTauri.writeUserTool({
      scope,
      workspacePath: sessionStore.activeWorkspace?.path ?? null,
      agentDir: null,
      name,
      body,
    });
    // ADR-0023: user tool 改动 → restart sidecar (Pi SDK tool list 重新注册)
    void triggerRestart('user_tool_changed');
    return result;
  }

  async function remove(scope: UserToolScope, name: string): Promise<boolean> {
    const sessionStore = useSessionStore();
    const result = await piTauri.deleteUserTool({
      scope,
      workspacePath: sessionStore.activeWorkspace?.path ?? null,
      agentDir: null,
      name,
    });
    // ADR-0023: user tool 改动 → restart sidecar
    void triggerRestart('user_tool_changed');
    return result;
  }

  /**
   * ADR-0023 (2026-08-23): 静默重启 sidecar (fire-and-forget)
   *   跟 mcpServers.triggerRestart 同 pattern, 改 user tool 也要 restart
   *   才能让 LLM 看到新 tool 列表.
   */
  async function triggerRestart(reason: string): Promise<void> {
    try {
      await piTauri.restartAllSidecars(reason);
    } catch (e) {
      console.warn('[userTools] triggerRestart failed:', e);
    }
  }

  /**
   * 构造一个新 user tool 的默认 JSON body. 给"派生 builtin tool" dialog 用:
   *   user 选 builtin (e.g. "grep") → 弹 dialog 表单填 description + args
   *   默认 body = { name, description, basedOn, args: { ... builtin 默认 schema } }
   *
   * builtin 默认 args schema 暂时写空 {} (FE 拿不到 Pi SDK 0.84.2 builtin parameters TypeBox schema,
   *   user 自己根据 description 填). 后续 P1.5+ 可以做 "拉 builtin schema 自动生成 form".
   */
  function buildDefaultBody(basedOn: BuiltinToolName, name: string, description: string): string {
    const body = {
      name,
      description,
      basedOn,
      args: {},
    };
    return JSON.stringify(body, null, 2);
  }

  return {
    // state
    tools,
    loading,
    error,
    // actions
    refresh,
    read,
    write,
    remove,
    buildDefaultBody,
    // 暴露给 UI
    BUILTIN_TOOL_NAMES,
    BUILTIN_TOOL_LABEL,
  };
});

function validateName(name: string) {
  if (!name || name.length < 1 || name.length > 64) {
    throw new Error(`user tool name 长度必须 1-64, got ${name.length}`);
  }
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error(`user tool name 只能含 [A-Za-z0-9._-], got '${name}'`);
  }
  if (name === '.' || name === '..') {
    throw new Error("user tool name 不能是 '.' 或 '..'");
  }
  if ((BUILTIN_TOOL_NAMES as readonly string[]).includes(name)) {
    throw new Error(`user tool name '${name}' 跟 builtin tool 重名, 加个前缀 (e.g. my_${name})`);
  }
}

function validateBody(body: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    throw new Error(`user tool body 不是合法 JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('user tool body 必须是 JSON object');
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.name !== 'string' || !obj.name) {
    throw new Error("user tool body 缺 'name' 字段或为空");
  }
  if (typeof obj.basedOn !== 'string' || !(BUILTIN_TOOL_NAMES as readonly string[]).includes(obj.basedOn)) {
    throw new Error(`user tool body 'basedOn' 必须是 [${BUILTIN_TOOL_NAMES.join(', ')}] 之一`);
  }
  if (!obj.args || typeof obj.args !== 'object') {
    throw new Error("user tool body 'args' 字段必须是 JSON object");
  }
  if (typeof obj.description !== 'string' || !obj.description) {
    throw new Error("user tool body 'description' 字段为空");
  }
}
