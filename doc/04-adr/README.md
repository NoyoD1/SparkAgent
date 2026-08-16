# 04 · Architecture Decision Records (ADR)

> **重大技术决策记录**。为什么当初这么选 / 备选是什么 / 取舍 / 后续怎么 review。
> **写代码前有重大决策先开 ADR**，不靠记忆不靠聊天记录。

## 什么是 ADR

- 一次决策一个 md 文件，文件名 `NNNN-<短名>.md`（NNNN 4 位递增）
- **不可变**：决策落地后不修改，只追加 `## 后续 Review` 章节
- 包含：背景 / 备选 / 决策 / 后果 / 何时 revisit
- 模板见 [template.md](template.md)

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

> 🟢 = v0.4 实施时必参考 / 🟡 = 间接影响

## 待补的 ADR

- ADR-0012: **5 档嵌套调色板**（v0.3.8.25 拍板）
- ADR-0013: **不引入 Tailwind**（v0.3.8.19 拍板）
- ADR-0014: **API key mask 函数 `sk-***XYZW`**（v0.3.7 R5 拍板）
- ADR-0015: **Provider ID `crypto.randomUUID()` 128-bit**（v0.3.7 R2 拍板）
- ADR-0016: **`window.__piTauri` 仅 DEV 暴露**（v0.3.7 R1 拍板）
- ADR-0017: **Sidecar 错误信息 sanitize 401/403**（v0.3.7 R4 拍板）
- ADR-0018: **Vite dev 跨端口 API 代理 / Tauri 内嵌加载**（基础架构）
- ADR-0019: **Default workspace `<home>/PiAgent/` 自动创建**（v0.3.5+）
- ADR-0020: **Pinia `acceptHMRUpdate` 防止 HMR 丢 state**（v0.3.8.1+）

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
