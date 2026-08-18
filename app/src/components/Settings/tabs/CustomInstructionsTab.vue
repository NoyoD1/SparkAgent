<script setup lang="ts">
/**
 * v0.4.6.1 AgentsTab (改造自 v0.4.6 CustomInstructionsTab) — 设置面板 "Agents" tab
 *
 * 多套 agent persona 库 (主/子) — 跟 v0.4.4 Skills / v0.4.6 自定义指令 同 pattern.
 *
 * 数据:
 *   - <workspace>/.pi/agents/<name>.md (frontmatter name/description/role: main|sub)
 *   - <workspace>/.pi/active_agent.json (active name, 写 active_agent.json 持久化)
 *
 * 集成 (跟 v0.4.4 skills / v0.4.6 自定义指令 同 pattern, D165 systemPrompt 不可动态改):
 *   - chat store send_prompt 把 activeAgent = { name, body } 传到 sidecar
 *   - sidecar 启动时拼到 appendSystemPromptOverride 注入 system prompt
 *   - 切主 agent = 写 active_agent.json, 下次发 prompt 时 sidecar 启动自动生效
 *
 * UI:
 *   - 列表 (主 agent 标 [主] 绿点, 子 agent 标 [子] 灰点, 跟 sidebar 一致)
 *   - 新建 / 编辑 / 删除
 *   - 标 [主] 切换 (单选, 主 agent 互斥, 跟 v0.4.6 之前单 AGENTS.md 不一样)
 *
 * 旧数据迁移 (agents store 内自动处理):
 *   - <workspace>/AGENTS.md 存在 + .pi/agents/ 不存在 → 自动 write_agent('default', ...) + set_main
 *   - 旧 AGENTS.md 保留为"项目背景规则" (Pi SDK 自动 load, 永远生效, 不可切)
 */
import { ref, onMounted } from 'vue';
import { storeToRefs } from 'pinia';
import { Bot, Save, Trash2, AlertCircle, Check, Info, Plus, X, Edit3, Circle, FileText } from 'lucide-vue-next';
import { useAgentsStore } from '@/stores/agents';

const agentsStore = useAgentsStore();
const { agents, activeName, lastError, hasTauriList } = storeToRefs(agentsStore);

const editingName = ref<string | null>(null);  // null = 不在编辑模式, 字符串 = 编辑这个 name
const isCreating = ref(false);
const formName = ref('');
const formRole = ref<'main' | 'sub'>('sub');
const formBody = ref('');
const isSaving = ref(false);
const toast = ref<{ type: 'ok' | 'fail'; message: string } | null>(null);

function startCreate() {
  isCreating.value = true;
  editingName.value = null;
  formName.value = '';
  formRole.value = 'sub';
  formBody.value = '';
}

function startEdit(name: string) {
  const a = agents.value.find((x: any) => x.name === name);
  if (!a) return;
  editingName.value = name;
  isCreating.value = false;
  formName.value = name;
  formRole.value = a.role as 'main' | 'sub';
  formBody.value = a.body;
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
      await agentsStore.update(formName.value, formBody.value, formRole.value);
      toast.value = { type: 'ok', message: `已更新 ${formName.value}` };
    } else {
      await agentsStore.create(formName.value, formBody.value, formRole.value);
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
  if (!confirm(`确认删除 agent "${name}"?\n\n${name === activeName.value ? '⚠️ 这是当前主 agent, 删除后会清空 active_agent.json' : ''}`)) return;
  try {
    await agentsStore.remove(name);
    toast.value = { type: 'ok', message: `已删除 ${name}` };
  } catch (e) {
    toast.value = { type: 'fail', message: e instanceof Error ? e.message : String(e) };
  }
}

async function setMain(name: string) {
  if (name === activeName.value) return;
  try {
    await agentsStore.setMain(name);
    toast.value = { type: 'ok', message: `已切换主 agent 到 ${name} (下次发 prompt 生效)` };
  } catch (e) {
    toast.value = { type: 'fail', message: e instanceof Error ? e.message : String(e) };
  }
}

onMounted(() => {
  agentsStore.refreshFromTauri();
});
</script>

<template>
  <div class="pad-agentstab">
    <div class="pad-agentstab__header">
      <h2 class="pad-agentstab__title">Agents (主/子人设库)</h2>
      <p class="pad-agentstab__subtitle">
        多套 <code>agent.md</code> 人设库 — 当前激活 = <strong>主 agent</strong>, 决定 LLM 行为.
        Pi SDK 启动时把当前主 agent 内容拼到 <code>system prompt</code> 注入.
      </p>
    </div>

    <div v-if="toast" class="pad-agentstab__toast" :class="`is-${toast.type}`">
      <Check v-if="toast.type === 'ok'" :size="14" :stroke-width="1.75" />
      <AlertCircle v-else :size="14" :stroke-width="1.75" />
      <span>{{ toast.message }}</span>
      <button class="pad-agentstab__toast-close" @click="toast = null">×</button>
    </div>

    <div v-if="lastError" class="pad-agentstab__toast is-fail">
      <AlertCircle :size="14" :stroke-width="1.75" />
      <span>{{ lastError }}</span>
    </div>

    <div class="pad-agentstab__card">
      <div class="pad-agentstab__card-head">
        <Bot :size="14" :stroke-width="1.75" />
        <span class="pad-agentstab__card-title">
          {{ agents.length }} 个 agent
          <span v-if="activeName" class="pad-agentstab__active">· 主: {{ activeName }}</span>
        </span>
        <div class="pad-agentstab__actions">
          <button
            v-if="!isCreating && !editingName"
            class="pad-agentstab__btn pad-agentstab__btn--primary"
            @click="startCreate"
          >
            <Plus :size="14" :stroke-width="1.75" />
            <span>新建</span>
          </button>
          <button
            v-if="isCreating || editingName"
            class="pad-agentstab__btn"
            @click="cancelForm"
          >
            <X :size="14" :stroke-width="1.75" />
            <span>取消</span>
          </button>
        </div>
      </div>

      <!-- 新建/编辑表单 -->
      <div v-if="isCreating || editingName" class="pad-agentstab__form">
        <div class="pad-agentstab__form-row">
          <label class="pad-agentstab__label">name</label>
          <input
            v-model="formName"
            class="pad-agentstab__input"
            :readonly="!!editingName"
            placeholder="例如 engineer / pm / teacher"
            spellcheck="false"
          />
        </div>
        <div class="pad-agentstab__form-row">
          <label class="pad-agentstab__label">role</label>
          <div class="pad-agentstab__radio">
            <label>
              <input v-model="formRole" type="radio" value="main" />
              <span>主</span>
            </label>
            <label>
              <input v-model="formRole" type="radio" value="sub" />
              <span>子</span>
            </label>
          </div>
        </div>
        <div class="pad-agentstab__form-row pad-agentstab__form-row--body">
          <label class="pad-agentstab__label">body (markdown)</label>
          <textarea
            v-model="formBody"
            class="pad-agentstab__textarea"
            placeholder="agent 人设 / 规则 / 行为描述, 例如: 你是一个严谨的软件工程师, 优先考虑性能 / 边界条件 / 测试."
            rows="12"
            spellcheck="false"
          />
        </div>
        <div class="pad-agentstab__form-actions">
          <button
            class="pad-agentstab__btn pad-agentstab__btn--primary"
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
        <div v-if="!hasTauriList" class="pad-agentstab__empty">
          <Bot :size="20" :stroke-width="1.5" />
          <div>⏳ 加载中…</div>
        </div>
        <div v-else-if="agents.length === 0" class="pad-agentstab__empty">
          <Bot :size="20" :stroke-width="1.5" />
          <div class="pad-agentstab__empty-title">暂无 agent</div>
          <div class="pad-agentstab__empty-desc">点 "新建" 创建你的第一个人设 (例如 "严谨软件工程师").</div>
        </div>
        <ul v-else class="pad-agentstab__list">
          <li
            v-for="a in agents"
            :key="a.name"
            class="pad-agentstab__item"
            :class="{ 'is-main': a.name === activeName }"
          >
            <Circle
              :size="10"
              :stroke-width="0"
              :fill="a.name === activeName ? 'var(--pad-fg-success, #22c55e)' : 'var(--pad-fg-tertiary)'"
            />
            <div class="pad-agentstab__item-body">
              <div class="pad-agentstab__item-name">
                <Bot :size="13" :stroke-width="1.75" />
                <code>{{ a.name }}</code>
                <span v-if="a.name === activeName" class="pad-agentstab__item-tag is-main">主</span>
                <span v-else class="pad-agentstab__item-tag is-sub">{{ a.role }}</span>
              </div>
              <div v-if="a.description" class="pad-agentstab__item-desc">{{ a.description }}</div>
              <div v-else class="pad-agentstab__item-body-preview">
                <FileText :size="11" :stroke-width="1.75" />
                <span>{{ a.body.slice(0, 80) }}{{ a.body.length > 80 ? '…' : '' }}</span>
              </div>
            </div>
            <div class="pad-agentstab__item-actions">
              <button
                v-if="a.name !== activeName"
                class="pad-agentstab__btn"
                title="设为主 agent"
                @click="setMain(a.name)"
              >
                切主
              </button>
              <button
                class="pad-agentstab__btn"
                title="编辑"
                @click="startEdit(a.name)"
              >
                <Edit3 :size="13" :stroke-width="1.75" />
              </button>
              <button
                class="pad-agentstab__btn pad-agentstab__btn--danger"
                title="删除"
                @click="remove(a.name)"
              >
                <Trash2 :size="13" :stroke-width="1.75" />
              </button>
            </div>
          </li>
        </ul>
      </div>
    </div>

    <div class="pad-agentstab__hint">
      <Info :size="12" :stroke-width="1.75" />
      <span>
        切主 agent 后 <strong>下次发 prompt 生效</strong> (Pi SDK 0.84.2 system prompt 启动时定, 跟 v0.4.4 skills 同 pattern).
        Composer 顶部也支持下拉切, 跟这里同步.
        <br />
        旧 <code>AGENTS.md</code> 首次打开会自动迁移到 <code>.pi/agents/default.md</code> (主 agent).
      </span>
    </div>
  </div>
</template>

<style scoped>
.pad-agentstab__header { padding: 24px 0 16px 0; }
.pad-agentstab__title { font-size: var(--pad-fs-22); font-weight: var(--pad-fw-semibold); color: var(--pad-fg-primary); margin: 0 0 4px 0; }
.pad-agentstab__subtitle { font-size: var(--pad-fs-13); color: var(--pad-fg-secondary); margin: 0; line-height: 1.5; }
.pad-agentstab__subtitle code { font-family: var(--pad-font-mono); font-size: 11px; background: var(--pad-bg-muted, rgba(0,0,0,0.04)); padding: 1px 4px; border-radius: 2px; }
.pad-agentstab__toast { display: flex; align-items: center; gap: 6px; padding: 8px 14px; margin-bottom: 12px; border-radius: var(--pad-radius-md, 8px); font-size: var(--pad-fs-12); }
.pad-agentstab__toast.is-ok { background: var(--pad-bg-success-soft, rgba(34,197,94,0.08)); color: var(--pad-fg-success, #22c55e); }
.pad-agentstab__toast.is-fail { background: var(--pad-bg-danger-soft, rgba(220,38,38,0.08)); color: var(--pad-fg-danger, #dc2626); }
.pad-agentstab__toast-close { margin-left: auto; background: transparent; border: none; color: inherit; cursor: pointer; font-size: 16px; }
.pad-agentstab__card { background: var(--pad-bg-base, #fff); border: 1px solid var(--pad-border-subtle, #e0e0e0); border-radius: var(--pad-radius-md, 8px); overflow: hidden; }
.pad-agentstab__card-head { display: flex; align-items: center; gap: 8px; padding: 10px 14px; background: var(--pad-bg-muted, rgba(0,0,0,0.02)); border-bottom: 1px solid var(--pad-border-subtle, #e0e0e0); color: var(--pad-fg-secondary); }
.pad-agentstab__card-title { flex: 1; font-size: var(--pad-fs-13); font-weight: var(--pad-fw-medium); }
.pad-agentstab__active { color: var(--pad-fg-success, #22c55e); font-weight: normal; }
.pad-agentstab__actions { display: flex; gap: 6px; }
.pad-agentstab__btn { display: inline-flex; align-items: center; gap: 4px; padding: 5px 10px; font-size: var(--pad-fs-12); border: 1px solid var(--pad-border-subtle, #e0e0e0); border-radius: var(--pad-radius-sm, 4px); background: var(--pad-bg-base, #fff); color: var(--pad-fg-primary); cursor: pointer; transition: all 0.15s; }
.pad-agentstab__btn:hover:not(:disabled) { background: var(--pad-bg-hover, rgba(0,0,0,0.04)); }
.pad-agentstab__btn:disabled { opacity: 0.4; cursor: not-allowed; }
.pad-agentstab__btn--primary { background: var(--pad-accent, #6366f1); border-color: var(--pad-accent, #6366f1); color: var(--pad-fg-on-accent, #fff); }
.pad-agentstab__btn--primary:hover:not(:disabled) { opacity: 0.9; }
.pad-agentstab__btn--danger { color: var(--pad-fg-danger, #dc2626); }
.pad-agentstab__btn--danger:hover:not(:disabled) { background: var(--pad-bg-danger-soft, rgba(220,38,38,0.08)); }
.pad-agentstab__form { padding: 16px; border-bottom: 1px solid var(--pad-border-subtle, #e0e0e0); display: flex; flex-direction: column; gap: 12px; }
.pad-agentstab__form-row { display: flex; align-items: center; gap: 8px; }
.pad-agentstab__form-row--body { flex-direction: column; align-items: stretch; }
.pad-agentstab__label { font-size: var(--pad-fs-12); color: var(--pad-fg-secondary); width: 60px; flex-shrink: 0; }
.pad-agentstab__input { flex: 1; padding: 6px 10px; font-family: var(--pad-font-mono); font-size: var(--pad-fs-13); border: 1px solid var(--pad-border-subtle, #e0e0e0); border-radius: var(--pad-radius-sm, 4px); background: var(--pad-bg-base, #fff); }
.pad-agentstab__input:focus { outline: none; border-color: var(--pad-accent, #6366f1); }
.pad-agentstab__radio { display: flex; gap: 12px; }
.pad-agentstab__radio label { display: inline-flex; align-items: center; gap: 4px; font-size: var(--pad-fs-12); cursor: pointer; }
.pad-agentstab__textarea { width: 100%; padding: 10px; font-family: var(--pad-font-mono); font-size: var(--pad-fs-13); line-height: 1.6; border: 1px solid var(--pad-border-subtle, #e0e0e0); border-radius: var(--pad-radius-sm, 4px); background: var(--pad-bg-base, #fff); resize: vertical; min-height: 200px; }
.pad-agentstab__textarea:focus { outline: none; border-color: var(--pad-accent, #6366f1); }
.pad-agentstab__form-actions { display: flex; justify-content: flex-end; gap: 6px; }
.pad-agentstab__empty { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 40px 20px; gap: 8px; color: var(--pad-fg-tertiary); }
.pad-agentstab__empty-title { font-size: var(--pad-fs-14); color: var(--pad-fg-secondary); }
.pad-agentstab__empty-desc { font-size: var(--pad-fs-12); color: var(--pad-fg-tertiary); text-align: center; }
.pad-agentstab__list { list-style: none; padding: 0; margin: 0; }
.pad-agentstab__item { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-top: 1px solid var(--pad-border-subtle, rgba(0,0,0,0.04)); }
.pad-agentstab__item.is-main { background: var(--pad-bg-success-soft, rgba(34,197,94,0.04)); }
.pad-agentstab__item-body { flex: 1; min-width: 0; }
.pad-agentstab__item-name { display: flex; align-items: center; gap: 6px; font-size: var(--pad-fs-13); }
.pad-agentstab__item-name code { font-family: var(--pad-font-mono); font-size: var(--pad-fs-13); color: var(--pad-fg-primary); font-weight: var(--pad-fw-medium); }
.pad-agentstab__item-tag { font-size: 9px; padding: 1px 5px; border-radius: 3px; font-weight: var(--pad-fw-medium); text-transform: uppercase; letter-spacing: 0.3px; }
.pad-agentstab__item-tag.is-main { background: var(--pad-bg-success, rgba(34,197,94,0.15)); color: var(--pad-fg-success, #22c55e); }
.pad-agentstab__item-tag.is-sub { background: var(--pad-bg-muted, rgba(0,0,0,0.04)); color: var(--pad-fg-tertiary); }
.pad-agentstab__item-desc { font-size: var(--pad-fs-12); color: var(--pad-fg-secondary); margin-top: 2px; }
.pad-agentstab__item-body-preview { display: flex; align-items: center; gap: 4px; font-size: 11px; color: var(--pad-fg-tertiary); margin-top: 2px; font-family: var(--pad-font-mono); }
.pad-agentstab__item-actions { display: flex; gap: 4px; }
.pad-agentstab__hint { display: flex; align-items: flex-start; gap: 6px; padding: 12px 16px; color: var(--pad-fg-tertiary); font-size: 11px; line-height: 1.5; }
.pad-agentstab__hint code { font-family: var(--pad-font-mono); font-size: 10px; background: var(--pad-bg-muted, rgba(0,0,0,0.04)); padding: 1px 4px; border-radius: 2px; }
</style>
