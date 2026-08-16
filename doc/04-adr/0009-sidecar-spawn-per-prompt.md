# ADR-0009: Sidecar 一次一 spawn 进程模型

- **状态**: Accepted
- **日期**: 2026-08-12
- **决策者**: 自己

## 背景

Tauri 主进程（Rust）跟 sidecar（Node）的进程关系怎么设计？sidecar 何时 spawn / 何时退 / 是否复用？

## 备选

### 长跑 daemon（sidecar 跟 Tauri 主进程同生命周期）
- ✅ 启动延迟 0
- ❌ LLM 长流 / 大量 token 内存累积
- ❌ 配置变更（provider / model 切）要 notify sidecar
- ❌ crash 后重启复杂（要重连 stdin/stdout）
- ❌ 多 session 并发难管理

### LRU 进程池（sidecar 池化，warm start）
- ✅ 启动延迟低
- ✅ 内存可控（LRU 淘汰）
- ❌ 复杂度高（池大小 / 淘汰策略 / 状态）
- ❌ 配置变更仍要 notify 池中进程
- ❌ v0.3 阶段过度设计

### 一次一 spawn（每次 send_prompt 启动 sidecar，prompt 结束即退）✅
- ✅ 简单（spawn / wait / kill）
- ✅ 配置变更立刻生效（新 spawn 用新 config）
- ✅ crash 恢复简单（下次 send_prompt 自动重启）
- ✅ token / 内存不残留
- ❌ ~200ms 启动延迟
- ❌ 真正的 abort 要 kill 进程（v0.4+ 用 AbortController）
- ❌ 多 prompt 并发（同一 session 多次 send）会 spawn 多次

## 决策

**一次一 spawn**。

理由：
1. 简单 — Rust 端 spawn / wait / kill 代码 < 100 行
2. 配置变更（用户切 provider / 改 baseUrl）立刻生效
3. crash 恢复零成本（下次 send_prompt 自动重启）
4. token / 内存每次 prompt 都干净

**取舍**：~200ms 启动延迟可接受（用户感知不强 — 已有 LLM 网络延迟打底）。

## 后果

- 正面:
  - 实现简单（spawn / IPC / kill 边界清晰）
  - 配置变更 / crash 恢复都自然
  - 内存 / token 不残留
- 负面:
  - 每次 send_prompt ~200ms 启动延迟（用户能感知"按回车到 AI 开始打字"中间间隔略长）
  - abort 实现复杂（要 kill 子进程，v0.4+ 加 AbortController）
  - 频繁 send（同一 session 连发 10 次）会 spawn 10 次
- 中性:
  - 适合 v0.3 阶段（用户量小 / 单 session 使用）
  - 大规模并发场景（v1.0 商业化）需要重新评估

## 何时 Revisit

- 用户反馈"启动慢"（实测 ~200ms 应该可接受，但要看 N=1 vs N=10 场景）
- 多 prompt 并发需求（同时发 5 个 prompt — 5 个 sidecar 进程）
- abort 实现复杂度超过维护收益（考虑长跑 daemon + AbortController）
- v1.0 商业化部署（每用户同时用 — 池化更合理）
- Node 启动 200ms 变 500ms+（Node 性能退化）
