# Desktop 集成 (Tauri 2)

> 状态: 🟡 50%
> 最后更新: 2026-08-16
> spec 涉及: `src-tauri/` 全部 + `app/src/components/TitleBar.vue`

---

## 1. Spec

**Tauri 2 桌面 app**，不是 Web / 不是 CLI / 不是 IDE 插件。Windows 优先，macOS / Linux 后续。

### 1.1 必备能力

- ✅ **窗口控制**（v0.3.8.21+）— 自定义 title bar，minimize / maximize / close
- ✅ **窗口尺寸**：默认 1280×800，最小 960×600
- ✅ **OS keychain 集成** — `keyring.rs`（Windows Credential Manager）
- ✅ **进程管理** — sidecar spawn + lifecycle
- ✅ **文件对话框** — `dialog:default` capability
- ✅ **启动 dragging** — title bar drag region
- ✅ **isMaximized 状态查询** — UI 同步显示 maximize/restore icon
- 🟡 **fs 权限** — v0.4 必加（当前 capabilities 还没 `core:fs:allow-*`）
- 🟡 **shell 权限** — v0.4 必加（`core:shell:allow-execute` 之类）
- ❌ **系统托盘**（tray icon + quick actions）— 未做
- ❌ **全局快捷键**（Ctrl+Shift+P 唤起 app）— 未做
- ❌ **多窗口**（一个 session 一个窗口）— 未做
- ❌ **自动更新**（`tauri-plugin-updater`）— v1.0 必做
- ❌ **系统通知**（agent 完成时通知）— v0.5
- ❌ **Dock / Menu Bar**（macOS）— v0.9
- ❌ **文件关联**（`.piagent` / `.md` 双击打开）— v1.0
- ❌ **崩溃上报**（`tauri-plugin-sentry`）— v1.0

### 1.2 不做什么

- ❌ 浏览器插件形态
- ❌ Web 形态（v0.2 已废弃）
- ❌ 移动端

---

## 2. 当前实现

| 文件 | 职责 |
|---|---|
| `src-tauri/src/main.rs` | 入口 |
| `src-tauri/src/lib.rs` | Tauri Builder + commands 注册 |
| `src-tauri/src/sidecar.rs` | spawn sidecar + IPC bridge |
| `src-tauri/src/keyring.rs` | OS keychain 增删查 |
| `src-tauri/src/config_store.rs` | provider 配置 JSON 持久化（原子写）|
| `src-tauri/src/index_file.rs` | session 文件管理 |
| `src-tauri/tauri.conf.json` | 窗口配置 / 打包 / identifier |
| `src-tauri/capabilities/default.json` | 权限白名单 |
| `app/src/components/TitleBar.vue` | 自定义 title bar + 窗口控制按钮 |
| `app/src/lib/tauri.ts` | invoke + listen 包装 |

### 2.1 当前 capabilities

```json
{
  "permissions": [
    "core:default",
    "core:window:allow-minimize",
    "core:window:allow-maximize",
    "core:window:allow-unmaximize",
    "core:window:allow-toggle-maximize",
    "core:window:allow-close",
    "core:window:allow-start-dragging",
    "core:window:allow-is-maximized",
    "dialog:default"
  ]
}
```

**缺失**（v0.4 必加）：
- `core:fs:allow-read-text-file`
- `core:fs:allow-write-text-file`
- `core:fs:allow-read-dir`
- `core:fs:allow-exists` / `allow-mkdir` / `allow-remove`
- `core:shell:allow-execute`（受限，命令白名单）
- `core:path:default`（路径操作）

### 2.2 窗口配置（v0.3.8.21+）

```json
{
  "title": "Pi Agent",
  "width": 1280,
  "height": 800,
  "minWidth": 960,
  "minHeight": 600,
  "resizable": true,
  "fullscreen": false,
  "decorations": false
}
```

- `decorations: false` — 关掉原生 title bar，用自定义
- Windows 11 窗口自身 8px 圆角 — v0.3.8.22 适配
- title bar 顶角圆 + body padding 10px 适配

### 2.3 进程模型

- Tauri 主进程：整个 app 生命周期
- WebView2：Tauri 内嵌
- Sidecar：每 prompt spawn，结束即退

---

## 3. 已知问题 / 限制

- 🟡 Sidecar 启动 ~200ms 延迟（每 prompt 重新 spawn）
- 🟡 没有 sidecar 进程池（v0.4 考虑加 LRU 池）
- 🟡 WebView2 缓存偶尔清掉（v0.3.8+ 改 Rust 文件持久化缓解）
- 🟡 没有崩溃恢复（app 崩了要重新打开）
- 🟡 启动速度依赖 WebView2 加载
- 🟡 没有"开机自启"开关

---

## 4. 待办（Roadmap）

### P0（v0.4 必做）
- [ ] Tauri fs / shell 权限
- [ ] Sidecar 进程池（LRU，warm start）

### P0（v1.0 必做）
- [ ] 自动更新（`tauri-plugin-updater`）
- [ ] 崩溃上报（opt-in）

### P1
- [ ] 系统托盘 + 快速操作
- [ ] 全局快捷键
- [ ] 系统通知（agent 完成时）
- [ ] 开机自启开关
- [ ] 多窗口（一个 session 一个窗口）

### P2（v0.9+）
- [ ] macOS Dock / Menu Bar 适配
- [ ] Linux 桌面集成（AppImage / deb / rpm）
- [ ] 文件关联（双击 `.piagent` 打开）

---

## 5. Changelog

- **2026-08-16 · v0.3.8.22** · Windows 11 窗口圆角 + body padding
- **2026-08-16 · v0.3.8.21** · `decorations: false` + 自定义 title bar + 窗口控制
- **2026-08-15 · v0.3.5** · 窗口尺寸 / 最小尺寸
- **2026-08-13 · v0.3.1** · Tauri keychain + dialog capability
- **2026-08-12 · v0.3** · Tauri 2 骨架（编译通过 + sidecar spawn）
