# Workspace（工作区）

> 状态: 🟡 40%
> 最后更新: 2026-08-16
> spec 涉及: `app/src/stores/chat.ts` + `app/src/components/Sidebar/WorkspaceTree.vue` + Tauri fs

---

## 1. Spec

**Workspace = 用户指定的工作目录**。agent 知道 cwd，session 跟 workspace 绑定，tool call 在 workspace 内执行（v0.4+）。

### 1.1 必备能力

- ✅ 多 workspace 切换
- ✅ Default workspace 自动创建（首次发消息时 `<home>/PiAgent/`）
- ✅ Workspace 路径 system prompt 注入（v0.3.8.11+）
- 🟡 Workspace 列表 UI（侧边栏下拉）
- 🟡 Workspace 添加（picker）— 已有对话框入口
- 🟡 Workspace 文件树浏览 — 基础有，深度有限
- 🟡 Workspace 切换 → session pool 切换
- ❌ 实际文件读/写工具（v0.4 必做）
- ❌ 文件监听（v0.5+）
- ❌ 索引 / 全文搜索（v0.5+）
- ❌ Git 集成（v0.6+）— diff / log / blame

### 1.2 不做什么

- ❌ Workspace 加密（用户自己 OS 加密）
- ❌ 远程 workspace（SFTP / 云盘）— v2.0+ 再说
- ❌ 多 workspace 并行（同时打开两个）— UX 复杂，v0.4 之后

---

## 2. 当前实现

| 文件 | 职责 |
|---|---|
| `app/src/stores/chat.ts` | active workspace + workspacePath 注入 send_prompt |
| `app/src/components/Sidebar/WorkspaceTree.vue` | 文件树 UI（基础）|
| `app/src/components/Sidebar/Sidebar.vue` | workspace 切换下拉 |
| Tauri `dialog.ts` | 文件夹选择对话框 |
| `sidecar/src/openai-compatible.mjs` | workspacePath 注入 system message |

### 2.1 System Prompt 注入（v0.3.8.11）

```javascript
// openai-compatible.mjs
const systemMsg = config.workspacePath
  ? `你的工作目录是 ${config.workspacePath}。用户希望你读写这个目录下的文件。
     （注意：当前 sidecar 还没有 file system tools，LLM 只能"描述"会做什么，
     后续 v0.3.9+ 接 tool_calls 才能真写文件。）`
  : null;
```

**当前 LLM 实际状态**：知道 cwd，但**没工具**操作 — 只能告诉用户"我会改 X 文件"。

### 2.2 Default workspace

- 首次 `sendMessage` 触发 `ensureDefaultWorkspace()` Rust command
- 自动创建 `<home>/PiAgent/`
- 用户可后续手动改到别的目录

### 2.3 文件树

- 当前 v0.3.8.x 已有基础树形展示
- 不递归（默认 1-2 层）
- 没监听文件变化（要刷新才知道）
- 没排序 / 过滤

---

## 3. 已知问题 / 限制

- 🟡 文件树只读，不能右键"新建 / 重命名 / 删除"
- 🟡 切换 workspace 时 session 列表会闪（loading 状态没做）
- 🟡 Default workspace 路径用户看不到（隐藏在 Rust 内部）
- 🟡 没有"最近使用 workspace"列表
- 🟡 文件树加载大目录（1000+ 文件）会卡

---

## 4. 待办（Roadmap）

### P0（v0.4 必做）
- [ ] **实际文件工具**（`read_file` / `write_file` / `edit_file` / `list_dir` / `glob` / `grep`）— 跟 [tools.md](tools.md) 联动
- [ ] 路径校验（path traversal 拒绝）
- [ ] 工具权限 UI（"agent 申请读 X 文件" → confirm）

### P1（v0.4 - v0.5）
- [ ] 文件树右键菜单（新建 / 重命名 / 删除）
- [ ] 文件监听（自动 refresh 树）
- [ ] Recent workspaces 列表

### P2（v0.5+）
- [ ] 全文搜索（ripgrep 集成）
- [ ] Git 集成（status / diff / log）
- [ ] 多 workspace 并行（tab 切换）
- [ ] Workspace 设置（排除目录 / 包含规则）

---

## 5. Changelog

- **2026-08-16 · v0.3.8.12** · inline workspace 操作按钮
- **2026-08-16 · v0.3.8.11** · workspacePath 注入 system message
- **2026-08-15 · v0.3.5** · ensureDefaultWorkspace + workspace 列表
- **2026-08-14 · v0.3.3** · real workspace 接入 sidecar
- **2026-08-10 · v0.2** · workspace 概念引入（无实际工具）
