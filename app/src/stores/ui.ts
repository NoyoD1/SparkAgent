import { defineStore } from 'pinia';
import { ref, watch } from 'vue';

export type SidebarTab = 'work' | 'code' | 'design';

/** 主区域显示模式: chat (默认) / settings (设置面板铺满主区) */
export type ViewMode = 'chat' | 'settings';

/** 列宽 (px), localStorage 持久化, 拖动分隔条改 */
export interface ColumnWidths {
  sidebar: number;
  drawer: number;
}
const DEFAULT_WIDTHS: ColumnWidths = { sidebar: 248, drawer: 340 };
const WIDTHS_KEY = 'pi-agent:layout:v1';

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
  function closeSettings() {
    viewMode.value = 'chat';
  }

  return {
    // state
    sidebarCollapsed,
    drawerCollapsed,
    activeTab,
    widths,
    viewMode,
    settingsTab,
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
  };
});
