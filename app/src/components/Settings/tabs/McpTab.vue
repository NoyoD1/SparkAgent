<script setup lang="ts">
/**
 * 2026-08-21 v0.6.3-rc1 P2-1: Settings → MCP tab
 *
 * 列出已配置的 MCP server, 跟 Tools tab 同 pattern:
 *   - 列表: 展示所有 MCP server (含 workspace + global 两层 scope)
 *   - 新建: 弹 dialog 填 name / command / args, 保存到 <workspace>/.pi/mcp/<name>.json
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
import { ref, onMounted } from 'vue';
import { storeToRefs } from 'pinia';
import {
  Plug, Plus, X, Save, Trash2, AlertCircle, Check, Info, Pencil,
} from 'lucide-vue-next';
import { useMcpServersStore, type McpServerScope } from '@/stores/mcpServers';

const mcpStore = useMcpServersStore();
const { servers, loading, error } = storeToRefs(mcpStore);

// ====== 新建 dialog state ======
const isCreating = ref(false);
const formName = ref('');
const formCommand = ref('');
const formArgs = ref('');   // 空格分隔的 args (UI 简化), 提交时 split
const isSavingCreate = ref(false);

// ====== 编辑 dialog state (跟新建分开, 走 JSON textarea) ======
const isEditing = ref(false);
const editingScope = ref<McpServerScope>('workspace');
const editingName = ref('');
const editingBody = ref('');
const isSavingEdit = ref(false);

// ====== Toast ======
const toast = ref<{ type: 'ok' | 'fail'; message: string } | null>(null);

function startCreate() {
  isCreating.value = true;
  formName.value = '';
  formCommand.value = 'node';
  formArgs.value = '';
}

function cancelCreate() {
  isCreating.value = false;
  formName.value = '';
  formCommand.value = '';
  formArgs.value = '';
}

async function saveCreate() {
  if (isSavingCreate.value) return;
  isSavingCreate.value = true;
  toast.value = null;
  try {
    const args = formArgs.value
      .split(/\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const body = mcpStore.buildDefaultBody(formName.value, formCommand.value, args);
    await mcpStore.write('workspace', formName.value, body);
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
    editingScope.value = scope;
    editingName.value = name;
    editingBody.value = body;
    isEditing.value = true;
    toast.value = null;
  } catch (e) {
    toast.value = { type: 'fail', message: e instanceof Error ? e.message : String(e) };
  }
}

function cancelEdit() {
  isEditing.value = false;
  editingName.value = '';
  editingBody.value = '';
}

async function saveEdit() {
  if (isSavingEdit.value) return;
  isSavingEdit.value = true;
  toast.value = null;
  try {
    await mcpStore.write(editingScope.value, editingName.value, editingBody.value);
    toast.value = { type: 'ok', message: `已更新 ${editingName.value}` };
    cancelEdit();
    await mcpStore.refresh();
  } catch (e) {
    toast.value = { type: 'fail', message: e instanceof Error ? e.message : String(e) };
  } finally {
    isSavingEdit.value = false;
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

onMounted(() => {
  mcpStore.refresh();
});
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

    <!-- 新建 dialog -->
    <div v-if="isCreating" class="pad-mcptab__dialog">
      <div class="pad-mcptab__dialog-head">
        <Plus :size="14" :stroke-width="1.75" />
        <span>新建 MCP server</span>
        <button class="pad-mcptab__toast-close" @click="cancelCreate">
          <X :size="14" :stroke-width="1.75" />
        </button>
      </div>
      <div class="pad-mcptab__form">
        <div class="pad-mcptab__form-row">
          <label class="pad-mcptab__label">name <span class="pad-mcptab__hint-inline">(1-64 char, [A-Za-z0-9._@-], 不能跟 builtin 重)</span></label>
          <input
            v-model="formName"
            class="pad-mcptab__input"
            placeholder="例如 filesystem"
            spellcheck="false"
          />
        </div>
        <div class="pad-mcptab__form-row">
          <label class="pad-mcptab__label">command <span class="pad-mcptab__hint-inline">(可执行文件: npx / node / 绝对路径 / .exe)</span></label>
          <input
            v-model="formCommand"
            class="pad-mcptab__input"
            placeholder="例如 npx"
            spellcheck="false"
          />
        </div>
        <div class="pad-mcptab__form-row">
          <label class="pad-mcptab__label">args <span class="pad-mcptab__hint-inline">(空格分隔, 会转成 string[] 传给命令)</span></label>
          <input
            v-model="formArgs"
            class="pad-mcptab__input"
            placeholder="例如 -y @modelcontextprotocol/server-filesystem D:\workspace"
            spellcheck="false"
          />
        </div>
        <div class="pad-mcptab__form-actions">
          <button class="pad-mcptab__btn" @click="cancelCreate" :disabled="isSavingCreate">
            <X :size="14" :stroke-width="1.75" />
            <span>取消</span>
          </button>
          <button class="pad-mcptab__btn pad-mcptab__btn--primary" :disabled="isSavingCreate" @click="saveCreate">
            <Save :size="14" :stroke-width="1.75" />
            <span>{{ isSavingCreate ? '保存中…' : '保存到 workspace' }}</span>
          </button>
        </div>
      </div>
    </div>

    <!-- 编辑 dialog -->
    <div v-if="isEditing" class="pad-mcptab__dialog">
      <div class="pad-mcptab__dialog-head">
        <Pencil :size="14" :stroke-width="1.75" />
        <span>编辑 <code>{{ editingName }}</code> (scope: {{ editingScope }})</span>
        <button class="pad-mcptab__toast-close" @click="cancelEdit">
          <X :size="14" :stroke-width="1.75" />
        </button>
      </div>
      <div class="pad-mcptab__form">
        <div class="pad-mcptab__form-row pad-mcptab__form-row--body">
          <label class="pad-mcptab__label">body (JSON)
            <span class="pad-mcptab__hint-inline">
              必填 name + command, 可选 args / env / cwd / timeout.
              <a
                href="https://modelcontextprotocol.io/docs/concepts/architecture"
                target="_blank"
                rel="noopener"
                class="pad-mcptab__link"
              >MCP 协议文档</a>
            </span>
          </label>
          <textarea
            v-model="editingBody"
            class="pad-mcptab__textarea"
            rows="14"
            spellcheck="false"
          />
        </div>
        <div class="pad-mcptab__form-actions">
          <button class="pad-mcptab__btn" @click="cancelEdit" :disabled="isSavingEdit">
            <X :size="14" :stroke-width="1.75" />
            <span>取消</span>
          </button>
          <button class="pad-mcptab__btn pad-mcptab__btn--primary" :disabled="isSavingEdit" @click="saveEdit">
            <Save :size="14" :stroke-width="1.75" />
            <span>{{ isSavingEdit ? '保存中…' : '保存' }}</span>
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
          v-if="!isCreating"
          class="pad-mcptab__btn pad-mcptab__btn--primary"
          @click="startCreate"
        >
          <Plus :size="12" :stroke-width="1.75" />
          <span>新建</span>
        </button>
        <button
          v-if="!loading && servers.length > 0"
          class="pad-mcptab__btn"
          @click="mcpStore.refresh()"
          title="刷新列表"
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
        <div class="pad-mcptab__empty-desc">点 "新建" 按钮配置你的第一个 MCP server. 常见例子: filesystem / fetch / github 等.</div>
      </div>
      <ul v-else class="pad-mcptab__list">
        <li v-for="s in servers" :key="`${s.scope}/${s.name}`" class="pad-mcptab__item">
          <div class="pad-mcptab__item-body">
            <div class="pad-mcptab__item-name">
              <code>{{ s.name }}</code>
              <span class="pad-mcptab__scope-tag" :class="`is-${s.scope}`">{{ s.scope }}</span>
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
</style>
