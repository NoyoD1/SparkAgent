<script setup lang="ts">
/**
 * ProviderTab — 多 Provider 管理 (BYOK)
 *
 * 布局:
 * - 左侧: provider 列表 + "+ 添加"
 * - 右侧: 选中 provider 的详情 (name, type, key, baseUrl, models list, 测试, 删除)
 * - AddProviderForm: 嵌入中间列的 inline form (v3 改造, 取代 modal 套娃)
 *
 * 范围:
 * - ✅ fetch 模型 (内置 + openai-compatible)
 * - ✅ 测试连接 (ping fetch-models 看 ok)
 * - ✅ active model 切换
 * - ⏸ openai-compatible 的 LLM 调 (Phase 3+, UI 标 "已发现, LLM 调 Phase 3+")
 */
import { ref, computed } from 'vue';
import { Plus, Trash2, RefreshCw, CheckCircle2, AlertCircle, Star, KeyRound, Sparkles, ExternalLink, Server } from 'lucide-vue-next';
import { useConfigStore, PROVIDER_OPTIONS, THINKING_LEVELS, type ProviderConfig, type ProviderType, type ModelInfo } from '@/stores/config';
import { useUiStore } from '@/stores/ui';
import AddProviderForm from './AddProviderForm.vue';

const config = useConfigStore();
const ui = useUiStore();

const selectedId = ref<string | null>(config.providers[0]?.id ?? null);
/** viewMode: list (默认) | add (中间列显示 add form, 右侧列空) */
const viewMode = ref<'list' | 'add'>('list');
const fetchState = ref<'idle' | 'fetching' | 'ok' | 'fail'>('idle');
const fetchMessage = ref<string>('');

const selectedProvider = computed<ProviderConfig | null>(
  () => config.providers.find((p) => p.id === selectedId.value) ?? null,
);

const isOpenAICompatible = computed(() => selectedProvider.value?.type === 'openai-compatible');

function selectProvider(id: string) {
  selectedId.value = id;
  fetchState.value = 'idle';
  fetchMessage.value = '';
}

function setActive(provider: ProviderConfig) {
  if (!provider.activeModelId) {
    fetchMessage.value = '请先拉取模型并选一个 active model';
    return;
  }
  config.setActiveProvider(provider.id);
  fetchState.value = 'ok';
  fetchMessage.value = `已切换到 ${provider.label} / ${provider.activeModelId}`;
}

function activateModel(providerId: string, modelId: string) {
  config.setActiveModel(providerId, modelId);
  const p = config.providers.find((x) => x.id === providerId);
  if (p) {
    fetchState.value = 'ok';
    fetchMessage.value = `已激活 ${p.label} / ${modelId}`;
  }
}

function setThinking(level: 'off' | 'low' | 'medium' | 'high') {
  config.setThinkingLevel(level);
}

async function fetchModels(provider: ProviderConfig) {
  if (provider.type === 'openai-compatible' && !provider.baseUrl) {
    fetchState.value = 'fail';
    fetchMessage.value = 'OpenAI 兼容需要填 baseUrl';
    return;
  }
  if (provider.type === 'openai-compatible' && !provider.apiKeyEnv) {
    fetchState.value = 'fail';
    fetchMessage.value = 'OpenAI 兼容需要填 env 变量名 (server 从这个 env 读 key)';
    return;
  }
  fetchState.value = 'fetching';
  fetchMessage.value = '';
  try {
    // v0.2+: openai-compatible 传 apiKeyEnv (env 变量名, 不是 key)
    const resp = await fetch('/api/providers/fetch-models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: provider.type,
        baseUrl: provider.baseUrl,
        apiKeyEnv: provider.type === 'openai-compatible' ? provider.apiKeyEnv : undefined,
      }),
    });
    const data = await resp.json() as { ok: boolean; models?: ModelInfo[]; error?: string; warning?: string };
    if (data.ok && data.models) {
      config.setProviderModels(provider.id, data.models);
      fetchState.value = 'ok';
      fetchMessage.value = `拉到 ${data.models.length} 个模型${data.warning ? ` · ${data.warning}` : ''}`;
    } else {
      fetchState.value = 'fail';
      fetchMessage.value = data.error ?? 'fetch 失败';
    }
  } catch (e) {
    fetchState.value = 'fail';
    fetchMessage.value = e instanceof Error ? e.message : String(e);
  }
}

async function testConnection(provider: ProviderConfig) {
  // 复用 fetch-models, 既验 key (从 server env) 又验 endpoint
  await fetchModels(provider);
  if (fetchState.value === 'ok' && provider.models.length > 0) {
    fetchMessage.value = `✅ 连接成功, ${provider.models.length} 个模型可用`;
  }
}

function removeProvider(provider: ProviderConfig) {
  if (!confirm(`确定删除 "${provider.label}"? 会清除这个 provider 的 key + models.`)) return;
  config.removeProvider(provider.id);
  if (selectedId.value === provider.id) {
    selectedId.value = config.providers[0]?.id ?? null;
  }
}

function onProviderAdded(id: string) {
  selectedId.value = id;
  viewMode.value = 'list';
}

function openAdd() {
  viewMode.value = 'add';
}
function closeAdd() {
  viewMode.value = 'list';
}
</script>

<template>
  <div class="pad-providers">
    <div class="pad-providers__card">
      <!-- LEFT: list (240px) | add 模式下变 form (280px) -->
      <aside class="pad-providers__list-col">
        <div v-if="viewMode === 'add'" class="pad-providers__list-head">
          <span class="pad-providers__list-title">添加供应商</span>
        </div>
        <div v-else class="pad-providers__list-head">
          <span class="pad-providers__list-title">
            <span>智谱</span>
            <span class="pad-providers__list-section-dot" />
            <span>自定义供应商</span>
          </span>
        </div>
        <div class="pad-providers__list-inner">
          <!-- list 模式: provider 卡片列表 -->
          <template v-if="viewMode === 'list'">
            <button
              v-for="p in config.providers"
              :key="p.id"
              class="pad-provider-card"
              :class="{ 'is-selected': selectedId === p.id, 'is-active': p.id === config.activeProviderId }"
              @click="selectProvider(p.id)"
            >
              <div class="pad-provider-card__icon">
                <Server :size="14" :stroke-width="1.75" />
              </div>
              <div class="pad-provider-card__body">
                <div class="pad-provider-card__label">{{ p.label }}</div>
                <div class="pad-provider-card__sub">
                  {{ PROVIDER_OPTIONS.find((o) => o.id === p.type)?.label ?? p.type }}
                </div>
              </div>
              <span v-if="p.id === config.activeProviderId" class="pad-provider-card__dot" />
            </button>
            <button v-if="config.providers.length === 0" class="pad-providers__empty" disabled>
              <Sparkles :size="14" :stroke-width="1.75" />
              <span>暂无 provider, 点下面 + 添加</span>
            </button>
          </template>
          <!-- add 模式: 嵌入 AddProviderForm -->
          <AddProviderForm
            v-else
            @close="closeAdd"
            @added="onProviderAdded"
          />
        </div>
        <button v-if="viewMode === 'list'" class="pad-providers__add" @click="openAdd">
          <Plus :size="14" :stroke-width="1.75" /> 添加供应商
        </button>
      </aside>

      <!-- RIGHT: detail (flex 1) -->
      <div class="pad-providers__detail">
        <div v-if="!selectedProvider" class="pad-providers__empty-detail">
          <KeyRound :size="28" :stroke-width="1.5" />
          <p>选一个 provider 看详情<br>或点左下"+ 添加"新建</p>
        </div>

        <div v-else class="pad-provider-detail">
          <!-- Type / Label -->
          <div class="pad-provider-detail__row">
            <div class="pad-provider-detail__row-label">
              <span>名称</span>
            </div>
            <input
              class="pad-provider-detail__input"
              type="text"
              :value="selectedProvider.label"
              @input="config.updateProvider(selectedProvider.id, { label: ($event.target as HTMLInputElement).value })"
            />
          </div>

          <div class="pad-provider-detail__row">
            <div class="pad-provider-detail__row-label">
              <span>类型</span>
              <span v-if="isOpenAICompatible" class="pad-provider-detail__phase3">baseUrl LLM 调: Phase 3+</span>
            </div>
            <select
              class="pad-provider-detail__select"
              :value="selectedProvider.type"
              @change="config.updateProvider(selectedProvider.id, { type: (($event.target as HTMLSelectElement).value) as ProviderType })"
            >
              <option v-for="o in PROVIDER_OPTIONS" :key="o.id" :value="o.id">{{ o.label }}</option>
            </select>
          </div>

          <div v-if="isOpenAICompatible" class="pad-provider-detail__row">
            <div class="pad-provider-detail__row-label">
              <span>Base URL</span>
              <span class="pad-provider-detail__hint">如 https://api.openrouter.ai/v1</span>
            </div>
            <input
              class="pad-provider-detail__input"
              type="text"
              :value="selectedProvider.baseUrl ?? ''"
              placeholder="https://your-proxy.com/v1"
              @input="config.updateProvider(selectedProvider.id, { baseUrl: ($event.target as HTMLInputElement).value })"
            />
          </div>

          <div v-if="isOpenAICompatible" class="pad-provider-detail__row">
            <div class="pad-provider-detail__row-label">
              <span>API Key ENV</span>
              <span class="pad-provider-detail__hint">server 从这个 env 读 key</span>
            </div>
            <input
              class="pad-provider-detail__input pad-provider-detail__input--mono"
              type="text"
              :value="selectedProvider.apiKeyEnv ?? ''"
              placeholder="OPENAI_COMPATIBLE_KEY"
              @input="config.updateProvider(selectedProvider.id, { apiKeyEnv: ($event.target as HTMLInputElement).value })"
            />
          </div>

          <!-- v0.2: API Key 走 server .env, 这里只显示状态提示 -->
          <div v-if="!isOpenAICompatible" class="pad-provider-detail__row">
            <div class="pad-provider-detail__row-label">
              <span>API Key</span>
              <span class="pad-provider-detail__hint">配在 server/.env</span>
            </div>
            <div class="pad-provider-detail__key-hint">
              环境变量 <code>{{ selectedProvider.type.toUpperCase() }}_API_KEY</code> 须配在
              <code>server/.env</code>. 改完重启 server 生效.
            </div>
          </div>

          <!-- Models list -->
          <div class="pad-provider-detail__section">
            <div class="pad-provider-detail__section-head">
              <span class="pad-provider-detail__section-title">模型 ({{ selectedProvider.models.length }})</span>
              <button
                class="pad-provider-detail__iconbtn"
                :disabled="fetchState === 'fetching'"
                title="拉取模型"
                @click="fetchModels(selectedProvider)"
              >
                <RefreshCw :size="14" :stroke-width="1.75" :class="{ 'is-spinning': fetchState === 'fetching' }" />
                <span>拉取</span>
              </button>
            </div>
            <div v-if="selectedProvider.models.length === 0" class="pad-provider-detail__models-empty">
              点"拉取"从 provider 拉可用模型. 失败会自动 fallback 到内置 list.
            </div>
            <div v-else class="pad-provider-detail__models">
              <label
                v-for="m in selectedProvider.models"
                :key="m.id"
                class="pad-provider-detail__model"
                :class="{ 'is-active': selectedProvider.activeModelId === m.id }"
              >
                <input
                  type="radio"
                  :name="`model-${selectedProvider.id}`"
                  :value="m.id"
                  :checked="selectedProvider.activeModelId === m.id"
                  @change="activateModel(selectedProvider.id, m.id)"
                />
                <div class="pad-provider-detail__model-body">
                  <div class="pad-provider-detail__model-id">{{ m.id }}</div>
                  <div v-if="m.label" class="pad-provider-detail__model-label">{{ m.label }}</div>
                </div>
              </label>
            </div>
          </div>

          <!-- Thinking -->
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
              :disabled="fetchState === 'fetching'"
              @click="testConnection(selectedProvider)"
            >
              <CheckCircle2 v-if="fetchState === 'ok'" :size="14" :stroke-width="1.75" />
              <span v-else-if="fetchState === 'fetching'">测试中…</span>
              <span v-else>测试连接</span>
            </button>
            <button
              class="pad-provider-detail__btn"
              :disabled="!selectedProvider.activeModelId"
              @click="setActive(selectedProvider)"
            >
              <Star :size="14" :stroke-width="1.75" />
              设为当前
            </button>
            <button
              class="pad-provider-detail__btn pad-provider-detail__btn--danger"
              @click="removeProvider(selectedProvider)"
            >
              <Trash2 :size="14" :stroke-width="1.75" />
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

/* v4: 居中卡片, 单卡片两栏 (list/form + detail) */
.pad-providers__card {
  display: flex;
  background: var(--pad-card);
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-lg);
  overflow: hidden;
  flex: 1;
  min-height: 0;
  /* 卡片阴影 (跟 design token 一致) */
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04), 0 4px 12px rgba(0, 0, 0, 0.04);
}

/* LEFT: list 240px | add 模式 form 280px */
.pad-providers__list-col {
  width: 240px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 0;
  min-height: 0;
  background: var(--pad-bg-muted);
  border-right: 1px solid var(--pad-border);
  transition: width var(--pad-dur-base) var(--pad-ease-in-out);
}
/* add 模式稍微宽点, 容纳 form */
.pad-providers:has(.pad-providers__list-col .pad-addprov) .pad-providers__list-col,
.pad-providers__list-col:has(.pad-addprov) {
  width: 360px;
}

.pad-providers__list-head {
  padding: var(--pad-sp-3) var(--pad-sp-4);
  border-bottom: 1px solid var(--pad-divider);
  flex-shrink: 0;
}
.pad-providers__list-title {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: var(--pad-fs-12);
  font-weight: var(--pad-fw-medium);
  color: var(--pad-fg-secondary);
}
.pad-providers__list-section-dot {
  display: inline-block;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--pad-fg-tertiary);
}

.pad-providers__list-inner {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--pad-sp-2);
  overflow-y: auto;
  flex: 1;
  min-height: 0;
}
.pad-provider-card {
  display: flex;
  align-items: center;
  gap: var(--pad-sp-2);
  width: 100%;
  padding: var(--pad-sp-2) var(--pad-sp-3);
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
.pad-provider-card.is-active {
  background: var(--pad-accent-soft);
  border-color: var(--pad-accent);
}
.pad-provider-card__icon {
  width: 24px;
  height: 24px;
  border-radius: var(--pad-radius-sm);
  background: var(--pad-bg-elevated);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--pad-fg-secondary);
  flex-shrink: 0;
}
.pad-provider-card.is-active .pad-provider-card__icon {
  background: var(--pad-accent);
  color: var(--pad-fg-inverse);
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
  margin-top: 2px;
}
/* v4: active 用右边小圆点代替 Star (跟 ZCode 参考一致) */
.pad-provider-card__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--pad-success);
  flex-shrink: 0;
}
.pad-provider-card__star {
  color: var(--pad-accent);
  flex-shrink: 0;
}
.pad-providers__empty {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: var(--pad-sp-2) var(--pad-sp-3);
  font-size: var(--pad-fs-12);
  color: var(--pad-fg-tertiary);
  background: transparent;
  border: 1px dashed var(--pad-border);
  border-radius: var(--pad-radius-md);
  cursor: default;
  width: 100%;
}
.pad-providers__add {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 36px;
  margin: var(--pad-sp-2);
  padding: 0 var(--pad-sp-3);
  border-radius: var(--pad-radius-md);
  font-size: var(--pad-fs-13);
  color: var(--pad-fg-secondary);
  background: transparent;
  border: 1px dashed var(--pad-border);
  cursor: pointer;
  transition: background var(--pad-dur-fast) ease, color var(--pad-dur-fast) ease, border-color var(--pad-dur-fast) ease;
  flex-shrink: 0;
}
.pad-providers__add:hover {
  background: var(--pad-bg-hover);
  color: var(--pad-fg-primary);
  border-color: var(--pad-accent);
  border-style: solid;
}

/* RIGHT: detail (flex 1, 占剩余空间) */
.pad-providers__detail {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: var(--pad-sp-4) var(--pad-sp-5);
  background: var(--pad-card);
}
.pad-providers__empty-detail {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  gap: var(--pad-sp-2);
  color: var(--pad-fg-tertiary);
  text-align: center;
  font-size: var(--pad-fs-12);
  line-height: var(--pad-lh-relaxed);
}
.pad-provider-detail {
  display: flex;
  flex-direction: column;
  gap: var(--pad-sp-3);
}
.pad-provider-detail__row {
  display: grid;
  grid-template-columns: 120px 1fr;
  align-items: center;
  gap: var(--pad-sp-2);
}
.pad-provider-detail__row-label {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.pad-provider-detail__row-label > span:first-child {
  font-size: var(--pad-fs-12);
  font-weight: var(--pad-fw-medium);
  color: var(--pad-fg-secondary);
}
.pad-provider-detail__hint {
  font-size: var(--pad-fs-11);
  color: var(--pad-fg-tertiary);
}
.pad-provider-detail__phase3 {
  display: inline-block;
  font-size: var(--pad-fs-10);
  color: var(--pad-warning-text);
  background: var(--pad-warning-subtle);
  border: 1px solid var(--pad-warning-border);
  border-radius: var(--pad-radius-pill);
  padding: 1px 6px;
  width: fit-content;
}
.pad-provider-detail__input,
.pad-provider-detail__select {
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
.pad-provider-detail__input:focus,
.pad-provider-detail__select:focus {
  border-color: var(--pad-accent);
}
.pad-provider-detail__input[type="password"] {
  font-family: var(--pad-font-mono);
}
.pad-provider-detail__input--mono {
  font-family: var(--pad-font-mono);
  letter-spacing: 0;
}
.pad-provider-detail__key-hint {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  background: var(--pad-bg-active);
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-md);
  font-size: var(--pad-fs-12);
  color: var(--pad-fg-secondary);
  line-height: 1.5;
}
.pad-provider-detail__key-hint code {
  font-family: var(--pad-font-mono);
  font-size: var(--pad-fs-12);
  background: var(--pad-bg-elevated);
  padding: 1px 5px;
  border-radius: var(--pad-radius-sm);
  color: var(--pad-fg-primary);
}

.pad-provider-detail__section {
  background: var(--pad-bg-active);
  border-radius: var(--pad-radius-md);
  padding: var(--pad-sp-2);
}
.pad-provider-detail__section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--pad-sp-2);
}
.pad-provider-detail__section-title {
  font-size: var(--pad-fs-12);
  font-weight: var(--pad-fw-medium);
  color: var(--pad-fg-secondary);
}
.pad-provider-detail__iconbtn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 var(--pad-sp-2);
  font-size: var(--pad-fs-12);
  color: var(--pad-fg-secondary);
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--pad-radius-sm);
  cursor: pointer;
  transition: background var(--pad-dur-fast) ease, color var(--pad-dur-fast) ease;
}
.pad-provider-detail__iconbtn:hover:not(:disabled) {
  background: var(--pad-bg-hover);
  color: var(--pad-fg-primary);
}
.pad-provider-detail__iconbtn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.pad-provider-detail__iconbtn .is-spinning {
  animation: pad-spin 1s linear infinite;
}
@keyframes pad-spin {
  to { transform: rotate(360deg); }
}

.pad-provider-detail__models-empty {
  font-size: var(--pad-fs-12);
  color: var(--pad-fg-tertiary);
  padding: var(--pad-sp-2) var(--pad-sp-2);
  text-align: center;
}
.pad-provider-detail__models {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 180px;
  overflow-y: auto;
}
.pad-provider-detail__model {
  display: flex;
  align-items: center;
  gap: var(--pad-sp-2);
  padding: var(--pad-sp-2);
  border-radius: var(--pad-radius-sm);
  cursor: pointer;
  background: transparent;
  border: 1px solid transparent;
  transition: background var(--pad-dur-fast) ease, border-color var(--pad-dur-fast) ease;
}
.pad-provider-detail__model:hover {
  background: var(--pad-bg-hover);
}
.pad-provider-detail__model.is-active {
  background: var(--pad-accent-soft);
  border-color: var(--pad-accent);
}
.pad-provider-detail__model input[type="radio"] {
  margin: 0;
  cursor: pointer;
  accent-color: var(--pad-accent);
}
.pad-provider-detail__model-body {
  flex: 1;
  min-width: 0;
}
.pad-provider-detail__model-id {
  font-size: var(--pad-fs-12);
  color: var(--pad-fg-primary);
  font-family: var(--pad-font-mono);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pad-provider-detail__model-label {
  font-size: var(--pad-fs-11);
  color: var(--pad-fg-tertiary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pad-provider-detail__seg {
  display: inline-flex;
  background: var(--pad-bg-input);
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-md);
  padding: 2px;
  gap: 2px;
  width: fit-content;
}
.pad-provider-detail__segbtn {
  padding: 0 var(--pad-sp-3);
  height: 26px;
  font-size: var(--pad-fs-12);
  color: var(--pad-fg-secondary);
  background: transparent;
  border: none;
  border-radius: var(--pad-radius-sm);
  cursor: pointer;
}
.pad-provider-detail__segbtn:hover { color: var(--pad-fg-primary); }
.pad-provider-detail__segbtn.is-active {
  background: var(--pad-bg-elevated);
  color: var(--pad-fg-primary);
  font-weight: var(--pad-fw-medium);
  box-shadow: var(--pad-shadow-button);
}

.pad-provider-detail__actions {
  display: flex;
  gap: var(--pad-sp-2);
}
.pad-provider-detail__btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 var(--pad-sp-3);
  border-radius: var(--pad-radius-md);
  font-size: var(--pad-fs-13);
  color: var(--pad-fg-primary);
  background: var(--pad-bg-input);
  border: 1px solid var(--pad-border);
  cursor: pointer;
  transition: background var(--pad-dur-fast) ease;
}
.pad-provider-detail__btn:hover:not(:disabled) {
  background: var(--pad-bg-hover);
}
.pad-provider-detail__btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.pad-provider-detail__btn--primary {
  background: var(--pad-accent);
  color: var(--pad-fg-inverse);
  border-color: transparent;
}
.pad-provider-detail__btn--primary:hover:not(:disabled) {
  background: var(--pad-accent-hover);
}
.pad-provider-detail__btn--danger {
  margin-left: auto;
  color: var(--pad-danger);
}

.pad-provider-detail__result {
  font-size: var(--pad-fs-12);
  padding: var(--pad-sp-2) var(--pad-sp-3);
  border-radius: var(--pad-radius-md);
  background: var(--pad-bg-active);
  color: var(--pad-fg-secondary);
  word-break: break-word;
}
.pad-provider-detail__result.is-ok {
  background: var(--pad-success-subtle);
  color: var(--pad-success-text);
  border: 1px solid var(--pad-success-border);
}
.pad-provider-detail__result.is-fail {
  background: var(--pad-danger-subtle);
  color: var(--pad-danger-text);
  border: 1px solid var(--pad-danger-border);
}
.pad-provider-detail__result.is-fetching {
  background: var(--pad-warning-subtle);
  color: var(--pad-warning-text);
  border: 1px solid var(--pad-warning-border);
}

.pad-providers-fade-enter-active,
.pad-providers-fade-leave-active {
  transition: opacity var(--pad-dur-base) var(--pad-ease-out-soft);
}
.pad-providers-fade-enter-from,
.pad-providers-fade-leave-to {
  opacity: 0;
}
</style>
