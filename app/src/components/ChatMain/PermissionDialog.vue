<script setup lang="ts">
/**
 * PermissionDialog — v0.4.1+ tool permission 确认弹窗
 *
 * 场景: sidecar 收到 LLM 调 tool 的请求 (e.g. LLM 决定读 README.md) → Pi SDK
 * beforeToolCall hook 拦截 → emit permission_request 给 FE → chat store 调到
 * uiStore.openPermissionDialog → 这个组件弹出来
 *
 * 行为:
 * - 显示 tool name (read/write/edit/bash/ls/find/grep) + 参数
 * - 用户点 "允许" → tauri.sendPermissionResponse(toolCallId, true) → sidecar 放行
 * - 用户点 "拒绝" → tauri.sendPermissionResponse(toolCallId, false) → sidecar 阻止
 * - 弹窗只能点一个按钮, sidecar 在等响应 (同步)
 *
 * 设计: 跟 minimal 风格一致 — 简单 modal + 卡片 + 主色按钮, 不打扰
 */
import { computed } from 'vue';
import { storeToRefs } from 'pinia';
import { Shield, ShieldCheck, ShieldX, X } from 'lucide-vue-next';
import { useUiStore } from '@/stores/ui';
import { piTauri } from '@/lib/tauri';

const uiStore = useUiStore();
const { pendingPermission } = storeToRefs(uiStore);

const isOpen = computed(() => pendingPermission.value !== null);

/** tool name 翻译成中文 (跟 pi-coding-agent 7 工具对齐) */
const TOOL_LABEL: Record<string, string> = {
  read: '读取文件',
  write: '写入文件',
  edit: '编辑文件',
  bash: '执行命令',
  ls: '列出目录',
  find: '查找文件',
  grep: '搜索内容',
};

const toolLabel = computed(() => {
  if (!pendingPermission.value) return '';
  return TOOL_LABEL[pendingPermission.value.toolName] || pendingPermission.value.toolName;
});

const toolArgs = computed(() => {
  if (!pendingPermission.value) return [] as Array<[string, string]>;
  return Object.entries(pendingPermission.value.args).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]);
});

async function respond(allow: boolean) {
  const req = pendingPermission.value;
  if (!req) return;
  console.log('[PermissionDialog] respond', { allow, sessionId: req.sessionId, id: req.toolCallId });
  try {
    // v0.5.0: Pi SDK 通用 extension UI 协议 — 弹窗响应走 RpcCommand { type: 'extension_ui_response' }
    //   替代 v0.4.x 的 sendPermissionResponse 特殊 invoke.
    //   跟 v0.4.x permission_request 兼容: req.toolCallId 实际是 extension_ui_request event.id
    //   (chat store 解析 extension_ui_request 时把 event.id 存为 toolCallId 字段).
    //   RpcExtensionUIResponse schema: { type: 'extension_ui_response', id, confirmed: boolean }
    //   详见 @earendil-works/pi-coding-agent/modes/rpc/rpc-types.
    await piTauri.sendRpcCommand(req.sessionId, {
      type: 'extension_ui_response',
      id: req.toolCallId,
      confirmed: allow,
    });
  } catch (e) {
    console.error('[PermissionDialog] sendRpcCommand(extension_ui_response) failed', e);
  }
  // 立即关弹窗, 不等服务端 tool_end event (不然有视觉延迟)
  uiStore.closePermissionDialog();
}
</script>

<template>
  <!--
    v0.5.0: 不再 Teleport to body + 居中 modal.
    inline 渲染在 ChatMain .pad-chatmain__composer-area 内、Composer 正上方.
    inline flow 性质保证弹窗底边始终贴 Composer 顶边, Composer 高度动态变化时弹窗自然跟随.
    不用 ResizeObserver 也不用 ResizeEvent, 浏览器 inline flow 自动处理.
  -->
  <Transition name="perm-slide-up">
    <div v-if="isOpen" class="perm-dialog" role="alertdialog" aria-modal="false">
      <div class="perm-dialog__head">
        <Shield :size="16" :stroke-width="1.75" class="perm-dialog__head-icon" />
        <span class="perm-dialog__head-title">工具权限确认</span>
        <button class="perm-dialog__close" title="拒绝" @click="respond(false)">
          <X :size="14" :stroke-width="1.75" />
        </button>
      </div>
      <div class="perm-dialog__body">
        <p class="perm-dialog__desc">
          AI 想执行 <strong>{{ toolLabel }}</strong> 操作, 是否允许?
        </p>
        <div v-if="toolArgs.length > 0" class="perm-dialog__args">
          <div v-for="[k, v] in toolArgs" :key="k" class="perm-dialog__arg">
            <span class="perm-dialog__arg-key">{{ k }}</span>
            <code class="perm-dialog__arg-value">{{ v }}</code>
          </div>
        </div>
        <p v-else class="perm-dialog__desc-empty">(无参数)</p>
      </div>
      <div class="perm-dialog__foot">
        <button class="perm-dialog__btn perm-dialog__btn--deny" @click="respond(false)">
          <ShieldX :size="13" :stroke-width="1.75" />
          <span>拒绝</span>
        </button>
        <button class="perm-dialog__btn perm-dialog__btn--allow" @click="respond(true)">
          <ShieldCheck :size="13" :stroke-width="1.75" />
          <span>允许</span>
        </button>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
/*
 * v0.5.0: inline 浮层, 不再 fixed 全屏 modal.
 * 位置由父容器 (ChatMain .pad-chatmain__composer-area 内部, Composer 正上方) 决定.
 * 不需要 position: absolute / fixed, 跟 Composer 同列 inline 渲染.
 *
 * 父容器 padding: 0 16px 12px 已经是 chatmain 准备好, 这里弹窗 + Composer 共用居中 720px.
 * 弹窗自己加 margin-bottom 跟 Composer 留 8px 视觉间距.
 */
.perm-dialog {
  margin: 0 0 8px;
  background: var(--pad-popover);
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-lg);
  box-shadow: var(--pad-shadow-modal-large);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.perm-dialog__head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--pad-divider);
  background: var(--pad-bg-active);
}
.perm-dialog__head-icon {
  color: var(--pad-accent);
}
.perm-dialog__head-title {
  font-size: var(--pad-fs-13);
  font-weight: var(--pad-fw-medium);
  color: var(--pad-fg-primary);
  flex: 1;
}
.perm-dialog__close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: var(--pad-radius-sm);
  background: transparent;
  border: none;
  color: var(--pad-fg-tertiary);
  cursor: pointer;
  transition: background var(--pad-dur-fast) ease, color var(--pad-dur-fast) ease;
}
.perm-dialog__close:hover {
  background: var(--pad-bg-hover);
  color: var(--pad-fg-primary);
}
.perm-dialog__body {
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.perm-dialog__desc {
  font-size: var(--pad-fs-12);
  color: var(--pad-fg-secondary);
  line-height: 1.5;
  margin: 0;
}
.perm-dialog__desc strong {
  color: var(--pad-fg-primary);
  font-weight: var(--pad-fw-medium);
}
.perm-dialog__desc-empty {
  font-size: var(--pad-fs-12);
  color: var(--pad-fg-tertiary);
  font-style: italic;
  margin: 0;
}
.perm-dialog__args {
  background: var(--pad-muted);
  border: 1px solid var(--pad-divider);
  border-radius: var(--pad-radius-md);
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 140px;
  overflow-y: auto;
}
.perm-dialog__arg {
  display: flex;
  gap: 8px;
  align-items: baseline;
  font-size: var(--pad-fs-12);
}
.perm-dialog__arg-key {
  color: var(--pad-fg-tertiary);
  font-family: var(--pad-font-mono);
  font-size: var(--pad-fs-11);
  flex-shrink: 0;
  min-width: 60px;
}
.perm-dialog__arg-value {
  color: var(--pad-fg-primary);
  font-family: var(--pad-font-mono);
  font-size: var(--pad-fs-12);
  word-break: break-all;
  flex: 1;
  background: transparent;
  border: none;
  padding: 0;
}
.perm-dialog__foot {
  display: flex;
  gap: 8px;
  padding: 10px 14px;
  border-top: 1px solid var(--pad-divider);
  background: var(--pad-bg-input);
  justify-content: flex-end;
}
.perm-dialog__btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 12px;
  border-radius: var(--pad-radius-md);
  font-size: var(--pad-fs-12);
  font-weight: var(--pad-fw-medium);
  border: 1px solid transparent;
  cursor: pointer;
  transition:
    background var(--pad-dur-fast) ease,
    border-color var(--pad-dur-fast) ease;
  font-family: inherit;
}
.perm-dialog__btn--deny {
  background: transparent;
  color: var(--pad-fg-secondary);
  border-color: var(--pad-border);
}
.perm-dialog__btn--deny:hover {
  background: var(--pad-bg-hover);
  color: var(--pad-fg-primary);
  border-color: var(--pad-fg-tertiary);
}
.perm-dialog__btn--allow {
  background: var(--pad-primary);
  color: var(--pad-fg-inverse);
  border-color: var(--pad-primary);
}
.perm-dialog__btn--allow:hover {
  background: var(--pad-accent-hover);
  border-color: var(--pad-accent-hover);
}

/* v0.5.0: 从输入框上方"滑出"动画. 不用 fade, 用 translateY 表现"从下面冒出来"  */
.perm-slide-up-enter-active,
.perm-slide-up-leave-active {
  transition:
    opacity var(--pad-dur-base) var(--pad-ease-out-soft),
    transform var(--pad-dur-base) var(--pad-ease-out-soft);
  transform-origin: bottom center;
}
.perm-slide-up-enter-from,
.perm-slide-up-leave-to {
  opacity: 0;
  transform: translateY(8px);
}
</style>
