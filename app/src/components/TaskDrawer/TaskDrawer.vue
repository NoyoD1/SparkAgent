<script setup lang="ts">
/**
 * TaskDrawer — right column 340px: header + 待办 section + 上下文 section.
 * 1:1 mirrors chat.html's <aside id="drawer">.
 */
import { ref } from 'vue';
import { Plus, PanelRightClose, ChevronDown, ListChecks, Info, MessageSquareOff } from 'lucide-vue-next';
import IconButton from '@/components/ui/IconButton.vue';
import { useUiStore } from '@/stores/ui';

const uiStore = useUiStore();

const todoCollapsed = ref(false);
const contextCollapsed = ref(false);

function toggleTodo() {
  todoCollapsed.value = !todoCollapsed.value;
}
function toggleContext() {
  contextCollapsed.value = !contextCollapsed.value;
}
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

      <!-- 上下文 section -->
      <section class="pad-drawer__section">
        <button class="pad-drawer__section-toggle" @click="toggleContext">
          <div class="pad-drawer__section-toggle-left">
            <span>上下文</span>
            <Info :size="14" :stroke-width="1.75" class="pad-drawer__info" />
          </div>
          <ChevronDown
            :size="14"
            :stroke-width="1.75"
            :class="['pad-drawer__chev', { 'is-collapsed': contextCollapsed }]"
          />
        </button>
        <div :class="['pad-drawer__section-body', { 'is-collapsed': contextCollapsed }]">
          <div class="pad-drawer__context">
            <div class="pad-drawer__context-bar">
              <div class="pad-drawer__context-track">
                <div class="pad-drawer__context-fill" style="width: 13%" />
              </div>
              <button class="pad-drawer__context-btn">压缩</button>
            </div>
            <div class="pad-drawer__empty">
              <div class="pad-drawer__empty-icon">
                <MessageSquareOff :size="20" :stroke-width="1.5" />
              </div>
              <div class="pad-drawer__empty-title">暂 未 使 用 上 下 文</div>
              <div class="pad-drawer__empty-desc">追踪 TraeWork 工作时使用的工具和文件</div>
            </div>
          </div>
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
.pad-drawer__info {
  color: var(--pad-fg-tertiary);
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
.pad-drawer__section-body > div {
  overflow: hidden;
}
/* v0.3.8.26.1 修折叠后底部漏出: grid-template-rows: 0fr 折叠的是 grid row 高度,
 * 但 row 内直接子 div (.pad-drawer__empty / .pad-drawer__context) 自带 padding
 * 16px+20px = 32px. padding 是 box model 的一部分, 不受 grid 0fr 限制,
 * 仍撑出 32px 高度 → 折叠后底部漏出 icon / 进度条 / 按钮.
 *
 * 修法: 折叠状态下把直接子 div 的 padding/margin/border/height 全归零,
 * 让 grid item 真正收缩到 0. (跟 thinking body 折叠一样的 belt-and-suspenders) */
.pad-drawer__section-body.is-collapsed > div {
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
.pad-drawer__context-track {
  flex: 1;
  height: 1px;
  background: var(--pad-border);
  border-radius: 0;
  overflow: visible;
  position: relative;
}
.pad-drawer__context-fill {
  position: absolute;
  left: 0;
  top: -1px;
  height: 3px;
  background: var(--pad-fg-primary);
  border-radius: 0;
  transition: width var(--pad-dur-base) var(--pad-ease-out-soft);
}
/* v0.3.8.24: "压缩" 按钮去掉灰底, 改成纯文字 + underline-on-hover */
.pad-drawer__context-btn {
  height: auto;
  padding: 0;
  background: transparent;
  color: var(--pad-fg-tertiary);
  font-size: var(--pad-fs-12);
  border: none;
  cursor: pointer;
  transition: color var(--pad-dur-fast) ease;
  text-decoration: none;
}
.pad-drawer__context-btn:hover {
  color: var(--pad-fg-primary);
  text-decoration: underline;
  text-underline-offset: 2px;
}
</style>
