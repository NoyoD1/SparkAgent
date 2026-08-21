# ADR-0018: MCP 集成 (Model Context Protocol, Anthropic 协议)

- **状态**: Accepted
- **日期**: 2026-08-21
- **Type**: Functional
- **Module**: Tools (extension)
- **决策者**: user
- **Relates to**: [0014-feature-tools](0014-feature-tools.md) (工具模块扩展), [0005-pi-sdk-integration](0005-pi-sdk-integration.md) (customTools 接入点)

## 功能定义 (应该做什么)

- ✅ 4 个 Tauri command (list/read/write/delete MCP server JSON)
- ✅ 两层 scope: workspace (`<ws>/.pi/mcp/`) + global (`<user.home>/.pi/agent/mcp/`)
- ✅ Workspace 优先 (同名时 workspace 覆盖 global)
- ✅ 4 种 transport (schema 接受, 实际只实现 stdio): stdio / http / sse
- ✅ 离线 MCP 测试 server (`doc/mcp-test-server/offline-mcp-server.mjs`, 4 tool: echo / add / hello / sysinfo)
- ✅ Cherry Studio 同款 UI (form/JSON 双视图 + type radio + env 字段)
- ✅ JSON 导入 3 格式 auto-detect (single object / array / Claude Desktop `{mcpServers: {...}}`)
- ✅ Sidecar 走官方 `@modelcontextprotocol/sdk` (Client + StdioClientTransport)
- ✅ 工具名加 `mcp_<server>_<tool>` 前缀 (防跟 builtin / user tool 撞)
- ✅ lifecycle: spawn → initialize → listTools → callTool → stop (exit/SIGTERM 清理子进程)
- ❌ HTTP / SSE transport 真正实现 (schema 接受, sidecar 未实现)
- ❌ Hot reload (改 config 后需切 workspace / 重启 app 触发 sidecar 重启)
- ❌ drag-drop 文件 / 批量覆盖 / 单 server 单独 scope (P2-1.2 候选, 暂不做)

## 已实现 (v0.6.3-rc1 P2-1 系列)

### Rust 端 4 command (src-tauri/src/lib.rs)

```rust
#[tauri::command]
async fn list_mcp_servers(workspace_path: Option<String>, agent_dir: Option<String>) -> Result<Vec<McpServerInfo>, String>
// scan workspace <ws>/.pi/mcp + global <agentDir>/mcp (workspace_override 优先级)
async fn read_mcp_server(args: ReadDeleteMcpServerArgs) -> Result<String, String>
async fn write_mcp_server(args: McpServerArgs) -> Result<String, String>
async fn delete_mcp_server(args: ReadDeleteMcpServerArgs) -> Result<bool, String>
```

**McpServerInfo** 结构 (返给 FE):

```rust
struct McpServerInfo {
    name: String,
    command: String,
    body: String,         // 完整 JSON (FE 不重复读)
    file_path: String,    // 绝对路径 (debug 用)
    scope: String,        // 'workspace' | 'global'
    server_type: String,  // 'stdio' | 'http' | 'sse' (默认 stdio)
}
```

### Sidecar 端 (sidecar/src/mcpClient.mjs + index.mjs)

```js
class McpServerClient {
  constructor(config: { name, command, args, env, cwd, timeout, type? })
  async start()    // spawn 子进程 + JSON-RPC initialize + listTools
  async callTool(name, args)  // JSON-RPC tools/call + 30s timeout
  async stop()     // client.close() + transport.close() (SIGTERM 子进程)
}

function loadMcpServerConfigs(workspacePath, agentDir)  // 扫两层 scope, workspace 覆盖 global
function wrapMcpToolsAsCustomTools(clients)  // MCP tool → Pi SDK ToolDefinition (mcp_<server>_<tool> 前缀)
function registerMcpCleanup(clients)  // exit / SIGTERM / SIGINT / SIGHUP 清理
```

### FE 端 (Settings → MCP tab)

```
新建 / 编辑 (unified dialog):
  名称 [filesystem            ]   ← 大号 input
  命令 [npx]  参数 [-y @mcp/server-fs D:\path]   ← inline 30%/flex
  高级 ▾
    目标
    ┌─ ○ 当前工作区 ─────────────────────────────┐
    │  [Test1 — D:\AIWorkSpace\Test1 ▼]  ← 多个 ws 可选
    │  → 写到 <ws>/.pi/mcp/<name>.json
    │  = D:\AIWorkSpace\Test1\.pi\mcp\<name>.json
    └────────────────────────────────────────────┘
    ┌─ ○ 全局 (跨工作区) ──────────────────────┐
    │  → 写到 C:\Users\你\.pi\agent\mcp/<name>.json
    └────────────────────────────────────────────┘
    环境变量 (JSON object)   [{}]
    超时 (毫秒)              [30000]
  [取消]  [添加]
```

### 存储 & 路径解析

```
workspace scope:  <workspacePath>/.pi/mcp/<name>.json
global scope:     <agentDir>/mcp/<name>.json
  agentDir 默认:    <user.home>/.pi/agent/  (USERPROFILE 优先, fallback HOME)
  兜底共用:         resolve_mcp_agent_dir() helper (P2-1.6)
```

## 备选 / 关键决策

### 1. 官方 SDK vs 自研 JSON-RPC

- ✅ **选官方 `@modelcontextprotocol/sdk`**: 协议细节正确率高, 跟生态兼容, npm 包小
- ❌ 备选自研 JSON-RPC: 协议细节 (initialize / listTools / tools/call 握手) 易错, 维护成本高
- 决策: P2-1.0 拍板, 时间 1 个晚上验证可行

### 2. JSON Schema → Pi SDK TypeBox 转换

- ✅ **自写 `jsonSchemaToTypeBox`**: 处理 4 primitive (string/number/boolean) + array + nested object
- 复杂 (oneOf / anyOf / $ref / enum) 降级 `Type.Any()` — Pi SDK TypeBox 跟 OpenAI JSON Schema 互转, 简单 schema LLM 能看懂
- 决策: P2-1.0 拍板, 99% MCP server schema 简单够用

### 3. 工具名 `mcp_<server>_<tool>` 前缀

- ✅ **加前缀**: 防跟 builtin 7 个 + user tool 撞名
- 例: `filesystem` server + `read_file` tool → `mcp_filesystem_read_file`
- 决策: P2-1.0 拍板, 跟 P1-5 user tool 区分一致

### 4. 两层 scope (workspace + global)

- ✅ **沿用 Skills / User Tools 同 pattern**: workspace 优先覆盖 global, 路径解析一致
- workspace 跟项目绑定, global 跟用户绑定 (白话文: 项目工具 vs 个人工具)
- 决策: 跟 0008-tool-permission 沙箱一致, 不增加新概念

### 5. UI 设计: Cherry Studio 同款 vs 极简

- v0.6.3-rc1 P2-1.3 走 Cherry Studio 风格 (form/JSON tab + type radio + 完整字段) → user 反馈"内容太多"
- v0.6.3-rc1 P2-1.4 极简: 只露 3 字段 (名称/命令/参数), 其它塞"高级"折叠
- 决策: P2-1.4 拍板, 用 `<details>` 原生折叠, 零 JS 状态, a11y 免费

## 关键 Bug 修复时间线 (端到端测试发现)

| Commit | 现象 | 根因 | 修法 |
|---|---|---|---|
| P2-1.2 | list 拿 None | FE wrapper 用 `{ args: {...} }` 包装, 但 Rust 函数是独立参数, 走错路径 | 改 `invoke('list_mcp_servers', { workspacePath, agentDir })` 平铺 |
| P2-1.5 | global scope 不能保存 | FE 永远传 agent_dir=None, Rust 拒 | resolve_mcp_servers_dir global branch 加 `<user.home>/.pi/agent` 兜底 |
| P2-1.6 | LLM 工具列表只有 7 个 builtin, 看不到 mcp_* | Pi SDK 0.84.2 `isAllowedTool` 只放行 `tools` 数组里的名字, customTools 静默过滤 | sidecar 拼 `allTools = [...builtin, ...customTools 名字]` 传给 Pi SDK |
| P2-1.7 | list global 拿不到 | list 路径也有 `if let Some(agent_dir)` 漏兜底 | 抽 `resolve_mcp_agent_dir` helper, list 也用它 |

## 端到端核验

### 配置 + 启 sidecar

1. 配 workspace `D:\AIWorkSpace\Test1` 激活
2. Settings → MCP → 新建 → 名称 `offline-mcp-test` / 命令 `node` / 参数 `D:\UnityWork\Tools\Pi\doc\mcp-test-server\offline-mcp-server.mjs`
3. 选 workspace scope → 添加
4. **必须切 workspace 或重启 app** 触发 sidecar 重启 (当前不热重载)
5. F12 console 应看到:
   ```
   [sidecar] P2-1: MCP server 'offline-mcp-test' started (4 tools, <X>ms)
   [sidecar] P2-1: 4 MCP tool(s) merged into customTools: [...]
   [sidecar] creating agent session: ... mcpTools=4 ...
   ```

### 调 4 个 tool

| Prompt | Tool | 预期 |
|---|---|---|
| "用 mcp_offline-mcp-test_echo 跟我说 hello" | echo | LLM 直接调, 输出 `echo: hello` |
| "用 mcp 工具计算 17 + 25" | add | 输出 `17 + 25 = 42` |
| "用 mcp 工具 hello 跟我打个招呼" | hello | 输出 `Hello, World!` |
| "用 mcp 工具 sysinfo 告诉我 Node 版本" | sysinfo | 输出含 `nodeVersion: v24.16.0` 等 JSON |

## 已知问题 / 技术债

- ❌ **HTTP / SSE transport**: schema 接受但 sidecar 实际只接 stdio. UI 选了 HTTP/SSE 会保存失败 (P2-3 待做)
- 🟡 **不热重载**: 改 config 后需切 workspace 或重启 app 触发 sidecar 重启 (P1-5.2 待做)
- 🟡 **复杂 schema fallback**: `oneOf` / `anyOf` / `$ref` 降级 `Type.Any()`, 部分复杂 MCP server 工具参数 LLM 可能识别不准
- 🟡 **没超时 per-tool 配置**: 全局 timeout 30s, 长跑 tool 会超时 (e.g. fetch 下载大文件)

## 后续规划

### P2-3 (HTTP / SSE transport)
- 走 `@modelcontextprotocol/sdk` 的 `StreamableHTTPClientTransport` (新版, 替 SSEClientTransport)
- OAuth flow 走 device code / client credentials (MCP 标准 auth)
- sidecar spawn 不再需要本地进程, 改成长连接 pool
- UI form mode 加 URL / headers 字段 (HTTP/SSE 专用)

### P1-5.2 (Hot reload)
- FE 写 MCP/user tool 后, Tauri 端 `event::emit("mcp-config-changed")` 通知 sidecar
- sidecar 监听事件, kill 旧 agent session, spawn 新 session
- 不重启整个 sidecar, 保留 model / session / 历史

## 何时 Revisit

- **HTTP / SSE 真正使用**: 当 user 报告 "我需要接某个远程 MCP server (不是本地 node)" → 立刻 P2-3
- **热重载体验差**: 当 user 报告 "改 MCP config 太麻烦, 每次要切 ws" → 立刻 P1-5.2
- **复杂 schema 报 LLM 调用不准**: 当 user 报 "某个 MCP tool 调不通" → 升级 jsonSchemaToTypeBox

---

## 后续 Review (2026-08-21, v0.6.3-rc1)

> 不可变原则: 决策落地后不改原文章节, 变更只追加 ## 后续 Review 段.

(v0.6.3-rc1 实际跑下来发现的问题 / 调整 / 推翻原因)

### 已修 (P2-1.2 / .5 / .6 / .7)

- ✅ P2-1.2: FE wrapper `args` 包装错 — 改成平铺
- ✅ P2-1.5: global scope write 兜底 — resolve_mcp_servers_dir 加 `<user.home>/.pi/agent` 兜底
- ✅ P2-1.6: Pi SDK 0.84.2 isAllowedTool 过滤 customTools — 拼 `allTools` 白名单
- ✅ P2-1.7: list global scan 漏兜底 — 抽 `resolve_mcp_agent_dir` helper, 共享给 list

### UI 调整 (P2-1.3 → P2-1.4)

- v0.6.3-rc1 P2-1.3 Cherry Studio 同款 (form/JSON tab + type radio + 完整字段) — user 反馈"内容太多"
- v0.6.3-rc1 P2-1.4 极简: 砍 JSON tab / 砍 type radio / 砍顶部 hint, 只露 3 字段 + 高级折叠 (<details>)
- 决策变更: 极简 > 形式完整, 高频 user 不需要看到 HTTP/SSE / env 字段

### 仍然 TODO (跟原文档一致)

- ❌ HTTP / SSE transport 实现 (P2-3)
- ❌ 热重载 (P1-5.2)
- 端到端测试已通过 (offline-mcp-test 4 tool 全部能调)

---

## 后续 Review (2026-08-21, v0.6.3-rc1 二阶段 P2 全部完成)

> 二阶段定义: 7-item 计划 (HTTP/SSE + 热重载 + UI 字段 + 复杂 schema + 错误 sanitize + Session 4 件套审计)
> 全部推进到代码就绪 + build 验证 + 端到端可测状态. user 后续人工验证后归档.

### 二阶段 P2 全部 6 个 item 完成 (P2-1.8 ~ P2-6)

| Commit | Item | 状态 | 核心改动 |
|---|---|---|---|
| `07f3774` | **P2-1.8** HTTP/SSE transport 真正实现 | ✅ | sidecar 抽 `createTransport` 按 type dispatch: stdio (Stdio) / http (StreamableHTTP) / sse (SSE). env 字段复用 (stdio = 子进程 env, http/sse = request headers). no OAuth (user 明示). 4 文件 + 1 binary. |
| `80dbf6e` | **P2-1.8.1** mcpImport 加 map 格式 (hotfix) | ✅ | 加第 4 种 import 格式 `{name: {config}}` (workspace 风格, 跟 Claude Desktop 区别是没 mcpServers 包裹). 同时放宽 format ① 探测 (name + url 也算, http config 不被拒). |
| (P2-2 一并修) | **P2-1.8 oversite** tryParseMcpServerJson 适足 type=url | ✅ | sidecar 读 config 时仍要求 command 必填, http/sse 会被静默 reject. 跟 P2-2 一起修了, 按 type 分支校验必填字段. |
| `0f7c3fa` | **P2-2** MCP 热重载 (fs.watch + debounce) | ✅ | sidecar-side `fs.watch` 双 config dir, 300ms debounce. **不重建 Pi SDK agent session** (重 = 丢对话状态, 跟 user 原话"重启 sidecar agent session"略偏, 选了"reload MCP subsystem"路径, 跟 Claude Code / Cursor 体验一致). in-place close + re-spawn, LLM 下一轮 turn 看到新 tool. |
| `b77c9fa` | **P2-3** dialog 恢复 form/JSON tab + type/url 字段 | ✅ | P2-1.4 砍 JSON tab 留下"HTTP/SSE 在 form 没法配 url"洞. P2-3 恢复思路: form 仍为主 (保留降低门槛), JSON tab 作 escape hatch. 加 type radio + url 字段 + env 字段按 type 切语义. 2 文件, 496+/138- 行. |
| `b9c7c6b` | **P2-4** 复杂 schema 升级 (oneOf/anyOf/allOf/$ref/递归) | ✅ | 重写 jsonSchemaToTypeBox, 加 convertSchema(schema, root, visited) 递归 + $ref 解析 (支持 #/definitions, #/$defs, #/components/schemas). 循环引用检测用 visited Set + 回溯删除. const → Literal, format/minimum/maximum 透传. 12/12 smoke test passed. |
| `3cd5632` | **P2-6** Tool 错误 sanitize (401/403/429/5xx 分类) | ✅ | 新增 errorSanitizer.mjs, classifyToolError + formatToolError. 输出格式 `[<emoji> <category>] <hint>\n原始: <original>`. user 一眼看出问题类型 + 知道下一步怎么修. 16/16 smoke test passed. 关键 bug fix: port 数字 (1:443) 不再被误判 4xx (用 lookbehind/lookahead 排除). |
| `5337a46` | **P2-final** .gitignore 加 .trash/ | ✅ | 临时测试/调试产出 fallback 目录. |

### Item 5 跳过 (per 原计划)

- ❌ **MCP per-tool timeout**: 不做. 保持 30s 全局. 远期: per-tool 覆盖.

### Item 7 审计: 3/3 已实现 (导出按计划跳过)

- ✅ **Session 标题自动生成** (Phase 6 / `app/src/stores/chat.ts:1978-2085`): ghost prompt 走独立 sidecar session, LLM 返回 1-8 字标题写回 `s.autoTitle`
- ✅ **Session 删除二次确认** (Phase 3 / `WorkspaceTree.vue:488-499`): 走 showConfirm + ConfirmDialog, danger=true, 文案含 session 名 + 不可撤销
- ✅ **Session 搜索** (Phase 5 / `WorkspaceTree.vue:503-532`): sidebar 顶部 🔍 input, 跨 workspace + 跨 archive, 本地同步 < 10ms
- ❌ **Session 导出**: 按 user 原话"除了导出" 跳过

### 关键设计决策 (二阶段)

- **HTTP 走 StreamableHTTPClientTransport** (MCP 新标准) 而非 SSEClientTransport, SSE 走 SSEClientTransport 兼容老 server
- **env 字段语义复用**: stdio = 子进程环境变量, http/sse = HTTP request headers (避免再加独立 headers 字段)
- **不实现 OAuth** (user 明示), auth 走 header (`Authorization: Bearer xxx` 塞 env 字段)
- **reload MCP subsystem 不重建 agent session** (user 原话"重启 sidecar agent session" 略偏, 选了 in-place reload 保留对话状态)
- **form/JSON tab 切换 form 为主** (P2-1.4 简化原则保留, JSON 是 escape hatch 不是主入口)
- **allOf 优先 object 合并** (跟 Type.Intersect 比起来 LLM 更易理解)
- **错误兜底保持 Type.Any() / unknown category** (任何解析失败不 crash, LLM 看到空 schema 总比 stack trace 好)
- **复杂 schema 测试不引入真 MCP server**: 12 case 全部是 ad-hoc JSON Schema, sidecar 启动时 unit test 跑一遍就够

### 端到端验证清单 (user 后续人工验)

- [ ] P2-1.8: 配 HTTP MCP server → 调 tool 能跑
- [ ] P2-1.8.1: 4 种 JSON 格式都能导入 (flat / array / Claude Desktop / map)
- [ ] P2-2: 编辑 .pi/mcp/*.json → 300ms 内 sidecar stderr 有 reload log
- [ ] P2-3: 编辑 dialog 顶部有 "表单 / JSON" tab, 选 http 切 URL 字段
- [ ] P2-4: 复杂 schema MCP tool 调通, LLM 一次填对参数
- [ ] P6: 配故意错 API key → 看到 `[🔐 auth_expired] 鉴权失败 (401)...`
- [ ] Item 7: 删 session 弹二次确认 / 搜索 sidebar 顶部 🔍 / 新 session 首条消息后自动命名

### 远期 backlog (commit message 里已记)

- P2-1.8.1: 独立 `headers` 字段 (跟 env 拆开)
- P2-2.1: Tauri event 推送给 FE, McpTab 实时显示 reload 提示
- P2-3.1: type=http/sse 时 env 字段做更友好的 headers 编辑 UI
- P2-4.1: TypeBox schema cache (per-tool 启动时 build 一次)
- P2-6.1: builtin tool (read/write/bash) 错误也走 sanitizer

### 产物

| 文件 | 大小 | 时间戳 |
|---|---|---|
| `src-tauri/target/debug/pi-agent-desktop.exe` | 27.27MB | 14:40 (含全部最新 FE + bundled sidecar) |
| `sidecar/dist/pi-agent-sidecar.exe` | 109.26MB | 14:01 (P2-6 build) |
| `src-tauri/binaries/pi-agent-sidecar-x86_64-pc-windows-msvc.exe` | 109.26MB | 14:01 (Tauri externalBin) |

