# 02 · 路线图 (Roadmap)

> v0.4 → v1.0 阶段划分 + 每 phase 必做项 + 验收标准。
> 状态：🟢 当前阶段 / ⚪ 未来阶段 / ✅ 已完成

---

## 阶段总览

| Phase | 主题 | 关键交付 | 状态 | 预计开始 |
|---|---|---|---|---|
| v0.1 - v0.2 | 骨架 | Web form + 多 provider BYOK + 流式 | ✅ | 2026-07 |
| v0.3 | Tauri 化 | 桌面 app + OS keychain + Node sidecar | ✅ | 2026-08 上 |
| v0.3.5 - v0.3.8.27 | UX Polish | 布局 / 主题 / 折叠 / 字体 / 设计系统 | ✅ | 2026-08 中 |
| **v0.4** | **Tool Call 真正落地** | 文件读/写 / shell / 权限确认 / abort | 🟡 (4/6) | **2026-08 中** |
| **v0.4.2 step 1** | **上下文管理 (createAgentSession + SessionManager per-workspace 隔离)** | 短期记忆 / 跨 workspace 隔离 | 🟢 (4/4 smoke PASS) | **2026-08-17** |
| **v0.5.0 ~ v0.5.8** | **RPC 模式重构 + Release** | sidecar 重写 + Pi SDK RPC + Tauri 2 标准 sidecar + 端到端验证 | 🟢 (14 commits + 验证 PASS) | **2026-08-17** |
| **v0.4.3 系列** | **P0 Pi SDK 暴露 (table stakes)** | compaction / skills / slash cmds / rules / usage | ⚪ (规划) | **2026-09 目标** |
| v0.5.0+ | P1 自建 | Plan mode / sub-agents / MCP 集成 | ⚪ | TBD |
| v0.6 | Web app + Agent SDK | claude.ai/code 对标 / 编程 API | ⚪ | TBD |
| v0.7 | 体验增强 | Auto mode / Voice / Hooks / Notepads | ⚪ | TBD |
| v0.8 | 协作 + 平台扩展 | Team rules / Cloud sync / VSCode 插件 | ⚪ | TBD |
| v0.9 | 跨平台 | macOS / Linux / Mobile POC | ⚪ | TBD |
| **Pre-release** | **打包 (release 前置)** | **sidecar 编译成独立 .exe + 单 binary 分发** | 🟢 (v0.5.6 done) | **v1.0 前必做** |
| **v1.0** | **稳定版** | 自动更新 + 完整文档 + 用户指南 | ⚪ | TBD |

> **roadmap 重大更新 (2026-08-17 23:26, user 拍板)**: 跟 Claude Code v2.1.x / Trae v2.0+ / Cursor 3.x 2026 Q2 主流产品对标后, 决定走 **"Pi SDK 暴露优先 + 自建补缺"** 路线, 详细 43 项功能对比见 [05-competitive-analysis-2026.md](05-competitive-analysis-2026.md). 短期 (0-6 月) P0 + P1 重点补 table stakes, 长期评估是否换底座.
>
> **ADR 拍板状态 (2026-08-17 23:26)**:
> - [ADR-0021](04-adr/0021-pi-agent-2026-strategy.md) ✅ **accepted** (A 方案: 跟 Pi SDK 走)
> - [ADR-0022](04-adr/0022-sub-agent-architecture.md) ⚪ **proposed** (待 user 拍板 A/B/C)
> - [ADR-0023](04-adr/0023-mcp-integration.md) ✅ **accepted** (3 阶段全做)

---

## 🟡 v0.4 · Tool Call 真正落地（**当前 · 4/6**）

**为什么这个最重要**：没 tool call，Pi Agent 就是个 chat 客户端；有了 tool call，才是 agent 客户端。

**v0.4 计划变更（2026-08-16）**：原计划 10 项集成 Pi SDK 后降到 6 项。详见 [ADR-0012](04-adr/0012-pi-sdk-integration.md) — LLM 客户端层 + 协议层复用 pi-ai + pi-agent-core。

**v0.4.1 反转（2026-08-17, D102）**：7 tool + session 改为直接使用 `pi-coding-agent` 包（"直接使用 pi-coding-agent 包的"），不再自写。依赖最终是 3 个包：pi-ai + pi-agent-core + pi-coding-agent。

**v0.4.1 完成项**（item 1 + 2 + 5 部分 + step 累加 UI）:
- ✅ item 1 Pi SDK 集成（v0.4.0）
- ✅ item 2 7 tool 集成（v0.4.1，**用 pi-coding-agent 工厂** createReadTool/createWriteTool/createEditTool/createBashTool/createLsTool/createFindTool/createGrepTool）
- ✅ Step 累加 UI（v0.4.1 — Cursor 风格，1 turn = 1 step group）
- ✅ Tool result 持久化框架（v0.4.1 message.steps, v0.4.2 用 pi-coding-agent SessionManager 落盘）

**v0.4 还差**（推到 v0.4.1+ 或 v0.4.2）:
- ❌ item 3 Tool permission system（v0.4 必做未做）
- ❌ item 4 Abort / Stop button（v0.4 必做未做）
- ❌ item 5 Session 持久化 v0.4.2 集成
- ❌ item 6 Workspace 路径校验 + 危险命令黑名单（v0.4 必做未做）

**v0.4.2 step 1 完成项 (2026-08-17)**:
- ✅ `createAgentSession` 切 `new Agent` (commit 落地中, smoke test 4/4 PASS — 新建/resume/compaction/跨 workspace 隔离)
- ✅ Tool permission 改走 Extension `pi.on("tool_call", handler)` (走 `DefaultResourceLoader` 注入, Pi SDK 内部桥接)
- ✅ LLM retry 改用 AgentSession 内置 `auto_retry_*` 事件, 删 sidecar 自写状态机 (commit `88d05ea` 的 200 行代码移除)
- ✅ 4 个新 IPC 事件: `compaction_start` / `compaction_end` / `auto_retry_start` / `auto_retry_end` (替代 v0.4.2 partial 的 `retry_*`)
- ✅ 1 个新 IPC 入口: `compact_session` (手动触发压缩)
- ✅ per-workspace session 目录隔离 (sha256(workspace) 前 16 位 → `<agentDir>/sessions/<hash>/`)
- ✅ per-workspace stable sessionId 持久化 (FE configStore.perWorkspaceSessionId 走 Rust config_store)
- ✅ 4 个 ADR 加 `## 后续 Review` 段说明实施细节变更 (0012/0013/0014/0015), README 加 "后续 Review" 列

### 必做项（v0.4 6 项）

| # | 项 | spec | 状态 | 验收 |
|---|---|---|---|---|
| 1 | **Pi SDK 集成**（sidecar 用 pi-ai + pi-agent-core）| [ADR-0012](04-adr/0012-pi-sdk-integration.md) | ✅ v0.4.0 | 现有 JSON Lines 协议不变，LLM 调用底层切 Pi SDK；7 内置 + 自定义 provider 全通 |
| 2 | **7 个 tool 集成**（v0.4.1 反转用 `pi-coding-agent`，不是自写）| [tools.md](03-features/tools.md) | ✅ v0.4.1 | LLM 能读 / 写 workspace 内文件 + 跑命令 + 浏览；走 pi-coding-agent 工厂 (D102) |
| 3 | **Tool permission system**（v0.4 最关键）| [tools.md](03-features/tools.md) + [security.md](03-features/security.md) | ❌ 未做 | 每个 tool call 用户显式 confirm（至少第一次），白名单 / 黑名单 |
| 4 | **Abort / Stop button** | [chat-core.md](03-features/chat-core.md) | ❌ 未做 | 用户能中断生成 + tool call（kill sidecar 子进程）|
| 5 | **Session 持久化**（v0.4.2 用 `pi-coding-agent` SessionManager + createAgentSession）| [session.md](03-features/session.md) | ✅ v0.4.2 step 1 | per-workspace 隔离的短期记忆: 切 workspace 走不同 session 目录, 切回走同一 session file, 持久化到 `~/.pi/agent/sessions/<hash>/<timestamp>_<sessionId>.jsonl` |
| 6 | **Workspace 路径校验 + 危险命令黑名单** | [security.md](03-features/security.md) | ❌ 未做 | tool 拒绝 path traversal (`../` etc)；`rm -rf /` `mkfs` 等拦截 |

### Pi SDK 集成细节（item 1 + 2 — v0.4.1 最终版）

```js
// sidecar/src/index.mjs (v0.4.1)
import { Agent } from '@earendil-works/pi-agent-core';
import { createModels, createProvider,
         anthropicProvider, openaiProvider, deepseekProvider,
         moonshotaiProvider, groqProvider, googleProvider,
         minimaxProvider } from '@earendil-works/pi-ai';
import { stream, streamSimple } from '@earendil-works/pi-ai/api/openai-completions';
import { createBashTool, createEditTool, createFindTool, createGrepTool,
         createLsTool, createReadTool, createWriteTool } from '@earendil-works/pi-coding-agent';

// 7 provider 工厂
const models = createModels();
models.setProvider(anthropicProvider());
// ... 其他内置
models.setProvider(createProvider({
  id: 'user-custom',
  baseUrl: userBaseUrl,
  auth: { apiKey: { name: '...', resolve: async () => ({ auth: { apiKey: config.apiKey } }) } },
  models: [{
    id: userModelId,
    provider: 'user-custom',   // 必填 1
    api: 'openai-completions',
    baseUrl: userBaseUrl,      // 必填 2
    input: ['text'],           // 必填 3
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },  // 必填 5 (v0.4.1.2)
    contextWindow: 128000, maxTokens: 8192,
  }],
  api: { stream, streamSimple },
}));

// 7 tool 工厂 (v0.4.1, 用 pi-coding-agent 不是自写)
function buildTools(workspacePath) {
  const cwd = workspacePath || process.cwd();
  return [
    createReadTool(cwd), createWriteTool(cwd), createEditTool(cwd),
    createBashTool(cwd), createLsTool(cwd), createFindTool(cwd), createGrepTool(cwd),
  ];
}

// Agent 实例
const agent = new Agent({
  initialState: { systemPrompt, model: models.getModel(providerId, modelId),
                  tools: buildTools(workspacePath) },
  streamFn: models.streamSimple.bind(models),
});

agent.subscribe(event => sendToFE(event));   // ⬅ 现有 JSON Lines 协议 (turn_start/turn_end + tool_execution_* 透传)
await agent.prompt(userContent);
```

**v0.4.1 踩坑**（已修）:
- `cost` 必填（`pi-ai/src/models.ts:882` calculateCost 假设 `model.cost` 已定义）— 加 `cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }`
- `tool_call_*` 事件名错（v0.4 凭印象写）— 改对 `tool_execution_*`，映射到 JSON Lines `tool_*`
- 7 tool 工具名按 pi-coding-agent 实际 emit（`read`/`write`/`edit`/`bash`/`ls`/`find`/`grep`），不是 self-name 假设

### 不做（推到后续 phase）

- ❌ Subagent（在 tool call 稳定后单独做）
- ❌ Memory（在 tool call 上验证后做）
- ❌ Plan Mode（需要 subagent + 稳定 tool）

### 验收标准（v0.4 完成定义）

- [x] 启动 app → 配置 BYOK → 选 workspace → 发"读 README.md 给我总结"（v0.4.1 fauxProvider 烟测 PASS）
- [x] LLM 调用 `read` 工具 → 显示 tool call UI（折叠 / 展开）→ 输出总结（v0.4.1 7 tool 集成完成）
- [x] 发"在 src/foo.ts 加一个 hello 函数" → LLM 调用 `edit` → 实际写入文件 → diff 显示（v0.4.1 7 tool 集成完成）
- [ ] 发"跑 npm test" → LLM 调用 `bash` → 输出在 UI → 用户中途点 Stop → 真的中断（item 4 未做）
- [ ] session 重启后历史完整恢复（messages + tool calls + tool results）（item 5 v0.4.2 待做）
- [x] 商汤 / 任意 OpenAI-compatible provider 配 key 后能跑（v0.4.0 真 key 端到端跑通 deepseek-v4-flash）

---

## ✅ v0.5.0 → v0.5.6 · RPC 模式重构 + Release (2026-08-17)

11 个 commit 落地 (484de1b / 7ef5b8b / b251e92 / 78b9821 / 4879808 / 40d9b99 / 6b30141 / 16aebb8 / 7247efe / 4d849f1 / 115959e), 详见 [ADR-0017](04-adr/0017-v0.5-rpc-mode-migration.md).

### 必做项 (v0.5 11 项)

| # | 项 | spec | 状态 | 验收 |
|---|---|---|---|---|
| 1 | sidecar 全量重写 836→200 行, 走 Pi SDK `runRpcMode` | [ADR-0017](04-adr/0017-v0.5-rpc-mode-migration.md) | ✅ 7ef5b8b | 删手写 40+ case event map / 5x retry / 30s hang / permission Ext / backpressure, 全部走 Pi SDK |
| 2 | Tauri command 重写 (透传 RpcCommand) | [ADR-0017](04-adr/0017-v0.5-rpc-mode-migration.md) | ✅ b251e92 | `send_prompt` + `send_rpc_command` 通用 invoke, 顶层标量参数 camelCase |
| 3 | FE chat store 重写 (pull+push, 200 行) | [ADR-0017](04-adr/0017-v0.5-rpc-mode-migration.md) | ✅ b251e92 | 700+ 行手写 event handler → 200 行 pull+push |
| 4 | PermissionDialog 改 inline 浮层 (贴 Composer 顶) | [chat-core.md](03-features/chat-core.md) | ✅ 40d9b99 | 不挡 workspace, 高度自适应, unscoped CSS |
| 5 | v0.5.2 polish (6 个真新功能 + 4 个 v0.5.1 没修好的 bug) | [chat-core.md](03-features/chat-core.md) | ✅ 16aebb8 | image tab / streaming 改 MutationObserver / 光标偏移修 |
| 6 | v0.5.3 polish (跑马灯方向 + 原生 tooltip 清理) | [chat-core.md](03-features/chat-core.md) | ✅ c0c3909 | 跑马灯 D159 二次修正数学; 删 button title 改 aria-label |
| 7 | **v0.5.4 sync 链 hotfix** (单 session 上下文丢失) | [ADR-D165](../topics/...md) | ✅ 7247efe | 每次 spawn 手动 sync `state.messages = buildSessionContext().messages` + lazy create stable sessionId |
| 8 | **v0.5.5 model behavior hotfix** (DeepSeek meta-history 幻觉) | [ADR-...TBD](04-adr/) | ✅ 4d849f1 | `appendSystemPromptOverride` 加 `<context_awareness>` 段, LLM 明确知道有 history |
| 9 | **v0.5.6 bun compile** (D163 跨项目规则) | [D163](../topics/...md) | ✅ 115959e | `bun build --compile` 出 `sidecar/dist/pi-agent-sidecar.exe` (108 MB), Tauri 跑 .exe 不依赖 system Node |
| 10 | ADR-0017 status `proposed → accepted` | [ADR-0017](04-adr/0017-v0.5-rpc-mode-migration.md) | ✅ 8758554 | 13 个 commit 实际落地, status 改 accepted + 11+2 commit 列表 |
| 11 | Architecture doc 同步 RPC 模式 | [01-architecture.md](01-architecture.md) | ✅ 8758554 | 流程图 + step 描述 + 目录结构 全部更新 v0.5.0+ 状态 |

### Release 产物 (v0.5.6 2026-08-17 22:24, v0.5.8 2026-08-17 22:46)

```
v0.5.6 (115959e, 写死编译时绝对路径 ⚠️ 干净机器 fail):
src-tauri\target\release\pi-agent-desktop.exe         12.77 MB
src-tauri\target\release\bundle\msi\Pi Agent_0.1.0_x64_en-US.msi   5.17 MB
src-tauri\target\release\bundle\nsis\Pi Agent_0.1.0_x64-setup.exe  3.94 MB
sidecar\dist\pi-agent-sidecar.exe                   108 MB  (bun compiled, self-contained)

v0.5.8 (33fc5fa, Tauri 2 标准 sidecar 机制, 干净机器真能跑):
src-tauri\target\release\pi-agent-desktop.exe         14.35 MB  (+ tauri-plugin-shell)
src-tauri\target\release\pi-agent-sidecar.exe        103.48 MB  (Tauri 命名约定 + sidecar.exe 配套)
src-tauri\target\release\bundle\msi\Pi Agent_0.1.0_x64_en-US.msi  44.02 MB  (含 sidecar.exe)
src-tauri\target\release\bundle\nsis\Pi Agent_0.1.0_x64-setup.exe 30.94 MB  (含 sidecar.exe)
sidecar\dist\pi-agent-sidecar.exe                   108 MB  (bun compiled, self-contained)
src-tauri\binaries\pi-agent-sidecar-x86_64-pc-windows-msvc.exe  108 MB  (Tauri 命名约定, 必须 commit)
```

### v0.5.7 + v0.5.8 补完 (2026-08-17 22:46)

| Commit | 性质 | 内容 |
|---|---|---|
| 8758554 | doc sync | v0.5.7 — ADR-0017 status proposed → accepted + Architecture/Roadmap 同步 v0.5.0-v0.5.6 状态 |
| 33fc5fa | release | **v0.5.8** — Tauri 2 标准 sidecar 机制 (D172 跨项目规则), 补 v0.5.6 漏的 `bundle.externalBin` + `app.shell().sidecar()`, 干净 Windows 机器 install MSI/NSIS 真能跑 |

### v0.5.9 端到端验证 PASS (2026-08-17 23:07)

**user 在干净 Windows 机器 install NSIS installer, 7 个核心场景全 PASS**:

| # | 场景 | 状态 |
|---|---|---|
| 1 | 安装 (NSIS installer 走完, 装到 install_dir/) | ✅ |
| 2 | Provider 配置 (LLM provider 接入, key 走 keychain) | ✅ |
| 3 | 对话 send (消息流正常) | ✅ |
| 4 | 工具调用 (tool executor 跑通) | ✅ |
| 5 | think (thinking blocks 显示 OK) | ✅ |
| 6 | 权限二次确认 (PermissionDialog 弹窗正常) | ✅ |
| 7 | 上下文记忆 (多轮对话 history 累积, AI 记得之前聊过) | ✅ |

完整 v0.5 cycle 收官: Phase 1-3 + 3 hotfix + 1 release 收尾 + 1 doc sync + 1 Tauri 2 sidecar 机制补全 + 1 端到端验证 = 14 commits, 全部 landed + 端到端验过.

### 后续 (v0.5.9+ 待做) — 2026-08-17 竞品对标重排

> **roadmap 重大更新**: 跟 Claude Code v2.1.x / Trae v2.0+ / Cursor 3.x 2026 Q2 主流产品对标后, 决定走 **"Pi SDK 暴露优先 + 自建补缺"** 路线, 详细 43 项功能对比见 [05-competitive-analysis-2026.md](05-competitive-analysis-2026.md). 短期 (0-6 月) P0 + P1 重点补 table stakes, 长期评估是否换底座.

#### 🥇 P0 — 1 个月内必做 (table stakes for 2026, Pi SDK 暴露, 0 风险)

- [ ] **v0.4.3 Compaction UI** (1-2h, 极高 ROI) — UI 暴露 Pi SDK `core/compaction/` 已有 `compact` RPC, 按钮调 `send_rpc_command` 即完事, 跟 context 计数集成
- [ ] **v0.4.4 Skills (Pi SDK 暴露)** (2-3h, 极高 ROI) — Pi SDK 有 `core/skills.ts` (loadSkillsFromDir + formatSkillsForPrompt), UI 加 skill 管理面板
- [ ] **v0.4.5 Slash commands (内置)** (2-3h, 高 ROI) — 走 Pi SDK `core/slash-commands.ts` 暴露内置 + custom 命令
- [ ] **v0.4.6 Project rules (类似 CLAUDE.md)** (1-2h, 高 ROI) — 走 UI 让 user 创建/编辑 project memory file, 走 `appendSystemPromptOverride` 注入
- [ ] **v0.4.7 /usage 完整化** (2h, 中 ROI) — 走 Pi SDK `usage-totals.ts` + 分类聚合 + UI 图表

**P0 全部是 Pi SDK 已有功能 UI 暴露, 0 风险快速做完. 1-2 周完 5 项.**

#### 🥈 P1 — 2-3 个月内做 (重要, Pi SDK 缺需自建)

- [ ] **v0.5.0 Plan mode** (4-6h, 高 ROI) — Pi SDK 没原生 plan mode, 走 PreToolUse permission 拦截 + 第一个 tool call 让 AI 写 plan + user 审批
- [ ] **v0.5.1 Sub-agents (Explore/Plan)** (8-12h, 高 ROI) — Pi SDK 没原生 sub-agent, 走多个 sidecar 进程 + 主控协调, 短期只支持 Explore/Plan 两种
- [ ] **v0.5.2 Background tasks** (中 ROI) — 走 sidecar 进程 detach + 状态同步, UI 列出 background tasks
- [ ] **v0.5.3 MCP 集成 Phase 1 (stdio)** (8-10h, 极高 ROI) — 走 sidecar 启动 stdio MCP server + Pi SDK 走 `extensionFactories` 暴露为 tool

#### 🥉 P2 — 6 个月内做 (nice-to-have / 差异化)

- [ ] **v0.6.0 Web app (claude.ai/code 对标)** — 走 Tauri 2 web target 复用前端, 部署到 Vercel/自建
- [ ] **v0.6.0 Agent SDK (编程 API)** — 走 Tauri command 暴露为 JSON-RPC, 跟现有 send_rpc_command 复用
- [ ] **v0.7.0 Auto mode (智能 permission)** — 走 second 模型做 classifier 评估每个 tool call 风险
- [ ] **v0.7.0 Voice input** — 走 web speech API
- [ ] **v0.7.0 CLI 模式** — 走 Tauri 2 CLI target 复用现有 sidecar
- [ ] **v0.7.0 Notepads / Canvas** — 差异化, 走 Vue 3 + 自实现画布
- [ ] **v0.8.0 Team 共享 rules** — 跟 cloud sync 一起做
- [ ] **v0.8.0 跨设备 cloud sync** — 走 Tauri 2 cloud sync
- [ ] **v0.8.0 Plugin marketplace** — 跟 Team 共享一起做
- [ ] **v0.8.0 IDE 插件 (VS Code)** — 走 webview embed 简化版
- [ ] **v0.9.0 跨平台** — macOS / Linux / Mobile POC

#### 历史项 (已包含在前面 milestone)

- [x] ~~v0.5.1: image tab 完整化~~ — 改到 P2 v0.7.0 跟 canvas 一起做
- [x] ~~v0.5.2: multi-agent / sub-agent 探索~~ — 改到 P1 v0.5.1
- [x] ~~v0.5.3: Tauri 2 mobile / iPad / Android 调研~~ — 改到 P2 v0.9.0 跨平台

---

## ⚪ v0.6 · Memory 系统

### 必做项

| # | 项 | spec | 验收 |
|---|---|---|---|
| 1 | 项目级 memory（`./AGENTS.md` 类似 Pi Agent 机制）| [memory.md](03-features/memory.md) | 每个 workspace 自己的 memory 文件 |
| 2 | 用户级 memory（`%APPDATA%\com.piagent.desktop\memory.md`）| [memory.md](03-features/memory.md) | 跨项目生效 |
| 3 | 自动从对话提取要点（"记住这个" / "以后别这样"）| [memory.md](03-features/memory.md) | 用户说一次就记住 |
| 4 | Memory 编辑器（settings tab）| [memory.md](03-features/memory.md) | 用户能手动增删改 |
| 5 | Memory 在 system prompt 注入（已有 workspace prompt 机制扩展）| [memory.md](03-features/memory.md) | LLM 知道 user preferences / project context |

---

## ⚪ v0.6 · Skills + MCP

### 必做项

| # | 项 | spec | 验收 |
|---|---|---|---|
| 1 | Slash command（`/help` `/clear` `/model` `/commit` 等）| [skills.md](03-features/skills.md) | 至少 10 个内置 command |
| 2 | 用户自定义 slash command（`.claude/commands/*.md` 类似）| [skills.md](03-features/skills.md) | Markdown + frontmatter 加载 |
| 3 | Skills 包（带 description / when-to-use 触发条件）| [skills.md](03-features/skills.md) | 跟 Claude Skills 兼容 |
| 4 | MCP server 接入（stdio transport）| [mcp.md](03-features/mcp.md) | 配 mcp.json 就能用 |
| 5 | MCP 工具在 tool call 列表里出现 | [mcp.md](03-features/mcp.md) | LLM 能调用 MCP 暴露的工具 |
| 6 | 插件市场 UI（v1 可不做，先支持本地 / git 加载）| [mcp.md](03-features/mcp.md) | 从 git URL 装插件 |

---

## ⚪ v0.7 · Subagent + Plan Mode

### 必做项

| # | 项 | spec | 验收 |
|---|---|---|---|
| 1 | Plan mode（先输出计划 → 用户 approve → 执行）| [subagent.md](03-features/subagent.md) | 类似 Claude Code 的 ExitPlanMode |
| 2 | Subagent 委派（主 agent 调子 agent 跑独立任务）| [subagent.md](03-features/subagent.md) | 类似 Claude Code 的 Task 工具 |
| 3 | Agent profile（不同 agent 配不同 system prompt / tools）| [subagent.md](03-features/subagent.md) | settings 里能选 agent |

---

## ⚪ v0.8 · 协作 / 分享

### 必做项

| # | 项 | spec | 验收 |
|---|---|---|---|
| 1 | Session 导出（Markdown / JSON / 完整含 tool calls）| [sharing.md](03-features/sharing.md) | 一键导出到剪贴板 / 文件 |
| 2 | Session 分享链接（加密 + 过期）| [sharing.md](03-features/sharing.md) | 跟 Claude Artifacts 类似 |
| 3 | 团队空间（如 B 端需要，待定）| [sharing.md](03-features/sharing.md) | spec 待商业化方案确定后写 |

---

## ⚪ v0.9 · 跨平台

### 必做项

| # | 项 | spec | 验收 |
|---|---|---|---|
| 1 | macOS 适配（Dock / Menu Bar / 全局快捷键）| [platform.md](03-features/platform.md) | Tauri 2 macOS target 编译通过 + 真机测 |
| 2 | Linux 适配（AppImage / deb）| [platform.md](03-features/platform.md) | Ubuntu 22.04 + Fedora 测 |
| 3 | Web 版本（如需要，存疑）| [platform.md](03-features/platform.md) | 决策：是否值得做（v0.2 形态的回归）|

---

## 🎯 v1.0 · 稳定版

### ⚠️ Pre-release 必做项 (v1.0 feature 之前, **必须先做**)

**为什么这一项独立**: 当前 `src-tauri/src/sidecar.rs:65` 用 `Command::new("node").arg("sidecar/src/index.mjs")` 直接读 .mjs 源码,有两个 release 阻塞问题:
1. `CARGO_MANIFEST_DIR` 编译时嵌入开发路径 → 用户拷 `.exe` 单独跑会报 "Sidecar script not found"
2. `.mjs` 是 plain text → 任何拿到 .exe 的人都能 cat 出 sidecar 源码

| # | 项 | spec | 验收 |
|---|---|---|---|
| **P0** | **Sidecar 编译成独立 .exe** | bun build --compile | `bun build --compile sidecar/src/index.mjs --outfile pi-agent-sidecar.exe` 成功, .exe 自包含 node_modules, Tauri 改成 spawn 这个 .exe. 验证: 拷 .exe 到没装 Node.js 的机器单独跑,功能正常 |
| **P1** | **ADR-0013**: 选 sidecar 编译方案 (bun vs pkg vs nexe vs Rust 重写) | [04-adr/](../04-adr/) | 记录决策 + 风险 + 验证 Pi SDK 兼容性 |

### 必做项

| # | 项 | spec | 验收 |
|---|---|---|---|
| 1 | 自动更新（`tauri-plugin-updater`）| [desktop.md](03-features/desktop.md) | 用户收到新版本提示 → 静默下载 → 下次启动安装 |
| 2 | 完整用户文档（`docs/user-guide/`）| [README.md](README.md) | 新用户 5 分钟上手 |
| 3 | Crash report（`tauri-plugin-sentry` 或自实现）| [observability.md](03-features/observability.md) | 崩溃自动上报（用户 opt-in）|
| 4 | 性能审计（启动 / 内存 / CPU）| [01-architecture.md](01-architecture.md) | 满足 [性能预算](01-architecture.md#9-性能预算) |
| 5 | 完整 E2E 测试覆盖（Playwright + Tauri）| [observability.md](03-features/observability.md) | 核心 flow 100% 覆盖 |
| 6 | 安全审计（key / tool / network）| [security.md](03-features/security.md) | 第三方安全 review |
| 7 | README + LICENSE + 官网 ready | — | 开源发布 |

---

## 不在 roadmap（明确不做）

- ❌ 移动端（iOS / Android）— v2.0+ 再说
- ❌ 浏览器插件 — v2.0+ 再说
- ❌ 多模态生成为主入口 — 不做（可作为扩展 tool）
- ❌ 账号 / 社交 / feed — 不做
- ❌ 强制更新 — 不做
- ❌ Bundle IDE — 不抢 VSCode 饭碗
