<script setup lang="ts">
/**
 * WorkspaceTemplateMenu — 加工作区的小菜单 (v0.6+ 2.2)
 *
 * 替代原本单一的 "+" 按钮 (走 pickFolder). 提供三个模板:
 *   1. 选择已有文件夹 (走系统 picker, 跟之前一致)
 *   2. 新建空目录 (弹小 dialog 填名字, 然后选父目录)
 *   3. 从 Git 克隆 (弹小 dialog 填 URL, 然后选父目录)
 *
 * 设计: 用 + 按钮 + 下拉菜单 (跟现代 IDE 一致). 不用 modal/popover 库, 纯 Teleport.
 */
import { ref, onMounted, onUnmounted } from 'vue';
import { Plus, ChevronDown, FolderPlus, FilePlus2, GitBranch } from 'lucide-vue-next';

defineProps<{
  disabled?: boolean;
}>();

const emit = defineEmits<{
  (e: 'pick-folder'): void;
  (e: 'empty-dir'): void;
  (e: 'git-clone'): void;
}>();

const open = ref(false);
const menuEl = ref<HTMLElement | null>(null);
const btnEl = ref<HTMLElement | null>(null);

function toggle() {
  if (open.value) close();
  else show();
}
function show() {
  if (open.value) return;
  // 算菜单位置 (在按钮下面, 右侧对齐)
  if (!btnEl.value) return;
  const rect = btnEl.value.getBoundingClientRect();
  // 用 CSS class 设位置, 简单点直接 fixed
  open.value = true;
  // 下个 tick 拿到 menuEl 后设位置
  requestAnimationFrame(() => {
    if (!menuEl.value) return;
    menuEl.value.style.top = `${rect.bottom + 4}px`;
    menuEl.value.style.left = `${rect.right - 180}px`;  // 180 = menu 宽, 右侧对齐按钮
  });
}
function close() {
  open.value = false;
}
function onItem(action: 'pick-folder' | 'empty-dir' | 'git-clone') {
  close();
  // emit 写三个分支 TS 会让类型联合卡住, 这里用 as any 走, 反正只有一个 emit
  (emit as (e: string) => void)(action);
}
function onDocClick(e: MouseEvent) {
  if (!open.value) return;
  if (btnEl.value?.contains(e.target as Node)) return;
  if (menuEl.value?.contains(e.target as Node)) return;
  close();
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && open.value) close();
}

onMounted(() => {
  document.addEventListener('mousedown', onDocClick);
  document.addEventListener('keydown', onKey);
});
onUnmounted(() => {
  document.removeEventListener('mousedown', onDocClick);
  document.removeEventListener('keydown', onKey);
});
</script>

<template>
  <div class="pad-wstpl">
    <button
      ref="btnEl"
      class="pad-wstpl__btn"
      :disabled="disabled"
      :title="disabled ? '打开文件夹选择...' : '加工作区 (选文件夹 / 新建空 / git clone)'"
      @click="toggle"
    >
      <Plus :size="12" :stroke-width="2" />
      <ChevronDown :size="9" :stroke-width="2" />
    </button>

    <Teleport to="body">
      <div
        v-if="open"
        ref="menuEl"
        class="pad-wstpl__menu"
        role="menu"
      >
        <button class="pad-wstpl__item" role="menuitem" @click="onItem('pick-folder')">
          <FolderPlus :size="13" :stroke-width="1.75" />
          <span>选择已有文件夹</span>
        </button>
        <button class="pad-wstpl__item" role="menuitem" @click="onItem('empty-dir')">
          <FilePlus2 :size="13" :stroke-width="1.75" />
          <span>新建空目录</span>
        </button>
        <button class="pad-wstpl__item" role="menuitem" @click="onItem('git-clone')">
          <GitBranch :size="13" :stroke-width="1.75" />
          <span>从 Git 克隆</span>
        </button>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.pad-wstpl {
  position: relative;
  display: inline-flex;
}
.pad-wstpl__btn {
  display: inline-flex;
  align-items: center;
  gap: 1px;
  padding: 2px 4px;
  border: none;
  border-radius: 3px;
  background: transparent;
  color: var(--pad-fg-tertiary);
  cursor: pointer;
  transition: background var(--pad-dur-fast) ease, color var(--pad-dur-fast) ease;
}
.pad-wstpl__btn:hover:not(:disabled) {
  background: var(--pad-bg-hover);
  color: var(--pad-fg-primary);
}
.pad-wstpl__btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>

<style>
/* menu 走 Teleport, 不 scoped */
.pad-wstpl__menu {
  position: fixed;
  z-index: 1000;
  min-width: 180px;
  padding: 4px;
  background: var(--pad-bg-elevated, #2a2a2a);
  border: 1px solid var(--pad-border-subtle, var(--pad-bg-hover));
  border-radius: 6px;
  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.3);
}
.pad-wstpl__item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 10px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--pad-fg-primary);
  font-size: 12px;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  transition: background var(--pad-dur-fast) ease;
}
.pad-wstpl__item:hover {
  background: var(--pad-bg-hover);
}
</style>
