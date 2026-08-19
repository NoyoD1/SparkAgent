# ADR-0011: Session 模块 (列表 / 切换 / 持久化)

- **状态**: Accepted
- **日期**: 2026-08-19
- **Type**: Functional
- **Module**: Session
- **决策者**: user
- **Relates to**: [0007-session-management](0007-session-management.md) (技术实现)

## 功能定义 (应该做什么)

- ✅ 列出当前 workspace 的所有 session (按更新时间倒序)
- ✅ 创建新 session
- ✅ 切换 session (切换后保留各自 history)
- 🟡 重命名 session (UI 待暴露, 协议已就绪)
- 🟡 删除 session (走 `confirm()` 临时, in-app 弹窗待做)
- ✅ 自动持久化 (每次 message 更新都写盘)
- ✅ 跨重启保留 history
- ✅ Per-workspace 隔离 (Test1 不会污染 Test2)
- ✅ Per-session 隔离 (同 workspace 内多 session 各自独立)
- 🟡 Session 标题自动生成
- 🟡 删除二次确认 (in-app 弹窗, 替代 `confirm()`)
- ❌ Session 导出 (Markdown / JSON / 含 tool calls)
- ❌ Session 搜索 (跨 session 关键词)
- ❌ Session 归档 (Archive 视图)
- ❌ Session 标签 / 分组
- ❌ 收藏 / Pin
- ❌ 跨设备同步 (不做, 跟数据本机第一对齐)

## 已实现 (v0.5.9+)

| 功能 | 状态 | 实现位置 | 核验方法 |
|---|---|---|---|
| 列表 (按时间倒序) | ✅ | `app/src/components/Sidebar/WorkspaceTree.vue` `getSessionsByWorkspace` | 看 sidebar session 列表顺序 |
| 创建新 session | ✅ | `sessionStore.addSession` | 点 "新任务" 按钮, 看新 session 出现 |
| 切换 session | ✅ | `sessionStore.selectSession` | 点不同 session, 看切换 + history |
| 重命名 | 🟡 (协议就绪, UI 待暴露) | `sessionStore.renameSession` | (待 UI 暴露) |
| 删除 | 🟡 (走 `confirm()` 临时) | `sessionStore.removeSession` | 点删除, 浏览器 confirm 弹窗 |
| 自动持久化 | ✅ | Pi SDK `SessionManager` append entries | 看 `~/.pi/agent/sessions/<hash>/<ts>_<id>.jsonl` |
| 跨重启保留 | ✅ | 同上 | 关 app, 重开, 看 history 还在 |
| Per-workspace 隔离 | ✅ | sha256(workspace).slice(0,16) 目录 hash | 切 workspace, 看不同 jsonl |
| Per-session 隔离 | ✅ | 每 session 独立 `piSessionId` (uuid v4) | 同 workspace 创 2 session, 各自独立 history |

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

## 已知问题 / 技术债

- 🟡 **标题硬编码 "新任务"**: 缺 LLM 自动生成 (v0.6 P0)
- 🟡 **删除走 `confirm()`**: 不是 in-app 弹窗, 体验差
- 🟡 **重命名 UI 没收**: 协议已就绪 (`set_session_name` RpcCommand)
- 🟡 **Session 文件膨胀**: 长对话 + tool calls, 可能 MB+
- 🟡 **v0.4.2 残留字段 `per_workspace_session_id`**: 仍在 `config_store.rs` 持久化, 写不读, 占 config.json 体积
- 🟡 **没有 LRU 清理**: 用户删 workspace 后 `~/.pi/agent/sessions/<hash>/` 残留

## 后续规划

### P0 (v0.6)
- 标题自动生成 (LLM 总结第一条 user 消息)
- 删除二次确认 (in-app 弹窗, 走 PermissionDialog 同款)
- 重命名 UI 暴露
- 清理 v0.4.2 残留 `per_workspace_session_id` 字段

### P1 (v0.6 - v0.7)
- Session 导出 (Markdown / JSON)
- Session 搜索 (关键词)
- Session 归档
- LRU 清理 (workspace 删后清 sessions)

### P2 (v0.7+)
- Session 标签 / Pin
- 跨设备同步 (不做原则, 但加密 backup 可做)
