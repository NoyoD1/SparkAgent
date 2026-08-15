<script setup lang="ts">
/**
 * Sidebar — 248px (collapsed 52px) container.
 * 1:1 mirrors chat.html's <aside id="sidebar">.
 * Composes: TabBar / FunctionList / WorkspaceTree / UserArea.
 */
import { storeToRefs } from 'pinia';
import { useUiStore } from '@/stores/ui';
import SidebarTabBar from './SidebarTabBar.vue';
import SidebarFunctionList from './SidebarFunctionList.vue';
import WorkspaceTree from './WorkspaceTree.vue';
import SidebarUserArea from './SidebarUserArea.vue';

const uiStore = useUiStore();
const { sidebarCollapsed } = storeToRefs(uiStore);
</script>

<template>
  <aside
    class="pad-sidebar"
    :class="{ 'is-collapsed': sidebarCollapsed }"
  >
    <SidebarTabBar />
    <SidebarFunctionList />
    <WorkspaceTree />
    <SidebarUserArea />
  </aside>
</template>

<style scoped>
.pad-sidebar {
  width: var(--pad-sidebar-width);
  background: var(--pad-bg-sidebar);
  border-radius: var(--pad-radius-xl);
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
