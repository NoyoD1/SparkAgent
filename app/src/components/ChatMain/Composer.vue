<script setup lang="ts">
/**
 * Composer — textarea + toolbar + 当前 active provider/model chip (可切换) + mic/send.
 * 1:1 mirrors chat.html's bottom composer, 但 model chip 改成 active config.
 * v3: model 菜单视觉跟 PadSelect 弹层统一 (hover 灰底 / active 紫底+左 2px accent / checkmark)
 * v0.4.1+: 加 tool permission 按钮 + dropdown (3 选 1: ask / smart / allow)
 * v0.4.3 redesign: 删 v0.4.3 旧 text 计数 + 独立压缩按钮, 改用 ContextIndicator 组件
 *   (compact 83% + click 展开 popover 含 token 来源 breakdown + BYOK 提示 + 压缩按钮)
 */
import { ref, computed, nextTick, onMounted, onUnmounted, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { Plus, Paperclip, ChevronDown, Mic, ArrowUp, Square, AlertTriangle, Star, Check, Hand, Sparkles, CheckCheck, Quote, X, Lock, ListOrdered, Wrench, Plug } from 'lucide-vue-next';
import { useChatStore } from '@/stores/chat';
import { useSessionStore } from '@/stores/session';
import { useConfigStore, PROVIDER_OPTIONS, PERMISSION_MODE_OPTIONS, type PermissionMode } from '@/stores/config';
import { useUiStore } from '@/stores/ui';
import { useSkillsStore } from '@/stores/skills';
import { useUserToolsStore } from '@/stores/userTools';
import { useMcpServersStore } from '@/stores/mcpServers';
import { useComposerAttachmentsStore, type PendingImage, type PendingFile } from '@/stores/composerAttachments';
import { piTauri } from '@/lib/tauri';
import ContextIndicator from './ContextIndicator.vue';

const chatStore = useChatStore();
const sessionStore = useSessionStore();
const configStore = useConfigStore();
const uiStore = useUiStore();
const skillsStore = useSkillsStore();
const userToolsStore = useUserToolsStore();
const mcpServersStore = useMcpServersStore();
const attachmentsStore = useComposerAttachmentsStore();
const { activeSession } = storeToRefs(sessionStore);
const { skills } = storeToRefs(skillsStore);
const { tools: userTools } = storeToRefs(userToolsStore);
const { servers: mcpServers } = storeToRefs(mcpServersStore);

const inputText = ref('');
const showModelMenu = ref(false);
// v0.5.0-v0.1: 删 multi-agent persona, Composer / popover 改 2 类 (Skills / 扩展, 不含 Agents)
//  之前 v0.4.7a 是 3 类 (Skills / Agents / 扩展), 现在 Agents 段删除
//  user 16:24 拍板: agent 是边界定义/思维指导, 不需要切换, single agent 链路拉动
// D214: slash 触发字符: 同时支持 "/" (传统) 和 "@" (新), @ 是"引用语法"
//   主流编辑器 (Notion / Slack) 都用 @ 触发资源引用, 跟 "/" 命令区分开
const showSlashPopover = ref(false);
const slashPopoverQuery = ref('');
const slashPopoverTrigger = ref<'/' | '@' | null>(null);
const slashPopoverCursor = ref(0);  // 当前选中项
type RefKind = 'skill' | 'tool' | 'mcp';
interface SlashItem {
  group: 'Skills' | 'Tools' | 'MCP';
  slug: string;       // 显示用, e.g. /skill:code-review 或 @skill:code-review
  label: string;
  description: string;
  isPlaceholder?: boolean;
  kind?: RefKind;     // 资源类型, force-read 时区分
  name?: string;      // 资源名
}
const slashItems = computed<SlashItem[]>(() => {
  const out: SlashItem[] = [];
  // 1. Skills
  for (const s of skills.value) {
    out.push({
      group: 'Skills',
      slug: `@skill:${s.name}`,
      label: s.name,
      description: s.description || '(无描述)',
      kind: 'skill',
      name: s.name,
    });
  }
  // 2. Tools (D214 Phase 1: 接入 useUserToolsStore)
  for (const t of userTools.value) {
    out.push({
      group: 'Tools',
      slug: `@tool:${t.name}`,
      label: t.name,
      description: t.description || `${t.basedOn} preset`,
      kind: 'tool',
      name: t.name,
    });
  }
  // 3. MCP (D214 Phase 1: 接 useMcpServersStore, 没 server 时显示 placeholder)
  if (mcpServers.value.length === 0) {
    out.push({
      group: 'MCP',
      slug: '@mcp:',
      label: '(暂无可用)',
      description: 'MCP server 未配置, 去 Settings → MCP 添加',
      isPlaceholder: true,
    });
  } else {
    for (const s of mcpServers.value) {
      out.push({
        group: 'MCP',
        slug: `@mcp:${s.name}`,
        label: s.name,
        // MCP server 没有顶层 description, 用 command 或 url 凑个标识
        description: s.url || s.command || `MCP server: ${s.name}`,
        kind: 'mcp',
        name: s.name,
      });
    }
  }
  return out;
});
const filteredSlashItems = computed<SlashItem[]>(() => {
  const q = slashPopoverQuery.value.toLowerCase();
  if (!q) return slashItems.value;
  return slashItems.value.filter(
    (it) => it.label.toLowerCase().includes(q) || it.description.toLowerCase().includes(q),
  );
});

// v0.4.7b 旧 selectedSkillRefs 已删: chip 走 inline 渲染 (Phase 3), 不再需要在底部堆叠.
//   ref 解析逻辑保留在 send() 里的 allMarkers 收集.

// ====== D214 Phase 3: contentEditable rich input ======
// 替换 textarea, 支持 inline 灰底 chip 渲染 (skill/tool/mcp reference)
// Model: inputText (string) 是 source of truth, 内含 [[ref:kind:name]] marker
// DOM: richInputRef 的 innerHTML 是渲染结果 (text + chip spans)
// 同步: 每次 input 事件, 从 innerText 提取新 inputText, watch 触发 re-render

const richInputRef = ref<HTMLElement | null>(null);
const isComposing = ref(false);  // IME 中文输入中

// Marker regex — 文本里出现的 [[ref:kind:name]] 渲染成 chip
// 注意: kind 跟 name 不含空白 / ]]
const REF_RE = /\[\[ref:(skill|tool|mcp):([^\s\]]+)\]\]/g;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// 把 inputText 渲染成 innerHTML, [[ref:kind:name]] 变 chip span
function renderRichInput(): void {
  if (!richInputRef.value) return;
  // 保存当前光标 (text offset)
  const cursorBefore = getCursorOffsetInText();
  // 切分: text 段 + chip 段
  const text = inputText.value;
  const parts: Array<{ kind: 'text' | 'chip'; content: string; refKind?: string; refName?: string }> = [];
  let lastIdx = 0;
  REF_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = REF_RE.exec(text)) !== null) {
    if (m.index > lastIdx) {
      parts.push({ kind: 'text', content: text.slice(lastIdx, m.index) });
    }
    parts.push({ kind: 'chip', content: m[0], refKind: m[1], refName: m[2] });
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < text.length) {
    parts.push({ kind: 'text', content: text.slice(lastIdx) });
  }
  // 拼 innerHTML
  let html = '';
  for (const p of parts) {
    if (p.kind === 'text') {
      // 保留换行 (contentEditable 把 \n 渲染成 <br>)
      const lines = p.content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (i > 0) html += '<br>';
        if (lines[i]) html += `<span>${escapeHtml(lines[i])}</span>`;
      }
    } else {
      // D214 v3 bug fix: chip 内部 span 全部显式 contenteditable="false"
      //   某些浏览器 (尤其 WebView2) 不严格继承父级 false, 导致 Backspace 能进 chip 内部
      //   删字, 跟 "整块删" 的预期不符. 显式标 false 确保整块不可编辑.
      // D214 v2: 显示用 `kind:name` 格式 (不带 @ 前缀), 跟 Notion/Slack @ mention 一致
      html += `<span class="pad-composer__ref-chip" contenteditable="false" data-ref-kind="${p.refKind}" data-ref-name="${escapeHtml(p.refName || '')}" data-text-length="${p.content.length}"><span class="pad-composer__ref-chip-label" contenteditable="false">${p.refKind}</span><span class="pad-composer__ref-chip-name" contenteditable="false">${escapeHtml(p.refName || '')}</span><span class="pad-composer__ref-chip-x" contenteditable="false" data-remove="${escapeHtml(p.content)}">×</span></span>`;
    }
  }
  // D214 v6 fix: 在 chip 后面追加 zero-width space 作光标锚点
  //   浏览器 (尤其 WebView2) 在光标放在 non-editable chip 之后时, 经常 snap 到 chip 之前
  //   (表现为"光标卡在两个 chip 中间, 需要手动按 End 才能到末尾"). 加一个零宽空格
  //   让光标有可编辑目标可以落在它后面. 零宽空格是 0 宽字符, 视觉上不可见.
  //   extractLogicalText 会 strip 它, 不影响 inputText 内容.
  if (parts.length > 0 && parts[parts.length - 1].kind === 'chip') {
    html += '&#x200B;';
  }
  // 只有内容真正变了才写 (避免无谓重渲染)
  if (richInputRef.value.innerHTML !== html) {
    richInputRef.value.innerHTML = html;
  }
  // 恢复光标
  setCursorByTextOffset(cursorBefore);
}

// 在 contentEditable 里, 把光标放到 text offset 位置
// D214 bug fix: chip 用 data-text-length 记录 marker 在 inputText 里的实际长度
//   (visible text "@skill:x" 是 8 字符, 但 marker "[[ref:skill:x]]" 是 16 字符)
//   setCursor 必须用 data-text-length 减去, 才能跟 inputText 位置 1:1 对应
function setCursorByTextOffset(offset: number): void {
  if (!richInputRef.value) return;
  const root = richInputRef.value;
  let remaining = offset;
  function visit(node: Node): { node: Node; offset: number } | null {
    if (node.nodeType === Node.TEXT_NODE) {
      const len = (node.textContent || '').length;
      if (remaining <= len) {
        return { node, offset: remaining };
      }
      remaining -= len;
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement;
      if (el.classList && el.classList.contains('pad-composer__ref-chip')) {
        // chip 整段对应 marker 文本 (data-text-length), 减去后 cursor 跳到 chip 后
        const chipTextLen = parseInt(el.dataset.textLength || '0', 10);
        if (remaining <= chipTextLen) {
          // cursor 在 chip 内部或刚好在 chip 末尾 — 都放到 chip 之后 (chip 不可编辑)
          return { node: el.parentNode!, offset: Array.from(el.parentNode!.childNodes).indexOf(el) + 1 };
        }
        remaining -= chipTextLen;
        return null;
      }
      if (el.tagName === 'BR') {
        if (remaining === 0) return { node: el, offset: 0 };
        remaining -= 1;
        return null;
      }
      for (const child of Array.from(node.childNodes)) {
        const r = visit(child);
        if (r) return r;
      }
    }
    return null;
  }
  const pos = visit(root) ?? { node: root, offset: root.childNodes.length };
  try {
    const sel = window.getSelection();
    if (!sel) return;
    const range = document.createRange();
    range.setStart(pos.node, pos.offset);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  } catch (e) {
    console.warn('[Composer] setCursorByTextOffset failed:', e);
  }
}

// 从 contentEditable 的当前 selection 计算 text offset
// D214 bug fix: chip 用 data-text-length 记录 marker 实际长度, 累加时用它
//   而不是 chip 显示文本长度 (display "@skill:x" ≠ marker "[[ref:skill:x]]")
// D214 v6: 同时 strip zero-width space (renderRichInput 加的 cursor anchor), 让 offset
//   跟 inputText 字符串位置 1:1 对应, 否则差 1 会让 setCursorByTextOffset 算错位置
function getCursorOffsetInText(): number {
  if (!richInputRef.value) return inputText.value.length;
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return inputText.value.length;
  const range = sel.getRangeAt(0);
  if (!richInputRef.value.contains(range.startContainer)) {
    return inputText.value.length;
  }
  const root = richInputRef.value;
  let total = 0;
  // helper: text 节点去掉 zero-width space 后的可见长度
  const visibleTextLen = (s: string): number => s.replace(/\u200B/g, '').length;
  function visit(node: Node, until: Node | null, untilOffset: number): boolean {
    if (node === until) {
      if (node.nodeType === Node.TEXT_NODE) {
        // until 是 text 节点: untilOffset 是 DOM 内的字符位置, 需要把 ZWSP 折算回 inputText 偏移
        const text = node.textContent || '';
        const zwspBefore = (text.slice(0, untilOffset).match(/\u200B/g) || []).length;
        total += untilOffset - zwspBefore;
        return true;
      } else if (node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).tagName === 'BR') {
        total += untilOffset;
        return true;
      } else {
        for (let i = 0; i < untilOffset && i < node.childNodes.length; i++) {
          const c = node.childNodes[i];
          if (c.nodeType === Node.TEXT_NODE) {
            total += visibleTextLen(c.textContent || '');
          } else if (c.nodeType === Node.ELEMENT_NODE) {
            const cel = c as HTMLElement;
            if (cel.classList && cel.classList.contains('pad-composer__ref-chip')) {
              // chip 用 data-text-length (marker 实际长度)
              total += parseInt(cel.dataset.textLength || '0', 10);
            } else if (cel.tagName === 'BR') {
              total += 1;
            }
          }
        }
        return true;
      }
    }
    if (node.nodeType === Node.TEXT_NODE) {
      total += visibleTextLen(node.textContent || '');
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement;
      if (el.classList && el.classList.contains('pad-composer__ref-chip')) {
        // chip: 累加 data-text-length (marker 长度), 不算 visible text
        total += parseInt(el.dataset.textLength || '0', 10);
        return false;
      }
      if (el.tagName === 'BR') {
        total += 1;
      } else {
        for (const child of Array.from(node.childNodes)) {
          if (visit(child, until, untilOffset)) return true;
        }
      }
    }
    return false;
  }
  visit(root, range.startContainer, range.startOffset);
  return total;
}

// v0.5.0-D 第12轮: 引用回复 (quote & reply) — 当前 active session 的引用
//   从 chat store.quoteBySession 拉, 切 session 时自动切 quote
const currentQuote = computed(() => {
  const sid = sessionStore.activeSessionId;
  if (!sid) return null;
  return chatStore.quoteBySession[sid] ?? null;
});
// 引用预览 (截断过长内容, 避免 composer 区域被撑高)
const QUOTE_PREVIEW_MAX = 200;
const currentQuotePreview = computed(() => {
  const q = currentQuote.value;
  if (!q) return '';
  const text = q.content;
  if (text.length <= QUOTE_PREVIEW_MAX) return text;
  return text.slice(0, QUOTE_PREVIEW_MAX) + '…';
});
function clearQuote() {
  const sid = sessionStore.activeSessionId;
  if (!sid) return;
  chatStore.clearQuote(sid);
}

// v0.6+ 文件引用 (file reference) — sidebar 文件树点文件 → composer chip
//   per-session (切 session 不丢, 跟 quote 一致), sendPrompt 后清空.
//   渲染成 chip: 文件名 + 删除按钮, hover 看完整路径.
const currentFileRefs = computed(() => {
  const sid = sessionStore.activeSessionId;
  if (!sid) return [];
  return chatStore.fileRefsBySession[sid] ?? [];
});
function removeFileRef(path: string) {
  const sid = sessionStore.activeSessionId;
  if (!sid) return;
  chatStore.removeFileRef(sid, path);
}

// D214 Phase 3: 点击 chip 里的 × 删除该 ref
//   在 contentEditable 里点 × → 找到最近的 .pad-composer__ref-chip → 解析它的 marker → 从 inputText 删
// D214 v7: 点 chip 主体 (非 × 按钮) 弹预览浮层 — 看完整 skill/tool/mcp 内容
function onRichClick(e: MouseEvent) {
  const target = e.target as HTMLElement;
  // 路径 1: 点 × 按钮 → 删 chip
  if (target.classList.contains('pad-composer__ref-chip-x')) {
    const chip = target.closest('.pad-composer__ref-chip') as HTMLElement | null;
    if (!chip) return;
    const kind = chip.dataset.refKind;
    const name = chip.dataset.refName;
    if (!kind || !name) return;
    const reNew = new RegExp(`\\[\\[ref:${kind}:${name}\\]\\]`, 'g');
    const reOld = new RegExp(`\\[\\[${kind}:${name}\\]\\]`, 'g');
    inputText.value = inputText.value.replace(reNew, '').replace(reOld, '');
    e.preventDefault();
    return;
  }
  // 路径 2: 点 chip 主体 → 弹预览浮层
  const chip = target.closest('.pad-composer__ref-chip') as HTMLElement | null;
  if (chip) {
    const kind = chip.dataset.refKind as 'skill' | 'tool' | 'mcp' | undefined;
    const name = chip.dataset.refName;
    if (kind && name) {
      // useChipPreview 是 singleton, import 一下直接用
      // 动态 import 避免循环 (composable 动态 import store / tauri)
      import('@/composables/useChipPreview').then(({ useChipPreview }) => {
        useChipPreview().openRef(kind, name, chip);
      });
      e.preventDefault();
      // 阻止冒泡: 不要让 click 冒到 contentEditable 触发 focus 偏移
      e.stopPropagation();
    }
  }
}
// v0.4.1+ tool permission 菜单
const showPermissionMenu = ref(false);

// ====== ADR-0022 v3.5 (2026-08-23): composer 粘贴/拖拽 image + file ======
// 粘贴 image (clipboard) 或拖文件到 contentEditable -> upload -> 渲染 chip
// 阻止默认 paste (默认会 inline dataURL base64 巨大) + drop (默认会 navigate 到文件)
async function onRichPaste(e: ClipboardEvent) {
  if (!e.clipboardData) return;
  const items = e.clipboardData.items;
  // 找 image/* 类型
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.kind.startsWith('image/')) {
      e.preventDefault(); // 阻止 inline base64
      const file = item.getAsFile();
      if (file) await attachmentsStore.addFile(file);
      return; // 只处理第一个 image
    }
  }
  // 找 file 类型 (从其他 app 复制文件粘贴)
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.kind === 'file') {
      e.preventDefault();
      const file = item.getAsFile();
      if (file) await attachmentsStore.addFile(file);
      return;
    }
  }
  // 没文件, 走默认 (文字粘贴)
}

async function onRichDrop(e: DragEvent) {
  if (!e.dataTransfer) return;
  const files = Array.from(e.dataTransfer.files);
  if (files.length === 0) return; // 没文件, 可能是 text drag
  e.preventDefault();
  for (const file of files) {
    await attachmentsStore.addFile(file);
  }
}

// 附件显示用: 字节数 -> "2.3 MB" / "456 KB" / "789 B"
function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

// ADR-0022 v3.8: composer chip 点开大图 / 文件预览
//  - 跟 useChipPreview 同样用动态 import (避免循环, composable 内部也动态 import tauri)
//  - openImage 直接 set state; openFile 走 spawn_blocking 读 text 前 200 行
function openAttachmentPreviewImage(img: PendingImage) {
  import('@/composables/useAttachmentPreview').then(({ useAttachmentPreview }) => {
    useAttachmentPreview().openImage({ data: img.base64, mimeType: img.mimeType });
  });
}
function openAttachmentPreviewFile(f: PendingFile) {
  import('@/composables/useAttachmentPreview').then(({ useAttachmentPreview }) => {
    void useAttachmentPreview().openFile({
      path: f.path,
      filename: f.filename,
      mimeType: f.mimeType,
      bytes: f.bytes,
    });
  });
}

// 2026-08-20 P0-1 补充 B: 改用 session 自己的 permission mode (per-session 存)
// 旧实现读 configStore.permissionMode (全局), 导致一个 session 切了 ask, 所有 session 都跟着 ask.
// 新实现 sessionStore.getSessionPermissionMode(activeId) → session 自己 mode → fallback 全局.
const currentPermissionMode = computed<PermissionMode>(() => {
  const sid = activeSession.value?.id;
  if (!sid) return configStore.permissionMode;  // 没 active session 走全局
  return sessionStore.getSessionPermissionMode(sid);
});
const currentPermissionOption = computed(
  () => PERMISSION_MODE_OPTIONS.find((o) => o.value === currentPermissionMode.value) ?? PERMISSION_MODE_OPTIONS[0],
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
  // 2026-08-20 P0-1 补充 B: 写 session 自己的 mode, 不动全局 configStore.
  // 没 active session 时 (e.g. 用户在 initial hero 状态点 dropdown) 退化为改全局,
  // 保持向后兼容:用户新建 session 时仍然用全局当前值 (addSession 从 configStore 读).
  const sid = activeSession.value?.id;
  if (sid) {
    sessionStore.setSessionPermissionMode(sid, mode);
  } else {
    configStore.setPermissionMode(mode);
  }
  showPermissionMenu.value = false;
  // v0.5.0: Pi SDK 0.84.2 没有"运行时修改 permission mode" 的 RpcCommand — permission mode
  //   是 AgentSession 创建时设的, 跟 session 绑定. 要换 mode 必须 abort 当前 session
  //   + 新建 session. 当前策略: mode 改了只存到 session, 下次该 session 触发 sendPrompt
  //   重启 sidecar 时自动用新 mode; 当前正在跑的 turn 走旧 mode (走完当前 turn).
  //   旧实现改 configStore 全局, 切 session 也没用; 现在改 session 至少切换 session 时立即生效.
  console.log('[Composer] permission mode changed (per-session, applies on next sendPrompt for this session)', { sessionId: sid, mode });
}

// ===== v0.4.1+ 点外部关闭 permission menu + v0.4.4.6 model menu =====
// 标准 pattern: document.addEventListener('click') + contains 检查. 跟 ChatMain.vue / PadSelect.vue 一致.
// v0.4.4.6: 一起处理 model menu (以前只有 perm menu 走这个 pattern, model menu 点空白不关, user 反馈)
// v0.5.0-v0.1: 删 agent menu (multi-agent persona 回滚, 不需要切主)
// 2026-08-20 P0-1 补充 A: 加上 queue panel (3 选 1 弹层, 跟 perm / model 互斥)
const permMenuRef = ref<HTMLElement | null>(null);
const modelMenuRef = ref<HTMLElement | null>(null);
const queuePanelRef = ref<HTMLElement | null>(null);
// ADR-0022 v3.6: `+` 按钮 menu (合并 Plus/Image/Paperclip)
const plusMenuRef = ref<HTMLElement | null>(null);
const showPlusMenu = ref(false);
const filePickerRef = ref<HTMLInputElement | null>(null);
function togglePlusMenu() {
  showPlusMenu.value = !showPlusMenu.value;
}
function pickFiles() {
  // 关闭 menu, 触发隐藏的 <input type="file"> click
  showPlusMenu.value = false;
  filePickerRef.value?.click();
}
async function onFilePickerChange(e: Event) {
  const target = e.target as HTMLInputElement;
  if (!target.files) return;
  for (const file of Array.from(target.files)) {
    await attachmentsStore.addFile(file);
  }
  // 清 input.value 让同样文件名能再选
  target.value = '';
}
async function toggleBrowserPanelFromMenu() {
  showPlusMenu.value = false;
  await uiStore.toggleBrowserPanel();
}
function onClickOutsideAnyMenu(e: MouseEvent) {
  const target = e.target as Node;
  if (showPermissionMenu.value && permMenuRef.value && !permMenuRef.value.contains(target)) {
    showPermissionMenu.value = false;
  }
  if (showModelMenu.value && modelMenuRef.value && !modelMenuRef.value.contains(target)) {
    showModelMenu.value = false;
  }
  if (showQueuePanel.value && queuePanelRef.value && !queuePanelRef.value.contains(target)) {
    showQueuePanel.value = false;
  }
  if (showPlusMenu.value && plusMenuRef.value && !plusMenuRef.value.contains(target)) {
    showPlusMenu.value = false;
  }
}
onMounted(() => {
  document.addEventListener('click', onClickOutsideAnyMenu);
});
onUnmounted(() => document.removeEventListener('click', onClickOutsideAnyMenu));

// 2026-08-20 P0-1 补充 B: 改用 session 自己的 provider/model (per-session 存)
// 旧实现读 configStore.activeProvider / activeModel (全局), 切 session 时 chip 跟着变,
// 用户不能"一个 session 用 deepseek, 另一个用 minimax". 新实现 session 优先, fallback 全局.
//   三段 fallback 跟 chat.ts sendPrompt 里一样: session.modelId → session provider.activeModelId → 全局 activeModel.
const activeProvider = computed(() => {
  const sid = activeSession.value?.id;
  if (!sid) return configStore.activeProvider;
  const sessionProviderId = sessionStore.getSessionProviderId(sid);
  if (sessionProviderId) {
    const p = configStore.providers.find((x) => x.id === sessionProviderId);
    if (p) return p;
  }
  return configStore.activeProvider;
});
const activeModel = computed(() => {
  const sid = activeSession.value?.id;
  const p = activeProvider.value;
  if (!p) return configStore.activeModel;
  if (!sid) return p.models.find((m) => m.id === p.activeModelId) ?? null;
  const sessionModelId = sessionStore.getSessionModelId(sid);
  if (sessionModelId) {
    const m = p.models.find((x) => x.id === sessionModelId);
    if (m) return m;
  }
  return p.models.find((m) => m.id === p.activeModelId) ?? null;
});
const providerTypeLabel = computed(() => {
  const p = activeProvider.value;
  if (!p) return null;
  return PROVIDER_OPTIONS.find((o) => o.id === p.type)?.label ?? p.type;
});

const hasConfig = computed(() => !!activeProvider.value && !!activeModel.value);

const isStreaming = computed(() =>
  activeSession.value ? chatStore.isStreamingSession(activeSession.value.id) : false,
);

// 2026-08-20 P0-1 补充 A: 当前 session 的 send queue. reactive ref 让 UI 实时反映队列变化.
//   storeToRefs 解构 sendQueueBySession 后, 内部改值会触发本组件重新计算 length/列表.
const { sendQueueBySession } = storeToRefs(chatStore);
const currentSessionQueue = computed<string[]>(() => {
  const sid = activeSession.value?.id;
  if (!sid) return [];
  // D214 v5: 队列 item 改 {llm, user} 对象, UI 显示干净 user 文本 (不含 <reference> block)
  const raw = sendQueueBySession.value[sid] ?? [];
  return raw.map((it) => it.user);
});
const queueLength = computed(() => currentSessionQueue.value.length);
const showQueuePanel = ref(false);

function toggleModelMenu() {
  // 2026-08-20 P0-1 补充 A: streaming 期间禁 model 切换.
  // 业务约束: 模型切换要重启 sidecar, 跟正在跑的 stream 冲突 (current turn 状态机没法跨模型).
  // 允许编辑输入框 + send (入队, 见 chat store.sendQueue), 但 model 切换在 stream 期间不能点.
  if (isStreaming.value) {
    console.log('[Composer] model menu blocked: session is streaming');
    return;
  }
  showModelMenu.value = !showModelMenu.value;
  if (showModelMenu.value) showPermissionMenu.value = false;  // 二选一开
}

function toggleQueuePanel() {
  showQueuePanel.value = !showQueuePanel.value;
  if (showQueuePanel.value) {
    showModelMenu.value = false;
    showPermissionMenu.value = false;
  }
}

function clearQueue() {
  const sid = activeSession.value?.id;
  if (!sid) return;
  chatStore.clearSendQueue(sid);
}

function removeQueueItem(index: number) {
  const sid = activeSession.value?.id;
  if (!sid) return;
  chatStore.removeFromQueue(sid, index);
}

// ===== v0.4.7a: Composer / popover 监听 =====
// 监听 inputText, 检测光标前是不是 "/" (单独一个, 后无字符 / 有字符) -> 弹层
// 触发: ↑↓ 选 + Enter 触发 + Esc 关闭
// 选 skill -> 激活 (走 v0.4.4 skills store toggle)
// 选 mcp -> placeholder (P1 留空)
// 不含 builtin 22 (D184 v8 Q1 拍板: 终端命令式交互要淡化, 走 GUI 面板)
// v0.5.0-v0.1: 删 agent 段 (multi-agent persona 回滚, single agent 链路)

const slashPopoverRef = ref<HTMLElement | null>(null);

function isSlashTriggerActive(): { active: boolean; trigger: '/' | '@' | null } {
  // D214 v2: "/" 和 "@" 行为统一 — 都能在 chip 后/空白后/行首/标点后触发
  //   之前 "/" 必须行首, 但用户在一个 chip 后打 "/", popover 永远空.
  //   改: 跟 "@" 一样宽松, 任意非单词位置都能触发.
  const text = inputText.value;
  const cursor = getCursorOffsetInText();
  const before = text.slice(0, cursor);
  const after = text.slice(cursor);

  // 通用逻辑: 找最近一个 trigger char (@ 或 /), 检查它前面是不是英文单词中间
  //   trigger char 必须在光标前, 之间没有空白
  //   trigger char 前面不能是英文字母 (避免 "test/x" 这种单词中间触发)
  //   但允许: 空白/行首/[/(/]/中文/数字/标点/... (中文打 / 应该能触发, chip 后打 / 也能触发)
  //   后面不能直接是另一个 @ 或 /
  function checkTrigger(ch: '@' | '/'): boolean {
    const lastIdx = before.lastIndexOf(ch);
    if (lastIdx < 0) return false;
    const between = before.slice(lastIdx + 1);
    if (/\s/.test(between)) return false;
    const charBefore = lastIdx > 0 ? before[lastIdx - 1] : '';
    // 关键: 只挡 ASCII 英文字母 (a-zA-Z), 其他 (中文/数字/标点/空白/[]) 都放行
    if (lastIdx !== 0 && /[a-zA-Z]/.test(charBefore)) return false;
    if (after.startsWith(ch)) return false;
    return true;
  }

  // @ 优先级稍高 (更常见), 但实际上谁先匹配都行
  if (checkTrigger('@')) return { active: true, trigger: '@' };
  if (checkTrigger('/')) return { active: true, trigger: '/' };
  return { active: false, trigger: null };
}

function getSlashQuery(): string {
  // D214 v4 bug fix: 不能简单 lineBefore.slice(1), 因为 chip 后的 "/" 前面是 "]"
  //   (marker 末尾), 不是 "/" 字符. 改成找最近的 trigger char 位置, 取后面文本
  const text = inputText.value;
  const cursor = getCursorOffsetInText();
  const before = text.slice(0, cursor);

  // 找最近的 / 或 @, 哪个在光标前更近用哪个
  const lastSlash = before.lastIndexOf('/');
  const lastAt = before.lastIndexOf('@');
  let triggerIdx = -1;
  if (lastSlash >= 0 && !/\s/.test(before.slice(lastSlash + 1))) {
    triggerIdx = lastSlash;
  }
  if (lastAt >= 0 && !/\s/.test(before.slice(lastAt + 1))) {
    if (lastAt > triggerIdx) {
      triggerIdx = lastAt;
    }
  }

  if (triggerIdx < 0) return '';
  return before.slice(triggerIdx + 1);
}

// D214 Phase 3: watch inputText 触发 contentEditable re-render
//   外部修改 (e.g. send 后清空, /use-latest 指令插入) 走 inputText.value = X,
//   watch 会同步到 DOM. 用户直接打字走 onRichInput → 同步 inputText → watch → re-render.
// D214 v8.1: 同时调 autoResize, 因为 renderRichInput 重置 innerHTML 后
//   scrollHeight 变了, composer 高度得跟着重算. 之前只在 onRichInput 里调,
//   加 chip (programmatic) 时不触发, composer 高度不跟 → 引用多时内容被截.
watch(inputText, () => {
  // 在 IME 组合中不重渲染 (避免破坏中文输入)
  if (isComposing.value) return;
  nextTick(() => {
    renderRichInput();
    autoResize();
  });
});

// D214: 主动 load 3 个 store, 确保 popover 里有数据
//   之前完全靠 sidecar snapshot event, 启动时序问题 / 没访问 Tools/MCP tab
//   都会导致 store 是空的. 现在 on popover open 时主动 refresh
let _ensureLoadedPromise: Promise<void> | null = null;
async function ensureResourcesLoaded() {
  if (_ensureLoadedPromise) return _ensureLoadedPromise;
  _ensureLoadedPromise = (async () => {
    // Skills: 走 store 自己的 refreshFromTauri (Tauri list_skills, 不依赖 sidecar event)
    try { await skillsStore.refreshFromTauri(); } catch (e) { console.warn('[Composer] skills refresh failed:', e); }
    // User tools + MCP: 走 store 自带的 refresh
    try { await userToolsStore.refresh(); } catch (e) { console.warn('[Composer] userTools refresh failed:', e); }
    try { await mcpServersStore.refresh(); } catch (e) { console.warn('[Composer] mcpServers refresh failed:', e); }
  })();
  return _ensureLoadedPromise;
}

function openSlashPopover() {
  showSlashPopover.value = true;
  const trig = isSlashTriggerActive();
  slashPopoverTrigger.value = trig.trigger;
  slashPopoverQuery.value = getSlashQuery();
  slashPopoverCursor.value = 0;
  // D214: 弹层打开时确保数据加载完成, 不阻塞 UI
  ensureResourcesLoaded();
}

function closeSlashPopover() {
  showSlashPopover.value = false;
  slashPopoverQuery.value = '';
  slashPopoverTrigger.value = null;
  slashPopoverCursor.value = 0;
}

// D214 v8: 键盘 ↑↓ 选中项时 scroll 进可视区
//   用 .is-active 找当前选中项, scrollIntoView({block: 'nearest'}) 只滚最小距离
//   (顶部 / 底部已经在视区内就不滚, 避免抖动)
function scrollActiveItemIntoView() {
  const popover = slashPopoverRef.value;
  if (!popover) return;
  const active = popover.querySelector('.pad-composer__slash-item.is-active');
  if (active && 'scrollIntoView' in active) {
    (active as HTMLElement).scrollIntoView({ block: 'nearest' });
  }
}

// D214: 在 contentEditable 模式下, 把 marker 插到光标位置
//   marker 格式: [[ref:kind:name]] — 内部用, 显示成 kind:name 灰底 chip
// D214 v5 修: 替换范围 = [last_trigger_char, cursor), 不再用 lastNl+1
//   旧实现 "/" 用 lastNl+1, 单行场景 (chip + text + /skill2) 会把整行前面全删
//   (issue 3: 第二个 slash 覆盖第一个 chip). 统一用 lastIndexOf(trigger),
//   跟 getSlashQuery 保持一致 — trigger char 前面不管什么字符都放行.
// D214 v6 修: 用 requestAnimationFrame 等 DOM 真的渲染完再 setCursor, 避免 watch 的
//   renderRichInput 重渲染 innerHTML 把光标位置重置. setCursor 内部用 setStartAfter(lastChip)
//   最直接放法, 不依赖 setCursorByTextOffset 的 offset 算 (WebView2 在 chip 后 snap 光标).
async function insertMarkerAtCursor(marker: string): Promise<void> {
  const text = inputText.value;
  const cursor = getCursorOffsetInText();
  const before = text.slice(0, cursor);
  let replaceFrom = cursor;
  const trigger = slashPopoverTrigger.value;
  if (trigger) {
    const lastTrigger = before.lastIndexOf(trigger);
    if (lastTrigger >= 0) replaceFrom = lastTrigger;
  }
  const newText = text.slice(0, replaceFrom) + marker + text.slice(cursor);
  const targetOffset = replaceFrom + marker.length;
  inputText.value = newText;
  closeSlashPopover();
  // 等 watch 触发 → renderRichInput 跑完 → 浏览器把 DOM 真的渲染出来
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  if (!richInputRef.value) return;
  richInputRef.value.focus();
  // D214 v6 修 cursor 卡中间: 优先用 setStartAfter(lastChip) 直接放光标
  //   跨过 non-editable chip 后的 snap 问题 (WebView2 在 setCursorByTextOffset 算的
  //   parent offset N 之后, 仍 snap 到 chip 之前). 拿所有 chip 找最后一个, 直接
  //   range.setStartAfter. 如果 marker 不在末尾 (用户后面还有文字), 退回到 setCursorByTextOffset.
  const chips = Array.from(richInputRef.value.querySelectorAll('.pad-composer__ref-chip'));
  const sel = window.getSelection();
  if (sel && chips.length > 0) {
    // 算出最后一个 chip 在 inputText 中的位置, 看 targetOffset 是不是在它之后
    //   (即 marker 真的是最后一个, 后面没有别的文字)
    let lastChipInputEnd = 0;
    for (const c of chips) {
      const len = parseInt((c as HTMLElement).dataset.textLength || '0', 10);
      lastChipInputEnd += len;
    }
    if (targetOffset === lastChipInputEnd) {
      // 真的在最后一个 chip 后面 → 用 setStartAfter 直接放 (最可靠)
      const range = document.createRange();
      const lastChip = chips[chips.length - 1] as HTMLElement;
      range.setStartAfter(lastChip);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
      return;
    }
  }
  // marker 后面还有文字 (例如 user 输入了 `chip1 /test2 hello` → 选 chip 后是
  //   `chip1 chip2 hello`, cursor 应在 chip2 后但在 hello 前), 走 offset 算法
  setCursorByTextOffset(targetOffset);
  // D214 v8.1: 加 chip 后重算高度. watch 也会触发 autoResize, 但 pickSlashItem
  // 走的是 await rAF → setCursor, DOM 这时已稳定, 显式调一次更稳
  autoResize();
}

async function pickSlashItem(item: SlashItem) {
  if (item.isPlaceholder) {
    console.log('[Composer / popover] placeholder, no-op');
    return;
  }
  if (!item.kind || !item.name) {
    console.warn('[Composer / popover] missing kind/name:', item);
    return;
  }
  // D214: 统一 marker 格式 [[ref:kind:name]], send 时按 kind 解析
  const marker = `[[ref:${item.kind}:${item.name}]]`;
  await insertMarkerAtCursor(marker);
  console.log(`[Composer / popover] ${item.kind} reference inserted: ${item.name}`);
}

// D214 v3 bug fix: 用 innerText 提取会丢 chip marker (变成 "SKILL name ×" 字符串)
//   改用 DOM walk, chip 元素用 marker 文本代替, 纯文本节点原样保留
//   这样输入 `/` 后 chip 不会被 watch 重渲染抹掉
// D214 v6: 同步 strip zero-width space (\u200B, renderRichInput 加的 cursor anchor),
//   不让这个不可见字符进入 inputText → 避免污染 LLM prompt 和 user 气泡渲染
function extractLogicalText(root: HTMLElement): string {
  let result = '';
  function visit(node: Node): void {
    if (node.nodeType === Node.TEXT_NODE) {
      result += (node.textContent || '').replace(/\u00A0/g, ' ').replace(/\u200B/g, '');
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement;
      if (el.classList && el.classList.contains('pad-composer__ref-chip')) {
        const kind = el.dataset.refKind;
        const name = el.dataset.refName;
        if (kind && name) {
          result += `[[ref:${kind}:${name}]]`;
        }
        // chip 内部 text/span 都跳过 (chip 整体对应一个 marker)
      } else if (el.tagName === 'BR') {
        result += '\n';
      } else {
        for (const child of Array.from(node.childNodes)) {
          visit(child);
        }
      }
    }
  }
  visit(root);
  // 统一换行符
  return result.replace(/\r\n?/g, '\n');
}

// D214: contentEditable 输入处理 (替代 onTextareaInput)
function onRichInput() {
  if (isComposing.value) return;  // IME 组合中不重算
  if (!richInputRef.value) return;
  const newText = extractLogicalText(richInputRef.value);
  inputText.value = newText;
  const trig = isSlashTriggerActive();
  if (trig.active) {
    if (!showSlashPopover.value) openSlashPopover();
    else {
      slashPopoverTrigger.value = trig.trigger;
      slashPopoverQuery.value = getSlashQuery();
    }
  } else {
    if (showSlashPopover.value) closeSlashPopover();
  }
  nextTick(autoResize);
}

// D214 v5: IME compositionend 兜底
//   WebView2 / 某些浏览器在 IME 完成 (compositionend) 后, input 事件可能不重新触发,
//   导致 onRichInput 没机会跑, inputText.value 还停留在 composition 之前的状态.
//   用户接着按 Enter 发消息时, send() 读到的 text 就少了刚输入的中文/日文/韩文等
//   IME 文字 — 表现为"文字被吞".
//   修法: compositionend 主动调 onRichInput 重新从 DOM 提取文本, 同步 inputText.
function onCompositionEnd() {
  isComposing.value = false;
  onRichInput();
}

function onRichKeydown(e: KeyboardEvent) {
  // D214: popover 在时, 拦截方向键 + Enter + Esc
  if (showSlashPopover.value) {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeSlashPopover();
      return;
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      slashPopoverCursor.value = Math.min(slashPopoverCursor.value + 1, filteredSlashItems.value.length - 1);
      // D214 v8: 让选中项 scroll 进可视区. 之前只能滚鼠标, 键盘按到底下面看不到
      nextTick(() => scrollActiveItemIntoView());
      return;
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      slashPopoverCursor.value = Math.max(slashPopoverCursor.value - 1, 0);
      nextTick(() => scrollActiveItemIntoView());
      return;
    } else if (e.key === 'Enter') {
      if (filteredSlashItems.value.length > 0 && slashPopoverCursor.value >= 0) {
        e.preventDefault();
        const item = filteredSlashItems.value[slashPopoverCursor.value];
        if (item) pickSlashItem(item);
      } else {
        // 没选中就退出 popover
        e.preventDefault();
        closeSlashPopover();
      }
      return;
    }
  } else if (e.key === 'Enter' && !e.shiftKey) {
    // D214: popover 不在, Enter 直接 send (跟 textarea 版一致)
    e.preventDefault();
    send();
    return;
  }
  // Backspace 紧贴 chip 前面: 删整个 chip (避免留下半截 marker)
  if (e.key === 'Backspace') {
    const cursor = getCursorOffsetInText();
    if (cursor > 0) {
      const text = inputText.value;
      // 找 cursor 之前的最后一个 [[ref:...]] marker
      const re = /\[\[ref:(skill|tool|mcp):([^\s\]]+)\]\]/g;
      let lastEnd = -1;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        if (m.index + m[0].length === cursor) {
          lastEnd = m.index;
          break;
        }
      }
      if (lastEnd >= 0) {
        e.preventDefault();
        inputText.value = text.slice(0, lastEnd) + text.slice(cursor);
        nextTick(() => setCursorByTextOffset(lastEnd));
      }
    }
  }
}

function pickModel(providerId: string, modelId: string) {
  // 2026-08-20 P0-1 补充 A: streaming 兜底 (UI 也禁了, 防 bypass)
  if (isStreaming.value) {
    console.warn('[Composer] pickModel blocked: session is streaming');
    return;
  }
  // 2026-08-20 P0-1 补充 B: 写 session 自己的 model, 不动全局 configStore.
  // 没 active session 时退化为改全局, 保持向后兼容.
  const sid = activeSession.value?.id;
  if (sid) {
    sessionStore.setSessionModel(sid, providerId, modelId);
  } else {
    configStore.setActiveModel(providerId, modelId);
  }
  showModelMenu.value = false;
  console.log('[Composer] model changed (per-session, applies on next sendPrompt for this session)', { sessionId: sid, providerId, modelId });
}

function openSettings() {
  uiStore.openSettings('provider');
  showModelMenu.value = false;
}

async function send() {
  // D214 v5 兜底: send 前再 sync 一次, 防止 IME/慢输入场景下 inputText 落后于 DOM
  //   (典型: WebView2 中文 IME compositionend 后 input 事件不重新触发).
  //   主动从 DOM 重新提取, 保证 send 读到的 text 跟用户看到的一致.
  if (richInputRef.value && !isComposing.value) {
    const synced = extractLogicalText(richInputRef.value);
    if (synced !== inputText.value) {
      console.warn('[Composer] send: inputText was stale, refreshed from DOM', {
        before: inputText.value.slice(0, 60),
        after: synced.slice(0, 60),
      });
    }
    inputText.value = synced;
  }
  const rawText = inputText.value;
  const text = rawText.trim();
  if (!text) return;
  // 2026-08-20 P0-1 补充 A: 去掉之前的 `if (isStreaming.value) return`.
  //   业务要求: streaming 时允许 send (入队, 等 LLM 回完自动发), 不应该拦.
  //   sendPrompt 内部已经有 streaming 入队判断 (chat.ts:780-787), 这里直接放行.
  if (!hasConfig.value) {
    openSettings();
    return;
  }
  // D214: 解析 [[ref:kind:name]] marker, 强制 read 后拼到 user prompt 头部
  //   支持 kind: skill / tool / mcp — 每次 send 都重新 read, 不依赖 cache
  //   兼容老 [[skill:xxx]] marker
  const refs: Array<{ kind: RefKind; name: string; body: string }> = [];
  const allMarkers: Array<{ kind: RefKind; name: string }> = [];
  const newRe = /\[\[ref:(skill|tool|mcp):([^\s\]]+)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = newRe.exec(rawText)) !== null) {
    allMarkers.push({ kind: m[1] as RefKind, name: m[2] });
  }
  const oldRe = /\[\[skill:([^\s\]]+)\]\]/g;
  while ((m = oldRe.exec(rawText)) !== null) {
    allMarkers.push({ kind: 'skill', name: m[1] });
  }
  const seen = new Set<string>();
  const uniqueMarkers = allMarkers.filter((r) => {
    const k = `${r.kind}:${r.name}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  for (const ref of uniqueMarkers) {
    try {
      if (ref.kind === 'skill') {
        const cached = skillsStore.skills.find((s: any) => s.name === ref.name);
        if (!cached) {
          console.warn(`[Composer] skill not found: ${ref.name}`);
          continue;
        }
        const parsed = await piTauri.readSkillFile(cached.filePath);
        refs.push({ kind: 'skill', name: ref.name, body: parsed.body || parsed.description || '' });
      } else if (ref.kind === 'tool') {
        const cached = userToolsStore.tools.find((t: any) => t.name === ref.name);
        if (!cached) {
          console.warn(`[Composer] tool not found: ${ref.name}`);
          continue;
        }
        const raw = await piTauri.readUserTool({
          scope: cached.scope,
          workspacePath: sessionStore.activeWorkspace?.path ?? null,
          agentDir: null,
          name: ref.name,
        });
        refs.push({ kind: 'tool', name: ref.name, body: raw });
      } else if (ref.kind === 'mcp') {
        const cached = mcpServersStore.servers.find((s: any) => s.name === ref.name);
        if (!cached) {
          console.warn(`[Composer] mcp server not found: ${ref.name}`);
          continue;
        }
        const raw = await piTauri.readMcpServer({
          scope: cached.scope,
          workspacePath: sessionStore.activeWorkspace?.path ?? null,
          agentDir: null,
          name: ref.name,
        });
        refs.push({ kind: 'mcp', name: ref.name, body: raw });
      }
    } catch (e) {
      console.warn(`[Composer] read ${ref.kind} ${ref.name} failed:`, e);
    }
  }

  // D214 v5: 分离 LLM prompt 和 user bubble text
  //   - LLM prompt 必须含 <reference>...</reference> section, 让 model 看到 user 引用了哪些内容
  //   - user bubble text 只能含 user 自己打的内容 (chip 渲染, 不显示 reference block —
  //     那是 LLM 内部协议, 不该展示给用户)
  //   - 这两个走不同路径: llmText → piTauri.sendPrompt (发给 LLM),
  //                       userText → message.content (ChatMessage v-html 渲染成 user 气泡)
  let llmText = text;
  if (refs.length > 0) {
    const refSection = refs
      .map((r) => `<reference type="${r.kind}" name="${r.name}">\n${r.body}\n</reference>`)
      .join('\n\n');
    llmText = `${refSection}\n\n---\n\n${text}`;
    console.log(`[Composer] embedded ${refs.length} reference(s) into LLM prompt: ${refs.map((r) => `${r.kind}:${r.name}`).join(', ')}`);
  }
  // D214 v7: last-mentioned tracking (隐式 ref 续接)
  //   把 chatStore 维护的 recent refs (per session, cap 3) 中, **不在当前 message 显式
  //   提到的**也读 body 注入 `<recent_refs>` section. 走同一套 readSkillFile /
  //   readUserTool / readMcpServer (Rust 端有 cache, 不会重复 IO).
  //   例: user 上一句引用了 huashu-design, 这一句"再分析一下" 没 chip, 但 LLM
  //   仍能拿到 huashu-design 的 body (走 recent_refs section).
  const sid = sessionStore.activeSessionId;
  if (sid) {
    const recentRefs = chatStore.getRecentRefs(sid);
    const explicitKeys = new Set(refs.map((r) => `${r.kind}:${r.name}`));
    const implicitRefs = recentRefs.filter((r) => !explicitKeys.has(`${r.kind}:${r.name}`));
    if (implicitRefs.length > 0) {
      const recentBodies: Array<{ ref: typeof implicitRefs[0]; body: string }> = [];
      for (const r of implicitRefs) {
        try {
          let body = '';
          if (r.kind === 'skill') {
            const cached = skillsStore.skills.find((s: any) => s.name === r.name);
            if (cached) {
              const parsed = await piTauri.readSkillFile(cached.filePath);
              body = parsed.body || parsed.description || '';
            }
          } else if (r.kind === 'tool') {
            const cached = userToolsStore.tools.find((t: any) => t.name === r.name);
            if (cached) {
              body = await piTauri.readUserTool({
                scope: cached.scope,
                workspacePath: sessionStore.activeWorkspace?.path ?? null,
                agentDir: null,
                name: r.name,
              });
            }
          } else if (r.kind === 'mcp') {
            const cached = mcpServersStore.servers.find((s: any) => s.name === r.name);
            if (cached) {
              body = await piTauri.readMcpServer({
                scope: cached.scope,
                workspacePath: sessionStore.activeWorkspace?.path ?? null,
                agentDir: null,
                name: r.name,
              });
            }
          }
          if (body) recentBodies.push({ ref: r, body });
        } catch (e) {
          console.warn(`[Composer] read recent ref ${r.kind}:${r.name} failed:`, e);
        }
      }
      if (recentBodies.length > 0) {
        // recent_refs 走单独的 wrapper, 跟显式 <reference> 区分 (前者是 LLM 隐式 context)
        const recentSection = `<recent_refs>\n<!-- 最近提到的 ref, 不在当前 message 显式 mention. 用途: 处理 "再分析一下" 这类隐式续接, LLM 仍能看到完整 context -->\n${recentBodies
          .map((x) => `<reference type="${x.ref.kind}" name="${x.ref.name}">\n${x.body}\n</reference>`)
          .join('\n\n')}\n</recent_refs>`;
        llmText = `${llmText}\n\n${recentSection}`;
        console.log(`[Composer] embedded ${recentBodies.length} recent ref(s) into LLM prompt: ${recentBodies.map((x) => `${x.ref.kind}:${x.ref.name}`).join(', ')}`);
      }
    }
  }
  inputText.value = '';
  if (richInputRef.value) richInputRef.value.innerHTML = '';
  // userText = text (无 reference section, 但有 [[ref:...]] marker, chat 渲染时转 chip)
  await chatStore.sendPrompt(llmText, { userText: text });
  // 走完后才更新 recent refs (放这里避免 send 失败时污染)
  if (sid) {
    for (const r of refs) {
      chatStore.addRecentRef(sid, { kind: r.kind, name: r.name });
    }
  }
}

/**
 * v0.5.0+: 中断按钮 (send 变 stop). 走 Pi SDK abort RpcCommand
 *   透传到 sidecar → AgentSession.abort() → 停 LLM stream + tool call
 * 期间 (abort → agent_end 之间) userAborted=true, UI 状态保持"停止中"视觉,
 *   agent_end event 来后 store 翻 streaming=false, button 自动恢复成 send.
 *
 * v0.5.0-PR3 兜底 (D_Stop_Hang):
 *   - 30s timeout: Pi SDK 0.84.2 在某些 OpenAI-compatible provider (MiniMax 等) 上
 *     abort 后 emit `agent_end` event 偶尔 lost → 跑马灯一直转. 30s 内没收到
 *     agent_end 就 force 翻 streaming=false + 弹 "已强制终止" 提示.
 *   - catch 兜底: abort RpcCommand 本身失败时也 force 翻 streaming=false.
 *
 * Bug #4 修 (2026-08-18): 加 UI toast 反馈 (之前 silently, 用户视觉"点 stop 没反应").
 *   - abort RpcCommand 成功 + agent_end 在 30s 内到: 静默 (按钮已恢复成 send)
 *   - abort RpcCommand 失败: toast "停止失败: ..."
 *   - 30s 内没收到 agent_end (force 兜底): toast "已强制终止 (LLM 没响应 abort, 30s 兜底)"
 */
const userAborted = ref(false);
let abortWatchStop: (() => void) | null = null;
async function stop() {
  const sid = activeSession.value?.id;
  if (!sid) return;
  userAborted.value = true;
  // 启动 30s fallback timer: 30s 内没收到 agent_end → force 翻 streaming=false
  if (abortWatchStop) abortWatchStop();
  let resolved = false;
  const fallbackTimer = setTimeout(() => {
    if (resolved) return;
    console.warn('[Composer] abort 30s 内没收到 agent_end, force 翻 streaming=false');
    chatStore.forceStopStreaming(sid);
    userAborted.value = false;
    // Bug #4 修: 30s 兜底触发时给用户明确反馈 (之前没有, 以为没生效)
    uiStore.showToast('已强制终止生成 (LLM 30s 内未响应 abort)', 'warning', 5000);
  }, 30_000);
  // watch isStreaming 翻 false → agent_end 到了, 立刻 clear timer
  abortWatchStop = watch(
    () => chatStore.isStreamingSession(sid),
    (s) => {
      if (!s) {
        resolved = true;
        clearTimeout(fallbackTimer);
        if (abortWatchStop) {
          abortWatchStop();
          abortWatchStop = null;
        }
        userAborted.value = false;
      }
    },
    { immediate: false },
  );
  try {
    await piTauri.sendRpcCommand(sid, { type: 'abort' });
  } catch (e) {
    // v0.5.0-D 修: abort RPC 失败时, forceStopStreaming 已经做了 killSidecar 兜底,
    //   UI 状态确实翻回 idle (下方 forceStopStreaming 调). 之前 toast '停止失败: ...'
    //   误导用户以为没停成. 改成 '已停止 (RPC 不可达, 强制终止)' 让用户清楚动作已完成,
    //   不再以为 stop 按钮坏了.
    console.warn('[Composer] abort RpcCommand failed, falling back to forceStopStreaming', e);
    resolved = true;
    clearTimeout(fallbackTimer);
    if (abortWatchStop) {
      abortWatchStop();
      abortWatchStop = null;
    }
    // 兜底: abort 失败也清 streaming, 让 user 继续操作
    chatStore.forceStopStreaming(sid);
    userAborted.value = false;
    uiStore.showToast('已停止 (RPC 不可达，已强制终止 sidecar)', 'warning', 3500);
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

// ===== D214: contentEditable 自动高度 =====
// 行为: 跟原 textarea 一样, 1 行起步, 多行按 scrollHeight 长高, 上限 400px (D214 v8: 200→400).
// 超过 → 内部滚动. contentEditable 的 scrollHeight 计算跟 textarea 一致.
const COMPOSER_MAX_H = 400;
function autoResize() {
  const el = richInputRef.value;
  if (!el) return;
  el.style.height = 'auto';
  const h = Math.min(el.scrollHeight, COMPOSER_MAX_H);
  el.style.height = `${h}px`;
  el.style.overflowY = el.scrollHeight > COMPOSER_MAX_H ? 'auto' : 'hidden';
}

onMounted(() => {
  nextTick(() => {
    renderRichInput();
    autoResize();
  });
});
</script>

<template>
  <div class="pad-composer">
    <!-- D214 Phase 3: contentEditable div 替代 textarea, 支持 inline 灰底 chip 渲染
         - 输入: @ 或 / 触发 popover, 选完插入 [[ref:kind:name]] → render 成 @kind:name chip
         - 删除: 紧贴 chip 前的 Backspace 删整个 chip, 普通文字正常删除
         - 自适应高度: autoResize() 设 maxHeight + overflow-y: auto -->
    <div
      ref="richInputRef"
      class="pad-composer__input pad-composer__input-rich"
      contenteditable="true"
      spellcheck="false"
      :data-placeholder="hasConfig ? '帮你编写代码、调试 Bug、优化性能等开发工作，交付生产级代码产物。' : '先在 Settings → Providers 加个 provider, 然后回这里发消息'"
      @input="onRichInput"
      @keydown="onRichKeydown"
      @compositionstart="isComposing = true"
      @compositionend="onCompositionEnd"
      @click="onRichClick"
      @paste="onRichPaste"
      @drop.prevent="onRichDrop"
      @dragover.prevent
    ></div>

    <!-- D214 Phase 3: 已删 v0.4.7b 底部 "已引用 skills" preview
         灰底 chip 现在 inline 渲染在 contentEditable 文本流里 (跟 Notion @ mention 一样),
         不再需要在底部堆叠. 旧 pad-composer__skill-refs CSS 还在, 保留不影响 (没人引用). -->

    <!-- v0.5.0-D 第12轮: 引用回复 (quote & reply) 预览
         从 assistant message 点"引用"button → 整条消息正文作为 blockquote 显示在 composer 上方.
         点 × 清空, send 时 quote 拼到 user message 前面 (markdown blockquote 格式). -->
    <div v-if="currentQuote" class="pad-composer__quote">
      <Quote :size="11" :stroke-width="1.75" class="pad-composer__quote-icon" />
      <div class="pad-composer__quote-body">
        <div class="pad-composer__quote-label">引用消息</div>
        <div class="pad-composer__quote-text">{{ currentQuotePreview }}</div>
      </div>
      <button
        class="pad-composer__quote-remove"
        :title="'取消引用'"
        type="button"
        @click="clearQuote"
      >
        <X :size="12" :stroke-width="2" />
      </button>
    </div>

    <!-- v0.6+: 文件引用 (file reference) — sidebar 文件树点文件收集的 chip -->
    <div v-if="currentFileRefs.length > 0" class="pad-composer__file-refs">
      <FileText :size="11" :stroke-width="1.75" class="pad-composer__file-refs-icon" />
      <span class="pad-composer__file-refs-label">已引用文件:</span>
      <span
        v-for="ref in currentFileRefs"
        :key="ref.path"
        class="pad-composer__file-ref"
        :title="`完整路径: ${ref.path}\n点击移除引用`"
        @click="removeFileRef(ref.path)"
      >
        <FileText :size="9" :stroke-width="2" class="pad-composer__file-ref-icon" />
        <span class="pad-composer__file-ref-name">{{ ref.name }}</span>
        <X :size="9" :stroke-width="2" class="pad-composer__file-ref-x" />
      </span>
    </div>

    <!-- ADR-0022 v3.5: composer 粘贴/拖拽 上传的 image + file chip 区
         - image: 缩略图 (previewUrl) + 删除按钮, send 时走 Pi SDK images[]
         - file:  文件 icon + filename + 删除按钮, send 时拼到 message text 的 <file> tag
         顺序: images 在前 (vision model 优先看图), files 在后 -->
    <div
      v-if="attachmentsStore.pendingImages.length > 0 || attachmentsStore.pendingFiles.length > 0"
      class="pad-composer__attachments"
    >
      <Paperclip :size="11" :stroke-width="1.75" class="pad-composer__attachments-icon" />
      <span class="pad-composer__attachments-label">附件 ({{ attachmentsStore.pendingImages.length + attachmentsStore.pendingFiles.length }}):</span>
      <!-- image: 缩略图 + 删除 -->
      <span
        v-for="(img, i) in attachmentsStore.pendingImages"
        :key="`img-${i}-${img.savedPath}`"
        class="pad-composer__attachment-image"
        :title="img.savedPath || `${img.mimeType}, ${formatBytes(img.bytes)}`"
      >
        <img
          :src="img.previewUrl"
          class="pad-composer__attachment-thumb"
          alt="upload"
          @click="openAttachmentPreviewImage(img)"
        />
        <span class="pad-composer__attachment-meta">{{ formatBytes(img.bytes) }}</span>
        <button
          class="pad-composer__attachment-x"
          type="button"
          title="移除"
          @click.stop="attachmentsStore.removeImage(i)"
        >
          <X :size="9" :stroke-width="2" />
        </button>
      </span>
      <!-- file: 文件 icon + filename + 删除 (点主体开预览, 删按钮独立 @click.stop) -->
      <span
        v-for="(f, i) in attachmentsStore.pendingFiles"
        :key="`file-${i}-${f.path}`"
        class="pad-composer__attachment-file"
        :title="`${f.path}\n点击预览, ✕ 移除`"
        @click="openAttachmentPreviewFile(f)"
      >
        <FileText :size="9" :stroke-width="2" class="pad-composer__attachment-icon" />
        <span class="pad-composer__attachment-name">{{ f.filename }}</span>
        <span class="pad-composer__attachment-meta">{{ formatBytes(f.bytes) }}</span>
        <button
          class="pad-composer__attachment-x"
          type="button"
          title="移除"
          @click.stop="attachmentsStore.removeFile(i)"
        >
          <X :size="9" :stroke-width="2" />
        </button>
      </span>
    </div>
    <div v-if="attachmentsStore.uploadError" class="pad-composer__upload-error">
      <AlertTriangle :size="11" :stroke-width="1.75" />
      <span>{{ attachmentsStore.uploadError }}</span>
    </div>

    <!-- v0.4.7a: Composer / popover 3 类 (skill / agent / mcp, 不含 builtin 22) -->
    <div v-if="showSlashPopover" ref="slashPopoverRef" class="pad-composer__slash-popover">
      <div v-if="filteredSlashItems.length === 0" class="pad-composer__slash-empty">
        <span>没有匹配的项</span>
      </div>
      <div v-else class="pad-composer__slash-list">
        <!-- D214: 改用 'Skills' | 'Tools' | 'MCP' 三组, 旧 '扩展' group 已删 -->
        <template v-for="group in ['Skills', 'Tools', 'MCP']" :key="group">
          <div v-if="filteredSlashItems.some((it) => it.group === group)" class="pad-composer__slash-group-label">
            {{ group }}
          </div>
          <button
            v-for="it in filteredSlashItems.filter((x) => x.group === group)"
            :key="`${group}-${it.label}`"
            class="pad-composer__slash-item"
            :class="{ 'is-active': filteredSlashItems.indexOf(it) === slashPopoverCursor, 'is-placeholder': it.isPlaceholder }"
            @click="pickSlashItem(it)"
          >
            <!-- D214: Notion/Slack 风格 — 左侧图标 + 右侧 stack (名称粗体, 描述灰) -->
            <span class="pad-composer__slash-item-icon">
              <FileText v-if="it.group === 'Skills'" :size="14" :stroke-width="1.75" />
              <Wrench v-else-if="it.group === 'Tools'" :size="14" :stroke-width="1.75" />
              <Plug v-else-if="it.group === 'MCP'" :size="14" :stroke-width="1.75" />
            </span>
            <span class="pad-composer__slash-item-body">
              <span class="pad-composer__slash-item-name">{{ it.label }}</span>
              <span class="pad-composer__slash-item-desc">{{ it.description }}</span>
            </span>
          </button>
        </template>
      </div>
      <div class="pad-composer__slash-hint">
        <span>↑↓ 选</span>
        <span>↵ 触发</span>
        <span>Esc 关闭</span>
      </div>
    </div>
    <div class="pad-composer__bar">
      <div class="pad-composer__bar-left">
        <!-- ADR-0022 v3.6 (2026-08-23): 合并 Plus + Image + Paperclip 为一个 `+` 按钮
             点 `+` 弹二级 menu (类似 permission menu):
             - 添加文件或图片: 触发 file picker (input type=file, accept image/* + 任意)
             - 技能 / 总结 / 目标 / 计划: 即将推出 (占位)
             - 浏览器操控: toggle 右侧 browser panel (WebView2) -->
        <div class="pad-composer__plus-wrap" ref="plusMenuRef">
          <button
            class="pad-composer__iconbtn"
            :class="{ 'is-open': showPlusMenu }"
            :title="'添加上下文 (文件/图片/技能/...)'"
            @click="togglePlusMenu"
          >
            <Plus :size="16" :stroke-width="1.75" />
          </button>
          <div v-if="showPlusMenu" class="pad-composer__plus-menu" @click.stop>
            <button
              class="pad-composer__plus-menu-item"
              type="button"
              @click="pickFiles"
            >
              <Paperclip :size="14" :stroke-width="1.75" class="pad-composer__plus-menu-icon" />
              <span>添加文件或图片</span>
            </button>
            <button
              class="pad-composer__plus-menu-item is-disabled"
              type="button"
              disabled
              title="即将推出 — 输入 / 触发技能选单"
            >
              <Wrench :size="14" :stroke-width="1.75" class="pad-composer__plus-menu-icon" />
              <span>技能</span>
            </button>
            <button
              class="pad-composer__plus-menu-item is-disabled"
              type="button"
              disabled
              title="即将推出"
            >
              <ListOrdered :size="14" :stroke-width="1.75" class="pad-composer__plus-menu-icon" />
              <span>总结</span>
            </button>
            <button
              class="pad-composer__plus-menu-item is-disabled"
              type="button"
              disabled
              title="即将推出"
            >
              <Star :size="14" :stroke-width="1.75" class="pad-composer__plus-menu-icon" />
              <span>目标</span>
            </button>
            <button
              class="pad-composer__plus-menu-item is-disabled"
              type="button"
              disabled
              title="即将推出"
            >
              <CheckCheck :size="14" :stroke-width="1.75" class="pad-composer__plus-menu-icon" />
              <span>计划</span>
            </button>
            <div class="pad-composer__plus-menu-sep" />
            <button
              class="pad-composer__plus-menu-item is-toggle"
              type="button"
              @click="toggleBrowserPanelFromMenu"
            >
              <Plug :size="14" :stroke-width="1.75" class="pad-composer__plus-menu-icon" />
              <span>浏览器操控</span>
              <span
                class="pad-composer__plus-menu-switch"
                :class="{ 'is-on': uiStore.browserPanelVisible }"
              >
                {{ uiStore.browserPanelVisible ? '已开启' : '已关闭' }}
              </span>
            </button>
          </div>
        </div>
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
              :class="{ 'is-active': opt.value === currentPermissionMode }"
              @click="pickPermission(opt.value)"
            >
              <span class="pad-composer__perm-menu-item-body">
                <span class="pad-composer__perm-menu-item-label">{{ opt.label }}</span>
                <span class="pad-composer__perm-menu-item-hint">{{ opt.hint }}</span>
              </span>
              <Check
                v-if="opt.value === currentPermissionMode"
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
      <!-- ADR-0022 v3.6: 隐藏 file picker (点 `+` menu 触发) -->
      <input
        ref="filePickerRef"
        type="file"
        class="pad-composer__file-picker"
        multiple
        accept="image/*,.pdf,.txt,.md,.ts,.tsx,.js,.jsx,.json,.yaml,.yml,.toml,.rs,.py,.go,.java,.cs,.cpp,.c,.h,.hpp,.sh,.sql,.css,.html,.xml,.csv,.log"
        @change="onFilePickerChange"
      />
      <div class="pad-composer__bar-right">
        <!-- v0.4.3 redesign: ContextIndicator 组件 (compact 83% + click 展开 popover) -->
        <!-- 位置: 切换 model chip 左侧, 跟 model 一体 (UX 原则: 功能逻辑是一体的) -->
        <ContextIndicator />
        <div ref="modelMenuRef" class="pad-composer__model-wrap">
          <button
            class="pad-composer__modelchip"
            :class="{ 'is-warn': !hasConfig, 'is-open': showModelMenu, 'is-locked': isStreaming && hasConfig }"
            :disabled="isStreaming && hasConfig"
            :title="isStreaming
              ? `LLM 还在回复, 等回完才能切换 model (现在改会跟当前 turn 状态机冲突)`
              : hasConfig
                ? `当前: ${providerTypeLabel} / ${activeModel?.id}`
                : '未配置 provider, 点击去设置'"
            @click="toggleModelMenu"
          >
            <Lock v-if="isStreaming && hasConfig" :size="12" :stroke-width="1.75" />
            <AlertTriangle v-else-if="!hasConfig" :size="14" :stroke-width="1.75" />
            <Star v-else :size="12" :stroke-width="1.75" fill="currentColor" />
            <span class="pad-composer__chip-label">
              <span v-if="hasConfig">{{ activeModel?.id }}</span>
              <span v-else>未配置</span>
            </span>
            <ChevronDown v-if="!isStreaming || !hasConfig" :size="14" :stroke-width="1.75" :class="['pad-composer__chip-chev', { 'is-flipped': showModelMenu }]" />
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
                    v-if="p.id === activeProvider?.id"
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
                  :class="{ 'is-active': p.id === activeProvider?.id && activeModel?.id === m.id }"
                  @click="pickModel(p.id, m.id)"
                >
                  <span class="pad-composer__model-menu-item-body">
                    <span class="pad-composer__model-menu-item-id">{{ m.id }}</span>
                    <span v-if="m.label" class="pad-composer__model-menu-item-label">{{ m.label }}</span>
                  </span>
                  <Check
                    v-if="p.id === activeProvider?.id && activeModel?.id === m.id"
                    :size="14"
                    :stroke-width="2"
                    class="pad-composer__model-menu-item-check"
                  />
                </button>
              </div>
            </template>
          </div>
        </div>
        <!-- 2026-08-20 P0-1 补充 A: 队列气泡 (LLM 还在回时用户发的消息排队) -->
        <div v-if="queueLength > 0" ref="queuePanelRef" class="pad-composer__queue-wrap">
          <button
            class="pad-composer__queuechip"
            :class="{ 'is-open': showQueuePanel }"
            :title="`队列中 ${queueLength} 条消息, LLM 回完会自动按顺序发送`"
            @click="toggleQueuePanel"
          >
            <ListOrdered :size="12" :stroke-width="1.75" />
            <span>队列 {{ queueLength }}</span>
          </button>
          <!-- 队列 popover (跟 model 菜单同 pattern, 列出来源 + 可删单条 / 全清) -->
          <div v-if="showQueuePanel" class="pad-composer__queue-panel" @click.stop>
            <div class="pad-composer__queue-panel-head">
              <span>发送队列 ({{ queueLength }})</span>
              <button class="pad-composer__queue-panel-clear" @click="clearQueue">清空全部</button>
            </div>
            <div class="pad-composer__queue-panel-list">
              <div
                v-for="(item, idx) in currentSessionQueue"
                :key="idx"
                class="pad-composer__queue-panel-item"
              >
                <span class="pad-composer__queue-panel-num">{{ idx + 1 }}</span>
                <span class="pad-composer__queue-panel-text">{{ item.length > 80 ? item.slice(0, 80) + '…' : item }}</span>
                <button
                  class="pad-composer__queue-panel-remove"
                  :title="`从队列删除 (剩余 ${queueLength - idx - 1} 条)`"
                  @click="removeQueueItem(idx)"
                >
                  <X :size="12" :stroke-width="1.75" />
                </button>
              </div>
            </div>
            <div class="pad-composer__queue-panel-foot">
              LLM 完成后自动按顺序发送, 也可点 ↑ 删单条
            </div>
          </div>
        </div>
        <button class="pad-composer__iconbtn" title="语音输入">
          <Mic :size="16" :stroke-width="1.75" />
        </button>
        <!-- 2026-08-20 P0-1 补充 A: send 按钮始终是 send, 不再按 streaming 切 stop.
             streaming 时 send → sendPrompt 内部入队 (chat.ts sendQueue).
             stop 拆成独立按钮, v-if="isStreaming", 显式区分 send / stop. -->
        <button
          class="pad-composer__send"
          :disabled="!hasConfig || !inputText.trim()"
          :title="hasConfig ? '发送 (Enter) / 加入发送队列' : '去设置配 provider'"
          @click="send()"
        >
          <ArrowUp :size="16" :stroke-width="2" />
        </button>
        <!-- 独立 stop 按钮: 仅 streaming 时显示, 跟 send 并排. Esc 也触发 stop (keybinding). -->
        <button
          v-if="isStreaming"
          class="pad-composer__send is-stop"
          :class="{ 'is-stopping': userAborted }"
          :disabled="userAborted"
          :title="userAborted ? '正在停止…' : '停止生成 (Esc)'"
          @click="stop()"
        >
          <Square :size="12" :stroke-width="2" fill="currentColor" />
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
    var(--pad-shadow-composer),
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

/* D214 Phase 3: contentEditable rich input
   - 跟 textarea 视觉一致, 但支持 inline chip
   - :empty 伪元素实现 placeholder (contentEditable 不支持 placeholder 属性)
   - D214 v6: min-height 44→28px, 1 行高, 不需要 2 行的空 padding (之前用户反映留白太大)
   - D214 v8.1: min-height 28→36px, 略宽一点, 输入体验更舒服 (28 之前偏挤)
   - D214 v8: max-height 200→400px, 引多个 chip 时换行生长 (之前 200 太矮会卡住)
   - D214 v8: 加 white-space: pre-wrap + overflow-wrap: anywhere, 让 chip 跟文字
     能在 chip 边界自然换行, 不再溢出 composer */
.pad-composer__input-rich {
  /* 跟 textarea 完全一致的尺寸/排版, 让切换零视觉差 */
  min-height: 36px;
  max-height: 400px;
  overflow-y: auto;
  /* chip + 文字 都能换行. pre-wrap 保留所有空白 + 自动换行, overflow-wrap
     anywhere 在长 chip 没法整体换行时强制 break */
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  /* contentEditable 跟普通 div 一样, 需要 user-select: text 允许选中文本 */
  user-select: text;
  -webkit-user-select: text;
  /* 防止浏览器默认的拼写检查下划线干扰 */
  text-rendering: optimizeLegibility;
}
.pad-composer__input-rich:empty::before {
  content: attr(data-placeholder);
  color: var(--pad-fg-tertiary);
  pointer-events: none;
  /* 不让 placeholder 文本被选中 */
  user-select: none;
}

/* D214 v7: chip 样式已提到全局 app/src/assets/styles/chip.css
   这里只保留 file-ref (sidebar 文件引用) chip 样式, 跟 ref chip 是两种东西别混 */

/* ===== ADR-0022 v3.6: `+` 按钮 + 二级 menu ===== */
.pad-composer__plus-wrap {
  position: relative;
}
.pad-composer__iconbtn.is-open {
  background: var(--pad-bg-active);
  color: var(--pad-fg-primary);
}
.pad-composer__plus-menu {
  position: absolute;
  bottom: 36px;
  left: 0;
  min-width: 200px;
  background: var(--pad-popover);
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-lg);
  box-shadow: var(--pad-shadow-popover);
  padding: 4px;
  z-index: 30;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.pad-composer__plus-menu-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  border: none;
  border-radius: var(--pad-radius-md);
  background: transparent;
  text-align: left;
  font-family: inherit;
  font-size: var(--pad-fs-13);
  color: var(--pad-fg-primary);
  cursor: pointer;
  transition: background var(--pad-dur-fast) ease;
}
.pad-composer__plus-menu-item:hover:not(.is-disabled):not(.is-toggle) {
  background: var(--pad-bg-hover);
}
.pad-composer__plus-menu-item.is-disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.pad-composer__plus-menu-item.is-toggle {
  cursor: pointer;
}
.pad-composer__plus-menu-icon {
  color: var(--pad-fg-tertiary);
  flex-shrink: 0;
}
.pad-composer__plus-menu-sep {
  height: 1px;
  background: var(--pad-divider);
  margin: 4px 6px;
}
.pad-composer__plus-menu-switch {
  margin-left: auto;
  font-size: var(--pad-fs-11, 11px);
  font-family: var(--pad-font-mono, monospace);
  color: var(--pad-fg-tertiary);
  padding: 1px 8px;
  border-radius: var(--pad-radius-pill);
  background: var(--pad-muted);
}
.pad-composer__plus-menu-switch.is-on {
  color: var(--pad-accent);
  background: color-mix(in srgb, var(--pad-accent) 14%, transparent);
}
.pad-composer__file-picker {
  display: none; /* 隐藏, 用 ref.click() 触发 */
}

/* ===== ADR-0022 v3.5: 粘贴/拖拽 attachments (image + file) ===== */
.pad-composer__attachments {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--pad-border);
  background: var(--pad-bg-app);
  flex-wrap: wrap;
  max-height: 100px;
  overflow-y: auto;
}
.pad-composer__attachments-icon {
  color: var(--pad-fg-tertiary);
  flex-shrink: 0;
}
.pad-composer__attachments-label {
  font-size: var(--pad-fs-11, 11px);
  color: var(--pad-fg-tertiary);
  flex-shrink: 0;
}
.pad-composer__attachment-image,
.pad-composer__attachment-file {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 32px;
  padding: 0 4px 0 4px;
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-md);
  background: var(--pad-card);
  font-size: var(--pad-fs-12, 12px);
  color: var(--pad-fg-primary);
  max-width: 200px;
  flex-shrink: 0;
  cursor: pointer;
  transition: border-color var(--pad-dur-fast, 0.12s) ease, background var(--pad-dur-fast, 0.12s) ease;
}
.pad-composer__attachment-image:hover,
.pad-composer__attachment-file:hover {
  border-color: var(--pad-accent, #6366f1);
  background: var(--pad-accent-soft, #eef2ff);
}
.pad-composer__attachment-image {
  padding: 2px 4px;
}
.pad-composer__attachment-thumb {
  height: 28px;
  width: auto;
  max-width: 100px;
  object-fit: cover;
  border-radius: var(--pad-radius-sm);
}
.pad-composer__attachment-icon {
  color: var(--pad-fg-tertiary);
  flex-shrink: 0;
}
.pad-composer__attachment-name {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 120px;
  font-family: var(--pad-font-mono, monospace);
}
.pad-composer__attachment-meta {
  font-size: var(--pad-fs-10, 10px);
  color: var(--pad-fg-tertiary);
  flex-shrink: 0;
}
.pad-composer__attachment-x {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  background: transparent;
  border: none;
  border-radius: var(--pad-radius-sm);
  color: var(--pad-fg-tertiary);
  cursor: pointer;
  flex-shrink: 0;
}
.pad-composer__attachment-x:hover {
  background: var(--pad-bg-hover);
  color: var(--pad-fg-primary);
}
.pad-composer__upload-error {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  background: color-mix(in srgb, var(--pad-danger, #dc2626) 12%, transparent);
  color: var(--pad-danger, #dc2626);
  font-size: var(--pad-fs-12, 12px);
}

.pad-composer__file-refs {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
  padding: 4px 10px 2px 10px;
  font-size: 11px;
  color: var(--pad-fg-secondary);
}
.pad-composer__file-refs-icon {
  color: var(--pad-fg-tertiary);
  flex-shrink: 0;
}
.pad-composer__file-refs-label {
  font-size: 10px;
  color: var(--pad-fg-tertiary);
  margin-right: 2px;
}
.pad-composer__file-ref {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 4px 2px 5px;
  background: var(--pad-bg-hover);
  border: 1px solid var(--pad-border-subtle, transparent);
  border-radius: 3px;
  font-size: 10px;
  font-family: var(--pad-ff-mono, monospace);
  color: var(--pad-fg-primary);
  cursor: pointer;
  user-select: none;
  transition: background var(--pad-dur-fast) ease;
}
.pad-composer__file-ref:hover {
  background: var(--pad-bg-active, var(--pad-bg-hover));
  filter: brightness(1.05);
}
.pad-composer__file-ref-icon {
  color: var(--pad-fg-tertiary);
  flex-shrink: 0;
}
.pad-composer__file-ref-name {
  max-width: 140px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pad-composer__file-ref-x {
  color: var(--pad-fg-tertiary);
  flex-shrink: 0;
  margin-left: 1px;
}
.pad-composer__file-ref:hover .pad-composer__file-ref-x {
  color: var(--pad-danger-text, #ff6b6b);
}

/* v0.4.7b: 已选 skill 引用 preview (D184 v9 ❹ user 14:30: "灰底skill的引用") */
.pad-composer__skill-refs {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  padding: 6px 8px;
  margin-top: 4px;
  background: var(--pad-bg-muted, rgba(0,0,0,0.02));
  border: 1px solid var(--pad-border-subtle, rgba(0,0,0,0.06));
  border-radius: var(--pad-radius-sm, 4px);
  font-size: 11px;
  color: var(--pad-fg-tertiary);
}
.pad-composer__skill-refs-label { font-size: 10px; }

/* v0.5.0-D 第12轮: 引用回复 (quote & reply) 预览 — composer 上方的引用块
   跟 markdown blockquote 视觉一致: 左边 border + 灰底, 跟消息历史引用呼应 */
.pad-composer__quote {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 0 0 6px 0;
  padding: 6px 8px 6px 10px;
  background: var(--pad-bg-active);
  border-left: 3px solid var(--pad-accent);
  border-radius: 0 var(--pad-radius-sm) var(--pad-radius-sm) 0;
  font-size: 11px;
  color: var(--pad-fg-secondary);
  max-height: 80px;
  overflow: hidden;
  position: relative;
}
.pad-composer__quote-icon {
  color: var(--pad-accent);
  flex-shrink: 0;
  margin-top: 1px;
  opacity: 0.7;
}
.pad-composer__quote-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.pad-composer__quote-label {
  font-size: 10px;
  color: var(--pad-fg-tertiary);
  font-weight: var(--pad-fw-medium);
  letter-spacing: 0.02em;
}
.pad-composer__quote-text {
  font-size: 12px;
  line-height: 1.45;
  color: var(--pad-fg-secondary);
  word-wrap: break-word;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
}
.pad-composer__quote-remove {
  flex-shrink: 0;
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
  margin-top: 2px;
  transition: background var(--pad-dur-fast) ease, color var(--pad-dur-fast) ease;
}
.pad-composer__quote-remove:hover {
  background: var(--pad-bg-hover);
  color: var(--pad-fg-primary);
}
.pad-composer__skill-ref-chip {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 1px 4px 1px 6px;
  background: var(--pad-bg-muted, rgba(99,102,241,0.08));
  border: 1px solid rgba(99,102,241,0.2);
  border-radius: 10px;
  font-size: 10px;
  font-family: var(--pad-font-mono);
  color: var(--pad-accent, #6366f1);
}
.pad-composer__skill-ref-chip code {
  font-family: var(--pad-font-mono);
  font-size: 10px;
  color: var(--pad-accent, #6366f1);
}
.pad-composer__skill-ref-remove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  padding: 0;
  font-size: 12px;
  background: transparent;
  border: none;
  border-radius: 50%;
  color: var(--pad-fg-tertiary);
  cursor: pointer;
  line-height: 1;
}
.pad-composer__skill-ref-remove:hover {
  background: var(--pad-bg-hover, rgba(0,0,0,0.08));
  color: var(--pad-fg-danger, #dc2626);
}

/* v0.4.7a: Composer / popover (skill / agent / mcp, 不含 builtin 22)
   D214: 改 absolute 定位, 从输入框上方弹出, 跟 permission menu 一样浮在上面
   D214 v6: max-height 280→200px, padding 4→2px, 整体更紧凑 (用户反映留白太大) */
.pad-composer__slash-popover {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 0;
  right: 0;
  max-height: 200px;
  overflow-y: auto;
  background: var(--pad-card, #fff);
  border: 1px solid var(--pad-border, rgba(0,0,0,0.1));
  border-radius: var(--pad-radius-md, 8px);
  box-shadow: var(--pad-shadow-popover);
  padding: 2px;
}
.pad-composer__slash-empty {
  padding: 12px;
  text-align: center;
  font-size: var(--pad-fs-12);
  color: var(--pad-fg-tertiary);
}
.pad-composer__slash-list { display: flex; flex-direction: column; gap: 1px; }
.pad-composer__slash-group-label {
  padding: 4px 10px 1px;
  font-size: 10px;
  font-weight: var(--pad-fw-medium);
  color: var(--pad-fg-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.pad-composer__slash-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  width: 100%;
  padding: 5px 10px;
  font-size: var(--pad-fs-12);
  color: var(--pad-fg-secondary);
  background: transparent;
  border: none;
  border-radius: var(--pad-radius-sm, 5px);
  cursor: pointer;
  text-align: left;
  transition: background var(--pad-dur-fast) ease;
}
.pad-composer__slash-item:hover,
.pad-composer__slash-item.is-active {
  background: var(--pad-bg-hover, rgba(0,0,0,0.06));
}
.pad-composer__slash-item.is-placeholder { opacity: 0.5; cursor: not-allowed; }
.pad-composer__slash-item.is-placeholder:hover { background: transparent; }

/* D214: Notion/Slack 风格 — 左侧图标 + 右侧 vertical stack
   D214 v6: icon 28→22px, 让 item 整体高度更紧凑 (单 item 35px → ~28px) */
.pad-composer__slash-item-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  flex-shrink: 0;
  border-radius: 5px;
  background: var(--pad-bg-secondary, rgba(0,0,0,0.04));
  color: var(--pad-fg-tertiary);
  margin-top: 1px;
}
.pad-composer__slash-item-body {
  display: flex;
  flex-direction: column;
  gap: 0;
  min-width: 0;
  flex: 1;
}
.pad-composer__slash-item-name {
  font-size: 12px;
  font-weight: var(--pad-fw-medium, 500);
  color: var(--pad-fg-primary);
  line-height: 1.3;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pad-composer__slash-item-desc {
  font-size: 10px;
  color: var(--pad-fg-tertiary);
  line-height: 1.3;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* D214: 旧 slug 样式保留但无视觉影响 (兼容老 build) */
.pad-composer__slash-slug {
  font-family: var(--pad-font-mono);
  font-size: 12px;
  color: var(--pad-accent, #6366f1);
  font-weight: var(--pad-fw-medium);
  flex-shrink: 0;
  min-width: 140px;
}
.pad-composer__slash-desc {
  flex: 1;
  font-size: 11px;
  color: var(--pad-fg-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pad-composer__slash-hint {
  display: flex;
  gap: 12px;
  padding: 4px 10px;
  border-top: 1px solid var(--pad-border-subtle, rgba(0,0,0,0.06));
  font-size: 10px;
  color: var(--pad-fg-tertiary);
  font-family: var(--pad-font-mono);
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
  box-shadow: var(--pad-shadow-popover-lg);
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
/* v0.4.3 redesign: ContextIndicator 已拆到独立组件 (ContextIndicator.vue), 它的样式在那边 scoped */
/* 旧 v0.4.3 text 计数 + 独立压缩按钮 CSS 删除 (D173 UX 原则: 功能逻辑一体, 拆到独立组件) */
/* v0.5.0-D 第2轮 workspace path chip 删除: 用户反馈 "这路径放这里有什么意义" — 占位感,
   workspace 路径在 WorkspaceTree 树视图 + ChatHeader 标题已经能看清, Composer 重复显示
   反而打断输入流. 沙箱限制 (createPermissionExtension 路径校验) 仍生效, 写错位置会被
   sidecar block 并 return reason, 不会写到 workspace 之外. */

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
  box-shadow: var(--pad-shadow-popover-lg);
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

/* 2026-08-20 P0-1 补充 A: 队列气泡 + 面板样式
 * 视觉跟 model chip 同语言 (圆角 + border + hover 灰底), 颜色用 primary 强调"等待发送"
 * popover 跟 model menu 同 z-index + 弹出位置
 */
.pad-composer__modelchip.is-locked {
  /* 跟 is-warn 区分: is-warn 是黄色 (没配 provider), is-locked 是灰色 (streaming 锁) */
  color: var(--pad-fg-tertiary);
  background: var(--pad-bg-active);
  cursor: not-allowed;
  opacity: 0.7;
}
.pad-composer__modelchip.is-locked:hover {
  background: var(--pad-bg-active);
  color: var(--pad-fg-tertiary);
}
.pad-composer__queue-wrap {
  position: relative;
  display: inline-flex;
  align-items: center;
}
.pad-composer__queuechip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 10px;
  border-radius: var(--pad-radius-md);
  background: var(--pad-bg-active);
  border: 1px solid var(--pad-border);
  color: var(--pad-primary);
  font-size: var(--pad-fs-12);
  font-weight: var(--pad-fw-medium);
  cursor: pointer;
  transition:
    background var(--pad-dur-fast) ease,
    border-color var(--pad-dur-fast) ease;
  font-family: inherit;
}
.pad-composer__queuechip:hover {
  background: var(--pad-bg-hover);
  border-color: var(--pad-border-strong);
}
.pad-composer__queuechip.is-open {
  background: var(--pad-bg-hover);
  border-color: var(--pad-border-strong);
}
.pad-composer__queue-panel {
  position: absolute;
  bottom: calc(100% + 6px);
  right: 0;
  z-index: 100;
  min-width: 280px;
  max-width: 360px;
  max-height: 320px;
  display: flex;
  flex-direction: column;
  background: var(--pad-popover);
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-lg);
  box-shadow: var(--pad-shadow-modal-large);
  overflow: hidden;
}
.pad-composer__queue-panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid var(--pad-divider);
  font-size: var(--pad-fs-12);
  font-weight: var(--pad-fw-medium);
  color: var(--pad-fg-primary);
  background: var(--pad-bg-active);
}
.pad-composer__queue-panel-clear {
  font-size: var(--pad-fs-11);
  color: var(--pad-fg-tertiary);
  background: transparent;
  border: none;
  padding: 2px 6px;
  border-radius: var(--pad-radius-sm);
  cursor: pointer;
  font-family: inherit;
}
.pad-composer__queue-panel-clear:hover {
  color: var(--pad-danger, var(--pad-fg-secondary));
  background: var(--pad-bg-hover);
}
.pad-composer__queue-panel-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.pad-composer__queue-panel-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  font-size: var(--pad-fs-12);
  color: var(--pad-fg-secondary);
  border-bottom: 1px solid transparent;
}
.pad-composer__queue-panel-item:hover {
  background: var(--pad-bg-hover);
}
.pad-composer__queue-panel-num {
  flex-shrink: 0;
  min-width: 18px;
  text-align: center;
  font-family: var(--pad-font-mono);
  font-size: var(--pad-fs-11);
  color: var(--pad-fg-tertiary);
  background: var(--pad-muted);
  border-radius: var(--pad-radius-sm);
  padding: 1px 4px;
}
.pad-composer__queue-panel-text {
  flex: 1;
  word-break: break-all;
  color: var(--pad-fg-primary);
  font-family: var(--pad-font-mono);
  font-size: var(--pad-fs-12);
  line-height: 1.4;
}
.pad-composer__queue-panel-remove {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: none;
  background: transparent;
  color: var(--pad-fg-tertiary);
  border-radius: var(--pad-radius-sm);
  cursor: pointer;
  transition: background var(--pad-dur-fast) ease, color var(--pad-dur-fast) ease;
}
.pad-composer__queue-panel-remove:hover {
  background: var(--pad-bg-active);
  color: var(--pad-danger, var(--pad-fg-primary));
}
.pad-composer__queue-panel-foot {
  padding: 6px 12px;
  font-size: var(--pad-fs-11);
  color: var(--pad-fg-tertiary);
  border-top: 1px solid var(--pad-divider);
  background: var(--pad-bg-input);
  text-align: center;
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
