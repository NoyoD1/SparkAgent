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
  AlertTriangle,
} from 'lucide-vue-next';
import { useChatStore } from '@/stores/chat';
import { useSessionStore } from '@/stores/session';
import { useConfigStore } from '@/stores/config';
import { pickFolder } from '@/lib/dialog';
import ChatHeader from './ChatHeader.vue';
import ChatMessage from './ChatMessage.vue';
import Composer from './Composer.vue';
import ChatMessageNav, { type ChatTurn } from './ChatMessageNav.vue';
import PermissionDialog from './PermissionDialog.vue';

const chatStore = useChatStore();
const sessionStore = useSessionStore();
const configStore = useConfigStore();
const { activeSession, activeWorkspace, workspaces } = storeToRefs(sessionStore);

const messages = computed(() =>
  activeSession.value ? chatStore.getMessages(activeSession.value.id) : []
);

// streaming 状态暴露给 ChatMessage
const activeModelName = computed(() => configStore.activeModel?.id ?? '');
const isSessionStreaming = computed(() =>
  activeSession.value ? chatStore.isStreamingSession(activeSession.value.id) : false,
);
// v0.5.0-D 第18轮 (D205): 删 isStreaming 别名, 模板直接用 isSessionStreaming
//   (D205 删了底部 status bar, isStreaming 别名在 ChatMessage 里 isMessageStreaming 还用,
//    但 ChatMain 自己模板不再用)
function isMessageStreaming(idx: number): boolean {
  // v0.5.0-D 改: 不再检查 `!m.content`. 之前第一条 text_delta 来了就 false
  //   → ChatMessage 的 "生成中..." pill 立刻消失, 用户看不到 "正在下笔" 的过渡.
  //   现在整个 agent loop 期间都 true, 直到 agent_end.
  if (!isSessionStreaming.value) return false;
  if (idx !== messages.value.length - 1) return false;
  const m = messages.value[idx];
  return !!m && m.role === 'assistant';
}

// v0.5.0-D 第18轮 (D205) REVERT D202: 删底部 streaming status bar
//   底部 status bar 的动态文字 ("思考中.../生成中.../下笔中...") 移到 ChatMessage placeholder
//   这里不再维护 streamingTextTimer / STREAMING_TEXTS 等, 跟 user 反馈的"不要左下角提示"一致
//   (user: "左下角不要有这种提示, 我们上面已经有回复的loading提示了")

// v0.5.0-D 第17轮 (D204) REVERT D203: 删 latestAssistantEmpty + retryLastPrompt
//   D203 在 status bar 加 emptyResponse 警告变体 + 重新生成 button — user 反馈太激进
//   (model 合法的空 message 误判). 真正的兜底在 D204 stream hang detector, 走 chat
//   区域中间横线, 不在 popup-style bottom bar 里. 重新生成让 user 自己在 composer
//   重发即可, 不需要专门 button.

// v0.4.1 step 累加: steps 现在直接挂在 message.steps 上, 不需要 messageId 索引
// 保留 thinking/toolCalls 索引代码以防未来 step 拆分到顶层 (legacy fallback)

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

// v0.5.0-D 第17轮 (D204): stream hang indicator
//   chat store 的 streamHangBySession 控制: 30s 无事件 + 仍 isStreaming → true
//   UI 在 chat 区域显示横线 (不是 popup). user 可点 × 关闭 (清标记, 不会触发新请求,
//   user 自行在 composer 重发即可)
const isStreamHang = computed(() => {
  const sid = activeSession.value?.id;
  if (!sid) return false;
  return !!chatStore.streamHangBySession[sid];
});
function dismissStreamHang() {
  const sid = activeSession.value?.id;
  if (!sid) return;
  chatStore.clearStreamHang(sid);
}

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
    // D214 v6: 用 requestAnimationFrame + setTimeout 双保险, 等新 session 的消息真的
    //   渲染完再 scroll-to-bottom. 之前 nextTick 太快, scrollHeight 还是 0, 滚不动.
    //   (用户反馈: "每次点击 session 应该在最底部, 而不是最顶部")
    const doScroll = () => scrollToBottom(false);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setTimeout(doScroll, 50);
      });
    });
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
              :session-id="activeSession?.id"
              :steps="msg.role === 'assistant' ? (msg.steps || []) : []"
              :model-name="activeModelName"
              :is-streaming="isMessageStreaming(idx)"
              :error-message="
                isMessageStreaming(idx) || idx < messages.length - 1
                  ? null
                  : chatStore.getError(activeSession?.id)
              "
              :retry="
                isMessageStreaming(idx) ? (chatStore.retryBySession?.[activeSession?.id || ''] ?? null) : null
              "
            />
            <!-- v0.5.0-D 第17轮 (D204): stream hang error line
                 真正兜底: 30s 无事件 + 仍 isStreaming → 显示横线在 chat 区域中间
                 user 反馈: "我不要弹窗, 我要的是在chat区域中间一个'------error具体详情-------'这样的横线"
                 横线显示具体错误信息 + × 关闭 (关闭只清标记, 不会触发新请求,
                 user 自行在 composer 重发即可, 不强行 retry)
                 替代 D200/D202/D203 的 popup-style emptyResponse 警告 (false positive 太多)

                 2026-08-21 v0.6.3-rc1: 30s 超时只 warn + UI 提示, 不 force stop streaming
                 (user 反馈: AI 真的在回复时被强打断不合理. 业务规则: 除非主动报错才停)
                 横线文案改 "AI 响应较慢" 而非 "已停止响应", 不再 force stop -->
            <div v-if="isStreamHang" class="pad-chatmain__stream-hang">
              <div class="pad-chatmain__stream-hang-line" />
              <span class="pad-chatmain__stream-hang-text">
                <AlertTriangle :size="13" :stroke-width="1.75" class="pad-chatmain__stream-hang-icon" />
                30s 无新事件 · AI 响应较慢 · 可继续等待, 必要时手动点 stop
              </span>
              <div class="pad-chatmain__stream-hang-line" />
              <button
                type="button"
                class="pad-chatmain__stream-hang-close"
                title="关闭提示 (不会重发)"
                @click="dismissStreamHang"
              >
                ×
              </button>
            </div>
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
        <!-- v0.5.0: PermissionDialog inline 渲染在 Composer 正上方 (v-if 控制 + Transition 滑出).
             inline flow 性质保证弹窗底边始终贴 Composer 顶边, Composer 高度变化时弹窗自然跟随.
             不需要 ResizeObserver 也不用 ResizeEvent, 浏览器自动处理. -->
        <PermissionDialog />
        <!-- v0.5.0-D 第18轮 (D205) REVERT D202: 删底部 status bar
             user 反馈: "左下角不要有这种提示, 我们上面已经有回复的loading提示了"
             动态文字 ("思考中.../生成中.../下笔中...") 移到 ChatMessage placeholder 里轮换
             这里只放 PermissionDialog + Composer, 不再重复显示 streaming 状态 -->
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
          <!-- v0.5.0-D 第18轮 (D205) REVERT D202: hero 模式也不再重复 status bar
               (ChatMessage placeholder 里就有动态文字, 跟非 hero 一致) -->
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
  /* v0.3.8.23: 跟 body 同色, border-radius 去掉, 改用 1px border 跟 sidebar 区分.
   * 但 border 不能直接加这里 (会跟 column-gap 里的 ResizeHandle 撞),
   * 视觉上 ResizeHandle 本身就是 1px line, 充当分割线. */
  background: var(--pad-card);
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
  /* v0.3.8.7: padding-right 10px, 让浏览器原生滚动条不贴 ResizeHandle 中线,
   * 避免鼠标在两者之间无法选中滚动条.
   * (list-inner 是 max-width 880px margin 0 auto, 居中逻辑不受影响)
   * D214 v6: padding-bottom 120→24px. 之前 120 是为了"最后消息不被 composer 盖住",
   *   但 120 太大会让短消息 (1-2 条) 的 chat 出现大片空白区, 用户体验差.
   *   composer-area 自带 12px padding, 24px + 12px = 36px 总间距, 足够视觉分隔. */
  padding: 16px 10px 24px 0;
}
.pad-chatmain__list-inner {
  display: flex;
  flex-direction: column;
  gap: 14px;
  /* v0.3.8.1: chat 内容居中 + 最大宽 880px, 宽屏不拉伸
   * 左 40 留给 nav tick 横向移动空间, 右 24 是消息右边距 */
  padding: 0 24px 0 40px;
  max-width: 720px;  /* v0.4.1.3: 880 → 720, user 反馈"中间区域太宽, 适当收窄" */
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
  /* v0.4.1.3: 跟 list-inner 一样居中 + 最大宽 720px, 宽屏下输入框不跟着拉 (v0.3.8.1 之前 880px 太宽) */
  padding: 0 16px 12px;
  max-width: 720px;
  margin: 0 auto;
  width: 100%;
  box-sizing: border-box;
}
/* v0.3.8.27 移除 composer 上方的 ::before 渐变 fade mask.
 * 之前的设计意图: 让消息列表滚到底时自然"消失"在 composer 后.
 * 实际效果 (亮色/暗色都试过):
 * - 亮色 mode: ::before 跟 body 颜色差异明显, 像一块"硬膏药"贴在 composer 顶部
 * - 暗色 mode: ::before 在深色背景上同样有"硬膏药"感, 反而遮住 list 内容让用户看不见
 * - solid 区紧贴 composer (v0.3.8.26.1) 后, "消息消失" 的视觉反而更"硬"
 *
 * 用户决定: 直接去掉 mask, 让 list 跟 composer 自然衔接.
 * - list padding-bottom 120px 仍然保留, 最后消息不会被 composer 盖住
 * - list 自身 .pad-scroll 滚到顶/底行为不变
 * - composer 顶边 1px border 现在完全可见 (之前 mask 渐变可能微弱影响)
 *
 * 如果后续想要"消息消失在 composer 后" 的视觉, 替代方案:
 * - 在 .pad-chatmain__list 加 mask-image: linear-gradient(to bottom, transparent 0, black 30px, black calc(100% - 80px), transparent 100%)
 * - 这样 list 自己的顶部/底部各 30/80px 渐变透明, 不依赖 ::before 浮层
 *   (但 list mask 在某些 WebView 跟 overflow: auto 兼容性差, 谨慎测试)
 * 现在先删 ::before, 走简洁方案. */

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

/* v0.5.0-D 第18轮 (D205) REVERT D202: 删 .pad-chatmain__streaming-status 相关样式
 *   底部 status bar 整块移除, 不再需要 spinner / text / fadein 等 class
 *   (动态文字移到 ChatMessage placeholder 里, 见 ChatMessage.vue) */

/* v0.5.0-D 第17轮 (D204): stream hang 错误横线
 *   在 chat 区域中间, user 反馈要的格式: "------error具体详情-------"
 *   不走 popup / bottom bar, inline 容易看, 点 × 关闭
 *   替代 D202 AlertTriangle placeholder + D203 底部 status bar 警告变体 */
.pad-chatmain__stream-hang {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 20px 16px 12px;
  font-size: var(--pad-fs-12);
  color: var(--pad-fg-warning, #d97706);
}
.pad-chatmain__stream-hang-line {
  flex: 1;
  height: 1px;
  background: var(--pad-fg-warning, #d97706);
  opacity: 0.3;
}
.pad-chatmain__stream-hang-text {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
  font-weight: var(--pad-fw-medium);
}
.pad-chatmain__stream-hang-icon {
  flex-shrink: 0;
}
.pad-chatmain__stream-hang-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  font-size: 16px;
  line-height: 1;
  color: var(--pad-fg-warning, #d97706);
  background: transparent;
  border: 1px solid var(--pad-fg-warning, #d97706);
  border-radius: var(--pad-radius-sm, 6px);
  cursor: pointer;
  transition: background var(--pad-dur-fast) ease, color var(--pad-dur-fast) ease;
}
.pad-chatmain__stream-hang-close:hover {
  background: var(--pad-fg-warning, #d97706);
  color: #fff;
}
</style>
