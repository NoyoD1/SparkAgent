# ADR-0023: External Tools + 静默重启机制

**Status**: Accepted (2026-08-23)
**Author**: Pi Agent team
**ADR**: 0023

## 背景

之前两个痛点一直困扰我们:

1. **Tool 列表写死在 sidecar 代码里** — 加新 tool 必须改主项目代码, build, 重启。User 想 drop-in 一个 .py 脚本就能用, 走不通。
2. **配置改动必须重启 sidecar 才生效** — Pi SDK 0.84.2 的 tool 注册只在 `createAgentSession` 时一次, 后续 MCP server / user tool / dangerousWhitelist / bash.path 改了都不生效, 必须 kill sidecar → 下次 prompt 起新进程才生效。

## 现状摘要

### 已有 (作为基础)
- **sidecar 启动流程** (`src-tauri/src/sidecar.rs::run_prompt`): 每次 LLM run 启一个 sidecar subprocess, 传 `config_arg` (JSON) 到 argv[1], 写 `initial_command_json` 到 stdin。子进程直到 `agent_end` 才死。
- **tool 加载链** (`sidecar/src/index.mjs::loadUserTools`): 扫 `<workspace>/.pi/tools/*.json` + `<agentDir>/tools/*.json`, 包装成 Pi SDK `ToolDefinition`。
- **MCP 路径** (`sidecar/src/index.mjs::initMcpSubsystem`): spawn 多个 MCP subprocess, wrap 成 `ToolDefinition`。
- **浏览器 3 tool** (`sidecar/src/index.mjs::loadBrowserTools`): 静态注册。
- **Tauri `kill_sidecar`** (`src-tauri/src/sidecar.rs:497`): 杀指定 session 的 child。

### 缺什么

1. **没有 "外部 tool" 概念** — `loadUserTools` 只支持 JSON preset 包装 builtin 7 tool (`read/write/edit/bash/ls/find/grep`), 没法加新 tool (e.g. web_search, pdf_summarize, db_query)。
2. **没有 restart 命令** — `kill_sidecar` 杀指定 session, 但杀完没自动起新。下次 prompt 才起新 (因为是 per-agent-run 模式, 实际工作)。FE 视角: "改了配置, 啥时候生效?" 不清晰。
3. **没有 "需要重启" 的明确边界** — user 不知道哪些 save 触发重启, 哪些 hot-reload 即可。

## 目标

1. **External tools**: user 在 `<workspace>/.pi/tools/external/<name>/` drop 一个 `manifest.json` + 任意语言脚本, 重启 sidecar 后 LLM 就能看到 + 调用, 不用改主项目代码。
2. **静默 restart 机制**: 改了"需要重启"的配置后, FE 一键触发 → Tauri kill active sidecars → 下次 prompt 起新 (带新 config) → UI 弹个 1-2 秒 toast, 几乎无感。
3. **可观测**: FE 知道当前 sidecar 状态, 知道 "下次 prompt 起新的" 的语义, 不疑惑。

## 备选 / 关键决策

### 决策点 Q1: External tool 怎么跟 Pi SDK 集成

- **A. 在 sidecar 同进程 import 脚本** (e.g. dynamic import .mjs): 简单, 但只支持 JS, 进程隔离差, 一个 tool 崩了拖死 sidecar
- **B. Subprocess + stdio JSON-RPC** (e.g. spawn `python3 tool.py`): 任意语言, 进程隔离, MCP 同款协议, 选这个
- **C. 走 MCP 协议**: user 自己写 MCP server 配进 `.pi/mcp/`, 复用现有 P2-1.8 路径 — 但 user 想 drop-in 简单脚本, 不一定想学 MCP

**选 B**: subprocess + JSON-RPC, manifest-driven, 任意语言, 隔离好。

### 决策点 Q2: External tool 文件位置

- **A. `<workspace>/.pi/tools/external/<name>/`** (workspace 范围)
- **B. `<agentDir>/tools/external/<name>/`** (global 范围)
- **C. 都支持, workspace 覆盖 global** (跟现有 `loadUserTools` 一致)

**选 C**: 跟 user tool / skills / commands / MCP server 同 pattern, workspace 优先覆盖 global。

### 决策点 Q3: Manifest schema

```json
{
  "name": "tavily_search",
  "description": "Web search via Tavily API. Returns ranked results with snippets.",
  "parameters": {
    "type": "object",
    "properties": {
      "query": {"type": "string", "description": "搜索关键词"},
      "max_results": {"type": "integer", "default": 5, "minimum": 1, "maximum": 20}
    },
    "required": ["query"]
  },
  "runtime": "python",
  "entry": "tavily_search.py",
  "timeout": 30000
}
```

跟 Pi SDK 0.84.2 ToolDefinition 完全兼容 (name / description / parameters JSON schema + execute() 闭包)。

### 决策点 Q4: JSON-RPC 协议 (subprocess ↔ sidecar)

**subprocess → sidecar** (初始化 + 结果):
- `{ "type": "ready" }` — 启动完成, 准备接收 tool_call
- `{ "id": "...", "type": "result", "content": <Pi SDK ToolResult> }` — tool call 成功
- `{ "id": "...", "type": "error", "error": "..." }` — tool call 失败

**sidecar → subprocess** (tool call):
- `{ "id": "uuid", "type": "call", "args": { ... } }` — 调用 tool

**Pi SDK ToolResult schema** (subprocess 返回的 `content` 字段):
- text: `{ "type": "text", "text": "..." }`
- image: `{ "type": "image", "data": "<base64>", "mimeType": "image/png" }` (Tavily 不会返, 但留接口)

**Timeout**: sidecar 端默认 30s (manifest 可改), 超时 → 自动 kill subprocess + 返 error 给 LLM。

### 决策点 Q5: Runtime 怎么启

- **python**: `python3 <entry>` (Windows 上 `python` / `py` / `python3` 都试, 找第一个能用的)
- **node**: `node <entry>`
- **bun**: `bun <entry>` (跟 sidecar 同 runtime, 性能最好)

Manifest 里 `runtime` 字段指明, sidecar 找对应解释器。失败 → 这个 tool 跳过, log warn。

### 决策点 Q6: 静默 restart 触发边界

**触发 restart** (config 改了, 必须新 sidecar 才生效):
- ✅ 加/删/改 MCP server (改 tool 列表)
- ✅ 加/删/改 external tool 文件 (改 tool 列表)
- ✅ 改 dangerousWhitelist (Extension 工厂 state)
- ✅ 改 bash.path (mirror 到 settings.shellPath)
- ✅ 改 system prompt override (D165 systemPrompt 不可动态改)
- ✅ 改 user tool preset (loadUserTools 启动时读)

**不触发** (已热重载或无需重启):
- ❌ Skill enable/disable (已热重载)
- ❌ Provider/model 切换 (下次 send_rpc_command 即生效)
- ❌ Permission mode 切换 (已热重载)
- ❌ UI 配置 (字体/主题等)

### 决策点 Q7: Restart 真的需要 kill 吗

**架构实情**: sidecar 是 per-agent-run 模式 (run_prompt 每次起, agent_end 后死), 不是常驻。所以 "重启" 实际是:
- 当前 LLM run 在跑 → kill 当前 child, 补发 `agent_end` (error) 让 FE 收尾 → 下次 send_prompt 起新 child
- 当前 LLM run 已结束 → 无 child, 啥都不做 → 下次 send_prompt 自然起新 child

**结论**: 不需要主动 respawn, 只需 kill。next-prompt lazy spawn 走通就是 "重启完成"。

### 决策点 Q8: FE 怎么无感

- 静默 (1-2s) "正在重启服务…" toast, 期间不 disable UI (用户可能正看历史)
- 不阻塞 send_prompt (kill 异步, send_prompt 走下次 spawn)
- 用户当前 LLM response 如果被杀, 弹 error 提示 (1 次), 然后 user 重发

不引入 modal / loading spinner — 跟现有 "tool call running" 风格一致, 都是非阻塞 toast。

## 端到端核验

### 启动流程 (首次)

1. Tauri 启动, sidecar 还没起
2. FE 创建 session → send_prompt → Tauri `run_prompt` → spawn sidecar (argv[1]=config, stdin=initial cmd)
3. sidecar 读 config → 扫 `<agentDir>/tools/external/*/manifest.json` + `<workspace>/.pi/tools/external/*/manifest.json`
4. 对每个 manifest: 验证 schema → 启 subprocess (python3 / node / bun) → 等 `{type:"ready"}` → 包成 Pi SDK `ToolDefinition`
5. `createAgentSession` 把所有 customTools (user + MCP + external + browser) merge 进 tool list
6. LLM 看到 tool, 调 `tavily_search(query=...)` → sidecar execute() 转发 JSON-RPC → subprocess 调 Tavily API → 返结果

### 改动配置后的重启

1. User 在 Settings 加 MCP server "fetch" → 保存
2. store 检测: "需要 restart" (MCP server 改动) → 弹 toast "正在重启服务…"
3. store 调 `restart_sidecar(reason='mcp_changed')` Tauri command
4. Tauri: 列所有 active sidecar session_id → 逐个 kill + 补发 `agent_end` (error reason=restart)
5. Tauri: return (不等新 spawn, 那是 lazy)
6. FE: 收到 `agent_end` 事件 → 弹 toast "服务已就绪" (因为事件 reason=restart, FE 知道是 restart 不是正常结束)
7. User 下次 send_prompt → Tauri spawn 新 sidecar → 加载新 MCP config → LLM 看到新 tool

### 验证清单

- [ ] Drop 一个 `tavily_search/` 文件夹到 `<workspace>/.pi/tools/external/`, 重启, LLM 看到 `tavily_search` tool
- [ ] LLM 调 `tavily_search(query="xxx")`, 拿回搜索结果 (含 snippets + URLs)
- [ ] 改 `dangerousWhitelist` 加一条, 重启, LLM 能跑新加的危险命令
- [ ] 加一个新 MCP server, 重启, LLM 看到新 tool
- [ ] 静默重启期间, user 切到另一个 session 还能正常用 (只重启指定 session 的 sidecar)
- [ ] Restart 失败 (e.g. 启动新 sidecar 失败) → FE 看到 error toast, 不卡死

## 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| Python 环境找不到 (`python3` 不在 PATH) | External tool 跑不起来 | sidecar 启动时检测, 没 python 时 log warn + 跳过所有 python runtime 的 tool, FE 弹 "需要安装 Python 3.x" toast |
| Subprocess 启动后不响应 (写 hung) | Tool call 超时 | sidecar 端 timeout 强制 kill subprocess, 返 error 给 LLM |
| Subprocess 启动后立即 crash (manifest 错 / import 错) | 该 tool 不可用 | spawn 时加 5s "ready" 等待, 超时跳过 + log error, 不影响其他 tool |
| User 写 tool 调危险 API (e.g. 删文件) | 跟 bash 同级风险 | 复用现有 permission system: tool 调时弹确认弹窗 (走 extension_ui_request) |
| 多个 external tool 命名冲突 | tool 列表重复, Pi SDK 报错 | dedupe by name, 跟现有 user tool 同名时 workspace 覆盖 global |
| Manifest schema 错误 | tool 加载失败 | FE 端 lint manifest (开发期), 启动时严格校验, 错的 log + 跳过 |

## 实施计划

### 阶段 1: 静默重启机制 (0.5 天)

1. Tauri `restart_sidecar(reason: String)` command
   - 列 `ActiveSidecars` map
   - 对每个: kill + 补发 `agent_end` 事件 (带 reason='restart')
   - return 当前 killed count
2. FE `restartSidecar` wrapper
3. FE store helper: `requiresRestart(configType)` 决定是否触发
4. 在 MCP server / user tool / dangerousWhitelist save 后调用
5. UI: 1-2s toast (用现有 uiStore 弹 toast 机制)

### 阶段 2: External tools 框架 (1-1.5 天)

1. Sidecar `loadExternalTools(workspacePath, agentDir)` 函数
   - 扫 2 个目录, 读 manifest.json, 校验 schema
   - 启 subprocess, 等 ready, 包成 ToolDefinition
2. Subprocess 模板 (Python): `external_tool_template.py` 给 user 参考
3. 错误处理: subprocess 启动失败 / 5s ready 超时 / tool call 超时
4. Pi SDK ToolDefinition 包装, merge 到 `allCustomTools`

### 阶段 3: Tavily 第一个 concrete tool (0.5 天)

1. `sidecar/tools/tavily_search/manifest.json` + `tavily_search.py`
2. Python 纯 stdlib (urllib), 无依赖
3. API key 走 env var (`TAVILY_API_KEY`), 在 settings.json 配置
4. 端到端测试: LLM 调 `tavily_search`, 拿回结果

### 阶段 4: 验证 + commit

1. typecheck + cargo check + vite build + cargo tauri build --debug
2. 跑 exe, 端到端走 1-2 个 tool call
3. commit (建议拆 2 个: 阶段 1+2 一个, 阶段 3 一个, 跟现有 commit 粒度一致)

## 关键文件

- `src-tauri/src/sidecar.rs` — 加 `restart_sidecar` command
- `src-tauri/src/lib.rs` — 注册 `restart_sidecar` invoke handler
- `sidecar/src/index.mjs` — 加 `loadExternalTools` + `allCustomTools` 集成
- `sidecar/tools/tavily_search/` — 第一个 external tool (manifest + py)
- `app/src/lib/tauri.ts` — 加 `restartSidecar` wrapper
- `app/src/stores/mcpServers.ts` — save 后调 `restartSidecar` (if scope=workspace 且改了 tool list)
- `app/src/stores/userTools.ts` — 同上
- `app/src/components/Settings/GeneralTab.vue` — 改 dangerousWhitelist 后调
- `app/src/stores/ui.ts` — 加 `toast` 机制 (如果还没)

## 不在范围

- Hot-reload tool 列表 (不改 sidecar 进程, 改 tool 列表) — Pi SDK 不支持, 需重启
- 自动检测 external tool 文件变化 (chokidar) — 需要时再加
- 沙箱限制 external tool subprocess (e.g. CPU/mem) — 跟现有 bash sandbox 一起做
- Tool marketplace / 在线下载 — YAGNI, user 自己 drop 文件夹
