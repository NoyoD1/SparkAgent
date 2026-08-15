<script setup lang="ts">
/**
 * SettingsDialog — v4: 居中卡片布局 (跟 ZCode 参考一致)
 *
 * 布局:
 * - 顶栏 (48px): 返回工作区 + 当前 tab 标题
 * - 主体 (居中, max-width 1080, 居中 + 留白):
 *   - Page header: 大标题 + 副标题 + 右侧重置按钮
 *   - 内容卡片: 由各 tab 内部实现 (一般是 list + detail 二栏卡片)
 *
 * 触发: openSettings() 在 ui store 切 viewMode = 'settings'
 * 关闭: closeSettings() 切回 'chat'
 */
import { computed, markRaw } from 'vue';
import {
  KeyRound,         // Provider
  Settings2,        // 通用
  Palette,          // 外观
  Keyboard,         // 快捷键
  Plug,             // 扩展 / MCP
  Info,             // 关于
  ArrowLeft,        // 关闭
  RotateCcw,        // 重置
} from 'lucide-vue-next';
import { useUiStore } from '@/stores/ui';
import { storeToRefs } from 'pinia';
import ProviderTab from './tabs/ProviderTab.vue';
import GeneralTab from './tabs/GeneralTab.vue';
import AppearanceTab from './tabs/AppearanceTab.vue';
import ShortcutsTab from './tabs/ShortcutsTab.vue';
import ExtensionsTab from './tabs/ExtensionsTab.vue';
import AboutTab from './tabs/AboutTab.vue';

interface TabDef {
  id: string;
  label: string;
  icon: any;
  component: any;
  group: string;
  implemented: boolean;
}

const TABS: TabDef[] = [
  { id: 'general',    label: '通用',     icon: markRaw(Settings2), component: markRaw(GeneralTab),    group: '基础设置', implemented: false },
  { id: 'appearance', label: '外观',     icon: markRaw(Palette),    component: markRaw(AppearanceTab), group: '基础设置', implemented: false },
  { id: 'provider',   label: 'Provider', icon: markRaw(KeyRound),   component: markRaw(ProviderTab),   group: '基础设置', implemented: true  },
  { id: 'shortcuts',  label: '快捷键',   icon: markRaw(Keyboard),   component: markRaw(ShortcutsTab),  group: 'Agent 能力', implemented: false },
  { id: 'extensions', label: '扩展 / MCP', icon: markRaw(Plug),      component: markRaw(ExtensionsTab), group: 'Agent 能力', implemented: false },
  { id: 'about',      label: '关于',     icon: markRaw(Info),       component: markRaw(AboutTab),      group: '数据与统计', implemented: true  },
];

const uiStore = useUiStore();
const { settingsTab } = storeToRefs(uiStore);

const groupedTabs = computed(() => {
  const groups = new Map<string, TabDef[]>();
  for (const t of TABS) {
    if (!groups.has(t.group)) groups.set(t.group, []);
    groups.get(t.group)!.push(t);
  }
  return Array.from(groups.entries()).map(([label, tabs]) => ({ label, tabs }));
});

const activeTab = computed(() => TABS.find((t) => t.id === settingsTab.value) ?? TABS[0]);
const activeComponent = computed(() => activeTab.value.component);

function selectTab(id: string) {
  uiStore.openSettings(id);
}
function close() {
  uiStore.closeSettings();
}
</script>

<template>
  <div class="pad-settings-full">
    <!-- Top bar (返回 + 标题) -->
    <div class="pad-settings-full__topbar">
      <button class="pad-settings-full__back" @click="close">
        <ArrowLeft :size="16" :stroke-width="1.75" />
        <span>返回工作区</span>
      </button>
    </div>

    <!-- Body: 左侧 nav + 中间 page (居中, max-width 1080) -->
    <div class="pad-settings-full__body">
      <!-- Left: 分类 nav (固定 220, 不参与居中) -->
      <nav class="pad-settings-full__nav">
        <div
          v-for="group in groupedTabs"
          :key="group.label"
          class="pad-settings-full__nav-group"
        >
          <div class="pad-settings-full__nav-group-label">{{ group.label }}</div>
          <button
            v-for="t in group.tabs"
            :key="t.id"
            class="pad-settings-full__nav-item"
            :class="{ 'is-active': settingsTab === t.id }"
            @click="selectTab(t.id)"
          >
            <component :is="t.icon" :size="16" :stroke-width="1.75" />
            <span class="pad-settings-full__nav-item-label">{{ t.label }}</span>
            <span v-if="!t.implemented" class="pad-settings-full__nav-item-badge">即将</span>
          </button>
        </div>
      </nav>

      <!-- Center: page (居中, max-width 1080, 自适应) -->
      <main class="pad-settings-full__page">
        <div class="pad-settings-full__page-head">
          <div>
            <h1 class="pad-settings-full__page-title">{{ activeTab.label }} 设置</h1>
            <p v-if="settingsTab === 'provider'" class="pad-settings-full__page-sub">
              管理自定义模型供应商，配置后可在聊天时选择使用。
            </p>
          </div>
          <button v-if="settingsTab === 'provider'" class="pad-settings-full__page-action" title="重置">
            <RotateCcw :size="14" :stroke-width="1.75" />
          </button>
        </div>
        <div class="pad-settings-full__page-body">
          <component :is="activeComponent" />
        </div>
      </main>
    </div>
  </div>
</template>

<style scoped>
.pad-settings-full {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  background: var(--pad-bg-app);
  overflow: hidden;
  animation: pad-settings-fade-in var(--pad-dur-base) var(--pad-ease-out-soft);
}
@keyframes pad-settings-fade-in {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}

.pad-settings-full__topbar {
  display: flex;
  align-items: center;
  height: 48px;
  padding: 0 var(--pad-sp-5);
  background: var(--pad-bg-app);
  flex-shrink: 0;
  gap: var(--pad-sp-3);
}
.pad-settings-full__back {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 var(--pad-sp-2);
  border-radius: var(--pad-radius-md);
  font-size: var(--pad-fs-13);
  color: var(--pad-fg-secondary);
  background: transparent;
  border: none;
  cursor: pointer;
  transition: background var(--pad-dur-fast) ease, color var(--pad-dur-fast) ease;
}
.pad-settings-full__back:hover {
  background: var(--pad-bg-hover);
  color: var(--pad-fg-primary);
}

.pad-settings-full__body {
  display: flex;
  flex: 1;
  min-height: 0;
  /* nav 跟 page 之间留白 */
  gap: 0;
}

/* Nav: 不参与居中, 固定左侧 */
.pad-settings-full__nav {
  width: 220px;
  flex-shrink: 0;
  background: var(--pad-bg-app);
  overflow-y: auto;
  padding: var(--pad-sp-3) 0 var(--pad-sp-5);
  /* nav 跟 page 之间用 page 自己控制 padding-left 留白 */
}
.pad-settings-full__nav-group {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 0 var(--pad-sp-2);
  margin-bottom: var(--pad-sp-3);
}
.pad-settings-full__nav-group-label {
  font-size: var(--pad-fs-11);
  font-weight: var(--pad-fw-medium);
  color: var(--pad-fg-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: var(--pad-sp-2) var(--pad-sp-3) var(--pad-sp-1);
}
.pad-settings-full__nav-item {
  display: flex;
  align-items: center;
  gap: var(--pad-sp-2);
  width: 100%;
  height: 32px;
  padding: 0 var(--pad-sp-3);
  border-radius: var(--pad-radius-md);
  font-size: var(--pad-fs-13);
  color: var(--pad-fg-secondary);
  background: transparent;
  border: none;
  cursor: pointer;
  text-align: left;
  transition: background var(--pad-dur-fast) ease, color var(--pad-dur-fast) ease;
}
.pad-settings-full__nav-item:hover {
  background: var(--pad-bg-hover);
  color: var(--pad-fg-primary);
}
.pad-settings-full__nav-item.is-active {
  background: var(--pad-bg-active);
  color: var(--pad-fg-primary);
  font-weight: var(--pad-fw-medium);
}
.pad-settings-full__nav-item-label {
  flex: 1;
}
.pad-settings-full__nav-item-badge {
  font-size: var(--pad-fs-10);
  color: var(--pad-fg-tertiary);
  background: var(--pad-bg-hover);
  border-radius: var(--pad-radius-pill);
  padding: 1px 6px;
}

/* Page: 居中, max-width 1080, 自适应 */
.pad-settings-full__page {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  /* 关键: 内部居中 + 跟 nav 留白 */
  padding: var(--pad-sp-5) var(--pad-sp-6);
  display: flex;
  flex-direction: column;
  align-items: center; /* 横向居中 */
}
.pad-settings-full__page-head {
  width: 100%;
  max-width: 880px;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--pad-sp-3);
  margin-bottom: var(--pad-sp-4);
  flex-shrink: 0;
}
.pad-settings-full__page-title {
  font-size: 22px;
  font-weight: var(--pad-fw-semibold);
  color: var(--pad-fg-primary);
  margin: 0;
  line-height: 1.3;
  letter-spacing: -0.01em;
}
.pad-settings-full__page-sub {
  font-size: var(--pad-fs-13);
  color: var(--pad-fg-tertiary);
  margin: 6px 0 0 0;
  line-height: 1.5;
}
.pad-settings-full__page-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: var(--pad-radius-md);
  color: var(--pad-fg-tertiary);
  background: transparent;
  border: 1px solid transparent;
  cursor: pointer;
  transition: background var(--pad-dur-fast) ease, color var(--pad-dur-fast) ease, border-color var(--pad-dur-fast) ease;
  flex-shrink: 0;
}
.pad-settings-full__page-action:hover {
  background: var(--pad-bg-hover);
  color: var(--pad-fg-primary);
  border-color: var(--pad-border);
}
.pad-settings-full__page-body {
  width: 100%;
  max-width: 880px;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
</style>
