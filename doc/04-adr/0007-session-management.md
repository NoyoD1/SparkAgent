# ADR-0007: Session 管理 (per-session 独立 + per-workspace 目录隔离)

- **状态**: Accepted
- **日期**: 2026-08-17 (v0.4.2 step 1 引入), 2026-08-18 (v0.4.5.x 翻转 per-session)
- **决策者**: user
- **Relates to**: [0005-pi-sdk-integration](0005-pi-sdk-integration.md), [0006-rpc-mode-migration](0006-rpc-mode-migration.md)

## 背景

Session (一次完整对话 + 历史 messages) 怎么存 / 怎么隔离?

v0.4.1 之前: 裸 `new Agent()` 每次全新实例, 跨 turn 无记忆.

user 2026-08-17 反馈: "我们是不是还没做上下文管理？他没有记忆，跨 session 完全断掉" + "长链路调用也还有点问题，他不会自主决策".

## 备选

- **A. Pi SDK SessionManager (per-session 独立 + per-workspace 目录 hash)** — 选这个
- B. 自写 messages[] + 全量 rewrite — 重造轮子
- C. 不隔离 (全局 session pool) — Test1 污染 Test2

## 决策

**Per-session 独立 piSessionId (uuid v4, `crypto.randomUUID()`)** + **Per-workspace 目录 hash (`sha256(workspacePath).slice(0, 16)`)**:

```
~/.pi/agent/sessions/
├── <hash-workspace-1>/<ts>_<sessionId-A>.jsonl
├── <hash-workspace-1>/<ts>_<sessionId-B>.jsonl
└── <hash-workspace-2>/<ts>_<sessionId-C>.jsonl
```

- Pi SDK SessionManager 自动 append (user / assistant / tool_call / tool_result / model_change / thinking_level_change / compaction 7 类 entry)
- Resume: 走 `SessionManager.setSessionFile(<existing file>)` load entries
- Workspace 切换: sidecar 重启 (新进程 + 新 config), 走不同目录 → 不污染
- Session 切换 (同 workspace): FE 给新 sessionId → sidecar 走不同 file → 独立 context

**两层隔离**:
- 第一层: workspace 路径 → 目录 hash (sha256 前 16 位) → 防止 workspace 间污染
- 第二层: 每个 session 独立 piSessionId → 防止同 workspace 内 session 串历史

## 历史变迁

- **v0.4.2 step 1 (2026-08-17)**: per-workspace stable sessionId (FE `configStore.perWorkspaceSessionId[workspacePath]`). 同一 workspace 下所有 FE session 共享同一个 jsonl → 串历史 bug.
- **v0.4.5.x (2026-08-18)**: 翻转为 per-session 独立 piSessionId (`Session.piSessionId` 字段), 旧 per-workspace 字段标 deprecated.
- **迁移** (`migrateOldSessionIds()`): 启动时把旧 per-workspace id 派给该 workspace 第一个旧 session, 其余生成新 uuid (历史清空 trade-off).

## 后果

- ✅ 跨 session 持久化, 跨重启有记忆
- ✅ 跨 workspace 不污染 (Test1 / Test2 各走各的 jsonl)
- ✅ Session 切换不串 (每个 session 独立 jsonl)
- ✅ Per-workspace stable sessionId 走 deprecated, 简化 FE 逻辑
- ❌ Session 文件膨胀 (长对话 + tool calls 累积, 可能 MB+)
- ❌ Session 启动慢 ~150-300ms (setSessionFile + buildSessionContext)
- ❌ Workspace 删后 session 文件残留 (没 LRU 清理)
- ❌ v0.4.2 step 1 引入的 `perWorkspaceSessionId` 字段仍在 config_store.rs 持久化, 写不读, 占用 config.json 体积

## 何时 Revisit

- Session 文件 > 100MB → gzip + 分段
- 启动开销成问题 → 评估 sidecar 长连接
- 跨 workspace 共享上下文需求 → 重新评估隔离模型
- 清理 v0.4.2 step 1 残留字段: 下一个大版本把 `per_workspace_session_id` 从 config_store.rs 彻底移除
