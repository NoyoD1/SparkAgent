import { defineStore } from 'pinia';
import { ref, watch } from 'vue';
import { piTauri } from '@/lib/tauri';

export type SidebarTab = 'work' | 'code' | 'design';

/** 主区域显示模式: chat (默认) / settings (设置面板铺满主区) */
export type ViewMode = 'chat' | 'settings';

/** 主题模式: 浅色 / 深色 / 跟随系统 (auto) */
export type ThemeMode = 'light' | 'dark' | 'auto';

/** 列宽 (px), localStorage 持久化, 拖动分隔条改 */
export interface ColumnWidths {
  sidebar: number;
  drawer: number;
}
const DEFAULT_WIDTHS: ColumnWidths = { sidebar: 248, drawer: 340 };
const WIDTHS_KEY = 'pi-agent:layout:v1';
const THEME_KEY = 'pi-agent:theme:v1';

function loadWidths(): ColumnWidths {
  try {
    const raw = localStorage.getItem(WIDTHS_KEY);
    if (!raw) return { ...DEFAULT_WIDTHS };
    const parsed = JSON.parse(raw) as Partial<ColumnWidths>;
    return {
      sidebar: clampWidth(parsed.sidebar ?? DEFAULT_WIDTHS.sidebar, 52, 480),
      drawer: clampWidth(parsed.drawer ?? DEFAULT_WIDTHS.drawer, 200, 600),
    };
  } catch {
    return { ...DEFAULT_WIDTHS };
  }
}
function loadTheme(): ThemeMode {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === 'light' || v === 'dark' || v === 'auto') return v;
  } catch {}
  return 'light';
}
function clampWidth(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

// ====== Toast 通知类型 (Bug #2/#4/#5/#6 统一反馈) ======
export type ToastKind = 'info' | 'success' | 'warning' | 'error';
export interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
  /** ms, 默认 4000; error 6000 留时间看 */
  duration: number;
}

export const useUiStore = defineStore('ui', () => {
  // Sidebar (left)
  const sidebarCollapsed = ref(false);
  // 默认 code — 跟 Pi-Agent-Design.design reference/0.png..13.png 一致 (Work/Code/Design 中 Code 始终 active)
  const activeTab = ref<SidebarTab>('code');

  // Task Drawer (right)
  const drawerCollapsed = ref(false);

  // ADR-0022 v2 (2026-08-23): Browser Panel (WebView2, agent 控制的浏览器) 显隐
  //   默认 false, 启动时从 Rust 同步, FE 右上角按钮调 toggleBrowserPanel 切
  const browserPanelVisible = ref(false);

  // Layout widths (拖动持久化)
  const widths = ref<ColumnWidths>(loadWidths());

  // View mode (chat | settings)
  const viewMode = ref<ViewMode>('chat');
  // Settings 内的当前 tab (string 是 tab id, e.g. 'provider', 'general')
  const settingsTab = ref<string>('provider');

  // 主题模式 (light / dark / auto 跟随系统)
  const themeMode = ref<ThemeMode>(loadTheme());

  // Active session — moved to session store (Phase 3 v0.3.2+)

  watch(
    widths,
    (v) => {
      try {
        localStorage.setItem(WIDTHS_KEY, JSON.stringify(v));
      } catch {}
    },
    { deep: true },
  );

  // theme 变化时持久化 + 同步到 <html data-theme="...">
  watch(
    themeMode,
    (v) => {
      try {
        localStorage.setItem(THEME_KEY, v);
      } catch {}
      applyTheme(v);
    },
  );

  function toggleSidebar() {
    sidebarCollapsed.value = !sidebarCollapsed.value;
  }
  function setSidebarCollapsed(v: boolean) {
    sidebarCollapsed.value = v;
  }

  function toggleDrawer() {
    drawerCollapsed.value = !drawerCollapsed.value;
  }
  function setDrawerCollapsed(v: boolean) {
    drawerCollapsed.value = v;
  }

  // ADR-0022 v2: Browser Panel 显隐 toggle
  //   调 piTauri.toggleBrowserPanel(), Rust 端创建/dock/show/hide 都会同步状态回来
  //   失败时 (e.g. webview create 报错) 保持当前 state, 不乐观更新
  // ADR-0022 v3: 打开时自动收起 TaskDrawer (右侧区域避免 2 个 panel 重叠)
  //   关闭时不动 drawer (用户自己决定是否打开)
  async function toggleBrowserPanel() {
    try {
      const state = await piTauri.toggleBrowserPanel();
      browserPanelVisible.value = state.visible;
      if (state.visible && !drawerCollapsed.value) {
        drawerCollapsed.value = true;
      }
    } catch (e) {
      console.error('[ui] toggleBrowserPanel failed', e);
    }
  }

  /** ADR-0022 v2: 启动时从 Rust 同步初始 Browser Panel 状态 */
  async function initBrowserPanelState() {
    const state = await piTauri.getBrowserPanelState();
    browserPanelVisible.value = state.visible;
  }

  /** ADR-0022 v2: webview 被 user 主动点 X 销毁时, Rust emit browser-panel:destroyed */
  function onBrowserPanelDestroyed() {
    browserPanelVisible.value = false;
  }

  function setActiveTab(t: SidebarTab) {
    activeTab.value = t;
  }

  // setActiveSession removed — use sessionStore.selectSession() instead

  function setSidebarWidth(px: number) {
    widths.value.sidebar = clampWidth(px, 52, 480);
  }
  function setDrawerWidth(px: number) {
    widths.value.drawer = clampWidth(px, 200, 600);
  }

  function openSettings(tab: string = 'provider') {
    settingsTab.value = tab;
    viewMode.value = 'settings';
  }

  // v0.3.8.16: 主题切换 — light / dark / auto (跟系统 prefers-color-scheme)
  // 应用方式: 在 <html> 上加 data-theme="light|dark" (让 tokens.css 的 .dark 选择器匹配)
  // 'auto' 模式不加 attribute, 走 CSS @media (prefers-color-scheme: dark) 兜底
  function applyTheme(mode: ThemeMode) {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    if (mode === 'light') {
      root.setAttribute('data-theme', 'light');
    } else if (mode === 'dark') {
      root.setAttribute('data-theme', 'dark');
    } else {
      // auto: 不设 attribute, 让 OS 决定
      root.removeAttribute('data-theme');
    }
  }
  function setThemeMode(mode: ThemeMode) {
    themeMode.value = mode;
  }
  function closeSettings() {
    viewMode.value = 'chat';
  }

  // ====== v0.4.1+ tool permission dialog ======
  // sidecar emit permission_request → chat store 调 openPermissionDialog → 弹窗
  // 用户点允许/拒绝 → 调 closePermissionDialog + tauri.sendPermissionResponse

  /** 当前待确认的 permission request (null = 弹窗隐藏) */
  const pendingPermission = ref<{
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
    sessionId: string;
  } | null>(null);

  function openPermissionDialog(req: {
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
    sessionId: string;
  }) {
    pendingPermission.value = req;
  }
  function closePermissionDialog() {
    pendingPermission.value = null;
  }

  // ====== Toast 通知 (Bug #2/#4/#5/#6 统一反馈) ======
  // 之前各种失败都 console.log/console.error, 用户视觉"没反应".
  // 现在统一走 showToast, App.vue 顶层渲染 toast 容器 (跟 pad-mig-notice 同位置).
  const toasts = ref<ToastItem[]>([]);
  let toastSeq = 0;

  function showToast(message: string, kind: ToastKind = 'info', duration?: number) {
    const id = ++toastSeq;
    const item: ToastItem = {
      id,
      kind,
      message,
      duration: duration ?? (kind === 'error' ? 6000 : 4000),
    };
    toasts.value = [...toasts.value, item];
    setTimeout(() => {
      dismissToast(id);
    }, item.duration);
  }
  function dismissToast(id: number) {
    toasts.value = toasts.value.filter((t) => t.id !== id);
  }
  function clearToasts() {
    toasts.value = [];
  }

  return {
    // state
    sidebarCollapsed,
    drawerCollapsed,
    browserPanelVisible,  // ADR-0022 v2
    activeTab,
    widths,
    viewMode,
    settingsTab,
    themeMode,
    pendingPermission,  // v0.4.1+
    toasts,  // Bug #2/#4/#5/#6: toast 队列
    // actions
    toggleSidebar,
    setSidebarCollapsed,
    toggleDrawer,
    setDrawerCollapsed,
    toggleBrowserPanel,  // ADR-0022 v2
    initBrowserPanelState,  // ADR-0022 v2
    onBrowserPanelDestroyed,  // ADR-0022 v2
    setActiveTab,
    setSidebarWidth,
    setDrawerWidth,
    openSettings,
    closeSettings,
    setThemeMode,
    applyTheme,  // v0.3.8.16: 初始应用 (App.vue 调)
    openPermissionDialog,  // v0.4.1+
    closePermissionDialog,  // v0.4.1+
    showToast,  // Bug #2/#4/#5/#6: 统一错误/成功反馈
    dismissToast,
    clearToasts,
  };
});
