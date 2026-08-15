<script setup lang="ts">
/**
 * ChatMessage — single message bubble.
 * - role="user": right-aligned, bg-hover, asymmetric radius (rounded-tr-sm).
 * - role="assistant": left-aligned, card bg, with thinking block + actions.
 * 1:1 mirrors chat.html's message area.
 */
import { computed, ref } from 'vue';
import { Bot, ChevronDown, ThumbsUp, ThumbsDown, Copy, RefreshCw } from 'lucide-vue-next';
import Avatar from '@/components/ui/Avatar.vue';
import type { ChatMessage, ThinkingBlock } from '@/lib/mock/types';

interface Props {
  message: ChatMessage;
  thinking?: ThinkingBlock;
  /** When true, the thinking block starts collapsed */
  defaultThinkingCollapsed?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  defaultThinkingCollapsed: false,
});

const thinkingCollapsed = ref(props.defaultThinkingCollapsed);

function toggleThinking() {
  thinkingCollapsed.value = !thinkingCollapsed.value;
}

const isUser = computed(() => props.message.role === 'user');
</script>

<template>
  <!-- User message — right aligned, bg-hover -->
  <div v-if="isUser" class="pad-msg pad-msg--user">
    <div class="pad-msg__bubble pad-msg__bubble--user">
      {{ message.content }}
    </div>
  </div>

  <!-- Assistant message — left aligned, card, with thinking + actions -->
  <div v-else class="pad-msg pad-msg--assistant">
    <div class="pad-msg__bubble pad-msg__bubble--assistant">
      <!-- Header -->
      <div class="pad-msg__header">
        <Avatar text="" :size="24" tone="accent">
          <Bot :size="14" :stroke-width="1.75" />
        </Avatar>
        <span class="pad-msg__name">TraeWork</span>
      </div>

      <!-- Thinking block -->
      <div v-if="thinking" class="pad-msg__thinking">
        <button class="pad-msg__thinking-toggle" @click="toggleThinking">
          <span>思考过程</span>
          <ChevronDown
            :size="14"
            :stroke-width="1.75"
            :class="['pad-msg__thinking-chev', { 'is-collapsed': thinkingCollapsed }]"
          />
        </button>
        <div :class="['pad-msg__thinking-body', { 'is-collapsed': thinkingCollapsed }]">
          <div class="pad-msg__thinking-content">
            {{ thinking.content }}
          </div>
        </div>
      </div>

      <!-- Body -->
      <div class="pad-msg__body">{{ message.content }}</div>

      <!-- Actions -->
      <div class="pad-msg__actions">
        <div class="pad-msg__actions-left">
          <button class="pad-msg__action" title="赞">
            <ThumbsUp :size="14" :stroke-width="1.75" />
          </button>
          <button class="pad-msg__action" title="踩">
            <ThumbsDown :size="14" :stroke-width="1.75" />
          </button>
          <button class="pad-msg__action" title="复制">
            <Copy :size="14" :stroke-width="1.75" />
          </button>
          <button class="pad-msg__action" title="重新生成">
            <RefreshCw :size="14" :stroke-width="1.75" />
          </button>
        </div>
        <span class="pad-msg__ai-tag">由 AI 生成</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pad-msg {
  display: flex;
  width: 100%;
}
.pad-msg--user {
  justify-content: flex-end;
}
.pad-msg--assistant {
  justify-content: flex-start;
}

.pad-msg__bubble {
  max-width: 80%;
  padding: var(--pad-sp-3) var(--pad-sp-4);
  border-radius: var(--pad-radius-xl);
  font-size: var(--pad-fs-14);
  line-height: var(--pad-lh-base);
}
.pad-msg__bubble--user {
  max-width: 70%;
  background: var(--pad-bg-hover);
  color: var(--pad-fg-primary);
  border-top-right-radius: var(--pad-radius-sm);
  padding: 10px var(--pad-sp-4);
}
.pad-msg__bubble--assistant {
  max-width: 80%;
  background: var(--pad-card);
  color: var(--pad-fg-primary);
  border-top-left-radius: var(--pad-radius-sm);
  box-shadow: var(--pad-shadow-button);
}

.pad-msg__header {
  display: flex;
  align-items: center;
  gap: var(--pad-sp-2);
  margin-bottom: var(--pad-sp-2);
}
.pad-msg__name {
  font-size: var(--pad-fs-13);
  font-weight: var(--pad-fw-semibold);
  color: var(--pad-fg-primary);
}

.pad-msg__thinking {
  margin-bottom: var(--pad-sp-3);
}
.pad-msg__thinking-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: var(--pad-fs-12);
  color: var(--pad-fg-tertiary);
  background: transparent;
  border: none;
  padding: 0;
  cursor: pointer;
  transition: color var(--pad-dur-fast) ease;
}
.pad-msg__thinking-toggle:hover {
  color: var(--pad-fg-secondary);
}
.pad-msg__thinking-chev {
  transition: transform var(--pad-dur-base) var(--pad-ease-in-out);
}
.pad-msg__thinking-chev.is-collapsed {
  transform: rotate(-90deg);
}
.pad-msg__thinking-body {
  display: grid;
  grid-template-rows: 1fr;
  transition: grid-template-rows var(--pad-dur-base) var(--pad-ease-out-soft);
}
.pad-msg__thinking-body > div {
  overflow: hidden;
}
.pad-msg__thinking-body.is-collapsed {
  grid-template-rows: 0fr;
}
.pad-msg__thinking-content {
  margin-top: var(--pad-sp-2);
  font-size: var(--pad-fs-13);
  color: var(--pad-fg-secondary);
  line-height: var(--pad-lh-relaxed);
  background: var(--pad-bg-active);
  border-radius: var(--pad-radius-lg);
  padding: var(--pad-sp-3);
}

.pad-msg__body {
  font-size: var(--pad-fs-14);
  color: var(--pad-fg-primary);
  line-height: var(--pad-lh-relaxed);
  margin-bottom: var(--pad-sp-3);
  white-space: pre-wrap;
  word-wrap: break-word;
}

.pad-msg__actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.pad-msg__actions-left {
  display: flex;
  align-items: center;
  gap: 2px;
}
.pad-msg__action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: var(--pad-radius-md);
  color: var(--pad-fg-secondary);
  background: transparent;
  border: none;
  cursor: pointer;
  transition: background var(--pad-dur-fast) ease, color var(--pad-dur-fast) ease;
}
.pad-msg__action:hover {
  background: var(--pad-bg-hover);
  color: var(--pad-fg-primary);
}
.pad-msg__ai-tag {
  font-size: var(--pad-fs-11);
  color: var(--pad-fg-tertiary);
}
</style>
