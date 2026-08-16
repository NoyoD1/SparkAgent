<script setup lang="ts">
/**
 * ChatView — v0.3.8.1 顶层布局
 *
 * viewMode 切 chat | settings:
 * - chat: TitleBar + Sidebar | ChatMain | [TaskDrawer 手动开] (3 列, 可拖拽)
 * - settings: TitleBar + Settings 全屏 (replace 主区)
 *
 * 列宽: ui store widths, 拖 ResizeHandle 改, localStorage 持久化
 *
 * v0.3.8.1: 右侧 TaskDrawer 默认 **关闭**, 只有用户主动点 ChatHeader 的 PanelRight 才开
 * 之前: 有 active session 自动开 → 用户嫌吵, 改成手动开
 */
import { computed } from 'vue';
import { storeToRefs } from 'pinia';
import TitleBar from '@/components/TitleBar.vue';
import Sidebar from '@/components/Sidebar/Sidebar.vue';
import ChatMain from '@/components/ChatMain/ChatMain.vue';
import TaskDrawer from '@/components/TaskDrawer/TaskDrawer.vue';
import SettingsDialog from '@/components/Settings/SettingsDialog.vue';
import ResizeHandle from '@/components/ui/ResizeHandle.vue';
import { useUiStore } from '@/stores/ui';

const uiStore = useUiStore();
const { viewMode, sidebarCollapsed, drawerCollapsed, widths } = storeToRefs(uiStore);

// v0.3.8.1: 右侧 panel 默认关, 用户主动开 (ChatHeader 按钮)
// 之前: !!activeSession && !drawerCollapsed → 有 session 就自动开, 太吵
const showRightDrawer = computed(
  () => !drawerCollapsed.value,  // 只看用户是否手动关过
);

const sidebarWidth = computed(() => sidebarCollapsed.value ? 0 : widths.value.sidebar);
const mainWidth = computed(
  () => `calc(100% - ${sidebarWidth.value}px - 1px - ${widths.value.drawer}px - 1px)`,
);

function onSidebarResize(w: number) {
  uiStore.setSidebarWidth(w);
}
function onDrawerResize(w: number) {
  uiStore.setDrawerWidth(w);
}
</script>

<template>
  <div class="pad-app">
    <TitleBar />

    <!-- main row -->
    <div v-if="viewMode === 'chat'" class="pad-app__body">
      <Sidebar
        :style="{ width: `${sidebarWidth}px` }"
        :no-active-tab-bar="false"
      />

      <ResizeHandle
        v-if="!sidebarCollapsed"
        :width="widths.sidebar"
        side="left"
        :min="180"
        :max="480"
        @resize="onSidebarResize"
      />

      <ChatMain :style="{ width: mainWidth, minWidth: 0 }" />

      <!-- 右侧 TaskDrawer: 永远渲染, 用 is-collapsed class 走 transition (不 v-if, 否则 DOM 移除无动画) -->
      <ResizeHandle
        v-show="showRightDrawer"
        :width="widths.drawer"
        side="right"
        :min="200"
        :max="600"
        @resize="onDrawerResize"
      />
      <TaskDrawer
        :style="showRightDrawer ? { width: `${widths.drawer}px` } : undefined"
        :class="{ 'is-collapsed': !showRightDrawer }"
      />
    </div>

    <!-- settings 整主区 -->
    <SettingsDialog v-else class="pad-app__settings" />
  </div>
</template>

<style scoped>
.pad-app {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  /* v0.3.8.23: 用户反馈"几块膏药贴界面上".
   * 之前 3 种底色: pad-app 用 --pad-bg-active (灰色 gap) / title-bar 用 --pad-bg-app (白) /
   * 内部 cards 用 --pad-card (白). 三者拼接像贴膏药.
   * 现在统一: 全部用 --pad-card (白), gap / 标题栏 / body 一起融合成一张大白卡.
   * 视觉分层靠 1px border, 不靠底色差. */
  padding: 0;
  gap: 0;
  background: var(--pad-card);
  overflow: hidden;
}

.pad-app__body {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  /* v0.3.8.10: 5px column gap, ResizeHandle 5px 容器正中, 拖拽手柄 "||" 显示在中心.
   * v0.3.8.23: gap 颜色跟 body 同色 (var(--pad-card) 而不是 --pad-bg-active),
   * 视觉上 sections 之间没有"色差", 只有 1px border line 分割 (在子组件里加). */
  column-gap: 5px;
  background: var(--pad-card);
}

.pad-app__settings {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border-radius: var(--pad-radius-xl);
  overflow: hidden;
}
</style>
