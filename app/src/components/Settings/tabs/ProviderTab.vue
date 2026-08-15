<script setup lang="ts">
/**
 * ProviderTab — 多 Provider 管理 (BYOK) — Phase 3 Tauri 流程
 *
 * 布局:
 * - 左侧: provider 列表 + "+ 添加"
 * - 右侧: 选中 provider 的详情
 *   - 名称 / 类型 / baseUrl
 *   - API Key (存 OS keychain, 显示 masked preview + 改/删)
 *   - 模型列表 (拉取/激活)
 *   - Thinking 深度 / 设为当前 / 删除
 *
 * 范围:
 * - ✅ fetch 模型 (openai-compatible, 走 Tauri command)
 * - ✅ API key 存 OS keychain (save/delete/has/list)
 * - ✅ active model 切换
 */
import { ref, computed, onMounted } from 'vue';
import { Plus, Trash2, RefreshCw, CheckCircle2, Star, KeyRound, Sparkles, Server, Save } from 'lucide-vue-next';
import { useConfigStore, PROVIDER_OPTIONS, THINKING_LEVELS, type ProviderConfig, type ProviderType } from '@/stores/config';
import { fetchProviderModels } from '@/lib/providers-api';
import { piTauri } from '@/lib/tauri';
import AddProviderForm from './AddProviderForm.vue';

const config = useConfigStore();

const selectedId = ref<string | null>(config.providers[0]?.id ?? null);
const viewMode = ref<'list' | 'add'>('list');
const fetchState = ref<'idle' | 'fetching' | 'ok' | 'fail'>('idle');
const fetchMessage = ref<string>('');

/** API key section state */
const keyState = ref<'idle' | 'saving' | 'deleting'>('idle');
const keyMessage = ref<string>('');
const newKeyInput = ref<string>('');
/** Map<providerId, {configured, preview}> */
const keyStatus = ref<Record<string, { configured: boolean; preview: string | null }>>({});

const selectedProvider = computed<ProviderConfig | null>(
  () => config.providers.find((p) => p.id === selectedId.value) ?? null,
);

const isOpenAICompatible = computed(() => selectedProvider.value?.type === 'openai-compatible');

const currentKeyStatus = computed(() => {
  if (!selectedProvider.value) return null;
  return keyStatus.value[selectedProvider.value.id] ?? null;
});

onMounted(async () => {
  await refreshAllKeyStatus();
});

async function refreshAllKeyStatus() {
  try {
    const list = await piTauri.listApiKeys();
    const next: Record<string, { configured: boolean; preview: string | null }> = {};
    for (const k of list) {
      next[k.provider_id] = { configured: k.configured, preview: k.preview };
    }
    keyStatus.value = next;
  } catch (e) {
    console.error('[provider-tab] listApiKeys failed', e);
  }
}

function selectProvider(id: string) {
  selectedId.value = id;
  fetchState.value = 'idle';
  fetchMessage.value = '';
  keyMessage.value = '';
  newKeyInput.value = '';
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
  // Phase 3: 需要 keychain 有 key 才能拉
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

async function testConnection(provider: ProviderConfig) {
  await fetchModels(provider);
  if (fetchState.value === 'ok' && provider.models.length > 0) {
    fetchMessage.value = `✅ 连接成功, ${provider.models.length} 个模型可用`;
  }
}

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
  // 先删 keychain (best-effort, 失败不阻塞)
  piTauri.deleteApiKey(provider.id).catch(() => {});
  config.removeProvider(provider.id);
  if (selectedId.value === provider.id) {
    selectedId.value = config.providers[0]?.id ?? null;
  }
  void refreshAllKeyStatus();
}

function onProviderAdded(id: string) {
  selectedId.value = id;
  viewMode.value = 'list';
  void refreshAllKeyStatus();
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
      <!-- LEFT: list (240px) | add 模式下变 form (360px) -->
      <aside class="pad-providers__list-col">
        <div v-if="viewMode === 'add'" class="pad-providers__list-head">
          <span class="pad-providers__list-title">添加供应商</span>
        </div>
        <div v-else class="pad-providers__list-head">
          <span class="pad-providers__list-title">智谱 · 自定义供应商</span>
        </div>
        <div class="pad-providers__list-inner">
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
              <!-- key status dot: 绿=已配置, 灰=未配置 -->
              <span
                v-if="keyStatus[p.id]"
                class="pad-provider-card__keydot"
                :class="{ 'is-configured': keyStatus[p.id]?.configured }"
                :title="keyStatus[p.id]?.configured ? `已配置: ${keyStatus[p.id]?.preview}` : '未配置 key'"
              />
              <span v-if="p.id === config.activeProviderId" class="pad-provider-card__dot" />
            </button>
            <button v-if="config.providers.length === 0" class="pad-providers__empty" disabled>
              <Sparkles :size="14" :stroke-width="1.75" />
              <span>暂无 provider, 点下面 + 添加</span>
            </button>
          </template>
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
          <!-- Name -->
          <div class="pad-provider-detail__row">
            <div class="pad-provider-detail__row-label"><span>名称</span></div>
            <input
              class="pad-provider-detail__input"
              type="text"
              :value="selectedProvider.label"
              @input="config.updateProvider(selectedProvider.id, { label: ($event.target as HTMLInputElement).value })"
            />
          </div>

          <!-- Type -->
          <div class="pad-provider-detail__row">
            <div class="pad-provider-detail__row-label"><span>类型</span></div>
            <select
              class="pad-provider-detail__select"
              :value="selectedProvider.type"
              @change="config.updateProvider(selectedProvider.id, { type: (($event.target as HTMLSelectElement).value) as ProviderType })"
            >
              <option v-for="o in PROVIDER_OPTIONS" :key="o.id" :value="o.id">{{ o.label }}</option>
            </select>
          </div>

          <!-- Base URL (openai-compatible) -->
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

          <!-- API Key (Phase 3: 存 OS keychain) -->
          <div class="pad-provider-detail__row">
            <div class="pad-provider-detail__row-label">
              <span>API Key</span>
              <span class="pad-provider-detail__hint">存 OS keychain (Windows Credential Manager)</span>
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
              点"拉取"从 provider 拉可用模型. 需先存 API Key.
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
  width: 240px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 0;
  min-height: 0;
  background: var(--pad-bg-muted);
  border-right: 1px solid var(--pad-divider);
  transition: width var(--pad-dur-base) var(--pad-ease-in-out);
}
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
.pad-provider-card__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--pad-success);
  flex-shrink: 0;
}
.pad-provider-card__keydot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--pad-fg-tertiary);
  flex-shrink: 0;
  opacity: 0.4;
}
.pad-provider-card__keydot.is-configured {
  background: var(--pad-success);
  opacity: 1;
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
  grid-template-columns: 140px 1fr;
  gap: var(--pad-sp-3);
  align-items: start;
}
.pad-provider-detail__row-label {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-top: 8px;
  font-size: var(--pad-fs-12);
  color: var(--pad-fg-secondary);
}
.pad-provider-detail__hint {
  font-size: var(--pad-fs-11);
  color: var(--pad-fg-tertiary);
  font-weight: var(--pad-fw-regular);
}
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
  transition: border-color var(--pad-dur-fast) ease, box-shadow var(--pad-dur-fast) ease;
  width: 100%;
}
.pad-provider-detail__input:focus {
  border-color: var(--pad-accent);
  box-shadow: 0 0 0 3px var(--pad-accent-soft);
}
.pad-provider-detail__input--key {
  font-family: var(--pad-font-mono);
  letter-spacing: 0.02em;
}
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
  cursor: pointer;
  width: 100%;
}
.pad-provider-detail__key-form {
  display: flex;
  gap: var(--pad-sp-2);
  align-items: center;
}
.pad-provider-detail__key-configured {
  display: flex;
  align-items: center;
  gap: var(--pad-sp-2);
  flex-wrap: wrap;
}
.pad-provider-detail__key-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--pad-fs-12);
  color: var(--pad-success-text);
  font-weight: var(--pad-fw-medium);
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
  background: var(--pad-bg-elevated);
  padding: 2px 6px;
  border-radius: var(--pad-radius-sm);
  color: var(--pad-fg-secondary);
}
.pad-provider-detail__section {
  border-top: 1px solid var(--pad-divider);
  padding-top: var(--pad-sp-3);
  margin-top: var(--pad-sp-2);
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
  border-radius: var(--pad-radius-sm);
  font-size: var(--pad-fs-11);
  color: var(--pad-fg-secondary);
  background: transparent;
  border: 1px solid var(--pad-border);
  cursor: pointer;
  transition: all var(--pad-dur-fast) ease;
}
.pad-provider-detail__iconbtn:hover:not(:disabled) {
  background: var(--pad-bg-hover);
  color: var(--pad-fg-primary);
}
.pad-provider-detail__iconbtn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.pad-provider-detail__models-empty {
  font-size: var(--pad-fs-11);
  color: var(--pad-fg-tertiary);
  padding: var(--pad-sp-2) var(--pad-sp-3);
  background: var(--pad-bg-muted);
  border-radius: var(--pad-radius-md);
  border: 1px dashed var(--pad-border);
}
.pad-provider-detail__models {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.pad-provider-detail__model {
  display: flex;
  align-items: center;
  gap: var(--pad-sp-2);
  padding: var(--pad-sp-2) var(--pad-sp-3);
  border-radius: var(--pad-radius-md);
  cursor: pointer;
  border: 1px solid transparent;
  transition: all var(--pad-dur-fast) ease;
}
.pad-provider-detail__model:hover {
  background: var(--pad-bg-hover);
}
.pad-provider-detail__model.is-active {
  background: var(--pad-accent-soft);
  border-color: var(--pad-accent);
}
.pad-provider-detail__model-body {
  flex: 1;
  min-width: 0;
}
.pad-provider-detail__model-id {
  font-size: var(--pad-fs-12);
  color: var(--pad-fg-primary);
  font-family: var(--pad-font-mono);
}
.pad-provider-detail__model-label {
  font-size: var(--pad-fs-11);
  color: var(--pad-fg-tertiary);
  margin-top: 2px;
}
.pad-provider-detail__seg {
  display: inline-flex;
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-md);
  overflow: hidden;
  background: var(--pad-bg-input);
}
.pad-provider-detail__segbtn {
  height: 28px;
  padding: 0 var(--pad-sp-2);
  font-size: var(--pad-fs-12);
  color: var(--pad-fg-secondary);
  background: transparent;
  border: none;
  cursor: pointer;
  transition: all var(--pad-dur-fast) ease;
  font-family: inherit;
}
.pad-provider-detail__segbtn:not(:last-child) {
  border-right: 1px solid var(--pad-border);
}
.pad-provider-detail__segbtn:hover {
  background: var(--pad-bg-hover);
}
.pad-provider-detail__segbtn.is-active {
  background: var(--pad-accent-soft);
  color: var(--pad-accent);
  font-weight: var(--pad-fw-medium);
}
.pad-provider-detail__actions {
  display: flex;
  gap: var(--pad-sp-2);
  align-items: center;
  border-top: 1px solid var(--pad-divider);
  padding-top: var(--pad-sp-3);
  margin-top: var(--pad-sp-2);
}
.pad-provider-detail__btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 var(--pad-sp-3);
  border-radius: var(--pad-radius-md);
  font-size: var(--pad-fs-12);
  color: var(--pad-fg-primary);
  background: var(--pad-bg-input);
  border: 1px solid var(--pad-border);
  cursor: pointer;
  transition: all var(--pad-dur-fast) ease;
  font-family: inherit;
}
.pad-provider-detail__btn:hover:not(:disabled) {
  background: var(--pad-bg-hover);
  border-color: var(--pad-border-strong);
}
.pad-provider-detail__btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.pad-provider-detail__btn--small {
  height: 26px;
  padding: 0 var(--pad-sp-2);
  font-size: var(--pad-fs-11);
}
.pad-provider-detail__btn--primary {
  background: var(--pad-accent);
  color: var(--pad-fg-inverse);
  border-color: transparent;
}
.pad-provider-detail__btn--primary:hover:not(:disabled) {
  background: var(--pad-accent-hover);
}
.pad-provider-detail__btn--danger:hover {
  background: var(--pad-danger-subtle);
  color: var(--pad-danger-text);
  border-color: var(--pad-danger);
}
.pad-provider-detail__result {
  font-size: var(--pad-fs-11);
  padding: 6px 10px;
  border-radius: var(--pad-radius-sm);
  background: var(--pad-bg-muted);
  color: var(--pad-fg-secondary);
}
.pad-provider-detail__result.is-ok { color: var(--pad-success-text); background: var(--pad-success-subtle); }
.pad-provider-detail__result.is-fail { color: var(--pad-danger-text); background: var(--pad-danger-subtle); }
.pad-provider-detail__result.is-fetching { color: var(--pad-warning-text); background: var(--pad-warning-subtle); }
.pad-providers-fade-enter-active,
.pad-providers-fade-leave-active {
  transition: opacity var(--pad-dur-base) var(--pad-ease-out-soft);
}
.pad-providers-fade-enter-from,
.pad-providers-fade-leave-to {
  opacity: 0;
}
.is-spinning {
  animation: pad-spin 1s linear infinite;
}
@keyframes pad-spin {
  to { transform: rotate(360deg); }
}
</style>
