<script setup lang="ts">
/**
 * SidebarFunctionList — 4 function rows: 插件市场/自动化/办公助理/模板库.
 * 1:1 mirrors chat.html's nav.function-list block.
 */
import { Plug, Zap, Briefcase, LayoutTemplate, Plus } from 'lucide-vue-next';
import { useSessionStore } from '@/stores/session';
import { pickFolder } from '@/lib/dialog';

const sessionStore = useSessionStore();

/**
 * 新建任务 — 触发流程:
 * 1. 选本地文件夹 (workspace)  [如果是新用户没 workspace]
 * 2. 在 workspace 下加一个 session "新任务"
 * 3. 切到 chat 区
 */
async function createNewTask() {
  if (sessionStore.workspaces.length === 0) {
    // 没 workspace, 先选文件夹
    const path = await pickFolder('选一个本地代码目录, 后面 session 都在这个目录下');
    if (!path) return;
    const ws = sessionStore.addWorkspace({ path });
    sessionStore.addSession(ws.id, '新任务');
  } else {
    // 有 workspace, 在当前 active workspace 加 session
    const wid = sessionStore.activeWorkspaceId ?? sessionStore.workspaces[0].id;
    sessionStore.addSession(wid, '新任务');
  }
}
</script>

<template>
  <nav class="pad-funcnav">
    <button class="pad-newtask" @click="createNewTask">
      <Plus :size="14" :stroke-width="1.75" />
      <span class="pad-funcnav__label">新建任务</span>
    </button>

    <button class="pad-funcrow">
      <Plug :size="16" :stroke-width="1.75" />
      <span class="pad-funcnav__label">插件市场</span>
    </button>
    <button class="pad-funcrow">
      <Zap :size="16" :stroke-width="1.75" />
      <span class="pad-funcnav__label">自动化</span>
    </button>
    <button class="pad-funcrow">
      <Briefcase :size="16" :stroke-width="1.75" />
      <span class="pad-funcnav__label">办公助理</span>
    </button>
    <button class="pad-funcrow">
      <LayoutTemplate :size="16" :stroke-width="1.75" />
      <span class="pad-funcnav__label">模板库</span>
    </button>
  </nav>
</template>

<style scoped>
.pad-funcnav {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 0 var(--pad-sp-2);
  flex-shrink: 0;
}
.pad-funcrow,
.pad-newtask {
  display: flex;
  align-items: center;
  gap: var(--pad-sp-2);
  width: 100%;
  height: 32px;
  padding: 0 var(--pad-sp-3);
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
.pad-newtask {
  color: var(--pad-fg-primary);
  font-weight: var(--pad-fw-medium);
}
.pad-newtask:hover {
  background: var(--pad-bg-hover);
}
.pad-funcrow:hover {
  background: var(--pad-bg-hover);
  color: var(--pad-fg-primary);
}

/* Collapsed sidebar — hide label, center icons */
:global(.pad-sidebar.is-collapsed) .pad-funcrow,
:global(.pad-sidebar.is-collapsed) .pad-newtask {
  justify-content: center;
  padding: 0;
}
:global(.pad-sidebar.is-collapsed) .pad-funcnav__label {
  display: none;
}
</style>
