<script setup lang="ts">
/**
 * SessionContextMenu · session 右键 kebab 菜单 (Phase 1)
 *
 * 用法:
 *   <SessionContextMenu
 *     v-if="menuSession"
 *     :x="menuX"
 *     :y="menuY"
 *     :session="menuSession"
 *     @action="onAction"
 *     @close="menuSession = null"
 *   />
 *
 * emit action 类型:
 *   - 'pin' | 'unpin'
 *   - 'rename'
 *   - 'add-tag' (Phase 4 UI 触发 tag 输入)
 *   - 'remove-tag' + payload: { tag: string }
 *   - 'archive' (active session 才显示)
 *   - 'restore' (archived session 才显示)
 *   - 'delete-permanently' (archived session 才显示, 红色)
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import type { Session } from '@/stores/session';

interface Props {
  x: number;
  y: number;
  session: Session;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  action: [payload: { type: string; payload?: any }];
  close: [];
}>();

const menuEl = ref<HTMLElement | null>(null);
const adjustedX = ref(props.x);
const adjustedY = ref(props.y);

function clamp() {
  if (!menuEl.value) return;
  const rect = menuEl.value.getBoundingClientRect();
  const margin = 8;
  let x = props.x;
  let y = props.y;
  if (x + rect.width > window.innerWidth - margin) {
    x = window.innerWidth - rect.width - margin;
  }
  if (y + rect.height > window.innerHeight - margin) {
    y = window.innerHeight - rect.height - margin;
  }
  if (x < margin) x = margin;
  if (y < margin) y = margin;
  adjustedX.value = x;
  adjustedY.value = y;
}

onMounted(() => {
  nextTick(clamp);
});

watch(
  () => [props.x, props.y],
  () => {
    nextTick(clamp);
  },
);

function onClickOutside(e: MouseEvent) {
  const target = e.target as HTMLElement;
  if (menuEl.value && menuEl.value.contains(target)) return;
  emit('close');
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault();
    emit('close');
  }
}

onMounted(() => {
  // 用 mousedown 比 click 早, 避免右键点击立刻被自己吃掉
  setTimeout(() => {
    document.addEventListener('mousedown', onClickOutside);
  }, 0);
  document.addEventListener('keydown', onKeydown);
});

onUnmounted(() => {
  document.removeEventListener('mousedown', onClickOutside);
  document.removeEventListener('keydown', onKeydown);
});

const isArchived = computed(() => !!props.session.archived);
const isPinned = computed(() => !!props.session.pinned);
const tags = computed(() => props.session.tags ?? []);

function emitAction(type: string, payload?: any) {
  emit('action', { type, payload });
  emit('close');
}
</script>

<template>
  <div
    ref="menuEl"
    class="pad-contextmenu"
    :style="{ left: adjustedX + 'px', top: adjustedY + 'px' }"
    @click.stop
    @contextmenu.prevent
  >
    <button class="pad-contextmenu-item" @click="emitAction(isPinned ? 'unpin' : 'pin')">
      <span class="pad-contextmenu-item__icon">📌</span>
      <span>{{ isPinned ? 'Unpin' : 'Pin to top' }}</span>
    </button>

    <button class="pad-contextmenu-item" @click="emitAction('rename')">
      <span class="pad-contextmenu-item__icon">✏️</span>
      <span>Rename</span>
    </button>

    <button class="pad-contextmenu-item" @click="emitAction('add-tag')">
      <span class="pad-contextmenu-item__icon">🏷</span>
      <span>Add tag...</span>
    </button>

    <div v-if="tags.length" class="pad-contextmenu-tags">
      <button
        v-for="tag in tags"
        :key="tag"
        type="button"
        class="pad-contextmenu-tag"
        :title="`点击删除 tag: ${tag}`"
        @click="emitAction('remove-tag', { tag })"
      >
        {{ tag }} <span class="pad-contextmenu-tag__close">×</span>
      </button>
    </div>

    <div class="pad-contextmenu-divider" />

    <button v-if="!isArchived" class="pad-contextmenu-item" @click="emitAction('archive')">
      <span class="pad-contextmenu-item__icon">📦</span>
      <span>Archive</span>
    </button>
    <button v-else class="pad-contextmenu-item" @click="emitAction('restore')">
      <span class="pad-contextmenu-item__icon">↩️</span>
      <span>Restore</span>
    </button>

    <button
      v-if="isArchived"
      class="pad-contextmenu-item pad-contextmenu-item--danger"
      @click="emitAction('delete-permanently')"
    >
      <span class="pad-contextmenu-item__icon">🗑</span>
      <span>Delete permanently</span>
    </button>
  </div>
</template>

<style scoped>
.pad-contextmenu {
  position: fixed;
  min-width: 220px;
  background: var(--pad-bg-card, #ffffff);
  border: 1px solid var(--pad-border, rgba(0, 0, 0, 0.1));
  border-radius: var(--pad-radius-md, 6px);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18);
  padding: var(--pad-sp-1, 4px);
  z-index: 9998;
  user-select: none;
}

.pad-contextmenu-item {
  display: flex;
  align-items: center;
  gap: var(--pad-sp-2, 8px);
  width: 100%;
  text-align: left;
  padding: var(--pad-sp-2, 8px) var(--pad-sp-3, 12px);
  border: none;
  background: transparent;
  color: var(--pad-fg-primary, #1a1a1a);
  font-size: var(--pad-fs-13, 13px);
  cursor: pointer;
  border-radius: var(--pad-radius-sm, 4px);
  transition: background var(--pad-dur-fast, 0.15s) ease;
}

.pad-contextmenu-item:hover {
  background: var(--pad-bg-hover, rgba(0, 0, 0, 0.05));
}

.pad-contextmenu-item--danger {
  color: var(--pad-danger, #ef4444);
}

.pad-contextmenu-item--danger:hover {
  background: var(--pad-danger-bg, rgba(239, 68, 68, 0.08));
}

.pad-contextmenu-item__icon {
  font-size: var(--pad-fs-13, 13px);
  width: 16px;
  text-align: center;
  flex-shrink: 0;
}

.pad-contextmenu-divider {
  height: 1px;
  background: var(--pad-border, rgba(0, 0, 0, 0.08));
  margin: var(--pad-sp-1, 4px) 0;
}

.pad-contextmenu-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 2px var(--pad-sp-3, 12px) var(--pad-sp-2, 8px);
}

.pad-contextmenu-tag {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-size: var(--pad-fs-11, 11px);
  padding: 2px 6px;
  background: var(--pad-bg-hover, rgba(0, 0, 0, 0.05));
  color: var(--pad-fg-secondary, #4a4a4a);
  border: 1px solid var(--pad-border, rgba(0, 0, 0, 0.08));
  border-radius: var(--pad-radius-sm, 4px);
  cursor: pointer;
  transition: background var(--pad-dur-fast, 0.15s) ease;
}

.pad-contextmenu-tag:hover {
  background: var(--pad-bg-page, rgba(0, 0, 0, 0.08));
  color: var(--pad-fg-primary, #1a1a1a);
}

.pad-contextmenu-tag__close {
  font-size: var(--pad-fs-13, 13px);
  color: var(--pad-fg-tertiary, #888);
  margin-left: 2px;
}
</style>
