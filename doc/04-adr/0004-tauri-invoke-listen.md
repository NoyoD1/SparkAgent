# ADR-0004: Tauri invoke/listen IPC (替代 WebSocket)

- **状态**: Accepted
- **日期**: 2026-08-12
- **决策者**: user
- **Relates to**: [0001-tauri-2-shell](0001-tauri-2-shell.md), [0006-rpc-mode-migration](0006-rpc-mode-migration.md)

## 背景

FE ↔ Tauri ↔ Sidecar 通信: Tauri 已经做 invoke (FE → Rust) / listen (Rust → FE) IPC, 需要再加 WebSocket 吗?

## 备选

- **A. Tauri invoke/listen** — 选这个
- B. WebSocket (Rust 起 ws server) — 端口冲突 + 生命周期管理
- C. HTTP polling — 实时性差
- D. Shared memory / mmap — Tauri 2 不直接支持

## 决策

**Tauri invoke/listen**:
- FE → Rust: `invoke('command_name', { args })` 返回 Promise
- Rust → FE: `emit('event_name', { payload })` 推流
- Rust → Sidecar: stdio 透传 (Tauri 不解析 RpcCommand)
- 不开端口, 不管 WS server lifecycle, 不操心 CORS

## 后果

- ✅ 0 端口, 0 防火墙问题
- ✅ 协议简单, TypeScript 自动生成类型
- ✅ 单进程 (Rust), 简单 IPC
- ❌ 大量 emit 性能不如 WS (实测够用, ~1K events/s 没问题)
- ❌ Rust → FE 单向, FE → Rust 单向 (但 invoke + emit 组合等价双向)

## 何时 Revisit

- 流式 event 超过 10K/s → 评估 WebSocket
- 需要 cross-window 通信 → 考虑 EventBus
