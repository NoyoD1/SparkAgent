# ADR-0008: Tauri invoke/listen 替代 WebSocket 协议

- **状态**: Accepted
- **日期**: 2026-08-12
- **决策者**: 自己（基于 ADR-0003 + 0004）

## 背景

v0.2 是 Web form：FE ↔ Node server 用 WebSocket，API key 走 WS payload。v0.3 切桌面后，FE ↔ Tauri host 用什么协议？

## 备选

### 保留 WebSocket（FE ↔ 自建 server，server ↔ sidecar 走 IPC）
- ✅ 跟 v0.2 兼容
- ❌ 自建 server 部署成本
- ❌ API key 仍走 WS 协议字段（违反 ADR-0004）
- ❌ 多一层进程

### Electron IPC（ipcMain / ipcRenderer）
- ❌ 不选 — 选 Tauri 不 Electron（ADR-0001）

### Tauri invoke（命令） + listen（事件）✅
- ✅ API key 完全不出前端（FE invoke 不含 key，Rust 读 keychain）
- ✅ 事件流适合 LLM 流式（`chat:event` 多事件流）
- ✅ 类型安全（Tauri 命令参数 / 返回有 TS 类型）
- ✅ 不引 server
- ❌ 跨 Tauri 进程边界（FE 是 WebView，Tauri host 是 Rust 进程）
- ❌ WebView2 crash 难调试

### Tauri Channel（invoke 但带 channel 用于流式）
- ✅ 适合流式
- ❌ 比 listen 复杂（invoke 时同时 listen）

## 决策

**Tauri invoke + listen**。

- 命令（请求-响应）：`invoke('send_prompt', { ... })` / `invoke('save_api_key', { ... })` 等
- 事件（流式）：`listen('chat:event', (e) => ...)` 接收 LLM 流
- apiKey 协议层完全不出现在 FE 调用栈（FE 只传 `providerId`，Rust 读 keychain）

理由：
1. 跟 ADR-0004 BYOK 一致（apiKey 不出前端）
2. 跟 ADR-0003 desktop 形态契合（不引 server）
3. 类型安全（@tauri-apps/api 自动生成类型）
4. 简单（不用维护 WS 协议 / 心跳 / 重连）

## 后果

- 正面:
  - 协议层 0 key 风险
  - 类型一致（FE / Tauri 命令都有 TS 类型）
  - 调试简单（FE invoke 在 DevTools 可见，event 也能 inspect）
- 负面:
  - 跨进程边界（FE 是 WebView，Tauri host 是 Rust）
  - 大量事件流（`message_update` 可能 100+ / 秒）— Tauri event 序列化开销（实测可接受）
  - WebView2 缓存清时 listener 会断（要在 onMounted 重连）
- 中性:
  - 协议字段在 `app/src/lib/tauri.ts` 单文件定义（跟 Rust 端 `lib.rs` 对齐）
  - 不影响 FE / sidecar 协议（FE 跟 sidecar 不直接通信，都过 Tauri 中转）

## 何时 Revisit

- 需要多端协作（FE ↔ 云端 ↔ 本机 — 引 server 时再加 WS）
- Tauri 事件流性能成瓶颈（每秒 1000+ 事件）
- WebView2 频繁 crash（换协议不解决根本问题）
- Tauri 3+ 引入 Channel 模式（可优化流式）
