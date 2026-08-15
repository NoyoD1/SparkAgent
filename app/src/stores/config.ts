/**
 * Config store — 多 Provider 管理
 *
 * v0.2 设计 (apiKey 走 server .env):
 * - 用户加 N 个 Provider config (Anthropic / OpenAI / DeepSeek / 自定义 OpenAI 兼容)
 * - 每个 config 有自己的 models[] (拉取后缓存) + activeModelId
 * - activeProviderId 指向当前在 chat 里用的 provider
 * - localStorage 持久化: providers + activeProviderId + thinkingLevel (没 apiKey 字段)
 * - apiKey 完全在 server .env, client 协议层不传
 */

import { defineStore } from 'pinia';
import { ref, computed, watch } from 'vue';

export type ProviderType =
  | 'anthropic'
  | 'openai'
  | 'deepseek'
  | 'moonshotai'
  | 'google'
  | 'groq'
  | 'minimax'
  | 'openai-compatible';

export interface ThinkingLevel {
  value: 'off' | 'low' | 'medium' | 'high';
  label: string;
}

export interface ModelInfo {
  id: string;
  label?: string;
  fetchedAt?: string;
}

export interface ProviderOption {
  id: ProviderType;
  label: string;
  hint?: string;
  needsBaseUrl?: boolean;
}

export const PROVIDER_OPTIONS: ProviderOption[] = [
  { id: 'anthropic',          label: 'Anthropic (Claude)' },
  { id: 'openai',             label: 'OpenAI' },
  { id: 'deepseek',           label: 'DeepSeek' },
  { id: 'moonshotai',         label: 'Moonshot (Kimi)' },
  { id: 'google',             label: 'Google Gemini' },
  { id: 'groq',               label: 'Groq' },
  { id: 'minimax',           label: 'MiniMax' },
  { id: 'openai-compatible',  label: 'OpenAI 兼容 (自定义 baseUrl)', needsBaseUrl: true },
];

export interface ThinkingLevelOpt {
  value: 'off' | 'low' | 'medium' | 'high';
  label: string;
}

export const THINKING_LEVELS: ThinkingLevelOpt[] = [
  { value: 'off', label: '关闭' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
];

export interface ProviderConfig {
  id: string;
  type: ProviderType;
  label: string;
  /**
   * v0.2: apiKey 不在这里, 走 server .env (process.env[`${PROVIDER}_API_KEY`])
   * 兼容旧版: load 时读到 apiKey 字段会丢弃 (红色 migrate)
   */
  apiKey?: string;  // deprecated, will be stripped on load
  baseUrl?: string;
  /**
   * v0.2+: openai-compatible 专用. client 告诉 server "用 env 名字 X 拿 key".
   * 例: 'MYPROXY_KEY' / 'SHANGTANG_KEY' / 'OPENAI_COMPATIBLE_KEY'.
   * 内置 provider 忽略此字段.
   */
  apiKeyEnv?: string;
  models: ModelInfo[];
  activeModelId?: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

const STORAGE_KEY = 'pi-agent:config:v3';  // bump v2→v3: 删 apiKey 字段

function genId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function loadFromStorage(): {
  providers: ProviderConfig[];
  activeProviderId: string | null;
  thinkingLevel: 'off' | 'low' | 'medium' | 'high';
} {
  const fallback = {
    providers: [] as ProviderConfig[],
    activeProviderId: null as string | null,
    thinkingLevel: 'medium' as 'off' | 'low' | 'medium' | 'high',
  };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.providers)) return fallback;
    // v0.2: 强制 strip apiKey 字段, 即便旧 v2 数据带过来也不存
    const providers = parsed.providers.map((p: ProviderConfig) => {
      const { apiKey: _apiKey, ...rest } = p;
      return rest as ProviderConfig;
    });
    return {
      providers,
      activeProviderId: parsed.activeProviderId ?? null,
      thinkingLevel: parsed.thinkingLevel ?? 'medium',
    };
  } catch {
    return fallback;
  }
}

function saveToStorage(s: {
  providers: ProviderConfig[];
  activeProviderId: string | null;
  thinkingLevel: 'off' | 'low' | 'medium' | 'high';
}) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch (e) {
    console.warn('[config] localStorage save failed', e);
  }
}

export const useConfigStore = defineStore('config', () => {
  const initial = loadFromStorage();
  const providers = ref<ProviderConfig[]>(initial.providers);
  const activeProviderId = ref<string | null>(initial.activeProviderId);
  const thinkingLevel = ref<'off' | 'low' | 'medium' | 'high'>(initial.thinkingLevel);

  watch(
    [providers, activeProviderId, thinkingLevel],
    () => {
      saveToStorage({
        providers: providers.value,
        activeProviderId: activeProviderId.value,
        thinkingLevel: thinkingLevel.value,
      });
    },
    { deep: true },
  );

  // ===== Computed =====
  const activeProvider = computed<ProviderConfig | null>(
    () => providers.value.find((p) => p.id === activeProviderId.value) ?? null,
  );

  const activeModel = computed<ModelInfo | null>(() => {
    const p = activeProvider.value;
    if (!p || !p.activeModelId) return null;
    return p.models.find((m) => m.id === p.activeModelId) ?? null;
  });

  const isConfigured = computed(
    () => !!activeProvider.value && !!activeProvider.value.activeModelId,
  );

  // ===== Actions =====

  function addProvider(input: {
    type: ProviderType;
    label?: string;
    baseUrl?: string;
    apiKeyEnv?: string;
  }): ProviderConfig {
    const opt = PROVIDER_OPTIONS.find((o) => o.id === input.type);
    const defaultLabel = opt?.label ?? input.type;
    const provider: ProviderConfig = {
      id: genId(),
      type: input.type,
      label: input.label?.trim() || `${defaultLabel} #${providers.value.length + 1}`,
      baseUrl: input.baseUrl?.trim() || undefined,
      apiKeyEnv: input.apiKeyEnv?.trim() || undefined,
      models: [],
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    providers.value = [...providers.value, provider];
    return provider;
  }

  function updateProvider(id: string, patch: Partial<ProviderConfig>) {
    const idx = providers.value.findIndex((p) => p.id === id);
    if (idx < 0) return;
    providers.value[idx] = {
      ...providers.value[idx],
      ...patch,
      updatedAt: new Date().toISOString(),
    };
  }

  function removeProvider(id: string) {
    providers.value = providers.value.filter((p) => p.id !== id);
    if (activeProviderId.value === id) {
      activeProviderId.value = providers.value[0]?.id ?? null;
    }
  }

  function setProviderModels(id: string, models: ModelInfo[]) {
    const p = providers.value.find((x) => x.id === id);
    if (!p) return;
    p.models = models.map((m) => ({ ...m, fetchedAt: new Date().toISOString() }));
    // 如果 activeModelId 不在新 list 里, 重置
    if (p.activeModelId && !models.find((m) => m.id === p.activeModelId)) {
      p.activeModelId = undefined;
    }
    p.updatedAt = new Date().toISOString();
  }

  function setActiveModel(providerId: string, modelId: string) {
    const p = providers.value.find((x) => x.id === providerId);
    if (!p) return;
    if (!p.models.find((m) => m.id === modelId)) return;
    p.activeModelId = modelId;
    activeProviderId.value = providerId;
  }

  function setActiveProvider(providerId: string) {
    if (!providers.value.find((p) => p.id === providerId)) return;
    activeProviderId.value = providerId;
  }

  function setThinkingLevel(level: 'off' | 'low' | 'medium' | 'high') {
    thinkingLevel.value = level;
  }

  function clearAll() {
    providers.value = [];
    activeProviderId.value = null;
  }

  return {
    // state
    providers,
    activeProviderId,
    thinkingLevel,
    // computed
    activeProvider,
    activeModel,
    isConfigured,
    // actions
    addProvider,
    updateProvider,
    removeProvider,
    setProviderModels,
    setActiveModel,
    setActiveProvider,
    setThinkingLevel,
    clearAll,
  };
});
