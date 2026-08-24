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
// v3.30: configStore / activeSessionId 不再被 popover 引用 (v3.29 用了, v3.30 删了 model
//   名的 derived 之后也没 caller). import 也保留 (后续如果要在 popover 读 model 走 import).
//   实际其他 store 调用: sessionStore.isStreaming / sessionStore.activeSession / sessionStore
//   还用, 留着. configStore.unused — 删 import + const.

const showPopover = ref(false);
const popoverRef = ref<HTMLElement | null>(null);

// ======== computed (从 chat store 拉数据) ========

const contextTokens = computed(() => {
  const sid = activeSession.value?.id;
  if (!sid) return 0;
  return chatStore.getContextTokens(sid);
});
// v3.29: per-session context window. 拿当前 session 的 model, 跟切 model 同步.
const contextWindow = computed(() => {
  const sid = activeSession.value?.id;
  if (!sid) return chatStore.getContextWindow();
  return chatStore.getContextWindow(sid);
});
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

// v0.5.0-D 第21轮 (D208) + 第22轮 (D209) + v0.6 (N3): REAL 4 分类 (Pi SDK lastUsage 实测, per-turn 覆盖)
//   D209 改累加, v0.6 N4 改回 per-turn 覆盖 (跟 Claude Code 主流算法一致)
const realBreakdown = computed(() => {
  const sid = activeSession.value?.id;
  if (!sid) {
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  }
  return chatStore.getContextBreakdownReal(sid);
});
const realPct = computed(() => chatStore.getContextBreakdownRealPercent(realBreakdown.value));

// v0.6 (N3): 6 分类 FE 估算 (跟图 1/图 2 用户期望的细分项一致: 消息/工具/系统提示词/记忆/技能/其他)
//   跟 4 分类 REAL 是两个维度, 互补:
//   - 4 分类: "用了多少" (input/output/cacheRead/cacheWrite, LLM 端实测)
//   - 6 分类: "用在哪里" (消息/工具/系统提示词/技能/记忆/其他, FE 估算)
//   6 分类数据源: chatStore.getContextBreakdown (chat.ts:799), 函数完整, 之前只是没渲染
//   dot-* 颜色 CSS (D209 注释说删了) 实际还在, 直接复用
const breakdown = computed(() => {
  const sid = activeSession.value?.id;
  if (!sid) {
    return { messages: 0, tools: 0, systemPrompts: 0, skills: 0, memory: 0, other: 0 };
  }
  return chatStore.getContextBreakdown(sid);
});
const breakdownPct = computed(() => chatStore.getContextBreakdownPercent(breakdown.value));

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
      <!-- v3.30: head 段只放标题 + 压缩按钮 (没 model, 没 percent, 不挤).
           单独区域 "上下文总量" 显示 6.4K / 200K 大数字 + percent, 拉长 panel 容纳.
           进度条移到单独区域下面, 满宽. model 名不在 popover 显示 (它已经显示在
           Composer 底部 model chip, 详情面板不重复).
           percent 只在单独区域显示 1 处 (bar 宽度用 percent, 不重复文本). -->
      <div class="pad-ctx-popover-head">
        <span class="pad-ctx-popover-title">上下文窗口</span>
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
      </div>

      <!-- v3.30 新加: 上下文总量单独区域 (不挤在 title 区)
           user 反馈: '将面板拉长给单独显示上下文总量数值一个区域, 不要都挤在 title 那边'
           大数字 X / Y + percent 一行显示, 下面进度条满宽, 视觉显眼 -->
      <div class="pad-ctx-popover-totals">
        <div class="pad-ctx-popover-totals-row">
          <span class="pad-ctx-popover-totals-tokens">{{ formatTokens(contextTokens) }}</span>
          <span class="pad-ctx-popover-totals-divider">/</span>
          <span class="pad-ctx-popover-totals-window">{{ formatTokens(contextWindow) }}</span>
          <span class="pad-ctx-popover-totals-pct">{{ percent }}%</span>
        </div>
        <div class="pad-ctx-popover-bar">
          <div class="pad-ctx-popover-bar-fill" :style="{ width: percent + '%' }"></div>
        </div>
      </div>

      <!-- v0.5.0-D 第22轮 (D209) 重构: 单一区块, Pi SDK REAL 4 分类 (累加)
           之前 (D208) 拆成 "实测 (Pi SDK)" + "估算 (FE)" 两个区块. user 反馈:
           "我要的不是你单独新建一个'实测 (Pi SDK)'计量, 而是数值正确显示在FE里面"
           现在: 只保留 4 分类 REAL (input/output/cacheRead/cacheWrite), 累加跨 turn 求和
           (cumulativeUsageBySession, 不是单次 turn 覆盖). 6 分类 FE 估算整段删掉 (不准)
           数据源: chatStore.cumulativeUsageBySession[sid] (D209 累加, message_end 写)
           百分比: 各分类占 4 分类总和的比例
           合计行: 4 分类总和 + context 部分 (input+cacheRead) — 跟 Composer 底部 % 同源 -->
      <div class="pad-ctx-popover-rows">
        <div class="pad-ctx-popover-row">
          <span class="pad-ctx-popover-row-left">
            <span class="pad-ctx-dot dot-input"></span>
            <span>input (新 context)</span>
          </span>
          <span class="pad-ctx-popover-row-right">
            <span class="pad-ctx-popover-val">{{ formatTokens(realBreakdown.input) }}</span>
            <span class="pad-ctx-popover-pct">{{ realPct.input }}%</span>
          </span>
        </div>
        <div class="pad-ctx-popover-row">
          <span class="pad-ctx-popover-row-left">
            <span class="pad-ctx-dot dot-output"></span>
            <span>output (response)</span>
          </span>
          <span class="pad-ctx-popover-row-right">
            <span class="pad-ctx-popover-val">{{ formatTokens(realBreakdown.output) }}</span>
            <span class="pad-ctx-popover-pct">{{ realPct.output }}%</span>
          </span>
        </div>
        <div class="pad-ctx-popover-row">
          <span class="pad-ctx-popover-row-left">
            <span class="pad-ctx-dot dot-cache-read"></span>
            <span>cache read (命中)</span>
          </span>
          <span class="pad-ctx-popover-row-right">
            <span class="pad-ctx-popover-val">{{ formatTokens(realBreakdown.cacheRead) }}</span>
            <span class="pad-ctx-popover-pct">{{ realPct.cacheRead }}%</span>
          </span>
        </div>
        <div class="pad-ctx-popover-row">
          <span class="pad-ctx-popover-row-left">
            <span class="pad-ctx-dot dot-cache-write"></span>
            <span>cache write (新写)</span>
          </span>
          <span class="pad-ctx-popover-row-right">
            <span class="pad-ctx-popover-val">{{ formatTokens(realBreakdown.cacheWrite) }}</span>
            <span class="pad-ctx-popover-pct">{{ realPct.cacheWrite }}%</span>
          </span>
        </div>
      </div>
      <!-- v3.31: 合计行拆分显示, 解释 6.4K (上) vs 6.7K (合计) 的关系
           user 反馈 '我看你写合计是 6.7K, 但为什么上面是 6.4K?' (疑惑)
           - 顶部 6.4K = context 占用 (input + cacheRead + cacheWrite, 跟 Pi SDK ctx window 算法一致)
           - 合计 6.7K = 4 分类总和 (含 output 250, 不是 context 占用, 是 total token 使用)
           拆成 "context 6.4K + output 250 = 6.7K total" 避免 user 数字对比疑惑.
           保留括号内 context 部分供快速 reference. -->
      <div class="pad-ctx-popover-total">
        context {{ formatTokens(realBreakdown.input + realBreakdown.cacheRead + realBreakdown.cacheWrite) }}
        <span v-if="realBreakdown.output > 0" class="pad-ctx-popover-total-output">
          + output {{ formatTokens(realBreakdown.output) }}
        </span>
        =
        <span class="pad-ctx-popover-total-sum">
          {{ formatTokens(realBreakdown.input + realBreakdown.output + realBreakdown.cacheRead + realBreakdown.cacheWrite) }} total
        </span>
      </div>
      <!-- v0.6 (N3): 6 分类 FE 估算 (来源构成) - 跟图 1/图 2 用户期望一致
           在 4 分类 REAL 下面, 用 section 分隔, 标注 "FE 估算" 跟 4 区分开
           跟 4 分类互补: 4 分类是"用了多少 token" (LLM 实测), 6 分类是"用在哪里" (FE 估算) -->
      <div class="pad-ctx-popover-section-divider"></div>
      <div class="pad-ctx-popover-section-title">来源构成（FE 估算）</div>
      <div class="pad-ctx-popover-rows">
        <div class="pad-ctx-popover-row">
          <span class="pad-ctx-popover-row-left">
            <span class="pad-ctx-dot dot-messages"></span>
            <span>消息</span>
          </span>
          <span class="pad-ctx-popover-row-right">
            <span class="pad-ctx-popover-val">{{ formatTokens(breakdown.messages) }}</span>
            <span class="pad-ctx-popover-pct">{{ breakdownPct.messages }}%</span>
          </span>
        </div>
        <div class="pad-ctx-popover-row">
          <span class="pad-ctx-popover-row-left">
            <span class="pad-ctx-dot dot-tools"></span>
            <span>工具</span>
          </span>
          <span class="pad-ctx-popover-row-right">
            <span class="pad-ctx-popover-val">{{ formatTokens(breakdown.tools) }}</span>
            <span class="pad-ctx-popover-pct">{{ breakdownPct.tools }}%</span>
          </span>
        </div>
        <div class="pad-ctx-popover-row">
          <span class="pad-ctx-popover-row-left">
            <span class="pad-ctx-dot dot-system"></span>
            <span>系统提示词</span>
          </span>
          <span class="pad-ctx-popover-row-right">
            <span class="pad-ctx-popover-val">{{ formatTokens(breakdown.systemPrompts) }}</span>
            <span class="pad-ctx-popover-pct">{{ breakdownPct.systemPrompts }}%</span>
          </span>
        </div>
        <div class="pad-ctx-popover-row">
          <span class="pad-ctx-popover-row-left">
            <span class="pad-ctx-dot dot-memory"></span>
            <span>记忆</span>
          </span>
          <span class="pad-ctx-popover-row-right">
            <span class="pad-ctx-popover-val">{{ formatTokens(breakdown.memory) }}</span>
            <span class="pad-ctx-popover-pct">{{ breakdownPct.memory }}%</span>
          </span>
        </div>
        <div class="pad-ctx-popover-row">
          <span class="pad-ctx-popover-row-left">
            <span class="pad-ctx-dot dot-skills"></span>
            <span>技能</span>
          </span>
          <span class="pad-ctx-popover-row-right">
            <span class="pad-ctx-popover-val">{{ formatTokens(breakdown.skills) }}</span>
            <span class="pad-ctx-popover-pct">{{ breakdownPct.skills }}%</span>
          </span>
        </div>
        <div class="pad-ctx-popover-row">
          <span class="pad-ctx-popover-row-left">
            <span class="pad-ctx-dot dot-other"></span>
            <span>其他</span>
          </span>
          <span class="pad-ctx-popover-row-right">
            <span class="pad-ctx-popover-val">{{ formatTokens(breakdown.other) }}</span>
            <span class="pad-ctx-popover-pct">{{ breakdownPct.other }}%</span>
          </span>
        </div>
      </div>
      <!-- 累加说明: v0.6 (N4) 改 per-turn 覆盖, 跨 turn 数字自然增长 (history 越来越长, totalTokens 也越来越大)
           跟 Claude Code 主流算法一致, 跟 Pi SDK 0.84.2 trigger 逻辑一致 -->
      <div class="pad-ctx-popover-estimate-note">
        本次 turn 实测 · 主动压缩后清零重计
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

/* v0.6 (N6): popover 顶部高亮 summary 行 (用了多少 / 容量 / 占比 / model 名) */
.pad-ctx-popover-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  margin-bottom: 8px;
  background: var(--pad-bg-secondary, rgba(0, 0, 0, 0.03));
  border-radius: var(--pad-radius-md, 8px);
  border: 1px solid transparent;
  transition: border-color var(--pad-dur-fast, 0.15s) ease;
}
.pad-ctx-popover-summary.is-high {
  border-color: var(--pad-fg-warning, #d97706);
  background: var(--pad-bg-warning-soft, rgba(217, 119, 6, 0.08));
}
.pad-ctx-popover-summary-main {
  display: flex;
  align-items: baseline;
  gap: 0;
}
.pad-ctx-popover-summary-tokens {
  font-size: 16px;
  font-weight: 600;
  color: var(--pad-fg-primary);
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.01em;
}
.pad-ctx-popover-summary-divider {
  font-size: 14px;
  color: var(--pad-fg-tertiary, #71717a);
  font-weight: 400;
  margin: 0 5px;
}
.pad-ctx-popover-summary-window {
  font-size: 13px;
  color: var(--pad-fg-secondary, #52525b);
  font-variant-numeric: tabular-nums;
  font-weight: 500;
}
.pad-ctx-popover-summary-meta {
  display: flex;
  align-items: baseline;
  gap: 4px;
  font-size: 11px;
  color: var(--pad-fg-tertiary, #71717a);
}
.pad-ctx-popover-summary-percent {
  font-weight: 600;
  color: var(--pad-fg-primary);
  font-variant-numeric: tabular-nums;
}
.pad-ctx-popover-summary.is-high .pad-ctx-popover-summary-percent {
  color: var(--pad-fg-warning, #d97706);
}
.pad-ctx-popover-summary-dot {
  opacity: 0.5;
}
.pad-ctx-popover-summary-model {
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
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

/* v3.30: 上下文总量单独区域 (不挤在 title 区)
   user 反馈 '将面板拉长给单独显示上下文总量数值一个区域, 不要都挤在 title 那边'.
   panel 拉长容纳大数字 + percent + 满宽进度条. */
.pad-ctx-popover-totals {
  margin-bottom: 12px;
  padding: 8px 10px;
  background: var(--pad-bg-secondary, rgba(0, 0, 0, 0.025));
  border-radius: var(--pad-radius-sm, 4px);
  transition: background var(--pad-dur-fast, 0.15s) ease;
}
.is-high .pad-ctx-popover-totals {
  background: var(--pad-bg-warning-soft, rgba(217, 119, 6, 0.08));
}
.pad-ctx-popover-totals-row {
  display: flex;
  align-items: baseline;
  gap: 4px;
  margin-bottom: 6px;
}
.pad-ctx-popover-totals-tokens {
  font-size: 18px;
  font-weight: 600;
  color: var(--pad-fg-primary);
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.01em;
}
.pad-ctx-popover-totals-divider {
  font-size: 14px;
  color: var(--pad-fg-tertiary, #71717a);
  font-weight: 400;
  margin: 0 2px;
}
.pad-ctx-popover-totals-window {
  font-size: 14px;
  color: var(--pad-fg-secondary, #52525b);
  font-variant-numeric: tabular-nums;
  font-weight: 500;
}
.pad-ctx-popover-totals-pct {
  margin-left: auto;
  font-size: 14px;
  font-weight: 600;
  color: var(--pad-fg-primary);
  font-variant-numeric: tabular-nums;
}
.is-high .pad-ctx-popover-totals-pct {
  color: var(--pad-fg-warning, #d97706);
}
.pad-ctx-popover-totals .pad-ctx-popover-bar {
  margin-bottom: 0;  /* 区域里 bar 不再加底部 margin (区域本身已有) */
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
/* v0.5.0-D 第12轮: 6 分类 breakdown 颜色 (按 token 量级从深到浅)
 *   消息 (最大) > 工具 > 系统提示词 > 技能 > 记忆 > 其他 (最小)
 *   v0.5.0-D 第22轮 (D209) REVERT: 6 分类全删, dot-messages/tools/system/skills/memory/other 全删 */
.dot-messages { background: var(--pad-fg-900, #0a0a0a); }
.dot-tools { background: var(--pad-fg-700, #404040); }
.dot-system { background: var(--pad-fg-500, #737373); }
.dot-skills { background: var(--pad-fg-400, #a3a3a3); }
.dot-memory { background: var(--pad-fg-300, #d4d4d4); }
.dot-other { background: var(--pad-fg-200, #e5e5e5); }

/* v0.5.0-D 第21轮 (D208) + 第22轮 (D209): 4 分类 REAL 颜色 (Pi SDK lastUsage 实测, 累加)
 *   input (新 context) / output (response) / cacheRead (命中) / cacheWrite (新写) */
.dot-input { background: #4f46e5; }     /* 蓝紫: input 新 context */
.dot-output { background: #0891b2; }    /* 青: output response */
.dot-cache-read { background: #16a34a; } /* 绿: cache 命中 (节省) */
.dot-cache-write { background: #f59e0b; } /* 橙: cache 新写 */

/* v0.5.0-D 第22轮 (D209): 合计行 (REAL 4 分类总和 + context 部分)
 *   跟 Composer 底部 "上下文 X%" 用同一个 contextTokens 数值, 跟 percent 一致
 *   v3.31: 拆成 'context X + output Y = Z total' (解释顶部 6.4K vs 合计 6.7K 疑惑) */
.pad-ctx-popover-total {
  margin-top: 4px;
  padding-top: 8px;
  border-top: 1px solid var(--pad-border-subtle, rgba(0, 0, 0, 0.06));
  font-size: 11px;
  color: var(--pad-fg-secondary, #52525b);
  font-variant-numeric: tabular-nums;
  text-align: right;
  font-weight: var(--pad-fw-medium, 500);
}
.pad-ctx-popover-total-output {
  color: var(--pad-fg-tertiary, #71717a);
  font-weight: var(--pad-fw-regular, 400);
  margin: 0 4px;
}
.pad-ctx-popover-total-sum {
  color: var(--pad-fg-primary);
  font-weight: var(--pad-fw-semibold, 600);
  margin-left: 4px;
}

/* v0.5.0-D 第12轮: 6 分类 breakdown 百分比样式 (row 右边) */
.pad-ctx-popover-pct {
  font-size: 11px;
  color: var(--pad-fg-tertiary);
  font-variant-numeric: tabular-nums;
  min-width: 36px;
  text-align: right;
}

/* v0.6 (N3): 6 分类 section 分隔 + 标题 */
.pad-ctx-popover-section-divider {
  height: 1px;
  background: var(--pad-border-subtle, rgba(0, 0, 0, 0.06));
  margin: 10px 0 8px;
}
.pad-ctx-popover-section-title {
  font-size: 10px;
  font-weight: 600;
  color: var(--pad-fg-tertiary, #71717a);
  margin-bottom: 6px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

/* 估算说明 (popover 底部) */
.pad-ctx-popover-estimate-note {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--pad-border-subtle, rgba(0, 0, 0, 0.06));
  font-size: 10px;
  font-style: italic;
  color: var(--pad-fg-tertiary);
  text-align: center;
  opacity: 0.8;
}

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
