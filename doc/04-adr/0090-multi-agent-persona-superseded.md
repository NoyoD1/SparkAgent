# ADR-0090: Multi-Agent Persona — **Superseded by [0009-single-agent-design](0009-single-agent-design.md)**

- **状态**: Superseded (2026-08-18 16:30)
- **日期**: 2026-08-18 (提出), 2026-08-18 16:30 (被 0009 取代)
- **决策者**: user (拍板回滚)
- **Superseded by**: [0009-single-agent-design](0009-single-agent-design.md)

## 状态说明

这个 ADR 是 v0.4.5.1 ~ v0.5.0-PR1 期间往 multi-agent persona 方向做的尝试. user 2026-08-18 16:24 拍板"single agent design", v0.5.0-v0.1 整体回滚 (1 commit, 13 文件). 完整回滚记录 + 教训看 [0009](0009-single-agent-design.md).

**这个 ADR 文件本身不再追加内容, 仅作为历史 reference 保留**. 想了解 multi-agent 怎么实现, 看 backup 目录 `.doc-backup-2026-08-19/04-adr/0024-multi-agent-persona.md`.

## 历史脉络 (5 commit + 1 PR 全部推测错方向)

| Commit / PR | 内容 | 为什么错 |
|---|---|---|
| v0.4.5.1 (7b8f833) | 删 Slash tab | 推测错, 后续 v0.4.5.2 恢复 |
| v0.4.6.1 (e2ece2a) | Sidebar "AGENT 团队" group + Composer 顶部 agent selector + Settings → Agents tab | user 16:24 反对 "切 agent" 心智模型 |
| v0.4.6.2 (5ee616e) | per-session 切主 agent | 同上 |
| v0.4.7a (fa8412c) | Composer `/` popover 3 类 (skill / agent / mcp) | 含 Agents 段, 后续回滚 |
| v0.4.7b (538d4d6) | skill @ 引用 | **保留** (跟切 agent 无关) |
| v0.5.0-PR1 (2f21394 + 4b32b7d) | DEFAULT marker + ensureDefaultAgent | 同 v0.4.6.1 反对 |
| v0.5.0-v0.1 (1 commit) | 整体回滚, 改 13 文件 | user 16:24 拍板 single agent |

## 教训 (D184 + D186)

**D184 v6/v7/v8/v9 现场重演 5 次** (2026-08-18):
- 每次都得按 user 原话字面理解, 不靠 session summary 推论
- 5 commit + 1 PR 全部推测错方向, user 16:24 拍板回滚

**D186 教训累计 5 次**:
- 现场重演 v6 + v7 + v8 + v9 + v10 全部推测试错方向
- 写完代码 + 测完不算 self-verify, 必须按 user 原话字面 + grep 实际行为

## 何时 Revisit

- 用户明确要 sub-agent 协作 → 评估 sub-agent architecture (v0.7+)
- 多人 / 多任务 协作需求出现 → 重新评估 multi-agent
