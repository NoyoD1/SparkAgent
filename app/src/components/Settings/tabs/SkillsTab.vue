<script setup lang="ts">
/**
 * v0.4.4 Skills (Pi SDK 暴露) — 设置面板 tab
 *
 * 走 Pi SDK 0.84.2 loadSkills / formatSkillsForPrompt / DefaultResourceLoader
 * .appendSystemPromptOverride. 数据从 sidecar 启动时 emit 的 skills_snapshot 拿 (走
 * chat:event channel, type 'skills_snapshot'), 存在 skills store.
 *
 * UI 设计: 跟 ProviderTab 风格一致 (页面 header + 内容卡片), 但 v0.4.4 是"管理"
 * 性质 (勾选启用) 不是"配置"性质 (填 baseUrl + key), 所以 list 走 SkillsButton
 * 同 pattern: name + description + baseDir + 原生 checkbox.
 *
 * toggle 改 localStorage (skills store), 但 sidecar 没重启 → system prompt 还没注入
 * 新 enabled skills. user 必须重启 release .exe (D165 systemPrompt 不可动态改).
 * 完整"toggle 后自动重启 sidecar"是 v0.4.4.x polish.
 */
import { storeToRefs } from 'pinia';
import { Sparkles, AlertCircle, Info } from 'lucide-vue-next';
import { useSkillsStore } from '@/stores/skills';

const skillsStore = useSkillsStore();
const { skills, hasSnapshot, diagnostics } = storeToRefs(skillsStore);

function onToggle(name: string, value: boolean) {
  if (value) skillsStore.enable(name);
  else skillsStore.disable(name);
  // v0.4.4 占位: toggle 改 localStorage, 但 sidecar 没重启 → system prompt 还没注入.
  //   user 必须重启 release .exe (kill 当前 sidecar + send_prompt 触发新 spawn) 才生效.
  console.warn(`[skills] toggled "${name}" → ${value}. 记得重启 release .exe 让 sidecar 重新加载 skills 注入 system prompt (D165 systemPrompt 不可动态改).`);
}
</script>

<template>
  <div class="pad-skillstab">
    <div class="pad-skillstab__header">
      <h2 class="pad-skillstab__title">Skills</h2>
      <p class="pad-skillstab__subtitle">
        管理 Pi SDK 启用的 skills (走 <code>loadSkills</code> + <code>formatSkillsForPrompt</code> +
        <code>appendSystemPromptOverride</code>). 启用的 skills 会在每次 send_prompt 时
        注入 system prompt, 让 LLM 自动调用.
      </p>
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
</style>
