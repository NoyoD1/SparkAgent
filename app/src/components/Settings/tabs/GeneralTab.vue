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
import { piTauri } from '@/lib/tauri';
import { Archive, Info } from 'lucide-vue-next';

const sessionStore = useSessionStore();
const uiStore = useUiStore();

const autoCompactionEnabled = ref(true);
const isLoading = ref(false);
const isSaving = ref(false);
const isReady = computed(() => !isLoading.value && !isSaving.value);

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
onMounted(loadInitial);
</script>

<template>
  <div class="pad-general-tab">
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
</style>
