<script setup lang="ts">
/**
 * 2026-08-21 v0.6.3-rc1 P2-1: Settings → MCP tab
 *
 * 列出已配置的 MCP server, 跟 Tools tab 同 pattern:
 *   - 列表: 展示所有 MCP server (含 workspace + global 两层 scope)
 *   - 新建: 弹 dialog 填 name / command / args, 保存到 <workspace>/.pi/mcp/<name>.json
 *   - 导入 JSON (v0.6.3-rc1 P2-1.1): 粘贴 / 选 .json 文件, auto-detect 3 种格式
 *     (single object / array / Claude Desktop {mcpServers: {...}}), preview 后批量写入
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
 *   (工具名加 mcp_<server>_<tool> 前缀). **不**支持热重载 (P1.5 之后再说), 改完需重启 sidecar.
 */
import { ref, computed, onMounted } from 'vue';
import { storeToRefs } from 'pinia';
import {
  Plug, Plus, X, Save, Trash2, AlertCircle, Check, Info, Pencil, Upload, FileJson,
} from 'lucide-vue-next';
import { useMcpServersStore, type McpServerScope } from '@/stores/mcpServers';
import {
  parseMcpImportJson,
  describeFormat,
  type ImportParseResult,
} from '@/lib/mcpImport';

const mcpStore = useMcpServersStore();
const { servers, loading, error } = storeToRefs(mcpStore);

// v0.6.3-rc1 P2-1.2: 记录当前 MCP 操作的 workspace path, 给 UI 显示 + 排查
//   list_mcp_servers 拿不到 server 时, user 一看路径就知道是不是 active workspace 选错了
const currentWsPath = ref<string>('');

// ====== 新建 dialog state ======
const isCreating = ref(false);
const formName = ref('');
const formCommand = ref('');
const formArgs = ref('');   // 空格分隔的 args (UI 简化), 提交时 split
const isSavingCreate = ref(false);

// ====== 编辑 dialog state (走 unified dialog, 跟新建共用 isCreating) ======
//   editingName / editingBody / editingScope / isSavingEdit 留作 saveEdit 用
const editingScope = ref<McpServerScope>('workspace');
const editingName = ref('');
const editingBody = ref('');
const isSavingEdit = ref(false);

// ====== v0.6.3-rc1 P2-1.3: unified create/edit dialog (form / JSON tab 切换) ======
//   替代之前简单的 form dialog + 纯 JSON edit dialog.
//   创建 / 编辑共用同一个 dialog (通过 isCreating 区分模式),
//   dialog 内部有 form (可视化字段) + json (textarea) 两个 tab, 跟 Cherry Studio 那种风格.
const dialogMode = ref<'create' | 'edit'>('create');   // 当前是新建还是编辑
const dialogTab = ref<'form' | 'json'>('form');       // 当前显示哪个 tab
const dialogType = ref<'stdio' | 'http' | 'sse'>('stdio');
const dialogFormEnv = ref('');                         // env 字段 (JSON object string)
const dialogIsHttpOrSse = computed(() => dialogType.value === 'http' || dialogType.value === 'sse');

function startCreate() {
  dialogMode.value = 'create';
  dialogTab.value = 'form';
  dialogType.value = 'stdio';
  formName.value = '';
  formCommand.value = 'node';
  formArgs.value = '';
  dialogFormEnv.value = '{}';
  editingScope.value = 'workspace';
  isCreating.value = true;
}

function cancelCreate() {
  isCreating.value = false;
  formName.value = '';
  formCommand.value = '';
  formArgs.value = '';
  dialogFormEnv.value = '';
}

async function saveCreate() {
  if (isSavingCreate.value) return;
  isSavingCreate.value = true;
  toast.value = null;
  try {
    // v0.6.3-rc1 P2-1.3: HTTP / SSE 暂未实现, 明确拒绝保存
    if (dialogType.value !== 'stdio') {
      throw new Error(`暂未支持 ${dialogType.value.toUpperCase()} 传输 (P2.3 实现), 当前请用 stdio`);
    }
    const args = formArgs.value
      .split(/\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const env = parseEnvJson(dialogFormEnv.value, '环境变量');
    const body = mcpStore.buildBodyFromForm({
      type: dialogType.value,
      name: formName.value,
      command: formCommand.value,
      args,
      env,
      timeout: 30000,
    });
    await mcpStore.write(editingScope.value, formName.value, body);
    toast.value = { type: 'ok', message: `已创建 ${formName.value}` };
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
    dialogTab.value = 'form';
    editingScope.value = scope;
    editingName.value = name;
    editingBody.value = body;
    // 反解 body 到 form 字段 (form tab 默认显示, user 可切到 json tab 看原文)
    try {
      const obj = JSON.parse(body);
      dialogType.value = (obj.type === 'http' || obj.type === 'sse') ? obj.type : 'stdio';
      formCommand.value = obj.command || '';
      formArgs.value = Array.isArray(obj.args) ? obj.args.join(' ') : '';
      dialogFormEnv.value = obj.env ? JSON.stringify(obj.env, null, 2) : '{}';
    } catch {
      // body 解析失败, 切到 json tab 让 user 看原文
      dialogTab.value = 'json';
    }
    isCreating.value = true;  // 跟新建共用一个 dialog
    toast.value = null;
  } catch (e) {
    toast.value = { type: 'fail', message: e instanceof Error ? e.message : String(e) };
  }
}

async function saveEdit() {
  if (isSavingEdit.value) return;
  isSavingEdit.value = true;
  toast.value = null;
  try {
    let body: string;
    if (dialogTab.value === 'form') {
      // v0.6.3-rc1 P2-1.3: HTTP / SSE 暂未实现
      if (dialogType.value !== 'stdio') {
        throw new Error(`暂未支持 ${dialogType.value.toUpperCase()} 传输 (P2.3 实现), 当前请用 stdio`);
      }
      const args = formArgs.value
        .split(/\s+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      const env = parseEnvJson(dialogFormEnv.value, '环境变量');
      body = mcpStore.buildBodyFromForm({
        type: dialogType.value,
        name: editingName.value,
        command: formCommand.value,
        args,
        env,
        timeout: 30000,
      });
    } else {
      body = editingBody.value;
    }
    await mcpStore.write(editingScope.value, editingName.value, body);
    toast.value = { type: 'ok', message: `已更新 ${editingName.value}` };
    cancelCreate();
    await mcpStore.refresh();
  } catch (e) {
    toast.value = { type: 'fail', message: e instanceof Error ? e.message : String(e) };
  } finally {
    isSavingEdit.value = false;
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
        <strong>修改后需重启 sidecar 生效 (不支持热重载)</strong>.
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

    <!-- v0.6.3-rc1 P2-1.3: unified create/edit dialog (form / JSON tab 切换, 跟 Cherry Studio 风格) -->
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

      <!-- 顶部 hint -->
      <div class="pad-mcptab__form-hint">
        <Info :size="12" :stroke-width="1.75" />
        <span>
          填写 MCP 配置, 保存后返回列表. 修改后需重启 sidecar 生效.
          <a
            href="https://modelcontextprotocol.io/docs/concepts/architecture"
            target="_blank"
            rel="noopener"
            class="pad-mcptab__link"
          >MCP 协议文档</a>
        </span>
      </div>

      <div class="pad-mcptab__form">
        <!-- 名称 (创建模式可编辑, 编辑模式只读, 改名通过删除+新建) -->
        <div class="pad-mcptab__form-row">
          <label class="pad-mcptab__label">名称 <span class="pad-mcptab__hint-inline">(1-64 char, [A-Za-z0-9._@-], 不能跟 builtin 重)</span></label>
          <input
            v-model="formName"
            class="pad-mcptab__input"
            placeholder="例如 filesystem"
            spellcheck="false"
            :disabled="dialogMode === 'edit'"
          />
        </div>

        <!-- 作用域 (workspace / global) -->
        <div class="pad-mcptab__form-row">
          <label class="pad-mcptab__label">作用域</label>
          <div class="pad-mcptab__radio-group">
            <label class="pad-mcptab__radio">
              <input
                type="radio"
                value="workspace"
                v-model="editingScope"
                :disabled="dialogMode === 'edit' || isSavingCreate"
              />
              <span>workspace (当前工作区 <code>&lt;ws&gt;/.pi/mcp/&lt;name&gt;.json</code>)</span>
            </label>
            <label class="pad-mcptab__radio">
              <input
                type="radio"
                value="global"
                v-model="editingScope"
                :disabled="dialogMode === 'edit' || isSavingCreate"
              />
              <span>global (跨工作区 <code>&lt;agentDir&gt;/mcp/&lt;name&gt;.json</code>)</span>
            </label>
          </div>
        </div>

        <!-- 类型 (stdio / http / sse) — v0.6.3-rc1 P2-1.3 -->
        <div class="pad-mcptab__form-row">
          <label class="pad-mcptab__label">类型 <span class="pad-mcptab__hint-inline">(transport 协议, stdio 已实现 / http / sse 暂未支持 P2.3)</span></label>
          <div class="pad-mcptab__radio-group pad-mcptab__radio-group--inline">
            <label class="pad-mcptab__radio">
              <input
                type="radio"
                value="stdio"
                v-model="dialogType"
                :disabled="isSavingCreate"
              />
              <span>stdio (本地命令)</span>
            </label>
            <label class="pad-mcptab__radio" :title="`HTTP transport 暂未实现 (P2.3), 选了会保存失败`">
              <input
                type="radio"
                value="http"
                v-model="dialogType"
                :disabled="true"
              />
              <span>HTTP <em>(暂未支持)</em></span>
            </label>
            <label class="pad-mcptab__radio" :title="`SSE transport 暂未实现 (P2.3), 选了会保存失败`">
              <input
                type="radio"
                value="sse"
                v-model="dialogType"
                :disabled="true"
              />
              <span>SSE (Server-Sent Events) <em>(暂未支持)</em></span>
            </label>
          </div>
        </div>

        <!-- 表单 / JSON tab 切换 (跟 Cherry Studio 截图同 UX) -->
        <div class="pad-mcptab__tab-bar">
          <button
            type="button"
            class="pad-mcptab__tab"
            :class="{ 'is-active': dialogTab === 'form' }"
            @click="dialogTab = 'form'"
            :disabled="isSavingCreate"
          >表单</button>
          <button
            type="button"
            class="pad-mcptab__tab"
            :class="{ 'is-active': dialogTab === 'json' }"
            @click="dialogTab = 'json'"
            :disabled="isSavingCreate"
          >JSON</button>
        </div>

        <!-- 表单 tab 内容 -->
        <template v-if="dialogTab === 'form'">
          <div class="pad-mcptab__form-row">
            <label class="pad-mcptab__label">命令 <span class="pad-mcptab__hint-inline">(可执行文件: npx / node / 绝对路径 / .exe)</span></label>
            <input
              v-model="formCommand"
              class="pad-mcptab__input"
              placeholder="例如 npx"
              spellcheck="false"
              :disabled="dialogIsHttpOrSse"
            />
          </div>
          <div class="pad-mcptab__form-row">
            <label class="pad-mcptab__label">参数 <span class="pad-mcptab__hint-inline">(空格分隔, 会转成 string[] 传给命令)</span></label>
            <input
              v-model="formArgs"
              class="pad-mcptab__input"
              placeholder="例如 -y @modelcontextprotocol/server-filesystem D:\workspace"
              spellcheck="false"
              :disabled="dialogIsHttpOrSse"
            />
          </div>
          <div class="pad-mcptab__form-row">
            <label class="pad-mcptab__label">环境变量 <span class="pad-mcptab__hint-inline">(JSON object, 留空用 {})</span></label>
            <textarea
              v-model="dialogFormEnv"
              class="pad-mcptab__textarea pad-mcptab__textarea--mono"
              rows="4"
              spellcheck="false"
              placeholder='例如 { "MY_API_KEY": "your-key" }'
              :disabled="dialogIsHttpOrSse"
            />
          </div>
          <div v-if="dialogIsHttpOrSse" class="pad-mcptab__form-hint pad-mcptab__form-hint--warn">
            <AlertCircle :size="12" :stroke-width="1.75" />
            <span>{{ dialogType.toUpperCase() }} 暂未实现, 切换回 stdio 后才能保存</span>
          </div>
        </template>

        <!-- JSON tab 内容 (直接编辑完整 body) -->
        <template v-else>
          <div class="pad-mcptab__form-row pad-mcptab__form-row--body">
            <label class="pad-mcptab__label">body (JSON)
              <span class="pad-mcptab__hint-inline">type 必填 stdio, name/command 必填 string</span>
            </label>
            <textarea
              v-model="editingBody"
              class="pad-mcptab__textarea"
              rows="12"
              spellcheck="false"
            />
          </div>
        </template>

        <!-- 底部按钮 -->
        <div class="pad-mcptab__form-actions">
          <button
            class="pad-mcptab__btn"
            @click="cancelCreate"
            :disabled="isSavingCreate || isSavingEdit"
          >
            <X :size="14" :stroke-width="1.75" />
            <span>取消</span>
          </button>
          <button
            v-if="dialogMode === 'create'"
            class="pad-mcptab__btn pad-mcptab__btn--primary"
            :disabled="isSavingCreate || dialogIsHttpOrSse"
            @click="saveCreate"
          >
            <Save :size="14" :stroke-width="1.75" />
            <span>{{ isSavingCreate ? '添加中…' : '添加' }}</span>
          </button>
          <button
            v-else
            class="pad-mcptab__btn pad-mcptab__btn--primary"
            :disabled="isSavingEdit || (dialogTab === 'form' && dialogIsHttpOrSse)"
            @click="saveEdit"
          >
            <Save :size="14" :stroke-width="1.75" />
            <span>{{ isSavingEdit ? '保存中…' : '保存' }}</span>
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
            支持 3 种格式 (auto-detect): ① 单个 <code>{name, command, args}</code> ②
            <code>[{...}, {...}]</code> array ③ Claude Desktop 标准
            <code>{mcpServers: {name: {...}}}</code>.
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
            placeholder='例 1: { "name": "filesystem", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "D:\\path"] }&#10;&#10;例 2: { "mcpServers": { "filesystem": { ... }, "fetch": { ... } } }'
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
            </div>
            <div class="pad-mcptab__item-cmd">
              <code>{{ s.command }}</code>
              <span class="pad-mcptab__item-args">{{ summarizeArgs(s.body) }}</span>
            </div>
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
        本项目通过官方 SDK 集成, 每个 MCP server 是独立子进程, 走 JSON-RPC over stdio.
        修改配置后需重启 sidecar 生效 (侧边栏切 workspace / 退出 app 再开, 都会触发 sidecar 重启).
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
.pad-mcptab__form-row--body {
  gap: 4px;
}
.pad-mcptab__label {
  font-size: var(--pad-fs-12, 12px);
  font-weight: var(--pad-fw-medium);
  color: var(--pad-fg-secondary);
}
.pad-mcptab__hint-inline {
  font-weight: var(--pad-fw-regular, 400);
  color: var(--pad-fg-tertiary);
  font-size: var(--pad-fs-11, 11px);
  margin-left: 4px;
}
.pad-mcptab__link {
  color: var(--pad-accent);
  text-decoration: none;
  margin-left: 4px;
}
.pad-mcptab__link:hover { text-decoration: underline; }
.pad-mcptab__input {
  padding: 6px 10px;
  background: var(--pad-popover);
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-sm);
  font-family: var(--pad-font-mono);
  font-size: var(--pad-fs-13);
  color: var(--pad-fg-primary);
}
.pad-mcptab__input:focus {
  outline: none;
  border-color: var(--pad-accent);
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

/* v0.6.3-rc1 P2-1.3: form/JSON tab bar (跟 Cherry Studio 同 UX) */
.pad-mcptab__tab-bar {
  display: flex;
  gap: 0;
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-sm);
  overflow: hidden;
  align-self: flex-end;
  margin-bottom: 4px;
}
.pad-mcptab__tab {
  background: var(--pad-popover);
  border: none;
  padding: 4px 12px;
  font-size: var(--pad-fs-12, 12px);
  color: var(--pad-fg-secondary);
  cursor: pointer;
  font-family: inherit;
  transition: all var(--pad-dur-fast) ease;
}
.pad-mcptab__tab:not(:first-child) {
  border-left: 1px solid var(--pad-border);
}
.pad-mcptab__tab:hover:not(:disabled) {
  background: var(--pad-bg-hover);
  color: var(--pad-fg-primary);
}
.pad-mcptab__tab.is-active {
  background: var(--pad-primary);
  color: var(--pad-fg-inverse);
}
.pad-mcptab__tab:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* v0.6.3-rc1 P2-1.3: inline radio (3 个一排) */
.pad-mcptab__radio-group--inline {
  flex-direction: row;
  gap: 12px;
  padding: 8px 10px;
}
.pad-mcptab__radio-group--inline .pad-mcptab__radio em {
  color: var(--pad-fg-tertiary);
  font-style: normal;
  font-size: var(--pad-fs-11, 11px);
  margin-left: 2px;
}

/* v0.6.3-rc1 P2-1.3: warn 风格的 form hint (用于 HTTP/SSE 警告) */
.pad-mcptab__form-hint--warn {
  background: color-mix(in srgb, var(--pad-danger, #dc2626) 6%, transparent);
}
.pad-mcptab__form-hint--warn :deep(svg) {
  color: var(--pad-danger, #dc2626);
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
