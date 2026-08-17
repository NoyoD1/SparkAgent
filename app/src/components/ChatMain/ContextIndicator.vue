<script setup lang="ts">
/**
 * v0.4.3 redesign: ContextIndicator — 紧凑 context 计数 + popover 二级展开
 *
 * 设计来源: Claude Code web (claude.ai/code) 上下文窗口展开模式
 *   - 主 toolbar: 紧凑 `上下文 83%` + 细色条 (位置: 切换 model chip 左侧, 跟 model 一体)
 *   - 点击 → popover 二级展开
 *     - 上下文窗口 83% + 进度条
 *     - Token 来源分 (Q2=B 按来源分, 精确): Input (新) / Cache 命中 / Cache 写入 / Output
 *     - BYOK 无套餐限制 (Q3=B 简化提示, 一行 italic)
 *     - [🗄️ 压缩 context] 按钮
 *     - [X] 关闭
 *   - 70% 阈值高亮, 压缩中 spinner
 *
 * UX 原则 (D173 跨项目规则):
 *   "功能逻辑是一体的, 不会割裂" — context (计数 + breakdown + 用量 + 压缩) 全在 1 个组件
 *   不像 v0.4.3 旧设计那样 text 计数 + 独立压缩按钮分散在 toolbar
 *
 * 跟 chat store 集成:
 *   - getContextTokens(sid) → 计算 contextTokens = input + cacheRead + cacheWrite
 *   - lastUsageBySession[sid] → 取 input/output/cacheRead/cacheWrite 4 字段
 *   - isContextHigh(sid) → 70% 阈值
 *   - isCompacting(sid) → 压缩中状态
 *   - compact(sid) → 触发压缩 RpcCommand
 */
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { BarChart3, ChevronDown, Archive, X, Loader2 } from 'lucide-vue-next';
import { useChatStore } from '@/stores/chat';
import { useSessionStore } from '@/stores/session';

const chatStore = useChatStore();
const sessionStore = useSessionStore();
const { activeSession } = storeToRefs(sessionStore);

const showPopover = ref(false);
const popoverRef = ref<HTMLElement | null>(null);

// ======== computed (从 chat store 拉数据) ========

const contextTokens = computed(() => {
  const sid = activeSession.value?.id;
  if (!sid) return 0;
  return chatStore.getContextTokens(sid);
});
const contextWindow = computed(() => chatStore.getContextWindow());
const percent = computed(() => {
  if (contextWindow.value === 0) return 0;
  return Math.min(100, Math.round((contextTokens.value / contextWindow.value) * 100));
});
const isHigh = computed(() => {
  const sid = activeSession.value?.id;
  if (!sid) return false;
  return chatStore.isContextHigh(sid);
});
const isCompacting = computed(() => {
  const sid = activeSession.value?.id;
  if (!sid) return false;
  return chatStore.isCompacting(sid);
});
const isStreaming = computed(() => {
  const sid = activeSession.value?.id;
  if (!sid) return false;
  return chatStore.isStreamingSession(sid);
});

// 取上次 assistant 消息的完整 usage, 4 字段都展示
const lastUsage = computed(() => {
  const sid = activeSession.value?.id;
  if (!sid) return undefined;
  return chatStore.lastUsageBySession[sid];
});
const inputTokens = computed(() => lastUsage.value?.input ?? 0);
const outputTokens = computed(() => lastUsage.value?.output ?? 0);
const cacheReadTokens = computed(() => lastUsage.value?.cacheRead ?? 0);
const cacheWriteTokens = computed(() => lastUsage.value?.cacheWrite ?? 0);
const cost = computed(() => {
  // cost 字段是按 provider 分类 (input/output/cacheRead/cacheWrite), 没有 total 字段
  // v0.4.3 简化: 只 sum 4 字段, 跟 Pi SDK cost 字段对齐
  if (!lastUsage.value?.cost) return 0;
  const c = lastUsage.value.cost;
  return c.input + c.output + c.cacheRead + c.cacheWrite;
});

// ======== 工具 ========

function formatTokens(n: number): string {
  if (n === 0) return '0';
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return `${n}`;
}
function formatCost(c: number): string {
  if (c === 0) return '$0';
  if (c < 0.01) return `$${c.toFixed(4)}`;
  return `$${c.toFixed(3)}`;
}

// ======== popover 控制 ========

function togglePopover() {
  if (isCompacting.value) return;  // 压缩中不响应点击
  showPopover.value = !showPopover.value;
}
function closePopover() {
  showPopover.value = false;
}
function onCompress() {
  const sid = activeSession.value?.id;
  if (!sid) return;
  chatStore.compact(sid);
  // 压缩触发后不立刻关 popover, 让 user 看到 "压缩中" 状态
  // compaction_end 后 button 恢复, user 可手动关
}

// ======== 点击外部关闭 ========

function onDocumentClick(e: MouseEvent) {
  if (!showPopover.value) return;
  const target = e.target as Node;
  if (popoverRef.value && !popoverRef.value.contains(target)) {
    closePopover();
  }
}
function onEscape(e: KeyboardEvent) {
  if (e.key === 'Escape' && showPopover.value) {
    closePopover();
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

// session 切换时自动关 popover
watch(() => activeSession.value?.id, () => {
  showPopover.value = false;
});

// ======== 标题 (tooltip) ========

const buttonTitle = computed(() => {
  if (isCompacting.value) return '正在压缩 context...';
  if (isHigh.value) return `Context 已用 ${percent.value}% — 点击查看详细用量并压缩`;
  return `Context: ${formatTokens(contextTokens.value)} / ${formatTokens(contextWindow.value)} — 点击查看详细用量`;
});
</script>

<template>
  <div ref="popoverRef" class="pad-ctx-indicator" :class="{ 'is-high': isHigh, 'is-loading': isCompacting }">
    <button
      class="pad-ctx-btn"
      :disabled="isCompacting"
      :title="buttonTitle"
      @click="togglePopover"
    >
      <BarChart3 v-if="!isCompacting" :size="14" :stroke-width="1.75" />
      <Loader2 v-else :size="14" :stroke-width="1.75" class="pad-ctx-btn-spinner" />
      <span class="pad-ctx-text">上下文 {{ percent }}%</span>
      <ChevronDown :size="12" :stroke-width="1.75" :class="['pad-ctx-btn-chev', { 'is-flipped': showPopover }]" />
    </button>

    <!-- Popover 二级展开 (Claude Code 风格) -->
    <div v-if="showPopover" class="pad-ctx-popover" @click.stop>
      <div class="pad-ctx-popover-head">
        <span class="pad-ctx-popover-title">上下文窗口</span>
        <span class="pad-ctx-popover-pct">{{ percent }}%</span>
        <button class="pad-ctx-popover-close" title="关闭" @click="closePopover">
          <X :size="14" :stroke-width="1.75" />
        </button>
      </div>
      <div class="pad-ctx-popover-bar">
        <div class="pad-ctx-popover-bar-fill" :style="{ width: percent + '%' }"></div>
      </div>

      <!-- Token 来源分 (Q2=B 按来源分, 精确) -->
      <div class="pad-ctx-popover-rows">
        <div class="pad-ctx-popover-row">
          <span class="pad-ctx-popover-row-left">
            <span class="pad-ctx-dot dot-input"></span>
            <span>Input (新)</span>
          </span>
          <span class="pad-ctx-popover-row-right">
            <span class="pad-ctx-popover-val">{{ formatTokens(inputTokens) }}</span>
          </span>
        </div>
        <div class="pad-ctx-popover-row">
          <span class="pad-ctx-popover-row-left">
            <span class="pad-ctx-dot dot-cacheread"></span>
            <span>Cache 命中</span>
          </span>
          <span class="pad-ctx-popover-row-right">
            <span class="pad-ctx-popover-val">{{ formatTokens(cacheReadTokens) }}</span>
          </span>
        </div>
        <div class="pad-ctx-popover-row">
          <span class="pad-ctx-popover-row-left">
            <span class="pad-ctx-dot dot-cachewrite"></span>
            <span>Cache 写入</span>
          </span>
          <span class="pad-ctx-popover-row-right">
            <span class="pad-ctx-popover-val">{{ formatTokens(cacheWriteTokens) }}</span>
          </span>
        </div>
        <div class="pad-ctx-popover-row">
          <span class="pad-ctx-popover-row-left">
            <span class="pad-ctx-dot dot-output"></span>
            <span>Output (生成)</span>
          </span>
          <span class="pad-ctx-popover-row-right">
            <span class="pad-ctx-popover-val">{{ formatTokens(outputTokens) }}</span>
          </span>
        </div>
        <!-- 估算 cost (BYOK 用户付 provider) -->
        <div class="pad-ctx-popover-row pad-ctx-popover-row-cost">
          <span class="pad-ctx-popover-row-left">
            <span>本次 session 估算</span>
          </span>
          <span class="pad-ctx-popover-row-right">
            <span class="pad-ctx-popover-val">{{ formatCost(cost) }}</span>
          </span>
        </div>
      </div>

      <!-- BYOK 简化提示 (Q3=B 跳过套餐/周限额) -->
      <div class="pad-ctx-popover-byok">
        BYOK 无套餐限制
      </div>

      <!-- 压缩按钮 (在 popover 内, 不再独立 toolbar 项) -->
      <button
        class="pad-ctx-popover-compress"
        :disabled="isStreaming || isCompacting"
        :title="isStreaming ? 'streaming 中无法压缩' : (isCompacting ? '正在压缩...' : '手动压缩 context')"
        @click="onCompress"
      >
        <Loader2 v-if="isCompacting" :size="14" :stroke-width="1.75" class="pad-ctx-btn-spinner" />
        <Archive v-else :size="14" :stroke-width="1.75" />
        <span>{{ isCompacting ? '压缩中...' : '压缩 context' }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
/* ======== Compact 指示器 (主 toolbar) ======== */
.pad-ctx-indicator {
  position: relative;
  display: inline-flex;
  align-items: center;
}
.pad-ctx-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0 8px;
  height: 32px;
  border-radius: var(--pad-radius-md);
  background: transparent;
  border: 1px solid transparent;
  color: var(--pad-fg-tertiary);
  font-size: var(--pad-fs-sm);
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s;
  font-variant-numeric: tabular-nums;
}
.pad-ctx-btn:hover:not(:disabled) {
  background: var(--pad-bg-hover, rgba(0, 0, 0, 0.05));
  color: var(--pad-fg-secondary);
}
.pad-ctx-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.pad-ctx-text {
  font-size: 12px;
}
.pad-ctx-btn-chev {
  transition: transform 0.2s;
  opacity: 0.5;
}
.pad-ctx-btn-chev.is-flipped {
  transform: rotate(180deg);
}
.pad-ctx-btn-spinner {
  animation: pad-ctx-spin 1s linear infinite;
}
@keyframes pad-ctx-spin {
  to { transform: rotate(360deg); }
}

/* 高 context 警告 */
.pad-ctx-indicator.is-high .pad-ctx-btn {
  color: var(--pad-fg-warning, #d97706);
  background: var(--pad-bg-warning-soft, rgba(217, 119, 6, 0.08));
}
.pad-ctx-indicator.is-high .pad-ctx-btn:hover:not(:disabled) {
  background: var(--pad-bg-warning-medium, rgba(217, 119, 6, 0.15));
}
/* 压缩中 */
.pad-ctx-indicator.is-loading .pad-ctx-btn {
  color: var(--pad-accent-primary, #6366f1);
}

/* ======== Popover (二级展开, 仿 Claude Code 风格) ======== */
.pad-ctx-popover {
  position: absolute;
  bottom: calc(100% + 8px);
  left: 0;
  z-index: 1000;
  min-width: 320px;
  background: var(--pad-bg-elevated, #ffffff);
  border: 1px solid var(--pad-border-medium, rgba(0, 0, 0, 0.12));
  border-radius: var(--pad-radius-lg, 12px);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.16);
  padding: 12px;
  font-size: var(--pad-fs-sm);
  user-select: none;
}
[data-theme="dark"] .pad-ctx-popover,
.dark .pad-ctx-popover {
  background: #1e1e1e;
  border-color: rgba(255, 255, 255, 0.12);
}

/* 头部: 标题 + 百分比 + 关闭按钮 */
.pad-ctx-popover-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.pad-ctx-popover-title {
  font-weight: 600;
  font-size: 13px;
  color: var(--pad-fg-primary);
}
.pad-ctx-popover-pct {
  margin-left: auto;
  font-size: 14px;
  font-weight: 600;
  color: var(--pad-fg-primary);
  font-variant-numeric: tabular-nums;
}
.pad-ctx-popover-close {
  background: transparent;
  border: none;
  color: var(--pad-fg-tertiary);
  cursor: pointer;
  padding: 2px;
  border-radius: 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.pad-ctx-popover-close:hover {
  background: var(--pad-bg-hover);
  color: var(--pad-fg-primary);
}

/* 进度条 */
.pad-ctx-popover-bar {
  height: 4px;
  background: var(--pad-bg-secondary, rgba(0, 0, 0, 0.05));
  border-radius: 2px;
  overflow: hidden;
  margin-bottom: 12px;
}
.pad-ctx-popover-bar-fill {
  height: 100%;
  background: var(--pad-accent-primary, #6366f1);
  transition: width 0.3s, background 0.2s;
}
.is-high .pad-ctx-popover-bar-fill {
  background: var(--pad-fg-warning, #d97706);
}

/* Token 来源行 */
.pad-ctx-popover-rows {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 10px;
}
.pad-ctx-popover-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 2px 0;
  font-size: 12px;
  color: var(--pad-fg-secondary);
}
.pad-ctx-popover-row-left {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.pad-ctx-popover-row-right {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.pad-ctx-popover-val {
  font-variant-numeric: tabular-nums;
  font-weight: 500;
  color: var(--pad-fg-primary);
}
.pad-ctx-popover-row-cost {
  border-top: 1px solid var(--pad-border-subtle, rgba(0, 0, 0, 0.06));
  padding-top: 8px;
  margin-top: 4px;
  font-style: italic;
  color: var(--pad-fg-tertiary);
}

/* Token 来源小色点 (跟进度条颜色对应) */
.pad-ctx-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
.dot-input { background: #6366f1; }       /* accent / 主色 */
.dot-cacheread { background: #10b981; }   /* 绿: 节省钱 */
.dot-cachewrite { background: #f59e0b; }  /* 黄: 写 cache 少 */
.dot-output { background: #94a3b8; }      /* 灰: 输出 */

/* BYOK 简化提示 */
.pad-ctx-popover-byok {
  text-align: center;
  font-size: 11px;
  font-style: italic;
  color: var(--pad-fg-tertiary);
  padding: 8px 0;
  border-top: 1px solid var(--pad-border-subtle, rgba(0, 0, 0, 0.06));
}

/* 压缩按钮 (在 popover 内) */
.pad-ctx-popover-compress {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 100%;
  padding: 8px 12px;
  background: var(--pad-accent-primary, #6366f1);
  color: white;
  border: none;
  border-radius: var(--pad-radius-md, 8px);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s;
}
.pad-ctx-popover-compress:hover:not(:disabled) {
  background: var(--pad-accent-primary-hover, #5558e3);
}
.pad-ctx-popover-compress:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
