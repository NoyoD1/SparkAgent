<script setup lang="ts">
/**
 * Sidebar — 248px (collapsed 52px) container.
 * 1:1 mirrors chat.html's <aside id="sidebar">.
 * Composes: TabBar / FunctionList / WorkspaceTree / UserArea.
 *
 * v0.3.5+ 接收 noActiveTabBar prop: ChatMain initial 状态 (无 active session) 传 true,
 * SidebarTabBar 不点亮任何 tab.
 */
import { storeToRefs } from 'pinia';
import { useUiStore } from '@/stores/ui';
import SidebarTabBar from './SidebarTabBar.vue';
import SidebarFunctionList from './SidebarFunctionList.vue';
import WorkspaceTree from './WorkspaceTree.vue';
import SidebarUserArea from './SidebarUserArea.vue';

defineProps<{ noActiveTabBar?: boolean }>();

const uiStore = useUiStore();
const { sidebarCollapsed } = storeToRefs(uiStore);
</script>

<template>
  <aside
    class="pad-sidebar"
    :class="{ 'is-collapsed': sidebarCollapsed }"
  >
    <SidebarTabBar :no-active="noActiveTabBar" />
    <SidebarFunctionList />
    <WorkspaceTree />
    <SidebarUserArea />
  </aside>
</template>

<style scoped>
.pad-sidebar {
  width: var(--pad-sidebar-width);
  /* v0.3.8.23: 跟 body 同色, 不再用 --pad-bg-sidebar (#fafafa 浅灰),
   * 整张界面同色, sidebar 跟 chat 跟 drawer 视觉上是同一张卡.
   * border-radius 也去掉, 改用 1px right border 跟 chat 区分.
   * (border 在父级 .pad-app__body 里靠 column-gap 中线体现) */
  background: var(--pad-card);
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  transition: width var(--pad-dur-base) var(--pad-ease-out-soft);
  overflow: hidden;
}
.pad-sidebar.is-collapsed {
  width: 52px;
}
</style>
