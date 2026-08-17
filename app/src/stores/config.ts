/**
 * Config store — 多 Provider 管理
 *
 * v0.3.8+: 持久化改走 Rust (load_app_config / save_app_config) → %APPDATA%\com.piagent.desktop\config.json
 * - 之前用 WebView2 localStorage 会被清 WebView2 缓存时一起擦掉
 * - 现在独立 OS 文件, 跟 keychain 一样安全 + 持久
 * - apiKey 继续走 OS keychain (永不出前端)
 *
 * v0.3.8.1+: Pinia HMR 保护 (防止 Vite 热更时 store 状态被重置为 [] 触发 watch 写空)
 * 初始化: 空状态起步, App.vue onMounted 调 init() 异步加载
 * 改动: watch 自动调 piTauri.saveAppConfig 持久化
 */

import { defineStore, acceptHMRUpdate } from 'pinia';
import { ref, computed, watch } from 'vue';
import { piTauri } from '@/lib/tauri';

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
  /** v0.3.2+: 用户在 Settings 手动启停. undefined/true = 启用, false = 停用 */
  enabled?: boolean;
}

export interface ProviderOption {
  id: ProviderType;
  label: string;
  hint?: string;
  needsBaseUrl?: boolean;
  /** v0.3.8+: 内置 provider. 始终在 Settings 列表显示, 不需要"添加"步骤. */
  builtin?: boolean;
}

export const PROVIDER_OPTIONS: ProviderOption[] = [
  { id: 'anthropic',          label: 'Anthropic (Claude)',  builtin: true },
  { id: 'openai',             label: 'OpenAI',              builtin: true },
  { id: 'deepseek',           label: 'DeepSeek',            builtin: true },
  { id: 'moonshotai',         label: 'Moonshot (Kimi)',     builtin: true },
  { id: 'google',             label: 'Google Gemini',       builtin: true },
  { id: 'groq',               label: 'Groq',                builtin: true },
  { id: 'minimax',            label: 'MiniMax',            builtin: true },
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

/** 跟 Rust 端 config_store::AppConfig 对齐 */
function emptyAppConfig() {
  return {
    version: 1,
    providers: [] as ProviderConfig[],
    activeProviderId: null as string | null,
    thinkingLevel: 'medium' as 'off' | 'low' | 'medium' | 'high',
    // v0.4.1+: tool permission mode (跟 Rust config_store 默认 ask 对齐)
    permissionMode: 'ask' as PermissionMode,
  };
}

/** v0.4.1+ tool permission 模式.
 *  - ask: 每次 tool call 显式 confirm (最安全, 默认值)
 *  - smart: 读自动放行, 写/命令/删 confirm (中等, 适合日常开发)
 *  - allow: 全部自动放行 (最省心但最危险, 不推荐)
 */
export type PermissionMode = 'ask' | 'smart' | 'allow';

export const PERMISSION_MODE_OPTIONS: Array<{ value: PermissionMode; label: string; hint: string; icon: string }> = [
  { value: 'ask',   label: '主动询问', hint: '每个工具调用前都问一次',           icon: 'Hand' },
  { value: 'smart', label: '智能授权', hint: '读文件自动放行, 写/命令/删才问',  icon: 'Sparkles' },
  { value: 'allow', label: '始终授权', hint: '全部自动放行, 不再询问',           icon: 'CheckCheck' },
];

/**
 * v0.3.8+ 内置 provider 的常见 model 列表.
 * 简化版 — 实际生产可走 provider 的 /v1/models 端点拉, 但 sidecar 现在只支持 openai-compatible.
 * 用法: 内置 provider 配置 key 后, 用户从此列表选 active model, 也可手输自定义 id.
 */
export const BUILTIN_MODELS: Record<Exclude<ProviderType, 'openai-compatible'>, string[]> = {
  anthropic:  ['claude-3-5-sonnet-latest', 'claude-3-5-haiku-latest', 'claude-3-opus-latest'],
  openai:     ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo'],
  deepseek:   ['deepseek-chat', 'deepseek-reasoner', 'deepseek-coder'],
  moonshotai: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
  google:     ['gemini-1.5-pro', 'gemini-1.5-flash', 'gemini-2.0-flash-exp'],
  groq:       ['llama-3.1-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'],
  minimax:    ['MiniMax-M2', 'MiniMax-M1', 'abab6.5s-chat'],
};

// R2: provider id 改用 crypto.randomUUID() (128 bit 熵), 不再可猜
// 老 id (timestamp 形式) 仍合法, 不会被破坏; 新 id 用 UUID v4
function genId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // 极端 fallback: 旧实现, 不在现代浏览器/Tauri 走
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export const useConfigStore = defineStore('config', () => {
  // v0.3.8+: 初始为空, 等 App.vue onMounted 调 init() 异步加载
  const initial = emptyAppConfig();
  const providers = ref<ProviderConfig[]>(initial.providers);
  const activeProviderId = ref<string | null>(initial.activeProviderId);
  const thinkingLevel = ref<'off' | 'low' | 'medium' | 'high'>(initial.thinkingLevel);
  // v0.4.1+ tool permission mode
  const permissionMode = ref<PermissionMode>(initial.permissionMode);
  const loaded = ref(false);  // v0.3.8+: init() 完成后置 true
  const saving = ref(false);  // 写入 Rust 中, UI 可以 disable input

  /** v0.3.8+: App.vue onMounted 调一次, 从 Rust 文件读 */
  async function init() {
    try {
      const cfg = await piTauri.loadAppConfig();
      // 强制 strip apiKey 字段 (防御性, 旧数据可能带过来)
      const cleanProviders = (cfg.providers ?? []).map((p: any) => {
        const { apiKey: _apiKey, ...rest } = p;
        return rest as ProviderConfig;
      });
      providers.value = cleanProviders;
      activeProviderId.value = cfg.activeProviderId ?? null;
      // v0.3.8.1 fix: 旧 build 写过空串, 落盘后读出还是空. 用 || 替代 ?? 让 "" 也走 fallback
      const tl = (cfg.thinkingLevel as any) || 'medium';
      thinkingLevel.value = (tl === 'off' || tl === 'low' || tl === 'medium' || tl === 'high') ? tl : 'medium';
      // v0.4.1+: permission mode. 旧 config.json 没这字段 → undefined → 走 'ask' fallback
      const pm = (cfg.permissionMode as any) || 'ask';
      permissionMode.value = (pm === 'ask' || pm === 'smart' || pm === 'allow') ? pm : 'ask';
      // 如果读出来的字段跟默认不同, 主动落一次盘 (修旧数据)
      if (tl !== thinkingLevel.value) {
        console.log('[config] init: normalized thinkingLevel', JSON.stringify(tl), '->', thinkingLevel.value);
        void persist();
      }
      if (pm !== permissionMode.value) {
        console.log('[config] init: normalized permissionMode', JSON.stringify(pm), '->', permissionMode.value);
        void persist();
      }
      console.log('[config] init loaded: providers=', providers.value.length, 'active=', activeProviderId.value);
    } catch (e) {
      console.warn('[config] init failed (use empty defaults)', e);
    } finally {
      loaded.value = true;
    }
  }

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

  // v0.3.8.5: 返回指定 provider 的 enabled models (过滤掉用户停用的)
  // undefined / true = 启用, false = 停用
  function enabledModels(providerId: string): ModelInfo[] {
    const p = providers.value.find((x) => x.id === providerId);
    if (!p) return [];
    return p.models.filter((m) => m.enabled !== false);
  }

  // v0.3.8.5: 全部 enabled models (跨 provider), 给将来的 quick bar 等用
  const allEnabledModels = computed<Array<{ provider: ProviderConfig; model: ModelInfo }>>(
    () => {
      const out: Array<{ provider: ProviderConfig; model: ModelInfo }> = [];
      for (const p of providers.value) {
        for (const m of p.models) {
          if (m.enabled !== false) {
            out.push({ provider: p, model: m });
          }
        }
      }
      return out;
    },
  );

  // ===== 改动自动保存到 Rust =====
  async function persist() {
    if (!loaded.value) return;  // init 没完不写, 避免覆盖文件
    saving.value = true;
    try {
      await piTauri.saveAppConfig({
        version: 1,
        providers: providers.value,
        activeProviderId: activeProviderId.value,
        thinkingLevel: thinkingLevel.value,
        permissionMode: permissionMode.value,
      });
    } catch (e) {
      console.error('[config] save failed', e);
    } finally {
      saving.value = false;
    }
  }

  // deep watch: 任一字段变 → persist
  watch(
    [providers, activeProviderId, thinkingLevel, permissionMode],
    () => {
      void persist();
    },
    { deep: true },
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
    p.models = models.map((m) => ({
      ...m,
      enabled: m.enabled !== false, // 默认为启用, 只在显式 false 时停用
      fetchedAt: new Date().toISOString(),
    }));
    // 如果 activeModelId 不在新 list 里, 重置
    if (p.activeModelId && !models.find((m) => m.id === p.activeModelId)) {
      p.activeModelId = undefined;
    }
    p.updatedAt = new Date().toISOString();
  }

  function toggleModelEnabled(providerId: string, modelId: string) {
    const p = providers.value.find((x) => x.id === providerId);
    if (!p) return;
    const m = p.models.find((x) => x.id === modelId);
    if (!m) return;
    m.enabled = m.enabled === false ? true : false;
    // 关掉的如果是 active, 清掉 active
    if (m.enabled === false && p.activeModelId === modelId) {
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

  /** v0.4.1+: 切换 tool permission 模式 */
  function setPermissionMode(mode: PermissionMode) {
    permissionMode.value = mode;
  }

  function clearAll() {
    providers.value = [];
    activeProviderId.value = null;
  }

  /**
   * v0.3.8.1+: 从 v0.3.6 老 localStorage (`pi-agent:config:v3`) 迁移 provider 配置.
   *
   * 场景: 之前在 v0.3.6 build 用过, 配置存在 localStorage.
   * 切换到 v0.3.8+ build 后, Rust config.json 是空的, localStorage 数据孤儿化.
   *
   * 流程:
   * 1. App.vue init() 完成后, 如果 providers 空, 调这个
   * 2. 读 localStorage `pi-agent:config:v3`
   * 3. 解析 providers, 写入 store (触发 watch → 持久化到 config.json)
   * 4. 返回迁移了多少个, UI 可提示
   */
  function migrateFromLocalStorage(): { migrated: number; source: 'localStorage' | 'none' } {
    if (typeof localStorage === 'undefined') return { migrated: 0, source: 'none' };
    try {
      const raw = localStorage.getItem('pi-agent:config:v3');
      if (!raw) return { migrated: 0, source: 'none' };
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed.providers) || parsed.providers.length === 0) {
        return { migrated: 0, source: 'none' };
      }
      // 强制 strip apiKey (旧 v2/v3 数据如果带过的话)
      const cleanProviders: ProviderConfig[] = parsed.providers.map((p: any) => {
        const { apiKey: _apiKey, ...rest } = p;
        return rest as ProviderConfig;
      });
      providers.value = cleanProviders;
      if (parsed.activeProviderId) activeProviderId.value = parsed.activeProviderId;
      if (parsed.thinkingLevel && (parsed.thinkingLevel === 'off' || parsed.thinkingLevel === 'low' || parsed.thinkingLevel === 'medium' || parsed.thinkingLevel === 'high')) {
        thinkingLevel.value = parsed.thinkingLevel;
      }
      console.log('[config] migrated', cleanProviders.length, 'providers from localStorage → config.json');
      // 主动 persist 一次 (写盘), 之后 watch 也会触发
      void persist();
      return { migrated: cleanProviders.length, source: 'localStorage' };
    } catch (e) {
      console.warn('[config] migrateFromLocalStorage failed', e);
      return { migrated: 0, source: 'none' };
    }
  }

  return {
    // state
    providers,
    activeProviderId,
    thinkingLevel,
    permissionMode,
    loaded,
    saving,
    // computed
    activeProvider,
    activeModel,
    isConfigured,
    allEnabledModels,
    // functions
    enabledModels,
    // actions
    init,
    addProvider,
    updateProvider,
    removeProvider,
    setProviderModels,
    toggleModelEnabled,
    setActiveModel,
    setActiveProvider,
    setThinkingLevel,
    setPermissionMode,
    clearAll,
    migrateFromLocalStorage,
  };
});

// v0.3.8.1+: Pinia HMR 保护
// 之前 Vite HMR 重新执行 config.ts 时, store 会被重置为初始 [], watch 触发写空到 config.json
// 用户的 provider 配置就这样丢了. acceptHMRUpdate 让 Pinia 跨 HMR 保留 state.
if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useConfigStore, import.meta.hot));
}
