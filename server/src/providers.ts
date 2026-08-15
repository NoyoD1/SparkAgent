/**
 * Provider model fetch — 拉取 provider 的可用模型列表
 *
 * 两种 fetch 方式:
 * 1. OpenAI-compatible (自定义 baseUrl): GET {baseUrl}/models + Bearer auth
 * 2. 内置 provider: 走对应的 base URL + auth (大部分 OpenAI-compatible, Anthropic/Google 走硬编码)
 *
 * v0.2: apiKey 全部从 process.env 读 (client 不传), 安全
 *
 * 内置 provider 的模型数据, 部分走 API fetch, 部分走硬编码 (Phase 2+ 范围, 先稳)
 */

import type { Context } from 'hono';

export type ProviderType =
  | 'anthropic'
  | 'openai'
  | 'deepseek'
  | 'moonshotai'
  | 'google'
  | 'groq'
  | 'minimax'
  | 'openai-compatible';

export interface ModelInfo {
  id: string;
  label?: string;
}

export interface FetchModelsRequest {
  type: ProviderType;
  /** v0.2: 留作 optional, 实际从 env 读. openai-compatible 可从 client 传 (跟 baseUrl 配套) */
  apiKey?: string;
  baseUrl?: string;
  /** v0.2+: openai-compatible 专用, server 从 process.env[apiKeyEnv] 读 key */
  apiKeyEnv?: string;
}

export interface FetchModelsResponse {
  ok: boolean;
  models?: ModelInfo[];
  error?: string;
}

/**
 * v0.2: 从 server 进程 env 里读 provider 的 API key.
 * 命名约定 (内置 provider): process.env[`<PROVIDER>_API_KEY`] (PROVIDER 大写)
 *   - anthropic    → ANTHROPIC_API_KEY
 *   - openai       → OPENAI_API_KEY
 *   - deepseek     → DEEPSEEK_API_KEY
 *   - moonshotai   → MOONSHOTAI_API_KEY
 *   - google       → GOOGLE_API_KEY
 *   - groq         → GROQ_API_KEY
 *   - minimax      → MINIMAX_API_KEY  (特殊: MiniMax API key 来自 token.sensenova.cn 等代理, env 名通常被覆盖)
 *   - openai-compatible: 优先用 client config.apiKeyEnv (任意 env 名), fallback `OPENAI_COMPATIBLE_KEY`
 */
export function getApiKeyFromEnv(provider: string, customEnvName?: string): string | undefined {
  // openai-compatible: 优先用 client 指定的 env 名
  if (provider === 'openai-compatible' && customEnvName) {
    const key = process.env[customEnvName];
    if (key && key.length > 0) return key;
  }
  // 默认约定
  const defaultEnv = provider === 'openai-compatible'
    ? 'OPENAI_COMPATIBLE_KEY'
    : `${provider.toUpperCase()}_API_KEY`;
  const key = process.env[defaultEnv];
  return key && key.length > 0 ? key : undefined;
}

/** 内置 provider 的 OpenAI-compatible endpoint (有就 fetch, 没有就硬编码) */
const BUILTIN_OPENAI_COMPATIBLE: Partial<Record<ProviderType, string>> = {
  openai: 'https://api.openai.com/v1',
  deepseek: 'https://api.deepseek.com/v1',
  moonshotai: 'https://api.moonshot.cn/v1',
  groq: 'https://api.groq.com/openai/v1',
};

/** 内置 provider 的硬编码 fallback 模型 (fetch 失败时用) */
const BUILTIN_FALLBACK: Record<ProviderType, ModelInfo[]> = {
  anthropic: [
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
    { id: 'claude-opus-4-5', label: 'Claude Opus 4.5' },
    { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
  ],
  openai: [
    { id: 'gpt-4o', label: 'GPT-4o' },
    { id: 'gpt-4o-mini', label: 'GPT-4o mini' },
    { id: 'o4-mini', label: 'o4-mini' },
    { id: 'o3', label: 'o3' },
  ],
  deepseek: [
    { id: 'deepseek-chat', label: 'DeepSeek-V3 Chat' },
    { id: 'deepseek-reasoner', label: 'DeepSeek-R1 Reasoner' },
  ],
  moonshotai: [
    { id: 'kimi-k2-0711-preview', label: 'Kimi K2' },
    { id: 'moonshot-v1-128k', label: 'Moonshot v1 128k' },
    { id: 'moonshot-v1-32k', label: 'Moonshot v1 32k' },
  ],
  google: [
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
    { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash' },
  ],
  groq: [
    { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B' },
    { id: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B' },
    { id: 'mixtral-8x7b-32768', label: 'Mixtral 8x7B' },
  ],
  minimax: [
    { id: 'MiniMax-Text-01', label: 'MiniMax Text 01' },
  ],
  'openai-compatible': [], // 没 baseUrl 不能 fallback
};

/** 安全 redact 避免 apiKey 进日志 */
function redactApiKey(s: string): string {
  if (s.length <= 8) return '***';
  return `${s.slice(0, 4)}***${s.slice(-4)}`;
}

/** 调 OpenAI-compatible /models endpoint */
async function fetchOpenAICompatibleModels(
  baseUrl: string,
  apiKey: string,
): Promise<ModelInfo[]> {
  // baseUrl 标准化: 去尾部斜杠, 拼 /models
  const cleanBase = baseUrl.replace(/\/+$/, '');
  const url = `${cleanBase}/models`;

  const resp = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} ${resp.statusText} (${redactApiKey(apiKey)})`);
  }
  const data = (await resp.json()) as { data?: Array<{ id: string; owned_by?: string }> };
  if (!Array.isArray(data.data)) {
    throw new Error('Invalid response: no .data array');
  }
  return data.data
    .map((m) => ({ id: m.id, label: m.owned_by ? `${m.id} (${m.owned_by})` : undefined }))
    .filter((m) => !!m.id);
}

/** 调 Anthropic /v1/models (特殊 auth: x-api-key + anthropic-version) */
async function fetchAnthropicModels(apiKey: string): Promise<ModelInfo[]> {
  const resp = await fetch('https://api.anthropic.com/v1/models', {
    method: 'GET',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} ${resp.statusText} (${redactApiKey(apiKey)})`);
  }
  const data = (await resp.json()) as { data?: Array<{ id: string; display_name?: string }> };
  if (!Array.isArray(data.data)) {
    throw new Error('Invalid Anthropic response: no .data');
  }
  return data.data
    .map((m) => ({ id: m.id, label: m.display_name }))
    .filter((m) => !!m.id);
}

/** 调 Google Gemini /v1beta/models (key 走 query string) */
async function fetchGoogleModels(apiKey: string): Promise<ModelInfo[]> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`;
  const resp = await fetch(url, {
    method: 'GET',
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} ${resp.statusText} (${redactApiKey(apiKey)})`);
  }
  const data = (await resp.json()) as { models?: Array<{ name?: string; displayName?: string }> };
  if (!Array.isArray(data.models)) {
    throw new Error('Invalid Google response: no .models');
  }
  return data.models
    .map((m) => {
      const id = (m.name ?? '').replace(/^models\//, '');
      return { id, label: m.displayName ?? id };
    })
    .filter((m) => !!m.id);
}

/** 主入口: 拉取模型 */
export async function fetchProviderModels(
  req: FetchModelsRequest,
): Promise<FetchModelsResponse> {
  const { type, baseUrl } = req;
  // v0.2: apiKey 优先用 client 传的 (openai-compatible 模式), 内置 provider 走 env
  let apiKey = req.apiKey;
  if (!apiKey) {
    apiKey = getApiKeyFromEnv(type, req.apiKeyEnv) || '';
  }
  if (!apiKey) {
    const envHint = type === 'openai-compatible' && req.apiKeyEnv
      ? ` (or env \`${req.apiKeyEnv}\`)`
      : `Add \`${type.toUpperCase()}_API_KEY=...\` to server/.env and restart server.`;
    return {
      ok: false,
      error:
        `No API key for provider "${type}". ` +
        envHint,
    };
  }

  try {
    if (type === 'openai-compatible') {
      if (!baseUrl) {
        return { ok: false, error: 'baseUrl is required for openai-compatible' };
      }
      const models = await fetchOpenAICompatibleModels(baseUrl, apiKey);
      return { ok: true, models };
    }

    if (type === 'anthropic') {
      try {
        const models = await fetchAnthropicModels(apiKey);
        return { ok: true, models };
      } catch (e) {
        // 401/403/网络错误 — fallback 硬编码
        return {
          ok: true,
          models: BUILTIN_FALLBACK.anthropic,
          warning: `API fetch 失败 (${e instanceof Error ? e.message : String(e)}), 用内置 fallback list`,
        };
      }
    }

    if (type === 'google') {
      try {
        const models = await fetchGoogleModels(apiKey);
        return { ok: true, models };
      } catch (e) {
        return {
          ok: true,
          models: BUILTIN_FALLBACK.google,
          warning: `API fetch 失败 (${e instanceof Error ? e.message : String(e)}), 用内置 fallback list`,
        };
      }
    }

    if (type === 'minimax') {
      // MiniMax 没有标准 /models endpoint, 走 fallback
      return { ok: true, models: BUILTIN_FALLBACK.minimax };
    }

    // OpenAI-compatible 内置 (openai / deepseek / moonshotai / groq)
    const compatBase = BUILTIN_OPENAI_COMPATIBLE[type];
    if (compatBase) {
      try {
        const models = await fetchOpenAICompatibleModels(compatBase, apiKey);
        return { ok: true, models };
      } catch (e) {
        return {
          ok: true,
          models: BUILTIN_FALLBACK[type] ?? [],
          warning: `API fetch 失败 (${e instanceof Error ? e.message : String(e)}), 用内置 fallback list`,
        };
      }
    }

    return { ok: false, error: `Unknown provider type: ${type}` };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
