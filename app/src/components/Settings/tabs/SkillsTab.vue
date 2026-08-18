<script setup lang="ts">
/**
 * v0.4.4 Skills (Pi SDK 暴露) — 设置面板 tab
 *
 * 走 Pi SDK 0.84.2 loadSkills / formatSkillsForPrompt / DefaultResourceLoader
 * .appendSystemPromptOverride. 数据从 sidecar 启动时 emit 的 skills_snapshot 拿 (走
 * chat:event channel, type 'skills_snapshot'), 存在 skills store.
 *
 * UI 设计: 跟 ProviderTab 风格一致 (页面 header + 内容卡片 + viewMode: 'list' | 'add').
 *   - 'list': 显示已加载的 skills + "+ 添加自定义" 按钮 (跟 Provider 的"添加自定义"同 pattern)
 *   - 'add': AddSkillForm 子组件, 收 name + description + body + scope (workspace / global)
 *
 * toggle 改 localStorage (skills store), 但 sidecar 没重启 → system prompt 还没注入
 * 新 enabled skills. user 必须重启 release .exe (D165 systemPrompt 不可动态改).
 * 完整"toggle 后自动重启 sidecar"是 v0.4.4.x polish.
 */
import { ref } from 'vue';
import { storeToRefs } from 'pinia';
import { Sparkles, Plus, AlertCircle, Info, Check } from 'lucide-vue-next';
import { useSkillsStore } from '@/stores/skills';
import AddSkillForm from './AddSkillForm.vue';

const skillsStore = useSkillsStore();
const { skills, hasSnapshot, diagnostics } = storeToRefs(skillsStore);

const viewMode = ref<'list' | 'add'>('list');
const toast = ref<{ type: 'ok' | 'fail'; message: string } | null>(null);

function onToggle(name: string, value: boolean) {
  if (value) skillsStore.enable(name);
  else skillsStore.disable(name);
  // v0.4.4 占位: toggle 改 localStorage, 但 sidecar 没重启 → system prompt 还没注入.
  //   user 必须重启 release .exe (kill 当前 sidecar + send_prompt 触发新 spawn) 才生效.
  console.warn(`[skills] toggled "${name}" → ${value}. 记得重启 release .exe 让 sidecar 重新加载 skills 注入 system prompt (D165 systemPrompt 不可动态改).`);
}

function openAdd() {
  viewMode.value = 'add';
  toast.value = null;
}
function closeAdd() {
  viewMode.value = 'list';
}
function onCreated(filePath: string) {
  // 写完文件, 切回 list, 显示 toast
  viewMode.value = 'list';
  toast.value = {
    type: 'ok',
    message: `已写入 ${filePath} — 记得重启 release .exe 让 sidecar 重新加载 skills`,
  };
  // 5s 后清掉 toast
  setTimeout(() => {
    if (toast.value?.message.includes(filePath)) toast.value = null;
  }, 5000);
}
/**
 * v0.4.4.4: zip 压缩包导入完成. 跟 .md 导入 / 手动 submit 类似, 切回 list + toast.
 * 不同点: 直接 import 完成, user 不需要再编辑 form, 所以不刷新 form 字段.
 */
function onZipImported(info: { name: string; targetDir: string; fileCount: number }) {
  viewMode.value = 'list';
  toast.value = {
    type: 'ok',
    message: `已解压 ${info.fileCount} 个文件 (${info.name}) 到 ${info.targetDir} — 记得重启 release .exe 让 sidecar 重新加载 skills`,
  };
  setTimeout(() => {
    if (toast.value?.message.includes(info.name)) toast.value = null;
  }, 5000);
}
</script>

<template>
  <div class="pad-skillstab">
    <!-- viewMode: 'list' → 显示 skills 列表 -->
    <template v-if="viewMode === 'list'">
      <div class="pad-skillstab__header">
        <h2 class="pad-skillstab__title">Skills</h2>
        <p class="pad-skillstab__subtitle">
          管理 Pi SDK 启用的 skills (走 <code>loadSkills</code> + <code>formatSkillsForPrompt</code> +
          <code>appendSystemPromptOverride</code>). 启用的 skills 会在每次 send_prompt 时
          注入 system prompt, 让 LLM 自动调用.
        </p>
      </div>

      <div v-if="toast" class="pad-skillstab__toast" :class="`is-${toast.type}`">
        <Check v-if="toast.type === 'ok'" :size="14" :stroke-width="1.75" />
        <AlertCircle v-else :size="14" :stroke-width="1.75" />
        <span>{{ toast.message }}</span>
        <button class="pad-skillstab__toast-close" @click="toast = null">×</button>
      </div>

      <div class="pad-skillstab__card">
        <div class="pad-skillstab__card-head">
          <Sparkles :size="14" :stroke-width="1.75" />
          <span class="pad-skillstab__card-title">
            {{ skills.length }} skills 加载
            <span v-if="hasSnapshot" class="pad-skillstab__count">
              · 启用 {{ skills.filter((s) => skillsStore.isEnabled(s.name)).length }} 个
            </span>
          </span>
          <button class="pad-skillstab__add-btn" @click="openAdd">
            <Plus :size="14" :stroke-width="1.75" />
            <span>添加自定义</span>
          </button>
        </div>

        <div v-if="!hasSnapshot" class="pad-skillstab__empty">
          <Sparkles :size="20" :stroke-width="1.5" />
          <div class="pad-skillstab__empty-title">⏳ 等待 sidecar 加载 skills...</div>
          <div class="pad-skillstab__empty-desc">
            第一次 <code>send_prompt</code> 后 sidecar 才会 emit <code>skills_snapshot</code> (走
            <code>chat:event</code> channel, 来自 stdout 启动时一次 emit).
            如果一直不显示, 检查 sidecar stderr 是否有 loadSkills 报错.
          </div>
        </div>

        <div v-else-if="skills.length === 0" class="pad-skillstab__empty">
          <Sparkles :size="20" :stroke-width="1.5" />
          <div class="pad-skillstab__empty-title">📭 暂 无 skills</div>
          <div class="pad-skillstab__empty-desc">
            在 <strong>workspace</strong> 的 <code>.pi/skills/</code> 或 <strong>全局</strong>
            <code>~/.pi/agent/skills/</code> 创建 <code>SKILL.md</code> (带 frontmatter:
            <code>name</code> + <code>description</code> + 可选 <code>disable-model-invocation</code>).
            <button class="pad-skillstab__inline-link" @click="openAdd">点此添加</button> 或
            详见 <a href="https://github.com/earendil-works/pi" target="_blank" rel="noopener">Pi SDK 文档</a>.
          </div>
        </div>

        <ul v-else class="pad-skillstab__list">
          <li v-for="s in skills" :key="s.name" class="pad-skillstab__item">
            <div class="pad-skillstab__item-body">
              <div class="pad-skillstab__item-name">
                <span>{{ s.name }}</span>
                <span v-if="s.disableModelInvocation" class="pad-skillstab__tag" title="disable-model-invocation: true, 只走 /skill:name 手动调用">manual</span>
              </div>
              <div class="pad-skillstab__item-desc">{{ s.description || '(no description)' }}</div>
              <div class="pad-skillstab__item-path">{{ s.baseDir }}</div>
            </div>
            <label class="pad-skillstab__item-toggle" :class="{ 'is-disabled': s.disableModelInvocation }">
              <input
                type="checkbox"
                :checked="skillsStore.isEnabled(s.name)"
                :disabled="s.disableModelInvocation"
                @change="(e: Event) => onToggle(s.name, (e.target as HTMLInputElement).checked)"
              />
            </label>
          </li>
        </ul>

        <div v-if="diagnostics.length > 0" class="pad-skillstab__diag">
          <AlertCircle :size="12" :stroke-width="1.75" />
          <span>{{ diagnostics.length }} skill 加载诊断 (e.g. collision / path 不存在)</span>
        </div>
      </div>

      <div class="pad-skillstab__hint">
        <Info :size="12" :stroke-width="1.75" />
        <span>
          toggle 后 <strong>重启 release .exe</strong> 让 sidecar 重新加载 skills 注入 system prompt
          (D165 systemPrompt 不可动态改). 后续 v0.4.4.x 会做"toggle 后自动重启 sidecar" polish.
        </span>
      </div>
    </template>

    <!-- viewMode: 'add' → AddSkillForm -->
    <AddSkillForm
      v-else
      @close="closeAdd"
      @created="onCreated"
      @zipImported="onZipImported"
    />
  </div>
</template>

<style scoped>
.pad-skillstab {
  max-width: 720px;
}
.pad-skillstab__header {
  margin-bottom: 16px;
}
.pad-skillstab__title {
  font-size: 18px;
  font-weight: 600;
  color: var(--pad-fg-primary);
  margin: 0 0 4px;
}
.pad-skillstab__subtitle {
  font-size: 12px;
  color: var(--pad-fg-tertiary);
  margin: 0;
  line-height: 1.5;
}
.pad-skillstab__subtitle code {
  font-family: var(--pad-font-mono, ui-monospace, monospace);
  font-size: 11px;
  background: var(--pad-bg-secondary, rgba(0, 0, 0, 0.04));
  padding: 1px 4px;
  border-radius: 3px;
}

.pad-skillstab__card {
  background: var(--pad-card);
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-lg);
  overflow: hidden;
}
.pad-skillstab__card-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--pad-border-subtle, rgba(0, 0, 0, 0.06));
  color: var(--pad-fg-secondary);
  font-size: 12px;
  font-weight: 500;
}
.pad-skillstab__card-title {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.pad-skillstab__count {
  color: var(--pad-fg-tertiary);
  font-weight: 400;
  font-variant-numeric: tabular-nums;
}

.pad-skillstab__empty {
  padding: 40px 24px;
  text-align: center;
  color: var(--pad-fg-tertiary);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}
.pad-skillstab__empty-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--pad-fg-secondary);
  margin-top: 4px;
}
.pad-skillstab__empty-desc {
  font-size: 11px;
  line-height: 1.6;
  max-width: 480px;
}
.pad-skillstab__empty-desc code {
  font-family: var(--pad-font-mono, ui-monospace, monospace);
  background: var(--pad-bg-secondary, rgba(0, 0, 0, 0.04));
  padding: 1px 4px;
  border-radius: 3px;
}
.pad-skillstab__empty-desc a {
  color: var(--pad-accent-primary, #6366f1);
  text-decoration: none;
}
.pad-skillstab__empty-desc a:hover {
  text-decoration: underline;
}

.pad-skillstab__list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.pad-skillstab__item {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--pad-border-subtle, rgba(0, 0, 0, 0.04));
  transition: background 0.1s;
}
.pad-skillstab__item:last-child {
  border-bottom: none;
}
.pad-skillstab__item:hover {
  background: var(--pad-bg-hover, rgba(0, 0, 0, 0.02));
}
.pad-skillstab__item-body {
  flex: 1;
  min-width: 0;
}
.pad-skillstab__item-name {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 500;
  color: var(--pad-fg-primary);
  font-size: 13px;
  margin-bottom: 4px;
}
.pad-skillstab__tag {
  font-size: 9px;
  font-weight: 500;
  padding: 1px 4px;
  border-radius: 3px;
  background: var(--pad-bg-tertiary, rgba(0, 0, 0, 0.06));
  color: var(--pad-fg-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.pad-skillstab__item-desc {
  font-size: 12px;
  color: var(--pad-fg-secondary);
  line-height: 1.5;
  margin-bottom: 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.pad-skillstab__item-path {
  font-size: 10px;
  color: var(--pad-fg-tertiary);
  font-family: var(--pad-font-mono, ui-monospace, monospace);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pad-skillstab__item-toggle {
  display: inline-flex;
  align-items: center;
  margin-top: 2px;
  flex-shrink: 0;
}
.pad-skillstab__item-toggle input {
  width: 16px;
  height: 16px;
  cursor: pointer;
  accent-color: var(--pad-accent-primary, #6366f1);
}
.pad-skillstab__item-toggle.is-disabled input {
  cursor: not-allowed;
  opacity: 0.4;
}

.pad-skillstab__diag {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  background: var(--pad-bg-warning-soft, rgba(217, 119, 6, 0.06));
  color: var(--pad-fg-warning, #d97706);
  font-size: 11px;
  border-top: 1px solid var(--pad-border-subtle, rgba(0, 0, 0, 0.06));
}

.pad-skillstab__hint {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin-top: 12px;
  padding: 10px 12px;
  background: var(--pad-bg-secondary, rgba(0, 0, 0, 0.02));
  border-radius: var(--pad-radius-md);
  color: var(--pad-fg-tertiary);
  font-size: 11px;
  line-height: 1.5;
}

/* v0.4.4.2 添加自定义按钮 (跟 ProviderTab "添加自定义" 同 pattern) */
.pad-skillstab__add-btn {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  font-size: 11px;
  font-weight: 500;
  color: var(--pad-fg-secondary);
  background: var(--pad-card);
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-md);
  cursor: pointer;
  transition: all 0.15s;
}
.pad-skillstab__add-btn:hover {
  background: var(--pad-bg-hover, rgba(0, 0, 0, 0.04));
  color: var(--pad-fg-primary);
  border-color: var(--pad-accent-primary, #6366f1);
}

.pad-skillstab__inline-link {
  background: none;
  border: none;
  color: var(--pad-accent-primary, #6366f1);
  text-decoration: underline;
  cursor: pointer;
  font: inherit;
  padding: 0;
}
.pad-skillstab__inline-link:hover {
  text-decoration: none;
}

/* Toast (创建成功提示) */
.pad-skillstab__toast {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  padding: 8px 12px;
  border-radius: var(--pad-radius-md);
  font-size: 12px;
}
.pad-skillstab__toast.is-ok {
  background: var(--pad-bg-success-soft, rgba(34, 197, 94, 0.08));
  color: var(--pad-fg-success, #16a34a);
  border: 1px solid var(--pad-fg-success-soft, rgba(34, 197, 94, 0.2));
}
.pad-skillstab__toast.is-fail {
  background: var(--pad-bg-warning-soft, rgba(217, 119, 6, 0.08));
  color: var(--pad-fg-warning, #d97706);
  border: 1px solid var(--pad-fg-warning-soft, rgba(217, 119, 6, 0.2));
}
.pad-skillstab__toast-close {
  margin-left: auto;
  background: transparent;
  border: none;
  color: inherit;
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
  padding: 0 4px;
  opacity: 0.6;
}
.pad-skillstab__toast-close:hover {
  opacity: 1;
}
</style>
