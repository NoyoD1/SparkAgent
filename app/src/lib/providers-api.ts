/**
 * Provider model fetch — Phase 3 Tauri 版
 *
 * 走 Tauri command 'fetch_provider_models' (Rust 用 ureq 调 {baseUrl}/models).
 * apiKey 从 OS keychain 读 (Rust 拿, 不进前端).
 *
 * v0.5.0-D D213: 返回 model 自带 metadata (catalog 自动填 / openai-compatible 启发式 parse)
 *
 * 返回: { ok, models: [{id, label?, contextWindow?, maxOutput?, vision?, reasoning?, modelType?, autoSource?}], error? }
 */
import { piTauri } from './tauri';

export interface ModelInfo {
  id: string;
  label?: string;
  /** v0.5.0-D D213: 自动填充的 metadata */
  contextWindow?: number;
  maxOutput?: number;
  vision?: boolean;
  reasoning?: boolean;
  /** 注意: 这里 modelType 跟 store 里的 'type' 是同一字段, 为了对齐 store 的 ModelInfo 用 'type' */
  type?: 'chat' | 'image' | 'video' | 'audio' | 'embedding';
  /** "catalog" (内置静态) | "openai-compatible" (运行时 parse), undefined = 没匹配到 */
  autoSource?: 'catalog' | 'openai-compatible';
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
    const raw = await piTauri.fetchProviderModels(req.providerId, req.type, req.baseUrl ?? '');
    return {
      ok: true,
      models: raw.map((m) => ({
        id: m.id,
        label: m.label ?? undefined,
        contextWindow: m.contextWindow ?? undefined,
        maxOutput: m.maxOutput ?? undefined,
        vision: m.vision ?? undefined,
        reasoning: m.reasoning ?? undefined,
        type: (m.modelType ?? undefined) as ModelInfo['type'],  // 跟 store 的 ModelInfo 对齐用 'type'
        autoSource: m.autoSource ?? undefined,  // null → undefined 跟 store 对齐
      })),
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
