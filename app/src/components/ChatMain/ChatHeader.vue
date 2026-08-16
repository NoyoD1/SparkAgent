<script setup lang="ts">
/**
 * ChatHeader — chat title bar: "你好" title + timestamp + "在中打开" dropdown + bell + 右侧 panel toggle.
 * v2: 加 PanelRight / PanelRightClose 按钮 (从 TitleBar 下移过来) 控右侧任务摘要抽屉
 */
import { ref, computed } from 'vue';
import { storeToRefs } from 'pinia';
import { MoreHorizontal, Code2, ChevronDown, Folder, ExternalLink, Bell, PanelRight, PanelRightClose } from 'lucide-vue-next';
import { useSessionStore } from '@/stores/session';
import { useUiStore } from '@/stores/ui';
import IconButton from '@/components/ui/IconButton.vue';

const sessionStore = useSessionStore();
const uiStore = useUiStore();
const { activeSession } = storeToRefs(sessionStore);
const { drawerCollapsed } = storeToRefs(uiStore);

const showDropdown = ref(false);

function toggleDropdown(e: MouseEvent) {
  e.stopPropagation();
  showDropdown.value = !showDropdown.value;
}
function closeDropdown() {
  showDropdown.value = false;
}

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
</style>
