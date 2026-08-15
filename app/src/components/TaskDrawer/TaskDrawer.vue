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
  background: var(--pad-bg-sidebar);
  border-radius: var(--pad-radius-xl);
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  overflow: hidden;
  transition:
    width var(--pad-dur-base) var(--pad-ease-out-soft),
    opacity var(--pad-dur-base) var(--pad-ease-out-soft);
}
.pad-drawer.is-collapsed {
  width: 0;
  opacity: 0;
  pointer-events: none;
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
  gap: var(--pad-sp-2);
}
.pad-drawer__section {
  background: var(--pad-bg-active);
  border-radius: var(--pad-radius-xl);
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
  transition: background var(--pad-dur-fast) ease;
}
.pad-drawer__section-toggle:hover {
  background: var(--pad-bg-hover);
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
.pad-drawer__section-body.is-collapsed {
  grid-template-rows: 0fr;
}
.pad-drawer__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: var(--pad-sp-4);
  padding-bottom: 20px;
}
.pad-drawer__empty-icon {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: var(--pad-bg-hover);
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: var(--pad-sp-2);
  color: var(--pad-fg-tertiary);
}
.pad-drawer__empty-title {
  font-size: var(--pad-fs-13);
  color: var(--pad-fg-secondary);
  letter-spacing: 0.1em;
}
.pad-drawer__empty-desc {
  font-size: var(--pad-fs-12);
  color: var(--pad-fg-tertiary);
  margin-top: 4px;
}
.pad-drawer__context {
  padding: var(--pad-sp-1) var(--pad-sp-4) 20px var(--pad-sp-4);
}
.pad-drawer__context-bar {
  display: flex;
  align-items: center;
  gap: var(--pad-sp-3);
  margin-bottom: var(--pad-sp-2);
}
.pad-drawer__context-track {
  flex: 1;
  height: 6px;
  background: var(--pad-bg-hover);
  border-radius: 9999px;
  overflow: hidden;
}
.pad-drawer__context-fill {
  height: 100%;
  background: var(--pad-warning);
  border-radius: 9999px;
}
.pad-drawer__context-btn {
  height: 24px;
  padding: 0 var(--pad-sp-2);
  border-radius: var(--pad-radius-md);
  background: var(--pad-bg-hover);
  color: var(--pad-fg-secondary);
  font-size: var(--pad-fs-12);
  border: none;
  cursor: pointer;
  transition: background var(--pad-dur-fast) ease;
}
.pad-drawer__context-btn:hover {
  background: var(--pad-bg-active);
  color: var(--pad-fg-primary);
}
</style>
