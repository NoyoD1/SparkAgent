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
import { computed, ref } from 'vue';
import { ThumbsUp, ThumbsDown, Copy, RefreshCw } from 'lucide-vue-next';
import type { ChatMessage, Step } from '@/lib/mock/types';
import MarkdownContent from './MarkdownContent.vue';
import StepGroup from './StepGroup.vue';

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
}

const props = withDefaults(defineProps<Props>(), {
  sessionId: '',
  modelName: '',
  isStreaming: false,
  errorMessage: null,
  steps: () => [],
});

const isUser = computed(() => props.message.role === 'user');

const hasSteps = computed(() => (props.steps?.length ?? 0) > 0);
const hasContent = computed(() => (props.message.content?.trim().length ?? 0) > 0);

const copied = ref(false);
async function copyMessage() {
  try {
    await navigator.clipboard.writeText(props.message.content);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1200);
  } catch (e) {
    console.warn('[msg] copy failed', e);
  }
}
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

    <!-- v0.3.8.9: Streaming loading — 整个 stream 期间一直显示 -->
    <div v-if="isStreaming" class="pad-msg__loading">
      <span class="pad-msg__loading-dot"></span>
      <span class="pad-msg__loading-dot"></span>
      <span class="pad-msg__loading-dot"></span>
      <span class="pad-msg__loading-text">{{ message.content ? '继续生成中…' : '生成中…' }}</span>
    </div>

    <!-- markdown body (final reply, 跨 turn 累积) -->
    <div v-else-if="hasContent" class="pad-msg__body">
      <MarkdownContent :content="message.content" />
    </div>

    <!-- v0.3.8.15: stream 结束但 4 类内容都为空时, 显示具体 error 信息 -->
    <div
      v-else-if="!isStreaming && !hasContent && !hasSteps"
      class="pad-msg__empty"
    >
      <span v-if="errorMessage">⚠ {{ errorMessage }}</span>
      <span v-else>AI 没有返回内容</span>
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

/* ===== streaming loading ===== */
.pad-msg__loading {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--pad-fg-tertiary);
  font-size: var(--pad-fs-13);
  padding: 4px 0;
}
.pad-msg__loading-dot {
  display: inline-block;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--pad-fg-tertiary);
  animation: pad-msg-bounce 1.2s ease-in-out infinite;
}
.pad-msg__loading-dot:nth-child(2) { animation-delay: 0.15s; }
.pad-msg__loading-dot:nth-child(3) { animation-delay: 0.3s; }
.pad-msg__loading-text { margin-left: 4px; }

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

@keyframes pad-msg-bounce {
  0%, 80%, 100% { transform: scale(0.6); opacity: 0.4; }
  40% { transform: scale(1); opacity: 1; }
}
</style>
