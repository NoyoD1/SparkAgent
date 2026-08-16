<script setup lang="ts">
/**
 * ChatMessageNav — v0.3.8.2 游标卡尺刻度版
 *
 * 行为:
 * - 左侧垂直线 + 每个 user message 一个 tick
 * - active tick = 当前视野内最靠近顶部的 user message (IntersectionObserver)
 * - hover tick (220ms delay) → 浮出预览卡 (Teleport 到 body, 动态位置)
 * - click tick → 跳到对应 message (onJump 回调)
 *
 * v0.3.8.2 设计变更 (对齐参考图):
 * - 视觉: 游标卡尺刻度 — 上下短, 左右细 (8x2px base)
 * - hover lens: 鼠标 hover 一个 tick 时, 它向右伸长 (24px),
 *   周围 4 个 tick 也按距离衰减地变长:
 *     d=0 (自己) → 24px opacity 1 fg-secondary
 *     d=1        → 20px opacity 0.85 fg-tertiary
 *     d=2        → 16px opacity 0.7
 *     d=3        → 12px opacity 0.55
 *     d>=4       → 8px opacity 0.4 (默认)
 * - active tick: accent 紫色, 同样会带动周围
 * - 不用 fg-primary (#1a1a1a) — 太黑; 最高到 fg-secondary (#5c5c5c)
 *
 * v0.3.8.2 修复 (F12 报错根除):
 * - 之前 `onHoverEnter` 用 `e.currentTarget`, 但 220ms setTimeout 之后
 *   `e.currentTarget` 经常被浏览器 GC 置 null, positionPopover 内部
 *   `target.getBoundingClientRect()` 就抛 "Cannot read properties of null".
 * - 改法: onHoverEnter 不再靠 e.currentTarget, 用 `tickRefs.value[idx]`
 *   直接拿 DOM 引用. tickRefs 在 mounted 阶段就收集, 不受 GC 影响.
 * - 加防御: positionPopover 入口 null check + isConnected + 0 size 跳过.
 *
 * v0.3.8.2 自身滚动 (超长 turns):
 * - nav 容器 max-height + overflow-y: auto
 * - wheel 事件 in nav → 滚 nav, 不穿透到 chat list
 * - active 变化时自动 scroll nav 把 active 滚到可见区
 */
import { ref, onBeforeUnmount, onMounted, watch, nextTick, computed } from 'vue';

export interface ChatTurn {
  id: string;
  userContent: string;
  assistantPreview: string;
  isActive: boolean;
}

interface Props {
  turns: ChatTurn[];
  /** 跳到指定 message id 的回调 */
  onJump?: (messageId: string) => void;
  /** 滚动容器的 ref (用来设 IntersectionObserver root) */
  scrollRoot?: HTMLElement | null;
}
const props = defineProps<Props>();

const hoveredIdx = ref<number | null>(null);
const activeIdx = ref<number | null>(null);
const navEl = ref<HTMLElement | null>(null);
const popoverStyle = ref<Record<string, string>>({});
const tickRefs = ref<HTMLButtonElement[]>([]);

let hoverTimer: ReturnType<typeof setTimeout> | null = null;
let leaveTimer: ReturnType<typeof setTimeout> | null = null;
let io: IntersectionObserver | null = null;

function setTickRef(el: HTMLButtonElement | null, idx: number) {
  if (el) tickRefs.value[idx] = el;
}

// v0.3.8.2: 不用 e.currentTarget (会被 GC 置 null), 用 tickRefs 直接拿 DOM
function onHoverEnter(idx: number) {
  if (leaveTimer) {
    clearTimeout(leaveTimer);
    leaveTimer = null;
  }
  hoveredIdx.value = idx;
  if (hoverTimer) {
    clearTimeout(hoverTimer);
    hoverTimer = null;
  }
  hoverTimer = setTimeout(() => {
    const tickEl = tickRefs.value[idx];
    if (tickEl) positionPopover(tickEl);
  }, 220);
}

function onHoverLeave() {
  if (hoverTimer) {
    clearTimeout(hoverTimer);
    hoverTimer = null;
  }
  if (leaveTimer) {
    clearTimeout(leaveTimer);
    leaveTimer = null;
  }
  leaveTimer = setTimeout(() => {
    hoveredIdx.value = null;
  }, 120);
}

function onPopoverEnter() {
  if (leaveTimer) {
    clearTimeout(leaveTimer);
    leaveTimer = null;
  }
}

function positionPopover(tickEl: HTMLElement) {
  // v0.3.8.2 fix: 防御性 null / 0 size 跳过, 避免抛 getBoundingClientRect on null
  if (!tickEl || !tickEl.isConnected) return;
  const rect = tickEl.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return;
  const POPOVER_W = 260;
  const MARGIN = 8;
  let left = rect.right + MARGIN;
  if (left + POPOVER_W > window.innerWidth - MARGIN) {
    left = rect.left - POPOVER_W - MARGIN;
  }
  left = Math.max(MARGIN, left);
  const top = rect.top + rect.height / 2;
  popoverStyle.value = {
    position: 'fixed',
    top: `${top}px`,
    left: `${left}px`,
    width: `${POPOVER_W}px`,
    transform: 'translateY(-50%)',
    zIndex: '99999',
  };
}

function onClick(turn: ChatTurn, idx: number) {
  // v0.3.8.3 fix: 点击 tick 主动设 activeIdx, 不等 IO fire
  // 之前底部/顶部 tick 跳到目标位置后, 因 rootMargin 太严, IO 不识别
  // target message 为 visible, 导致 active 一直停在 idx 0 / count-1
  activeIdx.value = idx;
  // 同步把 nav 滚到让点击的 tick 居中
  nextTick(() => {
    const el = navEl.value;
    const tickEl = tickRefs.value[idx];
    if (el && tickEl) {
      const tickTop = tickEl.offsetTop;
      const tickH = tickEl.offsetHeight;
      const navH = el.clientHeight;
      el.scrollTop = tickTop - navH / 2 + tickH / 2;
    }
  });
  props.onJump?.(turn.id);
}

/* ============================================================
 * 游标卡尺 hover lens 公式
 *   BASE = 8
 *   hovered d=0 → 24
 *   hovered d=1 → 20
 *   hovered d=2 → 16
 *   hovered d=3 → 12
 *   hovered d>=4 → BASE
 *   active d=0  → 22 (覆盖)
 *   active d=1  → 11
 *   active d>=2 → BASE
 * ============================================================ */
const TICK_BASE = 8;
const HOVER_WIDTHS = [24, 20, 16, 12]; // d=0,1,2,3
const HOVER_OPACITIES = [1, 0.85, 0.7, 0.55];
const ACTIVE_W = 22;
const ACTIVE_NEAR_W = 11;
const ACTIVE_OPACITY = 0.9;
const ACTIVE_NEAR_OPACITY = 0.6;

function tickWidth(idx: number): number {
  let w = TICK_BASE;
  if (hoveredIdx.value !== null) {
    const d = Math.abs(idx - hoveredIdx.value);
    if (d < HOVER_WIDTHS.length) {
      w = HOVER_WIDTHS[d];
    }
  }
  if (activeIdx.value === idx) {
    w = Math.max(w, ACTIVE_W);
  } else if (activeIdx.value !== null) {
    const d = Math.abs(idx - activeIdx.value);
    if (d === 1) w = Math.max(w, ACTIVE_NEAR_W);
  }
  return w;
}

function tickOpacity(idx: number): number {
  let op = 0.4; // 默认 opacity
  if (hoveredIdx.value !== null) {
    const d = Math.abs(idx - hoveredIdx.value);
    if (d < HOVER_OPACITIES.length) {
      op = HOVER_OPACITIES[d];
    }
  }
  if (activeIdx.value === idx) {
    op = Math.max(op, ACTIVE_OPACITY);
  } else if (activeIdx.value !== null) {
    const d = Math.abs(idx - activeIdx.value);
    if (d === 1) op = Math.max(op, ACTIVE_NEAR_OPACITY);
  }
  return op;
}

function tickColor(idx: number): string {
  // 优先级: active 自己 → hovered 自己 → 默认 tertiary
  // 注意: active 自己用 accent 紫色, 不混入黑色搭配
  if (activeIdx.value === idx) return 'var(--pad-accent)';
  if (hoveredIdx.value === idx) return 'var(--pad-fg-secondary)';
  return 'var(--pad-fg-tertiary)';
}

// v0.3.8.2: nav 自身的滚动 — wheel 在 nav 上时滚 nav 不穿透
function onWheel(e: WheelEvent) {
  const el = navEl.value;
  if (!el) return;
  const { scrollTop, scrollHeight, clientHeight } = el;
  const maxScroll = scrollHeight - clientHeight;
  if (maxScroll <= 0) {
    // 不可滚: 阻止穿透, 防止 nav 抢了 chat list 的滚动
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  const next = scrollTop + e.deltaY;
  el.scrollTop = Math.max(0, Math.min(maxScroll, next));
  e.preventDefault();
  e.stopPropagation();
}

// ===== IntersectionObserver: 跟踪当前可见的 user message =====
function collectUserMsgElements(): HTMLElement[] {
  const root = props.scrollRoot;
  if (!root) return [];
  const turnIds = new Set(props.turns.map((t) => t.id));
  const out: HTMLElement[] = [];
  const all = root.querySelectorAll<HTMLElement>('[data-message-id]');
  for (const el of Array.from(all)) {
    const id = el.getAttribute('data-message-id');
    if (id && turnIds.has(id)) {
      out.push(el);
    }
  }
  return out;
}

function setupObserver() {
  if (io) {
    io.disconnect();
    io = null;
  }
  if (!props.scrollRoot) return;
  const elements = collectUserMsgElements();
  if (elements.length === 0) return;
  const root = props.scrollRoot;
  io = new IntersectionObserver(
    (entries) => {
      const visibleEntries = entries
        .filter((e) => e.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
      if (visibleEntries.length > 0) {
        const topEl = visibleEntries[0].target as HTMLElement;
        const id = topEl.getAttribute('data-message-id');
        if (id) {
          const idx = props.turns.findIndex((t) => t.id === id);
          if (idx >= 0) {
            activeIdx.value = idx;
            nextTick(() => scrollNavToActive(idx));
          }
        }
      }
    },
    // v0.3.8.3: rootMargin 放宽到 -10% top / -10% bottom
    // 之前 -20% / -50% 太严, 底部/顶部 message 永远不算 visible, IO 不 fire,
    // active 一直停在 idx 0 (顶部) / count-1 (底部)
    { root, threshold: [0, 0.5, 1], rootMargin: '-10% 0px -10% 0px' },
  );
  for (const el of elements) {
    io.observe(el);
  }
}

function scrollNavToActive(idx: number) {
  const el = navEl.value;
  const tickEl = tickRefs.value[idx];
  if (!el || !tickEl) return;
  const tickTop = tickEl.offsetTop;
  const tickH = tickEl.offsetHeight;
  const navScrollTop = el.scrollTop;
  const navH = el.clientHeight;
  if (tickTop < navScrollTop) {
    el.scrollTop = Math.max(0, tickTop - 8);
  } else if (tickTop + tickH > navScrollTop + navH) {
    el.scrollTop = tickTop + tickH - navH + 8;
  }
}

watch(
  () => [props.scrollRoot, props.turns.length, props.turns.map((t) => t.id).join(',')],
  () => {
    nextTick(setupObserver);
  },
);

onMounted(() => {
  nextTick(setupObserver);
});

onBeforeUnmount(() => {
  if (hoverTimer) clearTimeout(hoverTimer);
  if (leaveTimer) clearTimeout(leaveTimer);
  if (io) io.disconnect();
});

defineExpose({ activeIdx });

const visible = computed(() => props.turns.length >= 1);
</script>

<template>
  <nav
    v-if="visible"
    ref="navEl"
    class="pad-msgnav"
    aria-label="消息导航"
    @wheel="onWheel"
  >
    <!-- v0.3.8.10: row 是 hit area (固定 24px × 22px), 内部 tick 是视觉元素 (动态 width)
     * 用户从图 2 参考图看出来: tick 视觉上伸缩, 但 hit area 统一按展开宽度 24px 算.
     * 这样鼠标在 tick 旁边 24px 内都能点中, 不需要精确瞄准短 tick. -->
    <button
      v-for="(turn, idx) in turns"
      :key="turn.id"
      :ref="(el) => setTickRef(el as HTMLButtonElement | null, idx)"
      type="button"
      class="pad-msgnav__row"
      :title="`第 ${idx + 1} 轮`"
      @mouseenter="onHoverEnter(idx)"
      @mouseleave="onHoverLeave"
      @click="onClick(turn, idx)"
    >
      <span
        class="pad-msgnav__tick"
        :class="{ 'is-active': activeIdx === idx, 'is-hovered': hoveredIdx === idx }"
        :style="{
          width: tickWidth(idx) + 'px',
          opacity: tickOpacity(idx),
          backgroundColor: tickColor(idx),
        }"
      />
    </button>

    <Teleport to="body">
      <div
        v-if="hoveredIdx !== null && turns[hoveredIdx]"
        class="pad-msgnav__popover"
        :style="popoverStyle"
        @mouseenter="onPopoverEnter"
        @mouseleave="onHoverLeave"
      >
        <div class="pad-msgnav__popover-head">
          <span class="pad-msgnav__popover-idx">第 {{ hoveredIdx + 1 }} 轮 / 共 {{ turns.length }} 轮</span>
        </div>
        <div class="pad-msgnav__popover-section">
          <div class="pad-msgnav__popover-label">你</div>
          <div class="pad-msgnav__popover-content">{{ turns[hoveredIdx].userContent || '(空)' }}</div>
        </div>
        <div class="pad-msgnav__popover-section">
          <div class="pad-msgnav__popover-label">AI</div>
          <div class="pad-msgnav__popover-content">{{ turns[hoveredIdx].assistantPreview || '(生成中…)' }}</div>
        </div>
      </div>
    </Teleport>
  </nav>
</template>

<style scoped>
.pad-msgnav {
  /* v0.3.8.2 游标卡尺刻度版
   * - position absolute on chat-body, top 50% 居中
   * - 透明背景, 不加任何 card 风格
   * - 子元素 align-items: flex-start → width 伸缩是向右长的, 不会让 layout 跳动
   * - gap 3px (刻度紧密)
   * - max-height + overflow-y: auto → 超长 turns 时 nav 自身可滚
   * - padding 8px 0 8px 0, 右侧不预留 (因为 max-width 24px < 30px nav 容器宽度) */
  position: absolute;
  top: 50%;
  left: 12px;
  transform: translateY(-50%);
  z-index: 40; /* 比 list 高, 比 jump-to-bottom (z-50) 低 */
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  /* v0.3.8.10: gap 8 → 4, 视觉密度更大, row 之间紧凑 */
  gap: 4px;
  padding: 10px 0;
  max-height: calc(100% - 64px);
  overflow-y: auto;
  overflow-x: hidden;
  pointer-events: auto;
  background: transparent;
  border: none;
  box-shadow: none;
  /* 隐藏滚动条 — 滚动靠 wheel, 不要占视觉空间 */
  scrollbar-width: none;
  -ms-overflow-style: none;
}
.pad-msgnav::-webkit-scrollbar {
  display: none;
}

/* v0.3.8.10: row = 整行 hit area (固定 24px × 22px), 接所有 mouse/click 事件 */
.pad-msgnav__row {
  position: relative;
  display: flex;
  align-items: center;
  width: 24px;            /* 固定展开宽度 = hit area 统一标准 */
  height: 22px;           /* 固定高度, 跨 tick 上下 hit area */
  padding: 0;
  background: transparent;
  border: none;
  cursor: pointer;
  flex-shrink: 0;
}

.pad-msgnav__tick {
  /* v0.3.8.10: tick 是绝对定位的视觉元素, 不接 pointer event
   * (整个 row 接收), 动态 width 8-24px 由 :style 注入
   * - 视觉 3px 高 pill, 跟 row 居中 */
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  height: 3px;
  border-radius: 999px;
  pointer-events: none;
  transition:
    width 180ms var(--pad-ease-out-soft, cubic-bezier(0.16, 1, 0.3, 1)),
    background-color 180ms ease,
    opacity 180ms ease;
}
</style>

<style>
/* unscoped: popover 是 teleport 到 body 的, scoped data-v 不传过去 */
.pad-msgnav__popover {
  background: var(--pad-popover);
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-lg);
  box-shadow: var(--pad-shadow-popover);
  padding: 10px 12px;
  z-index: 99999 !important;
  max-height: 280px;
  overflow-y: auto;
  font-family: var(--pad-font-sans);
  pointer-events: auto;
  animation: pad-msgnav-popover-in 0.15s var(--pad-ease-out-soft, ease-out);
}
@keyframes pad-msgnav-popover-in {
  from { opacity: 0; transform: translateY(-50%) translateX(-4px); }
  to { opacity: 1; transform: translateY(-50%) translateX(0); }
}
.pad-msgnav__popover-head {
  font-size: var(--pad-fs-11);
  color: var(--pad-fg-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  font-weight: var(--pad-fw-medium);
  margin-bottom: 6px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--pad-divider);
}
.pad-msgnav__popover-idx {
  color: var(--pad-fg-secondary);
}
.pad-msgnav__popover-section {
  margin: 6px 0;
}
.pad-msgnav__popover-label {
  font-size: var(--pad-fs-11);
  color: var(--pad-fg-tertiary);
  margin-bottom: 2px;
  font-weight: var(--pad-fw-medium);
}
.pad-msgnav__popover-content {
  font-size: var(--pad-fs-12);
  color: var(--pad-fg-primary);
  line-height: var(--pad-lh-base);
  display: -webkit-box;
  -webkit-line-clamp: 4;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-wrap: break-word;
  white-space: pre-wrap;
}
</style>
