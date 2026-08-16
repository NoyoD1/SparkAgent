# 多平台 (Platforms)

> 状态: ❌ 0% (Windows only 当前)
> 最后更新: 2026-08-16
> spec 涉及: Tauri targets + 平台适配

---

## 1. Spec

**Windows 是 v1.0 目标平台**。macOS / Linux 后续。Web / Mobile 不在 v1.x roadmap。

### 1.1 平台支持矩阵

| 平台 | 状态 | 计划 | 关键挑战 |
|---|---|---|---|
| **Windows 10/11** | ✅ v0.3+ | 已支持 | — |
| **macOS 13+** | ❌ | v0.9 目标 | Apple Silicon / Intel / 签名 / 公证 |
| **Linux (Ubuntu / Fedora)** | ❌ | v0.9 目标 | WebKitGTK 版本碎片 / AppImage / deb / rpm |
| **Web** | ❌ | **不做** | v0.2 形态已废弃，回归无意义 |
| **iOS / Android** | ❌ | **不做（v1.x）** | Tauri Mobile 仍在 beta，UX 差异大 |
| **ChromeOS** | ❌ | 不做 | 同 Linux 路径，但 Tauri 支持有限 |

### 1.2 不做什么

- ❌ Web 形态（用户已经在桌面 app，回归 Web 无价值）
- ❌ 移动端（v1.x 不考虑）
- ❌ ChromeOS（v1.x 不考虑）

---

## 2. 当前实现

### 2.1 Tauri 编译目标

```toml
# src-tauri/Cargo.toml
[target.'cfg(target_os = "windows")'.dependencies]
# Windows-only 依赖（keyring crate 走 Windows API）
```

- `tauri.conf.json` `bundle.targets: "all"` — 自动编译 macOS / Linux / Windows 多目标
- 但**只测过 Windows**

### 2.2 平台特定代码

- `keyring.rs` — Windows Credential Manager / macOS Keychain / Linux Secret Service（keyring crate 跨平台）
- `tauri.conf.json` `decorations: false` 行为在 macOS 略有不同（v0.9 测）
- WebView2 是 Windows 专属 — macOS 用 WKWebView，Linux 用 WebKitGTK

---

## 3. 已知问题 / 限制

- 🟡 完全没有 macOS / Linux 编译测试
- 🟡 macOS 签名 / 公证流程没走（App Store 之外分发需要）
- 🟡 Linux 桌面环境碎片化（GNOME / KDE / XFCE 表现可能不同）
- 🟡 没有自动构建多平台 binary 的 CI

---

## 4. 待办（Roadmap）

### P0（v0.9 必做）

#### macOS
- [ ] 真机编译测试（Apple Silicon + Intel）
- [ ] 代码签名（Developer ID）
- [ ] 公证（Notarization）
- [ ] DMG / pkg 打包
- [ ] macOS 特定 UI 适配（Dock / Menu Bar / 全局菜单）
- [ ] 快捷键适配（Cmd vs Ctrl）

#### Linux
- [ ] Ubuntu 22.04 / Fedora 最新版真机测试
- [ ] AppImage 打包
- [ ] .deb / .rpm 打包
- [ ] WebKitGTK 版本兼容
- [ ] 字体 / 滚动条适配（Linux 字体比 Windows 细）

### P1（v1.0+）
- [ ] CI/CD 多平台自动构建
- [ ] 平台特定快捷键文档
- [ ] 平台特定 bug 修复

### P2（v2.0+ — 暂不做）
- [ ] iOS / Android（Tauri Mobile 稳定后）
- [ ] Web（如果有强烈需求）

---

## 5. Changelog

- **2026-08-12 · v0.3** · Windows 桌面 app 编译通过
- **2026-08-10 · v0.2** · Web 形态（已废弃）
