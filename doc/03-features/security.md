# 安全 (Security)

> 状态: 🟡 60%
> 最后更新: 2026-08-16
> spec 涉及: `src-tauri/src/keyring.rs` + `sidecar/src/openai-compatible.mjs` + `src-tauri/capabilities/default.json` + `app/src/lib/tauri.ts`

---

## 1. Spec

**安全 = BYOK 承诺的基石**。API key 不出本机、错误信息不漏 key、tool call 不破沙箱、网络通信不夹私货。

### 1.1 必备能力

- ✅ **API Key 走 OS keychain**（Windows Credential Manager / macOS Keychain / Linux Secret Service）
- ✅ **API Key 永远不在前端**（FE 只调 `hasApiKey()` 验证存在）
- ✅ **API Key 不进 WS 协议 / stdin 协议字段名**（只走 Rust → Sidecar 一次性 stdin）
- ✅ **API Key 不进日志 / 错误信息**（401/403 sanitize）
- ✅ **Provider ID 用 `crypto.randomUUID()` 128-bit**
- ✅ **Sidecar 错误脱敏**（R4）：key pattern regex 替换
- ✅ **Window 控制权限** 最小化（capabilities 白名单）
- ✅ **FE 调试只暴露给 DEV**（`window.__piTauri` 只在 `import.meta.env.DEV`）
- 🟡 **CSP 严格化**（当前 `csp: null`）— v0.4 必做
- 🟡 **fs 权限最小化**（v0.4 加 fs capability 时必须白名单）
- 🟡 **shell 权限 sandbox**（v0.4 加 shell capability 时白名单命令 + workspace 限制）
- ❌ **Tool call 权限确认 UI**（v0.4 必做）
- ❌ **Tool call 审计日志**（v0.5）
- ❌ **危险命令黑名单**（`rm -rf /`, `mkfs` 等）（v0.4 必做）
- ❌ **路径校验**（path traversal 拒绝）（v0.4 必做）
- ❌ **网络白名单**（限制 LLM API endpoint）（v0.4 必做）
- ❌ **进程沙箱**（firejail / docker / Windows Job Object）— v2.0+
- ❌ **安全审计**（第三方 review）— v1.0

### 1.2 不做什么

- ❌ 端到端加密 session（OS 加密足够）
- ❌ 抗量子加密（v1.x 远期）
- ❌ 抗 side-channel（性能 vs 安全，v2.0+）
- ❌ 抗本地 rootkit（用户自己负责 OS 安全）

---

## 2. 当前实现

### 2.1 Keychain（src-tauri/src/keyring.rs）

```rust
// 增
save_api_key(provider_id: String, api_key: String)
  → Windows Credential Manager write (key = provider_id)

// 删
delete_api_key(provider_id: String)

// 查
has_api_key(provider_id: String) -> bool
list_api_keys() -> [{ provider_id, configured, preview }]  // preview 是 mask()

// mask 函数: sk-***XYZW (前2后4)
```

### 2.2 Frontend 不持 key（app/src/lib/tauri.ts）

```typescript
async saveApiKey(providerId: string, apiKey: string) {
  await invoke('save_api_key', { providerId, apiKey });
  // FE 不保留 apiKey 变量，函数结束即 GC
}

async hasApiKey(providerId: string): Promise<boolean> {
  return await invoke('has_api_key', { providerId });
}
```

### 2.3 Sidecar 错误脱敏（sidecar/src/openai-compatible.mjs）

```javascript
const KEY_PATTERNS = [
  /\bsk-[A-Za-z0-9_\-]{4,}/g,         // OpenAI
  /\bsk-proj-[A-Za-z0-9_\-]{4,}/g,
  /\bAKIA[0-9A-Z]{4,}/g,               // AWS
  /\bghp_[A-Za-z0-9]{4,}/g,            // GitHub
  /\bxai-[A-Za-z0-9]{4,}/g,            // xAI
  /\bAIza[0-9A-Za-z_\-]{4,}/g,         // Google
  /Bearer\s+[A-Za-z0-9_\-\.]{8,}/gi,   // 任何 "Bearer xxx"
];
function sanitizeErrBody(text) {
  let out = text;
  for (const re of KEY_PATTERNS) {
    out = out.replace(re, (m) => m.length > 4 ? `${m.slice(0, 2)}***` : '***');
  }
  return out.slice(0, 300);
}
```

### 2.4 协议字段安全

- `chat:event` Tauri event payload **不包含** apiKey
- `send_prompt` invoke args **不包含** apiKey（Rust 自己读 keychain）
- sidecar stdin config 行**包含** apiKey，但 sidecar 立即用完，**不写 stdout**

### 2.5 当前 capabilities 限制

```json
{
  "permissions": [
    "core:default",
    "core:window:*",     // 只允许窗口控制
    "dialog:default"
    // 没有 fs / shell / clipboard / os
  ]
}
```

**当前没有 fs / shell capability** = v0.4 之前 LLM 不能动文件 = 安全。

---

## 3. 已知问题 / 限制

- 🟡 CSP `null` — dev 友好但生产应该严格
- 🟡 Sidecar 错误脱敏 regex 不全（小众 provider key pattern 可能漏）
- 🟡 没有"tool call 危险操作二次确认"（v0.4 必做）
- 🟡 没有 path traversal 防御（v0.4 必做）
- 🟡 没有进程沙箱（恶意 skill 理论上能跑任意命令，v0.4+ 加白名单缓解）
- 🟡 WebView2 缓存可能存 sensitive 临时数据（v0.3.8+ 迁 Rust 文件缓解）

---

## 4. 待办（Roadmap）

### P0（v0.4 必做）

- [ ] **CSP 严格化**（`script-src 'self'` 等）
- [ ] **fs capability 加白名单**（只允许 workspace 内）
- [ ] **shell capability 加白名单**（只允许安全命令 + workspace cwd）
- [ ] **path traversal 防御**（`../` / 绝对路径拒绝）
- [ ] **危险命令黑名单**（`rm -rf /` / `mkfs` / `format` / `dd if=` / `:(){ :|:& };:` 等）
- [ ] **Tool call 权限确认 UI**（首次 + 黑名单 + 白名单模式）
- [ ] **错误脱敏 regex 补全**（加 `x-`、`anthropic-`、`minimax-` 等）

### P1（v0.4 - v0.5）
- [ ] Tool call 审计日志（`%APPDATA%\com.piagent.desktop\audit.log`）
- [ ] 网络白名单（限制 LLM endpoint）
- [ ] 进程级 sandbox（Windows Job Object 限制）

### P2（v1.0+）
- [ ] 第三方安全审计
- [ ] 抗 side-channel 优化
- [ ] 进程沙箱（firejail / docker）

---

## 5. Changelog

- **2026-08-15 · v0.3.7** · sidecar 401/403 sanitize（R4）
- **2026-08-15 · v0.3.7** · `window.__piTauri` dev-only（R1）
- **2026-08-15 · v0.3.7** · provider ID `crypto.randomUUID()`（R2）
- **2026-08-15 · v0.3.7** · key mask 函数 `sk-***XYZW`（R5）
- **2026-08-13 · v0.3.1** · OS keychain + 不传 key 走 invoke
- **2026-08-12 · v0.3** · capabilities 白名单
