# ADR-0015: Skills / Slash Command 模块

- **状态**: Accepted (v0.6.3-rc1 含 D214 完整化增量)
- **日期**: 2026-08-19 (D214 增量 2026-08-22)
- **Type**: Functional
- **Module**: Skills
- **决策者**: user
- **Relates to**: [0009-single-agent-design](0009-single-agent-design.md) (skills 注入), [0014-feature-tools](0014-feature-tools.md) (user tools 资源), [0018-feature-mcp](0018-feature-mcp.md) (MCP server 资源)

## 功能定义 (应该做什么)

- ✅ Skills 加载 (走 Pi SDK `loadSkills`)
- ✅ Skills 启用 / 禁用切换
- ✅ Skills 内容注入 system prompt 第 3 段
- ✅ Skill / Tool / MCP 引用 (`[[ref:kind:name]]` 一次性嵌入 prompt, v0.6.3-rc1 D214 改统一 marker)
- ✅ Slash command 自定义 (`<workspace>/.pi/commands/*.md`)
- ✅ Composer `/` 弹窗 (**3 类**: skills / tools / MCP, v0.6.3-rc1 D214 改 3 类)
- ✅ Composer `@` 触发 (跟 `/` 行为统一, 任何位置, v0.6.3-rc1 D214 新加)
- ✅ Composer contentEditable + inline 灰底 chip 渲染 (v0.6.3-rc1 D214 替代 textarea)
- ✅ Skill 编辑 UI (Settings → Skills tab, v0.6.3-rc1 P0-1 49af1ab)
- ✅ Skill 启用预览 (v0.6.3-rc1 P0-1, 启之前在 tab 里直接看内容)
- ❌ Skill 分享 / 导出
- ❌ Skill marketplace

## 已实现 (v0.6.3-rc1)

### 核心模块 (P2 系列, v0.5.9 ~ v0.6.0)

| 功能 | 状态 | 实现位置 | 核验方法 |
|---|---|---|---|
| Skills 加载 | ✅ | sidecar `loadSkills({ cwd, agentDir, skillPaths })` | 写 .pi/skills/*.md, 看到加载 |
| Skills 启用切换 | ✅ | `skills.ts` enabledNames + FE restart sidecar | 启/禁, sidecar 重启后注入 |
| 注入 system prompt | ✅ | Pi SDK `loadSkills` 自动注入 (第 3 段) | sidecar stderr 4 段 log 看到 |
| Slash command | ✅ | `<workspace>/.pi/commands/*.md` + Composer `/` 弹窗 | 自定义一个 slash, `/` 弹窗看到 |

### P0-1 Skills 完整闭环 (v0.6.3-rc1, commit 49af1ab)

| 功能 | 状态 | 实现位置 |
|---|---|---|
| Skill 编辑 UI (新建/编辑/删除) | ✅ | `SkillsTab.vue` + `AddSkillForm.vue` (edit 模式) |
| Tauri command `write_skill_file` / `delete_skill_file` / `reload_skills` | ✅ | `src-tauri/src/lib.rs` |
| Skill 启用前内容预览 | ✅ | `SkillsTab.vue` 列表直接展示, 不需启就能看 |
| Unicode skill name 支持 | ✅ | D211 修 (前后端路径) |
| Permission dropdown bug 修 | ✅ | D209 改 `currentPermissionMode` 替代 `configStore` |
| `<skill_realtime>` system prompt override | ✅ | 让 LLM 在每 turn 看到最新 skill 内容 (D165 绕过) |

### D214 Composer 完整化 (v0.6.3-rc1, commit 49bb229 / aab6742 / 060258c / 711c826)

**3 类资源接入 slash popover** (Skills / Tools / MCP):

| 功能 | 状态 | 实现位置 |
|---|---|---|
| Skills 接入 | ✅ | `Composer.vue` `slashItems` 遍历 `skillsStore.skills` |
| User tools 接入 | ✅ | `Composer.vue` 遍历 `userToolsStore.tools` |
| MCP servers 接入 | ✅ | `Composer.vue` 遍历 `mcpServersStore.servers`, 空时显示 placeholder |
| `@` 触发 (跟 `/` 统一) | ✅ | `isSlashTriggerActive()` 支持 `/` 和 `@` |
| 统一 marker 格式 `[[ref:kind:name]]` | ✅ | `pickSlashItem` 生成, send 时按 kind 解析 |
| Force-read (每次 send 重新从磁盘读) | ✅ | `Composer.send()` 不依赖 cache, LLM 总看最新内容 |
| on popover open 主动 refresh 3 个 store | ✅ | `ensureResourcesLoaded()` 兜底 (防 sidecar snapshot 漏数据) |

**contentEditable 替代 textarea + inline 灰底 chip 渲染**:

| 功能 | 状态 | 实现位置 |
|---|---|---|
| contentEditable div | ✅ | `Composer.vue` `<div ref="richInputRef" contenteditable="true">` |
| Marker → chip span 渲染 (灰底 + 圆角) | ✅ | `renderRichInput()` + `:deep(.pad-composer__ref-chip)` CSS |
| Chip 内部 span 全部 `contenteditable="false"` | ✅ | 防 WebView2 允许 Backspace 进 chip 内部删字 |
| `data-text-length` 记录 marker 实际长度 | ✅ | chip 显示文本 ≠ marker 文本, 光标 offset 用 marker 长度算 |
| Chip × 删除按钮 | ✅ | `onRichClick` 处理, 删对应 marker |
| Backspace 紧贴 chip 删整块 | ✅ | `onRichKeydown` Backspace 处理, 避免留半截 marker |
| DOM walk 提取文本 (不用 innerText) | ✅ | `extractLogicalText()` 保留 marker, 不丢 |
| IME compositionend 兜底 | ✅ | `onCompositionEnd` 主动 `onRichInput` (WebView2 input 事件可能不重发) |
| `send()` 入口 re-extract 兜底 | ✅ | 防 IME/慢输入场景下 inputText 落后于 DOM |
| Last trigger char 替换 (不用 lastNl+1) | ✅ | `insertMarkerAtCursor` 修单行场景 chip 被覆盖 |
| `setStartAfter(lastChip)` 直接放光标 | ✅ | 兜底 WebView2 在 non-editable chip 后 snap 到 chip 前 |
| Chip 在 user 气泡渲染 (`v-html`) | ✅ | `ChatMessage.vue` `renderMessageContent` + `:deep()` 穿透 scoped |

**LLM prompt vs user display text 分离** (commit aab6742):

- ✅ LLM prompt 含 `<reference>...</reference>` section (内部协议, 让 LLM 知道 user 引用了哪些内容)
- ✅ User bubble 只含 user 输入 (chip 渲染, **不含 reference block**)
- ✅ 队列 item 改 `{llm, user}` 对象 (string[] 存不下两份)
- ✅ `sendPrompt(content, { userText })` API 接受两个 opt
- ✅ ghost title / 新 session 初始名 / queue preview 都用 user text

### D214 v6 Composer polish (v0.6.3-rc1, commit 060258c / 711c826)

| 功能 | 状态 | 备注 |
|---|---|---|
| ContentEditable min-height 44→28px | ✅ | 1 行高, 不留 2 行 padding |
| Popover max-height 280→200px | ✅ | 整体更紧凑 |
| Popover item padding 8/12→5/10px | ✅ | 单 item ~28px 高 |
| Popover item icon 28→22px | ✅ | 跟 padding 配合 |
| Popover hint padding 6→4px | ✅ | 提示行更紧凑 |
| Chat list padding-bottom 120→24px | ✅ | 短消息不再大片空白 |
| Session 切换自动滚底 (rAF + setTimeout 50ms 三重保险) | ✅ | 之前 nextTick 太早 scrollHeight=0 |

## 核验方法 (端到端)

### Skill 加载 (P2)
1. 在 workspace 下建 `.pi/skills/test-skill.md`, 内容 e.g.:
   ```markdown
   # Test Skill
   你现在扮演一个测试 skill, 回答 "pong" 给所有 "ping" 问题.
   ```
2. 进 Settings → Skills, 启 "test-skill"
3. 重启 sidecar (D165 system prompt 不可动态改, 必须重启)
4. sidecar stderr log 看到 4 段 system prompt 包含 skill
5. 发 "ping", LLM 答 "pong"

### Skill 编辑 UI (P0-1, 49af1ab)
1. 进 Settings → Skills tab
2. 点 "新建 skill", 输入名字 + 描述 + 内容, 保存
3. 进 `.pi/skills/` 看到对应 .md 文件
4. reload skills, skill 出现在列表
5. 启/禁, 切到 chat 能用

### D214 3 类资源 / @ 触发 / 强制读 (49bb229)
1. Composer 输入 `@`, 弹窗打开, 看到 Skills/Tools/MCP 三组
2. 选一个 skill, chip 插入 composer, `[[ref:skill:xxx]]` 格式
3. 同时 `@huashu` 过滤, 选 `huashu-design` chip
4. 在 chat 输入文字追加, send
5. **user 气泡只显示 chip + 文字, 不含 `<reference>` block**
6. LLM 实际收到的是 `<reference>body</reference>` + `[[ref:skill:xxx]]` + user text, 走 skill 内容回答

### D214 v5 send 三修 (aab6742)
1. chip + 文字 + send → user 气泡**只显示 chip + 文字** (无 reference block)
2. 已有 chip + 文字 → 在末尾加 `/` → 弹窗 → 选第二个 → **新增 chip** (不覆盖)
3. 中文 IME → 文字不丢 (有 stale warning 也算正常兜底)

### D214 v6 cursor 卡中间 (711c826)
1. 加第 2 个 chip → 光标**直接落在末尾** (setStartAfter 路径)
2. chip 后继续打文字 → 文字紧贴 chip
3. 切不同 session → 自动滚到底 (不再需要手动跳底)
4. 短消息 chat → 底部留白明显减少 (120→24px)

## 已知问题 / 技术债

- 🟡 **D165 system prompt 不可动态改**: 切 skill / 改 skill 内容要重启 sidecar (~150-300ms). `<skill_realtime>` 已在 v0.6.3-rc1 走 user message 注入缓解, 但 system prompt 段仍需重启
- 🟡 **没 builtin 22 个 slash 的展示**: 隐藏了 (跟 user 14:33 反馈), 但有些有用的看不到
- 🟡 **Chip × 删除按钮在 mobile 太小**: 14×14px 鼠标好点, 触屏不行 (后续 P1 polish)
- 🟡 **ChatMessage chip CSS 跟 Composer chip 重复**: 两处都定义 `:deep(.pad-composer__ref-chip)`, 后续可以提到全局 SCSS 复用
- 🟡 **没 last-mentioned tracking**: 隐式续接 (e.g. "再回复我一次" 没关键词) 仍 fall through 到 cache. 后续 P1 走 last-mentioned tracking 或每次 inject 所有 enabled (token 成本高)
- 🟡 **Send 时 ref body 重新 read 磁盘**: 每次 send 读 3 类资源 = 高频 IO. 后续可加 in-memory cache + invalidation (skill 改文件 → reload)

## 后续规划

### P0 (v0.6 已完成, 49af1ab)
- ✅ Skill 编辑 UI
- ✅ Skill 启用预览

### P0 (v0.6.3-rc1 已完成, 49bb229 / aab6742 / 060258c / 711c826)
- ✅ Slash command 完整化 (3 类 + @ 触发 + force-read)
- ✅ contentEditable + inline chip 渲染
- ✅ LLM prompt vs user display text 分离 (防 reference block 漏到 user 气泡)
- ✅ Composer 留白 + chat 底部留白压缩
- ✅ Session 切换自动滚底

### P1 (v0.7 候选)
- Chip × 按钮触屏友好
- ChatMessage chip CSS 提到全局复用
- last-mentioned tracking (隐式续接)
- Send ref body 内存 cache + invalidation

### P2 (v0.7+)
- Skill 分享 / 导出
- Skill marketplace
- D165 根因排查 (Pi SDK 0.85+ 是否有 dynamic system prompt API)
