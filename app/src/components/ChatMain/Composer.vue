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
import { Plus, Image, Paperclip, ChevronDown, Mic, ArrowUp, Square, AlertTriangle, Star, Check, Hand, Sparkles, CheckCheck, Quote, X, Lock, ListOrdered } from 'lucide-vue-next';
import { useChatStore } from '@/stores/chat';
import { useSessionStore } from '@/stores/session';
import { useConfigStore, PROVIDER_OPTIONS, PERMISSION_MODE_OPTIONS, type PermissionMode } from '@/stores/config';
import { useUiStore } from '@/stores/ui';
import { useSkillsStore } from '@/stores/skills';
import { piTauri } from '@/lib/tauri';
import ContextIndicator from './ContextIndicator.vue';

const chatStore = useChatStore();
const sessionStore = useSessionStore();
const configStore = useConfigStore();
const uiStore = useUiStore();
const skillsStore = useSkillsStore();
const { activeSession } = storeToRefs(sessionStore);
const { skills } = storeToRefs(skillsStore);

const inputText = ref('');
const showModelMenu = ref(false);
// v0.5.0-v0.1: 删 multi-agent persona, Composer / popover 改 2 类 (Skills / 扩展, 不含 Agents)
//  之前 v0.4.7a 是 3 类 (Skills / Agents / 扩展), 现在 Agents 段删除
//  user 16:24 拍板: agent 是边界定义/思维指导, 不需要切换, single agent 链路拉动
const showSlashPopover = ref(false);
const slashPopoverQuery = ref('');
const slashPopoverCursor = ref(0);  // 当前选中项
interface SlashItem {
  group: 'Skills' | '扩展';
  slug: string;       // /skill:code-review /mcp:...
  label: string;
  description: string;
  isPlaceholder?: boolean;
}
const slashItems = computed<SlashItem[]>(() => {
  const out: SlashItem[] = [];
  // 1. Skills
  for (const s of skills.value) {
    out.push({
      group: 'Skills',
      slug: `/skill:${s.name}`,
      label: s.name,
      description: s.description || '(无描述)',
    });
  }
  // 2. MCP (P1 留空)
  out.push({
    group: '扩展',
    slug: '/mcp:',
    label: '(暂无可用)',
    description: 'MCP 扩展 P1 实现, 后续 v0.5+ 接入 (ADR-0023)',
    isPlaceholder: true,
  });
  return out;
});
const filteredSlashItems = computed<SlashItem[]>(() => {
  const q = slashPopoverQuery.value.toLowerCase();
  if (!q) return slashItems.value;
  return slashItems.value.filter(
    (it) => it.label.toLowerCase().includes(q) || it.description.toLowerCase().includes(q),
  );
});

// v0.4.7b: 从 inputText 解析已引用的 skill names (一次性 @ 引用, D184 v9 ❹)
const selectedSkillRefs = computed<string[]>(() => {
  const re = /\[\[skill:([A-Za-z0-9._-]+)\]\]/g;
  const names = new Set<string>();
  let m;
  while ((m = re.exec(inputText.value)) !== null) {
    names.add(m[1]);
  }
  return Array.from(names);
});

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

function removeSkillRef(name: string) {
  // 从 inputText 删所有 [[skill:<name>]] marker
  const re = new RegExp(`\\[\\[skill:${name}\\]\\]`, 'g');
  inputText.value = inputText.value.replace(re, '').replace(/ +/g, ' ').trim();
}
// v0.4.1+ tool permission 菜单
const showPermissionMenu = ref(false);

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
  return sendQueueBySession.value[sid] ?? [];
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

function isSlashTriggerActive(): boolean {
  // 光标前有 "/" 单独一个, 后无字符 / 单词
  const text = inputText.value;
  const cursor = textareaRef.value?.selectionStart ?? text.length;
  // 找光标前最近的换行
  const before = text.slice(0, cursor);
  const after = text.slice(cursor);
  // 光标前最后一个 token 必须是 "/" (或 "/xxx")
  const lastNl = before.lastIndexOf('\n');
  const lineStart = lastNl + 1;
  const lineBefore = before.slice(lineStart);
  // 不能前面已经有非空白 (slash 命令必须在行首, 类似 markdown)
  if (lineBefore.trim() !== lineBefore) return false;
  // 必须以 / 开头
  if (!lineBefore.startsWith('/')) return false;
  // 后面不能有 / (避免双 //)
  if (after.startsWith('/')) return false;
  return true;
}

function getSlashQuery(): string {
  const text = inputText.value;
  const cursor = textareaRef.value?.selectionStart ?? text.length;
  const before = text.slice(0, cursor);
  const lastNl = before.lastIndexOf('\n');
  const lineStart = lastNl + 1;
  const lineBefore = before.slice(lineStart);
  // 去掉 / 前缀
  return lineBefore.slice(1);
}

function openSlashPopover() {
  showSlashPopover.value = true;
  slashPopoverQuery.value = getSlashQuery();
  slashPopoverCursor.value = 0;
}

function closeSlashPopover() {
  showSlashPopover.value = false;
  slashPopoverQuery.value = '';
  slashPopoverCursor.value = 0;
}

async function pickSlashItem(item: SlashItem) {
  if (item.isPlaceholder) {
    console.log('[Composer / popover] mcp placeholder, no-op');
    return;
  }
  // 把光标前 /xxx 替换成对应 marker 或触发动作
  const text = inputText.value;
  const cursor = textareaRef.value?.selectionStart ?? text.length;
  const before = text.slice(0, cursor);
  const after = text.slice(cursor);
  const lastNl = before.lastIndexOf('\n');
  const lineStart = lastNl + 1;
  closeSlashPopover();
  // 触发对应 action
  if (item.group === 'Skills') {
    // v0.4.7b: 一次性 @ 引用嵌入 user prompt (D184 v9 ❹ user 14:30 原话)
    //   跟 v0.4.4 skills 切 enabled (持续注入 system prompt) 完全不同
    //   marker `[[skill:code-review]]` 插入到文本框, send 时解析替换成 skill body 拼到 user prompt 前面
    const marker = `[[skill:${item.label}]]`;
    const newBefore = before.slice(0, lineStart) + marker + before.slice(cursor);
    inputText.value = newBefore + after;
    nextTick(() => {
      if (textareaRef.value) {
        const newCursor = newBefore.length;
        textareaRef.value.setSelectionRange(newCursor, newCursor);
        textareaRef.value.focus();
        autoResize();
      }
    });
    console.log(`[Composer / popover] skill reference inserted: ${item.label} (一次性 @ 引用)`);
  }
}

function onTextareaInput() {
  autoResize();
  if (isSlashTriggerActive()) {
    openSlashPopover();
  } else {
    closeSlashPopover();
  }
}

function onTextareaKeydown(e: KeyboardEvent) {
  if (!showSlashPopover.value) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    closeSlashPopover();
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    slashPopoverCursor.value = Math.min(slashPopoverCursor.value + 1, filteredSlashItems.value.length - 1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    slashPopoverCursor.value = Math.max(slashPopoverCursor.value - 1, 0);
  } else if (e.key === 'Enter') {
    if (filteredSlashItems.value.length > 0 && slashPopoverCursor.value >= 0) {
      e.preventDefault();
      const item = filteredSlashItems.value[slashPopoverCursor.value];
      if (item) pickSlashItem(item);
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
  // v0.4.7b: 解析 [[skill:xxx]] marker, 替换成 skill body 拼到 user prompt 前面 (D184 v9 ❹)
  //   一次性 @ 引用, 不写 system prompt (跟 v0.4.4 skills 切 enabled 完全不同)
  const skillRefs: Array<{ name: string; body: string }> = [];
  const markerRe = /\[\[skill:([A-Za-z0-9._-]+)\]\]/g;
  let m;
  while ((m = markerRe.exec(rawText)) !== null) {
    const skillName = m[1];
    // 实际拿 skill body: 走 skills store 缓存 (listSkills emit) + 找 name
    const cached = skillsStore.skills.find((s: any) => s.name === skillName);
    if (cached) {
      skillRefs.push({ name: skillName, body: cached.description || '' });
    } else {
      console.warn(`[Composer] skill reference not found: ${skillName}`);
    }
  }
  // 拼 skill references 到 user prompt 前面
  let finalPrompt = text;
  if (skillRefs.length > 0) {
    const skillSection = skillRefs
      .map((s) => `<skill_reference name="${s.name}">\n${s.body}\n</skill_reference>`)
      .join('\n\n');
    finalPrompt = `${skillSection}\n\n---\n\n${text}`;
    console.log(`[Composer] embedded ${skillRefs.length} skill reference(s) into user prompt`);
  }
  inputText.value = '';
  // v0.3.5+: sendPrompt 自动确保 session 存在 (无 workspace 会弹 folder picker)
  await chatStore.sendPrompt(finalPrompt);
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
      @input="onTextareaInput"
      @keydown="onTextareaKeydown"
      @keydown.enter.exact.prevent="showSlashPopover ? pickSlashItem(filteredSlashItems[slashPopoverCursor] || filteredSlashItems[0]) : send()"
    />

    <!-- v0.4.7b: 已选 skill 引用 preview (一次性 @ 引用嵌入 user prompt, D184 v9 ❹) -->
    <div v-if="selectedSkillRefs.length > 0" class="pad-composer__skill-refs">
      <Paperclip :size="11" :stroke-width="1.75" />
      <span class="pad-composer__skill-refs-label">已引用 skills:</span>
      <span
        v-for="name in selectedSkillRefs"
        :key="name"
        class="pad-composer__skill-ref-chip"
      >
        <code>[[skill:{{ name }}]]</code>
        <button class="pad-composer__skill-ref-remove" :title="`移除 ${name}`" @click="removeSkillRef(name)">×</button>
      </span>
    </div>

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

    <!-- v0.4.7a: Composer / popover 3 类 (skill / agent / mcp, 不含 builtin 22) -->
    <div v-if="showSlashPopover" ref="slashPopoverRef" class="pad-composer__slash-popover">
      <div v-if="filteredSlashItems.length === 0" class="pad-composer__slash-empty">
        <span>没有匹配的项</span>
      </div>
      <div v-else class="pad-composer__slash-list">
        <template v-for="group in ['Skills', '扩展']" :key="group">
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
            <span class="pad-composer__slash-slug">{{ it.slug }}</span>
            <span class="pad-composer__slash-desc">{{ it.description }}</span>
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
              :class="{ 'is-active': opt.value === currentPermissionMode }"
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
/* v0.6+: 文件引用 (file reference) chip — 跟 skill ref 类似的 chip 风格, 蓝色 (FileText icon) */
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

/* v0.4.7a: Composer / popover (skill / agent / mcp, 不含 builtin 22) */
.pad-composer__slash-popover {
  position: relative;
  margin-top: var(--pad-sp-2);
  background: var(--pad-card, #fff);
  border: 1px solid var(--pad-border, rgba(0,0,0,0.1));
  border-radius: var(--pad-radius-md, 8px);
  box-shadow: var(--pad-shadow-popover);
  padding: 4px;
  max-height: 280px;
  overflow-y: auto;
}
.pad-composer__slash-empty {
  padding: 16px;
  text-align: center;
  font-size: var(--pad-fs-12);
  color: var(--pad-fg-tertiary);
}
.pad-composer__slash-list { display: flex; flex-direction: column; gap: 2px; }
.pad-composer__slash-group-label {
  padding: 6px 10px 2px;
  font-size: 10px;
  font-weight: var(--pad-fw-medium);
  color: var(--pad-fg-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.pad-composer__slash-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  font-size: var(--pad-fs-12);
  color: var(--pad-fg-secondary);
  background: transparent;
  border: none;
  border-radius: var(--pad-radius-sm, 4px);
  cursor: pointer;
  text-align: left;
  transition: background var(--pad-dur-fast) ease, color var(--pad-dur-fast) ease;
}
.pad-composer__slash-item:hover,
.pad-composer__slash-item.is-active {
  background: var(--pad-bg-hover, rgba(0,0,0,0.06));
  color: var(--pad-fg-primary);
}
.pad-composer__slash-item.is-placeholder { opacity: 0.5; cursor: not-allowed; }
.pad-composer__slash-item.is-placeholder:hover { background: transparent; }
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
  padding: 6px 10px;
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
