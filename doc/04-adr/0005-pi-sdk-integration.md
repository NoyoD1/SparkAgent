# ADR-0005: 集成 @earendil-works/pi-coding-agent 0.84.2

- **状态**: Accepted
- **日期**: 2026-08-16 (v0.4 拍板), 2026-08-17 (v0.4.1 反转加 pi-coding-agent)
- **决策者**: user
- **Relates to**: [0006-rpc-mode-migration](0006-rpc-mode-migration.md), [0007-session-management](0007-session-management.md), [0008-tool-permission](0008-tool-permission.md)

## 背景

AI Agent 框架选型: 自写 vs LangChain vs Vercel AI SDK vs Pi SDK (earendil-works/pi)。

v0.3 阶段 sidecar 裸跑 (手写 fetch + SSE 解析), 0 依赖. 问题:
1. tool call 没人执行 (LLM 发 `tool_call`, sidecar 收到 `tool_start` 事件后停在那儿)
2. thinking 字段名要手动兼容 (`reasoning_content` / `reasoning` / `thinking`)
3. Agent 协议自创, 跟 earendil-works/pi 主线脱节
4. session 管理简陋

## 备选

- **A. Pi SDK (pi-ai + pi-agent-core + pi-coding-agent)** — 选这个
- B. LangChain.js — bundle 大, Agent loop 不灵活
- C. Vercel AI SDK — 只有 LLM 客户端, 无 agent loop
- D. 自写 (走老路) — 重复造轮子 (v0.3 已经走过, ADR-0010 旧)

## 决策

**3 个 npm 包 (v0.4.1 反转, user 拍板"直接用 pi-coding-agent 包的")**:

```json
{
  "@earendil-works/pi-ai": "^0.84.2",
  "@earendil-works/pi-agent-core": "^0.84.2",
  "@earendil-works/pi-coding-agent": "^0.84.2"
}
```

**Pi SDK 0.84.2 提供**:
- 25+ 内置 provider + 任意 openai-compatible 自定义 (`createProvider({ baseUrl, api: openaiCompletionsApi })`)
- 7 tool 工厂: `createReadTool` / `createWriteTool` / `createEditTool` / `createBashTool` / `createLsTool` / `createFindTool` / `createGrepTool`
- runRpcMode (40+ RpcCommand + RpcEvent 协议, 详见 [0006](0006-rpc-mode-migration.md))
- SessionManager (per-workspace 隔离 + resume, 详见 [0007](0007-session-management.md))
- ResourceLoader (AGENTS.md + skills + commands 自动 load, 详见 [0010-single-agent-design](0010-single-agent-design.md))
- Extension API (pi.on("tool_call") 拦截, 详见 [0008](0008-tool-permission.md))
- 5x retry (`auto_retry_start` / `auto_retry_end` events) — 配置见代码, ADR 不单独开
- 30s stream hang watch — 内置
- auto-compaction (`shouldCompact` 内部检查)

## 集成踩坑 (踩过, 留底)

**6 字段必填** (custom provider):
1. `provider: 'id'` — line 631 `getAuth` 抛 "Unknown provider: undefined"
2. `baseUrl: '...'` — line 510 `new OpenAI({ baseURL: model.baseUrl })`, 否则 fallback `https://api.openai.com/v1`
3. `input: ['text']` 或 `['text', 'image']` — line 1021 `model.input.includes("image")` 假设 array
4. `auth: { apiKey: { name, resolve } }` — 对象, 不是字符串
5. `cost: { input, output, cacheRead, cacheWrite }` (number) — `pi-ai/src/models.ts:882` `calculateCost()` 读 `model.cost.tiers`, v0.4.1.2 加 ("Cannot read properties of undefined (reading 'tiers')")
6. `contextWindow` + `maxTokens` (数字) — 必须有, 否则 `contextWindow` 默认 0 撑爆

**Event name 拼写** (v0.84+):
- ❌ `tool_call_*` (v0.4 凭印象写错)
- ✅ `tool_execution_*` (实际命名, commit `0bcc856` 修)

**Tool 工厂签名** (不是自写时假设的"self-name"):
```js
import { createBashTool, createEditTool, createFindTool, createGrepTool,
         createLsTool, createReadTool, createWriteTool } from '@earendil-works/pi-coding-agent';
function buildTools(workspacePath) {
  const cwd = workspacePath || process.cwd();
  return [
    createReadTool(cwd), createWriteTool(cwd), createEditTool(cwd),
    createBashTool(cwd), createLsTool(cwd), createFindTool(cwd), createGrepTool(cwd),
  ];
}
```

LLM 调用的工具名是 `read` / `write` / `edit` / `bash` / `ls` / `find` / `grep` (不是 `read_file` / `list_dir`).

## 后果

- ✅ 0 行业务代码 (跟 v0.3 836 行手写对比)
- ✅ 协议标准化, 跟 earendil-works/pi 主线对齐
- ✅ Tool call / 流式 / thinking / session / 5x retry / 30s hang 全 SDK 内置
- ❌ 启动慢 ~150-300ms (ResourceLoader + ExtensionRunner + SettingsManager)
- ❌ Pi SDK API 还在 0.84 早期, 文档不全, 必须 grep `pi-sdk/packages/{ai,agent,coding-agent}/src/` 源码

## 何时 Revisit

- Pi SDK 升级 0.85+ breaking change → 评估
- 0.85+ 暴露更稳定 API → 重新对比 LangChain / Vercel AI SDK
- Pi SDK 0.85+ 大改 runRpcMode → 评估
