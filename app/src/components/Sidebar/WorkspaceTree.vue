<script setup lang="ts">
/**
 * WorkspaceTree — 真实 workspace + session 管理 (Phase 3 v0.3.2+)
 *
 * v0.3.6+ 重做:
 * 1. 参考 Pi-Agent-Design.design/reference/3.png 的视觉: section labels + file icons + chevrons
 * 2. Session hover 预览 popover 位置动态 (跟 hovered session bbox 对齐, 右边越界翻左边)
 * 3. 顶部 "项目" section label (跟 sidebar 其他 label 风格统一)
 *
 * v0.5.0-v0.1: 删底部 "Agent 团队" group (回滚 multi-agent persona, user 16:24 拍板
 *   "agent 是边界定义/思维指导, 不需要切换, single agent 链路拉动"). 删 hardcoded
 *   "Code Reviewer / Refactor / + 更多即将推出" placeholder + v0.4.6.2 改造的
 *   真实数据 group + 折叠 state + 切主 button. Sidebar 回到 v0.4.6 之前形态.
 *
 * v0.6.0 Phase 1: session store +6 fields / +8 actions / +4 getters; 新建 ConfirmDialog
 *   (Common) + SessionContextMenu (Sidebar) 通用组件.
 *
 * v0.6.0 Phase 2: rename inline (dblclick) + right-click kebab menu + Pin to top section
 *   (📌 Pinned) 在每个 workspace 树顶部. 不破坏现有 active section 渲染逻辑.
 *
 * v0.6.0 Phase 3: 归档/恢复/永久删除流.
 *   - active session 顶右 inline 按钮: ❌删 → 📦Archive (走 ConfirmDialog → archiveSession)
 *   - sidebar 顶层 🗄 归档 section (workspace 列表外, 同滚动区底部, 不嵌套到任何 ws)
 *   - 归档项显示 [from A] 源工作区角标
 *   - archive 列表右键 → Restore / Delete permanently (后者走 danger ConfirmDialog)
 *   - 旧 store.removeSession 保留 (其他 code path 可能用), UI 入口全部走 archive 流
 *
 * v0.6.0 Phase 4: Tag chip 显示 + add-tag 接通.
 *   - session item 标题下加第二行 tag chip row (小字, sub-color, 仅当 tags.length > 0 才显示)
 *   - chip 点击直接 removeTag (轻量操作, 不走 confirm)
 *   - 右键菜单 'Add tag...' 已由 SessionContextMenu 内部变 input (Phase 4 wired)
 *   - onContextMenuAction.add-tag → sessionStore.addTag
 *
 * v0.6.0 Phase 5: 顶层 search bar (跨 workspace + 跨 archive).
 *   - sidebar 顶部 🔍 input, v-model searchQuery
 *   - searchQuery 非空时: 替换整个 workspace tree + archive section 为结果列表
 *   - 结果: 复用 session item + 加 [from X] workspace 角标 + match hint
 *   - 点结果: selectSession + 清空 search
 *   - Esc (input 上): 有 query 时清空, 无 query 时 blur
 *   - × 按钮: 清空 search
 *   - 搜索逻辑: store.searchSessions 同步本地跑, 不 debounce (1000 session <10ms)
 *
 * v0.6.0 Phase 6: 显示 s.autoTitle (LLM 自动生成) > s.title (user 手动) > '新任务'.
 *   - 3 处 session item 标题 + hover preview 标题 + Archive/Delete confirm message
 *   - 触发在 chat.ts sendPrompt first message 检测, 跟本组件无关
 */
import { ref, computed, nextTick } from 'vue';
import { storeToRefs } from 'pinia';
import {
  ChevronRight,
  Folder,
  Plus,
  Trash2,
  Archive,
  MessageCircle,
  Search,
  X,
} from 'lucide-vue-next';
import { useSessionStore } from '@/stores/session';
import { useChatStore } from '@/stores/chat';
import { pickFolder } from '@/lib/dialog';
import SessionContextMenu from './SessionContextMenu.vue';
import ConfirmDialog from '@/components/Common/ConfirmDialog.vue';

const sessionStore = useSessionStore();
const chatStore = useChatStore();
const { workspaces, expandedWorkspaceIds, activeSessionId } = storeToRefs(sessionStore);

const pickingFolder = ref(false);

// ===== session hover 预览 popover =====
const hoverSessionId = ref<string | null>(null);
const popoverLeft = ref(0);
const popoverTop = ref(0);
let hoverTimer: number | null = null;
let hideTimer: number | null = null;

interface SessionPreview {
  title: string;
  path: string;
  firstUser: string;
  messageCount: number;
  updatedAt: string;
}
function getSessionPreview(sessionId: string): SessionPreview | null {
  const s = sessionStore.sessions.find((x) => x.id === sessionId);
  if (!s) return null;
  const ws = sessionStore.workspaces.find((w) => w.id === s.workspaceId);
  const msgs = chatStore.getMessages(sessionId);
  const firstUser = msgs.find((m) => m.role === 'user');
  return {
    // Phase 6: 优先 autoTitle (LLM 生成), fallback title (user 手动改), 再 fallback '新任务'
    title: s.autoTitle || s.title || '新任务',
    path: ws?.path ?? '(无工作区)',
    firstUser: firstUser?.content ?? '',
    messageCount: msgs.length,
    updatedAt: s.updatedAt,
  };
}
function formatRelative(ts: string): string {
  const d = new Date(ts);
  const now = Date.now();
  const diffMs = now - d.getTime();
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} 天前`;
  return d.toLocaleDateString();
}
const hoverPreview = computed<SessionPreview | null>(() => {
  if (!hoverSessionId.value) return null;
  return getSessionPreview(hoverSessionId.value);
});

function onSessionEnter(e: MouseEvent, id: string) {
  if (hideTimer) {
    window.clearTimeout(hideTimer);
    hideTimer = null;
  }
  if (hoverTimer) window.clearTimeout(hoverTimer);
  hoverTimer = window.setTimeout(() => {
    positionPopover(e.currentTarget as HTMLElement);
    hoverSessionId.value = id;
  }, 220);
}
function onSessionMove(e: MouseEvent) {
  // 鼠标在 session 元素内移动时, popover 跟着 bbox 走 (避免 sticky 偏移)
  if (!hoverSessionId.value) return;
  positionPopover(e.currentTarget as HTMLElement);
}
function onSessionLeave() {
  if (hoverTimer) {
    window.clearTimeout(hoverTimer);
    hoverTimer = null;
  }
  hideTimer = window.setTimeout(() => {
    hoverSessionId.value = null;
  }, 80);
}
function onPopoverEnter() {
  // 用户从 session 元素 hover 进 popover 内, 取消关闭 timer
  if (hideTimer) {
    window.clearTimeout(hideTimer);
    hideTimer = null;
  }
}
function positionPopover(target: HTMLElement | null) {
  if (!target) return;
  const rect = target.getBoundingClientRect();
  const POPOVER_W = 300;
  const GAP = 8;
  // 默认贴在右侧; 右边放不下就翻到左边
  let left = rect.right + GAP;
  if (left + POPOVER_W > window.innerWidth - 8) {
    left = rect.left - POPOVER_W - GAP;
  }
  if (left < 8) left = 8;
  // 垂直对齐到 session 中部
  const top = rect.top + rect.height / 2;
  popoverLeft.value = left;
  popoverTop.value = top;
}

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
}
function selectSession(id: string) {
  sessionStore.selectSession(id);
}
function toggle(id: string) {
  sessionStore.toggleWorkspaceExpanded(id);
}
function removeWorkspace(id: string) {
  if (!confirm('删除这个工作区? 所有 session 一并删.')) return;
  sessionStore.removeWorkspace(id);
}

// ====== Phase 2: Rename inline + 右键菜单 state ======

const renamingSessionId = ref<string | null>(null);
const renameValue = ref('');
const renameInputEl = ref<HTMLInputElement | null>(null);

const contextMenuSessionId = ref<string | null>(null);
const contextMenuX = ref(0);
const contextMenuY = ref(0);

const contextMenuSession = computed(() => {
  if (!contextMenuSessionId.value) return null;
  return sessionStore.sessions.find((s) => s.id === contextMenuSessionId.value) ?? null;
});

/**
 * 当前 workspace 下未 pinned 的 active session (active section 用)
 * pinned section 单独渲染, 避免重复
 */
function activeNonPinned(wsId: string) {
  return sessionStore.activeSessionsByWorkspace(wsId).filter((s) => !s.pinned);
}

async function onStartRename(id: string) {
  const s = sessionStore.sessions.find((x) => x.id === id);
  if (!s) return;
  // 切换目标前先取消正在 rename 的
  renamingSessionId.value = id;
  renameValue.value = s.title;
  await nextTick();
  // focus + select all
  renameInputEl.value?.focus();
  renameInputEl.value?.select();
}

function onConfirmRename() {
  if (!renamingSessionId.value) return;
  const id = renamingSessionId.value;
  const newTitle = renameValue.value.trim();
  if (newTitle) {
    sessionStore.renameSession(id, newTitle);
  }
  renamingSessionId.value = null;
  renameValue.value = '';
}

function onCancelRename() {
  renamingSessionId.value = null;
  renameValue.value = '';
}

function onContextMenu(e: MouseEvent, id: string) {
  e.preventDefault();
  // 正在 rename 同一个 session, 不弹菜单
  if (renamingSessionId.value === id) return;
  contextMenuSessionId.value = id;
  contextMenuX.value = e.clientX;
  contextMenuY.value = e.clientY;
}

function closeContextMenu() {
  contextMenuSessionId.value = null;
}

function onContextMenuAction(payload: { type: string; payload?: any }) {
  const sessionId = contextMenuSessionId.value;
  if (!sessionId) return;
  switch (payload.type) {
    case 'pin':
      sessionStore.setPinned(sessionId, true);
      break;
    case 'unpin':
      sessionStore.setPinned(sessionId, false);
      break;
    case 'rename':
      onStartRename(sessionId);
      break;
    case 'add-tag':
      if (payload.payload?.tag) {
        sessionStore.addTag(sessionId, payload.payload.tag);
      }
      break;
    case 'remove-tag':
      if (payload.payload?.tag) {
        sessionStore.removeTag(sessionId, payload.payload.tag);
      }
      break;
    case 'archive':
      requestArchive(sessionId);
      break;
    case 'restore':
      // restore 不需要 confirm, 单步可逆操作
      sessionStore.restoreSession(sessionId);
      break;
    case 'delete-permanently':
      requestDeletePermanently(sessionId);
      break;
  }
}

// ====== Phase 3: 归档 / 永久删除 ConfirmDialog 流 ======

const confirmOpen = ref(false);
const confirmTitle = ref('');
const confirmMessage = ref('');
const confirmLabel = ref('确定');
const confirmDanger = ref(false);
let confirmCallback: (() => void) | null = null;

function showConfirm(opts: {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
}) {
  confirmTitle.value = opts.title;
  confirmMessage.value = opts.message;
  confirmLabel.value = opts.confirmLabel ?? '确定';
  confirmDanger.value = opts.danger ?? false;
  confirmCallback = opts.onConfirm;
  confirmOpen.value = true;
}

function onConfirmAction() {
  const cb = confirmCallback;
  confirmCallback = null;
  cb?.();
}

/** workspace 名字 lookup (archive section 角标用) */
function getWorkspaceName(workspaceId: string): string {
  return sessionStore.getWorkspace(workspaceId)?.name ?? '(已删工作区)';
}

function requestArchive(sessionId: string) {
  const s = sessionStore.sessions.find((x) => x.id === sessionId);
  if (!s) return;
  showConfirm({
    title: '归档这个 session?',
    message: `「${s.autoTitle || s.title || '新任务'}」\n\n归档后会从工作区列表移除, 可在底部归档区恢复或永久删除.`,
    confirmLabel: '归档',
    onConfirm: () => {
      sessionStore.archiveSession(sessionId);
    },
  });
}

function requestDeletePermanently(sessionId: string) {
  const s = sessionStore.sessions.find((x) => x.id === sessionId);
  if (!s) return;
  showConfirm({
    title: '永久删除这个 session?',
    message: `「${s.autoTitle || s.title || '新任务'}」\n\n此操作不可撤销.\n\nPi SDK 的对话历史仍保留在本地 jsonl 文件中, 但前端不再可见.`,
    confirmLabel: '永久删除',
    danger: true,
    onConfirm: () => {
      sessionStore.deleteSessionPermanently(sessionId);
    },
  });
}

// ====== Phase 5: 顶层 search (跨 workspace + 跨 archive) ======

const searchQuery = ref('');
const searchInputEl = ref<HTMLInputElement | null>(null);

/** store.searchSessions 包装成 computed, 仅当 query 非空时跑 */
const searchResults = computed(() => {
  const q = searchQuery.value.trim();
  if (!q) return [];
  return sessionStore.searchSessions(q);
});

function clearSearch() {
  searchQuery.value = '';
  // 让 input 保持焦点方便继续输入
}

function onSearchEsc(e: KeyboardEvent) {
  if (searchQuery.value) {
    e.preventDefault();
    e.stopPropagation();
    clearSearch();
  } else {
    // 无 query, blur 让焦点还给 sidebar
    (e.target as HTMLInputElement).blur();
  }
}

function onSelectFromSearch(id: string) {
  sessionStore.selectSession(id);
  clearSearch();
  // 让焦点从 input 拿开, 避免继续输入触发搜索
  searchInputEl.value?.blur();
}

function matchHint(match: 'title' | 'autoTitle' | `tag:${string}`): string {
  if (match === 'title') return '匹配标题';
  if (match === 'autoTitle') return '匹配自动标题';
  return `匹配 tag: ${match.slice(4)}`;
}
</script>

<template>
  <div class="pad-wstree">
    <!-- ====== Phase 5: 顶部 search bar (跨 workspace + 跨 archive, 始终可见) ====== -->
    <div class="pad-wstree__search">
      <Search :size="12" :stroke-width="1.75" class="pad-wstree__search-icon" />
      <input
        ref="searchInputEl"
        v-model="searchQuery"
        type="text"
        class="pad-wstree__search-input"
        placeholder="搜索 session (跨工作区 + 归档)..."
        @keydown.escape="onSearchEsc"
      />
      <button
        v-if="searchQuery"
        type="button"
        class="pad-wstree__search-clear"
        title="清空搜索"
        @click="clearSearch"
      >
        <X :size="11" :stroke-width="2" />
      </button>
    </div>

    <!-- ====== Phase 5: 搜索结果 (searchQuery 非空时显示) ====== -->
    <template v-if="searchQuery">
      <div class="pad-wstree__list">
        <div class="pad-wstree__sub-label">
          <span class="pad-wstree__sub-label-icon">
            <Search :size="11" :stroke-width="1.75" />
            搜索结果
          </span>
          <span class="pad-wstree__count">{{ searchResults.length }}</span>
        </div>
        <div
          v-for="r in searchResults"
          :key="'search-' + r.session.id"
          class="pad-wstree__session pad-wstree__session--search-result"
          :class="{
            'is-active': activeSessionId === r.session.id,
            'is-archived': r.session.archived,
          }"
          @click="onSelectFromSearch(r.session.id)"
          @mouseenter="(e) => onSessionEnter(e, r.session.id)"
          @mousemove="onSessionMove"
          @mouseleave="onSessionLeave"
        >
          <span class="pad-wstree__session-dot" v-if="activeSessionId === r.session.id" />
          <Archive
            v-else-if="r.session.archived"
            :size="11"
            :stroke-width="1.75"
            class="pad-wstree__session-icon"
          />
          <MessageCircle
            v-else
            :size="11"
            :stroke-width="1.75"
            class="pad-wstree__session-icon"
          />
          <div class="pad-wstree__session-body">
            <span class="pad-wstree__session-title">{{ r.session.title || '新任务' }}</span>
            <div class="pad-wstree__session-meta">
              <span
                class="pad-wstree__session-from"
                :title="`来自工作区: ${getWorkspaceName(r.session.workspaceId)}`"
              >
                [from {{ getWorkspaceName(r.session.workspaceId) }}]
              </span>
              <span class="pad-wstree__session-match">· {{ matchHint(r.match) }}</span>
            </div>
          </div>
        </div>
        <div v-if="searchResults.length === 0" class="pad-wstree__search-empty">
          <Search :size="20" :stroke-width="1.5" />
          <p>没有匹配 "{{ searchQuery }}"</p>
          <p class="pad-wstree__empty-hint">试试其他关键词 (标题 / 自动标题 / tag)</p>
        </div>
      </div>
    </template>

    <!-- ====== 正常 view (searchQuery 空时) ====== -->
    <template v-else>
    <!-- ====== 顶部: 任务列表 section label + 加 workspace 按钮 ====== -->
    <div class="pad-wstree__head">
      <span class="pad-wstree__section-label">
        <Folder :size="12" :stroke-width="1.75" />
        <span>项目</span>
      </span>
      <button
        class="pad-wstree__head-add"
        :disabled="pickingFolder"
        :title="pickingFolder ? '打开文件夹选择...' : '加工作区'"
        @click="addWorkspace"
      >
        <Plus :size="12" :stroke-width="2" />
      </button>
    </div>

    <!-- ====== 项目 / workspace 列表 ====== -->
    <div class="pad-wstree__list">
      <!-- 空状态: v0.3.5+ 引导去中间 tab strip -->
      <div v-if="workspaces.length === 0" class="pad-wstree__empty">
        <Folder :size="20" :stroke-width="1.5" />
        <p>没有工作区</p>
        <p class="pad-wstree__empty-hint">点中间"本地"下拉新建</p>
      </div>

      <!-- workspace 列表 -->
      <div v-for="ws in workspaces" :key="ws.id" class="pad-wstree__ws">
        <div
          class="pad-wstree__ws-head"
          :class="{ 'is-active': sessionStore.activeWorkspaceId === ws.id }"
          @click="toggle(ws.id)"
        >
          <ChevronRight
            :size="11"
            :stroke-width="2"
            :class="['pad-wstree__chev', { 'is-open': expandedWorkspaceIds.has(ws.id) }]"
          />
          <Folder :size="13" :stroke-width="1.75" class="pad-wstree__ws-icon" />
          <span class="pad-wstree__ws-name" :title="ws.path">{{ ws.name }}</span>
          <!-- v0.3.8.12: inline actions 替代二级 popover, 鼠标进入 ws-head 时显示 -->
          <div class="pad-wstree__ws-actions">
            <button
              class="pad-wstree__ws-action"
              title="新建 session"
              @click.stop="addSessionInWorkspace(ws.id)"
            >
              <Plus :size="12" :stroke-width="1.75" />
            </button>
            <button
              class="pad-wstree__ws-action is-danger"
              title="删工作区"
              @click.stop="removeWorkspace(ws.id)"
            >
              <Trash2 :size="12" :stroke-width="1.75" />
            </button>
          </div>
        </div>

        <!-- sessions 列表 (Phase 2: pinned section + active section + inline rename + context menu) -->
        <Transition name="pad-wsexpand">
          <div v-if="expandedWorkspaceIds.has(ws.id)" class="pad-wstree__sessions">
            <!-- 📌 Pinned section (Phase 2) -->
            <template v-if="sessionStore.pinnedSessionsByWorkspace(ws.id).length > 0">
              <div class="pad-wstree__sub-label">
                <span>📌 Pinned</span>
                <span class="pad-wstree__count">{{ sessionStore.pinnedSessionsByWorkspace(ws.id).length }}</span>
              </div>
              <div
                v-for="s in sessionStore.pinnedSessionsByWorkspace(ws.id)"
                :key="'pinned-' + s.id"
                class="pad-wstree__session"
                :class="{
                  'is-active': activeSessionId === s.id,
                  'is-streaming': chatStore.isStreamingSession(s.id),
                }"
                @click="selectSession(s.id)"
                @dblclick.stop="onStartRename(s.id)"
                @contextmenu.prevent="onContextMenu($event, s.id)"
                @mouseenter="(e) => onSessionEnter(e, s.id)"
                @mousemove="onSessionMove"
                @mouseleave="onSessionLeave"
              >
                <span class="pad-wstree__session-dot" v-if="activeSessionId === s.id" />
                <MessageCircle v-else :size="11" :stroke-width="1.75" class="pad-wstree__session-icon" />
                <div class="pad-wstree__session-body">
                  <!-- inline rename input -->
                  <input
                    v-if="renamingSessionId === s.id"
                    ref="renameInputEl"
                    v-model="renameValue"
                    class="pad-wstree__session-rename-input"
                    @keydown.enter.prevent="onConfirmRename"
                    @keydown.escape.prevent="onCancelRename"
                    @blur="onConfirmRename"
                    @click.stop
                    @dblclick.stop
                    @contextmenu.stop
                  />
                  <span v-else class="pad-wstree__session-title">
                    <span v-if="s.pinned" class="pad-wstree__session-pin">📌</span>
                    {{ s.autoTitle || s.title || '新任务' }}
                  </span>
                  <!-- Phase 4: tag chip row (仅当有 tag 且不在 rename 才显示) -->
                  <div
                    v-if="s.tags && s.tags.length > 0 && renamingSessionId !== s.id"
                    class="pad-wstree__session-tags"
                  >
                    <button
                      v-for="t in s.tags"
                      :key="t"
                      type="button"
                      class="pad-wstree__session-tag"
                      :title="`删除 tag: ${t}`"
                      @click.stop="sessionStore.removeTag(s.id, t)"
                    >#{{ t }}</button>
                  </div>
                </div>
                <!-- Phase 3: inline 按钮: 📦Archive (替代旧 Trash2 delete) -->
                <button
                  class="pad-wstree__session-action"
                  title="归档 (移动到底部归档区)"
                  @click.stop="requestArchive(s.id)"
                >
                  <Archive :size="11" :stroke-width="1.75" />
                </button>
              </div>
            </template>

            <!-- Active section (Phase 2) -->
            <template v-if="activeNonPinned(ws.id).length > 0">
              <div class="pad-wstree__sub-label">
                <span>Active</span>
                <span class="pad-wstree__count">{{ activeNonPinned(ws.id).length }}</span>
              </div>
            </template>
            <div
              v-for="s in activeNonPinned(ws.id)"
              :key="s.id"
              class="pad-wstree__session"
              :class="{
                'is-active': activeSessionId === s.id,
                'is-streaming': chatStore.isStreamingSession(s.id),
              }"
              @click="selectSession(s.id)"
              @dblclick.stop="onStartRename(s.id)"
              @contextmenu.prevent="onContextMenu($event, s.id)"
              @mouseenter="(e) => onSessionEnter(e, s.id)"
              @mousemove="onSessionMove"
              @mouseleave="onSessionLeave"
            >
              <span class="pad-wstree__session-dot" v-if="activeSessionId === s.id" />
              <MessageCircle v-else :size="11" :stroke-width="1.75" class="pad-wstree__session-icon" />
              <div class="pad-wstree__session-body">
                <input
                  v-if="renamingSessionId === s.id"
                  ref="renameInputEl"
                  v-model="renameValue"
                  class="pad-wstree__session-rename-input"
                  @keydown.enter.prevent="onConfirmRename"
                  @keydown.escape.prevent="onCancelRename"
                  @blur="onConfirmRename"
                  @click.stop
                  @dblclick.stop
                  @contextmenu.stop
                />
                <span v-else class="pad-wstree__session-title">{{ s.autoTitle || s.title || '新任务' }}</span>
                <!-- Phase 4: tag chip row -->
                <div
                  v-if="s.tags && s.tags.length > 0 && renamingSessionId !== s.id"
                  class="pad-wstree__session-tags"
                >
                  <button
                    v-for="t in s.tags"
                    :key="t"
                    type="button"
                    class="pad-wstree__session-tag"
                    :title="`删除 tag: ${t}`"
                    @click.stop="sessionStore.removeTag(s.id, t)"
                  >#{{ t }}</button>
                </div>
              </div>
              <button
                class="pad-wstree__session-action"
                title="归档 (移动到底部归档区)"
                @click.stop="requestArchive(s.id)"
              >
                <Archive :size="11" :stroke-width="1.75" />
              </button>
            </div>

            <button
              v-if="sessionStore.activeSessionsByWorkspace(ws.id).length === 0"
              class="pad-wstree__session-empty"
              disabled
            >
              暂无 session
            </button>
          </div>
        </Transition>
      </div>

      <!-- ====== Phase 3: 顶层 归档 section (workspace 列表外, sidebar 同一滚动区底部) ====== -->
      <template v-if="sessionStore.archivedSessions.length > 0">
        <div class="pad-wstree__divider" />
        <div class="pad-wstree__sub-label">
          <span class="pad-wstree__sub-label-icon">
            <Archive :size="11" :stroke-width="1.75" />
            归档
          </span>
          <span class="pad-wstree__count">{{ sessionStore.archivedSessions.length }}</span>
        </div>
        <div
          v-for="s in sessionStore.archivedSessions"
          :key="'archived-' + s.id"
          class="pad-wstree__session pad-wstree__session--archived"
          :class="{
            'is-active': activeSessionId === s.id,
          }"
          @click="selectSession(s.id)"
          @contextmenu.prevent="onContextMenu($event, s.id)"
          @mouseenter="(e) => onSessionEnter(e, s.id)"
          @mousemove="onSessionMove"
          @mouseleave="onSessionLeave"
        >
          <span class="pad-wstree__session-dot" v-if="activeSessionId === s.id" />
          <Archive v-else :size="11" :stroke-width="1.75" class="pad-wstree__session-icon" />
          <div class="pad-wstree__session-body">
            <span class="pad-wstree__session-title">
              {{ s.autoTitle || s.title || '新任务' }}
              <span class="pad-wstree__session-from" :title="`来自工作区: ${getWorkspaceName(s.workspaceId)}`">
                [from {{ getWorkspaceName(s.workspaceId) }}]
              </span>
            </span>
            <!-- Phase 4: tag chip row (archived session 不支持 inline rename, 直接显示) -->
            <div
              v-if="s.tags && s.tags.length > 0"
              class="pad-wstree__session-tags"
            >
              <button
                v-for="t in s.tags"
                :key="t"
                type="button"
                class="pad-wstree__session-tag"
                :title="`删除 tag: ${t}`"
                @click.stop="sessionStore.removeTag(s.id, t)"
              >#{{ t }}</button>
            </div>
          </div>
        </div>
      </template>
    </div>
    </template>
    <!-- /v-else 正常 view -->

    <!-- v0.5.0-v0.1: 删底部 "Agent 团队" group (回滚 multi-agent persona) -->

    <!-- ====== Phase 2: Session 右键菜单 (Teleport 到 body) ====== -->
    <SessionContextMenu
      v-if="contextMenuSession"
      :x="contextMenuX"
      :y="contextMenuY"
      :session="contextMenuSession"
      @action="onContextMenuAction"
      @close="closeContextMenu"
    />

    <!-- ====== Phase 3: 通用 ConfirmDialog (Teleport 到 body) ====== -->
    <ConfirmDialog
      v-model:open="confirmOpen"
      :title="confirmTitle"
      :message="confirmMessage"
      :confirm-label="confirmLabel"
      :danger="confirmDanger"
      @confirm="onConfirmAction"
    />

    <!-- ====== Session hover 预览 popover (Teleport 到 body) ====== -->
    <Teleport to="body">
      <Transition name="pad-preview">
        <div
          v-if="hoverPreview"
          class="pad-session-preview"
          role="tooltip"
          :style="{
            left: popoverLeft + 'px',
            top: popoverTop + 'px',
            transform: 'translateY(-50%)',
          }"
          @mouseenter="onPopoverEnter"
          @mouseleave="onSessionLeave"
        >
          <div class="pad-session-preview__title">{{ hoverPreview.title }}</div>
          <div class="pad-session-preview__path" :title="hoverPreview.path">
            <Folder :size="11" :stroke-width="1.75" />
            <span>{{ hoverPreview.path }}</span>
          </div>
          <div v-if="hoverPreview.firstUser" class="pad-session-preview__msg">
            <MessageCircle :size="11" :stroke-width="1.75" />
            <span>{{ hoverPreview.firstUser }}</span>
          </div>
          <div v-else class="pad-session-preview__msg is-empty">
            <MessageCircle :size="11" :stroke-width="1.75" />
            <span>暂无消息</span>
          </div>
          <div class="pad-session-preview__meta">
            <span>{{ hoverPreview.messageCount }} 条消息</span>
            <span class="pad-session-preview__dot">·</span>
            <span>{{ formatRelative(hoverPreview.updatedAt) }}</span>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.pad-wstree {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--pad-sp-1) var(--pad-sp-2) 0;
  height: 100%;
  min-height: 0;
}

/* ====== 顶部 section label ====== */
.pad-wstree__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--pad-sp-2) var(--pad-sp-2) var(--pad-sp-1);
}
.pad-wstree__section-label {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: var(--pad-fs-11);
  color: var(--pad-fg-tertiary);
  letter-spacing: 0.04em;
  text-transform: uppercase;
  font-weight: var(--pad-fw-medium);
  user-select: none;
}
.pad-wstree__head-add {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: var(--pad-radius-sm);
  background: transparent;
  border: none;
  color: var(--pad-fg-tertiary);
  cursor: pointer;
  transition: background var(--pad-dur-fast) ease, color var(--pad-dur-fast) ease;
}
.pad-wstree__head-add:hover:not(:disabled) {
  background: var(--pad-bg-hover);
  color: var(--pad-fg-primary);
}
.pad-wstree__head-add:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* ====== 列表 ====== */
.pad-wstree__list {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
  /* v0.3.8.20: 隐藏原生滚动条 (用户反馈 sidebar 这边滑动条太丑, 跟 minimalist 不搭)
   * 保留 overflow-y: auto + 滚轮/触屏可以滚, 只是不显示条.
   * 跟 ChatMessageNav 一样的方案, 兼容 Firefox + WebKit/Edge. */
  scrollbar-width: none;
  -ms-overflow-style: none;
}
.pad-wstree__list::-webkit-scrollbar {
  display: none;
}
.pad-wstree__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: var(--pad-sp-6) var(--pad-sp-3);
  color: var(--pad-fg-tertiary);
  font-size: var(--pad-fs-12);
}
.pad-wstree__empty p { margin: 0; }
.pad-wstree__empty-hint {
  font-size: var(--pad-fs-11);
  color: var(--pad-fg-tertiary);
  opacity: 0.7;
}

/* ====== workspace 行 ====== */
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
.pad-wstree__ws-icon {
  color: var(--pad-fg-secondary);
  flex-shrink: 0;
}
.pad-wstree__ws-name {
  flex: 1;
  font-size: var(--pad-fs-12);
  font-weight: var(--pad-fw-medium);
  color: var(--pad-fg-primary);
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
  background: transparent;
  border: none;
  border-radius: var(--pad-radius-sm);
  cursor: pointer;
  opacity: 0;
  transition: opacity var(--pad-dur-fast) ease, background var(--pad-dur-fast) ease, color var(--pad-dur-fast) ease;
}
.pad-wstree__ws-head:hover .pad-wstree__ws-menu,
.pad-wstree__ws-menu.is-shown {
  opacity: 1;
}
.pad-wstree__ws-menu:hover {
  background: var(--pad-bg-elevated);
  color: var(--pad-fg-primary);
}

/* v0.3.8.12: inline actions 替代二级 popover — 鼠标 hover ws-head 时显示 */
.pad-wstree__ws-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
  opacity: 0;
  transition: opacity var(--pad-dur-fast) ease;
}
.pad-wstree__ws-head:hover .pad-wstree__ws-actions,
.pad-wstree__ws-head:focus-within .pad-wstree__ws-actions {
  opacity: 1;
}
.pad-wstree__ws-action {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  background: transparent;
  border: none;
  border-radius: var(--pad-radius-sm);
  color: var(--pad-fg-tertiary);
  cursor: pointer;
  transition: background var(--pad-dur-fast) ease, color var(--pad-dur-fast) ease;
  flex-shrink: 0;
}
.pad-wstree__ws-action:hover {
  background: var(--pad-bg-hover);
  color: var(--pad-fg-primary);
}
.pad-wstree__ws-action.is-danger:hover {
  background: var(--pad-danger-subtle);
  color: var(--pad-danger-text);
}

/* ====== session 行 ====== */
.pad-wstree__sessions {
  margin-left: 14px;
  padding-left: 8px;
  border-left: 1px solid var(--pad-divider);
  display: flex;
  flex-direction: column;
  gap: 1px;
  margin-top: 2px;
  margin-bottom: 4px;
  overflow: hidden;
}
.pad-wstree__session {
  display: flex;
  align-items: center;
  gap: 6px;
  /* v0.4.1.5+: 紧凑 padding, 避免 item 上下超宽 (用户反馈上下超宽只能一行显示) */
  padding: 3px 8px;
  border-radius: var(--pad-radius-lg);
  background: transparent;
  border: 1px solid transparent;
  cursor: pointer;
  text-align: left;
  font-size: var(--pad-fs-12);
  color: var(--pad-fg-secondary);
  font-family: inherit;
  position: relative;
  width: 100%;
  transition:
    background var(--pad-dur-fast) ease,
    color var(--pad-dur-fast) ease,
    transform var(--pad-dur-fast) ease;
}
.pad-wstree__session:hover {
  background: var(--pad-bg-hover);
  color: var(--pad-fg-primary);
  transform: translateX(2px); /* 轻微右移 hover 反馈 */
}
.pad-wstree__session.is-active {
  background: var(--pad-accent-soft);
  color: var(--pad-accent);
  font-weight: var(--pad-fw-medium);
  /* v0.3.8.3: 选中态左边加一条 3px 圆角 accent 高亮条, 不再是纯矩形背景 */
  box-shadow: inset 3px 0 0 var(--pad-accent);
}
/* v0.5.2: streaming 流光 seamless loop + 方向修正
   上一版 (v0.5.1) 实际问题:
   1. 方向反了 — animation pos 100% → -100% 让 shine 从右向左移动 (用户期望左→右扫过)
   2. color-mix 在某些 WebView2 版本不支持, gradient 失效 → 看不出 shine
   3. background-size 200% + repeat 没起无缝 loop 作用, 因为 1 个 tile 已 > 容器宽

   重写思路 (标准 skeleton shimmer + 数学无缝 loop):
   - background-size 200% 100% (1 个 tile = 2× 容器宽, 内含 1 个 shine 占 image 30-70%)
   - background-repeat no-repeat (1 个 tile 就够, repeat 反而破坏无缝)
   - shine 在 image 50% 中心 (透明 30% / accent 50% / 透明 70%) — 边缘柔和
   - animation: 0% pos=-150% 0 (shine 在 container 左外), 100% pos=50% 0 (shine 在 container 右外)
     0% 和 100% 都是 "container 透明" (shine 都在容器外), 视觉无缝 loop
   - 动画总距离 200% container = 1 image 宽, shine 在容器内可见 ~90% 时长, 间隔 ~10% (0.14s 短暂空白, 几乎不可察)
   - opacity 0.18 让 shine 跟 is-active 的 accent-soft 背景叠加, 提亮但不抢戏
   - duration 1.4s 不变 */
.pad-wstree__session.is-streaming {
  position: relative;
  overflow: hidden;
}
.pad-wstree__session.is-streaming::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: linear-gradient(
    90deg,
    transparent 0%,
    transparent 30%,
    var(--pad-accent) 50%,
    transparent 70%,
    transparent 100%
  );
  background-size: 200% 100%;
  background-repeat: no-repeat;
  opacity: 0.18;
  animation: pad-wstree-shimmer 1.4s linear infinite;
  pointer-events: none;
  z-index: 0;
}
.pad-wstree__session.is-streaming > * {
  position: relative;
  z-index: 1;
}
@keyframes pad-wstree-shimmer {
  /* v0.5.3 方向修正 — X 减 200% = image 向右移 = shine 也向右移 = **左→右 sweep**
   * (v0.5.2 写的 0% X=-150% → 100% X=+50% 是 X 增, image 向左移, shine 也左移 → 实际是右→左,
   *  跟用户期望相反)
   *
   * CSS 数学 (image 宽 W=2×container, 50% image 处是 shine 中心):
   *   P (image 0% 标记在 container 位置) = -X
   *   shine 视觉位置 = P + W/2 = -X + 1
   *   X 增大 → P 减小 (向左) → shine 也向左 = **右→左**
   *   X 减小 → P 增大 (向右) → shine 也向右 = **左→右** ✅
   *
   * v0.5.3 终值 (对称 0% 100% 都 shine 在 container 外 = 真无缝 loop):
   *   pos=150% 0 (0%): P = -150%, shine = -50% (container 左外) → 容器透明
   *   pos=-50% 0 (100%): P = +50%, shine = +150% (container 右外) → 容器透明
   *   0% 和 100% 都不可见, 循环无 snap, shine 容器内可见时间 ≈ 50% (剩余 50% 容器外补间) */
  0%   { background-position: 150% 0; }
  100% { background-position: -50% 0; }
}
.pad-wstree__session-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--pad-accent);
  flex-shrink: 0;
  box-shadow: 0 0 0 3px var(--pad-accent-soft);
}
.pad-wstree__session-icon {
  color: var(--pad-fg-tertiary);
  flex-shrink: 0;
}
.pad-wstree__session-title {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
  /* v0.4.1.5+: 强制单行, 避免父容器子元素 line-height 撑高 */
  display: block;
  line-height: 1.3;
}

/* Phase 2: Pinned / Active 子区段 label */
.pad-wstree__sub-label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 8px 2px;
  font-size: var(--pad-fs-11);
  color: var(--pad-fg-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-weight: var(--pad-fw-medium);
  user-select: none;
}
.pad-wstree__sub-label .pad-wstree__count {
  font-size: var(--pad-fs-10);
  opacity: 0.7;
  font-weight: var(--pad-fw-regular);
}

/* Phase 3: 归档 section label 带 icon */
.pad-wstree__sub-label-icon {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

/* Phase 2: Pin emoji 前缀 */
.pad-wstree__session-pin {
  margin-right: 2px;
  font-size: 10px;
  vertical-align: 1px;
}

/* Phase 4: session item 内部 body (title + tag chips 垂直堆叠) */
.pad-wstree__session-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  /* 跟外层 item 一样单行省略 title, 避免 tag 行干扰 */
}

/* Phase 4: tag chip 行 (小字, sub-color, 仅当有 tag 才显示) */
.pad-wstree__session-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 3px;
  /* 略缩进对齐 title 文字起始 */
  padding-left: 0;
}
.pad-wstree__session-tag {
  display: inline-flex;
  align-items: center;
  font-size: var(--pad-fs-10, 10px);
  line-height: 1.4;
  padding: 0 5px;
  height: 14px;
  background: var(--pad-bg-hover, rgba(0, 0, 0, 0.04));
  color: var(--pad-fg-tertiary, #888);
  border: 1px solid transparent;
  border-radius: 7px;
  cursor: pointer;
  font-family: var(--pad-font-mono, monospace);
  transition: background var(--pad-dur-fast, 0.15s) ease, color var(--pad-dur-fast, 0.15s) ease;
  flex-shrink: 0;
}
.pad-wstree__session-tag:hover {
  background: var(--pad-danger-subtle, rgba(239, 68, 68, 0.08));
  color: var(--pad-danger-text, #ef4444);
}

/* Phase 5: 搜索结果 item meta 行 ([from X] + 匹配类型) */
.pad-wstree__session-meta {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: var(--pad-fs-10, 10px);
  color: var(--pad-fg-tertiary, #888);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
  line-height: 1.3;
}
.pad-wstree__session-match {
  color: var(--pad-fg-tertiary, #888);
  opacity: 0.8;
}

/* Phase 5: search bar (顶部) */
.pad-wstree__search {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 6px;
  margin: 2px 2px 4px;
  border: 1px solid var(--pad-border, rgba(0, 0, 0, 0.08));
  border-radius: var(--pad-radius-md, 6px);
  background: var(--pad-bg-card, #ffffff);
  transition: border-color var(--pad-dur-fast, 0.15s) ease, box-shadow var(--pad-dur-fast, 0.15s) ease;
}
.pad-wstree__search:focus-within {
  border-color: var(--pad-accent, #3b82f6);
  box-shadow: 0 0 0 2px var(--pad-accent-soft, rgba(59, 130, 246, 0.18));
}
.pad-wstree__search-icon {
  color: var(--pad-fg-tertiary, #888);
  flex-shrink: 0;
}
.pad-wstree__search-input {
  flex: 1;
  min-width: 0;
  border: none;
  background: transparent;
  color: var(--pad-fg-primary, #1a1a1a);
  font: inherit;
  font-size: var(--pad-fs-12, 12px);
  padding: 0;
  outline: none;
  height: 20px;
}
.pad-wstree__search-input::placeholder {
  color: var(--pad-fg-tertiary, #888);
  opacity: 0.7;
}
.pad-wstree__search-clear {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  padding: 0;
  background: transparent;
  border: none;
  border-radius: var(--pad-radius-sm, 4px);
  color: var(--pad-fg-tertiary, #888);
  cursor: pointer;
  flex-shrink: 0;
  transition: background var(--pad-dur-fast, 0.15s) ease, color var(--pad-dur-fast, 0.15s) ease;
}
.pad-wstree__search-clear:hover {
  background: var(--pad-bg-hover, rgba(0, 0, 0, 0.05));
  color: var(--pad-fg-primary, #1a1a1a);
}

/* Phase 5: 搜索空结果 */
.pad-wstree__search-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: var(--pad-sp-6, 16px) var(--pad-sp-3, 12px);
  color: var(--pad-fg-tertiary, #888);
  font-size: var(--pad-fs-12, 12px);
}
.pad-wstree__search-empty p { margin: 0; }
.pad-wstree__search-empty .pad-wstree__empty-hint {
  font-size: var(--pad-fs-11, 11px);
  opacity: 0.7;
}

/* Phase 3: archive 列表 [from A] 角标 */
.pad-wstree__session-from {
  margin-left: 6px;
  font-size: var(--pad-fs-10);
  color: var(--pad-fg-tertiary);
  font-weight: var(--pad-fw-regular);
  opacity: 0.7;
  font-family: var(--pad-font-mono);
  flex-shrink: 0;
}

/* Phase 3: archive session item 视觉弱化 */
.pad-wstree__session--archived {
  color: var(--pad-fg-tertiary);
  opacity: 0.85;
}
.pad-wstree__session--archived:hover {
  color: var(--pad-fg-secondary);
  opacity: 1;
}

/* Phase 3: workspace 列表与归档 section 之间的分隔线 */
.pad-wstree__divider {
  height: 1px;
  background: var(--pad-divider);
  margin: 8px 6px 0;
}

/* Phase 2: inline rename input */
.pad-wstree__session-rename-input {
  flex: 1;
  min-width: 0;
  border: 1px solid var(--pad-accent);
  border-radius: var(--pad-radius-sm);
  background: var(--pad-bg-card);
  color: var(--pad-fg-primary);
  font: inherit;
  padding: 0 4px;
  outline: none;
  height: 20px;
  margin: -2px 0;
}
.pad-wstree__session-rename-input:focus {
  box-shadow: 0 0 0 2px var(--pad-accent-soft);
}

/* Phase 3: session 行内右侧 inline action 按钮 (📦 Archive)
   替代旧 .pad-wstree__session-del (trash) — 视觉中性, hover 用普通 hover,
   不再是 danger 红色. */
.pad-wstree__session-action {
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--pad-fg-tertiary);
  background: transparent;
  border: none;
  border-radius: var(--pad-radius-sm);
  cursor: pointer;
  /* v0.4.1.5+: 默认半透明让位置统一可见, hover 完全不透明突出 */
  opacity: 0.35;
  transition: opacity var(--pad-dur-fast) ease, background var(--pad-dur-fast) ease, color var(--pad-dur-fast) ease;
}
.pad-wstree__session:hover .pad-wstree__session-action {
  opacity: 1;
}
.pad-wstree__session-action:hover {
  background: var(--pad-bg-hover);
  color: var(--pad-fg-primary);
  opacity: 1;
}
.pad-wstree__session-empty {
  padding: 4px 8px;
  font-size: var(--pad-fs-11);
  color: var(--pad-fg-tertiary);
  background: transparent;
  border: 1px dashed var(--pad-border);
  border-radius: var(--pad-radius-sm);
  cursor: default;
  text-align: center;
}

/* ====== 过渡 ====== */
.pad-wsfade-enter-active,
.pad-wsfade-leave-active {
  transition: opacity var(--pad-dur-fast) ease, transform var(--pad-dur-fast) ease;
}
.pad-wsfade-enter-from,
.pad-wsfade-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
.pad-wsexpand-enter-active,
.pad-wsexpand-leave-active {
  transition: opacity var(--pad-dur-fast) ease, max-height var(--pad-dur-base) var(--pad-ease-out-soft);
  overflow: hidden;
  max-height: 600px;
}
.pad-wsexpand-enter-from,
.pad-wsexpand-leave-to {
  opacity: 0;
  max-height: 0;
}
</style>

<style>
/* Session hover 预览 popover (Teleport 到 body, 不能 scoped) */
.pad-session-preview {
  position: fixed;
  z-index: 9999;
  width: 300px;
  padding: 10px 12px;
  background: var(--pad-popover);
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-lg);
  box-shadow: var(--pad-shadow-modal);
  pointer-events: auto; /* 允许 hover 进去 (让用户有时间移到 popover 上) */
  font-family: var(--pad-font-sans);
}
.pad-session-preview__title {
  font-size: var(--pad-fs-14);
  font-weight: var(--pad-fw-semibold);
  color: var(--pad-fg-primary);
  margin-bottom: 6px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pad-session-preview__path,
.pad-session-preview__msg {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--pad-fs-12);
  color: var(--pad-fg-secondary);
  margin-bottom: 4px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pad-session-preview__path span,
.pad-session-preview__msg span {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pad-session-preview__path {
  font-family: var(--pad-font-mono);
  color: var(--pad-fg-tertiary);
}
.pad-session-preview__msg.is-empty {
  color: var(--pad-fg-tertiary);
  font-style: italic;
}
.pad-session-preview__meta {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--pad-fs-11);
  color: var(--pad-fg-tertiary);
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid var(--pad-divider);
}
.pad-session-preview__dot {
  color: var(--pad-fg-tertiary);
}
.pad-preview-enter-active,
.pad-preview-leave-active {
  transition: opacity var(--pad-dur-fast) ease, transform var(--pad-dur-fast) ease;
}
.pad-preview-enter-from,
.pad-preview-leave-to {
  opacity: 0;
  transform: translateY(-50%) translateX(-4px);
}
</style>
