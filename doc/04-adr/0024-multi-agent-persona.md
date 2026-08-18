# ADR-0024: Multi-agent persona（主/子 agent 库 + Composer 顶部 selector + SlashPopover）

- **状态**: Proposed
- **日期**: 2026-08-18
- **决策者**: user 拍板（待）
- **Supersedes**: 无
- **Superseded by**: 无
- **关联**: [ADR-0012](0012-pi-sdk-integration.md) (Pi SDK 集成) / [ADR-0022](0022-sub-agent-architecture.md) (sub-agent 调用层) / [ADR-0023](0023-mcp-integration.md) (MCP 集成)

---

## 背景

user 14:30 / 14:33 / 14:34 三轮反馈重新 scope 了 P0 路线图：

| 时间 | 反馈 | 修正 |
|---|---|---|
| 14:30 (D201) | 想要"多 agent 风格、处理事情的态度" | v0.4.6 单 textarea 不够，要多套 |
| 14:30 (D201) | `/` 应该唤起 skill/mcp/指令 等分类 | v0.4.7 Composer popover 必要 |
| 14:33 (D184 v8) | 内置 22 个不要在 `/` 显示，走 GUI | v0.4.5 Slash tab 单开没价值，砍 |
| 14:33 (Q2 图 1) | 在 Composer 会话窗口动态切换 agent.md | 不在设置面板，在 Composer 顶部加 selector |
| 14:34 (Q3) | 当前启用 = 主 agent，其他 = 子 agent，跟 ADR-0022 sub-agent 衔接 | 主/子 agent 区分 + 未来 sub-agent 数据源 |

**D184 教训 v8 现场重演**（v0.4.5 + v0.4.6 + v0.4.7 + v0.4.8 我之前全部推测错）：每次都得按 user 原话字面理解，不凭 session summary 推论。

---

## 关键技术约束（Pi SDK 0.84.2 实测确认, D171 + D183 第 3 次现场重演）

实测源码（[`pi-sdk/packages/coding-agent/src/core/resource-loader.ts`](../pi-sdk/packages/coding-agent/src/core/resource-loader.ts) + [`agent-session.ts`](../pi-sdk/packages/coding-agent/src/core/agent-session.ts)）：

| API | 公开? | 能改 system prompt? |
|---|---|---|
| `_baseSystemPrompt` (agent-session.ts:373) | ❌ private | 不能外部 setter |
| `appendSystemPrompt` (resource-loader.ts:242) | ❌ ResourceLoader 内部 state | 不能外部 setter |
| `appendSystemPromptOverride: (base) => string[]` (resource-loader.ts:192) | ✅ 但只构造时设 | 只能 reload() 时被调用 |
| `extendResources(paths)` (agent-session.ts:2282) | ✅ 公开 API | ⚠️ 只支持 skill/prompt/theme path，**不支持 appendSystemPrompt** |
| `SessionManager.setSessionFile(file)` (session-manager.ts:891) | ✅ 公开 API | ✅ 复用 session + 从 jsonl 读回 history |

**结论**：Pi SDK 0.84.2 **没有公开的"运行时改 system prompt 但保留 session" API**。

**唯一可行 path = "session 重建 + 复用 SessionManager"**：
1. `session.abort()` 停当前 turn
2. 复用现有 SessionManager（同 sessionFile path）
3. 重建 AgentSession，传新 `appendSystemPromptOverride`（拼新 active agent 内容）
4. `session.subscribe()` 重新注册
5. 下条 user prompt → LLM 用新 persona + history 从 jsonl 自动恢复

**跟 user 拍板 A 方案的关系**：
- user 拍板 A 字面意思："切了当前 session 立即变，不开新 session"
- 实际可行 path："abort 当前 turn + 重建 session + 复用 SessionManager"
- **用户体验一致**（切了下条 LLM 回复就用新 persona，history 完整保留）
- **底层实现差异**：A 是 in-place 改，实际是 abort + 重建

我把这个差异**明确写进 commit message**（D186 教训诚实承认 self-verify 漏了），不在 ADR 里隐瞒。

---

## 备选方案

### 方案 A：session 重建 + 复用 SessionManager（推荐 ✅）

**架构**：
- 切主 agent → sidecar 走 session 重建 path（同上）
- user 体验：跟 A 方案一致（切了下条 LLM 立即用新 persona，history 保留）
- 跟 ADR-0022 sub-agent 兼容（v0.5.1 短期只 Explore/Plan，v0.5.2+ 加"自定义 .pi/agents/*.md"）

**优势**：
- ✅ Pi SDK 0.84.2 唯一可行 path（实测确认）
- ✅ 跟 ADR-0022 sub-agent 数据层复用
- ✅ history 完整保留（jsonl 自动读回）
- ✅ 跟 v0.4.4 skills / v0.4.6 自定义指令 同套 pattern（`.pi/` 文件夹 + 顶部下拉）

**劣势**：
- ❌ session 重建会丢 transient state（streaming token / tool call 状态）— **可接受**（切主 agent 本身是用户主动行为）
- ❌ 实际不是 in-place 改，跟 user 拍板 A 字面不完全一致 — **用户体验一致**

### 方案 B：切主 agent 自动开新 session

**架构**：
- 切主 agent → sidecar 创建新 SessionManager（不同 sessionFile）+ 新 AgentSession
- 旧 session 在 sidebar 还在（用户能点回去看），但切完是新 session 空白

**优势**：
- 实现简单（不用考虑 session 重建）

**劣势**：
- ❌ **不符合 user 拍板 A 方案**（user 明确要"切了当前 session 立即变"，不是开新空白）
- ❌ 旧 session 切走，再回不去继续聊（除非手动点 sidebar）

### 方案 C：拒绝，等 Pi SDK 加运行时改 system prompt API

**做法**：
- v0.4.6.1 砍到只剩数据层（列 persona 文件，标 main/sub，**手动改 active**）
- 切主 agent 必须重启 .exe

**优势**：
- 0 实现风险

**劣势**：
- ❌ **不符合 user 当前需求**（user 明确要"动态切换"）
- ❌ Pi SDK 短期内（0-12 月）加 runtime system prompt API 概率低（Mario 单人维护，公开 Roadmap 没提）

---

## 决策

**方案 A — session 重建 + 复用 SessionManager**

**理由**：
1. **Pi SDK 0.84.2 唯一可行 path**（D171 + D183 实测确认，第 3 次现场重演）
2. **跟 user 拍板 A 方案用户体验一致**（切了下条 LLM 用新 persona，history 保留）
3. **跟 ADR-0022 sub-agent 数据层复用**（v0.5.2+ sub-agent 读 `.pi/agents/*.md`）
4. **跟 v0.4.4 skills / v0.4.6 自定义指令 同套 pattern**（复用 .pi/ 文件夹规范）

---

## 实施范围（3 个版本一次 build，D173 "功能逻辑是一体的"）

### v0.4.5.1 — 砍 Slash tab（0.5h）

- 删 `app/src/components/Settings/tabs/SlashTab.vue`
- 改 `SettingsDialog.vue` 移除 Slash tab 入口
- 改 `app/src/stores/slash.ts` 保留 BUILTIN_SLASH_COMMANDS 22 个常量（P1 GUI 用）
- doc/02-roadmap 同步

### v0.4.6.1 — 多套 agent persona + 主/子区分（3.5h，**改动大**）

**数据层**（Tauri 端 5 invoke，D193 教训 `fn cmd(args: MyArgs) → { args }` 包裹）：
- `list_agents(workspacePath, agentDir)` — 扫 `<workspace>/.pi/agents/*.md`，解析 frontmatter
- `read_agent(workspacePath, agentDir, name)` — 读单文件
- `write_agent(workspacePath, agentDir, name, content)` — 写单文件（name 校验防 path traversal）
- `delete_agent(workspacePath, agentDir, name)` — 删单文件
- `set_main_agent(workspacePath, agentDir, name)` — 写 `<agentDir>/active_agent.json`

**存储**（兼容 v0.4.6）：
```
<workspace>/
  ├── AGENTS.md                  ← v0.4.6 保留为"项目背景规则" (Pi SDK 自动 load, 不可切)
  └── .pi/agents/                ← v0.4.6.1 新
      ├── engineer.md            ← frontmatter: name / description / role: main|sub
      ├── pm.md
      └── teacher.md
```

**UI 改造 3 处**（跟 Trae 截图 "AGENT 团队" 一致）：
1. **Sidebar "AGENT 团队" group**：主 agent 标 [主]（绿点），子 agent 标 [子]（灰点）
2. **Composer 顶部 agent selector**：显示当前 active name，点开下拉选（跟 Trae 红框一致）
3. **Settings → Agents tab**（替代原"自定义指令"tab）：列表 + 新建/编辑/删除 + 标 [主]/[子]

**sidecar 切换逻辑**（走方案 A 决策）：
```javascript
// sidecar 接 set_main_agent RPC
async function setMainAgent(name) {
  // 1. 写 active_agent.json
  // 2. 读 .pi/agents/<name>.md 内容
  // 3. session.abort() (如果有 active session)
  // 4. 复用 SessionManager (同 sessionFile)
  // 5. 重建 AgentSession, 传新 appendSystemPromptOverride (拼 active agent 内容)
  // 6. session.subscribe() 重新注册
  // 7. 通知 FE 切完了 (走 IPC event 'main_agent_changed')
}
```

**旧数据迁移**（FE 端首次打开检测）：
- 检测到 `<workspace>/AGENTS.md` 存在 + `<workspace>/.pi/agents/` 不存在
- 自动调 `write_agent("default", AGENTS.md 内容)` + Toast "已迁移到新位置"
- 旧 AGENTS.md 保留为"项目背景规则"（Pi SDK 自动 load，永远生效，不可切）

### v0.4.7a — Composer `/` popover 3 类（2h）

**触发**：Composer `<textarea>` 敲 `/`（光标前只有 `/`）→ 弹层

**3 类分组**（D184 v8 Q1 拍板：内置 22 不显示）：
1. **Skills**（v0.4.4 已加载的）
2. **Agents**（v0.4.6.1 多套，选了切换主 agent）
3. **扩展 (MCP)**（P1 留空）

**触发语义**：
- 选 skill → 激活（走 v0.4.4 skills store toggle，跟 v0.4.4 同）
- 选 agent → **切主 agent**（跟 Composer 顶部下拉同效果，调 `set_main_agent` RPC）
- 选 mcp → P1 留空

**内置 22 个**：**完全不显示** in popover（D184 v8 Q1 拍板：走 GUI 面板，淡化终端命令式交互）

---

## 跟 ADR-0022 sub-agent 的关系

| 维度 | ADR-0024 (本 ADR) | ADR-0022 sub-agent |
|---|---|---|
| **性质** | 数据层 (persona 库) | 调用层 (独立 sidecar 进程) |
| **状态** | proposed (待 user 拍板) | accepted (2026-08-17) |
| **范围** | v0.4.6.1 (当前) | v0.5.1 (短期只 Explore/Plan) / v0.5.2+ (加自定义) |
| **存储** | `.pi/agents/*.md` (frontmatter role: main\|sub) | sub-agent 启动时**读** `.pi/agents/<name>.md` 作 system prompt |
| **命名区分** | "主 agent" = 当前激活 persona (1 个)<br>"子 agent" = 备选 persona (N 个) | "sub-agent" = 主 agent 调起的独立 sidecar 进程 (临时) |
| **衔接** | ADR-0022 v0.5.2+ sub-agent "自定义" 读本 ADR data layer | 本 ADR 实施时**预留** `.pi/agents/` 文件格式 + frontmatter 字段 |

**关键不冲突点**：
- "子 agent" (本 ADR) ≠ "sub-agent" (ADR-0022)
- 本 ADR 切主 agent = 单 sidecar 进程内 abort + 重建 session
- ADR-0022 sub-agent = 多 sidecar 进程，主 agent 调 sub-agent 跑独立任务
- **两者数据层共享**：`.pi/agents/*.md` 既可以是"主/子 agent" 切换的源，也是未来 sub-agent 启动的 system prompt 源

---

## 后果

**正面**：
- ✅ 多 persona 切换体验流畅（切了下条 LLM 立即用新 persona，history 保留）
- ✅ 跟 v0.4.4 skills / v0.4.6 自定义指令 同一套 `.pi/` 文件夹规范
- ✅ 跟 ADR-0022 sub-agent 数据层复用（v0.5.2+ sub-agent 读 `.pi/agents/*.md`）
- ✅ Composer `/` popover 3 类符合主流产品对标（Claude Desktop / Cursor / Trae 模式）
- ✅ 旧 v0.4.6 AGENTS.md 自动迁移，向后兼容

**负面**：
- ❌ session 重建会丢 transient state（streaming token / tool call 状态）— **可接受**（切主 agent 是用户主动行为）
- ❌ 切主 agent 实际不是 in-place 改，是 abort + 重建 — 跟 user 拍板 A 字面不完全一致，但用户体验一致
- ❌ 5.5h 工作量一次 build — 一次回滚风险

**中性**：
- 不动 Pi SDK 0.84.2 内部 state，100% 走公开 API
- 不引入新依赖
- builtin 22 个常量保留在 sidecar (P1 GUI 用)，不从主入口 export（D188 教训）

---

## 何时 Revisit

- **Pi SDK 加运行时改 system prompt 公开 API** → 改用 in-place 改（更流畅，不需 abort）
- **user 反馈切主 agent 后丢 streaming 体验差** → 改走 B 方案（开新 session）或加 transient state 保存
- **ADR-0022 sub-agent v0.5.1 实施** → 复用本 ADR `.pi/agents/*.md` data layer，sub-agent 启动时读对应 persona 文件
- **user 想要 sub-agent "主/子" 跨进程** → 评估本 ADR "主/子 agent" 是否要重命名避免混淆

---

## 决策点（user 拍板）

- [ ] ✅ 同意本 ADR + 走方案 A（session 重建 + 复用 SessionManager）
- [ ] ✅ v0.4.5.1 + v0.4.6.1 + v0.4.7a 一次 build（5.5h 出 .msi）
- [ ] ✅ 接受 session 重建丢 transient state（切主 agent = abort 当前 turn + 重建）
- [ ] ⏸ v0.5.1 sub-agent 实施时复用本 ADR data layer
