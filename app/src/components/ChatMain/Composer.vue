<script setup lang="ts">
/**
 * Composer — textarea + toolbar + 当前 active provider/model chip (可切换) + mic/send.
 * 1:1 mirrors chat.html's bottom composer, 但 model chip 改成 active config.
 * v3: model 菜单视觉跟 PadSelect 弹层统一 (hover 灰底 / active 紫底+左 2px accent / checkmark)
 * v0.4.1+: 加 tool permission 按钮 + dropdown (3 选 1: ask / smart / allow)
 */
import { ref, computed, nextTick, onMounted, onUnmounted, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { Plus, Image, Paperclip, ChevronDown, Mic, ArrowUp, Square, AlertTriangle, Star, Check, Hand, Sparkles, CheckCheck } from 'lucide-vue-next';
import { useChatStore } from '@/stores/chat';
import { useSessionStore } from '@/stores/session';
import { useConfigStore, PROVIDER_OPTIONS, PERMISSION_MODE_OPTIONS, type PermissionMode } from '@/stores/config';
import { useUiStore } from '@/stores/ui';
import { piTauri } from '@/lib/tauri';

const chatStore = useChatStore();
const sessionStore = useSessionStore();
const configStore = useConfigStore();
const uiStore = useUiStore();
const { activeSession } = storeToRefs(sessionStore);

const inputText = ref('');
const showModelMenu = ref(false);
// v0.4.1+ tool permission 菜单
const showPermissionMenu = ref(false);

const currentPermissionOption = computed(
  () => PERMISSION_MODE_OPTIONS.find((o) => o.value === configStore.permissionMode) ?? PERMISSION_MODE_OPTIONS[0],
);

/** v0.4.1+ 解析 PERMISSION_MODE_OPTIONS.icon 字符串成 lucide 组件 (因为 store 是纯 TS, 不能直接 import vue 组件) */
const PERMISSION_ICON_MAP: Record<string, any> = {
  Hand: Hand,
  Sparkles: Sparkles,
  CheckCheck: CheckCheck,
};
const currentPermissionIcon = computed(() => PERMISSION_ICON_MAP[currentPermissionOption.value.icon]);

function togglePermissionMenu() {
  showPermissionMenu.value = !showPermissionMenu.value;
  if (showPermissionMenu.value) showModelMenu.value = false;  // 二选一开
}

function pickPermission(mode: PermissionMode) {
  configStore.setPermissionMode(mode);
  showPermissionMenu.value = false;
  // v0.5.0: Pi SDK 0.84.2 没有"运行时修改 permission mode" 的 RpcCommand — permission mode
  //   是 AgentSession 创建时设的, 跟 session 绑定. 要换 mode 必须 abort 当前 session
  //   + 新建 session. 当前策略: mode 改了只存到 config, 下次新 session 自动用新 mode,
  //   当前 session 继续用旧 mode (走完当前 turn). 后续如果用户强烈要求"中途切换"再加
  //   abort + new_session RpcCommand 流程.
  console.log('[Composer] permission mode changed (v0.5.0: only applies to new sessions)', { mode });
}

// ===== v0.4.1+ 点外部关闭 permission menu =====
// 标准 pattern: document.addEventListener('click') + contains 检查. 跟 ChatMain.vue / PadSelect.vue 一致.
const permMenuRef = ref<HTMLElement | null>(null);
function onPermClickOutside(e: MouseEvent) {
  if (!showPermissionMenu.value) return;
  if (permMenuRef.value && !permMenuRef.value.contains(e.target as Node)) {
    showPermissionMenu.value = false;
  }
}
onMounted(() => document.addEventListener('click', onPermClickOutside));
onUnmounted(() => document.removeEventListener('click', onPermClickOutside));

const activeProvider = computed(() => configStore.activeProvider);
const activeModel = computed(() => configStore.activeModel);
const providerTypeLabel = computed(() => {
  const p = activeProvider.value;
  if (!p) return null;
  return PROVIDER_OPTIONS.find((o) => o.id === p.type)?.label ?? p.type;
});

const hasConfig = computed(() => !!activeProvider.value && !!activeModel.value);

const isStreaming = computed(() =>
  activeSession.value ? chatStore.isStreamingSession(activeSession.value.id) : false,
);

function toggleModelMenu() {
  showModelMenu.value = !showModelMenu.value;
}

function pickModel(providerId: string, modelId: string) {
  configStore.setActiveModel(providerId, modelId);
  showModelMenu.value = false;
}

function openSettings() {
  uiStore.openSettings('provider');
  showModelMenu.value = false;
}

async function send() {
  const text = inputText.value.trim();
  if (!text) return;
  if (isStreaming.value) return;
  if (!hasConfig.value) {
    openSettings();
    return;
  }
  inputText.value = '';
  // v0.3.5+: sendPrompt 自动确保 session 存在 (无 workspace 会弹 folder picker)
  await chatStore.sendPrompt(text);
}

/**
 * v0.5.0+: 中断按钮 (send 变 stop). 走 Pi SDK abort RpcCommand
 *   透传到 sidecar → AgentSession.abort() → 停 LLM stream + tool call
 * 期间 (abort → agent_end 之间) userAborted=true, UI 状态保持"停止中"视觉,
 *   agent_end event 来后 store 翻 streaming=false, button 自动恢复成 send.
 */
const userAborted = ref(false);
async function stop() {
  const sid = activeSession.value?.id;
  if (!sid) return;
  userAborted.value = true;
  try {
    await piTauri.sendRpcCommand(sid, { type: 'abort' });
  } catch (e) {
    console.error('[Composer] abort RpcCommand failed', e);
    // 即使失败也清 flag, 让用户能继续操作
    userAborted.value = false;
  }
}

// 监听 streaming 变化: 收到 agent_end 后清 userAborted
watch(isStreaming, (s) => {
  if (!s) userAborted.value = false;
});

/** 外部 (ChatMain quick prompt chips 等) 调用, 填充输入框. 已有内容会追加空格 + 新文本. */
function setText(text: string) {
  const cur = inputText.value.trimEnd();
  inputText.value = cur ? `${cur} ${text}` : text;
  // 让 textarea 重新聚焦 + 高度自适应
  nextTick(() => {
    const ta = document.querySelector('.pad-composer__input') as HTMLTextAreaElement | null;
    if (ta) {
      ta.focus();
      // 把光标放末尾
      const len = ta.value.length;
      ta.setSelectionRange(len, len);
      autoResize();
    }
  });
}

defineExpose({ setText });

// ===== v0.3.7+ textarea 自动高度 =====
// 行为: 1 行 (24px line-height + 2*4 padding) 起步, 多行时按 scrollHeight 长高, 上限 8 行 (200px).
// 超过 8 行 → 内部滚动 (overflow-y: auto), 整体 composer 高度不再涨, 不挤掉消息列表.
const textareaRef = ref<HTMLTextAreaElement | null>(null);
const COMPOSER_MAX_H = 200;

function autoResize() {
  const ta = textareaRef.value;
  if (!ta) return;
  ta.style.height = 'auto'; // 先重置, 才能读到真实的 scrollHeight
  const h = Math.min(ta.scrollHeight, COMPOSER_MAX_H);
  ta.style.height = `${h}px`;
  ta.style.overflowY = ta.scrollHeight > COMPOSER_MAX_H ? 'auto' : 'hidden';
}

watch(inputText, () => nextTick(autoResize));
onMounted(() => nextTick(autoResize));
</script>

<template>
  <div class="pad-composer">
    <textarea
      ref="textareaRef"
      v-model="inputText"
      class="pad-composer__input"
      rows="2"
      :placeholder="hasConfig ? '帮你编写代码、调试 Bug、优化性能等开发工作，交付生产级代码产物。' : '先在 Settings → Providers 加个 provider, 然后回这里发消息'"
      @input="autoResize"
      @keydown.enter.exact.prevent="send"
    />
    <div class="pad-composer__bar">
      <div class="pad-composer__bar-left">
        <button class="pad-composer__iconbtn" title="添加上下文">
          <Plus :size="16" :stroke-width="1.75" />
        </button>
        <button class="pad-composer__iconbtn" title="附加图片">
          <Image :size="16" :stroke-width="1.75" />
        </button>
        <button class="pad-composer__iconbtn" title="附加文件">
          <Paperclip :size="16" :stroke-width="1.75" />
        </button>
        <!-- v0.4.1+ tool permission 设置按钮: 3 选 1 dropdown (ask / smart / allow) -->
        <div class="pad-composer__perm-wrap" ref="permMenuRef">
          <button
            class="pad-composer__permchip"
            :class="{ 'is-open': showPermissionMenu }"
            :title="`工具权限: ${currentPermissionOption.label} — ${currentPermissionOption.hint}`"
            @click="togglePermissionMenu"
          >
            <component :is="currentPermissionIcon" :size="14" :stroke-width="1.75" />
            <span class="pad-composer__permchip-label">{{ currentPermissionOption.label }}</span>
            <ChevronDown :size="12" :stroke-width="1.75" :class="['pad-composer__permchip-chev', { 'is-flipped': showPermissionMenu }]" />
          </button>

          <div v-if="showPermissionMenu" class="pad-composer__perm-menu" @click.stop>
            <div class="pad-composer__perm-menu-head">
              <span>工具权限模式</span>
            </div>
            <button
              v-for="opt in PERMISSION_MODE_OPTIONS"
              :key="opt.value"
              class="pad-composer__perm-menu-item"
              :class="{ 'is-active': opt.value === configStore.permissionMode }"
              @click="pickPermission(opt.value)"
            >
              <span class="pad-composer__perm-menu-item-body">
                <span class="pad-composer__perm-menu-item-label">{{ opt.label }}</span>
                <span class="pad-composer__perm-menu-item-hint">{{ opt.hint }}</span>
              </span>
              <Check
                v-if="opt.value === configStore.permissionMode"
                :size="14"
                :stroke-width="2"
                class="pad-composer__perm-menu-item-check"
              />
            </button>
            <div class="pad-composer__perm-menu-foot">
              <span class="pad-composer__perm-menu-foot-text">v0.4.1 占位 — 后端 confirm 弹窗 v0.4.1+ 接</span>
            </div>
          </div>
        </div>
      </div>
      <div class="pad-composer__bar-right">
        <div class="pad-composer__model-wrap">
          <button
            class="pad-composer__modelchip"
            :class="{ 'is-warn': !hasConfig, 'is-open': showModelMenu }"
            :title="hasConfig ? `当前: ${providerTypeLabel} / ${activeModel?.id}` : '未配置 provider, 点击去设置'"
            @click="toggleModelMenu"
          >
            <AlertTriangle v-if="!hasConfig" :size="14" :stroke-width="1.75" />
            <Star v-else :size="12" :stroke-width="1.75" fill="currentColor" />
            <span class="pad-composer__chip-label">
              <span v-if="hasConfig">{{ activeModel?.id }}</span>
              <span v-else>未配置</span>
            </span>
            <ChevronDown :size="14" :stroke-width="1.75" :class="['pad-composer__chip-chev', { 'is-flipped': showModelMenu }]" />
          </button>

          <div v-if="showModelMenu" class="pad-composer__model-menu" @click.stop>
            <div class="pad-composer__model-menu-head">
              <span>切换 active provider + model</span>
              <button class="pad-composer__model-menu-link" @click="openSettings">去设置 →</button>
            </div>
            <div v-if="configStore.providers.length === 0" class="pad-composer__model-menu-empty">
              还没有 provider, 点"去设置"添加.
            </div>
            <template v-else>
              <div
                v-for="p in configStore.providers"
                :key="p.id"
                class="pad-composer__model-menu-group"
              >
                <div class="pad-composer__model-menu-group-label">
                  <span>{{ p.label }}</span>
                  <span
                    v-if="p.id === configStore.activeProviderId"
                    class="pad-composer__model-menu-active-tag"
                  >active</span>
                </div>
                <!-- v0.3.8.5: 过滤掉用户在 Settings 停用的 model (m.enabled === false) -->
                <div
                  v-if="configStore.enabledModels(p.id).length === 0"
                  class="pad-composer__model-menu-empty"
                >
                  (无可用模型 — 去 Settings 启用)
                </div>
                <button
                  v-for="m in configStore.enabledModels(p.id)"
                  :key="m.id"
                  class="pad-composer__model-menu-item"
                  :class="{ 'is-active': p.id === configStore.activeProviderId && p.activeModelId === m.id }"
                  @click="pickModel(p.id, m.id)"
                >
                  <span class="pad-composer__model-menu-item-body">
                    <span class="pad-composer__model-menu-item-id">{{ m.id }}</span>
                    <span v-if="m.label" class="pad-composer__model-menu-item-label">{{ m.label }}</span>
                  </span>
                  <Check
                    v-if="p.id === configStore.activeProviderId && p.activeModelId === m.id"
                    :size="14"
                    :stroke-width="2"
                    class="pad-composer__model-menu-item-check"
                  />
                </button>
              </div>
            </template>
          </div>
        </div>
        <button class="pad-composer__iconbtn" title="语音输入">
          <Mic :size="16" :stroke-width="1.75" />
        </button>
        <button
          class="pad-composer__send"
          :class="{ 'is-stop': isStreaming, 'is-stopping': isStreaming && userAborted }"
          :disabled="!hasConfig || (!isStreaming && !inputText.trim())"
          :title="
            isStreaming
              ? userAborted
                ? '正在停止…'
                : '停止生成 (Esc)'
              : hasConfig
                ? '发送'
                : '去设置配 provider'
          "
          @click="isStreaming ? stop() : send()"
        >
          <ArrowUp v-if="!isStreaming" :size="16" :stroke-width="2" />
          <Square v-else :size="12" :stroke-width="2" fill="currentColor" />
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pad-composer {
  width: 100%;
  background: var(--pad-bg-input);
  border-radius: var(--pad-radius-xl);
  padding: 10px 12px 8px;
  position: relative;
  /* v0.3.7+ floating shadow: 让 composer 看起来浮在消息上方 */
  box-shadow:
    0 8px 24px rgba(0, 0, 0, 0.06),
    0 2px 6px rgba(0, 0, 0, 0.03),
    0 0 0 1px var(--pad-border);
  /* v0.3.8.25: 去掉 :focus-within 状态变化, 选中/不选中看着一样.
   * 用户反馈"输入框选中是也不要有边框高亮, 就保持正常状态".
   * minimalist 风格下 focus 状态变化 = 视觉噪音, 不加. */
  transition: none;
}
.pad-composer__input {
  display: block;
  width: 100%;
  background: transparent;
  border: none;
  outline: none;
  resize: none;
  font-size: var(--pad-fs-14);
  line-height: 22px;
  color: var(--pad-fg-primary);
  font-family: var(--pad-font-sans);
  padding: 2px 2px 0;
  /* v0.3.8.1: 初始 2 行高 (44px), 比之前的 22px 看起来更舒服 */
  min-height: 44px;
  max-height: 200px;
  overflow-y: hidden;
  box-sizing: border-box;
}
.pad-composer__input:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.pad-composer__input::placeholder {
  color: var(--pad-fg-tertiary);
}
.pad-composer__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: var(--pad-sp-2);
}
.pad-composer__bar-left,
.pad-composer__bar-right {
  display: flex;
  align-items: center;
  gap: var(--pad-sp-1);
}
.pad-composer__iconbtn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: var(--pad-radius-md);
  color: var(--pad-fg-secondary);
  background: transparent;
  border: none;
  cursor: pointer;
  transition:
    background var(--pad-dur-fast) ease,
    color var(--pad-dur-fast) ease;
}
.pad-composer__iconbtn:hover {
  background: var(--pad-bg-hover);
  color: var(--pad-fg-primary);
}
.pad-composer__model-wrap {
  position: relative;
}

/* ===== v0.4.1+ tool permission 按钮 + dropdown ===== */
/* 视觉跟 model chip + model menu 完全对齐 (统一 popover 风格) */
.pad-composer__perm-wrap {
  position: relative;
}
.pad-composer__permchip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 28px;
  padding: 0 4px 0 8px;
  margin-left: var(--pad-sp-1);
  border-radius: var(--pad-radius-md);
  font-size: var(--pad-fs-12);
  color: var(--pad-fg-secondary);
  background: transparent;
  border: 1px solid transparent;
  cursor: pointer;
  font-family: inherit;
  transition:
    background var(--pad-dur-fast) ease,
    color var(--pad-dur-fast) ease,
    border-color var(--pad-dur-fast) ease;
}
.pad-composer__permchip:hover {
  background: var(--pad-bg-hover);
  color: var(--pad-fg-primary);
}
.pad-composer__permchip.is-open {
  background: var(--pad-bg-active);
  color: var(--pad-fg-primary);
  border-color: var(--pad-border);
}
.pad-composer__permchip-label {
  white-space: nowrap;
}
.pad-composer__permchip-chev {
  color: var(--pad-fg-tertiary);
  transition: transform var(--pad-dur-base) var(--pad-ease-in-out);
}
.pad-composer__permchip-chev.is-flipped {
  transform: rotate(180deg);
}
.pad-composer__perm-menu {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 0;
  min-width: 240px;
  background: var(--pad-popover);
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-lg);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.10), 0 2px 8px rgba(0, 0, 0, 0.04);
  padding: 4px 0 6px;
  z-index: 30;
}
.pad-composer__perm-menu-head {
  padding: 8px 12px;
  border-bottom: 1px solid var(--pad-divider);
  font-size: var(--pad-fs-11);
  color: var(--pad-fg-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  font-weight: var(--pad-fw-medium);
}
/* item: 跟 model menu item 视觉统一 (8/12 padding + 2px 左侧 active accent) */
.pad-composer__perm-menu-item {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  gap: var(--pad-sp-2);
  min-height: 38px;
  padding: 8px 12px 8px 14px;
  text-align: left;
  background: transparent;
  border: none;
  border-radius: var(--pad-radius-md);
  cursor: pointer;
  transition: background var(--pad-dur-fast) ease;
  font-family: inherit;
  color: var(--pad-fg-primary);
}
.pad-composer__perm-menu-item:hover:not(.is-active) {
  background: var(--pad-bg-hover);
}
.pad-composer__perm-menu-item.is-active {
  background: var(--pad-accent-soft);
  color: var(--pad-fg-primary);
  font-weight: var(--pad-fw-medium);
}
.pad-composer__perm-menu-item.is-active::before {
  content: '';
  position: absolute;
  left: 4px;
  top: 8px;
  bottom: 8px;
  width: 2px;
  border-radius: 1px;
  background: var(--pad-accent);
}
.pad-composer__perm-menu-item-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}
.pad-composer__perm-menu-item-label {
  font-size: var(--pad-fs-13);
  color: var(--pad-fg-primary);
  font-weight: inherit;
}
.pad-composer__perm-menu-item-hint {
  font-size: var(--pad-fs-11);
  color: var(--pad-fg-tertiary);
  font-weight: var(--pad-fw-regular);
}
.pad-composer__perm-menu-item.is-active .pad-composer__perm-menu-item-hint {
  color: var(--pad-fg-secondary);
}
.pad-composer__perm-menu-item-check {
  color: var(--pad-accent);
  flex-shrink: 0;
  width: 16px;
  height: 16px;
}
.pad-composer__perm-menu-foot {
  padding: 6px 12px 4px;
  border-top: 1px solid var(--pad-divider);
  margin-top: 2px;
}
.pad-composer__perm-menu-foot-text {
  font-size: var(--pad-fs-10);
  color: var(--pad-fg-tertiary);
  font-style: italic;
}
.pad-composer__modelchip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 6px 0 var(--pad-sp-2);
  border-radius: var(--pad-radius-md);
  font-size: var(--pad-fs-13);
  color: var(--pad-fg-secondary);
  background: transparent;
  border: 1px solid transparent;
  cursor: pointer;
  transition:
    background var(--pad-dur-fast) ease,
    color var(--pad-dur-fast) ease,
    border-color var(--pad-dur-fast) ease;
}
.pad-composer__modelchip:hover {
  background: var(--pad-bg-hover);
  color: var(--pad-fg-primary);
}
.pad-composer__modelchip.is-open {
  background: var(--pad-bg-active);
  color: var(--pad-fg-primary);
  border-color: var(--pad-border);
}
.pad-composer__modelchip.is-warn {
  color: var(--pad-warning-text);
}
.pad-composer__chip-label {
  max-width: 180px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pad-composer__chip-chev {
  color: var(--pad-fg-tertiary);
  transition: transform var(--pad-dur-base) var(--pad-ease-in-out);
}
.pad-composer__chip-chev.is-flipped {
  transform: rotate(180deg);
}

/* model menu 视觉跟 PadSelect 弹层统一 */
.pad-composer__model-menu {
  position: absolute;
  bottom: calc(100% + 6px);
  right: 0;
  min-width: 320px;
  max-width: 400px;
  max-height: 380px;
  overflow-y: auto;
  background: var(--pad-popover);
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-lg);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.10), 0 2px 8px rgba(0, 0, 0, 0.04);
  padding: 4px 0 6px;
  z-index: 30;
}
.pad-composer__model-menu-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid var(--pad-divider);
  font-size: var(--pad-fs-11);
  color: var(--pad-fg-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  font-weight: var(--pad-fw-medium);
}
.pad-composer__model-menu-link {
  font-size: var(--pad-fs-12);
  color: var(--pad-accent);
  background: transparent;
  border: none;
  cursor: pointer;
  text-transform: none;
  letter-spacing: 0;
  font-weight: var(--pad-fw-regular);
}
.pad-composer__model-menu-link:hover {
  text-decoration: underline;
}
.pad-composer__model-menu-group {
  padding: 4px 0;
}
.pad-composer__model-menu-group-label {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px 4px;
  font-size: var(--pad-fs-11);
  color: var(--pad-fg-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  font-weight: var(--pad-fw-medium);
}
.pad-composer__model-menu-active-tag {
  display: inline-block;
  font-size: var(--pad-fs-10);
  color: var(--pad-accent);
  background: var(--pad-accent-soft);
  border-radius: var(--pad-radius-pill);
  padding: 1px 6px;
  text-transform: none;
  letter-spacing: 0;
  font-weight: var(--pad-fw-medium);
}
/* item: 跟 PadSelect 完全一致 (8/14 padding + 2px 左侧 active accent) */
.pad-composer__model-menu-item {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  gap: var(--pad-sp-2);
  min-height: 36px;
  padding: 8px 12px 8px 14px;
  text-align: left;
  background: transparent;
  border: none;
  border-radius: var(--pad-radius-md);
  cursor: pointer;
  transition: background var(--pad-dur-fast) ease;
  font-family: inherit;
  color: var(--pad-fg-primary);
}
.pad-composer__model-menu-item:hover:not(.is-active) {
  /* v0.3.8.18: bg-200 → bg-hover (semantic role, dark 模式有覆盖) */
  background: var(--pad-bg-hover);
}
.pad-composer__model-menu-item.is-active {
  background: var(--pad-accent-soft);
  color: var(--pad-fg-primary);
  font-weight: var(--pad-fw-medium);
}
.pad-composer__model-menu-item.is-active::before {
  content: '';
  position: absolute;
  left: 4px;
  top: 8px;
  bottom: 8px;
  width: 2px;
  border-radius: 1px;
  background: var(--pad-accent);
}
.pad-composer__model-menu-item-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}
.pad-composer__model-menu-item-id {
  font-size: var(--pad-fs-13);
  color: var(--pad-fg-primary);
  font-family: var(--pad-font-mono);
  font-weight: inherit;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pad-composer__model-menu-item-label {
  font-size: var(--pad-fs-11);
  color: var(--pad-fg-tertiary);
  font-weight: var(--pad-fw-regular);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pad-composer__model-menu-item.is-active .pad-composer__model-menu-item-label {
  color: var(--pad-fg-secondary);
}
.pad-composer__model-menu-item-check {
  color: var(--pad-accent);
  flex-shrink: 0;
  width: 16px;
  height: 16px;
}
.pad-composer__model-menu-empty {
  padding: 6px 14px 8px;
  font-size: var(--pad-fs-12);
  color: var(--pad-fg-tertiary);
}
.pad-composer__send {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: var(--pad-radius-md);
  background: var(--pad-primary);
  color: var(--pad-fg-inverse);
  border: none;
  cursor: pointer;
  box-shadow: var(--pad-shadow-button);
  transition:
    background var(--pad-dur-fast) ease,
    transform var(--pad-dur-fast) ease;
}
.pad-composer__send:hover:not(:disabled) {
  background: var(--pad-accent-hover);
}
.pad-composer__send:disabled {
  opacity: 0.4;
  cursor: not-allowed;
  box-shadow: none;
}

/* v0.5.0+: streaming 时 send 变 stop (Square icon + 红色 bg) */
.pad-composer__send.is-stop {
  background: var(--pad-danger);
  color: var(--pad-fg-inverse);
  /* hover 不要用 accent-hover, 用 danger 的 hover 态 */
}
.pad-composer__send.is-stop:hover:not(:disabled) {
  background: var(--pad-danger-hover, color-mix(in srgb, var(--pad-danger) 88%, white 12%));
}
.pad-composer__send.is-stop.is-stopping {
  background: var(--pad-fg-tertiary);
  cursor: wait;
  /* 阻止连续点击导致多个 abort 命令 */
}
.pad-composer__send.is-stop.is-stopping:hover {
  background: var(--pad-fg-tertiary);
}
</style>
