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
  Plus, Trash2, RefreshCw, CheckCircle2, KeyRound, Server, Save,
} from 'lucide-vue-next';
import {
  useConfigStore, PROVIDER_OPTIONS, BUILTIN_MODELS, THINKING_LEVELS,
  type ProviderConfig, type ProviderType, type ModelInfo,
} from '@/stores/config';
import { fetchProviderModels } from '@/lib/providers-api';
import { piTauri } from '@/lib/tauri';
import AddProviderForm from './AddProviderForm.vue';

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
    // 6. 自动选第一个 model (内置 provider 用硬编码 catalog)
    const builtinModels = BUILTIN_MODELS[t as Exclude<ProviderType, 'openai-compatible'>];
    if (builtinModels?.length) {
      config.setProviderModels(provider.id, builtinModels.map((id) => ({ id, enabled: true })));
      config.setActiveModel(provider.id, builtinModels[0]);
    }
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
  if (!confirm(`从 OS keychain 删除 ${selectedProvider.value.label} 的 API key?`)) return;
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

function removeProvider(provider: ProviderConfig) {
  if (!confirm(`确定删除 "${provider.label}"? 会清除这个 provider 的本地 config + keychain 里的 key.`)) return;
  piTauri.deleteApiKey(provider.id).catch(() => {});
  config.removeProvider(provider.id);
  void refreshAllKeyStatus();
  // 选回这个 type 对应的 builtin (新建或重选)
  if (provider.type === 'openai-compatible') {
    selection.value = null;
  } else {
    selection.value = { kind: 'builtin', type: provider.type };
  }
}

function setActive(provider: ProviderConfig) {
  if (!provider.activeModelId) {
    fetchMessage.value = '请先选一个 active model';
    fetchState.value = 'fail';
    return;
  }
  config.setActiveProvider(provider.id);
  fetchState.value = 'ok';
  fetchMessage.value = `已切换到 ${provider.label} / ${provider.activeModelId}`;
}

function activateModel(providerId: string, modelId: string) {
  const p = config.providers.find((x) => x.id === providerId);
  const m = p?.models.find((x) => x.id === modelId);
  if (!m || m.enabled === false) {
    fetchState.value = 'fail';
    fetchMessage.value = '该 model 已停用, 不能激活';
    return;
  }
  config.setActiveModel(providerId, modelId);
  if (p) {
    fetchState.value = 'ok';
    fetchMessage.value = `已激活 ${p.label} / ${modelId}`;
  }
}

function isModelEnabled(m: ModelInfo): boolean {
  return m.enabled !== false;
}

function addCustomModel() {
  if (!selectedProvider.value) return;
  const id = newModelInput.value.trim();
  if (!id) return;
  const existing = selectedProvider.value.models.find((m) => m.id === id);
  if (existing) {
    newModelInput.value = '';
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

function removeModel(modelId: string) {
  if (!selectedProvider.value) return;
  const p = selectedProvider.value;
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
              保存后会自动设为当前 active provider, 并从内置 model 列表预填 {{ BUILTIN_MODELS[currentBuiltinType! as Exclude<ProviderType, 'openai-compatible'>]?.[0] ?? '默认 model' }} 作 active.
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
                :value="selectedProvider.label"
                @input="config.updateProvider(selectedProvider.id, { label: ($event.target as HTMLInputElement).value })"
              />
              <p class="pad-provider-detail__head-sub">
                {{ builtinOptions.find((o) => o.id === selectedProvider!.type)?.label ?? '自定义' }}
                <span v-if="selectedProvider!.id === config.activeProviderId" class="pad-provider-detail__head-tag">当前激活</span>
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
              :value="selectedProvider.baseUrl ?? ''"
              placeholder="https://your-proxy.com/v1"
              @input="config.updateProvider(selectedProvider.id, { baseUrl: ($event.target as HTMLInputElement).value })"
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
          </div>

          <!-- Models -->
          <div class="pad-provider-detail__section">
            <div class="pad-provider-detail__section-head">
              <span class="pad-provider-detail__section-title">模型 ({{ selectedProvider.models.length }})</span>
              <button
                v-if="isOpenAICompatible"
                class="pad-provider-detail__iconbtn"
                :disabled="fetchState === 'fetching'"
                title="从 provider 拉取模型"
                @click="fetchModels(selectedProvider)"
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

            <div v-if="selectedProvider.models.length === 0" class="pad-provider-detail__models-empty">
              还没模型. {{ isOpenAICompatible ? '点"拉取" 或手输 model id.' : '从下方预填列表选, 或手输 id.' }}
            </div>
            <div v-else class="pad-provider-detail__models">
              <label
                v-for="m in selectedProvider.models"
                :key="m.id"
                class="pad-provider-detail__model"
                :class="{
                  'is-active': selectedProvider.activeModelId === m.id,
                  'is-disabled': !isModelEnabled(m),
                }"
              >
                <input
                  type="checkbox"
                  class="pad-provider-detail__model-toggle"
                  :checked="isModelEnabled(m)"
                  @change="config.toggleModelEnabled(selectedProvider.id, m.id)"
                />
                <input
                  type="radio"
                  :name="`model-${selectedProvider.id}`"
                  :value="m.id"
                  :checked="selectedProvider.activeModelId === m.id"
                  :disabled="!isModelEnabled(m)"
                  @change="activateModel(selectedProvider.id, m.id)"
                />
                <div class="pad-provider-detail__model-body">
                  <div class="pad-provider-detail__model-id">{{ m.id }}</div>
                  <div v-if="m.label" class="pad-provider-detail__model-label">{{ m.label }}</div>
                </div>
                <button
                  class="pad-provider-detail__model-remove"
                  type="button"
                  title="移除 model"
                  @click.stop="removeModel(m.id)"
                >
                  <Trash2 :size="12" :stroke-width="1.75" />
                </button>
              </label>
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
            <button
              class="pad-provider-detail__btn pad-provider-detail__btn--primary"
              :disabled="fetchState === 'fetching' || !selectedProvider.activeModelId"
              @click="setActive(selectedProvider)"
            >
              <CheckCircle2 :size="14" :stroke-width="1.75" />
              设为当前
            </button>
            <button
              class="pad-provider-detail__btn pad-provider-detail__btn--danger"
              @click="removeProvider(selectedProvider)"
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
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04), 0 4px 12px rgba(0, 0, 0, 0.04);
}
.pad-providers__list-col {
  width: 260px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 0;
  min-height: 0;
  background: var(--pad-bg-muted);
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
.pad-provider-detail__head-tag {
  display: inline-block;
  font-size: var(--pad-fs-10);
  color: var(--pad-accent);
  background: var(--pad-accent-soft);
  border-radius: var(--pad-radius-pill);
  padding: 1px 8px;
  text-transform: none;
  letter-spacing: 0;
  font-weight: var(--pad-fw-medium);
}

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
  background: var(--pad-bg-muted);
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
  background: var(--pad-bg-muted);
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
.pad-provider-detail__model.is-active { background: var(--pad-accent-soft); }
.pad-provider-detail__model.is-disabled { opacity: 0.5; }
.pad-provider-detail__model-body { flex: 1; min-width: 0; }
.pad-provider-detail__model-id { font-size: var(--pad-fs-13); font-family: var(--pad-font-mono); color: var(--pad-fg-primary); }
.pad-provider-detail__model-label { font-size: var(--pad-fs-11); color: var(--pad-fg-tertiary); margin-top: 1px; }
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
  background: var(--pad-bg-muted);
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
