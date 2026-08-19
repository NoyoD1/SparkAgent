<script setup lang="ts">
/**
 * ConfirmDialog · 通用 in-app 确认弹窗 (Phase 1)
 *
 * 替代 `window.confirm()`, 走 in-app 弹窗 (跟 PermissionDialog 同 pattern)
 * Phase 3+ 用于 archive / delete-permanently / 后续所有二次确认
 *
 * 用法:
 *   <ConfirmDialog
 *     v-model:open="confirmOpen"
 *     title="归档这个 session?"
 *     message="可在顶部归档处恢复或永久删除"
 *     confirm-label="归档"
 *     @confirm="onConfirm"
 *   />
 */
import { onMounted, onUnmounted, watch } from 'vue';

interface Props {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** 危险操作 (红色按钮 + 红色 hover), 例如 permanent delete */
  danger?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  confirmLabel: '确定',
  cancelLabel: '取消',
  danger: false,
});

const emit = defineEmits<{
  'update:open': [value: boolean];
  confirm: [];
  cancel: [];
}>();

function onConfirm() {
  emit('confirm');
  emit('update:open', false);
}

function onCancel() {
  emit('cancel');
  emit('update:open', false);
}

function onBackdropClick(e: MouseEvent) {
  if (e.target === e.currentTarget) {
    onCancel();
  }
}

function onKeydown(e: KeyboardEvent) {
  if (!props.open) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    onCancel();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    onConfirm();
  }
}

onMounted(() => {
  document.addEventListener('keydown', onKeydown);
});

onUnmounted(() => {
  document.removeEventListener('keydown', onKeydown);
});

// 打开时锁 body scroll
watch(
  () => props.open,
  (open) => {
    document.body.style.overflow = open ? 'hidden' : '';
  },
);
</script>

<template>
  <Teleport to="body">
    <Transition name="pad-confirm-fade">
      <div v-if="open" class="pad-confirm-backdrop" @click="onBackdropClick">
        <div class="pad-confirm-modal" :class="{ 'is-danger': danger }" role="dialog" :aria-label="title">
          <h3 class="pad-confirm-title">{{ title }}</h3>
          <p class="pad-confirm-message">{{ message }}</p>
          <div class="pad-confirm-actions">
            <button
              type="button"
              class="pad-confirm-btn pad-confirm-btn--cancel"
              @click="onCancel"
            >
              {{ cancelLabel }}
            </button>
            <button
              type="button"
              class="pad-confirm-btn pad-confirm-btn--confirm"
              :class="{ 'is-danger': danger }"
              @click="onConfirm"
            >
              {{ confirmLabel }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.pad-confirm-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
}

.pad-confirm-modal {
  background: var(--pad-bg-card, #ffffff);
  border: 1px solid var(--pad-border, rgba(0, 0, 0, 0.1));
  border-radius: var(--pad-radius-lg, 8px);
  padding: var(--pad-sp-6, 24px);
  max-width: 420px;
  width: 90%;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
}

.pad-confirm-title {
  margin: 0 0 var(--pad-sp-3, 12px);
  font-size: var(--pad-fs-15, 15px);
  font-weight: var(--pad-fw-medium, 500);
  color: var(--pad-fg-primary, #1a1a1a);
  line-height: 1.4;
}

.pad-confirm-message {
  margin: 0 0 var(--pad-sp-5, 20px);
  font-size: var(--pad-fs-13, 13px);
  color: var(--pad-fg-secondary, #4a4a4a);
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

.pad-confirm-actions {
  display: flex;
  gap: var(--pad-sp-2, 8px);
  justify-content: flex-end;
}

.pad-confirm-btn {
  padding: var(--pad-sp-2, 8px) var(--pad-sp-4, 16px);
  border-radius: var(--pad-radius-md, 6px);
  font-size: var(--pad-fs-13, 13px);
  cursor: pointer;
  border: 1px solid var(--pad-border, rgba(0, 0, 0, 0.1));
  background: transparent;
  color: var(--pad-fg-primary, #1a1a1a);
  transition:
    background var(--pad-dur-fast, 0.15s) ease,
    border-color var(--pad-dur-fast, 0.15s) ease,
    color var(--pad-dur-fast, 0.15s) ease;
}

.pad-confirm-btn:hover {
  background: var(--pad-bg-hover, rgba(0, 0, 0, 0.05));
}

.pad-confirm-btn--confirm {
  background: var(--pad-accent, #3b82f6);
  color: white;
  border-color: var(--pad-accent, #3b82f6);
}

.pad-confirm-btn--confirm:hover {
  opacity: 0.9;
}

.pad-confirm-btn--confirm.is-danger {
  background: var(--pad-danger, #ef4444);
  border-color: var(--pad-danger, #ef4444);
}

/* Transition */
.pad-confirm-fade-enter-active,
.pad-confirm-fade-leave-active {
  transition: opacity 0.15s ease;
}
.pad-confirm-fade-enter-from,
.pad-confirm-fade-leave-to {
  opacity: 0;
}
</style>
