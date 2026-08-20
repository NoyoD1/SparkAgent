# ADR-0013: Workspace 模块 (多工作区 / 沙箱)

- **状态**: Accepted
- **日期**: 2026-08-19 (初版) / 2026-08-20 v0.6 阶段 1 / 2026-08-20 v0.6.1 (文件树改二级页面 + 引用入 composer) / 2026-08-20 v0.6.1.1 (字号统一 + 429 友好提示 + log 抑制 + process 修复)
- **Type**: Functional
- **Module**: Workspace
- **决策者**: user

## 功能定义 (应该做什么)

- ✅ 多 workspace 支持 (每个是本地文件夹)
- ✅ 文件夹选择 (Tauri dialog picker)
- ✅ Workspace 列表
- ✅ Workspace 切换
- ✅ Workspace 展开 / 折叠
- ✅ Workspace 删除 (连同 sessions) — **v0.6**: 改用 in-app ConfirmDialog (0.1)
- ✅ Default workspace `<home>/PiAgent/` (没 workspace 时自动建) — **v0.6**: 加 `isDefault` 标记 + 列表徽标 (0.4)
- ✅ Workspace 沙箱: write / edit 工具的 path 必须在 workspacePath 之下
- ✅ 文件树浏览器 — **v0.6 新增 (2.1) / v0.6.1 改造**: workspace head `FolderOpen` 按钮 → 二级页面模式, sidebar 整块显示文件树, session + archive 隐退; 文件行点击 → 引用到 composer chip
- ✅ Workspace 切换 loading flash (UX) — **v0.6**: store 加 `isSwitchingWorkspace` flag (0.3)
- ✅ **v0.6 新增 (0.2)**: 重复添加 workspace 防护 (同路径 / 父子嵌套自动 dedup)
- ✅ **v0.6 新增 (2.2)**: Workspace 模板 — 选择已有 / 新建空 / Git 克隆
- ✅ **v0.6.1 新增**: 文件引用 (file reference) 机制 — 文件树点文件 → composer chip → send 时拼成 markdown code block 注入 LLM
- ⏳ 跨 workspace 共享上下文 — 阶段 2, 仅设计
- ⏳ Workspace 重命名 UI — 阶段 2, 触发式
- ⏳ 多窗口支持 — 阶段 2, 触发式

## 已实现 (v0.5.9 + v0.6 阶段 1 + v0.6.1 + v0.6.1.1)

### 核心 (v0.5.9+)

| 功能 | 状态 | 实现位置 | 核验方法 |
|---|---|---|---|
| 多 workspace 列表 | ✅ | `app/src/components/Sidebar/WorkspaceTree.vue` (`v-for="ws in workspaces"`) | 看到多 workspace 树 |
| 文件夹选择 | ✅ | `app/src/lib/dialog.ts:9` (Tauri `pickFolder`) | 点 + → 选 "选择已有文件夹" 模板, 系统 picker 弹出 |
| Workspace 切换 | ✅ | `app/src/stores/session.ts:490` (`selectWorkspace`) | 点不同 workspace, sidebar 切换 |
| 展开 / 折叠 | ✅ | `app/src/stores/session.ts:297` (`toggleWorkspaceExpanded`) | 点 chevron, 看折叠 |
| Workspace 删除 | ✅ (in-app ConfirmDialog) | `app/src/components/Sidebar/WorkspaceTree.vue:312-335` (走 `showConfirm` 流) | 点 trash → in-app 弹窗, 列 session 数 + Pi SDK jsonl 提示 |
| Default workspace | ✅ (有 isDefault 标记) | `app/src/stores/session.ts:306` (`addWorkspace` 接 `isDefault`) + `tauri.ts:711` (`ensureDefaultWorkspace`) | 没 workspace 时自动建, 列表显示 "默认" 徽标 |
| Workspace 沙箱 | ✅ | `sidecar/src/index.mjs:584` (`isPathWithinWorkspace`) + 调用 at `:493-503` | write / edit 到 workspace 外部, 被 block |

### v0.6 阶段 1 新增

| 功能 | 状态 | 实现位置 | 核验方法 |
|---|---|---|---|
| 重复添加 dedup (0.2) | ✅ | `app/src/stores/session.ts:131` (`detectWindowsPath`) + `:136` (`normalizePathForCompare`) + `:159` (`pathRelation`) + `addWorkspace` at `:306` | 加同路径 / 父子嵌套第二次, console.warn + 复用已有 |
| 切 ws loading state (0.3) | ✅ | `app/src/stores/session.ts:186` (`isSwitchingWorkspace`) + `:490` (`selectWorkspace`) + `:509` (`finishWorkspaceSwitch`) | 切 ws 期间 sidebar 显示 "切换中" 条 + sendPrompt 拒绝 |
| Default workspace 徽标 (0.4) | ✅ | `app/src/components/Sidebar/WorkspaceTree.vue:671-675` (Home icon + "默认") | sidebar 列表看 default ws 名字旁的徽标 |
| 删 default 弹窗升级 (0.4) | ✅ | `app/src/components/Sidebar/WorkspaceTree.vue:312-335` | 删 default ws, 弹窗文案说明 "删了下次自动重建" |
| 文件树浏览器 (2.1) | ✅ (v0.6.1 改二级页面) | `app/src/components/Sidebar/WorkspaceFileTree.vue` + `src-tauri/src/lib.rs:1753` (`list_workspace_tree`) + `:1708` (`read_tree_recursive`) | workspace head 点 `FolderOpen` → sidebar 整块变文件树, 顶部 "返回" 复原; 文件行点击 → 引用入 composer |
| Workspace 模板 (2.2) | ✅ | `app/src/components/Sidebar/WorkspaceTemplateMenu.vue` + `src-tauri/src/lib.rs:1771` (`create_empty_dir`) + `:1802` (`git_clone`) | 点 + 看 3 选项菜单 |

### v0.6.1 新增 — 文件引用 (file reference)

| 功能 | 状态 | 实现位置 | 核验方法 |
|---|---|---|---|
| 文件引用 state | ✅ | `app/src/stores/chat.ts:443` (`fileRefsBySession`) + `:444-462` (`addFileRef` / `removeFileRef` / `clearFileRefs`) | 加 chip → store 更新, 切 session 不丢 |
| Composer 渲染 chip | ✅ | `app/src/components/ChatMain/Composer.vue:106-115` (`currentFileRefs` + `removeFileRef`) + template `:512-531` + CSS `:746+` | 文件树点文件 → composer 上方出现 `📄 文件名 ×` chip; 点 X 移除 |
| sendPrompt 拼装 | ✅ | `app/src/stores/chat.ts:843-862` (拼接 markdown 块) | 发消息 → F12 console 看 `[chat] sendPrompt: with fileRefs (count=...)` |
| WorkspaceFileTree emit | ✅ | `app/src/components/Sidebar/WorkspaceFileTree.vue:37` (`reference-file` event) + `:77-79` (`onFileClick`) | 文件行 hover → cursor pointer; 点击 → 上层 addFileRef |
| 二级页面 mode | ✅ | `app/src/components/Sidebar/WorkspaceTree.vue:86` (`fileTreeModeWorkspaceId`) + `:92-101` (`openFileTree` / `closeFileTree`) + template `:546-555` | 点 FolderOpen → 整 sidebar 切换; 点返回 → 复原 |

### v0.6.1.1 新增 — 体验优化 + bug fix

| 功能 | 状态 | 实现位置 | 核验方法 |
|---|---|---|---|
| 文件树字号统一 | ✅ | `app/src/components/Sidebar/WorkspaceFileTree.vue` 全 CSS (font 12px / icon 12px / row 22px min-height / 缩进 14px) | 切到文件树, 字号跟 session 列表视觉一致 |
| 429 友好错误提示 | ✅ | `app/src/stores/chat.ts:337` (`friendlyErrorMessage`) + 在 `pushErrorDivider` at `:309` + `sendPrompt` catch at `:1548` | 触发 429 → 中文友好提示, 不再裸 JSON |
| log 抑制 (per-event noise) | ✅ | `app/src/stores/chat.ts:927` (跳过 `message_update` 的 per-event log) | F12 console 一个 turn 只剩 5-7 行有意义日志 |
| 平台检测 (process → TAURI internals) | ✅ | `app/src/stores/session.ts:131-152` (`detectWindowsPath` + `__TAURI_INTERNALS__.platform` 兜底) | 浏览器无 `process` 也不崩; 旧 localStorage 数据能正确加载 |

## Tauri commands (v0.6 阶段 1 新增)

```rust
// 2.1 — list_workspace_tree(path, max_depth?)
async fn list_workspace_tree(path: String, max_depth: Option<u32>) -> Result<Vec<WorkspaceTreeNode>, String>  // :1753

// 2.2 — create_empty_dir(parent, name)  →  返回新建目录的绝对路径
async fn create_empty_dir(parent: String, name: String) -> Result<String, String>  // :1771

// 2.2 — git_clone(url, parent)  →  返回 clone 出来的目录绝对路径
async fn git_clone(url: String, parent: String) -> Result<String, String>  // :1802
```

注册位置: `src-tauri/src/lib.rs:1896-1913` (`invoke_handler`).

实现要点:
- `list_workspace_tree`: 走 `tokio::task::spawn_blocking` 跑 `std::fs::read_dir`, 跳过大目录 (`.git` / `node_modules` / `target` / 等), 硬上限 5 层, 用 `symlink_metadata` 不跟 symlink (防 sandbox 逃逸)
- `create_empty_dir`: 校验 name 不含路径分隔符, 拒绝已存在, 走 `spawn_blocking`
- `git_clone`: 直接 `std::process::Command::new("git")` (不走 Tauri shell plugin, 避免再加 capability), 错误带 stderr 给 UI

## 核验方法 (端到端)

### 多 workspace 基础 (原)
1. 加 workspace A (e.g. `D:\test\A`)
2. 加 workspace B (e.g. `D:\test\B`)
3. 切 A, 创 session, 发 1 条
4. 切 B, 创 session, 发 1 条
5. 看 sidebar 两个 workspace 各自有 session

### Default workspace (原 + v0.6 增强)
1. 清 localStorage (`pi-agent:session:v1`)
2. 重开 app
3. 验证自动建 `<home>/PiAgent/`, 出现在 sidebar, **名字旁有 "默认" 徽标**
4. 发消息, 走 `ensureDefaultWorkspace` 自动创
5. (v0.6) 删这个默认 ws → 弹窗文案升级, 提示 "删了下次自动重建"

### Workspace 沙箱 (原)
1. 切到 workspace A (`D:\test\A`)
2. 让 LLM 写文件到 `D:\test\A\inside.txt` → 成功
3. 让 LLM 写文件到 `D:\outside.txt` (workspace 外部) → 被 block, Permission 弹窗拒绝
4. 让 LLM 写文件到 `D:\test-evil\evil.txt` (类似 prefix 误判) → 被 block (path 校验防 prefix 误判)
5. 读类 (read / ls / grep / find) 不强制, 跨目录查询 OK

### v0.6 阶段 1 新增

**重复添加 dedup (0.2)**:
1. 加 `D:\test\A`
2. 再加 `D:\test\A` (同路径) → console.warn "exact match", 复用已有 ws, UI 不创建
3. 加 `D:\test\A\sub` (子路径) → console.warn "descendant match", 复用
4. 加 `D:\test` (父路径) → console.warn "ancestor match", 复用

**切 ws loading state (0.3)**:
1. 创 ws A, 创 session, 发消息
2. 创 ws B, 点 B → sidebar session 区出现 "切换中,稍候..." 旋转条
3. 切期间快速点 composer 发消息 → 拒绝, 显示 "工作区切换中, 请稍候再发"
4. 等切完 (通常 < 1.5s), loading 条消失, 可发消息

**文件树浏览器 (2.1, v0.6.1 二级页面模式)**:
1. 创个 test workspace, 里面建 `src/`, `src/index.ts`, `README.md`
2. 切到这个 ws, hover 名字 → 看 ws head 出现 `FolderOpen` 按钮
3. 点 `FolderOpen` → sidebar 整块变成文件树 (session 列表 + archive 隐退), 顶部 "返回" 按钮可见
4. 目录点 chevron 展开 / 折叠 (2 层默认)
5. 文件行 hover → 变可点击 cursor; 点文件 → composer 出现 chip (icon + 文件名 + X)
6. 点 chip 的 X → 移除引用; 顶部 "返回" → 复原 session 列表
7. (e2e) 切到新 session, composer 输入消息, 加 2 个文件 ref, 发消息 → LLM 收到 markdown 块:
   ```
   以下文件被引用 (来自当前工作区):
   `D:\test\A\src\index.ts`
   `D:\test\A\README.md`

   <user text>
   ```
8. 切到别的 session, ref 还在 (per-session 存储)
9. 看 100 个 node_modules 文件的目录 → 不显示 (skip 大目录)
10. **(v0.6.1.1) 文件树字号跟 session 列表一致 (12px)**

**Workspace 模板 (2.2)**:
1. 点 sidebar 顶部 + → 下拉菜单出 3 选项
2. 选 "新建空目录" → 弹小 dialog, 填 "my-proj", 点确定 → 选父目录 → 创建并切到这个新 ws
3. 删这个 ws, 再走一次: 选 "从 Git 克隆" → 填 `https://github.com/octocat/Hello-World` → 选父目录 → 等 clone 完 → 自动切到 clone 出的目录
4. clone 失败 (URL 错) → 弹 dialog 显 stderr

### v0.6.1.1 新增

**429 友好错误**:
1. 故意发长消息触发 429 (快速连发 / 长 session + 引用大文件)
2. 看错误提示是中文友好版 ("LLM 限流 (429: TPM/Quota 触发)..."), 不再裸 JSON
3. 末尾保留原始错误方便排查

**log 抑制**:
1. 发一条消息, F12 console
2. 整个 LLM 流式响应期间, `[chat] event: ...` 日志**只在 message_start / end / turn_* / agent_* 触发时打印**
3. 不再每个 token chunk 一行 (message_update 跳过)

**平台检测修复 (process → TAURI internals)**:
1. 启动 app, F12 console
2. 没有 `ReferenceError: process is not defined`
3. 旧 localStorage 的 workspaces 能正确加载, `pathNormalized` lazy 补齐

## 已知问题 / 技术债

- 🟡 ~~**删除走 `confirm()`**~~ — **v0.6 已修**: 改用 in-app ConfirmDialog (跟 session 删除一致)
- 🟡 ~~**切换 loading flash**~~ — **v0.6 已修**: `isSwitchingWorkspace` flag + 1.5s 兜底 + sidecar `message_start` 早清
- ✅ ~~**没文件树 UI**~~ — **v0.6 / v0.6.1 已修**: 文件树组件 + 二级页面模式 + 引用入 composer
- 🟡 **沙箱只对 write / edit** — bash 走 permission 兜底, 不能静态检查 (不变)
- 🟡 **Windows 大小写** — 沙箱校验做了大小写不敏感, 但路径可能有 unicode 边界 (不变)
- 🟡 **同 ws 切换不取消 in-flight sendPrompt** — `selectWorkspace` 在 ws 内部(同 id) 直接 return, 是 no-op, 但已有 in-flight 的 sendPrompt 不会被打断 (新加)
- 🟡 **文件树模式切 workspace 不退出** — 在文件树模式时切别的 ws, 二级页面继续显示新 ws 的文件树. 这是合理的(同模式跨 ws 看文件)但容易让用户忘记自己在 "文件树模式" 里. (v0.6.1 新加)
- 🟡 **文件引用不持久化** — file ref chip 跟 quote 一样只在内存, 刷新页面就清. (跟 quote 行为一致, 设计上故意)
- 🟡 **git clone 没 timeout** — 大 repo 等很久没进度反馈 (已知风险, 见下)

## 已知风险 (暂时接受, 见 ADR-0013 1.3 阶段)

- **Symlink 逃逸**: workspace 内 symlink 指到外部, write 会通过 symlink 写到外面.
  - 当前缓解: `list_workspace_tree` 用 `symlink_metadata` 不跟 symlink (UI 不展示 symlink).
  - **没缓解**: `isPathWithinWorkspace` 沙箱校验仍用 `path.resolve` 不跟 symlink.
  - 暂时依赖"用户不要在自己 workspace 里塞恶意 symlink"作为前提.
- **Unicode normalization**: macOS NFD vs Windows/Linux NFC, 跨平台复制后字符串比对可能判错.
  - 当前 `normalizePathForCompare` 只处理大小写, 不处理 NFD/NFC.
  - 影响范围: dedup 0.2 在跨平台复制文件后可能误判同路径为不同.
- **bash 工具沙箱盲区**: bash 命令里塞任意路径, 静态检查不覆盖, 走 permission mode 兜底.
  - 走 permission dialog 兜底, 用户有最终决定权.
- **multi-file tool 未雨绸缪**: 当前 `isPathWithinWorkspace` 只看 `toolArgs.path || toolArgs.filePath`.
  - 未来 Pi SDK 加 multi-file tool 这里会漏.
- **git clone 没 timeout**: 拉大 repo 用户等很久没进度反馈.
  - 当前只走 std::process, 阻塞等 exit code. 后续可加 tokio::time::timeout + 进度 emit.
- **429 TPM 限流**: 长 session 累积 token 容易触发 provider TPM 配额. 已在 v0.6.1.1 加友好提示, 但**根本解决是压缩 session / 用付费 plan / 短 session**.

## 后续规划

### 阶段 2 (后续)

- 跨 workspace 共享上下文 (per-session 隔离的反向需求)
- Workspace 重命名 UI
- 多窗口支持 (per-window active workspace)
- Sandbox 增强 (symlink realpath)
- git clone timeout + 进度
- **新增 (v0.6.1)**: 文件引用 → 可拖拽到 composer / 可在 chat 区域显示 inline 引用 blockquote (跟 quote 一致视觉)
- **新增 (v0.6.1)**: 多选文件批量引用

### 已完成的 P0/P1/P2 (v0.6 阶段 1 + v0.6.1 + v0.6.1.1)

- [x] 0.1: 删除 workspace 改 in-app 弹窗
- [x] 0.2: addWorkspace dedup
- [x] 0.3: 切 workspace loading state
- [x] 0.4: Default workspace 标记 + 删时保护
- [x] 1.1: ADR 表格修正 (实现位置列细化)
- [x] 1.2: 弹窗文案对齐 Pi SDK jsonl 说明
- [x] 1.3: 已知风险节
- [x] 2.1: 文件树浏览器 (v0.6.1 改二级页面 + 引用入 composer)
- [x] 2.2: Workspace 模板
- [x] v0.6.1: 文件引用机制 (file ref state + chip + sendPrompt 拼接)
- [x] v0.6.1.1: 文件树字号统一 (12px 跟 session 对齐)
- [x] v0.6.1.1: 429 友好错误提示
- [x] v0.6.1.1: log 抑制 (跳过 message_update per-event log)
- [x] v0.6.1.1: 平台检测修复 (process → __TAURI_INTERNALS__.platform + 路径特征兜底)
