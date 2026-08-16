# Subagent / Plan Mode

> 状态: ❌ 0%
> 最后更新: 2026-08-16
> spec 涉及: v0.7 phase 新增

---

## 1. Spec

**Subagent = 主 agent 委派给子 agent 的独立子任务**。**Plan Mode = 先输出计划，等用户确认再执行**。两者都依赖稳定的 tool call（v0.4+）。

### 1.1 必备能力（v0.7 必做）

#### Subagent
- ❌ **Task tool**：主 agent 调 Task 工具启动子 agent
  - 传入任务描述 + context
  - 子 agent 跑独立 conversation
  - 结果回传主 agent
- ❌ **子 agent 隔离**
  - 独立 session ID
  - 独立 message history
  - 独立 tool permission
- ❌ **并行 subagent**：主 agent 一次启动多个子 agent
- ❌ **子 agent 可见性**：UI 显示"主 agent 委派 task #3 给子 agent"
- ❌ **子 agent 复用**：相同任务不重启

#### Plan Mode
- ❌ **EnterPlanMode tool**：agent 输出计划而不是直接执行
- ❌ **计划展示**：UI 友好显示"agent 想做这 5 件事"
- ❌ **ExitPlanMode tool**：用户批准 / 拒绝 / 修改计划
- ❌ **批准后自动执行**

#### Agent Profile
- ❌ **多 agent 配置**：不同 agent 用不同 system prompt + tool 白名单
- ❌ **Settings → Agents**：CRUD agent profile
- ❌ **内置 profile**：`coder` / `reviewer` / `docs-writer` / `data-analyst`

### 1.2 未来能力

- ❌ Agent 之间的 communication 协议 — v0.7+
- ❌ Agent 协同任务编排（DAG / state machine）— v0.8
- ❌ Agent 学习（跑完任务后总结经验到 memory）— v0.7

### 1.3 不做什么

- ❌ 自主 agent（agent 自己跑、不需要 user）— **不做**（用户必须能随时中断）
- ❌ Agent 市场（卖 agent profile）— v2.0+
- ❌ Agent 之间的八卦 / 聊天 — 不做

---

## 2. 当前实现

**没有**。当前只有 1 个"主 agent" 概念，subagent 完全没做。

---

## 3. 已知问题 / 限制

N/A

---

## 4. 待办（Roadmap）

### P0（v0.7 必做）

#### Subagent
- [ ] Task tool 实现
- [ ] 子 agent 独立 session
- [ ] 子 agent UI 嵌套展示
- [ ] 并行 subagent

#### Plan Mode
- [ ] EnterPlanMode / ExitPlanMode tool
- [ ] 计划 UI 展示
- [ ] 批准 / 拒绝 / 修改

#### Agent Profile
- [ ] Profile 数据结构 + 持久化
- [ ] 4 个内置 profile
- [ ] Profile 切换 UI

### P1（v0.7 - v0.8）
- [ ] Agent 协同任务编排
- [ ] Agent 学习（任务后 memory 写入）
- [ ] 子 agent 性能 / 成本统计

### P2（v0.8+）
- [ ] 远程 agent（多用户协同时需要）
- [ ] Agent marketplace

---

## 5. Changelog

N/A
