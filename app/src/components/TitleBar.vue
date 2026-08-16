<script setup lang="ts">
/**
 * TitleBar — 36px 自定义 top bar
 * v0.3.8.21: 接管原生窗口控制 (decorations: false)
 * - left:   PanelLeft (toggle sidebar) + Search + 编辑/帮助
 * - center: 留空 (可拖动区)
 * - right:  窗口控制 (min/max/close) — 调 @tauri-apps/api/window
 *
 * 整条 bar 都有 data-tauri-drag-region, 用户可以拖动窗口;
 * 右侧窗口控制按钮有 data-tauri-drag-region="false" (互斥, 不会跟拖动冲突).
 */
import { onMounted, onUnmounted, ref } from 'vue';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Search, PanelLeft, Minus, Square, Copy, X } from 'lucide-vue-next';
import IconButton from '@/components/ui/IconButton.vue';
import { useUiStore } from '@/stores/ui';

const uiStore = useUiStore();
const appWindow = getCurrentWindow();
const isMaximized = ref(false);

async function refreshMaximized() {
  try {
    isMaximized.value = await appWindow.isMaximized();
  } catch (e) {
    // dev 模式下 window API 可能不可用, 静默
    isMaximized.value = false;
  }
}

onMounted(() => {
  refreshMaximized();
  // 监听窗口 resize 事件, 同步 maximize 状态 (用户用系统快捷键/双击标题栏都会变)
  const unlistenPromise = appWindow.onResized(() => {
    refreshMaximized();
  });
  onUnmounted(() => {
    unlistenPromise.then((fn) => fn()).catch(() => {});
  });
});

async function onMinimize() {
  try { await appWindow.minimize(); } catch (e) { console.warn('[titlebar] minimize failed', e); }
}
async function onToggleMaximize() {
  try { await appWindow.toggleMaximize(); await refreshMaximized(); } catch (e) { console.warn('[titlebar] toggleMaximize failed', e); }
}
async function onClose() {
  try { await appWindow.close(); } catch (e) { console.warn('[titlebar] close failed', e); }
}
</script>

<template>
  <header class="pad-titlebar" data-tauri-drag-region>
    <div class="pad-titlebar__left">
      <div data-tauri-drag-region="false">
        <IconButton :icon="PanelLeft" size="sm" title="切换侧栏 (Cmd+\)" @click="uiStore.toggleSidebar" />
      </div>
      <span class="pad-titlebar__divider" aria-hidden="true" />
      <div data-tauri-drag-region="false">
        <IconButton :icon="Search" size="sm" title="搜索 (Cmd+K)" />
      </div>
      <button class="pad-titlebar__btn" data-tauri-drag-region="false">编辑(E)</button>
      <button class="pad-titlebar__btn" data-tauri-drag-region="false">帮助(H)</button>
    </div>
    <div class="pad-titlebar__center" data-tauri-drag-region />
    <div class="pad-titlebar__right">
      <IconButton :icon="Minus" size="sm" title="最小化" data-tauri-drag-region="false" @click="onMinimize" />
      <IconButton
        :icon="isMaximized ? Copy : Square"
        size="sm"
        :title="isMaximized ? '还原' : '最大化'"
        data-tauri-drag-region="false"
        @click="onToggleMaximize"
      />
      <IconButton :icon="X" size="sm" title="关闭" variant="danger" data-tauri-drag-region="false" @click="onClose" />
    </div>
  </header>
</template>

<style scoped>
.pad-titlebar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 36px;
  padding: 0 var(--pad-sp-3);
  /* v0.3.8.23: 跟 body 同色 (transparent 让 .pad-app 的 --pad-card 透过来),
   * 整张界面 = 1张大白卡, title bar 不是独立"贴纸", 是大白卡最上面一截 */
  background: transparent;
  /* 关掉 Tauri 原生装饰后, 整张卡撑满窗口, 窗口自带 8px 圆角,
   * title bar 的顶角跟着窗口圆角, 不需要自己画 radius.
   * bottom-radius 用 0 是因为下面紧接 body, 不要再画圆角. */
  border-radius: 0;
  /* 底边线 (1px subtle border) 跟 body 区分, 这是唯一分层手段 (background 同色) */
  border-bottom: 1px solid var(--pad-border);
  flex-shrink: 0;
  user-select: none;
}
.pad-titlebar__left,
.pad-titlebar__right {
  display: flex;
  align-items: center;
  gap: var(--pad-sp-1);
}
.pad-titlebar__center {
  flex: 1;
  height: 100%;
}
.pad-titlebar__divider {
  display: inline-block;
  width: 1px;
  height: 16px;
  background: var(--pad-divider);
  margin: 0 var(--pad-sp-1);
}
.pad-titlebar__btn {
  display: inline-flex;
  align-items: center;
  height: 28px;
  padding: 0 var(--pad-sp-2);
  border-radius: var(--pad-radius-md);
  font-size: var(--pad-fs-13);
  color: var(--pad-fg-secondary);
  background: transparent;
  border: none;
  cursor: pointer;
  transition:
    background var(--pad-dur-fast) ease,
    color var(--pad-dur-fast) ease;
}
.pad-titlebar__btn:hover {
  background: var(--pad-bg-hover);
  color: var(--pad-fg-primary);
}
</style>
