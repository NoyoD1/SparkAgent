<script setup lang="ts">
/**
 * IconButton — square 28px icon-only button.
 * 1:1 mirrors chat.html `.icon-btn` class.
 * Variants: 'default' (gray on hover) | 'danger' (red on hover)
 */
import { computed } from 'vue';

interface Props {
  /** Lucide icon component, e.g. Search, Plus */
  icon?: any;
  size?: 'sm' | 'md';          // sm = 20px, md = 28px
  variant?: 'default' | 'danger';
  title?: string;
  disabled?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  size: 'md',
  variant: 'default',
  disabled: false,
});

const sizeStyle = computed(() =>
  props.size === 'sm' ? '20px' : '28px'
);
const iconSize = computed(() =>
  props.size === 'sm' ? 14 : 16
);
</script>

<template>
  <button
    class="pad-icon-btn"
    :class="[`pad-icon-btn--${variant}`]"
    :style="{ width: sizeStyle, height: sizeStyle }"
    :title="title"
    :disabled="disabled"
  >
    <component
      :is="icon"
      v-if="icon"
      :size="iconSize"
      :stroke-width="1.75"
    />
  </button>
</template>

<style scoped>
.pad-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--pad-radius-md);
  color: var(--pad-fg-secondary);
  background: transparent;
  border: none;
  cursor: pointer;
  transition:
    background var(--pad-dur-fast) ease,
    color var(--pad-dur-fast) ease;
  flex-shrink: 0;
}
.pad-icon-btn:hover:not(:disabled) {
  background: var(--pad-bg-hover);
  color: var(--pad-fg-primary);
}
.pad-icon-btn--danger:hover:not(:disabled) {
  color: var(--pad-danger);
  background: var(--pad-bg-hover);
}
.pad-icon-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
