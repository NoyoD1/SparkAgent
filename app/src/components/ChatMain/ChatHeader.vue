<script setup lang="ts">
/**
 * ChatHeader — chat title bar: "你好" title + timestamp + "在中打开" dropdown + bell + 右侧 panel toggle.
 * v2: 加 PanelRight / PanelRightClose 按钮 (从 TitleBar 下移过来) 控右侧任务摘要抽屉
 * v0.3.8.18: 加主题切换 (太阳/月亮 图标 + 3 选下拉: 浅色/深色/跟随系统),
 *            之前要进 Settings → Appearance 才能切, 不方便.
 */
import { ref, computed } from 'vue';
import { storeToRefs } from 'pinia';
import {
  MoreHorizontal, Code2, ChevronDown, Folder, ExternalLink, Bell,
  PanelRight, PanelRightClose, Sun, Moon, Monitor, Check,
} from 'lucide-vue-next';
import { useSessionStore } from '@/stores/session';
import { useUiStore, type ThemeMode } from '@/stores/ui';
import IconButton from '@/components/ui/IconButton.vue';

const sessionStore = useSessionStore();
const uiStore = useUiStore();
const { activeSession } = storeToRefs(sessionStore);
const { drawerCollapsed, themeMode } = storeToRefs(uiStore);

const showDropdown = ref(false);
const showThemeMenu = ref(false);

function toggleDropdown(e: MouseEvent) {
  e.stopPropagation();
  showDropdown.value = !showDropdown.value;
  showThemeMenu.value = false;
}
function closeDropdown() {
  showDropdown.value = false;
  showThemeMenu.value = false;
}
function toggleThemeMenu(e: MouseEvent) {
  e.stopPropagation();
  showThemeMenu.value = !showThemeMenu.value;
  showDropdown.value = false;
}
function pickTheme(mode: ThemeMode) {
  uiStore.setThemeMode(mode);
  showThemeMenu.value = false;
}

// 当前主题对应图标: light→Sun, dark→Moon, auto→Monitor
const themeIcon = computed(() => {
  if (themeMode.value === 'dark') return Moon;
  if (themeMode.value === 'auto') return Monitor;
  return Sun;
});
const themeTitle = computed(() => {
  if (themeMode.value === 'dark') return '当前: 深色 (点击切换)';
  if (themeMode.value === 'auto') return '当前: 跟随系统 (点击切换)';
  return '当前: 浅色 (点击切换)';
});

// format timestamp like "07月29日 17:38"
const formattedTime = computed(() => {
  const ts = activeSession.value?.createdAt;
  if (!ts) return '';
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${mm}月${dd}日 ${hh}:${mi}`;
});
</script>

<template>
  <div class="pad-chatheader" @click="closeDropdown">
    <div class="pad-chatheader__left">
      <span class="pad-chatheader__title">{{ activeSession?.title ?? '新任务' }}</span>
      <span class="pad-chatheader__time">{{ formattedTime }}</span>
      <IconButton :icon="MoreHorizontal" size="sm" title="更多" />
    </div>
    <div class="pad-chatheader__right">
      <button class="pad-openin" @click="toggleDropdown">
        <Code2 :size="14" :stroke-width="1.75" />
        <span>在</span>
        <span class="pad-openin__target">中打开</span>
        <ChevronDown
          :size="14"
          :stroke-width="1.75"
          :class="['pad-openin__chev', { 'is-flipped': showDropdown }]"
        />
      </button>
      <div v-show="showDropdown" class="pad-openin-menu" @click.stop>
        <button class="pad-openin-item">
          <Code2 :size="14" :stroke-width="1.75" /> 在编辑器中打开
        </button>
        <button class="pad-openin-item">
          <Folder :size="14" :stroke-width="1.75" /> 在文件夹中打开
        </button>
        <button class="pad-openin-item">
          <ExternalLink :size="14" :stroke-width="1.75" /> 在浏览器中打开
        </button>
      </div>

      <!-- v0.3.8.18: 快速主题切换 (Sun/Moon/Monitor 图标 + 3 选下拉) -->
      <div class="pad-theme-toggle">
        <IconButton
          :icon="themeIcon"
          size="sm"
          :title="themeTitle"
          @click="toggleThemeMenu"
        />
        <div v-show="showThemeMenu" class="pad-theme-menu" @click.stop>
          <button
            v-for="opt in [
              { mode: 'light' as ThemeMode, label: '浅色', icon: Sun, desc: '明亮界面' },
              { mode: 'dark' as ThemeMode,  label: '深色', icon: Moon, desc: '暗色界面' },
              { mode: 'auto' as ThemeMode,  label: '跟随系统', icon: Monitor, desc: '按 OS 设置切换' },
            ]"
            :key="opt.mode"
            class="pad-theme-menu-item"
            :class="{ 'is-active': themeMode === opt.mode }"
            type="button"
            @click="pickTheme(opt.mode)"
          >
            <component :is="opt.icon" :size="14" :stroke-width="1.75" class="pad-theme-menu-icon" />
            <span class="pad-theme-menu-label">{{ opt.label }}</span>
            <span class="pad-theme-menu-desc">{{ opt.desc }}</span>
            <Check
              v-if="themeMode === opt.mode"
              :size="13"
              :stroke-width="2"
              class="pad-theme-menu-check"
            />
          </button>
        </div>
      </div>

      <IconButton :icon="Bell" size="sm" title="通知" />
      <IconButton
        :icon="drawerCollapsed ? PanelRight : PanelRightClose"
        size="sm"
        :title="drawerCollapsed ? '展开任务摘要' : '收起任务摘要'"
        @click="uiStore.toggleDrawer"
      />
    </div>
  </div>
</template>

<style scoped>
.pad-chatheader {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 48px;
  padding: 0 var(--pad-sp-4);
  flex-shrink: 0;
}
.pad-chatheader__left {
  display: flex;
  align-items: center;
  gap: var(--pad-sp-2);
  min-width: 0;
  flex: 1;
}
.pad-chatheader__title {
  font-size: var(--pad-fs-15);
  font-weight: var(--pad-fw-semibold);
  color: var(--pad-fg-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pad-chatheader__time {
  font-size: var(--pad-fs-12);
  color: var(--pad-fg-tertiary);
  flex-shrink: 0;
}
.pad-chatheader__right {
  display: flex;
  align-items: center;
  gap: var(--pad-sp-1);
  flex-shrink: 0;
}
.pad-openin {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
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
.pad-openin:hover {
  background: var(--pad-bg-hover);
  color: var(--pad-fg-primary);
}
.pad-openin__target {
  font-weight: var(--pad-fw-medium);
  color: var(--pad-fg-primary);
}
.pad-openin__chev {
  transition: transform var(--pad-dur-base) var(--pad-ease-in-out);
}
.pad-openin__chev.is-flipped {
  transform: rotate(180deg);
}
.pad-openin-menu {
  position: absolute;
  top: 48px;
  right: var(--pad-sp-3);
  min-width: 160px;
  background: var(--pad-bg-elevated);
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-lg);
  box-shadow: var(--pad-shadow-popover);
  padding: var(--pad-sp-1) 0;
  z-index: 50;
}
.pad-openin-item {
  display: flex;
  align-items: center;
  gap: var(--pad-sp-2);
  width: 100%;
  height: 32px;
  padding: 0 var(--pad-sp-3);
  font-size: var(--pad-fs-13);
  color: var(--pad-fg-secondary);
  background: transparent;
  border: none;
  cursor: pointer;
  text-align: left;
  transition:
    background var(--pad-dur-fast) ease,
    color var(--pad-dur-fast) ease;
}
.pad-openin-item:hover {
  background: var(--pad-bg-hover);
  color: var(--pad-fg-primary);
}

/* ===== v0.3.8.18: 主题切换下拉 ===== */
.pad-theme-toggle {
  position: relative;
}
.pad-theme-menu {
  position: absolute;
  top: 38px;
  right: 0;
  min-width: 200px;
  background: var(--pad-bg-elevated);
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-lg);
  box-shadow: var(--pad-shadow-popover);
  padding: var(--pad-sp-1);
  z-index: 50;
}
.pad-theme-menu-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  border-radius: var(--pad-radius-md);
  background: transparent;
  border: none;
  cursor: pointer;
  text-align: left;
  font-family: inherit;
  color: var(--pad-fg-secondary);
  transition: background var(--pad-dur-fast) ease, color var(--pad-dur-fast) ease;
}
.pad-theme-menu-item:hover {
  background: var(--pad-bg-hover);
  color: var(--pad-fg-primary);
}
.pad-theme-menu-item.is-active {
  background: var(--pad-accent-soft);
  color: var(--pad-fg-primary);
}
.pad-theme-menu-icon {
  color: var(--pad-fg-tertiary);
  flex-shrink: 0;
}
.pad-theme-menu-item.is-active .pad-theme-menu-icon {
  color: var(--pad-accent);
}
.pad-theme-menu-label {
  font-size: var(--pad-fs-13);
  font-weight: var(--pad-fw-medium);
  flex-shrink: 0;
}
.pad-theme-menu-desc {
  font-size: var(--pad-fs-11);
  color: var(--pad-fg-tertiary);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pad-theme-menu-check {
  color: var(--pad-accent);
  flex-shrink: 0;
}
</style>
