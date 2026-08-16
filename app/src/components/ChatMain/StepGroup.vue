<script setup lang="ts">
/**
 * StepGroup — v0.4.1 单个 step group 渲染
 *
 * 1 turn = 1 step = (thinking 1+ → tool_call 0+ → step text 可选)
 *
 * 视觉 (v0.4.1.2 美化, 参考 Cursor 风格):
 * - 标题行: "步骤 N · 思考 X 次 · 调用 M 工具" 极简, 12px fg-tertiary 跟正文 14px 区分
 * - 当前 step: 左边 2px accent 边 + 小 spinner 提示"运行中", 不强制展开
 * - 展开后: thinking 块 (fs-11 italic fg-tertiary) + tool_call 列表 (fs-11 mono)
 * - step 内的 text **不渲染**, 统一在 final body 显示 (避免重复)
 * - 默认全折叠, 用户点开才看
 */
import { computed, ref } from 'vue';
import { ChevronDown, Wrench, Brain, Loader2 } from 'lucide-vue-next';
import type { Step, ThinkingBlock, ToolCallBlock } from '@/lib/mock/types';
import { useChatStore } from '@/stores/chat';
import MarkdownContent from './MarkdownContent.vue';

interface Props {
  step: Step;
  sessionId: string;
  messageId: string;
  index: number;
  isLast: boolean;
}

const props = defineProps<Props>();
const chatStore = useChatStore();

const thinkingBlocks = computed(() => props.step.thinking);
const toolCalls = computed(() => props.step.toolCalls);
const isActive = computed(() => props.step.isActive);
const collapsed = computed(() => props.step.collapsed);

const thinkingCount = computed(() => thinkingBlocks.value.filter((t) => t.content).length);
const toolCount = computed(() => toolCalls.value.length);
const runningCount = computed(() => toolCalls.value.filter((t) => t.status === 'running').length);

function toggleCollapsed() {
  chatStore.setStepCollapsed(props.sessionId, props.messageId, props.step.id, !collapsed.value);
}

function toggleThinkingCollapsed(tb: ThinkingBlock) {
  chatStore.setStepThinkingCollapsed(
    props.sessionId,
    props.messageId,
    props.step.id,
    !tb.collapsed,
  );
}

const toolsCollapsed = ref(true);
function toggleToolsCollapsed() {
  toolsCollapsed.value = !toolsCollapsed.value;
}

function toolStatusLabel(t: ToolCallBlock): string {
  if (t.status === 'running' || t.status === 'pending') return '运行中';
  if (t.status === 'success') return '完成';
  return '失败';
}

function toolArgsSummary(t: ToolCallBlock): string {
  const keys = Object.keys(t.args || {});
  if (keys.length === 0) return '';
  const first = keys[0];
  const v = t.args[first];
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  const preview = s.length > 50 ? s.slice(0, 50) + '…' : s;
  return `${first}: ${preview}`;
}

/* // 标题: "步骤 N · 思考 X 次 · 调用 M 工具" (无 emoji, 简约) */
const stepSummary = computed(() => {
  const parts: string[] = [];
  if (thinkingCount.value > 0) parts.push(`思考 ${thinkingCount.value} 次`);
  if (toolCount.value > 0) {
    const txt = `调用 ${toolCount.value} 个工具`;
    parts.push(runningCount.value > 0 ? `${txt} (${runningCount.value} 运行中)` : txt);
  }
  if (parts.length === 0) return `步骤 ${props.index}`;
  return parts.join(' · ');
});
</script>

<template>
  <div
    class="pad-step"
    :class="{
      'is-active': isActive,
      'is-collapsed': collapsed,
      'is-last': isLast,
    }"
  >
    <!-- 标题行: 始终可见, 灰色 12px, 跟正文 14px 区分 -->
    <button class="pad-step__title" type="button" @click="toggleCollapsed">
      <span class="pad-step__title-prefix">
        <Loader2 v-if="isActive" :size="11" :stroke-width="2" class="pad-step__spinner" />
        <span v-else class="pad-step__num">{{ index }}</span>
      </span>
      <span class="pad-step__title-text">
        <span>步骤 {{ index }}</span>
        <span v-if="thinkingCount > 0 || toolCount > 0" class="pad-step__title-sep">·</span>
        <span>{{ stepSummary }}</span>
        <span v-if="isActive" class="pad-step__title-status">运行中</span>
      </span>
      <ChevronDown
        :size="11"
        :stroke-width="1.75"
        :class="['pad-step__chev', { 'is-collapsed': collapsed }]"
      />
    </button>

    <!-- 展开内容 -->
    <div :class="['pad-step__body', { 'is-collapsed': collapsed }]">
      <!-- thinking blocks (按时间顺序, fs-11 italic fg-tertiary) -->
      <div
        v-for="tb in thinkingBlocks"
        v-show="tb.content"
        :key="tb.id"
        class="pad-step__thinking"
      >
        <button
          class="pad-step__thinking-toggle"
          type="button"
          @click="toggleThinkingCollapsed(tb)"
        >
          <Brain :size="10" :stroke-width="1.75" />
          <span>思考</span>
          <ChevronDown
            :size="10"
            :stroke-width="1.75"
            :class="['pad-step__chev', { 'is-collapsed': tb.collapsed }]"
          />
        </button>
        <div :class="['pad-step__thinking-body', { 'is-collapsed': tb.collapsed }]">
          <div class="pad-step__thinking-content">
            <MarkdownContent :content="tb.content" />
          </div>
        </div>
      </div>

      <!-- tool calls (fs-11 mono) -->
      <div v-if="toolCalls.length > 0" class="pad-step__tools">
        <button
          class="pad-step__tools-toggle"
          type="button"
          @click="toggleToolsCollapsed"
        >
          <Wrench :size="10" :stroke-width="1.75" />
          <span>{{ toolCalls.length }} 个工具调用</span>
          <ChevronDown
            :size="10"
            :stroke-width="1.75"
            :class="['pad-step__chev', { 'is-collapsed': toolsCollapsed }]"
          />
        </button>
        <div :class="['pad-step__tools-body', { 'is-collapsed': toolsCollapsed }]">
          <ul class="pad-step__tools-list">
            <li
              v-for="t in toolCalls"
              :key="t.id"
              class="pad-step__tools-item"
              :class="`is-${t.status}`"
            >
              <div class="pad-step__tools-row">
                <span class="pad-step__tools-name">{{ t.name }}</span>
                <span class="pad-step__tools-status">{{ toolStatusLabel(t) }}</span>
              </div>
              <div v-if="toolArgsSummary(t)" class="pad-step__tools-args">
                {{ toolArgsSummary(t) }}
              </div>
              <pre v-if="t.result" class="pad-step__tools-result">{{ t.result }}</pre>
            </li>
          </ul>
        </div>
      </div>

      <!-- v0.4.1.2 fix: step 内不渲染 stepText, text 统一在 final body (lastStep.stepText) 显示
       * 避免 step 内 stepText 跟 final body 内容重复 (user 反馈"出现多次同样内容") -->
    </div>
  </div>
</template>

<style scoped>
/* ===== step group 容器: 极简, 左边 2px accent 边仅当 isActive ===== */
.pad-step {
  margin: 2px 0;
  padding: 0;
  position: relative;
}
.pad-step.is-active {
  border-left: 2px solid var(--pad-accent);
  padding-left: 8px;
  margin-left: -2px;
  background: var(--pad-muted);
  border-radius: 4px;
}

/* ===== 标题行: 12px fg-tertiary, 跟正文 14px 区分明显 ===== */
.pad-step__title {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 4px 6px;
  background: transparent;
  border: none;
  cursor: pointer;
  font-family: inherit;
  text-align: left;
  color: var(--pad-fg-tertiary);
  font-size: var(--pad-fs-12);
  font-weight: var(--pad-fw-medium);
  letter-spacing: 0.01em;
  border-radius: 4px;
  transition: background var(--pad-dur-fast) ease, color var(--pad-dur-fast) ease;
}
.pad-step__title:hover {
  background: var(--pad-bg-hover);
  color: var(--pad-fg-secondary);
}
.pad-step.is-active .pad-step__title {
  color: var(--pad-fg-secondary);
}
.pad-step__title-prefix {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  font-size: var(--pad-fs-11);
  color: var(--pad-fg-tertiary);
  flex-shrink: 0;
}
.pad-step.is-active .pad-step__title-prefix {
  color: var(--pad-accent);
}
.pad-step__num {
  font-family: var(--pad-font-mono);
}
.pad-step__spinner {
  animation: pad-step-spin 1.4s linear infinite;
}
@keyframes pad-step-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
.pad-step__title-text {
  flex: 1;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}
.pad-step__title-sep {
  color: var(--pad-fg-tertiary);
  opacity: 0.5;
}
.pad-step__title-status {
  color: var(--pad-accent);
  font-size: var(--pad-fs-11);
  margin-left: 4px;
}
.pad-step__chev {
  transition: transform var(--pad-dur-base) var(--pad-ease-in-out);
  flex-shrink: 0;
}
.pad-step__chev.is-collapsed { transform: rotate(-90deg); }

/* ===== step body 折叠: 紧凑 ===== */
.pad-step__body {
  padding: 4px 0 4px 16px;
  max-height: 4000px;
  overflow: hidden;
  opacity: 1;
  transition:
    max-height var(--pad-dur-base) var(--pad-ease-out-soft),
    opacity var(--pad-dur-fast) ease,
    padding var(--pad-dur-base) var(--pad-ease-out-soft);
}
.pad-step__body.is-collapsed {
  max-height: 0;
  height: 0;
  padding-top: 0;
  padding-bottom: 0;
  margin: 0;
  border: 0;
  opacity: 0;
  overflow: hidden;
}

/* ===== thinking 块 (fs-11 italic fg-tertiary) ===== */
.pad-step__thinking { margin: 4px 0; }
.pad-step__thinking-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: var(--pad-fs-11);
  font-weight: var(--pad-fw-medium);
  color: var(--pad-fg-tertiary);
  background: transparent;
  border: none;
  padding: 2px 0;
  cursor: pointer;
  letter-spacing: 0.01em;
  font-family: inherit;
  font-style: italic;
}
.pad-step__thinking-toggle:hover { color: var(--pad-fg-secondary); }
.pad-step__thinking-body {
  max-height: 2000px;
  overflow: hidden;
  opacity: 1;
  transition:
    max-height var(--pad-dur-base) var(--pad-ease-out-soft),
    opacity var(--pad-dur-fast) ease;
}
.pad-step__thinking-body.is-collapsed {
  max-height: 0;
  height: 0;
  padding: 0;
  margin: 0;
  border: 0;
  opacity: 0;
  overflow: hidden;
}
.pad-step__thinking-content {
  margin-top: 2px;
  padding: 6px 8px;
  font-size: var(--pad-fs-11);
  font-style: italic;
  color: var(--pad-fg-tertiary);
  line-height: var(--pad-lh-base);
  background: var(--pad-muted);
  border-radius: 4px;
}
/* 深穿透 MarkdownContent 内部, 保持 italic + fg-tertiary */
.pad-step__thinking-content :deep(.pad-md),
.pad-step__thinking-content :deep(.pad-md h1),
.pad-step__thinking-content :deep(.pad-md h2),
.pad-step__thinking-content :deep(.pad-md h3),
.pad-step__thinking-content :deep(.pad-md p) {
  font-style: italic;
  color: var(--pad-fg-tertiary);
}

/* ===== tool calls 块 (fs-11 mono) ===== */
.pad-step__tools { margin: 4px 0; }
.pad-step__tools-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: var(--pad-fs-11);
  font-weight: var(--pad-fw-medium);
  color: var(--pad-fg-tertiary);
  background: transparent;
  border: none;
  padding: 2px 0;
  cursor: pointer;
  letter-spacing: 0.01em;
  font-family: inherit;
}
.pad-step__tools-toggle:hover { color: var(--pad-fg-secondary); }
.pad-step__tools-body {
  max-height: 800px;
  overflow: hidden;
  opacity: 1;
  transition:
    max-height var(--pad-dur-base) var(--pad-ease-out-soft),
    opacity var(--pad-dur-fast) ease;
}
.pad-step__tools-body.is-collapsed {
  max-height: 0;
  height: 0;
  padding: 0;
  margin: 0;
  border: 0;
  opacity: 0;
  overflow: hidden;
}
.pad-step__tools-list {
  list-style: none;
  padding: 0 0 0 6px;
  margin: 2px 0 0;
  border-left: 1px solid var(--pad-border);
}
.pad-step__tools-item {
  padding: 2px 0;
  font-size: var(--pad-fs-11);
  color: var(--pad-fg-secondary);
}
.pad-step__tools-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.pad-step__tools-name {
  font-family: var(--pad-font-mono);
  font-weight: var(--pad-fw-medium);
  color: var(--pad-fg-secondary);
}
.pad-step__tools-status {
  font-size: var(--pad-fs-11);
  color: var(--pad-fg-tertiary);
  padding: 0 6px;
  border-radius: 999px;
  background: var(--pad-muted);
}
.pad-step__tools-item.is-running .pad-step__tools-status {
  color: var(--pad-accent);
  background: var(--pad-accent-soft);
}
.pad-step__tools-item.is-error .pad-step__tools-status {
  color: var(--pad-danger);
  background: var(--pad-danger-subtle);
}
.pad-step__tools-args {
  margin-top: 1px;
  color: var(--pad-fg-tertiary);
  font-family: var(--pad-font-mono);
  font-size: var(--pad-fs-11);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pad-step__tools-result {
  margin: 2px 0 0;
  padding: 4px 6px;
  background: var(--pad-muted);
  border-radius: 4px;
  font-family: var(--pad-font-mono);
  font-size: var(--pad-fs-11);
  color: var(--pad-fg-secondary);
  white-space: pre-wrap;
  word-wrap: break-word;
  max-height: 120px;
  overflow: auto;
}
</style>
