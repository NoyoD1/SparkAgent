<script setup lang="ts">
/**
 * App.vue — v0.3.8+ 启动时异步加载持久化配置
 *
 * - config.init() 走 Rust 读 %APPDATA%\com.piagent.desktop\config.json
 * - 加载完成前显示"加载中..." 蒙层, 避免看到空状态闪烁
 * - v0.3.8.1+: 加载后如果 providers 空, 尝试从旧 localStorage 迁移
 *   (解决 v0.3.6 → v0.3.8 升级时 localStorage 孤儿数据问题)
 * - session store 仍走 localStorage (v0.3.8 还接受这个; 后续要继续迁)
 */
import { onMounted, ref } from 'vue';
import ChatView from '@/views/ChatView.vue';
import { useConfigStore } from '@/stores/config';
import { useUiStore } from '@/stores/ui';

const config = useConfigStore();
const ui = useUiStore();
const ready = ref(false);
const migrationNotice = ref<string>('');

onMounted(async () => {
  // v0.3.8.16: 启动时把保存的主题应用到 <html> 上, 避免初始闪烁
  ui.applyTheme(ui.themeMode);
  try {
    await config.init();
    // v0.3.8.1 fix: providers 仍空时, 试从旧 v0.3.6 localStorage 迁
    if (config.providers.length === 0) {
      const result = config.migrateFromLocalStorage();
      if (result.migrated > 0) {
        migrationNotice.value = `已从旧版本恢复 ${result.migrated} 个 provider 配置`;
        setTimeout(() => { migrationNotice.value = ''; }, 5000);
      }
    }
  } finally {
    ready.value = true;
  }
});
</script>

<template>
  <div v-if="!ready" class="pad-app-boot">
    <div class="pad-app-boot__spinner" />
    <p class="pad-app-boot__text">加载中…</p>
  </div>
  <ChatView v-else />
  <Transition name="pad-mig-fade">
    <div v-if="migrationNotice" class="pad-mig-notice">
      <span>{{ migrationNotice }}</span>
    </div>
  </Transition>
</template>

<style>
.pad-app-boot {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  gap: 12px;
  background: var(--pad-bg-app);
  color: var(--pad-fg-secondary);
}
.pad-app-boot__spinner {
  width: 24px;
  height: 24px;
  border: 2px solid var(--pad-border);
  border-top-color: var(--pad-accent);
  border-radius: 50%;
  animation: pad-app-boot-spin 0.8s linear infinite;
}
.pad-app-boot__text {
  margin: 0;
  font-size: 13px;
  color: var(--pad-fg-tertiary);
}
@keyframes pad-app-boot-spin {
  to { transform: rotate(360deg); }
}

.pad-mig-notice {
  position: fixed;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  padding: 10px 18px;
  background: var(--pad-success-soft, var(--pad-bg-active));
  color: var(--pad-success-text, var(--pad-fg-primary));
  border: 1px solid var(--pad-success, var(--pad-accent));
  border-radius: var(--pad-radius-pill);
  font-size: var(--pad-fs-13);
  z-index: 9999;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
}
.pad-mig-fade-enter-active,
.pad-mig-fade-leave-active {
  transition: opacity var(--pad-dur-base) var(--pad-ease-out-soft), transform var(--pad-dur-base) var(--pad-ease-out-soft);
}
.pad-mig-fade-enter-from,
.pad-mig-fade-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(8px);
}
</style>

<style>
.pad-app-boot {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  gap: 12px;
  background: var(--pad-bg-app);
  color: var(--pad-fg-secondary);
}
.pad-app-boot__spinner {
  width: 24px;
  height: 24px;
  border: 2px solid var(--pad-border);
  border-top-color: var(--pad-accent);
  border-radius: 50%;
  animation: pad-app-boot-spin 0.8s linear infinite;
}
.pad-app-boot__text {
  margin: 0;
  font-size: 13px;
  color: var(--pad-fg-tertiary);
}
@keyframes pad-app-boot-spin {
  to { transform: rotate(360deg); }
}
</style>
