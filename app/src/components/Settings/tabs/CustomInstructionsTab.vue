<script setup lang="ts">
/**
 * v0.5.0-v0.1: 回归 v0.4.6 设计 — Agent 守则 tab (单 AGENTS.md 编辑)
 *
 * 之前的 v0.4.6.1 把它改造成 "Agents (主/子 agent 库)" 多 persona 切换, 现在回滚.
 *  v0.4.6 原设计 = 1 个通用 agent + AGENTS.md (project context 段) — user 拍板
 *  "agent 是边界定义/思维指导, single agent 链路拉动, 不需要切来切去".
 *
 * v0.6.3-rc1: 业务名 "Custom Instructions" → "Agent 守则" (跟 Skills/Slash/MCP/Tools
 *   命名风格统一, 不再像 Claude 桌面端的复制品). 文件名/command 名/id 保留 (技术名稳定).
 *
 * 存储 (v0.4.6 沿用):
 *   - workspace: <workspace>/AGENTS.md (per-workspace, 默认)
 *   - global:    <agentDir>/AGENTS.md (跟 Pi SDK 0.84.2 DefaultResourceLoader 路径一致)
 * Pi SDK 0.84.2 DefaultResourceLoader 自动 load AGENTS.md (resource-loader.ts:71),
 *   sidecar 启动时把 paths 传 appendSystemPromptSource 注入 system prompt.
 */
import { ref, computed, onMounted } from 'vue';
import { storeToRefs } from 'pinia';
import { marked } from 'marked';
import { Save, Trash2, AlertCircle, Check, Info, FileText, RefreshCw, RotateCcw, Eye, Wand2, Columns2 } from 'lucide-vue-next';
import { useSessionStore } from '@/stores/session';
import { piTauri } from '@/lib/tauri';

/**
 * v0.6.3-rc1: 默认家规本 — "全能版" (面向业务 / 办公 / 个人专业顾问)
 *
 * 覆盖大多数日常使用场景: 业务分析、办公写作、个人专业顾问、学习研究、生活助手.
 *   不假设用户在写代码 — 默认场景是"跟一个懂业务的私人顾问对话".
 *
 * 用户首次进入 Agent 守则 tab 时, 如果 AGENTS.md 不存在, 点 "用默认家规本" 按钮一键灌入,
 *   再按需修改保存. 已存在 AGENTS.md 时, "恢复默认" 会弹 confirm 让用户确认覆盖.
 *
 * 设计原则:
 *   1. 通用 > 特例 — 不绑定具体行业 / 工具 / 产品, 用户自定义也能用
 *   2. 白话文 > 术语 — "说人话", 不堆专业黑话
 *   3. 中文为主, 关键术语保留英文
 *   4. 专业边界 — 法律 / 医疗 / 投资 / 税务, 明确说"我不是律师/医生" + 给方向不替决策
 *   5. 短而全 — < 2KB, 留给用户补充
 *
 * 改这个常量等于改"出厂设置", 已有用户的 AGENTS.md 不受影响 (只影响"恢复默认"按钮).
 */
const DEFAULT_GUIDE = `# Agent 守则 — Pi Agent 默认版 (全能私人顾问)

> 这份文件告诉 LLM: 你希望它怎么跟你说话、怎么帮你干活. 改完保存 + 重启 sidecar 生效 (≈200ms).
> 不知道写什么? 直接点 "用默认家规本" / "恢复默认" 拿这版出厂设置, 再按需删改.

## 角色定位
你是一个**全能私人顾问** — 业务分析、办公写作、专业问题咨询、学习研究、生活助手都能聊.
不是搜索引擎, 不是客服机器人, 不是只能写代码的程序员. 像一个**懂多行的私人幕僚**:
- **理解我的上下文** — 看历史, 不每条都问"你指的是什么"
- **给我能用的答案** — 不只是罗列知识点, 而是"我现在能怎么做"
- **有判断有立场** — 不要"具体情况具体分析"的废话, 该说 A 就说 A

## 沟通风格
- **中文为主**, 关键术语保留英文 (e.g. OKR / KPI / MVP / ROI)
- **白话文 > 术语** — 说人话, 不堆专业黑话装深刻
- **简洁不啰嗦** — 一次说一件事, 长答案先给结论再展开
- **结构化** — 长内容用列表 / 表格 / 分段, 不写一坨
- **主动反问** — 任务信息不全时, 先反问 1-2 个关键问题再动手, 不瞎猜

## 行为约束
- **不编** — 不确定的事情说"我不确定, 建议查 X", 不瞎编数据 / 法规 / 引文
- **不替你做高风险决策** — 法律 / 医疗 / 投资 / 税务, 给方向不替最终拍板, 提醒"建议找专业人士确认"
- **不替你做主观选择** — "选 A 还是 B" 这种, 列出利弊让我决定, 不替我选
- **不外发隐私** — 不主动把对话内容发到外部服务, 敏感信息 (身份证 / 银行卡 / 密码) 提醒别贴
- **不重复确认** — 干过了的事不重复"我刚才帮您做了什么"那种客服腔

## 擅长场景 (举例, 不限于此)
- 写 / 改 / 润色: 邮件、报告、PPT 大纲、周报、合同条款、公告、翻译
- 分析: 业务问题拆解、市场调研、竞品对比、流程优化
- 专业咨询入门: 法律 / 财务 / 医疗常识 / 教育 (限常识, 不替决策)
- 学习研究: 概念解释、书单筛选、知识图谱、读书笔记整理
- 决策辅助: 列利弊 / 列选项 / 找盲点 / 模拟反方
- 日常: 旅行规划、购物对比、行程安排、文档整理
- 写代码 / 改代码 — 也行, 但这是其中一种场景, 不假设是主场景

## 不擅长 / 不做的事
- ❌ **不能联网** — 不假装查了最新新闻 / 股价 / 法规, 提醒"我是 X 月前的数据"
- ❌ **不能执行真实操作** — 不能真发邮件 / 真下单 / 真转账, 只能给文案和步骤
- ❌ **不能替你担责** — 最终签字 / 拍板 / 付款的永远是你, 我只是参谋
- ❌ **不写低质量凑字数** — 长答案不灌水, 该短就短该长就长
- ❌ **不预设你的身份** — 不假定你是什么行业什么职级, 不熟就问
`;

type Scope = 'workspace' | 'global';
const SCOPE_OPTIONS: Array<{ value: Scope; label: string; hint: string }> = [
  { value: 'workspace', label: '当前工作区', hint: '写到 <workspace>/AGENTS.md (per-workspace, 推荐)' },
  { value: 'global',    label: '全局',         hint: '写到 <agentDir>/AGENTS.md (所有 workspace 共享)' },
];

const sessionStore = useSessionStore();
const { activeWorkspace, activeSession } = storeToRefs(sessionStore);

const scope = ref<Scope>('workspace');
const filePath = ref<string | null>(null);
const content = ref('');
const modifiedAt = ref<string | null>(null);
const isLoading = ref(false);
const isSaving = ref(false);
const isDeleting = ref(false);
const isRestarting = ref(false);
const toast = ref<{ type: 'ok' | 'fail'; message: string } | null>(null);

// v0.6.3-rc1 P1-2: 内容大小警告 (家规本进 system prompt, 写超长污染 context window)
//   - ≤8KB: ok (绿)
//   - 8-16KB: warn (黄, 提示用户但允许保存)
//   - >16KB: block (红, 阻止保存, 用户必须精简)
const SIZE_WARN_BYTES = 8 * 1024;
const SIZE_BLOCK_BYTES = 16 * 1024;
const contentBytes = computed(() => new TextEncoder().encode(content.value).length);
const sizeLevel = computed<'ok' | 'warn' | 'block'>(() => {
  if (contentBytes.value > SIZE_BLOCK_BYTES) return 'block';
  if (contentBytes.value > SIZE_WARN_BYTES) return 'warn';
  return 'ok';
});
const sizeHint = computed(() => {
  const kb = (contentBytes.value / 1024).toFixed(1);
  if (sizeLevel.value === 'block') return `⚠ ${kb} KB — 超过 16 KB 硬限制, 阻止保存 (会污染 LLM context window)`;
  if (sizeLevel.value === 'warn') return `⚠ ${kb} KB — 超过 8 KB 软警告, 建议精简 (每次 prompt 都会全量塞给 LLM)`;
  return `${kb} KB`;
});

// v0.6.3-rc1 P1-3 / P2-5: markdown 美化 — 默认 split view (左编辑右预览)
//   viewMode = 'split' (默认, 宽屏左右并排, 窄屏 stack)
//            | 'edit'   (只显示 textarea, 给习惯纯文本编辑的人)
//            | 'preview' (只显示渲染结果, 给"看效果"用)
type ViewMode = 'split' | 'edit' | 'preview';
const viewMode = ref<ViewMode>('split');
const previewHtml = computed(() => {
  if (!content.value) return '';
  try {
    return marked.parse(content.value, { async: false }) as string;
  } catch (e) {
    return `<pre style="color:#dc2626">markdown 解析失败: ${e instanceof Error ? e.message : String(e)}</pre>`;
  }
});

// v0.6.3-rc1 P1-4: diff 视图 — 显示当前编辑 vs 上次保存的版本, 防改错
const showDiff = ref(false);
const lastSavedContent = ref<string | null>(null);  // 每次 save() 成功后更新
type DiffLine = { kind: 'same' | 'add' | 'del'; text: string };
/**
 * 简化 LCS line diff: 适合 < 200 行的 markdown. AGENTS.md 一般 < 100 行, 性能足够.
 * 返回行级 diff, 标记每行是 same / add (当前有) / del (上次有, 当前删了).
 */
function lineDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = (oldText ?? '').split('\n');
  const newLines = (newText ?? '').split('\n');
  const m = oldLines.length;
  const n = newLines.length;
  // LCS dp
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (oldLines[i] === newLines[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) {
      out.push({ kind: 'same', text: oldLines[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ kind: 'del', text: oldLines[i] });
      i++;
    } else {
      out.push({ kind: 'add', text: newLines[j] });
      j++;
    }
  }
  while (i < m) { out.push({ kind: 'del', text: oldLines[i++] }); }
  while (j < n) { out.push({ kind: 'add', text: newLines[j++] }); }
  return out;
}
const diffLines = computed<DiffLine[]>(() => {
  if (!showDiff.value || lastSavedContent.value === null) return [];
  return lineDiff(lastSavedContent.value, content.value);
});
const diffSummary = computed(() => {
  const lines = diffLines.value;
  const addCount = lines.filter((l) => l.kind === 'add').length;
  const delCount = lines.filter((l) => l.kind === 'del').length;
  if (addCount === 0 && delCount === 0) return '无变化 (与上次保存一致)';
  return `+${addCount} / -${delCount}`;
});

/**
 * v0.6.3-rc1 P0-2 fix: 显式解析 agentDir, 不依赖后端 fallback.
 * 之前是 `scope === 'global' ? null : null` typo, 两边都返回 null,
 *   全靠 Rust 端 `resolve_custom_instructions_path` 的 USERPROFILE/HOME fallback.
 * 跨平台 Pi SDK 0.85+ 改 fallback 路径时 (e.g. 改用 XDG_CONFIG_HOME) 会 silent fail.
 * 现在: global scope 主动 `piTauri.getAgentDir()` 拿真实路径, FE 显式传.
 * workspace scope 不需要 agentDir (后端用 workspacePath 算 AGENTS.md).
 */
async function resolveAgentDir(): Promise<string | null> {
  if (scope.value !== 'global') return null;
  try {
    return await piTauri.getAgentDir();
  } catch (e) {
    console.warn('[CustomInstructions] getAgentDir failed, 后端会 fallback:', e instanceof Error ? e.message : String(e));
    return null;
  }
}

async function load() {
  isLoading.value = true;
  toast.value = null;
  try {
    const wsPath = scope.value === 'workspace' ? activeWorkspace.value?.path ?? null : null;
    const agentDir = await resolveAgentDir();
    const res = await piTauri.readCustomInstructions({
      scope: scope.value,
      workspacePath: wsPath,
      agentDir,
    });
    filePath.value = res.filePath;
    content.value = res.content;
    modifiedAt.value = res.modifiedAt;
    // v0.6.3-rc1 P1-4: load 出来的就是上次保存的版本, diff 基线
    lastSavedContent.value = res.content;
    console.log(`[CustomInstructions] loaded: scope=${scope.value} filePath=${res.filePath} len=${res.content.length} agentDir=${agentDir ?? 'fallback'}`);
  } catch (e) {
    filePath.value = null;
    content.value = '';
    modifiedAt.value = null;
    console.error('[CustomInstructions] load failed:', e instanceof Error ? e.message : String(e));
  } finally {
    isLoading.value = false;
  }
}

async function save() {
  if (isSaving.value) return;
  // v0.6.3-rc1 P1-2: 硬限制 16KB 阻止保存
  if (sizeLevel.value === 'block') {
    toast.value = { type: 'fail', message: `内容超 16 KB (实际 ${(contentBytes.value / 1024).toFixed(1)} KB), 阻止保存. 请精简后再试.` };
    return;
  }
  isSaving.value = true;
  toast.value = null;
  try {
    const wsPath = scope.value === 'workspace' ? activeWorkspace.value?.path ?? null : null;
    const agentDir = await resolveAgentDir();
    const written = await piTauri.writeCustomInstructions({
      scope: scope.value,
      workspacePath: wsPath,
      agentDir,
      content: content.value,
    });
    filePath.value = written;
    modifiedAt.value = new Date().toISOString();
    // v0.6.3-rc1 P1-4: 记录最后保存的内容, 给 diff 视图用
    lastSavedContent.value = content.value;
    // v0.6.3-rc1 P0-4: 明确告知用户 Pi SDK 0.84.2 限制 — 改完不重启 sidecar LLM 看到的还是旧家规本
    toast.value = {
      type: 'ok',
      message: `已保存到 ${written} | Pi SDK 0.84.2 限制: 生效需重启 sidecar (≈200ms), 点右边的"保存并立即重启"或下次发消息自动重启`,
    };
    console.log(`[CustomInstructions] saved: ${written} agentDir=${agentDir ?? 'fallback'}`);
  } catch (e) {
    toast.value = { type: 'fail', message: e instanceof Error ? e.message : String(e) };
  } finally {
    isSaving.value = false;
  }
}

/**
 * v0.6.3-rc1 P0-4: 保存并立即重启 sidecar — 治 R1 沉默失败
 * 流程: save() 写文件 → kill 当前 active session 的 sidecar
 *   下次用户发消息时, chat store 自动 spawn 新 sidecar, 新 sidecar 启动时 Pi SDK
 *   自动 load 最新 AGENTS.md, LLM 看到的就是新家规本.
 *
 * 注意: 我们不主动 spawn 新 sidecar, 是因为:
 *   1. spawn 需要完整 config (provider/model/...), Agent 守则 tab 不持有这些
 *   2. 用户不发消息就 spawn 是浪费资源 (空跑 sidecar 进程)
 *   3. 跟现有 abort/stop 流程一样, kill 后下次 send_prompt 自动 spawn
 */
async function saveAndRestart() {
  if (isSaving.value || isRestarting.value) return;
  isRestarting.value = true;
  try {
    await save();
    if (toast.value?.type === 'fail') {
      // save 失败, 不重启
      isRestarting.value = false;
      return;
    }
    // 保存成功, kill 当前 active session 的 sidecar (如果有)
    const sid = activeSession.value?.id;
    if (!sid) {
      toast.value = {
        type: 'ok',
        message: `${toast.value?.message ?? ''} | 没有 active session, 下次发消息会自动启用新 sidecar`,
      };
      console.log('[CustomInstructions] saveAndRestart: no active session, skip kill_sidecar');
      return;
    }
    try {
      const killed = await piTauri.killSidecar(sid);
      console.log(`[CustomInstructions] saveAndRestart: killed=${killed} session=${sid}`);
      toast.value = {
        type: 'ok',
        message: `${toast.value?.message ?? ''} | 已重启 sidecar (kill_sidecar=${killed}), 下次发消息生效新家规本`,
      };
    } catch (e) {
      // kill 失败不阻塞 — 用户可以手动重启或下次发消息触发
      console.warn('[CustomInstructions] saveAndRestart: killSidecar failed (ignored):', e);
      toast.value = {
        type: 'ok',
        message: `${toast.value?.message ?? ''} | 重启 sidecar 失败: ${e instanceof Error ? e.message : String(e)} (下次发消息会自动重启)`,
      };
    }
  } finally {
    isRestarting.value = false;
  }
}

async function remove() {
  if (isDeleting.value) return;
  if (!confirm(`确认删除 ${filePath.value || 'AGENTS.md'}?\n\nPi SDK 0.84.2 启动时不再 load, LLM 走默认行为.`)) return;
  isDeleting.value = true;
  toast.value = null;
  try {
    const wsPath = scope.value === 'workspace' ? activeWorkspace.value?.path ?? null : null;
    const agentDir = await resolveAgentDir();
    const ok = await piTauri.deleteCustomInstructions({
      scope: scope.value,
      workspacePath: wsPath,
      agentDir,
    });
    if (ok) {
      filePath.value = null;
      content.value = '';
      modifiedAt.value = null;
      toast.value = { type: 'ok', message: '已删除' };
    } else {
      toast.value = { type: 'fail', message: '文件不存在' };
    }
  } catch (e) {
    toast.value = { type: 'fail', message: e instanceof Error ? e.message : String(e) };
  } finally {
    isDeleting.value = false;
  }
}

onMounted(() => {
  load();
});

/**
 * v0.6.3-rc1: "用默认家规本" / "恢复默认" 按钮 (一个按钮, label 动态)
 *   - filePath 为空 (未创建 AGENTS.md): 一键把 DEFAULT_GUIDE 灌入 textarea, 用户接着修改保存
 *   - filePath 有 (已创建 AGENTS.md): 弹 confirm 让用户确认覆盖 (防误操作丢稿)
 */
function useDefault() {
  const hasContent = content.value && content.value.trim().length > 0;
  if (hasContent) {
    if (!confirm('AGENTS.md 已有内容, 用默认家规本会覆盖你现在的编辑 (未保存的修改会丢).\n\n确认覆盖?')) {
      return;
    }
  }
  content.value = DEFAULT_GUIDE;
  // lastSavedContent 不动 — 如果 lastSavedContent 是 null (文件未创建), 就让它等于新默认值
  // diff 视图看不到 "未保存" 的变更 (因为 lastSavedContent === content)
  if (lastSavedContent.value === null) {
    lastSavedContent.value = DEFAULT_GUIDE;
  }
  toast.value = { type: 'ok', message: '已加载默认家规本, 修改后点 "保存" 写入 AGENTS.md' };
  console.log('[CustomInstructions] useDefault: loaded DEFAULT_GUIDE into textarea');
}
</script>

<template>
  <div class="pad-instrtab">
    <div class="pad-instrtab__header">
      <h2 class="pad-instrtab__title">Agent 守则</h2>
      <p class="pad-instrtab__subtitle">
        编辑 <code>AGENTS.md</code> — 作为 <strong>项目边界 / 思维指导</strong> 段注入 system prompt
        (Pi SDK 内部 <code>contextFiles</code> 拼到第 4 段 <code>project_context</code>, sidecar 不参与拼接).
        <br />
        <strong>⚠️ Pi SDK 0.84.2 限制</strong>: 改完不重启 sidecar LLM 看到的还是旧家规本 (system prompt 是
        sidecar 启动时一次性拼的). 改完保存后, 点 "保存并立即重启" 或下次发消息时自动重启.
      </p>
    </div>

    <div v-if="toast" class="pad-instrtab__toast" :class="`is-${toast.type}`">
      <Check v-if="toast.type === 'ok'" :size="14" :stroke-width="1.75" />
      <AlertCircle v-else :size="14" :stroke-width="1.75" />
      <span>{{ toast.message }}</span>
      <button class="pad-instrtab__toast-close" @click="toast = null">×</button>
    </div>

    <div class="pad-instrtab__card">
      <div class="pad-instrtab__card-head">
        <FileText :size="14" :stroke-width="1.75" />
        <span class="pad-instrtab__card-title">
          {{ filePath ? '已加载' : (isLoading ? '加载中…' : '未创建') }}
          <span v-if="filePath" class="pad-instrtab__file-path">{{ filePath }}</span>
        </span>
        <div class="pad-instrtab__actions">
          <button class="pad-instrtab__btn" :disabled="isLoading" @click="load">
            <RefreshCw :size="13" :stroke-width="1.75" />
            <span>刷新</span>
          </button>
          <!-- v0.6.3-rc1: 默认家规本 / 恢复默认 — 一个按钮两个用途, label 根据 filePath 动态切换 -->
          <button
            class="pad-instrtab__btn"
            :disabled="isLoading"
            :title="filePath ? '覆盖当前 AGENTS.md 为默认家规本 (弹 confirm 确认)' : '未创建 AGENTS.md, 一键灌入默认家规本, 接着修改保存'"
            @click="useDefault"
          >
            <Wand2 :size="13" :stroke-width="1.75" />
            <span>{{ filePath ? '恢复默认' : '用默认家规本' }}</span>
          </button>
          <button
            v-if="filePath"
            class="pad-instrtab__btn pad-instrtab__btn--danger"
            :disabled="isDeleting"
            @click="remove"
          >
            <Trash2 :size="13" :stroke-width="1.75" />
            <span>删除</span>
          </button>
          <button
            class="pad-instrtab__btn pad-instrtab__btn--primary"
            :disabled="isSaving"
            @click="save"
          >
            <Save :size="13" :stroke-width="1.75" />
            <span>{{ isSaving ? '保存中…' : '保存' }}</span>
          </button>
          <!-- v0.6.3-rc1 P0-4: 治 R1 沉默失败 — 改完家规本不重启 sidecar LLM 看到旧内容, 给用户一键 save+kill 流程 -->
          <button
            class="pad-instrtab__btn pad-instrtab__btn--primary"
            :disabled="isSaving || isRestarting"
            :title="`保存 AGENTS.md + kill 当前 active session 的 sidecar\n下次发消息时新 sidecar 自动 load 最新家规本\n(Pi SDK 0.84.2 限制, 没自动 reload 机制)`"
            @click="saveAndRestart"
          >
            <Save :size="13" :stroke-width="1.75" />
            <RotateCcw :size="13" :stroke-width="1.75" />
            <span>{{ isRestarting ? '重启中…' : '保存并立即重启' }}</span>
          </button>
        </div>
      </div>

      <div class="pad-instrtab__form">
        <div class="pad-instrtab__form-row">
          <label class="pad-instrtab__label">scope</label>
          <div class="pad-instrtab__radio">
            <label
              v-for="opt in SCOPE_OPTIONS"
              :key="opt.value"
              :class="{ 'is-active': scope === opt.value }"
            >
              <input
                v-model="scope"
                type="radio"
                :value="opt.value"
                @change="load"
              />
              <span>{{ opt.label }}</span>
            </label>
          </div>
        </div>
        <div class="pad-instrtab__form-row pad-instrtab__form-row--body">
          <div class="pad-instrtab__body-head">
            <label class="pad-instrtab__label">body (markdown)</label>
            <div class="pad-instrtab__head-actions">
              <!-- v0.6.3-rc1 P2-5: 视图模式 toggle — split (默认) / edit / preview -->
              <div class="pad-instrtab__view-mode" role="tablist" aria-label="视图模式">
                <button
                  v-for="m in (['split', 'edit', 'preview'] as const)"
                  :key="m"
                  class="pad-instrtab__view-mode-btn"
                  :class="{ 'is-active': viewMode === m }"
                  type="button"
                  role="tab"
                  :aria-selected="viewMode === m"
                  :title="m === 'split' ? '分屏 (左编辑右预览)' : m === 'edit' ? '只编辑' : '只预览'"
                  @click="viewMode = m"
                >
                  <Columns2 v-if="m === 'split'" :size="12" :stroke-width="1.75" />
                  <FileText v-else-if="m === 'edit'" :size="12" :stroke-width="1.75" />
                  <Eye v-else :size="12" :stroke-width="1.75" />
                  <span>{{ m === 'split' ? '分屏' : m === 'edit' ? '只编辑' : '只预览' }}</span>
                </button>
              </div>
              <!-- v0.6.3-rc1 P1-4: diff 视图 toggle -->
              <button
                class="pad-instrtab__toggle"
                :class="{ 'is-active': showDiff }"
                :disabled="lastSavedContent === null"
                type="button"
                :title="lastSavedContent === null ? 'load / save 后才能看 diff' : '显示当前编辑 vs 上次保存版本的差异'"
                @click="showDiff = !showDiff"
              >
                <span>{{ showDiff ? '隐藏 diff' : `diff (${diffSummary})` }}</span>
              </button>
            </div>
          </div>
          <!-- v0.6.3-rc1 P2-5: split view — 默认左右并排, 窄屏 stack -->
          <div :class="['pad-instrtab__editor', `is-mode-${viewMode}`]">
            <div v-if="viewMode !== 'preview'" class="pad-instrtab__editor-pane">
              <textarea
                v-model="content"
                class="pad-instrtab__textarea"
                :class="`is-${sizeLevel}`"
                :placeholder="'agent 人设 / 边界 / 思维指导, 例如:\n# 项目背景\n本项目是一个能源监控平台, 主要用户是电网调度员.\n# 行为约束\n- 优先考虑性能, 避免阻塞主线程\n- 涉及危险操作必须弹 confirm 让用户确认'"
                rows="20"
                spellcheck="false"
              />
            </div>
            <div v-if="viewMode !== 'edit'" class="pad-instrtab__editor-pane pad-instrtab__editor-pane--preview">
              <div class="pad-instrtab__preview-head">渲染预览 (LLM 看到的是纯文本, 这面板只给人类看效果)</div>
              <div class="pad-instrtab__preview-body markdown-body" v-html="previewHtml" />
            </div>
          </div>
          <!-- v0.6.3-rc1 P1-4: diff 视图 — 当前编辑 vs 上次保存 -->
          <div v-if="showDiff && lastSavedContent !== null" class="pad-instrtab__diff">
            <div class="pad-instrtab__diff-head">
              <span>diff: 当前编辑 vs 上次保存</span>
              <span class="pad-instrtab__diff-summary">{{ diffSummary }}</span>
            </div>
            <div class="pad-instrtab__diff-body">
              <div v-for="(line, idx) in diffLines" :key="idx" :class="`pad-instrtab__diff-line is-${line.kind}`">
                <span class="pad-instrtab__diff-marker">{{ line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ' }}</span>
                <span class="pad-instrtab__diff-text">{{ line.text || '\u00A0' }}</span>
              </div>
            </div>
          </div>
          <!-- v0.6.3-rc1 P1-2: 内容大小指示器 — >8KB 黄, >16KB 红 -->
          <div class="pad-instrtab__size" :class="`is-${sizeLevel}`">
            <span>{{ sizeHint }}</span>
          </div>
        </div>
      </div>
    </div>

    <div class="pad-instrtab__hint">
      <Info :size="12" :stroke-width="1.75" />
      <span>
        <strong>v0.5.0 single agent design</strong>: 这是一个 <strong>通用 agent</strong>, 永远 active.
        AGENTS.md 不是 persona 切换, 是 <strong>思维指导 / 边界定义</strong>, 注入 system prompt
        后 LLM 整个 session 持续遵守. <br />
        跟 Skills (持续能力) / Slash (快捷模板) / @ 引用 (一次性片段) 配合, 不需要切来切去.
      </span>
    </div>
  </div>
</template>

<style scoped>
.pad-instrtab__header { padding: 24px 0 16px 0; }
.pad-instrtab__title { font-size: var(--pad-fs-22); font-weight: var(--pad-fw-semibold); color: var(--pad-fg-primary); margin: 0 0 4px 0; }
.pad-instrtab__subtitle { font-size: var(--pad-fs-13); color: var(--pad-fg-secondary); margin: 0; line-height: 1.5; }
.pad-instrtab__subtitle code {
  font-family: var(--pad-font-mono);
  font-size: 11px;
  background: var(--pad-bg-input);
  padding: 1px 4px;
  border-radius: 2px;
}
.pad-instrtab__toast { display: flex; align-items: center; gap: 6px; padding: 8px 14px; margin-bottom: 12px; border-radius: var(--pad-radius-md, 8px); font-size: var(--pad-fs-12); }
.pad-instrtab__toast.is-ok { background: var(--pad-bg-success-soft, rgba(34,197,94,0.08)); color: var(--pad-fg-success, #22c55e); }
.pad-instrtab__toast.is-fail { background: var(--pad-bg-danger-soft, rgba(220,38,38,0.08)); color: var(--pad-fg-danger, #dc2626); }
.pad-instrtab__toast-close { margin-left: auto; background: transparent; border: none; color: inherit; cursor: pointer; font-size: 16px; }
/* Phase 8: dark mode 适配 — 修未定义的 --pad-bg-base / --pad-border-subtle / --pad-bg-muted */
.pad-instrtab__card {
  background: var(--pad-card);
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-md, 8px);
  overflow: hidden;
}
.pad-instrtab__card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  background: var(--pad-bg-input);
  border-bottom: 1px solid var(--pad-border);
  color: var(--pad-fg-secondary);
}
.pad-instrtab__card-title { flex: 1; font-size: var(--pad-fs-13); font-weight: var(--pad-fw-medium); display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.pad-instrtab__file-path { font-family: var(--pad-font-mono); font-size: 10px; color: var(--pad-fg-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pad-instrtab__actions { display: flex; gap: 6px; }
.pad-instrtab__btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px 10px;
  font-size: var(--pad-fs-12);
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-sm, 4px);
  background: var(--pad-bg-input);
  color: var(--pad-fg-primary);
  cursor: pointer;
  transition: all 0.15s;
}
.pad-instrtab__btn:hover:not(:disabled) { background: var(--pad-bg-hover); }
.pad-instrtab__btn:disabled { opacity: 0.4; cursor: not-allowed; }
/* Phase 8c: primary 按钮改成跟 Skills "添加自定义" 一样 — secondary 风格
   (card bg + border + secondary text), hover 升级到 primary text + accent border.
   之前用 var(--pad-accent) 填充, light 下 #18181b 深色 bg 配 #fafafa 撞色难看. */
.pad-instrtab__btn--primary {
  background: var(--pad-card);
  border-color: var(--pad-border);
  color: var(--pad-fg-secondary);
}
.pad-instrtab__btn--primary:hover:not(:disabled) {
  background: var(--pad-bg-hover);
  color: var(--pad-fg-primary);
  border-color: var(--pad-accent, #6366f1);
}
.pad-instrtab__btn--danger { color: var(--pad-fg-danger, #dc2626); }
.pad-instrtab__btn--danger:hover:not(:disabled) { background: var(--pad-bg-danger-soft, rgba(220,38,38,0.08)); }
.pad-instrtab__form { padding: 16px; display: flex; flex-direction: column; gap: 12px; }
.pad-instrtab__form-row { display: flex; align-items: center; gap: 8px; }
.pad-instrtab__form-row--body { flex-direction: column; align-items: stretch; }
.pad-instrtab__label { font-size: var(--pad-fs-12); color: var(--pad-fg-secondary); width: 60px; flex-shrink: 0; }
.pad-instrtab__radio { display: flex; gap: 12px; }
.pad-instrtab__radio label { display: inline-flex; align-items: center; gap: 4px; font-size: var(--pad-fs-12); cursor: pointer; padding: 4px 8px; border-radius: var(--pad-radius-sm, 4px); transition: background 0.15s; }
.pad-instrtab__radio label:hover { background: var(--pad-bg-hover); }
.pad-instrtab__radio label.is-active { background: var(--pad-accent-soft); color: var(--pad-fg-primary); font-weight: var(--pad-fw-medium); }
.pad-instrtab__textarea {
  width: 100%;
  padding: 10px;
  font-family: var(--pad-font-mono);
  font-size: var(--pad-fs-13);
  line-height: 1.6;
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-sm, 4px);
  background: var(--pad-bg-input);
  color: var(--pad-fg-primary);
  resize: vertical;
  min-height: 360px;
}
/* v0.6.3-rc1 P2-5: 在 split view 模式下, textarea 填充 editor-pane (填满高度) */
.pad-instrtab__editor-pane .pad-instrtab__textarea {
  border: none;
  border-radius: 0;
  flex: 1;
  min-height: 360px;
  height: 100%;
  resize: none;
}
.pad-instrtab__textarea:focus { outline: none; border-color: var(--pad-accent, #6366f1); }
/* v0.6.3-rc1 P1-2: 内容大小警告 — textarea 边框 + size 指示器颜色 */
.pad-instrtab__textarea.is-warn { border-color: rgba(234, 179, 8, 0.5); }
.pad-instrtab__textarea.is-block { border-color: rgba(220, 38, 38, 0.7); background: rgba(220, 38, 38, 0.04); }
.pad-instrtab__size { display: flex; justify-content: flex-end; padding: 4px 2px 0; font-size: 11px; font-family: var(--pad-font-mono); }
.pad-instrtab__size.is-ok { color: var(--pad-fg-tertiary); }
.pad-instrtab__size.is-warn { color: rgba(234, 179, 8, 0.95); font-weight: 500; }
.pad-instrtab__size.is-block { color: var(--pad-fg-danger, #dc2626); font-weight: 600; }
/* v0.6.3-rc1 P1-3 / P2-5: 实时预览 toggle + preview 面板 + split view */
.pad-instrtab__body-head { display: flex; align-items: center; justify-content: space-between; }
.pad-instrtab__head-actions { display: flex; gap: 6px; align-items: center; }
/* v0.6.3-rc1 P2-5: 视图模式按钮组 (split / edit / preview) */
.pad-instrtab__view-mode {
  display: inline-flex;
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-sm, 4px);
  overflow: hidden;
}
.pad-instrtab__view-mode-btn {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 4px 8px;
  font-size: 11px;
  background: transparent;
  border: none;
  color: var(--pad-fg-secondary);
  cursor: pointer;
  transition: all 0.15s;
  border-right: 1px solid var(--pad-border);
}
.pad-instrtab__view-mode-btn:last-child { border-right: none; }
.pad-instrtab__view-mode-btn:hover { background: var(--pad-bg-hover); }
.pad-instrtab__view-mode-btn.is-active { background: var(--pad-accent-soft, rgba(99,102,241,0.12)); color: var(--pad-fg-primary); }
.pad-instrtab__view-mode-btn.is-active svg { color: var(--pad-accent, #6366f1); }
/* v0.6.3-rc1 P2-5: split view editor — 宽屏左右并排, 窄屏自动 stack */
.pad-instrtab__editor {
  display: grid;
  gap: 8px;
  min-height: 360px;
}
.pad-instrtab__editor.is-mode-split {
  grid-template-columns: 1fr 1fr;
}
.pad-instrtab__editor.is-mode-edit,
.pad-instrtab__editor.is-mode-preview {
  grid-template-columns: 1fr;
}
@media (max-width: 720px) {
  .pad-instrtab__editor.is-mode-split { grid-template-columns: 1fr; }
}
.pad-instrtab__editor-pane {
  display: flex;
  flex-direction: column;
  min-height: 360px;
  background: var(--pad-bg-input);
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-sm, 4px);
  overflow: hidden;
}
.pad-instrtab__editor-pane--preview {
  background: var(--pad-bg-input);
  padding: 0;
}
.pad-instrtab__toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  font-size: 11px;
  background: transparent;
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-sm, 4px);
  color: var(--pad-fg-secondary);
  cursor: pointer;
  transition: all 0.15s;
}
.pad-instrtab__toggle:hover { background: var(--pad-bg-hover); }
.pad-instrtab__toggle.is-active { background: var(--pad-accent-soft, rgba(99,102,241,0.1)); color: var(--pad-fg-primary); border-color: var(--pad-accent, #6366f1); }
.pad-instrtab__preview-head {
  font-size: 10px;
  color: var(--pad-fg-tertiary);
  padding: 8px 12px;
  border-bottom: 1px dashed var(--pad-border);
  background: var(--pad-bg-muted, rgba(0,0,0,0.02));
}
.pad-instrtab__preview-body {
  font-size: var(--pad-fs-13);
  line-height: 1.7;
  color: var(--pad-fg-primary);
  padding: 12px 16px;
  overflow-y: auto;
  flex: 1;
}
/* markdown 渲染基础样式 (跟项目其他 markdown 渲染统一) */
.pad-instrtab__preview-body :deep(h1) { font-size: 1.4em; font-weight: 600; margin: 0.6em 0 0.4em; }
.pad-instrtab__preview-body :deep(h2) { font-size: 1.2em; font-weight: 600; margin: 0.6em 0 0.4em; }
.pad-instrtab__preview-body :deep(h3) { font-size: 1.05em; font-weight: 600; margin: 0.6em 0 0.4em; }
.pad-instrtab__preview-body :deep(p) { margin: 0.4em 0; }
.pad-instrtab__preview-body :deep(ul), .pad-instrtab__preview-body :deep(ol) { padding-left: 1.4em; margin: 0.4em 0; }
.pad-instrtab__preview-body :deep(li) { margin: 0.2em 0; }
.pad-instrtab__preview-body :deep(code) { font-family: var(--pad-font-mono); font-size: 0.9em; background: var(--pad-bg-muted); padding: 1px 4px; border-radius: 2px; }
.pad-instrtab__preview-body :deep(pre) { background: var(--pad-bg-muted); padding: 10px; border-radius: var(--pad-radius-sm, 4px); overflow-x: auto; }
.pad-instrtab__preview-body :deep(pre code) { background: transparent; padding: 0; }
.pad-instrtab__preview-body :deep(blockquote) { border-left: 3px solid var(--pad-border); padding-left: 10px; color: var(--pad-fg-secondary); margin: 0.5em 0; }
.pad-instrtab__preview-body :deep(a) { color: var(--pad-accent, #6366f1); text-decoration: underline; }
/* v0.6.3-rc1 P1-4: diff 视图 */
.pad-instrtab__diff {
  margin-top: 8px;
  background: var(--pad-bg-input);
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-sm, 4px);
  max-height: 360px;
  overflow-y: auto;
}
.pad-instrtab__diff-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  font-size: 11px;
  color: var(--pad-fg-tertiary);
  background: var(--pad-bg-muted, rgba(0,0,0,0.02));
  border-bottom: 1px solid var(--pad-border);
  position: sticky;
  top: 0;
  z-index: 1;
}
.pad-instrtab__diff-summary { font-family: var(--pad-font-mono); font-weight: 500; }
.pad-instrtab__diff-body { font-family: var(--pad-font-mono); font-size: var(--pad-fs-12); line-height: 1.5; }
.pad-instrtab__diff-line {
  display: flex;
  gap: 8px;
  padding: 1px 12px;
  white-space: pre-wrap;
  word-break: break-word;
}
.pad-instrtab__diff-marker {
  flex-shrink: 0;
  width: 12px;
  text-align: center;
  color: var(--pad-fg-tertiary);
  user-select: none;
}
.pad-instrtab__diff-line.is-same { color: var(--pad-fg-secondary); }
.pad-instrtab__diff-line.is-add { background: rgba(34, 197, 94, 0.12); color: var(--pad-fg-primary); }
.pad-instrtab__diff-line.is-add .pad-instrtab__diff-marker { color: rgba(34, 197, 94, 0.95); font-weight: 600; }
.pad-instrtab__diff-line.is-del { background: rgba(220, 38, 38, 0.1); color: var(--pad-fg-tertiary); text-decoration: line-through; }
.pad-instrtab__diff-line.is-del .pad-instrtab__diff-marker { color: rgba(220, 38, 38, 0.95); font-weight: 600; }
.pad-instrtab__hint { display: flex; align-items: flex-start; gap: 6px; padding: 12px 16px; color: var(--pad-fg-tertiary); font-size: 11px; line-height: 1.5; }
.pad-instrtab__hint code {
  font-family: var(--pad-font-mono);
  font-size: 10px;
  background: var(--pad-bg-input);
  padding: 1px 4px;
  border-radius: 2px;
}
</style>
