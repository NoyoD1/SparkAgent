# 可观测性 (Observability)

> 状态: ❌ 10%
> 最后更新: 2026-08-16
> spec 涉及: 几乎所有文件（散落日志）

---

## 1. Spec

**可观测性 = 出了问题能定位、跑了多少有数据、用户能反馈**。当前基本是 console.log + 文件 log，没有结构化。

### 1.1 必备能力

- 🟡 **基础 console.log**（FE / Sidecar / Rust 都有）
- 🟡 **`.tauri-*.log` 文件**（stderr/stdout 落到 Tauri 根目录）
- ❌ **结构化日志**（JSON 行 + level + timestamp + sessionId）— v0.5 必做
- ❌ **日志文件轮转**（按大小 / 时间切割）— v0.5
- ❌ **崩溃自动捕获**（Rust panic / WebView crash）— v1.0
- ❌ **崩溃报告**（Sentry / 自建）— v1.0 opt-in
- ❌ **性能监控**（启动时间 / 内存 / 帧率）— v0.5
- ❌ **用户反馈通道**（"上报问题"按钮）— v0.7
- ❌ **E2E 测试**（Playwright + Tauri）— v1.0
- ❌ **单元测试** — v1.0
- ❌ **CI/CD** — v0.7

### 1.2 不做什么

- ❌ 实时遥测（不向公司服务器上报用户行为）
- ❌ A/B test 平台
- ❌ 性能数据收集（除非用户 opt-in）

---

## 2. 当前实现

### 2.1 日志散落点

| 层 | 位置 | 现状 |
|---|---|---|
| **FE** | `console.log/info/warn/error` | 散落，没结构化 |
| **Tauri Rust** | `eprintln!` / `println!` | 写 stderr/stdout → Tauri 自动落 `.tauri-*.log` |
| **Sidecar** | `console.log/error` | 走 Tauri 子进程 stdout/stderr |
| **LLM 流** | 单独 debug（无 log）| LLM 流不写日志（避免内容曝光）|

### 2.2 当前问题

- 没有 level（debug / info / warn / error）
- 没有 sessionId 关联
- 文件不会轮转（积累会很大）
- 崩溃时 Rust panic 经常被吞

### 2.3 测试覆盖

- 单元测试：**0%**
- 集成测试：**0%**
- E2E：**0%**
- 手动 smoke test：`.smoke-test.cjs`（sidecar 单独跑）

---

## 3. 已知问题 / 限制

- 🟡 排查问题靠 `console.log` + 用户截图
- 🟡 Sidecar 崩溃无可见信号（前端只看到 `agent_end` 不到）
- 🟡 没有 session 级别的 trace（一个 session 内所有事件难回放）
- 🟡 性能问题靠用户反馈（"卡顿"），无量化数据

---

## 4. 待办（Roadmap）

### P0（v0.5 必做）
- [ ] **结构化日志**：JSON 行 + level + timestamp + sessionId
- [ ] **日志文件位置**：`%LOCALAPPDATA%\com.piagent.desktop\logs\<date>.jsonl`
- [ ] **日志轮转**：按 10MB / 天切割
- [ ] **FE log → Tauri log bridge**（统一入口）
- [ ] **Smoke test util**（已有 `.smoke-test.cjs` 扩成 CLI）

### P1（v0.5 - v0.7）
- [ ] 性能监控（启动时间 / 内存 / 帧率）
- [ ] Session trace 导出
- [ ] 用户反馈通道（"上报问题"按钮 + 附 log）

### P2（v1.0）
- [ ] 崩溃自动捕获 + 报告（opt-in）
- [ ] E2E 测试覆盖核心 flow
- [ ] CI/CD pipeline
- [ ] 单元测试覆盖率目标 60%+

---

## 5. Changelog

- **2026-08-15 · v0.3.x** · 修了 sidecar `agent_end` 错误路径不 emit（commit `05a5c53`）
- **2026-08-14 · v0.3.3** · sidecar 错误抛前端（agent_start unhandled 修复）
- **2026-08-12 · v0.3** · 基础 console.log 体系
