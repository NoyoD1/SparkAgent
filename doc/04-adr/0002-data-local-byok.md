# ADR-0002: 数据本机 + BYOK (用户自带 API key)

- **状态**: Accepted
- **日期**: 2026-08-12
- **决策者**: user
- **Relates to**: [0001-tauri-2-shell](0001-tauri-2-shell.md), [0005-pi-sdk-integration](0005-pi-sdk-integration.md)

## 背景

AI Agent 客户端需要存: provider config / session 历史 / 用户偏好 / API key。

走本地 vs 云端?

## 备选

- **A. 数据本机 + BYOK + OS keychain** — 选这个
- B. 自建云端 (subscription model) — 监管 + GDPR + 运营成本
- C. 混合 (敏感数据本机, 其他云端) — 复杂度高
- D. 纯本地 + 调 LLM (没 key) — 体验差

## 决策

**数据本机 + BYOK**:

| 数据 | 位置 | 实现 |
|---|---|---|
| Provider config | `%APPDATA%\com.piagent.desktop\config.json` | Rust `config_store.rs` (atomic write .tmp + rename) |
| API key | OS keychain | `keyring` crate (Windows Credential Manager / macOS Keychain / Linux libsecret) |
| Session 历史 | `~/.pi/agent/sessions/<workspace-hash>/<ts>_<sessionId>.jsonl` | Pi SDK `SessionManager` 自动管 |
| FE runtime state | WebView2 localStorage | Pinia `watch` 自动 persist |

- Provider config 走 Rust 文件 (不是 FE localStorage), 避免清 WebView2 缓存时擦掉已配的 provider / model list
- API key 不进 config.json, 走 `keyring` crate, 启动时注入到 Pi SDK `setRuntimeApiKey`
- session 文件 append-only, Pi SDK `SessionManager` 自动落盘

## 后果

- ✅ 用户数据 100% 本机, 无云依赖, 无 GDPR 风险
- ✅ 换电脑 / 重装: 备份 config.json + keychain 即可
- ✅ 清 WebView2 缓存不影响 provider config
- ❌ 跨设备同步: 不做 (跟"数据本机第一"对齐)
- ❌ 协作: 不做 (跟"个人 agent"对齐)

## 何时 Revisit

- 团队协作需求出现 → 加云端 sync (但 session 内容仍本机)
- 用户要端到端加密备份 → 加 age / gpg 包装
