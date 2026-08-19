# ADR-0015: Skills / Slash Command 模块

- **状态**: Accepted
- **日期**: 2026-08-19
- **Type**: Functional
- **Module**: Skills
- **决策者**: user
- **Relates to**: [0009-single-agent-design](0009-single-agent-design.md) (skills 注入)

## 功能定义 (应该做什么)

- ✅ Skills 加载 (走 Pi SDK `loadSkills`)
- ✅ Skills 启用 / 禁用切换
- ✅ Skills 内容注入 system prompt 第 3 段
- ✅ Skill @ 引用 (`[[skill:xxx]]` 一次性嵌入 prompt)
- ✅ Slash command 自定义 (`<workspace>/.pi/commands/*.md`)
- ✅ Composer `/` 弹窗 (2 类: skills / slash)
- 🟡 Skill 编辑 UI
- 🟡 Skill 列表 polish
- ❌ Skill 分享 / 导出
- ❌ Skill marketplace

## 已实现 (v0.5.9+)

| 功能 | 状态 | 实现位置 | 核验方法 |
|---|---|---|---|
| Skills 加载 | ✅ | sidecar `loadSkills({ cwd, agentDir, skillPaths })` | 写 .pi/skills/*.md, 看到加载 |
| Skills 启用切换 | ✅ | `skills.ts` enabledNames + FE restart sidecar | 启/禁, sidecar 重启后注入 |
| 注入 system prompt | ✅ | Pi SDK `loadSkills` 自动注入 (第 3 段) | sidecar stderr 4 段 log 看到 |
| Skill @ 引用 | ✅ (v0.4.7b) | `[[skill:xxx]]` marker 拼到 prompt 前 | 引用一个 skill, LLM 用 skill 内容 |
| Slash command | ✅ | `<workspace>/.pi/commands/*.md` + Composer `/` 弹窗 | 自定义一个 slash, `/` 弹窗看到 |
| Composer `/` 弹窗 | ✅ (v0.4.7b) | 2 类 (skill / slash) | `/` 弹窗, 看分类 |

## 核验方法 (端到端)

### Skill 加载
1. 在 workspace 下建 `.pi/skills/test-skill.md`, 内容 e.g.:
   ```markdown
   # Test Skill
   你现在扮演一个测试 skill, 回答 "pong" 给所有 "ping" 问题.
   ```
2. 进 Settings → Skills, 启 "test-skill"
3. 重启 sidecar (D165 system prompt 不可动态改, 必须重启)
4. sidecar stderr log 看到 4 段 system prompt 包含 skill
5. 发 "ping", LLM 答 "pong"

### Skill @ 引用
1. 启 skill
2. 在 composer 输入 `[[skill:test-skill]] 这是个测试`
3. 看 composer 下 preview chip 显示
4. Send, sidecar 把 marker 拼到 prompt 前, LLM 走 skill 内容

### Slash command
1. 在 workspace 下建 `.pi/commands/quick-test.md`:
   ```markdown
   # Quick Test
   跑 `node -v` 然后总结.
   ```
2. Composer 输入 `/`, 弹窗看到 "Quick Test"
3. 点, 自动跑
4. 验证 LLM 跑 `node -v` 并总结

### 启用切换
1. 启 skill A
2. 禁用 A, 启 B
3. 重启 sidecar
4. 验证 system prompt 段只含 B 不含 A

## 已知问题 / 技术债

- 🟡 **D165 system prompt 不可动态改**: 切 skill / 改 skill 内容要重启 sidecar (~150-300ms)
- 🟡 **Skill 引用 preview 是 textarea 下面**: 用户期望 overlay 渲染, v0.4.7c polish 没做
- 🟡 **没 skill 编辑 UI**: 写 skill 要手 .md 文件
- 🟡 **没 skill 启用预览**: 启之前看不到内容
- 🟡 **没 builtin 22 个 slash 的展示**: 隐藏了 (跟 user 14:33 反馈), 但有些有用的看不到

## 后续规划

### P0 (v0.6)
- Skill 编辑 UI (Settings → Skills tab)
- Skill 启用预览

### P1 (v0.6 - v0.7)
- v0.4.7c polish (overlay 渲染 skill chip)
- Skill 分享 / 导出

### P2 (v0.7+)
- Skill marketplace
- D165 根因排查 (Pi SDK 0.85+ 是否有 dynamic system prompt API)
