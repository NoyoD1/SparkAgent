# Provider / 模型 / BYOK

> 状态: ✅ 90%
> 最后更新: 2026-08-16
> spec 涉及: `app/src/stores/config.ts` + `app/src/components/Settings/tabs/ProviderTab.vue` + `src-tauri/src/keyring.rs` + `sidecar/src/openai-compatible.mjs`

---

## 1. Spec

**BYOK = Bring Your Own Key**。用户自己提供 LLM API key，**永远不经过我们的服务器**。多 provider 支持 + 自定义 OpenAI-compatible endpoint。

### 1.1 必备能力

- ✅ 7 个内置 provider：Anthropic / OpenAI / DeepSeek / Moonshot / Google / Groq / OpenAI Platform
- ✅ 自定义 provider（任意 OpenAI-compatible 端点）
- ✅ Provider 列表 UI（Settings → Providers）
- ✅ 当前激活 provider 标记
- ✅ API key 存 OS keychain（Windows Credential Manager）
- ✅ Key 列表 API（只返回 `mask()` 预览，如 `sk-***XYZW`）
- ✅ 模型切换（per provider 多模型）
- ✅ 从 .env 文件迁移 key（migrate_from_env）
- ✅ Provider 配置持久化到 Rust 文件（v0.3.8+，替代 localStorage）
- 🟡 Provider 测试连通性（fetch models）— 已做但错误处理可优化
- ❌ 模型参数配置（per session: temperature / top_p / max_tokens）— 未做
- ❌ 用量统计 / 计费 — 未做（用户自己看 provider 后台）
- ❌ OAuth 登录（Anthropic / OpenAI 官方 OAuth）— 未做

### 1.2 不做什么

- ❌ 代理用户 LLM 请求（我们不做中间人）
- ❌ 收集用户 key
- ❌ 默认 key（"试用一下"）— 用户必须自己配

---

## 2. 当前实现

| 文件 | 职责 |
|---|---|
| `app/src/stores/config.ts` | provider 列表 + active provider/model 状态 |
| `app/src/components/Settings/tabs/ProviderTab.vue` | provider CRUD UI |
| `app/src/components/Settings/tabs/AddProviderForm.vue` | 新增 provider 表单 |
| `app/src/lib/providers-api.ts` | Tauri invoke 包装 |
| `app/src/lib/tauri.ts` | `saveApiKey` / `deleteApiKey` / `hasApiKey` / `listApiKeys` |
| `src-tauri/src/keyring.rs` | OS keychain 增删查（keychain key = providerId）|
| `src-tauri/src/config_store.rs` | provider 配置 JSON 持久化（原子写）|
| `sidecar/src/openai-compatible.mjs` | 拿 key → 调 LLM API |

### 2.1 内置 provider 列表

| ID | 名称 | baseUrl | 备注 |
|---|---|---|---|
| `anthropic` | Anthropic | `https://api.anthropic.com/v1` | Claude 全系 |
| `openai` | OpenAI | `https://api.openai.com/v1` | GPT 全系 |
| `deepseek` | DeepSeek | `https://api.deepseek.com/v1` | 国产，中文友好 |
| `moonshot` | Moonshot Kimi | `https://api.moonshot.cn/v1` | 国产，长上下文 |
| `google` | Google Gemini | `https://generativelanguage.googleapis.com/v1beta` | |
| `groq` | Groq | `https://api.groq.com/openai/v1` | 超快推理 |
| `openai-platform` | OpenAI Platform | 用户自填 | 通用 OpenAI-compatible |

### 2.2 自定义 provider

- ID 规则：`^[A-Za-z0-9][A-Za-z0-9._-]*$`
- 用户填：name / baseUrl / model list
- 保存走通用 `saveProvider()`，**不**区分内置 vs 自定义
- 写盘到 `%APPDATA%\com.piagent.desktop\local-provider-plugins\`

### 2.3 API Key 流程

```
用户在 UI 输 key
  → invoke('save_api_key', { providerId, apiKey })
  → Rust 写 OS keychain (keychain key = providerId)
  → 前端**不保留** key 字符串，只调用 hasApiKey() 验证存在
  → 真正调 LLM 时，Rust 读 keychain → sidecar stdin → 一次 prompt 结束即丢
```

### 2.4 v0.3.8+ 持久化迁移

- **之前**：provider 配置存 localStorage（WebView2 缓存清就没了）
- **现在**：存 `%APPDATA%\com.piagent.desktop\config.json`（Rust 原子写）
- 启动时 loadAppConfig 读文件
- 改 provider 立即 saveAppConfig

---

## 3. 已知问题 / 限制

- 🟡 Key 错误信息脱敏 regex 不全（小众 provider key pattern 可能漏）
- 🟡 没有"key 即将过期"提示
- 🟡 没有"重命名 provider"（要删了重建）
- 🟡 Provider 配置没版本控制（用户改坏了无法回滚）
- 🟡 没有"导入 / 导出 provider 配置"（跨机器迁移靠手抄）

---

## 4. 待办（Roadmap）

### P0（v0.4 必做）
- [ ] 模型参数 per-session（temperature / top_p / max_tokens）— 重要 UX
- [ ] 错误脱敏 regex 补全（加 `x-`、`anthropic-` 等 pattern）

### P1（v0.4 - v0.5）
- [ ] Provider 导入 / 导出（JSON 配置文件）
- [ ] Key 即将过期检测
- [ ] Provider 重命名

### P2（v0.5+）
- [ ] 用量统计（parse provider response usage field）
- [ ] OAuth 登录（Anthropic / OpenAI 官方 OAuth）
- [ ] Per-provider 高级设置（request timeout / retry policy）

---

## 5. Changelog

- **2026-08-16 · v0.3.8.5** · 自定义 provider 写本地插件目录
- **2026-08-15 · v0.3.8.3** · 7 内置 provider 常驻 + 简化列表
- **2026-08-15 · v0.3.8.2** · provider 状态点 + OAuth 标识
- **2026-08-15 · v0.3.8.1** · Pinia HMR 兼容（acceptHMRUpdate）
- **2026-08-15 · v0.3.8** · provider 持久化迁 Rust 文件
- **2026-08-14 · v0.3.5** · provider 测试连通性
- **2026-08-13 · v0.3.1** · OS keychain UI 流程
- **2026-08-12 · v0.3** · Tauri keychain.rs 实现
- **2026-08-10 · v0.2** · web form 6 provider 列表
