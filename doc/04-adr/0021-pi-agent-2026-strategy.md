# ADR-0021: Pi Agent 2026 战略 — 跟 Pi SDK 走 + 自建补缺 (D172 演进版)

**Status**: proposed (2026-08-17, 待 user 拍板)
**Context**: v0.5.9 端到端验证通过后, 跟 Claude Code v2.1.x / Trae v2.0+ / Cursor 3.x 2026 Q2 主流产品对标, 识别 13 项 P0/P1 缺口
**Decider**: 待 user 拍板 (按 "判断题不要罗列 pros/cons 让用户选" 规则, AI 给推荐)

## 当前 Pi SDK 0.84.2 能力盘点

| 能力 | 状态 | 备注 |
|---|---|---|
| 基础对话 / 流式输出 / Markdown | ✅ | |
| Tool calling (7 内置) | ✅ | Read/Write/Edit/Bash/Ls/Find/Grep |
| Thinking blocks | ✅ | 跟 thinking_level 配置 |
| Session memory (per-workspace jsonl) | ✅ | SessionManager 持久化 |
| Compaction (context 压缩) | ✅ | `core/compaction/` 已有, **未走 UI 暴露** |
| Skills (custom capability) | ✅ | `core/skills.ts` 已有, **未走 UI 暴露** |
| Slash commands | ✅ | `core/slash-commands.ts` 已有, **未走 UI 暴露** |
| Project rules (APPEND_SYSTEM.md) | ✅ | 已有, **未走 UI 暴露** |
| Usage tracking | ✅ | `usage-totals.ts` 已有, UI 端基础计数 |
| Permission 二次确认 | ✅ | 走 InlineExtension |
| **Sub-agents** | ❌ | Pi SDK 缺, 需自建 |
| **MCP (Model Context Protocol)** | ❌ | Pi SDK 缺, 需自建 |
| **Plan mode** | ❌ | Pi SDK 缺, 需自建 |
| **Hooks (lifecycle events)** | ❌ | Pi SDK 缺, 需自建 |
| **Auto memory (跨 session)** | ❌ | Pi SDK 缺, 需自建 |
| **Auto mode (智能 permission)** | ❌ | Pi SDK 缺, 需自建 |

**关键发现**: 6 项 P0 缺口 (compaction / skills / slash / rules / usage / permission UX) **全是 Pi SDK 已有功能, 只是没走 UI 暴露**. 1-2 周可全做完.

## 三个战略选项

### A. 跟 Pi SDK 走 (推荐 ✅)

**做法**:
- 短期 (0-6 月): 6 项 P0 + 4 项 P1 = 10 项, 估计 4-6 月周期
- 中期 (6-12 月): 持续同步 Pi SDK 演进, 把 hooks / auto memory 等新能力拉过来
- 长期 (12+ 月): 评估是否走 B/C 方案

**优势**:
- 0 风险 (Pi SDK 已有功能, 纯 UI 暴露)
- 周期短 (P0 1-2 周, P1 2-3 月)
- 完全控制 sidecar 协议, 跟 Tauri 2 集成顺滑 (我们 v0.5.0 RPC 重构基础设施都打好了)
- 跨项目通用 (其他 Pi SDK 集成项目可参考)

**劣势**:
- Pi SDK 缺的能力 (sub-agents / MCP / plan mode) 要自建, 工程量
- 受制于 Pi SDK 演进速度 (Mario Zechner 单人维护, 路线图不一定跟得上)
- 跟 Claude Code 拼功能永远慢半拍 (Claude Code 1 季度发 100+ feature)

### B. 替换 Pi SDK 到底座

**做法**:
- 评估 Anthropic SDK / LangChain / OpenHands / Claude Agent SDK
- 重写 sidecar (~1-2 月) + FE 大量适配
- Pi SDK 放弃, 改新底座

**优势**:
- 拿到完整 Claude Code / Claude Agent SDK 能力 (sub-agents / MCP / hooks 全开)
- 跟主流产品功能同步, 不再慢半拍
- Anthropic / LangChain 社区大, 演进快

**劣势**:
- 工作量大: 1-2 月重写, 期间无法发版
- 失去对底层协议完全控制 (RCP 协议 / tool schema / 持久化格式都跟新底座走)
- 跟 Tauri 2 集成要重新做 (新底座可能没 RPC 模式)
- 切换风险: 新底座可能也有问题, 投入沉没成本

### C. 混合方案

**做法**:
- Pi SDK 当 "agent engine" 跑 RPC
- 额外集成 Anthropic SDK (走 sub-agents + MCP) 当 "advanced engine"
- 简单 chat 走 Pi SDK, 复杂任务走 Anthropic SDK
- 走 feature flag 切换

**优势**:
- 灵活: 简单任务用轻量 Pi SDK, 复杂任务用重型 Anthropic SDK
- 平滑过渡: 不一次性切换, 逐步验证新底座

**劣势**:
- 复杂度高: 两套底座共存, FE 要 feature flag 路由, 协议不一致
- 测试矩阵爆炸: Pi SDK 路径 + Anthropic SDK 路径 + 混合路径
- 长期债务: 两套底座都要维护

## 推荐

**A 方案 (跟 Pi SDK 走 + 自建补缺)**

**理由**:
1. **P0 全部是 UI 暴露, 0 风险**: 6 项 1-2 周搞定, 立即获得 table stakes 能力
2. **P1 自建有控制权**: sub-agents / MCP / plan mode 我们自建, 走 Tauri 2 + 多 sidecar 进程, 跟现有 RPC 模式集成顺
3. **不一次性切换风险**: B 方案风险高, 当前 v0.5.9 验证 PASS, 没必要大动干戈
4. **6 月再评估**: P0+P1 做完 6 月后, 看 Pi SDK 演进 + 我们自建质量, 决定是否走 B/C

**触发切换到 B 方案的条件** (6 月时评估):
- Pi SDK 12 月内没加 sub-agents / MCP / hooks 任意一个
- 我们自建的 P1 质量被用户反馈"不如 Claude Code 体验"
- Pi SDK 维护者停止维护

**触发切换到 C 方案的条件** (12 月时评估):
- Anthropic SDK 演进快, 集成成本降低
- 用户明确要求"要 Claude Code 同款能力"

## 决策点 (user 拍板)

- [ ] 同意 A 方案
- [ ] 或同意 B/C 方案 (需 user 给出具体理由)
- [ ] 或混合 (P0 走 A, P1 评估 B/C)

---

**关联**:
- [05-competitive-analysis-2026.md](../05-competitive-analysis-2026.md) — 43 项功能对比
- [02-roadmap.md](../02-roadmap.md) — P0/P1/P2 重排后的 roadmap
- ADR-0022 (TBD) — Sub-agent 架构
- ADR-0023 (TBD) — MCP 集成方案
