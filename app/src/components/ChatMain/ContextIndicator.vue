<script setup lang="ts">
/**
 * v0.4.3 redesign: ContextIndicator — 紧凑 context 计数 + popover 二级展开
 *
 * 设计来源: Claude Code web (claude.ai/code) 上下文窗口展开模式
 *   - 主 toolbar: 紧凑 `上下文 83%` + 细色条 (位置: 切换 model chip 左侧, 跟 model 一体)
 *   - 点击 → popover 二级展开
 *     - 上下文窗口 83% + 进度条
 *     - Token 来源分 (Q2=B 按来源分, 精确): Input (新) / Cache 命中 / Cache 写入 / Output
 *     - [🗄️ 压缩 context] 按钮
 *     - [X] 关闭
 *   - 70% 阈值高亮, 压缩中 spinner
 *
 * v0.4.3.1 (user 反馈 2026-08-18):
 *   - 删 cost 行 + BYOK 提示 (user 反馈"功能逻辑一体的, 装饰不要")
 *   - popover 改 minimalist: --pad-card + --pad-border + --pad-radius-md + 极轻 shadow
 *   - 跟右栏"会话文件"功能区形成"上下分工": 压缩入口在 Composer 底部, 文件管理在右栏
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
import { BarChart3, ChevronDown, Archive, Loader2 } from 'lucide-vue-next';
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

// ======== 工具 ========

function formatTokens(n: number): string {
  if (n === 0) return '0';
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return `${n}`;
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
        <!-- v0.4.3.2.5 (user 原话 2026-08-18 02:30): 压缩按钮紧跟 "上下文窗口" 标题 x 轴后面
         *   我之前 4 轮都理解成"放在 0% 后面", 完全错. user 凌晨 2:30 强烈不满.
         *   现在改成: 标题文字 [4px gap] 压缩 text link [auto gap] 0%
         *   - 压缩字号 12px, icon 10px (跟 4 行 token 一致, 视觉重量平齐)
         *   - 0% 还是 margin-left: auto 推到 popover 内容最右, 跟 4 行 token 数字严格右对齐
         *   - 弹窗靠 click outside 关 (D183 弹窗默认行为) -->
        <button
          v-if="!isCompacting"
          class="pad-ctx-popover-compress-link"
          :disabled="isStreaming || isCompacting"
          :title="isStreaming ? 'streaming 中无法压缩' : '手动压缩 context'"
          @click="onCompress"
        >
          <Archive :size="10" :stroke-width="1.75" />
          <span>压缩</span>
        </button>
        <Loader2 v-else :size="10" :stroke-width="1.75" class="pad-ctx-btn-spinner" />
        <span class="pad-ctx-popover-pct">{{ percent }}%</span>
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
      </div>
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

/* ======== Popover (二级展开, minimalist 风格, 跟整体 token 配) ======== */
.pad-ctx-popover {
  position: absolute;
  bottom: calc(100% + 8px);
  left: 0;
  z-index: 1000;
  min-width: 280px;
  /* v0.4.3.1.1: 跟右栏 drawer section 卡片视觉一致
   *   -- 1px border 代替 box-shadow (user 反馈"设计 token 和整体不符合")
   *   -- border-radius 跟 section 一致 (--pad-radius-lg = 12px, 不再用 --pad-radius-md = 10px)
   *   -- 跟 body 同色 (--pad-card), 视觉上是"浮起的另一张卡" */
  background: var(--pad-card);
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-lg);
  /* v0.4.3.1.1: user 反馈还是有阴影, 干脆去掉 box-shadow 走纯 border,
   *   跟整个 minimalist 风格一致 (Claude Code / Linear / Notion 都用 border 不用 shadow) */
  box-shadow: none;
  padding: var(--pad-sp-3);
  font-size: var(--pad-fs-12);
  user-select: none;
}

/* 头部: 标题 + 压缩 text link (紧跟标题) + 0% (最右, 跟 4 行 token 数字右对齐)
 *   v0.4.3.2.5 (user 原话 2026-08-18 02:30 "压缩两个放在上下文窗口x轴后面紧跟"):
 *   - "压缩" 紧跟 "上下文窗口" 标题 (margin-left: 4px, 跟 0% 无关)
 *   - "0%" 还是 margin-left: auto 推到 popover 内最右, 跟 4 行 token 数字严格右对齐
 *   - 标题行 layout: [上下文窗口] [4px] 压缩 [auto] 0%
 *   教训: 我之前 v0.4.3.2 / 2.2 / 2.3 / 2.4 连续 4 轮把"压缩" 放在 0% 后面, 完全理解
 *   反 user 草图原意. user 凌晨 2:30 强烈不满 ("一到凌晨就开始降智, 怕是要举报你").
 *   这次按 user 原话字面理解, 不再凭草图推测. */
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
  /* 0% 推到最右, 跟 4 行 token 数字严格右对齐
   * (同 popover padding-right 内右边界, 跟 4 行 token row 的 right column 重合) */
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
  /* v0.4.3.2.3: 下方独立按钮删了, 4 行下面是弹窗底部 padding, 不再额外留 gap */
  margin-bottom: 0;
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
/* v0.4.3.2: 圆点统一灰阶 (user 反馈"用灰黑不同比例"替代多色)
 *   越深 = 信息量越大 (新输入 > 缓存命中 > 缓存写入 > 输出)
 *   跟 minimalist 整体一致, 信息在数字不在颜色 */
.dot-input { background: var(--pad-fg-900, #0a0a0a); }      /* 最深: 新输入的 token */
.dot-cacheread { background: var(--pad-fg-600, #525252); }  /* 中深: 缓存命中 */
.dot-cachewrite { background: var(--pad-fg-400, #858585); } /* 中浅: 缓存写入 */
.dot-output { background: var(--pad-fg-300, #a1a1a1); }     /* 浅: 生成输出 */

/* BYOK 简化提示 */
.pad-ctx-popover-byok {
  text-align: center;
  font-size: 11px;
  font-style: italic;
  color: var(--pad-fg-tertiary);
  padding: 8px 0;
  border-top: 1px solid var(--pad-border-subtle, rgba(0, 0, 0, 0.06));
}

/* 压缩按钮 (紧跟 "上下文窗口" 标题后面, text link 极简风格) — v0.4.3.2.5
 *   之前 4 轮 v0.4.3.2 / 2.2 / 2.3 / 2.4 都把"压缩"放在 0% 后面, 完全错.
 *   user 原话: "压缩两个放在上下文窗口x轴后面紧跟" — 紧跟标题, 不是 0% 后面.
 *   v0.4.3.2.5 (user 原话 2026-08-18 02:30):
 *   - 紧跟 "上下文窗口" 标题 (margin-left: 4px, 跟标题文字隔 4px)
 *   - 字号 12px (跟 4 行 token 一致, 比 0% 字号 14px 小)
 *   - icon 10px (跟 12px 文字协调)
 *   - color tertiary, hover primary + underline (跟 0% 视觉重量平齐) */
.pad-ctx-popover-compress-link {
  margin-left: 4px;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  background: transparent;
  border: none;
  color: var(--pad-fg-tertiary);
  font-size: 12px;
  font-weight: var(--pad-fw-regular);
  cursor: pointer;
  padding: 2px 4px;
  text-decoration: none;
  transition: color var(--pad-dur-fast) ease;
}
.pad-ctx-popover-compress-link:hover:not(:disabled) {
  color: var(--pad-fg-primary);
  text-decoration: underline;
  text-underline-offset: 2px;
}
.pad-ctx-popover-compress:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
