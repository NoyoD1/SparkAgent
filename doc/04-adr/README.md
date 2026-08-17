# 04 · Architecture Decision Records (ADR)

> **重大技术决策记录**。为什么当初这么选 / 备选是什么 / 取舍 / 后续怎么 review。
> **写代码前有重大决策先开 ADR**，不靠记忆不靠聊天记录。

## 什么是 ADR

- 一次决策一个 md 文件，文件名 `NNNN-<短名>.md`（NNNN 4 位递增）
- **不可变**：决策落地后不修改，只追加 `## 后续 Review` 章节
- 包含：背景 / 备选 / 决策 / 后果 / 何时 revisit
- 模板见 [template.md](template.md)

### 什么时候需要写 ADR

✅ **要写**（重新选型 / 重边界 / 跨模块影响）：
- 选框架/库/SDK 替代方案
- 加新的模块边界（sidecar / Tauri command / store / IPC 协议）
- 改已有架构决策的反方向
- 引入新协议 / 新持久化策略

❌ **不写**（token 级微调）：
- 单个 CSS 值调整 / 文案修改
- 错误信息措辞
- 单 tool / 单 store 内部逻辑
- 这种记 commit message + 代码注释就够了

## Workflow（2026-08-17 立）

> **新工作前先看 ADR，避免后面对不上**

1. **新功能 / 大改之前**: `ls doc/04-adr/` + `grep` 关键词找相关 ADR
2. **如果有相关 ADR**: 读决策背景和"何时 Revisit" — 决策可能已经过期
3. **如果决策过期**: 改原 ADR 加 `## 后续 Review` 章节（不删原文），同时写新 ADR 标 `Supersedes: ADR-XXXX`
4. **如果决策被推翻**: 新 ADR 替代，旧 ADR 标 `Superseded by ADR-XXXX`
5. **每次 commit 前**: 问自己"这次改动算 ADR 级别吗"，是就新开 ADR，不是就 commit message 简述

## 已记录的决策

| # | 标题 | 状态 | 日期 | v0.4 相关 |
|---|---|---|---|---|
| [0001](0001-tauri-vs-electron.md) | Tauri 2 vs Electron | Accepted | 2026-08-12 | 🟢 |
| [0002](0002-minimalist-design.md) | Minimalist Copy 设计系统 | Accepted | 2026-08-16 | 🟢 |
| [0003](0003-desktop-only-sidecar.md) | Desktop-only + Node sidecar 拆分 | Accepted | 2026-08-12 | 🟢 |
| [0004](0004-byok-os-keychain.md) | BYOK + OS Keychain | Accepted | 2026-08-12 | 🟢 |
| [0005](0005-provider-rust-file.md) | Provider 持久化 → Rust 文件 | Accepted | 2026-08-15 | 🟡 |
| [0006](0006-marked-v18-gfm.md) | marked v18 GFM 后处理修法 | Accepted | 2026-08-15 | 🟡 |
| [0007](0007-no-ui-library.md) | 不引入 UI 组件库 | Accepted | 2026-08-14 | 🟡 |
| [0008](0008-tauri-invoke-listen.md) | Tauri invoke/listen 替代 WS | Accepted | 2026-08-12 | 🟢 |
| [0009](0009-sidecar-spawn-per-prompt.md) | Sidecar 一次一 spawn | Accepted | 2026-08-12 | 🟢 |
| [0010](0010-sidecar-direct-fetch.md) | Sidecar 直接 fetch 不引 SDK | **Superseded by 0012** | 2026-08-12 | 🟢 |
| [0011](0011-decorations-false.md) | `decorations: false` 自定义 title bar | Accepted | 2026-08-16 | 🟡 |
| [0012](0012-pi-sdk-integration.md) | 集成 pi-ai + pi-agent-core | Accepted | 2026-08-16 | 🟢 |
| [0013](0013-session-manager-compact.md) | v0.4.2 上下文管理 (createAgentSession + SessionManager) | Accepted | 2026-08-17 | 🟢 |
| [0014](0014-tool-permission-3-modes.md) | Tool permission 3 模式 (ask/smart/allow) | Accepted | 2026-08-17 | 🟢 |
| [0015](0015-llm-retry-5x-exponential-backoff.md) | LLM 失败 5 次指数退避重试 (1s/2s/4s/8s/16s) | Accepted | 2026-08-17 | 🟢 |
| [0016](0016-stream-hang-watchdog.md) | Stream hang watchdog (30s 没新 event → abort + finishUp 兜底) | Accepted | 2026-08-17 | 🟢 |

> 🟢 = v0.4 实施时必参考 / 🟡 = 间接影响

## 待补的 ADR（次要决策, 引用时再补）

> 之前 README 里"待补"列表用了 0012/0013 等已被主决策占用的编号，已修复重编号到 0017+。
> 这些都是 token 级 / 模式级决策, **改起来不破坏架构**, 等真正实施时补 ADR 即可。

- **ADR-0017**: 5 档嵌套调色板（v0.3.8.25 拍板: page / card / popover / hover / active）
- **ADR-0018**: 不引入 Tailwind（v0.3.8.19 拍板, 走 pure CSS `--pad-*` 变量）
- **ADR-0019**: API key mask 函数 `sk-***XYZW`（v0.3.7 R5）
- **ADR-0020**: Provider ID `crypto.randomUUID()` 128-bit（v0.3.7 R2）
- **ADR-0021**: `window.__piTauri` 仅 DEV 暴露（v0.3.7 R1）
- **ADR-0022**: Sidecar 错误信息 sanitize 401/403（v0.3.7 R4）
- **ADR-0023**: Vite dev 跨端口 API 代理 / Tauri 内嵌加载（基础架构）
- **ADR-0024**: Default workspace `<home>/PiAgent/` 自动创建（v0.3.5+）
- **ADR-0025**: Pinia `acceptHMRUpdate` 防止 HMR 丢 state（v0.3.8.1+）

> 这些是次要决策，v0.4 实施过程中如需引用再补。

## 模板

```markdown
# ADR-NNNN: <决策标题>

- **状态**: Proposed / Accepted / Deprecated / Superseded by ADR-XXXX
- **日期**: YYYY-MM-DD
- **决策者**: <谁拍板>

## 背景
<什么问题 / 什么上下文 / 有什么约束>

## 备选
<列 2-4 个候选方案>

## 决策
<选了什么 / 关键理由>

## 后果
- 正面: ...
- 负面: ...
- 中性: ...

## 何时 Revisit
<什么信号出现时要重新评估>
```
