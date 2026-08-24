<script setup lang="ts">
/**
 * ProviderTab — v0.3.8+ 重构
 *
 * 设计:
 * - 左侧"内置供应商" 7 个 (Anthropic / OpenAI / DeepSeek / Moonshot / Google / Groq / MiniMax)
 *   总是显示, 不需要"添加"步骤. 状态点: 绿=已配 key + active model, 灰=未配.
 *   点未配 → 弹 key 输入框, 配完自动建 provider + 设 active.
 *   点已配 → 右边详情 (key preview, model 列表, 删除等).
 *
 * - 左侧"自定义" (openai-compatible) 单独一节, 底部"+ 添加自定义"按钮.
 *   用户自填 baseUrl + key + label, 走原来 AddProviderForm 流程.
 *
 * - 持久化: provider config 走 Rust (load_app_config / save_app_config), apiKey 走 OS keychain.
 *   跟 WebView2 localStorage 解耦 — 清 WebView2 缓存不会丢配置.
 */
import { ref, computed, onMounted } from 'vue';
import {
  Plus, Trash2, RefreshCw, KeyRound, Server, Save, Settings,
} from 'lucide-vue-next';
import {
  useConfigStore, PROVIDER_OPTIONS, THINKING_LEVELS,
  type ProviderConfig, type ProviderType, type ModelInfo,
} from '@/stores/config';
import { fetchProviderModels } from '@/lib/providers-api';
import { piTauri } from '@/lib/tauri';
import { useSessionStore } from '@/stores/session';
import AddProviderForm from './AddProviderForm.vue';
import ConfirmDialog from '@/components/Common/ConfirmDialog.vue';

const config = useConfigStore();

/** 视图状态: 'list' | 'add-custom' */
const viewMode = ref<'list' | 'add'>('list');
/** 左侧选中项的 id: built-in 用 PROVIDER_OPTIONS.id (e.g. 'anthropic'), custom 用 config.providers[].id */
const selection = ref<{ kind: 'builtin'; type: ProviderType } | { kind: 'provider'; id: string } | null>(null);

/** keychain 状态: providerId -> { configured, preview } */
const keyStatus = ref<Record<string, { configured: boolean; preview: string | null }>>({});

/** 内置 provider 的 key 输入 */
const newBuiltinKey = ref<string>('');
const builtinKeyState = ref<'idle' | 'saving' | 'fail'>('idle');
const builtinKeyMsg = ref<string>('');

/** 当前选中 provider 的状态 */
const fetchState = ref<'idle' | 'fetching' | 'ok' | 'fail'>('idle');
const fetchMessage = ref<string>('');
const keyState = ref<'idle' | 'saving' | 'deleting'>('idle');
const keyMessage = ref<string>('');
const newKeyInput = ref<string>('');
const newModelInput = ref<string>('');

// P0 #1: 测试连接 (现有 provider 详情面板, 不动 key 也能测)
const testState = ref<'idle' | 'testing' | 'ok' | 'fail'>('idle');
const testMessage = ref<string>('');

// P1 #1: ConfirmDialog 状态 (替代 window.confirm/alert, 统一风格)
const confirmState = ref<{
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  danger: boolean;
  onConfirm: (() => void) | null;
  onCancel: (() => void) | null;
}>({
  open: false,
  title: '',
  message: '',
  confirmLabel: '确定',
  cancelLabel: '取消',
  danger: false,
  onConfirm: null,
  onCancel: null,
});

/** P1 #1: 显示 confirm 弹窗. 返回 Promise<boolean>. */
function showConfirm(opts: {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}): Promise<boolean> {
  return new Promise((resolve) => {
    confirmState.value = {
      open: true,
      title: opts.title,
      message: opts.message,
      confirmLabel: opts.confirmLabel ?? '确定',
      cancelLabel: opts.cancelLabel ?? '取消',
      danger: opts.danger ?? false,
      onConfirm: () => resolve(true),
      onCancel: () => resolve(false),
    };
  });
}

// v0.4.4.6: model metadata form (per-model 配置 5 字段: type / vision / contextWindow / maxOutput / maxRounds / reasoning)
const editingMetadataModelId = ref<string | null>(null);
// P1 #2: 校验 metadata 数字字段 (提前定义, cancelMetadataForm 引用)
const metadataFormError = ref<string>('');
const metadataForm = ref<{
  type: 'chat' | 'image' | 'video' | 'audio' | 'embedding';
  vision: boolean;
  contextWindow: number | null;
  maxOutput: number | null;
  maxRounds: number | null;
  reasoning: boolean;
}>({
  type: 'chat',
  vision: false,
  contextWindow: null,
  maxOutput: null,
  maxRounds: null,
  reasoning: false,
});

function openMetadataForm(model: ModelInfo) {
  // 复制当前 metadata 到 form (form 内部用 null 表示 "未设")
  metadataForm.value = {
    type: model.type ?? 'chat',
    vision: model.vision ?? false,
    contextWindow: model.contextWindow ?? null,
    maxOutput: model.maxOutput ?? null,
    maxRounds: model.maxRounds ?? null,
    reasoning: model.reasoning ?? false,
  };
  editingMetadataModelId.value = model.id;
}
function cancelMetadataForm() {
  editingMetadataModelId.value = null;
  metadataFormError.value = '';
}

/** P1 #2: 校验 metadata form 当前值, 返回第一个错误信息 (空 = 通过) */
function validateMetadataForm(): string {
  const f = metadataForm.value;
  if (f.contextWindow !== null && (!Number.isFinite(f.contextWindow) || f.contextWindow <= 0)) {
    return 'contextWindow 必须 > 0 (单位: tokens)';
  }
  if (f.maxOutput !== null && (!Number.isFinite(f.maxOutput) || f.maxOutput <= 0)) {
    return 'maxOutput 必须 > 0 (单位: tokens)';
  }
  if (f.maxRounds !== null && (!Number.isFinite(f.maxRounds) || f.maxRounds < 1)) {
    return 'maxRounds 必须 ≥ 1 (最大连续 tool call 轮数)';
  }
  if (f.contextWindow !== null && f.contextWindow > 10_000_000) {
    return 'contextWindow 太大 (上限 10M tokens)';
  }
  if (f.maxOutput !== null && f.maxOutput > 1_000_000) {
    return 'maxOutput 太大 (上限 1M tokens)';
  }
  if (f.maxRounds !== null && f.maxRounds > 100) {
    return 'maxRounds 太大 (上限 100 轮)';
  }
  // 关系校验: contextWindow ≥ maxOutput
  if (f.contextWindow !== null && f.maxOutput !== null && f.contextWindow < f.maxOutput) {
    return `contextWindow (${f.contextWindow}) 不能小于 maxOutput (${f.maxOutput})`;
  }
  return '';
}

function saveMetadata(modelId: string) {
  if (!selectedProvider.value) return;
  const err = validateMetadataForm();
  if (err) {
    metadataFormError.value = err;
    return;
  }
  metadataFormError.value = '';
  config.updateModelMetadata(selectedProvider.value.id, modelId, {
    type: metadataForm.value.type,
    vision: metadataForm.value.vision,
    contextWindow: metadataForm.value.contextWindow ?? undefined,
    maxOutput: metadataForm.value.maxOutput ?? undefined,
    maxRounds: metadataForm.value.maxRounds ?? undefined,
    reasoning: metadataForm.value.reasoning,
  });
  editingMetadataModelId.value = null;
  fetchState.value = 'ok';
  fetchMessage.value = `已更新 model ${modelId} metadata`;
}

/** 派生 */
const builtinOptions = computed(() => PROVIDER_OPTIONS.filter((o) => o.builtin));

/** 用户已经配置的 provider (含自定义) */
const allProviders = computed(() => config.providers);

/** 哪个内置 type 已经有 provider (用 type 配) */
const builtinProviderByType = computed<Record<string, ProviderConfig | null>>(() => {
  const map: Record<string, ProviderConfig | null> = {};
  for (const opt of builtinOptions.value) {
    map[opt.id] = allProviders.value.find((p) => p.type === opt.id) ?? null;
  }
  return map;
});

/** 用户自定义的 provider (type = 'openai-compatible') */
const customProviders = computed(() =>
  allProviders.value.filter((p) => p.type === 'openai-compatible'),
);

/** 当前右栏要展示什么 */
interface RightPanel {
  mode: 'empty' | 'builtin-unconfigured' | 'provider' | 'add-custom';
  /** builtin-unconfigured 时用 */
  builtinType?: ProviderType;
  /** provider 时用 */
  provider?: ProviderConfig;
}
const rightPanel = computed<RightPanel>(() => {
  if (viewMode.value === 'add') return { mode: 'add-custom' };
  if (!selection.value) return { mode: 'empty' };
  if (selection.value.kind === 'builtin') {
    const t = selection.value.type;
    const existing = builtinProviderByType.value[t];
    if (existing) return { mode: 'provider', provider: existing };
    return { mode: 'builtin-unconfigured', builtinType: t };
  }
  // provider 选中: selection.value.id 是 ProviderConfig.id
  const p = allProviders.value.find((x) => x.id === (selection.value as { kind: 'provider'; id: string }).id);
  if (p) return { mode: 'provider', provider: p };
  return { mode: 'empty' };
});

/** 当前 provider 选中 */
const selectedProvider = computed<ProviderConfig | null>(() => {
  if (rightPanel.value.mode === 'provider') return rightPanel.value.provider ?? null;
  return null;
});

const currentBuiltinType = computed<ProviderType | null>(() => {
  if (rightPanel.value.mode === 'builtin-unconfigured') return rightPanel.value.builtinType ?? null;
  return null;
});

const currentKeyStatus = computed(() => {
  const p = selectedProvider.value;
  if (!p) return null;
  return keyStatus.value[p.id] ?? null;
});

const isOpenAICompatible = computed(() => selectedProvider.value?.type === 'openai-compatible');

/** 选中时刷新 (内置未配 / 已配) */
function selectBuiltin(type: ProviderType) {
  viewMode.value = 'list';
  selection.value = { kind: 'builtin', type };
  resetForms();
}
function selectProvider(id: string) {
  viewMode.value = 'list';
  selection.value = { kind: 'provider', id };
  resetForms();
}
function resetForms() {
  builtinKeyState.value = 'idle';
  builtinKeyMsg.value = '';
  newBuiltinKey.value = '';
  fetchState.value = 'idle';
  fetchMessage.value = '';
  keyState.value = 'idle';
  keyMessage.value = '';
  newKeyInput.value = '';
  newModelInput.value = '';
  testState.value = 'idle';
  testMessage.value = '';
}

onMounted(async () => {
  await refreshAllKeyStatus();
});

async function refreshAllKeyStatus() {
  try {
    const list = await piTauri.listApiKeys();
    const next: Record<string, { configured: boolean; preview: string | null }> = {};
    for (const k of list) {
      next[k.providerId] = { configured: k.configured, preview: k.preview };
    }
    keyStatus.value = next;
  } catch (e) {
    console.error('[provider-tab] listApiKeys failed', e);
  }
}

/** ====== 内置 provider: 配 key ====== */
async function configureBuiltin() {
  if (!currentBuiltinType.value) return;
  if (!newBuiltinKey.value.trim()) {
    builtinKeyState.value = 'fail';
    builtinKeyMsg.value = 'API key 不能为空';
    return;
  }
  builtinKeyState.value = 'saving';
  builtinKeyMsg.value = '存 keychain…';
  const t = currentBuiltinType.value;
  try {
    // 1. 建 provider (还没存 model, 先建个空壳)
    const provider = config.addProvider({ type: t });
    // 2. 存 keychain
    await piTauri.saveApiKey(provider.id, newBuiltinKey.value.trim());
    // 3. 设为 active provider
    config.setActiveProvider(provider.id);
    // 4. 刷新
    await refreshAllKeyStatus();
    newBuiltinKey.value = '';
    builtinKeyState.value = 'idle';
    builtinKeyMsg.value = '';
    // 5. 切到详情面板
    selection.value = { kind: 'provider', id: provider.id };
    // 6. 2026-08-24 v3.28: 内置 provider 删了, 不再 BUILTIN_MODELS 预填. 让 user 自己在详情
    //   面板选 model (或者之前已经存了 model 的 user config 不动).
  } catch (e) {
    builtinKeyState.value = 'fail';
    builtinKeyMsg.value = e instanceof Error ? e.message : String(e);
  }
}

/** ====== provider 详情操作 ====== */
async function saveKey() {
  if (!selectedProvider.value) return;
  if (!newKeyInput.value.trim()) {
    keyMessage.value = 'key 不能为空';
    return;
  }
  keyState.value = 'saving';
  keyMessage.value = '存 keychain…';
  try {
    await piTauri.saveApiKey(selectedProvider.value.id, newKeyInput.value.trim());
    newKeyInput.value = '';
    keyState.value = 'idle';
    keyMessage.value = '已存 OS keychain';
    await refreshAllKeyStatus();
    setTimeout(() => { keyMessage.value = ''; }, 2000);
  } catch (e) {
    keyState.value = 'idle';
    keyMessage.value = e instanceof Error ? e.message : String(e);
  }
}

async function deleteKey() {
  if (!selectedProvider.value) return;
  // P1 #1: 用 ConfirmDialog 替代 window.confirm
  const ok = await showConfirm({
    title: '删除 API key',
    message: `从 OS keychain 删除 ${selectedProvider.value.label} 的 API key? (provider 配置会保留, 只是断开 key)`,
    confirmLabel: '删除',
    danger: true,
  });
  if (!ok) return;
  keyState.value = 'deleting';
  keyMessage.value = '删 keychain…';
  try {
    await piTauri.deleteApiKey(selectedProvider.value.id);
    keyState.value = 'idle';
    keyMessage.value = '已从 keychain 删除';
    await refreshAllKeyStatus();
    setTimeout(() => { keyMessage.value = ''; }, 2000);
  } catch (e) {
    keyState.value = 'idle';
    keyMessage.value = e instanceof Error ? e.message : String(e);
  }
}

async function testConnection() {
  if (!selectedProvider.value) return;
  const p = selectedProvider.value;
  const status = keyStatus.value[p.id];
  if (!status?.configured) {
    testState.value = 'fail';
    testMessage.value = '需要先配 key (存到 keychain)';
    return;
  }
  testState.value = 'testing';
  testMessage.value = '测试中…';
  try {
    const result = await piTauri.verifyProviderConnection({
      providerId: p.id,
      providerType: p.type,
      baseUrl: p.baseUrl ?? '',
    });
    testState.value = result.ok ? 'ok' : 'fail';
    testMessage.value = result.message;
  } catch (e) {
    testState.value = 'fail';
    testMessage.value = e instanceof Error ? e.message : String(e);
  }
}

async function removeProvider(provider: ProviderConfig) {
  // v0.5.0-PR2: 删的如果是当前 active, 提示 user input box 会回退
  // P0 #4 fix: 删 active 之前, 先算 fallback. 如果 fallback 不可用 (没 key / 没选 model),
  //   阻止删除并提示 user 先配置 fallback, 避免删完啥也发不出去.
  // P1 #1: 用 ConfirmDialog 替代 window.confirm/alert
  if (provider.id === config.activeProviderId) {
    const remaining = config.providers.filter((p) => p.id !== provider.id);
    if (remaining.length === 0) {
      const ok = await showConfirm({
        title: '删除最后一个 provider',
        message: `"${provider.label}" 是当前正在使用的 provider, 也是唯一一个. 删除后将没有任何 active provider, 需要重新配置后才能发消息. 继续?`,
        confirmLabel: '仍然删除',
        danger: true,
      });
      if (!ok) return;
    } else {
      const fallback = remaining[0];
      const fallbackKeyOk = keyStatus.value[fallback.id]?.configured === true;
      const fallbackModelOk = !!fallback.activeModelId;
      if (!fallbackKeyOk || !fallbackModelOk) {
        const reasons: string[] = [];
        if (!fallbackKeyOk) reasons.push('未配置 API key');
        if (!fallbackModelOk) reasons.push('未选择 active model');
        await showConfirm({
          title: '无法删除',
          message: `删除 "${provider.label}" 后会 fallback 到 "${fallback.label}", 但它${reasons.join('、')}, 会导致发不出消息.\n\n请先配置好 fallback 再删.`,
          confirmLabel: '我知道了',
          cancelLabel: '',
          danger: true,
        });
        return;
      }
      const ok = await showConfirm({
        title: '删除当前 provider',
        message: `"${provider.label}" 是当前正在使用的 provider, 确定删除? 删除后 input box 会回退到 "${fallback.label}".`,
        confirmLabel: '删除',
        danger: true,
      });
      if (!ok) return;
    }
  } else {
    const ok = await showConfirm({
      title: '删除 provider',
      message: `确定删除 "${provider.label}"? 会清除这个 provider 的本地 config + keychain 里的 key.`,
      confirmLabel: '删除',
      danger: true,
    });
    if (!ok) return;
  }
  // P1 #6 fix: 顺序改为先删 keychain, 成功后再删 config, 失败回滚提示 user
  try {
    await piTauri.deleteApiKey(provider.id);
  } catch (e) {
    console.error('[ProviderTab] deleteApiKey failed:', e);
    await showConfirm({
      title: '删除 keychain 失败',
      message: `从 OS keychain 删除 API key 失败: ${e instanceof Error ? e.message : String(e)}\n\nprovider 配置已保留, keychain 里的 key 可能成孤儿. 请去系统凭据管理器手动清理.`,
      confirmLabel: '我知道了',
      cancelLabel: '',
      danger: true,
    });
    return;
  }
  config.removeProvider(provider.id);
  void refreshAllKeyStatus();
  // 选回这个 type 对应的 builtin (新建或重选)
  if (provider.type === 'openai-compatible') {
    selection.value = null;
  } else {
    selection.value = { kind: 'builtin', type: provider.type };
  }
}

function isModelEnabled(m: ModelInfo): boolean {
  return m.enabled !== false;
}

function addCustomModel() {
  if (!selectedProvider.value) return;
  const id = newModelInput.value.trim();
  if (!id) return;
  // P2 #3 fix: 重复 id 提示, 不再静默吞. 之前用户加重复 model 不知道是没加成功还是已经在了.
  const existing = selectedProvider.value.models.find((m) => m.id === id);
  if (existing) {
    fetchState.value = 'fail';
    fetchMessage.value = `model "${id}" 已存在, 不用重复加`;
    return;
  }
  config.setProviderModels(selectedProvider.value.id, [
    ...selectedProvider.value.models,
    { id, label: undefined, enabled: true, fetchedAt: new Date().toISOString() },
  ]);
  newModelInput.value = '';
  fetchState.value = 'ok';
  fetchMessage.value = `已添加 model ${id}`;
}

async function removeModel(modelId: string) {
  if (!selectedProvider.value) return;
  const p = selectedProvider.value;
  // v0.5.0-PR2: 删的如果是当前 active, 提示 user — setProviderModels 会自动清 activeModelId, 下次 send 会用第一个 enabled
  if (p.id === config.activeProviderId && p.activeModelId === modelId) {
    // P1 #1: 用 ConfirmDialog 替代 window.confirm
    const ok = await showConfirm({
      title: '删除当前 model',
      message: `"${modelId}" 是当前正在使用的 model, 确定删除? 删除后下次发送会自动用这个 provider 的第一个 enabled model.`,
      confirmLabel: '删除',
      danger: true,
    });
    if (!ok) return;
  }
  const next = p.models.filter((m) => m.id !== modelId);
  config.setProviderModels(p.id, next);
}

async function fetchModels(provider: ProviderConfig) {
  if (provider.type === 'openai-compatible' && !provider.baseUrl) {
    fetchState.value = 'fail';
    fetchMessage.value = 'OpenAI 兼容需要填 baseUrl';
    return;
  }
  const status = keyStatus.value[provider.id];
  if (!status?.configured) {
    fetchState.value = 'fail';
    fetchMessage.value = '需要先在 API Key 段保存 key (存 OS keychain)';
    return;
  }
  fetchState.value = 'fetching';
  fetchMessage.value = '';
  try {
    const data = await fetchProviderModels({
      type: provider.type,
      providerId: provider.id,
      baseUrl: provider.type === 'openai-compatible' ? provider.baseUrl : undefined,
    });
    if (data.ok && data.models) {
      config.setProviderModels(provider.id, data.models);
      fetchState.value = 'ok';
      fetchMessage.value = `拉到 ${data.models.length} 个模型`;
    } else {
      fetchState.value = 'fail';
      fetchMessage.value = data.error ?? 'fetch 失败';
    }
  } catch (e) {
    fetchState.value = 'fail';
    fetchMessage.value = e instanceof Error ? e.message : String(e);
  }
}

function setThinking(level: 'off' | 'low' | 'medium' | 'high') {
  config.setThinkingLevel(level);
  // P0 #2 fix: 实时同步到运行中的 sidecar (通过 Pi SDK RpcCommand set_thinking_level).
  // 之前只在 session 创建时传一次, 中途切只对下一轮生效.
  const sessionStore = useSessionStore();
  const sid = sessionStore.activeSessionId;
  if (sid) {
    piTauri.sendRpcCommand(sid, { type: 'set_thinking_level', level }).catch((e) => {
      console.warn('[ProviderTab] set_thinking_level RpcCommand 发送失败 (忽略, 下轮 prompt 会用新值):', e);
    });
  }
}

function openAddCustom() {
  viewMode.value = 'add';
  selection.value = null;
}

function closeAddCustom() {
  viewMode.value = 'list';
}

function onProviderAdded(id: string) {
  viewMode.value = 'list';
  selection.value = { kind: 'provider', id };
  void refreshAllKeyStatus();
}
</script>

<template>
  <div class="pad-providers">
    <div class="pad-providers__card">
      <!-- ===== LEFT: list ===== -->
      <aside class="pad-providers__list-col">
        <!-- 内置供应商 (始终显示) -->
        <div class="pad-providers__list-head">
          <span class="pad-providers__list-title">内置供应商</span>
        </div>
        <div class="pad-providers__list-inner">
          <button
            v-for="opt in builtinOptions"
            :key="opt.id"
            class="pad-provider-card"
            :class="{
              'is-selected': selection?.kind === 'builtin' && selection.type === opt.id,
              'is-configured': !!builtinProviderByType[opt.id],
            }"
            @click="selectBuiltin(opt.id)"
          >
            <div class="pad-provider-card__icon">
              <Server :size="14" :stroke-width="1.75" />
            </div>
            <div class="pad-provider-card__body">
              <div class="pad-provider-card__label">{{ opt.label }}</div>
              <div class="pad-provider-card__sub">
                <template v-if="builtinProviderByType[opt.id]">
                  {{ builtinProviderByType[opt.id]!.models.length }} 个模型 ·
                  {{ builtinProviderByType[opt.id]!.activeModelId ?? '未选 model' }}
                </template>
                <template v-else>未配置</template>
              </div>
            </div>
            <!-- key status dot -->
            <span
              class="pad-provider-card__dot"
              :class="{
                'is-configured': !!builtinProviderByType[opt.id],
                'is-active': config.activeProviderId === builtinProviderByType[opt.id]?.id,
              }"
            />
          </button>
        </div>

        <!-- 自定义供应商 (有的话才显示) -->
        <template v-if="customProviders.length > 0">
          <div class="pad-providers__list-head">
            <span class="pad-providers__list-title">自定义</span>
          </div>
          <div class="pad-providers__list-inner">
            <button
              v-for="p in customProviders"
              :key="p.id"
              class="pad-provider-card"
              :class="{
                'is-selected': selection?.kind === 'provider' && (selection as any).id === p.id,
                'is-configured': true,
              }"
              @click="selectProvider(p.id)"
            >
              <div class="pad-provider-card__icon">
                <Server :size="14" :stroke-width="1.75" />
              </div>
              <div class="pad-provider-card__body">
                <div class="pad-provider-card__label">{{ p.label }}</div>
                <div class="pad-provider-card__sub">
                  {{ p.models.length }} 个模型 · {{ p.baseUrl?.replace(/^https?:\/\//, '').slice(0, 24) ?? 'no baseUrl' }}
                </div>
              </div>
              <span
                class="pad-provider-card__dot"
                :class="{
                  'is-configured': true,
                  'is-active': config.activeProviderId === p.id,
                }"
              />
            </button>
          </div>
        </template>

        <button class="pad-providers__add" @click="openAddCustom">
          <Plus :size="14" :stroke-width="1.75" /> 添加自定义
        </button>
      </aside>

      <!-- ===== RIGHT: detail ===== -->
      <div class="pad-providers__detail">
        <!-- EMPTY -->
        <div v-if="rightPanel.mode === 'empty'" class="pad-providers__empty-detail">
          <KeyRound :size="28" :stroke-width="1.5" />
          <p>选一个 provider 看详情<br>或点左下"添加自定义"</p>
        </div>

        <!-- ADD CUSTOM -->
        <AddProviderForm
          v-else-if="rightPanel.mode === 'add-custom'"
          @close="closeAddCustom"
          @added="onProviderAdded"
        />

        <!-- BUILTIN UNCONFIGURED: 弹 key 输入 -->
        <div v-else-if="rightPanel.mode === 'builtin-unconfigured'" class="pad-provider-detail">
          <div class="pad-provider-detail__head">
            <div class="pad-provider-detail__head-icon">
              <Server :size="20" :stroke-width="1.5" />
            </div>
            <div>
              <h3 class="pad-provider-detail__head-title">
                {{ builtinOptions.find((o) => o.id === currentBuiltinType)?.label }}
              </h3>
              <p class="pad-provider-detail__head-sub">内置供应商, 输入 API Key 即可使用</p>
            </div>
          </div>

          <div class="pad-provider-detail__row">
            <div class="pad-provider-detail__row-label">
              <span>API Key</span>
              <span class="pad-provider-detail__hint">存 OS keychain (Windows Credential Manager / macOS Keychain / Linux Secret Service)</span>
            </div>
            <div class="pad-provider-detail__key-form">
              <input
                v-model="newBuiltinKey"
                class="pad-provider-detail__input pad-provider-detail__input--key"
                type="password"
                placeholder="sk-..."
                autocomplete="off"
                :disabled="builtinKeyState === 'saving'"
                @keyup.enter="configureBuiltin"
              />
              <button
                class="pad-provider-detail__btn pad-provider-detail__btn--primary"
                type="button"
                :disabled="builtinKeyState === 'saving' || !newBuiltinKey.trim()"
                @click="configureBuiltin"
              >
                <Save v-if="builtinKeyState !== 'saving'" :size="14" :stroke-width="1.75" />
                <span>{{ builtinKeyState === 'saving' ? '存中…' : '保存并激活' }}</span>
              </button>
            </div>
            <p v-if="builtinKeyMsg" class="pad-provider-detail__hint" :class="{ 'is-err': builtinKeyState === 'fail' }">
              {{ builtinKeyMsg }}
            </p>
            <p class="pad-provider-detail__hint">
              保存后会自动设为当前 active provider. v3.28: 内置 model 列表删了, 请在详情面板手动加 model id (或 baseUrl 是 openai-compatible 时点 '拉取模型' 自动填).
            </p>
          </div>
        </div>

        <!-- CONFIGURED PROVIDER (内置已配 / 自定义) -->
        <div v-else-if="rightPanel.mode === 'provider' && selectedProvider" class="pad-provider-detail">
          <!-- 头部: label + type + active 徽标 -->
          <div class="pad-provider-detail__head">
            <div class="pad-provider-detail__head-icon">
              <Server :size="20" :stroke-width="1.5" />
            </div>
            <div class="pad-provider-detail__head-body">
              <input
                class="pad-provider-detail__input pad-provider-detail__input--inline"
                type="text"
                :value="selectedProvider!.label"
                @input="config.updateProvider(selectedProvider!.id, { label: ($event.target as HTMLInputElement).value })"
              />
              <p class="pad-provider-detail__head-sub">
                {{ builtinOptions.find((o) => o.id === selectedProvider!.type)?.label ?? '自定义' }}
              </p>
            </div>
          </div>

          <!-- Type / baseUrl (openai-compatible 才有) -->
          <div v-if="isOpenAICompatible" class="pad-provider-detail__row">
            <div class="pad-provider-detail__row-label">
              <span>Base URL</span>
              <span class="pad-provider-detail__hint">如 https://token.sensenova.cn/v1</span>
            </div>
            <input
              class="pad-provider-detail__input"
              type="text"
              :value="selectedProvider!.baseUrl ?? ''"
              placeholder="https://your-proxy.com/v1"
              @input="config.updateProvider(selectedProvider!.id, { baseUrl: ($event.target as HTMLInputElement).value })"
            />
          </div>

          <!-- API Key (keychain) -->
          <div class="pad-provider-detail__row">
            <div class="pad-provider-detail__row-label">
              <span>API Key</span>
              <span class="pad-provider-detail__hint">存 OS keychain</span>
            </div>
            <div v-if="currentKeyStatus?.configured" class="pad-provider-detail__key-configured">
              <span class="pad-provider-detail__key-status">
                <span class="pad-provider-detail__key-dot" />
                已配置
              </span>
              <code class="pad-provider-detail__key-preview">{{ currentKeyStatus.preview }}</code>
              <button
                class="pad-provider-detail__btn pad-provider-detail__btn--small"
                type="button"
                :disabled="keyState === 'deleting'"
                @click="deleteKey"
              >删除</button>
            </div>
            <div v-else class="pad-provider-detail__key-form">
              <input
                v-model="newKeyInput"
                class="pad-provider-detail__input pad-provider-detail__input--key"
                type="password"
                placeholder="sk-..."
                autocomplete="off"
                @keyup.enter="saveKey"
              />
              <button
                class="pad-provider-detail__btn pad-provider-detail__btn--primary pad-provider-detail__btn--small"
                type="button"
                :disabled="keyState === 'saving' || !newKeyInput.trim()"
                @click="saveKey"
              >
                <Save v-if="keyState !== 'saving'" :size="12" :stroke-width="1.75" />
                <span>{{ keyState === 'saving' ? '存中…' : '存 keychain' }}</span>
              </button>
            </div>
            <p v-if="keyMessage" class="pad-provider-detail__hint" :class="{ 'is-err': keyState === 'idle' && keyMessage.includes('不能') }">
              {{ keyMessage }}
            </p>

            <!-- P0 #1: 测试连接 (keychain 配好 key 后才能测) -->
            <div v-if="currentKeyStatus?.configured" class="pad-provider-detail__row" style="margin-top: 8px;">
              <div class="pad-provider-detail__row-label">
                <span>连通性</span>
                <span class="pad-provider-detail__hint">
                  <template v-if="selectedProvider!.type === 'openai-compatible'">真实 HTTP 测试 ({{ selectedProvider!.baseUrl || 'no baseUrl' }})</template>
                  <template v-else>keychain 验证 (内置 provider 首次对话时验通)</template>
                </span>
              </div>
              <div class="pad-provider-detail__key-form">
                <button
                  class="pad-provider-detail__btn pad-provider-detail__btn--small"
                  type="button"
                  :disabled="testState === 'testing'"
                  @click="testConnection"
                >
                  <span v-if="testState === 'testing'">测试中…</span>
                  <span v-else>测试连接</span>
                </button>
              </div>
              <p
                v-if="testMessage"
                class="pad-provider-detail__hint"
                :class="{ 'is-err': testState === 'fail', 'is-ok': testState === 'ok' }"
              >
                {{ testMessage }}
              </p>
            </div>
          </div>

          <!-- Models -->
          <div class="pad-provider-detail__section">
            <div class="pad-provider-detail__section-head">
              <span class="pad-provider-detail__section-title">模型 ({{ selectedProvider!.models.length }})</span>
              <button
                v-if="isOpenAICompatible"
                class="pad-provider-detail__iconbtn"
                :disabled="fetchState === 'fetching'"
                title="从 provider 拉取模型"
                @click="fetchModels(selectedProvider!)"
              >
                <RefreshCw :size="14" :stroke-width="1.75" :class="{ 'is-spinning': fetchState === 'fetching' }" />
                <span>拉取</span>
              </button>
            </div>

            <!-- 自定义 model id 输入 (任何 provider 都能用) -->
            <div class="pad-provider-detail__addmodel">
              <input
                v-model="newModelInput"
                class="pad-provider-detail__input pad-provider-detail__input--inline"
                type="text"
                :placeholder="isOpenAICompatible ? '或手输 model id' : '或手输 model id (如 claude-3-5-sonnet-latest)'"
                @keyup.enter="addCustomModel"
              />
              <button
                class="pad-provider-detail__btn pad-provider-detail__btn--small"
                type="button"
                :disabled="!newModelInput.trim()"
                @click="addCustomModel"
              >
                <Plus :size="12" :stroke-width="1.75" /> 添加
              </button>
            </div>

            <div v-if="selectedProvider!.models.length === 0" class="pad-provider-detail__models-empty">
              还没模型. {{ isOpenAICompatible ? '点"拉取" 或手输 model id.' : '从下方预填列表选, 或手输 id.' }}
            </div>
            <div v-else class="pad-provider-detail__models">
              <template v-for="m in selectedProvider!.models" :key="m.id">
                <label
                  class="pad-provider-detail__model"
                  :class="{
                    'is-current': config.activeProviderId === selectedProvider!.id && config.activeProvider?.activeModelId === m.id,
                    'is-disabled': !isModelEnabled(m),
                  }"
                >
                  <input
                    type="checkbox"
                    class="pad-provider-detail__model-toggle"
                    :checked="isModelEnabled(m)"
                    @change="config.toggleModelEnabled(selectedProvider!.id, m.id)"
                  />
                  <div class="pad-provider-detail__model-body">
                    <div class="pad-provider-detail__model-id">{{ m.id }}</div>
                    <div v-if="m.label" class="pad-provider-detail__model-label">{{ m.label }}</div>
                    <!-- v0.4.4.6: metadata 摘要 (type / vision / ctx / maxOut / maxRounds / reasoning 已设的项) -->
                    <!-- v0.5.0-D D213: autoSource 有值时加 ✨ 角标, 让用户知道哪些字段是自动填的 -->
                    <div v-if="m.type || m.vision || m.contextWindow || m.maxOutput || m.maxRounds || m.reasoning" class="pad-provider-detail__model-meta">
                      <span v-if="m.type" class="pad-provider-detail__model-meta-tag" :class="{ 'is-auto': m.autoSource }">
                        <template v-if="m.autoSource">✨ </template>{{ m.type }}
                      </span>
                      <span v-if="m.vision" class="pad-provider-detail__model-meta-tag" :class="{ 'is-auto': m.autoSource }">
                        <template v-if="m.autoSource">✨ </template>vision
                      </span>
                      <span v-if="m.contextWindow" class="pad-provider-detail__model-meta-tag" :class="{ 'is-auto': m.autoSource }">
                        <template v-if="m.autoSource">✨ </template>{{ Math.round(m.contextWindow / 1000) }}K ctx
                      </span>
                      <span v-if="m.maxOutput" class="pad-provider-detail__model-meta-tag" :class="{ 'is-auto': m.autoSource }">
                        <template v-if="m.autoSource">✨ </template>{{ Math.round(m.maxOutput / 1000) }}K out
                      </span>
                      <span v-if="m.maxRounds" class="pad-provider-detail__model-meta-tag">rounds≤{{ m.maxRounds }}</span>
                      <span v-if="m.reasoning" class="pad-provider-detail__model-meta-tag" :class="{ 'is-auto': m.autoSource }">
                        <template v-if="m.autoSource">✨ </template>reasoning
                      </span>
                    </div>
                  </div>
                  <!-- v0.5.0-PR2: current 标识 (只读, 跟 input box 同步 — 全局 activeProviderId + activeModelId 决定的) -->
                  <span
                    v-if="config.activeProviderId === selectedProvider!.id && config.activeProvider?.activeModelId === m.id"
                    class="pad-provider-detail__model-current-tag"
                    title="当前正在 input box 使用的 model (在 chat 输入框点其他 model 即可切换)"
                  >当前</span>
                  <!-- Phase 二阶段 B4: 已停用 badge (model.enabled === false). 跟 current tag 同样尺寸,
                       灰底配 tertiary 文字, 跟 current 绿底对比明显, 不会被误以为是"被选过" -->
                  <span
                    v-else-if="!isModelEnabled(m)"
                    class="pad-provider-detail__model-disabled-tag"
                    title="此 model 已停用, 不会出现在 chat 输入框的 model 选择列表里. 勾选左侧 checkbox 重新启用."
                  >已停用</span>
                  <button
                    class="pad-provider-detail__model-config"
                    type="button"
                    title="配置 model metadata (type/vision/上下文/单次回复/持续轮数/思考)"
                    @click.stop="editingMetadataModelId === m.id ? cancelMetadataForm() : openMetadataForm(m)"
                  >
                    <Settings :size="12" :stroke-width="1.75" />
                  </button>
                  <button
                    class="pad-provider-detail__model-remove"
                    type="button"
                    title="移除 model"
                    @click.stop="removeModel(m.id)"
                  >
                    <Trash2 :size="12" :stroke-width="1.75" />
                  </button>
                </label>
                <!-- v0.4.4.6: inline metadata form (展开在 row 下方) -->
                <div v-if="editingMetadataModelId === m.id" class="pad-provider-detail__model-metadata-form">
                  <div class="pad-provider-detail__form-row">
                    <label class="pad-provider-detail__form-label">类型</label>
                    <select v-model="metadataForm.type" class="pad-provider-detail__form-input">
                      <option value="chat">chat (对话)</option>
                      <option value="image">image (绘图)</option>
                      <option value="video">video (视频)</option>
                      <option value="audio">audio (音频)</option>
                      <option value="embedding">embedding (向量)</option>
                    </select>
                  </div>
                  <div class="pad-provider-detail__form-row">
                    <label class="pad-provider-detail__form-label">
                      <input v-model="metadataForm.vision" type="checkbox" />
                      支持图片输入 (多模态)
                    </label>
                    <label class="pad-provider-detail__form-label">
                      <input v-model="metadataForm.reasoning" type="checkbox" />
                      思考模型 (DeepSeek-R1 / Claude extended thinking)
                    </label>
                  </div>
                  <div class="pad-provider-detail__form-row">
                    <label class="pad-provider-detail__form-label">最大上下文 token</label>
                    <input v-model.number="metadataForm.contextWindow" type="number" min="0" step="1000" class="pad-provider-detail__form-input" placeholder="200000" />
                  </div>
                  <div class="pad-provider-detail__form-row">
                    <label class="pad-provider-detail__form-label">单次回复 token 上限</label>
                    <input v-model.number="metadataForm.maxOutput" type="number" min="0" step="100" class="pad-provider-detail__form-input" placeholder="8192" />
                  </div>
                  <div class="pad-provider-detail__form-row">
                    <label class="pad-provider-detail__form-label">持续回复轮数上限 (tool call 最多 N 轮)</label>
                    <input v-model.number="metadataForm.maxRounds" type="number" min="0" step="1" class="pad-provider-detail__form-input" placeholder="不设" />
                  </div>
                  <p
                    v-if="metadataFormError"
                    class="pad-provider-detail__hint is-err"
                    style="margin-top: 6px;"
                  >
                    {{ metadataFormError }}
                  </p>
                  <!-- v0.5.0-D D213: 提示该 model 的 metadata 是自动填的 (来源 catalog / openai-compatible) -->
                  <p
                    v-else-if="m.autoSource"
                    class="pad-provider-detail__hint"
                    style="margin-top: 6px; color: var(--pad-accent, #3b82f6);"
                  >
                    ✨ 这些值是自动填充的 (来源: {{ m.autoSource === 'catalog' ? '静态 model catalog' : 'openai-compatible 响应' }}), 改了就视为手动覆盖
                  </p>
                  <div class="pad-provider-detail__form-actions">
                    <button class="pad-provider-detail__btn pad-provider-detail__btn--ghost" type="button" @click="cancelMetadataForm">取消</button>
                    <button class="pad-provider-detail__btn pad-provider-detail__btn--primary" type="button" @click="saveMetadata(m.id)">保存 metadata</button>
                  </div>
                </div>
              </template>
            </div>
          </div>

          <!-- Thinking 深度 -->
          <div class="pad-provider-detail__row">
            <div class="pad-provider-detail__row-label"><span>Thinking 深度</span></div>
            <div class="pad-provider-detail__seg">
              <button
                v-for="o in THINKING_LEVELS"
                :key="o.value"
                class="pad-provider-detail__segbtn"
                :class="{ 'is-active': config.thinkingLevel === o.value }"
                @click="setThinking(o.value)"
              >{{ o.label }}</button>
            </div>
          </div>

          <!-- Actions -->
          <div class="pad-provider-detail__actions">
            <!-- v0.5.0-PR2: 详情面板只管 enabled, current active 完全归 input box 管 — 删 "设为当前" 按钮 -->
            <button
              class="pad-provider-detail__btn pad-provider-detail__btn--danger"
              @click="removeProvider(selectedProvider!)"
            >
              <Trash2 :size="14" :stroke-width="1.75" /> 删除
            </button>
          </div>

          <Transition name="pad-providers-fade">
            <div
              v-if="fetchMessage"
              class="pad-provider-detail__result"
              :class="{
                'is-ok': fetchState === 'ok',
                'is-fail': fetchState === 'fail',
                'is-fetching': fetchState === 'fetching',
              }"
            >
              {{ fetchMessage }}
            </div>
          </Transition>
        </div>
      </div>
    </div>

    <!-- P1 #1: ConfirmDialog (替代 window.confirm/alert, 统一风格) — 放在 v-if 链外, 不打断 v-else-if 邻接 -->
    <ConfirmDialog
      :open="confirmState.open"
      :title="confirmState.title"
      :message="confirmState.message"
      :confirm-label="confirmState.confirmLabel"
      :cancel-label="confirmState.cancelLabel"
      :danger="confirmState.danger"
      @update:open="(v) => { if (!v && confirmState.onCancel) confirmState.onCancel(); confirmState.open = v; }"
      @confirm="() => { if (confirmState.onConfirm) confirmState.onConfirm(); }"
      @cancel="() => { if (confirmState.onCancel) confirmState.onCancel(); }"
    />
  </div>
</template>

<style scoped>
.pad-providers {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.pad-providers__card {
  display: flex;
  background: var(--pad-card);
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-lg);
  overflow: hidden;
  flex: 1;
  min-height: 0;
  box-shadow: var(--pad-shadow-popover-subtle);
}
.pad-providers__list-col {
  width: 260px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 0;
  min-height: 0;
  background: var(--pad-bg-input);
  border-right: 1px solid var(--pad-divider);
}
.pad-providers__list-head {
  padding: 10px 12px 6px;
  flex-shrink: 0;
}
.pad-providers__list-title {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: var(--pad-fs-11);
  font-weight: var(--pad-fw-semibold);
  color: var(--pad-fg-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.pad-providers__list-inner {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 0 6px 6px;
  flex-shrink: 0;
}
.pad-provider-card {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  border-radius: var(--pad-radius-md);
  background: transparent;
  border: 1px solid transparent;
  cursor: pointer;
  text-align: left;
  transition: background var(--pad-dur-fast) ease, border-color var(--pad-dur-fast) ease;
  position: relative;
}
.pad-provider-card:hover {
  background: var(--pad-bg-hover);
}
.pad-provider-card.is-selected {
  background: var(--pad-bg-active);
  border-color: var(--pad-border);
}
.pad-provider-card.is-configured {
  /* 已配的, 给点视觉 */
}
.pad-provider-card__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: var(--pad-radius-sm);
  background: var(--pad-bg-input);
  color: var(--pad-fg-secondary);
  flex-shrink: 0;
}
.pad-provider-card__body {
  flex: 1;
  min-width: 0;
}
.pad-provider-card__label {
  font-size: var(--pad-fs-13);
  font-weight: var(--pad-fw-medium);
  color: var(--pad-fg-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pad-provider-card__sub {
  font-size: var(--pad-fs-11);
  color: var(--pad-fg-tertiary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-top: 1px;
}
.pad-provider-card__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--pad-border-strong);
  flex-shrink: 0;
}
.pad-provider-card__dot.is-configured {
  background: var(--pad-success);
  box-shadow: 0 0 0 3px var(--pad-success-soft, transparent);
}
.pad-provider-card__dot.is-active {
  background: var(--pad-accent);
  box-shadow: 0 0 0 3px var(--pad-accent-soft);
}
.pad-providers__add {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  margin: 8px;
  padding: 8px 12px;
  border-radius: var(--pad-radius-md);
  font-size: var(--pad-fs-12);
  color: var(--pad-fg-secondary);
  background: transparent;
  border: 1px dashed var(--pad-border);
  cursor: pointer;
  transition: all var(--pad-dur-fast) ease;
  font-family: inherit;
}
.pad-providers__add:hover {
  background: var(--pad-bg-hover);
  color: var(--pad-fg-primary);
  border-color: var(--pad-accent);
}

.pad-providers__detail {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  padding: 24px 28px;
}
.pad-providers__empty-detail {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  gap: 12px;
  color: var(--pad-fg-tertiary);
  text-align: center;
  font-size: var(--pad-fs-13);
  line-height: 1.6;
}
.pad-providers__empty-detail p { margin: 0; }

.pad-provider-detail {
  display: flex;
  flex-direction: column;
  gap: 18px;
  max-width: 640px;
  width: 100%;
  margin: 0 auto;
}
.pad-provider-detail__head {
  display: flex;
  align-items: center;
  gap: 12px;
}
.pad-provider-detail__head-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: var(--pad-radius-md);
  background: var(--pad-accent-soft);
  color: var(--pad-accent);
  flex-shrink: 0;
}
.pad-provider-detail__head-body { flex: 1; min-width: 0; }
.pad-provider-detail__head-title { margin: 0; font-size: 18px; font-weight: var(--pad-fw-semibold); }
.pad-provider-detail__head-sub { margin: 4px 0 0; font-size: var(--pad-fs-12); color: var(--pad-fg-tertiary); display: flex; align-items: center; gap: 8px; }
/* v0.5.0-PR2: 详情面板不再有 "当前激活" head tag (current 标识改在 model row 显示, 跟 input box 同步) */

.pad-provider-detail__row {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.pad-provider-detail__row-label {
  font-size: var(--pad-fs-12);
  font-weight: var(--pad-fw-medium);
  color: var(--pad-fg-secondary);
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.pad-provider-detail__hint {
  font-size: var(--pad-fs-11);
  color: var(--pad-fg-tertiary);
  font-weight: var(--pad-fw-regular);
  margin: 0;
}
.pad-provider-detail__hint.is-err { color: var(--pad-danger-text); }
.pad-provider-detail__input {
  height: 32px;
  padding: 0 var(--pad-sp-2);
  background: var(--pad-bg-input);
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-md);
  font-size: var(--pad-fs-13);
  color: var(--pad-fg-primary);
  font-family: inherit;
  outline: none;
  transition: border-color var(--pad-dur-fast) ease;
  width: 100%;
}
.pad-provider-detail__input:focus { border-color: var(--pad-accent); }
.pad-provider-detail__input--key { font-family: var(--pad-font-mono); letter-spacing: 0.02em; }
.pad-provider-detail__input--inline { background: transparent; border-color: transparent; padding-left: 0; font-size: 18px; font-weight: var(--pad-fw-semibold); }
.pad-provider-detail__input--inline:focus { background: var(--pad-bg-input); border-color: var(--pad-border); padding-left: var(--pad-sp-2); }

.pad-provider-detail__key-form {
  display: flex;
  gap: 8px;
  align-items: center;
}
.pad-provider-detail__key-form .pad-provider-detail__input { flex: 1; }
.pad-provider-detail__key-configured {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  background: var(--pad-bg-active);
  border-radius: var(--pad-radius-md);
  border: 1px solid var(--pad-border);
}
.pad-provider-detail__key-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--pad-fs-12);
  color: var(--pad-success-text);
}
.pad-provider-detail__key-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--pad-success);
}
.pad-provider-detail__key-preview {
  font-family: var(--pad-font-mono);
  font-size: var(--pad-fs-12);
  color: var(--pad-fg-secondary);
  flex: 1;
}

.pad-provider-detail__section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.pad-provider-detail__section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.pad-provider-detail__section-title {
  font-size: var(--pad-fs-12);
  font-weight: var(--pad-fw-medium);
  color: var(--pad-fg-secondary);
}
.pad-provider-detail__addmodel {
  display: flex;
  gap: 8px;
  align-items: center;
}
.pad-provider-detail__addmodel .pad-provider-detail__input { flex: 1; }

.pad-provider-detail__models-empty {
  font-size: var(--pad-fs-12);
  color: var(--pad-fg-tertiary);
  padding: 12px;
  background: var(--pad-bg-input);
  border-radius: var(--pad-radius-md);
  text-align: center;
}
.pad-provider-detail__models {
  display: flex;
  flex-direction: column;
  gap: 2px;
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-md);
  padding: 4px;
  background: var(--pad-bg-input);
}
.pad-provider-detail__model {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: var(--pad-radius-sm);
  cursor: pointer;
  transition: background var(--pad-dur-fast) ease;
}
.pad-provider-detail__model:hover { background: var(--pad-bg-hover); }
/* v0.5.0-PR2: 详情面板不切 active — current 标识用浅绿底高亮 (只读, 跟 input box 同步) */
.pad-provider-detail__model.is-current { background: var(--pad-success-soft, var(--pad-accent-soft)); }
/* Phase 二阶段 B4: 停用 model 不止 opacity 0.5, 还要 model id 划线 + 右侧 "已停用" 灰底 pill.
 *   opacity 0.5 单独用看不出"是没启用"还是"被选过没松手", 加显式文字跟划线更明确. */
.pad-provider-detail__model.is-disabled { opacity: 0.55; }
.pad-provider-detail__model.is-disabled .pad-provider-detail__model-id {
  text-decoration: line-through;
  text-decoration-color: var(--pad-fg-tertiary, #888);
  text-decoration-thickness: 1px;
}
.pad-provider-detail__model-body { flex: 1; min-width: 0; }
.pad-provider-detail__model-id { font-size: var(--pad-fs-13); font-family: var(--pad-font-mono); color: var(--pad-fg-primary); }
.pad-provider-detail__model-label { font-size: var(--pad-fs-11); color: var(--pad-fg-tertiary); margin-top: 1px; }
/* v0.5.0-PR2: current 标签 (跟 metadata tag 同尺寸, 绿底高亮, 跟 enabled 状态无关) */
.pad-provider-detail__model-current-tag {
  display: inline-flex;
  align-items: center;
  font-size: 10px;
  line-height: 14px;
  padding: 1px 8px;
  border-radius: var(--pad-radius-pill);
  background: var(--pad-success, var(--pad-accent));
  color: var(--pad-fg-inverse, #fff);
  font-weight: var(--pad-fw-semibold);
  letter-spacing: 0.02em;
  flex-shrink: 0;
}
/* Phase 二阶段 B4: 已停用 标签. 跟 current 同样尺寸对齐, 灰底 + tertiary 文字,
 *   跟绿底 current 视觉对比强, 跟 enabled model 的 metadata tag 不冲突. */
.pad-provider-detail__model-disabled-tag {
  display: inline-flex;
  align-items: center;
  font-size: 10px;
  line-height: 14px;
  padding: 1px 8px;
  border-radius: var(--pad-radius-pill);
  background: var(--pad-bg-tertiary, rgba(0, 0, 0, 0.06));
  color: var(--pad-fg-tertiary, #888);
  font-weight: var(--pad-fw-medium, 500);
  letter-spacing: 0.02em;
  flex-shrink: 0;
}
/* v0.4.4.6: metadata 摘要 (type/vision/ctx/out/rounds/reasoning 已设的项) */
.pad-provider-detail__model-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 4px;
}
.pad-provider-detail__model-meta-tag {
  display: inline-flex;
  align-items: center;
  font-size: 10px;
  line-height: 14px;
  padding: 1px 6px;
  border-radius: var(--pad-radius-sm);
  background: var(--pad-bg-input);
  color: var(--pad-fg-secondary);
  border: 1px solid var(--pad-border);
}
/* v0.5.0-D D213: 自动填充 (catalog / openai-compatible parse) 的 metadata tag 加柔和高亮 */
.pad-provider-detail__model-meta-tag.is-auto {
  background: var(--pad-accent-soft, rgba(99, 102, 241, 0.1));
  color: var(--pad-accent, #3b82f6);
  border-color: transparent;
}
/* v0.4.4.6: 配置 metadata 按钮 (跟删除按钮同 pattern: hover 才显) */
.pad-provider-detail__model-config {
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
  opacity: 0;
  transition: all var(--pad-dur-fast) ease;
}
.pad-provider-detail__model:hover .pad-provider-detail__model-config { opacity: 1; }
.pad-provider-detail__model-config:hover { background: var(--pad-bg-hover); color: var(--pad-fg-primary); }
.pad-provider-detail__model-remove {
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
  opacity: 0;
  transition: all var(--pad-dur-fast) ease;
}
.pad-provider-detail__model:hover .pad-provider-detail__model-remove { opacity: 1; }
.pad-provider-detail__model-remove:hover { background: var(--pad-danger-soft); color: var(--pad-danger-text); }

/* v0.4.4.6: inline metadata form (展开在 model row 下方) */
.pad-provider-detail__model-metadata-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  margin: 4px 0 8px 0;
  background: var(--pad-bg-subtle);
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-md);
}
.pad-provider-detail__form-row {
  display: flex;
  align-items: center;
  gap: 12px;
}
.pad-provider-detail__form-label {
  flex: 1;
  font-size: var(--pad-fs-12);
  color: var(--pad-fg-secondary);
  display: flex;
  align-items: center;
  gap: 6px;
}
.pad-provider-detail__form-input {
  flex: 1;
  padding: 6px 10px;
  font-size: var(--pad-fs-13);
  background: var(--pad-card);
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-sm);
  color: var(--pad-fg-primary);
}
.pad-provider-detail__form-input:focus {
  outline: none;
  border-color: var(--pad-accent);
}
.pad-provider-detail__form-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 4px;
}
.pad-provider-detail__btn {
  padding: 6px 14px;
  font-size: var(--pad-fs-12);
  border-radius: var(--pad-radius-sm);
  cursor: pointer;
  border: 1px solid var(--pad-border);
  background: var(--pad-card);
  color: var(--pad-fg-primary);
  transition: all var(--pad-dur-fast) ease;
}
.pad-provider-detail__btn:hover { background: var(--pad-bg-hover); }
/* Phase 8c: primary 按钮改成跟 Skills "添加自定义" 一样 — secondary 风格
   (card bg + border + secondary text), hover 升级到 primary text + accent border. */
.pad-provider-detail__btn--primary {
  background: var(--pad-card);
  border-color: var(--pad-border);
  color: var(--pad-fg-secondary);
}
.pad-provider-detail__btn--primary:hover {
  background: var(--pad-bg-hover);
  color: var(--pad-fg-primary);
  border-color: var(--pad-accent, #6366f1);
}
.pad-provider-detail__btn--ghost { background: transparent; }

.pad-provider-detail__seg {
  display: inline-flex;
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-md);
  overflow: hidden;
  background: var(--pad-bg-input);
}
.pad-provider-detail__segbtn {
  padding: 0 12px;
  height: 30px;
  font-size: var(--pad-fs-12);
  color: var(--pad-fg-secondary);
  background: transparent;
  border: none;
  cursor: pointer;
  font-family: inherit;
  transition: background var(--pad-dur-fast) ease, color var(--pad-dur-fast) ease;
}
.pad-provider-detail__segbtn + .pad-provider-detail__segbtn { border-left: 1px solid var(--pad-border); }
.pad-provider-detail__segbtn:hover { background: var(--pad-bg-hover); color: var(--pad-fg-primary); }
.pad-provider-detail__segbtn.is-active { background: var(--pad-accent); color: var(--pad-fg-inverse); }

.pad-provider-detail__actions {
  display: flex;
  gap: 8px;
  align-items: center;
  padding-top: 8px;
  border-top: 1px solid var(--pad-divider);
}
.pad-provider-detail__btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 30px;
  padding: 0 14px;
  border-radius: var(--pad-radius-md);
  font-size: var(--pad-fs-13);
  color: var(--pad-fg-primary);
  background: var(--pad-bg-input);
  border: 1px solid var(--pad-border);
  cursor: pointer;
  font-family: inherit;
  transition: all var(--pad-dur-fast) ease;
}
.pad-provider-detail__btn:hover:not(:disabled) {
  background: var(--pad-bg-hover);
  border-color: var(--pad-border-strong);
}
.pad-provider-detail__btn:disabled { opacity: 0.5; cursor: not-allowed; }
.pad-provider-detail__btn--primary { background: var(--pad-accent); color: var(--pad-fg-inverse); border-color: transparent; }
.pad-provider-detail__btn--primary:hover:not(:disabled) { background: var(--pad-accent-hover); }
.pad-provider-detail__btn--small { height: 26px; padding: 0 10px; font-size: var(--pad-fs-12); }
.pad-provider-detail__btn--danger { color: var(--pad-danger-text); border-color: var(--pad-danger-text); }
.pad-provider-detail__btn--danger:hover:not(:disabled) { background: var(--pad-danger-soft); }
.pad-provider-detail__iconbtn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 26px;
  padding: 0 10px;
  border-radius: var(--pad-radius-sm);
  font-size: var(--pad-fs-12);
  color: var(--pad-fg-secondary);
  background: transparent;
  border: 1px solid var(--pad-border);
  cursor: pointer;
  font-family: inherit;
  transition: all var(--pad-dur-fast) ease;
}
.pad-provider-detail__iconbtn:hover:not(:disabled) { background: var(--pad-bg-hover); color: var(--pad-fg-primary); }
.pad-provider-detail__iconbtn:disabled { opacity: 0.5; cursor: not-allowed; }
.is-spinning { animation: pad-spin 1s linear infinite; }
@keyframes pad-spin { to { transform: rotate(360deg); } }

.pad-provider-detail__result {
  font-size: var(--pad-fs-12);
  padding: 8px 12px;
  border-radius: var(--pad-radius-md);
  background: var(--pad-bg-input);
  color: var(--pad-fg-secondary);
}
.pad-provider-detail__result.is-ok { background: var(--pad-success-soft); color: var(--pad-success-text); }
.pad-provider-detail__result.is-fail { background: var(--pad-danger-soft); color: var(--pad-danger-text); }
.pad-provider-detail__result.is-fetching { background: var(--pad-warning-soft); color: var(--pad-warning-text); }
.pad-providers-fade-enter-active,
.pad-providers-fade-leave-active {
  transition: opacity var(--pad-dur-base) var(--pad-ease-out-soft), transform var(--pad-dur-base) var(--pad-ease-out-soft);
}
.pad-providers-fade-enter-from,
.pad-providers-fade-leave-to { opacity: 0; transform: translateY(4px); }
</style>
