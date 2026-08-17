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
  /** v0.4.1 step 累加: Pi SDK 一次 prompt 可能跑多个 turn (tool_call 链), turn_start/turn_end 标 step 边界 */
  | { type: 'turn_start'; sessionId: string }
  | { type: 'turn_end'; sessionId: string }
  | { type: 'message_start'; sessionId: string }
  | { type: 'message_update'; delta: string; kind?: 'thinking' | 'content'; sessionId: string }
  | { type: 'tool_start'; toolName: string; toolCallId: string; args: Record<string, unknown>; sessionId: string }
  | { type: 'tool_update'; toolCallId: string; delta: string; sessionId: string }
  | { type: 'tool_end'; toolCallId: string; result?: unknown; error?: string; sessionId: string }
  | { type: 'message_end'; sessionId: string }
  | { type: 'agent_end'; sessionId: string }
  | { type: 'error'; message: string; sessionId: string }
  // v0.4.1+ tool permission: sidecar 问 FE "LLM 想跑 X tool, 允许吗"
  | { type: 'permission_request'; toolCallId: string; toolName: string; args: Record<string, unknown>; sessionId: string }
  // v0.4.2 step 1 (AgentSession 内置): 5 次指数退避 (1s/2s/4s/8s/16s), AgentSession 内部自动 retry, 走 auto_retry_* 事件
  | { type: 'auto_retry_start'; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string; sessionId: string }
  | { type: 'auto_retry_end'; success: boolean; attempts: number; finalError?: string; sessionId: string }
  // v0.4.2 step 1 (AgentSession 内置): 上下文压缩, 走 reason (manual / threshold / overflow) + result / willRetry / errorMessage
  | { type: 'compaction_start'; reason: 'manual' | 'threshold' | 'overflow'; sessionId: string }
  | { type: 'compaction_end'; reason: 'manual' | 'threshold' | 'overflow'; success: boolean; willRetry: boolean; errorMessage?: string; sessionId: string };

type Handler = (event: ServerToClient) => void;

class PiTauriClient {
  private handlers = new Set<Handler>();
  private listenerStarted = false;
  private listenerReadyPromise: Promise<void> | null = null;

  private ensureListener(): Promise<void> {
    if (this.listenerReadyPromise) return this.listenerReadyPromise;
    this.listenerReadyPromise = (async () => {
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
        this.listenerReadyPromise = null; // 允许下次重试
      }
    })();
    return this.listenerReadyPromise;
  }

  /**
   * v0.3.5+ 等待 listener 注册完成再返回.
   * 调用 sendPrompt 之前 await 一下, 避免 sidecar 早早 emit 但 JS 还没 ready 丢事件.
   */
  async waitForListener(): Promise<void> {
    return this.ensureListener();
  }

  /** 注册事件 handler, **async** 因为内部要 await listener 注册. */
  async on(h: Handler): Promise<() => void> {
    this.handlers.add(h);
    await this.ensureListener();
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
      /** v0.3.8.11: 当前 workspace 目录绝对路径 (用于 system message 注入 LLM) */
      workspacePath?: string | null;
      /** v0.4.1+ tool permission mode (ask / smart / allow), 初始值 */
      permissionMode?: 'ask' | 'smart' | 'allow';
      /** v0.4.2 step 1+: per-workspace stable sessionId (从 configStore.perWorkspaceSessionId 读),
       *  让 sidecar 用同一 session 加载历史. undefined 时 sidecar 内部生成新 id. */
      sessionId?: string | null;
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
          workspacePath: cfg.workspacePath ?? null,  // v0.3.8.11
          permissionMode: cfg.permissionMode ?? 'ask',  // v0.4.1+ tool permission 初始值
          sessionId: cfg.sessionId ?? null,  // v0.4.2 step 1+
        },
      });
      console.log('[pi-tauri] sendPrompt invoke resolved', res);
    } catch (e) {
      console.error('[pi-tauri] sendPrompt invoke FAILED', e);
      throw e;
    }
  }

  // ====== v0.4.1+ tool permission IPC ======
  /**
   * FE 端 PermissionDialog 点了 允许/拒绝, 调这个发回 sidecar
   * - allow=true  → sidecar 放行 tool 执行
   * - allow=false → sidecar 阻止 tool (Pi SDK emit error tool result)
   *
   * v0.4.2.x fix: 必须传 sessionId, Rust 端 PermissionResponseMsg.session_id 是 required
   *   (没 #[serde(default)]), 之前漏传 → Tauri 抛 "missing required key msg" → 整个
   *   permission 流程崩, sidecar 永远等不到 permission_response → LLM 卡死 → 用户
   *   只能 abort → 3 个 step 都累积 "This operation was aborted" 错误提示.
   */
  async sendPermissionResponse(
    sessionId: string,
    toolCallId: string,
    allow: boolean,
    reason?: string,
  ): Promise<void> {
    console.log('[pi-tauri] sendPermissionResponse', { sessionId, toolCallId, allow, reason });
    await invoke('send_permission_response', {
      sessionId,
      toolCallId,
      allow,
      reason: reason ?? null,
    });
  }

  /**
   * v0.4.1+ 用户在 Composer 切了 permission mode, 调这个实时同步到 sidecar.
   * 下次 tool call 用新 mode.
   */
  async setPermissionMode(mode: 'ask' | 'smart' | 'allow'): Promise<void> {
    console.log('[pi-tauri] setPermissionMode', { mode });
    await invoke('set_permission_mode', { mode });
  }

  // ====== v0.4.2 step 1+ context management IPC ======
  /**
   * 手动压缩当前 session 的历史. 走 AgentSession.compact() (LLM-driven summary, 跟 Pi 主线一致).
   * 触发后 sidecar 会 emit compaction_start → compaction_end 事件, FE 在 chat store 显示 toast / banner.
   * @param sessionId - 当前 session 的 id (per-workspace)
   */
  async compactSession(sessionId: string): Promise<void> {
    console.log('[pi-tauri] compactSession', { sessionId });
    await invoke('compact_session', { sessionId });
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

  /**
   * v0.3.5+ 默认工作区: 在 home dir 下创建 PiAgent/ 目录 (e.g. C:\Users\<user>\PiAgent).
   * 初始状态发消息时无 workspace → 调这个拿一个默认地址, 不弹 picker.
   * 用户仍可通过 sidebar / tab strip 的"本地"下拉手动选别处.
   */
  async ensureDefaultWorkspace(): Promise<string> {
    return (await invoke('ensure_default_workspace')) as string;
  }

  // ====== App config (v0.3.8+: 持久化到 Rust 文件, 替代 localStorage) ======
  // 走 Rust 持久化是因为 WebView2 缓存被清时 localStorage 也被擦, provider 配置会丢.
  // 文件位置: %APPDATA%\com.piagent.desktop\config.json
  async loadAppConfig(): Promise<AppConfig> {
    return (await invoke('load_app_config')) as AppConfig;
  }
  async saveAppConfig(config: AppConfig): Promise<void> {
    await invoke('save_app_config', { config });
  }
}

// ====== App config 类型 (跟 Rust 端 config_store::AppConfig 对齐) ======
export interface AppConfig {
  version: number;
  providers: AppProviderConfig[];
  activeProviderId: string | null;
  thinkingLevel: 'off' | 'low' | 'medium' | 'high';
  /** v0.4.1+ tool permission 模式 (跟 Rust config_store permission_mode 对齐, 旧 config.json 缺这字段) */
  permissionMode?: 'ask' | 'smart' | 'allow';
  /**
   * v0.4.2 step 1+: 每个 workspace 关联的 sessionId (uuid v7), 切回 workspace 时让 sidecar 加载同一 session.
   * key = workspace 绝对路径, value = sessionId (跟 SessionManager 文件 <id>.jsonl 对应).
   * 旧 config.json 没这字段 → 默认空对象, 第一次切 workspace 时 sidecar 会生成新 sessionId.
   */
  perWorkspaceSessionId?: Record<string, string>;
}
export interface AppProviderConfig {
  id: string;
  type: string;
  label: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  models: AppModelInfo[];
  activeModelId?: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface AppModelInfo {
  id: string;
  label?: string;
  enabled?: boolean;
  fetchedAt?: string;
}

export const piTauri = new PiTauriClient();
// 模块加载时立即启动 listener (fire-and-forget), 加速首次 sendPrompt
void piTauri.waitForListener();

// 调试用: 把 piTauri 暴露到 window, 方便 F12 console 直接调
// R1: dev-only 守卫 — 生产构建不带这个, 防止注入脚本/扩展调 listApiKeys 等命令
if (typeof window !== 'undefined' && import.meta.env.DEV) {
  (window as any).__piTauri = piTauri;
  console.log('[pi-tauri] window.__piTauri exposed for dev console debugging');
}
