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

// ====== 2.1: WorkspaceTreeNode (list_workspace_tree 返回) ======
export interface WorkspaceTreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children: WorkspaceTreeNode[] | null;  // 文件 = null, 目录 = array (可能空)
}

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
  /**
   * v0.5.0-D 第29轮 (D212): LLM 错误信息 (assistant 消息时, stopReason='error' 时设)
   *   之前 (D204 前) 只在顶层 error 事件里有 errorMessage, 没在 AssistantMessage 上;
   *   现在从 message_end 直接读, 用于推 error divider.
   *   e.g. "429: Allocated quota exceeded" (rate limit), "network: timeout" 等
   */
  errorMessage?: string;
  /**
   * v0.5.0-D 第29轮 (D212): LLM 终止原因.
   *   - 'end_turn': 正常结束
   *   - 'toolUse': 调 tool 后停
   *   - 'max_tokens': 超出 max tokens
   *   - 'error': 异常 (e.g. 429 quota, network error)
   *   - 'abort': user 主动停止
   */
  stopReason?: 'end_turn' | 'toolUse' | 'max_tokens' | 'error' | 'abort' | string;
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
  // v0.4.5: slash commands snapshot (Pi SDK BUILTIN_SLASH_COMMANDS 21 个, 跟 skills_snapshot 同 pattern)
  | {
      type: 'slash_snapshot';
      commands: Array<{
        name: string;
        description: string;
        argumentHint: string | null;
        source: 'builtin' | 'custom' | 'extension' | 'prompt' | 'skill';
      }>;
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
    // ADR-0022 v3.5 (2026-08-23): 多模态 image content blocks
    //   Pi SDK 0.84.2 RpcCommand.prompt.images 字段原生支持
    //   vision model 看图, 文本模型忽略
    //   数组为空/undefined 时 Rust 端不构造 images 字段 (兼容老逻辑)
    images: Array<{ type: 'image'; data: string; mimeType: string }> = [],
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
      /** v0.4.4.6 model metadata (从 configStore.activeModel 读):
       *  - type: 模型类型, 决定路由 (chat/image/video/audio/embedding)
       *  - vision: 是否支持图片输入 (Pi SDK input: ['text', 'image'])
       *  - contextWindow: 最大上下文 token (Pi SDK contextWindow)
       *  - maxOutput: 单次回复 token 上限 (Pi SDK maxTokens)
       *  - maxRounds: LLM 连续 tool call 最多多少轮 (我们自己的, 后续 Extension 层拦截)
       *  - reasoning: 是否思考模型 (Pi SDK reasoning)
       *  sidecar 收到后把 metadata 拼到 user-custom model object (内置 provider 走 Pi SDK catalog 不需要). */
      modelMetadata?: {
        type?: 'chat' | 'image' | 'video' | 'audio' | 'embedding';
        vision?: boolean;
        contextWindow?: number;
        maxOutput?: number;
        maxRounds?: number;
        reasoning?: boolean;
      };
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
        // ADR-0022 v3.5: 透传 image content blocks 给 Pi SDK
        images: images.length > 0 ? images : null,
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
          modelMetadata: cfg.modelMetadata ?? null,  // v0.4.4.6 model metadata (user-custom path only)
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
   *   - compact:   sendRpcCommand({ type: 'compact' })  ← ⚠️ Bug #2 修: 用 compactSession() 替代
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

  /**
   * v0.4.6 Bug 修 (abort 后重发继续走): force kill sidecar child.
   * 背景: spawn-per-prompt 模式下, abort 触发后 Pi SDK 应该 emit agent_end 然后 sidecar 退出.
   *   但实际在某些 provider (MiniMax / DeepSeek V4 Flash) 上 agent_end 偶尔 lost, 30s 兜底
   *   forceStopStreaming 翻 streaming=false 但旧 sidecar 还在跑, AgentSession state 还在 hold.
   *   下次 send_prompt 启新 sidecar resume 时, 看到 incomplete message → "顺着前打断续走".
   * 修法: 30s 兜底 catch 时调这个, 主动 kill 旧 child + 移除 active map entry.
   * @returns true = 真杀了 child, false = 没找到 child (已退出)
   */
  async killSidecar(sessionId: string): Promise<boolean> {
    try {
      const res = await invoke<boolean>('kill_sidecar', { sessionId });
      console.log('[pi-tauri] killSidecar', { sessionId, killed: res });
      return res;
    } catch (e) {
      console.error('[pi-tauri] killSidecar FAILED', e);
      return false;
    }
  }

  /**
   * ADR-0023 (2026-08-23): 静默重启所有 active sidecar
   *   触发场景: 改了"需要重启"的配置 (MCP server / external tool / dangerousWhitelist /
   *     bash.path / system prompt override / user tool preset), Pi SDK tool 注册只在
   *     createAgentSession 时一次, 必须新 sidecar 进程才生效.
   *   行为: 杀所有 active sidecar children + emit `sidecar:event` 事件. 下次 send_prompt
   *     时 Tauri run_prompt 走 lazy spawn 路径, 读新 config 起新 sidecar. FE 无感
   *     (1-2 秒, 不弹 modal, 不阻塞 UI).
   *   副作用: 正在 streaming 的 LLM 响应会被断掉, run_prompt task 走 synthesized
   *     agent_end 路径, FE 收到后走正常 error 收尾视觉.
   * @param reason 给 log + UI toast 用的描述 (e.g. "mcp_server_changed", "external_tool_added")
   * @returns killed count (被杀的 child 数, 0 表示当前没 active sidecar, 啥都不影响)
   */
  async restartAllSidecars(reason: string): Promise<number> {
    try {
      const res = await invoke<number>('restart_all_sidecars', { reason });
      console.log('[pi-tauri] restartAllSidecars', { reason, killed: res });
      return res;
    } catch (e) {
      console.error('[pi-tauri] restartAllSidecars FAILED', e);
      return 0;
    }
  }

  /**
   * ADR-0022 v2 (2026-08-23): 切换 Browser Panel 显隐 (右上角 button 调用)
   *   - 不存在 → 创建 + dock 主窗口右侧 + show
   *   - hidden → dock 同步位置 + show
   *   - visible → hide (不 destroy, 保留 webview state, 下次 toggle 复用)
   * @returns 新状态 { visible: boolean }
   */
  async toggleBrowserPanel(): Promise<{ visible: boolean }> {
    try {
      const res = await invoke<{ visible: boolean }>('toggle_browser_panel');
      console.log('[pi-tauri] toggleBrowserPanel →', res);
      return res;
    } catch (e) {
      console.error('[pi-tauri] toggleBrowserPanel FAILED', e);
      throw e;
    }
  }

  /** ADR-0022 v2: 启动时同步 Browser Panel 初始状态 (visible/hidden/不存在) */
  async getBrowserPanelState(): Promise<{ visible: boolean }> {
    try {
      return await invoke<{ visible: boolean }>('get_browser_panel_state');
    } catch (e) {
      console.error('[pi-tauri] getBrowserPanelState FAILED', e);
      return { visible: false };
    }
  }

  /**
   * ADR-0022 v3.5 (2026-08-23): user 上传 (粘贴图片 / 拖文件) 存盘
   * 把 blob/arraybuffer 转成 Uint8Array, 传 bytes 给 Tauri 写盘
   * 返绝对路径, FE 再用路径拼到 message text (file) 或 images[] (image)
   *
   * 限制: 10 MB / 块, 扩展名白名单 (FE 端也校验一次, Rust 端兜底)
   */
  async saveUploadedFile(data: Uint8Array, filename: string): Promise<string> {
    try {
      // Tauri command 期望 Vec<u8>, JS 传 number[] 序列化为 JSON 时会失败 (会变成 array of numbers, deserialize 失败)
      // 用 invoke 直接传: Tauri 2 支持 Uint8Array 跨 IPC, 自动序列化
      const path = await invoke<string>('save_uploaded_file', { data, filename });
      console.log('[pi-tauri] saveUploadedFile', { filename, path, bytes: data.byteLength });
      return path;
    } catch (e) {
      console.error('[pi-tauri] saveUploadedFile FAILED', e);
      throw e;
    }
  }

  /**
   * ADR-0022 v3.8 (2026-08-23): 读 text 文件前 N 行, 给 useAttachmentPreview 用 (Composer file chip 点开预览用, TaskDrawer 文件点开预览用, ChatMessage 用户上传文件点开预览用)
   * Rust 端 spawn_blocking 跑 sync std::fs (防阻塞 async runtime), 限 max_lines <= 10_000 防 OOM
   */
  async readTextFilePreview(path: string, maxLines: number = 200): Promise<string> {
    try {
      const content = await invoke<string>('read_text_file_preview', { path, maxLines });
      return content || '';
    } catch (e) {
      console.error('[pi-tauri] readTextFilePreview FAILED', e);
      throw e;
    }
  }

  /**
   * ADR-0022 v3.9: 从 savedPath 重读图片, 转 ImageContent (base64 + mime)
   *   - 给 useAttachmentPreview.openImageFromPath 用
   *   - 场景: user 重开 session, message.images[].data (in-memory) 已被 sanitize 剥掉,
   *           click thumbnail 触发这个, 拿完整 base64 开大图
   *   - Rust 端限 50MB 防 OOM
   */
  async readImageAsDataUrl(path: string): Promise<{ data: string; mimeType: string }> {
    try {
      const result = await invoke<{ kind: string; data: string; mimeType: string }>(
        'read_image_as_data_url',
        { path },
      );
      return { data: result.data, mimeType: result.mimeType };
    } catch (e) {
      console.error('[pi-tauri] readImageAsDataUrl FAILED', e);
      throw e;
    }
  }

  /**
   * ADR-0022 v3 (2026-08-23): FE 顶部 URL bar 主动导航 (不依赖 agent)
   * 跟 sidecar 调 web_navigate 一样的 URL 校验, 但不返回 text (user 视觉可见 webview)
   */
  async browserNavigateUrl(url: string): Promise<void> {
    try {
      await invoke('browser_navigate_url', { url });
    } catch (e) {
      console.error('[pi-tauri] browserNavigateUrl FAILED', e);
      throw e;
    }
  }

  /** ADR-0022 v3: webview 后退 (调 webview history.back()) */
  async browserNavigateBack(): Promise<void> {
    try {
      await invoke('browser_navigate_back');
    } catch (e) {
      console.error('[pi-tauri] browserNavigateBack FAILED', e);
      throw e;
    }
  }

  /** ADR-0022 v3: webview 前进 (调 webview history.forward()) */
  async browserNavigateForward(): Promise<void> {
    try {
      await invoke('browser_navigate_forward');
    } catch (e) {
      console.error('[pi-tauri] browserNavigateForward FAILED', e);
      throw e;
    }
  }

  /** ADR-0022 v3: webview 刷新 (调 webview location.reload()) */
  async browserNavigateRefresh(): Promise<void> {
    try {
      await invoke('browser_navigate_refresh');
    } catch (e) {
      console.error('[pi-tauri] browserNavigateRefresh FAILED', e);
      throw e;
    }
  }

  /**
   * Bug #2 修 (2026-08-18): 独立 compact_session invoke.
   * 跟 sendPrompt 签名几乎一样, 但走 `compact_session` invoke 强制单独 spawn 一个
   * sidecar 跑 compact, 不依赖当前 session 是否有 active child.
   * 背景: 之前走 sendRpcCommand(sid, { type: 'compact' }), 但闲置 session 时
   *   ActiveSidecars map 已空, 报 "no active sidecar for session=..." → FE 视觉
   *   "点了没反应".
   *
   * 限制: 调用方需保证当前 session 不在 streaming (会跟 sidecar 写 jsonl 冲突).
   *   chat.ts compact() 入口已经 check isStreaming.
   */
  async compactSession(
    sessionId: string,
    configGetter: () => {
      providerId: string;
      provider: string;
      model: string;
      baseUrl?: string;
      thinkingLevel: ThinkingLevel;
      workspacePath?: string | null;
      permissionMode?: 'ask' | 'smart' | 'allow';
      sessionId?: string | null;
      skills?: { enabledNames: string[]; extraPaths?: string[] };
      modelMetadata?: {
        type?: 'chat' | 'image' | 'video' | 'audio' | 'embedding';
        vision?: boolean;
        contextWindow?: number;
        maxOutput?: number;
        maxRounds?: number;
        reasoning?: boolean;
      };
    } | null,
  ): Promise<void> {
    console.log('[pi-tauri] compactSession called', { sessionId });
    const cfg = configGetter();
    if (!cfg || !cfg.providerId || !cfg.provider || !cfg.model) {
      throw new Error('未配置 Provider (去 Settings → Providers 添加并选 active provider + model)');
    }
    try {
      await invoke('compact_session', {
        sessionId,
        config: {
          providerId: cfg.providerId,
          provider: cfg.provider,
          model: cfg.model,
          baseUrl: cfg.baseUrl ?? null,
          thinkingLevel: cfg.thinkingLevel,
          workspacePath: cfg.workspacePath ?? null,
          permissionMode: cfg.permissionMode ?? 'ask',
          sessionId: cfg.sessionId ?? null,
          skills: cfg.skills ?? { enabledNames: [] },
          modelMetadata: cfg.modelMetadata ?? null,
        },
      });
      console.log('[pi-tauri] compactSession invoke resolved');
    } catch (e) {
      console.error('[pi-tauri] compactSession invoke FAILED', e);
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

  // ====== ADR-0023 P3-C (2026-08-24): 通用 secret 管理 (MCP / external tool 用) ======
  //   跟 saveApiKey 走同一个 keychain service="pi-agent", 区别只是 key 名字是 secret
  //   (mcp-<server>-<field> / external-<tool>-<field>).
  //   触发 P3-A 静默重启: 改了 secret → 走 triggerRestart 复用模式
  async saveSecret(name: string, value: string): Promise<void> {
    await invoke('save_secret', { name, value });
  }

  async deleteSecret(name: string): Promise<void> {
    await invoke('delete_secret', { name });
  }

  async listSecrets(): Promise<
    Array<{ providerId: string; configured: boolean; preview: string | null }>
  > {
    return (await invoke('list_secrets')) as Array<{
      providerId: string;
      configured: boolean;
      preview: string | null;
    }>;
  }

  // ====== v0.4.4.6 Skills list (FE 主动拉) ======
  // 之前 v0.4.4.x sidecar 启动时 emit skills_snapshot 一次, 写完 skill 后 UI 不刷新
  // 修法: Tauri 端 list_skills 走 std::fs::read_dir 扫两个目录 (workspace + global),
  //   跟 sidecar 的 skills_snapshot 解耦, 纯 UI 列表用.
  // 写完/导入完成后 FE 调这个, 立刻刷新.
  // v0.4.4.6.3: 必须用 { args } 包裹, 跟 write_skill_file / import_skill_* 同 pattern.
  //   Rust 端 fn list_skills(args: ListSkillsArgs) 期望 { args: { workspacePath, agentDir } },
  //   直接展开会报 "command list-skills missing required key args" (D183 现场重演).
  async listSkills(args: { workspacePath?: string | null; agentDir?: string | null }): Promise<{
    skills: TauriSkillInfo[];
    diagnostics: TauriSkillDiagnostic[];
  }> {
    return (await invoke('list_skills', {
      args: {
        workspacePath: args.workspacePath ?? null,
        agentDir: args.agentDir ?? null,
      },
    })) as { skills: TauriSkillInfo[]; diagnostics: TauriSkillDiagnostic[] };
  }

  // ====== v0.4.5.2: User 自定义快捷提示词模板 (Slash commands) ======
  // 跟 v0.4.6.1 agents 同 pattern, Tauri 2 invoke 必须 { args } 包裹 (D193 教训)
  // D184 v9 ❷ user 14:30: 只显示 user 自定义, 不显示 builtin 22
  async listCommands(args: {
    workspacePath?: string | null;
    agentDir?: string | null;
  }): Promise<TauriCommandInfo[]> {
    return (await invoke('list_commands', {
      args: {
        workspacePath: args.workspacePath ?? null,
        agentDir: args.agentDir ?? null,
      },
    })) as TauriCommandInfo[]
  }

  async readCommand(args: {
    workspacePath?: string | null;
    agentDir?: string | null;
    name: string;
  }): Promise<TauriCommandInfo> {
    return (await invoke('read_command', { args })) as TauriCommandInfo
  }

  async writeCommand(args: {
    workspacePath?: string | null;
    agentDir?: string | null;
    name: string;
    content: string;
  }): Promise<string> {
    return (await invoke('write_command', { args })) as string
  }

  async deleteCommand(args: {
    workspacePath?: string | null;
    agentDir?: string | null;
    name: string;
  }): Promise<boolean> {
    return (await invoke('delete_command', { args })) as boolean
  }

  // ====== 2026-08-20 P1-5: User tools (从 builtin tool 派生的 args 预设模板) ======
  // 跟 Skills / Commands 同 pattern: 两层 scope (workspace + global, workspace 优先).
  //   - workspace: <workspacePath>/.pi/tools/<name>.json
  //   - global:   <agentDir>/tools/<name>.json
  // FE UI: Settings → Tools tab (新 tab, 跟 Skills/Commands/CustomInstructions 同级)
  async listUserTools(args: {
    workspacePath?: string | null;
    agentDir?: string | null;
  }): Promise<TauriUserToolInfo[]> {
    // v0.6.3-rc1 P2-1.2 修: Rust 端 fn list_user_tools(workspace_path, agent_dir) 是独立参数,
    //   跟 list_workspace_tree 同 pattern, 不能包 `args` (之前抄 list_skills 写错了).
    return (await invoke('list_user_tools', {
      workspacePath: args.workspacePath ?? null,
      agentDir: args.agentDir ?? null,
    })) as TauriUserToolInfo[]
  }

  async readUserTool(args: {
    scope: 'workspace' | 'global';
    workspacePath?: string | null;
    agentDir?: string | null;
    name: string;
  }): Promise<string> {
    return (await invoke('read_user_tool', { args })) as string
  }

  async writeUserTool(args: {
    scope: 'workspace' | 'global';
    workspacePath?: string | null;
    agentDir?: string | null;
    name: string;
    body: string;
  }): Promise<string> {
    return (await invoke('write_user_tool', { args })) as string
  }

  async deleteUserTool(args: {
    scope: 'workspace' | 'global';
    workspacePath?: string | null;
    agentDir?: string | null;
    name: string;
  }): Promise<boolean> {
    return (await invoke('delete_user_tool', { args })) as boolean
  }

  // ====== 2026-08-21 v0.6.3-rc1 P2-1: MCP server 配置 CRUD ======
  // 跟 P1-5 user tool 同 pattern: 两层 scope (workspace + global, workspace 优先)
  //   - workspace: <workspacePath>/.pi/mcp/<name>.json
  //   - global:   <agentDir>/mcp/<name>.json
  // FE UI: Settings → MCP tab (新 tab, 跟 Tools tab 同级)
  // sidecar 启动时 (Batch 2) 加载 + spawn MCP server 子进程, 走 @modelcontextprotocol/sdk
  //
  // ⚠️ v0.6.3-rc1 P2-1.2 修: 之前抄 list_skills (struct 参数) 用了 `args: {}` 包装,
  //   但 list_mcp_servers / list_user_tools 走独立参数 (workspace_path, agent_dir),
  //   Tauri 2 FE 必须直接平铺 { workspacePath, agentDir }, 不能包 `args`. 错的写法导致
  //   Rust 端收到 None (因为 args 整个被当第一个参数, 函数拿不到独立值). 修后跟
  //   list_workspace_tree (D183 已验证) 同 pattern.
  async listMcpServers(args: {
    workspacePath?: string | null;
    agentDir?: string | null;
  }): Promise<TauriMcpServerInfo[]> {
    return (await invoke('list_mcp_servers', {
      workspacePath: args.workspacePath ?? null,
      agentDir: args.agentDir ?? null,
    })) as TauriMcpServerInfo[]
  }

  async readMcpServer(args: {
    scope: 'workspace' | 'global';
    workspacePath?: string | null;
    agentDir?: string | null;
    name: string;
  }): Promise<string> {
    return (await invoke('read_mcp_server', { args })) as string
  }

  async writeMcpServer(args: {
    scope: 'workspace' | 'global';
    workspacePath?: string | null;
    agentDir?: string | null;
    name: string;
    body: string;
  }): Promise<string> {
    return (await invoke('write_mcp_server', { args })) as string
  }

  async deleteMcpServer(args: {
    scope: 'workspace' | 'global';
    workspacePath?: string | null;
    agentDir?: string | null;
    name: string;
  }): Promise<boolean> {
    return (await invoke('delete_mcp_server', { args })) as boolean
  }

  // ====== v0.4.6 Project rules / 自定义指令 (跟 Claude 桌面端 "自定义指令" 模式) ======
  // 持久化到 <workspace>/AGENTS.md (per-workspace) + <agentDir>/AGENTS.md (global).
  // Pi SDK 0.84.2 DefaultResourceLoader 自动 load AGENTS.md (resource-loader.ts:71),
  //   sidecar 启动时把 paths 传 appendSystemPromptSource 注入 system prompt.
  // 跟 write_skill_file / list_skills 同 pattern: Tauri 2 invoke 必须 { args } 包裹.
  async readCustomInstructions(args: {
    scope: 'workspace' | 'global';
    workspacePath?: string | null;
    agentDir?: string | null;
  }): Promise<{
    filePath: string | null;
    content: string;
    modifiedAt: string | null;
  }> {
    return (await invoke('read_custom_instructions', {
      args: {
        scope: args.scope,
        workspacePath: args.workspacePath ?? null,
        agentDir: args.agentDir ?? null,
      },
    })) as { filePath: string | null; content: string; modifiedAt: string | null };
  }

  async writeCustomInstructions(args: {
    scope: 'workspace' | 'global';
    workspacePath?: string | null;
    agentDir?: string | null;
    content: string;
  }): Promise<string> {
    return (await invoke('write_custom_instructions', {
      args: {
        scope: args.scope,
        workspacePath: args.workspacePath ?? null,
        agentDir: args.agentDir ?? null,
        content: args.content,
      },
    })) as string;
  }

  async deleteCustomInstructions(args: {
    scope: 'workspace' | 'global';
    workspacePath?: string | null;
    agentDir?: string | null;
  }): Promise<boolean> {
    return (await invoke('delete_custom_instructions', {
      args: {
        scope: args.scope,
        workspacePath: args.workspacePath ?? null,
        agentDir: args.agentDir ?? null,
      },
    })) as boolean;
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

  /**
   * v0.5.0-D D213: 拉 model 列表 + 自动 metadata.
   * - openai-compatible: 真实 HTTP /models + 启发式 parse context_length 等
   * - 内置 provider: 走 Rust 静态 catalog (anthropic/openai/etc)
   * - 没匹配到: metadata 全 null, FE 让用户手填
   *
   * 返回的 autoSource 标记数据来源 ("catalog" / "openai-compatible" / null), UI 加 ✨ 角标
   */
  async fetchProviderModels(
    providerId: string,
    providerType: string,
    baseUrl: string,
  ): Promise<Array<{
    id: string;
    label: string | null;
    contextWindow: number | null;
    maxOutput: number | null;
    vision: boolean | null;
    reasoning: boolean | null;
    modelType: string | null;
    autoSource: 'catalog' | 'openai-compatible' | null;
  }>> {
    return (await invoke('fetch_provider_models', {
      providerId,
      providerType,
      baseUrl,
    })) as Array<{
      id: string;
      label: string | null;
      contextWindow: number | null;
      maxOutput: number | null;
      vision: boolean | null;
      reasoning: boolean | null;
      /** Tauri 端叫 modelType, FE 映射成 type 跟 store 对齐 */
      modelType: 'chat' | 'image' | 'video' | 'audio' | 'embedding' | null;
      /** null = 没匹配到, FE 当 undefined 处理 */
      autoSource: 'catalog' | 'openai-compatible' | null;
    }>;
  }

  /**
   * v0.5.0-D D213: 拉内置 provider 的静态 catalog.
   * 用户在 "添加 model" 时如果想查所有已知 model, 可以调这个.
   * openai-compatible 返空 (走 best-effort parse).
   */
  async getModelCatalog(
    providerType: string,
  ): Promise<Record<string, {
    contextWindow: number | null;
    maxOutput: number | null;
    vision: boolean | null;
    reasoning: boolean | null;
    modelType: string | null;
  }>> {
    return (await invoke('get_model_catalog', { providerType })) as Record<string, {
      contextWindow: number | null;
      maxOutput: number | null;
      vision: boolean | null;
      reasoning: boolean | null;
      modelType: string | null;
    }>;
  }

  /**
   * P0 #1: "测试连接" 按钮. 验证 provider 配置是否可用.
   * - openai-compatible: 实际调 <baseUrl>/models, 验 key + baseUrl
   * - 内置 provider: 只验 keychain 里有 key, 实际 LLM 调通性在首次对话验证
   *
   * apiKey 可选: 传了就直接用 (避免 AddProviderForm 测连接时建临时 provider 污染 store);
   * 不传从 keychain 拿 providerId 对应的 key.
   */
  async verifyProviderConnection(args: {
    providerId: string;
    providerType: string;
    baseUrl: string;
    apiKey?: string | null;
  }): Promise<{
    ok: boolean;
    message: string;
    modelCount: number | null;
    latencyMs: number | null;
    detail: string | null;
  }> {
    return (await invoke('verify_provider_connection', {
      providerId: args.providerId,
      providerType: args.providerType,
      baseUrl: args.baseUrl,
      apiKey: args.apiKey ?? null,
    })) as {
      ok: boolean;
      message: string;
      modelCount: number | null;
      latencyMs: number | null;
      detail: string | null;
    };
  }

  /**
   * v0.3.5+ 默认工作区: 在 home dir 下创建 PiAgent/ 目录 (e.g. C:\Users\<user>\PiAgent).
   * 初始状态发消息时无 workspace → 调这个拿一个默认地址, 不弹 picker.
   * 用户仍可通过 sidebar / tab strip 的"本地"下拉手动选别处.
   */
  async ensureDefaultWorkspace(): Promise<string> {
    return (await invoke('ensure_default_workspace')) as string;
  }

  // v0.6.3-rc1 P2-1.4: 返回默认 agent dir (全局 MCP 配置目录).
  //   - Windows: C:\Users\<user>\.pi\agent
  //   - Unix: <user.home>/.pi/agent
  //   FE 用这个显示 "global scope 会写到哪" 透明性, 也可以传给 MCP command 当 agentDir.
  async getAgentDir(): Promise<string> {
    return (await invoke('get_agent_dir')) as string;
  }

  // v0.6 (Bug2 修): 读 Pi SDK settings.json 里的 compaction.enabled
  //   Pi SDK 默认 enabled=true. 改完下次 Pi SDK 启动生效 (启动时加载 settings).
  async getCompactionEnabled(): Promise<boolean> {
    return (await invoke('get_compaction_enabled')) as boolean;
  }

  // v0.6 (Bug2 修): 改 Pi SDK settings.json 里的 compaction.enabled
  //   不走 sidecar RPC (闲置 session 调不通). 改完下次 Pi SDK 启动生效.
  async setCompactionEnabled(enabled: boolean): Promise<void> {
    await invoke('set_compaction_enabled', { enabled });
  }

  // ====== ADR-0019 P0-1 (2026-08-23): Bash 路径配置 + 自动检测 ======
  //   写 ~/.pi/agent/settings.json 的 bash 字段
  //   Sidecar 启动时读 settings.bash.path, 传给 createBashToolDefinition 的 shellPath 选项
  //   Source of truth = settings.bash.path, auto + manual 都是合法写入路径 (source 字段区分)
  //   改完要等下次启动 sidecar 才生效 (Pi SDK 不热更新 shellPath, 保 session 状态)
  async getBashConfig(): Promise<TauriBashConfig | null> {
    return (await invoke('get_bash_config')) as TauriBashConfig | null;
  }

  async setBashConfig(args: { path: string; source: 'auto' | 'manual' }): Promise<TauriBashConfig> {
    return (await invoke('set_bash_config', { args })) as TauriBashConfig;
  }

  async verifyBashPath(path: string): Promise<{ ok: boolean; version?: string; error?: string }> {
    return (await invoke('verify_bash_path', { path })) as {
      ok: boolean;
      version?: string;
      error?: string;
    };
  }

  async clearBashConfig(): Promise<void> {
    await invoke('clear_bash_config');
  }

  async detectBashCandidates(): Promise<TauriShellInfo[]> {
    return (await invoke('detect_bash_candidates')) as TauriShellInfo[];
  }

  // ====== ADR-0019 P0-2 (2026-08-23): 危险命令白名单 ======
  //   存储在 ~/.pi/agent/settings.json 的 dangerousWhitelist 字段
  //   sidecar 启动时读, BUILTIN_DENY_LIST 匹配 + 不在 whitelist → block bash tool call
  async getDangerousWhitelist(): Promise<TauriWhitelistItem[]> {
    return (await invoke('get_dangerous_whitelist')) as TauriWhitelistItem[];
  }

  async addDangerousWhitelistItem(args: { pattern: string; note?: string }): Promise<TauriWhitelistItem[]> {
    return (await invoke('add_dangerous_whitelist_item', { args })) as TauriWhitelistItem[];
  }

  async removeDangerousWhitelistItem(args: { pattern: string }): Promise<TauriWhitelistItem[]> {
    return (await invoke('remove_dangerous_whitelist_item', { args })) as TauriWhitelistItem[];
  }

  // ====== 2.1: 文件树浏览器 ======
  //   读 workspace 目录树, UI 用. 不走 sidecar, 走 Tauri 直 invoke.
  async listWorkspaceTree(path: string, maxDepth = 2): Promise<WorkspaceTreeNode[]> {
    return (await invoke('list_workspace_tree', { path, maxDepth: maxDepth })) as WorkspaceTreeNode[];
  }

  // ====== 2.2: workspace 模板 - 空目录创建 ======
  async createEmptyDir(parent: string, name: string): Promise<string> {
    return (await invoke('create_empty_dir', { parent, name })) as string;
  }

  // ====== 2.2: workspace 模板 - Git clone ======
  async gitClone(url: string, parent: string): Promise<string> {
    return (await invoke('git_clone', { url, parent })) as string;
  }

  // ====== v0.4.4 Skills: 写自定义 SKILL.md (scope: 'workspace' | 'global') ======
  // P0-1 fix: edit mode 传 filePath 精确覆盖, 不走 scope→路径推算 (避免 global scope
  //   agentDir fallback 不一致导致写到新路径产生重复 skill)
  async writeSkillFile(args: {
    scope: 'workspace' | 'global';
    name: string;
    body: string;
    workspacePath?: string | null;
    agentDir?: string | null;
    /** P0-1: 精确文件路径. 传了则 Rust 直接覆盖, 不推算路径. edit mode 必传. */
    filePath?: string | null;
  }): Promise<string> {
    return (await invoke('write_skill_file', { args })) as string;
  }

  // ====== P0-1: 删除 skill 文件 (按精确路径) ======
  async deleteSkillFile(filePath: string): Promise<void> {
    await invoke('delete_skill_file', { filePath });
  }

  // ====== 2026-08-21: Skill 热重载 (Pi SDK reload 命令) ======
  // 走 Pi SDK 内置 reload, 重建 runtime 并重新 loadSkills.
  // session history 存在 JSONL 文件里, reload 后自动恢复. 下一条消息用新 skills.
  async reloadSkills(sessionId: string): Promise<void> {
    await invoke('reload_skills', { sessionId });
  }

  // ====== v0.4.4.3 Skill 导入: 读本地 .md 文件 + 解析 frontmatter ======
  async readSkillFile(path: string): Promise<{
    path: string;
    raw: string;
    name: string;
    description: string | null;
    disableModelInvocation: boolean;
    body: string;
    hasFrontmatter: boolean;
  }> {
    return (await invoke('read_skill_file', { path })) as any;
  }

  // ====== v0.4.4.4 Skill 导入: 从 zip 压缩包导入 (多文件 skill pack) ======
  async importSkillZip(args: {
    zipPath: string;
    scope: 'workspace' | 'global';
    workspacePath?: string | null;
    agentDir?: string | null;
  }): Promise<{
    name: string;
    targetDir: string;
    skillMdPath: string;
    description: string | null;
    multiFile: boolean;
    fileCount: number;
  }> {
    return (await invoke('import_skill_zip', { args })) as any;
  }

  // ====== v0.4.4.5 Skill 导入: 从 URL fetch raw .md (走 Tauri ureq sync HTTP) ======
  async importSkillUrl(args: {
    url: string;
    scope: 'workspace' | 'global';
    workspacePath?: string | null;
    agentDir?: string | null;
  }): Promise<{
    name: string;
    targetPath: string;
    description: string | null;
    bytes: number;
  }> {
    return (await invoke('import_skill_url', { args })) as any;
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
  // P2 #1 fix: 删 apiKeyEnv dead code 字段 (跟 stores/config.ts 同步, 字段全删)
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

/** v0.4.4.6: Tauri 端 list_skills 返回的单个 skill (跟 sidecar skills_snapshot schema 对齐) */
export interface TauriSkillInfo {
  name: string;
  description?: string;
  /** 文件绝对路径 */
  filePath: string;
  /** 父目录 (workspace: <ws>/.pi/skills/ 或 global: <agentDir>/skills/) */
  baseDir: string;
  /** "workspace" | "global" */
  scope: string;
  disableModelInvocation: boolean;
}

/** v0.4.4.6: Tauri 端 list_skills 返回的诊断信息 */
export interface TauriSkillDiagnostic {
  type: string;
  message: string;
  path?: string;
}

/** v0.4.5.2: Tauri 端 list_commands / read_command 返回的单个 user 自定义 command */
export interface TauriCommandInfo {
  name: string;
  description: string;
  /** frontmatter 后的 markdown body (用户自定义的提示词模板) */
  body: string;
  filePath: string;
}

export const piTauri = new PiTauriClient();

/**
 * ADR-0019 P0-1 (2026-08-23): Tauri 端 get_bash_config / set_bash_config 返回的 bash 配置
 *   写到 ~/.pi/agent/settings.json 的 bash 字段
 *   source: 'auto' = 自动检测写入, 'manual' = 用户手填写入, 排查用, 不影响行为
 */
export interface TauriBashConfig {
  path: string;
  source: 'auto' | 'manual';
  /** Unix epoch ms, 上次跑 bash --version 成功时间 */
  lastVerified?: number;
  /** bash --version 输出第一行解析的版本字符串 (e.g. "5.2.21") */
  version?: string;
}

/**
 * ADR-0019 P0-1 (2026-08-23): Tauri 端 detect_bash_candidates 返回的单个 shell 候选
 *   给 Settings → Bash 路径的 "自动检测" 按钮 + 首次启动静默 auto-pick 用
 */
export interface TauriShellInfo {
  /** 'bash' | 'wsl' | 'pwsh' | 'powershell' */
  shellType: 'bash' | 'wsl' | 'pwsh' | 'powershell';
  path: string;
  /** 'PATH' | 'registry' | 'common' | 'wsl', 排查用 */
  source: 'PATH' | 'registry' | 'common' | 'wsl';
  version?: string;
}

/**
 * ADR-0019 P0-2 (2026-08-23): Tauri 端 get/add/remove_dangerous_whitelist 返回的单条白名单
 *   存储在 ~/.pi/agent/settings.json 的 dangerousWhitelist 字段
 *   sidecar 启动时读, 跟 BUILTIN_DENY_LIST 一起判断:
 *     - 匹配 deny + 不在 whitelist → block bash tool call (LLM 收到 reason)
 *     - 匹配 deny + 在 whitelist → 放行 + stderr log [DANGEROUS_USED] (供 dev 排查)
 */
export interface TauriWhitelistItem {
  /** JavaScript 正则字符串, sidecar 编译成 new RegExp(pattern, 'i') */
  pattern: string;
  /** 用户加这条时的备注, UI 显示, 不参与匹配 */
  note: string;
  /** Unix epoch ms (跟 bash.lastVerified 格式一致) */
  addedAt: string;
}

/**
 * 2026-08-20 P1-5: Tauri 端 list_user_tools 返回的单个 user-defined tool
 *   (从 builtin tool 派生的 args 预设模板).
 *
 * 跟 builtin tool 的区别:
 *   - builtin: Pi SDK 内置, 不存文件
 *   - user tool: 存 <workspace>/.pi/tools/<name>.json 或 <agentDir>/tools/<name>.json
 *     sidecar 启动时加载, wrap builtin 的 ToolDefinition (复用 parameters zod schema)
 *     + 自定义 description 引导 LLM 啥时候用, + preset args 自动 merge
 */
export interface TauriUserToolInfo {
  /** user tool 名字, 跟文件名 sans .json 一致 */
  name: string;
  /** 给 LLM 看的描述, 告诉 LLM 啥时候该用这个 tool */
  description: string;
  /** builtin tool name (read / write / edit / bash / ls / find / grep) */
  basedOn: string;
  /** 完整 JSON body (跟 file 内容一致, 方便 FE 不重复读) */
  body: string;
  /** 绝对文件路径, FE 用于 debug / 显示 */
  filePath: string;
  /** 'workspace' | 'global' */
  scope: 'workspace' | 'global';
}

/**
 * 2026-08-21 v0.6.3-rc1 P2-1: MCP server 配置 (返回给 FE 用的类型).
 *
 * 跟 builtin tool 的关系:
 *   - builtin: Pi SDK 内置, 不存文件
 *   - user tool: builtin 派生的 args 预设包装
 *   - MCP server: 独立的子进程 (走 JSON-RPC over stdio), sidecar 启动时 spawn,
 *     通过 @modelcontextprotocol/sdk 拉 tools/list, 转 Pi SDK ToolDefinition
 *     工具名加 mcp_<server>_<tool> 前缀
 *
 * 存储: <workspace>/.pi/mcp/<name>.json + <agentDir>/mcp/<name>.json
 *
 * v0.6.3-rc1 P2-1.3: 加 serverType 字段 (stdio | http | sse), 默认 stdio, 跟 schema 对齐.
 *   HTTP / SSE 暂时不实现, 但 schema 接受, 留给 P2.3
 */
export interface TauriMcpServerInfo {
  /** MCP server 名, 跟文件名 sans .json 一致, LLM 看到的 tool 名前缀 mcp_<name>_<tool> */
  name: string;
  /** stdio 启动命令 (e.g. npx / node / .exe 绝对路径), http/sse 时为空字符串 */
  command: string;
  /** 完整 JSON body (跟 file 内容一致, 方便 FE 不重复读) */
  body: string;
  /** 绝对文件路径, FE 用于 debug / 显示 */
  filePath: string;
  /** 'workspace' | 'global' */
  scope: 'workspace' | 'global';
  /** v0.6.3-rc1 P2-1.3 + P2-1.8: transport 类型. stdio (默认) | http (P2-1.8 实现) | sse (P2-1.8 实现) */
  serverType: 'stdio' | 'http' | 'sse';
  /** v0.6.3-rc1 P2-1.8: http/sse 用的 URL. stdio 时为 null. */
  url: string | null;
}
// 模块加载时立即启动 listener (fire-and-forget), 加速首次 sendPrompt
void piTauri.waitForListener();

// 调试用: 把 piTauri 暴露到 window, 方便 F12 console 直接调
// R1: dev-only 守卫 — 生产构建不带这个, 防止注入脚本/扩展调 listApiKeys 等命令
if (typeof window !== 'undefined' && import.meta.env.DEV) {
  (window as any).__piTauri = piTauri;
  console.log('[pi-tauri] window.__piTauri exposed for dev console debugging');
}
