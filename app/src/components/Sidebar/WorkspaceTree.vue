<script setup lang="ts">
/**
 * WorkspaceTree — workspace + nested sessions + file list.
 * 1:1 mirrors chat.html's task list section.
 */
import { ChevronRight, Plus, List } from 'lucide-vue-next';
import { storeToRefs } from 'pinia';
import { useSessionStore } from '@/stores/session';
import { useUiStore } from '@/stores/ui';
import IconButton from '@/components/ui/IconButton.vue';

const sessionStore = useSessionStore();
const uiStore = useUiStore();
const { workspaces, expandedWorkspaceIds, activeSession } = storeToRefs(sessionStore);

function toggle(id: string) {
  sessionStore.toggleWorkspaceExpanded(id);
}

function selectSession(id: string) {
  uiStore.setActiveSession(id);
}
</script>

<template>
  <div class="pad-tree">
    <div class="pad-tree__header">
      <span class="pad-tree__title">任务列表</span>
      <div class="pad-tree__actions">
        <IconButton :icon="Plus" size="sm" title="添加" />
        <IconButton :icon="List" size="sm" title="切换视图" />
      </div>
    </div>

    <div class="pad-tree__list pad-scroll">
      <div v-for="ws in workspaces" :key="ws.id" class="pad-tree__ws">
        <button class="pad-tree__wsrow" @click="toggle(ws.id)">
          <ChevronRight
            :size="14"
            :stroke-width="1.75"
            class="pad-tree__chev"
            :class="{ 'is-rotated': expandedWorkspaceIds.has(ws.id) }"
          />
          <span class="pad-tree__label">{{ ws.name }}</span>
        </button>

        <div
          v-show="expandedWorkspaceIds.has(ws.id)"
          class="pad-tree__children"
        >
          <button
            v-for="s in sessionStore.getSessionsByWorkspace(ws.id)"
            :key="s.id"
            class="pad-tree__file"
            :class="{ 'is-active': activeSession?.id === s.id }"
            @click="selectSession(s.id)"
          >
            <span class="pad-tree__label">{{ s.title }}</span>
            <List
              v-if="activeSession?.id === s.id"
              :size="14"
              :stroke-width="1.75"
              class="pad-tree__file-icon"
            />
          </button>
          <button
            v-for="f in ws.files"
            :key="f.path"
            class="pad-tree__file pad-tree__file--readonly"
            :title="f.path"
          >
            <span class="pad-tree__label">{{ f.name }}</span>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pad-tree {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
.pad-tree__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--pad-sp-3) var(--pad-sp-4) var(--pad-sp-1);
  flex-shrink: 0;
}
.pad-tree__title {
  font-size: var(--pad-fs-12);
  color: var(--pad-fg-tertiary);
}
.pad-tree__actions {
  display: flex;
  align-items: center;
  gap: 2px;
}
.pad-tree__list {
  flex: 1;
  overflow-y: auto;
  padding: 0 var(--pad-sp-2) var(--pad-sp-2);
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.pad-tree__ws {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.pad-tree__wsrow {
  display: flex;
  align-items: center;
  gap: var(--pad-sp-1);
  width: 100%;
  height: 28px;
  padding: 0 var(--pad-sp-1);
  border-radius: var(--pad-radius-md);
  font-size: var(--pad-fs-13);
  color: var(--pad-fg-secondary);
  background: transparent;
  border: none;
  cursor: pointer;
  text-align: left;
  transition:
    background var(--pad-dur-fast) ease,
    color var(--pad-dur-fast) ease;
}
.pad-tree__wsrow:hover {
  background: var(--pad-bg-hover);
  color: var(--pad-fg-primary);
}
.pad-tree__chev {
  flex-shrink: 0;
  transition: transform var(--pad-dur-fast) var(--pad-ease-in-out);
}
.pad-tree__chev.is-rotated {
  transform: rotate(90deg);
}
.pad-tree__children {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-left: var(--pad-sp-5);
}
.pad-tree__file {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  height: 32px;
  padding: 0 var(--pad-sp-2);
  border-radius: var(--pad-radius-md);
  font-size: var(--pad-fs-12);
  color: var(--pad-fg-secondary);
  background: transparent;
  border: none;
  cursor: pointer;
  text-align: left;
  transition:
    background var(--pad-dur-fast) ease,
    color var(--pad-dur-fast) ease;
}
.pad-tree__file-icon {
  color: var(--pad-fg-tertiary);
  flex-shrink: 0;
}
.pad-tree__file:hover {
  background: var(--pad-bg-hover);
  color: var(--pad-fg-primary);
}
.pad-tree__file.is-active {
  background: var(--pad-bg-active);
  color: var(--pad-fg-primary);
}
.pad-tree__file--readonly {
  cursor: default;
  opacity: 0.7;
}
.pad-tree__file--readonly:hover {
  background: transparent;
  color: var(--pad-fg-secondary);
}
.pad-tree__label {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
  min-width: 0;
}

/* Collapsed sidebar — hide everything except icon */
:global(.pad-sidebar.is-collapsed) .pad-tree {
  display: none;
}
</style>
