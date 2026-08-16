# ADR-0003: Desktop-only 形态 + Node sidecar 拆分

- **状态**: Accepted
- **日期**: 2026-08-12
- **决策者**: 用户

## 背景

v0.2 是 Web form（前端 + Node server 同进程，浏览器访问）。v0.3 要切桌面。问题：LLM 长流 + tool call（v0.4+）+ memory（v0.5+）都重，WebView 单进程扛不住。

## 备选

### 单进程全 Web（保留 v0.2 形态）
- ✅ 部署简单
- ❌ WebView 单进程扛不住 LLM 长流
- ❌ 没法用 OS keychain（需要 native API）
- ❌ 没法管进程（spawn child）
- ❌ API key 必须走 WS 协议（违反 ADR-0004）

### 桌面单进程（all-in-Tauri）
- ✅ 简单
- ❌ Tauri 主进程跑 LLM 流 / tool call 会卡 UI
- ❌ Crash 恢复复杂

### 桌面 + Rust sidecar
- ✅ 强类型，编译期检查
- ❌ LLM SDK Rust 端成熟度不如 Node
- ❌ 跟 FE 共用 TS 代码难（FE 是 Vue 3 + TS，sidecar 要 Rust 写 tool）

### 桌面 + Node sidecar ✅
- ✅ Node LLM SDK 生态成熟（OpenAI SDK / Vercel AI SDK / Pi SDK）
- ✅ 跟 FE 共用 TS 类型（protocol 端）
- ✅ sidecar crash 不影响 Tauri 主进程
- ✅ LLM 长流不卡 UI
- ❌ 跨进程 IPC（stdin/stdout JSON Lines）
- ❌ ~200ms 启动延迟（每次 send_prompt spawn）

## 决策

**桌面（Tauri 2）+ Node sidecar（独立进程）**。

理由：
1. LLM 长流 + tool call 重，WebView 单进程扛不住
2. Node LLM SDK 生态最成熟（Pi SDK / OpenAI SDK / Anthropic SDK 都是）
3. FE / sidecar 共用 TS 类型，端到端 type-safe
4. sidecar crash 不影响 Tauri 主进程（简单 IPC 重启）

## 后果

- 正面:
  - UI 永不卡（LLM 在 sidecar 流）
  - 跨进程边界清晰（FE 不碰 key，sidecar 不碰 DOM）
  - TypeScript 全栈类型一致
- 负面:
  - 每次 send_prompt ~200ms 启动延迟（ADR-0009 评估）
  - 跨进程 IPC 调试复杂（stdin/stdout 不如 in-process 直觉）
  - Node 进程管理要 Rust 端负责（spawn / kill / restart）
- 中性:
  - sidecar 当前只装 openai-compatible 适配器，扩 Anthropic SDK / Pi SDK 时只动 sidecar
  - Tauri capabilities 跟 Node 进程隔离 — Node 端权限独立（无 capabilities 概念）

## 何时 Revisit

- 用户感觉启动慢（考虑 LRU 进程池 — 跟 ADR-0009 联动）
- 多 prompt 并发场景出现（sidecar 池化）
- 跨进程 IPC 调试成本超过维护收益（改单进程 + 异步队列）
- Node 生态出大问题（如 Node 20 EOL 没 LTS 接续）
