# MCP / 插件 (Model Context Protocol)

> 状态: ❌ 0%
> 最后更新: 2026-08-16
> spec 涉及: v0.6 phase 新增

---

## 1. Spec

**MCP = Model Context Protocol**。Anthropic 主导的"LLM 工具标准化协议"，让第三方工具可以"装上就用"。

### 1.1 必备能力（v0.6 必做）

- ❌ **MCP server 接入（stdio transport）**
  - 用户配 `mcp.json`（类似 Claude Desktop）
  - Sidecar spawn MCP server 子进程
  - 读 MCP server 暴露的 tool 列表
- ❌ **MCP tool 注入到 LLM tool 列表**
  - LLM 看到 `mcp_<server>_<tool>` 命名
  - Tool call 路由到对应 MCP server
- ❌ **MCP 资源（resources）支持**（文件 / 数据库 schema）
  - LLM 能 query 资源
- ❌ **MCP prompt 模板支持**
- ❌ **本地 / git URL 装 MCP server**
  - `npx -y @some/mcp-server` 一键装
  - 不用 marketplace（v1.0 再说）

### 1.2 未来能力

- ❌ MCP server marketplace — v1.0
- ❌ MCP server 配置 UI（不用手写 JSON）— v0.6 末 / v0.7
- ❌ 远程 MCP server（SSE transport）— v0.7
- ❌ MCP server 权限管理（哪些 server 能调哪些 tool）— v0.7
- ❌ 私有 MCP registry — v1.0+（C 方案需要）

### 1.3 不做什么

- ❌ 商业 marketplace（v1.x 不做）
- ❌ MCP server 自动发现（必须用户显式配）
- ❌ MCP server 自动更新（用户自己管版本）

---

## 2. 当前实现

**没有**。Sidecar 只做 chat completion + 计划中的内置 tool。

---

## 3. 已知问题 / 限制

N/A

---

## 4. 待办（Roadmap）

### P0（v0.6 必做）
- [ ] MCP stdio transport 实现（sidecar 内部）
- [ ] `mcp.json` 解析 + 加载
- [ ] MCP tool 列表 → LLM tool_calls
- [ ] MCP tool call 路由 + 结果回传
- [ ] 常见 MCP server 兼容测试（filesystem / github / postgres）

### P1（v0.6 - v0.7）
- [ ] MCP server 配置 UI
- [ ] 远程 MCP server（SSE transport）
- [ ] MCP server 权限管理

### P2（v0.7+）
- [ ] MCP marketplace
- [ ] 私有 MCP registry（C 方案部署需要）
- [ ] MCP server 调试 UI

---

## 5. Changelog

N/A
