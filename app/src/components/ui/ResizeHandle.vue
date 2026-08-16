<script setup lang="ts">
/**
 * ResizeHandle — v0.3.8.1 柔和鼠标跟随光效分隔条
 *
 * 设计:
 * - 1px 透明基础线
 * - hover/drag 时, 一条柔和的 accent 光柱出现, 中心在鼠标 Y 位置
 * - 强度: 鼠标位置 100% → 上下 30% 处衰减到 0 (类似 macOS split view)
 * - 默认颜色很淡 (5% alpha), drag 时变明显 (30% alpha)
 * - drag 行为不变 (跟之前一样 emit resize)
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
const hovering = ref(false);
const startX = ref(0);
const startWidth = ref(0);
const rootRef = ref<HTMLDivElement | null>(null);

function clamp(n: number) {
  return Math.max(props.min, Math.min(props.max, n));
}

function onPointerEnter() {
  hovering.value = true;
}
function onPointerLeave() {
  hovering.value = false;
}

function onPointerMove(e: PointerEvent) {
  // 更新鼠标 Y 位置 → CSS 变量驱动光柱中心
  const root = e.currentTarget as HTMLElement;
  const rect = root.getBoundingClientRect();
  const y = e.clientY - rect.top;
  const yPct = (y / rect.height) * 100;
  root.style.setProperty('--handle-mouse-y', `${yPct}%`);

  if (!dragging.value) return;
  const delta = e.clientX - startX.value;
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

function onPointerDown(e: PointerEvent) {
  e.preventDefault();
  dragging.value = true;
  startX.value = e.clientX;
  startWidth.value = props.width;
  (e.target as HTMLElement).setPointerCapture(e.pointerId);
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
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
    ref="rootRef"
    class="pad-resize"
    :class="{ 'is-dragging': dragging, 'is-hovering': hovering, [`side-${side}`]: true }"
    :style="{ '--handle-mouse-y': '50%' }"
    @pointerenter="onPointerEnter"
    @pointerleave="onPointerLeave"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
  >
    <!-- 中心 1px 基线 (永远显示, 很淡) -->
    <div class="pad-resize__line" />
    <!-- v0.3.8.10: 居中 "||" 拖拽手柄 (hover/drag 时显现, 提供明确视觉锚点) -->
    <div class="pad-resize__handle" />
  </div>
</template>

<style scoped>
.pad-resize {
  position: relative;
  width: 5px;              /* v0.3.8.10: 5px 容器填满 5px column gap, 1px 中心线两侧各 2px */
  background: transparent;
  cursor: col-resize;
  flex-shrink: 0;
  align-self: stretch;
  z-index: 5;
}

/* 中心 1px 永久基线 */
.pad-resize__line {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 50%;
  width: 1px;
  transform: translateX(-50%);
  background: var(--pad-border);
  opacity: 0.4;
  transition: opacity var(--pad-dur-fast) ease, background var(--pad-dur-fast) ease;
}
.pad-resize.is-hovering .pad-resize__line,
.pad-resize.is-dragging .pad-resize__line {
  background: var(--pad-accent);
  opacity: 0.6;
}

/* v0.3.8.10: "||" 拖拽手柄 — 居中两个 1×12px 短竖线,
 * hover 时 fg-tertiary 灰, drag 时 accent 紫.
 * 平时 opacity:0 不显示, 鼠标进入容器才显出 */
.pad-resize__handle {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 3px;
  height: 14px;
  display: flex;
  justify-content: space-between;
  pointer-events: none;
  opacity: 0;
  transition: opacity var(--pad-dur-fast) ease;
}
.pad-resize.is-hovering .pad-resize__handle,
.pad-resize.is-dragging .pad-resize__handle {
  opacity: 1;
}
.pad-resize__handle::before,
.pad-resize__handle::after {
  content: '';
  width: 1px;
  background: var(--pad-fg-tertiary);
  border-radius: 1px;
  transition: background var(--pad-dur-fast) ease;
}
.pad-resize.is-dragging .pad-resize__handle::before,
.pad-resize.is-dragging .pad-resize__handle::after {
  background: var(--pad-accent);
}
</style>
