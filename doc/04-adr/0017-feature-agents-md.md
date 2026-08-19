# ADR-0017: AGENTS.md 模块 (项目级 system prompt 注入)

- **状态**: Accepted
- **日期**: 2026-08-19
- **Type**: Functional
- **Module**: AGENTS.md
- **决策者**: user
- **Relates to**: [0009-single-agent-design](0009-single-agent-design.md) (single agent)

## 功能定义 (应该做什么)

- ✅ Pi SDK ResourceLoader 自动 load `<agentDir>/AGENTS.md` + `<cwd>/AGENTS.md`
- ✅ AGENTS.md 内容注入 system prompt 第 2 段 (Base / Project context)
- ✅ Settings → Custom Instructions tab 编辑 AGENTS.md
- ✅ Scope: workspace / global
- 🟡 多文件 project context (e.g. `.pi/context/*.md`)
- ❌ Dynamic system prompt (要重启 sidecar 才能生效, Pi SDK 0.84 限制)

## 已实现 (v0.5.9+)

| 功能 | 状态 | 实现位置 | 核验方法 |
|---|---|---|---|
| AGENTS.md 自动 load | ✅ | Pi SDK `DefaultResourceLoader.loadProjectContextFiles` | 写 AGENTS.md, sidecar stderr 看到 4 段含 Project context |
| 注入 system prompt | ✅ | ResourceLoader 内部, 第 2 段 | sidecar stderr log 验证 |
| Custom Instructions tab | ✅ (v0.4.6 集成, v0.5.0-v0.1 回归) | `SettingsDialog.vue` tab | 进 Settings → Custom Instructions, 编辑 |
| Workspace / Global scope | ✅ | tab 内 scope 切换 | 切 scope, 看不同 AGENTS.md |
| 4 段 system prompt log | ✅ (v0.5.0-PR1) | sidecar stderr `[sidecar] system prompt: 4 segments [...]` | 跑端到端, 看 stderr |

## 核验方法 (端到端)

### 自动 load
1. 在 workspace 下写 `AGENTS.md`:
   ```markdown
   # Project Rules
   你只用中文回答.
   ```
2. 写全局 `~/.pi/AGENTS.md`:
   ```markdown
   # User Rules
   回答简洁, 每次不超过 50 字.
   ```
3. 重启 sidecar (D165 限制)
4. 看 sidecar stderr log: `[sidecar] system prompt: 4 segments [persona=... project_context=set global+workspace]`
5. 发 "你好", 验证 LLM 用中文 + 简短 (两个 AGENTS.md 都生效)

### Custom Instructions UI
1. 进 Settings → Custom Instructions
2. 编辑 workspace AGENTS.md, 写一段新规则
3. 保存
4. 重启 sidecar
5. 验证新规则生效 (LLM 行为变)

### Scope 切换
1. Custom Instructions tab, 切 scope = global
2. 编辑 `~/.pi/AGENTS.md`
3. 切回 workspace, 看 4 段 log global 段变化

## 已知问题 / 技术债

- 🟡 **D165 system prompt 不可动态改**: 改 AGENTS.md 要重启 sidecar (~150-300ms)
- 🟡 **单 AGENTS.md 文件**: 复杂项目装不下
- 🟡 **没 syntax 高亮**: 编辑器是纯 textarea
- 🟡 **没 preview**: 改完不知道效果, 要看 stderr log

## 后续规划

### P0 (v0.6)
- Edit 时显示 preview (侧栏 markdown render)
- 重启时显示 loading + 倒计时

### P1 (v0.6 - v0.7)
- 多文件 project context (`.pi/context/*.md` 全部 load)
- 语法高亮 (CodeMirror / Monaco)

### P2 (v0.7+)
- Dynamic system prompt (等 Pi SDK 0.85+ API)
- AGENTS.md 模板库
