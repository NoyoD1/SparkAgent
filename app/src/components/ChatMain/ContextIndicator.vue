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

// v0.5.0-D 第12轮: 6 分类 context breakdown (按 token 来源分)
//   跟 Pi SDK 4 分类 (input/cacheRead/cacheWrite/output) 是不同维度, 互补关系.
//   Pi SDK 那个是 "cache 命中维度", 这个是 "内容来源维度" (消息/工具/系统提示词/技能/记忆/其他).
//   6 分类数字从 chat store getContextBreakdown 拿 (FE 端估算).
const breakdown = computed(() => {
  const sid = activeSession.value?.id;
  if (!sid) {
    return { messages: 0, tools: 0, systemPrompts: 0, skills: 0, memory: 0, other: 0 };
  }
  return chatStore.getContextBreakdown(sid);
});
const breakdownPct = computed(() => chatStore.getContextBreakdownPercent(breakdown.value));

// v0.5.0-D 第21轮 (D208): REAL 4 分类 (Pi SDK lastUsage 实测)
//   跟 6 分类 (FE 估算) 是两个维度, 互补:
//   - 6 分类 (估算): 用在哪里 (消息/工具/系统提示词/技能/记忆/其他)
//   - 4 分类 (REAL): 用多少 (input/output/cacheRead/cacheWrite, LLM 端实测)
//   UI 主显示 4 分类 REAL (准确), 6 分类 ESTIMATED 作为辅助 (比例参考)
const realBreakdown = computed(() => {
  const sid = activeSession.value?.id;
  if (!sid) {
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  }
  return chatStore.getContextBreakdownReal(sid);
});
const realPct = computed(() => chatStore.getContextBreakdownRealPercent(realBreakdown.value));

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

      <!-- v0.5.0-D 第21轮 (D208): REAL 4 分类 (Pi SDK lastUsage 实测, 不是 FE 估算)
           数据源: chatStore.getContextBreakdownReal(sid) — 从 lastUsageBySession 读
           4 个分类: input (新 context) / output (response) / cacheRead (命中) / cacheWrite (新写)
           这是 LLM 端实测的 token 数, 跟 LLM 实际 usage 一致, 不估算.
           之前 (D198) 6 分类是 FE 估算, 数字可能跟 LLM 实际差 10-20%, D208 加这个 REAL 4 分类
           让 user 能看到准确的 token 分布. -->
      <div class="pad-ctx-popover-section-title">实测 (Pi SDK)</div>
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
      <!-- 总和 (REAL, LLM 端实测): user 看到的就是这个数, 不估算 -->
      <div class="pad-ctx-popover-total">
        合计 {{ formatTokens(realBreakdown.input + realBreakdown.output + realBreakdown.cacheRead + realBreakdown.cacheWrite) }} tokens
        <span class="pad-ctx-popover-total-context">
          ({{ formatTokens(realBreakdown.input + realBreakdown.cacheRead) }} context)
        </span>
      </div>

      <!-- v0.5.0-D 第12轮: 6 分类 (FE 估算, 按 token 来源分) — 辅助视图
           D198 设计的"用在哪里"分类, 跟 D208 新加的"用多少"是不同维度
           6 分类是 FE 启发式估算 (CJK 1 char ≈ 1 token, 其他 4 chars ≈ 1 token),
           跟 LLM 实际数可能差 10-20%, 仅供比例参考.
           D208 把它降为辅助, 主视图是上面 4 分类 REAL 数据. -->
      <div class="pad-ctx-popover-section-title">估算 (FE)</div>
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
            <span class="pad-ctx-dot dot-other"></span>
            <span>其他</span>
          </span>
          <span class="pad-ctx-popover-row-right">
            <span class="pad-ctx-popover-val">{{ formatTokens(breakdown.other) }}</span>
            <span class="pad-ctx-popover-pct">{{ breakdownPct.other }}%</span>
          </span>
        </div>
      </div>
      <!-- 估算说明 (D208 降为辅助): FE 估算跟 LLM 实际可能有偏差, 仅供比例参考 -->
      <div class="pad-ctx-popover-estimate-note">
        估算值 · 实际 LLM token 数可能差 10-20%
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
/* v0.5.0-D 第12轮: 6 分类 breakdown 颜色 (按 token 量级从深到浅)
 *   消息 (最大) > 工具 > 系统提示词 > 技能 > 记忆 > 其他 (最小) */
.dot-messages { background: var(--pad-fg-900, #0a0a0a); }      /* 最深: 用户/助手消息 */
.dot-tools { background: var(--pad-fg-700, #404040); }        /* 次深: 工具定义 */
.dot-system { background: var(--pad-fg-500, #737373); }        /* 中: 系统提示词 */
.dot-skills { background: var(--pad-fg-400, #a3a3a3); }       /* 中浅: 技能 */
.dot-memory { background: var(--pad-fg-300, #d4d4d4); }       /* 浅: 记忆 */
.dot-other { background: var(--pad-fg-200, #e5e5e5); }        /* 最浅: 其他 */

/* v0.5.0-D 第21轮 (D208): 4 分类 REAL 颜色 (Pi SDK lastUsage 实测, 不估算)
 *   input (新 context) / output (response) / cacheRead (命中) / cacheWrite (新写)
 *   用半饱和色跟 6 分类 (灰阶) 区分, 强调"实测"vs"估算" */
.dot-input { background: #4f46e5; }     /* 蓝紫: input 新 context */
.dot-output { background: #0891b2; }    /* 青: output response */
.dot-cache-read { background: #16a34a; } /* 绿: cache 命中 (节省) */
.dot-cache-write { background: #f59e0b; } /* 橙: cache 新写 */

/* v0.5.0-D 第21轮 (D208): 区块小标题 (实测 / 估算 区分) */
.pad-ctx-popover-section-title {
  font-size: 10px;
  font-weight: var(--pad-fw-medium, 500);
  color: var(--pad-fg-tertiary, #71717a);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin: 12px 0 4px 0;
}
.pad-ctx-popover-section-title:first-of-type {
  margin-top: 0;
}

/* v0.5.0-D 第21轮 (D208): 合计行 (REAL 总和 + context 部分) */
.pad-ctx-popover-total {
  margin-top: 4px;
  font-size: 11px;
  color: var(--pad-fg-secondary, #52525b);
  font-variant-numeric: tabular-nums;
  text-align: right;
  font-weight: var(--pad-fw-medium, 500);
}
.pad-ctx-popover-total-context {
  color: var(--pad-fg-tertiary, #71717a);
  font-weight: var(--pad-fw-regular, 400);
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
