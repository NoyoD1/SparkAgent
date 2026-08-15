<script setup lang="ts">
/**
 * TitleBar — 36px high top bar
 * v3: 左中右 3 段, 视图 toggle 全部归左边功能区, 右边只剩窗口控制
 * - left:   PanelLeft (toggle sidebar) + PanelRight (toggle drawer) + Search + 编辑/帮助
 * - center: 留空 (页面内 title 由 ChatHeader / Settings 自己显示, 这里不抢戏)
 * - right:  窗口控制 (min/max/close)
 *
 * 设计来源: ZCode 参考 - 右侧不堆功能按钮, 避免鼠标长距离来回
 * 1:1 mirrors chat.html's <header> at the top, 但 toggle 全部左移
 */
import { Search, PanelLeft, PanelRight, Minus, Square, X } from 'lucide-vue-next';
import IconButton from '@/components/ui/IconButton.vue';
import { useUiStore } from '@/stores/ui';

const uiStore = useUiStore();
</script>

<template>
  <header class="pad-titlebar">
    <!-- 左侧功能区: 视图 toggle + 工具 (PanelLeft/PanelRight 都放这, 避免右侧路径太长) -->
    <div class="pad-titlebar__left">
      <IconButton :icon="PanelLeft" size="sm" title="切换侧栏 (Cmd+\)" @click="uiStore.toggleSidebar" />
      <IconButton :icon="PanelRight" size="sm" title="切换任务摘要抽屉" @click="uiStore.toggleDrawer" />
      <span class="pad-titlebar__divider" aria-hidden="true" />
      <IconButton :icon="Search" size="sm" title="搜索 (Cmd+K)" />
      <button class="pad-titlebar__btn">编辑(E)</button>
      <button class="pad-titlebar__btn">帮助(H)</button>
    </div>
    <!-- 中间: 留空 -->
    <div class="pad-titlebar__center" />
    <!-- 右侧: 窗口控制 (3 段式) -->
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
