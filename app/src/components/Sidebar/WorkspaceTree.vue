<script setup lang="ts">
/**
 * WorkspaceTree — 真实 workspace + session 管理 (Phase 3 v0.3.2+)
 *
 * v0.3.6+ 重做:
 * 1. 参考 Pi-Agent-Design.design/reference/3.png 的视觉: section labels + file icons + chevrons
 * 2. Session hover 预览 popover 位置动态 (跟 hovered session bbox 对齐, 右边越界翻左边)
 * 3. 顶部 "项目" section label (跟 sidebar 其他 label 风格统一)
 * 4. 底部 "Agent 团队" placeholder section
 */
import { ref, computed } from 'vue';
import { storeToRefs } from 'pinia';
import {
  ChevronRight,
  Folder,
  Plus,
  Trash2,
  MessageCircle,
  Sparkles,
  Users,
} from 'lucide-vue-next';
import { useSessionStore } from '@/stores/session';
import { useChatStore } from '@/stores/chat';
import { pickFolder } from '@/lib/dialog';

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
    title: s.title || '新任务',
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
function removeSession(id: string) {
  if (!confirm('删除这个 session? 消息一并删.')) return;
  sessionStore.removeSession(id);
}
</script>

<template>
  <div class="pad-wstree">
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

        <!-- sessions 列表 -->
        <Transition name="pad-wsexpand">
          <div v-if="expandedWorkspaceIds.has(ws.id)" class="pad-wstree__sessions">
            <div
              v-for="s in sessionStore.getSessionsByWorkspace(ws.id)"
              :key="s.id"
              class="pad-wstree__session"
              :class="{
                'is-active': activeSessionId === s.id,
                'is-streaming': chatStore.isStreamingSession(s.id),
              }"
              @click="selectSession(s.id)"
              @mouseenter="(e) => onSessionEnter(e, s.id)"
              @mousemove="onSessionMove"
              @mouseleave="onSessionLeave"
            >
              <span class="pad-wstree__session-dot" v-if="activeSessionId === s.id" />
              <MessageCircle v-else :size="11" :stroke-width="1.75" class="pad-wstree__session-icon" />
              <span class="pad-wstree__session-title">{{ s.title || '新任务' }}</span>
              <!-- v0.4.1.5+: 删除按钮统一在右侧, 默认半透明显眼但弱化, hover 完全不透明
                   (之前: 只 active 或 hover 显示, 位置/可见性不统一) -->
              <button
                class="pad-wstree__session-del"
                title="删 session"
                @click.stop="removeSession(s.id)"
              >
                <Trash2 :size="11" :stroke-width="1.75" />
              </button>
            </div>
            <button
              v-if="sessionStore.getSessionsByWorkspace(ws.id).length === 0"
              class="pad-wstree__session-empty"
              disabled
            >
              暂无 session
            </button>
          </div>
        </Transition>
      </div>
    </div>

    <!-- ====== 底部: Agent 团队 (placeholder) ====== -->
    <div class="pad-wstree__bottom">
      <span class="pad-wstree__section-label">
        <Users :size="12" :stroke-width="1.75" />
        <span>Agent 团队</span>
      </span>
      <div class="pad-wstree__agents">
        <div class="pad-wstree__agent">
          <Sparkles :size="11" :stroke-width="1.75" />
          <span>Code Reviewer</span>
        </div>
        <div class="pad-wstree__agent">
          <Sparkles :size="11" :stroke-width="1.75" />
          <span>Refactor</span>
        </div>
        <div class="pad-wstree__agent is-soon">
          <span>+ 更多即将推出</span>
        </div>
      </div>
    </div>

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
/* v0.4.1.7+3: streaming 流光 — v0.4.1.7 原始"单 shine 横扫"逻辑 + repeat 修 loop 衔接
   (v0.4.1.7 是用户说"对的"那版, 唯一问题是 loop 时 shine 出容器后容器空 50% 时间,
    v0.4.1.7+1/+2 改用 100% 宽软渐变想修, 但软到肉眼看着像静止)
   新方案:
   - 回到 v0.4.1.7 的 50% 宽 gradient + 3 段硬切 (transparent → accent-300 → transparent)
   - 加 background-repeat 让 shine 出容器后下一格 shine 已经进来, 永远有 shine 可见
   - 收紧 gradient 4-stop 硬边: 40% 透明 → 50% accent-400 尖峰 → 60% 透明
     (40-50% 5% 急转, 肉眼一眼看到"有东西在动", 不是软糊糊的灰)
   - 100% 移位 = 2 个 tile 宽 (50% × 2), 跑完正好 2 个 shine 扫过去, 无空档
   - 1.4s 时长比之前略快, 视觉更"活" */
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
    transparent 40%,
    var(--pad-accent-300) 45%,
    var(--pad-accent-400) 50%,
    var(--pad-accent-300) 55%,
    transparent 60%,
    transparent 100%
  );
  background-size: 50% 100%;
  background-repeat: repeat;
  animation: pad-wstree-shimmer 1.4s linear infinite;
  pointer-events: none;
  z-index: 0;
}
.pad-wstree__session.is-streaming > * {
  position: relative;
  z-index: 1;
}
@keyframes pad-wstree-shimmer {
  from { background-position: 0 0; }       /* 2 个 shine 在容器内 (各居一格) */
  to   { background-position: -100% 0; }  /* 移位 2 tile 宽, 视觉上 2 个 shine 永远在容器里 → 无 loop 衔接 */
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
.pad-wstree__session-del {
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
.pad-wstree__session:hover .pad-wstree__session-del {
  opacity: 1;
}
.pad-wstree__session-del:hover {
  background: var(--pad-danger-subtle);
  color: var(--pad-danger-text);
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

/* ====== 底部 Agent 团队 ====== */
.pad-wstree__bottom {
  border-top: 1px solid var(--pad-divider);
  padding: var(--pad-sp-2) 0 var(--pad-sp-2);
  margin-top: 4px;
}
.pad-wstree__bottom .pad-wstree__section-label {
  padding: 0 var(--pad-sp-2) var(--pad-sp-2);
}
.pad-wstree__agents {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 0 var(--pad-sp-2);
}
.pad-wstree__agent {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  font-size: var(--pad-fs-12);
  color: var(--pad-fg-secondary);
  border-radius: var(--pad-radius-sm);
  cursor: default;
}
.pad-wstree__agent.is-soon {
  color: var(--pad-fg-tertiary);
  font-style: italic;
  font-size: var(--pad-fs-11);
  padding-left: 19px;
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
