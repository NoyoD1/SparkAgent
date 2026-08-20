<script setup lang="ts">
/**
 * SessionContextMenu · session 右键 kebab 菜单 (Phase 1)
 *
 * Phase 4 改造: "Add tag..." 按钮原地变 input (Enter 提交, Esc 取消回菜单)
 *  - onAddTagClick → addingTag = true → focus input
 *  - onAddTagConfirm → emit('action', { type: 'add-tag', payload: { tag } }) + close
 *  - onAddTagCancel → addingTag = false (菜单保持开)
 *  - document keydown Esc 在 addingTag 时不再 close 菜单 (让 input 自己的 handler 处理)
 *
 * Phase 7 UI 优化: 全部 emoji 换 lucide icon, 英文换中文 (后续才做多语言)
 *  - 菜单项: 置顶/取消置顶 / 重命名 / 添加标签 / 归档 / 恢复 / 永久删除
 *  - icon: Pin / Pencil / Tag / Archive / RotateCcw / Trash2
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
 *   - 'add-tag' + payload: { tag: string }
 *   - 'remove-tag' + payload: { tag: string }
 *   - 'archive' (active session 才显示)
 *   - 'restore' (archived session 才显示)
 *   - 'delete-permanently' (archived session 才显示, 红色)
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { Pin, Pencil, Tag as TagIcon, Archive, RotateCcw, Trash2 } from 'lucide-vue-next';
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
    // Phase 4: 在 tag 输入态, Esc 优先由 input 自己的 handler 处理 (cancel 输入, 保持菜单)
    if (addingTag.value) return;
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

// Phase 4: "Add tag..." 按钮原地变输入框
const addingTag = ref(false);
const tagInputValue = ref('');
const tagInputEl = ref<HTMLInputElement | null>(null);

async function onAddTagClick() {
  addingTag.value = true;
  tagInputValue.value = '';
  await nextTick();
  tagInputEl.value?.focus();
}

function onAddTagConfirm() {
  const t = tagInputValue.value.trim();
  if (t) {
    emit('action', { type: 'add-tag', payload: { tag: t } });
  }
  emit('close');
}

function onAddTagCancel() {
  addingTag.value = false;
  tagInputValue.value = '';
}

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
      <Pin :size="13" :stroke-width="1.75" class="pad-contextmenu-item__icon" />
      <span>{{ isPinned ? '取消置顶' : '置顶' }}</span>
    </button>

    <button class="pad-contextmenu-item" @click="emitAction('rename')">
      <Pencil :size="13" :stroke-width="1.75" class="pad-contextmenu-item__icon" />
      <span>重命名</span>
    </button>

    <!-- Phase 4: 'Add tag...' 原地变 input (Enter 提交, Esc 取消回菜单) -->
    <div v-if="addingTag" class="pad-contextmenu-addtag">
      <TagIcon :size="13" :stroke-width="1.75" class="pad-contextmenu-item__icon" />
      <input
        ref="tagInputEl"
        v-model="tagInputValue"
        type="text"
        class="pad-contextmenu-addtag-input"
        placeholder="输入标签名..."
        maxlength="32"
        @keydown.enter.prevent="onAddTagConfirm"
        @keydown.escape.prevent="onAddTagCancel"
        @click.stop
      />
    </div>
    <button v-else class="pad-contextmenu-item" @click="onAddTagClick">
      <TagIcon :size="13" :stroke-width="1.75" class="pad-contextmenu-item__icon" />
      <span>添加标签</span>
    </button>

    <div v-if="tags.length" class="pad-contextmenu-tags">
      <button
        v-for="tag in tags"
        :key="tag"
        type="button"
        class="pad-contextmenu-tag"
        :title="`点击删除标签: ${tag}`"
        @click="emitAction('remove-tag', { tag })"
      >
        {{ tag }} <span class="pad-contextmenu-tag__close">×</span>
      </button>
    </div>

    <div class="pad-contextmenu-divider" />

    <button v-if="!isArchived" class="pad-contextmenu-item" @click="emitAction('archive')">
      <Archive :size="13" :stroke-width="1.75" class="pad-contextmenu-item__icon" />
      <span>归档</span>
    </button>
    <button v-else class="pad-contextmenu-item" @click="emitAction('restore')">
      <RotateCcw :size="13" :stroke-width="1.75" class="pad-contextmenu-item__icon" />
      <span>恢复</span>
    </button>

    <button
      v-if="isArchived"
      class="pad-contextmenu-item pad-contextmenu-item--danger"
      @click="emitAction('delete-permanently')"
    >
      <Trash2 :size="13" :stroke-width="1.75" class="pad-contextmenu-item__icon" />
      <span>永久删除</span>
    </button>
  </div>
</template>

<style scoped>
.pad-contextmenu {
  position: fixed;
  min-width: 220px;
  /* Phase 8: dark mode 适配 — 修之前用 --pad-bg-card (未定义, fallback 白底)
     改成正确的 --pad-card (light=#fff, dark=#171717) */
  background: var(--pad-card);
  border: 1px solid var(--pad-border);
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
  /* Phase 7: 从 emoji 换 lucide icon, font-size 改成 color (svg 不用 font-size) */
  color: var(--pad-fg-secondary, #4a4a4a);
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.pad-contextmenu-item--danger .pad-contextmenu-item__icon {
  color: var(--pad-danger, #ef4444);
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

/* Phase 4: in-menu add tag input (替换 'Add tag...' 按钮, 原地变输入框) */
.pad-contextmenu-addtag {
  display: flex;
  align-items: center;
  gap: var(--pad-sp-2, 8px);
  padding: var(--pad-sp-2, 8px) var(--pad-sp-3, 12px);
}
.pad-contextmenu-addtag-input {
  flex: 1;
  min-width: 0;
  border: 1px solid var(--pad-accent, #3b82f6);
  border-radius: var(--pad-radius-sm, 4px);
  /* Phase 8: dark mode — 改用 --pad-bg-input (light=#fff, dark=#1c1c1c) */
  background: var(--pad-bg-input);
  color: var(--pad-fg-primary);
  font: inherit;
  font-size: var(--pad-fs-13, 13px);
  padding: 2px 6px;
  outline: none;
  height: 22px;
}
.pad-contextmenu-addtag-input:focus {
  box-shadow: 0 0 0 2px var(--pad-accent-soft, rgba(59, 130, 246, 0.18));
}
</style>
