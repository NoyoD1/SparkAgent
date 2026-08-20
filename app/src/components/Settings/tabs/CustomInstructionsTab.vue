<script setup lang="ts">
/**
 * v0.5.0-v0.1: 回归 v0.4.6 设计 — Custom Instructions tab (单 AGENTS.md 编辑)
 *
 * 之前的 v0.4.6.1 把它改造成 "Agents (主/子 agent 库)" 多 persona 切换, 现在回滚.
 *  v0.4.6 原设计 = 1 个通用 agent + AGENTS.md (project context 段) — user 拍板
 *  "agent 是边界定义/思维指导, single agent 链路拉动, 不需要切来切去".
 *
 * 存储 (v0.4.6 沿用):
 *   - workspace: <workspace>/AGENTS.md (per-workspace, 默认)
 *   - global:    <agentDir>/AGENTS.md (跟 Pi SDK 0.84.2 DefaultResourceLoader 路径一致)
 * Pi SDK 0.84.2 DefaultResourceLoader 自动 load AGENTS.md (resource-loader.ts:71),
 *   sidecar 启动时把 paths 传 appendSystemPromptSource 注入 system prompt.
 */
import { ref, onMounted } from 'vue';
import { storeToRefs } from 'pinia';
import { Save, Trash2, AlertCircle, Check, Info, FileText, RefreshCw } from 'lucide-vue-next';
import { useSessionStore } from '@/stores/session';
import { piTauri } from '@/lib/tauri';

type Scope = 'workspace' | 'global';
const SCOPE_OPTIONS: Array<{ value: Scope; label: string; hint: string }> = [
  { value: 'workspace', label: '当前工作区', hint: '写到 <workspace>/AGENTS.md (per-workspace, 推荐)' },
  { value: 'global',    label: '全局',         hint: '写到 <agentDir>/AGENTS.md (所有 workspace 共享)' },
];

const sessionStore = useSessionStore();
const { activeWorkspace } = storeToRefs(sessionStore);

const scope = ref<Scope>('workspace');
const filePath = ref<string | null>(null);
const content = ref('');
const modifiedAt = ref<string | null>(null);
const isLoading = ref(false);
const isSaving = ref(false);
const isDeleting = ref(false);
const toast = ref<{ type: 'ok' | 'fail'; message: string } | null>(null);

async function load() {
  isLoading.value = true;
  toast.value = null;
  try {
    const wsPath = scope.value === 'workspace' ? activeWorkspace.value?.path ?? null : null;
    const agentDir = scope.value === 'global' ? null : null;  // sidecar 端用 getAgentDir() 解析
    const res = await piTauri.readCustomInstructions({
      scope: scope.value,
      workspacePath: wsPath,
      agentDir,
    });
    filePath.value = res.filePath;
    content.value = res.content;
    modifiedAt.value = res.modifiedAt;
    console.log(`[CustomInstructions] loaded: scope=${scope.value} filePath=${res.filePath} len=${res.content.length}`);
  } catch (e) {
    filePath.value = null;
    content.value = '';
    modifiedAt.value = null;
    console.error('[CustomInstructions] load failed:', e instanceof Error ? e.message : String(e));
  } finally {
    isLoading.value = false;
  }
}

async function save() {
  if (isSaving.value) return;
  isSaving.value = true;
  toast.value = null;
  try {
    const wsPath = scope.value === 'workspace' ? activeWorkspace.value?.path ?? null : null;
    const written = await piTauri.writeCustomInstructions({
      scope: scope.value,
      workspacePath: wsPath,
      agentDir: null,
      content: content.value,
    });
    filePath.value = written;
    modifiedAt.value = new Date().toISOString();
    toast.value = { type: 'ok', message: `已保存到 ${written}` };
    console.log(`[CustomInstructions] saved: ${written}`);
  } catch (e) {
    toast.value = { type: 'fail', message: e instanceof Error ? e.message : String(e) };
  } finally {
    isSaving.value = false;
  }
}

async function remove() {
  if (isDeleting.value) return;
  if (!confirm(`确认删除 ${filePath.value || 'AGENTS.md'}?\n\nPi SDK 0.84.2 启动时不再 load, LLM 走默认行为.`)) return;
  isDeleting.value = true;
  toast.value = null;
  try {
    const wsPath = scope.value === 'workspace' ? activeWorkspace.value?.path ?? null : null;
    const ok = await piTauri.deleteCustomInstructions({
      scope: scope.value,
      workspacePath: wsPath,
      agentDir: null,
    });
    if (ok) {
      filePath.value = null;
      content.value = '';
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

onMounted(() => {
  load();
});
</script>

<template>
  <div class="pad-instrtab">
    <div class="pad-instrtab__header">
      <h2 class="pad-instrtab__title">Custom Instructions</h2>
      <p class="pad-instrtab__subtitle">
        编辑 <code>AGENTS.md</code> — 作为 <strong>项目边界 / 思维指导</strong> 段注入 system prompt.
        Pi SDK 0.84.2 启动时自动 load (resource-loader.ts:71), 改完保存下次发 prompt 生效.
      </p>
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
        <span class="pad-instrtab__card-title">
          {{ filePath ? '已加载' : (isLoading ? '加载中…' : '未创建') }}
          <span v-if="filePath" class="pad-instrtab__file-path">{{ filePath }}</span>
        </span>
        <div class="pad-instrtab__actions">
          <button class="pad-instrtab__btn" :disabled="isLoading" @click="load">
            <RefreshCw :size="13" :stroke-width="1.75" />
            <span>刷新</span>
          </button>
          <button
            v-if="filePath"
            class="pad-instrtab__btn pad-instrtab__btn--danger"
            :disabled="isDeleting"
            @click="remove"
          >
            <Trash2 :size="13" :stroke-width="1.75" />
            <span>删除</span>
          </button>
          <button
            class="pad-instrtab__btn pad-instrtab__btn--primary"
            :disabled="isSaving"
            @click="save"
          >
            <Save :size="13" :stroke-width="1.75" />
            <span>{{ isSaving ? '保存中…' : '保存' }}</span>
          </button>
        </div>
      </div>

      <div class="pad-instrtab__form">
        <div class="pad-instrtab__form-row">
          <label class="pad-instrtab__label">scope</label>
          <div class="pad-instrtab__radio">
            <label
              v-for="opt in SCOPE_OPTIONS"
              :key="opt.value"
              :class="{ 'is-active': scope === opt.value }"
            >
              <input
                v-model="scope"
                type="radio"
                :value="opt.value"
                @change="load"
              />
              <span>{{ opt.label }}</span>
            </label>
          </div>
        </div>
        <div class="pad-instrtab__form-row pad-instrtab__form-row--body">
          <label class="pad-instrtab__label">body (markdown)</label>
          <textarea
            v-model="content"
            class="pad-instrtab__textarea"
            :placeholder="'agent 人设 / 边界 / 思维指导, 例如:\n# 项目背景\n本项目是一个能源监控平台, 主要用户是电网调度员.\n# 行为约束\n- 优先考虑性能, 避免阻塞主线程\n- 涉及危险操作必须弹 confirm 让用户确认'"
            rows="20"
            spellcheck="false"
          />
        </div>
      </div>
    </div>

    <div class="pad-instrtab__hint">
      <Info :size="12" :stroke-width="1.75" />
      <span>
        <strong>v0.5.0 single agent design</strong>: 这是一个 <strong>通用 agent</strong>, 永远 active.
        AGENTS.md 不是 persona 切换, 是 <strong>思维指导 / 边界定义</strong>, 注入 system prompt
        后 LLM 整个 session 持续遵守. <br />
        跟 Skills (持续能力) / Slash (快捷模板) / @ 引用 (一次性片段) 配合, 不需要切来切去.
      </span>
    </div>
  </div>
</template>

<style scoped>
.pad-instrtab__header { padding: 24px 0 16px 0; }
.pad-instrtab__title { font-size: var(--pad-fs-22); font-weight: var(--pad-fw-semibold); color: var(--pad-fg-primary); margin: 0 0 4px 0; }
.pad-instrtab__subtitle { font-size: var(--pad-fs-13); color: var(--pad-fg-secondary); margin: 0; line-height: 1.5; }
.pad-instrtab__subtitle code {
  font-family: var(--pad-font-mono);
  font-size: 11px;
  background: var(--pad-bg-input);
  padding: 1px 4px;
  border-radius: 2px;
}
.pad-instrtab__toast { display: flex; align-items: center; gap: 6px; padding: 8px 14px; margin-bottom: 12px; border-radius: var(--pad-radius-md, 8px); font-size: var(--pad-fs-12); }
.pad-instrtab__toast.is-ok { background: var(--pad-bg-success-soft, rgba(34,197,94,0.08)); color: var(--pad-fg-success, #22c55e); }
.pad-instrtab__toast.is-fail { background: var(--pad-bg-danger-soft, rgba(220,38,38,0.08)); color: var(--pad-fg-danger, #dc2626); }
.pad-instrtab__toast-close { margin-left: auto; background: transparent; border: none; color: inherit; cursor: pointer; font-size: 16px; }
/* Phase 8: dark mode 适配 — 修未定义的 --pad-bg-base / --pad-border-subtle / --pad-bg-muted */
.pad-instrtab__card {
  background: var(--pad-card);
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-md, 8px);
  overflow: hidden;
}
.pad-instrtab__card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  background: var(--pad-bg-input);
  border-bottom: 1px solid var(--pad-border);
  color: var(--pad-fg-secondary);
}
.pad-instrtab__card-title { flex: 1; font-size: var(--pad-fs-13); font-weight: var(--pad-fw-medium); display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.pad-instrtab__file-path { font-family: var(--pad-font-mono); font-size: 10px; color: var(--pad-fg-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pad-instrtab__actions { display: flex; gap: 6px; }
.pad-instrtab__btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px 10px;
  font-size: var(--pad-fs-12);
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-sm, 4px);
  background: var(--pad-bg-input);
  color: var(--pad-fg-primary);
  cursor: pointer;
  transition: all 0.15s;
}
.pad-instrtab__btn:hover:not(:disabled) { background: var(--pad-bg-hover); }
.pad-instrtab__btn:disabled { opacity: 0.4; cursor: not-allowed; }
/* Phase 8c: primary 按钮改成跟 Skills "添加自定义" 一样 — secondary 风格
   (card bg + border + secondary text), hover 升级到 primary text + accent border.
   之前用 var(--pad-accent) 填充, light 下 #18181b 深色 bg 配 #fafafa 撞色难看. */
.pad-instrtab__btn--primary {
  background: var(--pad-card);
  border-color: var(--pad-border);
  color: var(--pad-fg-secondary);
}
.pad-instrtab__btn--primary:hover:not(:disabled) {
  background: var(--pad-bg-hover);
  color: var(--pad-fg-primary);
  border-color: var(--pad-accent, #6366f1);
}
.pad-instrtab__btn--danger { color: var(--pad-fg-danger, #dc2626); }
.pad-instrtab__btn--danger:hover:not(:disabled) { background: var(--pad-bg-danger-soft, rgba(220,38,38,0.08)); }
.pad-instrtab__form { padding: 16px; display: flex; flex-direction: column; gap: 12px; }
.pad-instrtab__form-row { display: flex; align-items: center; gap: 8px; }
.pad-instrtab__form-row--body { flex-direction: column; align-items: stretch; }
.pad-instrtab__label { font-size: var(--pad-fs-12); color: var(--pad-fg-secondary); width: 60px; flex-shrink: 0; }
.pad-instrtab__radio { display: flex; gap: 12px; }
.pad-instrtab__radio label { display: inline-flex; align-items: center; gap: 4px; font-size: var(--pad-fs-12); cursor: pointer; padding: 4px 8px; border-radius: var(--pad-radius-sm, 4px); transition: background 0.15s; }
.pad-instrtab__radio label:hover { background: var(--pad-bg-hover); }
.pad-instrtab__radio label.is-active { background: var(--pad-accent-soft); color: var(--pad-fg-primary); font-weight: var(--pad-fw-medium); }
.pad-instrtab__textarea {
  width: 100%;
  padding: 10px;
  font-family: var(--pad-font-mono);
  font-size: var(--pad-fs-13);
  line-height: 1.6;
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-sm, 4px);
  background: var(--pad-bg-input);
  color: var(--pad-fg-primary);
  resize: vertical;
  min-height: 360px;
}
.pad-instrtab__textarea:focus { outline: none; border-color: var(--pad-accent, #6366f1); }
.pad-instrtab__hint { display: flex; align-items: flex-start; gap: 6px; padding: 12px 16px; color: var(--pad-fg-tertiary); font-size: 11px; line-height: 1.5; }
.pad-instrtab__hint code {
  font-family: var(--pad-font-mono);
  font-size: 10px;
  background: var(--pad-bg-input);
  padding: 1px 4px;
  border-radius: 2px;
}
</style>
