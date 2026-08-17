<script setup lang="ts">
/**
 * TaskDrawer — right column 340px: header + 待办 section + 会话文件 section.
 * 1:1 mirrors chat.html's <aside id="drawer">.
 *
 * v0.4.3.1 (user 反馈 2026-08-18):
 *   - 删"上下文"section (Composer 底部已有压缩入口, 右侧不再重复)
 *   - 加"会话文件"section: 当前 active session 内 AI 调 file tool 产生的文件列表
 *     (write / edit / edit-diff / 等带 args.path 字段的 tool)
 */
import { computed, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { Plus, PanelRightClose, ChevronDown, ListChecks, FileText, CircleAlert, CircleCheck } from 'lucide-vue-next';
import IconButton from '@/components/ui/IconButton.vue';
import { useUiStore } from '@/stores/ui';
import { useChatStore } from '@/stores/chat';
import { useSessionStore } from '@/stores/session';

const uiStore = useUiStore();
const chatStore = useChatStore();
const sessionStore = useSessionStore();
const { activeSession } = storeToRefs(sessionStore);

const todoCollapsed = ref(false);
const filesCollapsed = ref(false);

function toggleTodo() {
  todoCollapsed.value = !todoCollapsed.value;
}
function toggleFiles() {
  filesCollapsed.value = !filesCollapsed.value;
}

/**
 * 从 active session 的 toolCalls 抓 file 操作产生的文件.
 * Pi SDK 0.84.2 file tool 命名: write / edit / edit-diff (都用 args.path 字段存文件路径).
 * 也有少数 tool 用 file_path, 两个都兼容. 按 path dedupe (同一文件多次写只展示 1 次,
 * 但 status 取最后一次).
 */
const FILE_TOOL_NAMES = new Set(['write', 'edit', 'edit-diff', 'file_write', 'file_edit', 'create', 'file_create']);

interface SessionFile {
  path: string;
  name: string;
  toolName: string;
  status: 'success' | 'error' | 'running' | 'pending';
  /** 同 path 出现的次数 (用于显示 "N 次修改") */
  count: number;
}

const sessionFiles = computed<SessionFile[]>(() => {
  const sid = activeSession.value?.id;
  if (!sid) return [];
  const toolCalls = chatStore.getToolCalls(sid);
  const byPath = new Map<string, SessionFile>();
  for (const tc of toolCalls) {
    if (!FILE_TOOL_NAMES.has(tc.name)) continue;
    const args = tc.args as Record<string, unknown> | undefined;
    const path = (args?.path ?? args?.file_path) as string | undefined;
    if (typeof path !== 'string' || path.length === 0) continue;
    const existing = byPath.get(path);
    if (existing) {
      existing.count += 1;
      existing.status = tc.status;
    } else {
      // 从 path 提取 filename (最后一段, 兼容 / 和 \)
      const name = path.split(/[/\\]/).pop() || path;
      byPath.set(path, {
        path,
        name,
        toolName: tc.name,
        status: tc.status,
        count: 1,
      });
    }
  }
  return Array.from(byPath.values());
});

/** status 对应的 icon + 颜色 (minimalist, 跟 token 配, 不上彩色块) */
const fileStatusIcon = (status: SessionFile['status']) => {
  if (status === 'success') return CircleCheck;
  if (status === 'error') return CircleAlert;
  return FileText;
};
const fileStatusClass = (status: SessionFile['status']) => {
  if (status === 'error') return 'is-error';
  if (status === 'running' || status === 'pending') return 'is-running';
  return 'is-success';
};
</script>

<template>
  <aside
    class="pad-drawer"
    :class="{ 'is-collapsed': uiStore.drawerCollapsed }"
  >
    <!-- Header -->
    <div class="pad-drawer__header">
      <span class="pad-drawer__title">任务摘要</span>
      <div class="pad-drawer__actions">
        <IconButton :icon="Plus" size="sm" title="添加" />
        <IconButton :icon="PanelRightClose" size="sm" title="收起抽屉" @click="uiStore.toggleDrawer" />
      </div>
    </div>

    <div class="pad-drawer__body pad-scroll">
      <!-- 待办 section -->
      <section class="pad-drawer__section">
        <button class="pad-drawer__section-toggle" @click="toggleTodo">
          <span>待办</span>
          <ChevronDown
            :size="14"
            :stroke-width="1.75"
            :class="['pad-drawer__chev', { 'is-collapsed': todoCollapsed }]"
          />
        </button>
        <div :class="['pad-drawer__section-body', { 'is-collapsed': todoCollapsed }]">
          <div class="pad-drawer__empty">
            <div class="pad-drawer__empty-icon">
              <ListChecks :size="20" :stroke-width="1.5" />
            </div>
            <div class="pad-drawer__empty-title">暂 无 待 办</div>
            <div class="pad-drawer__empty-desc">复杂任务的进展会显示在这里</div>
          </div>
        </div>
      </section>

      <!-- 会话文件 section (v0.4.3.1: 替代"上下文"section, 因为 Composer 底部已有压缩入口) -->
      <section class="pad-drawer__section">
        <button class="pad-drawer__section-toggle" @click="toggleFiles">
          <div class="pad-drawer__section-toggle-left">
            <span>会话文件</span>
            <span v-if="sessionFiles.length" class="pad-drawer__count">{{ sessionFiles.length }}</span>
          </div>
          <ChevronDown
            :size="14"
            :stroke-width="1.75"
            :class="['pad-drawer__chev', { 'is-collapsed': filesCollapsed }]"
          />
        </button>
        <div :class="['pad-drawer__section-body', { 'is-collapsed': filesCollapsed }]">
          <div v-if="sessionFiles.length === 0" class="pad-drawer__empty">
            <div class="pad-drawer__empty-icon">
              <FileText :size="20" :stroke-width="1.5" />
            </div>
            <div class="pad-drawer__empty-title">暂 无 会 话 文 件</div>
            <div class="pad-drawer__empty-desc">AI 调用文件工具时会在此记录</div>
          </div>
          <ul v-else class="pad-drawer__files">
            <li
              v-for="f in sessionFiles"
              :key="f.path"
              class="pad-drawer__file-item"
              :class="fileStatusClass(f.status)"
              :title="f.path"
            >
              <div class="pad-drawer__file-icon">
                <component :is="fileStatusIcon(f.status)" :size="14" :stroke-width="1.75" />
              </div>
              <div class="pad-drawer__file-body">
                <div class="pad-drawer__file-name">{{ f.name }}</div>
                <div v-if="f.count > 1" class="pad-drawer__file-meta">
                  {{ f.toolName }} · 修改 {{ f.count }} 次
                </div>
                <div v-else class="pad-drawer__file-meta">{{ f.toolName }}</div>
              </div>
            </li>
          </ul>
        </div>
      </section>
    </div>
  </aside>
</template>

<style scoped>
.pad-drawer {
  width: var(--pad-drawer-width);
  /* v0.3.8.23: 跟 body 同色, border-radius 去掉, 视觉上跟 sidebar/chat 一体 */
  background: var(--pad-card);
  display: flex;
  flex-direction: column;
  /* v0.3.8.26 修右侧栏折叠不能完全收起:
   * 之前 flex-shrink: 0 让 flex item 不收缩, 即使 width: 0 也保持 var(--pad-drawer-width) (≈300px),
   * 视觉上"留一部分在外面" (≈80-100px min-content 撑开).
   * 现在 min-width: 0 + 删 flex-shrink: 0, 让 flex item 能真正收缩到 0. */
  flex-shrink: 1;
  min-width: 0;
  overflow: hidden;
  transition:
    width var(--pad-dur-base) var(--pad-ease-out-soft),
    opacity var(--pad-dur-base) var(--pad-ease-out-soft);
}
.pad-drawer.is-collapsed {
  width: 0;
  min-width: 0;
  opacity: 0;
  pointer-events: none;
  /* 防止内部 children (header 40px + body flex 1 + section padding) 突破父级 0 宽度,
   * 让视觉完全收起到 0. */
  overflow: hidden;
}
.pad-drawer__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 48px;
  padding: 0 var(--pad-sp-4);
  flex-shrink: 0;
}
.pad-drawer__title {
  font-size: var(--pad-fs-15);
  font-weight: var(--pad-fw-semibold);
  color: var(--pad-fg-primary);
}
.pad-drawer__actions {
  display: flex;
  align-items: center;
  gap: var(--pad-sp-1);
}
.pad-drawer__body {
  flex: 1;
  overflow-y: auto;
  padding: 0 var(--pad-sp-3) var(--pad-sp-3);
  display: flex;
  flex-direction: column;
  /* v0.3.8.25: gap 回到 8px, sections 之间用 8px 间距, 视觉上是独立的 card.
   * v0.3.8.24 用 border 替代 gap 走过头了, 用户反馈"不要纯线" */
  gap: var(--pad-sp-2);
}
.pad-drawer__section {
  /* v0.3.8.25: 回到"轻量 card"风格 — 1px border + 圆角 + 极轻底色.
   * v0.3.8.19-22 用 --pad-bg-active (重灰) 太重被否,
   * v0.3.8.24 全 transparent 走过头被否,
   * 现在用 --pad-muted (#fafafa 极淡灰) — 比 body 略深 1 档, 视觉是 card.
   * + 1px border + 圆角 = 真正"区域"感. */
  background: var(--pad-muted);
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-lg);
  overflow: hidden;
}
.pad-drawer__section-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  height: 40px;
  padding: 0 var(--pad-sp-4);
  font-size: var(--pad-fs-13);
  font-weight: var(--pad-fw-medium);
  color: var(--pad-fg-primary);
  background: transparent;
  border: none;
  cursor: pointer;
  transition: color var(--pad-dur-fast) ease;
}
.pad-drawer__section-toggle:hover {
  color: var(--pad-fg-primary);
}
.pad-drawer__section-toggle-left {
  display: flex;
  align-items: center;
  gap: var(--pad-sp-2);
}
/* v0.4.3.1: section 标题计数 (e.g. "会话文件 3") */
.pad-drawer__count {
  font-size: var(--pad-fs-11);
  font-weight: var(--pad-fw-regular);
  color: var(--pad-fg-tertiary);
  background: var(--pad-muted);
  border-radius: var(--pad-radius-pill);
  padding: 0 6px;
  min-width: 18px;
  height: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-variant-numeric: tabular-nums;
}
.pad-drawer__chev {
  transition: transform var(--pad-dur-base) var(--pad-ease-in-out);
  color: var(--pad-fg-tertiary);
}
.pad-drawer__chev.is-collapsed {
  transform: rotate(-90deg);
}
.pad-drawer__section-body {
  display: grid;
  grid-template-rows: 1fr;
  transition: grid-template-rows var(--pad-dur-base) var(--pad-ease-out-soft);
}
/* v0.3.8.26.1 修折叠后底部漏出: grid-template-rows: 0fr 折叠的是 grid row 高度,
 * 但 row 内直接子元素 (.pad-drawer__empty div / .pad-drawer__files ul) 自带 padding
 * 16px+20px = 32px. padding 是 box model 的一部分, 不受 grid 0fr 限制,
 * 仍撑出 32px 高度 → 折叠后底部漏出 icon / 进度条 / 按钮.
 *
 * 修法: 折叠状态下把直接子元素 (div + ul 都覆盖) 的 padding/margin/border/height 全归零,
 * 让 grid item 真正收缩到 0. (跟 thinking body 折叠一样的 belt-and-suspenders)
 *
 * v0.4.3.1: 改成 `> *` 通用选择, 同时覆盖 div (empty state) + ul (files list) 2 种 children */
.pad-drawer__section-body > * {
  overflow: hidden;
}
.pad-drawer__section-body.is-collapsed > * {
  padding: 0;
  margin: 0;
  border: 0;
  height: 0;
  min-height: 0;
}
.pad-drawer__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: var(--pad-sp-4) var(--pad-sp-4) 20px;
}
.pad-drawer__empty-icon {
  /* v0.3.8.24: 去掉圆形灰底, 改成纯线条 icon, 跟 minimalist 一致 */
  width: 28px;
  height: 28px;
  border: 1px solid var(--pad-border);
  border-radius: 50%;
  background: transparent;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: var(--pad-sp-2);
  color: var(--pad-fg-tertiary);
}
.pad-drawer__empty-title {
  font-size: var(--pad-fs-12);
  color: var(--pad-fg-secondary);
  letter-spacing: 0.04em;
}
.pad-drawer__empty-desc {
  font-size: var(--pad-fs-11);
  color: var(--pad-fg-tertiary);
  margin-top: 4px;
  line-height: 1.5;
}
.pad-drawer__context {
  padding: var(--pad-sp-2) var(--pad-sp-4) 20px;
}
.pad-drawer__context-bar {
  display: flex;
  align-items: center;
  gap: var(--pad-sp-3);
  margin-bottom: var(--pad-sp-3);
}
/* v0.3.8.24: 进度条改成 1px 细线 + 1px 填线, 不要 pill 大块彩色 */
/* v0.4.3.1: .pad-drawer__context-* 样式已删除 (上下文 section 整体替换为"会话文件" section) */

/* ======== v0.4.3.1: 会话文件列表 ======== */
.pad-drawer__files {
  list-style: none;
  margin: 0;
  padding: var(--pad-sp-1) 0 var(--pad-sp-2);
  display: flex;
  flex-direction: column;
}
.pad-drawer__file-item {
  display: flex;
  align-items: center;
  gap: var(--pad-sp-2);
  padding: var(--pad-sp-2) var(--pad-sp-4);
  border-top: 1px solid var(--pad-border-subtle, var(--pad-border));
  transition: background var(--pad-dur-fast) ease;
  cursor: default;
}
.pad-drawer__file-item:first-child {
  border-top: none;
}
.pad-drawer__file-item:hover {
  background: var(--pad-bg-hover, var(--pad-muted));
}
.pad-drawer__file-icon {
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--pad-fg-tertiary);
  border-radius: var(--pad-radius-sm);
}
.pad-drawer__file-item.is-success .pad-drawer__file-icon {
  color: var(--pad-success, #16a34a);
}
.pad-drawer__file-item.is-error .pad-drawer__file-icon {
  color: var(--pad-danger, #dc2626);
}
.pad-drawer__file-item.is-running .pad-drawer__file-icon {
  color: var(--pad-warning, #f59e0b);
}
.pad-drawer__file-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.pad-drawer__file-name {
  font-size: var(--pad-fs-12);
  font-weight: var(--pad-fw-medium);
  color: var(--pad-fg-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-family: var(--pad-font-mono);
}
.pad-drawer__file-meta {
  font-size: var(--pad-fs-10);
  color: var(--pad-fg-tertiary);
  font-family: var(--pad-font-mono);
}
</style>
