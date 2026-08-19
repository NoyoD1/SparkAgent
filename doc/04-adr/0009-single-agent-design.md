# ADR-0009: Single Agent Design (1 通用 agent, 不切多 persona)

- **状态**: Accepted
- **日期**: 2026-08-18 16:30
- **决策者**: user
- **Supersedes**: [0090-multi-agent-persona](0090-multi-agent-persona-superseded.md)

## 背景

AI Agent 客户端要不要支持"切 agent" (类似 Cursor / Trae / Claude Code 的 agent 库)?

v0.4.5.1 + v0.4.6.1 + v0.4.6.2 + v0.4.7a + v0.4.7b + v0.5.0-PR1 = 5 commit + 1 PR 都往"multi-agent persona"方向做.

user 2026-08-18 16:24 反馈 (原话): "我开发的应该是一个通用 agent, 它永远是 1 个 agent, 一些子 agent 只是像你之前规划的, 用于分工工作的, 处理什么问题是由我们本主线程决定的, 而不是一定需要我们主动去选择. agent team 其实是以以前的那种思维, 现在 agent 更像是一个边界定义 / 思维指导. 先移出 agent team 的设定吧, 我们先把单 agent 整个链路拖动之后, 再考虑 subagent 的实现?"

## 决策

**Single Agent Design**:
- 1 个通用 agent, 永远 active, 不需要切
- LLM 行为 = Pi SDK 默认 system prompt + AGENTS.md (项目边界 / 思维指导) + 启用的 Skills + Context awareness
- AGENTS.md 编辑走 Settings → Custom Instructions tab (跟 Claude Code / Trae 对齐)
- 用户扩展点:
  - **Skills** (持续能力, v0.4.4 集成, 走 Pi SDK `loadSkills`)
  - **Slash command** (用户自定义模板, v0.4.5.2 恢复, `<workspace>/.pi/commands/*.md`)
  - **`@` 引用** (一次性片段, v0.4.7b 引入, 走 marker `[[skill:xxx]]` 嵌入 prompt 前面)

**4 段 system prompt** (sidecar stderr log 验证):
1. **Base**: Pi SDK 默认 (LLM 行为基础)
2. **Project context**: AGENTS.md (Pi SDK `ResourceLoader` 自动 load)
3. **Skills**: 启用的 skills (v0.4.4 注入)
4. **Context awareness**: workspace + active model + active skill (v0.5.5 加, 修 DeepSeek V4 Flash 幻觉)

## 后果

- ✅ 简单, 1 个 agent 心智模型
- ✅ 跟 Pi SDK 默认对齐, 升级 0.85+ 自动获新能力
- ✅ 项目边界走 AGENTS.md (跟 Claude Code / Trae 风格一致)
- ✅ Sub-agent 留作 v0.7+, 不阻塞主线
- ❌ 不能切 persona 库 (暂时不做, 跟 v0.5 single agent 拍板一致)
- ❌ Custom Instructions tab 是单 AGENTS.md, 复杂多 persona 需求时不够

## 历史 (教训)

v0.4.5.1 + v0.4.6.1 + v0.4.6.2 + v0.4.7a + v0.4.7b + v0.5.0-PR1 = 5 commit + 1 PR 全部推测错方向, user 16:24 拍板回滚.

**v0.5.0-v0.1 (2026-08-18 16:30, 1 commit) 整体回滚**, 改 13 文件:
1. 删 `app/src/stores/agents.ts` (git rm)
2. 重写 `CustomInstructionsTab.vue` 回归 v0.4.6 单 AGENTS.md 编辑
3. 改 `SettingsDialog.vue` tab label `Agents` → `Custom Instructions`
4. 改 `Composer.vue` 删 agent selector
5. 改 `WorkspaceTree.vue` 删底部 "Agent 团队" group
6. 改 `tauri.ts` 删 7 invoke
7. 改 `chat.ts` 删 useAgentsStore import
8. 改 `lib.rs` 删 7 invoke + 4 struct + 7 helper function (313 行)
9. 改 `sidecar.rs` 删 `ActiveAgentConfig` struct
10. 改 `sidecar/src/index.mjs` 删 activeAgent 处理 + DEFAULT marker
11. ADR-0024 (旧) status accepted → superseded
12. 新开本 ADR
13. sidecar 重编译 (D172 教训必须 commit)

**保留**: v0.4.4 Skills + v0.4.5.2 Slash tab + v0.4.6 AGENTS.md 自动 load + v0.4.7b skill @ 引用 (跟切 agent 无关).

**D184 教训 v6/v7/v8/v9 + D186 教训 v6 累计 5 次现场重演**: 每次都得按 user 原话字面理解, 不靠 session summary 推论.

## 何时 Revisit

- 用户明确要 sub-agent 协作 → 重新评估 sub-agent architecture (v0.7+)
- 项目太大, AGENTS.md 单文件装不下 → 拆 multi-file context
- Pi SDK 0.85+ 暴露 sub-agent API → 评估
