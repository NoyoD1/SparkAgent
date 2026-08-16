# ADR-0005: Provider 持久化迁 localStorage → Rust 文件

- **状态**: Accepted
- **日期**: 2026-08-15
- **决策者**: 自己（基于 v0.3.8+ 用户反馈）

## 背景

v0.3.5 之前 provider 配置（list / active / model）存 WebView localStorage。问题：WebView2 缓存被清（用户主动 / 系统清理 / 升级）时 localStorage 丢，provider 配置会没，用户要重配。

## 备选

### 保留 localStorage
- ✅ 简单
- ❌ WebView 缓存清就丢
- ❌ 跟 OS keychain 路径不一致（key 在 Credential Manager，配置在 WebView — 割裂）

### IndexedDB
- ✅ WebView 内比 localStorage 容量大
- ❌ 同样 WebView 缓存清就丢
- ❌ 复杂度更高（transaction / object store）

### Rust 文件（`%APPDATA%\com.piagent.desktop\config.json`）✅
- ✅ 跟 OS keychain 路径一致（同一 APPDATA 目录）
- ✅ 原子写（temp file + rename）
- ✅ WebView 缓存清不影响
- ✅ 跟 session 文件同位置（统一管理）
- ❌ 跨平台路径处理（Windows / macOS / Linux 不同）
- ❌ 文件损坏恢复（要写 fallback 到 default）

### SQLite
- ✅ 强大（事务 / 索引 / 查询）
- ❌ 过度工程（provider config 才几 KB）
- ❌ 引入 `rusqlite` 依赖

## 决策

**Rust 文件**（`%APPDATA%\com.piagent.desktop\config.json`，macOS / Linux 类似 `~/Library/Application Support/com.piagent.desktop/config.json`）。

理由：
1. 跟 OS keychain 路径一致（同 APPDATA）
2. 原子写（写 temp → rename）防中途崩溃
3. 不引 SQLite 依赖（config 才几 KB）
4. WebView 缓存清不影响
5. Tauri 自带 `dirs` crate 取 APPDATA 路径

**协议层**：
- FE 调 `loadAppConfig()` / `saveAppConfig(config)` Tauri commands
- Rust 端用 `tempfile + rename` 原子写
- 加载失败 fallback 到 default（empty config + 一个内置 provider 列表）

## 后果

- 正面:
  - 持久化可靠（不依赖 WebView 缓存）
  - 跟 keychain 路径统一（卸载 app 一次清干净）
  - 调试简单（用户能直接看 config.json）
- 负面:
  - Rust 端要写 `AppConfig` 结构体 + serde（不能复用 FE TypeScript 类型 — 需手维护对齐）
  - 损坏恢复逻辑要写（fallback default + log warning）
- 中性:
  - 跟 session 文件、audit log 等后续文件位置统一
  - 不影响 Pinia store（FE 仍走 `useConfigStore` + `acceptHMRUpdate`）

## 何时 Revisit

- config 超过 1MB（要分文件 / 改 SQLite）
- 多端同步需求（config.json 走云端 — 跟"数据本机"原则冲突，可能性低）
- Tauri `dirs` crate API 变化（极少）
- 大量 atomic write 性能问题（不可能 — config 写入频率极低）
