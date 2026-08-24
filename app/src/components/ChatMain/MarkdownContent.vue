<script setup lang="ts">
/**
 * MarkdownContent — v0.3.7+ AI 回复的 markdown 渲染器
 *
 * 设计目标 (Trae 参考 image 4):
 * - 连续 inline 流 (没有 AI 气泡标题)
 * - 代码块带语法高亮 + 右上角"复制"按钮 (CSS hover 显示)
 * - inline code 红色高亮
 * - 文件路径自动变链接 (e.g. `D:\path\file.ts`)
 * - bold/italic/list/quote/table/heading 正常 markdown 渲染
 * - v0.5.0-D 第12轮: LaTeX 数学公式 ($...$ inline + $$...$$ block), 走 KaTeX 渲染
 *
 * 实现:
 * - marked v15 (pre-strict GFM, 跟 memory lesson 一致)
 * - highlight.js v11 代码块高亮 (通过 marked renderer 注入, 不需要 marked-highlight)
 * - katex 0.18 数学公式渲染 (pre-extract → markdown → restore)
 * - post-processor: 文件路径 → <a class="pad-md-path">
 * - post-processor: v18+ **bold** 边界补丁 (跟 memory 教训一致, 防升级踩坑)
 */
import { computed, ref, onMounted, onUpdated, nextTick, watch } from 'vue';
import { Marked } from 'marked';
import hljs from 'highlight.js';
import katex from 'katex';
import 'highlight.js/styles/atom-one-light.css';
import 'katex/dist/katex.min.css';

interface Props {
  content: string;
  /** v3.60: streaming 时, 内容底部 mask-image 渐隐 (新 text 像"阳光铺满墙面"一样进入)
   *          比逐字 pop-in 更有节奏感.  父组件 ChatMessage 传 isStreaming 进来. */
  isStreaming?: boolean;
}
const props = defineProps<Props>();

// marked v15: setOptions 走 breaks/gfm, use 走 renderer (highlight 走自定义 renderer, 不需要 marked-highlight)
const m = new Marked();
m.setOptions({ breaks: true, gfm: true });
m.use({
  renderer: {
    code(token: { text: string; lang?: string }) {
      const lang = token.lang && hljs.getLanguage(token.lang) ? token.lang : 'plaintext';
      const highlighted = hljs.highlight(token.text, { language: lang }).value;
      return `<pre data-lang="${lang}"><code class="hljs language-${lang}">${highlighted}</code></pre>`;
    },
  },
});

const html = computed(() => {
  let input = displayedContent.value || '';
  // v0.3.8.11: 把 LLM 输出里的 literal `\n` `\t` 转成真换行/制表符
  // (LLM 偶尔会输出 "\\n" 字符串而不是真换行, 之前 marked + breaks:true 不处理这两个字符)
  input = input.replace(/\\n/g, '\n').replace(/\\t/g, '\t');

  // v0.5.0-D 第12轮: LaTeX 公式预提取, 走 KaTeX 渲染成 HTML
  //  顺序很重要: 必须在 markdown parse **之前** 提取 (否则 $ 会被 marked 当成普通文本,
  //  marked 不会破坏 LaTeX 但 KaTeX 输出会跟 markdown 嵌套冲突, 解析顺序难控).
  //  用 ⟪LATEX_<type>_<idx>⟫ 占位 (Unicode 角括号, 不在正常 markdown 文本中),
  //  marked 会原样保留, sanitizeHtml 也不会动 (非 HTML tag).
  //  最后再把占位替换回 KaTeX 渲染的 HTML.
  const latexBlocks: string[] = [];
  const latexInlines: string[] = [];
  let preMd = input;
  // 1. Block math: $$...$$ (跨行)
  preMd = preMd.replace(/\$\$([\s\S]+?)\$\$/g, (_m, tex: string) => {
    let html = '';
    try {
      html = katex.renderToString(tex.trim(), { displayMode: true, throwOnError: false, output: 'html' });
    } catch (e) {
      html = `<span class="pad-md-latex-error">${escapeHtml(tex)}</span>`;
    }
    const idx = latexBlocks.length;
    latexBlocks.push(html);
    return `⟪LATEX_BLOCK_${idx}⟫`;
  });
  // 2. Inline math: $...$ (单行, 不跨 $$)
  preMd = preMd.replace(/(?<![\\$])\$([^\$\n]+?)\$(?!\$)/g, (_m, tex: string) => {
    let html = '';
    try {
      html = katex.renderToString(tex.trim(), { displayMode: false, throwOnError: false, output: 'html' });
    } catch (e) {
      html = `<span class="pad-md-latex-error">${escapeHtml(tex)}</span>`;
    }
    const idx = latexInlines.length;
    latexInlines.push(html);
    return `⟪LATEX_INLINE_${idx}⟫`;
  });

  const raw = m.parse(preMd, { async: false }) as string;
  let out = raw;
  // 1. v18+ GFM 严格 bold 边界补丁 (中文 markdown 常见)
  out = out.replace(/\*\*([^*\n<>]+?)\*\*/g, '<strong>$1</strong>');
  // 2. 文件路径自动变链接 (Windows 路径 + POSIX 绝对路径)
  //    排除已经在 href/src/<a> 标签里的
  out = out.replace(
    /(?<!["'>])\b((?:[A-Z]:\\|\/(?:home|Users|opt|tmp|var|etc|root)\/)[^\s<>"']+)/g,
    '<a class="pad-md-path" href="javascript:void(0)" data-path="$1">$1</a>',
  );
  // 3. v0.5.0-D 第12轮: 恢复 LaTeX 占位
  out = out.replace(/⟪LATEX_BLOCK_(\d+)⟫/g, (_m, idx) => latexBlocks[parseInt(idx, 10)] ?? '');
  out = out.replace(/⟪LATEX_INLINE_(\d+)⟫/g, (_m, idx) => latexInlines[parseInt(idx, 10)] ?? '');
  // 4. v0.5.0-D 第3轮: HTML 注入 sanitizer
  //    用户反馈 "agent 写东西时整个前端页面都变了" — 根本原因: v-html 注入的 HTML
  //    包含 <style> 块, 选择器是全局生效的 (CSS 作用域跟 DOM 位置无关), 覆盖到整个 app.
  //    e.g. agent 写 AI 洞察报告, 模板里有:
  //      <style>body{background:#0a0a0a;color:#fff}...</style>
  //    v-html 渲染时这个 <style> 仍生效, 把整个 desktop app 头部都改成深色 + 占据一整块.
  //    修复: 剥掉所有 CSS/JS 注入向量, 保留合法 markdown 元素 (h1, p, ul, table, pre, ...).
  //    inline style="..." 保留 (单个元素的局部样式, 不会泄漏到全局).
  //    KaTeX 输出含 <span class="katex"> 等, sanitizer 不会动 (不在 block list).
  out = sanitizeHtml(out);
  return out;
});

/** HTML escape for LaTeX parse error fallback */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * v0.5.0-D 第3轮: markdown 渲染后的 HTML sanitizer.
 *   目标: 防 LLM 输出的 HTML 通过 v-html 注入恶意/破坏性 CSS/JS 到全局.
 *   做法: 剥掉 <script>/<style>/<link>/<meta>/<base>/<iframe>/<object>/<embed>/<form>/
 *         <input>/<button>/<textarea>/<select>/<frame>/<frameset> 等.
 *   也剥掉 on*= 事件属性 + javascript:/data:/vbscript: 协议 URL.
 *
 *   替代方案及放弃原因:
 *     - DOMPurify: 需要装新 dep (75KB), 项目当前没引, 安装 + 配置成本不低.
 *     - 整个内容用 iframe sandbox 渲染: 体验差, 用户在 chat 里看到的是黑盒.
 *     - marked m.setOptions({ html: false }): 太严, 用户写 ```html ``` 代码块时也不
 *       能渲染 (marked 走 code block 不会执行 HTML, 但不显示就更怪).
 *   选 regex sanitization: 简单, 75 行内能搞定, 覆盖已知注入向量.
 *
 *   已知限制: regex 解析 HTML 不如 DOMParser 严谨, 但对 LLM 输出这种"半结构化"内容
 *     已经够用 (LLM 不会刻意构造畸形 HTML 绕过 sanitizer).
 */
function sanitizeHtml(input: string): string {
  let s = input;
  // 1. 剥 script / style 块 (内容连同闭合标签一起剥)
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '');
  s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '');
  // 2. 剥掉其他 CSS/JS 注入向量 (self-closing 或空内容也覆盖)
  s = s.replace(/<link\b[^>]*\/?>/gi, '');
  s = s.replace(/<meta\b[^>]*\/?>/gi, '');
  s = s.replace(/<base\b[^>]*\/?>/gi, '');
  s = s.replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe\s*>/gi, '');
  s = s.replace(/<object\b[^>]*>[\s\S]*?<\/object\s*>/gi, '');
  s = s.replace(/<embed\b[^>]*\/?>/gi, '');
  s = s.replace(/<form\b[^>]*>[\s\S]*?<\/form\s*>/gi, '');
  s = s.replace(/<input\b[^>]*\/?>/gi, '');
  s = s.replace(/<button\b[^>]*>[\s\S]*?<\/button\s*>/gi, '');
  s = s.replace(/<textarea\b[^>]*>[\s\S]*?<\/textarea\s*>/gi, '');
  s = s.replace(/<select\b[^>]*>[\s\S]*?<\/select\s*>/gi, '');
  s = s.replace(/<frame\b[^>]*\/?>/gi, '');
  s = s.replace(/<frameset\b[^>]*>[\s\S]*?<\/frameset\s*>/gi, '');
  // 3. 剥 on* 事件属性 (onclick / onerror / onload / onmouseover 等)
  //    匹配 " onxxx=" 形式 (前面是空格或标签边界), 不区分大小写
  s = s.replace(/\s+on[a-z]+\s*=\s*"[^"]*"/gi, '');
  s = s.replace(/\s+on[a-z]+\s*=\s*'[^']*'/gi, '');
  s = s.replace(/\s+on[a-z]+\s*=\s*[^\s>]+/gi, '');
  // 4. 剥 javascript:/data:/vbscript: 协议 URL
  s = s.replace(/(\b(?:href|src|action|formaction|xlink:href)\s*=\s*["']?)\s*(?:javascript|data|vbscript)\s*:/gi, '$1#');
  return s;
}

/** 给所有 <pre> 注入 "复制" 按钮 (每次 v-html 更新后都重做) */
function injectCopyButtons(root: HTMLElement | null) {
  if (!root) return;
  const pres = root.querySelectorAll<HTMLPreElement>('pre');
  pres.forEach((pre) => {
    if (pre.querySelector('.pad-md-pre-copy')) return; // 已经有了
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pad-md-pre-copy';
    btn.title = '复制代码';
    btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const code = pre.querySelector('code')?.textContent ?? '';
      try {
        await navigator.clipboard.writeText(code);
        btn.classList.add('is-copied');
        btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
        setTimeout(() => {
          btn.classList.remove('is-copied');
          btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
        }, 1200);
      } catch (err) {
        console.warn('[markdown] copy failed', err);
      }
    });
    pre.appendChild(btn);
  });
}

const rootRef = ref<HTMLElement | null>(null);
onMounted(() => nextTick(() => injectCopyButtons(rootRef.value)));
onUpdated(() => nextTick(() => injectCopyButtons(rootRef.value)));

// ====== v3.60.2: streaming 节奏控制 — "打字机 + 呼吸感" ======
//   user 反馈: 当前流式太快, 几秒出来一片, 视觉不友好.
//   需求: 像打字机一样逐字显示, 但有节奏呼吸感, 不急不慢, 像流光一样一条一条.
//   修法: 节流 displayedContent 增长, 配合"随机停顿" 模拟人打字呼吸.
//   - 80% 概率: 40-70ms 间隔 (正常打字节奏, 流光一条一条)
//   - 16% 概率: 90-140ms 间隔 (中度停顿, 模拟思考下一句)
//   - 4% 概率:  220-300ms 间隔 (深度停顿, 模拟深呼吸 / 换段)
//   - 不切 char (避免 v-html 整段 remount 性能问题), 直接整段节流到 target 当前值.
//   - 非 streaming (message_end): 立即 flush 全部, 不能延迟 (让 message 看起来"卡顿" 会很奇怪).

const displayedContent = ref('');
let queueTimer: ReturnType<typeof setTimeout> | null = null;

function pickNextInterval(): number {
  const r = Math.random();
  if (r < 0.04) return 220 + Math.random() * 80;  // 4% 深度停顿 220-300ms
  if (r < 0.20) return 90 + Math.random() * 50;   // 16% 中度停顿 90-140ms
  return 40 + Math.random() * 30;                  // 80% 正常 40-70ms
}

function tick() {
  queueTimer = null;
  const target = props.content || '';
  // 整段推到 target 当前值 (不切 char)
  if (displayedContent.value !== target) {
    displayedContent.value = target;
  }
  // 如果还有未显示的 (LLM 还在 stream, target 还在涨), 继续 schedule
  const next = props.content || '';
  if (displayedContent.value.length < next.length) {
    queueTimer = setTimeout(tick, pickNextInterval());
  }
}

watch(
  () => [props.content, props.isStreaming] as const,
  ([content, streaming]) => {
    if (!streaming) {
      // 切到非 streaming (message_end): 立即 flush 全部, 取消节流
      if (queueTimer) { clearTimeout(queueTimer); queueTimer = null; }
      displayedContent.value = content || '';
      return;
    }
    // streaming: 启动节奏 (如果还没启)
    if (!queueTimer) {
      queueTimer = setTimeout(tick, pickNextInterval());
    }
  },
  { immediate: true, deep: true },
);

/** 点击文件路径链接: 复制路径到剪贴板 (未来可拓展为在 editor 打开) */
function onContentClick(e: MouseEvent) {
  const target = e.target as HTMLElement;
  if (target.classList?.contains('pad-md-path')) {
    e.preventDefault();
    const path = target.getAttribute('data-path') ?? target.textContent ?? '';
    navigator.clipboard?.writeText(path).catch(() => {});
  }
}
</script>

<template>
  <div
    ref="rootRef"
    class="pad-md"
    :class="{ 'is-streaming': props.isStreaming }"
    v-html="html"
    @click="onContentClick"
  />
</template>

<style>
/* 全局样式 (因为 v-html 渲染的子元素不在 scoped 范围内) */
.pad-md {
  font-size: var(--pad-fs-14);
  line-height: var(--pad-lh-relaxed);
  color: var(--pad-fg-primary);
  word-wrap: break-word;
  overflow-wrap: break-word;
}
/* v3.60.2: streaming 节奏控制 — 走的是"打字机 + 呼吸感" (displayedContent
   自适应节流), 不靠 CSS animation. 这里只留 mask-image 作为最后视觉缓冲,
   避免新内容在屏幕边缘硬截断 (滚动到底时最后一行自然淡出). */
.pad-md.is-streaming {
  -webkit-mask-image: linear-gradient(to bottom, black calc(100% - 48px), transparent 100%);
  mask-image: linear-gradient(to bottom, black calc(100% - 48px), transparent 100%);
  -webkit-mask-mode: luminance;
  mask-mode: luminance;
  padding-bottom: 4px;
}

/* v3.60.2: 不再使用 Transition + animation, 节奏靠 displayedContent 自适应节流.
   保留 mask-image 作为最后视觉缓冲. */
.pad-md > *:first-child { margin-top: 0; }
.pad-md > *:last-child { margin-bottom: 0; }
.pad-md p { margin: 0 0 8px; }
.pad-md h1, .pad-md h2, .pad-md h3, .pad-md h4 {
  margin: 16px 0 8px;
  font-weight: var(--pad-fw-semibold);
  line-height: 1.3;
  color: var(--pad-fg-primary);
}
.pad-md h1 { font-size: 20px; }
.pad-md h2 { font-size: 18px; }
.pad-md h3 { font-size: 16px; }
.pad-md h4 { font-size: 14px; }
.pad-md ul, .pad-md ol { margin: 8px 0; padding-left: 24px; }
.pad-md li { margin: 2px 0; }
.pad-md blockquote {
  margin: 8px 0;
  padding: 4px 12px;
  border-left: 3px solid var(--pad-border);
  color: var(--pad-fg-secondary);
  background: var(--pad-bg-active);
  border-radius: 0 var(--pad-radius-md) var(--pad-radius-md) 0;
}
.pad-md hr {
  border: none;
  border-top: 1px solid var(--pad-divider);
  margin: 12px 0;
}
.pad-md a {
  color: var(--pad-accent);
  text-decoration: none;
}
.pad-md a:hover { text-decoration: underline; }
.pad-md a.pad-md-path {
  font-family: var(--pad-font-mono);
  font-size: 13px;
  padding: 1px 4px;
  background: var(--pad-accent-soft);
  border-radius: 4px;
  color: var(--pad-accent);
}
.pad-md a.pad-md-path:hover { background: var(--pad-accent); color: var(--pad-fg-inverse); }

/* inline code: 红色高亮 (markdown 通用约定, code 区别于正文)
 * v0.3.8.19: 之前用 #d63939 硬编码, dark 模式也保持红色, 实际在
 * 深色背景上还能用 (红色普遍 #ef4444 在 dark 上反差更鲜).
 * 改用 --pad-danger (semantic role, light=#dc2626 dark=#ef4444),
 * 跟整套 monochrome 主题更协调, 也跟 status error 一致. */
.pad-md code {
  font-family: var(--pad-font-mono);
  font-size: 13px;
  background: transparent;
  color: var(--pad-danger);
  padding: 0;
}
/* 但 code 在 pre 里时, 重置 (走 hljs 自己的配色) */
.pad-md pre code {
  color: inherit;
  background: transparent;
  padding: 0;
  font-size: 13px;
}

/* code block: 浅灰底 + 右上角"复制"按钮
 * v0.3.8.19: 之前用 #f6f8fa 硬编码, dark 模式没适配, 跟 light 一样是浅灰,
 * 在暗色背景上刺眼. 改用 --pad-muted (semantic role),
 * light = #fafafa, dark = #171717 跟 card 容器同色. */
.pad-md pre {
  position: relative;
  margin: 8px 0;
  padding: 12px 14px;
  background: var(--pad-muted);
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-md);
  overflow-x: auto;
  font-size: 13px;
  line-height: 1.55;
}
.pad-md pre .pad-md-pre-copy {
  position: absolute;
  top: 6px;
  right: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-sm);
  background: var(--pad-card);
  color: var(--pad-fg-secondary);
  cursor: pointer;
  opacity: 0;
  transition: opacity var(--pad-dur-fast) ease, background var(--pad-dur-fast) ease;
  padding: 0;
}
.pad-md pre:hover .pad-md-pre-copy { opacity: 1; }
.pad-md pre .pad-md-pre-copy:hover { background: var(--pad-bg-hover); color: var(--pad-fg-primary); }
.pad-md pre .pad-md-pre-copy.is-copied { color: var(--pad-accent); }

/* table */
.pad-md table {
  border-collapse: collapse;
  margin: 8px 0;
  font-size: 13px;
}
.pad-md th, .pad-md td {
  border: 1px solid var(--pad-border);
  padding: 6px 10px;
  text-align: left;
}
.pad-md th { background: var(--pad-bg-active); font-weight: var(--pad-fw-semibold); }

/* img */
.pad-md img {
  max-width: 100%;
  height: auto;
  border-radius: var(--pad-radius-md);
  margin: 6px 0;
}

/* v0.5.0-D 第12轮: LaTeX 公式 (KaTeX 渲染)
 *   inline (跟文字同行) 和 block (独占行, 居中) 两种.
 *   KaTeX 自己有 .katex / .katex-display 样式, 这里只补跟 prose 整合的微调:
 *   - inline 公式: 保持跟 baseline 对齐, 字号跟 prose 一致
 *   - block 公式: 居中, 上下加 margin, 跟段落分隔
 *   - 错误 fallback: 红色 mono 小字 (说明 LaTeX 解析失败)
 */
.pad-md .katex { font-size: 1em; }
.pad-md .katex-display {
  margin: 12px 0;
  overflow-x: auto;
  overflow-y: hidden;
}
.pad-md .katex-display > .katex {
  display: inline-block;
  text-align: center;
}
.pad-md .pad-md-latex-error {
  color: var(--pad-danger);
  font-family: var(--pad-font-mono);
  font-size: 12px;
  background: var(--pad-bg-active);
  padding: 1px 4px;
  border-radius: 3px;
}
</style>
