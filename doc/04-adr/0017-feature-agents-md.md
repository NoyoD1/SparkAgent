# ADR-0017: AGENTS.md 模块 (项目级 system prompt 注入)

- **状态**: Accepted (v0.6.3-rc1 重新核对, P0 偏差已修)
- **日期**: 2026-08-19 (初版) / 2026-08-22 (v0.6.3-rc1 重核)
- **Type**: Functional
- **Module**: AGENTS.md
- **决策者**: user
- **Relates to**: [0009-single-agent-design](0009-single-agent-design.md) (single agent)

## 功能定义 (应该做什么)

- ✅ Pi SDK ResourceLoader 自动 load `<agentDir>/AGENTS.md` + `<cwd>/AGENTS.md` (及 AGENTS.override.md / CLAUDE.md 等候选, 详见 §"Pi SDK 实际行为" )
- ✅ AGENTS.md 内容注入 system prompt (Pi SDK 用 `contextFiles` 结构化参数, **第 4 段** project_context, 不是第 2 段 — 详见 §"职责边界")
- ✅ Settings → **Agent 守则** tab 编辑 AGENTS.md (v0.6.3-rc1 改业务名 "Custom Instructions" → "Agent 守则")
- ✅ Scope: workspace / global
- ❌ 多文件 project context (e.g. `.pi/context/*.md`) — ADR 初版标 🟡 是错的, 实际 ❌
- ❌ Dynamic system prompt (Pi SDK 0.84.2 reload() API 支持 reload context files, 但 sidecar 没监听 AGENTS.md 文件变化, 等 P2-3)

## Pi SDK 实际行为 (v0.6.3-rc1 重核补的, ADR 初版漏)

### 加载文件名候选 (resource-loader.ts:71)
Pi SDK 0.84.2 `loadProjectContextFiles()` 候选列表:
```ts
const candidates = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
```
按顺序找, 找到第一个就停 (override 优先于普通 AGENTS.md).

**副作用**:
- 从 Claude 项目迁过来的 `CLAUDE.md` 也会被 Pi 自动 load 进 system prompt
- `AGENTS.override.md` 优先级最高, 用于紧急覆盖

### 注入 system prompt 的方式 (不是字符串拼接)
- Pi SDK `DefaultResourceLoader` 把 agentsFiles 存为结构化参数 `contextFiles: Array<{path, content}>`
- `createAgentSessionFromServices` (agent-session.ts:1039-1051) 把 contextFiles 传给 LLM
- Pi SDK 内部 `system-prompt.ts:32-43` 用 `appendSystemPrompt` 方式拼到 system prompt 末尾
- **sidecar 不参与拼接**, 这块是 Pi SDK 职责

## 职责边界 (v0.6.3-rc1 新增)

| 职责 | 谁做 | 代码位置 |
|---|---|---|
| 扫家规本文件 (candidates) | Pi SDK | `pi-sdk/.../core/resource-loader.ts:71, 118-156` |
| 把家规本塞进 LLM (contextFiles) | Pi SDK | `pi-sdk/.../core/agent-session.ts:1039-1051` |
| 渲染 contextFiles 到 system prompt | Pi SDK | `pi-sdk/.../core/system-prompt.ts:32-43` |
| 读 / 写 / 删 AGENTS.md (UI button 背后) | Pi Agent Desktop FE/BE | `CustomInstructionsTab.vue` + `lib.rs:1043-1087` |
| 把 skills 等追加段拼到 system prompt | Pi Agent Desktop sidecar | `sidecar/src/index.mjs:589-616` (5 段拼装) |
| reload AGENTS.md (改完不重启生效) | ❌ **没人做** — 已知 P2-3 等 Pi SDK 0.85+ | — |

## 已实现 (v0.6.3-rc1)

| 功能 | 状态 | 实现位置 | 核验方法 |
|---|---|---|---|
| AGENTS.md 自动 load | ✅ | Pi SDK `DefaultResourceLoader.loadProjectContextFiles` (resource-loader.ts:71, 118) | 写 AGENTS.md, sidecar stderr 看到 5 段含 project_context |
| CLAUDE.md / AGENTS.override.md 也 load | ✅ | 同上 (candidates 列表) | 写 CLAUDE.md 同样生效 |
| 注入 system prompt | ✅ | Pi SDK 内部, 第 4 段 `project_context` (不是第 2 段!) | sidecar stderr log 验证 |
| Agent 守则 tab | ✅ (v0.4.6 集成, v0.5.0-v0.1 回归, v0.6.3-rc1 P0-2 修 typo + 改名) | `CustomInstructionsTab.vue` | 进 Settings → Agent 守则, 编辑 |
| Workspace / Global scope | ✅ (P0-2 fix: FE 主动传 agentDir) | tab 内 scope 切换 + `resolveAgentDir()` helper | 切 scope, 看不同 AGENTS.md |
| **5 段** system prompt log | ✅ (v0.5.0-PR1 初版 4 段, D214 v5 加 skill_realtime 后变 5 段) | sidecar stderr `[sidecar] system prompt: 5 segments [...]` | 跑端到端, 看 stderr |
| 多文件 project context | ❌ | — | (计划 P2-1) |
| Dynamic system prompt | ❌ (sidecar 没监听 AGENTS.md, 等 P2-3) | — | (计划 P2-3) |
| 自动核验脚本 | ✅ (v0.6.3-rc1 P0-1) | `scripts/verify-adr-0017.mjs` | `node scripts/verify-adr-0017.mjs` |

## 5 段 system prompt log 详情 (v0.6.3-rc1 补的)

sidecar 启动时 stderr 打的格式 (index.mjs:333):
```
[sidecar] system prompt: 5 segments [
  base=Pi-SDK-default                              // 第 1 段, Pi SDK 内置
  skills=2(1234 chars)                             // 第 2 段, 我们侧拼 formatSkillsForPrompt
  skill_realtime=约束 LLM 每次用 skill 前读最新文件    // 第 3 段, D214 v5 教训加的
  project_context=AGENTS.md-auto(Pi-SDK)           // 第 4 段, Pi SDK contextFiles
  context_awareness=set                            // 第 5 段, meta-history 修正
]
```

**注意**:
- 第 1/4 段是 Pi SDK 职责, sidecar 不可控
- 第 2/3/5 段是 sidecar 拼的 (index.mjs:580-620)
- ADR 初版说"第 2 段"是错的, 实际 AGENTS.md 落在第 4 段

## 核验方法 (端到端)

### 自动 load
1. 在 workspace 下写 `AGENTS.md`:
   ```markdown
   # Project Rules
   你只用中文回答.
   ```
2. 写全局 `~/.pi/agent/AGENTS.md`:
   ```markdown
   # User Rules
   回答简洁, 每次不超过 50 字.
   ```
3. **重启 sidecar** (P0-4 加"立即重启"按钮, 也可手动 kill)
4. 看 sidecar stderr log: `[sidecar] system prompt: 5 segments [..., project_context=AGENTS.md-auto(Pi-SDK), ...]`
5. 发 "你好", 验证 LLM 用中文 + 简短 (两个 AGENTS.md 都生效)

### Agent 守则 UI
1. 进 Settings → Agent 守则
2. 编辑 workspace AGENTS.md, 写一段新规则
3. 保存 (UI 提示: "Pi SDK 0.84.2 限制: 生效需重启 sidecar ≈200ms")
4. **点 "保存并立即重启"** (P0-4 新加) 或手动重启 sidecar
5. 验证新规则生效 (LLM 行为变)

### Scope 切换
1. Agent 守则 tab, 切 scope = global
2. 编辑 `<agentDir>/AGENTS.md` (UI 顶部显示完整路径, P0-2 后 FE 主动 getAgentDir)
3. 切回 workspace, 看 5 段 log project_context 段变化

## 已知问题 / 技术债

- ❌ **AGENTS.md 改完不重启不生效**: Pi SDK 0.84.2 reload() API 支持但 sidecar 没监听, **P2-3 治本**
- ❌ **多文件 context 路径 (.pi/context/*.md)**: ADR 初版标 🟡 是错的, 完全没做, **P2-1**
- 🟡 **单 AGENTS.md 文件**: 复杂项目装不下 (跟 P2-1 一起治)
- 🟡 **没 syntax 高亮**: 编辑器是纯 textarea (P2-2)
- 🟡 **没 preview**: 改完不知道效果, 要看 stderr log (P1-3)
- 🟡 **没 diff 视图**: 改错只能回滚 (P1-4)
- 🟡 **无大小限制**: 写超长会污染 context window (P1-2 加 8KB/16KB 警告)

## 后续规划 (v0.6.3-rc1 重排)

### P0 (v0.6.3-rc1, 一鼓作气)
- ✅ **P0-1 自动化核验脚本** `verify-adr-0017.mjs` (1 红 6 黄 → 跑出来有偏差就修)
- ✅ **P0-2 修前端 typo**: global scope 主动 `getAgentDir()` 显式传, 不依赖后端 fallback
- ✅ **P0-3 更新 ADR 文档**: 4 段 → 5 段, 第 2 段 → 第 4 段, 标 Pi SDK 实际行为
- ✅ **P0-4 UI 加"保存并立即重启"按钮**: 治 R1 沉默失败

### P1 (v0.6.3-rc1, 用户可观测性)
- **P1-1 端到端核验脚本** `e2e-agents-md.mjs`: 起 sidecar + 抓 log + 发 prompt + 验 LLM 行为
- **P1-2 UI 加 content size 警告**: >8KB 黄字, >16KB 红字 + 阻止保存
- **P1-3 UI 加 preview tab**: 侧栏 markdown render 实时同步
- **P1-4 UI 加 diff 视图**: vs 上次保存的版本

### P2 (v0.7+)
- **P2-1 多文件 project context** `.pi/context/*.md` 自动 load
- **P2-2 Syntax 高亮** (CodeMirror 6)
- **P2-3 fs.watch + debounce** 监听 AGENTS.md → 触发 Pi SDK reload (治本 R1, 等 Pi SDK 0.85+ API 稳定)
- **P2-4 AGENTS.md 模板库** (首次创建给 3-5 个常用模板)

## 变更日志 (v0.6.3-rc1 重核)

| 日期 | 变更 | 出处 |
|---|---|---|
| 2026-08-19 | ADR 初版 (Accepted) | — |
| 2026-08-22 | v0.6.3-rc1 P0-1: 跑 `verify-adr-0017.mjs` 发现 1 红 6 黄 3 绿 | P0-1 自动化核验 |
| 2026-08-22 | v0.6.3-rc1 P0-2: 修 CustomInstructionsTab.vue:44 typo, FE 主动 getAgentDir | P0-2 typo fix |
| 2026-08-22 | v0.6.3-rc1 P0-3: 更新 ADR 状态表 (4 段 → 5 段, 第 2 段 → 第 4 段, 标 Pi SDK 实际行为) | P0-3 文档对齐 |
| 2026-08-22 | v0.6.3-rc1 P0-4: UI 加"保存并立即重启"按钮 | P0-4 UI 改动 |
| 2026-08-23 | v0.6.3-rc1 P1-1: 端到端核验脚本 `smoke-agents-md.mjs` (6 个 invariant, 替代 P1-1 原计划的 e2e — 轻量版, 不需要 LLM key) | P1-1 核验脚本 |
| 2026-08-23 | v0.6.3-rc1 P1-2/3/4: UI 加 content size 警告 (>8KB 黄 / >16KB 红 + 阻止保存) / markdown 实时预览 / diff 视图 (LCS line diff, vs 上次保存) | P1-2/3/4 UI 增量 |
| 2026-08-23 | v0.6.3-rc1 改名: 业务名 "Custom Instructions" → "Agent 守则" (用户可见文字; command/文件名/id 保留稳定) | 用户反馈: 跟 Skills/Slash/MCP/Tools 命名风格统一 |
| 2026-08-23 | v0.6.3-rc1 默认家规本: 写一份"全能私人顾问"出厂设置 (`DEFAULT_GUIDE` 常量), UI 加"用默认家规本" / "恢复默认"按钮 (有内容时弹 confirm 防覆盖) | 用户反馈: 全能 AI 助手, 不预设写代码 |
| 2026-08-23 | v0.6.3-rc1 P2-5: markdown 美化 — 默认 split view (左编辑右预览), 3 模式 toggle (分屏/只编辑/只预览), 宽屏左右并排窄屏 stack | 用户反馈: markdown 渲染后样子 |
| 2026-08-23 | v0.6.3-rc1 **核验通过**: verify-adr-0017.mjs 8 绿 1 黄 1 红 (黄红都是 P2 阶段); smoke-agents-md.mjs 6/6 pass; typecheck 干净; debug build F12 测试正常 | 测试通过, 准备 commit |
