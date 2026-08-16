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
    <!-- 鼠标跟随光柱: 透明度由 hover/drag 状态决定, 中心位置由 --handle-mouse-y 决定 -->
    <div class="pad-resize__beam" />
  </div>
</template>

<style scoped>
.pad-resize {
  position: relative;
  width: 12px;             /* 容器扩到 12px, 给光柱留 12px 宽的范围 */
  margin: 0 -5.5px;        /* 但视觉上仍是 1px 中心线 (12 - 1 = 11, 两侧各 5.5) */
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

/* 鼠标跟随光柱: 12px 宽, 跟着 --handle-mouse-y 移动 */
.pad-resize__beam {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 50%;
  transform: translateX(-50%);
  width: 12px;
  pointer-events: none;
  /* 上下两端完全透明, 中心 (鼠标位置) 最亮 */
  background: radial-gradient(
    ellipse 12px 80px at 50% var(--handle-mouse-y, 50%),
    var(--pad-accent) 0%,
    transparent 100%
  );
  opacity: 0;
  transition: opacity var(--pad-dur-fast) ease;
  mix-blend-mode: multiply;  /* 暗色背景下也能看清 */
}
.pad-resize.is-hovering .pad-resize__beam {
  opacity: 0.12;  /* 平时很淡 */
}
.pad-resize.is-dragging .pad-resize__beam {
  opacity: 0.25;  /* 拖拽时明显 */
}
</style>
