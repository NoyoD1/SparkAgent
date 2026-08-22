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
   * v0.5.0-D 第27轮 (D210.4) 升级: 之前是 boolean 只表示"完成", 现在是 object 表达
   *   3 种状态 (in_progress / success / failure), 跟 user 反馈一致:
   *   "压缩失败要在上面提示, 包括压缩进行中都不要通过弹窗形式提示, 而是统一使用分隔线"
   *   - in_progress: 压缩中 (compact() 立即 push, handleCompactionEnd 替换)
   *   - success: 压缩成功 (handleCompactionEnd 替换 in_progress)
   *   - failure: 压缩失败 (handleCompactionEnd 替换 in_progress, 附 errorMessage)
   * 不再用 toast 弹窗, 全部走分隔线统一 UX.
   */
  compactionMarker?: {
    state: 'in_progress' | 'success' | 'failure';
    /** 仅 failure 状态有, 压缩失败的错误信息 */
    errorMessage?: string;
    /**
     * v0.6 (P0-C): 压缩前 contextTokens (仅手动 compact 记录, auto-compaction 路径无).
     *   用来在 success divider 上显示"释放 X tokens".
     *   压缩成功后 contextTokens 清零, freedTokens = beforeCompact (因为 after = 0).
     */
    beforeCompact?: number;
    /**
     * v0.6 (P0-C): 释放的 tokens (仅 manual compact + success 时记录).
     *   Pi SDK 0.84.2 不直接报"压缩节省 token", 我们在 handleCompactionEnd 时算:
     *   freedTokens = beforeCompact - 0 (因为 compaction_end 成功时 contextTokens 清零).
     */
    freedTokens?: number;
  };
  /**
   * v0.5.0-D 第29轮 (D212): LLM 异常错误分界线.
   *   之前 (D204 前): 模型异常 (e.g. 429 quota exceeded) 走顶层 error 事件 + showToast,
   *   user 看到 toast 但 chat 流里没明显标记, 不直观.
   *   D212 改: message_end 检测 event.message.errorMessage + stopReason='error' → 推
   *   一条 system 角色消息, ChatMessage.vue 渲染为 "── ⚠ 生成失败: <errorMessage> ───"
   *   居中橙色横线 (跟压缩 failure 同款风格). 跟 compaction UX 保持一致:
   *   不用 toast, 全部走分隔线统一 UX.
   *   - reason: 错误来源, message_end (LLM 返回 stopReason=error) 是主路径
   *   - errorMessage: 错误详情 (e.g. "429: Allocated quota exceeded")
   *   - hasPartialContent: 失败时是否已有部分内容 (有 thinking/toolCall 但没最终答案)
   *     用于 UI 提示 user "本次回复有部分内容但未完成"
   */
  errorMarker?: {
    errorMessage: string;
    /**
     * 2026-08-20 P1-3: 原始错误信息 (从 LLM / provider 直接返的, 不做 friendly 改写)
     *   给 dev 排查用, UI 折叠显示 (默认折叠, user 点 "Show details" 展开).
     *   跟 errorMessage 区别: errorMessage 是 user-friendly 中文 + 原因列表 + 下一步,
     *   rawError 是 provider 原始字符串 (可能很长, 含 stack trace).
     */
    rawError?: string;
    /**
     * 2026-08-20 P1-3: 错误分类, 给 UI 切色 / 选 icon 用
     *   - 'auth_401': API key 失效 (淡红 + 提示去 Settings)
     *   - 'forbidden_403': model 拒绝 (橙色 + 提示换 model)
     *   - 'rate_limit_429': 限流 (黄色 + 提示等 1 分钟)
     *   - 'server_5xx': 服务异常 (灰色 + 提示等)
     *   - 'network': 网络错误 (灰色 + 提示查网络)
     *   - 'unknown': 未分类 (默认红色)
     */
    category?: 'auth_401' | 'forbidden_403' | 'rate_limit_429' | 'server_5xx' | 'network' | 'unknown';
    reason: 'message_end_stop_reason_error' | 'agent_end_no_retry';
    at: number;
    hasPartialContent: boolean;
  };
  /**
   * 2026-08-20 P1-7: warning marker — LLM 协议层"静默失败"指示
   *   跟 errorMarker 区别: error 是有 errorMessage 的具体失败, warning 是 "agent_end 来了但
   *   message_start 没来, idx=-1" 的静默情况. 视觉上用 warning 黄色 (不是 error 红), 文案上
   *   强调 "AI 没返回内容" + 列出常见根因 + 下一步行动, 引导 user 自己排查 (限流 / model 不支持 /
   *   provider 协议不兼容 Pi SDK 0.84.2).
   *   rawEventLog 留给 user / dev 排查时看, 不直接展示 (太长).
   */
  warningMarker?: {
    title: string;
    hint: string;
    rawEventLog?: string;
    at: number;
  };
  /**
   * v0.5.0-D 第15轮 (D202): assistant message 标志 — model 返回了空 message
   *   (message_end 来了但 0 text_delta, 跟图2 卡住现象一致).
   *   触发后 ChatMessage 渲染警告 + 操作建议, 替代单纯的"生成中..." placeholder,
   *   让 user 知道发生了什么, 不用盲猜是 streaming 还是卡死.
   *   v0.5.0-D 第19轮 (D206) REVERT: 删 emptyResponse 自动检测 (false positive 太多,
   *   model 合法的空 message 误判, 详情见 chat.ts D204)
   */
  // emptyResponse?: boolean;
  /**
   * v0.5.0-D 第19轮 (D206): user message 标志 — 这条消息是用 quote 功能发的
   *   (引用上一条 AI 消息的某段文字 + 写新问题).
   *   - `quoteContent` 存原始引用文本 (没有 `> ` 前缀), 给 ChatMessage 渲染用
   *     (引用部分用 blockquote 样式 + 左边框 + 缩进, 跟 Composer 的 quote preview 一致)
   *   - `message.content` 存 full text (带 `> ` markdown blockquote 语法),
   *     这就是发给 AI 的完整 prompt
   *   - AI 端的 markdown `> ` 语法是最小结构化提示, LLM 训练集里大量 markdown,
   *     能识别"这是引用" + "后面是新问题" 两个段落
   *   - D205 尝试完全去掉结构化标记 (plain text 拼接), 小模型无法识别"哪段是引用",
   *     answer 走偏; D206 回到 markdown blockquote 简单方案
   */
  quoteContent?: string;
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
