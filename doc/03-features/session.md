# Session 管理 (Sessions)

> 状态: 🟡 70%
> 最后更新: 2026-08-16
> spec 涉及: `app/src/stores/session.ts` + `app/src/components/Sidebar/` + Tauri 文件存储

---

## 1. Spec

**会话 = 一次完整对话 + 历史 messages**，持久化到本机，支持多 session 并存、切换、重命名、删除。

### 1.1 必备能力

- ✅ 会话列表（按更新时间倒序）
- ✅ 创建新会话
- ✅ 切换会话
- ✅ 重命名会话
- ✅ 删除会话
- ✅ 会话按 workspace 隔离（不同 workspace 不同 session pool）
- ✅ 自动持久化（每次 message 更新都写盘）
- 🟡 会话内容搜索 — mock 有，真后端接上后测
- ❌ 归档（archive）— 未做
- ❌ 导出（Markdown / JSON）— 未做
- ❌ 跨设备同步 — **不做**（数据本机第一原则）
- ❌ 会话标签 / 分组 — 未做
- ❌ 收藏 / Pin — 未做

### 1.2 不做什么

- ❌ 云同步
- ❌ 协作编辑（多人共享一个 session）
- ❌ 会话模板（"从模板创建"）— 跟 Skills 重叠，v0.6 一起做

---

## 2. 当前实现

| 文件 | 职责 |
|---|---|
| `app/src/stores/session.ts` | session CRUD + active session 状态 + 持久化触发 |
| `app/src/stores/chat.ts` | 消息流写入 session（auto-save on agent_end）|
| `app/src/components/Sidebar/SidebarFunctionList.vue` | session 列表 UI |
| `app/src/components/Sidebar/Sidebar.vue` | session 操作入口（新建 / 切换）|
| Tauri `config_store.rs` | session 路径解析（`%APPDATA%\com.piagent.desktop\sessions\`）|

### 2.1 数据结构

```typescript
interface Session {
  id: string;              // crypto.randomUUID()
  workspaceId: string;     // 关联 workspace
  title: string;           // 默认 "New chat" / LLM 自动生成（v0.4+ 规划）
  createdAt: string;       // ISO
  updatedAt: string;       // ISO
  messageCount: number;
  // messages 单独存 sessions/<id>.jsonl 避免大文件
}
```

### 2.2 持久化

- Session 元数据：`sessions/index.json`
- Session 消息：`sessions/<id>.jsonl`（每行一条 message JSON）
- 写入策略：agent_end 时全量 rewrite（v0.4+ 改增量）

### 2.3 多 session 并发

- Sidecar 通过 `sessionId` 区分
- 当前 UI 不支持"两个 tab 同时跑两个 session"，但后端协议已就绪
- v0.4+ 考虑"分屏多 session"

---

## 3. 已知问题 / 限制

- 🟡 Session 标题固定 "New chat"，没接 LLM 自动生成
- 🟡 删除 session 没二次确认
- 🟡 没有"清空所有 session"
- 🟡 Session 文件可能很大（10K message 后）— 没分页
- 🟡 Workspace 切换时 session 列表会跳变（loading flash）— UX 问题

---

## 4. 待办（Roadmap）

### P0（v0.4 必做）
- [ ] Session 标题自动生成（用 LLM 总结第一条 user 消息）
- [ ] 删除二次确认

### P1（v0.4 - v0.5）
- [ ] **Session 导出**：Markdown / JSON / 含 tool calls
- [ ] **Session 搜索**：跨 session 关键词搜索
- [ ] **Session 归档**：Archive 视图
- [ ] **Session 标签**：用户自定义 tag

### P2（v0.6+）
- [ ] Session 分享链接（加密 + 过期）— 跟 [sharing.md](sharing.md) 联动
- [ ] Session 模板（基于已有 session 创建副本）

---

## 5. Changelog

- **2026-08-15 · v0.3.3** · real workspace + session 接入 sidecar
- **2026-08-13 · v0.3.1** · session 持久化路径稳定
- **2026-08-12 · v0.3** · session store 基础（CRUD + active）
- **2026-08-10 · v0.2** · session mock 数据
