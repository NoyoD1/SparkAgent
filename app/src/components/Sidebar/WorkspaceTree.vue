<script setup lang="ts">
/**
 * WorkspaceTree — 真实 workspace + session 管理 (Phase 3 v0.3.2+)
 *
 * 数据从 session store 读, 不再用 mock.
 * "+ 加 workspace" → 调 Tauri dialog 选文件夹 → addWorkspace(path)
 * "+ 加 session" → 在当前 workspace 加一个
 * 点击 session → 设为 active
 */
import { ref } from 'vue';
import { storeToRefs } from 'pinia';
import { ChevronRight, Plus, Folder, FolderPlus, MoreHorizontal, Trash2, MessageSquarePlus } from 'lucide-vue-next';
import { useSessionStore } from '@/stores/session';
import { pickFolder } from '@/lib/dialog';
import IconButton from '@/components/ui/IconButton.vue';

const sessionStore = useSessionStore();
const { workspaces, expandedWorkspaceIds, activeSessionId } = storeToRefs(sessionStore);

const pickingFolder = ref(false);
const menuFor = ref<string | null>(null); // workspace id showing menu

async function addWorkspace() {
  if (pickingFolder.value) return;
  pickingFolder.value = true;
  try {
    const path = await pickFolder('选择工作区文件夹 (本地代码目录)');
    if (path) {
      sessionStore.addWorkspace({ path });
    }
  } finally {
    pickingFolder.value = false;
  }
}

function addSessionInWorkspace(workspaceId: string) {
  sessionStore.addSession(workspaceId, '新任务');
  menuFor.value = null;
}

function selectSession(id: string) {
  sessionStore.selectSession(id);
  menuFor.value = null;
}

function toggle(id: string) {
  sessionStore.toggleWorkspaceExpanded(id);
}

function removeWorkspace(id: string) {
  if (!confirm('删除这个工作区? 所有 session 一并删.')) return;
  sessionStore.removeWorkspace(id);
  menuFor.value = null;
}

function removeSession(id: string) {
  if (!confirm('删除这个 session? 消息一并删.')) return;
  sessionStore.removeSession(id);
  menuFor.value = null;
}
</script>

<template>
  <div class="pad-wstree">
    <!-- 顶部: 加 workspace 按钮 -->
    <div class="pad-wstree__top">
      <span class="pad-wstree__top-label">任务列表</span>
      <div class="pad-wstree__top-actions">
        <IconButton
          :icon="FolderPlus"
          size="sm"
          :title="pickingFolder ? '打开文件夹选择...' : '加工作区 (选本地文件夹)'"
          :disabled="pickingFolder"
          @click="addWorkspace"
        />
      </div>
    </div>

    <!-- 列表 -->
    <div class="pad-wstree__list">
      <!-- 空状态 -->
      <div v-if="workspaces.length === 0" class="pad-wstree__empty">
        <Folder :size="20" :stroke-width="1.5" />
        <p>没有工作区</p>
        <button class="pad-wstree__add-btn" :disabled="pickingFolder" @click="addWorkspace">
          <Plus :size="12" :stroke-width="2" />
          <span>选文件夹新建</span>
        </button>
      </div>

      <!-- workspace 列表 -->
      <div v-for="ws in workspaces" :key="ws.id" class="pad-wstree__ws">
        <button
          class="pad-wstree__ws-head"
          :class="{ 'is-active': sessionStore.activeWorkspaceId === ws.id }"
          @click="toggle(ws.id)"
        >
          <ChevronRight
            :size="11"
            :stroke-width="2"
            :class="['pad-wstree__chev', { 'is-open': expandedWorkspaceIds.has(ws.id) }]"
          />
          <Folder :size="13" :stroke-width="1.75" />
          <span class="pad-wstree__ws-name" :title="ws.path">{{ ws.name }}</span>
          <span
            class="pad-wstree__ws-menu"
            :class="{ 'is-shown': menuFor === ws.id }"
            @click.stop="menuFor = menuFor === ws.id ? null : ws.id"
          >
            <MoreHorizontal :size="12" :stroke-width="1.75" />
          </span>
        </button>
        <!-- workspace 菜单 -->
        <div v-if="menuFor === ws.id" class="pad-wstree__ws-menu-pop">
          <button class="pad-wstree__menu-item" @click.stop="addSessionInWorkspace(ws.id)">
            <MessageSquarePlus :size="12" :stroke-width="1.75" />
            <span>新建 session</span>
          </button>
          <button class="pad-wstree__menu-item is-danger" @click.stop="removeWorkspace(ws.id)">
            <Trash2 :size="12" :stroke-width="1.75" />
            <span>删工作区</span>
          </button>
          <div class="pad-wstree__ws-path" :title="ws.path">{{ ws.path }}</div>
        </div>

        <!-- sessions 列表 -->
        <div v-if="expandedWorkspaceIds.has(ws.id)" class="pad-wstree__sessions">
          <button
            v-for="s in sessionStore.getSessionsByWorkspace(ws.id)"
            :key="s.id"
            class="pad-wstree__session"
            :class="{ 'is-active': activeSessionId === s.id }"
            @click="selectSession(s.id)"
          >
            <span class="pad-wstree__session-dot" v-if="activeSessionId === s.id" />
            <span class="pad-wstree__session-title">{{ s.title || '新任务' }}</span>
            <span
              class="pad-wstree__session-del"
              :class="{ 'is-shown': activeSessionId === s.id }"
              title="删 session"
              @click.stop="removeSession(s.id)"
            >
              <Trash2 :size="11" :stroke-width="1.75" />
            </span>
          </button>
          <button
            v-if="sessionStore.getSessionsByWorkspace(ws.id).length === 0"
            class="pad-wstree__session-empty"
            disabled
          >
            暂无 session
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pad-wstree {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--pad-sp-1) var(--pad-sp-2);
  height: 100%;
  min-height: 0;
}
.pad-wstree__top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--pad-sp-2) var(--pad-sp-2) var(--pad-sp-1);
  border-bottom: 1px solid var(--pad-divider);
  margin-bottom: var(--pad-sp-1);
}
.pad-wstree__top-label {
  font-size: var(--pad-fs-11);
  color: var(--pad-fg-tertiary);
  letter-spacing: 0.04em;
  text-transform: uppercase;
  font-weight: var(--pad-fw-medium);
}
.pad-wstree__top-actions {
  display: flex;
  gap: 2px;
}
.pad-wstree__list {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}
.pad-wstree__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: var(--pad-sp-6) var(--pad-sp-3);
  color: var(--pad-fg-tertiary);
  font-size: var(--pad-fs-12);
}
.pad-wstree__empty p {
  margin: 0;
}
.pad-wstree__add-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 26px;
  padding: 0 var(--pad-sp-2);
  background: var(--pad-accent);
  color: var(--pad-fg-inverse);
  border: 1px solid transparent;
  border-radius: var(--pad-radius-sm);
  font-size: var(--pad-fs-12);
  font-weight: var(--pad-fw-medium);
  cursor: pointer;
  font-family: inherit;
}
.pad-wstree__add-btn:hover:not(:disabled) {
  background: var(--pad-accent-hover);
}
.pad-wstree__add-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.pad-wstree__ws {
  margin-bottom: 2px;
}
.pad-wstree__ws-head {
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  padding: 5px 6px;
  border-radius: var(--pad-radius-sm);
  background: transparent;
  border: 1px solid transparent;
  cursor: pointer;
  text-align: left;
  transition: background var(--pad-dur-fast) ease;
  position: relative;
}
.pad-wstree__ws-head:hover {
  background: var(--pad-bg-hover);
}
.pad-wstree__ws-head.is-active {
  background: var(--pad-bg-active);
}
.pad-wstree__chev {
  color: var(--pad-fg-tertiary);
  transition: transform var(--pad-dur-fast) ease;
  flex-shrink: 0;
}
.pad-wstree__chev.is-open {
  transform: rotate(90deg);
}
.pad-wstree__ws-name {
  flex: 1;
  font-size: var(--pad-fs-12);
  font-weight: var(--pad-fw-medium);
  color: var(--pad-fg-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.pad-wstree__ws-menu {
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--pad-fg-tertiary);
  border-radius: var(--pad-radius-sm);
  cursor: pointer;
  opacity: 0;
  transition: opacity var(--pad-dur-fast) ease, background var(--pad-dur-fast) ease;
}
.pad-wstree__ws-head:hover .pad-wstree__ws-menu,
.pad-wstree__ws-menu.is-shown {
  opacity: 1;
}
.pad-wstree__ws-menu:hover {
  background: var(--pad-bg-elevated);
  color: var(--pad-fg-primary);
}
.pad-wstree__ws-menu-pop {
  margin: 2px 0 4px 20px;
  padding: 4px;
  background: var(--pad-bg-elevated);
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-md);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.06);
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.pad-wstree__menu-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px;
  border: none;
  background: transparent;
  border-radius: var(--pad-radius-sm);
  font-size: var(--pad-fs-12);
  color: var(--pad-fg-primary);
  cursor: pointer;
  text-align: left;
  font-family: inherit;
}
.pad-wstree__menu-item:hover {
  background: var(--pad-bg-hover);
}
.pad-wstree__menu-item.is-danger {
  color: var(--pad-danger-text);
}
.pad-wstree__menu-item.is-danger:hover {
  background: var(--pad-danger-subtle);
}
.pad-wstree__ws-path {
  padding: 4px 6px;
  font-size: var(--pad-fs-10);
  color: var(--pad-fg-tertiary);
  font-family: var(--pad-font-mono);
  word-break: break-all;
  border-top: 1px solid var(--pad-divider);
  margin-top: 2px;
}
.pad-wstree__sessions {
  margin-left: 18px;
  padding-left: 4px;
  border-left: 1px solid var(--pad-divider);
  display: flex;
  flex-direction: column;
  gap: 1px;
  margin-top: 2px;
  margin-bottom: 4px;
}
.pad-wstree__session {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px;
  border-radius: var(--pad-radius-sm);
  background: transparent;
  border: 1px solid transparent;
  cursor: pointer;
  text-align: left;
  font-size: var(--pad-fs-12);
  color: var(--pad-fg-secondary);
  font-family: inherit;
  position: relative;
}
.pad-wstree__session:hover {
  background: var(--pad-bg-hover);
  color: var(--pad-fg-primary);
}
.pad-wstree__session.is-active {
  background: var(--pad-accent-soft);
  color: var(--pad-accent);
  font-weight: var(--pad-fw-medium);
}
.pad-wstree__session-dot {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--pad-accent);
  flex-shrink: 0;
}
.pad-wstree__session-title {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.pad-wstree__session-del {
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--pad-fg-tertiary);
  border-radius: var(--pad-radius-sm);
  cursor: pointer;
  opacity: 0;
  transition: opacity var(--pad-dur-fast) ease;
}
.pad-wstree__session:hover .pad-wstree__session-del,
.pad-wstree__session-del.is-shown {
  opacity: 1;
}
.pad-wstree__session-del:hover {
  background: var(--pad-danger-subtle);
  color: var(--pad-danger-text);
}
.pad-wstree__session-empty {
  padding: 3px 6px;
  font-size: var(--pad-fs-11);
  color: var(--pad-fg-tertiary);
  background: transparent;
  border: 1px dashed var(--pad-border);
  border-radius: var(--pad-radius-sm);
  cursor: default;
  text-align: center;
}
</style>
