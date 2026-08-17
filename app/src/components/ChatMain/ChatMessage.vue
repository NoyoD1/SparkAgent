<script setup lang="ts">
/**
 * ChatMessage — v0.3.7+ 重写, v0.4.1 step 累加重构
 *
 * 设计目标:
 * - **user 消息**: 右侧气泡 (保留)
 * - **assistant 消息** (v0.4.1):
 *   - **步骤列表** (StepGroup[]): 1 turn = 1 step, thinking + tool_calls 都归 step 内
 *   - markdown final body (message.content, 跨 turn 累积)
 *   - 底部小 actions (复制 / 重新生成)
 *
 * 不再有 "deepseek-v4-flash" 头部卡片, 也不再硬编码 TraeWork
 *
 * v0.4.1 step 累加改造: 把 message 级别的 thinking + toolCalls 改到 step 级别
 * 一次 prompt 可能跑 N turn, 每个 turn 是 1 step, 用户能展开/折叠看过程
 */
import { computed, ref, watch, onUnmounted } from 'vue';
import { ThumbsUp, ThumbsDown, Copy, RefreshCw, Loader2 } from 'lucide-vue-next';
import type { ChatMessage, Step } from '@/lib/mock/types';
import MarkdownContent from './MarkdownContent.vue';
import StepGroup from './StepGroup.vue';
import { useChatStore } from '@/stores/chat';

interface Props {
  message: ChatMessage;
  sessionId?: string;
  /** v0.4.1: 该 message 的 step 列表 (assistant 才有) */
  steps?: Step[];
  /** 保留: 模型名 (暂未用) */
  modelName?: string;
  isStreaming?: boolean;
  /** v0.3.8.15: 错误信息 (sidecar 发 error event 时显示具体内容) */
  errorMessage?: string | null;
  /** v0.4.2+ LLM 重试状态 (sidecar retry_start 期间显示"重试中 1/5...") */
  retry?: { attempt: number; maxAttempts: number; errorMessage: string } | null;
}

const props = withDefaults(defineProps<Props>(), {
  sessionId: '',
  modelName: '',
  isStreaming: false,
  errorMessage: null,
  retry: null,
  steps: () => [],
});

const chatStore = useChatStore();
const isUser = computed(() => props.message.role === 'user');

const hasSteps = computed(() => (props.steps?.length ?? 0) > 0);
// v0.4.1.2 fix: final body 渲染 last step 的 stepText (last turn 的 text)
// 而不是 message.content (跨 turn 累积所有 text, 会显示 turn 1 + turn 2 重复内容)
const lastStep = computed(() => {
  const steps = props.steps || [];
  return steps.length > 0 ? steps[steps.length - 1] : undefined;
});
const finalBody = computed(() => {
  // 优先 lastStep.stepText (per-turn 隔离, 不会跨 turn 重复)
  if (lastStep.value && lastStep.value.stepText.trim().length > 0) {
    return lastStep.value.stepText;
  }
  // fallback: message.content (单 turn 场景 / 兼容旧数据)
  return props.message.content;
});
const hasContent = computed(() => (finalBody.value?.trim().length ?? 0) > 0);

const copied = ref(false);
async function copyMessage() {
  try {
    await navigator.clipboard.writeText(finalBody.value);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1200);
  } catch (e) {
    console.warn('[msg] copy failed', e);
  }
}

/**
 * v0.5.1: phase-based status icon 动画 (替代 v0.3.8.9 的纯 3-dot bounce)
 *
 * 用户反馈: "实际当前任务还在后台继续跑, 但是因为是一段一段回复的, 正文可能有多条,
 *   导致看起来像是卡了, 需要加适当的提示icon动画, 表示当前是在走的.
 *   比如: 思考中… 创造中… 正在下笔… 等等这种效果切换"
 *
 * 实现:
 * - 跟 chat store 拿当前 phase (thinking / text / tool)
 * - phase 不同 → 文字列表不同 (各 2-3 个轮换, 表达 "思考"/"写作"/"执行" 不同状态)
 * - 每 1.8s 切下一个文字, 200ms crossfade (淡出 → 淡入)
 * - 同时显示旋转的 Loader2 icon (1.4s 旋转, 跟 pad-step__spinner 同步)
 * - watch phase 变化时立即重置 text index (新 phase 用自己的第一个文字)
 *
 * 替代 v0.3.8.9 的 `pad-msg__loading` (3 个灰点 bounce + 静态 "生成中…").
 *   旧版视觉上太朴素, 用户看不到"AI 正在思考/写作/调工具"的状态切换, 长 stream 时感觉卡.
 */
const PHASE_LABELS: Record<string, string[]> = {
  thinking: ['思考中…', '整理思路…', '推演中…'],
  text: ['正在下笔…', '创造中…', '书写中…'],
  tool: ['调用工具…', '执行中…'],
  idle: ['生成中…'],
};
const currentPhase = computed(() => chatStore.getPhase(props.sessionId));
const textIndex = ref(0);
let rotateTimer: ReturnType<typeof setInterval> | null = null;
const ROTATE_INTERVAL = 1800;

function startRotate() {
  stopRotate();
  rotateTimer = setInterval(() => {
    const labels = PHASE_LABELS[currentPhase.value] || PHASE_LABELS.idle;
    textIndex.value = (textIndex.value + 1) % labels.length;
  }, ROTATE_INTERVAL);
}
function stopRotate() {
  if (rotateTimer) {
    clearInterval(rotateTimer);
    rotateTimer = null;
  }
}
watch(
  currentPhase,
  () => {
    // phase 变化时, 立即重置 textIndex 到 0 (新 phase 自己的第一个文字)
    textIndex.value = 0;
  },
);
watch(
  () => props.isStreaming,
  (s) => {
    if (s) startRotate();
    else stopRotate();
  },
  { immediate: true },
);
onUnmounted(stopRotate);

const statusText = computed(() => {
  const labels = PHASE_LABELS[currentPhase.value] || PHASE_LABELS.idle;
  return labels[textIndex.value] || labels[0] || '生成中…';
});
</script>

<template>
  <!-- ============== USER MESSAGE: 右侧气泡 ============== -->
  <div v-if="isUser" class="pad-msg pad-msg--user" :data-message-id="message.id">
    <div class="pad-msg__bubble pad-msg__bubble--user">
      <MarkdownContent :content="message.content" />
    </div>
  </div>

  <!-- ============== ASSISTANT MESSAGE: step 累加 + final body ============== -->
  <div v-else class="pad-msg pad-msg--assistant" :data-message-id="message.id">
    <!-- v0.4.2+: 错误 banner (think 阶段出错也显示, 不只是空 message 状态)
       之前 v0.3.8.15 只在 !hasContent && !hasSteps 时显示, 漏掉了 think 阶段有 steps 但 LLM 调失败的场景 -->
    <div v-if="!isStreaming && errorMessage && !retry" class="pad-msg__error">
      <span class="pad-msg__error-icon" aria-hidden="true">⚠</span>
      <span class="pad-msg__error-text">{{ errorMessage }}</span>
    </div>

    <!-- v0.4.1: 步骤列表 (每个 step = 1 turn, thinking + tool_calls 都在 step 内) -->
    <div v-if="hasSteps" class="pad-msg__steps">
      <StepGroup
        v-for="(step, i) in steps"
        :key="step.id"
        :step="step"
        :session-id="sessionId"
        :message-id="message.id"
        :index="i + 1"
        :is-last="i === steps.length - 1"
      />
    </div>

    <!-- v0.5.1: Streaming status — phase-based 旋转 icon + 文字轮换
         替代 v0.3.8.9 的 3-dot bounce (太朴素, 长 stream 时感觉卡) -->
    <div v-if="isStreaming" class="pad-msg__loading">
      <Loader2 :size="13" :stroke-width="2" class="pad-msg__spinner" />
      <Transition name="pad-msg-status" mode="out-in">
        <span :key="statusText" class="pad-msg__loading-text">{{ statusText }}</span>
      </Transition>
    </div>

    <!-- v0.4.2+: 重试提示 (sidecar 在 5 次重试间 emit retry_start, UI 显示"重试中 1/5...")
       加重背景色让 retry 状态更明显, 跟 think 阶段错误区分开 -->
    <div v-if="retry" class="pad-msg__retry">
      <span class="pad-msg__retry-icon" aria-hidden="true">⟳</span>
      <span class="pad-msg__retry-text">
        LLM 调用失败，正在重试
        <strong>{{ retry.attempt }}/{{ retry.maxAttempts }}</strong>
        <span class="pad-msg__retry-hint">({{ retry.errorMessage.slice(0, 80) }}{{ retry.errorMessage.length > 80 ? '…' : '' }})</span>
      </span>
    </div>

    <!-- markdown body (final reply, 渲染 lastStep.stepText) -->
    <div v-else-if="hasContent" class="pad-msg__body">
      <MarkdownContent :content="finalBody" />
    </div>

    <!-- v0.3.8.15: stream 结束但 4 类内容都为空时, 显示具体 error 信息
         v0.4.2.x fix: 跟上面 error banner (line 89) 互斥, 有 errorMessage 时
         只显示 error banner, 不重复 "⚠ {{ errorMessage }}" + "AI 没有返回内容" 两个 -->
    <div
      v-else-if="!isStreaming && !hasContent && !hasSteps && !errorMessage"
      class="pad-msg__empty"
    >
      <span>AI 没有返回内容</span>
    </div>

    <!-- Actions: 仅在非 streaming 且有内容时显示 -->
    <div v-if="!isStreaming && hasContent" class="pad-msg__actions">
      <button class="pad-msg__action" :title="copied ? '已复制' : '复制'" type="button" @click="copyMessage">
        <Copy v-if="!copied" :size="12" :stroke-width="1.75" />
        <span v-else class="pad-msg__copied">已复制</span>
      </button>
      <button class="pad-msg__action" title="赞" type="button">
        <ThumbsUp :size="12" :stroke-width="1.75" />
      </button>
      <button class="pad-msg__action" title="踩" type="button">
        <ThumbsDown :size="12" :stroke-width="1.75" />
      </button>
      <button class="pad-msg__action" title="重新生成" type="button">
        <RefreshCw :size="12" :stroke-width="1.75" />
      </button>
    </div>
  </div>
</template>

<style scoped>
/* ===== 通用 ===== */
.pad-msg { display: flex; width: 100%; }
.pad-msg--user { justify-content: flex-end; }
.pad-msg--assistant {
  justify-content: flex-start;
  flex-direction: column;
  align-items: stretch;
  gap: 6px;
  max-width: 100%;
}

/* ===== user bubble (右) ===== */
.pad-msg__bubble { display: block; }
.pad-msg__bubble--user {
  max-width: 75%;
  padding: 8px 12px;
  background: var(--pad-bg-hover);
  color: var(--pad-fg-primary);
  border-radius: 12px;
  border-top-right-radius: 4px;
}

/* ===== assistant 流 (左, 连续, 无背景) ===== */
.pad-msg__body {
  font-size: var(--pad-fs-14);
  line-height: var(--pad-lh-relaxed);
  color: var(--pad-fg-primary);
  word-wrap: break-word;
}

/* ===== thinking 块 (v0.3.8.16: max-height 折叠, 之前 grid-template-rows 0fr 在某些浏览器漏边) ===== */
.pad-msg__thinking { margin: 0; }
.pad-msg__thinking-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  /* v0.3.8.12: 字号 12 → 11, 颜色 fg-tertiary (更灰), 明确跟正文 (14px / fg-primary) 区分 */
  font-size: var(--pad-fs-11);
  font-weight: var(--pad-fw-medium);
  color: var(--pad-fg-tertiary);
  background: transparent;
  border: none;
  padding: 0;
  cursor: pointer;
  transition: color var(--pad-dur-fast) ease;
  letter-spacing: 0.02em;
}
.pad-msg__thinking-toggle:hover { color: var(--pad-fg-secondary); }
.pad-msg__thinking-chev {
  transition: transform var(--pad-dur-base) var(--pad-ease-in-out);
}
.pad-msg__thinking-chev.is-collapsed { transform: rotate(-90deg); }
.pad-msg__thinking-body {
  /* v0.3.8.16: 用 max-height 替代 grid-template-rows: 0fr —
   * 0fr 在部分 WebView 渲染下, content 的 padding/background 仍可见, 造成"漏边".
   * max-height: 0 + overflow: hidden 才是最可靠的"内容完全裁掉"方案. */
  max-height: 2000px;
  overflow: hidden;
  opacity: 1;
  transition:
    max-height var(--pad-dur-base) var(--pad-ease-out-soft),
    opacity var(--pad-dur-fast) ease,
    margin-top var(--pad-dur-base) var(--pad-ease-out-soft);
}
.pad-msg__thinking-body.is-collapsed {
  /* v0.3.8.18 fix: 单纯 max-height: 0 在部分 WebView 仍漏 padding/background,
   * 补 height/padding/margin/border 全归零, 保证 0 高度 + 0 占位, 不留任何像素 */
  max-height: 0;
  height: 0;
  padding: 0;
  margin: 0;
  border: 0;
  opacity: 0;
  margin-top: 0;
  overflow: hidden;
}
.pad-msg__thinking-content {
  margin-top: 4px;
  font-size: var(--pad-fs-12);
  font-style: italic;
  color: var(--pad-fg-tertiary);
  line-height: var(--pad-lh-base);
  padding: 6px 10px;
  /* v0.3.8.18: 之前用 var(--pad-bg-100) 直接拿 primitive, dark 模式没覆盖,
   * 结果是 #fafafa 白色方块. 改用 --pad-muted (semantic role), dark 下是 #1a1d24
   * 跟 card 容器同色, 视觉上 thinking 块是 card 里的小色块, 不抢戏. */
  background: var(--pad-muted);
  border-radius: 6px;
  transition: padding var(--pad-dur-base) ease;
}
/* v0.3.8.26 修 thinking 内的 markdown 颜色跟正文一样深:
 * 父级 .pad-msg__thinking-content color: var(--pad-fg-tertiary) 被 MarkdownContent
 * 内部 .pad-md 的 color: var(--pad-fg-primary) 覆盖 → thinking 文字跟 assistant body
 * 一样深, 视觉上"thinking 是元数据"的提示丢失.
 *
 * :deep() 让 scoped 样式穿透到 v-html 渲染的子元素 (无 data-v-xxx 属性). */
.pad-msg__thinking-content :deep(.pad-md),
.pad-msg__thinking-content :deep(.pad-md h1),
.pad-msg__thinking-content :deep(.pad-md h2),
.pad-msg__thinking-content :deep(.pad-md h3),
.pad-msg__thinking-content :deep(.pad-md h4) {
  color: var(--pad-fg-tertiary);
}
.pad-msg__thinking-body.is-collapsed .pad-msg__thinking-content {
  /* v0.3.8.18: 折叠时 content 自身的 padding/margin 也要清零, 避免父级 height: 0
   * 仍受 content 内部 padding 影响, 出现 1-2px 漏边 */
  margin: 0;
  padding: 0;
  border: 0;
}

/* ===== tool calls 块 (v0.3.8.12: 字号颜色更"非正文") ===== */
.pad-msg__tools { margin: 0; }
.pad-msg__tools-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  /* v0.3.8.12: 字号 12 → 11, 跟正文 14px 区分; 字重 medium + letter-spacing 跟 thinking 一致 */
  font-size: var(--pad-fs-11);
  font-weight: var(--pad-fw-medium);
  color: var(--pad-fg-tertiary);
  background: transparent;
  border: none;
  padding: 0;
  cursor: pointer;
  transition: color var(--pad-dur-fast) ease;
  letter-spacing: 0.02em;
}
.pad-msg__tools-toggle:hover { color: var(--pad-fg-secondary); }
.pad-msg__tools-icon { opacity: 0.7; }
.pad-msg__tools-chev {
  transition: transform var(--pad-dur-base) var(--pad-ease-in-out);
}
.pad-msg__tools-chev.is-collapsed { transform: rotate(-90deg); }
.pad-msg__tools-body {
  /* v0.3.8.16: 同样用 max-height + overflow: hidden 替代 grid-template-rows: 0fr */
  max-height: 800px;
  overflow: hidden;
  opacity: 1;
  transition:
    max-height var(--pad-dur-base) var(--pad-ease-out-soft),
    opacity var(--pad-dur-fast) ease;
}
.pad-msg__tools-body.is-collapsed {
  /* v0.3.8.18: 跟 thinking body 一样的兜底, 折叠时彻底归零 */
  max-height: 0;
  height: 0;
  padding: 0;
  margin: 0;
  border: 0;
  opacity: 0;
  overflow: hidden;
}
.pad-msg__tools-list {
  list-style: none;
  padding: 0;
  margin: 6px 0 0;
  border-left: 2px solid var(--pad-border);
  padding-left: 10px;
}
.pad-msg__tools-item {
  padding: 4px 0;
  font-size: var(--pad-fs-12);
  color: var(--pad-fg-secondary);
}
.pad-msg__tools-item + .pad-msg__tools-item {
  border-top: 1px dashed var(--pad-border);
  margin-top: 4px;
  padding-top: 6px;
}
.pad-msg__tools-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.pad-msg__tools-name {
  font-family: var(--pad-font-mono);
  font-weight: var(--pad-fw-medium);
  /* v0.3.8.26: 之前 fg-primary 跟 assistant body 颜色一样, 跟正文混淆. 改 fg-secondary
   * 让 tool name 跟正文 (primary) 视觉区分, 但又比 args/status (tertiary) 略强
   * —— 跟 thinking-content 的 "灰一点" 原则一致. */
  color: var(--pad-fg-secondary);
}
.pad-msg__tools-status {
  font-size: var(--pad-fs-11);
  color: var(--pad-fg-tertiary);
  padding: 1px 6px;
  border-radius: 999px;
  /* v0.3.8.18: bg-100 → muted (semantic role, dark 模式有覆盖) */
  background: var(--pad-muted);
}
.pad-msg__tools-item.is-running .pad-msg__tools-status {
  color: var(--pad-accent);
  background: var(--pad-accent-soft);
}
.pad-msg__tools-item.is-error .pad-msg__tools-status {
  color: var(--pad-danger);
  background: var(--pad-danger-subtle);
}
.pad-msg__tools-args {
  margin-top: 2px;
  color: var(--pad-fg-tertiary);
  font-family: var(--pad-font-mono);
  font-size: var(--pad-fs-11);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pad-msg__tools-result {
  margin: 4px 0 0;
  padding: 6px 8px;
  /* v0.3.8.18: bg-100 → muted (semantic role, dark 模式有覆盖) */
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

/* ===== actions (小图标, 灰) ===== */
.pad-msg__actions {
  display: flex;
  align-items: center;
  gap: 2px;
  /* v0.3.8.1: 跟 composer 拉开距离, 避免 actions 跟 composer 顶部撞在一起 (穿帮) */
  margin-top: 10px;
  opacity: 0;
  transition: opacity var(--pad-dur-fast) ease;
}
.pad-msg:hover .pad-msg__actions,
.pad-msg:focus-within .pad-msg__actions { opacity: 1; }
.pad-msg__action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 22px;
  height: 22px;
  padding: 0 6px;
  border-radius: var(--pad-radius-sm);
  color: var(--pad-fg-tertiary);
  background: transparent;
  border: none;
  cursor: pointer;
  font-size: var(--pad-fs-11);
  font-family: inherit;
  transition: background var(--pad-dur-fast) ease, color var(--pad-dur-fast) ease;
}
.pad-msg__action:hover {
  background: var(--pad-bg-hover);
  color: var(--pad-fg-primary);
}
.pad-msg__copied { color: var(--pad-accent); }

/* ===== streaming loading (v0.5.1 phase-based status icon) ===== */
.pad-msg__loading {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--pad-fg-tertiary);
  font-size: var(--pad-fs-13);
  padding: 4px 0;
  /* 跟 StepGroup 里的 is-active 状态视觉一致: 用 accent 色提亮 spinner,
     让 user 一眼看到"AI 在工作" */
}
/* v0.5.1: 旋转 spinner — 替代 v0.3.8.9 的 3-dot bounce (1.2s → 1.4s 更稳) */
.pad-msg__spinner {
  color: var(--pad-accent);
  flex-shrink: 0;
  animation: pad-msg-spin 1.4s linear infinite;
}
@keyframes pad-msg-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
/* v0.5.1: status 文字 crossfade — 200ms 淡出 → 200ms 淡入, 文字轮换视觉过渡 */
.pad-msg__loading-text {
  /* inline-block + min-width 让 crossfade 时文字宽度变化不会让布局跳 */
  display: inline-block;
  font-style: italic;
  color: var(--pad-fg-secondary);
}
.pad-msg-status-enter-active,
.pad-msg-status-leave-active {
  transition:
    opacity 200ms ease,
    transform 200ms ease;
}
.pad-msg-status-enter-from {
  opacity: 0;
  transform: translateY(3px);
}
.pad-msg-status-leave-to {
  opacity: 0;
  transform: translateY(-3px);
}

/* v0.4.2+ LLM 重试提示 (跟 loading 一起出现, 在 loading 下面一行) */
.pad-msg__retry {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  margin-top: 6px;
  font-size: var(--pad-fs-12);
  color: var(--pad-warning-text);
  background: var(--pad-warning-subtle);
  border: 1px solid var(--pad-warning-border);
  border-radius: var(--pad-radius-md);
}
.pad-msg__retry-icon {
  display: inline-block;
  font-size: 14px;
  animation: pad-msg-retry-spin 1.2s linear infinite;
  /* 跟 loading dots 共用 bounce keyframe 也行, 但 spin 更直观 */
}
@keyframes pad-msg-retry-spin {
  to { transform: rotate(360deg); }
}
.pad-msg__retry-text strong {
  font-weight: var(--pad-fw-semibold);
  margin: 0 2px;
}
.pad-msg__retry-hint {
  color: var(--pad-fg-tertiary);
  margin-left: 4px;
  font-size: var(--pad-fs-11);
}

/* v0.4.2+ 错误 banner (think 阶段 LLM 调失败也显示, 之前只显示在空 message 状态) */
.pad-msg__error {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 8px 10px;
  margin: 6px 0;
  font-size: var(--pad-fs-12);
  color: var(--pad-danger-text);
  background: var(--pad-danger-subtle);
  border: 1px solid var(--pad-danger-border);
  border-radius: var(--pad-radius-md);
  line-height: 1.5;
  word-break: break-word;
}
.pad-msg__error-icon {
  flex-shrink: 0;
  font-size: 14px;
  line-height: 1.5;
}
.pad-msg__error-text {
  flex: 1;
}

/* v0.3.8.9: stream 结束但 4 类内容都空时的占位提示 */
.pad-msg__empty {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 0;
  font-size: var(--pad-fs-12);
  font-style: italic;
  color: var(--pad-fg-tertiary);
}
</style>
