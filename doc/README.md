# Pi Agent

> **状态**: 🟢 核心可用 · 14 个 feature 维度持续完善
> **当前版本**: v0.5.9+ (build bugfix-m 已 land, 2026-08-19)
> **架构**: Tauri 2 + Node sidecar (Pi SDK 0.84.2 `runRpcMode` + `createAgentSessionRuntime`)

---

## 一句话

本地优先的 AI Agent 桌面客户端。所有对话历史 / provider 配置 / API key 都在本机, 不上云, 不收集数据。

类似 Claude Code web 体验, 但桌面原生 + 数据本机 + BYOK + 多 provider。

---

## 技术栈

| 层 | 选型 | 关键 ADR |
|---|---|---|
| Shell | Tauri 2 (Rust) + WebView2 | [0001](04-adr/0001-tauri-2-shell.md) |
| Frontend | Vue 3 + Pinia + TypeScript + Vite (自研 Minimalist Copy) | [0003](04-adr/0003-no-ui-library.md) |
| Sidecar | Node.js + Pi SDK 0.84.2 (走 `runRpcMode`) | [0005](04-adr/0005-pi-sdk-integration.md) + [0006](04-adr/0006-rpc-mode-migration.md) |
| LLM | 7 内置 provider + 任意 openai-compatible | [0005](04-adr/0005-pi-sdk-integration.md) (6 字段必填) |
| 持久化 | 数据本机 (Rust `config_store.rs` + Pinia localStorage) | [0002](04-adr/0002-data-local-byok.md) |
| 鉴权 | OS keychain (Windows Credential Manager) | [0002](04-adr/0002-data-local-byok.md) |
| FE ↔ Tauri | Tauri invoke/listen (无 WebSocket) | [0004](04-adr/0004-tauri-invoke-listen.md) |

---

## 当前状态 (v0.5.9+)

### ✅ 核心可用 (端到端验证 PASS, user 装 MSI/NSIS 跑过)

- 多 provider 配置 + 切换 (anthropic / openai / deepseek / moonshotai / google / groq / openai-compatible)
- 多 workspace 隔离 + 沙箱 (write/edit tool 限制在 workspacePath 内, 防 LLM 误改客户端自身目录)
- 7 个内置 tool: `read` / `write` / `edit` / `bash` / `ls` / `find` / `grep`
- 流式对话 + tool call + 思考过程展示
- 短期记忆 (per-session 持久化到 Pi SDK SessionManager, per-workspace 目录 hash 隔离)
- Tool permission 3 模式: `ask` (每次确认) / `smart` (读类自动放行) / `allow` (全放行)
- LLM 失败 5x 指数退避重试 (Pi SDK `auto_retry_*` 内置)
- Stream hang 30s watchdog (Pi SDK 内置)
- Auto-compaction: context window 用到 90% 自动压缩历史
- 手动 compaction (Composer 按钮触发, 走 Pi SDK `compact` RPC 命令)
- Skills (Pi SDK `loadSkills`, 走 `<workspace>/.pi/skills/*.md` 或 user 加 path)
- 自定义 slash command (`<workspace>/.pi/commands/*.md`)
- AGENTS.md 自动 load (Pi SDK `DefaultResourceLoader` 自动读 `<workspace>/AGENTS.md` + `<agentDir>/AGENTS.md`)
- Single agent design (跟 Pi SDK 默认对齐, 不切多 persona)
- Stop 按钮 (30s 兜底强制停, 防 abort lost 卡住)
- Step 累加 UI (1 turn = 1 step group, Cursor 风格)

### 🟡 持续完善 (能用但有边角 case)

- Session 列表 UX (workspace 切换 loading flash)
- Context window 实时指示 (数字 + 70% 高亮, 但跟 manual compact 联动待 polish)
- Compaction 触发时机 (Pi SDK `shouldCompact` 内部, FE 端只显示结果)
- Stop 按钮的 abort 兜底 (Pi SDK `abort` 在某些 OpenAI-compatible provider 上偶发 lost, 30s 强制 set streaming=false)
- Model metadata form (ProviderTab ⚙️ inline edit, 边角校验)

### ❌ 还没做 (按优先级)

**P0 (v0.6 必做)**:
- Session 标题自动生成 (接 LLM 总结第一条 user 消息)
- Session 删除二次确认 (目前走 `confirm()`, 想换 in-app 弹窗)
- Session 导出 (Markdown / JSON / 含 tool calls)
- Session 搜索 (跨 session 关键词)
- Stop 按钮 UX 优化 (abort lost 根因)

**P1 (v0.6 - v0.7)**:
- Session 归档 (Archive 视图)
- Session 标签 / Pin
- 多 session 并发 (现在 1 个 active, 协议已就绪, UI 没收)
- 跨 workspace 共享上下文 (per-session 隔离的反向需求)

**P2 (v0.7+)**:
- MCP 集成 (ADR-0023 规划)
- Subagent (ADR-0022 延期, 跟 single agent 兼容后再开)
- Voice / Notepads / Hooks
- 协作 / 分享 (session 分享链接)

---

## 架构 (v0.5.0+ RpcMode 模式)

```
┌─────────────────────────────────────────────────┐
│ Vue 3 Frontend (app/)                           │
│  - Pinia stores (session / chat / config / ...)│
│  - 订阅 'chat:event' 拿 RpcEvent stream        │
│  - get_state 拉全状态, events 增量更新          │
└────────────────┬────────────────────────────────┘
                 ↕ invoke/listen (Tauri 2 IPC)
┌────────────────┴────────────────────────────────┐
│ Tauri 2 + Rust (src-tauri/)                     │
│  - spawn sidecar (bundle.externalBin)           │
│  - stdio 透传 (Tauri 端不解析 RpcCommand)        │
│  - config_store.rs 持久化 AppConfig             │
│  - keyring 持 API key                            │
└────────────────┬────────────────────────────────┘
                 ↕ stdio (JSONL RpcCommand / RpcEvent)
┌────────────────┴────────────────────────────────┐
│ Node sidecar (sidecar/src/index.mjs, ~600 行)   │
│  - 第 1 行: FE config (workspacePath / provider │
│    / model / apiKey / baseUrl / sessionId /     │
│    thinkingLevel / permissionMode / skills)     │
│  - 后续 RpcCommand (prompt / abort / set_model │
│    / set_thinking_level / compact / ...)        │
│  - Pi SDK runRpcMode 接管 stdin/stdout          │
│  - Pi SDK 5x retry + 30s hang watch 内置        │
│  - PermissionExtension 走 Pi SDK pi.on("tool_  │
│    call") + workspace 沙箱校验                  │
└────────────────┬────────────────────────────────┘
                 ↕ 完全委托
┌────────────────┴────────────────────────────────┐
│ @earendil-works/pi-coding-agent 0.84.2          │
│  ✓ runRpcMode (接管 stdin/stdout + backpressure)│
│  ✓ createAgentSessionRuntime (完整 lifecycle)   │
│  ✓ SessionManager (per-workspace 隔离 + resume) │
│  ✓ AgentSession.subscribe (40+ events)          │
│  ✓ 7 tool (read/bash/edit/write/grep/find/ls)  │
│  ✓ 5x retry + 30s hang watch (内置)            │
│  ✓ auto_compaction (shouldCompact)              │
│  ✓ Extension API (pi.on("tool_call") 拦截)     │
│  ✓ AGENTS.md 自动 load (ResourceLoader)         │
│  ✓ Skills + slash command 加载                  │
└─────────────────────────────────────────────────┘
```

---

## 14 个 Feature 维度状态

> **为什么这里只有一个表, 没有 03-features/ 目录**: 之前写过 14 个 feature spec, 跟代码脱节严重 (user 2026-08-19 feedback "docs are outdated and conflict with code"). 改用"一张总览表 + 关键 spec 随用随写"模式, 等 feature 稳定再单独建 03-features/.

| # | 维度 | 状态 | 关键实现 | Functional ADR | 备注 |
|---|---|---|---|---|---|
| 1 | **Chat 核心** (流式 / Markdown / 思考 / 工具) | 🟡 80% | `app/src/components/ChatMain/` + `app/src/stores/chat.ts` | [0010](04-adr/0010-feature-chat.md) | 缺 Stop UX / 重试单消息 / Token 计数 |
| 2 | **Session 管理** (列表 / 切换 / 持久化) | 🟡 50% | `app/src/stores/session.ts` + `app/src/components/Sidebar/WorkspaceTree.vue` + `sidecar/src/index.mjs` | [0011](04-adr/0011-feature-session.md) | per-session 独立 piSessionId + SessionManager 自动落盘; 缺标题自动生成 / 二次确认 / 导出 / 搜索 |
| 3 | **Provider / 模型 / BYOK** | ✅ 90% | `src-tauri/src/config_store.rs` + `app/src/stores/config.ts` | [0012](04-adr/0012-feature-provider.md) | 7 内置 + openai-compatible 自定义; keychain 持久化 |
| 4 | **Workspace** (多工作区 / 沙箱) | 🟡 60% | `app/src/components/Sidebar/` + sidecar `isPathWithinWorkspace()` | [0013](04-adr/0013-feature-workspace.md) | write/edit 沙箱, bash 由 permission 兜底 |
| 5 | **Tools** (7 tool / 3 模式 permission) | 🟢 80% | `sidecar/src/index.mjs` (PermissionExtension) + Pi SDK 7 工具工厂 | [0014](04-adr/0014-feature-tools.md) | 全部走 Extension API `pi.on("tool_call")` |
| 6 | **Memory** (跨会话 / 项目级 / 用户级) | 🟡 30% | Pi SDK SessionManager (短期) + AGENTS.md (项目级) | (待开 ADR) | 长期 memory (跨 session 项目笔记) 没做 |
| 7 | **Skills / Slash Command** | 🟡 60% | Pi SDK `loadSkills` + `workspace/.pi/commands/*.md` | [0015](04-adr/0015-feature-skills.md) | Skill 引用走 `[[skill:xxx]]` 标记, send 拼到 prompt 前面 |
| 8 | **MCP / 插件** | ❌ 0% | ADR-0023 规划 | (待开 ADR) | 等 v0.7 |
| 9 | **Subagent / Plan mode** | ❌ 0% | ADR-0022 规划 | (待开 ADR) | single agent design 之后再说 |
| 10 | **UI / 主题** | ✅ 90% | `app/src/styles/` + Minimalist Copy design system | (待开 ADR) | Light/Dark/Auto |
| 11 | **Desktop 集成** (窗口 / 托盘 / 快捷键) | 🟡 50% | `src-tauri/src/` | (待开 ADR) | 托盘 + 全局快捷键还没做 |
| 12 | **安全** (key 加密 / 沙箱 / 错误脱敏) | 🟡 70% | `keyring` + workspace sandbox + 401/403 sanitize | (待开 ADR) | 没做端到端 audit |
| 13 | **可观测性** (日志 / 监控 / crash) | 🟡 20% | `src-tauri/src/debug_log` + console + FE console | (待开 ADR) | 没接正式 metrics |
| 14 | **协作 / 分享** (session 导出 / 分享) | ❌ 0% | 规划中 | (待开 ADR) | 等 v0.7+ |

---

## Roadmap

### v0.5.x (当前迭代, 2026-08 中 ~ 2026-08 下)
- ✅ v0.5.0 sidecar 重写走 Pi SDK `runRpcMode` (836 → ~600 行 wrapper)
- ✅ v0.5.4 sync sessionManager history → agent.state.messages (避免"答第一次对话" bug)
- ✅ v0.5.5 DeepSeek V4 Flash `context_awareness` 段 (修幻觉)
- ✅ v0.5.6 bun compile sidecar → 独立 .exe (D163 跨项目规则)
- ✅ v0.5.8 Tauri 2 标准 sidecar 机制 (D172 跨项目规则, `bundle.externalBin` + `app.shell().sidecar()`)
- ✅ v0.5.9 端到端验证 PASS (user 干净 Windows 机器装 NSIS, 7 场景全过)
- 🟡 bugfix-a ~ bugfix-m (13 commit, polish + 边角 case 修)

### v0.6 (下一波, 2026-09 目标)
- P0 收尾: Session 标题自动生成 / 删除二次确认 / 导出 / 搜索
- Stop UX 优化 (abort lost 根因排查)
- 多 session 并发 UI (协议已就绪)
- Compaction UI polish (ContextIndicator 紧凑指示器 + popover)

### v0.7+ (远期)
- MCP 集成 (ADR-0023)
- Subagent (ADR-0022, 跟 single agent 兼容)
- Web app (v0.7)
- Voice / Hooks / Notepads
- 协作 / 分享

---

## 本地开发

```bash
# 前端 (Vue 3 + Vite)
cd app
pnpm install
pnpm dev          # 启 Vite dev server (HMR)

# 桌面 app (Tauri 2 + sidecar)
cd ..
cargo tauri dev   # 启 WebView2 + 自动 spawn sidecar

# 生产 build
cargo tauri build                # release .exe / .msi / .nsis
node scripts/build-debug.mjs     # debug .exe (24MB, devtools 开)
```

**关键路径**:
- `app/` — Vue 3 前端
- `src-tauri/` — Tauri 2 + Rust (sidecar spawn / config_store / keyring)
- `sidecar/` — Node sidecar (Pi SDK wrapper + 业务逻辑)
- `pi-sdk/` — `@earendil-works/pi-coding-agent` 0.84.2 源码 (reference only, 不进 git)

---

## 已知问题

- **Sidecar 启动开销**: 每次 `send_prompt` 新 spawn node 进程 (~150-300ms), Pi SDK 启动走完整 ResourceLoader + ExtensionRunner + SettingsManager
- **Workspace 切换 loading flash**: 切 workspace 时 sidecar 重启, session 列表会跳变
- **Session 文件膨胀**: 长对话 + tool calls 累积, `~/.pi/agent/sessions/<hash>/<ts>_<id>.jsonl` 可能上 MB
- **Session 残留**: 用户删 workspace 后, `~/.pi/agent/sessions/<hash>/` 目录残留
- **Stop 按钮 abort lost**: Pi SDK `abort` 在某些 OpenAI-compatible provider 上偶发 `agent_end` 没 emit, 跑马灯卡住 (30s 强制 set streaming=false 兜底)
- **Workspace sandbox 仅 write/edit**: `read` / `ls` / `grep` / `find` 不强制, `bash` 走 permission 兜底 (用户确认后才放行)

---

## 变更日志 (Changelog)

**只看近 30 天, 详细 commit 列表 git log**

- **2026-08-19 · v0.5.9+** · **doc/ 全部重写** (user 反馈旧 docs 跟代码脱节, 删 .doc-backup-2026-08-19/ 备份, 新 doc 走极简 README + ADR 模式)
- **2026-08-19 · bugfix-m** · 最后一次 polish commit
- **2026-08-18 ~ 19 · bugfix-a ~ l** · 13 commit 边角 case 修 + Stop 30s 兜底 + stepText 显示
- **2026-08-18 · v0.5.0-v0.1** · 回滚 multi-agent persona, 走 single agent design (ADR-0025)
- **2026-08-18 · v0.5.0-PR2** · Provider 详情面板只管 enabled, current 归 input box
- **2026-08-18 · v0.5.0-PR3** · stepText + stop 30s 兜底 + debug build 自动化
- **2026-08-18 · v0.4.7b** · skill @ 引用 `[[skill:xxx]]` 嵌入 prompt
- **2026-08-18 · v0.4.6.2** · per-session 切主 agent (后续被 single agent design 取代)
- **2026-08-18 · v0.4.6** · AGENTS.md 自动 load
- **2026-08-18 · v0.4.5.2** · Slash tab 恢复 (D184 v9 修正)
- **2026-08-18 · v0.4.4.6** · model metadata 5 字段 (type/vision/contextWindow/maxOutput/maxRounds/reasoning)
- **2026-08-18 · v0.4.4** · Skills + AGENTS.md 集成 (Pi SDK D165 systemPrompt 不可动态改, 必须重启)
- **2026-08-18 · v0.4.3** · Compaction UI (ContextIndicator 紧凑指示器)
- **2026-08-17 · v0.5.8** · Tauri 2 标准 sidecar 机制 (`bundle.externalBin` + `app.shell().sidecar()`)
- **2026-08-17 · v0.5.6** · bun compile sidecar → 独立 .exe
- **2026-08-17 · v0.5.4** · sync sessionManager history → agent.state.messages (v0.5.0 重构引入 bug 修)
- **2026-08-17 · v0.5.0** · sidecar 重写走 Pi SDK `runRpcMode` (836 → ~600 行 wrapper)
- **2026-08-17 · v0.4.2 step 1** · `createAgentSession` + `SessionManager` per-workspace 隔离 (后续被 v0.4.5.x per-session 翻转)
- **2026-08-17 · v0.4.1** · 7 tool 集成 + step 累加 UI
- **2026-08-16 · v0.4** · Pi SDK 集成 (anthropic / openai / deepseek / moonshotai / google / groq / openai-compatible)

---

## ADR 索引

所有 ADR 在 [04-adr/](04-adr/) 目录, **不可变** (决策落地后不改原文, 只追加 ## 后续 Review 段). 推翻用 `Superseded by ADR-XXXX` 标注, 新 ADR 在头部加 `Supersedes: ADR-XXXX`.

> **重写说明 (2026-08-19)**: 旧 doc 全部备份到 `.doc-backup-2026-08-19/`. 新 doc ADR 编号从 0001 重新分配, 反映 v0.5.9+ 实际状态. 旧 25 个 ADR 在 backup 里, 验证新版没问题后可 `git rm -r .doc-backup-2026-08-19/` 彻底删.
>
> **ADR 分两类 (2026-08-19 立)**:
> - **Technical** (0001-0009): 架构决策, "为什么这么选"
> - **Functional** (0010-0017): 业务模块 spec + 核验, "应该做什么 / 怎么验"

**18 个 ADR (按时间)**:

**Technical (9)**:

| # | 标题 | 状态 |
|---|---|---|
| [0001](04-adr/0001-tauri-2-shell.md) | Tauri 2 桌面壳 | Accepted |
| [0002](04-adr/0002-data-local-byok.md) | 数据本机 + BYOK | Accepted |
| [0003](04-adr/0003-no-ui-library.md) | 不引入 UI 组件库 | Accepted |
| [0004](04-adr/0004-tauri-invoke-listen.md) | Tauri invoke/listen IPC | Accepted |
| [0005](04-adr/0005-pi-sdk-integration.md) | 集成 Pi SDK 0.84.2 (6 字段必填踩坑) | Accepted |
| [0006](04-adr/0006-rpc-mode-migration.md) | v0.5.0 sidecar 重写走 Pi SDK `runRpcMode` | Accepted |
| [0007](04-adr/0007-session-management.md) | Session 管理 (per-session + per-workspace 目录隔离) | Accepted |
| [0008](04-adr/0008-tool-permission.md) | Tool permission 3 模式 + workspace 沙箱 | Accepted |
| [0009](04-adr/0009-single-agent-design.md) | Single Agent Design | Accepted |
| [0090](04-adr/0090-multi-agent-persona-superseded.md) | Multi-Agent Persona | **Superseded by 0009** |

**Functional (8, 核验用)**:

| # | 模块 | 用途 |
|---|---|---|
| [0010](04-adr/0010-feature-chat.md) | Chat | 流式 / Markdown / 思考 / 工具 / Step |
| [0011](04-adr/0011-feature-session.md) | Session | 列表 / 切换 / 持久化 / 跨重启 |
| [0012](04-adr/0012-feature-provider.md) | Provider / Model / BYOK | 7 内置 + 自定义 + keychain |
| [0013](04-adr/0013-feature-workspace.md) | Workspace | 多工作区 / 沙箱 / default |
| [0014](04-adr/0014-feature-tools.md) | Tools | 7 tool / 3 模式 permission |
| [0015](04-adr/0015-feature-skills.md) | Skills / Slash | 加载 / 启用 / @ 引用 / 自定义 slash |
| [0016](04-adr/0016-feature-compaction.md) | Compaction | auto / 手动 / 指示器 |
| [0017](04-adr/0017-feature-agents-md.md) | AGENTS.md | 项目级 system prompt 注入 |

**未实施 (规划中, 待开 functional ADR)**:
- v0.6: Session 标题自动生成 / 删除二次确认 / 导出 / 搜索 (实施时开 ADR)
- v0.7+: MCP 集成 / Sub-agent / 协作分享

**核验工作流** (走 functional ADR):
1. 选模块 → 走 ADR "核验方法" 段 → 验证 "已实现" 表每项
2. 看 "已知问题" 段 → 确认每个问题是否仍存在
3. 看 "后续规划 P0" 段 → 决定排进当前迭代
4. 更新 ADR (追加 ## 后续 Review) + commit

详细见 [04-adr/README.md](04-adr/README.md) "核验工作流" 段.

---

## 备注

- **备份**: 重写前的 doc 在 `.doc-backup-2026-08-19/` (46 文件), gitignore 已加 `.doc-backup-*`. 验证新版没问题后, 可 `git rm -r .doc-backup-2026-08-19/` 彻底删
- **写法约定**: 这个 README 是 "single source of truth" — feature 状态 / 限制 / roadmap 全部在这. 03-features/ 暂不开, 等 feature 稳定了再拆
- **更新规则**: 改完代码后 → 同步改本 README 对应章节 + ADR 加 ##后续 Review (重大变更). 状态变化 (🟡 → ✅) → 同步改表里那行
