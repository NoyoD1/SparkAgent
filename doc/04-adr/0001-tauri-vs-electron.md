# ADR-0001: Tauri 2 vs Electron

- **状态**: Accepted
- **日期**: 2026-08-12
- **决策者**: 用户

## 背景

需要做桌面 app，候选有多个框架。Pi Agent 走 BYOK 路线，本机敏感操作多（OS keychain / 文件 / shell），包大小 / 内存 / 启动速度对体验影响大。

## 备选

### Tauri 2 (Rust + WebView2)
- ✅ 包小（~10MB，对比 Electron ~150MB）
- ✅ 内存占用低（共享系统 WebView）
- ✅ Rust 后端 — 适合 keychain / fs / shell / 进程管理
- ✅ 跨平台统一接口（macOS Keychain / Linux Secret Service 抽象）
- ❌ Rust 学习曲线（维护成本）
- ❌ WebView2 平台限制（Windows 10+ 需预装 WebView2 runtime）
- ❌ 生态比 Electron 小

### Electron (Node + Chromium)
- ✅ 生态成熟（VSCode / Slack / Discord 都是）
- ✅ Web 前端开发者多
- ❌ 包大（~150MB）
- ❌ 内存高（每个 app 一个 Chromium）
- ❌ Node 后端 + Web 前端，敏感操作要走 Node（多一层风险）

### Wails (Go + WebView)
- ✅ 包小
- ✅ Go 后端简单
- ❌ 生态最小
- ❌ Go 维护成本（团队不熟）

### Flutter Desktop
- ✅ 跨平台一致
- ❌ Dart 学习曲线
- ❌ Web 技术栈投入归零

## 决策

**Tauri 2**。

理由：
1. 包小 / 内存低 — BYOK 桌面 app 启动要快
2. Rust 后端 — keychain / fs / shell / 进程管理是核心需求，Rust 表达力 + 安全都更合适
3. Vue 3 + Vite 前端不浪费（WebView 跑 Web 技术栈）

## 后果

- 正面:
  - 启动快（~800ms 到首屏）
  - 包小（预计 < 30MB 安装包）
  - 内存低（~80MB 空闲）
  - 敏感操作走 Rust，FE 完全不碰 key
- 负面:
  - Rust 学习曲线（个人维护要会 Rust）
  - WebView2 依赖（Windows 10 1809+ 自带，旧版要提示装）
  - 生态小（v0.3 期间 2 个核心库（keyring / shell）需要小改）
- 中性:
  - macOS 用 WKWebView，Linux 用 WebKitGTK — 行为差异需测试

## 何时 Revisit

- Tauri 3 发布（v3+ 可能有新能力）
- macOS 适配出现严重问题
- WebView2 在 Windows 11+ 出现性能/兼容瓶颈
- Rust 维护成本超过 Web 后端能节省的（可能性低）
- 用户主动要"换框架"（极小概率）
