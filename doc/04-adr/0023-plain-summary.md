# ADR-0023 白话文: 外部 tool + 静默重启

## 一句话总结
让 user 在文件夹里 drop 任意语言的脚本, 重启 sidecar 后 LLM 就能用; 配置改了之后 FE 一键静默重启, UI 几乎无感。

## 解决了两个老问题

### 问题 1: 加新 tool 必须改主项目代码
之前想加个 `web_search` tool, 必须在 `sidecar/src/index.mjs` 里写, 重 build sidecar (100MB), 用户完全没法自己加。

**现在**: user 在 `<workspace>/.pi/tools/external/<name>/` 放一个文件夹, 里面 `manifest.json` + `<entry>.py` (或 .mjs), 重启 sidecar 就能用。

### 问题 2: 改配置必须重启, 不知道何时生效
之前改了 MCP server / dangerousWhitelist / bash.path, 不知道啥时候生效, 经常得整个 Tauri 退出来再开。

**现在**: 改了 "需要重启" 的配置, FE 自动触发静默重启, 1-2 秒 toast 提示, 中间用户继续看历史 / 切 session, 几乎无感。

## 怎么工作 (3 步)

### Step 1: User drop tool 文件夹
```
<workspace>/.pi/tools/external/tavily_search/
├── manifest.json     # 名字/参数/超时声明
└── tavily_search.py  # 实际逻辑 (Python 纯 stdlib)
```

`manifest.json` 长这样:
```json
{
  "name": "tavily_search",
  "description": "Web search via Tavily API",
  "parameters": {
    "type": "object",
    "properties": {"query": {"type": "string"}},
    "required": ["query"]
  },
  "runtime": "python",
  "entry": "tavily_search.py",
  "timeout": 30000
}
```

### Step 2: Sidecar 启动时扫描 + 包装
- 扫 `<agentDir>/tools/external/*` + `<workspace>/.pi/tools/external/*`
- 每个 manifest → 启一个 subprocess (`python3 tavily_search.py`)
- subprocess 跟 sidecar 走 stdio JSON-RPC (跟 MCP 同款协议)
- 包成 Pi SDK `ToolDefinition`, merge 进 LLM 可见的 tool 列表

### Step 3: LLM 调用
- LLM 调 `tavily_search(query="xxx")` 
- sidecar 收到 → 转发 JSON-RPC 到 subprocess
- subprocess 调 Tavily API → 返结果
- sidecar 把结果包成 Pi SDK ToolResult → 返给 LLM

## 静默重启 (为啥能无感)

**架构实情**: sidecar 是 per-agent-run 模式 (每次发消息起一个, agent_end 后死)。所以 "重启" 实际是:
- 当前有 active sidecar → kill 它, 补发一个 `agent_end` (reason=restart) 让 FE 收尾
- 当前没 active sidecar → 啥都不做
- 下次 send_prompt → 自然起新 sidecar, 读新配置

FE 视角:
- user 改 MCP server → 保存 → 弹 "正在重启服务…" toast
- Tauri: kill 旧 sidecar → 补 agent_end 事件
- FE: 弹 "服务已就绪" toast (事件 reason 知道是 restart 不是正常结束)
- 整个过程 1-2 秒, 不 disable UI, 不弹 modal

## 拍板的 7 件事

1. **Subprocess 隔离** — 跟 MCP 同款, 任意语言, 一个崩了不影响 sidecar
2. **JSON-RPC 协议** — `{type:"ready"}` / `{type:"call", args}` / `{type:"result", content}`, 简单清晰
3. **Manifest 驱动** — 名字/参数/超时全在 manifest, 不用改 sidecar 代码
4. **Restart 触发边界** — MCP server / external tool / dangerousWhitelist / bash.path 改动才触发, skill/provider/model 不触发
5. **Kill 不 respawn** — 走 next-prompt lazy spawn, 简单
6. **FE 静默 toast** — 1-2 秒, 不阻塞 UI, 不弹 modal
7. **超时保护** — subprocess 启动 5s ready 超时, tool call 默认 30s 超时, 自动 kill

## 第一步: Tavily 搜索

`sidecar/tools/tavily_search/`:
- `manifest.json` — 声明 search tool
- `tavily_search.py` — 用 urllib 调 Tavily API, 无依赖
- API key 走 `TAVILY_API_KEY` env var, settings.json 配置

## 总投入: ~2-2.5 天
- 阶段 1 (静默重启): 0.5 天
- 阶段 2 (external tools 框架): 1-1.5 天
- 阶段 3 (Tavily): 0.5 天
- 阶段 4 (验证 + commit): 0.5 天

## 不做的 (YAGNI)
- 热重载 tool 列表 (Pi SDK 不支持, 必须重启)
- 自动检测文件变化 (chokidar) — 需要时再加
- Subprocess 沙箱 (CPU/mem 限制) — 跟现有 bash sandbox 一起做
- Tool marketplace / 在线下载 — YAGNI
