# ADR-0013: Workspace 模块 (多工作区 / 沙箱)

- **状态**: Accepted
- **日期**: 2026-08-19
- **Type**: Functional
- **Module**: Workspace
- **决策者**: user

## 功能定义 (应该做什么)

- ✅ 多 workspace 支持 (每个是本地文件夹)
- ✅ 文件夹选择 (Tauri dialog picker)
- ✅ Workspace 列表
- ✅ Workspace 切换
- ✅ Workspace 展开 / 折叠
- ✅ Workspace 删除 (连同 sessions)
- ✅ Default workspace `<home>/PiAgent/` (没 workspace 时自动建)
- ✅ Workspace 沙箱: write / edit 工具的 path 必须在 workspacePath 之下
- 🟡 文件树浏览器
- 🟡 Workspace 切换 loading flash (UX)
- ❌ 跨 workspace 共享上下文
- ❌ Workspace 模板

## 已实现 (v0.5.9+)

| 功能 | 状态 | 实现位置 | 核验方法 |
|---|---|---|---|
| 多 workspace 列表 | ✅ | `app/src/components/Sidebar/WorkspaceTree.vue` | 看到多 workspace 树 |
| 文件夹选择 | ✅ | `pickFolder('选择工作区文件夹')` | 点 + 按钮, 系统 picker 弹出 |
| Workspace 切换 | ✅ | `sessionStore.selectWorkspace` | 点不同 workspace, sidebar 切换 |
| 展开 / 折叠 | ✅ | `sessionStore.toggleWorkspaceExpanded` | 点 chevron, 看折叠 |
| Workspace 删除 | ✅ (走 `confirm()`) | `sessionStore.removeWorkspace` | 点删除, 浏览器 confirm 弹窗 |
| Default workspace | ✅ | `ensureDefaultWorkspace` | 没 workspace 时自动建 |
| Workspace 沙箱 | ✅ | sidecar `isPathWithinWorkspace` | write / edit 到 workspace 外部, 被 block |

## 核验方法 (端到端)

### 多 workspace 基础
1. 加 workspace A (e.g. `D:\test\A`)
2. 加 workspace B (e.g. `D:\test\B`)
3. 切 A, 创 session, 发 1 条
4. 切 B, 创 session, 发 1 条
5. 看 sidebar 两个 workspace 各自有 session

### Default workspace
1. 清 localStorage (`pi-agent:session:v1`)
2. 重开 app
3. 验证自动建 `<home>/PiAgent/`, 出现在 sidebar
4. 发消息, 走 `ensureDefaultWorkspace` 自动创

### Workspace 沙箱 (关键)
1. 切到 workspace A (`D:\test\A`)
2. 让 LLM 写文件到 `D:\test\A\inside.txt` → 成功
3. 让 LLM 写文件到 `D:\outside.txt` (workspace 外部) → 被 block, Permission 弹窗拒绝
4. 让 LLM 写文件到 `D:\test-evil\evil.txt` (类似 prefix 误判) → 被 block (path 校验防 prefix 误判)
5. 读类 (read / ls / grep / find) 不强制, 跨目录查询 OK

## 已知问题 / 技术债

- 🟡 **删除走 `confirm()`**: 跟 session 同样问题
- 🟡 **切换 loading flash**: 切 workspace 时 session 列表会跳变 (sidecar 重启 + setSessionFile 期间)
- 🟡 **没文件树 UI**: 用户看不到 workspace 里有啥文件, 只能从 LLM tool call 结果看
- 🟡 **沙箱只对 write / edit**: bash 走 permission 兜底, 不能静态检查
- 🟡 **Windows 大小写**: 沙箱校验做了大小写不敏感, 但路径可能有 unicode 边界

## 后续规划

### P0 (v0.6)
- Workspace 删除 in-app 弹窗
- 切 workspace loading state polish

### P1 (v0.6 - v0.7)
- 文件树浏览器 (左 sidebar, 点开看)
- Workspace 模板 (git clone 后自动选 template)

### P2 (v0.7+)
- 跨 workspace 共享上下文 (per-session 隔离的反向需求)
