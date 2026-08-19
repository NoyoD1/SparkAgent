<script setup lang="ts">
/**
 * ChatMessage — v0.3.7+ 重写, v0.4.1 step 累加重构, v0.4.6 Cursor 卡片重构, v0.5.0-D 第4轮:
 *   **per-step collapsible group** (Pi TUI / MiniMax Code 风格)
 *
 * 设计目标 (v0.5.0-D 第4轮):
 * - **user 消息**: 右侧气泡 (保留)
 * - **assistant 消息**:
 *   - 每个 step 独立渲染为一个 collapsible sub-section, 头部: "第 N 步 · 思考 X 次 ·
 *     调用 M 个工具" (MiniMax Code / Pi TUI 风格)
 *   - step body 内包含: thinking 块 (灰底斜体) + tool 卡片列表 (icon + name + args
 *     + status) + 正文 markdown
 *   - 已完成的 step 默认折叠 (点击 header 展开), 当前正在 streaming 的 step 自动展开,
 *     末尾有 "进行中..." 指示 + "▌" 闪烁光标
 *   - 错误 / retry / 空状态 / actions 仍按 message 级别挂
 *
 * 跟之前版本的对比:
 *   - v0.4.6 Cursor 风格: thinking / tools / bodies 三段平铺, 多 turn 内容互相覆盖
 *   - v0.5.0-D 第1-2轮: per-step body list, 但 thinking / tools 仍是顶层累积
 *   - v0.5.0-D 第4轮 (现在): per-step group, 整 step 折叠, thinking/tool/text 都在组内
 *
 * 用户反馈驱动: "图2 自行理解当前这个流式返回, 能看到 tools, think 完全看不到效果;
 *   你就用 Pi TUI 那种来试一下效果吧, 参考图3 做效果" — MiniMax Code / Pi TUI 风格.
 */
import { computed, ref, watch, onMounted, onUnmounted } from 'vue';
import { ThumbsUp, ThumbsDown, Copy, RefreshCw, Loader2, Wrench, Brain, ChevronDown, ChevronRight, Quote } from 'lucide-vue-next';
import type { ChatMessage, Step, ToolCallBlock } from '@/lib/mock/types';
import MarkdownContent from './MarkdownContent.vue';
import { useChatStore } from '@/stores/chat';
import { useSessionStore } from '@/stores/session';

interface Props {
  message: ChatMessage;
  sessionId?: string;
  /** v0.4.1: 该 message 的 step 列表 (assistant 才有) */
  steps?: Step[];
  /** 保留: 模型名 (暂未用) */
  modelName?: string;
  isStreaming?: boolean;
  /** v0.3.8.15: 错误信息 (sidecar 发 error event 时显示具体内容) */
  errorMessage?: string | null;
  /** v0.4.2+ LLM 重试状态 (sidecar retry_start 期间显示"重试中 1/5...") */
  retry?: { attempt: number; maxAttempts: number; errorMessage: string } | null;
}

const props = withDefaults(defineProps<Props>(), {
  sessionId: '',
  modelName: '',
  isStreaming: false,
  errorMessage: null,
  retry: null,
  steps: () => [],
});

const chatStore = useChatStore();
const isUser = computed(() => props.message.role === 'user');

/**
 * v0.5.0-D 第4轮: per-step 渲染. 直接用 props.steps, 每个 step 独立渲染为一个
 *   collapsible sub-section. thinking / tools / text 都在 step 内部, 不再平铺累积.
 *
 * hasThinkingOrTools: 任意 step 有 thinking 或 tool 时为 true (决定是否显示空状态).
 */
const hasThinkingOrTools = computed(() => {
  for (const s of props.steps || []) {
    if (s.thinking.length > 0 || s.toolCalls.length > 0) return true;
  }
  return false;
});
/**
 * v0.5.0-D 第4轮: 任意 step 有 stepText 时为 true (决定是否显示 actions / empty).
 */
const hasContent = computed(() => {
  for (const s of props.steps || []) {
    if (s.stepText && s.stepText.trim().length > 0) return true;
  }
  return false;
});

/**
 * v0.5.0-D 第4轮: per-step collapse state.
 *   - Set<stepId> 记录被 user 手动 collapse 的 step (toggle 用)
 *   - 默认 (没有 user 偏好): 已完成的 step 折叠, 当前正在 streaming 的 step 展开
 *   - user 手动 toggle 后, 记到 collapsedSteps 覆盖默认
 */
const collapsedSteps = ref<Set<string>>(new Set());
function isStepCollapsed(step: Step, isLast: boolean): boolean {
  if (collapsedSteps.value.has(step.id)) return true;
  if (collapsedSteps.value.has(`__expanded_${step.id}`)) return false;
  // 默认: 当前 (last) step 展开, 其他折叠
  return !isLast;
}
function toggleStep(step: Step) {
  const isLast = (props.steps || []).indexOf(step) === (props.steps || []).length - 1;
  const currentlyCollapsed = isStepCollapsed(step, isLast);
  if (currentlyCollapsed) {
    // 展开: 删 collapse 标记 + 加展开标记 (防止默认逻辑再次覆盖)
    collapsedSteps.value.delete(step.id);
    collapsedSteps.value.add(`__expanded_${step.id}`);
  } else {
    // 折叠: 反向
    collapsedSteps.value.add(step.id);
    collapsedSteps.value.delete(`__expanded_${step.id}`);
  }
  collapsedSteps.value = new Set(collapsedSteps.value);
}

/**
 * 复制拼接所有 step 的正文 (per-step, 跨 turn 完整).
 */
const copyableText = computed(() =>
  (props.steps || [])
    .map((s) => s.stepText || '')
    .filter((t) => t.trim().length > 0)
    .join('\n\n'),
);

const copied = ref(false);
/**
 * v0.5.0-D 第4轮: 复制拼接所有 step 的正文 (per-step, 跨 turn 完整).
 *   之前 finalBody = lastStep.stepText, 多 turn 时只复制最后一段.
 *   现在 copyableText 已经按时间序拼接好.
 */
async function copyMessage() {
  try {
    await navigator.clipboard.writeText(copyableText.value);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1200);
  } catch (e) {
    console.warn('[msg] copy failed', e);
  }
}

// v0.5.0-D 第12轮: 引用回复 (quote & reply) — 把整条 message 正文存到 chat store 的 quoteBySession
//   Composer 显示引用预览, user send 时 quote 拼到 user message 前面 (block quote 格式)
//   toggle 行为: 再次点同一 message 的"引用"button → 取消引用 (isQuoted 状态)
const sessionStoreForQuote = useSessionStore();
const isQuoted = computed(() => {
  const sid = sessionStoreForQuote.activeSessionId;
  if (!sid) return false;
  return chatStore.quoteBySession[sid]?.messageId === props.message.id;
});
function quoteMessage() {
  const sid = sessionStoreForQuote.activeSessionId;
  if (!sid) return;
  if (isQuoted.value) {
    // 再次点击 = 取消引用
    chatStore.clearQuote(sid);
  } else {
    chatStore.setQuote(sid, {
      messageId: props.message.id,
      content: copyableText.value,
    });
  }
}

// v0.5.0-D 第12轮 v2 (D199): 选区引用 — 鼠标滑动选中 assistant message 文字后, 浮动 "引用" button
//   user 反馈 "整段引用我希望也能支持对回复内容某些字段的引用, 比如鼠标滑动选中某些字段"
//   监听 mouseup 拿 window.getSelection(), 检查 selection 是否在 message 内, 是则显示 button
//   button 点击 → setQuote (只引用 selected text, 不是整条 message)
//   selection 不在 message 内 / 选中为空 → 隐藏 button
const assistantRootRef = ref<HTMLElement | null>(null);
const selectionQuoteVisible = ref(false);
const selectionQuotePos = ref({ top: 0, left: 0 });
const selectedTextRef = ref('');

function handleAssistantMouseUp(_e: MouseEvent) {
  // setTimeout 让浏览器 finalize selection
  setTimeout(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      selectionQuoteVisible.value = false;
      return;
    }
    const text = sel.toString().trim();
    if (!text || text.length < 1) {
      selectionQuoteVisible.value = false;
      return;
    }
    const range = sel.getRangeAt(0);
    const rootEl = assistantRootRef.value;
    if (!rootEl || !rootEl.contains(range.commonAncestorContainer)) {
      selectionQuoteVisible.value = false;
      return;
    }
    // 算出 button 位置: selection 上方, 居中
    const rect = range.getBoundingClientRect();
    const messageRect = rootEl.getBoundingClientRect();
    const buttonW = 80;  // 跟 CSS min-width 一致
    selectionQuotePos.value = {
      top: rect.top - messageRect.top - 36,  // 36 = button height + gap
      left: Math.max(0, rect.left - messageRect.left + rect.width / 2 - buttonW / 2),
    };
    selectedTextRef.value = text;
    selectionQuoteVisible.value = true;
  }, 10);
}

function quoteSelection() {
  const sid = sessionStoreForQuote.activeSessionId;
  if (!sid) return;
  chatStore.setQuote(sid, {
    messageId: props.message.id,
    content: selectedTextRef.value,
  });
  selectionQuoteVisible.value = false;
  // 清除浏览器选区 (避免后续操作误触)
  window.getSelection()?.removeAllRanges();
}

function onDocumentSelectionChange() {
  // selection 消失 → 隐藏 button
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
    selectionQuoteVisible.value = false;
  }
}

/**
 * v0.4.6 Cursor 风格: tool 卡片每行 result 默认折叠, 用户点 [+] 才展开.
 * 用 Set<toolCallId> 记录展开状态. (v0.5.0-D 第4轮 per-step group 改造后保留, 仍有用)
 */
const expandedTools = ref<Set<string>>(new Set());

function toggleToolExpanded(toolCallId: string) {
  if (expandedTools.value.has(toolCallId)) {
    expandedTools.value.delete(toolCallId);
  } else {
    expandedTools.value.add(toolCallId);
  }
  // 触发响应式
  expandedTools.value = new Set(expandedTools.value);
}
function toolStatusLabel(t: ToolCallBlock): string {
  if (t.status === 'running' || t.status === 'pending') return '运行中';
  if (t.status === 'success') return '完成';
  return '失败';
}
function toolArgsSummary(t: ToolCallBlock): string {
  const keys = Object.keys(t.args || {});
  if (keys.length === 0) return '';
  const first = keys[0];
  const v = t.args[first];
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  const preview = s.length > 50 ? s.slice(0, 50) + '…' : s;
  return `${first}: ${preview}`;
}

/**
 * v0.5.1: phase-based status icon 动画 (替代 v0.3.8.9 的纯 3-dot bounce)
 *
 * 用户反馈: "实际当前任务还在后台继续跑, 但是因为是一段一段回复的, 正文可能有多条,
 *   导致看起来像是卡了, 需要加适当的提示icon动画, 表示当前是在走的.
 *   比如: 思考中… 创造中… 正在下笔… 等等这种效果切换"
 *
 * 实现:
 * - 跟 chat store 拿当前 phase (thinking / text / tool)
 * - phase 不同 → 文字列表不同 (各 2-3 个轮换, 表达 "思考"/"写作"/"执行" 不同状态)
 * - 每 1.8s 切下一个文字, 200ms crossfade (淡出 → 淡入)
 * - 同时显示旋转的 Loader2 icon (1.4s 旋转, 跟 pad-step__spinner 同步)
 * - watch phase 变化时立即重置 text index (新 phase 用自己的第一个文字)
 *
 * 替代 v0.3.8.9 的 `pad-msg__loading` (3 个灰点 bounce + 静态 "生成中…").
 *   旧版视觉上太朴素, 用户看不到"AI 正在思考/写作/调工具"的状态切换, 长 stream 时感觉卡.
 */
const PHASE_LABELS: Record<string, string[]> = {
  thinking: ['思考中…', '整理思路…', '推演中…'],
  text: ['正在下笔…', '创造中…', '书写中…'],
  tool: ['调用工具…', '执行中…'],
  idle: ['生成中…'],
};
const currentPhase = computed(() => chatStore.getPhase(props.sessionId));
const textIndex = ref(0);
let rotateTimer: ReturnType<typeof setInterval> | null = null;
const ROTATE_INTERVAL = 1800;

function startRotate() {
  stopRotate();
  rotateTimer = setInterval(() => {
    const labels = PHASE_LABELS[currentPhase.value] || PHASE_LABELS.idle;
    textIndex.value = (textIndex.value + 1) % labels.length;
  }, ROTATE_INTERVAL);
}
function stopRotate() {
  if (rotateTimer) {
    clearInterval(rotateTimer);
    rotateTimer = null;
  }
}
watch(
  currentPhase,
  () => {
    // phase 变化时, 立即重置 textIndex 到 0 (新 phase 自己的第一个文字)
    textIndex.value = 0;
  },
);
watch(
  () => props.isStreaming,
  (s) => {
    if (s) startRotate();
    else stopRotate();
  },
  { immediate: true },
);
onUnmounted(stopRotate);

// v0.5.0-D 第12轮 v2 (D199): 选区引用 — 监听 document selectionchange
//   selection 变化时检查, 如果 selection 消失 → 隐藏浮动 button
onMounted(() => {
  document.addEventListener('selectionchange', onDocumentSelectionChange);
});
onUnmounted(() => {
  document.removeEventListener('selectionchange', onDocumentSelectionChange);
});

const statusText = computed(() => {
  const labels = PHASE_LABELS[currentPhase.value] || PHASE_LABELS.idle;
  return labels[textIndex.value] || labels[0] || '生成中…';
});
</script>

<template>
  <!-- ============== USER MESSAGE: 右侧气泡 ============== -->
  <div v-if="isUser" class="pad-msg pad-msg--user" :data-message-id="message.id">
    <div class="pad-msg__bubble pad-msg__bubble--user">
      <MarkdownContent :content="message.content" />
    </div>
  </div>

  <!-- ============== SYSTEM MESSAGE: v0.4.6 压缩分界线 ============== -->
  <!-- compaction 完成时 chat.ts push 一条 role:'system', compactionMarker:true 的消息,
       这里渲染为居中灰色横线 "── 上下文已压缩 ──", 不走 markdown. -->
  <div
    v-else-if="message.role === 'system' && message.compactionMarker"
    class="pad-msg__compaction-divider"
    :data-message-id="message.id"
  >
    <span class="pad-msg__compaction-line" />
    <span class="pad-msg__compaction-label">上下文已压缩</span>
    <span class="pad-msg__compaction-line" />
  </div>

  <!-- ============== ASSISTANT MESSAGE: v0.5.0-D 第4轮 per-step group 风格 ============== -->
  <div
    v-else
    ref="assistantRootRef"
    class="pad-msg pad-msg--assistant"
    :data-message-id="message.id"
    @mouseup="handleAssistantMouseUp"
  >
    <!-- v0.5.0-D 第12轮 v2 (D199): 选区引用浮动 button
         鼠标滑动选中 assistant message 文字 → 浮动 "引用" button 出现在 selection 上方
         点击 → 把 selected text 作为 quote (不是整条 message) 存到 store -->
    <div
      v-if="selectionQuoteVisible"
      class="pad-msg__quote-floating"
      :style="{ top: `${selectionQuotePos.top}px`, left: `${selectionQuotePos.left}px` }"
      @mousedown.prevent
    >
      <button type="button" class="pad-msg__quote-floating-btn" @click="quoteSelection">
        <Quote :size="12" :stroke-width="1.75" />
        引用
      </button>
    </div>
    <!-- v0.4.2+: 错误 banner (think 阶段出错也显示, 不只是空 message 状态) -->
    <div v-if="!isStreaming && errorMessage && !retry" class="pad-msg__error">
      <span class="pad-msg__error-icon" aria-hidden="true">⚠</span>
      <span class="pad-msg__error-text">{{ errorMessage }}</span>
    </div>

    <!-- v0.5.0-D 第12轮: per-step 折叠结构改
         用户 D198 反馈: "阶段性的思考能够折叠，然后阶段性的正文放在外面"
         旧: thinking + tools + text 都在一个 step group 内 (text 一起被折叠)
         新: thinking + tools 在 step group 内可折叠, text 移到 step group **外面**,
             不管 fold/unfold 都直接显示 (正文是给 user 看的核心, 不能藏)
         Step 头部仍然显示 "思考 N 次, 调用 M 个工具" summary. 如果 step 只有
         text (没 thinking / tool), 整个 step group 不渲染 (head 也不显示). -->
    <template v-for="(step, idx) in steps || []" :key="step.id">
      <!-- Step group (only if has thinking or tools) -->
      <div
        v-if="step.thinking.length || step.toolCalls.length"
        class="pad-step-group"
        :class="{
          'is-current': idx === (steps || []).length - 1 && isStreaming,
          'is-last': idx === (steps || []).length - 1,
        }"
      >
        <button
          type="button"
          class="pad-step-group__head"
          :title="isStepCollapsed(step, idx === (steps || []).length - 1) ? '展开步骤' : '折叠步骤'"
          @click="toggleStep(step)"
        >
          <ChevronRight
            :size="12"
            :stroke-width="1.75"
            :class="['pad-step-group__chev', { 'is-collapsed': isStepCollapsed(step, idx === (steps || []).length - 1) }]"
          />
          <Brain v-if="step.thinking.length" :size="11" :stroke-width="1.75" class="pad-step-group__icon" />
          <Wrench v-else-if="step.toolCalls.length" :size="11" :stroke-width="1.75" class="pad-step-group__icon" />
          <span class="pad-step-group__summary">
            <template v-if="step.thinking.length">
              思考 {{ step.thinking.length }} 次
            </template>
            <template v-if="step.thinking.length && step.toolCalls.length">，</template>
            <template v-if="step.toolCalls.length">
              调用 {{ step.toolCalls.length }} 个工具
            </template>
          </span>
          <span
            v-if="idx === (steps || []).length - 1 && isStreaming"
            class="pad-step-group__indicator"
          >
            <Loader2 :size="11" :stroke-width="2" class="pad-step-group__spinner" />
            {{ statusText }}
          </span>
        </button>

        <div
          v-show="!isStepCollapsed(step, idx === (steps || []).length - 1)"
          class="pad-step-group__body"
        >
          <!-- thinking 块 (按 step 隔离, 灰底斜体) -->
          <div v-if="step.thinking.length" class="pad-step-group__thinking">
            <div
              v-for="t in step.thinking"
              :key="t.id"
              class="pad-step-thinking"
            >
              <MarkdownContent :content="t.content" />
            </div>
          </div>

          <!-- tool 卡片 (按 step 隔离) -->
          <div v-if="step.toolCalls.length" class="pad-step-group__tools">
            <div
              v-for="t in step.toolCalls"
              :key="t.id"
              class="pad-msg__tool-card"
              :class="`is-${t.status}`"
            >
              <div class="pad-msg__tool-card-row">
                <Wrench :size="11" :stroke-width="1.75" class="pad-msg__tool-card-icon" />
                <span class="pad-msg__tool-card-name">{{ t.name }}</span>
                <span v-if="toolArgsSummary(t)" class="pad-msg__tool-card-args">
                  {{ toolArgsSummary(t) }}
                </span>
                <span class="pad-msg__tool-card-status">{{ toolStatusLabel(t) }}</span>
                <button
                  v-if="t.result"
                  class="pad-msg__tool-card-toggle"
                  type="button"
                  :title="expandedTools.has(t.id) ? '收起' : '展开 result'"
                  @click.stop="toggleToolExpanded(t.id)"
                >
                  <ChevronDown
                    :size="11"
                    :stroke-width="1.75"
                    :class="['pad-msg__tool-card-chev', { 'is-collapsed': !expandedTools.has(t.id) }]"
                  />
                </button>
              </div>
              <pre v-if="t.result && expandedTools.has(t.id)" class="pad-msg__tool-card-result">{{ t.result }}</pre>
            </div>
          </div>
        </div>
      </div>

      <!-- 正文 markdown (per-step 独立, ALWAYS 在 step group 外面, 不被折叠)
           D198 关键修复: 旧版 text 在 step group body 内, 跟 thinking/tools 一起被折叠
           (user 看到的是 "▼ 1 思考 1 次" 然后一堆 text, 不直观).
           现在 text 是 user 核心要看的内容, 跟 step group 平级, 不管 fold 都直接显示. -->
      <div
        v-if="step.stepText && step.stepText.trim().length > 0"
        class="pad-msg__body"
        :class="{ 'pad-msg__body--current': idx === (steps || []).length - 1 && isStreaming }"
      >
        <MarkdownContent :content="step.stepText" />
      </div>
    </template>

    <!-- v0.4.2+: 重试提示 (sidecar 在 5 次重试间 emit retry_start, UI 显示"重试中 1/5...") -->
    <div v-if="retry" class="pad-msg__retry">
      <span class="pad-msg__retry-icon" aria-hidden="true">⟳</span>
      <span class="pad-msg__retry-text">
        <template v-if="retry.attempt > 0 && retry.maxAttempts > 0">
          LLM 调用失败，正在重试
          <strong>{{ retry.attempt }}/{{ retry.maxAttempts }}</strong>
        </template>
        <template v-else>
          等待 LLM 重试中…
        </template>
        <span class="pad-msg__retry-hint">({{ retry.errorMessage.slice(0, 80) }}{{ retry.errorMessage.length > 80 ? '…' : '' }})</span>
      </span>
    </div>

    <!-- v0.3.8.15: stream 结束但 4 类内容都为空时, 显示具体 error 信息 -->
    <div
      v-if="!isStreaming && !hasContent && !hasThinkingOrTools && !errorMessage"
      class="pad-msg__empty"
    >
      <span>AI 没有返回内容</span>
    </div>

    <!-- Actions: 仅在非 streaming 且有内容时显示 -->
    <div v-if="!isStreaming && hasContent" class="pad-msg__actions">
      <button class="pad-msg__action" :title="copied ? '已复制' : '复制'" type="button" @click="copyMessage">
        <Copy v-if="!copied" :size="12" :stroke-width="1.75" />
        <span v-else class="pad-msg__copied">已复制</span>
      </button>
      <!-- v0.5.0-D 第12轮: 引用回复 (quote & reply) — 整条消息内容作为引用插入 composer
           D198 spec: 选中文字 → 引用部分, v1 简化: 整条消息引用, 后续可选中引用 -->
      <button
        v-if="message.role === 'assistant' && copyableText"
        class="pad-msg__action"
        :title="isQuoted ? '已引用 (再点取消)' : '引用回复'"
        type="button"
        @click="quoteMessage"
      >
        <Quote :size="12" :stroke-width="1.75" :class="{ 'is-active': isQuoted }" />
      </button>
      <button class="pad-msg__action" title="赞" type="button">
        <ThumbsUp :size="12" :stroke-width="1.75" />
      </button>
      <button class="pad-msg__action" title="踩" type="button">
        <ThumbsDown :size="12" :stroke-width="1.75" />
      </button>
      <button class="pad-msg__action" title="重新生成" type="button">
        <RefreshCw :size="12" :stroke-width="1.75" />
      </button>
    </div>
  </div>
</template>

<style scoped>
/* ===== 通用 ===== */
.pad-msg { display: flex; width: 100%; }
.pad-msg--user { justify-content: flex-end; }
/* v0.5.0-D 第11轮: assistant message narrative 风格 — 更紧凑, 更像 paragraph 流,
   跟 user bubble 的"框"风格对称. 不再有 step group box 突兀感 (D197). */
.pad-msg--assistant {
  justify-content: flex-start;
  flex-direction: column;
  align-items: stretch;
  gap: 2px;
  max-width: 100%;
}

/* ===== user bubble (右) ===== */
.pad-msg__bubble { display: block; }
.pad-msg__bubble--user {
  max-width: 75%;
  padding: 8px 12px;
  background: var(--pad-bg-hover);
  color: var(--pad-fg-primary);
  border-radius: 12px;
  border-top-right-radius: 4px;
}

/* ===== assistant 流 (左, 连续, 无背景) ===== */
.pad-msg__body {
  font-size: var(--pad-fs-14);
  line-height: var(--pad-lh-relaxed);
  color: var(--pad-fg-primary);
  word-wrap: break-word;
  /* 跟 step head 缩进对齐: step head padding-left 4px, 缩进 0 让正文跟 step head 对齐 */
  margin-top: 2px;
}

/* ===== v0.5.0-D: per-step body 列表 ===== */
.pad-msg__body-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.pad-msg__body--current {
  /* 当前正在 streaming 的 step body — 视觉上跟已完成 step 区分 */
  position: relative;
}
.pad-msg__body--current::after {
  /* 闪烁的游标 — 表示该 step 还在追加内容 */
  content: '▌';
  display: inline-block;
  margin-left: 2px;
  color: var(--pad-accent);
  animation: pad-msg-cursor-blink 1s steps(2, end) infinite;
  font-weight: var(--pad-fw-regular);
}
@keyframes pad-msg-cursor-blink {
  0%, 50% { opacity: 1; }
  50.01%, 100% { opacity: 0; }
}

/* ===== v0.5.0-D 第11轮: per-step group 风格 (MiniMax Code narrative 风格)
   跟第4轮比, 去掉所有 box/card border, 让 step 头部变纯文字 inline 按钮, thinking
   用纯斜体文字 (无背景块), tool card 变 inline pill. 整体跟 assistant message 主体
   融合, 不再有"框框"突兀感 (D197 用户反馈).

   关键变化:
   - step head: 去掉 border + background, 仅保留 hover 微高亮
   - step body: 去掉 left border, 仅 padding-left 缩进
   - thinking: 去掉 background block, 纯 italic text
   - tool: 变 inline pill (小标签, 不再是 full-width card)
   - step number 圆形标签: 隐藏 (图2 风格不显示 step 编号)
   - current step: 用 opacity 1 + 颜色微调, 不再 accent border ===== */
.pad-step-group {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
}
.pad-step-group__head {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 4px;
  background: transparent;
  border: none;
  font-size: var(--pad-fs-11);
  color: var(--pad-fg-tertiary);
  cursor: pointer;
  text-align: left;
  align-self: flex-start;
  max-width: 100%;
  flex-wrap: wrap;
  opacity: 0.7;
  border-radius: 4px;
  transition: opacity var(--pad-dur-fast) ease, color var(--pad-dur-fast) ease, background var(--pad-dur-fast) ease;
}
.pad-step-group__head:hover {
  opacity: 1;
  background: var(--pad-bg-hover);
  color: var(--pad-fg-secondary);
}
.pad-step-group.is-current > .pad-step-group__head {
  opacity: 1;
  color: var(--pad-fg-secondary);
}
.pad-step-group__chev {
  flex-shrink: 0;
  transition: transform var(--pad-dur-base) var(--pad-ease-in-out);
}
.pad-step-group__chev.is-collapsed {
  transform: rotate(0deg);
}
.pad-step-group__chev:not(.is-collapsed) {
  transform: rotate(90deg);
}
.pad-step-group__index {
  display: none;  /* 图2 风格不显示步骤编号, 隐藏 */
}
.pad-step-group__icon {
  flex-shrink: 0;
  opacity: 0.7;
}
.pad-step-group__summary {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-feature-settings: 'tnum';  /* 数字等宽对齐 */
}
.pad-step-group__indicator {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--pad-accent);
  font-size: var(--pad-fs-11);
  font-weight: var(--pad-fw-medium);
  flex-shrink: 0;
}
.pad-step-group__spinner {
  animation: pad-step-spin 1.4s linear infinite;
}
@keyframes pad-step-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
.pad-step-group__body {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 0 0 0 16px;
  border-left: none;  /* 去掉 left border (图2 narrative 风格) */
  margin-left: 4px;
}
.pad-step-group__thinking {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 0;
  background: transparent;
  border: none;
}
.pad-step-thinking :deep(.pad-md),
.pad-step-thinking :deep(.pad-md p) {
  font-style: italic;
  color: var(--pad-fg-tertiary);
  margin: 0;
  font-size: var(--pad-fs-12);
  line-height: var(--pad-lh-base);
}
.pad-step-group__tools {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

/* 旧 v0.4.6 Cursor 风格 (thinking-cursor / tools-cursor / body-list) 样式已不用, 删除
   留 v0.4.6 的 thinking / tools / body 基础样式, 上面 step-group 直接复用 padding/bg 等
   元素 class 即可 (class 名复用, 不重复定义). */
.pad-msg__compaction-divider {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 8px 0;
  padding: 0 8px;
}
.pad-msg__compaction-line {
  flex: 1;
  height: 1px;
  background: var(--pad-border);
  opacity: 0.6;
}
.pad-msg__compaction-label {
  font-size: var(--pad-fs-11);
  font-weight: var(--pad-fw-medium);
  color: var(--pad-fg-tertiary);
  white-space: nowrap;
  letter-spacing: 0.04em;
}

/* ===== v0.4.6 Cursor 风格: thinking 累积区 (顶部) ===== */
.pad-msg__thinking-cursor {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 4px;
}
.pad-msg__thinking-cursor-head {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: var(--pad-fs-11);
  font-weight: var(--pad-fw-medium);
  font-style: italic;
  color: var(--pad-fg-tertiary);
  letter-spacing: 0.02em;
}
/* v0.5.0-D: thinking header 现在是 button, 加 cursor-toggle reset 样式 */
.pad-msg__cursor-toggle {
  background: transparent;
  border: none;
  padding: 2px 4px;
  margin: 0;
  cursor: pointer;
  text-align: left;
  border-radius: 4px;
  transition: color var(--pad-dur-fast) ease, background var(--pad-dur-fast) ease;
}
.pad-msg__cursor-toggle:hover {
  color: var(--pad-fg-secondary);
  background: var(--pad-bg-hover);
}
.pad-msg__cursor-count {
  font-size: var(--pad-fs-10);
  font-weight: var(--pad-fw-regular);
  font-style: normal;
  color: var(--pad-fg-tertiary);
  opacity: 0.7;
  margin-left: 2px;
  letter-spacing: 0.02em;
}
.pad-msg__cursor-chev {
  margin-left: auto;
  opacity: 0.7;
  transition: transform var(--pad-dur-base) var(--pad-ease-in-out);
}
.pad-msg__cursor-chev.is-collapsed {
  transform: rotate(-90deg);
}
.pad-msg__thinking-cursor-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px 10px;
  background: var(--pad-muted);
  border-radius: 6px;
  font-size: var(--pad-fs-12);
  font-style: italic;
  color: var(--pad-fg-tertiary);
  line-height: var(--pad-lh-base);
  /* v0.4.6: 持续显示 + 可滚动, max-height 200px 防 thinking 很长时把整屏挤掉 */
  max-height: 200px;
  overflow-y: auto;
}
/* 深穿透让 MarkdownContent 内的 .pad-md 跟 thinking 一致灰底斜体 */
.pad-msg__thinking-cursor-body :deep(.pad-md),
.pad-msg__thinking-cursor-body :deep(.pad-md p) {
  font-style: italic;
  color: var(--pad-fg-tertiary);
  margin: 0;
}

/* ===== v0.4.6 Cursor 风格: tool 卡片列表 (中间) ===== */
.pad-msg__tools-cursor {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 4px 0 6px;
}
.pad-msg__tools-cursor-head {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: var(--pad-fs-11);
  font-weight: var(--pad-fw-medium);
  color: var(--pad-fg-tertiary);
  letter-spacing: 0.02em;
}
.pad-msg__tools-cursor-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 0;
  list-style: none;
}
.pad-msg__tools-cursor {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 4px 0 6px;
  padding: 0;
  list-style: none;
}
/* v0.5.0-D 第11轮: tool card 从 full-width card 改成 inline pill (MiniMax Code narrative 风格)
   - card 变 single-line pill, flex-wrap 自动换行
   - 没边框, 只 muted background 视觉提示是个 meta 元素
   - status 变 simple dot + text (不再是 badge 背景)
   - result 还是 mono code block 但缩进 + subtle border, 不抢主体焦点 */
.pad-msg__tool-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  align-items: flex-start;
  align-self: flex-start;
  max-width: 100%;
}
.pad-msg__tool-card-row {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px;
  background: var(--pad-muted);
  border-radius: 4px;
  font-size: var(--pad-fs-11);
  color: var(--pad-fg-secondary);
  flex-wrap: wrap;
  max-width: 100%;
  cursor: default;
}
.pad-msg__tool-card-icon {
  opacity: 0.7;
  flex-shrink: 0;
}
.pad-msg__tool-card-name {
  font-family: var(--pad-font-mono);
  font-weight: var(--pad-fw-medium);
  color: var(--pad-fg-secondary);
  flex-shrink: 0;
}
.pad-msg__tool-card-args {
  color: var(--pad-fg-tertiary);
  font-family: var(--pad-font-mono);
  font-size: var(--pad-fs-11);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
  max-width: 360px;
  flex-shrink: 1;
}
.pad-msg__tool-card-status {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: var(--pad-fs-10);
  color: var(--pad-fg-tertiary);
  flex-shrink: 0;
  margin-left: 2px;
  padding-left: 6px;
  border-left: 1px solid var(--pad-border);
}
.pad-msg__tool-card-status::before {
  content: '';
  display: inline-block;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.6;
}
.pad-msg__tool-card.is-running .pad-msg__tool-card-status {
  color: var(--pad-accent);
}
.pad-msg__tool-card.is-error .pad-msg__tool-card-status {
  color: var(--pad-danger);
}
.pad-msg__tool-card.is-success .pad-msg__tool-card-status {
  color: var(--pad-fg-tertiary);
}
.pad-msg__tool-card-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  background: transparent;
  border: none;
  border-radius: 3px;
  cursor: pointer;
  color: var(--pad-fg-tertiary);
  flex-shrink: 0;
  padding: 0;
  margin-left: 2px;
}
.pad-msg__tool-card-toggle:hover {
  background: var(--pad-bg-base);
  color: var(--pad-fg-secondary);
}
.pad-msg__tool-card-chev {
  transition: transform var(--pad-dur-base) var(--pad-ease-in-out);
}
.pad-msg__tool-card-chev.is-collapsed {
  transform: rotate(-90deg);
}
.pad-msg__tool-card-result {
  margin: 0;
  padding: 8px 10px;
  background: var(--pad-muted);
  border-radius: 4px;
  font-family: var(--pad-font-mono);
  font-size: var(--pad-fs-11);
  line-height: var(--pad-lh-base);
  color: var(--pad-fg-secondary);
  white-space: pre-wrap;
  word-wrap: break-word;
  max-height: 240px;
  overflow: auto;
  align-self: stretch;
}

/* ===== thinking 块 (v0.3.8.16: max-height 折叠, 之前 grid-template-rows 0fr 在某些浏览器漏边) ===== */
.pad-msg__thinking { margin: 0; }
.pad-msg__thinking-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  /* v0.3.8.12: 字号 12 → 11, 颜色 fg-tertiary (更灰), 明确跟正文 (14px / fg-primary) 区分 */
  font-size: var(--pad-fs-11);
  font-weight: var(--pad-fw-medium);
  color: var(--pad-fg-tertiary);
  background: transparent;
  border: none;
  padding: 0;
  cursor: pointer;
  transition: color var(--pad-dur-fast) ease;
  letter-spacing: 0.02em;
}
.pad-msg__thinking-toggle:hover { color: var(--pad-fg-secondary); }
.pad-msg__thinking-chev {
  transition: transform var(--pad-dur-base) var(--pad-ease-in-out);
}
.pad-msg__thinking-chev.is-collapsed { transform: rotate(-90deg); }
.pad-msg__thinking-body {
  /* v0.3.8.16: 用 max-height 替代 grid-template-rows: 0fr —
   * 0fr 在部分 WebView 渲染下, content 的 padding/background 仍可见, 造成"漏边".
   * max-height: 0 + overflow: hidden 才是最可靠的"内容完全裁掉"方案. */
  max-height: 2000px;
  overflow: hidden;
  opacity: 1;
  transition:
    max-height var(--pad-dur-base) var(--pad-ease-out-soft),
    opacity var(--pad-dur-fast) ease,
    margin-top var(--pad-dur-base) var(--pad-ease-out-soft);
}
.pad-msg__thinking-body.is-collapsed {
  /* v0.3.8.18 fix: 单纯 max-height: 0 在部分 WebView 仍漏 padding/background,
   * 补 height/padding/margin/border 全归零, 保证 0 高度 + 0 占位, 不留任何像素 */
  max-height: 0;
  height: 0;
  padding: 0;
  margin: 0;
  border: 0;
  opacity: 0;
  margin-top: 0;
  overflow: hidden;
}
.pad-msg__thinking-content {
  margin-top: 4px;
  font-size: var(--pad-fs-12);
  font-style: italic;
  color: var(--pad-fg-tertiary);
  line-height: var(--pad-lh-base);
  padding: 6px 10px;
  /* v0.3.8.18: 之前用 var(--pad-bg-100) 直接拿 primitive, dark 模式没覆盖,
   * 结果是 #fafafa 白色方块. 改用 --pad-muted (semantic role), dark 下是 #1a1d24
   * 跟 card 容器同色, 视觉上 thinking 块是 card 里的小色块, 不抢戏. */
  background: var(--pad-muted);
  border-radius: 6px;
  transition: padding var(--pad-dur-base) ease;
}
/* v0.3.8.26 修 thinking 内的 markdown 颜色跟正文一样深:
 * 父级 .pad-msg__thinking-content color: var(--pad-fg-tertiary) 被 MarkdownContent
 * 内部 .pad-md 的 color: var(--pad-fg-primary) 覆盖 → thinking 文字跟 assistant body
 * 一样深, 视觉上"thinking 是元数据"的提示丢失.
 *
 * :deep() 让 scoped 样式穿透到 v-html 渲染的子元素 (无 data-v-xxx 属性). */
.pad-msg__thinking-content :deep(.pad-md),
.pad-msg__thinking-content :deep(.pad-md h1),
.pad-msg__thinking-content :deep(.pad-md h2),
.pad-msg__thinking-content :deep(.pad-md h3),
.pad-msg__thinking-content :deep(.pad-md h4) {
  color: var(--pad-fg-tertiary);
}
.pad-msg__thinking-body.is-collapsed .pad-msg__thinking-content {
  /* v0.3.8.18: 折叠时 content 自身的 padding/margin 也要清零, 避免父级 height: 0
   * 仍受 content 内部 padding 影响, 出现 1-2px 漏边 */
  margin: 0;
  padding: 0;
  border: 0;
}

/* ===== tool calls 块 (v0.3.8.12: 字号颜色更"非正文") ===== */
.pad-msg__tools { margin: 0; }
.pad-msg__tools-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  /* v0.3.8.12: 字号 12 → 11, 跟正文 14px 区分; 字重 medium + letter-spacing 跟 thinking 一致 */
  font-size: var(--pad-fs-11);
  font-weight: var(--pad-fw-medium);
  color: var(--pad-fg-tertiary);
  background: transparent;
  border: none;
  padding: 0;
  cursor: pointer;
  transition: color var(--pad-dur-fast) ease;
  letter-spacing: 0.02em;
}
.pad-msg__tools-toggle:hover { color: var(--pad-fg-secondary); }
.pad-msg__tools-icon { opacity: 0.7; }
.pad-msg__tools-chev {
  transition: transform var(--pad-dur-base) var(--pad-ease-in-out);
}
.pad-msg__tools-chev.is-collapsed { transform: rotate(-90deg); }
.pad-msg__tools-body {
  /* v0.3.8.16: 同样用 max-height + overflow: hidden 替代 grid-template-rows: 0fr */
  max-height: 800px;
  overflow: hidden;
  opacity: 1;
  transition:
    max-height var(--pad-dur-base) var(--pad-ease-out-soft),
    opacity var(--pad-dur-fast) ease;
}
.pad-msg__tools-body.is-collapsed {
  /* v0.3.8.18: 跟 thinking body 一样的兜底, 折叠时彻底归零 */
  max-height: 0;
  height: 0;
  padding: 0;
  margin: 0;
  border: 0;
  opacity: 0;
  overflow: hidden;
}
.pad-msg__tools-list {
  list-style: none;
  padding: 0;
  margin: 6px 0 0;
  border-left: 2px solid var(--pad-border);
  padding-left: 10px;
}
.pad-msg__tools-item {
  padding: 4px 0;
  font-size: var(--pad-fs-12);
  color: var(--pad-fg-secondary);
}
.pad-msg__tools-item + .pad-msg__tools-item {
  border-top: 1px dashed var(--pad-border);
  margin-top: 4px;
  padding-top: 6px;
}
.pad-msg__tools-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.pad-msg__tools-name {
  font-family: var(--pad-font-mono);
  font-weight: var(--pad-fw-medium);
  /* v0.3.8.26: 之前 fg-primary 跟 assistant body 颜色一样, 跟正文混淆. 改 fg-secondary
   * 让 tool name 跟正文 (primary) 视觉区分, 但又比 args/status (tertiary) 略强
   * —— 跟 thinking-content 的 "灰一点" 原则一致. */
  color: var(--pad-fg-secondary);
}
.pad-msg__tools-status {
  font-size: var(--pad-fs-11);
  color: var(--pad-fg-tertiary);
  padding: 1px 6px;
  border-radius: 999px;
  /* v0.3.8.18: bg-100 → muted (semantic role, dark 模式有覆盖) */
  background: var(--pad-muted);
}
.pad-msg__tools-item.is-running .pad-msg__tools-status {
  color: var(--pad-accent);
  background: var(--pad-accent-soft);
}
.pad-msg__tools-item.is-error .pad-msg__tools-status {
  color: var(--pad-danger);
  background: var(--pad-danger-subtle);
}
.pad-msg__tools-args {
  margin-top: 2px;
  color: var(--pad-fg-tertiary);
  font-family: var(--pad-font-mono);
  font-size: var(--pad-fs-11);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pad-msg__tools-result {
  margin: 4px 0 0;
  padding: 6px 8px;
  /* v0.3.8.18: bg-100 → muted (semantic role, dark 模式有覆盖) */
  background: var(--pad-muted);
  border-radius: 4px;
  font-family: var(--pad-font-mono);
  font-size: var(--pad-fs-11);
  color: var(--pad-fg-secondary);
  white-space: pre-wrap;
  word-wrap: break-word;
  max-height: 120px;
  overflow: auto;
}

/* ===== actions (小图标, 灰) ===== */
.pad-msg__actions {
  display: flex;
  align-items: center;
  gap: 2px;
  /* v0.3.8.1: 跟 composer 拉开距离, 避免 actions 跟 composer 顶部撞在一起 (穿帮) */
  margin-top: 10px;
  opacity: 0;
  transition: opacity var(--pad-dur-fast) ease;
}
.pad-msg:hover .pad-msg__actions,
.pad-msg:focus-within .pad-msg__actions { opacity: 1; }
.pad-msg__action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 22px;
  height: 22px;
  padding: 0 6px;
  border-radius: var(--pad-radius-sm);
  color: var(--pad-fg-tertiary);
  background: transparent;
  border: none;
  cursor: pointer;
  font-size: var(--pad-fs-11);
  font-family: inherit;
  transition: background var(--pad-dur-fast) ease, color var(--pad-dur-fast) ease;
}
.pad-msg__action:hover {
  background: var(--pad-bg-hover);
  color: var(--pad-fg-primary);
}
.pad-msg__copied { color: var(--pad-accent); }
/* v0.5.0-D 第12轮: 引用 button active 状态 (已引用这条消息) */
.pad-msg__action :deep(svg.is-active) { color: var(--pad-accent); }

/* v0.5.0-D 第12轮 v2 (D199): 选区引用浮动 button
   鼠标滑动选中文本后, 浮动 button 出现在 selection 上方
   跟 minimalist Copy 主题一致: 1px border + 圆角 + 微 shadow
   @mousedown.prevent 避免 button 点击导致 selection 立即消失 */
.pad-msg__quote-floating {
  position: absolute;
  z-index: 100;
  min-width: 80px;
  /* 不用 transform 避免覆盖 selection 边界
   * top/left 由 inline style 算好 (相对 message root) */
}
.pad-msg__quote-floating-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  background: var(--pad-card);
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-sm, 6px);
  font-size: var(--pad-fs-11, 11px);
  font-weight: var(--pad-fw-medium, 500);
  color: var(--pad-fg-primary);
  cursor: pointer;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.08);
  transition: background var(--pad-dur-fast, 0.15s) ease, color var(--pad-dur-fast, 0.15s) ease, border-color var(--pad-dur-fast, 0.15s) ease;
}
.pad-msg__quote-floating-btn:hover {
  background: var(--pad-accent-soft, rgba(99, 102, 241, 0.08));
  border-color: var(--pad-accent, #6366f1);
  color: var(--pad-accent, #6366f1);
}

/* ===== streaming loading (v0.5.1 phase-based status icon) ===== */
.pad-msg__loading {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--pad-fg-tertiary);
  font-size: var(--pad-fs-13);
  padding: 4px 0;
  /* 跟 StepGroup 里的 is-active 状态视觉一致: 用 accent 色提亮 spinner,
     让 user 一眼看到"AI 在工作" */
}
/* v0.5.1: 旋转 spinner — 替代 v0.3.8.9 的 3-dot bounce (1.2s → 1.4s 更稳) */
.pad-msg__spinner {
  color: var(--pad-accent);
  flex-shrink: 0;
  animation: pad-msg-spin 1.4s linear infinite;
}
@keyframes pad-msg-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
/* v0.5.1: status 文字 crossfade — 200ms 淡出 → 200ms 淡入, 文字轮换视觉过渡 */
.pad-msg__loading-text {
  /* inline-block + min-width 让 crossfade 时文字宽度变化不会让布局跳 */
  display: inline-block;
  font-style: italic;
  color: var(--pad-fg-secondary);
}
.pad-msg-status-enter-active,
.pad-msg-status-leave-active {
  transition:
    opacity 200ms ease,
    transform 200ms ease;
}
.pad-msg-status-enter-from {
  opacity: 0;
  transform: translateY(3px);
}
.pad-msg-status-leave-to {
  opacity: 0;
  transform: translateY(-3px);
}

/* v0.4.2+ LLM 重试提示 (跟 loading 一起出现, 在 loading 下面一行) */
.pad-msg__retry {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  margin-top: 6px;
  font-size: var(--pad-fs-12);
  color: var(--pad-warning-text);
  background: var(--pad-warning-subtle);
  border: 1px solid var(--pad-warning-border);
  border-radius: var(--pad-radius-md);
}
.pad-msg__retry-icon {
  display: inline-block;
  font-size: 14px;
  animation: pad-msg-retry-spin 1.2s linear infinite;
  /* 跟 loading dots 共用 bounce keyframe 也行, 但 spin 更直观 */
}
@keyframes pad-msg-retry-spin {
  to { transform: rotate(360deg); }
}
.pad-msg__retry-text strong {
  font-weight: var(--pad-fw-semibold);
  margin: 0 2px;
}
.pad-msg__retry-hint {
  color: var(--pad-fg-tertiary);
  margin-left: 4px;
  font-size: var(--pad-fs-11);
}

/* v0.4.2+ 错误 banner (think 阶段 LLM 调失败也显示, 之前只显示在空 message 状态) */
.pad-msg__error {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 8px 10px;
  margin: 6px 0;
  font-size: var(--pad-fs-12);
  color: var(--pad-danger-text);
  background: var(--pad-danger-subtle);
  border: 1px solid var(--pad-danger-border);
  border-radius: var(--pad-radius-md);
  line-height: 1.5;
  word-break: break-word;
}
.pad-msg__error-icon {
  flex-shrink: 0;
  font-size: 14px;
  line-height: 1.5;
}
.pad-msg__error-text {
  flex: 1;
}

/* v0.3.8.9: stream 结束但 4 类内容都空时的占位提示 */
.pad-msg__empty {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 0;
  font-size: var(--pad-fs-12);
  font-style: italic;
  color: var(--pad-fg-tertiary);
}
</style>
