# Tools（工具调用）

> 状态: 🟡 30%
> 最后更新: 2026-08-16
> spec 涉及: `sidecar/src/openai-compatible.mjs` + 计划集成 `pi-agent` SDK + Tauri fs/shell 权限

---

## 1. Spec

**Tool = LLM 能调用的本地能力**（读文件 / 跑命令 / 搜索 / 调用 MCP）。**这是 Pi Agent 从 chat 客户端变成 agent 客户端的关键**。

### 1.1 必备能力（v0.4 必做）

- ✅ Tool call 协议（流式接收 + UI 展示 + 折叠）— v0.3.8.6+
- ❌ **内置工具集**（v0.4 必做）：
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
- ❌ Tool call 复用（同一个 tool call 第二次走 cache）— v0.5+

### 1.2 未来能力

- ❌ Tool 插件系统（用户写自定义 tool）— v0.6
- ❌ Tool marketplace — v1.0
- ❌ Tool 调用 trace（debug UI）— v0.5
- ❌ Tool 调用统计 / 性能 — v0.5
- ❌ Tool sandboxing（firejail / docker 隔离）— v2.0+ 考虑

### 1.3 不做什么

- ❌ 远程 tool（tool 跑在用户机器，不在云）
- ❌ 静默 tool call（必须 UI 可见）

---

## 2. 当前实现

| 文件 | 职责 |
|---|---|
| `sidecar/src/openai-compatible.mjs` | **当前**只做 chat completion，**没 tool executor**（v0.4+ 集成） |
| `app/src/stores/chat.ts` | 接收 `tool_start` / `tool_update` / `tool_end` 事件 |
| `app/src/components/ChatMain/ChatMessage.vue` | tool_call 块 UI（折叠 / 展开）|

### 2.1 协议（已有）

```typescript
{ type: 'tool_start', toolName: string, toolCallId: string, args: Record<string, any>, sessionId }
{ type: 'tool_update', toolCallId: string, delta: string, sessionId }
{ type: 'tool_end', toolCallId: string, result?: any, error?: string, sessionId }
```

### 2.2 事件处理（v0.3.8.6+）

- tool_start 触发：UI 创建 tool_call block（折叠状态）
- tool_update 增量更新 tool 参数 / 输出
- tool_end 触发：UI 展开结果 / 错误

### 2.3 当前限制

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

- [ ] **集成 `pi-agent` SDK**（替代直接 fetch 简单调用）
- [ ] **7 个内置工具**：read_file / write_file / edit_file / list_dir / glob / grep / bash
- [ ] **Tool executor**：sidecar 内部跑 tool + 捕获输出 + 超时控制
- [ ] **Tool permission UI**：每次 call 前 confirm（首次 + 黑名单 + 白名单）
- [ ] **Workspace 路径校验**：path traversal (`../`) 拒绝
- [ ] **危险命令黑名单**：`rm -rf /`, `mkfs`, `dd if=`, `format` 等
- [ ] **Abort 按钮**：用户中断正在跑的 tool + LLM 流
- [ ] **Tool result 持久化**到 session JSONL
- [ ] **Tauri fs/shell 权限**加到 capabilities

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

- **2026-08-16 · v0.3.8.26** · tool 文字色区分（fg-secondary）
- **2026-08-16 · v0.3.8.6** · tool_call 流式 + 折叠
- **2026-08-12 · v0.3** · tool 事件协议设计
