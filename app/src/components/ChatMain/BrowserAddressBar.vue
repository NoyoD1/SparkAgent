<script setup lang="ts">
/**
 * BrowserAddressBar — ADR-0022 v3 (2026-08-23)
 * 主窗口顶部 URL bar, 跟 Browser Panel (WebView2 浮窗) 联动
 *
 * 位置: ChatHeader 下方, ChatMessage 上方
 * 显示: 仅当 browserPanelVisible=true (ui store)
 *
 * 功能:
 *  - URL input + Enter → browser_navigate_url (调 webview navigate)
 *  - 后退 / 前进 / 刷新 按钮 (调 webview history API)
 *  - 关闭按钮 → toggleBrowserPanel (hide webview)
 *
 * 之前只有 agent 工具能控制 webview (web_navigate 走 sidecar 文件队列),
 *   现在 user 也能在主窗口内直接控制 — 跟 IDE "Open in panel" 一致
 */
import { ref, onMounted, onUnmounted } from 'vue';
import { ArrowLeft, ArrowRight, RotateCw, X, Globe } from 'lucide-vue-next';
import { piTauri } from '@/lib/tauri';
import { useUiStore } from '@/stores/ui';
import IconButton from '@/components/ui/IconButton.vue';

const uiStore = useUiStore();
const urlInput = ref('');
const navigating = ref(false);

async function onSubmit() {
  let url = urlInput.value.trim();
  if (!url) return;
  // 自动补 scheme: 用户输入 "baidu.com" → "https://baidu.com"
  if (!/^https?:\/\//i.test(url)) {
    url = 'https://' + url;
  }
  navigating.value = true;
  try {
    await piTauri.browserNavigateUrl(url);
    urlInput.value = url; // 回填规范化后的 URL
  } catch (e) {
    console.error('[BrowserAddressBar] navigate failed', e);
  } finally {
    navigating.value = false;
  }
}

async function onBack() {
  try {
    await piTauri.browserNavigateBack();
  } catch (e) {
    console.error('[BrowserAddressBar] back failed', e);
  }
}
async function onForward() {
  try {
    await piTauri.browserNavigateForward();
  } catch (e) {
    console.error('[BrowserAddressBar] forward failed', e);
  }
}
async function onRefresh() {
  try {
    await piTauri.browserNavigateRefresh();
  } catch (e) {
    console.error('[BrowserAddressBar] refresh failed', e);
  }
}
function onClose() {
  uiStore.toggleBrowserPanel();
}

/**
 * 监听 webview 的 page load event, 自动把当前 URL 同步到 input
 * (Rust 端 page load finished 时已经会 emit, 后续扩展: 可让 Rust 在 page load
 *  时 emit 'browser-panel:url-changed' payload=url, FE 同步到 input)
 *
 * v0.1: 只在用户主动 submit 后同步 urlInput;后续等 Rust emit url event 再加
 */
onMounted(() => {
  // 占位: 后续接 page_url 事件 (Rust emit browser-panel:url-changed)
});
onUnmounted(() => {
  // nothing to cleanup yet
});
</script>

<template>
  <div class="pad-browser-bar">
    <IconButton :icon="Globe" size="sm" title="Browser Panel" class="pad-browser-bar__icon" />
    <button
      class="pad-browser-bar__nav-btn"
      type="button"
      title="后退"
      @click="onBack"
    >
      <ArrowLeft :size="14" :stroke-width="1.75" />
    </button>
    <button
      class="pad-browser-bar__nav-btn"
      type="button"
      title="前进"
      @click="onForward"
    >
      <ArrowRight :size="14" :stroke-width="1.75" />
    </button>
    <button
      class="pad-browser-bar__nav-btn"
      type="button"
      title="刷新"
      @click="onRefresh"
    >
      <RotateCw :size="14" :stroke-width="1.75" />
    </button>
    <form class="pad-browser-bar__form" @submit.prevent="onSubmit">
      <input
        v-model="urlInput"
        type="text"
        class="pad-browser-bar__input"
        :placeholder="navigating ? '正在加载…' : '输入 URL (回车导航, 自动补 https://)'"
        :disabled="navigating"
        spellcheck="false"
        autocomplete="off"
      />
    </form>
    <button
      class="pad-browser-bar__close"
      type="button"
      title="关闭浏览器面板"
      @click="onClose"
    >
      <X :size="14" :stroke-width="1.75" />
    </button>
  </div>
</template>

<style scoped>
.pad-browser-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 40px;
  padding: 0 var(--pad-sp-3);
  background: var(--pad-bg-app);
  border-bottom: 1px solid var(--pad-border);
  flex-shrink: 0;
}
.pad-browser-bar__icon {
  color: var(--pad-fg-tertiary);
  flex-shrink: 0;
}
.pad-browser-bar__nav-btn,
.pad-browser-bar__close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  border-radius: var(--pad-radius-md);
  background: transparent;
  color: var(--pad-fg-secondary);
  cursor: pointer;
  transition:
    background var(--pad-dur-fast) ease,
    color var(--pad-dur-fast) ease;
  flex-shrink: 0;
}
.pad-browser-bar__nav-btn:hover,
.pad-browser-bar__close:hover {
  background: var(--pad-bg-hover);
  color: var(--pad-fg-primary);
}
.pad-browser-bar__form {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
}
.pad-browser-bar__input {
  width: 100%;
  height: 28px;
  padding: 0 12px;
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-md);
  background: var(--pad-card);
  color: var(--pad-fg-primary);
  font-size: var(--pad-fs-13);
  font-family: var(--pad-font-mono, monospace);
  outline: none;
  transition:
    border-color var(--pad-dur-fast) ease,
    background var(--pad-dur-fast) ease;
}
.pad-browser-bar__input:focus {
  border-color: var(--pad-accent);
  background: var(--pad-card);
}
.pad-browser-bar__input:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.pad-browser-bar__input::placeholder {
  color: var(--pad-fg-tertiary);
}
</style>
