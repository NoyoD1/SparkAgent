# ADR-0015: Skills / Slash Command 模块

- **状态**: Accepted (v0.6.3-rc1 含 D214 完整化增量)
- **日期**: 2026-08-19 (D214 增量 2026-08-22, v8.2 修 2026-08-22)
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

### D214 v8 UI 优化 (v0.6.3-rc1, commit 01e310f)

| 功能 | 状态 | 备注 |
|---|---|---|
| Composer max-height 200→400px + `white-space: pre-wrap` + `overflow-wrap: anywhere` | ✅ | 多 chip + 长文本不溢出, 手动换行也保留 |
| Slash popover `scrollActiveItemIntoView()` (键盘 ↑↓ 选中项滚进可视区) | ✅ | `scrollIntoView({block: 'nearest'})` 只滚最小距离, 顶/底已在内就不滚, 避免抖动 |
| ChipPreview 剥 frontmatter 走 `MarkdownContent` 渲染 | ✅ | 跟 chat 气泡的 markdown 渲染一致, 预览所见即所得 |
| ChipPreview body JSON 走 pretty print | ✅ | `JSON.stringify(parsed, null, 2)`, 读 tool/mcp body 更清晰 |

### D214 v8.1 UI polish (v0.6.3-rc1, commit c636049)

| 功能 | 状态 | 备注 |
|---|---|---|
| ChipPreview body 整体可滚 (meta + content 一起滚) | ✅ | 之前 content 自己 overflow: auto, meta 不动, 双层 scrollbar 体验差. 改成整个 body 一个 scrollbar |
| ChipPreview popover max-height 240→360px | ✅ | 给更多内容留空间, 配合 body 整体滚 |
| Composer min-height 28→36px | ✅ | 1 行高, 上下呼吸更舒展 |
| `watch(inputText)` 加 `autoResize()` | ✅ | 外部修改 inputText 后, composer 高度自适应 |
| `insertMarkerAtCursor` 末尾补 `autoResize()` | ✅ | 加 chip 后, composer 高度即时跟新内容 |

### D214 v8.2 chat 气泡 chip preview 启动时序修 (v0.6.3-rc1, commit 3c6c646)

**问题**: 启动程序后立即发 chat, 气泡里如果带 chip, 点击会报 "Skill 不存在: xxx" (同 tool/mcp). 在输入框 `/` 选过 chip 后再点, 就正常.

**根因**: `useChipPreview.fetchRefBody` 走 `skillsStore.skills.find()` / `userToolsStore.tools.find()` / `mcpServersStore.servers.find()` 找 entry, 但 FE 启动时不一定先访问 Skills/Tools/MCP tab, 3 个 store 还没从 Tauri 拉数据, 数组是空的, find 直接 miss → throw. 被动刷新链只有 `Composer.vue` 的 `ensureResourcesLoaded` (slash popover 打开时), chat 气泡里的历史 chip 走不到这条链.

**修法 (结构层面)**: `fetchRefBody` 3 个 if 分支, find miss 时主动调对应 store 的 refresh, 再 find 一次, 仍找不到才 throw. 跟 `ensureResourcesLoaded` 同 pattern, 不引入新机制.

| 功能 | 状态 | 备注 |
|---|---|---|
| `fetchRefBody` skill 分支 miss 后调 `skillsStore.refreshFromTauri()` | ✅ | refresh 失败 console.warn 不 throw, 让后续 "Skill 不存在" 报准 |
| `fetchRefBody` tool 分支 miss 后调 `userToolsStore.refresh()` | ✅ | 同上 |
| `fetchRefBody` mcp 分支 miss 后调 `mcpServersStore.refresh()` | ✅ | 同上 |
| 3 类资源对称处理, 通用机制不硬编码 | ✅ | 不引入新 store, 不改 store 签名, 仅在 composable 兜底 |

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

### D214 v7 chip UX + 性能 (bbe25bf)
1. 点 chip (Composer 或 ChatMessage 气泡里) → 浮层弹出, 显示完整 body (Teleport 到 body)
2. 同一 skill 连续发 5 条消息 → 第 2-5 条应该都从 cache 读 (Rust 端走 REF_BODY_CACHE, mtime 一致返)
3. user 上句引用 huashu-design, 下句"再分析一下" (没 chip) → LLM 还能看到 huashu-design 内容
   (走 `<recent_refs>` section, D214 v7 隐式续接支持)

### D214 v8 UI 优化 (01e310f)
1. Composer 加 5-8 个 chip + 长文字 → composer 自动撑高, 不溢出屏幕
2. Slash popover 键盘 ↑↓ 选中项 → 选中项始终在可视区, 不滚过头
3. 点 skill chip → preview 浮层里 skill frontmatter 剥掉, 只显示正文 (跟 chat 一致渲染)
4. 点 tool/mcp chip → JSON 格式化显示 (缩进 2 空格)

### D214 v8.1 UI polish (c636049)
1. 点 chip → preview body 一个 scrollbar (meta + content 整体滚, 不再双层 scrollbar)
2. Composer 加 chip → composer 高度即时跟新内容 (insertMarkerAtCursor 末尾 autoResize)
3. 空 Composer → 高度 36px (比 28px 舒展)
4. 外部清空 inputText → composer 高度回到 min

### D214 v8.2 chat 气泡 chip 启动时序修 (3c6c646)
1. 启动程序 → 不访问 Skills/Tools/MCP tab → 直接发带 chip 的 chat
2. 点 chat 气泡里的 chip → 浮层正常显示 body (不报 "Skill 不存在")
3. F12 console 看不到 `[useChipPreview] xxx refresh failed` warn (正常拉到了)
4. 第二次点同 chip → 仍然正常 (refresh 一次后 store 已有数据, 不再走 refresh 分支)

## 已知问题 / 技术债

- 🟡 **D165 system prompt 不可动态改**: 切 skill / 改 skill 内容要重启 sidecar (~150-300ms). `<skill_realtime>` 已在 v0.6.3-rc1 走 user message 注入缓解, 但 system prompt 段仍需重启
- 🟡 **没 builtin 22 个 slash 的展示**: 隐藏了 (跟 user 14:33 反馈), 但有些有用的看不到
- 🟡 **last-mentioned tracking token 成本**: v7 cap 3 条, 长文件 × 3 = 几十 KB per turn. 后续可加 "短消息才 inject" 启发式降成本
- 🟡 **last-mentioned 不感知 chip 删除**: user 点 × 删 chip 后, recent refs 不会自动移出 (不像 addRecentRef 那样反向). 后续 P1 polish

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

### P0 (v0.6.3-rc1 已完成, bbe25bf D214 v7)
- ✅ Chip 点击预览浮层 (P0-2/P0-3)
- ✅ Chip × 按钮触屏友好 (14→18px)
- ✅ Chip CSS 提到全局 (assets/styles/chip.css, Composer/ChatMessage 重复规则删掉)
- ✅ Rust 端 ref body 内存 cache (mtime 校验 + write/delete 主动 invalidate)
- ✅ Last-mentioned tracking (chat store 维护 recentRefs, 隐式续接 inject recent_refs)

### P0 (v0.6.3-rc1 已完成, 01e310f D214 v8)
- ✅ Composer max-height 200→400px + pre-wrap + overflow-wrap (多 chip 不溢出)
- ✅ Slash popover 键盘 ↑↓ 选中项 `scrollIntoView({block: 'nearest'})` 滚进可视区
- ✅ ChipPreview 剥 frontmatter 走 MarkdownContent 渲染 (跟 chat 一致)
- ✅ ChipPreview JSON body pretty print (2 空格缩进)

### P0 (v0.6.3-rc1 已完成, c636049 D214 v8.1)
- ✅ ChipPreview body 整体可滚 (meta + content 一起滚, 取消 content 自己的 overflow, 避免双层 scrollbar)
- ✅ ChipPreview popover max-height 240→360px
- ✅ Composer min-height 28→36px
- ✅ `watch(inputText)` 加 `autoResize()` (外部修改 inputText 高度跟)
- ✅ `insertMarkerAtCursor` 末尾补 `autoResize()` (加 chip 高度即时跟)

### P0 (v0.6.3-rc1 已完成, 3c6c646 D214 v8.2)
- ✅ 修 chat 气泡 chip 启动时序: `useChipPreview.fetchRefBody` find miss 时主动 refresh store 再 find
  (3 类资源 skills/tools/mcp 对称处理, 跟 Composer.vue `ensureResourcesLoaded` 同 pattern)

### P1 (v0.7 候选)
- Last-mentioned "短消息才 inject" 启发式 (降 token 成本)
- Last-mentioned 感知 chip 删除 (addRecentRef 配 removeRecentRef)

### P2 (v0.7+)
- Skill 分享 / 导出
- Skill marketplace
- D165 根因排查 (Pi SDK 0.85+ 是否有 dynamic system prompt API)
- MCP HTTP / SSE transport
- MCP config 热更新 (Hot reload)
