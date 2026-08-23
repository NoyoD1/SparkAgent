<script setup lang="ts">
/**
 * v0.6 (N1+N2 + Bug2 修 + 热更增强): 通用设置 — 自动压缩开关
 *
 * 背景: ADR-0016 决策 auto-compaction 行为. Pi SDK 0.84.2 settingsManager
 *   只暴露 `setCompactionEnabled` setter, 触发阈值 (reserveTokens/keepRecentTokens)
 *   是只读 getter, 改不了. 所以本 tab 只做 enabled 开关.
 *
 * 持久化方案: Rust 端直接读写 ~/.pi/agent/settings.json (跟 Pi SDK 0.84.2 FileSettingsStorage 一致)
 *   不走 sidecar RPC 避免 "no active sidecar" 坑 (Bug2 修)
 *
 * 热更增强 (2026-08-22): 写文件后, 如果有 active session, 顺便发 set_auto_compaction RPC
 *   让那个 session 的 Pi SDK settingsManager 内存立即更新 (Pi SDK 内部 save() 会同时触发
 *   this.settings = deepMergeSettings(this.globalSettings, this.projectSettings)).
 *   其他闲置 session: 下次启动 sidecar 时读新 settings.json 自动生效.
 *
 * 流程:
 *  - onMounted 调 getCompactionEnabled 读 ~/.pi/agent/settings.json 的 compaction.enabled
 *  - user 改 toggle → 调 setCompactionEnabled 写文件 + (如有 active session) 发 RPC 热更
 *  - 关闭时: 走 Pi SDK overflow 路径 (context > contextWindow) 才压缩, 实际相当于 100% 触发
 *  - 开启时: 走 Pi SDK threshold 路径 (context > contextWindow - reserveTokens=16384) 触发,
 *            200K 窗口下约 92% 触发
 */
import { ref, computed, onMounted } from 'vue';
import { useSessionStore } from '@/stores/session';
import { useUiStore } from '@/stores/ui';
import { piTauri, type TauriBashConfig, type TauriShellInfo, type TauriWhitelistItem } from '@/lib/tauri';
import { Archive, Info, Terminal, Search, X, FlaskConical, CheckCircle2, AlertCircle, Shield, Plus } from 'lucide-vue-next';

const sessionStore = useSessionStore();
const uiStore = useUiStore();

const autoCompactionEnabled = ref(true);
const isLoading = ref(false);
const isSaving = ref(false);
const isReady = computed(() => !isLoading.value && !isSaving.value);

// ====== ADR-0019 P0-1 (2026-08-23): Bash 路径配置 ======
//   写在 ~/.pi/agent/settings.json 的 bash 字段
//   Source of truth: settings.bash.path, auto + manual 都是合法写入路径
//   首次启动 1+ 候选 → 静默 auto-pick (source='auto'), 0 候选 + 没填 → 弹 toast
//   输入框 on-blur → 立即校验 + 持久化 (source='manual')
//   shell 切换不热生效, 等下次启动 sidecar
const bashPath = ref('');
const bashConfig = ref<TauriBashConfig | null>(null);
const bashCandidates = ref<TauriShellInfo[]>([]);
const bashIsDetecting = ref(false);
const bashIsSaving = ref(false);
const bashIsVerifying = ref(false);
const bashVerifyResult = ref<{ ok: boolean; version?: string; error?: string } | null>(null);
const bashHasAutoPicked = ref(false);

// ====== ADR-0019 P0-2 (2026-08-23): 高级权限 (危险命令白名单) ======
//   内置 deny list 12 类 — 跟 sidecar/src/index.mjs 的 BUILTIN_DENY_LIST 一一对应
//   顺序就是侧车扫描顺序, 展示给 user 看 (只读, 不可关)
//   description 是白话版本, regex 跟 sidecar 同步
const BUILTIN_DENY_DESCRIPTIONS = [
  'rm -rf / rm -r / --recursive (递归删)',
  'rmdir /s (Windows 递归删目录)',
  'del /f (Windows 强删文件)',
  'rd /s /q (Windows 强删目录)',
  'format (Windows 格式化磁盘)',
  'mkfs (Linux 格式化分区, mkfs.ext4 等)',
  'dd if= (磁盘级复制, 可擦盘)',
  ':(){ :|:& };: (Fork bomb)',
  'wget|curl ... | bash (下载并执行)',
  'sh|bash <(curl|wget) (进程替换 + 下载执行)',
  'shutdown -h / -r now (关机/重启)',
  'init 0/6 (Linux 切换运行级别)',
  '> /dev/sda (直接写磁盘设备)',
];

const whitelist = ref<TauriWhitelistItem[]>([]);
const whitelistIsSaving = ref(false);
const newWhitelistPattern = ref('');
const newWhitelistNote = ref('');

async function loadWhitelist() {
  try {
    whitelist.value = await piTauri.getDangerousWhitelist();
    console.log(`[GeneralTab] loaded dangerousWhitelist: ${whitelist.value.length} item(s)`);
  } catch (e) {
    console.warn('[GeneralTab] get_dangerous_whitelist failed:', e);
    whitelist.value = [];
  }
}

async function addWhitelistItem() {
  if (whitelistIsSaving.value) return;
  const pattern = newWhitelistPattern.value.trim();
  const note = newWhitelistNote.value.trim();
  if (!pattern) {
    useUiStore().showToast('pattern 不能为空', 'warning', 2000);
    return;
  }
  whitelistIsSaving.value = true;
  try {
    whitelist.value = await piTauri.addDangerousWhitelistItem({ pattern, note });
    useUiStore().showToast(`已添加白名单: ${pattern}`, 'success', 2500);
    newWhitelistPattern.value = '';
    newWhitelistNote.value = '';
    console.log(`[GeneralTab] add_dangerous_whitelist_item OK: pattern=${pattern}`);
    // ADR-0023: 危险命令白名单改动 → restart sidecar (Extension 工厂 state)
    void piTauri.restartAllSidecars('dangerous_whitelist_changed');
  } catch (e) {
    useUiStore().showToast(`添加失败: ${e instanceof Error ? e.message : String(e)}`, 'error', 4000);
  } finally {
    whitelistIsSaving.value = false;
  }
}

async function removeWhitelistItem(item: TauriWhitelistItem) {
  if (whitelistIsSaving.value) return;
  if (!confirm(`确认从白名单移除?\n\npattern: ${item.pattern}\n${item.note ? `备注: ${item.note}\n` : ''}\n移除后, 匹配此 pattern 的危险命令会被 LLM 拦截.`)) {
    return;
  }
  whitelistIsSaving.value = true;
  try {
    whitelist.value = await piTauri.removeDangerousWhitelistItem({ pattern: item.pattern });
    useUiStore().showToast(`已移除: ${item.pattern}`, 'success', 2000);
    console.log(`[GeneralTab] remove_dangerous_whitelist_item OK: pattern=${item.pattern}`);
    // ADR-0023: 危险命令白名单改动 → restart sidecar
    void piTauri.restartAllSidecars('dangerous_whitelist_changed');
  } catch (e) {
    useUiStore().showToast(`移除失败: ${e instanceof Error ? e.message : String(e)}`, 'error', 4000);
  } finally {
    whitelistIsSaving.value = false;
  }
}

async function loadBashInitial() {
  try {
    const cfg = await piTauri.getBashConfig();
    bashConfig.value = cfg;
    bashPath.value = cfg?.path ?? '';
    console.log(`[GeneralTab] loaded bash config: path=${cfg?.path ?? '(unset)'} source=${cfg?.source ?? '(none)'} version=${cfg?.version ?? '(unknown)'}`);
  } catch (e) {
    console.warn('[GeneralTab] get_bash_config 失败, 用默认空:', e);
    bashConfig.value = null;
    bashPath.value = '';
  }
  await detectBashCandidates();
  if (!bashConfig.value && bashCandidates.value.length > 0 && !bashHasAutoPicked.value) {
    const first = bashCandidates.value[0];
    const pickable = first.shellType === 'bash' || first.shellType === 'wsl' ? first : null;
    if (pickable) {
      bashHasAutoPicked.value = true;
      console.log(`[GeneralTab] first-run auto-pick bash: ${pickable.path} (source=auto)`);
      try {
        const saved = await piTauri.setBashConfig({ path: pickable.path, source: 'auto' });
        bashConfig.value = saved;
        bashPath.value = saved.path;
      } catch (e) {
        console.warn('[GeneralTab] auto-pick set_bash_config 失败, 跳过:', e);
      }
    } else {
      useUiStore().showToast('未检测到 bash / wsl shell, 请在 Bash 路径手动指定', 'warning', 5000);
    }
  } else if (!bashConfig.value && bashCandidates.value.length === 0) {
    useUiStore().showToast('未检测到 bash, 请安装 Git for Windows 或在 Bash 路径手动指定', 'warning', 5000);
  }
}

async function detectBashCandidates() {
  bashIsDetecting.value = true;
  try {
    bashCandidates.value = await piTauri.detectBashCandidates();
    console.log(`[GeneralTab] detect_bash_candidates: found ${bashCandidates.value.length} candidate(s)`);
  } catch (e) {
    console.error('[GeneralTab] detect_bash_candidates 失败', e);
    bashCandidates.value = [];
  } finally {
    bashIsDetecting.value = false;
  }
}

async function onBashPathBlur() {
  const path = bashPath.value.trim();
  if (!path) {
    if (bashConfig.value) {
      await clearBashConfig();
    }
    return;
  }
  if (path === bashConfig.value?.path) return;
  await setBashPath(path, 'manual');
}

async function setBashPath(path: string, source: 'auto' | 'manual') {
  if (bashIsSaving.value) return;
  bashIsSaving.value = true;
  bashVerifyResult.value = null;
  try {
    const saved = await piTauri.setBashConfig({ path, source });
    bashConfig.value = saved;
    bashPath.value = saved.path;
    bashVerifyResult.value = { ok: true, version: saved.version };
    useUiStore().showToast(
      `已保存 Bash 路径 (source=${source}, version=${saved.version ?? '?'})`,
      'success',
      3000,
    );
    console.log(`[GeneralTab] set_bash_config OK: path=${path} source=${source} version=${saved.version ?? '?'}`);
    // ADR-0023: bash.path 改动 → restart sidecar (Pi SDK 0.84.2 settings.shellPath 启动时读)
    void piTauri.restartAllSidecars('bash_path_changed');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    bashVerifyResult.value = { ok: false, error: msg };
    useUiStore().showToast(`保存失败: ${msg}`, 'error');
    try {
      const cfg = await piTauri.getBashConfig();
      bashConfig.value = cfg;
      bashPath.value = cfg?.path ?? '';
    } catch { /* ignore */ }
  } finally {
    bashIsSaving.value = false;
  }
}

async function pickCandidate(c: TauriShellInfo) {
  bashPath.value = c.path;
  await setBashPath(c.path, 'auto');
}

async function verifyBash() {
  const path = bashPath.value.trim();
  if (!path) {
    useUiStore().showToast('先填一个 bash 路径再测试', 'info', 2000);
    return;
  }
  if (bashIsVerifying.value) return;
  bashIsVerifying.value = true;
  try {
    const result = await piTauri.verifyBashPath(path);
    bashVerifyResult.value = result;
    if (result.ok) {
      useUiStore().showToast(`✓ v${result.version ?? '?'}`, 'success', 2000);
    } else {
      useUiStore().showToast(`测试失败: ${result.error ?? '未知错误'}`, 'error', 4000);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    bashVerifyResult.value = { ok: false, error: msg };
    useUiStore().showToast(`测试失败: ${msg}`, 'error', 4000);
  } finally {
    bashIsVerifying.value = false;
  }
}

async function clearBashConfig() {
  if (bashIsSaving.value) return;
  bashIsSaving.value = true;
  try {
    await piTauri.clearBashConfig();
    bashConfig.value = null;
    bashPath.value = '';
    bashVerifyResult.value = null;
    useUiStore().showToast('已清除, 下次启动 sidecar fallback Pi SDK 自带搜索', 'info', 3000);
    console.log('[GeneralTab] clear_bash_config OK');
  } catch (e) {
    useUiStore().showToast(`清除失败: ${e instanceof Error ? e.message : String(e)}`, 'error');
  } finally {
    bashIsSaving.value = false;
  }
}

function lastVerifiedLabel(ms: number | undefined): string {
  if (!ms) return '(从未验证)';
  const ageSec = Math.floor((Date.now() - ms) / 1000);
  if (ageSec < 60) return '刚刚';
  if (ageSec < 3600) return `${Math.floor(ageSec / 60)} 分钟前`;
  if (ageSec < 86400) return `${Math.floor(ageSec / 3600)} 小时前`;
  return `${Math.floor(ageSec / 86400)} 天前`;
}

async function loadInitial() {
  isLoading.value = true;
  try {
    const enabled = await piTauri.getCompactionEnabled();
    autoCompactionEnabled.value = enabled;
    console.log(`[GeneralTab] loaded compaction.enabled=${enabled} from settings.json`);
  } catch (e) {
    console.warn('[GeneralTab] get_compaction_enabled 失败, 用默认值 true:', e);
    autoCompactionEnabled.value = true;
  } finally {
    isLoading.value = false;
  }
}

async function onToggle() {
  isSaving.value = true;
  const target = autoCompactionEnabled.value;
  const prev = !target;
  try {
    // 1. 写文件 (持久化, 保证下次 Pi SDK 启动一定生效)
    await piTauri.setCompactionEnabled(target);
    console.log(`[GeneralTab] set_compaction_enabled=${target} 写入 settings.json`);

    // 2. 热更尝试: 给当前 active session 发 set_auto_compaction RPC
    //    Pi SDK 0.84.2 收到后会改 settingsManager.globalSettings.compaction.enabled + 重新 merge settings
    //    (settings-manager.js:509-516 + save() 内部 this.settings = deepMergeSettings)
    //    失败静默: 闲置 session 没 active sidecar 正常, 不算错
    let hotUpdateMsg = '';
    const sid = sessionStore.activeSessionId;
    if (sid) {
      try {
        await piTauri.sendRpcCommand(sid, {
          type: 'set_auto_compaction',
          enabled: target,
        });
        hotUpdateMsg = '当前 session 立即生效';
        console.log(`[GeneralTab] 热更 RPC sent to ${sid}`);
      } catch (rpcErr) {
        // 闲置 session / sidecar 死了, 文件已经写, 下次启 sidecar 自然生效
        hotUpdateMsg = '当前 session 下次发 prompt 时生效';
        console.warn('[GeneralTab] 热更 RPC 失败 (active sidecar 不在, 正常):', rpcErr);
      }
    } else {
      hotUpdateMsg = '下次 session 启动生效';
    }

    uiStore.showToast(
      target
        ? `已启用自动压缩 (${hotUpdateMsg}, threshold 92% 触发)`
        : `已关闭自动压缩 (${hotUpdateMsg}, 100% 才压缩)`,
      'success',
      3000,
    );
  } catch (e) {
    console.error('[GeneralTab] set_compaction_enabled FAILED', e);
    uiStore.showToast(`保存失败: ${e instanceof Error ? e.message : String(e)}`, 'error');
    autoCompactionEnabled.value = prev; // 回滚
  } finally {
    isSaving.value = false;
  }
}

// 通用 tab 打开时读一次
onMounted(() => {
  loadInitial();
  void loadBashInitial();
  void loadWhitelist();
});
</script>

<template>
  <div class="pad-general-tab">
    <!-- ADR-0019 P0-1 (2026-08-23): Bash 路径配置 (置顶, 所有 tool 依赖) -->
    <div class="pad-general-section">
      <div class="pad-general-section-head">
        <Terminal :size="16" :stroke-width="1.75" class="pad-general-section-icon" />
        <h3 class="pad-general-section-title">Bash 路径</h3>
        <span v-if="bashConfig" class="pad-general-section-tag" :class="`is-${bashConfig.source}`">
          {{ bashConfig.source === 'auto' ? '自动' : '手动' }}
        </span>
      </div>
      <p class="pad-general-section-desc">
        Pi Agent 所有工具 (bash / read / write / edit) 都依赖 bash.
        如果你的 Git for Windows 装在非常规路径, 在这里手动指定.
        改完 <strong>下次启动 sidecar 生效</strong>.
      </p>

      <div class="pad-bash-row">
        <input
          v-model="bashPath"
          type="text"
          class="pad-bash-input"
          placeholder="例如 D:\DevTools\Git\bin\bash.exe"
          spellcheck="false"
          :disabled="bashIsSaving"
          @blur="onBashPathBlur"
        />
        <button
          class="pad-general-btn pad-general-btn--primary"
          :disabled="bashIsDetecting"
          @click="detectBashCandidates"
          title="重新检测本机的 bash / wsl / pwsh"
        >
          <Search :size="13" :stroke-width="1.75" />
          <span>{{ bashIsDetecting ? '检测中…' : '自动检测' }}</span>
        </button>
        <button
          class="pad-general-btn"
          :disabled="bashIsVerifying || !bashPath.trim()"
          @click="verifyBash"
          title="跑 &lt;bash&gt; --version 验证"
        >
          <FlaskConical :size="13" :stroke-width="1.75" />
          <span>{{ bashIsVerifying ? '测试中…' : '测试' }}</span>
        </button>
        <button
          class="pad-general-btn pad-general-btn--danger"
          :disabled="bashIsSaving || !bashConfig"
          @click="clearBashConfig"
          title="删除 bash 配置, 下次启动 fallback Pi SDK 自带搜索"
        >
          <X :size="13" :stroke-width="1.75" />
          <span>清除</span>
        </button>
      </div>

      <!-- 状态行 -->
      <div v-if="bashConfig" class="pad-bash-status">
        <CheckCircle2 v-if="bashVerifyResult?.ok !== false" :size="13" :stroke-width="1.75" class="pad-bash-status-ok" />
        <AlertCircle v-else :size="13" :stroke-width="1.75" class="pad-bash-status-fail" />
        <span class="pad-bash-status-text">
          状态: {{ bashVerifyResult?.ok === false ? '✗ 验证失败' : `✓ v${bashConfig.version ?? '?'}` }}
          <span class="pad-bash-status-sep">·</span>
          来源: {{ bashConfig.source === 'auto' ? '自动检测' : '手动填写' }}
          <span class="pad-bash-status-sep">·</span>
          上次验证: {{ lastVerifiedLabel(bashConfig.lastVerified) }}
        </span>
      </div>
      <div v-else class="pad-bash-status is-warn">
        <AlertCircle :size="13" :stroke-width="1.75" />
        <span class="pad-bash-status-text">
          状态: 未配置 (下次启动 sidecar 会走 Pi SDK 自带搜索, 大概率失败)
        </span>
      </div>

      <!-- 候选列表 -->
      <details v-if="bashCandidates.length > 0" class="pad-bash-candidates">
        <summary class="pad-bash-candidates-summary">
          检测到 {{ bashCandidates.length }} 个 shell 候选 (点击填入)
        </summary>
        <ul class="pad-bash-candidates-list">
          <li
            v-for="(c, i) in bashCandidates"
            :key="`${c.source}-${c.path}-${i}`"
            class="pad-bash-candidate"
            :class="{ 'is-active': c.path === bashConfig?.path }"
            @click="pickCandidate(c)"
          >
            <span class="pad-bash-candidate-type">{{ c.shellType }}</span>
            <span class="pad-bash-candidate-path">{{ c.path }}</span>
            <span class="pad-bash-candidate-source">{{ c.source }}{{ c.version ? ` · v${c.version}` : '' }}</span>
          </li>
        </ul>
      </details>

      <div v-if="bashVerifyResult?.ok === false && bashVerifyResult.error" class="pad-bash-error">
        <AlertCircle :size="13" :stroke-width="1.75" />
        <span>{{ bashVerifyResult.error }}</span>
      </div>
    </div>

    <!-- ADR-0019 P0-2 (2026-08-23): 高级权限 (危险命令白名单) -->
    <div class="pad-general-section">
      <div class="pad-general-section-head">
        <Shield :size="16" :stroke-width="1.75" class="pad-general-section-icon" />
        <h3 class="pad-general-section-title">高级权限</h3>
        <span class="pad-general-section-tag is-manual">{{ whitelist.length }} 条白名单</span>
      </div>
      <p class="pad-general-section-desc">
        Pi Agent 内置检测 <strong>12 类危险命令</strong> (rm -rf / format / mkfs / dd if= / pipe-to-shell / fork bomb 等).
        匹配的命令会被 LLM 拦截 (除非加白名单). 白名单走<strong>正则</strong>, 匹配就放行 + sidecar 标记
        <code>[DANGEROUS_USED]</code> 供排查. <strong>非必要别加</strong>, 95% 情况改写命令就行.
      </p>

      <details v-if="BUILTIN_DENY_DESCRIPTIONS.length > 0" class="pad-bash-candidates" style="margin-top: 4px">
        <summary class="pad-bash-candidates-summary">
          内置检测的 12 类危险命令 (只读, 不可关闭)
        </summary>
        <ul class="pad-bash-candidates-list">
          <li v-for="(d, i) in BUILTIN_DENY_DESCRIPTIONS" :key="`deny-${i}`" class="pad-bash-candidate" style="cursor: default">
            <span class="pad-bash-candidate-type">DANGER</span>
            <span class="pad-bash-candidate-path">{{ d }}</span>
          </li>
        </ul>
      </details>

      <div class="pad-bash-row" style="margin-top: 12px">
        <input
          v-model="newWhitelistPattern"
          type="text"
          class="pad-bash-input"
          placeholder="正则 pattern, e.g. rm\\s+-rf\\s+/tmp/.*"
          spellcheck="false"
          :disabled="whitelistIsSaving"
        />
        <input
          v-model="newWhitelistNote"
          type="text"
          class="pad-bash-input"
          placeholder="备注 (可选, e.g. 清理 /tmp)"
          spellcheck="false"
          :disabled="whitelistIsSaving"
          style="min-width: 180px; flex: 0.6"
        />
        <button
          class="pad-general-btn pad-general-btn--primary"
          :disabled="whitelistIsSaving || !newWhitelistPattern.trim()"
          @click="addWhitelistItem"
          title="添加正则到白名单 (匹配后放行危险命令)"
        >
          <Plus :size="13" :stroke-width="1.75" />
          <span>{{ whitelistIsSaving ? '添加中…' : '添加' }}</span>
        </button>
      </div>

      <div v-if="whitelist.length > 0" style="margin-top: 10px">
        <div
          v-for="item in whitelist"
          :key="item.pattern + item.addedAt"
          class="pad-bash-candidate"
          style="cursor: default; border-radius: var(--pad-radius-sm, 6px)"
        >
          <span class="pad-bash-candidate-type">WHITELIST</span>
          <span class="pad-bash-candidate-path" :title="item.pattern">{{ item.pattern }}</span>
          <span v-if="item.note" class="pad-bash-candidate-source" style="opacity: 0.8">{{ item.note }}</span>
          <span class="pad-bash-candidate-source" style="opacity: 0.5">·</span>
          <button
            class="pad-general-btn pad-general-btn--danger"
            style="height: 22px; padding: 0 8px; font-size: 11px"
            :disabled="whitelistIsSaving"
            @click="removeWhitelistItem(item)"
            title="从白名单移除"
          >
            <X :size="11" :stroke-width="1.75" />
            <span>删除</span>
          </button>
        </div>
      </div>
      <div v-else class="pad-bash-status is-warn" style="margin-top: 8px">
        <Info :size="13" :stroke-width="1.75" />
        <span class="pad-bash-status-text">
          暂无白名单. 危险命令 (rm -rf / 等) 会被 LLM 拦截, 走改写命令路径.
        </span>
      </div>
    </div>

    <!-- v0.6 (N1+N2): 自动压缩开关 -->
    <div class="pad-general-section">
      <div class="pad-general-section-head">
        <Archive :size="16" :stroke-width="1.75" class="pad-general-section-icon" />
        <h3 class="pad-general-section-title">自动压缩</h3>
      </div>
      <p class="pad-general-section-desc">
        启用后，context 用到约 <strong>92%</strong>（200K 窗口下）自动压缩历史对话。
        关闭后，撑到 <strong>100%</strong> 才压缩（Pi SDK overflow 兜底触发，更激进，可能直接报错）。
      </p>
      <label class="pad-general-toggle" :class="{ 'is-disabled': !isReady }">
        <span class="pad-general-toggle-text">
          {{ autoCompactionEnabled ? '已启用' : '已关闭' }}
          <span v-if="isSaving" class="pad-general-toggle-saving">保存中…</span>
        </span>
        <span class="pad-general-toggle-switch" :class="{ 'is-on': autoCompactionEnabled }">
          <input
            type="checkbox"
            v-model="autoCompactionEnabled"
            :disabled="!isReady"
            @change="onToggle"
          />
          <span class="pad-general-toggle-knob"></span>
        </span>
      </label>
      <div class="pad-general-info">
        <Info :size="13" :stroke-width="1.75" />
        <span>
          <strong>生效时机：</strong>
          <ul style="margin: 4px 0 0 0; padding-left: 18px;">
            <li>如果当前有 active session → <strong>该 session 立即生效</strong>（Pi SDK 内存热更新）</li>
            <li>其他闲置 session → 下次发 prompt 启新 sidecar 时读 settings 自动生效</li>
          </ul>
          <br />
          <strong>Pi SDK 0.84.2 限制：</strong>触发阈值（92%）和保留 token 数（reserveTokens=16384）由 Pi SDK 内部写死，
          <strong>暂不能在 UI 调整</strong>。详见 <code>ADR-0016</code>。
        </span>
      </div>
    </div>

    <!-- 后续扩展: 语言 / 时区 / 默认 workspace / 启动行为等 -->
    <div class="pad-general-section is-placeholder">
      <p class="pad-general-placeholder-text">
        后续扩展：语言、时区、默认 workspace、启动行为等会在这个 tab 出现。
      </p>
    </div>
  </div>
</template>

<style scoped>
.pad-general-tab {
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: 4px;
}

.pad-general-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px;
  background: var(--pad-card);
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-md, 10px);
}
.pad-general-section.is-placeholder {
  background: transparent;
  border: 1px dashed var(--pad-border-subtle, rgba(0, 0, 0, 0.06));
  align-items: center;
  text-align: center;
}

.pad-general-section-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.pad-general-section-icon {
  color: var(--pad-fg-tertiary, #71717a);
}
.pad-general-section-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--pad-fg-primary);
  margin: 0;
}
.pad-general-section-desc {
  font-size: 12px;
  color: var(--pad-fg-secondary, #52525b);
  line-height: var(--pad-lh-relaxed, 1.6);
  margin: 0;
}

.pad-general-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  background: var(--pad-bg-secondary, rgba(0, 0, 0, 0.03));
  border-radius: var(--pad-radius-md, 8px);
  cursor: pointer;
  user-select: none;
  transition: background var(--pad-dur-fast, 0.15s) ease;
}
.pad-general-toggle:hover:not(.is-disabled) {
  background: var(--pad-bg-hover, rgba(0, 0, 0, 0.06));
}
.pad-general-toggle.is-disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.pad-general-toggle-text {
  font-size: 13px;
  color: var(--pad-fg-primary);
  font-weight: 500;
  display: flex;
  align-items: center;
  gap: 8px;
}
.pad-general-toggle-saving {
  font-size: 11px;
  color: var(--pad-fg-tertiary, #71717a);
  font-weight: 400;
}

/* iOS-style toggle switch */
.pad-general-toggle-switch {
  position: relative;
  width: 36px;
  height: 20px;
  background: var(--pad-border, #d4d4d8);
  border-radius: 999px;
  transition: background var(--pad-dur-fast, 0.15s) ease;
  flex-shrink: 0;
}
.pad-general-toggle-switch.is-on {
  background: var(--pad-accent-primary, #6366f1);
}
.pad-general-toggle-switch input {
  position: absolute;
  opacity: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  cursor: pointer;
  z-index: 1;
}
.pad-general-toggle-knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  background: white;
  border-radius: 50%;
  transition: transform var(--pad-dur-fast, 0.15s) ease;
  pointer-events: none;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.15);
}
.pad-general-toggle-switch.is-on .pad-general-toggle-knob {
  transform: translateX(16px);
}

.pad-general-info {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 10px 12px;
  background: var(--pad-bg-secondary, rgba(0, 0, 0, 0.03));
  border-radius: var(--pad-radius-sm, 6px);
  font-size: 11px;
  color: var(--pad-fg-tertiary, #71717a);
  line-height: var(--pad-lh-relaxed, 1.6);
}
.pad-general-info :deep(svg) {
  flex-shrink: 0;
  margin-top: 2px;
  color: var(--pad-fg-tertiary, #71717a);
}
.pad-general-info code {
  font-family: ui-monospace, monospace;
  font-size: 10px;
  padding: 1px 4px;
  background: var(--pad-bg-hover, rgba(0, 0, 0, 0.06));
  border-radius: 3px;
}

.pad-general-placeholder-text {
  font-size: 12px;
  color: var(--pad-fg-tertiary, #71717a);
  font-style: italic;
  margin: 0;
}

/* ====== ADR-0019 P0-1 (2026-08-23): Bash 路径 section 样式 ====== */
.pad-general-section-tag {
  font-size: 10px;
  padding: 2px 8px;
  border-radius: 999px;
  font-weight: 500;
  letter-spacing: 0.02em;
  margin-left: auto;
}
.pad-general-section-tag.is-auto {
  background: color-mix(in srgb, var(--pad-accent-primary, #6366f1) 14%, transparent);
  color: var(--pad-accent-primary, #6366f1);
}
.pad-general-section-tag.is-manual {
  background: color-mix(in srgb, #16a34a 14%, transparent);
  color: #16a34a;
}

.pad-bash-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.pad-bash-input {
  flex: 1;
  min-width: 280px;
  padding: 6px 10px;
  background: var(--pad-bg-input, var(--pad-card));
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-sm, 6px);
  font-family: var(--pad-font-mono, ui-monospace, monospace);
  font-size: 12px;
  color: var(--pad-fg-primary);
  transition: border-color var(--pad-dur-fast, 0.15s) ease;
}
.pad-bash-input:focus {
  outline: none;
  border-color: var(--pad-accent-primary, #6366f1);
}
.pad-bash-input:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.pad-general-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 10px;
  background: transparent;
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-sm, 6px);
  font-size: 12px;
  color: var(--pad-fg-secondary, #52525b);
  cursor: pointer;
  font-family: inherit;
  transition: all var(--pad-dur-fast, 0.15s) ease;
  white-space: nowrap;
}
.pad-general-btn:hover:not(:disabled) {
  background: var(--pad-bg-hover, rgba(0, 0, 0, 0.06));
  color: var(--pad-fg-primary);
}
.pad-general-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.pad-general-btn--primary {
  background: var(--pad-accent-primary, #6366f1);
  color: white;
  border-color: var(--pad-accent-primary, #6366f1);
}
.pad-general-btn--primary:hover:not(:disabled) {
  background: var(--pad-accent-hover, #4f46e5);
  border-color: var(--pad-accent-hover, #4f46e5);
  color: white;
}
.pad-general-btn--danger:hover:not(:disabled) {
  color: #dc2626;
  border-color: #dc2626;
}

.pad-bash-status {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  font-size: 12px;
  color: var(--pad-fg-secondary, #52525b);
  background: var(--pad-bg-secondary, rgba(0, 0, 0, 0.03));
  border-radius: var(--pad-radius-sm, 6px);
}
.pad-bash-status.is-warn {
  background: color-mix(in srgb, #f59e0b 12%, transparent);
  color: #f59e0b;
}
.pad-bash-status-ok {
  color: #16a34a;
  flex-shrink: 0;
}
.pad-bash-status-fail {
  color: #dc2626;
  flex-shrink: 0;
}
.pad-bash-status-text {
  font-family: var(--pad-font-mono, ui-monospace, monospace);
  font-size: 11px;
}
.pad-bash-status-sep {
  margin: 0 4px;
  opacity: 0.4;
}

.pad-bash-candidates {
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-sm, 6px);
  background: var(--pad-bg-secondary, rgba(0, 0, 0, 0.02));
  overflow: hidden;
}
.pad-bash-candidates-summary {
  padding: 8px 10px;
  font-size: 12px;
  color: var(--pad-fg-secondary, #52525b);
  cursor: pointer;
  user-select: none;
  list-style: none;
  display: flex;
  align-items: center;
  gap: 4px;
}
.pad-bash-candidates-summary::-webkit-details-marker {
  display: none;
}
.pad-bash-candidates-summary::before {
  content: '▶';
  font-size: 8px;
  color: var(--pad-fg-tertiary, #71717a);
  transition: transform var(--pad-dur-fast, 0.15s) ease;
}
.pad-bash-candidates[open] .pad-bash-candidates-summary::before {
  transform: rotate(90deg);
}
.pad-bash-candidates-list {
  list-style: none;
  margin: 0;
  padding: 0;
  border-top: 1px solid var(--pad-border);
}
.pad-bash-candidate {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 12px;
  font-size: 11px;
  cursor: pointer;
  border-bottom: 1px solid var(--pad-border);
  transition: background var(--pad-dur-fast, 0.15s) ease;
}
.pad-bash-candidate:last-child {
  border-bottom: none;
}
.pad-bash-candidate:hover {
  background: var(--pad-bg-hover, rgba(0, 0, 0, 0.05));
}
.pad-bash-candidate.is-active {
  background: color-mix(in srgb, var(--pad-accent-primary, #6366f1) 10%, transparent);
}
.pad-bash-candidate-type {
  font-weight: 600;
  font-family: var(--pad-font-mono, ui-monospace, monospace);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 1px 6px;
  background: var(--pad-bg-hover, rgba(0, 0, 0, 0.06));
  border-radius: 3px;
  min-width: 56px;
  text-align: center;
  color: var(--pad-fg-secondary, #52525b);
}
.pad-bash-candidate-path {
  flex: 1;
  font-family: var(--pad-font-mono, ui-monospace, monospace);
  font-size: 11px;
  color: var(--pad-fg-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pad-bash-candidate-source {
  font-size: 10px;
  color: var(--pad-fg-tertiary, #71717a);
  font-family: var(--pad-font-mono, ui-monospace, monospace);
  flex-shrink: 0;
}

.pad-bash-error {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 6px 10px;
  font-size: 11px;
  color: #dc2626;
  background: color-mix(in srgb, #dc2626 10%, transparent);
  border-radius: var(--pad-radius-sm, 6px);
  font-family: var(--pad-font-mono, ui-monospace, monospace);
}
</style>
