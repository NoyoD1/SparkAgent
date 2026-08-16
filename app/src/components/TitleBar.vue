<script setup lang="ts">
/**
 * TitleBar — 36px high top bar
 * v4: 删 PanelRight (下移到 ChatHeader 右侧), TitleBar 只剩 sidebar toggle + 工具 + 窗口控制
 * - left:   PanelLeft (toggle sidebar) + Search + 编辑/帮助
 * - center: 留空
 * - right:  窗口控制 (min/max/close)
 */
import { Search, PanelLeft, Minus, Square, X } from 'lucide-vue-next';
import IconButton from '@/components/ui/IconButton.vue';
import { useUiStore } from '@/stores/ui';

const uiStore = useUiStore();
</script>

<template>
  <header class="pad-titlebar">
    <div class="pad-titlebar__left">
      <IconButton :icon="PanelLeft" size="sm" title="切换侧栏 (Cmd+\)" @click="uiStore.toggleSidebar" />
      <span class="pad-titlebar__divider" aria-hidden="true" />
      <IconButton :icon="Search" size="sm" title="搜索 (Cmd+K)" />
      <button class="pad-titlebar__btn">编辑(E)</button>
      <button class="pad-titlebar__btn">帮助(H)</button>
    </div>
    <div class="pad-titlebar__center" />
    <div class="pad-titlebar__right">
      <IconButton :icon="Minus" size="sm" title="最小化" />
      <IconButton :icon="Square" size="sm" title="最大化" />
      <IconButton :icon="X" size="sm" title="关闭" variant="danger" />
    </div>
  </header>
</template>

<style scoped>
.pad-titlebar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 36px;
  padding: 0 var(--pad-sp-3);
  background: var(--pad-bg-app);
  border-radius: var(--pad-radius-xl);
  flex-shrink: 0;
  user-select: none;
}
.pad-titlebar__left,
.pad-titlebar__right {
  display: flex;
  align-items: center;
  gap: var(--pad-sp-1);
}
.pad-titlebar__center {
  flex: 1;
}
/* 左侧功能区, PanelLeft/PanelRight 跟工具按钮之间细分隔 */
.pad-titlebar__divider {
  display: inline-block;
  width: 1px;
  height: 16px;
  background: var(--pad-divider);
  margin: 0 var(--pad-sp-1);
}
.pad-titlebar__btn {
  display: inline-flex;
  align-items: center;
  height: 28px;
  padding: 0 var(--pad-sp-2);
  border-radius: var(--pad-radius-md);
  font-size: var(--pad-fs-13);
  color: var(--pad-fg-secondary);
  background: transparent;
  border: none;
  cursor: pointer;
  transition:
    background var(--pad-dur-fast) ease,
    color var(--pad-dur-fast) ease;
}
.pad-titlebar__btn:hover {
  background: var(--pad-bg-hover);
  color: var(--pad-fg-primary);
}
</style>
