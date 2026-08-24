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
import { ThumbsUp, ThumbsDown, Copy, RefreshCw, Loader2, Wrench, Brain, ChevronDown, ChevronRight, Quote, Check, AlertTriangle, FileText } from 'lucide-vue-next';
// 注: ChevronRight 之前是 step group collapsed indicator 用的, 这里引用 blockquote
//     折叠 indicator 也复用, 不重复 import.
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
 * 2026-08-20 P1-3: error divider 折叠 raw details 用.
 *   用 Set 跟踪哪些 messageId 是展开的 (默认折叠). 不持久化, reload 后重置.
 *   本地 component state, 不放 store — 每个 ChatMessage 独立管自己 details.
 */
const errorDetailsOpen = ref<Set<string>>(new Set());
function toggleErrorDetails(messageId: string) {
  const next = new Set(errorDetailsOpen.value);
  if (next.has(messageId)) next.delete(messageId);
  else next.add(messageId);
  errorDetailsOpen.value = next;
}
function isErrorDetailsOpen(messageId: string): boolean {
  return errorDetailsOpen.value.has(messageId);
}

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
 * v0.6 (P0-C): 格式化 compact 节省的 tokens 数字 (跟 ContextIndicator.vue 里的 formatTokens 一致)
 *   0 → "0", 1000+ → "X.XK" (1 位小数)
 */
function formatCompactionTokens(n: number): string {
  if (!n || n === 0) return '0';
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return `${n}`;
}

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

// ADR-0022 v3.8: 共享 useAttachmentPreview composable (App.vue mount 一次)
//   点 user 消息里的 image / file chip → 走全局浮层 (跟 Composer / TaskDrawer 一样)
//   避免每组件各管一份 image preview state 互相打架
// v3.9: image 优先用 in-memory data, 没有就降级到 savedPath 走 openImageFromPath (reload 后场景)
function openAttachmentPreviewImage(img: { data?: string; mimeType: string; savedPath?: string }) {
  import('@/composables/useAttachmentPreview').then(({ useAttachmentPreview }) => {
    const ap = useAttachmentPreview();
    if (img.data) {
      ap.openImage({ data: img.data, mimeType: img.mimeType });
    } else if (img.savedPath) {
      void ap.openImageFromPath(img.savedPath);
    } else {
      console.warn('[ChatMessage] image 既无 data 也无 savedPath, 无法预览');
    }
  });
}
function openAttachmentPreviewFile(f: { path: string; filename: string; mimeType: string; bytes: number }) {
  import('@/composables/useAttachmentPreview').then(({ useAttachmentPreview }) => {
    void useAttachmentPreview().openFile(f);
  });
}

// 字节数显示: 跟 Composer 一样
function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

// v0.5.0-D 第19轮 (D206): 从 user message.content 提取新问题部分
//   message.content 格式: "> <quoted line 1>\n> <quoted line 2>\n\n<user question>"
//   quoteContent 是原引用 (没 > 前缀), 用来对比
//   返回: <user question>  (去掉 > 前缀的引用行 + 空行)
//   如果匹配不上, 返回原 content (兜底)
function extractNewQuestion(content: string, quoteContent: string): string {
  // 1. quoteContent 拆成行, 每行加 "> " 前缀 (跟 content 里的格式一致)
  const quotedLines = quoteContent
    .split('\n')
    .map((line) => line.trim() ? `> ${line}` : '>')
    .join('\n');
  // 2. content 找到 quotedLines 的位置, 跳过 + 跳过后面的空行
  const idx = content.indexOf(quotedLines);
  if (idx < 0) {
    // 兜底: 匹配不上就返回原 content
    return content;
  }
  let after = content.slice(idx + quotedLines.length);
  // 跳过开头的空行 (\n+)
  after = after.replace(/^\n+/, '');
  return after;
}

// D214: 把 user message content 里的 [[ref:kind:name]] marker 转成 chip HTML, 在 chat 渲染
//   - escape HTML 防 XSS
//   - replace marker → <span class="pad-composer__ref-chip">...</span> (不带 × 按钮, 消息已发出不能删)
//   - 换行 → <br>
//   用 v-html 渲染, CSS 用 :deep() 穿透 scoped
function renderMessageContent(content: string): string {
  // 1. escape HTML 特殊字符 (先 escape, 再做 marker 替换, marker 替换回去是 HTML)
  let result = content
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  // 2. 把 marker 替换成 chip HTML
  //   注意: kind/name 已经是 escape 过的版本 (e.g. "<x>" → "&lt;x&gt;"), 浏览器会正确反解析显示
  // 2026-08-24 v3.25: 接受任意 kind (不限定 skill/tool/mcp/extension/command), 兼容 user 笔误
  //   (e.g. "[[ref:commands:sayhello]]" 复数 s 仍渲染成 chip, label 显示 "commands")
  const REF_RE = /\[\[ref:([a-zA-Z][a-zA-Z0-9_-]*):([^\s\]]+)\]\]/g;
  result = result.replace(REF_RE, (_, kind, name) => {
    return `<span class="pad-composer__ref-chip" data-ref-kind="${kind}" data-ref-name="${name}"><span class="pad-composer__ref-chip-label">${kind}</span><span class="pad-composer__ref-chip-name">${name}</span></span>`;
  });
  // 3. 换行 → <br>
  result = result.replace(/\n/g, '<br>');
  return result;
}

// D214 v7: user 气泡里 chip 点击事件委托
//   contentEditable (这里用 v-html 注入) 没有 Vue 事件, 走 parent click + closest 判断
//   点 chip 主体 → 弹 ChipPreview 看完整 body; 点非 chip 区域 → 忽略
function onUserContentClick(e: MouseEvent) {
  const target = e.target as HTMLElement;
  const chip = target.closest?.('.pad-composer__ref-chip') as HTMLElement | null;
  if (!chip) return;
  const kind = chip.dataset.refKind as 'skill' | 'tool' | 'mcp' | undefined;
  const name = chip.dataset.refName;
  if (!kind || !name) return;
  // chat 已发出的 chip 没有 × 按钮, 整块都触发 preview
  import('@/composables/useChipPreview').then(({ useChipPreview }) => {
    useChipPreview().openRef(kind, name, chip);
  });
}

// v0.5.0-D 第20轮 (D207): user 消息气泡里引用的可折叠行为
//   默认 collapsed, 显示首行 + "..." + chevron, 点击展开全文 / 收起
//   短引用 (< 80 字符单行) 自动不折叠 (用 Quote icon 装饰, 没有 chevron)
//   阈值跟"长"判断: 单行 + 总长 < 80 → 不折叠, 否则折叠
const QUOTE_COLLAPSE_THRESHOLD = 80;
const isQuoteLong = computed(() => {
  const q = props.message.quoteContent;
  if (!q) return false;
  // 多行 或 长度超过阈值 → 长
  if (q.includes('\n')) return true;
  return q.length > QUOTE_COLLAPSE_THRESHOLD;
});
const isQuoteCollapsed = ref(true);
function toggleQuote() {
  isQuoteCollapsed.value = !isQuoteCollapsed.value;
}
// 折叠时显示的预览: 首行 + "..."
// 展开时显示全文
const quotePreviewText = computed(() => {
  const q = props.message.quoteContent || '';
  if (!isQuoteLong.value || !isQuoteCollapsed.value) {
    return q;
  }
  // 折叠: 取首行 (按 \n 切)
  const firstLine = q.split('\n')[0] || '';
  if (firstLine.length > QUOTE_COLLAPSE_THRESHOLD) {
    return firstLine.slice(0, QUOTE_COLLAPSE_THRESHOLD) + '…';
  }
  // 首行短但有更多行 → 首行 + "..."
  return firstLine + '…';
});

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

// v0.5.0-D 第12轮 v2 (D199) + 第13轮 (D200) fix: 选区引用 — 鼠标滑动选中 assistant message 文字后, 浮动 "引用" button
//   user 反馈 "整段引用我希望也能支持对回复内容某些字段的引用, 比如鼠标滑动选中某些字段"
//
// D200 fix 说明:
//   之前 (D199 v1) 只在 per-message mouseup 上监听, 用户反馈
//   1) 选区在 message 之外开始 (e.g. 列表项内深层 DOM), mouseup 不冒泡到 message 根 → button 不弹
//   2) 浮动 button 位置跑到 message 顶部 (CSS 没 position: relative, button 跑到上层容器)
//   修法:
//   - CSS: .pad-msg--assistant 加 position: relative
//   - JS: 改用 document-level mouseup + selectionchange 双兜底, 不依赖 per-message mouseup
//   - 位置: 用 viewport 坐标 (rect.top / rect.left) + messageRect offset 算
//   - debounce 50ms: 防止 selectionchange 高频触发性能问题

const assistantRootRef = ref<HTMLElement | null>(null);
const selectionQuoteVisible = ref(false);
const selectionQuotePos = ref({ top: 0, left: 0 });
const selectedTextRef = ref('');

/**
 * 核心检查: 拿当前 window selection, 判断是否在这个 assistant message 内
 * - 是: 算出 button 位置 (selection 上方居中, 相对 message root)
 * - 否: 隐藏 button
 * 在 per-message mouseup, document mouseup, document selectionchange 都会调
 */
function checkSelectionInMessage() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
    selectionQuoteVisible.value = false;
    return;
  }
  const range = sel.getRangeAt(0);
  const rootEl = assistantRootRef.value;
  if (!rootEl || !rootEl.contains(range.commonAncestorContainer)) {
    selectionQuoteVisible.value = false;
    return;
  }
  const text = sel.toString().trim();
  if (!text || text.length < 1) {
    selectionQuoteVisible.value = false;
    return;
  }
  const rect = range.getBoundingClientRect();
  const messageRect = rootEl.getBoundingClientRect();
  const buttonW = 80;  // 跟 CSS min-width 一致
  selectionQuotePos.value = {
    // 相对 message root, 不是 viewport (button 是 position: absolute, parent 是 relative)
    top: rect.top - messageRect.top - 36,  // 36 = button height + 4px gap
    left: Math.max(0, rect.left - messageRect.left + rect.width / 2 - buttonW / 2),
  };
  selectedTextRef.value = text;
  selectionQuoteVisible.value = true;
}

function handleAssistantMouseUp(_e: MouseEvent) {
  // per-message 入口, 立即 setTimeout 让浏览器 finalize selection
  setTimeout(checkSelectionInMessage, 10);
}

function onDocumentMouseUp(_e: MouseEvent) {
  // D200 fix: document-level 兜底 — selection 可能在 message 之外开始,
  //   但 mouseup 触发时已经收尾, 这时调 checkSelection 仍能识别
  setTimeout(checkSelectionInMessage, 10);
}

let selectionChangeTimer: ReturnType<typeof setTimeout> | null = null;
function onDocumentSelectionChange() {
  // D200 fix: selectionchange 兜底 — keyboard 选区 (shift+arrow) / 双击选词 / 编程式 select
  //   都不会触发 mouseup, 必须靠 selectionchange 抓
  // debounce 50ms 防高频触发
  if (selectionChangeTimer) clearTimeout(selectionChangeTimer);
  selectionChangeTimer = setTimeout(checkSelectionInMessage, 50);
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
  // v0.5.0-D 第18轮 (D205) 增强: idle phase 也加轮换 label
  //   user 反馈 "目前caht回复是固定的'生成中...'" — 之前 idle 只有 1 个 label
  //   不轮换看起来是静态的. 加上 "思考中…/生成中…/下笔中…" 让 placeholder 始终有动效
  //   (D205 替代 D202 删掉的底部 status bar, 动态文字搬到这里)
  idle: ['思考中…', '生成中…', '下笔中…'],
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

// v0.5.0-D 第12轮 v2 (D199) + 第13轮 (D200): 选区引用 — 监听 document mouseup + selectionchange
//   selection 变化时检查, 如果 selection 消失 → 隐藏浮动 button
//   D200 fix: 加 document-level mouseup 兜底, 处理 selection 在 message 之外开始的 case
onMounted(() => {
  document.addEventListener('mouseup', onDocumentMouseUp);
  document.addEventListener('selectionchange', onDocumentSelectionChange);
});
onUnmounted(() => {
  document.removeEventListener('mouseup', onDocumentMouseUp);
  document.removeEventListener('selectionchange', onDocumentSelectionChange);
  if (selectionChangeTimer) clearTimeout(selectionChangeTimer);
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
      <!-- ADR-0022 v3.7: 附件 (image + file) 渲染在 content 之前
           image: 缩略图, 点开大图 (走 useChipPreview 类似的浮层)
           file: 文件名 chip (跟 sidebar file-ref chip 类似视觉) -->
      <div
        v-if="(message.images && message.images.length > 0) || (message.files && message.files.length > 0)"
        class="pad-msg__attachments"
      >
        <!-- v3.9: image 渲染逻辑
             - 优先 in-memory data (全图, 缩放后), in-memory 时直接用
             - 否则用 persisted thumbnail (~10-30KB JPEG, 持久化) 作为缩略图
             - 都没有 → 灰色 placeholder (空 savedPath 的边界场景, 实际上 always 至少有 thumbnail)
             - click → 优先 data, 否则 openImageFromPath(savedPath) 走 Tauri 重读 -->
        <button
          v-for="(img, i) in message.images || []"
          :key="`img-${i}`"
          class="pad-msg__attachment-image"
          type="button"
          :title="`${img.mimeType} (${formatBytes(img.bytes || 0)}, 点击放大预览)`"
          @click="openAttachmentPreviewImage(img)"
        >
          <img
            v-if="img.data || img.thumbnail"
            :src="img.data ? `data:${img.mimeType};base64,${img.data}` : `data:image/jpeg;base64,${img.thumbnail}`"
            class="pad-msg__attachment-thumb"
            :alt="`attachment ${i + 1}`"
          />
          <div v-else class="pad-msg__attachment-image-placeholder">
            <span>图片</span>
            <span class="pad-msg__attachment-image-meta">{{ img.mimeType }}</span>
          </div>
        </button>
        <!-- files 标签 (点开走共享 useAttachmentPreview 浮层, 跟 Composer 行为一致) -->
        <button
          v-for="(f, i) in message.files || []"
          :key="`file-${i}-${f.path}`"
          class="pad-msg__attachment-file"
          type="button"
          :title="`完整路径: ${f.path}\n${formatBytes(f.bytes)}\n点击预览`"
          @click="openAttachmentPreviewFile(f)"
        >
          <FileText :size="11" :stroke-width="1.75" class="pad-msg__attachment-file-icon" />
          <span class="pad-msg__attachment-file-name">{{ f.filename }}</span>
          <span class="pad-msg__attachment-file-size">{{ formatBytes(f.bytes) }}</span>
        </button>
      </div>

      <!-- v0.5.0-D 第19轮 (D206): user 消息里有引用时, 引用部分用 blockquote 可视化
           之前 (D199-D205) 都是用 MarkdownContent 渲染完整 content (带 > 语法, 渲染成 markdown blockquote)
           但 markdown blockquote 在 user 气泡里视觉太朴素 (跟普通文字没区别)
           D206 改法: 如果有 quoteContent, 拆开渲染 —
             1. quoteContent 用专门的 blockquote 样式 (左边框 + 缩进 + 灰背景)
                跟 Composer 里的 quote preview 风格一致
             2. 新问题用 MarkdownContent 渲染 (普通 markdown)
           quoteContent 是原引用文本 (没 > 前缀), 从 message.content 里去掉 > 前缀的部分
           v0.5.0-D 第20轮 (D207): 引用部分可折叠 (默认 collapsed, 点击展开)
             之前 (D206): 96px max-height + overflow-y: auto (滑动查看)
             现在: 默认只显示第一行 + chevron icon, 点击展开全文 / 收起
             短引用 (< 80 字符单行) 自动不折叠, 直接全显 + Quote icon (装饰)
             比滑动更清晰: 一眼看到"有引用, 点开看", 不用猜底下还有内容
           -->
      <template v-if="message.quoteContent">
        <div
          class="pad-msg__quote-block"
          :class="{ 'is-collapsed': isQuoteCollapsed, 'is-clickable': isQuoteLong }"
          @click="isQuoteLong && toggleQuote()"
        >
          <ChevronRight
            v-if="isQuoteLong"
            :size="12"
            :stroke-width="1.75"
            class="pad-msg__quote-chevron"
            :class="{ 'is-expanded': !isQuoteCollapsed }"
          />
          <Quote v-else :size="12" :stroke-width="1.75" class="pad-msg__quote-icon" />
          <div class="pad-msg__quote-text">{{ quotePreviewText }}</div>
        </div>
        <!-- 新问题部分: 从 message.content 去掉 quote 的 > 前缀行 + 空行 -->
        <div class="pad-msg__new-question">
          <!-- D214: 用 v-html 渲染, 让 [[ref:kind:name]] marker 显示成 chip
               MarkdownContent 不认识 marker, 会当文本显示. chip CSS 提到全局 chip.css (D214 v7).
               chip 点击走事件委托 (onUserContentClick) 弹预览浮层 -->
          <div
            class="pad-msg__user-content"
            v-html="renderMessageContent(extractNewQuestion(message.content, message.quoteContent))"
            @click="onUserContentClick"
          />
        </div>
      </template>
      <template v-else>
        <!-- D214: 同上 — v-html + renderMessageContent 渲染 chip. chip 点击弹预览 -->
        <div
          class="pad-msg__user-content"
          v-html="renderMessageContent(message.content)"
          @click="onUserContentClick"
        />
      </template>
    </div>
  </div>

  <!-- ============== SYSTEM MESSAGE: v0.4.6 压缩分界线 ==============
       v0.5.0-D 第27轮 (D210.4) 升级: 之前是 boolean 只标"完成", 现在是 object 表达
       3 种状态 (in_progress / success / failure), 全部走分隔线 UX, 不用 toast.
       user 反馈: "压缩失败要在上面提示, 包括压缩进行中都不要通过弹窗形式提示,
       而是统一使用分隔线的形式, 做的整体一些"
       - in_progress: ⏳ 正在压缩... (旋转 spinner)
       - success:    ✓ 上下文已压缩
       - failure:    ⚠ 压缩失败: <errorMessage> -->
  <div
    v-else-if="message.role === 'system' && message.compactionMarker"
    :class="['pad-msg__compaction-divider', `is-${message.compactionMarker.state}`]"
    :data-message-id="message.id"
  >
    <span class="pad-msg__compaction-line" />
    <span class="pad-msg__compaction-label">
      <!-- v0.5.0-D 第27轮 (D210.4): 按 state 显示不同 icon + text -->
      <template v-if="message.compactionMarker.state === 'in_progress'">
        <Loader2 :size="12" :stroke-width="1.75" class="pad-msg__compaction-spinner" />
        <span>正在压缩…</span>
      </template>
      <template v-else-if="message.compactionMarker.state === 'success'">
        <Check :size="12" :stroke-width="1.75" />
        <span>
          上下文已压缩
          <!-- v0.6 (P0-C): 显示释放 tokens 数字, 手动 compact 成功时才有 -->
          <template v-if="message.compactionMarker.freedTokens && message.compactionMarker.freedTokens > 0">
            （释放 {{ formatCompactionTokens(message.compactionMarker.freedTokens) }} tokens）
          </template>
        </span>
      </template>
      <template v-else-if="message.compactionMarker.state === 'failure'">
        <AlertTriangle :size="12" :stroke-width="1.75" />
        <span>压缩失败: {{ message.compactionMarker.errorMessage || '未知错误' }}</span>
      </template>
    </span>
    <span class="pad-msg__compaction-line" />
  </div>

  <!-- ============== SYSTEM MESSAGE: v0.5.0-D 第29轮 (D212) LLM 异常错误分界线 ==============
       跟 compaction divider 平行的新类型, 复用同一组 .pad-msg__compaction-* 样式 class
       (因为视觉一致 — 居中横线 + icon + 文本), 改 class prefix 太啰嗦.
       user 反馈 (D212): "我发送一个内容后, ai 在回复过程中可能出现 error 时,
       没有友好提示, 会出现突然终止的情况, 这种情况在一些调用LLM时由于TPM限制, 时常发生"
       修法: chat.ts message_end 检测 errorMessage + stopReason='error' → 推
       errorMarker system message, 这里渲染为居中橙色横线 "── ⚠ 生成失败: ... ───".
       - hasPartialContent=true: "生成中断 (已输出部分内容)"
       - hasPartialContent=false: "生成失败 (无任何内容)"
       跟压缩 UX 一致: 不用 toast, 全部走分隔线. -->
  <div
    v-else-if="message.role === 'system' && message.errorMarker"
    :class="['pad-msg__compaction-divider', 'is-failure', `is-cat-${message.errorMarker.category || 'unknown'}`]"
    :data-message-id="message.id"
  >
    <span class="pad-msg__compaction-line" />
    <span class="pad-msg__compaction-label pad-msg__error-label">
      <AlertTriangle :size="12" :stroke-width="1.75" />
      <span class="pad-msg__error-body">
        <!-- 2026-08-20 P1-3: 错误主体 — friendly 中文提示 + (已输出部分内容) hint -->
        <span class="pad-msg__error-friendly">
          {{ message.errorMarker.errorMessage || '未知错误' }}
          <template v-if="message.errorMarker.hasPartialContent">
            <span class="pad-msg__error-hint">(已输出部分内容)</span>
          </template>
        </span>
        <!-- raw error 折叠 (默认折叠, dev 排查用, user 不用关心) -->
        <button
          v-if="message.errorMarker.rawError && message.errorMarker.rawError !== message.errorMarker.errorMessage"
          class="pad-msg__error-details-toggle"
          @click="toggleErrorDetails(message.id)"
        >
          {{ isErrorDetailsOpen(message.id) ? '▼ Hide details' : '▶ Show details' }}
        </button>
        <pre
          v-if="message.errorMarker.rawError && isErrorDetailsOpen(message.id) && message.errorMarker.rawError !== message.errorMarker.errorMessage"
          class="pad-msg__error-raw"
        >{{ message.errorMarker.rawError }}</pre>
      </span>
    </span>
    <span class="pad-msg__compaction-line" />
  </div>

  <!-- 2026-08-20 P1-7: warning marker (跟 error 同款, 黄色, "AI 没返回内容")
       触发场景: LLM 调用结束但 assistant message 没创建 (idx=-1) — Pi SDK 协议层静默失败
       跟 errorMarker 区别: error 是有 errorMessage 的具体错误, warning 是"啥也没拿到" -->
  <div
    v-else-if="message.role === 'system' && message.warningMarker"
    :class="['pad-msg__compaction-divider', 'is-warning']"
    :data-message-id="message.id"
  >
    <span class="pad-msg__compaction-line" />
    <span class="pad-msg__compaction-label pad-msg__warning-label">
      <AlertTriangle :size="12" :stroke-width="1.75" />
      <span>
        <strong>{{ message.warningMarker.title || 'AI 没返回内容' }}</strong>
        <span class="pad-msg__warning-hint">{{ message.warningMarker.hint || '' }}</span>
      </span>
    </span>
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
        <MarkdownContent :content="step.stepText" :is-streaming="isStreaming" />
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

    <!-- v0.5.0-D 第14轮 fix (D201): streaming 期间 placeholder
         之前 (D200 前): step group 因为没 thinking/tools 不渲染, text body 因为没
         stepText 也不渲染, empty state 因为 isStreaming=true 不渲染 → 用户发了消息后
         视觉上没任何反馈, 像 "loading 不见了". 修法: streaming + 无内容时显示 placeholder
         (Loader2 + statusText 跟 phase 联动, 跟 Composer 下面 ComposerStatus 一致)
         v0.5.0-D 第17轮 (D204) REVERT D202: 删 AlertTriangle 警告变体
         (D202 在 emptyResponse=true 时换 AlertTriangle + warning text, 但 D204 已删
         emptyResponse 自动检测 — model 合法的空 message 不能告警, 之前是 false positive
         把 D202 截图的 sensenova-6.7-flash-lite 第一次空 message 误判成 error)
         现在 placeholder 永远只是 Loader2 + statusText, 跟 D201 一致 -->
    <div
      v-if="isStreaming && !hasContent && !hasThinkingOrTools && !errorMessage"
      class="pad-msg__streaming-placeholder"
    >
      <Loader2
        :size="13"
        :stroke-width="1.75"
        class="pad-msg__streaming-spinner"
      />
      <span>{{ statusText }}</span>
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
  /* v0.5.0-D 第13轮 fix (D200): 浮动 button 需要这个作为定位 anchor.
   *   之前没 position: relative → button position: absolute 跑到上层 positioned
   *   容器 (chat scroll container), 看起来在 message 顶部错位. */
  position: relative;
}

/* ===== user bubble (右) ===== */
.pad-msg__bubble { display: block; }
.pad-msg__bubble--user {
  max-width: 75%;
  padding: 8px 12px;
  background: var(--pad-bg-hover);
  color: var(--pad-fg-primary);
}

/* ===== ADR-0022 v3.7: user message 附件 (image + file) 渲染 ===== */
.pad-msg__attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
}
.pad-msg__attachment-image {
  padding: 0;
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-md);
  background: transparent;
  cursor: pointer;
  overflow: hidden;
  line-height: 0; /* 去掉 button 文字 baseline */
  transition: transform var(--pad-dur-fast) ease, border-color var(--pad-dur-fast) ease;
}
.pad-msg__attachment-image:hover {
  transform: scale(1.02);
  border-color: var(--pad-accent);
}
.pad-msg__attachment-thumb {
  max-width: 240px;
  max-height: 240px;
  width: auto;
  height: auto;
  display: block;
  object-fit: cover;
  border-radius: var(--pad-radius-sm);
}
/* v3.9: 边界 fallback — image 既无 data 也无 thumbnail (理论不会发生, 但兜底) */
.pad-msg__attachment-image-placeholder {
  width: 120px;
  height: 80px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  background: var(--pad-muted);
  color: var(--pad-fg-tertiary);
  font-size: var(--pad-fs-12, 12px);
  border-radius: var(--pad-radius-sm);
}
.pad-msg__attachment-image-meta {
  font-size: var(--pad-fs-10, 10px);
  font-family: var(--pad-font-mono, monospace);
}
.pad-msg__attachment-file {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 8px;
  background: var(--pad-card);
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-sm);
  font-size: var(--pad-fs-12, 12px);
  color: var(--pad-fg-primary);
  max-width: 240px;
  cursor: pointer;
  font-family: inherit;
  transition: border-color var(--pad-dur-fast, 0.12s) ease, background var(--pad-dur-fast, 0.12s) ease;
}
.pad-msg__attachment-file:hover {
  border-color: var(--pad-accent, #6366f1);
  background: var(--pad-accent-soft, #eef2ff);
}
.pad-msg__attachment-file-icon {
  color: var(--pad-fg-tertiary);
  flex-shrink: 0;
}
.pad-msg__attachment-file-name {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 140px;
  font-family: var(--pad-font-mono, monospace);
}
.pad-msg__attachment-file-size {
  font-size: var(--pad-fs-10, 10px);
  color: var(--pad-fg-tertiary);
  flex-shrink: 0;
}

/* v0.5.0-D 第19轮 (D206): user 消息气泡里引用的 blockquote 样式
 *   跟 Composer 的 quote preview 风格一致 (左边框 + 缩进 + 灰背景)
 *   引用部分用专门的 div 渲染, 不走 MarkdownContent (那样渲染成 markdown blockquote 视觉太朴素)
 *   新问题部分用 MarkdownContent 正常渲染
 *   布局: 引用 blockquote 在上, 新问题在下, 8px gap
 *   v0.5.0-D 第20轮 (D207): 改为可折叠 (默认 collapsed, 点击展开)
 *     - 短引用 (单行 < 80 字符) 不折叠, 用 Quote icon
 *     - 长引用 (多行 或 > 80 字符) 折叠, 用 ChevronRight icon, 展开后变 ChevronDown (旋转 90deg)
 *     - 折叠时显示首行 + "..." (preview), 展开显示全文
 *     - is-clickable: cursor pointer + hover 背景色
 *     - 不再 max-height + overflow (D206 的滑动方案, 视觉不清晰) */
.pad-msg__quote-block {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin: 0 0 8px 0;
  padding: 6px 8px;
  background: var(--pad-bg-secondary, rgba(0, 0, 0, 0.02));
  border-left: 2px solid var(--pad-border-strong, #d4d4d8);
  border-radius: 0 6px 6px 0;
  font-size: var(--pad-fs-12);
  color: var(--pad-fg-tertiary);
  user-select: text;
  transition: background var(--pad-dur-fast, 0.12s) ease;
}
.pad-msg__quote-block.is-clickable {
  cursor: pointer;
}
.pad-msg__quote-block.is-clickable:hover {
  background: var(--pad-bg-hover, rgba(0, 0, 0, 0.04));
}
.pad-msg__quote-icon {
  flex-shrink: 0;
  margin-top: 2px;
  color: var(--pad-fg-tertiary);
}
.pad-msg__quote-chevron {
  flex-shrink: 0;
  margin-top: 2px;
  color: var(--pad-fg-tertiary);
  transition: transform var(--pad-dur-fast, 0.12s) ease;
}
.pad-msg__quote-chevron.is-expanded {
  transform: rotate(90deg);
}
.pad-msg__quote-text {
  flex: 1;
  white-space: pre-wrap;
  word-break: break-word;
  /* 多行时正常换行, 不要被截断 (D207 删了 max-height, 让引用按需展开) */
  line-height: var(--pad-lh-base, 1.5);
}
.pad-msg__new-question {
  /* 新问题部分: 普通 markdown 渲染, 跟原 user 气泡一致 */
  font-size: var(--pad-fs-14);
  line-height: var(--pad-lh-base, 1.5);
}

/* D214 v7: user 消息气泡里 chip 样式已提到全局 app/src/assets/styles/chip.css
   删掉这里的 :deep() 重复规则, 避免以后改 chip 样式要改两处 */

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
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--pad-fs-11);
  font-weight: var(--pad-fw-medium);
  color: var(--pad-fg-tertiary);
  white-space: nowrap;
  letter-spacing: 0.04em;
  /* v0.5.0-D 第27轮 (D210.4): failure state 允许换行, 避免错误信息太长撑爆 */
}
.pad-msg__compaction-label > span {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 480px;
}
.pad-msg__compaction-spinner {
  animation: pad-msg-compaction-spin 1s linear infinite;
}
@keyframes pad-msg-compaction-spin {
  to { transform: rotate(360deg); }
}

/* v0.5.0-D 第27轮 (D210.4): 三种状态微调 line 颜色, 让用户视觉区分 */
.pad-msg__compaction-divider.is-in_progress .pad-msg__compaction-line {
  background: var(--pad-fg-tertiary);
  opacity: 0.4;
}
.pad-msg__compaction-divider.is-failure .pad-msg__compaction-line {
  background: var(--pad-fg-warning, #d97706);
  opacity: 0.5;
}
.pad-msg__compaction-divider.is-failure .pad-msg__compaction-label {
  color: var(--pad-fg-warning, #d97706);
}

/* 2026-08-20 P1-3: error category 切色 (跟 is-failure 错开, 让 user 视觉一眼分清错误类型)
   - auth_401 (apiKey 失效/填错) → 红色 (--pad-danger) — v3.37 改: 之前是 keychain 失效,
     现在是 settings.json 里 ProviderConfigDto.apiKey 字段失效/填错
   - forbidden_403 (model 拒绝) → 深红 (--pad-danger-strong)
   - rate_limit_429 (限流)      → 琥珀 (--pad-fg-warning, 跟 is-failure 同色)
   - server_5xx (服务异常)      → 灰色 (--pad-fg-tertiary)
   - network (网络)             → 灰色 (--pad-fg-tertiary)
   - unknown (未分类)            → 琥珀 (默认)
   颜色用 CSS variable 优先, 缺省 fallback. 后续 dark mode 自动适配. */
.pad-msg__compaction-divider.is-failure.is-cat-auth_401 .pad-msg__compaction-line,
.pad-msg__compaction-divider.is-failure.is-cat-auth_401 .pad-msg__compaction-label {
  color: var(--pad-danger, #dc2626);
  background: var(--pad-danger, #dc2626);
}
.pad-msg__compaction-divider.is-failure.is-cat-forbidden_403 .pad-msg__compaction-line,
.pad-msg__compaction-divider.is-failure.is-cat-forbidden_403 .pad-msg__compaction-label {
  color: var(--pad-danger-strong, #991b1b);
  background: var(--pad-danger-strong, #991b1b);
}
.pad-msg__compaction-divider.is-failure.is-cat-server_5xx .pad-msg__compaction-line,
.pad-msg__compaction-divider.is-failure.is-cat-server_5xx .pad-msg__compaction-label,
.pad-msg__compaction-divider.is-failure.is-cat-network .pad-msg__compaction-line,
.pad-msg__compaction-divider.is-failure.is-cat-network .pad-msg__compaction-label {
  color: var(--pad-fg-tertiary, #71717a);
  background: var(--pad-fg-tertiary, #71717a);
  opacity: 0.5;
}
/* 2026-08-20 P1-3: error divider 主体布局 — friendly + 折叠 details + raw pre */
.pad-msg__error-label {
  max-width: 90%;
  flex-wrap: wrap;
  justify-content: center;
  align-items: flex-start;
  text-align: left;
  gap: 6px;
  padding: 0 8px;
}
.pad-msg__error-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
  min-width: 0;
}
.pad-msg__error-friendly {
  white-space: pre-wrap;
  font-size: var(--pad-fs-12, 12px);
  line-height: 1.5;
}
.pad-msg__error-details-toggle {
  align-self: flex-start;
  background: transparent;
  border: 1px solid var(--pad-border, #e5e7eb);
  color: var(--pad-fg-tertiary, #71717a);
  font-size: var(--pad-fs-10, 10px);
  padding: 2px 8px;
  border-radius: var(--pad-radius-sm, 4px);
  cursor: pointer;
  font-family: var(--pad-font-mono, monospace);
  transition: background var(--pad-dur-fast, 120ms) ease, color var(--pad-dur-fast, 120ms) ease;
}
.pad-msg__error-details-toggle:hover {
  background: var(--pad-bg-hover, rgba(0,0,0,0.04));
  color: var(--pad-fg-primary, #18181b);
}
.pad-msg__error-raw {
  margin: 0;
  padding: 8px 10px;
  background: var(--pad-bg-input, #fafafa);
  border: 1px solid var(--pad-border, #e5e7eb);
  border-radius: var(--pad-radius-md, 6px);
  font-family: var(--pad-font-mono, monospace);
  font-size: var(--pad-fs-11, 11px);
  color: var(--pad-fg-secondary, #3f3f46);
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 200px;
  overflow-y: auto;
  align-self: stretch;
}
/* 2026-08-20 P1-7: warning divider (LLM 协议层静默失败, 比 is-failure error 轻一档)
   同 is-failure 框架, 颜色用更浅的琥珀 + 标题加粗 + hint 弱化. 跟 error 红 (var --pad-danger) 区分开,
   user 视觉一眼知道 "AI 没回复但不算调用失败". */
.pad-msg__compaction-divider.is-warning .pad-msg__compaction-line {
  background: var(--pad-fg-warning-soft, #f59e0b);
  opacity: 0.4;
}
.pad-msg__compaction-divider.is-warning .pad-msg__compaction-label {
  color: var(--pad-fg-warning-soft, #f59e0b);
}
.pad-msg__warning-label {
  max-width: 80%;
  flex-wrap: wrap;
  justify-content: center;
}
.pad-msg__warning-label strong {
  font-weight: var(--pad-fw-semibold, 600);
  margin-right: 6px;
}
.pad-msg__warning-hint {
  font-size: var(--pad-fs-11, 11px);
  color: var(--pad-fg-tertiary, #71717a);
  margin-left: 4px;
}
/* v0.5.0-D 第29轮 (D212): error divider hint 文字弱化 (e.g. "已输出部分内容") */
.pad-msg__error-hint {
  margin-left: 6px;
  font-size: var(--pad-fs-10, 10px);
  color: var(--pad-fg-tertiary, #71717a);
  font-weight: var(--pad-fw-regular, 400);
  font-style: italic;
  opacity: 0.85;
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
  background: var(--pad-card);
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

/* v0.5.0-D 第14轮 (D201): streaming 期间 placeholder
 *   之前用户发消息后没 loading 反馈 (D200 截图), 现在显示 Loader2 + 跟 phase 联动的文字
 *   跟整体 minimalist Copy 主题一致: 灰字 + 1.4s 旋转 spinner */
.pad-msg__streaming-placeholder {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 0;
  font-size: var(--pad-fs-12);
  color: var(--pad-fg-tertiary);
}
.pad-msg__streaming-spinner {
  /* v0.5.0-D 第15轮 fix (D202): 之前用错 animation — pad-msg-cursor-blink 是 opacity
   *   闪烁 (0/1), 不是 rotation. Loader2 圆环在 show/hide 反复, 看起来不转 (D201 截图).
   *   改用 rotation animation (跟 step group spinner 同一个 1.4s 旋转). */
  animation: pad-step-spin 1.4s linear infinite;
  opacity: 0.7;
}
/* v0.5.0-D 第17轮 (D204) REVERT: 删 D202 的 .is-warning 变体 + warning-icon class
   (emptyResponse 自动检测 + UI 警告变体已全删, 不再需要这些样式) */

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
  box-shadow: var(--pad-shadow-button);
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
