# Tools（工具调用）

> 状态: 🟡 30%
> 最后更新: 2026-08-16
> spec 涉及: `sidecar/src/`（**v0.4 集成 pi-ai + pi-agent-core**）+ `app/src/stores/chat.ts` + Tauri fs/shell 权限

---

## 1. Spec

**Tool = LLM 能调用的本地能力**（读文件 / 跑命令 / 搜索 / 调用 MCP）。**这是 Pi Agent 从 chat 客户端变成 agent 客户端的关键**。

### 1.1 必备能力（v0.4 必做）

- ✅ Tool call 协议（流式接收 + UI 展示 + 折叠）— v0.3.8.6+
- 🟡 **LLM 调用层**（**v0.4.0** 集成 pi-ai 完成）— 复用 `createModels` + 内置 7 provider 工厂 + 自定义 `createProvider`
- 🟡 **Agent loop**（**v0.4.0** 集成 pi-agent-core 完成）— 复用 `Agent` 类 + `AgentTool` 接口
- ❌ **7 个 tool 自实现**（v0.4 必做）：
  - `read_file(path)` — 读文件内容
  - `write_file(path, content)` — 写文件
  - `edit_file(path, old, new)` — 局部编辑
  - `list_dir(path)` — 列目录
  - `glob(pattern)` — 文件名匹配
  - `grep(pattern, path)` — 内容搜索
  - `bash(command, cwd?)` — 跑命令
- ❌ **Tool permission system**（v0.4 必做）：
  - 每次 tool call 用户 confirm（至少第一次）
  - 白名单 / 黑名单
  - workspace 路径限制
  - 危险命令拦截（`rm -rf /` 等）
- ❌ **Abort tool**（v0.4 必做）：
  - 用户能中断正在跑的 bash
  - 同时中断 LLM 流（联动 [chat-core.md](chat-core.md)）
- ❌ Tool result 持久化到 session — 部分（v0.3.8.6+ 已落 session）
- ❌ **Tool call history 折叠 / 展开**（v0.4 增强）

### 1.2 Pi SDK 集成（v0.4 计划）

`@earendil-works/pi-ai` + `@earendil-works/pi-agent-core` — 详见 [ADR-0012](../04-adr/0012-pi-sdk-integration.md)

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

**pi-agent-core 不提供**（**自实现**）：
- ❌ 7 个内置 tool（read/write/edit/bash/ls/find/grep）— 自己用 `AgentTool` 接口实现
- ❌ SessionManager — 自己用 JSONL 持久化
- ❌ AuthStorage — 已有 OS keychain（ADR-0004）
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

| 文件 | 职责 | v0.4 改动 |
|---|---|---|
| `sidecar/src/index.mjs` | sidecar 入口 | 改：import pi-ai + pi-agent-core |
| `sidecar/src/openai-compatible.mjs` | **当前**手写 fetch + SSE 解析（v0.3 阶段）| **删**（被 pi-ai 替换）|
| `sidecar/src/agent.mjs` | **新**：Agent + createModels 实例 | v0.4 新建 |
| `sidecar/src/tools/` | **新**：7 个 tool 实现目录 | v0.4 新建 |
| `app/src/stores/chat.ts` | 接收 tool_* 事件 | 协议不变 |
| `app/src/components/ChatMain/ChatMessage.vue` | tool_call 块 UI | UI 不变 |

### 2.1 协议（不变）

FE ↔ Sidecar JSON Lines 协议**保持 v0.3.8.6+ 形态**：

```typescript
{ type: 'tool_start', toolName: string, toolCallId: string, args: Record<string, any>, sessionId }
{ type: 'tool_update', toolCallId: string, delta: string, sessionId }
{ type: 'tool_end', toolCallId: string, result?: any, error?: string, sessionId }
```

**v0.4 改动**：sidecar 内部用 `agent.subscribe(event)` 接收 pi-agent-core 事件 → 映射到 JSON Lines 协议 → 发给 FE。

### 2.2 当前限制

- **没有 tool executor**：sidecar 不会真去读文件 / 跑命令
- LLM 调用 tool_call → 收到 tool_start 事件 → UI 展示 → **但 tool 永远不结束**（因为没人响应）
- 这是 v0.4 要解决的核心问题

---

## 3. 已知问题 / 限制

- 🟡 Tool call UI 已有，但 executor 缺失
- 🟡 没有 abort 机制
- 🟡 没有权限控制
- 🟡 没有 tool result 折叠状态持久化（session 重新打开后所有 tool 都默认展开）

---

## 4. 待办（Roadmap）

### P0（v0.4 必做）— 整个 v0.4 phase 就是为了做这个

- [x] **集成 `pi-ai` + `pi-agent-core`** — 2026-08-16 用户拍板（ADR-0012）
- [ ] **7 个内置工具**：read_file / write_file / edit_file / list_dir / glob / grep / bash（自实现，基于 pi-agent-core AgentTool）
- [ ] **Tool executor**：sidecar 内部跑 tool + 捕获输出 + 超时控制
- [ ] **Tool permission UI**：每次 call 前 confirm（首次 + 黑名单 + 白名单）
- [ ] **Workspace 路径校验**：path traversal (`../`) 拒绝
- [ ] **危险命令黑名单**：`rm -rf /`, `mkfs`, `dd if=`, `format` 等
- [ ] **Abort 按钮**：用户中断正在跑的 tool + LLM 流
- [ ] **Tool result 持久化**到 session JSONL
- [ ] **Tauri fs/shell 权限**加到 capabilities
- [ ] **build pi-sdk**：`pi-sdk/packages/ai` + `pi-sdk/packages/agent` 出 dist

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

- **2026-08-16 · v0.4 plan** · 集成 pi-ai + pi-agent-core（ADR-0012 拍板），7 个 tool + session 仍自写
- **2026-08-16 · v0.3.8.26** · tool 文字色区分（fg-secondary）
- **2026-08-16 · v0.3.8.6** · tool_call 流式 + 折叠
- **2026-08-12 · v0.3** · tool 事件协议设计
