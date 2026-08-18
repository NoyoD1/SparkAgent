<script setup lang="ts">
/**
 * v0.4.6 CustomInstructionsTab — 设置面板 "自定义指令" tab
 *
 * 跟 Claude 桌面端 "自定义指令" 模式 (图 2): 单 textarea 编辑额外 system prompt,
 * 持久化到 <workspace>/AGENTS.md (per-workspace) + <agentDir>/AGENTS.md (global).
 *
 * Pi SDK 0.84.2 DefaultResourceLoader (resource-loader.ts:71) 自动 load AGENTS.md
 *   到 system prompt; sidecar 启动时把 paths 传 appendSystemPromptSource (v0.4.6c).
 * 跟 skills 一样 scope 切换 (workspace / global).
 */
import { ref, computed, onMounted, watch } from 'vue';
import { FileText, Save, Trash2, AlertCircle, Check, Info, Globe, FolderOpen } from 'lucide-vue-next';
import { piTauri } from '@/lib/tauri';
import { useSessionStore } from '@/stores/session';

const sessionStore = useSessionStore();
const activeWorkspace = computed(() => sessionStore.activeWorkspace);

type Scope = 'workspace' | 'global';
const scope = ref<Scope>('workspace');
const filePath = ref<string | null>(null);
const content = ref<string>('');
const originalContent = ref<string>('');
const isLoading = ref(false);
const isSaving = ref(false);
const isDeleting = ref(false);
const toast = ref<{ type: 'ok' | 'fail'; message: string } | null>(null);
const modifiedAt = ref<string | null>(null);

const hasChanges = computed(() => content.value !== originalContent.value);
const hasContent = computed(() => filePath.value !== null);

async function loadInstructions() {
  isLoading.value = true;
  toast.value = null;
  try {
    const res = await piTauri.readCustomInstructions({
      scope: scope.value,
      workspacePath: activeWorkspace.value?.path ?? null,
      agentDir: null,  // global 走 Rust fallback 算 (USERPROFILE/HOME + .pi/agent)
    });
    filePath.value = res.filePath;
    content.value = res.content;
    originalContent.value = res.content;
    modifiedAt.value = res.modifiedAt;
  } catch (e) {
    toast.value = { type: 'fail', message: e instanceof Error ? e.message : String(e) };
  } finally {
    isLoading.value = false;
  }
}

async function save() {
  if (isSaving.value) return;
  isSaving.value = true;
  toast.value = null;
  try {
    const path = await piTauri.writeCustomInstructions({
      scope: scope.value,
      workspacePath: activeWorkspace.value?.path ?? null,
      agentDir: null,
      content: content.value,
    });
    filePath.value = path;
    originalContent.value = content.value;
    toast.value = { type: 'ok', message: `已保存到 ${path}` };
  } catch (e) {
    toast.value = { type: 'fail', message: e instanceof Error ? e.message : String(e) };
  } finally {
    isSaving.value = false;
  }
}

async function remove() {
  if (isDeleting.value) return;
  if (!filePath.value) return;
  if (!confirm(`确认删除?\n\n${filePath.value}`)) return;
  isDeleting.value = true;
  toast.value = null;
  try {
    const ok = await piTauri.deleteCustomInstructions({
      scope: scope.value,
      workspacePath: activeWorkspace.value?.path ?? null,
      agentDir: null,
    });
    if (ok) {
      content.value = '';
      originalContent.value = '';
      filePath.value = null;
      modifiedAt.value = null;
      toast.value = { type: 'ok', message: '已删除' };
    } else {
      toast.value = { type: 'fail', message: '文件不存在' };
    }
  } catch (e) {
    toast.value = { type: 'fail', message: e instanceof Error ? e.message : String(e) };
  } finally {
    isDeleting.value = false;
  }
}

watch(scope, () => {
  loadInstructions();
});

onMounted(loadInstructions);
</script>

<template>
  <div class="pad-instrtab">
    <div class="pad-instrtab__header">
      <h2 class="pad-instrtab__title">自定义指令</h2>
      <p class="pad-instrtab__subtitle">
        为此设备上的所有 Agent 提供额外指令和上下文.
        Pi SDK 启动时会自动 load <code>AGENTS.md</code> 注入 system prompt.
      </p>
    </div>

    <!-- Scope 切换 (跟 Claude 一样左栏导航, 这里用 segment) -->
    <div class="pad-instrtab__scope">
      <button
        class="pad-instrtab__scope-btn"
        :class="{ 'is-active': scope === 'workspace' }"
        :disabled="!activeWorkspace"
        @click="scope = 'workspace'"
      >
        <FolderOpen :size="14" :stroke-width="1.75" />
        <span>Workspace</span>
        <span v-if="activeWorkspace" class="pad-instrtab__scope-hint">{{ activeWorkspace.name }}</span>
      </button>
      <button
        class="pad-instrtab__scope-btn"
        :class="{ 'is-active': scope === 'global' }"
        @click="scope = 'global'"
      >
        <Globe :size="14" :stroke-width="1.75" />
        <span>Global</span>
        <span class="pad-instrtab__scope-hint">~/.pi/agent/AGENTS.md</span>
      </button>
    </div>

    <div v-if="toast" class="pad-instrtab__toast" :class="`is-${toast.type}`">
      <Check v-if="toast.type === 'ok'" :size="14" :stroke-width="1.75" />
      <AlertCircle v-else :size="14" :stroke-width="1.75" />
      <span>{{ toast.message }}</span>
      <button class="pad-instrtab__toast-close" @click="toast = null">×</button>
    </div>

    <div class="pad-instrtab__card">
      <div class="pad-instrtab__card-head">
        <FileText :size="14" :stroke-width="1.75" />
        <div class="pad-instrtab__card-title">
          <span v-if="filePath">
            <code>{{ filePath }}</code>
            <span v-if="modifiedAt" class="pad-instrtab__mtime">· 修改于 {{ new Date(Number(modifiedAt) * 1000).toLocaleString() }}</span>
          </span>
          <span v-else>暂无文件 — 保存会创建 <code>AGENTS.md</code></span>
        </div>
        <div class="pad-instrtab__actions">
          <button
            v-if="hasContent"
            class="pad-instrtab__btn pad-instrtab__btn--danger"
            :disabled="isDeleting"
            @click="remove"
          >
            <Trash2 :size="14" :stroke-width="1.75" />
            <span>删除</span>
          </button>
          <button
            class="pad-instrtab__btn pad-instrtab__btn--primary"
            :disabled="!hasChanges || isSaving"
            @click="save"
          >
            <Save :size="14" :stroke-width="1.75" />
            <span>{{ isSaving ? '保存中…' : '保存' }}</span>
          </button>
        </div>
      </div>

      <textarea
        v-model="content"
        class="pad-instrtab__textarea"
        placeholder="添加你的自定义指令……"

        :rows="20"
        spellcheck="false"
      />

      <div class="pad-instrtab__meta">
        <span>{{ content.length }} 字符</span>
        <span v-if="hasChanges" class="pad-instrtab__dirty">● 未保存</span>
      </div>
    </div>

    <div class="pad-instrtab__hint">
      <Info :size="12" :stroke-width="1.75" />
      <span>
        写完后<strong>重启 release .exe</strong> 让 sidecar 重新加载 <code>AGENTS.md</code> 注入
        system prompt (D165 systemPrompt 不可动态改). 后续 v0.4.4.x polish 加 toggle 自动重启 sidecar.
      </span>
    </div>
  </div>
</template>

<style scoped>
.pad-instrtab__header { padding: 24px 0 16px 0; }
.pad-instrtab__title { font-size: var(--pad-fs-22); font-weight: var(--pad-fw-semibold); color: var(--pad-fg-primary); margin: 0 0 4px 0; }
.pad-instrtab__subtitle { font-size: var(--pad-fs-13); color: var(--pad-fg-secondary); margin: 0; line-height: 1.5; }
.pad-instrtab__subtitle code { font-family: var(--pad-font-mono); font-size: 11px; background: var(--pad-bg-muted, rgba(0,0,0,0.04)); padding: 1px 4px; border-radius: 2px; }
.pad-instrtab__scope { display: flex; gap: 4px; padding: 0 0 16px 0; }
.pad-instrtab__scope-btn {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 6px 12px;
  font-size: var(--pad-fs-12);
  background: var(--pad-bg-base, #fff);
  border: 1px solid var(--pad-border-subtle, #e0e0e0);
  border-radius: var(--pad-radius-sm, 4px);
  color: var(--pad-fg-secondary);
  cursor: pointer;
  transition: all 0.15s;
}
.pad-instrtab__scope-btn:hover:not(:disabled) { background: var(--pad-bg-hover, rgba(0,0,0,0.04)); }
.pad-instrtab__scope-btn.is-active { background: var(--pad-bg-accent-soft, rgba(99,102,241,0.08)); border-color: var(--pad-accent, #6366f1); color: var(--pad-fg-accent, #6366f1); }
.pad-instrtab__scope-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.pad-instrtab__scope-hint { font-size: 10px; color: var(--pad-fg-tertiary); font-family: var(--pad-font-mono); }
.pad-instrtab__toast { display: flex; align-items: center; gap: 6px; padding: 8px 14px; margin-bottom: 12px; border-radius: var(--pad-radius-md, 8px); font-size: var(--pad-fs-12); }
.pad-instrtab__toast.is-ok { background: var(--pad-bg-success-soft, rgba(34,197,94,0.08)); color: var(--pad-fg-success, #22c55e); }
.pad-instrtab__toast.is-fail { background: var(--pad-bg-danger-soft, rgba(220,38,38,0.08)); color: var(--pad-fg-danger, #dc2626); }
.pad-instrtab__toast-close { margin-left: auto; background: transparent; border: none; color: inherit; cursor: pointer; font-size: 16px; }
.pad-instrtab__card { background: var(--pad-bg-base, #fff); border: 1px solid var(--pad-border-subtle, #e0e0e0); border-radius: var(--pad-radius-md, 8px); overflow: hidden; }
.pad-instrtab__card-head { display: flex; align-items: center; gap: 8px; padding: 10px 14px; background: var(--pad-bg-muted, rgba(0,0,0,0.02)); border-bottom: 1px solid var(--pad-border-subtle, #e0e0e0); color: var(--pad-fg-secondary); }
.pad-instrtab__card-title { flex: 1; font-size: var(--pad-fs-12); min-width: 0; }
.pad-instrtab__card-title code { font-family: var(--pad-font-mono); font-size: 11px; color: var(--pad-fg-primary); word-break: break-all; }
.pad-instrtab__mtime { color: var(--pad-fg-tertiary); font-weight: normal; margin-left: 4px; }
.pad-instrtab__actions { display: flex; gap: 6px; }
.pad-instrtab__btn { display: inline-flex; align-items: center; gap: 4px; padding: 5px 10px; font-size: var(--pad-fs-12); border: 1px solid var(--pad-border-subtle, #e0e0e0); border-radius: var(--pad-radius-sm, 4px); background: var(--pad-bg-base, #fff); color: var(--pad-fg-primary); cursor: pointer; transition: all 0.15s; }
.pad-instrtab__btn:hover:not(:disabled) { background: var(--pad-bg-hover, rgba(0,0,0,0.04)); }
.pad-instrtab__btn:disabled { opacity: 0.4; cursor: not-allowed; }
.pad-instrtab__btn--primary { background: var(--pad-accent, #6366f1); border-color: var(--pad-accent, #6366f1); color: var(--pad-fg-on-accent, #fff); }
.pad-instrtab__btn--primary:hover:not(:disabled) { opacity: 0.9; }
.pad-instrtab__btn--danger { color: var(--pad-fg-danger, #dc2626); }
.pad-instrtab__btn--danger:hover:not(:disabled) { background: var(--pad-bg-danger-soft, rgba(220,38,38,0.08)); }
.pad-instrtab__textarea { width: 100%; padding: 14px; font-family: var(--pad-font-mono); font-size: var(--pad-fs-13); line-height: 1.6; color: var(--pad-fg-primary); background: var(--pad-bg-base, #fff); border: none; resize: vertical; min-height: 360px; outline: none; }
.pad-instrtab__textarea:focus { background: var(--pad-bg-subtle, #fafafa); }
.pad-instrtab__textarea::placeholder { color: var(--pad-fg-tertiary); font-style: italic; }
.pad-instrtab__meta { display: flex; gap: 12px; padding: 8px 14px; border-top: 1px solid var(--pad-border-subtle, #e0e0e0); font-size: 11px; color: var(--pad-fg-tertiary); background: var(--pad-bg-muted, rgba(0,0,0,0.02)); }
.pad-instrtab__dirty { color: var(--pad-fg-warning, #d97706); font-weight: var(--pad-fw-medium); }
.pad-instrtab__hint { display: flex; align-items: flex-start; gap: 6px; padding: 12px 16px; color: var(--pad-fg-tertiary); font-size: 11px; line-height: 1.5; }
.pad-instrtab__hint code { font-family: var(--pad-font-mono); font-size: 10px; background: var(--pad-bg-muted, rgba(0,0,0,0.04)); padding: 1px 4px; border-radius: 2px; }
</style>
