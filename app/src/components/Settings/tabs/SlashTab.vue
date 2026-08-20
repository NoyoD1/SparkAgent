<script setup lang="ts">
/**
 * v0.4.5.2 SlashTab — 设置面板 "Slash" tab (D184 v9 ❷ 恢复)
 *
 * 跟 v0.4.6.1 AgentsTab / v0.4.4.6 SkillsTab 同 pattern.
 *
 * 范围 (D184 v9 ❷ user 14:30 原话):
 *   "Slash tab是单独用于给用户自定义快捷提示词模板的, 不是用来显示builtin的"
 *   - 只显示 user 自定义 .pi/commands/*.md
 *   - builtin 22 个 (Pi SDK BUILTIN_SLASH_COMMANDS) 完全不显示, 走 Pi CLI 内部
 *
 * 存储: <workspace>/.pi/commands/<name>.md (frontmatter name/description + body)
 * 跟 v0.4.4 Skills 一样, 走 Tauri 4 invoke (list/read/write/delete_command)
 */
import { ref, onMounted } from 'vue';
import { storeToRefs } from 'pinia';
import { Terminal, Save, Trash2, AlertCircle, Check, Info, Plus, X, Edit3, FileText } from 'lucide-vue-next';
import { useSlashStore } from '@/stores/slash';

const slashStore = useSlashStore();
const { commands, hasTauriList, lastError } = storeToRefs(slashStore);

const editingName = ref<string | null>(null);
const isCreating = ref(false);
const formName = ref('');
const formDescription = ref('');
const formBody = ref('');
const isSaving = ref(false);
const toast = ref<{ type: 'ok' | 'fail'; message: string } | null>(null);

function startCreate() {
  isCreating.value = true;
  editingName.value = null;
  formName.value = '';
  formDescription.value = '';
  formBody.value = '';
}

function startEdit(name: string) {
  const c = commands.value.find((x) => x.name === name);
  if (!c) return;
  editingName.value = name;
  isCreating.value = false;
  formName.value = name;
  formDescription.value = c.description;
  formBody.value = c.body;
}

function cancelForm() {
  editingName.value = null;
  isCreating.value = false;
  formName.value = '';
  formBody.value = '';
}

async function save() {
  if (isSaving.value) return;
  if (!formName.value.trim()) {
    toast.value = { type: 'fail', message: 'name 不能为空' };
    return;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(formName.value)) {
    toast.value = { type: 'fail', message: 'name 必须以字母/数字开头, 只能含 [A-Za-z0-9._-]' };
    return;
  }
  isSaving.value = true;
  toast.value = null;
  try {
    if (editingName.value) {
      await slashStore.update(formName.value, formBody.value, formDescription.value);
      toast.value = { type: 'ok', message: `已更新 ${formName.value}` };
    } else {
      await slashStore.create(formName.value, formBody.value, formDescription.value);
      toast.value = { type: 'ok', message: `已创建 ${formName.value}` };
    }
    cancelForm();
  } catch (e) {
    toast.value = { type: 'fail', message: e instanceof Error ? e.message : String(e) };
  } finally {
    isSaving.value = false;
  }
}

async function remove(name: string) {
  if (!confirm(`确认删除 command "${name}"?`)) return;
  try {
    await slashStore.remove(name);
    toast.value = { type: 'ok', message: `已删除 ${name}` };
  } catch (e) {
    toast.value = { type: 'fail', message: e instanceof Error ? e.message : String(e) };
  }
}

onMounted(() => {
  slashStore.refreshFromTauri();
});
</script>

<template>
  <div class="pad-slashtab">
    <div class="pad-slashtab__header">
      <h2 class="pad-slashtab__title">Slash 快捷提示词模板</h2>
      <p class="pad-slashtab__subtitle">
        管理<strong>用户自定义</strong>的快捷提示词模板 (存 <code>&lt;workspace&gt;/.pi/commands/*.md</code>).
        在 Composer 选 command 后内容会作为 system prompt 注入 (后续 v0.4.7b 改 @ 引用嵌入 user prompt).
      </p>
    </div>

    <div v-if="toast" class="pad-slashtab__toast" :class="`is-${toast.type}`">
      <Check v-if="toast.type === 'ok'" :size="14" :stroke-width="1.75" />
      <AlertCircle v-else :size="14" :stroke-width="1.75" />
      <span>{{ toast.message }}</span>
      <button class="pad-slashtab__toast-close" @click="toast = null">×</button>
    </div>

    <div v-if="lastError" class="pad-slashtab__toast is-fail">
      <AlertCircle :size="14" :stroke-width="1.75" />
      <span>{{ lastError }}</span>
    </div>

    <div class="pad-slashtab__card">
      <div class="pad-slashtab__card-head">
        <Terminal :size="14" :stroke-width="1.75" />
        <span class="pad-slashtab__card-title">
          {{ commands.length }} 个自定义 command
        </span>
        <div class="pad-slashtab__actions">
          <button
            v-if="!isCreating && !editingName"
            class="pad-slashtab__btn pad-slashtab__btn--primary"
            @click="startCreate"
          >
            <Plus :size="14" :stroke-width="1.75" />
            <span>新建</span>
          </button>
          <button
            v-if="isCreating || editingName"
            class="pad-slashtab__btn"
            @click="cancelForm"
          >
            <X :size="14" :stroke-width="1.75" />
            <span>取消</span>
          </button>
        </div>
      </div>

      <!-- 新建/编辑表单 -->
      <div v-if="isCreating || editingName" class="pad-slashtab__form">
        <div class="pad-slashtab__form-row">
          <label class="pad-slashtab__label">name</label>
          <input
            v-model="formName"
            class="pad-slashtab__input"
            :readonly="!!editingName"
            placeholder="例如 translate / review / explain"
            spellcheck="false"
          />
        </div>
        <div class="pad-slashtab__form-row">
          <label class="pad-slashtab__label">description</label>
          <input
            v-model="formDescription"
            class="pad-slashtab__input"
            placeholder="例如 翻译 / 代码审查 / 概念解释"
            spellcheck="false"
          />
        </div>
        <div class="pad-slashtab__form-row pad-slashtab__form-row--body">
          <label class="pad-slashtab__label">body</label>
          <textarea
            v-model="formBody"
            class="pad-slashtab__textarea"
            placeholder="提示词模板内容, 例如: 请把以下内容翻译成英文, 保持原意和语气:&#10;&#10;{{input}}"
            rows="10"
            spellcheck="false"
          />
        </div>
        <div class="pad-slashtab__form-actions">
          <button
            class="pad-slashtab__btn pad-slashtab__btn--primary"
            :disabled="isSaving"
            @click="save"
          >
            <Save :size="14" :stroke-width="1.75" />
            <span>{{ isSaving ? '保存中…' : (editingName ? '保存修改' : '创建') }}</span>
          </button>
        </div>
      </div>

      <!-- 列表 -->
      <div v-else>
        <div v-if="!hasTauriList" class="pad-slashtab__empty">
          <Terminal :size="20" :stroke-width="1.5" />
          <div>⏳ 加载中…</div>
        </div>
        <div v-else-if="commands.length === 0" class="pad-slashtab__empty">
          <Terminal :size="20" :stroke-width="1.5" />
          <div class="pad-slashtab__empty-title">暂无自定义 command</div>
          <div class="pad-slashtab__empty-desc">点 "新建" 创建你的第一个快捷提示词模板 (例如 /translate).</div>
        </div>
        <ul v-else class="pad-slashtab__list">
          <li v-for="c in commands" :key="c.name" class="pad-slashtab__item">
            <div class="pad-slashtab__item-body">
              <div class="pad-slashtab__item-name">
                <code>/{{ c.name }}</code>
                <span class="pad-slashtab__item-desc-inline">{{ c.description }}</span>
              </div>
              <div class="pad-slashtab__item-body-preview">
                <FileText :size="11" :stroke-width="1.75" />
                <span>{{ c.body.slice(0, 100) }}{{ c.body.length > 100 ? '…' : '' }}</span>
              </div>
            </div>
            <div class="pad-slashtab__item-actions">
              <button
                class="pad-slashtab__btn"
                title="编辑"
                @click="startEdit(c.name)"
              >
                <Edit3 :size="13" :stroke-width="1.75" />
              </button>
              <button
                class="pad-slashtab__btn pad-slashtab__btn--danger"
                title="删除"
                @click="remove(c.name)"
              >
                <Trash2 :size="13" :stroke-width="1.75" />
              </button>
            </div>
          </li>
        </ul>
      </div>
    </div>

    <div class="pad-slashtab__hint">
      <Info :size="12" :stroke-width="1.75" />
      <span>
        Pi SDK 内置 22 个 command (<code>/settings</code> <code>/model</code> <code>/share</code> 等) 走 Pi CLI 内部, <strong>不在此面板显示</strong>.
        自定义模板存 <code>&lt;workspace&gt;/.pi/commands/*.md</code>, 跟 v0.4.4 skills / v0.4.6.1 agents 同 pattern.
      </span>
    </div>
  </div>
</template>

<style scoped>
.pad-slashtab__header { padding: 24px 0 16px 0; }
.pad-slashtab__title { font-size: var(--pad-fs-22); font-weight: var(--pad-fw-semibold); color: var(--pad-fg-primary); margin: 0 0 4px 0; }
.pad-slashtab__subtitle { font-size: var(--pad-fs-13); color: var(--pad-fg-secondary); margin: 0; line-height: 1.5; }
.pad-slashtab__subtitle code { font-family: var(--pad-font-mono); font-size: 11px; background: var(--pad-bg-input); padding: 1px 4px; border-radius: 2px; }
.pad-slashtab__toast { display: flex; align-items: center; gap: 6px; padding: 8px 14px; margin-bottom: 12px; border-radius: var(--pad-radius-md, 8px); font-size: var(--pad-fs-12); }
.pad-slashtab__toast.is-ok { background: var(--pad-bg-success-soft, rgba(34,197,94,0.08)); color: var(--pad-fg-success, #22c55e); }
.pad-slashtab__toast.is-fail { background: var(--pad-bg-danger-soft, rgba(220,38,38,0.08)); color: var(--pad-fg-danger, #dc2626); }
.pad-slashtab__toast-close { margin-left: auto; background: transparent; border: none; color: inherit; cursor: pointer; font-size: 16px; }
/* Phase 8: dark mode 适配 — 修未定义的 --pad-bg-base / --pad-border-subtle / --pad-bg-muted
   改用 --pad-card / --pad-border / --pad-bg-input (light=#fff, dark=#171717/#262626/#1c1c1c) */
.pad-slashtab__card {
  background: var(--pad-card);
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-md, 8px);
  overflow: hidden;
}
.pad-slashtab__card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  background: var(--pad-bg-input);
  border-bottom: 1px solid var(--pad-border);
  color: var(--pad-fg-secondary);
}
.pad-slashtab__card-title { flex: 1; font-size: var(--pad-fs-13); font-weight: var(--pad-fw-medium); }
.pad-slashtab__actions { display: flex; gap: 6px; }
.pad-slashtab__btn {
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
.pad-slashtab__btn:hover:not(:disabled) { background: var(--pad-bg-hover); }
.pad-slashtab__btn:disabled { opacity: 0.4; cursor: not-allowed; }
/* Phase 8c: primary 按钮改成跟 Skills "添加自定义" 一样 — secondary 风格
   (card bg + border + secondary text), hover 升级到 primary text + accent border.
   之前用 var(--pad-accent) 填充, light 下 #18181b 深色 bg 配 #fafafa/var(--pad-fg-900) 撞色难看. */
.pad-slashtab__btn--primary {
  background: var(--pad-card);
  border-color: var(--pad-border);
  color: var(--pad-fg-secondary);
}
.pad-slashtab__btn--primary:hover:not(:disabled) {
  background: var(--pad-bg-hover);
  color: var(--pad-fg-primary);
  border-color: var(--pad-accent, #6366f1);
}
.pad-slashtab__btn--danger { color: var(--pad-fg-danger, #dc2626); }
.pad-slashtab__btn--danger:hover:not(:disabled) { background: var(--pad-bg-danger-soft, rgba(220,38,38,0.08)); }
.pad-slashtab__form {
  padding: 16px;
  border-bottom: 1px solid var(--pad-border);
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.pad-slashtab__form-row { display: flex; align-items: center; gap: 8px; }
.pad-slashtab__form-row--body { flex-direction: column; align-items: stretch; }
.pad-slashtab__label { font-size: var(--pad-fs-12); color: var(--pad-fg-secondary); width: 80px; flex-shrink: 0; }
.pad-slashtab__input {
  flex: 1;
  padding: 6px 10px;
  font-family: var(--pad-font-mono);
  font-size: var(--pad-fs-13);
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-sm, 4px);
  background: var(--pad-bg-input);
  color: var(--pad-fg-primary);
}
.pad-slashtab__input:focus { outline: none; border-color: var(--pad-accent, #6366f1); }
.pad-slashtab__textarea {
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
  min-height: 180px;
}
.pad-slashtab__textarea:focus { outline: none; border-color: var(--pad-accent, #6366f1); }
.pad-slashtab__form-actions { display: flex; justify-content: flex-end; gap: 6px; }
.pad-slashtab__empty { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 40px 20px; gap: 8px; color: var(--pad-fg-tertiary); }
.pad-slashtab__empty-title { font-size: var(--pad-fs-14); color: var(--pad-fg-secondary); }
.pad-slashtab__empty-desc { font-size: var(--pad-fs-12); color: var(--pad-fg-tertiary); text-align: center; }
.pad-slashtab__list { list-style: none; padding: 0; margin: 0; }
.pad-slashtab__item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-top: 1px solid var(--pad-border);
}
.pad-slashtab__item-body { flex: 1; min-width: 0; }
.pad-slashtab__item-name { display: flex; align-items: center; gap: 8px; font-size: var(--pad-fs-13); }
.pad-slashtab__item-name code { font-family: var(--pad-font-mono); font-size: var(--pad-fs-13); color: var(--pad-fg-primary); font-weight: var(--pad-fw-medium); }
.pad-slashtab__item-desc-inline { font-size: var(--pad-fs-12); color: var(--pad-fg-tertiary); }
.pad-slashtab__item-body-preview { display: flex; align-items: center; gap: 4px; font-size: 11px; color: var(--pad-fg-tertiary); margin-top: 2px; font-family: var(--pad-font-mono); }
.pad-slashtab__item-actions { display: flex; gap: 4px; }
.pad-slashtab__hint { display: flex; align-items: flex-start; gap: 6px; padding: 12px 16px; color: var(--pad-fg-tertiary); font-size: 11px; line-height: 1.5; }
.pad-slashtab__hint code { font-family: var(--pad-font-mono); font-size: 10px; background: var(--pad-bg-input); padding: 1px 4px; border-radius: 2px; }
</style>
