/**
 * Provider model fetch — client 端
 * 调 server /api/providers/fetch-models, 返回 model 列表
 *
 * v0.2: apiKey 走 server .env, client 不传
 */

import type { ProviderType, ModelInfo } from '@/stores/config';

export interface FetchModelsRequest {
  type: ProviderType;
  /** v0.2 deprecated, 留空走 server env. openai-compatible 可选. */
  apiKey?: string;
  baseUrl?: string;
  /** v0.2+: openai-compatible 专用, server 从 process.env[apiKeyEnv] 读 key */
  apiKeyEnv?: string;
}

export interface FetchModelsResponse {
  ok: boolean;
  models?: ModelInfo[];
  warning?: string;
  error?: string;
}

export async function fetchProviderModels(
  req: FetchModelsRequest,
): Promise<FetchModelsResponse> {
  try {
    // 显式不传 apiKey, 强制走 server env
    const { apiKey: _unused, ...payload } = req;
    const resp = await fetch('/api/providers/fetch-models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      return { ok: false, error: `HTTP ${resp.status}` };
    }
    return await resp.json() as FetchModelsResponse;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
