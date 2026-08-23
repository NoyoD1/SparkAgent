<script setup lang="ts">
/**
 * AttachmentPreview — 全局附件预览浮层 (Teleport to body)
 *
 * ADR-0022 v3.8 (2026-08-23):
 *   渲染 useAttachmentPreview.current state:
 *   - image: 暗色背景 + 大图 (跟之前 ChatMessage 内的 inline preview 一样)
 *   - file:  text 前 200 行 monospace 显示 + 头部 path / 大小 / mime, binary 显示提示
 *   - ESC / 点背景 / × 关闭
 *
 * App.vue mount 一次, 跟 useChipPreview 一样的 singleton 模式.
 */
import { onMounted, onUnmounted, watch } from 'vue';
import { X, FileText, Loader2 } from 'lucide-vue-next';
import { useAttachmentPreview } from '@/composables/useAttachmentPreview';

const { current, close } = useAttachmentPreview();

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && current.value) {
    close();
  }
}
onMounted(() => {
  document.addEventListener('keydown', onKeydown);
});
onUnmounted(() => {
  document.removeEventListener('keydown', onKeydown);
});

// body 滚动锁 (浮层显示时禁止背后页面滚动)
watch(current, (v) => {
  if (typeof document === 'undefined') return;
  document.body.style.overflow = v ? 'hidden' : '';
});

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}
</script>

<template>
  <Teleport to="body">
    <!-- v3.9: image-loading (从 savedPath 读 base64 期间) -->
    <div
      v-if="current?.kind === 'image-loading'"
      class="pad-att-preview pad-att-preview--image"
      @click.self="close"
    >
      <button
        class="pad-att-preview__close"
        type="button"
        title="关闭 (Esc)"
        @click="close"
      >
        <X :size="18" :stroke-width="1.75" />
      </button>
      <div class="pad-att-preview__loading">
        <Loader2 :size="32" :stroke-width="1.5" class="pad-att-preview__spin" />
        <div class="pad-att-preview__loading-text">加载图片中…</div>
        <div class="pad-att-preview__loading-path">{{ current.path }}</div>
      </div>
    </div>

    <!-- image 大图预览 -->
    <div
      v-else-if="current?.kind === 'image'"
      class="pad-att-preview pad-att-preview--image"
      @click.self="close"
    >
      <button
        class="pad-att-preview__close"
        type="button"
        title="关闭 (Esc)"
        @click="close"
      >
        <X :size="18" :stroke-width="1.75" />
      </button>
      <img
        :src="`data:${current.mimeType};base64,${current.data}`"
        class="pad-att-preview__img"
        alt="preview"
        @click.stop
      />
      <div class="pad-att-preview__meta">{{ current.mimeType }}</div>
    </div>

    <!-- file 预览 (text 前 N 行 / binary 占位) -->
    <div
      v-else-if="current?.kind === 'file'"
      class="pad-att-preview pad-att-preview--file"
      @click.self="close"
    >
      <button
        class="pad-att-preview__close"
        type="button"
        title="关闭 (Esc)"
        @click="close"
      >
        <X :size="18" :stroke-width="1.75" />
      </button>
      <div class="pad-att-preview__file-panel" @click.stop>
        <div class="pad-att-preview__file-head">
          <FileText :size="20" :stroke-width="1.5" class="pad-att-preview__file-icon" />
          <div class="pad-att-preview__file-meta">
            <div class="pad-att-preview__file-name">{{ current.filename }}</div>
            <div class="pad-att-preview__file-path" :title="current.path">
              {{ current.path }}
            </div>
            <div class="pad-att-preview__file-stats">
              <span>{{ current.mimeType || 'unknown' }}</span>
              <span>·</span>
              <span>{{ formatBytes(current.bytes) }}</span>
            </div>
          </div>
        </div>
        <div v-if="current.loading" class="pad-att-preview__file-loading">
          <Loader2 :size="18" :stroke-width="1.5" class="pad-att-preview__spin" />
          <span>读取中…</span>
        </div>
        <pre v-else class="pad-att-preview__file-body">{{ current.preview }}</pre>
        <div v-if="current.truncated" class="pad-att-preview__file-truncated">
          仅显示前 200 行 (文件总行数更多)
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.pad-att-preview {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.85);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10000;
  flex-direction: column;
  padding: 48px;
}
.pad-att-preview--file {
  align-items: stretch;
  justify-content: center;
  padding: 32px;
}
.pad-att-preview__close {
  position: absolute;
  top: 16px;
  right: 16px;
  width: 36px;
  height: 36px;
  padding: 0;
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.4);
  color: #fff;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2;
  transition: background var(--pad-dur-fast, 0.12s) ease;
}
.pad-att-preview__close:hover {
  background: rgba(255, 255, 255, 0.15);
}
.pad-att-preview__img {
  max-width: 90%;
  max-height: 80%;
  object-fit: contain;
  border-radius: var(--pad-radius-md, 8px);
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
}
.pad-att-preview__meta {
  margin-top: 12px;
  color: rgba(255, 255, 255, 0.7);
  font-size: var(--pad-fs-12, 12px);
  font-family: var(--pad-font-mono, monospace);
}
/* v3.9: image-loading 状态 (从 savedPath 读 base64 期间) */
.pad-att-preview__loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  color: rgba(255, 255, 255, 0.8);
}
.pad-att-preview__loading-text {
  font-size: var(--pad-fs-13, 13px);
}
.pad-att-preview__loading-path {
  font-size: var(--pad-fs-11, 11px);
  font-family: var(--pad-font-mono, monospace);
  color: rgba(255, 255, 255, 0.5);
  max-width: 80%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* file 预览面板 */
.pad-att-preview__file-panel {
  background: var(--pad-card, #fff);
  border-radius: var(--pad-radius-lg, 12px);
  width: 100%;
  max-width: 800px;
  max-height: 80%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
}
.pad-att-preview__file-head {
  display: flex;
  gap: 12px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--pad-border, #e5e7eb);
  background: var(--pad-bg-app, #f9fafb);
  flex-shrink: 0;
}
.pad-att-preview__file-icon {
  color: var(--pad-fg-secondary, #6b7280);
  flex-shrink: 0;
  margin-top: 2px;
}
.pad-att-preview__file-meta {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.pad-att-preview__file-name {
  font-size: var(--pad-fs-14, 14px);
  font-weight: var(--pad-fw-medium, 500);
  color: var(--pad-fg-primary, #111827);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pad-att-preview__file-path {
  font-size: var(--pad-fs-11, 11px);
  color: var(--pad-fg-tertiary, #9ca3af);
  font-family: var(--pad-font-mono, monospace);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pad-att-preview__file-stats {
  display: flex;
  gap: 6px;
  font-size: var(--pad-fs-11, 11px);
  color: var(--pad-fg-tertiary, #9ca3af);
  font-family: var(--pad-font-mono, monospace);
}
.pad-att-preview__file-body {
  flex: 1;
  min-height: 0;
  margin: 0;
  padding: 14px 16px;
  font-size: var(--pad-fs-12, 12px);
  font-family: var(--pad-font-mono, monospace);
  line-height: 1.6;
  color: var(--pad-fg-primary, #111827);
  background: var(--pad-bg-app, #f9fafb);
  white-space: pre;
  overflow: auto;
}
.pad-att-preview__file-loading {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 32px;
  color: var(--pad-fg-secondary, #6b7280);
  font-size: var(--pad-fs-13, 13px);
}
.pad-att-preview__spin {
  animation: pad-att-preview-spin 1s linear infinite;
}
@keyframes pad-att-preview-spin {
  to { transform: rotate(360deg); }
}
.pad-att-preview__file-truncated {
  padding: 6px 16px;
  background: var(--pad-warning-soft, #fffbeb);
  color: var(--pad-warning-text, #b45309);
  font-size: var(--pad-fs-11, 11px);
  text-align: center;
  flex-shrink: 0;
}
</style>
