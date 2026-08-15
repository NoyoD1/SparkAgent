/**
 * Pi Agent Tauri Client — replaces lib/ws.ts.
 *
 * 用 Tauri 2 的 invoke + listen 跟 Rust host 通信:
 *   - invoke('send_prompt', { sessionId, content, config })  启动一次 LLM 调用
 *   - listen('chat:event', (e) => ...)                       收流式事件
 *   - invoke('save_api_key' | 'delete_api_key' | 'list_api_keys' | 'has_api_key' | 'migrate_from_env')
 *
 * 跟 ws.ts 的区别:
 *   - apiKey 永不在前端 (走 OS keychain, Rust 直接读)
 *   - 协议没 apiKey 字段, 只有 providerId (keychain key)
 *   - 多并发 prompt 通过 sessionId 区分
 */

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

console.log('[pi-tauri] module loaded, tauri-internals=', typeof (window as any).__TAURI_INTERNALS__);

// ====== Event types (跟 server/src/types.ts ServerToClient 对齐 + 加 sessionId) ======
export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high';

export type ServerToClient =
  | { type: 'ready' }
  | { type: 'config_ok'; provider: string; model: string; sessionId?: string }
  | { type: 'config_error'; message: string; sessionId?: string }
  | { type: 'agent_start'; sessionId: string }
  | { type: 'message_start'; sessionId: string }
  | { type: 'message_update'; delta: string; sessionId: string }
  | { type: 'tool_start'; toolName: string; toolCallId: string; args: Record<string, unknown>; sessionId: string }
  | { type: 'tool_update'; toolCallId: string; delta: string; sessionId: string }
  | { type: 'tool_end'; toolCallId: string; result?: unknown; error?: string; sessionId: string }
  | { type: 'message_end'; sessionId: string }
  | { type: 'agent_end'; sessionId: string }
  | { type: 'error'; message: string; sessionId: string };

type Handler = (event: ServerToClient) => void;

class PiTauriClient {
  private handlers = new Set<Handler>();
  private listenerStarted = false;

  private async ensureListener(): Promise<void> {
    if (this.listenerStarted) return;
    this.listenerStarted = true;
    try {
      await listen<ServerToClient>('chat:event', (e) => {
        for (const h of this.handlers) {
          try {
            h(e.payload);
          } catch (err) {
            console.error('[pi-tauri] handler threw', err);
          }
        }
      });
      console.log('[pi-tauri] listening on chat:event');
    } catch (err) {
      console.error('[pi-tauri] listen failed', err);
      this.listenerStarted = false;
    }
  }

  /** 注册事件 listener, 返回 unsubscribe */
  on(h: Handler): () => void {
    this.handlers.add(h);
    void this.ensureListener();
    return () => this.handlers.delete(h);
  }

  /**
   * 发 prompt. 走 invoke('send_prompt') → Rust 读 keychain + 启 sidecar.
   * apiKey 不在 client, 不进协议.
   */
  async sendPrompt(
    sessionId: string,
    content: string,
    configGetter: () => {
      providerId: string;
      provider: string;
      model: string;
      baseUrl?: string;
      thinkingLevel: ThinkingLevel;
    } | null,
  ): Promise<void> {
    console.log('[pi-tauri] sendPrompt called', { sessionId, contentLen: content.length });
    const cfg = configGetter();
    console.log('[pi-tauri] sendPrompt config=', cfg);
    if (!cfg || !cfg.providerId || !cfg.provider || !cfg.model) {
      throw new Error('未配置 Provider (去 Settings → Providers 添加并选 active provider + model)');
    }
    try {
      const res = await invoke('send_prompt', {
        sessionId,
        content,
        config: {
          providerId: cfg.providerId,
          provider: cfg.provider,
          model: cfg.model,
          baseUrl: cfg.baseUrl ?? null,
          thinkingLevel: cfg.thinkingLevel,
        },
      });
      console.log('[pi-tauri] sendPrompt invoke resolved', res);
    } catch (e) {
      console.error('[pi-tauri] sendPrompt invoke FAILED', e);
      throw e;
    }
  }

  // ====== Keychain API ======
  async saveApiKey(providerId: string, apiKey: string): Promise<void> {
    await invoke('save_api_key', { providerId, apiKey });
  }

  async deleteApiKey(providerId: string): Promise<void> {
    await invoke('delete_api_key', { providerId });
  }

  async hasApiKey(providerId: string): Promise<boolean> {
    return (await invoke('has_api_key', { providerId })) as boolean;
  }

  async listApiKeys(): Promise<
    Array<{ providerId: string; configured: boolean; preview: string | null }>
  > {
    return (await invoke('list_api_keys')) as Array<{
      providerId: string;
      configured: boolean;
      preview: string | null;
    }>;
  }

  async migrateFromEnv(envPath?: string): Promise<{
    migrated: Array<{ envVar: string; providerId: string; preview: string }>;
    skipped: string[];
    error: string | null;
  }> {
    return (await invoke('migrate_from_env', { envPath: envPath ?? null })) as {
      migrated: Array<{ envVar: string; providerId: string; preview: string }>;
      skipped: string[];
      error: string | null;
    };
  }

  async fetchProviderModels(
    providerId: string,
    baseUrl: string,
  ): Promise<Array<{ id: string; label: string | null }>> {
    return (await invoke('fetch_provider_models', { providerId, baseUrl })) as Array<{
      id: string;
      label: string | null;
    }>;
  }
}

export const piTauri = new PiTauriClient();
void piTauri['ensureListener']();

// 调试用: 把 piTauri 暴露到 window, 方便 F12 console 直接调
if (typeof window !== 'undefined') {
  (window as any).__piTauri = piTauri;
  console.log('[pi-tauri] window.__piTauri exposed for console debugging');
}
