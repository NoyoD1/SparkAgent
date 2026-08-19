# ADR-0001: Tauri 2 桌面壳

- **状态**: Accepted
- **日期**: 2026-08-12
- **决策者**: user
- **Relates to**: [0002-data-local-byok](0002-data-local-byok.md), [0004-tauri-invoke-listen](0004-tauri-invoke-listen.md)

## 背景

桌面 AI Agent 客户端需要: 系统集成 (托盘 / 快捷键 / 窗口) / 本地文件访问 / 安全沙箱 / 小 bundle / 跨平台。

## 备选

- **A. Tauri 2 (Rust + WebView)** — 选这个
- B. Electron (Chromium + Node) — bundle 100MB+, 内存 200MB+
- C. Flutter Desktop — 原生性能好, 但 Web 生态弱
- D. 原生 Swift/Kotlin — 跨平台成本高

## 决策

**Tauri 2**:
- Rust 核心 + 系统 WebView (Windows WebView2 / macOS WKWebView / Linux WebKitGTK)
- Bundle: ~15-25 MB (.exe) / 46 MB (.msi installer) / 32 MB (NSIS)
- 内存: ~80-120 MB idle
- 启动: ~200 ms cold
- 生态: invoke/listen IPC + Rust crate + npm sidecar

## 后果

- ✅ Bundle 小, 安装快
- ✅ 内存低, 启动快
- ✅ Rust 后端安全 (类型 + 内存安全)
- ✅ 跨平台代码 95% 复用
- ❌ WebView2 跟系统绑定, Win7 装不了 (用户接受, 至少 Win10)
- ❌ WebView 跟 Chrome 差 2-3 个 minor version (某些新 CSS 特性不支持)

## 何时 Revisit

- WebView 出现严重兼容性问题 → 评估迁移
- Tauri 3.x 重大 API 变化 → 评估升级成本
- Flutter Desktop Web 生态追上 → 重新对比
