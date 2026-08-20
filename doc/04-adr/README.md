# 04 · Architecture Decision Records (ADR)

> **重大技术决策记录**。为什么当初这么选 / 备选是什么 / 取舍 / 后续怎么 review。
> **写代码前有重大决策先开 ADR**，不靠记忆不靠聊天记录。

## 什么是 ADR

- 一次决策一个 md 文件，文件名 `NNNN-<短名>.md`（NNNN 4 位递增）
- **不可变**：决策落地后不修改原文章节，只追加 `## 后续 Review` 段
- 推翻旧决策：新开 ADR，标 `Supersedes: ADR-XXXX`；旧 ADR 状态改为 `Superseded by ADR-XXXX`
- 包含：背景 / 备选 / 决策 / 后果 / 何时 Revisit
- 模板见 [template.md](template.md)

## 什么时候需要写 ADR

✅ **要写**（重新选型 / 重边界 / 跨模块影响）：
- 选框架/库/SDK 替代方案
- 加新的模块边界（sidecar / Tauri command / store / IPC 协议）
- 改已有架构决策的反方向
- 引入新协议 / 新持久化策略

❌ **不写**（token 级微调）：
- 单个 CSS 值调整 / 文案修改
- 错误信息措辞
- 单 tool / 单 store 内部逻辑
- 这种记 commit message + 代码注释就够了

## Workflow

1. **新功能 / 大改之前**: 读 [README.md](../README.md) 当前状态表, 找相关 ADR
2. **如果有相关 ADR**: 读决策背景和"何时 Revisit" — 决策可能已经过期
3. **如果决策过期**: 改原 ADR 加 `## 后续 Review` 章节（不删原文），同时写新 ADR 标 `Supersedes: ADR-XXXX`
4. **如果决策被推翻**: 新 ADR 替代，旧 ADR 标 `Superseded by ADR-XXXX`
5. **每次 commit 前**: 问自己"这次改动算 ADR 级别吗"，是就新开 ADR，不是就 commit message 简述

## 已记录的决策

> **重写规则 (2026-08-19)**: 旧 doc 全部备份到 `.doc-backup-2026-08-19/`. 新 doc 从零写, ADR 编号重新分配. 旧 ADR 不在下面列表里的, 走 backup 路径查 `.doc-backup-2026-08-19/04-adr/<old-id>.md`.
>
> **ADR 分类 (2026-08-19 立)**: 9 个 Technical ADR (0001-0009, 架构决策) + 8 个 Functional ADR (0010-0017, 业务功能 spec + 核验). 推翻/历史走 0090+.

### Technical ADR (架构 / 选型 / 协议)

| # | 标题 | 状态 | 日期 | 关联 |
|---|---|---|---|---|
| [0001](0001-tauri-2-shell.md) | Tauri 2 桌面壳 | Accepted | 2026-08-12 | - |
| [0002](0002-data-local-byok.md) | 数据本机 + BYOK | Accepted | 2026-08-12 | - |
| [0003](0003-no-ui-library.md) | 不引入 UI 组件库 | Accepted | 2026-08-14 | - |
| [0004](0004-tauri-invoke-listen.md) | Tauri invoke/listen IPC | Accepted | 2026-08-12 | - |
| [0005](0005-pi-sdk-integration.md) | 集成 Pi SDK 0.84.2 | Accepted | 2026-08-16 | - |
| [0006](0006-rpc-mode-migration.md) | v0.5.0 — sidecar 重写走 Pi SDK runRpcMode | Accepted | 2026-08-17 | 0005 |
| [0007](0007-session-management.md) | Session 管理 (per-session + per-workspace 目录隔离) | Accepted | 2026-08-17 → 2026-08-18 翻转 | 0005, 0006 |
| [0008](0008-tool-permission.md) | Tool permission 3 模式 + workspace 沙箱 | Accepted | 2026-08-17 → 2026-08-18 沙箱 | 0005, 0006 |
| [0009](0009-single-agent-design.md) | Single Agent Design | Accepted | 2026-08-18 16:30 | - |
| [0090](0090-multi-agent-persona-superseded.md) | Multi-Agent Persona | **Superseded by 0009** | 2026-08-18 | - |

### Functional ADR (业务模块 spec + 核验)

> **用法**: 每个 functional ADR 含 **功能定义 / 已实现 / 核验方法 / 已知问题 / 后续规划**. 核验时按"核验方法"段走端到端, 跟"已实现"表逐项打勾, 跟"已知问题"逐项确认是否仍存在, 跟"后续规划 P0"决定要不要做.

| # | 模块 | 文档 | 关联技术 ADR |
|---|---|---|---|
| [0010](0010-feature-chat.md) | **Chat** (流式 / Markdown / 思考 / 工具 / Step) | [0010-feature-chat.md](0010-feature-chat.md) | - |
| [0011](0011-feature-session.md) | **Session** (列表 / 切换 / 持久化 / 跨重启) | [0011-feature-session.md](0011-feature-session.md) | 0007 |
| [0012](0012-feature-provider.md) | **Provider / Model / BYOK** (7 内置 + 自定义 + keychain) | [0012-feature-provider.md](0012-feature-provider.md) | 0002 |
| [0013](0013-feature-workspace.md) | **Workspace** (多工作区 / 沙箱 / default) | [0013-feature-workspace.md](0013-feature-workspace.md) | - |
| [0014](0014-feature-tools.md) | **Tools** (7 tool / 3 模式 permission) | [0014-feature-tools.md](0014-feature-tools.md) | 0008 |
| [0015](0015-feature-skills.md) | **Skills / Slash Command** (Pi SDK loadSkills + @ 引用 + 自定义 slash) | [0015-feature-skills.md](0015-feature-skills.md) | 0009 |
| [0016](0016-feature-compaction.md) | **Compaction** (auto + 手动 + 指示器) | [0016-feature-compaction.md](0016-feature-compaction.md) | 0007, 0005 |
| [0017](0017-feature-agents-md.md) | **AGENTS.md** (项目级 system prompt 注入) | [0017-feature-agents-md.md](0017-feature-agents-md.md) | 0009 |
| [0018](0018-feature-mcp.md) | **MCP 集成** (4 command + workspace/global scope + stdio/HTTP/SSE schema + Cherry Studio UI) | [0018-feature-mcp.md](0018-feature-mcp.md) | 0005, 0014 |

**未实施 (规划中, 待开 ADR)**:
- v0.6: Session 标题自动生成 / 删除二次确认 / 导出 / 搜索
- v0.7+: ~~MCP 集成~~ (v0.6.3-rc1 已完成, 见 0018) / Sub-agent / 协作分享 / MCP HTTP+SSE transport (P2-3) / MCP hot reload (P1-5.2)

**不在本目录的旧 ADR**: 见 `.doc-backup-2026-08-19/04-adr/` (重写前的 25 个历史 ADR, 含 v0.3 / v0.4 / v0.5 期间被取代 / 合并的决策). 验证新版 ADR 没问题后可 `git rm -r .doc-backup-2026-08-19/` 彻底删.

## 核验工作流 (2026-08-19 立)

按 functional ADR 逐项核验:

1. **选模块**: 从 8 个 functional ADR 选一个
2. **走"核验方法"段**: 端到端跑一遍, 验证"已实现"表每项
3. **看"已知问题"段**: 确认每个问题是否仍存在 (修了的划掉, 仍存在的标 🔴)
4. **看"后续规划 P0"段**: 决定哪些 P0 要做, 排进当前迭代
5. **更新 ADR**: 验证完, 改"已实现"表 / "已知问题" / "后续规划" (追加 ## 后续 Review 段)
6. **commit**: 跟代码 commit 一起, 写明"ADR-XXXX 核验通过 / 修 Y 问题"

例如核验 session 模块:
```
1. 跑 ADR-0011 §核验方法 3 个端到端 (基础 CRUD / per-workspace 隔离 / per-session 隔离)
2. "标题硬编码" 仍存在 → 标 🔴, 排 P0
3. "v0.4.2 残留字段 per_workspace_session_id" → 仍存在, 决定下个版本清
4. 更新 ADR-0011 状态
```
