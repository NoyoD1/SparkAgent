<script setup lang="ts">
/**
 * ResizeHandle — 1px 透明分隔条, 拖动改宽度
 *
 * 用法:
 *   <ResizeHandle :width="widths.sidebar" @resize="(w) => setSidebarWidth(w)" />
 *
 * 行为:
 * - hover 显示 2px accent-soft 提示
 * - drag 时全局 cursor: col-resize
 * - 释放后回 normal cursor
 * - 拖动时实时更新父组件
 */
import { ref } from 'vue';

const props = withDefaults(defineProps<{
  width: number;
  min?: number;
  max?: number;
  /** horizontal (列宽) | vertical (行高) */
  direction?: 'horizontal' | 'vertical';
  /** 拖动方向: 'left' (向左拉增宽) | 'right' (向右拉增宽) | 'auto' (左侧 panel 增宽) */
  side?: 'left' | 'right' | 'auto';
}>(), {
  min: 52,
  max: 800,
  direction: 'horizontal',
  side: 'auto',
});

const emit = defineEmits<{
  resize: [width: number];
  'update:width': [width: number];
}>();

const dragging = ref(false);
const startX = ref(0);
const startWidth = ref(0);

function clamp(n: number) {
  return Math.max(props.min, Math.min(props.max, n));
}

function onPointerDown(e: PointerEvent) {
  e.preventDefault();
  dragging.value = true;
  startX.value = e.clientX;
  startWidth.value = props.width;
  (e.target as HTMLElement).setPointerCapture(e.pointerId);
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
}

function onPointerMove(e: PointerEvent) {
  if (!dragging.value) return;
  const delta = e.clientX - startX.value;
  // 左侧 panel (side='left'): 向右拖 delta > 0 → 增宽
  // 右侧 panel (side='right'): 向左拖 delta < 0 → 增宽
  let newWidth: number;
  if (props.side === 'right') {
    newWidth = startWidth.value - delta;
  } else {
    newWidth = startWidth.value + delta;
  }
  newWidth = clamp(newWidth);
  emit('resize', newWidth);
  emit('update:width', newWidth);
}

function onPointerUp(e: PointerEvent) {
  if (!dragging.value) return;
  dragging.value = false;
  try { (e.target as HTMLElement).releasePointerCapture(e.pointerId); } catch {}
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
}
</script>

<template>
  <div
    class="pad-resize"
    :class="{ 'is-dragging': dragging, [`side-${side}`]: true }"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
  >
    <div class="pad-resize__hit" />
  </div>
</template>

<style scoped>
.pad-resize {
  position: relative;
  width: 1px;
  background: transparent;
  cursor: col-resize;
  flex-shrink: 0;
  align-self: stretch;
  z-index: 5;
  transition: background var(--pad-dur-fast) ease;
}
.pad-resize:hover,
.pad-resize.is-dragging {
  background: var(--pad-accent-soft);
}
.pad-resize:hover .pad-resize__hit,
.pad-resize.is-dragging .pad-resize__hit {
  background: var(--pad-accent);
}
.pad-resize__hit {
  position: absolute;
  top: 0;
  bottom: 0;
  left: -3px;
  right: -3px;
  background: transparent;
  transition: background var(--pad-dur-fast) ease;
}
</style>
