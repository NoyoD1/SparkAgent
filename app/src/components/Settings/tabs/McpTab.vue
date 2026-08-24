<script setup lang="ts">
/**
 * 2026-08-21 v0.6.3-rc1 P2-1: Settings → MCP tab
 *
 * 列出已配置的 MCP server, 跟 Tools tab 同 pattern:
 *   - 列表: 展示所有 MCP server (含 workspace + global 两层 scope)
 *   - 新建: 弹 dialog 填 name / command / args, 保存到 <workspace>/.pi/mcp/<name>.json
 *   - 导入 JSON (v0.6.3-rc1 P2-1.1 + P2-1.8): 粘贴 / 选 .json 文件, auto-detect 4 种格式
 *     (single object / array / Claude Desktop {mcpServers: {...}} / map {name: {...}}),
 *     preview 后批量写入
 *   - 编辑: 弹 dialog 编辑 JSON body, 跟 Tools tab 一样 (P1.5.1 不再省略 edit)
 *   - 删除: 确认后删文件
 *
 * 跟 Tools tab 的差异:
 *   - 没有"派生"按钮 (MCP server 不是 builtin 派生, 是独立子进程)
 *   - body 字段不同: name / command / args / env / cwd / timeout
 *   - 新建时给 1 个简单 form (name / command / args), 不直接编辑 JSON (降低使用门槛)
 *   - 编辑时跟 Tools tab 一样暴露 JSON textarea (高手 / 调试用)
 *
 * sidecar 启动时自动加载 MCP server 配置 + spawn + 拉 tools/list 转 Pi SDK ToolDefinition
 *   (工具名加 mcp_<server>_<tool> 前缀).
 * v0.6.3-rc1 P2-2: **支持热重载**, sidecar fs.watch 两个 config dir, 改完 300ms debounce
 *   自动 close + re-spawn. LLM 下一轮 turn 看到新 tool. 不重建 Pi SDK agent session,
 *   不丢对话状态.
 */
import { ref, computed, onMounted } from 'vue';
import { storeToRefs } from 'pinia';
import {
  Plug, Plus, X, Trash2, AlertCircle, Check, Info, Pencil, Upload, FileJson, RefreshCw,
} from 'lucide-vue-next';
import { useMcpServersStore, type McpServerScope } from '@/stores/mcpServers';
import { useSessionStore } from '@/stores/session';
import { piTauri } from '@/lib/tauri';
import {
  parseMcpImportJson,
  describeFormat,
  type ImportParseResult,
} from '@/lib/mcpImport';

const mcpStore = useMcpServersStore();
const { servers, loading, error, runtimeStatus, runtimeWorkspacePath } = storeToRefs(mcpStore);
const sessionStore = useSessionStore();

// 2026-08-24 P3-F: helper — 从 runtimeStatus 找 server 状态
//   runtimeStatus 是 sidecar emit 的 snapshot, 按 name 索引
//   workspacePath 不一致 (e.g. user 切了 ws) 时不显示 (防止误判)
const statusByName = computed(() => {
  const map = new Map<string, typeof runtimeStatus.value[number]>();
  if (runtimeWorkspacePath.value && runtimeWorkspacePath.value !== currentWsPath.value) {
    return map;  // 跨 workspace snapshot, 不显示
  }
  for (const s of runtimeStatus.value) {
    map.set(s.name, s);
  }
  return map;
});

const startedCount = computed(() => runtimeStatus.value.filter((s) => s.status === 'started').length);
const failedCount = computed(() => runtimeStatus.value.filter((s) => s.status === 'failed').length);
const hasSnapshot = computed(() => runtimeStatus.value.length > 0);

// v0.6.3-rc1 P2-1.2: 记录当前 MCP 操作的 workspace path, 给 UI 显示 + 排查
//   list_mcp_servers 拿不到 server 时, user 一看路径就知道是不是 active workspace 选错了
const currentWsPath = ref<string>('');

// v0.6.3-rc1 P2-1.4: dialog 选中的 workspace (高级区下拉). computed 拿对应 path
//   找不到时 fallback 到 currentWsPath (确保 save 时不会传空字符串)
const dialogSelectedWsPath = computed(() => {
  const id = dialogSelectedWorkspaceId.value;
  if (!id) return currentWsPath.value;
  const ws = sessionStore.workspaces.find((w) => w.id === id);
  return ws?.path || currentWsPath.value;
});

// ====== 新建 dialog state ======
const isCreating = ref(false);
const formName = ref('');
const formCommand = ref('');
const formUrl = ref('');           // v0.6.3-rc1 P2-3: http/sse 时填
const formType = ref<'stdio' | 'http' | 'sse'>('stdio');  // v0.6.3-rc1 P2-3: 重新加回来 (P2-1.4 砍过)
const formArgs = ref('');   // 空格分隔的 args (UI 简化), 提交时 split
const isSavingCreate = ref(false);

// ====== 编辑 dialog state (走 unified dialog, 跟新建共用 isCreating) ======
//   editingName / editingBody / isSavingEdit 留作 saveEdit 用
const editingName = ref('');
const editingBody = ref('');
const isSavingEdit = ref(false);

// ====== v0.6.3-rc1 P2-3: 恢复 form/JSON 双 tab (P2-1.4 砍过, 但 HTTP/SSE 配置 form 字段不够用) ======
//   - form tab: 核心字段可视化 (name/type/command-or-url/args/高级区)
//   - JSON tab: 直接编辑完整 body (高级 user / headers / 复杂 env 时用, 跟 Skills 模式一致)
//   - 默认 form, "JSON" tab 按钮/链接在 dialog 头, 不卡住普通 user
const dialogTab = ref<'form' | 'json'>('form');
const dialogJsonText = ref('');  // JSON tab 的 textarea 内容
const dialogJsonError = ref<string | null>(null);  // JSON 解析失败时显示

// ====== v0.6.3-rc1 P2-1.4: 简约版 unified create/edit dialog state ======
//   P2-3 调整: 加 form/JSON tab 切换 + form 加 type radio + url 字段
const dialogMode = ref<'create' | 'edit'>('create');   // 当前是新建还是编辑
const editingScope = ref<McpServerScope>('workspace');  // 作用域 (高级区)
// v0.6.3-rc1 P2-1.4 修: 让 user 选要写到哪个 workspace (而不是只看"当前工作区"暗箱).
//   dialogSelectedWorkspaceId 默认 = 当前 active workspace; 多个 workspace 时可切换.
//   global scope 时该 select 隐藏 (global 跟 workspace 无关).
const dialogSelectedWorkspaceId = ref<string | null>(null);
const globalDirPath = ref<string>('');                  // 缓存 getAgentDir() 结果 (高级区显示)
const dialogFormEnv = ref('');                         // env 字段 (JSON object string, 高级区)
const dialogFormTimeout = ref(30000);                 // 超时 (ms, 高级区)

function startCreate() {
  dialogMode.value = 'create';
  dialogTab.value = 'form';  // P2-3: 新建默认 form tab
  formName.value = '';
  formType.value = 'stdio';
  formCommand.value = 'node';
  formUrl.value = '';
  formArgs.value = '';
  editingScope.value = 'workspace';
  // 默认选当前 active workspace (user 可在下拉里改)
  dialogSelectedWorkspaceId.value = sessionStore.activeWorkspaceId
    || sessionStore.workspaces[0]?.id
    || null;
  dialogFormEnv.value = '{}';
  dialogFormTimeout.value = 30000;
  dialogJsonText.value = '';  // P2-3: 清 JSON tab 内容
  dialogJsonError.value = null;
  isCreating.value = true;
  // 异步加载 global dir path 给 UI 显示
  if (!globalDirPath.value) {
    piTauri.getAgentDir().then((p) => { globalDirPath.value = p; }).catch(() => { /* 忽略 */ });
  }
}

function cancelCreate() {
  isCreating.value = false;
  formName.value = '';
  formCommand.value = '';
  formUrl.value = '';
  formType.value = 'stdio';
  formArgs.value = '';
  dialogFormEnv.value = '';
  dialogJsonError.value = null;
}

// v0.6.3-rc1 P2-3: 把 form 字段拼成 body string (form tab → JSON 序列化)
//   跟 buildBodyFromForm 一致, 但只用于切 tab 时实时显示, 校验交给 saveCreate/saveEdit
function buildJsonFromFormState(): string {
  const args = formArgs.value
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  let env: Record<string, string> = {};
  try {
    env = parseEnvJson(dialogFormEnv.value, '环境变量');
  } catch {
    // env 解析失败, 临时用空, 切回 form tab 时 user 修
    env = {};
  }
  const params: {
    type: 'stdio' | 'http' | 'sse';
    name: string;
    command?: string;
    url?: string;
    args?: string[];
    env?: Record<string, string>;
    timeout?: number;
  } = {
    type: formType.value,
    name: dialogMode.value === 'edit' ? editingName.value : formName.value,
    args,
    env,
    timeout: dialogFormTimeout.value || 30000,
  };
  if (formType.value === 'stdio') {
    params.command = formCommand.value;
  } else {
    params.url = formUrl.value;
  }
  return mcpStore.buildBodyFromForm(params);
}

async function saveCreate() {
  if (isSavingCreate.value) return;
  isSavingCreate.value = true;
  toast.value = null;
  try {
    // v0.6.3-rc1 P2-3: 走 tab 决策 body 来源
    //   - form tab: form 字段 → buildBodyFromForm
    //   - JSON tab: textarea 内容 (user 已直接编辑)
    let body: string;
    let resolvedName: string = formName.value;  // 提交时用的 name, JSON tab 会从 body 抓
    if (dialogTab.value === 'json') {
      // JSON tab: 走 parseMcpImportJson 4 种格式 auto-detect
      //   - 修 v3.9+: 之前只 JSON.parse + 顶层找 name, 用户贴 Claude Desktop 格式
      //     {"mcpServers": {...}} 顶层没 name → 报 "name 长度必须 1-64, got 0" 误导
      //   - 现在统一走 import 解析, 1 个 server 直接用, 多个 server 让 user 用"导入"按钮
      const trimmed = dialogJsonText.value.trim();
      if (!trimmed) throw new Error('JSON 内容为空');
      const result = parseMcpImportJson(trimmed);
      if (result.topError) {
        throw new Error(result.topError);
      }
      if (result.invalid.length > 0 && result.servers.length === 0) {
        const first = result.invalid[0];
        throw new Error(`JSON 解析失败: ${first.reason}`);
      }
      if (result.servers.length === 0) {
        throw new Error('JSON 解析成功但没找到任何 server (格式可能不识别)');
      }
      if (result.servers.length > 1) {
        throw new Error(
          `检测到 ${result.servers.length} 个 server (${result.servers.map((s) => s.name).join(', ')}). ` +
          `批量导入请用右上 "导入" 按钮 (走 ${describeFormat(result.format)} 解析)`,
        );
      }
      const server = result.servers[0];
      resolvedName = server.name;
      body = server.body;  // parser 已经把 name 填进 body
    } else {
      const args = formArgs.value
        .split(/\s+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      const env = parseEnvJson(dialogFormEnv.value, '环境变量');
      const params: {
        type: 'stdio' | 'http' | 'sse';
        name: string;
        command?: string;
        url?: string;
        args?: string[];
        env?: Record<string, string>;
        timeout?: number;
      } = {
        type: formType.value,
        name: formName.value,
        args,
        env,
        timeout: dialogFormTimeout.value || 30000,
      };
      if (formType.value === 'stdio') {
        if (!formCommand.value.trim()) {
          throw new Error('type=stdio 时命令必填');
        }
        params.command = formCommand.value;
      } else {
        // http / sse
        if (!formUrl.value.trim()) {
          throw new Error(`type=${formType.value} 时 URL 必填`);
        }
        if (!formUrl.value.startsWith('http://') && !formUrl.value.startsWith('https://')) {
          throw new Error('URL 必须以 http:// 或 https:// 开头');
        }
        params.url = formUrl.value;
      }
      body = mcpStore.buildBodyFromForm(params);
    }
    // v0.6.3-rc1 P2-1.4: 走 mcpStore.writeWithPath 传用户选中的 workspace / agent dir
    //   (老的 write() 走 active workspace, 多个 ws 时 user 没切换入口 → 现在补上)
    const wsPath = editingScope.value === 'workspace' ? dialogSelectedWsPath.value : null;
    const agDir = editingScope.value === 'global' ? (globalDirPath.value || null) : null;
    await mcpStore.writeWithPath(editingScope.value, resolvedName, body, wsPath, agDir);
    toast.value = { type: 'ok', message: `已创建 ${resolvedName}` };
    cancelCreate();
    await mcpStore.refresh();
  } catch (e) {
    toast.value = { type: 'fail', message: e instanceof Error ? e.message : String(e) };
  } finally {
    isSavingCreate.value = false;
  }
}

async function startEdit(scope: McpServerScope, name: string) {
  try {
    const body = await mcpStore.read(scope, name);
    dialogMode.value = 'edit';
    dialogTab.value = 'form';  // P2-3: edit 默认 form tab
    editingScope.value = scope;
    editingName.value = name;
    editingBody.value = body;
    // v0.6.3-rc1 P2-1.4: edit 模式下也设置 workspace id (用作显示, 但 disabled)
    //   编辑时不允许改 scope / workspace, 想搬移请删除+新建
    dialogSelectedWorkspaceId.value = sessionStore.activeWorkspaceId
      || sessionStore.workspaces[0]?.id
      || null;
    // 反解 body 到 form 字段 (P2-3: 加 type + url)
    try {
      const f = mcpStore.parseBodyToForm(body);
      formType.value = f.type;
      formCommand.value = f.command;
      formUrl.value = f.url;
      formArgs.value = f.args;
      dialogFormEnv.value = f.env;
      dialogFormTimeout.value = f.timeout;
      dialogJsonText.value = body;  // P2-3: 同步填到 JSON tab (切 tab 时显示原文)
      dialogJsonError.value = null;
    } catch (e) {
      // body 解析失败, 切到 JSON tab 让 user 看原文修
      formCommand.value = '';
      formUrl.value = '';
      formArgs.value = '';
      dialogFormEnv.value = '{}';
      dialogFormTimeout.value = 30000;
      dialogJsonText.value = body;
      dialogJsonError.value = e instanceof Error ? e.message : String(e);
      dialogTab.value = 'json';
    }
    isCreating.value = true;  // 跟新建共用一个 dialog
    toast.value = null;
    if (!globalDirPath.value) {
      piTauri.getAgentDir().then((p) => { globalDirPath.value = p; }).catch(() => { /* 忽略 */ });
    }
  } catch (e) {
    toast.value = { type: 'fail', message: e instanceof Error ? e.message : String(e) };
  }
}

async function saveEdit() {
  if (isSavingEdit.value) return;
  isSavingEdit.value = true;
  toast.value = null;
  try {
    // v0.6.3-rc1 P2-3: 跟 saveCreate 一样按 tab 决策 body 来源
    //   v3.9+: JSON tab 走 parseMcpImportJson, 跟 saveCreate 一致, 让 name 自动从 body 抓
    let body: string;
    if (dialogTab.value === 'json') {
      const trimmed = dialogJsonText.value.trim();
      if (!trimmed) throw new Error('JSON 内容为空');
      const result = parseMcpImportJson(trimmed);
      if (result.topError) throw new Error(result.topError);
      if (result.invalid.length > 0 && result.servers.length === 0) {
        throw new Error(`JSON 解析失败: ${result.invalid[0].reason}`);
      }
      if (result.servers.length === 0) {
        throw new Error('JSON 解析成功但没找到任何 server');
      }
      if (result.servers.length > 1) {
        throw new Error(
          `检测到 ${result.servers.length} 个 server. 编辑场景请保持单 server JSON, 批量请用 "导入" 按钮`,
        );
      }
      const server = result.servers[0];
      // 编辑模式: name 必须跟原 editingName 一致, 否则 user 改了名字路径冲突
      if (server.name !== editingName.value) {
        throw new Error(
          `JSON 里 server name '${server.name}' 跟原名 '${editingName.value}' 不一致. ` +
          `改名请用 "新建" 流程`,
        );
      }
      body = server.body;
    } else {
      const args = formArgs.value
        .split(/\s+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      const env = parseEnvJson(dialogFormEnv.value, '环境变量');
      const params: {
        type: 'stdio' | 'http' | 'sse';
        name: string;
        command?: string;
        url?: string;
        args?: string[];
        env?: Record<string, string>;
        timeout?: number;
      } = {
        type: formType.value,
        name: editingName.value,
        args,
        env,
        timeout: dialogFormTimeout.value || 30000,
      };
      if (formType.value === 'stdio') {
        if (!formCommand.value.trim()) {
          throw new Error('type=stdio 时命令必填');
        }
        params.command = formCommand.value;
      } else {
        if (!formUrl.value.trim()) {
          throw new Error(`type=${formType.value} 时 URL 必填`);
        }
        if (!formUrl.value.startsWith('http://') && !formUrl.value.startsWith('https://')) {
          throw new Error('URL 必须以 http:// 或 https:// 开头');
        }
        params.url = formUrl.value;
      }
      body = mcpStore.buildBodyFromForm(params);
    }
    // v0.6.3-rc1 P2-1.4: edit 模式 workspace/scope 锁住, 用原 editingScope 写入
    //   (dialogSelectedWsPath 仍用作"显示这个 server 在哪个 ws", 写入路径用 editingScope 解析的 active)
    const wsPath = editingScope.value === 'workspace' ? dialogSelectedWsPath.value : null;
    const agDir = editingScope.value === 'global' ? (globalDirPath.value || null) : null;
    await mcpStore.writeWithPath(editingScope.value, editingName.value, body, wsPath, agDir);
    toast.value = { type: 'ok', message: `已更新 ${editingName.value}` };
    cancelCreate();
    await mcpStore.refresh();
  } catch (e) {
    toast.value = { type: 'fail', message: e instanceof Error ? e.message : String(e) };
  } finally {
    isSavingEdit.value = false;
  }
}

// v0.6.3-rc1 P2-3: tab 切换 — form ↔ JSON 同步
//   form → json: 把当前 form 字段 serialize 到 JSON, 放 textarea
//   json → form: 解析 JSON, 填回 form 字段 (失败留在 JSON tab 给清晰错误)
function switchDialogTab(target: 'form' | 'json') {
  if (target === dialogTab.value) return;
  if (target === 'json') {
    // form → json: 实时 serialize (即使 form 字段未保存, 也让 user 看到 JSON 视图)
    try {
      dialogJsonText.value = buildJsonFromFormState();
      dialogJsonError.value = null;
    } catch (e) {
      dialogJsonError.value = e instanceof Error ? e.message : String(e);
    }
    dialogTab.value = 'json';
  } else {
    // json → form: 解析 JSON, 失败不切 + 给错误
    try {
      const f = mcpStore.parseBodyToForm(dialogJsonText.value);
      formName.value = f.name;  // v3.9+: 之前漏了, JSON tab 填了 name 切回 form 还是空 → saveCreate 报 name 长度 0
      formType.value = f.type;
      formCommand.value = f.command;
      formUrl.value = f.url;
      formArgs.value = f.args;
      dialogFormEnv.value = f.env;
      dialogFormTimeout.value = f.timeout;
      dialogJsonError.value = null;
      dialogTab.value = 'form';
    } catch (e) {
      // 解析失败, 留在 JSON tab, 显示错误
      dialogJsonError.value = e instanceof Error ? e.message : String(e);
    }
  }
}

/** 解析 env JSON textarea, 失败时给清晰错误 (含字段名, user 知道是哪个字段错了) */
function parseEnvJson(text: string, fieldLabel: string): Record<string, string> {
  const trimmed = text.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${fieldLabel} 必须是 JSON object, 不是 array 或 null`);
    }
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v !== 'string') {
        throw new Error(`${fieldLabel}.${k} 必须是 string, got ${typeof v}`);
      }
    }
    return parsed as Record<string, string>;
  } catch (e) {
    throw new Error(`${fieldLabel} 不是合法 JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ====== 导入 JSON dialog state (v0.6.3-rc1 P2-1.1) ======
const isImporting = ref(false);
const importJsonText = ref('');             // textarea 内容
const importScope = ref<McpServerScope>('workspace');  // 整批写入哪个 scope
const importParseResult = ref<ImportParseResult | null>(null);  // 解析后的 preview
const importFileInputRef = ref<HTMLInputElement | null>(null);  // file picker ref
const isImporting_apply = ref(false);       // 跟 isImporting 区分: 前者是 dialog 显示, 后者是正在写盘

// ====== Toast ======
const toast = ref<{ type: 'ok' | 'fail'; message: string } | null>(null);

// 2026-08-24 P3-F: 强制重测 — triggerRestart 让 sidecar 重启并重跑 MCP 初始化
//   用于改了 keychain secret / 修了 MCP config 后, 不用 restart app
const isForceRetesting = ref(false);
async function forceRetestMcp() {
  if (isForceRetesting.value) return;
  isForceRetesting.value = true;
  toast.value = null;
  try {
    // triggerRestart 走 mcpServersStore 内部 (跟 write/delete 一样的 pattern)
    //   内部 fire-and-forget Tauri restart_all_sidecars, 整个 Tauri 进程会 kill active sidecar
    //   下次 send_prompt lazy spawn 新 sidecar, 重新跑 createAgentSessionRuntime
    await mcpStore.triggerRestart('user_force_retest');
    toast.value = { type: 'ok', message: '已触发 sidecar 重启 — 下次发消息时新 sidecar 会重测 MCP, 几秒后回到这里刷新状态' };
  } catch (e) {
    toast.value = { type: 'fail', message: e instanceof Error ? e.message : String(e) };
  } finally {
    // 5s 后解除按钮 disable (不管 sidecar 是否真的重启完)
    setTimeout(() => { isForceRetesting.value = false; }, 5000);
  }
}

async function removeServer(scope: McpServerScope, name: string) {
  if (!confirm(`确认删除 MCP server "${name}" (scope=${scope})?`)) return;
  try {
    await mcpStore.remove(scope, name);
    toast.value = { type: 'ok', message: `已删除 ${name}` };
    await mcpStore.refresh();
  } catch (e) {
    toast.value = { type: 'fail', message: e instanceof Error ? e.message : String(e) };
  }
}

// 简洁的 args 摘要 (UI 列表里展示)
function summarizeArgs(bodyStr: string): string {
  try {
    const obj = JSON.parse(bodyStr);
    if (!Array.isArray(obj.args) || obj.args.length === 0) return '(无 args)';
    return obj.args.join(' ');
  } catch {
    return '(解析失败)';
  }
}

// ====== 2026-08-21 v0.6.3-rc1 P2-1.1: 导入 JSON ======
function startImport() {
  isImporting.value = true;
  importJsonText.value = '';
  importScope.value = 'workspace';
  importParseResult.value = null;
}

function cancelImport() {
  isImporting.value = false;
  importJsonText.value = '';
  importParseResult.value = null;
}

// 点 "解析预览": 走 lib/mcpImport.ts parse, 不写盘
function parseImportPreview() {
  if (!importJsonText.value.trim()) {
    importParseResult.value = null;
    return;
  }
  importParseResult.value = parseMcpImportJson(importJsonText.value);
}

// 选文件: 读 .json 自动填到 textarea (走 FileReader)
function onImportFileSelected(ev: Event) {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    importJsonText.value = String(reader.result ?? '');
    parseImportPreview();  // 选完自动解析, 省 user 一次点击
  };
  reader.onerror = () => {
    toast.value = { type: 'fail', message: `读文件失败: ${reader.error?.message ?? 'unknown'}` };
  };
  reader.readAsText(file, 'utf-8');
  // 清 input.value, 允许重复选同一文件
  input.value = '';
}

function triggerImportFilePicker() {
  importFileInputRef.value?.click();
}

// 点 "确认导入": 把 preview 里的 servers 写盘
async function applyImport() {
  if (isImporting_apply.value) return;
  const preview = importParseResult.value;
  if (!preview) {
    toast.value = { type: 'fail', message: '请先点 "解析预览" 看看哪些 server 会被导入' };
    return;
  }
  if (preview.servers.length === 0) {
    toast.value = { type: 'fail', message: '没有可导入的 server (全部解析失败或不识别格式)' };
    return;
  }
  isImporting_apply.value = true;
  toast.value = null;
  try {
    const result = await mcpStore.importServers(
      preview.servers.map((s) => ({ name: s.name, body: s.body })),
      importScope.value,
    );
    // 拼一个汇总消息
    const lines: string[] = [];
    if (result.imported.length > 0) {
      lines.push(`✅ 导入 ${result.imported.length} 个: ${result.imported.join(', ')}`);
    }
    if (result.skipped.length > 0) {
      lines.push(`⏭️  跳过 ${result.skipped.length} 个 (冲突): ${result.skipped.map((s) => s.name).join(', ')}`);
    }
    if (result.failed.length > 0) {
      lines.push(`❌ 失败 ${result.failed.length} 个: ${result.failed.map((f) => `${f.name} (${f.reason})`).join('; ')}`);
    }
    toast.value = {
      type: result.imported.length > 0 ? 'ok' : 'fail',
      message: lines.join(' / '),
    };
    if (result.imported.length > 0) {
      cancelImport();
    }
  } catch (e) {
    toast.value = { type: 'fail', message: e instanceof Error ? e.message : String(e) };
  } finally {
    isImporting_apply.value = false;
  }
}

onMounted(() => {
  refreshAndShowPath();
  // 2026-08-24 v3.22 P3-F: 进 McpTab 自动 forceRetest (跟 unityMCP 行为对齐)
  //   之前要发消息触发 sidecar 启, 然后才看到 status. 现在: 进 tab → triggerRestart sidecar
  //   → sidecar 重启完 emit mcp_status → store 更新 → UI 显示.
  //   只在有 server 时做 (没 server 没必要 restart).
  if (mcpStore.servers.length > 0) {
    // 短暂延后, 让 refreshAndShowPath 跑完 (UI 先显示, 再 trigger restart)
    setTimeout(() => { void forceRetestMcp(); }, 200);
  }
});

// ====== 2026-08-21 v0.6.3-rc1 P2-1.2: 包装 refresh 同步 ws path (UI 显示用) ======
async function refreshAndShowPath() {
  try {
    currentWsPath.value = await mcpStore.ensureActiveWorkspace();
  } catch (e) {
    currentWsPath.value = '';
    toast.value = { type: 'fail', message: e instanceof Error ? e.message : String(e) };
    return;
  }
  await mcpStore.refresh();
}
</script>

<template>
  <div class="pad-mcptab">
    <div class="pad-mcptab__header">
      <h2 class="pad-mcptab__title">MCP — Model Context Protocol</h2>
      <p class="pad-mcptab__subtitle">
        配置 MCP server (Anthropic 协议). 存 <code>&lt;workspace&gt;/.pi/mcp/*.json</code> +
        <code>&lt;agentDir&gt;/mcp/*.json</code> (workspace 优先).
        sidecar 启动时自动加载 + spawn 每个 server, 走 <code>@modelcontextprotocol/sdk</code>
        拉 tools/list 转 Pi SDK ToolDefinition (工具名加 <code>mcp_&lt;server&gt;_&lt;tool&gt;</code> 前缀).
        <strong>v0.6.3-rc1 P2-2 起支持热重载</strong>: 改完 JSON 文件 sidecar 自动
        close + re-spawn (300ms debounce), LLM 下一轮 turn 看到新 tool, 不丢对话状态.
      </p>
    </div>

    <div v-if="toast" class="pad-mcptab__toast" :class="`is-${toast.type}`">
      <Check v-if="toast.type === 'ok'" :size="14" :stroke-width="1.75" />
      <AlertCircle v-else :size="14" :stroke-width="1.75" />
      <span>{{ toast.message }}</span>
      <button class="pad-mcptab__toast-close" @click="toast = null">×</button>
    </div>

    <div v-if="error" class="pad-mcptab__toast is-fail">
      <AlertCircle :size="14" :stroke-width="1.75" />
      <span>{{ error }}</span>
    </div>

    <!-- v0.6.3-rc1 P2-1.4: 简约版 unified create/edit dialog
         设计: 只露 3 个核心字段 (名称/命令/参数), 其它 (作用域/env/超时) 塞"高级"折叠区
         砍掉: JSON tab / 类型 radio / 顶部大段 hint / HTTP-SSE 警告 / 协议文档链接
         (JSON 批量配置用顶部"导入 JSON"按钮, 高级配置用展开的高级区)
    -->
    <div v-if="isCreating" class="pad-mcptab__dialog">
      <div class="pad-mcptab__dialog-head">
        <component :is="dialogMode === 'create' ? Plus : Pencil" :size="14" :stroke-width="1.75" />
        <span>
          {{ dialogMode === 'create' ? '新建' : '编辑' }}
          <code v-if="dialogMode === 'edit'">{{ editingName }}</code>
          MCP 服务器
        </span>
        <button class="pad-mcptab__toast-close" @click="cancelCreate">
          <X :size="14" :stroke-width="1.75" />
        </button>
      </div>

      <div class="pad-mcptab__form">
        <!-- v0.6.3-rc1 P2-3: tab 切换 (form | JSON) — form 为主, JSON 给高级 user / HTTP-SSE 配置用 -->
        <div class="pad-mcptab__tabs">
          <button
            type="button"
            class="pad-mcptab__tab"
            :class="{ 'is-active': dialogTab === 'form' }"
            @click="switchDialogTab('form')"
          >
            <span>表单</span>
          </button>
          <button
            type="button"
            class="pad-mcptab__tab"
            :class="{ 'is-active': dialogTab === 'json' }"
            @click="switchDialogTab('json')"
          >
            <FileJson :size="12" :stroke-width="1.75" />
            <span>JSON</span>
          </button>
          <span class="pad-mcptab__tab-hint">
            支持 4 种格式 (单 server / Claude Desktop mcpServers / array / map) — 多 server 请用 "导入" 按钮
          </span>
        </div>

        <!-- ====== JSON tab (直接编辑 body) ====== -->
        <div v-if="dialogTab === 'json'" class="pad-mcptab__form-row">
          <textarea
            v-model="dialogJsonText"
            class="pad-mcptab__textarea pad-mcptab__textarea--mono"
            rows="14"
            spellcheck="false"
            placeholder='{
  "type": "http",
  "name": "my-http-mcp",
  "url": "http://localhost:3000/mcp"
}'
          />
          <div v-if="dialogJsonError" class="pad-mcptab__error-hint">
            <AlertCircle :size="12" :stroke-width="1.75" />
            <span>{{ dialogJsonError }}</span>
          </div>
        </div>

        <!-- ====== Form tab (可视化字段) ====== -->
        <template v-else>
          <!-- 核心字段: 名称 (一直可见) -->
          <div class="pad-mcptab__form-row">
            <input
              v-model="formName"
              class="pad-mcptab__input pad-mcptab__input--large"
              placeholder="名称, 例如 filesystem"
              spellcheck="false"
              :disabled="dialogMode === 'edit'"
            />
          </div>

          <!-- P2-3: type radio (stdio / http / sse) — P2-1.4 砍过, P2-3 加回来
               HTTP/SSE 必填 url (P2-1.8 起 sidecar 真支持) -->
          <div class="pad-mcptab__form-row">
            <label class="pad-mcptab__label-small">传输方式</label>
            <div class="pad-mcptab__radio-group">
              <label class="pad-mcptab__radio">
                <input
                  type="radio"
                  value="stdio"
                  v-model="formType"
                  :disabled="isSavingCreate || isSavingEdit"
                />
                <span>stdio <code class="pad-mcptab__hint-inline">(子进程, 最常见)</code></span>
              </label>
              <label class="pad-mcptab__radio">
                <input
                  type="radio"
                  value="http"
                  v-model="formType"
                  :disabled="isSavingCreate || isSavingEdit"
                />
                <span>http <code class="pad-mcptab__hint-inline">(StreamableHTTP, MCP 新标准)</code></span>
              </label>
              <label class="pad-mcptab__radio">
                <input
                  type="radio"
                  value="sse"
                  v-model="formType"
                  :disabled="isSavingCreate || isSavingEdit"
                />
                <span>sse <code class="pad-mcptab__hint-inline">(SSE 旧标准, 兼容老 server)</code></span>
              </label>
            </div>
          </div>

          <!-- stdio: command + args -->
          <template v-if="formType === 'stdio'">
            <div class="pad-mcptab__form-row pad-mcptab__form-row--inline">
              <input
                v-model="formCommand"
                class="pad-mcptab__input pad-mcptab__input--mono"
                placeholder="命令 (如 npx)"
                spellcheck="false"
              />
              <input
                v-model="formArgs"
                class="pad-mcptab__input pad-mcptab__input--mono pad-mcptab__input--flex"
                placeholder="参数 (空格分隔, 如 -y @modelcontextprotocol/server-fs D:\path)"
                spellcheck="false"
              />
            </div>
          </template>

          <!-- http / sse: url (env 当 request headers 用) -->
          <template v-else>
            <div class="pad-mcptab__form-row">
              <input
                v-model="formUrl"
                class="pad-mcptab__input pad-mcptab__input--mono"
                :placeholder="formType === 'http' ? 'URL (如 http://localhost:3000/mcp)' : 'URL (SSE endpoint)'"
                spellcheck="false"
              />
              <div class="pad-mcptab__hint-inline pad-mcptab__hint-inline--block">
                认证 header 走下方"环境变量" (e.g. <code>{"Authorization": "Bearer xxx"}</code>)
              </div>
            </div>
          </template>

          <!-- 高级 (默认折叠, 大部分 user 用不到) -->
          <details class="pad-mcptab__advanced">
            <summary>高级</summary>
            <div class="pad-mcptab__advanced-body">
              <!-- v0.6.3-rc1 P2-1.4: 目标选择 (workspace / global) + workspace 下拉
                   解决 user 反馈"创建多个 workspace 时不知道放到哪个"的问题
              -->
              <div class="pad-mcptab__form-row">
                <label class="pad-mcptab__label-small">目标</label>
                <div class="pad-mcptab__radio-group pad-mcptab__radio-group--stack">
                  <label class="pad-mcptab__radio pad-mcptab__radio--block">
                    <input
                      type="radio"
                      value="workspace"
                      v-model="editingScope"
                      :disabled="dialogMode === 'edit' || isSavingCreate"
                    />
                    <div class="pad-mcptab__radio-content">
                      <span class="pad-mcptab__radio-label">当前工作区</span>
                      <!-- workspace 选择: 默认 = active, 多 ws 时可切换 -->
                      <select
                        v-model="dialogSelectedWorkspaceId"
                        class="pad-mcptab__select"
                        :disabled="dialogMode === 'edit' || editingScope !== 'workspace' || isSavingCreate || sessionStore.workspaces.length <= 1"
                      >
                        <option
                          v-for="ws in sessionStore.workspaces"
                          :key="ws.id"
                          :value="ws.id"
                        >
                          {{ ws.name || ws.path.split(/[\\/]/).filter(Boolean).slice(-1)[0] }} — {{ ws.path }}
                        </option>
                      </select>
                      <code v-if="editingScope === 'workspace' && dialogSelectedWsPath" class="pad-mcptab__path-hint">
                        → 写到 <code>&lt;ws&gt;/.pi/mcp/&lt;name&gt;.json</code> = <code>{{ dialogSelectedWsPath }}\.pi\mcp\&lt;name&gt;.json</code>
                      </code>
                    </div>
                  </label>
                  <label class="pad-mcptab__radio pad-mcptab__radio--block">
                    <input
                      type="radio"
                      value="global"
                      v-model="editingScope"
                      :disabled="dialogMode === 'edit' || isSavingCreate"
                    />
                    <div class="pad-mcptab__radio-content">
                      <span class="pad-mcptab__radio-label">全局 (跨工作区)</span>
                      <code v-if="globalDirPath" class="pad-mcptab__path-hint">
                        → 写到 <code>{{ globalDirPath }}\mcp\&lt;name&gt;.json</code>
                      </code>
                      <code v-else class="pad-mcptab__path-hint pad-mcptab__path-hint--muted">
                        (加载全局路径中...)
                      </code>
                    </div>
                  </label>
                </div>
              </div>
              <div class="pad-mcptab__form-row">
                <label class="pad-mcptab__label-small">
                  环境变量
                  <span class="pad-mcptab__hint-inline">
                    (JSON object, 留空用 {{ '{}' }})
                    <template v-if="formType !== 'stdio'">
                      <br />type={{ formType }} 时当 HTTP request headers 用 (e.g. <code>{"Authorization": "Bearer xxx"}</code>)
                    </template>
                  </span>
                </label>
                <textarea
                  v-model="dialogFormEnv"
                  class="pad-mcptab__textarea pad-mcptab__textarea--mono"
                  rows="3"
                  spellcheck="false"
                  :placeholder="formType === 'stdio' ? '{&quot;MY_API_KEY&quot;: &quot;your-key&quot;}' : '{&quot;Authorization&quot;: &quot;Bearer your-token&quot;}'"
                />
              </div>
              <div class="pad-mcptab__form-row">
                <label class="pad-mcptab__label-small">超时 (毫秒)</label>
                <input
                  v-model.number="dialogFormTimeout"
                  type="number"
                  class="pad-mcptab__input"
                  placeholder="30000"
                />
              </div>
            </div>
          </details>
        </template>

        <!-- 底部按钮 (一行: 取消 + 添加) -->
        <div class="pad-mcptab__form-actions">
          <button
            class="pad-mcptab__btn"
            @click="cancelCreate"
            :disabled="isSavingCreate || isSavingEdit"
          >
            取消
          </button>
          <button
            v-if="dialogMode === 'create'"
            class="pad-mcptab__btn pad-mcptab__btn--primary"
            :disabled="isSavingCreate"
            @click="saveCreate"
          >
            {{ isSavingCreate ? '添加中…' : '添加' }}
          </button>
          <button
            v-else
            class="pad-mcptab__btn pad-mcptab__btn--primary"
            :disabled="isSavingEdit"
            @click="saveEdit"
          >
            {{ isSavingEdit ? '保存中…' : '保存' }}
          </button>
        </div>
      </div>
    </div>

    <!-- 2026-08-21 v0.6.3-rc1 P2-1.1: 导入 JSON dialog -->
    <div v-if="isImporting" class="pad-mcptab__dialog">
      <div class="pad-mcptab__dialog-head">
        <Upload :size="14" :stroke-width="1.75" />
        <span>导入 MCP server JSON</span>
        <button class="pad-mcptab__toast-close" @click="cancelImport">
          <X :size="14" :stroke-width="1.75" />
        </button>
      </div>
      <div class="pad-mcptab__form">
        <!-- 顶部 hint -->
        <div class="pad-mcptab__form-hint">
          <Info :size="12" :stroke-width="1.75" />
          <span>
            支持 4 种格式 (auto-detect): ① 单个 <code>{name, command|url, ...}</code> ②
            <code>[{...}, {...}]</code> array ③ Claude Desktop 标准
            <code>{mcpServers: {name: {...}}}</code> ④ map
            <code>{name: {...}}</code> (跟 <code>.pi/mcp/*.json</code> 一致).
            选完文件后自动解析预览, 跟现有 <code>name</code> 冲突的会跳过.
          </span>
        </div>

        <!-- 存储 scope 选择 (整批共用) -->
        <div class="pad-mcptab__form-row">
          <label class="pad-mcptab__label">存储 scope <span class="pad-mcptab__hint-inline">(整批写入同一个 scope, workspace 优先覆盖 global 同名)</span></label>
          <div class="pad-mcptab__radio-group">
            <label class="pad-mcptab__radio">
              <input
                type="radio"
                value="workspace"
                v-model="importScope"
                :disabled="isImporting_apply"
              />
              <span>workspace (当前工作区 <code>&lt;ws&gt;/.pi/mcp/*.json</code>)</span>
            </label>
            <label class="pad-mcptab__radio">
              <input
                type="radio"
                value="global"
                v-model="importScope"
                :disabled="isImporting_apply"
              />
              <span>global (跨工作区 <code>&lt;agentDir&gt;/mcp/*.json</code>)</span>
            </label>
          </div>
        </div>

        <!-- 文件选择 + 粘贴 -->
        <div class="pad-mcptab__form-row">
          <label class="pad-mcptab__label">JSON 内容</label>
          <div class="pad-mcptab__file-row">
            <input
              ref="importFileInputRef"
              type="file"
              accept=".json,application/json"
              class="pad-mcptab__file-input"
              @change="onImportFileSelected"
            />
            <button
              type="button"
              class="pad-mcptab__btn"
              @click="triggerImportFilePicker"
              :disabled="isImporting_apply"
            >
              <FileJson :size="12" :stroke-width="1.75" />
              <span>选择 .json 文件</span>
            </button>
            <span class="pad-mcptab__hint-inline">或者直接粘贴到下面 textarea</span>
          </div>
          <textarea
            v-model="importJsonText"
            class="pad-mcptab__textarea pad-mcptab__textarea--mono"
            rows="10"
            spellcheck="false"
            placeholder='例 1: { "name": "filesystem", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "D:\\path"] }&#10;&#10;例 2: { "mcpServers": { "filesystem": { ... }, "fetch": { ... } } }&#10;&#10;例 3 (P2-1.8): { "my-http-mcp": { "type": "http", "url": "http://localhost:3000/mcp" } }'
            :disabled="isImporting_apply"
            @input="parseImportPreview"
          />
        </div>

        <!-- 解析预览 -->
        <div v-if="importParseResult" class="pad-mcptab__preview">
          <div v-if="importParseResult.topError" class="pad-mcptab__preview-block is-error">
            <AlertCircle :size="12" :stroke-width="1.75" />
            <span>{{ importParseResult.topError }}</span>
          </div>
          <div v-else class="pad-mcptab__preview-block is-info">
            <Check :size="12" :stroke-width="1.75" />
            <span>检测到格式: <strong>{{ describeFormat(importParseResult.format) }}</strong></span>
          </div>

          <!-- 解析成功的 servers (含跟现有冲突的标记) -->
          <div v-if="importParseResult.servers.length > 0" class="pad-mcptab__preview-block">
            <div class="pad-mcptab__preview-title">
              ✅ 将导入 {{ importParseResult.servers.length }} 个 server 到 <code>{{ importScope }}</code>:
            </div>
            <ul class="pad-mcptab__preview-list">
              <li v-for="s in importParseResult.servers" :key="s.name" class="pad-mcptab__preview-item">
                <code class="pad-mcptab__preview-name">{{ s.name }}</code>
                <code class="pad-mcptab__preview-cmd">{{ s.command }}</code>
                <span v-if="servers.some((existing) => existing.name === s.name)" class="pad-mcptab__conflict-tag">
                  冲突 (将跳过)
                </span>
              </li>
            </ul>
          </div>

          <!-- 解析失败的 -->
          <div v-if="importParseResult.invalid.length > 0" class="pad-mcptab__preview-block is-warn">
            <div class="pad-mcptab__preview-title">
              ⚠️ {{ importParseResult.invalid.length }} 个 entry 解析失败 (不会写入):
            </div>
            <ul class="pad-mcptab__preview-list">
              <li v-for="(item, idx) in importParseResult.invalid" :key="idx" class="pad-mcptab__preview-item">
                <code class="pad-mcptab__preview-cmd">{{ item.reason }}</code>
              </li>
            </ul>
          </div>
        </div>

        <!-- 操作按钮 -->
        <div class="pad-mcptab__form-actions">
          <button
            class="pad-mcptab__btn"
            @click="cancelImport"
            :disabled="isImporting_apply"
          >
            <X :size="14" :stroke-width="1.75" />
            <span>取消</span>
          </button>
          <button
            class="pad-mcptab__btn pad-mcptab__btn--primary"
            :disabled="isImporting_apply || !importParseResult || (importParseResult.servers.length === 0 && (importParseResult.servers.length - importParseResult.invalid.length) === 0) || (importParseResult.servers.length > 0 && importParseResult.servers.every((s) => servers.some((existing) => existing.name === s.name)))"
            @click="applyImport"
          >
            <Upload :size="14" :stroke-width="1.75" />
            <span>
              {{
                isImporting_apply
                  ? '导入中…'
                  : `确认导入 ${importParseResult?.servers.filter((s) => !servers.some((existing) => existing.name === s.name)).length ?? 0} 个 server`
              }}
            </span>
          </button>
        </div>
      </div>
    </div>

    <!-- Server 列表 -->
    <div class="pad-mcptab__section">
      <h3 class="pad-mcptab__section-title">
        <Plug :size="14" :stroke-width="1.75" />
        <span>MCP Servers ({{ servers.length }})</span>
        <!-- 2026-08-24 P3-F: runtime 状态汇总 — 顶部一眼看到 connected/failed 数量 -->
        <span
          v-if="hasSnapshot"
          class="pad-mcptab__runtime-summary"
          :title="`sidecar mcp_status snapshot: ${runtimeStatus.length} server(s)`"
        >
          <template v-if="failedCount > 0">
            <AlertCircle :size="12" :stroke-width="2" class="pad-mcptab__runtime-icon-fail" />
            {{ startedCount }} 启好, {{ failedCount }} 失败
          </template>
          <template v-else>
            <Check :size="12" :stroke-width="2" class="pad-mcptab__runtime-icon-ok" />
            全部 {{ startedCount }} 启好
          </template>
        </span>
        <span v-else class="pad-mcptab__runtime-summary is-pending">未启动 sidecar</span>
        <!-- 2026-08-24 P3-F: 强制重测 — triggerRestart 让 sidecar 重新跑 MCP 初始化 -->
        <button
          v-if="!isCreating && !isImporting"
          class="pad-mcptab__btn"
          @click="forceRetestMcp"
          title="强制 sidecar 重启并重跑 MCP 初始化 (用最新 keychain 配置)"
          :disabled="isForceRetesting"
        >
          <RefreshCw :size="12" :stroke-width="1.75" :class="{ 'is-spinning': isForceRetesting }" />
          <span>{{ isForceRetesting ? '重测中…' : '重测' }}</span>
        </button>
        <button
          v-if="!isCreating && !isImporting"
          class="pad-mcptab__btn pad-mcptab__btn--primary"
          @click="startCreate"
        >
          <Plus :size="12" :stroke-width="1.75" />
          <span>新建</span>
        </button>
        <button
          v-if="!isCreating && !isImporting"
          class="pad-mcptab__btn"
          @click="startImport"
          title="粘贴 / 选 .json 文件批量导入"
        >
          <Upload :size="12" :stroke-width="1.75" />
          <span>导入 JSON</span>
        </button>
        <button
          v-if="!loading"
          class="pad-mcptab__btn"
          @click="refreshAndShowPath"
          title="刷新列表 (任何时候都能点, 强制重读 mcp/ 目录)"
        >
          <span>刷新</span>
        </button>
      </h3>
      <div v-if="loading" class="pad-mcptab__empty">
        <Plug :size="20" :stroke-width="1.5" />
        <div>⏳ 加载中…</div>
      </div>
      <div v-else-if="servers.length === 0" class="pad-mcptab__empty">
        <Plug :size="20" :stroke-width="1.5" />
        <div class="pad-mcptab__empty-title">暂无 MCP server</div>
        <div class="pad-mcptab__empty-desc">点 "新建" 填表单, 或 "导入 JSON" 粘贴 Claude Desktop / Cursor 的 MCP 配置批量导入. 常见例子: filesystem / fetch / github 等.</div>
        <div v-if="currentWsPath" class="pad-mcptab__empty-meta">
          扫的目录: <code>&lt;ws&gt;/.pi/mcp/*.json</code> + <code>&lt;ws&gt;/.pi/mcp/&lt;name&gt;.json</code> (ws = <code>{{ currentWsPath }}</code>)
        </div>
      </div>
      <ul v-else class="pad-mcptab__list">
        <li v-for="s in servers" :key="`${s.scope}/${s.name}`" class="pad-mcptab__item">
          <div class="pad-mcptab__item-body">
            <div class="pad-mcptab__item-name">
              <code>{{ s.name }}</code>
              <span class="pad-mcptab__scope-tag" :class="`is-${s.scope}`">{{ s.scope }}</span>
              <span class="pad-mcptab__type-tag" :class="`is-${s.serverType}`">{{ s.serverType }}</span>
              <!-- 2026-08-24 P3-F: runtime 状态 (sidecar mcp_status snapshot) -->
              <span
                v-if="statusByName.get(s.name)"
                class="pad-mcptab__status-tag"
                :class="`is-${statusByName.get(s.name)!.status}`"
                :title="statusByName.get(s.name)!.reason || (statusByName.get(s.name)!.status === 'started' ? `${statusByName.get(s.name)!.toolCount} tool(s) loaded` : 'see below')"
              >
                <template v-if="statusByName.get(s.name)!.status === 'started'">
                  <Check :size="11" :stroke-width="2" />
                  启好 · {{ statusByName.get(s.name)!.toolCount }} tool
                </template>
                <template v-else>
                  <AlertCircle :size="11" :stroke-width="2" />
                  启动失败
                </template>
              </span>
              <span
                v-else-if="hasSnapshot"
                class="pad-mcptab__status-tag is-pending"
                title="sidecar 没报告这个 server (可能未配置或 scope 不匹配)"
              >
                未检查
              </span>
            </div>
            <div class="pad-mcptab__item-cmd">
              <code>{{ s.command }}</code>
              <span class="pad-mcptab__item-args">{{ summarizeArgs(s.body) }}</span>
            </div>
            <!-- 2026-08-24 P3-F: 失败原因 + tools 列表 -->
            <div
              v-if="statusByName.get(s.name)?.status === 'failed' && statusByName.get(s.name)?.reason"
              class="pad-mcptab__item-error"
            >
              <AlertCircle :size="11" :stroke-width="2" />
              {{ statusByName.get(s.name)!.reason }}
            </div>
            <details
              v-else-if="statusByName.get(s.name)?.status === 'started' && (statusByName.get(s.name)?.tools?.length ?? 0) > 0"
              class="pad-mcptab__item-tools"
              open
            >
              <summary>{{ statusByName.get(s.name)!.tools.length }} tool(s) — LLM 看到 mcp_<code>{{ s.name }}</code>_<code>...</code></summary>
              <ul>
                <li v-for="t in statusByName.get(s.name)!.tools" :key="t.name">
                  <code>mcp_{{ s.name }}_{{ t.name }}</code>
                  <span v-if="t.description" class="pad-mcptab__tool-desc">{{ t.description }}</span>
                </li>
              </ul>
            </details>
          </div>
          <div class="pad-mcptab__item-actions">
            <button
              class="pad-mcptab__btn"
              title="编辑 JSON"
              @click="startEdit(s.scope as McpServerScope, s.name)"
            >
              <Pencil :size="13" :stroke-width="1.75" />
            </button>
            <button
              class="pad-mcptab__btn pad-mcptab__btn--danger"
              title="删除"
              @click="removeServer(s.scope as McpServerScope, s.name)"
            >
              <Trash2 :size="13" :stroke-width="1.75" />
            </button>
          </div>
        </li>
      </ul>
    </div>

    <div class="pad-mcptab__hint">
      <Info :size="12" :stroke-width="1.75" />
      <span>
        MCP (Model Context Protocol) 是 Anthropic 提出的开放标准, 让 LLM 跟外部工具/数据源对话.
        本项目通过官方 SDK 集成, 每个 MCP server 是独立子进程, 走 JSON-RPC over stdio
        (或 HTTP/SSE 长连接, P2-1.8 起).
        <strong>改完配置自动热重载</strong> (P2-2 起, 300ms debounce, 不需重启 sidecar).
      </span>
    </div>
  </div>
</template>

<style scoped>
/* 跟 ToolsTab 视觉一致, 用 pad-mcptab__ 前缀 */
.pad-mcptab {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.pad-mcptab__header {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.pad-mcptab__title {
  margin: 0;
  font-size: var(--pad-fs-20, 20px);
  font-weight: var(--pad-fw-semibold, 600);
  color: var(--pad-fg-primary);
}
.pad-mcptab__subtitle {
  margin: 0;
  font-size: var(--pad-fs-13, 13px);
  color: var(--pad-fg-secondary);
  line-height: 1.5;
}
.pad-mcptab__subtitle code {
  background: var(--pad-bg-active);
  padding: 1px 6px;
  border-radius: var(--pad-radius-sm);
  font-family: var(--pad-font-mono);
  font-size: var(--pad-fs-12);
}
.pad-mcptab__toast {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: var(--pad-radius-md);
  font-size: var(--pad-fs-13);
}
.pad-mcptab__toast.is-ok {
  background: color-mix(in srgb, var(--pad-success, #16a34a) 12%, transparent);
  color: var(--pad-success, #16a34a);
}
.pad-mcptab__toast.is-fail {
  background: color-mix(in srgb, var(--pad-danger, #dc2626) 12%, transparent);
  color: var(--pad-danger, #dc2626);
}
.pad-mcptab__toast-close {
  margin-left: auto;
  background: transparent;
  border: none;
  color: inherit;
  cursor: pointer;
  font-size: var(--pad-fs-16);
  line-height: 1;
  opacity: 0.7;
  padding: 0 4px;
}
.pad-mcptab__toast-close:hover { opacity: 1; }

/* v0.6.3-rc1 P2-3: form/JSON tab 切换 UI */
.pad-mcptab__tabs {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 0 8px 0;
  border-bottom: 1px solid var(--pad-divider);
}
.pad-mcptab__tab {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 12px;
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--pad-fg-secondary);
  font-size: var(--pad-fs-12);
  font-weight: var(--pad-fw-medium);
  cursor: pointer;
  margin-bottom: -1px;  /* 让 active 的下边框对齐 divider */
  transition: color 0.15s, border-color 0.15s;
}
.pad-mcptab__tab:hover {
  color: var(--pad-fg-primary);
}
.pad-mcptab__tab.is-active {
  color: var(--pad-fg-primary);
  border-bottom-color: var(--pad-accent, #3b82f6);
}
.pad-mcptab__tab-hint {
  margin-left: auto;
  font-size: var(--pad-fs-11);
  color: var(--pad-fg-tertiary);
}
.pad-mcptab__error-hint {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
  padding: 6px 10px;
  background: var(--pad-danger-bg, #fef2f2);
  border: 1px solid var(--pad-danger, #dc2626);
  border-radius: var(--pad-radius-sm);
  color: var(--pad-danger, #dc2626);
  font-size: var(--pad-fs-12);
}

.pad-mcptab__section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.pad-mcptab__section-title {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: var(--pad-fs-14, 14px);
  font-weight: var(--pad-fw-semibold, 600);
  color: var(--pad-fg-primary);
}

.pad-mcptab__dialog {
  background: var(--pad-bg-input);
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-md);
  overflow: hidden;
}
.pad-mcptab__dialog-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--pad-divider);
  background: var(--pad-bg-active);
  font-size: var(--pad-fs-13);
  font-weight: var(--pad-fw-medium);
  color: var(--pad-fg-primary);
}
.pad-mcptab__dialog-head code {
  font-family: var(--pad-font-mono);
  background: var(--pad-muted);
  padding: 1px 6px;
  border-radius: var(--pad-radius-sm);
  font-size: var(--pad-fs-12);
}
.pad-mcptab__form {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px;
}
.pad-mcptab__form-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.pad-mcptab__form-row--inline {
  flex-direction: row;
  gap: 6px;
}
.pad-mcptab__form-row--inline .pad-mcptab__input {
  flex: 0 0 auto;
  width: 30%;
  min-width: 100px;
}
.pad-mcptab__form-row--inline .pad-mcptab__input--flex {
  flex: 1 1 auto;
  width: auto;
}
.pad-mcptab__form-row--body {
  gap: 4px;
}
.pad-mcptab__label {
  font-size: var(--pad-fs-12, 12px);
  font-weight: var(--pad-fw-medium);
  color: var(--pad-fg-secondary);
}
.pad-mcptab__label-small {
  font-size: var(--pad-fs-11, 11px);
  font-weight: var(--pad-fw-medium);
  color: var(--pad-fg-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.pad-mcptab__hint-inline {
  font-weight: var(--pad-fw-regular, 400);
  color: var(--pad-fg-tertiary);
  font-size: var(--pad-fs-11, 11px);
  margin-left: 4px;
}
.pad-mcptab__input {
  padding: 6px 10px;
  background: var(--pad-popover);
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-sm);
  font-family: var(--pad-font-mono);
  font-size: var(--pad-fs-13);
  color: var(--pad-fg-primary);
}
.pad-mcptab__input--large {
  font-family: inherit;
  font-size: var(--pad-fs-15, 15px);
  padding: 8px 12px;
  font-weight: var(--pad-fw-medium);
}
.pad-mcptab__input--mono {
  font-family: var(--pad-font-mono);
}
.pad-mcptab__input:focus {
  outline: none;
  border-color: var(--pad-accent);
}
.pad-mcptab__input:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.pad-mcptab__textarea {
  padding: 8px 10px;
  background: var(--pad-popover);
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-sm);
  font-family: var(--pad-font-mono);
  font-size: var(--pad-fs-12, 12px);
  color: var(--pad-fg-primary);
  line-height: 1.5;
  resize: vertical;
  min-height: 200px;
}
.pad-mcptab__textarea--mono {
  font-family: var(--pad-font-mono);
  min-height: 80px;  /* 高级区 env 不需要 200px */
}
.pad-mcptab__textarea:focus {
  outline: none;
  border-color: var(--pad-accent);
}
.pad-mcptab__form-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 4px;
}

/* v0.6.3-rc1 P2-1.4: 高级折叠区 (用 <details> 原生, 零依赖) */
.pad-mcptab__advanced {
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-sm);
  background: var(--pad-bg-input);
}
.pad-mcptab__advanced > summary {
  cursor: pointer;
  padding: 6px 10px;
  font-size: var(--pad-fs-12, 12px);
  color: var(--pad-fg-secondary);
  user-select: none;
  list-style: none;
  display: flex;
  align-items: center;
  gap: 6px;
  border-radius: var(--pad-radius-sm);
  transition: background var(--pad-dur-fast) ease;
}
.pad-mcptab__advanced > summary::-webkit-details-marker { display: none; }  /* Safari 隐藏默认箭头 */
.pad-mcptab__advanced > summary::before {
  content: '▸';
  font-size: 10px;
  color: var(--pad-fg-tertiary);
  transition: transform var(--pad-dur-fast) ease;
  display: inline-block;
  width: 10px;
}
.pad-mcptab__advanced[open] > summary::before {
  transform: rotate(90deg);
}
.pad-mcptab__advanced > summary:hover {
  background: var(--pad-bg-hover);
  color: var(--pad-fg-primary);
}
.pad-mcptab__advanced[open] > summary {
  border-bottom: 1px solid var(--pad-divider);
  font-weight: var(--pad-fw-medium);
}
.pad-mcptab__advanced-body {
  padding: 10px 12px 4px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.pad-mcptab__btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 12px;
  background: transparent;
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-sm);
  font-size: var(--pad-fs-12, 12px);
  color: var(--pad-fg-secondary);
  cursor: pointer;
  font-family: inherit;
  transition: all var(--pad-dur-fast) ease;
}
.pad-mcptab__btn:hover:not(:disabled) {
  background: var(--pad-bg-hover);
  color: var(--pad-fg-primary);
}
.pad-mcptab__btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.pad-mcptab__btn--primary {
  background: var(--pad-primary);
  color: var(--pad-fg-inverse);
  border-color: var(--pad-primary);
}
.pad-mcptab__btn--primary:hover:not(:disabled) {
  background: var(--pad-accent-hover);
  border-color: var(--pad-accent-hover);
}
.pad-mcptab__btn--danger:hover:not(:disabled) {
  color: var(--pad-danger, #dc2626);
  border-color: var(--pad-danger, #dc2626);
}

.pad-mcptab__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 32px 16px;
  background: var(--pad-bg-input);
  border: 1px dashed var(--pad-border);
  border-radius: var(--pad-radius-md);
  color: var(--pad-fg-tertiary);
  gap: 6px;
}
.pad-mcptab__empty-title {
  font-size: var(--pad-fs-13, 13px);
  font-weight: var(--pad-fw-medium);
  color: var(--pad-fg-secondary);
}
.pad-mcptab__empty-desc {
  font-size: var(--pad-fs-12, 12px);
  color: var(--pad-fg-tertiary);
}
.pad-mcptab__empty-meta {
  font-size: var(--pad-fs-11, 11px);
  color: var(--pad-fg-tertiary);
  font-family: var(--pad-font-mono);
  margin-top: 8px;
  text-align: left;
  max-width: 600px;
  line-height: 1.5;
  word-break: break-all;
}
.pad-mcptab__empty-meta code {
  background: var(--pad-bg-active);
  padding: 0 4px;
  border-radius: 3px;
  font-size: var(--pad-fs-10, 10px);
}

.pad-mcptab__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.pad-mcptab__item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  background: var(--pad-bg-input);
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-md);
}
.pad-mcptab__item-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.pad-mcptab__item-name {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.pad-mcptab__item-name code {
  font-family: var(--pad-font-mono);
  font-size: var(--pad-fs-13, 13px);
  font-weight: var(--pad-fw-medium);
  color: var(--pad-fg-primary);
}
.pad-mcptab__scope-tag {
  font-size: var(--pad-fs-10, 10px);
  padding: 1px 6px;
  border-radius: var(--pad-radius-sm);
  font-weight: var(--pad-fw-medium);
  letter-spacing: 0.05em;
  text-transform: uppercase;
}
.pad-mcptab__scope-tag.is-workspace {
  background: color-mix(in srgb, var(--pad-accent) 14%, transparent);
  color: var(--pad-accent);
}
.pad-mcptab__scope-tag.is-global {
  background: var(--pad-muted);
  color: var(--pad-fg-secondary);
}
/* v0.6.3-rc1 P2-1.3: type tag (stdio | http | sse) */
.pad-mcptab__type-tag {
  font-size: var(--pad-fs-10, 10px);
  padding: 1px 6px;
  border-radius: var(--pad-radius-sm);
  font-weight: var(--pad-fw-medium);
  letter-spacing: 0.05em;
  text-transform: uppercase;
  font-family: var(--pad-font-mono);
}
.pad-mcptab__type-tag.is-stdio {
  background: color-mix(in srgb, var(--pad-success, #16a34a) 14%, transparent);
  color: var(--pad-success, #16a34a);
}
.pad-mcptab__type-tag.is-http {
  background: color-mix(in srgb, #2563eb 14%, transparent);
  color: #2563eb;
}
.pad-mcptab__type-tag.is-sse {
  background: color-mix(in srgb, #9333ea 14%, transparent);
  color: #9333ea;
}

/* 2026-08-24 P3-F: runtime 状态 tag (sidecar mcp_status 反馈) */
.pad-mcptab__status-tag {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: var(--pad-fs-10, 10px);
  padding: 1px 6px;
  border-radius: var(--pad-radius-sm);
  font-weight: var(--pad-fw-medium);
}
.pad-mcptab__status-tag.is-started {
  background: color-mix(in srgb, var(--pad-success, #16a34a) 14%, transparent);
  color: var(--pad-success, #16a34a);
}
.pad-mcptab__status-tag.is-failed {
  background: color-mix(in srgb, #dc2626 14%, transparent);
  color: #dc2626;
}
.pad-mcptab__status-tag.is-pending {
  background: var(--pad-muted);
  color: var(--pad-fg-tertiary);
}
.pad-mcptab__status-tag code {
  font-family: var(--pad-font-mono);
}

/* 2026-08-24 P3-F: 失败原因 (单行, 可换行) */
.pad-mcptab__item-error {
  display: flex;
  align-items: flex-start;
  gap: 4px;
  margin-top: 4px;
  padding: 4px 8px;
  background: color-mix(in srgb, #dc2626 8%, transparent);
  border-left: 2px solid #dc2626;
  border-radius: 2px;
  font-size: var(--pad-fs-11, 11px);
  color: var(--pad-fg-secondary);
  line-height: 1.4;
  word-break: break-word;
  white-space: pre-wrap;
}
.pad-mcptab__item-error :first-child {
  flex-shrink: 0;
  margin-top: 1px;
  color: #dc2626;
}

/* 2026-08-24 P3-F: tools 列表 (折叠) */
.pad-mcptab__item-tools {
  margin-top: 4px;
  font-size: var(--pad-fs-11, 11px);
  color: var(--pad-fg-secondary);
}
.pad-mcptab__item-tools summary {
  cursor: pointer;
  user-select: none;
  padding: 2px 0;
  list-style: none;
}
.pad-mcptab__item-tools summary::-webkit-details-marker {
  display: none;
}
.pad-mcptab__item-tools summary::before {
  content: '▸';
  display: inline-block;
  margin-right: 4px;
  transition: transform 0.15s;
}
.pad-mcptab__item-tools[open] summary::before {
  transform: rotate(90deg);
}
.pad-mcptab__item-tools ul {
  list-style: none;
  padding: 4px 0 0 18px;
  margin: 0;
}
.pad-mcptab__item-tools li {
  padding: 2px 0;
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px;
}
.pad-mcptab__item-tools code {
  font-family: var(--pad-font-mono);
  color: var(--pad-fg-primary);
  background: var(--pad-bg-active);
  padding: 1px 4px;
  border-radius: 2px;
}
.pad-mcptab__tool-desc {
  color: var(--pad-fg-tertiary);
  font-size: var(--pad-fs-10, 10px);
}

/* 2026-08-24 P3-F: 顶部 runtime summary */
.pad-mcptab__runtime-summary {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: 8px;
  padding: 2px 8px;
  border-radius: var(--pad-radius-sm);
  font-size: var(--pad-fs-11, 11px);
  font-weight: var(--pad-fw-medium);
  background: var(--pad-bg-active);
  color: var(--pad-fg-secondary);
}
.pad-mcptab__runtime-summary.is-pending {
  opacity: 0.6;
  font-style: italic;
}
.pad-mcptab__runtime-icon-ok {
  color: var(--pad-success, #16a34a);
}
.pad-mcptab__runtime-icon-fail {
  color: #dc2626;
}

/* 2026-08-24 P3-F: refresh button 旋转动画 */
.is-spinning {
  animation: pad-spin 0.8s linear infinite;
}
@keyframes pad-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* v0.6.3-rc1 P2-1.4: inline radio (P2-1.4 还在用, 高级区作用域 radio) */
.pad-mcptab__radio-group--inline {
  flex-direction: row;
  gap: 12px;
  padding: 4px 0;
}
.pad-mcptab__radio-group--inline .pad-mcptab__radio em {
  color: var(--pad-fg-tertiary);
  font-style: normal;
  font-size: var(--pad-fs-11, 11px);
  margin-left: 2px;
}

/* v0.6.3-rc1 P2-1.4: stack radio (目标: workspace / global, 垂直堆叠) */
.pad-mcptab__radio-group--stack {
  flex-direction: column;
  gap: 4px;
  padding: 0;
}
.pad-mcptab__radio--block {
  align-items: flex-start;
  padding: 8px 10px;
  background: var(--pad-popover);
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-sm);
  cursor: pointer;
}
.pad-mcptab__radio--block:has(input:checked) {
  border-color: var(--pad-accent);
  background: color-mix(in srgb, var(--pad-accent) 6%, transparent);
}
.pad-mcptab__radio--block:has(input:disabled) {
  opacity: 0.6;
  cursor: not-allowed;
}
.pad-mcptab__radio-content {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
  min-width: 0;
}
.pad-mcptab__radio-label {
  font-size: var(--pad-fs-13, 13px);
  font-weight: var(--pad-fw-medium);
  color: var(--pad-fg-primary);
}
.pad-mcptab__path-hint {
  font-size: var(--pad-fs-11, 11px);
  color: var(--pad-fg-tertiary);
  font-family: var(--pad-font-mono);
  line-height: 1.5;
  word-break: break-all;
}
.pad-mcptab__path-hint code {
  background: var(--pad-muted);
  padding: 0 4px;
  border-radius: 3px;
  font-size: var(--pad-fs-10, 10px);
}
.pad-mcptab__path-hint--muted {
  opacity: 0.6;
  font-style: italic;
}

/* v0.6.3-rc1 P2-1.4: select (workspace 选择) */
.pad-mcptab__select {
  padding: 4px 8px;
  background: var(--pad-popover);
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-sm);
  font-family: var(--pad-font-mono);
  font-size: var(--pad-fs-12, 12px);
  color: var(--pad-fg-primary);
  max-width: 100%;
  cursor: pointer;
}
.pad-mcptab__select:focus {
  outline: none;
  border-color: var(--pad-accent);
}
.pad-mcptab__select:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.pad-mcptab__item-cmd {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.pad-mcptab__item-cmd code {
  font-family: var(--pad-font-mono);
  font-size: var(--pad-fs-12, 12px);
  color: var(--pad-fg-secondary);
  background: var(--pad-muted);
  padding: 1px 6px;
  border-radius: var(--pad-radius-sm);
}
.pad-mcptab__item-args {
  font-size: var(--pad-fs-11, 11px);
  color: var(--pad-fg-tertiary);
  font-family: var(--pad-font-mono);
}
.pad-mcptab__item-actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}

.pad-mcptab__hint {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 10px 12px;
  background: color-mix(in srgb, var(--pad-accent) 6%, transparent);
  border-radius: var(--pad-radius-md);
  font-size: var(--pad-fs-12, 12px);
  color: var(--pad-fg-secondary);
  line-height: 1.5;
}
.pad-mcptab__hint :deep(svg) {
  flex-shrink: 0;
  margin-top: 2px;
  color: var(--pad-accent);
}

/* ====== 2026-08-21 v0.6.3-rc1 P2-1.1: 导入 JSON dialog 专用样式 ====== */
.pad-mcptab__form-hint {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 8px 10px;
  background: color-mix(in srgb, var(--pad-accent) 6%, transparent);
  border-radius: var(--pad-radius-sm);
  font-size: var(--pad-fs-12, 12px);
  color: var(--pad-fg-secondary);
  line-height: 1.5;
}
.pad-mcptab__form-hint :deep(svg) {
  flex-shrink: 0;
  margin-top: 2px;
  color: var(--pad-accent);
}
.pad-mcptab__form-hint code {
  background: var(--pad-bg-active);
  padding: 0 4px;
  border-radius: 3px;
  font-family: var(--pad-font-mono);
  font-size: var(--pad-fs-11, 11px);
}

.pad-mcptab__radio-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 6px 10px;
  background: var(--pad-popover);
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-sm);
}
.pad-mcptab__radio {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--pad-fs-12, 12px);
  color: var(--pad-fg-secondary);
  cursor: pointer;
}
.pad-mcptab__radio input[type="radio"] {
  margin: 0;
  cursor: pointer;
}
.pad-mcptab__radio:has(input:disabled) {
  opacity: 0.5;
  cursor: not-allowed;
}
.pad-mcptab__radio code {
  background: var(--pad-bg-active);
  padding: 0 4px;
  border-radius: 3px;
  font-family: var(--pad-font-mono);
  font-size: var(--pad-fs-11, 11px);
}

.pad-mcptab__file-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 6px;
}
.pad-mcptab__file-input {
  display: none;  /* 隐藏原生 input, 用 button 触发 */
}

.pad-mcptab__textarea--mono {
  font-family: var(--pad-font-mono);
  font-size: var(--pad-fs-12, 12px);
  min-height: 160px;
}

.pad-mcptab__preview {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  background: var(--pad-popover);
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-sm);
  font-size: var(--pad-fs-12, 12px);
}
.pad-mcptab__preview-block {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.pad-mcptab__preview-block.is-info {
  color: var(--pad-fg-primary);
}
.pad-mcptab__preview-block.is-info :deep(svg) {
  color: var(--pad-success, #16a34a);
}
.pad-mcptab__preview-block.is-error {
  color: var(--pad-danger, #dc2626);
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 6px;
}
.pad-mcptab__preview-block.is-warn {
  color: var(--pad-fg-primary);
}
.pad-mcptab__preview-block :deep(svg) {
  flex-shrink: 0;
}
.pad-mcptab__preview-title {
  display: flex;
  align-items: center;
  gap: 4px;
  font-weight: var(--pad-fw-medium);
}
.pad-mcptab__preview-title code {
  background: var(--pad-muted);
  padding: 0 4px;
  border-radius: 3px;
  font-family: var(--pad-font-mono);
  font-size: var(--pad-fs-11, 11px);
}
.pad-mcptab__preview-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.pad-mcptab__preview-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  background: var(--pad-bg-input);
  border-radius: var(--pad-radius-sm);
  flex-wrap: wrap;
}
.pad-mcptab__preview-name {
  font-family: var(--pad-font-mono);
  font-size: var(--pad-fs-12, 12px);
  font-weight: var(--pad-fw-medium);
  color: var(--pad-fg-primary);
  background: var(--pad-muted);
  padding: 1px 6px;
  border-radius: 3px;
}
.pad-mcptab__preview-cmd {
  font-family: var(--pad-font-mono);
  font-size: var(--pad-fs-11, 11px);
  color: var(--pad-fg-secondary);
}
.pad-mcptab__conflict-tag {
  font-size: var(--pad-fs-10, 10px);
  color: var(--pad-danger, #dc2626);
  background: color-mix(in srgb, var(--pad-danger, #dc2626) 12%, transparent);
  padding: 1px 6px;
  border-radius: var(--pad-radius-sm);
  font-weight: var(--pad-fw-medium);
  margin-left: auto;
}
</style>
