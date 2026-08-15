<script setup lang="ts">
/**
 * SidebarTabBar — Work / Code / Design 3 tabs at top of sidebar.
 * 1:1 mirrors chat.html's `<button>Work</button><button>Code</button><button>Design</button>`.
 */
import { Briefcase, Code2, PenTool } from 'lucide-vue-next';
import { useUiStore, type SidebarTab } from '@/stores/ui';
import { storeToRefs } from 'pinia';

const uiStore = useUiStore();
const { activeTab } = storeToRefs(uiStore);

const tabs: { id: SidebarTab; label: string; icon: any }[] = [
  { id: 'work', label: 'Work', icon: Briefcase },
  { id: 'code', label: 'Code', icon: Code2 },
  { id: 'design', label: 'Design', icon: PenTool },
];

function select(t: SidebarTab) {
  uiStore.setActiveTab(t);
}
</script>

<template>
  <div class="pad-tabbar">
    <button
      v-for="t in tabs"
      :key="t.id"
      class="pad-tab"
      :class="{ 'is-active': activeTab === t.id }"
      :title="t.label"
      @click="select(t.id)"
    >
      <component :is="t.icon" :size="14" :stroke-width="1.75" />
      <span class="pad-tab__label">{{ t.label }}</span>
    </button>
  </div>
</template>

<style scoped>
.pad-tabbar {
  display: flex;
  align-items: center;
  gap: var(--pad-sp-1);
  padding: var(--pad-sp-2) var(--pad-sp-3);
  flex-shrink: 0;
}
.pad-tab {
  display: flex;
  align-items: center;
  gap: var(--pad-sp-1);
  padding: 0 var(--pad-sp-2);
  height: 28px;
  border-radius: var(--pad-radius-md);
  font-size: var(--pad-fs-13);
  font-weight: var(--pad-fw-medium);
  color: var(--pad-fg-secondary);
  background: transparent;
  border: none;
  cursor: pointer;
  transition:
    background var(--pad-dur-fast) ease,
    color var(--pad-dur-fast) ease;
}
.pad-tab:hover {
  background: var(--pad-bg-hover);
  color: var(--pad-fg-primary);
}
.pad-tab.is-active {
  background: var(--pad-bg-active);
  color: var(--pad-fg-primary);
}
/* Collapsed sidebar — hide label */
:global(.pad-sidebar.is-collapsed) .pad-tab__label {
  display: none;
}
</style>
