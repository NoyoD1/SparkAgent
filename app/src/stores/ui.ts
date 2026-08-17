import { defineStore } from 'pinia';
import { ref, watch } from 'vue';

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

export const useUiStore = defineStore('ui', () => {
  // Sidebar (left)
  const sidebarCollapsed = ref(false);
  // 默认 code — 跟 Pi-Agent-Design.design reference/0.png..13.png 一致 (Work/Code/Design 中 Code 始终 active)
  const activeTab = ref<SidebarTab>('code');

  // Task Drawer (right)
  const drawerCollapsed = ref(false);

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

  return {
    // state
    sidebarCollapsed,
    drawerCollapsed,
    activeTab,
    widths,
    viewMode,
    settingsTab,
    themeMode,
    pendingPermission,  // v0.4.1+
    // actions
    toggleSidebar,
    setSidebarCollapsed,
    toggleDrawer,
    setDrawerCollapsed,
    setActiveTab,
    setSidebarWidth,
    setDrawerWidth,
    openSettings,
    closeSettings,
    setThemeMode,
    applyTheme,  // v0.3.8.16: 初始应用 (App.vue 调)
    openPermissionDialog,  // v0.4.1+
    closePermissionDialog,  // v0.4.1+
  };
});
