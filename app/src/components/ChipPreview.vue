<script setup lang="ts">
/**
 * ChipPreview — chip 点击预览浮层
 *
 * D214 v7: 用户点 chip 主体 (不是 × 按钮) → 弹这个浮层, 显示完整 body
 *   - 用 Teleport 到 body, 避开父容器 overflow:hidden / z-index 问题
 *   - 位置: 默认在 chip 下方, 下方空间不够时弹到 chip 上方
 *   - 内容: title (kind + name) + body (markdown / JSON 文本, 等宽字体)
 *   - 关闭: × 按钮 / Escape / 点空白
 *   - App.vue 一次性 mount, 走 useChipPreview 全局状态
 */
import { computed, onMounted, onUnmounted, watch, nextTick } from 'vue';
import { X, FileText, Wrench, Plug } from 'lucide-vue-next';
import { useChipPreview } from '@/composables/useChipPreview';

const { current, closeRef } = useChipPreview();

// 是否显示
const isOpen = computed(() => current.value !== null);

// 浮层位置 (根据 chip 位置算)
const popupStyle = computed(() => {
  if (!current.value) return {};
  const POPUP_MAX_H = 360;
  const POPUP_W = 480;
  const MARGIN = 6;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const anchor = current.value.pos;
  // 横向: 居中 chip, 但不能超出 viewport
  let left = anchor.left + anchor.width / 2 - POPUP_W / 2;
  left = Math.max(8, Math.min(left, vw - POPUP_W - 8));
  // 纵向: 默认下方, 下方 < POPUP_MAX_H + 40 时翻到上方
  const spaceBelow = vh - (anchor.top + MARGIN);
  const spaceAbove = anchor.top - MARGIN;
  let top: number;
  if (spaceBelow >= Math.min(POPUP_MAX_H, 200) || spaceBelow > spaceAbove) {
    top = anchor.top + 22 + MARGIN;  // 22 ≈ chip 高度
  } else {
    top = anchor.top - POPUP_MAX_H - MARGIN;
    if (top < 8) top = 8;
  }
  return {
    top: `${top}px`,
    left: `${left}px`,
    width: `${POPUP_W}px`,
    maxHeight: `${Math.min(POPUP_MAX_H, Math.max(spaceBelow - 16, spaceAbove - 16, 200))}px`,
  };
});

// Kind → lucide icon
const KindIcon = computed(() => {
  if (!current.value) return FileText;
  if (current.value.kind === 'skill') return FileText;
  if (current.value.kind === 'tool') return Wrench;
  return Plug;
});

// Escape 关闭
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && isOpen.value) {
    e.preventDefault();
    closeRef();
  }
}

// 点空白关闭 (mouseup 比 click 更稳 — 拖动选区不会误关)
function onDocumentMouseUp(e: MouseEvent) {
  if (!isOpen.value) return;
  const target = e.target as Node;
  if (popupEl.value && popupEl.value.contains(target)) return;
  // 别关, 如果点的是 chip 本身 (用户可能切到另一个 chip)
  //   这里不主动处理: openRef 会先 close + open, closeRef 只在外部点空白时跑
  //   如果想"点 chip 切到另一个", openRef 自己 replace state, 这里别关就行
  //   但要是点的不是 chip 也不是 popup, 就关
  const isChip = (target as HTMLElement).closest?.('.pad-composer__ref-chip');
  if (isChip) return;  // 让 chip click handler 处理 (openRef 会替换 state)
  closeRef();
}

const popupEl = ref<HTMLElement | null>(null);
// Vue ref 替身 (script setup 里直接用 ref 会爆, 用 import)
import { ref } from 'vue';

onMounted(() => {
  document.addEventListener('keydown', onKeydown);
  // 下一帧挂 mouseup, 避免跟 chip click 抢事件
  nextTick(() => {
    document.addEventListener('mouseup', onDocumentMouseUp);
  });
});
onUnmounted(() => {
  document.removeEventListener('keydown', onKeydown);
  document.removeEventListener('mouseup', onDocumentMouseUp);
});

// 重新打开时, 自动滚 body 到顶
watch(isOpen, async (open) => {
  if (open) {
    await nextTick();
    const body = popupEl.value?.querySelector('.chip-preview__body') as HTMLElement | null;
    if (body) body.scrollTop = 0;
  }
});
</script>

<template>
  <Teleport to="body">
    <div v-if="isOpen && current" ref="popupEl" class="chip-preview" :style="popupStyle" @mousedown.stop>
      <div class="chip-preview__head">
        <component :is="KindIcon" :size="13" :stroke-width="1.75" class="chip-preview__head-icon" />
        <span class="chip-preview__head-title">{{ current.title }}</span>
        <button class="chip-preview__close" title="关闭 (Esc)" @click="closeRef">
          <X :size="14" :stroke-width="2" />
        </button>
      </div>
      <div v-if="current.loading" class="chip-preview__loading">
        加载中…
      </div>
      <div v-else-if="current.error" class="chip-preview__error">
        加载失败: {{ current.error }}
      </div>
      <pre v-else class="chip-preview__body">{{ current.body }}</pre>
    </div>
  </Teleport>
</template>

<style scoped>
.chip-preview {
  position: fixed;
  z-index: 1000;
  background: var(--pad-card, #fff);
  border: 1px solid var(--pad-border, rgba(0, 0, 0, 0.12));
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18), 0 2px 6px rgba(0, 0, 0, 0.08);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  font-family: var(--pad-font-sans);
}
.chip-preview__head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--pad-border-subtle, rgba(0, 0, 0, 0.08));
  background: var(--pad-bg-secondary, rgba(0, 0, 0, 0.02));
  flex-shrink: 0;
}
.chip-preview__head-icon {
  color: var(--pad-fg-tertiary);
  flex-shrink: 0;
}
.chip-preview__head-title {
  flex: 1;
  font-size: 12px;
  font-weight: 600;
  color: var(--pad-fg-primary);
  font-family: var(--pad-font-mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chip-preview__close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  background: transparent;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  color: var(--pad-fg-tertiary);
  padding: 0;
  flex-shrink: 0;
}
.chip-preview__close:hover {
  background: var(--pad-bg-hover, rgba(0, 0, 0, 0.06));
  color: var(--pad-fg-primary);
}
.chip-preview__body {
  margin: 0;
  padding: 10px 12px;
  font-family: var(--pad-font-mono);
  font-size: 12px;
  line-height: 1.5;
  color: var(--pad-fg-primary);
  white-space: pre-wrap;
  word-break: break-word;
  overflow-y: auto;
  flex: 1;
  background: var(--pad-bg-base, #fafafa);
}
.chip-preview__loading,
.chip-preview__error {
  padding: 24px 12px;
  text-align: center;
  font-size: 12px;
  color: var(--pad-fg-tertiary);
}
.chip-preview__error {
  color: var(--pad-fg-danger, #dc2626);
}
</style>
