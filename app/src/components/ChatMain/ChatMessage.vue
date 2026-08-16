<script setup lang="ts">
/**
 * ChatMessage — v0.3.7+ 重写
 *
 * 设计目标 (Trae 参考 image 4):
 * - **user 消息**: 右侧气泡 (保留)
 * - **assistant 消息**: **没有气泡标题**, 改成连贯 inline 流:
 *   - 可选 thinking 块 (collapsible, 灰字 + chevron, 跟参考 4 一样)
 *   - markdown 内容 (用 MarkdownContent 渲染)
 *   - 底部小 actions (复制 / 重新生成)
 *
 * 不再有 "deepseek-v4-flash" 头部卡片, 也不再硬编码 TraeWork
 */
import { computed, ref } from 'vue';
import { ChevronDown, ThumbsUp, ThumbsDown, Copy, RefreshCw } from 'lucide-vue-next';
import type { ChatMessage, ThinkingBlock } from '@/lib/mock/types';
import MarkdownContent from './MarkdownContent.vue';

interface Props {
  message: ChatMessage;
  thinking?: ThinkingBlock;
  defaultThinkingCollapsed?: boolean;
  /** 保留, 暂未用, 后续 thinking 块可显示"deepseek-v4-flash 思考 1 次" */
  modelName?: string;
  isStreaming?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  defaultThinkingCollapsed: false,
  modelName: '',
  isStreaming: false,
});

const thinkingCollapsed = ref(props.defaultThinkingCollapsed);
function toggleThinking() {
  thinkingCollapsed.value = !thinkingCollapsed.value;
}

const isUser = computed(() => props.message.role === 'user');

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

  <!-- ============== ASSISTANT MESSAGE: 连续流 (无气泡标题) ============== -->
  <div v-else class="pad-msg pad-msg--assistant" :data-message-id="message.id">
    <!-- Thinking 块 (有数据时) -->
    <div v-if="thinking" class="pad-msg__thinking">
      <button class="pad-msg__thinking-toggle" type="button" @click="toggleThinking">
        <span>思考过程</span>
        <ChevronDown
          :size="12"
          :stroke-width="1.75"
          :class="['pad-msg__thinking-chev', { 'is-collapsed': thinkingCollapsed }]"
        />
      </button>
      <div :class="['pad-msg__thinking-body', { 'is-collapsed': thinkingCollapsed }]">
        <div class="pad-msg__thinking-content">
          <MarkdownContent :content="thinking.content" />
        </div>
      </div>
    </div>

    <!-- Streaming loading: 3 个跳动点 + "生成中…" -->
    <div v-if="isStreaming && !message.content" class="pad-msg__loading">
      <span class="pad-msg__loading-dot"></span>
      <span class="pad-msg__loading-dot"></span>
      <span class="pad-msg__loading-dot"></span>
      <span class="pad-msg__loading-text">生成中…</span>
    </div>

    <!-- markdown body -->
    <div v-else-if="message.content" class="pad-msg__body">
      <MarkdownContent :content="message.content" />
    </div>

    <!-- Actions: 仅在非 streaming 且有内容时显示 -->
    <div v-if="!isStreaming && message.content" class="pad-msg__actions">
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

/* ===== thinking 块 ===== */
.pad-msg__thinking { margin: 0; }
.pad-msg__thinking-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: var(--pad-fs-12);
  font-style: italic;
  color: var(--pad-fg-tertiary);
  background: transparent;
  border: none;
  padding: 0;
  cursor: pointer;
  transition: color var(--pad-dur-fast) ease;
}
.pad-msg__thinking-toggle:hover { color: var(--pad-fg-secondary); }
.pad-msg__thinking-chev {
  transition: transform var(--pad-dur-base) var(--pad-ease-in-out);
}
.pad-msg__thinking-chev.is-collapsed { transform: rotate(-90deg); }
.pad-msg__thinking-body {
  display: grid;
  grid-template-rows: 1fr;
  transition: grid-template-rows var(--pad-dur-base) var(--pad-ease-out-soft);
}
.pad-msg__thinking-body > div { overflow: hidden; }
.pad-msg__thinking-body.is-collapsed { grid-template-rows: 0fr; }
.pad-msg__thinking-content {
  margin-top: 4px;
  font-size: var(--pad-fs-12);
  font-style: italic;
  color: var(--pad-fg-secondary);
  line-height: var(--pad-lh-base);
  padding: 6px 10px;
  border-left: 2px solid var(--pad-border);
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

@keyframes pad-msg-bounce {
  0%, 80%, 100% { transform: scale(0.6); opacity: 0.4; }
  40% { transform: scale(1); opacity: 1; }
}
</style>
