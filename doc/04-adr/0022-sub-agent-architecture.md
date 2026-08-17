# ADR-0022: Sub-agent 架构 — 多个 sidecar 进程 + 主控协调 (短期方案)

**Status**: proposed (2026-08-17, 待 user 拍板)
**Context**: Pi SDK 0.84.2 没原生 sub-agent 支持, 主流产品 (Claude Code / Trae / Cursor) 都有
**Decider**: 待 user 拍板

## 背景

Claude Code / Trae / Cursor 2026 都把 sub-agent 列为旗舰能力:
- Claude Code: 6 内置 sub-agents (Explore/Plan/General/Bash/Claude Code Guide), 支持自定义 + Forked (继承父 context)
- Trae: Builder + Coder dual + 多 agent 并行
- Cursor: up to 8 parallel agents in isolated git worktrees

Pi SDK 0.84.2 0 支持 sub-agent (grep 验证无 `subagent` / `spawnAgent` / `forkAgent`).

## Pi SDK 演进可能性

- Pi SDK 是 Mario Zechner (Badlogic) 单人维护
- 路线图无 sub-agent (Mario 公开 Roadmap 没提)
- 短期内 (0-12 月) Pi SDK 加 sub-agent 概率低
- 我们必须自建

## 三个自建方案

### 方案 A — 多个 sidecar 进程 + 主控协调 (推荐 ✅)

**架构**:
- 主 session: 1 个 sidecar 进程 (现有)
- Sub-agent: 每个 1 个独立 sidecar 进程 (走 `app.shell().sidecar("pi-agent-sidecar")` 复用现有基础设施)
- 主控: FE chat store 路由 prompt 到 sub-agent, 收 sub-agent 流式输出, 合并结果

**Pi SDK sidecar 改造**:
- 加 `mode: "subagent" | "main"` 配置
- main mode: 接 prompt + 内部 sub-agent invocation
- subagent mode: 接 system prompt + 独立 session + 独立 JSONL

**FE 改造**:
- chat store: `sendPromptToSubAgent({ name, prompt, model })` 
- UI: sub-agent 调用可视化 (像 Claude Code 的 sub-agent block)

**优势**:
- 完全复用现有 v0.5.0+ RPC + Tauri 2 sidecar 机制
- 隔离强: sub-agent crash 不影响 main
- 资源可控: sub-agent 走 spawn 临时, 用完 kill
- 走 v0.5.0+ 打好的基础设施, 0 重复造轮子

**劣势**:
- 进程开销: 每个 sub-agent 108 MB (sidecar.exe)
- 启动延迟: sub-agent spawn ~200-300ms
- 通信开销: main ↔ sub-agent 走 FE 协调 (不是 Pi SDK 内置)

### 方案 B — 同一 sidecar 进程内多 session (用 SessionManager)

**架构**:
- 1 个 sidecar 进程, 内部开 N 个 SessionManager (Pi SDK 已支持)
- 主 session 协调 sub-session (走 `runtime.sessionManager.setSessionFile` 切换)

**优势**:
- 单进程, 0 spawn 开销
- 走 Pi SDK SessionManager 已有的隔离

**劣势**:
- 复杂状态管理: 单进程多 session, lock / state 一致性难搞
- crash 影响: 1 个崩全崩
- Pi SDK session 切换有 sync bug (v0.5.4 修过, 但单进程多 session 未实测)

### 方案 C — 跟 Pi SDK 演进, 短期不实现

**做法**:
- v0.5.0+ roadmap 不加 sub-agent
- 等 Pi SDK 演进, 1-2 年后再评估
- 用户用 prompt chain 模拟 (效果差)

**优势**:
- 0 工程量
- 0 风险

**劣势**:
- 跟主流产品功能差距持续扩大
- 复杂任务 (e.g. "refactor 整个 auth module") 用户体验差

## 推荐

**方案 A — 多个 sidecar 进程 + 主控协调**

**理由**:
1. **完全复用 v0.5.0+ 基础设施**: 多 sidecar 进程走 `app.shell().sidecar()`, 跟现有 main sidecar 一致
2. **隔离最强**: sub-agent crash 不影响 main, 资源可控
3. **风险可控**: 短期只支持 2 种 (Explore/Plan), 跟 Claude Code 内置对齐
4. **未来兼容 Pi SDK**: 等 Pi SDK 加 sub-agent, 我们走 plugin layer 替换

**实施时间估计**: 8-12h (v0.5.1 milestone)
- sidecar `mode` config 改造: 1h
- sub-agent spawn 走 Tauri 2 sidecar: 1h
- FE chat store sub-agent routing: 3h
- UI sub-agent block 可视化: 2h
- 测试 + 端到端: 1-2h

## 短期范围 (v0.5.1)

只实现 2 种 sub-agent (对齐 Claude Code 内置):
- **Explore**: 只读, 负责 codebase exploration / 搜索 / 找文件
- **Plan**: 只读, 负责 plan mode 研究 + 写 plan

后续 v0.5.2+ 再加:
- General-purpose (有写权限)
- Bash (只跑 shell)
- 自定义 (user 自建 .pi/agents/*.md)

## 触发重新评估

- Pi SDK 加 sub-agent 后, 评估是否切换到 B 方案 (单进程多 session) 减少进程开销
- 用户反馈 sub-agent 启动慢 / 资源占太多时, 走 B 方案

## 决策点 (user 拍板)

- [ ] 同意 A 方案
- [ ] 或 B 方案
- [ ] 或 C 方案 (不实现)

---

**关联**:
- [05-competitive-analysis-2026.md](../05-competitive-analysis-2026.md) — sub-agent 缺口分析
- ADR-0021 — Pi Agent 2026 战略
- ADR-0023 (TBD) — MCP 集成方案
