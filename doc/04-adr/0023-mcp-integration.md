# ADR-0023: MCP 集成方案 — stdio Phase 1 + SSE/HTTP Phase 2

**Status**: accepted (2026-08-17, user 拍板 3 阶段全做)
**Context**: Pi SDK 0.84.2 没原生 MCP 支持, 主流产品 (Claude Code / Trae / Cursor) 都有, 1000+ community MCP servers
**Decider**: user 拍板 3 阶段全做 (2026-08-17 23:26) — Phase 1 v0.5.3 stdio + Phase 2 v0.5.4 SSE/HTTP + Phase 3 v0.5.5 UI 管理面板

## 背景

MCP (Model Context Protocol) 是 Anthropic 2024-11 推的开放标准, 让 AI agent 接入外部工具 (GitHub/Jira/DBs/Slack/Figma/Browser 等). 2026 已是 AI agent 生态基础.

主流产品支持:
- Claude Code: 1000+ community MCP servers, 走 `claude mcp add` 配置
- Trae: 支持 stdio/SSE/Streamable HTTP 三种 transport
- Cursor: `.cursor/mcp.json` 配置, 走 plugin marketplace

Pi SDK 0.84.2 没 MCP 支持. 我们的方案: sidecar 启动 MCP server (走 stdio), 通过 Pi SDK `extensionFactories` 暴露为 tool.

## MCP 集成方案

### 整体架构

```
[Tauri App]
    │
    ├─ send_rpc_command (existing)
    │
    └─ new: mcp.{start,stop,list,invoke}_server
            │
            ▼
[Tauri Rust]
    │
    ├─ spawn MCP server process (走 stdio, 类似 sidecar)
    │      - 配置: ~/.pi/mcp_servers.json (项目级 + 用户级)
    │      - 走 app.shell().sidecar() 或 std::process::Command
    │      - stdio pipe 双向通信
    │
    └─ 把 MCP server 的 tools 透传给 sidecar
            │
            ▼
[Sidecar (Node.js, Pi SDK)]
    │
    └─ mcp 客户端层 (新写, ~100 行)
          - 启动时 list tools (走 JSON-RPC over stdio)
          - 包装为 Pi SDK InlineExtension
          - tool call 时 invoke MCP server
          - 把 result 走 RpcEvent 透传回 FE
```

### 配置文件格式 (~/.pi/mcp_servers.json)

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "from-keychain" }
    },
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/workspace"]
    }
  }
}
```

**安全**:
- env 引用 keychain 里的 secret (跟现有 BYOK 机制一致, 不存明文)
- capabilities 控制 MCP server 可访问的资源 (filesystem scope / network)

### 实施分 3 阶段

**Phase 1 (v0.5.3, 8-10h): stdio transport (核心)**
- sidecar 加 mcp client (~100 行)
- Tauri 加 mcp_start_server / mcp_stop_server / mcp_list_servers / mcp_invoke tool
- 配置文件: ~/.pi/mcp_servers.json
- 走 std::process::Command 启动 MCP server (走 stdio)
- Pi SDK `extensionFactories` 把 MCP tools 暴露给 LLM
- 测试: 集成 filesystem MCP server, 验证 LLM 能 list/read/write 文件

**Phase 2 (v0.5.4, 4h): SSE + Streamable HTTP transport**
- mcp client 加 SSE / Streamable HTTP 客户端
- 远程 MCP server 支持 (e.g. hosted Linear/Figma MCP)

**Phase 3 (v0.5.5, 2h): UI management 面板**
- Settings → MCP Servers 页面
- 启停 / 配置 / 状态查看
- 跟现有 BYOK keychain 集成 (env 引用 keychain)

## 安全 / 权限考量

跟现有 Tauri 2 capabilities 机制集成:
- `shell:allow-spawn` 已经声明 (v0.5.8 加的, D172 规则)
- MCP server 启动走同样的 capability 检查
- MCP tool call 走 existing permission 二次确认机制 (跟 bash / write 一样)
- 高风险 MCP server (e.g. 写 GitHub repo) 走 `permission_mode: 'ask'`
- 低风险 MCP server (e.g. 只读 GitHub) 走 `permission_mode: 'allow'`

## 跨项目通用

跟 Claude Code 配 mcp_servers.json 格式兼容 (或转换):
- 同样 `mcpServers` 顶层 key
- 同样 `command` + `args` + `env` schema
- user 从 Claude Code 复制 mcp config 过来即可

## 决策点 (user 拍板)

- [x] ✅ 同意 3 阶段全做 (2026-08-17 23:26, user 拍板)

### 落地计划

- **v0.5.3 (~2-3 月)**: Phase 1 stdio transport (核心 8-10h)
  - sidecar 加 mcp client (~100 行)
  - Tauri 加 mcp_start_server / mcp_stop_server / mcp_list_servers / mcp_invoke tool
  - 配置文件: ~/.pi/mcp_servers.json
  - Pi SDK `extensionFactories` 暴露 MCP tools 给 LLM
  - 测试: 集成 filesystem MCP server, 验证 LLM 能 list/read/write 文件

- **v0.5.4 (~3 月)**: Phase 2 SSE + Streamable HTTP transport (4h)
  - mcp client 加 SSE / Streamable HTTP 客户端
  - 远程 MCP server 支持 (e.g. hosted Linear/Figma MCP)

- **v0.5.5 (~3-4 月)**: Phase 3 UI management 面板 (2h)
  - Settings → MCP Servers 页面
  - 启停 / 配置 / 状态查看
  - 跟现有 BYOK keychain 集成 (env 引用 keychain)

---

**关联**:
- [05-competitive-analysis-2026.md](../05-competitive-analysis-2026.md) — MCP 缺口分析
- ADR-0021 — Pi Agent 2026 战略
- ADR-0022 (TBD) — Sub-agent 架构
- D172 — Tauri 2 standard sidecar (复用 app.shell().sidecar() 机制)
