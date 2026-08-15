<script setup lang="ts">
/**
 * ExtensionsTab — 扩展 / MCP 工具设置 (占位)
 * 计划: MCP servers (Anthropic / 第三方), Pi extension 加载, 自定义 tools
 */
import { Plug } from 'lucide-vue-next';
</script>

<template>
  <div class="pad-tab-placeholder">
    <Plug :size="32" :stroke-width="1.5" class="pad-tab-placeholder__icon" />
    <h3 class="pad-tab-placeholder__title">扩展 / MCP</h3>
    <p class="pad-tab-placeholder__desc">MCP server (Anthropic 协议)、Pi Extension 加载、自定义工具.</p>
    <span class="pad-tab-placeholder__badge">即将推出</span>
  </div>
</template>

<style scoped>
.pad-tab-placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  height: 100%;
  min-height: 320px;
  gap: var(--pad-sp-2);
  padding: var(--pad-sp-4);
}
.pad-tab-placeholder__icon {
  color: var(--pad-fg-tertiary);
  margin-bottom: var(--pad-sp-2);
}
.pad-tab-placeholder__title {
  font-size: var(--pad-fs-15);
  font-weight: var(--pad-fw-semibold);
  color: var(--pad-fg-primary);
  margin: 0;
}
.pad-tab-placeholder__desc {
  font-size: var(--pad-fs-13);
  color: var(--pad-fg-tertiary);
  max-width: 280px;
  line-height: var(--pad-lh-relaxed);
  margin: 0;
}
.pad-tab-placeholder__badge {
  margin-top: var(--pad-sp-2);
  font-size: var(--pad-fs-11);
  color: var(--pad-fg-tertiary);
  background: var(--pad-bg-hover);
  border-radius: var(--pad-radius-pill);
  padding: 2px 10px;
}
</style>
