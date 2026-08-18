# ADR-0025: Single agent design（通用 agent + AGENTS.md 边界定义, 不切主）

- **状态**: Accepted (2026-08-18 16:30, user 拍板 "agent 是边界定义/思维指导, single agent 链路拉动")
- **日期**: 2026-08-18
- **决策者**: user 拍板
- **Supersedes**: [ADR-0024](0024-multi-agent-persona.md) (multi-agent persona, 被回滚)
- **关联**: [ADR-0012](0012-pi-sdk-integration.md) (Pi SDK 集成) / [ADR-0022](0022-sub-agent-architecture.md) (sub-agent 调用层, 留作 v0.5.1+ 实施) / [ADR-0023](0023-mcp-integration.md) (MCP 集成) / [ADR-0024](0024-multi-agent-persona.md) (被取代)

---

## 背景

user 16:24 反馈重新 scope P0 路线图:
- "我开发的应该是一个通用 agent, 它永远是主 agent, 一些子 agent 只是像你之前规划的, 用于分工工作的"
- "处理什么问题是由我们本身线程决定的, 而不是一定需要我们主动去选择"
- "agent team 其实是以前的那种思维, 现在 agent 更像是一个边界定义, 处理问题时的思维指导"
- "先移除 agent team 的设定吧, 我们先把单 agent 整个链路拉动之后, 再考虑 subagent 的实现"

**D184 + D186 教训**: v0.4.6.1 + v0.4.6.2 + v0.4.7a + v0.4.7b + v0.5.0-PR1 共 5 commit + 1 PR 全部推测错方向, D186 教训累计 5 次现场重演 (v6 + v7 + v8 + v9 + v10), D184 教训累计 5 次. user 拍板"回滚 + 走 single agent design".

**跟 v0.4.6 之前的关系**: v0.4.6 那个 "Project rules / 自定义指令" (AGENTS.md) 的设计**保留**, 但去掉 v0.4.6.1 那次改造的"multi-agent persona 切换"那部分. 跟 Claude Code "Custom Instructions" 模式对齐, 跟 Trae "AGENTS.md" 模式对齐.

---

## 关键技术约束（Pi SDK 0.84.2 实测确认）

| API | 公开? | 行为 |
|---|---|---|
| `_baseSystemPrompt` (agent-session.ts:373) | ❌ private | 不能外部 setter |
| `appendSystemPrompt` (resource-loader.ts:242) | ❌ private | 不能外部 setter |
| `appendSystemPromptOverride: (base) => string[]` (resource-loader.ts:192) | ✅ 但只 reload() 时调 | 我们用 skills + context awareness |
| `DefaultResourceLoader.loadProjectContextFiles({cwd, agentDir})` | ✅ 公开 | **自动 load `<agentDir>/AGENTS.md` + `<cwd>/AGENTS.md`** → 注入 system prompt 段 |
| `SessionManager.setSessionFile(file)` (session-manager.ts:891) | ✅ 公开 | 复用 session + 从 jsonl 读回 history |

**结论**: 1 个通用 agent (Pi SDK 默认) + AGENTS.md (Pi SDK 自动 load) = 最简洁的 single agent 链路. 不需要任何"切主 agent"逻辑.

---

## 备选方案

### 方案 A: Single agent + AGENTS.md (推荐 ✅)

**架构**:
- 1 个**通用 agent**, 永远 active, 不需要切
- LLM 行为 = Pi SDK 默认 system prompt + AGENTS.md (项目边界 / 思维指导) + 启用的 Skills + Context awareness
- AGENTS.md 编辑走 Settings → Custom Instructions tab (跟 Claude Code / Trae 对齐)
- sub-agent (ADR-0022) 留作 v0.5.1+, 优先级低于 P0

**4 段 system prompt** (显式化, sidecar stderr log 验证):
1. **Base**: Pi SDK 默认 (LLM 行为基础)
2. **Project context**: AGENTS.md (Pi SDK 自动 load, resource-loader.ts:71)
3. **Skills**: 启用 skills (持续能力, v0.4.4 注入)
4. **Context awareness**: v0.5.5 model behavior fix (meta-history 幻觉修)

**优势**:
- ✅ 最简洁: 不需要"切主"逻辑, 不需要"DEFAULT marker", 不需要"per-session 隔离"
- ✅ 跟 v0.4.6 之前兼容: AGENTS.md 编辑 UI 已经在 v0.4.6 存在, 回归就好
- ✅ 跟 Pi SDK 0.84.2 DefaultResourceLoader 自动 load 行为对齐
- ✅ 跟 Trae / Claude Code / Codex / Cursor "Custom Instructions" 模式一致
- ✅ 1 commit 落地, 改 7 个文件, diff 干净 (B 重做)

**劣势**:
- ❌ user 不能切 persona (但 user 原话 "处理什么问题是由我们本身线程决定的, 不是用户主动选择", 不需要切)
- ❌ 暂时不支持 sub-agent (留作 v0.5.1+, user 拍板"先把单 agent 整个链路拉动")

### 方案 B: 多 persona 但自动选 (根据任务类型, 不让用户选)

**架构**:
- 保留多 persona 数据层 (.pi/agents/*.md)
- 切主 = 自动 (根据 user prompt 关键词 / LLM 自身判断)
- 跟 v0.4.4 skills 同 pattern, 但自动

**劣势**:
- ❌ 不符合 user 原话 "处理什么问题是由我们本身线程决定的" — user 明确说"不要让用户主动选", 但没说要"自动"
- ❌ LLM 选 persona 是个新问题, Pi SDK 0.84.2 不支持, 复杂度高
- ❌ 跟 Trae / Claude Code / Codex 的 "user 显式 Custom Instructions" 模式不一致

### 方案 C: 拒绝, 等 Pi SDK 加运行时改 system prompt 公开 API

**做法**: 跟 v0.4.6.1 ADR-0024 备选 C 一样, 暂停实施
**劣势**:
- ❌ user 拍板"先移除 agent team 设定", 等 Pi SDK 加 API 不符合 user 期望
- ❌ Pi SDK 短期内 (0-12 月) 加 runtime system prompt API 概率低 (D210 实测 + Mario 单人维护)

---

## 决策

**方案 A — Single agent + AGENTS.md**

**理由**:
1. **user 16:24 原话明确**: "agent 是边界定义/思维指导, single agent 链路拉动, 不要切"
2. **Pi SDK 0.84.2 默认 load AGENTS.md**, 不需要任何"切主"逻辑
3. **跟 v0.4.6 之前兼容**: 回归 Custom Instructions tab (单 AGENTS.md 编辑)
4. **跟 Trae / Claude Code / Codex 一致**: 不切 persona, 1 个通用 agent + Custom Instructions

---

## 实施范围（1 commit 落地, B 重做）

### v0.5.0-v0.1 — 回归 single agent design (1 commit, 落地)

**改的文件 (7 个)**:
- `app/src/stores/agents.ts`: **整个删** (git rm)
- `app/src/components/Settings/tabs/CustomInstructionsTab.vue`: 重写 (单 AGENTS.md 编辑, v0.4.6 design)
- `app/src/components/Settings/SettingsDialog.vue`: 改 tab id `instructions` 保留, label `Agents` → `Custom Instructions`, icon `Bot` → `FileText`
- `app/src/components/ChatMain/Composer.vue`: 删 agent selector (script + template + CSS), `/` popover 改 2 类 (Skills / 扩展, 删 Agents 段)
- `app/src/components/Sidebar/WorkspaceTree.vue`: 删底部 "Agent 团队" group + import + state + function + CSS
- `app/src/lib/tauri.ts`: 删 7 个 agents invoke (list_/read_/write_/delete_/set_main_agent + read/write_session_active_agent) + TauriAgentInfo type + activeAgent 字段
- `app/src/stores/chat.ts`: 删 useAgentsStore import + activeAgent 字段
- `src-tauri/src/lib.rs`: 删 7 invoke + AgentInfo/AgentArgs/SessionAgentArgs/ListAgentsResponse struct + parse_agent_name + parse_agent_frontmatter + resolve_agents_dir + resolve_active_agent_path + read/write_active_agent_name + resolve_session_agent_path (313 行), 删 active_agent 字段, send_prompt 改不传 active_agent, invoke handler 列表删 7 个, 删 use ActiveAgentConfig import
- `src-tauri/src/sidecar.rs`: 删 ActiveAgentConfig struct + active_agent 字段 + sidecar config JSON 字段
- `sidecar/src/index.mjs`: 删 activeAgent 处理 + DEFAULT marker, 4 段 system prompt log 改 4 段 (Base / Project context / Skills / Context awareness)
- `doc/04-adr/0024-multi-agent-persona.md`: status accepted → superseded by ADR-0025, 末尾加 supersession note
- `doc/04-adr/0025-single-agent-design.md`: 本 ADR (新开)
- `doc/02-roadmap.md`: 加 v0.5.0-v0.1 entry + 标之前 4 entry (v0.4.5.1/6.1/6.2/7a + v0.5.0-PR1) 为 "superseded by v0.5.0-v0.1"
- `src-tauri/binaries/pi-agent-sidecar-x86_64-pc-windows-msvc.exe`: sidecar 重编译 (D172 教训必须 commit)

**保留 (跟切 agent 无关)**:
- v0.4.4 Skills 启用 (Pi SDK 表层)
- v0.4.5.2 Slash tab 恢复 (user 自定义快捷模板)
- v0.4.6 Project rules / 自定义指令 (AGENTS.md 自动 load, 改回 Custom Instructions tab UI)
- v0.4.7b skill @ 引用 (一次性嵌入 user prompt)

---

## 后果

**正面**:
- ✅ 1 个通用 agent, 永远 active, 不需要切
- ✅ AGENTS.md (Custom Instructions tab) = LLM 整个 session 持续遵守的边界 / 思维指导
- ✅ 跟 Pi SDK 0.84.2 DefaultResourceLoader 自动 load 行为对齐
- ✅ 跟 Trae / Claude Code / Codex "Custom Instructions" 模式一致
- ✅ 1 commit 落地, 改 13 个文件, diff 干净 (B 重做)
- ✅ 4 段 system prompt 显式 log, sidecar stderr 可见, user 端到端能验
- ✅ v0.5.0-PR1 已落地 (commit 2f21394), 4 段 system prompt log 部分保留, DEFAULT marker / ensureDefaultAgent 部分回滚

**负面**:
- ❌ user 不能切 persona (但 user 原话明确"不要切")
- ❌ 暂时不支持 sub-agent (留作 v0.5.1+, user 拍板)
- ❌ 1 commit 大动作, 13 文件 diff 较大 (但比 5 个 revert commit 累积 diff 干净)

**中性**:
- ADR-0022 sub-agent 留作 v0.5.1+, 数据层不冲突 (sub-agent 启动时读 .pi/agents/<name>.md 作 system prompt — 这个 data layer 已被本设计覆盖, 单 agent 模式下每个 .md 都被 Pi SDK 自动 load)
- v0.4.5.2 / v0.4.7b 等 commit 保留 (跟切 agent 无关)
- sidecar 4 段 log 简化 (Base / Project context / Skills / Context awareness), 不再有 persona 段

---

## 何时 Revisit

- **user 反馈"需要 sub-agent 分工"** → 实施 ADR-0022 v0.5.1+ (短期 Explore/Plan, 中期自定义)
- **user 反馈"AGENTS.md 不够, 想要 per-task instructions"** → 评估 system prompt 段扩展 (v0.4.6 已有 Project Rules, 复用)
- **Pi SDK 加运行时改 system prompt 公开 API** → 重新评估 ADR-0024 (multi-agent persona 恢复)
- **v0.4.7c polish (Composer 重做 contenteditable + 任意 caret + 富文本 chip)** → 继续 v0.5.0-PR2 路线
- **v0.5.0-PR3 Mention Panel 统一 (Slash / Skills / 扩展)** → 继续 v0.5.0-PR3 路线

---

## 决策点（user 拍板）

- [ ] ✅ 走 single agent design (回归 v0.4.6 之前 + AGENTS.md 思维指导)
- [ ] ✅ 1 commit 落地 (B 重做, 13 文件 diff)
- [ ] ✅ 删 multi-agent persona 全部 (ADR-0024 superseded, commit 历史保留)
- [ ] ⏸ sub-agent (ADR-0022) 留作 v0.5.1+, 不在 P0
- [ ] ⏸ v0.5.0-PR2 / PR3 (Composer 重做 + Mention Panel 统一) 待做
