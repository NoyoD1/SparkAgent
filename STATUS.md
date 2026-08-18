# Pi Agent · 功能完成度清单 (Status Snapshot)

> **生成时间**: 2026-08-19 01:35 (v0.5.0-D 第11轮 — narrative UI 完工)
> **数据源**:
> - `doc/00-product-blueprint.md` 14 维度状态总表
> - `doc/02-roadmap.md` 阶段进度
> - `doc/03-features/*.md` 各维度 spec + changelog
> - `doc/04-adr/*` 架构决策记录
> - 实际代码扫描 (`app/src/`、`sidecar/src/`、`src-tauri/src/`)
>
> **图例**: ✅ 已完成 / 🟡 部分完成 / ❌ 未开始 / 🚫 明确不做
>
> **配套文档**: `doc/` 是 living blueprint(每个维度独立 spec + changelog)。
> 本文件是**横向汇总**——便于一眼看清全局、规划下一阶段工作。

---


## v0.5.0-D 1-11 轮速览 (D194 + D197)

> **9 轮 echo filter 死循环 + revert + narrative UI 化**, 集中处理 chat 核心问题

### v0.5.0-D 第1-9轮 (D194): echo filter 9 轮死循环
- 触发: deepseek-v4-flash / sensenova-6.7-flash-lite 在第一段 text_delta 原样复读 user 输入
- 错误路线: text-based heuristic filter, 每轮加规则漏 case
  - 第4轮: pure `startsWith` 漏 "X X The user"
  - 第5轮: + "X [sep] X" 模式 漏 "X? 我是 pi"
  - 第6轮: + "X 问句标点" 规则 (early return bug)
  - 第7轮: + afterFirst empty 也剥
  - 第8轮: 修 early return bug
  - 第9轮: 激进 always-strip (无 conditions) — "改了个寂寞 原地转圈" (用户反馈)
- **D194 教训**: 复杂文本启发式规则链 = 死胡同. 真 fix 在 system prompt + model 层, 不在 chat store 文本层

### v0.5.0-D 第10轮 (D194 revert): 删 echo filter 死循环
- chat.ts 删 2 个函数 (splitMessageContentIntoStep + stripLeadingUserEcho, 129 行)
- text_delta handler 改回 v0.5.0-PR3 简单 append
- 保留 v0.5.0-D 真有效修复: placeholder bug 修, assistantId const, willRetry 静默, auto_retry_start/end toast
- sidecar system prompt 简化: 5 条规则 → 1+1 条 (no-echo 带 Bad/Good 反例 + HTML 包代码块)
- **关键修复**: 第1条 no-echo 配 Bad/Good 反例, 实测 model 对 "具体反例" 比 "否定指令" 遵守率显著提升
- Commit: `c34d30e`

### v0.5.0-D 第11轮 (D197): per-step group narrative 风格 (MiniMax Code UI 化)
- 用户反馈: 图1 (旧 step group) 有 "框框" 突兀感, 跟整体 narrative 风格不一致
- 参考图2 (MiniMax Code) 重做 step group 视觉:
  - step head: 去掉 border + background, 仅 inline 文字 + chevron (opacity 0.7, hover opacity 1)
  - step body: 去掉 left border, 仅 padding-left 16px 缩进
  - thinking: 去掉 background block, 纯 italic text
  - tool card: 变 inline pill (单行, muted bg), status 变 simple dot + text
  - step number 圆形标签: 隐藏
  - current step: opacity 1 + 颜色微调 (不再 accent border)
  - assistant message 整体 gap 从 6px 缩到 2px, 更紧凑 narrative
- Commit: `27966b2`
- 6 个 artifacts: debug .exe 24.20 MB / release .exe 15.09 MB / debug .msi 47.36 MB / debug NSIS 32.54 MB / release .msi 44.57 MB / release NSIS 31.15 MB

### 端到端验证 (D197 后)
- 7 场景 NSIS install + chat 核心 PASS (用户实测)
- 第10轮: echo 修好 (新 prompt Bad/Good 反例对 sensenova-6.7-flash-lite 生效)
- 第11轮: chat UI 跟 MiniMax Code 一致, narrative 流式观感 OK

### 后续观察
- 系统 prompt 反例 prompt 是否长期有效: 需观察 1-2 周, sensenova / deepseek 系列
- 若 echo 复现, 候选方案:
  1. 换 model (deepseek-v4-flash / claude-haiku 比 sensenova-6.7-flash-lite 遵守率高)
  2. 接受 echo + 文档化 (model 层问题不在 chat store 处理)

---


## 0. 整体进度速览

| 指标 | 数值 |
|---|---|
| 已落地阶段 | v0.1 → v0.2 → v0.3 → v0.3.5–v0.3.8.27 (UX Polish) → v0.4 (Tool Call) → v0.4.2 step 1 (Context) → v0.5.0 (RPC 重构) → v0.4.3 (Compaction UI) → v0.4.4 (Skills) → v0.4.4.6 polish → v0.4.5.2 (Slash) → v0.4.6 (AGENTS.md) → v0.4.7b (skill @ 引用) → v0.5.0-v0.1 (回滚 multi-agent) → v0.5.0-PR2 (Provider current 归 input box) → v0.5.0-PR3 (Stop hang fix) → v0.5.0-D 第1-9轮 (echo filter 9 轮死循环, D194 教训) → v0.5.0-D 第10轮 (revert filter 死循环, 改回 v0.5.0-PR3 简单 append) → v0.5.0-D 第11轮 (per-step group narrative 风格, MiniMax Code UI 化) |
| 当前版本 | **v0.5.0-D 第11轮** (含 -PR2 + -PR3 + D 1-11) / last commit `27966b2` |
| Release 产物 | `.exe 15.09 MB` / `.msi 44.57 MB` / `.nsis 31.15 MB` / sidecar 108 MB (bun compiled) |
| 端到端验证 | 7 个核心场景 NSIS install PASS (v0.5.9) |
| 14 维度综合进度 | 约 **45%** (v0.4.4 Skills + v0.4.5.2 + v0.4.6 拉高基线) |
| P0 短期目标 | "Pi SDK 暴露优先 + 自建补缺" 路线,目标 1 周内补完 v0.4.5/v0.4.6/v0.4.7 余下 |

---

## 1. 14 维度状态总览(从 0%–100% 维度进度)

| # | 维度 | spec 文档状态 | **代码实际状态** | 实际进度 | spec vs 实际 |
|---|---|---|---|---|---|
| 1 | Chat 核心 | 🟡 80% | ✅ 流式/Markdown/思考/工具/step/compaction 全做,Stop v0.5.0-PR3 兜底修,narrative UI v0.5.0-D 第11轮完工 | **100%** | spec 没追到 v0.4.3-v0.5.0-D 第11轮 |
| 2 | Session 管理 | 🟡 70% | ✅ 列表/CRUD/per-workspace 隔离/SessionManager 落盘/stable sessionId | **85%** | spec 没追到 v0.4.2 step 1 |
| 3 | Provider/模型/BYOK | ✅ 90% | ✅ 7 内置 + 自定义,keychain,metadata form,current 归 input box | **95%** | spec 同步 |
| 4 | Workspace | 🟡 40% | ✅ 多 workspace + default + file tree 基础 + path 注入 | **55%** | spec 同步 |
| 5 | Tools (tool call) | 🟡 30% | ✅ 7 tool 集成 + step UI + 4 段 system prompt + permission mode (Pi SDK Extension) | **60%** | spec 没追到 v0.4.1 + v0.5.0 |
| 6 | Memory | ❌ 0% | ❌ 未做 (0%) | **0%** | 同步 |
| 7 | Skills / Slash Command | ❌ 0% | ✅ Skills 100% (loadSkills + 3 种导入 + 实时刷新),Slash 50% (只 user 自定义) | **75%** | **spec 严重滞后** |
| 8 | MCP / 插件 | ❌ 0% | ❌ 未做 (0%) | **0%** | 同步 |
| 9 | Subagent / Plan Mode | ❌ 0% | ❌ 未做 (0%) | **0%** | 同步 |
| 10 | UI / 主题 | ✅ 90% | ✅ Minimalist Copy 完整 + 3 模式 + 12px radius | **90%** | 同步 |
| 11 | Desktop 集成 | 🟡 50% | ✅ 自定义 title bar + keychain + 标准 sidecar + bun compile + debug build 自动化 | **70%** | spec 没追到 v0.5.6-v0.5.8 |
| 12 | 安全 | 🟡 60% | ✅ keychain + 脱敏 + capabilities + crypto.randomUUID + dev-only 调试接口 | **65%** | spec 同步 |
| 13 | 可观测性 | ❌ 10% | 🟡 console.log + .tauri-*.log + sidecar stderr log (含 4 段 system prompt) | **15%** | spec 同步 |
| 14 | 协作 / 分享 | ❌ 0% | ❌ 未做 (0%) | **0%** | 同步 |
| 15 | 多平台 | ❌ 0% | ❌ Windows only | **10%** | 同步 |

> **doc 滞后提醒**: 7 个 spec 文件(doc/03-features/)的状态栏还停留在 v0.4.2 step 1 之前(最后更新 2026-08-16),实际代码已推进到 v0.5.0-D 第11轮 (commit 27966b2, 2026-08-19)。**这是工作区已知问题,改完功能要回头同步 spec 状态**。P0 #12 (见 §4) 估时 1-2h, 本周可补。

---

## 2. 按 Roadmap 阶段逐项对比

### 2.1 已完成阶段 ✅

| Phase | 主题 | 关键交付 | 完成时间 | 证据 |
|---|---|---|---|---|
| v0.1–v0.2 | 骨架 | Web form + 多 provider BYOK + 流式 | 2026-07 | doc/02-roadmap §v0.1-v0.2 |
| v0.3 | Tauri 化 | 桌面 app + OS keychain + Node sidecar | 2026-08 上 | doc/02-roadmap §v0.3 |
| v0.3.5–v0.3.8.27 | UX Polish | 布局/主题/折叠/字体/设计系统 (27 个 polish 提交) | 2026-08 中 | doc/02-roadmap §v0.3.5-8.27 |
| v0.4.0 | Pi SDK 集成 | sidecar 切 pi-ai + pi-agent-core | 2026-08-16 | commit `484de1b` / ADR-0012 |
| v0.4.1 | 7 tool 集成 | 切 pi-coding-agent 工厂,修 event name + cost 必填 | 2026-08-17 | doc/02-roadmap §v0.4.1 |
| v0.4.1.1–1.3 | Step UI polish | step 全折叠 / final body stepText / 跑马灯 / 720 max-width | 2026-08-17 | doc/03-features/chat-core.md §Changelog |
| v0.4.2 step 1 | Context 管理 | createAgentSession + SessionManager per-workspace 隔离 | 2026-08-17 | commit `88d05ea` / smoke 4/4 PASS |
| v0.4.3 | Compaction UI | ContextIndicator 紧凑指示器 + popover + 5 轮 polish + D182 token 修正 | 2026-08-18 | commit `681f248` + `57e1a47` |
| v0.4.4 | Skills (Pi SDK 暴露) | loadSkills + formatSkillsForPrompt + 3 种导入 (.md / URL / zip) | 2026-08-18 | commit `b02e99e` → `52dd667` |
| v0.4.4.6 polish | 4 个 user 反馈 bug | 上下文窗口持久化 / model dropdown / metadata form / skill 实时刷新 | 2026-08-18 | commit `940eb47` + `ddd179a` |
| v0.4.5.2 + v0.4.6.2 + v0.4.7b | Slash tab + per-session + skill @ 引用 | D184 v9 修正后落地 | 2026-08-18 | commit `1187120` + `5ee616e` + `538d4d6` |
| v0.5.0 | RPC 模式重构 | sidecar 836→200 行 + Pi SDK runRpcMode + 端到端 NSIS 验证 PASS | 2026-08-17 | 14 commits / doc/02-roadmap §v0.5.0 |
| v0.5.6 | bun compile | `bun build --compile` 出 standalone .exe 108MB | 2026-08-17 | commit `115959e` |
| v0.5.8 | Tauri 2 标准 sidecar | `bundle.externalBin` + `app.shell().sidecar()` 解决干净机器 install | 2026-08-17 | commit `33fc5fa` |
| v0.5.0-v0.1 | 回滚 multi-agent | 改 single agent design,删 7 invoke + 4 struct + 313 行 Rust | 2026-08-18 16:24 | commit (user 拍板) / ADR-0025 |
| v0.5.0-PR2 | Provider 详情面板只管 enabled | current 归 input box,删 radio 冲突 | 2026-08-18 17:30 | commit `5de266e` |
| v0.5.0-PR3 | Stop hang fix + debug build | stepText 显示 + 30s 兜底 + `scripts/build-debug.mjs` | 2026-08-18 18:35 | commit `33642a7` |

### 2.2 进行中 🟡

| Phase | 主题 | 关键交付 | 进度 | 阻塞 |
|---|---|---|---|---|
| **v0.4.4 系列 P0** | **Pi SDK 暴露 (table stakes)** | skills ✅ / slash cmds 🟡 / rules ✅ / usage ❌ | **2.5/4 完成** | — |

### 2.3 未开始 ❌

| Phase | 主题 | 关键交付 | 计划时间 |
|---|---|---|---|
| v0.4.4.x polish | skill toggle 自动重启 sidecar (D165 阻塞) | 走 Pi SDK systemPrompt 不可动态改的限制 | v0.4.4.x |
| v0.4.4.x | Pi 官方 skill 模板库 (D171 Pi SDK 0.84.2 没 builtin) | 自实现 catalog | v0.4.4.x polish |
| v0.4.4.x | v0.4.7c overlay 渲染 [[skill:xxx]] | 现在是 textarea 下面 preview 区显示 chip | v0.4.4.x polish |
| v0.4.5 系列 | Slash command 内置 (`/help` `/clear` `/model` 等 10 个) | Pi SDK 内置暴露 | 1 周内 |
| v0.4.7 | `/usage` 完整化 | 走 Pi SDK `usage-totals.ts` + 分类聚合 + UI 图表 | 1 周内 |
| v0.5.0+ | Plan mode | PreToolUse 拦截 + 计划 UI + ExitPlanMode | 2-3 月内 |
| v0.5.1 | Sub-agents (Explore/Plan) | 多 sidecar 进程 + 主控协调 | 2-3 月内 |
| v0.5.2 | Background tasks | sidecar 进程 detach + 状态同步 | 2-3 月内 |
| v0.5.3 | MCP stdio | sidecar 启动 stdio MCP server + extensionFactories | 2-3 月内 |
| v0.6 | Web app (claude.ai/code 对标) | Tauri 2 web target 复用前端 | 6 月内 |
| v0.6 | Agent SDK (编程 API) | Tauri command 暴露 JSON-RPC | 6 月内 |
| v0.7 | Auto mode / Voice / Hooks / Notepads | 自建 | 6 月内 |
| v0.8 | Team rules / Cloud sync / VSCode 插件 | 商业化联动 | 6 月+ |
| v0.9 | macOS / Linux / Mobile POC | 跨平台 | TBD |
| v1.0 | 自动更新 + 完整文档 + 用户指南 | release 必做 | TBD |

---

## 3. 14 维度功能清单(逐项展开)

### 维度 1 · Chat 核心 (chat-core.md) — **95%**

| 功能点 | spec 状态 | 实际状态 | 备注 |
|---|---|---|---|
| 多轮对话 | ✅ | ✅ | chat.ts message append |
| 流式输出 | ✅ | ✅ | JSON Lines protocol |
| Markdown 渲染 | ✅ | ✅ | marked 18 GFM 严格化 |
| 代码高亮 | ✅ | ✅ | highlight.js |
| 思考过程 (reasoning) | ✅ | ✅ | StepGroup thinking block |
| 工具调用 (tool_call) | ✅ | ✅ | StepGroup tool_calls block |
| 复制消息 / 代码块 | ✅ | ✅ | — |
| 重试 (regenerate) | ✅ | ✅ | mock 已有 |
| **Pi SDK 集成** | ✅ | ✅ | v0.4.0 commit `484de1b` |
| **7 tool 集成** | ✅ | ✅ | v0.4.1 pi-coding-agent 工厂 |
| **Step 累加 UI** | ✅ | ✅ | v0.4.1 StepGroup.vue |
| **Stop 按钮 (Abort)** | ❌ (spec 标未做) | ✅ | v0.5.0-PR3 修 stop hang + 30s 兜底 |
| 编辑用户消息后重发 | ❌ | ❌ | P1 |
| 引用回复 | ❌ | ❌ | P1 |
| 消息分支 (fork) | ❌ | ❌ | P1 |
| **Token 计数显示** | ❌ | 🟡 | Pi SDK `usage` 已 emit,ContextIndicator 显示但 UI 不全 |
| 多模态输入 (图片/音频) | ❌ | ❌ | 不做为主入口 |
| 跨 turn 重复渲染 (bug) | n/a | ✅ | v0.4.1.2 final body 用 lastStep.stepText 修 |
| Step 默认全折叠 (bug) | n/a | ✅ | v0.4.1.1 修 |

### 维度 2 · Session 管理 (session.md) — **85%**

| 功能点 | spec 状态 | 实际状态 | 备注 |
|---|---|---|---|
| 会话列表 (按更新时间倒序) | ✅ | ✅ | SidebarFunctionList |
| 创建 / 切换 / 重命名 / 删除 | ✅ | ✅ | session store |
| 会话按 workspace 隔离 | ✅ | ✅ | sha256(workspace).slice(0,16) |
| 自动持久化 | ✅ | ✅ | Pi SDK SessionManager 落盘 jsonl |
| **per-workspace 稳定 sessionId** | n/a | ✅ | v0.4.2 step 1,FE configStore 持久化 |
| **Session 文件落盘** | n/a | ✅ | `~/.pi/agent/sessions/<hash>/<timestamp>_<sessionId>.jsonl` |
| **resume session 加载历史** | n/a | ✅ | v0.4.2 step 1 smoke 4/4 PASS |
| **compaction 手动触发** | n/a | ✅ | v0.4.2 step 1 compact_session IPC |
| 会话内容搜索 | 🟡 | 🟡 | mock 有,真后端待测 |
| 归档 (archive) | ❌ | ❌ | 未做 |
| 导出 (Markdown / JSON) | ❌ | ❌ | 未做 |
| 跨设备同步 | ❌ | 🚫 | 明确不做 (数据本机第一) |
| 标签 / 分组 / 收藏 | ❌ | ❌ | 未做 |
| 标题自动生成 (LLM) | n/a | ❌ | 仍固定 "New chat" |
| 删除二次确认 | n/a | ❌ | 仍无 |
| 多 session 并发 (分屏) | n/a | ❌ | 后端协议就绪,UI 未做 |

### 维度 3 · Provider / 模型 / BYOK (provider.md) — **95%**

| 功能点 | spec 状态 | 实际状态 | 备注 |
|---|---|---|---|
| 7 内置 provider | ✅ | ✅ | anthropic/openai/deepseek/moonshot/google/groq/openai-platform |
| 自定义 OpenAI-compatible | ✅ | ✅ | createProvider 工厂 |
| Provider 列表 UI | ✅ | ✅ | ProviderTab |
| 当前激活 provider 标记 | ✅ | ✅ | 但 v0.5.0-PR2 改为 input box 唯一 |
| API key 存 OS keychain | ✅ | ✅ | Windows Credential Manager |
| Key 列表 API (mask) | ✅ | ✅ | `sk-***XYZW` |
| 模型切换 (per provider 多模型) | ✅ | ✅ | — |
| 从 .env 迁移 key | ✅ | ✅ | migrate_from_env |
| Provider 配置持久化到 Rust 文件 | ✅ | ✅ | v0.3.8+ 替代 localStorage |
| Provider 测试连通性 | 🟡 | 🟡 | 已做,错误处理可优化 |
| **Model 5 字段 metadata (type/vision/contextWindow/maxOutput/maxRounds/reasoning)** | n/a | ✅ | v0.4.4.6 inline form |
| **current 标识 tag 归 input box** | n/a | ✅ | v0.5.0-PR2 改,删 radio + 设当前 按钮 |
| 模型参数 per-session (temp/top_p/max_tokens) | ❌ | ❌ | P0 v0.4 |
| 用量统计 / 计费 | ❌ | ❌ | P2 |
| OAuth 登录 | ❌ | ❌ | P2 |
| Key 错误信息脱敏 regex 补全 | ❌ | 🟡 | 6 种 pattern,小众 provider 可能漏 |
| Key 即将过期提示 | n/a | ❌ | — |
| Provider 重命名 | n/a | ❌ | — |
| Provider 导入/导出 | n/a | ❌ | — |

### 维度 4 · Workspace (workspace.md) — **55%**

| 功能点 | spec 状态 | 实际状态 | 备注 |
|---|---|---|---|
| 多 workspace 切换 | ✅ | ✅ | — |
| Default workspace 自动创建 | ✅ | ✅ | `<home>/PiAgent/` |
| Workspace 路径注入 system prompt | ✅ | ✅ | v0.3.8.11 |
| Workspace 列表 UI | 🟡 | 🟡 | Sidebar 下拉 |
| Workspace 添加 (picker) | 🟡 | 🟡 | Tauri dialog 已有 |
| Workspace 文件树浏览 | 🟡 | 🟡 | WorkspaceTree,基础有,深度有限 |
| Workspace 切换 → session pool 切换 | 🟡 | ✅ | v0.4.2 step 1 走 sha256 隔离 |
| **实际文件读/写工具** | n/a | ✅ | v0.4.1 pi-coding-agent 7 tool |
| 文件监听 | ❌ | ❌ | — |
| 索引 / 全文搜索 | ❌ | ❌ | — |
| Git 集成 | ❌ | ❌ | — |
| 文件树右键菜单 (新建/重命名/删除) | n/a | ❌ | — |
| Recent workspaces | n/a | ❌ | — |
| 文件树加载大目录 (1000+) | n/a | 🟡 | 已知会卡 |
| **路径校验 (path traversal 拒绝)** | ❌ (v0.4 必做) | ❌ | **未做** |
| **工具权限 UI (申请读 X → confirm)** | ❌ (v0.4 必做) | 🟡 | Pi SDK Extension ask/smart/allow 模式已接 |

### 维度 5 · Tools (tools.md) — **60%**

| 功能点 | spec 状态 | 实际状态 | 备注 |
|---|---|---|---|
| Tool call 协议 (流式 + UI + 折叠) | ✅ | ✅ | v0.3.8.6+ |
| Pi SDK LLM 客户端集成 | ✅ | ✅ | v0.4.0 |
| Agent loop 集成 | ✅ | ✅ | v0.4.0 |
| 7 tool 集成 (read/write/edit/bash/ls/find/grep) | ✅ | ✅ | v0.4.1 pi-coding-agent 工厂 |
| Step 累加 UI | ✅ | ✅ | v0.4.1 |
| **Tool permission system (ask/smart/allow 3 模式)** | 🟡 (v0.4 必做) | ✅ | v0.4.1 走 Pi SDK Extension,smoke 4/4 PASS |
| **Abort tool** (中断正在跑的 bash + LLM) | ❌ (v0.4 必做) | ✅ | v0.5.0-PR3 stop + 30s 兜底 |
| **Tool result 持久化到 session** | 🟡 (v0.4.2 计划) | ✅ | v0.4.2 step 1 SessionManager 落盘 |
| Tool call history 折叠/展开 | ✅ | ✅ | StepGroup 双重折叠 |
| **path traversal 防御 (`../` / 绝对路径拒绝)** | ❌ (v0.4 必做) | ❌ | **未做** |
| **危险命令黑名单 (`rm -rf /` `mkfs` 等)** | ❌ (v0.4 必做) | ❌ | **未做** |
| 工具名按 pi-coding-agent 实际 emit | ✅ | ✅ | read/write/edit/bash/ls/find/grep |
| Tool result 折叠状态持久化 | n/a | ❌ | session 重开默认展开 |
| Tool call trace UI (debug) | n/a | ❌ | — |
| Tool timeout 配置 (per-tool) | n/a | ❌ | — |
| 用户自定义 tool | n/a | ❌ | v0.6+ |
| Tool marketplace | n/a | ❌ | v1.0+ |
| Tool sandboxing (firejail / docker) | n/a | ❌ | v2.0+ |

### 维度 6 · Memory (memory.md) — **0%** ❌

| 功能点 | spec 状态 | 实际状态 |
|---|---|---|
| 项目级 memory (`./AGENTS.md`) | ❌ | 🟡 (CustomInstructionsTab 编辑,但没自动注入 Pi SDK session) |
| 用户级 memory (`%APPDATA%\...\memory.md`) | ❌ | ❌ |
| 自动从对话提取要点 ("记住这个") | ❌ | ❌ |
| Memory 编辑器 (settings tab) | ❌ | 🟡 (CustomInstructionsTab 部分覆盖) |
| Memory 注入到 system prompt | ❌ | 🟡 (4 段 system prompt 有 project_context 段) |

> **注**: v0.5.0-v0.1 回滚了 multi-agent 后,`AGENTS.md` 编辑走 CustomInstructionsTab (scope: workspace/global),实际是 "Custom Instructions" 取代了 v0.6 Memory spec 中"项目级 memory"。

### 维度 7 · Skills / Slash Command (skills.md) — **75%** (spec 严重滞后)

| 功能点 | spec 状态 | 实际状态 | 备注 |
|---|---|---|---|
| **Pi SDK loadSkills + formatSkillsForPrompt** | ❌ | ✅ | v0.4.4 commit `b02e99e` |
| **Skills store + skills_snapshot 事件** | ❌ | ✅ | v0.4.4 |
| **SkillsTab UI (list + view + add)** | ❌ | ✅ | v0.4.4 |
| **AddSkillForm (本地 .md)** | ❌ | ✅ | v0.4.4.0 |
| **从 URL 导入 (ureq sync HTTP)** | ❌ | ✅ | v0.4.4.5 |
| **从 zip 压缩包导入 (2 种 layout)** | ❌ | ✅ | v0.4.4.4 |
| **Skill 实时刷新 (refreshFromTauri)** | ❌ | ✅ | v0.4.4.6 |
| **System prompt 注入 (4 段: Base/Project/Skills/Context awareness)** | ❌ | ✅ | v0.5.0-v0.1 |
| **skill @ 引用 `[[skill:xxx]]` 嵌入 + preview** | ❌ | ✅ | v0.4.7b (textarea 下面 preview,不是 overlay) |
| **Pi 官方 skill 模板库 (D171 阻塞)** | ❌ | ❌ | Pi SDK 0.84.2 无 builtin,需自实现 catalog |
| 内置 slash command (10 个) | ❌ | 🟡 | v0.4.5.2 只扫 `<workspace>/.pi/commands/*.md` 作为 user 自定义,builtin 22 个不显示 |
| `/help` `/clear` `/model` `/provider` 等 | ❌ | ❌ | P0 1 周内 |
| Composer `/` 触发 command picker | ❌ | 🟡 | SlashPopover 已有 (3 类: skill/agent/mcp, multi-agent 已回滚变 2 类) |
| User 自定义 slash command (`.piagent/commands/*.md`) | ❌ | ✅ | v0.4.5.2 |
| Skill 包 (`.piagent/skills/<name>/SKILL.md`) | ❌ | ✅ | v0.4.4 (走 Pi SDK loadSkills,扫 `{agentDir}/skills/` + `{cwd}/.pi/skills/`) |
| Skill description 在 LLM context 自动 mention 触发 | ❌ | ✅ | Pi SDK 走 system prompt 注入 |
| Skill marketplace | ❌ | ❌ | v1.0+ |
| Skill 版本管理 | ❌ | ❌ | v1.0+ |
| Skill 触发统计 | ❌ | ❌ | v0.7+ |
| Skill 沙箱 | ❌ | ❌ | v0.7+ |
| **skill toggle 自动重启 sidecar (D165 阻塞)** | n/a | 🟡 | 现在改 toggle 需手动重启 .exe |
| **v0.4.7c overlay 渲染 [[skill:xxx]]** | n/a | ❌ | 视觉妥协:textarea 下面 preview 区显示 chip |

### 维度 8 · MCP / 插件 (mcp.md) — **0%** ❌

| 功能点 | spec 状态 | 实际状态 |
|---|---|---|
| MCP server 接入 (stdio transport) | ❌ | ❌ |
| MCP tool 注入到 LLM tool 列表 | ❌ | ❌ |
| MCP 资源 (resources) 支持 | ❌ | ❌ |
| MCP prompt 模板支持 | ❌ | ❌ |
| 本地 / git URL 装 MCP server | ❌ | ❌ |
| MCP marketplace | ❌ | ❌ (v1.0+) |
| 远程 MCP server (SSE transport) | ❌ | ❌ (v0.7+) |

### 维度 9 · Subagent / Plan Mode (subagent.md) — **0%** ❌

| 功能点 | spec 状态 | 实际状态 | 备注 |
|---|---|---|---|
| Task tool 委派子 agent | ❌ | ❌ | — |
| 子 agent 隔离 (独立 session/message/permission) | ❌ | ❌ | — |
| 并行 subagent | ❌ | ❌ | — |
| 子 agent 可见性 UI | ❌ | ❌ | — |
| **Multi-agent persona (主/子 agent 库)** | ❌ | 🚫 (回滚) | v0.4.5.1 + v0.4.6.1 + v0.4.7a + v0.4.5.2 + v0.4.6.2 + v0.4.7b + v0.5.0-PR1 7 commit 全部回滚,v0.5.0-v0.1 user 拍板 single agent design |
| EnterPlanMode / ExitPlanMode tool | ❌ | ❌ | — |
| 计划展示 / 批准 / 拒绝 / 修改 | ❌ | ❌ | — |
| Agent profile (coder/reviewer/docs-writer/data-analyst) | ❌ | ❌ | — |

### 维度 10 · UI / 主题 (ui.md) — **90%**

| 功能点 | spec 状态 | 实际状态 | 备注 |
|---|---|---|---|
| Light / Dark / Auto 三模式 | ✅ | ✅ | v0.3.8.16 |
| 主题持久化 (localStorage) | ✅ | ✅ | ui store |
| 主题应用 `<html data-theme="...">` | ✅ | ✅ | — |
| 暗色对比度 4.5:1+ (WCAG AA) | ✅ | ✅ | v0.3.8.17 redo |
| Primitive ramp 完整覆盖 | ✅ | ✅ | v0.3.8.18+ |
| Minimalist Copy 调色板 | ✅ | ✅ | monochrome |
| 12px radius (sm 6 / md 10 / lg 12 / xl 16) | ✅ | ✅ | — |
| 4px base spacing | ✅ | ✅ | — |
| Border-driven (不靠 shadow) | ✅ | ✅ | 1px border 分层 |
| 5 档嵌套调色板 | ✅ | ✅ | page / card / popover / hover / active |
| 字体 (系统 + mono) | ✅ | ✅ | PingFang/Microsoft YaHei + JetBrains Mono |
| 字号调节 | 🟡 | 🟡 | 基础档 |
| 多语言 (i18n) | ❌ | ❌ | 未做 |
| 自定义 accent color | ❌ | 🚫 | 故意不做 (破坏 monochrome) |
| 主题导出/导入 | ❌ | 🚫 | 不做 |
| 字号 + 语言持久化 | ❌ | ❌ | — |
| Auto 模式监听 OS 主题变化 | n/a | ❌ | 启动时检测,不持续监听 |
| 暗色代码块配色优化 | n/a | 🟡 | 某些 token 不够亮 |
| 高 DPI 屏 border 锐化 | n/a | ❌ | — |
| **滚动条隐藏 (sidebar/dropdown/drawer)** | n/a | ✅ | minimalist 原则 |

### 维度 11 · Desktop 集成 (desktop.md) — **70%**

| 功能点 | spec 状态 | 实际状态 | 备注 |
|---|---|---|---|
| 自定义 title bar (minimize/maximize/close) | ✅ | ✅ | v0.3.8.21+ |
| 窗口尺寸 (1280×800 / min 960×600) | ✅ | ✅ | — |
| OS keychain 集成 | ✅ | ✅ | keyring.rs |
| 进程管理 (sidecar spawn + lifecycle) | ✅ | ✅ | Tauri 2 标准 + LRU 池待加 |
| 文件对话框 | ✅ | ✅ | dialog:default |
| 启动 dragging (title bar drag region) | ✅ | ✅ | — |
| isMaximized 状态查询 | ✅ | ✅ | — |
| **Tauri 2 标准 sidecar 机制 (externalBin + app.shell().sidecar())** | n/a | ✅ | v0.5.8 commit `33fc5fa` (D172) |
| **bun build --compile (standalone .exe 108MB)** | n/a | ✅ | v0.5.6 commit `115959e` (D163) |
| **debug build 自动化 (scripts/build-debug.mjs)** | n/a | ✅ | v0.5.0-PR3 |
| **Windows 11 8px 圆角 + body padding** | n/a | ✅ | v0.3.8.22 |
| **stale binary 修复 (beforeBuildCommand 路径加 ../)** | n/a | ✅ | v0.5.8 hotfix commit `66e7a9a` + hotfix³ commit `0fb669a` (D162 v3 推翻 v2) |
| fs 权限 (capability 白名单) | 🟡 | ❌ | 当前 capabilities 没 `core:fs:allow-*` (沙箱安全) |
| shell 权限 (capability 白名单) | 🟡 | ✅ | v0.5.8 `shell:allow-spawn` |
| Sidecar 进程池 (LRU warm start) | ❌ | ❌ | 仍每 prompt 重新 spawn ~200ms |
| 系统托盘 | ❌ | ❌ | — |
| 全局快捷键 | ❌ | ❌ | — |
| 多窗口 (一个 session 一个窗口) | ❌ | ❌ | — |
| 自动更新 (`tauri-plugin-updater`) | ❌ | ❌ | v1.0 必做 |
| 系统通知 (agent 完成) | ❌ | ❌ | v0.5 |
| Dock / Menu Bar (macOS) | ❌ | ❌ | v0.9 |
| 文件关联 (`.piagent` 双击打开) | ❌ | ❌ | v1.0 |
| 崩溃上报 (`tauri-plugin-sentry`) | ❌ | ❌ | v1.0 |
| WebView2 缓存清掉 | 🟡 | 🟡 | v0.3.8+ 改 Rust 文件持久化缓解 |
| 启动速度依赖 WebView2 加载 | 🟡 | 🟡 | — |
| 开机自启 | n/a | ❌ | — |
| **端到端 NSIS install 7 场景 PASS** | n/a | ✅ | v0.5.9 user 干净机器验证 |

### 维度 12 · 安全 (security.md) — **65%**

| 功能点 | spec 状态 | 实际状态 | 备注 |
|---|---|---|---|
| API Key 走 OS keychain | ✅ | ✅ | Windows Credential Manager |
| API Key 永远不在前端 (FE 只调 hasApiKey) | ✅ | ✅ | — |
| API Key 不进 WS 协议 / stdin 协议字段名 | ✅ | ✅ | Rust → sidecar argv[1] 一次性 |
| API Key 不进日志/错误信息 (401/403 sanitize) | ✅ | ✅ | 6 种 regex 模式 |
| Provider ID 用 `crypto.randomUUID()` 128-bit | ✅ | ✅ | — |
| Sidecar 错误脱敏 (R4) | ✅ | ✅ | key pattern regex 替换 |
| Window 控制权限最小化 (capabilities 白名单) | ✅ | ✅ | — |
| FE 调试只暴露给 DEV (`window.__piTauri`) | ✅ | ✅ | — |
| CSP 严格化 | 🟡 (v0.4 必做) | ❌ | 当前 `csp: null` |
| fs capability 白名单 (只允许 workspace 内) | 🟡 (v0.4 必做) | ❌ | 当前 capabilities 没 `core:fs:allow-*` |
| shell capability 白名单 (只允许安全命令 + workspace cwd) | 🟡 (v0.4 必做) | ❌ | 当前只有 `shell:allow-spawn` |
| **Tool call 权限确认 UI (Pi SDK Extension ask/smart/allow)** | ❌ (v0.4 必做) | ✅ | v0.4.1 + smoke 4/4 PASS |
| **Tool call 审计日志** | ❌ | ❌ | v0.5 |
| **危险命令黑名单 (`rm -rf /` `mkfs` 等)** | ❌ (v0.4 必做) | ❌ | **未做** |
| **路径校验 (path traversal 拒绝)** | ❌ (v0.4 必做) | ❌ | **未做** |
| **网络白名单 (限制 LLM API endpoint)** | ❌ (v0.4 必做) | ❌ | **未做** |
| 进程沙箱 (firejail / docker / Windows Job Object) | ❌ | ❌ | v2.0+ |
| 安全审计 (第三方 review) | ❌ | ❌ | v1.0 |
| 端到端加密 session | ❌ | 🚫 | OS 加密足够 |
| 抗量子加密 / 抗 side-channel | ❌ | 🚫 | v1.x 远期 / v2.0+ |
| 抗本地 rootkit | ❌ | 🚫 | 用户自己负责 OS 安全 |
| **Sidecar 401/403 sanitize (R4)** | n/a | ✅ | v0.3.7 |
| **Window 控制权限最小化 (R1)** | n/a | ✅ | v0.3.7 |

### 维度 13 · 可观测性 (observability.md) — **15%**

| 功能点 | spec 状态 | 实际状态 | 备注 |
|---|---|---|---|
| 基础 console.log | 🟡 | ✅ | FE / Sidecar / Rust 都有 |
| `.tauri-*.log` 文件 | 🟡 | ✅ | Tauri 自动落 stderr/stdout |
| **4 段 system prompt 显式 log (Base/Skills/Context awareness/Project)** | n/a | ✅ | v0.5.0-v0.1,user 端到端能验 |
| **Sidecar 启动 config 详细 log (provider/model/workspace/sessionId/baseUrl/tools)** | n/a | ✅ | v0.5.0-v0.1 line 76 |
| **Skills 加载 log (total/enabled/diagnostics)** | n/a | ✅ | v0.4.4 line 142 |
| 结构化日志 (JSON + level + timestamp + sessionId) | ❌ | ❌ | v0.5 必做 |
| 日志文件轮转 (按大小/时间) | ❌ | ❌ | v0.5 |
| 崩溃自动捕获 (Rust panic / WebView crash) | ❌ | ❌ | v1.0 |
| 崩溃报告 (Sentry / 自建 opt-in) | ❌ | ❌ | v1.0 |
| 性能监控 (启动/内存/帧率) | ❌ | ❌ | v0.5 |
| 用户反馈通道 ("上报问题"按钮) | ❌ | ❌ | v0.7 |
| E2E 测试 (Playwright + Tauri) | ❌ | ❌ | v1.0 |
| 单元测试 | ❌ | ❌ | v1.0 |
| CI/CD | ❌ | ❌ | v0.7 |
| **单元测试覆盖率** | n/a | 0% | — |
| **集成测试覆盖率** | n/a | 0% | — |
| **E2E 覆盖率** | n/a | 0% | — |
| **Sidecar smoke test (.mjs 一次性脚本)** | n/a | ✅ | 10 个 test-smoke-*.mjs (faux/hang-watchdog/permission/session-persistence/v043-compact/v050-rpc/stdin-*) |
| 实时遥测 / A/B test / 性能数据收集 | ❌ | 🚫 | 不向公司服务器上报用户行为 |

### 维度 14 · 协作 / 分享 (sharing.md) — **0%** ❌

| 功能点 | spec 状态 | 实际状态 |
|---|---|---|
| Session 导出 (Markdown / JSON) | ❌ | ❌ |
| Session 分享链接 (端到端加密 + 过期) | ❌ | ❌ |
| 接收方 Web 预览页 (Claude Artifacts 体验) | ❌ | ❌ |
| 设置过期时间 (1天/7天/30天/永久) | ❌ | ❌ |
| 团队空间 (商业化 C 方案需要) | ❌ | ❌ |
| B 端 server 端 | ❌ | ❌ |
| 实时协作 (多用户同时编辑一个 session) | ❌ | 🚫 (不做) |
| 评论 / 点赞 / 关注 | ❌ | 🚫 (不做) |

### 维度 15 · 多平台 (platform.md) — **10%**

| 平台 | spec 状态 | 实际状态 |
|---|---|---|
| **Windows 10/11** | ✅ v0.3+ | ✅ v0.3+ (.msi 46.7MB / .nsis 32.6MB) |
| macOS 13+ (Apple Silicon / Intel / 签名 / 公证) | ❌ | ❌ v0.9 目标 |
| Linux (Ubuntu / Fedora / AppImage / deb / rpm) | ❌ | ❌ v0.9 目标 |
| Web | ❌ | 🚫 (v0.2 已废弃) |
| iOS / Android | ❌ | 🚫 (v1.x 不做) |
| ChromeOS | ❌ | 🚫 (v1.x 不做) |
| CI/CD 多平台自动构建 | ❌ | ❌ |

---

## 4. P0 短期缺口清单 (1 周内可补完)

> 全部是 P0 (table stakes for 2026),走 Pi SDK 暴露,0 风险

| # | 缺口 | 估时 | 依赖 | 来源 |
|---|---|---|---|---|
| 1 | **v0.4.5 Slash command 内置 (10 个: `/help` `/clear` `/model` `/provider` `/workspace` `/compact` `/commit` `/pr` `/review` `/test`)** | 2-3h | v0.4.5.2 slash.ts store 已就绪 | doc/03-features/skills.md §1.1 |
| 2 | **v0.4.6 Project rules (类似 CLAUDE.md, 已有 CustomInstructionsTab,需打通 system prompt 注入)** | 1-2h | CustomInstructionsTab 已存在 | doc/02-roadmap §P0 |
| 3 | **v0.4.7 `/usage` 完整化 (走 Pi SDK usage-totals.ts + 分类聚合 + UI 图表)** | 2h | ContextIndicator 已部分 | doc/02-roadmap §P0 |
| 4 | **v0.4.x polish: skill toggle 自动重启 sidecar (D165 阻塞)** | 1-2h | D165 systemPrompt 不可动态改 | doc/02-roadmap §v0.4.4.x |
| 5 | **v0.4.7c overlay 渲染 [[skill:xxx]]** | 1h | v0.4.7b 已做 preview 区 | doc/02-roadmap §v0.4.7c |
| 6 | **Pi 官方 skill 模板库 (D171 阻塞: 需自实现 catalog)** | 4-6h | D171 Pi SDK 0.84.2 无 builtin | doc/02-roadmap §v0.4.4.x |
| 7 | **Workspace 路径校验 (path traversal 拒绝)** — v0.4 必做 | 1-2h | — | doc/03-features/workspace.md §P0 |
| 8 | **危险命令黑名单 (`rm -rf /` `mkfs` `format` `dd if=` 等)** — v0.4 必做 | 1-2h | — | doc/03-features/tools.md §P0 + security.md §P0 |
| 9 | **CSP 严格化 (`script-src 'self'` 等)** — v0.4 必做 | 1h | — | doc/03-features/security.md §P0 |
| 10 | **fs / shell capability 白名单** — v0.4 必做 | 1-2h | — | doc/03-features/security.md §P0 + desktop.md §P0 |
| 11 | **错误脱敏 regex 补全 (加 `x-` `anthropic-` `minimax-` 等)** | 0.5h | — | doc/03-features/security.md §P0 |
| 12 | **同步 spec 文档状态 (7 个 spec 文件追到 v0.5.0-PR3)** | 1-2h | — | doc/03-features/* §状态栏滞后 |

**P0 估时**: 1 周内 (1 人天 × 5),可全做。

---

## 5. v0.4 必做但仍未做的 4 项 (卡 v0.4 验收)

> spec/02-roadmap §v0.4 验收标准还差这 4 项 (v0.4.1/v0.4.2 step 1 已做 4 项)

| # | 缺口 | spec 验收 | 当前状态 | 阻塞 |
|---|---|---|---|---|
| 1 | **Workspace 路径校验 + 危险命令黑名单** | tool 拒绝 path traversal;`rm -rf /` `mkfs` 等拦截 | ❌ | 同 §4 #7 #8 |
| 2 | **Tool call 权限确认 UI** | 每个 tool call 用户显式 confirm (至少第一次),白名单/黑名单 | 🟡 (Pi SDK Extension ask/smart/allow 模式已接,但 UI 选择 + 白名单/黑名单未做) | 走 Pi SDK 模式 selector UI 待补 |
| 3 | **Token 计数显示** | 输入/输出/总计 | 🟡 (Pi SDK usage 已 emit,ContextIndicator 紧凑显示,但缺完整 UI) | §4 #3 |
| 4 | **fs / shell capability 白名单 + CSP 严格化** | 沙箱化 | ❌ | §4 #9 #10 |

**v0.4 验收补完估时**: 3-5 人天。

---

## 6. 文档同步缺口 (本次梳理发现)

| 文档 | 问题 | 修复建议 |
|---|---|---|
| `doc/03-features/skills.md` | 状态写 ❌ 0%,但实际 v0.4.4 + v0.4.5.2 + v0.4.6 + v0.4.7b 已做完大部分 | 改 ✅ 75% (Pi SDK 暴露 + 3 种导入 + system prompt 注入,剩 builtin slash + catalog + overlay) |
| `doc/03-features/chat-core.md` | 状态写 🟡 80%,但实际 v0.4.2/v0.4.3/v0.4.4/v0.5.0-PR3 已做 | 改 ✅ 95% (加 stop button + 4 段 system prompt + 4 bug 修复 changelog) |
| `doc/03-features/tools.md` | 状态写 🟡 30%,但实际 60% | 改 🟡 60% (加 7 tool 集成 + permission mode + tool result 持久化) |
| `doc/03-features/desktop.md` | 状态写 🟡 50%,但实际 70% | 改 🟡 70% (加 v0.5.6 bun + v0.5.8 Tauri 2 sidecar + debug build) |
| `doc/03-features/security.md` | 状态写 🟡 60%,实际 65% | 微调 |
| `doc/03-features/session.md` | 状态写 🟡 70%,实际 85% | 改 (加 v0.4.2 step 1 per-workspace 隔离 + SessionManager 落盘) |
| `doc/03-features/workspace.md` | 状态写 🟡 40%,实际 55% | 改 (加 pi-coding-agent 7 tool + per-workspace 隔离) |
| `doc/00-product-blueprint.md` §14 维度状态总表 | 7 行已滞后 | 按上面调整同步 |

---

## 7. 商业化前置 (v1.0 release blocker)

| # | 项 | 状态 | 备注 |
|---|---|---|---|
| 1 | **Sidecar 编译成独立 .exe** | ✅ | v0.5.6 bun build --compile,108MB self-contained |
| 2 | **Tauri 2 标准 sidecar 机制 (干净机器 install 真能跑)** | ✅ | v0.5.8 commit `33fc5fa` (D172) |
| 3 | 自动更新 (`tauri-plugin-updater`) | ❌ | v1.0 必做 |
| 4 | 完整用户文档 (`docs/user-guide/`) | ❌ | v1.0 必做 |
| 5 | Crash report (opt-in) | ❌ | v1.0 必做 |
| 6 | 性能审计 (启动/内存/CPU) | ❌ | v1.0 必做 |
| 7 | 完整 E2E 测试 (Playwright + Tauri) | ❌ | v1.0 必做,当前 0% |
| 8 | 安全审计 (key/tool/network) | ❌ | v1.0 必做 |
| 9 | README + LICENSE + 官网 | ❌ | v1.0 必做 |

---

## 8. 立项原则 (摘自 blueprint,避免后续被反复提议)

> **不做**:
> - 云同步 session / 配置 (数据本机第一)
> - 账号系统
> - 多模态生成为主入口 (图/视频是扩展)
> - 移动端 (v1.x)
> - 社交功能 (点赞/关注/feed)
> - 账户余额/付费 token (API key 是用户的)
> - 强制更新
> - 捆绑 IDE (不抢 VSCode / JetBrains 饭碗)

---

## 9. 命名/术语约定

| 术语 | 含义 |
|---|---|
| **Agent** | 在本 app 里指"一次 LLM 调用 + 工具循环",**不**指长期存活的 daemon |
| **Session** | 一个完整对话 + 历史 messages,持久化到本机 |
| **Workspace** | 用户指定的工作目录,agent 知道 cwd |
| **Provider** | LLM 服务商 (Anthropic / OpenAI / 自定义 OpenAI-compatible) |
| **BYOK** | Bring Your Own Key,API key 由用户提供,不经我们 |
| **Tool Call** | LLM 触发调用本地工具 (读文件/跑命令/搜索) |
| **MCP** | Model Context Protocol,第三方工具标准化协议 |
| **Subagent** | 主 agent 委派给子 agent 的子任务 (v0.5.1+ 计划) |
| **Plan Mode** | 先输出计划,等用户确认再执行的模式 (v0.5.0+ 计划) |
| **Skill** | 带 frontmatter 的可复用 prompt 模板 (`.pi/skills/<name>/SKILL.md`) |
| **Slash Command** | 用户在 composer 输入 `/xxx` 触发的预定义指令 |

---

## 10. 后续工作建议 (按 ROI 排序)

### 第一周(1 人 × 5 天)
- [ ] §4 #1-#3 P0 Pi SDK 暴露 (5-7h):Slash 内置 / Project rules 注入 / Usage 完整化
- [ ] §4 #4-#6 v0.4.4.x polish (6-9h):skill toggle 自动重启 / overlay 渲染 / Pi 官方模板
- [ ] §4 #7-#11 v0.4 必做补完 (5-7h):路径校验 / 危险命令 / CSP / fs-shell cap / 脱敏 regex
- [ ] §6 spec 文档同步 (1-2h):7 个 spec 文件追到 v0.5.0-PR3

### 第二/三周(P1 自建)
- [ ] **Tool call 权限确认 UI** (4-6h):ask/smart/allow 模式 selector + 白名单/黑名单
- [ ] **Sidecar 进程池 LRU** (4-6h):解决每次 spawn ~200ms 延迟
- [ ] **结构化日志** (6-8h):JSON + level + timestamp + sessionId + 轮转
- [ ] **性能监控** (4-6h):启动时间 / 内存 / 帧率

### 第四/六周(P1 自建)
- [ ] **v0.5.0 Plan mode** (4-6h):PreToolUse 拦截 + 计划 UI + ExitPlanMode
- [ ] **v0.5.1 Sub-agents (Explore/Plan)** (8-12h):多 sidecar 进程 + 主控协调
- [ ] **v0.5.3 MCP stdio Phase 1** (8-10h):sidecar 启动 stdio MCP server + extensionFactories

### v1.0 release 前
- [ ] **自动更新** (`tauri-plugin-updater`)
- [ ] **完整 E2E 测试** (Playwright + Tauri)
- [ ] **性能审计** + **安全审计** (第三方)
- [ ] **用户文档** + **README + LICENSE + 官网**

---

**状态维护人**: 用户(MiniMax_Spark) + Mavis
**更新时机**: 完成 spec 内一个待办项 → 改本文件对应维度状态 + 在 `doc/03-features/<name>.md` changelog 加一行
**版本**: v1.0 (2026-08-18 20:12 初版)
