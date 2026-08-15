<script setup lang="ts">
/**
 * SidebarUserArea — 燎原 / 免费 user + Settings 按钮 (左下角)
 * v2: 加 Settings 按钮跟 avatar 并排, 取代 TitleBar 的齿轮
 */
import { MessageSquare, Settings } from 'lucide-vue-next';
import Avatar from '@/components/ui/Avatar.vue';
import IconButton from '@/components/ui/IconButton.vue';
import { useUiStore } from '@/stores/ui';

const uiStore = useUiStore();

function openSettings() {
  uiStore.openSettings('provider');
}
</script>

<template>
  <div class="pad-user">
    <Avatar text="N" :size="24" tone="brand" />
    <div class="pad-user__meta">
      <div class="pad-user__name">燎原</div>
      <div class="pad-user__plan">免费</div>
    </div>
    <IconButton :icon="MessageSquare" title="消息" />
    <IconButton :icon="Settings" title="设置" @click="openSettings" />
  </div>
</template>

<style scoped>
.pad-user {
  display: flex;
  align-items: center;
  gap: var(--pad-sp-2);
  height: 48px;
  padding: 0 var(--pad-sp-3);
  flex-shrink: 0;
}
.pad-user__meta {
  flex: 1;
  min-width: 0;
}
.pad-user__name {
  font-size: var(--pad-fs-13);
  color: var(--pad-fg-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pad-user__plan {
  font-size: var(--pad-fs-11);
  color: var(--pad-fg-tertiary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 折叠时隐藏 meta */
:global(.pad-sidebar.is-collapsed) .pad-user__meta {
  display: none;
}
</style>
