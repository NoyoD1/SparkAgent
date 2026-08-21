<script setup lang="ts">
/**
 * ChipPreview — chip 点击预览浮层
 *
 * D214 v7: 用户点 chip 主体 (不是 × 按钮) → 弹这个浮层, 显示完整 body
 *   - 用 Teleport 到 body, 避开父容器 overflow:hidden / z-index 问题
 *   - 位置: 默认在 chip 下方, 下方空间不够时弹到 chip 上方
 *   - 内容: title (kind + name) + body (skill 走 markdown, tool/mcp 走 pretty JSON)
 *   - 关闭: × 按钮 / Escape / 点空白
 *   - App.vue 一次性 mount, 走 useChipPreview 全局状态
 *
 * D214 v8: skill body 剥 YAML frontmatter, 走 MarkdownContent 渲染
 *   - 之前 `<pre>` 直接显示原文, frontmatter 跟正文糊在一起, 中间还有
 *     空行 ("内容中间出现空白区域" 问题)
 *   - 现在: frontmatter 单独显示 (key-value 小表格), 正文走 markdown 渲染
 *   - tool/mcp body 走 JSON.stringify(body, null, 2) pretty print
 *
 * D214 v8: popover 高度 360→240, 更紧凑更贴 chip
 *   - 之前 360 + chip 在底部 → popover 顶到 viewport 顶, 离 chip 太远
 *   - 现在 240 → 离 chip 最多 240+22+6 = 268px, 跟 chip 视觉更近
 *   - 超过 240 内部滚动, 不溢出 viewport
 */
import { computed, onMounted, onUnmounted, ref, watch, nextTick } from 'vue';
import { X, FileText, Wrench, Plug } from 'lucide-vue-next';
import { useChipPreview } from '@/composables/useChipPreview';
import MarkdownContent from './ChatMain/MarkdownContent.vue';

const { current, closeRef } = useChipPreview();

// 是否显示
const isOpen = computed(() => current.value !== null);

/**
 * 解析 body:
 * - skill: 剥 frontmatter (--- 之间的 YAML), frontmatter 单独展示 (key-value),
 *         正文走 markdown
 * - tool/mcp: 尝试 JSON.parse + pretty print, parse 失败 fallback 原文
 */
interface ParsedBody {
  /** frontmatter (skill 才有), key-value 形式, 排成小表格 */
  frontmatter: Array<{ key: string; value: string }>;
  /** 主体 markdown 文本 (skill) 或 pretty JSON (tool/mcp) */
  body: string;
  /** 主体类型, 模板按这个分支渲染 */
  type: 'markdown' | 'json' | 'text';
}

const parsedBody = computed<ParsedBody | null>(() => {
  if (!current.value || current.value.loading || current.value.error) return null;
  const raw = current.value.body;
  if (current.value.kind === 'skill') {
    return parseSkillBody(raw);
  }
  // tool / mcp: body 是 JSON 字符串
  try {
    const obj = JSON.parse(raw);
    return {
      frontmatter: [],
      body: JSON.stringify(obj, null, 2),
      type: 'json',
    };
  } catch {
    return { frontmatter: [], body: raw, type: 'text' };
  }
});

function parseSkillBody(raw: string): ParsedBody {
  // 匹配开头的 YAML frontmatter: ---\n...\n---\n (CRLF 也兼容)
  const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!fmMatch) {
    return { frontmatter: [], body: raw, type: 'markdown' };
  }
  const fmText = fmMatch[1];
  const main = fmMatch[2];
  // 解析 frontmatter: 一行一个 key: value, 简单支持 (name / description)
  const frontmatter: Array<{ key: string; value: string }> = [];
  for (const line of fmText.split(/\r?\n/)) {
    const m = line.match(/^([a-zA-Z_][\w-]*)\s*:\s*(.*)$/);
    if (m) {
      frontmatter.push({ key: m[1], value: m[2].trim() });
    }
  }
  return { frontmatter, body: main.trim(), type: 'markdown' };
}

// 浮层位置 (根据 chip 位置算)
const popupStyle = computed(() => {
  if (!current.value) return {};
  const POPUP_MAX_H = 360;          // D214 v8.1: 240→360, 长 skill body (description 几百字) 需要更高
  const POPUP_W = 480;
  const MARGIN = 6;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const anchor = current.value.pos;
  // 横向: 居中 chip, 但不能超出 viewport
  let left = anchor.left + anchor.width / 2 - POPUP_W / 2;
  left = Math.max(8, Math.min(left, vw - POPUP_W - 8));
  // 纵向: 默认下方, 下方 < POPUP_MAX_H + 40 时翻到上方
  //   D214 v8.1: 仍 360 max, 但 body 内部有 overflow-y: auto, 长内容可以滚
  //   (v8 设 240 跟 chip 视觉近, 但长内容截断没法滚 → user 反馈)
  const spaceBelow = vh - (anchor.top + MARGIN);
  const spaceAbove = anchor.top - MARGIN;
  let top: number;
  if (spaceBelow >= Math.min(POPUP_MAX_H, 200) || spaceBelow > spaceAbove) {
    top = anchor.top + 22 + MARGIN;  // 22 ≈ chip 高度
  } else {
    // 翻到 chip 上方: popover 顶端贴 chip 底端 (anchor.top - maxHeight), 内部滚
    top = anchor.top - POPUP_MAX_H - MARGIN;
    if (top < 8) top = 8;
  }
  return {
    top: `${top}px`,
    left: `${left}px`,
    width: `${POPUP_W}px`,
    maxHeight: `${Math.min(POPUP_MAX_H, Math.max(spaceBelow - 16, spaceAbove - 16, 240))}px`,
  };
});

// Kind → lucide icon
const KindIcon = computed(() => {
  if (!current.value) return FileText;
  if (current.value.kind === 'skill') return FileText;
  if (current.value.kind === 'tool') return Wrench;
  return Plug;
});

// Escape 关闭
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && isOpen.value) {
    e.preventDefault();
    closeRef();
  }
}

// 点空白关闭 (mouseup 比 click 更稳 — 拖动选区不会误关)
function onDocumentMouseUp(e: MouseEvent) {
  if (!isOpen.value) return;
  const target = e.target as Node;
  if (popupEl.value && popupEl.value.contains(target)) return;
  // 别关, 如果点的是 chip 本身 (用户可能切到另一个 chip)
  //   这里不主动处理: openRef 会先 close + open, closeRef 只在外部点空白时跑
  //   如果想"点 chip 切到另一个", openRef 自己 replace state, 这里别关就行
  //   但要是点的不是 chip 也不是 popup, 就关
  const isChip = (target as HTMLElement).closest?.('.pad-composer__ref-chip');
  if (isChip) return;  // 让 chip click handler 处理 (openRef 会替换 state)
  closeRef();
}

const popupEl = ref<HTMLElement | null>(null);

onMounted(() => {
  document.addEventListener('keydown', onKeydown);
  // 下一帧挂 mouseup, 避免跟 chip click 抢事件
  nextTick(() => {
    document.addEventListener('mouseup', onDocumentMouseUp);
  });
});
onUnmounted(() => {
  document.removeEventListener('keydown', onKeydown);
  document.removeEventListener('mouseup', onDocumentMouseUp);
});

// 重新打开时, 自动滚 body 到顶
watch(isOpen, async (open) => {
  if (open) {
    await nextTick();
    const body = popupEl.value?.querySelector('.chip-preview__body') as HTMLElement | null;
    if (body) body.scrollTop = 0;
  }
});
</script>

<template>
  <Teleport to="body">
    <div v-if="isOpen && current" ref="popupEl" class="chip-preview" :style="popupStyle" @mousedown.stop>
      <div class="chip-preview__head">
        <component :is="KindIcon" :size="13" :stroke-width="1.75" class="chip-preview__head-icon" />
        <span class="chip-preview__head-title">{{ current.title }}</span>
        <button class="chip-preview__close" title="关闭 (Esc)" @click="closeRef">
          <X :size="14" :stroke-width="2" />
        </button>
      </div>
      <div v-if="current.loading" class="chip-preview__loading">
        加载中…
      </div>
      <div v-else-if="current.error" class="chip-preview__error">
        加载失败: {{ current.error }}
      </div>
      <div v-else-if="parsedBody" class="chip-preview__body">
        <!-- D214 v8: frontmatter 单独排成小表格 (name + description),
             正文走 markdown 渲染 (MarkdownContent 组件, 跟 chat 渲染一致).
             之前 <pre> 直接显示原文 → frontmatter 跟正文糊一起, 中间大块空白 -->
        <div v-if="parsedBody.frontmatter.length > 0" class="chip-preview__meta">
          <div v-for="row in parsedBody.frontmatter" :key="row.key" class="chip-preview__meta-row">
            <span class="chip-preview__meta-key">{{ row.key }}</span>
            <span class="chip-preview__meta-val">{{ row.value }}</span>
          </div>
        </div>
        <!-- 正文 -->
        <div v-if="parsedBody.type === 'markdown' && parsedBody.body" class="chip-preview__content chip-preview__content--md">
          <MarkdownContent :content="parsedBody.body" />
        </div>
        <pre v-else-if="parsedBody.type === 'json'" class="chip-preview__content chip-preview__content--json">{{ parsedBody.body }}</pre>
        <pre v-else class="chip-preview__content chip-preview__content--text">{{ parsedBody.body }}</pre>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.chip-preview {
  position: fixed;
  z-index: 1000;
  background: var(--pad-card, #fff);
  border: 1px solid var(--pad-border, rgba(0, 0, 0, 0.12));
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18), 0 2px 6px rgba(0, 0, 0, 0.08);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  font-family: var(--pad-font-sans);
}
.chip-preview__head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--pad-border-subtle, rgba(0, 0, 0, 0.08));
  background: var(--pad-bg-secondary, rgba(0, 0, 0, 0.02));
  flex-shrink: 0;
}
.chip-preview__head-icon {
  color: var(--pad-fg-tertiary);
  flex-shrink: 0;
}
.chip-preview__head-title {
  flex: 1;
  font-size: 12px;
  font-weight: 600;
  color: var(--pad-fg-primary);
  font-family: var(--pad-font-mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chip-preview__close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  background: transparent;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  color: var(--pad-fg-tertiary);
  padding: 0;
  flex-shrink: 0;
}
.chip-preview__close:hover {
  background: var(--pad-bg-hover, rgba(0, 0, 0, 0.06));
  color: var(--pad-fg-primary);
}
/* D214 v8.1: body 整体可滚 (单一 scrollbar, 长 skill description 不截断)
   之前: body overflow: hidden, .chip-preview__content 自己 overflow-y: auto —
     meta 表格里的 description 如果很长 (几百字), 撑爆 meta 高度,
     把 content 区挤出可视区, 用户看到"不能滚" 其实是 .content 没滚到 meta.
   改: body 自身 overflow-y: auto, meta + content 都参与 body 滚动,
     .content 取消自己 overflow, 让 markdown 长文也能顺着 body 一起滚.
   v8 改 max-height 240→360 留更多空间, 但 body 仍可滚, 不会硬截断. */
.chip-preview__body {
  margin: 0;
  padding: 8px 10px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex: 1;
  min-height: 0;
  background: var(--pad-bg-base, #fafafa);
}

/* D214 v8: frontmatter 小表格 (name / description 等) */
.chip-preview__meta {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 6px 8px;
  background: var(--pad-bg-secondary, rgba(0, 0, 0, 0.03));
  border-radius: 4px;
  font-size: 11px;
  flex-shrink: 0;
}
.chip-preview__meta-row {
  display: flex;
  gap: 8px;
  align-items: baseline;
}
.chip-preview__meta-key {
  color: var(--pad-fg-tertiary);
  font-weight: 600;
  text-transform: uppercase;
  font-size: 10px;
  letter-spacing: 0.04em;
  min-width: 80px;
  flex-shrink: 0;
}
.chip-preview__meta-val {
  color: var(--pad-fg-primary);
  word-break: break-word;
  flex: 1;
}

/* D214 v8.1: 内容区去掉自己的 overflow-y, 跟 body 一起滚 (避免双层 scrollbar) */
.chip-preview__content {
  flex-shrink: 0;
}
/* markdown: 走 sans 字体, 跟 chat 一致. 顶部 margin 去掉避免空行 */
.chip-preview__content--md {
  font-family: var(--pad-font-sans);
  font-size: 12px;
  line-height: 1.5;
  color: var(--pad-fg-primary);
}
/* MarkdownContent 默认会给第一个元素加 margin-top, 在弹窗里不需要, 顶到 meta 表格下沿 */
.chip-preview__content--md :deep(*) {
  margin-top: 0 !important;
}
.chip-preview__content--md :deep(*:last-child) {
  margin-bottom: 0 !important;
}

/* json: pretty print, 等宽字体 */
.chip-preview__content--json {
  margin: 0;
  font-family: var(--pad-font-mono);
  font-size: 11px;
  line-height: 1.5;
  color: var(--pad-fg-primary);
  white-space: pre-wrap;
  word-break: break-word;
  padding: 6px 8px;
  background: var(--pad-bg-secondary, rgba(0, 0, 0, 0.03));
  border-radius: 4px;
}
.chip-preview__content--text {
  margin: 0;
  font-family: var(--pad-font-mono);
  font-size: 11px;
  line-height: 1.5;
  color: var(--pad-fg-primary);
  white-space: pre-wrap;
  word-break: break-word;
  padding: 6px 8px;
  background: var(--pad-bg-secondary, rgba(0, 0, 0, 0.03));
  border-radius: 4px;
}

.chip-preview__loading,
.chip-preview__error {
  padding: 24px 12px;
  text-align: center;
  font-size: 12px;
  color: var(--pad-fg-tertiary);
}
.chip-preview__error {
  color: var(--pad-fg-danger, #dc2626);
}
</style>
