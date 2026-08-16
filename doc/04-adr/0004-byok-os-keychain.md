# ADR-0004: BYOK + OS Keychain

- **状态**: Accepted
- **日期**: 2026-08-12
- **决策者**: 用户

## 背景

Pi Agent 走 BYOK（Bring Your Own Key）路线，API key 完全由用户提供。问题：key 存哪？走什么协议？泄露风险怎么控？

## 备选

### localStorage 明文
- ✅ 简单
- ❌ **绝对不行** — WebView2 缓存清时 key 丢，且 key 任何脚本可读
- ❌ 跨进程传递会进 WS 协议字段

### localStorage 加密（AES）
- ✅ 比明文好
- ❌ 加密 key 存哪？自举问题
- ❌ F12 console 能看到密文 + decrypt 入口

### 加密 SQLite（FE 端）
- ✅ 比 localStorage 安全
- ❌ 同上，加密 key 怎么管
- ❌ 跟 WebView 强耦合

### 自建 key server
- ❌ 跟"本地优先"原则冲突
- ❌ 反而增加泄露面

### OS Keychain（Windows Credential Manager / macOS Keychain / Linux Secret Service）✅
- ✅ 系统级加密（AES-256 / 平台实现）
- ✅ 用户身份验证（Windows Hello / macOS TouchID）
- ✅ 跨平台统一接口（`keyring` crate）
- ✅ 不引额外依赖
- ❌ 跨机器迁移 key 麻烦（要重配）
- ❌ key 不可导出（用户自己看不到完整 key）

## 决策

**OS Keychain**（keychain key = `providerId`，value = apiKey 明文，但 OS 加密存储）。

理由：
1. 系统级加密 + 用户身份验证 — 不需要我们做
2. 跨平台统一接口（`keyring` crate 抽象）
3. 不引额外依赖 / 不写自举逻辑
4. 跟 ADR-0003 桌面形态自然契合（keychain 是 native API）

**协议层**：
- apiKey **不**进 localStorage / WS 协议 / 日志 / 错误信息
- apiKey 只在 Rust 读 keychain → 一次 prompt 一次性 stdin 传给 sidecar → 用完即丢
- FE 只调 `hasApiKey(providerId)` 验证存在，不持 key 字符串

## 后果

- 正面:
  - 满足 BYOK 承诺（key 不出本机）
  - 跨平台一致（Windows / macOS / Linux 都用 keychain）
  - 用户不需要记住 key（只输一次）
- 负面:
  - 换机器要重配（**这是 BYOK 的代价，不是 bug**）
  - 用户看不到完整 key（要重新输）
  - 某些 Linux 桌面环境没有 keychain daemon（fallback 待设计）
- 中性:
  - mask 函数（`sk-***XYZW`）是 UI 层降级 — 真 key 仍存
  - 401/403 错误信息必须 sanitize（key 模式 regex 替换）— 已在 sidecar 实现

## 何时 Revisit

- 多端同步需求出现（要换更复杂的 key 管理方案 — 跟"数据本机"原则冲突，可能性低）
- Linux 桌面无 keychain daemon 用户占比高（fallback 到 encrypted file）
- 用户主动要"导出 key"（违反 BYOK 原则，应拒绝）
- Windows Credential Manager 出现严重 bug（极小概率）
