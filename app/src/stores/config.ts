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
  // v0.4.4.6: model metadata (跟 Pi SDK 0.84.2 ModelDefinitionSchema 白名单对齐, 简化).
  //   - type: 模型类型, 决定路由 (chat → LLM, image → image gen, video/audio/embedding → 后续 polish)
  //   - vision: 是否支持图片输入 (Pi SDK input: ['text', 'image'])
  //   - contextWindow: 最大上下文 token (Pi SDK contextWindow)
  //   - maxOutput: 单次回复 token 上限 (Pi SDK maxTokens)
  //   - maxRounds: LLM 连续 tool call 最多多少轮 (我们自己的, Pi SDK 没对应, 后续 Extension 层拦截)
  //   - reasoning: 是否思考模型 (Pi SDK reasoning)
  type?: 'chat' | 'image' | 'video' | 'audio' | 'embedding';
  vision?: boolean;
  contextWindow?: number;
  maxOutput?: number;
  maxRounds?: number;
  reasoning?: boolean;
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
  // P2 #1 fix: 删 apiKeyEnv dead code 字段. v0.2 设计是"openai-compatible 用 env 名取 key",
  //   实际 BYOK 全部走 keychain, 整个字段没人读 (UI / sidecar / Rust DTO 全无引用).
  //   保留 schema 字段反而是 tech debt, 后续开发看到会以为是 feature.
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
    // v0.4.2 step 1+: per-workspace stable sessionId, 让 sidecar 加载同一 session 历史
    perWorkspaceSessionId: {} as Record<string, string>,
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
// P2 #4 fix: 没 crypto.randomUUID 直接抛错, 不用低熵 fallback (Date.now + Math.random 可猜).
//   现代 Tauri WebView2 / 浏览器都有 crypto.randomUUID, 跑不到 fallback 算代码 bug.
function genId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  throw new Error('[config] crypto.randomUUID 不可用 — 当前 runtime 太老或 polyfill 缺失, 不能生成安全 id');
}

export const useConfigStore = defineStore('config', () => {
  // v0.3.8+: 初始为空, 等 App.vue onMounted 调 init() 异步加载
  const initial = emptyAppConfig();
  const providers = ref<ProviderConfig[]>(initial.providers);
  const activeProviderId = ref<string | null>(initial.activeProviderId);
  const thinkingLevel = ref<'off' | 'low' | 'medium' | 'high'>(initial.thinkingLevel);
  // v0.4.1+ tool permission mode
  const permissionMode = ref<PermissionMode>(initial.permissionMode);
  // v0.4.2 step 1+: per-workspace stable sessionId (key=workspacePath, value=sessionId uuidv7)
  const perWorkspaceSessionId = ref<Record<string, string>>({});
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
      // v0.4.2 step 1+: per-workspace sessionId 映射. 旧 config.json 没这字段 → undefined → 空对象
      perWorkspaceSessionId.value = (cfg.perWorkspaceSessionId && typeof cfg.perWorkspaceSessionId === 'object')
        ? cfg.perWorkspaceSessionId
        : {};
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
        perWorkspaceSessionId: perWorkspaceSessionId.value,  // v0.4.2 step 1+
      });
    } catch (e) {
      console.error('[config] save failed', e);
    } finally {
      saving.value = false;
    }
  }

  // P1 #4 fix: 500ms debounce, 避免连续改 metadata form / 多次 setActiveModel 触发连串写盘.
  // 之前每个 watch 触发都立刻 saveAppConfig, 改 6 字段 form 写 6 次盘.
  // 注意: load 流程 / migrateFromLocalStorage 仍走 persist() 直接调用, 不走 debounce (避免覆盖时序).
  let persistDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  function schedulePersist() {
    if (persistDebounceTimer !== null) {
      clearTimeout(persistDebounceTimer);
    }
    persistDebounceTimer = setTimeout(() => {
      persistDebounceTimer = null;
      void persist();
    }, 500);
  }

  // deep watch: 任一字段变 → debounce 500ms → persist
  watch(
    [providers, activeProviderId, thinkingLevel, permissionMode, perWorkspaceSessionId],
    () => {
      schedulePersist();
    },
    { deep: true },
  );

  // ===== Actions =====

  function addProvider(input: {
    type: ProviderType;
    label?: string;
    baseUrl?: string;
    /** P2 #2 fix: 内置 type 已配过, 允许覆盖 (例如用户误删想重建). 走 builtin UI 流程时 force=true. */
    force?: boolean;
  }): ProviderConfig {
    // P2 #2 fix: 防重复 type 拒绝 (内置 provider 配过就不让再加; openai-compatible 允许多个)
    if (!input.force && input.type !== 'openai-compatible') {
      const existing = providers.value.find((p) => p.type === input.type);
      if (existing) {
        throw new Error(`已存在 ${input.type} provider (label: ${existing.label}). 删除旧的后再加, 或在 builtin 流程用 force.`);
      }
    }
    const opt = PROVIDER_OPTIONS.find((o) => o.id === input.type);
    const defaultLabel = opt?.label ?? input.type;
    const provider: ProviderConfig = {
      id: genId(),
      type: input.type,
      label: input.label?.trim() || `${defaultLabel} #${providers.value.length + 1}`,
      baseUrl: input.baseUrl?.trim() || undefined,
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

  // v0.4.4.6: 单独更新某个 model 的 metadata (5 字段: type/vision/contextWindow/maxOutput/maxRounds/reasoning)
  //   partial 合并到现有 m 上, 不会重置 enabled/label/fetchedAt
  function updateModelMetadata(
    providerId: string,
    modelId: string,
    metadata: Partial<Pick<ModelInfo, 'type' | 'vision' | 'contextWindow' | 'maxOutput' | 'maxRounds' | 'reasoning'>>,
  ) {
    const p = providers.value.find((x) => x.id === providerId);
    if (!p) return;
    const m = p.models.find((x) => x.id === modelId);
    if (!m) return;
    // partial 合并, undefined 不动 (这样 form 留空可以保留之前的值)
    for (const [k, v] of Object.entries(metadata)) {
      if (v !== undefined) (m as any)[k] = v;
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

  // ====== v0.4.2 step 1+: per-workspace sessionId getter/setter =====
  /**
   * 拿 workspace 关联的 sessionId. 第一次没设过 → 返回 undefined (sidecar 会自动生成新 id).
   * 注意: 切 workspace 时用 setSessionIdForWorkspace 同步写回去 (即使 undefined 也要清旧值, 防 workspace 改名残留).
   */
  function getSessionIdForWorkspace(workspacePath: string): string | undefined {
    return perWorkspaceSessionId.value[workspacePath];
  }
  /**
   * 设置 workspace 关联的 sessionId. 同步写回 config_store, 切回时 sidecar 走同一 session.
   * 传 undefined 移除 (workspace 改名 / 删了后清理).
   */
  function setSessionIdForWorkspace(workspacePath: string, sessionId: string | undefined) {
    if (sessionId === undefined) {
      const next = { ...perWorkspaceSessionId.value };
      delete next[workspacePath];
      perWorkspaceSessionId.value = next;
    } else {
      perWorkspaceSessionId.value = { ...perWorkspaceSessionId.value, [workspacePath]: sessionId };
    }
  }
  /**
   * v0.5.4 hotfix: lazy create + persist per-workspace sessionId.
   *
   * 背景: v0.4.2 step 1 加了 per-workspace stable sessionId 机制 (config store getter/setter,
   *   config_store.rs 持久化, sidecar 接收 id 走 setSessionFile 走 load 模式),
   *   但整个项目**没人调** setSessionIdForWorkspace 写回, 也没人调 getSessionIdForWorkspace
   *   拿值 (v0.4.2 step 1 commit message 自己承认"没跑端到端真实 LLM 验证", 用 PI_FAUX mock 跳过).
   *
   * 后果: sendPrompt 时 getSessionIdForWorkspace() 永远返回 undefined → Tauri 传 None → sidecar
   *   SessionManager.create({id: undefined}) 内部 createSessionId() 创 `sess-${Date.now()}-${random}`
   *   随机 id → 每次 prompt 一个新 file, AI 永远"第一次对话" (user 截图里 .pi 目录 24 个 .jsonl).
   *
   * 修法: sendPrompt 调 ensureSessionIdForWorkspace 拿一个保证存在的 id (没就生成 v4 UUID
   *   写回 store 立即 persist). 之后所有 prompt 走同一个 id → sidecar 扫到 `${ts}_${sid}.jsonl`
   *   → setSessionFile 走 load → AI 看到 history.
   *
   * Pi SDK 0.84.2 不校验 sessionId 格式, 任意 string 都接受 (走 setSessionFile 走 file path 后缀
   *   匹配 + 内容 parse, 只要 file 是合法 jsonl 就行).
   */
  function ensureSessionIdForWorkspace(workspacePath: string): string {
    let sid = perWorkspaceSessionId.value[workspacePath];
    if (!sid) {
      // crypto.randomUUID() 是 v4 UUID (128 bit 熵), 跟 Pi SDK 内部 uuidv7 兼容 (Pi SDK 不校验格式)
      sid = crypto.randomUUID();
      perWorkspaceSessionId.value = { ...perWorkspaceSessionId.value, [workspacePath]: sid };
      void persist();  // 立即落盘, 切回 workspace 时还在
      console.log('[config] ensureSessionIdForWorkspace: generated new', { workspacePath, sid: sid.slice(0, 16) });
    }
    return sid;
  }

  return {
    // state
    providers,
    activeProviderId,
    thinkingLevel,
    permissionMode,
    perWorkspaceSessionId,  // v0.4.2 step 1+
    loaded,
    saving,
    // computed
    activeProvider,
    activeModel,
    isConfigured,
    allEnabledModels,
    // functions
    enabledModels,
    getSessionIdForWorkspace,  // v0.4.2 step 1+
    ensureSessionIdForWorkspace,  // v0.5.4 hotfix: lazy create + persist per-workspace sessionId
    // actions
    init,
    addProvider,
    updateProvider,
    removeProvider,
    setProviderModels,
    toggleModelEnabled,
    updateModelMetadata,
    setActiveModel,
    setActiveProvider,
    setThinkingLevel,
    setPermissionMode,
    setSessionIdForWorkspace,  // v0.4.2 step 1+
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
