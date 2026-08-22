# Build Guide — 怎么打包 Pi Agent Desktop

> 面向**给别人用 / 自己调试**两种场景的打包手册.
> 跟 ADR-0017 同目录 (本目录是工程文档根, ADR 跟 build 文档放一起方便找).
> 最近更新: 2026-08-23

---

## 一、两种 build 的区别 (先看这个选对)

| 维度 | Debug build | Release build |
|---|---|---|
| **用途** | 日常开发 / 排查问题 / F12 看 console | **发版本 / 给别人用** |
| **路径** | `src-tauri/target/debug/pi-agent-desktop.exe` | `src-tauri/target/release/pi-agent-desktop.exe` |
| **大小** | ~26 MB (含 debug 符号) | ~7-10 MB (LTO + strip 优化) |
| **编译耗时** | ~2 分钟 (首次) / ~30 秒 (增量) | ~5-10 分钟 (首次, 开 LTO) |
| **devtools (F12)** | ✅ 默认开 | ❌ 默认关 |
| **控制台日志** | 详细 (含 [chat] / [sidecar] / [Composer] 前缀) | 简略 |
| **热重载 FE 改动** | ✅ 重 build 会嵌新 dist | ✅ 同上 |
| **安装包 (MSI / NSIS)** | ❌ 不生成 | ✅ 自动生成 |
| **谁能跑** | 开发者自己 (有 rust 工具链) | 任何人 (只要 Windows 64-bit) |

**简单说**:
- **改完代码想立刻看效果** → debug
- **要给用户 / PM / 别人用** → release

---

## 二、前置依赖 (首次打包要装)

按顺序装, 别跳:

### 1. Node.js ≥ 20.19.0
```powershell
node --version    # 检查, 没装去 https://nodejs.org 装 LTS
```

### 2. Rust toolchain (stable)
```powershell
# 装 rustup (Windows 安装器)
winget install Rustlang.Rustup
# 或去 https://rustup.rs/ 下一键安装

rustc --version    # 验证
cargo --version
```

### 3. MSVC C++ build tools (Tauri/Rust 编译要)
- 装 Visual Studio 2022 (Community 免费) 选 "**使用 C++ 的桌面开发**" 工作负载
- 或装 "Build Tools for Visual Studio 2022"

### 4. WebView2 Runtime (Windows 10/11 默认装, Win 7/8 要手动装)
- 99% 的 Win 10/11 机器已经预装
- 验证: 控制面板 → 程序 → 搜 "Microsoft Edge WebView2 Runtime"

### 5. Tauri 2 CLI
```powershell
cargo install tauri-cli --version "^2.0.0"
```

### 6. 项目依赖
```powershell
cd D:\UnityWork\Tools\Pi
npm install --prefix app    # FE 依赖 (vue, vite, marked, pinia 等)
```

> 注: 第一次跑会装很多 crate, 慢是正常的 (5-10 分钟). 之后增量编译 30 秒.

---

## 三、Debug build (开发用, 带 F12)

### 一行命令
```powershell
# 在项目根 (D:\UnityWork\Tools\Pi)
node scripts/build-debug.mjs
```

或走 npm:
```powershell
cd D:\UnityWork\Tools\Pi\app
npm run build:debug
```

### 它做了什么
1. 跑 `vue-tsc --noEmit` (FE type check)
2. 跑 `vite build` (FE 打包到 `app/dist/`)
3. 跑 `cargo tauri build --debug` (Rust 编译 + 嵌 dist 进 .exe + 嵌 sidecar)
4. 输出 `src-tauri/target/debug/pi-agent-desktop.exe`

### 跑完拿到
```
============================================================
[build-debug] ✅ 完成
[build-debug] ⏱️  耗时: 100s
[build-debug] 📁 .exe 路径: D:\UnityWork\Tools\Pi\src-tauri\target\debug\pi-agent-desktop.exe
[build-debug] 📦 大小: 26.15 MB
[build-debug] 🕐 时间戳: 2026-08-23 00:17:02
[build-debug] 🔧 devtools: debug 模式默认开, 双击跑后按 F12 看 console
[build-debug] 💡 排查问题贴 console 日志截图 (含 [chat] / [sidecar] / [Composer] 前缀) 给 AI
============================================================
```

### 怎么用
1. **双击** `D:\UnityWork\Tools\Pi\src-tauri\target\debug\pi-agent-desktop.exe` 跑
2. 跑起来后, 在应用窗口里按 **F12** → 选 Console 标签 → 看日志
3. 改完代码 → 再跑一次 `npm run build:debug` → 增量编译 ~30 秒 → 重新双击 .exe

### 排错模式
- 改了 Vue 文件但 .exe 没生效 → 跑一遍 `npm run build` (单独 build FE) 再 build-debug
- cargo 编译报错 → 看完整 stderr, 99% 是 type error 或 missing dependency
- .exe 跑不起来 + 弹"找不到 sidecar" → 跑 `npm run build:debug` 重新打, 别直接用旧的 .exe

---

## 四、Release build (给别人用)

### 一行命令
```powershell
# 在项目根
node scripts/build-release.mjs
```

或走 npm:
```powershell
cd D:\UnityWork\Tools\Pi\app
npm run build:release
```

### 它做了什么
1. 跑 `vue-tsc --noEmit` + `vite build` (FE)
2. 跑 `cargo tauri build` (Rust release 模式: LTO + strip + opt-level 3)
3. 输出三样东西:
   - `src-tauri/target/release/pi-agent-desktop.exe` — 单文件 .exe (双击能跑)
   - `src-tauri/target/release/bundle/msi/Pi Agent_0.1.0_x64_en-US.msi` — Windows Installer 包
   - `src-tauri/target/release/bundle/nsis/Pi Agent_0.1.0_x64-setup.exe` — NSIS 一键安装包

### 跑完拿到
```
============================================================
[build-release] ✅ 完成
[build-release] ⏱️  耗时: 380s (比 debug 慢, 因为开了 LTO + strip)
[build-release] 📁 .exe 路径: ...\target\release\pi-agent-desktop.exe
[build-release] 📦 大小: 8.43 MB (比 debug 小 ~70%)
[build-release] 🕐 时间戳: 2026-08-23 ...
[build-release] 🔒 devtools: release 模式默认关, F12 不可用
[build-release] 📦 Bundle 安装包:
[build-release]    MSI:  ...\Pi Agent_0.1.0_x64_en-US.msi (12.45 MB)
[build-release]    NSIS: ...\Pi Agent_0.1.0_x64-setup.exe (11.82 MB)
============================================================
```

### 发给别人怎么选

| 给的对象 | 推荐文件 | 理由 |
|---|---|---|
| **懂技术的同事** | `pi-agent-desktop.exe` (单文件) | 解压即用, 不用装 |
| **普通用户** | `Pi Agent_0.1.0_x64-setup.exe` (NSIS) | 双击装, 有开始菜单快捷方式, 标准 Windows 体验 |
| **企业 IT 部署** | `Pi Agent_0.1.0_x64_en-US.msi` (MSI) | 可用 GPO / SCCM 静默安装, 可配 transform |
| **Mac / Linux** | 目前没出 (项目没配 macOS / Linux bundle) | — |

### NSIS 安装包双击效果
- 默认装到 `C:\Program Files\Pi Agent\`
- 创建开始菜单快捷方式 + 桌面快捷方式
- 写注册表 (卸载用)
- 自带 uninstall.exe (控制面板可卸)

---

## 五、改了代码怎么重新打

### 改了 FE (Vue/TS/CSS)
- **Debug**: 重跑 `npm run build:debug` (~30 秒增量) → 双击新 .exe
- **Release**: 重跑 `npm run build:release` (~30 秒 FE, 然后 release 链接)

### 改了 Rust (src-tauri/src/*.rs)
- **Debug**: 重跑 `npm run build:debug` (cargo 自动增量编译改的文件)
- **Release**: 重跑 `npm run build:release` (release 模式 cargo 增量, 但 LTO 跑全链)

### 改了 sidecar (sidecar/src/*.mjs)
- Tauri 2 sidecar 是嵌进 .exe 的, **改了 sidecar 必须重 build**
- Tauri 自己检测 sidecar mtime, 自动重新嵌入
- 但保险起见, 改 sidecar 后**清一下**: `cargo clean -p pi-agent-sidecar` (如果有) 或直接 `cargo clean`

### 改了 tauri.conf.json / Cargo.toml
- 配置改了 cargo 100% 重新链接 (不是编译, 是链接)
- 耗时比纯改 .rs 长

---

## 六、常见问题

### Q: cargo 编译报 "linker not found"
A: 缺 MSVC C++ build tools. 重装 Visual Studio 2022, 勾上 "**使用 C++ 的桌面开发**" 工作负载.

### Q: build 报 "WebView2 not found"
A: 装 Microsoft Edge WebView2 Runtime: https://developer.microsoft.com/microsoft-edge/webview2/

### Q: sidecar 启动报错 "找不到 pi-agent-sidecar.exe"
A: Tauri 2 走 `bundle.externalBin` 声明, 检查 `src-tauri/tauri.conf.json`:
```json
"externalBin": ["binaries/pi-agent-sidecar"]
```
然后 `src-tauri/binaries/pi-agent-sidecar-x86_64-pc-windows-msvc.exe` 必须存在.
开发模式 Tauri 会从 `sidecar/dist/` 自动 link 过去.

### Q: debug .exe 双击跑不起来, 没弹窗
A:
1. 看 sidecar stderr log: 路径在 `%TEMP%` 或 tauri debug log
2. F12 看 FE console
3. 跑 `npm run build:debug` 重打, 别用旧 .exe

### Q: release .exe 在用户机器上跑不起来
A: 99% 是缺 WebView2 Runtime (Win 7/8 / 老 Win 10 才有这问题). 让用户装一下.

### Q: 改完代码 cargo 跑得慢
A: 第一次跑会编译 1000+ 个 crate (~5-10 分钟). 之后只编译改的文件 + 链接 (~30 秒-2 分钟).
- 想全清重编: `cd src-tauri && cargo clean` (慎用, 下次又得 5-10 分钟)
- 想只清 sidecar: `cd src-tauri && cargo clean -p pi-agent-sidecar`

### Q: 怎么给 release .exe 签名 (避免 Windows SmartScreen 警告)
A: 暂未配 (项目 `bundle.windows.certificateThumbprint` 空). 后面如果要发正式版需要:
- 买代码签名证书 (DigiCert / GlobalSign 等)
- 在 `tauri.conf.json` 配置 `windows.certificateThumbprint` + `wix.signCommand`
- 当前 debug + 内部分发**不需要签名**, 智能屏警告点"仍要运行"即可

---

## 七、版本号管理

`src-tauri/tauri.conf.json`:
```json
"productName": "Pi Agent",
"version": "0.1.0",
"identifier": "com.piagent.desktop"
```

**改版本号必须改 3 处** (Tauri 2 限制, 不改会 bundle 文件名错乱):
1. `src-tauri/tauri.conf.json` 的 `version` 字段
2. `app/package.json` 的 `version` 字段
3. (未来如果要) `src-tauri/Cargo.toml` 的 `version` 字段

改完重 build, bundle 文件名自动带新版本号 (e.g. `Pi Agent_0.2.0_x64-setup.exe`).

---

## 八、CI 集成 (后续)

如果想上 CI 自动打 release:

```yaml
# .github/workflows/release.yml (示意)
- name: Setup
  uses: actions/checkout@v4
- name: Install Rust
  uses: dtolnay/rust-toolchain@stable
- name: Install Node
  uses: actions/setup-node@v4
  with: { node-version: 20 }
- name: Build Release
  run: |
    npm install --prefix app
    cd app && npm run build:release
- name: Upload MSI
  uses: actions/upload-artifact@v4
  with:
    name: pi-agent-msi
    path: src-tauri/target/release/bundle/msi/*.msi
```

(当前项目没配 CI, 上线前补.)

---

## 九、跟 ADR-0017 的关系

- **ADR-0017** = AGENTS.md 模块功能定义 + 实现状态
- **本文件** = 怎么把代码打成 .exe 给人用
- 两者**正交**: 改 AGENTS.md 内容不影响 build 流程, 改 build 配置不影响 AGENTS.md

debug build + F12 看 console 是**核验 ADR-0017 实际行为**的标准手段:
- 改 AGENTS.md → save → "保存并立即重启" → 发 prompt → 看 sidecar stderr 5 段 log
- 核验脚本: `node scripts/verify-adr-0017.mjs` (10 项) / `node scripts/smoke-agents-md.mjs` (6 invariant)

---

## 附: 完整命令速查

```powershell
# === Debug (开发用, F12 可用) ===
cd D:\UnityWork\Tools\Pi
node scripts/build-debug.mjs
# 跑: 双击 src-tauri\target\debug\pi-agent-desktop.exe

# === Release (给别人用, F12 不可用) ===
cd D:\UnityWork\Tools\Pi
node scripts/build-release.mjs
# 跑: 双击 src-tauri\target\release\pi-agent-desktop.exe
# 分发: src-tauri\target\release\bundle\nsis\Pi Agent_0.1.0_x64-setup.exe

# === 只 build FE (不打包) ===
cd D:\UnityWork\Tools\Pi
node scripts/build-fe.mjs

# === Type check ===
cd D:\UnityWork\Tools\Pi\app
npm run typecheck

# === ADR 核验 ===
cd D:\UnityWork\Tools\Pi
node scripts/verify-adr-0017.mjs
node scripts/smoke-agents-md.mjs
```
