<script setup lang="ts">
/**
 * SecretsTab — ADR-0023 P3-C (2026-08-24)
 *
 * 通用 keychain secret 管理 (MCP server env / external tool env 用).
 * 跟 LLM apiKey 走同一个 OS keychain (Windows Credential Manager / macOS Keychain /
 * Linux Secret Service), service="pi-agent", user 是 secret name.
 *
 * 用法:
 *   1. 在这里 add secret (e.g. name="external-tavily_search-TAVILY_API_KEY", value=tvly-xxx)
 *   2. 在 MCP server env / external tool manifest.env 里写
 *      "TAVILY_API_KEY": "keychain:pi-agent:external-tavily_search-TAVILY_API_KEY"
 *   3. sidecar 启动 / 收到 tool call 时, 把 keychain 引用解析成明文再注入 subprocess env
 *   4. JSON 配置文件里**只有引用没有明文**, 备份 / git push 不怕泄露
 *
 * 命名建议:
 *   - mcp-<server-name>-<env-field>           e.g. mcp-MiniMax-MINIMAX_API_KEY
 *   - external-<tool-name>-<env-field>       e.g. external-tavily_search-TAVILY_API_KEY
 *   - LLM apiKey 跟 secret 走同一个 keychain, 但 LLM apiKey 走专有 "Provider" tab 管理
 *     (历史 + UX 原因, 避免两边都能改导致混乱)
 */
import { ref, onMounted } from 'vue';
import { KeyRound, Plus, Trash2, Save, X, AlertCircle, Info, Loader2 } from 'lucide-vue-next';
import { piTauri } from '@/lib/tauri';

// ====== state ======
const secrets = ref<Array<{ providerId: string; configured: boolean; preview: string | null }>>([]);
const loading = ref(false);
const isAddOpen = ref(false);
const isSaving = ref(false);
const isDeleting = ref<string | null>(null);
const newName = ref('');
const newValue = ref('');
const toast = ref<{ type: 'ok' | 'fail' | 'warn'; message: string } | null>(null);

const NAME_RE = /^[A-Za-z0-9._@-]+$/;

async function refresh() {
  loading.value = true;
  try {
    secrets.value = await piTauri.listSecrets();
  } catch (e) {
    toast.value = { type: 'fail', message: `读 secret 列表失败: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    loading.value = false;
  }
}

function startAdd() {
  isAddOpen.value = true;
  newName.value = '';
  newValue.value = '';
}

function cancelAdd() {
  isAddOpen.value = false;
  newName.value = '';
  newValue.value = '';
}

async function saveAdd() {
  if (isSaving.value) return;
  const name = newName.value.trim();
  const value = newValue.value;
  if (!name) {
    toast.value = { type: 'warn', message: 'name 不能为空' };
    return;
  }
  if (value.length === 0) {
    toast.value = { type: 'warn', message: 'value 不能为空' };
    return;
  }
  if (name.length > 128) {
    toast.value = { type: 'warn', message: `name 太长: ${name.length} > 128` };
    return;
  }
  if (!NAME_RE.test(name)) {
    toast.value = { type: 'warn', message: `name '${name}' 含非法字符, 只能 [A-Za-z0-9._@-]` };
    return;
  }
  // 防跟已有重名
  if (secrets.value.some((s) => s.providerId === name)) {
    toast.value = { type: 'warn', message: `已存在 secret '${name}', 请先删除再添加 (或换名)` };
    return;
  }
  isSaving.value = true;
  try {
    await piTauri.saveSecret(name, value);
    toast.value = { type: 'ok', message: `已保存 secret '${name}'` };
    cancelAdd();
    await refresh();
    // ADR-0023 P3-A: 改 secret 触发静默重启, 新配置下次对话生效
    //   (跟 dangerousWhitelist / bash.path 同 pattern, 走 P3-A 静默重启)
    void piTauri.restartAllSidecars('secret_changed');
  } catch (e) {
    toast.value = { type: 'fail', message: `保存失败: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    isSaving.value = false;
  }
}

async function deleteSecret(name: string) {
  if (isDeleting.value) return;
  if (!confirm(`确认删除 secret?\n\nname: ${name}\n\n删除后, MCP / external tool 引用 'keychain:pi-agent:${name}' 的地方会启动失败, 直到你重新添加.`)) {
    return;
  }
  isDeleting.value = name;
  try {
    await piTauri.deleteSecret(name);
    toast.value = { type: 'ok', message: `已删除 '${name}'` };
    await refresh();
    void piTauri.restartAllSidecars('secret_changed');
  } catch (e) {
    toast.value = { type: 'fail', message: `删除失败: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    isDeleting.value = null;
  }
}

onMounted(() => {
  void refresh();
});
</script>

<template>
  <div class="pad-secret-tab">
    <!-- 头部: 说明 + 添加按钮 -->
    <div class="pad-secret-tab__head">
      <div class="pad-secret-tab__intro">
        <div class="pad-secret-tab__title">
          <KeyRound :size="14" :stroke-width="1.75" />
          <span>Secret 管理</span>
        </div>
        <p class="pad-secret-tab__desc">
          存到 OS keychain (Windows Credential Manager / macOS Keychain / Linux Secret Service).
          在 MCP server env / external tool manifest.env 里用
          <code class="pad-secret-tab__inline-code">"keychain:pi-agent:&lt;name&gt;"</code>
          引用, 不会再有明文存盘.
        </p>
      </div>
      <button
        v-if="!isAddOpen"
        class="pad-secret-tab__btn pad-secret-tab__btn--primary"
        type="button"
        @click="startAdd"
      >
        <Plus :size="13" :stroke-width="2" />
        <span>添加 secret</span>
      </button>
    </div>

    <!-- 提示 toast -->
    <div v-if="toast" :class="['pad-secret-tab__toast', `is-${toast.type}`]">
      <AlertCircle v-if="toast.type === 'fail'" :size="13" :stroke-width="1.75" />
      <Info v-else :size="13" :stroke-width="1.75" />
      <span>{{ toast.message }}</span>
    </div>

    <!-- 添加 form -->
    <div v-if="isAddOpen" class="pad-secret-tab__add-form">
      <div class="pad-secret-tab__form-row">
        <label class="pad-secret-tab__label">name (keychain user)</label>
        <input
          v-model="newName"
          class="pad-secret-tab__input"
          type="text"
          placeholder="e.g. external-tavily_search-TAVILY_API_KEY"
          spellcheck="false"
          maxlength="128"
        />
        <span class="pad-secret-tab__hint">
          推荐命名: <code>mcp-&lt;server&gt;-&lt;field&gt;</code> 或
          <code>external-&lt;tool&gt;-&lt;field&gt;</code>. 跟 LLM apiKey 命名空间共用,
          但 LLM apiKey 走专有 Provider tab, 这里管其它所有 secret.
        </span>
      </div>
      <div class="pad-secret-tab__form-row">
        <label class="pad-secret-tab__label">value (明文, 只用一次)</label>
        <input
          v-model="newValue"
          class="pad-secret-tab__input pad-secret-tab__input--mono"
          type="password"
          placeholder="e.g. tvly-xxxxxxxxxxxxx"
          spellcheck="false"
        />
        <span class="pad-secret-tab__hint">
          写到 keychain 后, FE / 日志 / 配置文件 都看不到明文. 想看明文只能删了重加.
        </span>
      </div>
      <div class="pad-secret-tab__form-actions">
        <button
          class="pad-secret-tab__btn"
          type="button"
          :disabled="isSaving"
          @click="cancelAdd"
        >
          <X :size="13" :stroke-width="2" />
          <span>取消</span>
        </button>
        <button
          class="pad-secret-tab__btn pad-secret-tab__btn--primary"
          type="button"
          :disabled="isSaving"
          @click="saveAdd"
        >
          <Loader2 v-if="isSaving" :size="13" :stroke-width="2" class="pad-secret-tab__spin" />
          <Save v-else :size="13" :stroke-width="2" />
          <span>{{ isSaving ? '保存中…' : '保存到 keychain' }}</span>
        </button>
      </div>
    </div>

    <!-- 列表 -->
    <div v-if="loading && secrets.length === 0" class="pad-secret-tab__loading">
      <Loader2 :size="14" :stroke-width="1.75" class="pad-secret-tab__spin" />
      <span>读取中…</span>
    </div>
    <div v-else-if="secrets.length === 0" class="pad-secret-tab__empty">
      <div class="pad-secret-tab__empty-icon">
        <KeyRound :size="20" :stroke-width="1.5" />
      </div>
      <div class="pad-secret-tab__empty-title">还没有 secret</div>
      <div class="pad-secret-tab__empty-desc">
        点右上 "添加 secret" 创建一个, 然后在 MCP / external tool 配置里用
        <code class="pad-secret-tab__inline-code">"keychain:pi-agent:&lt;name&gt;"</code> 引用.
      </div>
    </div>
    <ul v-else class="pad-secret-tab__list">
      <li
        v-for="s in secrets"
        :key="s.providerId"
        class="pad-secret-tab__item"
      >
        <div class="pad-secret-tab__item-icon">
          <KeyRound :size="13" :stroke-width="1.75" />
        </div>
        <div class="pad-secret-tab__item-body">
          <div class="pad-secret-tab__item-name">{{ s.providerId }}</div>
          <div class="pad-secret-tab__item-meta">
            <span v-if="s.configured" class="pad-secret-tab__item-preview">{{ s.preview ?? '***' }}</span>
            <span v-else class="pad-secret-tab__item-missing">(keychain 找不到 — 可能被外部删了)</span>
          </div>
          <div class="pad-secret-tab__item-ref">
            引用语法: <code class="pad-secret-tab__inline-code">keychain:pi-agent:{{ s.providerId }}</code>
          </div>
        </div>
        <button
          class="pad-secret-tab__btn pad-secret-tab__btn--danger"
          type="button"
          :disabled="isDeleting === s.providerId"
          @click="deleteSecret(s.providerId)"
        >
          <Loader2 v-if="isDeleting === s.providerId" :size="12" :stroke-width="2" class="pad-secret-tab__spin" />
          <Trash2 v-else :size="12" :stroke-width="1.75" />
          <span>{{ isDeleting === s.providerId ? '删除中…' : '删除' }}</span>
        </button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.pad-secret-tab {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 4px 0;
}

.pad-secret-tab__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.pad-secret-tab__intro {
  flex: 1;
  min-width: 0;
}

.pad-secret-tab__title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--pad-fs-13);
  font-weight: var(--pad-fw-medium);
  color: var(--pad-fg-primary);
  margin-bottom: 4px;
}

.pad-secret-tab__desc {
  margin: 0;
  font-size: var(--pad-fs-11);
  color: var(--pad-fg-tertiary);
  line-height: 1.5;
}

.pad-secret-tab__inline-code {
  font-family: var(--pad-font-mono, monospace);
  font-size: 11px;
  padding: 1px 4px;
  background: var(--pad-muted);
  border-radius: 3px;
  color: var(--pad-fg-secondary);
}

.pad-secret-tab__toast {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  font-size: var(--pad-fs-12);
  border-radius: var(--pad-radius-md);
  border: 1px solid var(--pad-border);
}
.pad-secret-tab__toast.is-ok {
  background: var(--pad-success-soft, #f0fdf4);
  border-color: var(--pad-success, #16a34a);
  color: var(--pad-success-text, #15803d);
}
.pad-secret-tab__toast.is-fail {
  background: var(--pad-danger-soft, #fef2f2);
  border-color: var(--pad-danger, #dc2626);
  color: var(--pad-danger-text, #b91c1c);
}
.pad-secret-tab__toast.is-warn {
  background: var(--pad-warning-soft, #fffbeb);
  border-color: var(--pad-warning, #d97706);
  color: var(--pad-warning-text, #b45309);
}

.pad-secret-tab__add-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  background: var(--pad-muted);
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-md);
}

.pad-secret-tab__form-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.pad-secret-tab__label {
  font-size: var(--pad-fs-11);
  font-weight: var(--pad-fw-medium);
  color: var(--pad-fg-secondary);
}

.pad-secret-tab__input {
  width: 100%;
  height: 28px;
  padding: 0 8px;
  font-size: var(--pad-fs-12);
  background: var(--pad-card, #fff);
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-sm);
  color: var(--pad-fg-primary);
  font-family: inherit;
}
.pad-secret-tab__input:focus {
  outline: none;
  border-color: var(--pad-accent, #6366f1);
}
.pad-secret-tab__input--mono {
  font-family: var(--pad-font-mono, monospace);
}

.pad-secret-tab__hint {
  font-size: var(--pad-fs-10);
  color: var(--pad-fg-tertiary);
  line-height: 1.4;
}

.pad-secret-tab__form-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}

.pad-secret-tab__btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 12px;
  font-size: var(--pad-fs-12);
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-sm);
  background: var(--pad-card, #fff);
  color: var(--pad-fg-primary);
  cursor: pointer;
  transition: all var(--pad-dur-fast, 0.12s) ease;
  font-family: inherit;
}
.pad-secret-tab__btn:hover:not(:disabled) {
  background: var(--pad-bg-hover, var(--pad-muted));
  border-color: var(--pad-fg-tertiary);
}
.pad-secret-tab__btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.pad-secret-tab__btn--primary {
  background: var(--pad-accent, #6366f1);
  color: #fff;
  border-color: var(--pad-accent, #6366f1);
}
.pad-secret-tab__btn--primary:hover:not(:disabled) {
  background: var(--pad-accent-hover, #4f46e5);
  border-color: var(--pad-accent-hover, #4f46e5);
}
.pad-secret-tab__btn--danger {
  color: var(--pad-danger, #dc2626);
  border-color: var(--pad-danger-soft, #fee2e2);
}
.pad-secret-tab__btn--danger:hover:not(:disabled) {
  background: var(--pad-danger-soft, #fee2e2);
  border-color: var(--pad-danger, #dc2626);
}

.pad-secret-tab__loading {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 16px;
  color: var(--pad-fg-tertiary);
  font-size: var(--pad-fs-12);
  justify-content: center;
}

.pad-secret-tab__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 24px 16px;
  border: 1px dashed var(--pad-border);
  border-radius: var(--pad-radius-md);
  color: var(--pad-fg-tertiary);
}
.pad-secret-tab__empty-icon {
  width: 32px;
  height: 32px;
  border: 1px solid var(--pad-border);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 8px;
  color: var(--pad-fg-tertiary);
}
.pad-secret-tab__empty-title {
  font-size: var(--pad-fs-12);
  color: var(--pad-fg-secondary);
  margin-bottom: 4px;
  letter-spacing: 0.04em;
}
.pad-secret-tab__empty-desc {
  font-size: var(--pad-fs-11);
  line-height: 1.5;
  max-width: 360px;
}

.pad-secret-tab__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.pad-secret-tab__item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  background: var(--pad-card, #fff);
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-md);
}

.pad-secret-tab__item-icon {
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--pad-fg-tertiary);
  border-radius: var(--pad-radius-sm);
  background: var(--pad-muted);
}

.pad-secret-tab__item-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.pad-secret-tab__item-name {
  font-size: var(--pad-fs-12);
  font-weight: var(--pad-fw-medium);
  color: var(--pad-fg-primary);
  font-family: var(--pad-font-mono, monospace);
}

.pad-secret-tab__item-meta {
  font-size: var(--pad-fs-11);
  color: var(--pad-fg-tertiary);
  font-family: var(--pad-font-mono, monospace);
}

.pad-secret-tab__item-preview {
  color: var(--pad-fg-secondary);
}

.pad-secret-tab__item-missing {
  color: var(--pad-danger, #dc2626);
}

.pad-secret-tab__item-ref {
  font-size: var(--pad-fs-10);
  color: var(--pad-fg-tertiary);
}

.pad-secret-tab__spin {
  animation: pad-secret-tab-spin 1s linear infinite;
}

@keyframes pad-secret-tab-spin {
  to { transform: rotate(360deg); }
}
</style>
