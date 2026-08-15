/**
 * Provider model fetch — Phase 3 Tauri 版
 *
 * 走 Tauri command 'fetch_provider_models' (Rust 用 ureq 调 {baseUrl}/models).
 * apiKey 从 OS keychain 读 (Rust 拿, 不进前端).
 *
 * 返回: { ok, models: [{id, label?}], error? }
 */
import { piTauri } from './tauri';

export interface ModelInfo {
  id: string;
  label?: string;
}

export interface FetchModelsRequest {
  type: string;
  baseUrl?: string;
  /** Phase 3: Tauri 用 providerId 查 keychain (前端不再需要 apiKey) */
  providerId: string;
}

export interface FetchModelsResponse {
  ok: boolean;
  models?: ModelInfo[];
  error?: string;
}

export async function fetchProviderModels(
  req: FetchModelsRequest,
): Promise<FetchModelsResponse> {
  if (req.type === 'openai-compatible' && !req.baseUrl) {
    return { ok: false, error: 'baseUrl is required for openai-compatible' };
  }
  try {
    const raw = await piTauri.fetchProviderModels(req.providerId, req.baseUrl ?? '');
    return {
      ok: true,
      models: raw.map((m) => ({ id: m.id, label: m.label ?? undefined })),
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
