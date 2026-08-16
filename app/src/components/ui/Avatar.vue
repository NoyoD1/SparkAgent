<script setup lang="ts">
/**
 * Avatar — square avatar with brand/accent bg.
 * - Pass `text` (1-2 chars) for text-based avatar (user sidebar bottom).
 * - Pass default slot for icon-based avatar (TraeWork bot icon in chat message).
 * 1:1 mirrors chat.html avatar blocks (line 168 user "N", line 223 bot icon).
 */
import { computed, useSlots } from 'vue';

interface Props {
  /** 1-2 chars text avatar; ignored if default slot is provided */
  text?: string;
  size?: number;           // px, default 24
  tone?: 'brand' | 'accent';
}

const props = withDefaults(defineProps<Props>(), {
  text: '',
  size: 24,
  tone: 'brand',
});

const slots = useSlots();
const fontSize = computed(() => Math.round(props.size * 0.42));
const hasSlot = computed(() => !!slots.default);
</script>

<template>
  <div
    class="pad-avatar"
    :class="[`pad-avatar--${tone}`, { 'pad-avatar--icon': hasSlot }]"
    :style="{
      width: `${size}px`,
      height: `${size}px`,
      borderRadius: 'var(--pad-radius-md)',
      fontSize: `${fontSize}px`,
    }"
  >
    <slot>{{ text }}</slot>
  </div>
</template>

<style scoped>
.pad-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  /* v0.3.8.19: 之前用 #fff 硬编码, dark 模式下主按钮变成浅色背景,
   * 白字看不清楚. 改用 --pad-primary-foreground (semantic role, 会反色) */
  color: var(--pad-primary-foreground);
  font-weight: var(--pad-fw-semibold);
  flex-shrink: 0;
  user-select: none;
}
.pad-avatar--icon {
  font-size: 0;             /* suppress text fallback when slot is used */
}
.pad-avatar--brand {
  background: var(--pad-primary);
}
.pad-avatar--accent {
  background: var(--pad-accent);
}
</style>
