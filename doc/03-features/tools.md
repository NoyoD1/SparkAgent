# Tools（工具调用）

> 状态: 🟢 70%
> 最后更新: 2026-08-17 (v0.4.1 集成 pi-coding-agent 7 tool 端到端跑通)
> spec 涉及: `sidecar/src/index.mjs`（**v0.4 集成 pi-ai + pi-agent-core, v0.4.1 加 pi-coding-agent 7 tool**）+ `app/src/stores/chat.ts` + `app/src/components/ChatMain/StepGroup.vue` + Tauri fs/shell 权限

---

## 1. Spec

**Tool = LLM 能调用的本地能力**（读文件 / 跑命令 / 搜索 / 调用 MCP）。**这是 Pi Agent 从 chat 客户端变成 agent 客户端的关键**。

### 1.1 必备能力（v0.4 必做 + v0.4.1 已落地）

- ✅ Tool call 协议（流式接收 + UI 展示 + 折叠）— v0.3.8.6+
- ✅ **LLM 调用层**（**v0.4.0** 集成 pi-ai 完成）— 复用 `createModels` + 内置 7 provider 工厂 + 自定义 `createProvider`
- ✅ **Agent loop**（**v0.4.0** 集成 pi-agent-core 完成）— 复用 `Agent` 类 + `AgentTool` 接口
- ✅ **7 个 tool 集成**（**v0.4.1** 集成 `pi-coding-agent` 完成）— 工具名按 pi-coding-agent 实际 emit 的（**不是自写时的 self-name 假设**）：
  - `read` (path) — 读文件内容（不是 `read_file`）
  - `write` (path, content) — 写文件（不是 `write_file`）
  - `edit` (path, old, new) — 局部编辑（不是 `edit_file`）
  - `bash` (command, cwd?) — 跑命令
  - `ls` (path) — 列目录（不是 `list_dir`）
  - `find` (pattern) — 文件名匹配（不是 `glob`）
  - `grep` (pattern, path) — 内容搜索
- ✅ **Step 累加 UI**（v0.4.1）— 1 turn = 1 step group，可折叠累加（Cursor 风格），final body 渲染 `lastStep.stepText` 防重复
- 🟡 **Tool permission system**（v0.4 必做，v0.4.1 未做）：
  - 每次 tool call 用户 confirm（至少第一次）
  - 白名单 / 黑名单
  - workspace 路径限制
  - 危险命令拦截（`rm -rf /` 等）
- ❌ **Abort tool**（v0.4 必做）：
  - 用户能中断正在跑的 bash
  - 同时中断 LLM 流（联动 [chat-core.md](chat-core.md)）
- 🟡 Tool result 持久化到 session — v0.4.2 计划（用 pi-coding-agent SessionManager）
- ✅ **Tool call history 折叠 / 展开**（v0.4.1 step group + tool_call 双重折叠）

### 1.2 Pi SDK 集成（v0.4 + v0.4.1）

`@earendil-works/pi-ai` + `@earendil-works/pi-agent-core` + `@earendil-works/pi-coding-agent` — 详见 [ADR-0012](../04-adr/0012-pi-sdk-integration.md)

**`pi-ai` 提供**：
- 25+ 内置 provider 工厂（`anthropicProvider()` / `openaiProvider()` / `deepseekProvider()` / `moonshotaiProvider()` / `groqProvider()` / `googleProvider()` / `minimaxProvider()` / ...）
- `createProvider({ id, baseUrl, auth, models, api })` — 任意自定义 OpenAI-compatible
- `createModels()` + `MutableModels.setProvider()` — 运行时动态加 provider
- 统一 LLM 客户端（流式 / thinking / tool call 协议）
- OS keychain auth 抽象

**`pi-agent-core` 提供**：
- `Agent` 类 — 高级 agent 抽象（`subscribe(event)` + `prompt(text)` + `streamFn`）
- `agentLoop()` / `runAgentLoop()` — 底层 loop
- `AgentContext` / `AgentEvent` / `AgentTool` — 协议类型
- `Transport` / `StreamFn` — 流式接口
- `uuidv7` — 工具

**`pi-coding-agent` 提供**（**v0.4.1 集成**）：
- 7 个内置 tool 工厂：`createReadTool` / `createWriteTool` / `createEditTool` / `createBashTool` / `createLsTool` / `createFindTool` / `createGrepTool`（接受 `(cwd, options?)` → `AgentTool<any>[]`）
- `createAgentSession` / `SessionManager` — session 持久化（v0.4.2 待集成）
- `compact` / `shouldCompact` / `estimateContextTokens` — 上下文压缩（v0.4.2 待集成）

**当前未集成（自实现 / 复用现有）**：
- ❌ Tool permission wrapper（v0.4.2+）— pi-coding-agent 工具无 workspace bound + 无 confirm
- ✅ AuthStorage — 已有 OS keychain（ADR-0004），pi-ai 自带 auth 注入点
- ❌ ProjectTrustStore — v0.5+ 考虑

### 1.3 未来能力

- ❌ Tool 插件系统（用户写自定义 tool）— v0.6
- ❌ Tool marketplace — v1.0
- ❌ Tool 调用 trace（debug UI）— v0.5
- ❌ Tool 调用统计 / 性能 — v0.5
- ❌ Tool sandboxing（firejail / docker 隔离）— v2.0+ 考虑

### 1.4 不做什么

- ❌ 远程 tool（tool 跑在用户机器，不在云）
- ❌ 静默 tool call（必须 UI 可见）

---

## 2. 当前实现

| 文件 | 职责 | v0.4.1 状态 |
|---|---|---|
| `sidecar/src/index.mjs` | sidecar 入口（Agent + createModels + 7 tool 工厂）| v0.4.1 集成 pi-coding-agent |
| `sidecar/src/openai-compatible.mjs` | v0.3 手写 fetch + SSE | v0.4 删（被 pi-ai 替换）|
| `sidecar/src/tools/` | v0.4 计划自写 7 tool | **v0.4.1 不存在**（用 pi-coding-agent 工厂）|
| `sidecar/test-smoke-faux.mjs` | fauxProvider 烟测（tool_execution_start/end + cost 必填）| v0.4.1 PASS |
| `app/src/stores/chat.ts` | 接收 tool_* 事件 + step 累加 state | v0.4.1 加 setStepCollapsed / setStepThinkingCollapsed |
| `app/src/components/ChatMain/StepGroup.vue` | 单 step 渲染（thinking + tool_calls, 默认全折叠）| **v0.4.1 新建** |
| `app/src/components/ChatMain/ChatMessage.vue` | tool_call 块 UI + 改用 steps prop | v0.4.1 改 |
| `app/src/components/ChatMain/ChatMain.vue` | list-inner + composer-area 收窄 880→720 | v0.4.1.3 改 |
| `app/src/components/Sidebar/WorkspaceTree.vue` | session item is-streaming 跑马灯 | v0.4.1.3 加 marching ants |

### 2.1 协议（不变）

FE ↔ Sidecar JSON Lines 协议**保持 v0.3.8.6+ 形态**：

```typescript
{ type: 'tool_start', toolName: string, toolCallId: string, args: Record<string, any>, sessionId }
{ type: 'tool_update', toolCallId: string, delta: string, sessionId }
{ type: 'tool_end', toolCallId: string, result?: any, error?: string, sessionId }
```

**v0.4 改动**：sidecar 内部用 `agent.subscribe(event)` 接收 pi-agent-core 事件 → 映射到 JSON Lines 协议 → 发给 FE。

**v0.4.1 修复**：event name 改对（`tool_execution_start/update/end` → `tool_start/update/end`）— v0.4 集成时按印象写错 `tool_call_*`，v0.4.1 集成 7 tool 后立即冒泡。AI 改 Pi SDK 必看文档 + grep 源码，不要凭印象。

### 2.2 当前限制

- ✅ **Tool executor 已有**（v0.4.1）— 7 tool 由 pi-coding-agent 工厂创建，Agent 自动 dispatch
- ❌ **没有 abort 机制**（v0.4 必做未做）— 用户不能中断正在跑的 tool + LLM 流
- ❌ **没有权限控制**（v0.4 必做未做）— workspace 路径校验 + 危险命令黑名单缺失
- ❌ **没有 permission confirm**（v0.4 必做未做）— pi-coding-agent 工具无 user confirm hook

---

## 3. 已知问题 / 限制

- ❌ 没有 abort 机制（v0.4 必做未做）
- ❌ 没有权限控制（v0.4 必做未做）
- ❌ tool 工具名按 pi-coding-agent 实际 emit（`read`/`write`/`edit`/`bash`/`ls`/`find`/`grep`）— UI 渲染时要看 `tool_start.toolName`，不能硬编码假设
- 🟡 tool result 折叠状态不持久化（session 重新打开后所有 tool 都默认展开）

---

## 4. 待办（Roadmap）

### P0（v0.4 必做）

- [x] **集成 `pi-ai` + `pi-agent-core`** — 2026-08-16 用户拍板（ADR-0012）
- [x] **集成 `pi-coding-agent` 7 tool** — 2026-08-17 v0.4.1 反转（D102，直接用包不自写）
- [x] **Tool executor**：pi-coding-agent 工厂创建，Agent 自动 dispatch
- [x] **修复 event name** `tool_call_*` → `tool_execution_*` → 映射到 JSON Lines `tool_*`
- [x] **修复 cost 必填** — `pi-ai/src/models.ts:882` calculateCost 假设 `model.cost` 已定义
- [x] **Step 累加 UI** — 1 turn = 1 step group，Cursor 风格
- [x] **Tool result 持久化** — v0.4.2 用 pi-coding-agent SessionManager
- [ ] **Tool permission UI**（未做，v0.4 必做）— wrapper layer
- [ ] **Workspace 路径校验**（未做，v0.4 必做）— wrapper layer
- [ ] **危险命令黑名单**（未做，v0.4 必做）— wrapper layer
- [ ] **Abort 按钮**（未做，v0.4 必做）— kill sidecar 子进程

### P1（v0.4 - v0.5）
- [ ] Tool call history 折叠状态持久化
- [ ] Tool call trace UI（debug：每步 args / result / timing）
- [ ] Tool timeout 配置（per-tool）

### P2（v0.5+）
- [ ] 用户自定义 tool（写 JS / Python）
- [ ] Tool marketplace
- [ ] Tool 性能统计
- [ ] Sandboxing

---

## 5. Changelog

- **2026-08-17 · v0.4.1 (集成 pi-coding-agent 7 tool)** · D102 反转（"直接使用 pi-coding-agent 包的"），7 tool 由 `createReadTool`/... 工厂创建，Agent 自动 dispatch。修了 4 个坑：event name `tool_call_*` → `tool_execution_*` + cost 必填（`pi-ai/src/models.ts:882`）+ step 累加 UI（1 turn = 1 step group, Cursor 风格）+ final body 渲染 `lastStep.stepText` 防重复. Session 跑马灯 + chat 收窄 880→720
- **2026-08-16 · v0.4 plan** · 集成 pi-ai + pi-agent-core（ADR-0012 拍板），原计划 7 个 tool + session 自写
- **2026-08-16 · v0.3.8.26** · tool 文字色区分（fg-secondary）
- **2026-08-16 · v0.3.8.6** · tool_call 流式 + 折叠
- **2026-08-12 · v0.3** · tool 事件协议设计
