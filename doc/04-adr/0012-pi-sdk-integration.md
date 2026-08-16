# ADR-0012: 集成 pi-ai + pi-agent-core 作为 sidecar 主体

- **状态**: Accepted
- **日期**: 2026-08-16
- **决策者**: 用户
- **Supersedes**: [ADR-0010](0010-sidecar-direct-fetch.md)

## 参考文档 (AI 查 SDK 行为必看)

| 包 | 文档 | 必看原因 |
|---|---|---|
| `@earendil-works/pi-ai` | https://github.com/earendil-works/pi/tree/main/packages/ai | Model interface 必填字段 (`provider` / `baseUrl` / `input` / `cost` / `contextWindow` / `maxTokens` / `api`), createProvider 自定义模板, 内置 provider 工厂, agent event 协议 (`tool_execution_*` v0.84+) |
| `@earendil-works/pi-agent-core` | https://github.com/earendil-works/pi/tree/main/packages/agent | `Agent` 类 (initialState / streamFn / beforeToolCall), `AgentTool` interface, `AgentEvent` 类型, `agentLoop` 行为 |
| `@earendil-works/pi-coding-agent` | https://github.com/earendil-works/pi/tree/main/packages/coding-agent | 7 个内置 tool 工厂 (`createReadTool/createWriteTool/...`), `createAgentSession` / `SessionManager` / `compact` API |

**用法规则 (2026-08-17 立)**: 涉及 Pi SDK 任何改动前, **必须先看上述文档** (README + 主要 .ts/.md), 再 grep `pi-sdk/packages/{ai,agent,coding-agent}/src/`. 不要等 user 跑出 bug 再回来抓瞎. 5 字段必填 + cost 必填 + event name (`tool_call_*` vs `tool_execution_*`) 这些坑, 文档里都有, 是 AI 没看就写导致的.

**当前 npm 版本**: `@earendil-works/pi-ai@0.84.2` + `@earendil-works/pi-agent-core@0.84.2` + `@earendil-works/pi-coding-agent@0.84.2` (2026-08-17 装). 文档 main 分支可能跟 npm 同步也可能不, **遇到不一致以 npm 包内 dist/ 实际行为为准**, 但文档是 first stop.

## 背景

v0.3 阶段 sidecar 完全裸跑（手写 fetch + SSE 解析，0 依赖）。问题：

1. **tool call 不能做** — LLM 发 `tool_call`，sidecar 收到 `tool_start` 事件后停在那儿，无人执行
2. **thinking mode 字段名要手动兼容**（`reasoning_content` / `reasoning` / `thinking` 几个名字）
3. **Agent 协议自创** — 跟 earendil-works/pi 主线脱节
4. **session 管理简陋** — v0.3.3 才接 real session
5. **用户明确目标**：要使用 Pi Agent 的能力（tool call / 流式 / thinking 协议 / session）

2026-08-16 audit `D:\AIWorkSpace\WorkBoddyWorkSpace\Agentplantform\Spark\spartagent\node_modules\@earendil-works\pi-ai\` 后确认：

- Pi SDK **完全支持**任意 baseUrl provider（`createProvider({ baseUrl, ... })`）
- Pi SDK **完全支持**运行时动态加 provider（`MutableModels.setProvider()`）
- Pi SDK **有 25+ 内置 provider 工厂**（anthropic/openai/deepseek/groq/moonshotai/google/mistral/github-copilot/...）
- Pi Agent 完整集成了 tool call / 流式 / thinking / session / agent loop

## 备选

### 方案 A：集成 pi-ai + pi-agent-core ✅
- ✅ LLM 客户端完整（25+ 内置 provider + 任意自定义）
- ✅ 通用 agent loop + tool call 协议 + event streaming
- ✅ 跟 earendil-works/pi 主线对齐，协议升级自动跟上
- ❌ 7 个 tool（read/write/edit/bash/ls/find/grep）要自己写（pi-agent-core 不包含）
- ❌ SessionManager / AuthStorage / ProjectTrustStore 要自己写（core 不包含）
- ❌ ExtensionRuntime 不包含（v0.6 Skills 基础要自己搭）

### 方案 B：集成 pi-coding-agent（包 whole）
- ✅ 7 个内置 tool + SessionManager + AuthStorage + ExtensionRuntime 全白送
- ✅ v0.4 立即可跑全部 tool
- ❌ 被 coding-agent 的整套假设绑死（.pi 配置目录 / settings 系统 / project trust）
- ❌ 包大（包含 TUI 客户端的间接依赖）
- ❌ 不能精细控制（用户明确要"用核心包"）

### 方案 C：只集成 pi-ai（不要 agent-core）
- ✅ LLM 客户端 + 流式 + thinking 协议
- ❌ 没有 agent loop — 要自己写 tool call 循环 / context 管理 / abort 逻辑
- ❌ 维护成本高

### 方案 D：保持现状（裸跑）
- ❌ v0.4 tool call 必做做不了
- ❌ 用户明确反对

## 决策

**方案 A：集成 pi-ai + pi-agent-core**（用户明确选择"两个核心包"）。

```json
// sidecar/package.json
{
  "dependencies": {
    "@earendil-works/pi-ai": "file:../pi-sdk/packages/ai",
    "@earendil-works/pi-agent-core": "file:../pi-sdk/packages/agent"
  }
}
```

**集成方式**：
- sidecar `src/index.mjs` 用 `Agent` (pi-agent-core) + `createModels` (pi-ai)
- 7 个内置 provider 工厂调用（`anthropicProvider()` / `openaiProvider()` / `deepseekProvider()` / `groqProvider()` / `moonshotaiProvider()` / `googleProvider()` / `minimaxProvider()`）
- 自定义 provider 用 `createProvider({ id, baseUrl, auth, models, api: openaiCompletionsApi })`
- 现有 JSON Lines IPC 协议（`chat:event`）保留 — **只换 LLM 调用底层实现**，不改 FE
- Tool / session 抽象自己实现（基于 `Agent.subscribe` + `Agent.prompt` + `AgentTool` 接口）

## Provider 映射（v0.3.x 7 内置 → Pi SDK）

| v0.3 provider ID | Pi SDK 工厂 | API |
|---|---|---|
| `anthropic` | `anthropicProvider()` | `anthropic-messages` |
| `openai` | `openaiProvider()` | `openai-responses` |
| `deepseek` | `deepseekProvider()` | `openai-completions` |
| `moonshot` | `moonshotaiProvider()` | `openai-completions` |
| `google` | `googleProvider()` | `google-generative-ai` |
| `groq` | `groqProvider()` | `openai-completions` |
| `openai-platform` (用户自填) | `createProvider({ baseUrl, api: openaiCompletionsApi })` | `openai-completions` |
| **新增**: 商汤 sensenova | `createProvider({ baseUrl: 'https://api.sensenova.cn/v1', api: openaiCompletionsApi })` | `openai-completions` |
| **任意自定义** | 同上 | `openai-completions` |

## 工作量变化

| v0.4 项 | 原计划 | 集成 Pi SDK 后 |
|---|---|---|
| LLM 客户端 | 自写 fetch + SSE | 复用 pi-ai |
| 流式协议 | 自写 event 协议 | 复用 pi-ai AssistantMessageEventStream |
| Thinking 协议 | 自写字段名兼容 | 复用 pi-ai unified thinking |
| 7 个 tool | 全自写 | **仍自写**（pi-agent-core 不含 tool 实现） |
| Session 管理 | 自写 | **仍自写**（core 不含 SessionManager） |
| Auth 存储 | 已有 OS keychain | **复用**（pi-ai 自带 auth 注入点） |
| Tool call 协议 | 自写事件 | **复用** pi-agent-core Agent.subscribe |
| Provider 抽象 | 已有 store | **替换** createProvider-based |

**总工作量**：v0.4 路线图 10 项 → 6 项（节省 40%）。**7 个 tool + session 仍要自己写**（pi-agent-core 故意保持 core 极简，不含业务能力）。

## 后果

- 正面:
  - LLM 调用层零自维护 — 25+ provider 跟 SDK 升级自动跟上
  - 协议标准化 — FE 跟 sidecar 协议可对接 SDK 未来 Skills / Subagent
  - Tool call / 流式 / thinking 一行实现
  - 跟 earendil-works/pi 主线对齐（v1.0 商业化时可深度集成）
- 负面:
  - 7 个 tool 自己写（read/write/edit/bash/ls/find/grep）— 预计 800-1200 行 TS
  - Session 持久化自己写 — 预计 300-500 行
  - pi-sdk 必须 build 出 dist（需要 npm install + npm run build 在 pi-sdk 仓库）
  - pi-ai 的 anthropic/openai 协议细节要学习（不是 LLM API 直觉）
- 中性:
  - sidecar 0 依赖 → 3 依赖（pi-ai + pi-agent-core + 各自 transitive）
  - pi-sdk clone 到 `pi-sdk/` 不进 git（.gitignore 已加）
  - v0.3 mock 工具调用 UI 全部保留 — 协议层不动

## 何时 Revisit

- pi-coding-agent 升级到提供"可插拔 core"（把 tool / session 拆出来）
- 用户要更多内置 tool（web search / browser use / image gen）
- pi-ai 主线 breaking change 频繁（依赖锁版本）
- Pi SDK 出 v1.x 商业版要付费
- 性能 / 启动速度问题（pi-ai 包大，启动慢）

## v0.4 集成踩坑 (2026-08-16)

`createProvider` 工厂**不**自动给 model 注入以下必填字段，调用方**必须手动加**：

1. **`provider: 'id'`** — line 631 `getAuth` 抛 "Unknown provider: undefined"
2. **`baseUrl: '...'`** — line 510 `new OpenAI({ baseURL: model.baseUrl })`，否则 OpenAI SDK fallback 到 `https://api.openai.com/v1`
3. **`input: ['text']` 或 `['text', 'image']`** — line 1021 `model.input.includes("image")` 假设 array，否则 `undefined.includes(...)` 抛错
4. **`auth: { apiKey: { name, resolve } }`** — auth.apiKey 是对象（ApiKeyAuth）不是字符串
5. **anthropic 工厂要 env var 或 keychain credential**，user-custom 工厂能注入 apiKey

**user-custom provider 工厂** template（v0.4.2 完整版）：

```javascript
createProvider({
  id: 'user-custom',
  baseUrl: '...',
  auth: {
    apiKey: {
      name: '...',
      resolve: async () => ({ auth: { apiKey: config.apiKey } }),
    },
  },
  models: [{
    id: '...',
    provider: 'user-custom',       // <-- 必填
    api: 'openai-completions',
    baseUrl: '...',               // <-- 必填 (line 510)
    input: ['text'],              // <-- 必填 (line 1021)
    contextWindow: 128000,
    maxTokens: 8192,
  }],
  api: { stream, streamSimple },  // from @earendil-works/pi-ai/api/openai-completions
});
```
