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
// 模块加载时立即启动 listener (fire-and-forget), 加速首次 sendPrompt
void piTauri.waitForListener();

// 调试用: 把 piTauri 暴露到 window, 方便 F12 console 直接调
// R1: dev-only 守卫 — 生产构建不带这个, 防止注入脚本/扩展调 listApiKeys 等命令
if (typeof window !== 'undefined' && import.meta.env.DEV) {
  (window as any).__piTauri = piTauri;
  console.log('[pi-tauri] window.__piTauri exposed for dev console debugging');
}
