# ADR-0011: Session 模块 (列表 / 切换 / 持久化 / 8 features)

- **状态**: Accepted (v0.6 Phase 1-6 全部完成, 2026-08-20)
- **日期**: 2026-08-19 (initial) / 2026-08-20 (Phase 1-6 全部 close)
- **Type**: Functional
- **Module**: Session
- **决策者**: user
- **Relates to**: [0007-session-management](0007-session-management.md) (技术实现)

## 功能定义 (应该做什么 — v0.6 目标 8 features + 基础)

- ✅ 列出当前 workspace 的所有 session (按更新时间倒序)
- ✅ 创建新 session
- ✅ 切换 session (切换后保留各自 history)
- ✅ 重命名 session (Phase 2 dblclick inline rename)
- ✅ 删除 session (Phase 3 永久删除, 走 in-app 危险 confirm)
- ✅ 自动持久化 (每次 message 更新都写盘)
- ✅ 跨重启保留 history
- ✅ Per-workspace 隔离 (Test1 不会污染 Test2)
- ✅ Per-session 隔离 (同 workspace 内多 session 各自独立)
- ✅ 标题自动生成 (Phase 6 ghost prompt via 独立 sidecar)
- ✅ 删除二次确认 (Phase 1+3 ConfirmDialog 通用组件)
- ✅ Session 搜索 (Phase 5 顶层 search bar 跨 workspace + 跨 archive)
- ✅ Session 归档 (Phase 3 Archive / Restore / 永久删除, [from X] 角标)
- ✅ Session 标签 (Phase 4 chip 显示 + in-menu add/remove)
- ✅ Pin / 收藏 (Phase 2 📌 Pinned section + 右键 toggle)
- ❌ Session 导出 (Markdown / JSON / 含 tool calls) → **推到二阶段**
- ❌ 跨设备同步 (原则不做, 加密 backup 可做) → **推到二阶段**

## 已实现 (v0.6 全部完成, 6 个独立 commit)

**基础 CRUD (pre-v0.6)**

| 功能 | 状态 | 实现位置 | 核验方法 |
|---|---|---|---|
| 列表 (按时间倒序) | ✅ | `app/src/stores/session.ts` `getSessionsByWorkspace` | 看 sidebar session 列表顺序 |
| 创建新 session | ✅ | `sessionStore.addSession` | 点 "新任务" 按钮, 看新 session 出现 |
| 切换 session | ✅ | `sessionStore.selectSession` | 点不同 session, 看切换 + history |
| 自动持久化 | ✅ | Pi SDK `SessionManager` append entries | 看 `~/.pi/agent/sessions/<hash>/<ts>_<id>.jsonl` |
| 跨重启保留 | ✅ | 同上 | 关 app, 重开, 看 history 还在 |
| Per-workspace 隔离 | ✅ | sha256(workspace).slice(0,16) 目录 hash | 切 workspace, 看不同 jsonl |
| Per-session 隔离 | ✅ | 每 session 独立 `piSessionId` (uuid v4) | 同 workspace 创 2 session, 各自独立 history |

**v0.6 Phase 1 (数据层, no UI) — commit 8f18762**

| 改动 | 位置 |
|---|---|
| +6 字段 (autoTitle/archived/archivedAt/pinned/pinnedAt/tags) | `session.ts` |
| +8 actions (archiveSession/restoreSession/deleteSessionPermanently/setPinned/togglePin/setAutoTitle/addTag/removeTag) | `session.ts` |
| +4 getters (activeSessionsByWorkspace/pinnedSessionsByWorkspace/archivedSessions/searchSessions) | `session.ts` |
| `ConfirmDialog.vue` (新, Teleport + Transition + danger) | `app/src/components/Common/` |
| `SessionContextMenu.vue` (新, 右键菜单 + viewport 边缘 clamp) | `app/src/components/Sidebar/` |

**v0.6 Phase 2 (Pin + Rename + ContextMenu wiring) — commit 8f18762**

| 改动 | 位置 |
|---|---|
| dblclick session → inline rename (Enter/Esc/blur) | `WorkspaceTree.vue` `onStartRename` |
| right-click session → SessionContextMenu | `WorkspaceTree.vue` `onContextMenu` |
| 顶部 📌 Pinned section (workspace 内, pinned 排序) | `WorkspaceTree.vue` template |

**v0.6 Phase 3 (Archive + Delete 流程) — commit 8f18762**

| 改动 | 位置 |
|---|---|
| active session inline 按钮: ❌删 → 📦Archive (走 ConfirmDialog) | `WorkspaceTree.vue` |
| 顶层 🗄 归档 section (workspace 列表外, sidebar 底部) | `WorkspaceTree.vue` template |
| 归档项 [from X] workspace 角标 | `WorkspaceTree.vue` + `getWorkspaceName` |
| archive 列表右键 → Restore (无 confirm) / Delete permanently (danger confirm) | `SessionContextMenu` 已支持, `WorkspaceTree` 接通 |
| 删旧 WorkspaceTree local `removeSession()` 函数 (store action 保留, 无人调) | `WorkspaceTree.vue` |

**v0.6 Phase 4 (Tag chip 显示 + add-tag 接通) — commit 0540b39**

| 改动 | 位置 |
|---|---|
| SessionContextMenu 'Add tag...' 原地变 input (Enter 提交, Esc 取消) | `SessionContextMenu.vue` |
| session item 加 body 包裹, 标题下加 tag chip 行 (3 处) | `WorkspaceTree.vue` template |
| chip 点击直接 removeTag (轻量操作) | `WorkspaceTree.vue` |
| `onContextMenuAction.add-tag` → `sessionStore.addTag` | `WorkspaceTree.vue` |
| 已知 UX 瑕疵: 多 tag item icon/Archive 按钮因 align-items: center 略偏 (待 grid 重构) |  |

**v0.6 Phase 5 (顶层 search bar) — commit 356c786**

| 改动 | 位置 |
|---|---|
| `searchQuery` ref + `searchResults` computed (包 `searchSessions`) | `WorkspaceTree.vue` script |
| 顶部 .pad-wstree__search (Search icon + input + × clear) | `WorkspaceTree.vue` template |
| v-if/v-else 切换 search 结果 vs 正常视图 | `WorkspaceTree.vue` template |
| 结果项: 复用 session item + [from X] + match hint (标题/autoTitle/tag) | `WorkspaceTree.vue` template |
| 点结果 → selectSession + clearSearch + blur input | `WorkspaceTree.vue` `onSelectFromSearch` |
| Esc 有 query 清空 / 无 query blur | `WorkspaceTree.vue` `onSearchEsc` |

**v0.6 Phase 6 (自动生成 title via ghost prompt) — commit aa236c8**

| 改动 | 位置 |
|---|---|
| `triggerGhostTitlePrompt` 函数: spawn 独立 sidecar (ghostSessionId), 走同样 LLM 跑 title-gen prompt | `chat.ts` |
| `cleanGhostTitle` (去 Title: 前缀/引号/markdown/cap 60 字) | `chat.ts` |
| `extractTextFromMessage` (从 string \| AgentContentBlock[] 提纯 text) | `chat.ts` |
| sendPrompt first message 检测 + fire-and-forget 触发 | `chat.ts` sendPrompt 末尾 |
| `ghostTriggeredForSession` Set 防重 | `chat.ts` |
| 45s timeout + error event + spawn 失败 三层兜底 (全 catch log, 不抛) | `chat.ts` |
| 3 处 session item 标题 + hover preview + confirm message 改用 `s.autoTitle \|\| s.title \|\| '新任务'` | `WorkspaceTree.vue` |

**设计决策: ghost prompt 用独立 sidecar (跟原 spec 略不同)**

- 原 spec: pass `{ghost:true}` through `runRpcMode`, sidecar skips `SessionManager.append`
- 实际: 独立 sidecar (ghostSessionId = `__ghost_<mainId>__<ts>__`), sidecar 自动创建独立 jsonl, 主 session history 0 污染
- 效果等价 "sidecar skips append", 优点: 不动 sidecar/src/index.mjs, 不用 fork/wrap Pi SDK

## 核验方法 (端到端)

### 基础 CRUD
1. 切到 Test1 workspace, 创 3 个 session "新任务"
2. 每个 session 发 2 条消息
3. 切走再切回, 看 history 还在
4. 删一个 session, 看其他不受影响
5. 重启 app, 看 session 列表和 history 都在

### Per-workspace 隔离
1. 切 Test1, 连发 3 条消息
2. 切 Test2, 发 1 条 "1+1=?"
3. 验证 AI **不记得** Test1 的对话
4. 切回 Test1, 发 1 条 "1+1=?"
5. 验证 AI **记得** 前 3 条

### Per-session 隔离 (关键)
1. 切 Test1, 创 session A, 发 "我是 A"
2. 创 session B, 发 "我是 B"
3. 切回 session A, 发 "1+1=?"
4. 验证 AI 看到 A 的 history, **不知道** B 的内容
5. 看 `~/.pi/agent/sessions/<hash>/` 应该有 2 个不同 `_<sessionId>.jsonl` 文件

### 持久化
1. 跑 5 turn 对话
2. 看 `~/.pi/agent/sessions/<hash>/<ts>_<id>.jsonl` 至少有 5+ 行 (header + 5 user/assistant)
3. kill app (硬关), 重开
4. 看 session 列表还在, history 都在

### Phase 2: Pin + Rename
1. dblclick 任意 session → 出现 input, 默认 select all
2. 改 title, Enter 提交 / Esc 取消 / blur 自动提交
3. 右键 → Pin to top → session 跳到 📌 Pinned section
4. 右键 → Unpin → session 回到 Active section

### Phase 3: Archive + Delete
1. active session 顶右 📦Archive → confirm → session 消失
2. sidebar 底部 🗄 归档 section 出现, 含 [from X] 角标
3. 归档项右键 → Restore → 直接回原 workspace
4. 归档项右键 → Delete permanently → 危险 confirm (红) → 永久删除

### Phase 4: Tags
1. 右键 → Add tag... → 菜单里变 input
2. 输入 tag 名 + Enter → 菜单关闭, session item 标题下出现 #tagname chip
3. hover chip → 背景变浅红, 文字变红
4. 点 chip → 直接删除

### Phase 5: Search
1. 顶部 🔍 input, 输入任意字符 → workspace tree + 归档区消失
2. 结果项显示 icon + title + [from X] + 匹配 hint
3. 搜标题命中 → 显示 "匹配标题"
4. 搜 tag 命中 → 显示 "匹配 tag: bug"
5. 搜 archived session → 也能搜到 (图标 Archive)
6. 点结果 → 选中 + 清空 search
7. Esc 有 query 清空 / 无 query blur
8. × 按钮清空

### Phase 6: Auto Title
1. 新建 session, 默认 title "新任务"
2. 发第一条消息 (>= 4 字符)
3. 数秒后: sidebar session title 自动变成 LLM 生成的标题
4. 鼠标 hover session: popover 也显示 autoTitle
5. 主 session 消息流 / jsonl 完全没变 (没有 title-gen 痕迹)
6. 已发过消息的 session 再 sendPrompt: 不会重新触发

## 已知问题 / 技术债 (Phase 1-6 完成后剩余)

- 🟡 **Session 文件膨胀**: 长对话 + tool calls, jsonl 可能 MB+. 无压缩 / 归档
- 🟡 **v0.4.2 残留字段 `per_workspace_session_id`**: 仍在 `config_store.rs` 持久化, 写不读, 占 config.json 体积
- 🟡 **没有 LRU 清理**: 用户删 workspace 后 `~/.pi/agent/sessions/<hash>/` 残留
- 🟡 **Ghost prompt 残留 jsonl**: Phase 6 跑完一次自动生成 title 后, ghost sidecar 写的独立 jsonl 文件残留在 disk, 不会被清理 (~1-2KB/file)
- 🟡 **多 tag session item 视觉略偏**: `align-items: center` 让 icon/Archive 按钮落在 title 与 tag 行之间 (Phase 4 commit message 标注, 需 grid 重构)
- 🟡 **Ghost prompt 无降级**: 走 spawn 第二个 sidecar, 多消耗一份内存 + 启动时间, 高频新建 session 场景有性能成本

## 后续规划 / 二阶段待办

### P0 二阶段 (下个 sprint)
- **Session 导出** (Markdown / JSON / 含 tool calls)
  - 用户场景: 重要对话想留档, 发到博客/PR 描述
  - 实现: chat store 加 exportSession(sessionId, format) 函数, 走 Tauri dialog save
- **LRU 清理** (workspace 删后清 sessions)
  - 用户场景: 删 workspace 后磁盘不残留
  - 实现: sessionStore.removeWorkspace 删完后, 调新 Tauri command `purge_session_dir(workspaceHash)`
- **清理 v0.4.2 残留 `per_workspace_session_id` 字段**
  - 实现: config_store.rs 删字段定义 + 一次性 migration 抹掉 config.json 里的旧值
- **多 tag session item grid 重构** (修 Phase 4 已知 UX 瑕疵)
  - icon/Archive 按钮锁第 1 行, tag chips 锁第 2 行

### P1 二阶段+1
- **Ghost prompt jsonl 清理** (Phase 6 残留)
  - ghost 任务结束后 Tauri 调 `delete_session_file(path)` 删 jsonl
  - 或定期 GC (`__ghost_*.jsonl` mtime > 1h 删)
- **Session 文件压缩 / 归档后清理**
  - 用户归档超过 30 天的 session, 把 jsonl gzip 存到 archive/ 子目录
  - 跟手动 export 走同一个压缩路径
- **加密 backup** (跨设备同步的轻量替代)
  - 备份整个 `~/.pi/` 到本地 zip (AES-256)
  - 不做云同步, 但给"换电脑"场景铺路

### P2 二阶段+2
- **Ghost prompt 性能优化** (Phase 6 已知)
  - 高频新建 session 场景, 考虑复用 ghost sidecar (per-workspace 一个, 而不是 per-session)
  - 或加个 `autoTitleEnabled` 配置开关, 默认开, 用户可关
- **Session 列表分页 / 虚拟滚动**
  - 单 workspace > 100 session 时 sidebar 渲染慢
- **批量操作** (多选 + 批量归档/删除/打 tag)
  - 跟 Pin section 协同: 批量 Pin / 批量归档
