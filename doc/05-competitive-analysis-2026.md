# Pi Agent vs 主流 Coding Agent 2026 对比分析 (Claude Code / Trae / Cursor)

**调研时间**: 2026-08-17 23:18
**目的**: 识别 Pi Agent v0.5.9 跟 2026 主流产品的能力 gap, 决定 roadmap 优先级
**结论先行**: Pi SDK 0.84.2 缺 sub-agent / MCP / plan mode 原生支持, Pi Agent 短期走 UI 补全 (compaction/skills/rules) + Pi SDK 演进同步; 长期要评估是否换底座

## 一、调研范围

| 产品 | 公司 | 形态 | 调研深度 |
|---|---|---|---|
| Claude Code v2.1.x (2026 Q2) | Anthropic | CLI + Desktop + Web + VSCode/JetBrains | ✅ 深度 (CLAUDE.md, skills, hooks, sub-agents, MCP, plan mode, Routines, Bugbot) |
| Trae IDE + Work v2.0+ (2026 Q2) | ByteDance | IDE + Work 平台 (Code/Design/Work) | ✅ 深度 (SOLO mode, Builder, CUE engine, Skill market, 多模型, 三端) |
| Cursor 3.x (2026 Q2) | Anysphere | IDE (VS Code fork) + CLI + Web | ✅ 深度 (Composer 1.5/2, Agent mode, Background Agents, Bugbot, .cursor/rules, Cursor SDK) |
| GitHub Copilot (Workspace) | Microsoft | IDE 插件 + Workspace | ⚠️ 略 (主要功能跟 Cursor 重叠, 不重复调研) |
| Windsurf | Codeium | IDE | ⚠️ 略 (跟 Cursor 高度重叠) |
| Aider / Cline | 开源 | CLI / IDE 插件 | ⚠️ 略 (小众, 不影响主 roadmap) |

## 二、功能矩阵 (Y = 有, N = 无, P = 部分, - = 不适用)

| # | 功能类别 | 具体能力 | Claude Code | Trae | Cursor | **Pi Agent v0.5.9** | Pi SDK 0.84.2 状态 |
|---|---|---|---|---|---|---|---|
| 1 | **核心对话** | 多轮对话 + 流式输出 + Markdown 渲染 | Y | Y | Y | **Y** | ✅ |
| 2 | | Thinking 块显示 (extended thinking) | Y (4K-128K levels) | Y | Y | **Y** | ✅ |
| 3 | | Tool calling + 自动执行 | Y | Y | Y | **Y** | ✅ |
| 4 | | 权限确认 (tool call 二选一) | Y (6 modes + Auto) | Y (Sandbox/Manual/Auto) | Y (3 levels) | **Y** (3 modes: ask/smart/allow) | ✅ |
| 5 | **多模型** | 接入多个 LLM provider | Y (Anthropic) | Y (Doubao/DeepSeek/Kimi/GLM/Claude/GPT) | Y (multi) | **Y** (OpenAI-compatible + 自定义) | ✅ |
| 6 | | BYOK (keychain 持久化) | Y (env) | Y (settings) | Y (encrypted) | **Y** (OS keychain) | N/A (Tauri 2 提供) |
| 7 | | Auto mode (智能选 model) | Y (Sonnet 4.6 classifier) | Y (Auto mode) | Y (Auto) | **N** | ❌ |
| 8 | **Agent 能力** | Plan mode (先规划后执行) | Y (/plan) | Y (Alt+P) | Y (Plan Mode) | **N** | ❌ |
| 9 | | Sub-agents (并行子 agent, 隔离 context) | Y (6 内置 + 自定义) | Y (Builder+Coder dual + multi-agent) | Y (up to 8 parallel) | **N** | ❌ |
| 10 | | Background agents (云端/异步) | Y (cloud sessions) | Y (SOLO) | Y (cloud VMs) | **N** | ❌ |
| 11 | | Worktree 隔离 (并行分支) | Y (-w flag) | Y (SOLO Coder) | Y (8 agents) | **N** | ❌ |
| 12 | **扩展性** | MCP (Model Context Protocol) 服务器 | Y (1000+ community) | Y (stdio/SSE/Streamable HTTP) | Y (.cursor/mcp.json) | **N** | ❌ |
| 13 | | Slash commands (内置) | Y (60+) | Y | Y (lots) | **N** | ❌ (Pi SDK 有 slash-commands.ts 但未暴露) |
| 14 | | Custom slash commands / Skills | Y (SKILL.md) | Y (Skill Market) | Y (.cursor/rules) | **N** | ✅ Pi SDK 有 skills.ts (未暴露) |
| 15 | | Hooks (lifecycle events) | Y (25 events, 4 types) | N | N | **N** | ❌ |
| 16 | | Plugin system (打包) | Y (Plugin marketplace) | Y (Skill Market) | Y (Marketplace) | **N** | ❌ |
| 17 | **Memory** | Session memory (单 session 累积) | Y | Y | Y | **Y** (per-workspace jsonl) | ✅ |
| 18 | | 跨 session 长期 memory (auto memory) | Y (Auto Memory + topic files) | Y (Memory 功能) | Y (Notepads) | **N** | ❌ |
| 19 | | Project rules (CLAUDE.md / .cursor/rules) | Y (CLAUDE.md + 200 行 limit) | Y (规则引擎) | Y (.cursor/rules) | **N** | ⚠️ Pi SDK 有 APPEND_SYSTEM.md (未走 UI 暴露) |
| 20 | | Compaction (context 压缩) | Y (/compact) | Y (context compression) | Y (auto) | **N** | ✅ Pi SDK 有 core/compaction/ (未走 UI 暴露) |
| 21 | **使用体验** | Image input (拖入/粘贴/上传) | Y | Y (Figma/img) | Y | **P** (image tab 已有, 完整度待验) | ✅ |
| 22 | | Image generation (输出) | Y (DALL-E etc) | Y (设计) | Y (Composer 2) | **P** (image tab 已有) | ✅ |
| 23 | | Voice input (push-to-talk) | Y (/voice) | N | N | **N** | N/A |
| 24 | | Vim mode (编辑器) | Y (v/V char/line) | Y | Y | **N** (我们不是 IDE) | N/A |
| 25 | **平台** | Desktop (原生) | Y | Y | Y | **Y** (Tauri 2) | N/A |
| 26 | | Web app | Y (claude.ai/code) | Y (trae.ai/work) | Y (cursor.com/agents) | **N** | N/A |
| 27 | | Mobile app | Y (iOS/Android) | Y (iOS/Android) | Y (iOS) | **N** | N/A |
| 28 | | CLI | Y (claude -p) | Y (Trae CLI) | Y (Cursor CLI) | **N** | N/A |
| 29 | | IDE 插件 (VS Code / JetBrains) | Y (VSCode + JetBrains) | Y (VSCode 等) | Y (本身是 IDE) | **N** | N/A |
| 30 | **集成** | GitHub Actions / CI | Y (claude -p) | N (Trae Work 走云端) | Y (Cursor SDK) | **N** | N/A |
| 31 | | Slack / Discord / Linear / GitHub | Y (Channels + native) | Y (多集成) | Y (Linear 等) | **N** | N/A |
| 32 | **协作** | Team 共享 rules | Y (managed settings) | Y (企业版) | Y (Teams $40/seat) | **N** (单用户) | N/A |
| 33 | | Cloud sync (跨设备) | Y (cloud sessions) | Y (TRAE Work 跨端) | Y (cloud agents) | **N** (本地 only) | N/A |
| 34 | **安全** | Sandbox (filesystem + network 隔离) | Y (OS-level) | Y (Sandbox + allowlist) | Y (cloud VMs) | **P** (keychain 是, tool 沙箱无) | N/A |
| 35 | | Privacy mode (代码不上传) | Y | Y | Y | **Y** (BYOK 默认) | N/A |
| 36 | **可观测** | Cost / Usage 统计 (per session) | Y (/usage + breakdown) | Y | Y | **P** (基础 token 计数) | ✅ usage-totals.ts |
| 37 | | /usage 跨 session 统计 | Y | Y | Y | **N** | ❌ |
| 38 | | 监控 / 审计日志 | Y (企业版) | Y (企业版) | Y (Security Review) | **N** | N/A |
| 39 | **UI 增强** | Notepads / Canvas (可视化) | N | N | Y (Canvas) | **N** | N/A |
| 40 | | Interactive components (表格/方块/图表) | N | Y (canvas) | Y (Canvas) | **N** | N/A |
| 41 | | Plan visualization (审批前看 plan) | Y (Plan mode) | Y (Plan mode) | Y (Plan mode) | **N** | ❌ |
| 42 | **可编程** | Agent SDK (programmatic API) | Y (Claude Agent SDK) | Y (内置) | Y (Cursor SDK) | **N** | N/A |
| 43 | | Headless mode (无 UI 跑) | Y (claude -p) | Y (CLI) | Y (CLI) | **N** | N/A |

## 三、Gap 优先级 (P0/P1/P2)

### P0 — 1 个月内必做 (table stakes for 2026)

| Gap | 来源 | 重要性 | 备注 |
|---|---|---|---|
| **Compaction UI** | 35 (Pi SDK 已有) | 🔥 极高 | Pi SDK `core/compaction/` 已内置 `compact` RPC, UI 加按钮调 `send_rpc_command` 即完事. **v0.4.3** |
| **Skills (Pi SDK 暴露)** | 14 (Pi SDK 已有 skills.ts) | 🔥 极高 | Pi SDK 有 `loadSkillsFromDir` + `formatSkillsForPrompt`, 走 UI 加 skill management 即可. **v0.4.4** |
| **Slash commands (内置)** | 13 (Pi SDK 有但未用) | 🔥 极高 | 走 Pi SDK `core/slash-commands.ts` 暴露内置 + custom 命令. **v0.4.5** |
| **Project rules (类似 CLAUDE.md)** | 19 (Pi SDK 有 APPEND_SYSTEM.md) | 🔥 高 | 走 UI 让 user 创建/编辑 project memory file, Pi SDK 走 `appendSystemPromptOverride` 注入. **v0.4.6** |
| **/usage 完整化** | 37 (Pi SDK 有 usage-totals.ts) | 🔥 高 | 走 Pi SDK usage + tool/error/cost 分类聚合, UI 图表展示. **v0.4.7** |

### P1 — 2-3 个月内做 (重要)

| Gap | 来源 | 重要性 | 备注 |
|---|---|---|---|
| **Plan mode** | 8 (Pi SDK 缺) | 🔥 高 | Pi SDK 没原生 plan mode, 我们走 PreToolUse permission 拦截 + 第一个 tool call 让 AI 写 plan + user 审批. **v0.5.0 大重构** |
| **Sub-agents** | 9 (Pi SDK 缺) | 🔥 高 | Pi SDK 没 sub-agent 原生支持, 我们走"多个 sidecar 进程 + 主控协调"自己实现, 短期只支持 Explore/Plan 两种. **v0.5.1** |
| **Background tasks** | 10 | 中 | 走 sidecar 进程 detach + 状态同步, UI 列出 background tasks. **v0.5.2** |
| **MCP 集成 (Phase 1: stdio)** | 12 (Pi SDK 缺) | 🔥 高 | 走 `sidecar` + 配 `mcp_servers.json` + sidecar 启动 stdio MCP server + Pi SDK 走 `extensionFactories` 暴露为 tool. **v0.5.3** |
| **Web app (claude.ai/code 对标)** | 26 | 中 | 走 `vue-tsc build` 出 web build + 部署到 Vercel/自建, 走 Tauri 2 web target 复用前端. **v0.6.0** |

### P2 — 6 个月内做 (nice-to-have / 差异化)

| Gap | 来源 | 重要性 | 备注 |
|---|---|---|---|
| Mobile (iOS/Android) | 27 | 低 | Tauri 2 mobile target POC, 不优先. **POC-only** |
| Auto mode (智能 permission) | 7 | 中 | 走 second 模型做 classifier 评估每个 tool call 风险. **v0.7.0** |
| 跨设备 cloud sync | 33 | 低 | 走 Tauri 2 cloud sync, 但要 server 端, 工程量大. **v0.8.0** |
| Team 共享 rules | 32 | 低 | 跟 v0.8.0 一起做, 需要 server 端. **v0.8.0** |
| Agent SDK / 编程 API | 42 | 中 | 走 Tauri command 暴露为 JSON-RPC, 跟现有 send_rpc_command 复用. **v0.6.0 (跟 web app 一起)** |
| CLI 模式 | 28 | 低 | 走 Tauri 2 CLI target 复用现有 sidecar. **v0.7.0** |
| Voice input | 23 | 低 | 走 web speech API, 容易加. **v0.7.0** |
| Hooks (lifecycle events) | 15 | 低 | Pi SDK 没 hook 系统, 需自建, 优先级低. **v0.7.0** |
| Plugin marketplace | 16 | 低 | 跟 Team 共享一起做. **v0.8.0** |
| IDE 插件 (VS Code) | 29 | 低 | 工程量大, 走 webview embed 简化版. **v0.8.0** |
| Notepads / Canvas | 39-40 | 低 | 差异化, 走 Vue 3 + 自实现画布. **v0.7.0** |
| 监控 / 审计日志 | 38 | 低 | 企业版需求, 个人版不做. **v0.8.0** |

## 四、Pi SDK 演进策略 (战略决策)

**当前 Pi SDK 0.84.2 缺口**: sub-agents, MCP, plan mode, hooks, auto memory, voice

### 三个选项

**A. 跟 Pi SDK 走 (推荐, 短期)**
- 短期 (0-6 月): Pi Agent 自建补缺 (P0 + P1), 等 Pi SDK 演进
- 中期 (6-12 月): 评估 Pi SDK 路线图, 优先把 sub-agents / MCP 推动 Pi SDK 加进
- 风险: Pi SDK 是 Mario Zechner (Badlogic) 单人维护, 演进速度不一定跟得上需求

**B. 替换 Pi SDK (中期评估)**
- 评估 Anthropic SDK, LangChain, OpenHands 等替代底座
- 工作量: 1-2 月重写 sidecar, FE 大量适配
- 收益: 拿到完整 Claude Code / Claude Agent SDK 能力
- 风险: 失去对底层协议的完全控制, 依赖上游

**C. 混合方案 (长期)**
- Pi SDK 跑 RpcMode 当 "agent engine", 同时集成 Anthropic SDK / OpenAI Agents SDK
- 不同场景选不同引擎: 简单 chat 走 Pi SDK, sub-agent / MCP 走 Anthropic SDK
- 复杂度高, 长期再评估

**当前建议**: 走 A 方案, P0 1 个月内全做, P1 2-3 月, 6 月时再评估 B 方案.

## 五、立即推荐 (按 ROI 排序)

| 优先级 | 项 | 估计时间 | 价值 | 风险 |
|---|---|---|---|---|
| 🥇 | **v0.4.3 Compaction UI** | 1-2h | 极高 (memory 体验闭环) | 低 (Pi SDK 已有) |
| 🥈 | **v0.4.4 Skills (Pi SDK 暴露)** | 2-3h | 极高 (扩展性) | 低 (Pi SDK 已有) |
| 🥉 | **v0.4.5 Slash commands** | 2-3h | 高 (操作效率) | 低 (Pi SDK 已有) |
| 4 | **v0.4.6 Project rules UI** | 1-2h | 高 (per-workspace 记忆) | 低 (Pi SDK 有 APPEND_SYSTEM.md) |
| 5 | **v0.4.7 /usage 完整化** | 2h | 中 (可观测) | 低 (Pi SDK 有 usage-totals.ts) |
| 6 | **v0.5.0 Plan mode** | 4-6h | 高 (用户控制感) | 中 (Pi SDK 缺) |
| 7 | **v0.5.1 Sub-agents (Explore/Plan)** | 8-12h | 高 (复杂任务) | 高 (Pi SDK 缺, 需自建) |
| 8 | **v0.5.3 MCP Phase 1 (stdio)** | 8-10h | 极高 (生态) | 高 (Pi SDK 缺, 需自建) |

P0 (1-5) 全部是 Pi SDK 已有的功能 UI 暴露, 0 风险快速做完. 做完 5 项估计 1-2 周.
P1 (6-8) 才有 Pi SDK 缺口, 需自建, 周期 2-3 月.

## 六、Roadmap 同步

需要更新 `doc/02-roadmap.md`:
- v0.4.3 改名 v0.4.3a: Compaction UI (现 v0.4.3 拆细)
- 加 v0.4.3b ~ v0.4.3f: 5 个 P0 Pi SDK 暴露
- 加 v0.5.0 ~ v0.5.3: P1 自建功能
- 加 v0.6.0 ~ v0.8.0: P2 nice-to-have

## 七、Doc 同步 (D170)

新 ADR 待写:
- **ADR-0021 (TBD)**: Pi Agent 2026 战略 — 跟 Pi SDK 走 vs 替换 vs 混合, 决定 v0.5+ 路线
- **ADR-0022 (TBD)**: Sub-agent 架构 — 多个 sidecar 进程 + 主控协调 vs Pi SDK 内置 (需等 Pi SDK 演进)
- **ADR-0023 (TBD)**: MCP 集成方案 — stdio 优先 (Phase 1) + SSE/HTTP (Phase 2) + 走 Tauri capability 权限管控
