/**
 * Pi Agent Tauri Client — v0.5.0 RPC mode.
 *
 * 跟 v0.4.x 比, 不再手写 v0.4.x 自定义 IPC 协议 (config_ok / config_error /
 * permission_request / 各种 tool_* / message_update delta field), 改成 Pi SDK
 * 0.84.2 原生 RpcEvent 协议:
 *   - invoke('send_prompt', { sessionId, content, config })  启动一次 LLM 调用
 *   - invoke('send_rpc_command', { sessionId, commandJson })  通用 RpcCommand 透传
 *     (permission dialog 响应 → extension_ui_response / abort / set_model / compact)
 *   - listen('chat:event', (e) => ...)  收 RpcEvent stream (Pi SDK 原生 event)
 *   - invoke('save_api_key' | 'delete_api_key' | 'list_api_keys' | 'has_api_key' |
 *     'migrate_from_env' | ...)  走 keychain
 *
 * 跟 ws.ts 的区别:
 *   - apiKey 永不在前端 (走 OS keychain, Rust 直接读)
 *   - 协议没 apiKey 字段, 只有 providerId (keychain key)
 *   - 多并发 prompt 通过 sessionId 区分
 */

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

console.log('[pi-tauri] module loaded, tauri-internals=', typeof (window as any).__TAURI_INTERNALS__);

// ====== Event types (v0.5.0: Pi SDK 0.84.2 RpcEvent schema 透传) ======
export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high';

/** Pi SDK AgentMessage 简化 schema (FE 只关心 role + content + tool_calls) */
export interface AgentMessageLite {
  role: 'user' | 'assistant' | 'toolResult';
  content: string | AgentContentBlock[];
  /** tool call id (assistant 调 tool 时) */
  toolCallId?: string;
  /** tool name (assistant 调 tool 时) */
  toolName?: string;
  /** tool call args (assistant 调 tool 时) */
  args?: Record<string, unknown>;
  /** tool call result (toolResult 消息时) */
  result?: unknown;
  /** isError (toolResult 消息时) */
  isError?: boolean;
  /** token usage (assistant 消息时) */
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: { input: number; output: number; cacheRead: number; cacheWrite: number } };
}

export type AgentContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };

/** v0.5.0 Pi SDK RpcEvent (跟 Pi SDK 0.84.2 AgentSessionEvent / AgentEvent 对齐, 外加 sessionId) */
export type ServerToClient =
  | { type: 'agent_start'; sessionId: string }
  | {
      type: 'agent_end';
      sessionId: string;
      /** Pi SDK 0.84.2 AgentSessionEvent.agent_end: { messages: AgentMessage[]; willRetry: boolean } */
      messages?: AgentMessageLite[];
      willRetry?: boolean;
    }
  | { type: 'agent_settled'; sessionId: string }
  | { type: 'turn_start'; sessionId: string }
  | {
      type: 'turn_end';
      sessionId: string;
      message?: AgentMessageLite;
      toolResults?: AgentMessageLite[];
    }
  | {
      type: 'message_start';
      sessionId: string;
      /** Pi SDK AgentEvent.message_start: { message: AgentMessage } */
      message: AgentMessageLite;
    }
  | {
      type: 'message_update';
      sessionId: string;
      /** Pi SDK 0.84.2 JsonAgentSessionEvent.message_update:
       *  json-event.ts: ToJsonEvent 转换显式把 message_update 顶层加上 `usage`,
       *  同时剥离 assistantMessageEvent.partial (cumulative snapshot 由 message_start 提
       *  供, deltas build it, message_end 提供 final authoritative message).
       *  最终 wire schema: { type, usage, assistantMessageEvent } — **没有顶层 message**.
       *  v0.4.3.2 之前我 v0.5.0 commit 7ef5b8b 写顶层 `usage?` optional, chat store 读
       *  event.usage 永远 undefined → 0 0 0 0; 我 v0.4.3.2 修成 event.message?.usage 仍
       *  是错的 (message_update 根本没顶层 message 字段). 正确读法: event.usage (顶层).
       *  see: pi-sdk/packages/coding-agent/src/modes/json-event.ts:6-15, 31-45
       */
      usage: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
      };
      /**
       * 嵌套 streaming event. 跟 v0.4.x 直接 delta 字段不一样.
       * - { type: 'text_delta', delta: string }        text 流式
       * - { type: 'thinking_delta', delta: string }    thinking 流式
       * - { type: 'tool_call_delta', delta: string }   tool call args 流式
       * - { type: 'done' }                              assistant 消息结束
       */
      assistantMessageEvent:
        | { type: 'text_delta'; delta: string }
        | { type: 'thinking_delta'; delta: string }
        | { type: 'tool_call_delta'; delta: string }
        | { type: 'done' };
    }
  | {
      type: 'message_end';
      sessionId: string;
      message: AgentMessageLite;
      /** Pi SDK 0.84.2 json-event.ts:32-34:
       *  `if (event.type !== 'message_update') return event` — message_end 保持原 AgentSessionEvent
       *  schema: { type, message: AgentMessage }. message.usage 是 AssistantMessage 必填字段
       *  (types.ts:415 `usage: Usage;`), FE 读 event.message.usage. */
    }
  // v0.5.0 tool_execution_* (Pi SDK 用 tool_execution_* 不是 v0.4.x 的 tool_*)
  | {
      type: 'tool_execution_start';
      sessionId: string;
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
    }
  | {
      type: 'tool_execution_update';
      sessionId: string;
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
      partialResult: unknown;
    }
  | {
      type: 'tool_execution_end';
      sessionId: string;
      toolCallId: string;
      toolName: string;
      result: unknown;
      isError: boolean;
    }
  // v0.4.4 Skills (Pi SDK 暴露) — sidecar 启动时一次性 emit, FE 存 skills store
  //   走 chat:event channel (跟 RpcEvent 共用), payload 不是 RpcEvent 而是 sidecar 自定义协议
  //   (类似 v0.4.x config_ok, runRpcMode 接管 stdout 之前 emit). 没 sessionId (跟 session 无关).
  | {
      type: 'skills_snapshot';
      skills: Array<{
        name: string;
        description: string;
        filePath: string;
        baseDir: string;
        disableModelInvocation: boolean;
      }>;
      diagnostics: Array<{ type: string; message: string; path?: string }>;
    }
  // v0.4.2 step 1+ retry (5x exponential backoff, Pi SDK AgentSession 内置)
  | {
      type: 'auto_retry_start';
      sessionId: string;
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      errorMessage: string;
    }
  | {
      type: 'auto_retry_end';
      sessionId: string;
      success: boolean;
      /** Pi SDK 用单数 attempt (不是 v0.4.x 的 attempts) */
      attempt: number;
      finalError?: string;
    }
  // v0.4.2 step 1+ compaction (手动 / 自动 threshold / overflow)
  | {
      type: 'compaction_start';
      sessionId: string;
      reason: 'manual' | 'threshold' | 'overflow';
    }
  | {
      type: 'compaction_end';
      sessionId: string;
      reason: 'manual' | 'threshold' | 'overflow';
      /** Pi SDK CompactionResult */
      result?: unknown;
      aborted: boolean;
      willRetry: boolean;
      errorMessage?: string;
    }
  // v0.5.0 extension UI (替代 v0.4.x 的 permission_request) — Pi SDK RPC 协议
  // 弹窗 method: select / confirm / input / editor / notify / setStatus / setWidget / setTitle
  | {
      type: 'extension_ui_request';
      sessionId: string;
      id: string;
      method: 'select' | 'confirm' | 'input' | 'editor' | 'notify' | 'setStatus' | 'setWidget' | 'setTitle' | 'set_editor_text';
      title?: string;
      message?: string;
      options?: string[];
      placeholder?: string;
      prefill?: string;
      notifyType?: 'info' | 'warning' | 'error';
      statusKey?: string;
      statusText?: string | undefined;
      widgetKey?: string;
      widgetLines?: string[] | undefined;
      widgetPlacement?: 'aboveEditor' | 'belowEditor';
      timeout?: number;
    }
  // v0.4.2.x fix: 顶层错误事件 (跟 v0.4.x 兼容, Rust emit_error 触发)
  | { type: 'error'; message: string; sessionId: string };

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
      /** v0.4.4 Skills (Pi SDK 暴露): FE 维护 enabled skill names (存 localStorage),
       *  send_prompt 时传 sidecar, sidecar 走 formatSkillsForPrompt 注入 system prompt.
       *  enabled 改变必须重启 sidecar (D165 systemPrompt 不可动态改). */
      skills?: { enabledNames: string[]; extraPaths?: string[] };
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
          skills: cfg.skills ?? { enabledNames: [] },  // v0.4.4 Skills (Pi SDK 暴露)
        },
      });
      console.log('[pi-tauri] sendPrompt invoke resolved', res);
    } catch (e) {
      console.error('[pi-tauri] sendPrompt invoke FAILED', e);
      throw e;
    }
  }

  /**
   * v0.5.0: 通用 RpcCommand 透传 — 替代 v0.4.x 的 sendPermissionResponse / setPermissionMode / compactSession
   * 3 个特殊 invoke. FE 端构造 RpcCommand 对象, 这里 JSON.stringify 后 invoke('send_rpc_command', ...).
   * 典型用法:
   *   - 权限弹窗:  sendRpcCommand({ type: 'extension_ui_response', id, confirmed: true })
   *   - abort:     sendRpcCommand({ type: 'abort' })
   *   - set_model: sendRpcCommand({ type: 'set_model', provider, modelId })
   *   - compact:   sendRpcCommand({ type: 'compact' })
   *   - 等等, 40+ RpcCommand 都走这一个
   */
  async sendRpcCommand(
    sessionId: string,
    cmd: Record<string, unknown>,
  ): Promise<void> {
    const commandJson = JSON.stringify(cmd);
    console.log('[pi-tauri] sendRpcCommand', { sessionId, type: (cmd as any).type });
    try {
      await invoke('send_rpc_command', { sessionId, commandJson });
    } catch (e) {
      console.error('[pi-tauri] sendRpcCommand FAILED', e);
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

  /**
   * v0.3.5+ 默认工作区: 在 home dir 下创建 PiAgent/ 目录 (e.g. C:\Users\<user>\PiAgent).
   * 初始状态发消息时无 workspace → 调这个拿一个默认地址, 不弹 picker.
   * 用户仍可通过 sidebar / tab strip 的"本地"下拉手动选别处.
   */
  async ensureDefaultWorkspace(): Promise<string> {
    return (await invoke('ensure_default_workspace')) as string;
  }

  // ====== v0.4.4 Skills: 写自定义 SKILL.md (scope: 'workspace' | 'global') ======
  async writeSkillFile(args: {
    scope: 'workspace' | 'global';
    name: string;
    body: string;
    workspacePath?: string | null;
    agentDir?: string | null;
  }): Promise<string> {
    return (await invoke('write_skill_file', { args })) as string;
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
