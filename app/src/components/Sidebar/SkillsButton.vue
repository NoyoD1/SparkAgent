<script setup lang="ts">
/**
 * v0.4.4 Skills (Pi SDK 暴露) — Sidebar 入口按钮
 *
 * 走 v0.4.3 ContextIndicator 同样的纯 Vue + CSS popover pattern (D183 弹窗靠 click outside 关):
 *   - icon button (Sparkles) + count badge 显示 enabled / total
 *   - click → 切 showPopover, 用 onDocumentClick 监听 mousedown 关弹窗 (跟 v0.4.3 一致)
 *   - 不引第三方 UI 库 (项目没装 naive-ui, 纯 CSS + Vue)
 *
 * 数据:
 *   - skills store: 订阅 sidecar emit 的 skills_snapshot, 列表 + enabled 状态
 *   - toggle 改 localStorage + 提示 user 重启 sidecar (D165 systemPrompt 不可动态改)
 *
 * 当前占位 (等 user 拍板):
 *   - icon + count 显示
 *   - 列表项: name + description + toggle (原生 checkbox)
 *   - 弹窗内容只有 list + 空状态, 复杂编辑 (新建 skill / 上传 / 编辑 frontmatter) 不在 v0.4.4 范围
 */
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { storeToRefs } from 'pinia';
import { Sparkles } from 'lucide-vue-next';
import { useSkillsStore } from '@/stores/skills';

const skillsStore = useSkillsStore();
const { skills, hasSnapshot, diagnostics } = storeToRefs(skillsStore);

const enabledCount = computed(() =>
  skills.value.filter((s) => skillsStore.isEnabled(s.name)).length,
);

const showPopover = ref(false);
const popoverRef = ref<HTMLElement | null>(null);

function togglePopover() {
  showPopover.value = !showPopover.value;
}
function onDocumentClick(e: MouseEvent) {
  if (!showPopover.value) return;
  const target = e.target as Node;
  if (popoverRef.value && !popoverRef.value.contains(target)) {
    showPopover.value = false;
  }
}
function onEscape(e: KeyboardEvent) {
  if (e.key === 'Escape' && showPopover.value) {
    showPopover.value = false;
  }
}

onMounted(() => {
  document.addEventListener('mousedown', onDocumentClick);
  document.addEventListener('keydown', onEscape);
});
onUnmounted(() => {
  document.removeEventListener('mousedown', onDocumentClick);
  document.removeEventListener('keydown', onEscape);
});

function onToggle(name: string, value: boolean) {
  if (value) skillsStore.enable(name);
  else skillsStore.disable(name);
  // v0.4.4 占位: toggle 改 localStorage, 但 sidecar 没重启 → system prompt 还没注入新 enabled skills.
  //   user 必须重启 sidecar (kill 当前 sidecar 进程 + send_prompt 触发新 spawn) 才生效.
  //   完整"toggle 后自动重启 sidecar"是 v0.4.4.x polish, 这次先做最小可见.
  console.warn(`[skills] toggled "${name}" → ${value}. 记得重启 release .exe 让 sidecar 重新加载 skills 注入 system prompt (D165 systemPrompt 不可动态改).`);
}
</script>

<template>
  <div ref="popoverRef" class="pad-skills">
    <button
      class="pad-skills-btn"
      :class="{ 'is-active': enabledCount > 0 }"
      :title="enabledCount > 0 ? `已启用 ${enabledCount} / ${skills.length} skills` : 'Skills'"
      @click="togglePopover"
    >
      <Sparkles :size="16" :stroke-width="1.75" />
      <span v-if="enabledCount > 0" class="pad-skills-btn__count">{{ enabledCount }}</span>
    </button>

    <!-- v0.4.4: Popover 二级展开 (跟 v0.4.3 ContextIndicator 同 pattern, 纯 Vue + CSS) -->
    <div v-if="showPopover" class="pad-skills-popover" @click.stop>
      <div class="pad-skills-popover-head">
        <Sparkles :size="14" :stroke-width="1.75" />
        <span class="pad-skills-popover-title">Skills</span>
        <span class="pad-skills-popover-count">{{ enabledCount }} / {{ skills.length }}</span>
      </div>

      <div class="pad-skills-popover-body">
        <div v-if="!hasSnapshot" class="pad-skills-popover-empty">
          <div class="pad-skills-popover-empty-title">⏳ 等待 sidecar 加载 skills...</div>
          <div class="pad-skills-popover-empty-desc">
            第一次 send_prompt 后 sidecar 才会 emit skills_snapshot (走 RpcEvent 'chat:event' channel).
          </div>
        </div>
        <div
          v-else-if="skills.length === 0"
          class="pad-skills-popover-empty"
        >
          <div class="pad-skills-popover-empty-title">📭 暂 无 skills</div>
          <div class="pad-skills-popover-empty-desc">
            在 workspace 的 <code>.pi/skills/</code> 或全局 <code>~/.pi/agent/skills/</code> 创建 SKILL.md
          </div>
        </div>
        <ul v-else class="pad-skills-list">
          <li v-for="s in skills" :key="s.name" class="pad-skills-item">
            <div class="pad-skills-item-body">
              <div class="pad-skills-item-name">
                <span>{{ s.name }}</span>
                <span v-if="s.disableModelInvocation" class="pad-skills-item-tag" title="disable-model-invocation: true, 只走 /skill:name 手动调用">manual</span>
              </div>
              <div class="pad-skills-item-desc">{{ s.description || '(no description)' }}</div>
              <div class="pad-skills-item-path">{{ s.baseDir }}</div>
            </div>
            <label class="pad-skills-item-toggle" :class="{ 'is-disabled': s.disableModelInvocation }">
              <input
                type="checkbox"
                :checked="skillsStore.isEnabled(s.name)"
                :disabled="s.disableModelInvocation"
                @change="(e: Event) => onToggle(s.name, (e.target as HTMLInputElement).checked)"
              />
            </label>
          </li>
        </ul>
      </div>

      <div v-if="diagnostics.length > 0" class="pad-skills-popover-diag">
        ⚠️ {{ diagnostics.length }} skill 加载诊断 (e.g. collision / path 不存在)
      </div>

      <div class="pad-skills-popover-hint">
        💡 toggle 后 <strong>重启 release .exe</strong> 让 sidecar 重新加载 skills 注入 system prompt
      </div>
    </div>
  </div>
</template>

<style scoped>
.pad-skills {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.pad-skills-btn {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: var(--pad-radius-md);
  background: transparent;
  border: 1px solid transparent;
  color: var(--pad-fg-tertiary);
  cursor: pointer;
  transition: all 0.15s;
}
.pad-skills-btn:hover {
  background: var(--pad-bg-hover, rgba(0, 0, 0, 0.05));
  color: var(--pad-fg-secondary);
}
.pad-skills-btn.is-active {
  color: var(--pad-accent-primary, #6366f1);
  background: var(--pad-bg-accent-soft, rgba(99, 102, 241, 0.08));
}
.pad-skills-btn__count {
  position: absolute;
  top: -2px;
  right: -2px;
  min-width: 14px;
  height: 14px;
  padding: 0 3px;
  border-radius: 7px;
  background: var(--pad-accent-primary, #6366f1);
  color: white;
  font-size: 9px;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-variant-numeric: tabular-nums;
}

/* Popover (跟 v0.4.3 ContextIndicator 同 minimalist 风格, D183 弹窗靠 click outside 关) */
.pad-skills-popover {
  position: absolute;
  top: 0;
  left: calc(100% + 8px);
  z-index: 1000;
  min-width: 340px;
  max-width: 380px;
  background: var(--pad-card);
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-lg);
  /* v0.4.3.1.1: 跟整体 minimalist 风格一致, 1px border + 0 box-shadow */
  box-shadow: none;
  font-size: 12px;
  user-select: none;
}
.pad-skills-popover-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--pad-border-subtle, rgba(0, 0, 0, 0.06));
  color: var(--pad-fg-primary);
}
.pad-skills-popover-title {
  font-weight: 600;
  font-size: 13px;
}
.pad-skills-popover-count {
  margin-left: auto;
  font-variant-numeric: tabular-nums;
  color: var(--pad-fg-tertiary);
  font-size: 11px;
}
.pad-skills-popover-body {
  max-height: 360px;
  overflow-y: auto;
}

.pad-skills-popover-empty {
  padding: 24px 16px;
  text-align: center;
}
.pad-skills-popover-empty-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--pad-fg-secondary);
  margin-bottom: 6px;
}
.pad-skills-popover-empty-desc {
  font-size: 11px;
  color: var(--pad-fg-tertiary);
  line-height: 1.5;
}
.pad-skills-popover-empty-desc code {
  font-family: var(--pad-font-mono, ui-monospace, monospace);
  background: var(--pad-bg-secondary, rgba(0, 0, 0, 0.04));
  padding: 1px 4px;
  border-radius: 3px;
}

.pad-skills-list {
  list-style: none;
  margin: 0;
  padding: 4px 0;
}
.pad-skills-item {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--pad-border-subtle, rgba(0, 0, 0, 0.04));
}
.pad-skills-item:last-child {
  border-bottom: none;
}
.pad-skills-item-body {
  flex: 1;
  min-width: 0;
}
.pad-skills-item-name {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 500;
  color: var(--pad-fg-primary);
  font-size: 12px;
}
.pad-skills-item-tag {
  font-size: 9px;
  font-weight: 500;
  padding: 1px 4px;
  border-radius: 3px;
  background: var(--pad-bg-tertiary, rgba(0, 0, 0, 0.06));
  color: var(--pad-fg-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.pad-skills-item-desc {
  font-size: 11px;
  color: var(--pad-fg-secondary);
  margin-top: 2px;
  line-height: 1.4;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.pad-skills-item-path {
  font-size: 10px;
  color: var(--pad-fg-tertiary);
  margin-top: 4px;
  font-family: var(--pad-font-mono, ui-monospace, monospace);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pad-skills-item-toggle {
  display: inline-flex;
  align-items: center;
  margin-top: 2px;
}
.pad-skills-item-toggle input {
  width: 14px;
  height: 14px;
  cursor: pointer;
  accent-color: var(--pad-accent-primary, #6366f1);
}
.pad-skills-item-toggle.is-disabled input {
  cursor: not-allowed;
  opacity: 0.4;
}

.pad-skills-popover-diag {
  padding: 6px 12px;
  background: var(--pad-bg-warning-soft, rgba(217, 119, 6, 0.06));
  color: var(--pad-fg-warning, #d97706);
  font-size: 10px;
  border-top: 1px solid var(--pad-border-subtle, rgba(0, 0, 0, 0.06));
}

.pad-skills-popover-hint {
  padding: 8px 12px;
  font-size: 10px;
  color: var(--pad-fg-tertiary);
  border-top: 1px solid var(--pad-border-subtle, rgba(0, 0, 0, 0.06));
  background: var(--pad-bg-secondary, rgba(0, 0, 0, 0.02));
}
</style>
