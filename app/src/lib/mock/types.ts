// Mock data types — 1:1 mirrors what the Pi SDK session/agent state will look like.
// When Phase 2 hooks up real Pi SDK, these types will be replaced by SDK types.

export interface MockWorkspace {
  id: string;
  name: string;
  /** pseudo "industry" tag (能源/交管/QA/...) — just a label, not used yet */
  tag?: string;
  files: MockFile[];
  createdAt: string;
}

export interface MockFile {
  path: string;
  name: string;
  kind: 'file' | 'dir';
}

export interface MockSession {
  id: string;
  workspaceId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export type ChatRole = 'user' | 'assistant' | 'system';

/**
 * v0.4.3: LLM token usage (assistant 消息时填, 跟 message_end 事件一起)
 * - input: cache miss 新输入的 token 数
 * - output: assistant 本轮生成的 token 数
 * - cacheRead: cache hit 命中的 token 数 (DeepSeek V4 Flash / Anthropic 都有 prompt cache)
 * - cacheWrite: 这次新写入 cache 的 token 数
 * - cost: 按 provider 实际计费 (input/output/cacheRead/cacheWrite 分别计)
 */
export interface MessageUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: string;
  /**
   * v0.4.1 step 累加: 一次 LLM run 可能跑多个 turn (tool_call 链), 每个 turn = 1 step.
   * assistant message 才有, 内部按时间顺序 push step group.
   * UI 用 StepGroup 渲染, 默认折叠, 当前正在跑的那个 step 默认展开.
   */
  steps?: Step[];
  /**
   * v0.4.3: assistant message 关联的 LLM token usage (message_end 事件填)
   * FE 用这个计算 context window 占用 (last usage.input + last usage.cacheRead)
   * UI 在 Composer 显示 + 触发 compaction 按钮高亮
   */
  usage?: MessageUsage;
  /**
   * v0.4.6: system 角色消息标记. 配合 ChatMessage.vue 渲染为分界线.
   * 当前只用于 compaction 完成时分界线 ("── 已压缩 ──").
   */
  compactionMarker?: boolean;
}

export interface ThinkingBlock {
  id: string;
  messageId: string;
  content: string;
  collapsed: boolean;
}

export type ToolCallStatus = 'pending' | 'running' | 'success' | 'error';

export interface ToolCallBlock {
  id: string;
  messageId: string;
  name: string;
  args: Record<string, unknown>;
  status: ToolCallStatus;
  result?: string;
  startedAt: string;
  endedAt?: string;
}

/**
 * v0.4.1 step 累加: 1 turn = 1 step group, 内含本 turn 的 thinking + toolCalls + text.
 * - thinking / toolCalls 数组: 跟当前 message 共享 messageId 关联, 但只存本 turn 的事件
 * - isActive: 当前 turn 跑没跑完 (true 时 UI 默认展开)
 * - collapsed: 用户手动折叠状态
 * - stepText: 本 turn 的 text_delta 累积 (跟 message.content 区分, message.content 是 final reply)
 *
 * 为什么 step 拆出来:
 * - Pi SDK Agent.prompt 一次可能跑 N turn (tool_call 链)
 * - 所有 turn 的 thinking 全累加到 1 个 block 没法看
 * - 拆成 step 后: 用户能看到"思考 → 工具 → 结果 → 思考 → 工具 → 结果"的清晰链路
 */
export interface Step {
  id: string;
  /** 本 step 内的思考块 (1 turn 可能 emit 多次 thinking_delta, 合并到 1 个 block 即可) */
  thinking: ThinkingBlock[];
  /** 本 step 内的工具调用 (1 turn 内多个 tool_call) */
  toolCalls: ToolCallBlock[];
  /** 本 step 的 text_delta 累积 (assistant 在本 turn 输出的文字) */
  stepText: string;
  /** 当前 turn 还在跑 (true) 还是跑完了 (false) */
  isActive: boolean;
  /** 用户手动折叠状态 (true = 折叠) */
  collapsed: boolean;
}
