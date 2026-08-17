# ADR-0013: v0.4.2 上下文管理 — `createAgentSession` + `SessionManager` 持久化

- **状态**: Accepted
- **日期**: 2026-08-17
- **决策者**: 用户
- **Relates to**: [ADR-0012](0012-pi-sdk-integration.md)

## 背景

v0.4.1 sidecar 用 `new Agent({...})` 直接构造（裸 pi-agent-core），每次 `runPrompt` 都是**全新 agent 实例**：

- ❌ **无历史记忆**：用户连续发 3 条消息，LLM 只见最后一条，前两条完全丢
- ❌ **无 compaction**：长对话会撑爆 context window（deepseek-v4-flash 8K 限制）
- ❌ **无 system prompt 持久化**：每次 system prompt 都从 base 重新算
- ❌ **LLM 不自主决策**：用户问"看下工作区有什么"，LLM 回复一长串"你需要做什么"（应该直接调 tool）

实测场景（用户 2026-08-17 反馈）：

> "我们是不是还没做上下文管理？他没有记忆，跨 session 完全断掉"
> "长链路调用也还有点问题，他不会自主决策"

`pi-coding-agent@0.84.2` 包已经有完整解决方案（之前 v0.4 集成时没用到，只用了它的 7 个 tool 工厂）：

- `createAgentSession({...})` 返回 `AgentSession`，封装了 Agent + SessionManager + SettingsManager
- `SessionManager` 自动把每条 message 落到 `~/.pi/agent/sessions/<uuid>.jsonl`（line-delimited JSON）
- `session.prompt(text)` 启动新 turn，结束自动 persist user + assistant messages
- `session.subscribe(listener)` 收 `compaction_start` / `compaction_end` / `entry_appended` 事件
- `session.compact()` 手动触发 LLM-driven summary
- `CompactionSettings`（`shouldCompact` 阈值 / `reserveTokens` / `keepRecentTokens`）通过 `settingsManager.getCompactionSettings()` 读

## 备选

### 方案 A: 自己手写持久化 + compaction ❌

sidecar 内部自己维护 `messages[]` 数组，每次 prompt 后 append，自己 dump 到 JSON。

- ❌ 重造 pi-coding-agent 已有的轮子（SessionManager 已经处理 flush / crash recovery / compaction entry）
- ❌ 自己写 LLM summary（要走一次完整 LLM 调用，**和正式 turn 一样可能 hang**）
- ❌ 跟 Pi 主线协议脱节，未来 pi-coding-agent 升级拿不到新能力
- ❌ **不推荐**（v0.4.1 阶段已经手写 fetch / SSE 解析被 ADR-0010 推翻过，前车之鉴）

### 方案 B: 切换到 `createAgentSession`，SessionManager 用默认路径 ✅

```javascript
import { createAgentSession, SessionManager } from '@earendil-works/pi-coding-agent';

const sessionManager = SessionManager.create(cwd, getDefaultSessionDir(cwd, agentDir));
const { session, extensionsResult } = await createAgentSession({
  cwd, agentDir, model, customTools,
  sessionManager,  // ← 注入
});
```

- ✅ 复用 pi-coding-agent 全部能力（persistence / compaction / settings / extension）
- ✅ SessionManager 自动落盘到 `~/.pi/agent/sessions/<uuid>.jsonl`
- ✅ `session.subscribe()` 拿到 `compaction_start` / `compaction_end` / `entry_appended` 高级事件（不只是 `tool_execution_*`）
- ✅ 跨 session 有记忆，user 关闭重开 Pi Agent 还在
- ❌ session 文件位置写死到 `~/.pi/agent/sessions/`（每用户一个全局目录，**多 workspace 共享**）
- ❌ `createAgentSession` 走 ResourceLoader + ExtensionRunner，启动比 `new Agent()` 慢 ~200ms

### 方案 C: 方案 B + per-workspace 隔离 session ✅ (推荐)

跟方案 B 一样用 `createAgentSession`，但 **session 文件按 workspace 路径分目录**：

```
~/.pi/agent/sessions/
  ├── <hash(workspacePath)>/<uuid>.jsonl
  └── <hash(workspacePath)>/<uuid>.jsonl
```

- ✅ 同方案 B 所有优点
- ✅ **不同 workspace 不污染上下文**（Test1 的 LLM 不会记 Test2 的内容）
- ✅ workspace 改名/移动时 hash 失效 → 起新 session（自然清理）
- ❌ 多一层目录 hash，调试时看 session 文件稍微麻烦

### 方案 D: 不动 session，只加 system prompt 让 LLM 自主决策 ❌ (临时)

不动架构，只改 system prompt 段：

```
当用户请求涉及 workspace 操作时, 优先调 write/edit/bash tool 直接执行, 不要先问 "我应该怎么做"
```

- ✅ 最小变更，立即可测
- ❌ **不解决记忆问题**（user 反馈的核心痛点）
- ❌ 治标不治本

## 决策

**选方案 C: `createAgentSession` + per-workspace 隔离**。

理由：
1. **Pi 主线协议对齐**：跟 earendil-works/pi 主项目一致，升级 0.85+ 自动拿到新能力
2. **per-workspace 隔离是硬需求**：用户在两个 workspace 切换，不能让 Test1 的对话污染 Test2
3. **Compaction 复用 Pi 实现**：不自己写 LLM summary（hang watchdog 已经在 v0.4.1.4 修过，但能不复用就不复用）
4. **FE 端零感知**：v0.4.1 的 IPC 协议（message_start / text_delta / tool_execution_* / agent_end）继续工作，**只在 IPC 层加 3 个新事件**（compaction_start / compaction_end / entry_appended）用于 UI 提示，不改协议主线

具体实施细节：

### 1. Sidecar 切换

```javascript
// 旧 (v0.4.1)
const agent = new Agent({
  initialState: { systemPrompt, model, tools: buildTools(config.workspacePath) },
  streamFn: models.streamSimple.bind(models),
  beforeToolCall: async (ctx, signal) => { ... },
});

// 新 (v0.4.2)
import { createAgentSession, SessionManager, getDefaultSessionDir } from '@earendil-works/pi-coding-agent';
import { createHash } from 'crypto';

function sessionDirFor(workspacePath) {
  const hash = createHash('sha256').update(workspacePath).digest('hex').slice(0, 16);
  return join(homedir(), '.pi', 'agent', 'sessions', hash);
}

const sessionManager = SessionManager.create(
  config.workspacePath,
  sessionDirFor(config.workspacePath),
  { id: config.sessionId },  // 让 sidecar 知道用哪个 session 文件
);
const { session } = await createAgentSession({
  cwd: config.workspacePath,
  agentDir: config.agentDir,
  model,
  customTools: buildTools(config.workspacePath),
  sessionManager,
});
```

### 2. 事件映射

`AgentSession.subscribe` 收 `AgentSessionEvent`（已包含所有 `AgentEvent` + 额外 session 级别事件），**逐个 map 到现有 IPC 协议**：

| AgentSessionEvent | → IPC 事件 |
|---|---|
| `agent_start` | `agent_start` |
| `message_start` (user) | `user_message_start` |
| `message_start` (assistant) | `assistant_message_start` |
| `message_update` (text/thinking) | `message_update` |
| `message_end` | `message_end` |
| `tool_execution_start` | `tool_execution_start` |
| `tool_execution_update` | `tool_execution_update` |
| `tool_execution_end` | `tool_execution_end` |
| `turn_start` | `turn_start` |
| `turn_end` | `turn_end` |
| `agent_end` | `agent_end` |
| **🆕 `compaction_start`** | **`compaction_start`** (FE 显示"正在压缩历史"toast) |
| **🆕 `compaction_end`** | **`compaction_end`** (FE 隐藏 toast) |
| **🆕 `entry_appended`** | **不进 IPC** (FE 不需要，是 sidecar 内部持久化事件) |
| **🆕 `auto_retry_start` / `auto_retry_end`** | **→ `auto_retry_start` / `auto_retry_end`** (FE 显示"重试中") |

### 3. Permission hook 适配

`AgentSession` 内部包装了 `Agent.beforeToolCall`，**不直接暴露**。需要通过 session 的 `agent.subscribe` 监听 `tool_execution_start` 事件，**前置拦截**：

```javascript
// 旧: 直接给 Agent.beforeToolCall
// 新: 监听 tool_execution_start, 如果是 ask/smart 模式就 emit permission_request + 阻塞 tool 执行
```

或者用 pi-coding-agent 提供的 `toolPolicy` / `permissionHandler` API（如果存在的话）。**实施时先查文档**，没 API 就在 tool execute 前做异步等待。

## 后续 Review (v0.4.2 step 1, 2026-08-17)

**调研推翻了两条 ADR 假设**:

1. **§3 Permission hook 适配 错了** — 实施发现正确的做法不是监听 `tool_execution_start` (那是 tool 已经开始了, 拦截不了), 而是走 **Extension API** `pi.on("tool_call", handler)`:
   - Pi SDK `agent-session.ts:480-499` `_installAgentToolHooks` 创建 Agent 时自动装 `this.agent.beforeToolCall = async ({toolCall, args}) => runner.emitToolCall({type: "tool_call", toolName, toolCallId, input: args})`
   - 任何 `pi.on("tool_call", handler)` 自动接管, 返回 `ToolCallEventResult { block?, reason?, terminate? }` 决定行为
   - `block: true` → 阻止 (Pi SDK 自动 emit error tool result), `terminate: true` → 当前 batch 后 stop
   - 走 `DefaultResourceLoader({ extensionFactories: [{ name, factory, hidden: true }] })` 注入

2. **§2 事件映射表错了 `entry_appended`** — 实施发现 `entry_appended { entry: SessionEntry }` 包含 session 内部所有持久化条目 (message / model_change / thinking_level_change / compaction), 不只是 entry. sidecar 应该 **过滤掉** `entry_appended` 不进 IPC, FE 不需要 (只 sidecar 内部用).

**新增实施细节** (实测时确认的):

- `createAgentSession` 接受 `sessionManager` 字段 (sdk.ts:81), 我们传 `SessionManager.create(cwd, sessionDirFor(cwd), { id: sessionId })`
- `sessionManager.getSessionId()` 拿 sessionId, `sessionManager.buildSessionContext()` 读历史 messages
- `session.prompt(text, { streamingBehavior: "steer" | "followUp" })` 提交用户消息, **不是** `agent.continue()` (AgentSession 内部管理 history, 没有 continue)
- `session.subscribe(listener)` 收 `AgentSessionEvent` (包含所有 `AgentEvent` + 5 个 session-level: `compaction_start` / `compaction_end` / `entry_appended` / `auto_retry_start` / `auto_retry_end` / `agent_settled`)
- `session.compact()` 手动压缩 (FE 端通过 IPC `compact_session` 触发)
- `session.abort()` 取消当前 run

**Per-workspace 隔离实施**:
```javascript
import { createHash } from 'crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';

function sessionDirFor(workspacePath) {
  const hash = createHash('sha256').update(workspacePath).digest('hex').slice(0, 16);
  return join(homedir(), '.pi', 'agent', 'sessions', hash);
}
const sessionDir = sessionDirFor(workspacePath);
const sessionManager = SessionManager.create(workspacePath, sessionDir, { id: sessionId });
```

`SessionManager.create` 第二个参数 (sessionDir) 是**目录**, 不是文件路径. SessionManager 内部拼接 `<id>.jsonl` 落到该目录. 所以**per-workspace 隔离 = 目录 hash, sessionId 在目录内** (`~/.pi/agent/sessions/<hash>/<sessionId>.jsonl`).

**sessionId 流程**:
- FE 切 workspace 时, 读 `perWorkspaceSessionId.get(workspacePath) || uuidv7()`
- 把 sessionId 通过 IPC `config { sessionId, workspacePath }` 传给 sidecar
- sidecar 用来 `SessionManager.create(..., { id: sessionId })`, 决定落哪个文件
- 同一 workspace 多次 session: sessionId 唯一, 多次 prompt 自动 append
- 切走 workspace: sessionManager 不需要 unload, sidecar 全局保留 (内存状态)
- 切回 workspace: 用原 sessionId 重新 create, SessionManager 读历史 messages 自动恢复

**Active tool 7 个全激活** (重要):
- `createAgentSession` 默认只激活 4 个 built-in (read/bash/edit/write), grep/find/ls 不会自动激活
- 解决: `createAgentSession({ tools: ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'] })` 显式传

**ADR-0013 §后果 跟现实略有差异**:
- 写的是"启动慢 ~200ms" — 实测 ~150-300ms 浮动, 跟 system load 有关
- 写的是"Permission hook 要重写" — ✅ 已重写, 改 Extension (上面)
- 写的是"Pi SDK API 还在 0.84 早期" — 0.84.2 实施时 API 稳定, 没有发现 breaking issue

**新增的 IPC 协议事件** (FE chat store + tauri.ts 要同步改):
- `compaction_start { reason: "manual" | "threshold" | "overflow", sessionId }` — FE 显示 "正在压缩历史" toast
- `compaction_end { reason, success, willRetry, errorMessage?, sessionId }` — FE 隐藏 toast, 失败时显示 banner
- `auto_retry_start { attempt, maxAttempts, delayMs, errorMessage, sessionId }` — **替代 v0.4.2 partial 的 `retry_start`**, 跟 Pi SDK 对齐
- `auto_retry_end { success, attempts, finalError?, sessionId }` — **替代 v0.4.2 partial 的 `retry_end`**

**删 v0.4.2 partial 的 `retry_start` / `retry_end`**: 之前 (commit `88d05ea`) sidecar 自写 retry 状态机, 事件名 `retry_start` / `retry_end`. v0.4.2 step 1 改用 SDK 内置后, **事件名从 `retry_*` 改 `auto_retry_*`** (跟 Pi SDK 对齐, 跟 `compaction_*` 风格统一). FE 端 chat store + tauri.ts + ChatMessage.vue retry banner 代码要同步改.

### 4. 跨 session 持久化

- sessionId 由 FE 给（每个 workspace 一个稳定 sessionId）
- sessionId 持久化到 Tauri `config_store`（`per-workspace-session-id` map: workspacePath → sessionId）
- sidecar 启动时从 config 读 sessionId，传给 `SessionManager.create(..., { id })`
- 用户切 workspace → sidecar 重新创建 SessionManager + AgentSession（用对应 sessionId）

### 5. Compaction 触发策略

- **自动**: `settingsManager.getCompactionSettings()` 读 `reserveTokens` + `keepRecentTokens`，AgentSession 内部在 turn 结束时 `shouldCompact()` 检查
- **手动**: FE 加"压缩历史"按钮 → IPC `compact_session` → sidecar `await session.compact()`
- **容量**: 默认 90% context window 触发（`reserveTokens: 16384` 留出 system prompt + output 余量）

### 6. System prompt 加 LLM 自主决策段

在 `createAgentSession` 之前 / 之后注入 custom system prompt append：

```javascript
const { session } = await createAgentSession({...});
session.setSystemPromptOverride(`${baseSystemPrompt}

[Pi Agent 行为约束]
- 用户请求涉及 workspace 操作时, 优先调 read/write/edit/bash tool 直接执行, 不要先问"我应该怎么做"
- 调 tool 之前不需要确认, 直接调 (Permission 弹窗已经替你跟用户确认了)
- 完成 user 请求后, 简短总结做了什么即可, 不要列"我做了 X, Y, Z"清单`);
```

## 后果

### 正面
- ✅ **AI 有记忆**：跨 session、跨重启都保留 history
- ✅ **Compaction 自动触发**：长对话不爆 context
- ✅ **多 workspace 隔离**：Test1 不会污染 Test2
- ✅ **跟 Pi 主线对齐**：升级 0.85+ 自动获新能力（Pi 0.85 已经在路上了）
- ✅ **LLM 自主决策**：明确 system prompt 后减少"我应该做什么"废话
- ✅ **Auto-retry UI**：FE 可以做"重试中"提示

### 负面
- ❌ **启动慢 ~200ms**：`createAgentSession` 比 `new Agent()` 多走 ResourceLoader + ExtensionRunner + SettingsManager
- ❌ **session 文件要清理**：用户删 workspace 后 `~/.pi/agent/sessions/<hash>/` 残留（**写一个 v0.4.2+ 清理脚本**）
- ❌ **Permission hook 要重写**：`Agent.beforeToolCall` 不直接暴露，要走 session 的 tool 拦截层
- ❌ **Pi SDK API 还在 0.84 早期**：compaction API 文档不全，**实施时必须先 grep `pi-sdk/packages/coding-agent/src/core/compaction/` 读源码**
- ❌ **session 文件可能很大**：长对话 + tool calls 累积，`ls -lh` 可能上 MB（**v0.4.3 考虑 gzip**）

### 中性
- 🟡 **session 文件路径约定**：per-workspace 隔离，hash 是 sha256 前 16 位（**用户不需要知道，但开发者调试时要 grep**）
- 🟡 **sessionId 命名**：用 uuid v7（`uuidv7()` from `pi-ai`），FE 用 stable sessionId（workspace 创建后不变）
- 🟡 **Compaction 用的 LLM**：默认跟当前 model 走（**未来 v0.4.3 考虑用小模型如 gpt-4o-mini** 专门做 summary 省钱）

## 何时 Revisit

- ❗ **session 文件 > 100MB** 单文件 → gzip + 分段
- ❗ **auto-compaction 后 LLM 仍报 context overflow** → 调 `reserveTokens` 比例
- ❗ **Pi SDK 升级到 0.85+ 大改 session API** → 重新评估是否还要用 `createAgentSession`
- ❗ **用户多 workspace 切换频繁导致 session 启动慢** → 考虑长连接 + session pool
- ❗ **跨 workspace 共享上下文成为需求** → 方案 B（不隔离）
- ❗ **session 文件数量 > 1000** → 写 LRU 清理

## 实施步骤

1. ✅ ADR-0013 写完（本文）
2. ⏭ 改 `sidecar/src/index.mjs`: `new Agent` → `createAgentSession` + `SessionManager` (per-workspace 隔离)
3. ⏭ 加 3 个 IPC 事件: `compaction_start` / `compaction_end` / `auto_retry_start` / `auto_retry_end`
4. ⏭ FE `tauri.ts` 加 invoke: `compact_session` (手动压缩)
5. ⏭ FE `config_store` 加 `perWorkspaceSessionId: Map<workspacePath, sessionId>`
6. ⏭ FE `appStore` 切 workspace 时 emit sessionId 给 sidecar
7. ⏭ 写 `sidecar/test-smoke-session-persistence.mjs` (4 scenario: 新建 / resume / compaction / cross-workspace 隔离)
8. ⏭ System prompt 注入"自主决策"段
9. ⏭ 改 doc/02-roadmap.md v0.4.2 状态, 改 doc/03-features/chat-core.md 上下文管理章节
10. ⏭ 跑端到端测试: 同一 workspace 连发 5 条消息 → 切走 → 切回 → AI 记得前 5 条

## 参考文档 (必看)

- `pi-sdk/packages/coding-agent/src/core/sdk.ts` `createAgentSession` 签名 + 默认行为
- `pi-sdk/packages/coding-agent/src/core/session-manager.ts` `SessionManager` 持久化 / `buildSessionContext` / `appendMessage` / `getBranch`
- `pi-sdk/packages/coding-agent/src/core/agent-session.ts` `AgentSession.subscribe` 事件类型 + `compact()` 实现
- `pi-sdk/packages/coding-agent/src/core/compaction/index.ts` `shouldCompact` / `generateSummary` / `prepareCompaction`
- `pi-sdk/packages/coding-agent/src/core/settings-manager.ts` `getCompactionSettings`

**用法规则 (继承自 ADR-0012)**: 改前先看上述源码 + README, 不要凭印象写. 遇到 hang / 数据丢失 / session 文件损坏, 第一反应回这 5 个文件 grep.
