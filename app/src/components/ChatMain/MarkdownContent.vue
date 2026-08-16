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
 *
 * 实现:
 * - marked v15 (pre-strict GFM, 跟 memory lesson 一致)
 * - highlight.js v11 代码块高亮 (通过 marked renderer 注入, 不需要 marked-highlight)
 * - post-processor: 文件路径 → <a class="pad-md-path">
 * - post-processor: v18+ **bold** 边界补丁 (跟 memory 教训一致, 防升级踩坑)
 */
import { computed, ref, onMounted, onUpdated, nextTick } from 'vue';
import { Marked } from 'marked';
import hljs from 'highlight.js';
import 'highlight.js/styles/atom-one-light.css';

interface Props {
  content: string;
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
  let input = props.content || '';
  // v0.3.8.11: 把 LLM 输出里的 literal `\n` `\t` 转成真换行/制表符
  // (LLM 偶尔会输出 "\\n" 字符串而不是真换行, 之前 marked + breaks:true 不处理这两个字符)
  input = input.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
  const raw = m.parse(input, { async: false }) as string;
  let out = raw;
  // 1. v18+ GFM 严格 bold 边界补丁 (中文 markdown 常见)
  out = out.replace(/\*\*([^*\n<>]+?)\*\*/g, '<strong>$1</strong>');
  // 2. 文件路径自动变链接 (Windows 路径 + POSIX 绝对路径)
  //    排除已经在 href/src/<a> 标签里的
  out = out.replace(
    /(?<!["'>])\b((?:[A-Z]:\\|\/(?:home|Users|opt|tmp|var|etc|root)\/)[^\s<>"']+)/g,
    '<a class="pad-md-path" href="javascript:void(0)" data-path="$1">$1</a>',
  );
  return out;
});

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
  <div ref="rootRef" class="pad-md" v-html="html" @click="onContentClick" />
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
</style>
