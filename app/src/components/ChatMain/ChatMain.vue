<script setup lang="ts">
/**
 * ChatMain — middle column
 *
 * v0.3.7 重构:
 * 1. composer 改成 floating 浮层 (z-index 10, 上面有阴影 + 渐变 fade), 不再占用 flex slot
 * 2. scroll-to-bottom 按钮移到 chat-body 内的 absolute (bottom: 16px), 永远在 composer 上方, 不会盖到输入框
 * 3. chat-body 内增加 ChatMessageNav (左侧贴边的"消息轮次导航栏", 垂直线 + ticks + hover 预览)
 * 4. 保持 v0.3.5+ 的 hero/active 双分支
 */
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue';
import { storeToRefs } from 'pinia';
import {
  Code2,
  Monitor,
  Folder,
  FolderPlus,
  Check,
  ChevronDown,
  ArrowDown,
  Smartphone,
  BookOpen,
  Gamepad2,
  Wrench,
} from 'lucide-vue-next';
import { useChatStore } from '@/stores/chat';
import { useSessionStore } from '@/stores/session';
import { useConfigStore } from '@/stores/config';
import { pickFolder } from '@/lib/dialog';
import ChatHeader from './ChatHeader.vue';
import ChatMessage from './ChatMessage.vue';
import Composer from './Composer.vue';
import ChatMessageNav, { type ChatTurn } from './ChatMessageNav.vue';

const chatStore = useChatStore();
const sessionStore = useSessionStore();
const configStore = useConfigStore();
const { activeSession, activeWorkspace, workspaces } = storeToRefs(sessionStore);

const messages = computed(() =>
  activeSession.value ? chatStore.getMessages(activeSession.value.id) : []
);
const thinking = computed(() =>
  activeSession.value ? chatStore.getThinking(activeSession.value.id) : []
);

// streaming 状态暴露给 ChatMessage
const activeModelName = computed(() => configStore.activeModel?.id ?? '');
const isSessionStreaming = computed(() =>
  activeSession.value ? chatStore.isStreamingSession(activeSession.value.id) : false,
);
function isMessageStreaming(idx: number): boolean {
  if (!isSessionStreaming.value) return false;
  if (idx !== messages.value.length - 1) return false;
  const m = messages.value[idx];
  return !!m && m.role === 'assistant' && !m.content;
}

// thinking -> messageId 映射
const thinkingByMessageId = computed(() => {
  const map = new Map<string, typeof thinking.value[number]>();
  for (const t of thinking.value) map.set(t.messageId, t);
  return map;
});

// v0.3.8.6: toolCalls -> messageId 映射 (per-message tools 列表)
const toolCallsByMessageId = computed(() => {
  const tcList = activeSession.value ? chatStore.getToolCalls(activeSession.value.id) : [];
  const map = new Map<string, typeof tcList[number][]>();
  for (const t of tcList) {
    const arr = map.get(t.messageId) ?? [];
    arr.push(t);
    map.set(t.messageId, arr);
  }
  return map;
});

// ===== v0.3.7+ 轮次 (user 消息 + 紧跟的 assistant 消息) =====
const turns = computed<ChatTurn[]>(() => {
  const out: ChatTurn[] = [];
  const msgs = messages.value;
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].role !== 'user') continue;
    const userContent = msgs[i].content;
    let assistantContent = '';
    for (let j = i + 1; j < msgs.length; j++) {
      if (msgs[j].role === 'assistant') {
        assistantContent = msgs[j].content;
        break;
      }
    }
    out.push({
      id: msgs[i].id,  // 用 user message id 当 anchor (tick click 跳这里)
      userContent,
      assistantPreview: assistantContent.replace(/\n/g, ' ').slice(0, 120),
      isActive: false,  // v0.3.8.1: active 由 IntersectionObserver 决定, 不再硬编码最后一条
    });
  }
  return out;
});

const userMessagesCount = computed(() => turns.value.length);

// v0.3.8.1.3: 不再 prop 传 userMessageEls (Vue 组件 ref 拿到的是实例不是 DOM 元素,
// IntersectionObserver.observe(instance) 抛错). nav 内部用 scrollRoot.querySelectorAll 自己拿.

// ===== Quick prompt chips (initial hero) =====
const QUICK_PROMPTS = [
  { label: '应用开发', icon: Smartphone, template: '帮我开发一个应用，需求是：' },
  { label: '项目理解', icon: BookOpen, template: '请帮我理解当前项目的结构和核心代码：' },
  { label: '游戏创意', icon: Gamepad2, template: '我想做一个游戏，创意是：' },
  { label: '工具脚本', icon: Wrench, template: '请帮我写个工具脚本，用途是：' },
] as const;

const heroInputRef = ref<InstanceType<typeof Composer> | null>(null);
function applyQuickPrompt(template: string) {
  heroInputRef.value?.setText(template);
}

// ===== "本地" tab 下拉菜单 =====
const showLocalMenu = ref(false);
const localMenuRef = ref<HTMLDivElement | null>(null);
const pickingFolder = ref(false);

async function pickNewWorkspace() {
  if (pickingFolder.value) return;
  pickingFolder.value = true;
  try {
    const path = await pickFolder('选一个本地代码目录, 作为新工作区');
    if (path) {
      const ws = sessionStore.addWorkspace({ path });
      sessionStore.selectWorkspace(ws.id);
    }
  } finally {
    pickingFolder.value = false;
    showLocalMenu.value = false;
  }
}

function selectExistingWorkspace(id: string) {
  sessionStore.selectWorkspace(id);
  showLocalMenu.value = false;
}

function onClickOutside(e: MouseEvent) {
  if (!localMenuRef.value) return;
  if (localMenuRef.value.contains(e.target as Node)) return;
  showLocalMenu.value = false;
}
onMounted(() => document.addEventListener('click', onClickOutside));
onUnmounted(() => document.removeEventListener('click', onClickOutside));

const defaultHint = computed(() => '~/PiAgent');

// ===== 消息列表自动滚底 + 跳底按钮 =====
const listRef = ref<HTMLDivElement | null>(null);
const NEAR_BOTTOM_PX = 100;
const isNearBottom = ref(true);
const showScrollToBottom = ref(false);

function getDistanceFromBottom(): number {
  const el = listRef.value;
  if (!el) return 0;
  return el.scrollHeight - el.scrollTop - el.clientHeight;
}

function scrollToBottom(smooth = true) {
  const el = listRef.value;
  if (!el) return;
  el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
}

function onListScroll() {
  const dist = getDistanceFromBottom();
  isNearBottom.value = dist <= NEAR_BOTTOM_PX;
  showScrollToBottom.value = !isNearBottom.value;
}

function onJumpToBottom() {
  scrollToBottom(true);
  isNearBottom.value = true;
  showScrollToBottom.value = false;
}

watch(
  () => messages.value.length,
  () => {
    if (!isNearBottom.value) return;
    nextTick(() => scrollToBottom(true));
  },
);

watch(
  () => {
    const last = messages.value[messages.value.length - 1];
    return last?.id ? last.content.length : 0;
  },
  () => {
    if (!isNearBottom.value) return;
    nextTick(() => scrollToBottom(true));
  },
);

watch(
  () => activeSession.value?.id,
  () => {
    isNearBottom.value = true;
    showScrollToBottom.value = false;
    nextTick(() => scrollToBottom(false));
  },
);

// ===== nav tick click: 跳到对应 message =====
function jumpToMessage(messageId: string) {
  const list = listRef.value;
  if (!list) return;
  const el = list.querySelector(`[data-message-id="${messageId}"]`) as HTMLElement | null;
  if (el) {
    // v0.3.8.1 fix: 用 block:'center' 避免 'start' 把消息顶到 list 顶端
    // 触发整个 webview 滚动 (html 跟 list 都能滚). center 只滚到中间, 不会让 body 跳
    // 显式只滚 list (closest scrollable), 不让 body 跟动
    const listRect = list.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const offset = elRect.top - listRect.top - (listRect.height / 2) + (elRect.height / 2);
    list.scrollTo({
      top: list.scrollTop + offset,
      behavior: 'smooth',
    });
  }
}
</script>

<template>
  <section class="pad-chatmain">
    <!-- ============== ACTIVE SESSION ============== -->
    <template v-if="activeSession">
      <ChatHeader />

      <div class="pad-chatmain__body">
        <!-- 左侧贴边的消息轮次导航栏: v0.3.8.1 移到 list 外面, 跟 chat-body absolute, 不随消息滚动
         * v0.3.8.1.2: 改成 >= 1, 即使只有 1 条也显示 (单 tick 作 "回到顶部" 视觉锚点) -->
        <ChatMessageNav
          v-if="userMessagesCount >= 1"
          :turns="turns"
          :on-jump="jumpToMessage"
          :scroll-root="listRef"
        />

        <div ref="listRef" class="pad-chatmain__list pad-scroll" @scroll="onListScroll">
          <div class="pad-chatmain__list-inner">
            <ChatMessage
              v-for="(msg, idx) in messages"
              :key="msg.id"
              :message="msg"
              :thinking="msg.role === 'assistant' ? thinkingByMessageId.get(msg.id) : undefined"
              :tool-calls="msg.role === 'assistant' ? (toolCallsByMessageId.get(msg.id) || []) : []"
              :model-name="activeModelName"
              :is-streaming="isMessageStreaming(idx)"
            />
          </div>
        </div>

        <!-- 跳到底按钮: 浮动在 chat-body 底部, 永远在 composer 上方 -->
        <Transition name="pad-fade">
          <button
            v-show="showScrollToBottom"
            class="pad-jump-bottom"
            type="button"
            title="跳到最新消息"
            @click="onJumpToBottom"
          >
            <ArrowDown :size="14" :stroke-width="2" />
            <span>跳到底部</span>
          </button>
        </Transition>
      </div>

      <!-- composer 浮层: z-index 最高, 上面有渐变 fade + composer 自带 shadow -->
      <div class="pad-chatmain__composer-area">
        <Composer />
      </div>
    </template>

    <!-- ============== INITIAL HERO ============== -->
    <template v-else>
      <div class="pad-hero">
        <h1 class="pad-hero__title">
          <Code2 :size="34" :stroke-width="1.75" class="pad-hero__icon" />
          <span>Code with <span class="pad-hero__brand">Pi Agent</span></span>
        </h1>

        <div class="pad-hero__composer">
          <Composer ref="heroInputRef" />
        </div>

        <div ref="localMenuRef" class="pad-hero__tabstrip">
          <button
            class="pad-hero__tab pad-hero__tab--local"
            :class="{ 'is-open': showLocalMenu }"
            type="button"
            title="本地工作目录 / 新建工作区"
            :disabled="pickingFolder"
            @click="showLocalMenu = !showLocalMenu"
          >
            <Monitor :size="14" :stroke-width="1.75" />
            <span>本地</span>
            <ChevronDown
              :size="12"
              :stroke-width="2"
              :class="['pad-hero__tab-chev', { 'is-flipped': showLocalMenu }]"
            />
          </button>

          <span
            v-if="activeWorkspace"
            class="pad-hero__tab pad-hero__tab--readonly"
            :title="activeWorkspace.path"
          >
            <Folder :size="14" :stroke-width="1.75" />
            <span>{{ activeWorkspace.name }}</span>
          </span>
          <span v-else class="pad-hero__tab-hint">发消息会默认用 {{ defaultHint }}</span>

          <div v-if="showLocalMenu" class="pad-hero__local-menu" @click.stop>
            <button
              class="pad-hero__local-menu-item is-primary"
              type="button"
              :disabled="pickingFolder"
              @click="pickNewWorkspace"
            >
              <FolderPlus :size="13" :stroke-width="1.75" />
              <span>选择文件夹新建工作区</span>
            </button>
            <div v-if="workspaces.length > 0" class="pad-hero__local-menu-sep" />
            <template v-if="workspaces.length > 0">
              <div class="pad-hero__local-menu-head">切换工作区</div>
              <button
                v-for="ws in workspaces"
                :key="ws.id"
                class="pad-hero__local-menu-item"
                type="button"
                @click="selectExistingWorkspace(ws.id)"
              >
                <Folder :size="13" :stroke-width="1.75" />
                <span class="pad-hero__local-menu-name" :title="ws.path">{{ ws.name }}</span>
                <Check
                  v-if="ws.id === activeWorkspace?.id"
                  :size="13"
                  :stroke-width="2"
                  class="pad-hero__local-menu-check"
                />
              </button>
            </template>
          </div>
        </div>

        <div class="pad-hero__chips">
          <button
            v-for="qp in QUICK_PROMPTS"
            :key="qp.label"
            class="pad-hero__chip"
            type="button"
            @click="applyQuickPrompt(qp.template)"
          >
            <component :is="qp.icon" :size="14" :stroke-width="1.75" />
            <span>{{ qp.label }}</span>
          </button>
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
/* ===== chatmain 容器 ===== */
.pad-chatmain {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--pad-card);
  border-radius: var(--pad-radius-xl);
  overflow: hidden;
  position: relative;
}

/* ===== ACTIVE: chat body 包裹 list + jump 按钮 ===== */
.pad-chatmain__body {
  flex: 1;
  min-height: 0;
  position: relative;
  overflow: hidden;
}
.pad-chatmain__list {
  position: absolute;
  inset: 0;
  overflow-y: auto;
  /* v0.3.8.1: 底部 120px 留给 composer area + button + 视觉呼吸 */
  padding: 16px 0 120px 0;
}
.pad-chatmain__list-inner {
  display: flex;
  flex-direction: column;
  gap: 14px;
  /* v0.3.8.1: chat 内容居中 + 最大宽 880px, 宽屏不拉伸
   * 左 40 留给 nav tick 横向移动空间, 右 24 是消息右边距 */
  padding: 0 24px 0 40px;
  max-width: 880px;
  margin: 0 auto;
  width: 100%;
  box-sizing: border-box;
}

/* ===== jump 按钮: 在 chat body 内的底部中央 ===== */
.pad-jump-bottom {
  position: absolute;
  left: 50%;
  /* v0.3.8.1.2: bottom 16 → 32, 避免跟最后一条消息的 actions (margin-top:10) 视觉上撞 */
  bottom: 32px;
  transform: translateX(-50%);
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 12px;
  border-radius: var(--pad-radius-pill);
  font-size: var(--pad-fs-12);
  color: var(--pad-fg-primary);
  background: var(--pad-card);
  border: 1px solid var(--pad-border);
  box-shadow: var(--pad-shadow-popover);
  cursor: pointer;
  font-family: inherit;
  /* v0.3.8.1.2: z-index 5 → 50, 最高层, 不会被 message actions / list 等遮挡 */
  z-index: 50;
  transition:
    background var(--pad-dur-fast) ease,
    border-color var(--pad-dur-fast) ease,
    transform var(--pad-dur-fast) ease;
}
.pad-jump-bottom:hover {
  background: var(--pad-bg-hover);
  border-color: var(--pad-border-strong);
  transform: translateX(-50%) translateY(-1px);
}
.pad-jump-bottom:active {
  transform: translateX(-50%) translateY(0);
}
.pad-fade-enter-active,
.pad-fade-leave-active {
  transition: opacity var(--pad-dur-base) var(--pad-ease-out-soft),
              transform var(--pad-dur-base) var(--pad-ease-out-soft);
}
.pad-fade-enter-from,
.pad-fade-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(8px);
}

/* ===== composer 浮层 (v0.3.7+) ===== */
.pad-chatmain__composer-area {
  position: relative;
  flex-shrink: 0;
  z-index: 10;
  /* v0.3.8.1: 跟 list-inner 一样居中 + 最大宽 880px, 宽屏下输入框不跟着拉 */
  padding: 0 16px 12px;
  max-width: 880px;
  margin: 0 auto;
  width: 100%;
  box-sizing: border-box;
}
.pad-chatmain__composer-area::before {
  /* 浮层上方的渐变 fade: 让消息列表滚到底时自然消失在 composer 后
   * v0.3.8.1.2: 加 border-radius 倒角 (16px top) + 跟 composer 同宽 (left/right 16px, 跟 area padding 对齐),
   * 倒角位置跟 composer 顶角弧度对应, 避免穿帮 */
  content: '';
  position: absolute;
  top: -48px;
  /* left/right 跟 area padding 16px 对齐, 跟 composer card 同宽 */
  left: 16px;
  right: 16px;
  height: 48px;
  background: linear-gradient(
    to top,
    var(--pad-card) 0%,
    var(--pad-card) 40%,
    transparent 100%
  );
  border-radius: 16px 16px 0 0;
  pointer-events: none;
  z-index: 1;
}

/* ===== initial hero 布局 (跟之前一致) ===== */
.pad-hero {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: var(--pad-sp-8) var(--pad-sp-4);
  gap: var(--pad-sp-5);
  position: relative;
}
.pad-hero__title {
  display: flex;
  align-items: center;
  gap: var(--pad-sp-3);
  margin: 0;
  font-family: var(--pad-font-sans);
  font-size: 32px;
  font-weight: var(--pad-fw-semibold);
  line-height: 1.2;
  color: var(--pad-fg-primary);
  letter-spacing: -0.01em;
}
.pad-hero__icon {
  color: var(--pad-fg-primary);
  flex-shrink: 0;
}

.pad-hero__composer {
  width: 100%;
  max-width: 720px;
  display: flex;
  flex-direction: column;
}

.pad-hero__tabstrip {
  width: 100%;
  max-width: 720px;
  display: flex;
  align-items: center;
  gap: var(--pad-sp-2);
  flex-wrap: wrap;
  position: relative;
}
.pad-hero__tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 10px;
  border-radius: var(--pad-radius-md);
  font-size: var(--pad-fs-13);
  color: var(--pad-fg-secondary);
  background: transparent;
  border: 1px solid var(--pad-border);
  cursor: pointer;
  transition:
    background var(--pad-dur-fast) ease,
    color var(--pad-dur-fast) ease,
    border-color var(--pad-dur-fast) ease;
  font-family: inherit;
}
.pad-hero__tab:hover:not(:disabled) {
  background: var(--pad-bg-hover);
  color: var(--pad-fg-primary);
  border-color: var(--pad-border-strong);
}
.pad-hero__tab:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.pad-hero__tab--local.is-open {
  background: var(--pad-bg-active);
  color: var(--pad-fg-primary);
  border-color: var(--pad-border-strong);
}
.pad-hero__tab--readonly {
  cursor: default;
  color: var(--pad-fg-tertiary);
}
.pad-hero__tab-chev {
  transition: transform var(--pad-dur-base) var(--pad-ease-in-out);
}
.pad-hero__tab-chev.is-flipped {
  transform: rotate(180deg);
}
.pad-hero__tab-hint {
  font-size: var(--pad-fs-12);
  color: var(--pad-fg-tertiary);
  padding: 0 4px;
}

.pad-hero__local-menu {
  position: absolute;
  top: 36px;
  left: 0;
  min-width: 240px;
  max-width: 360px;
  background: var(--pad-popover);
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-lg);
  box-shadow: var(--pad-shadow-popover);
  padding: 4px 0 6px;
  z-index: 20;
}
.pad-hero__local-menu-head {
  padding: 6px 12px 4px;
  font-size: var(--pad-fs-11);
  color: var(--pad-fg-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-weight: var(--pad-fw-medium);
}
.pad-hero__local-menu-sep {
  height: 1px;
  background: var(--pad-divider);
  margin: 4px 0;
}
.pad-hero__local-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 12px;
  background: transparent;
  border: none;
  text-align: left;
  font-size: var(--pad-fs-13);
  color: var(--pad-fg-primary);
  cursor: pointer;
  font-family: inherit;
  transition: background var(--pad-dur-fast) ease;
}
.pad-hero__local-menu-item:hover:not(:disabled) {
  background: var(--pad-bg-hover);
}
.pad-hero__local-menu-item.is-primary {
  color: var(--pad-accent);
  font-weight: var(--pad-fw-medium);
}
.pad-hero__local-menu-item.is-primary:hover:not(:disabled) {
  background: var(--pad-accent-soft);
}
.pad-hero__local-menu-item:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.pad-hero__local-menu-name {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pad-hero__local-menu-check {
  color: var(--pad-accent);
  flex-shrink: 0;
}

.pad-hero__chips {
  width: 100%;
  max-width: 720px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--pad-sp-2);
  flex-wrap: wrap;
  margin-top: var(--pad-sp-1);
}
.pad-hero__chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 14px;
  border-radius: var(--pad-radius-pill);
  font-size: var(--pad-fs-13);
  color: var(--pad-fg-secondary);
  background: var(--pad-card);
  border: 1px solid var(--pad-border);
  cursor: pointer;
  transition:
    background var(--pad-dur-fast) ease,
    color var(--pad-dur-fast) ease,
    border-color var(--pad-dur-fast) ease,
    transform var(--pad-dur-fast) ease;
  font-family: inherit;
}
.pad-hero__chip:hover {
  background: var(--pad-bg-hover);
  color: var(--pad-fg-primary);
  border-color: var(--pad-border-strong);
  transform: translateY(-1px);
}
.pad-hero__chip:active {
  transform: translateY(0);
}
</style>
