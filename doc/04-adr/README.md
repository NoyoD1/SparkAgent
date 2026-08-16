# 04 · Architecture Decision Records (ADR)

> **重大技术决策记录**。为什么当初这么选 / 备选是什么 / 取舍 / 后续怎么 review。
> **写代码前有重大决策先开 ADR**，不靠记忆不靠聊天记录。

## 什么是 ADR

- 一次决策一个 md 文件，文件名 `NNNN-<短名>.md`（NNNN 4 位递增）
- **不可变**：决策落地后不修改，只追加 `## 后续 Review` 章节
- 包含：背景 / 备选 / 决策 / 后果 / 何时 revisit
- 模板见 [template.md](template.md)

## 已记录的决策

| # | 标题 | 状态 | 日期 |
|---|---|---|---|
| — | _（暂未开 ADR，先记在 doc README / 00-product-blueprint.md 内）_ | — | — |

## 计划要补的 ADR

- ADR-0001: **Tauri 2 vs Electron**（已落地但未写文档）
- ADR-0002: **Minimalist Copy 设计系统**（v0.3.8.19+ 切换）
- ADR-0003: **Desktop-only 形态 + Node sidecar 拆分**（v0.3 切）
- ADR-0004: **BYOK + OS Keychain**（v0.3 切）
- ADR-0005: **Provider 持久化迁 localStorage → Rust 文件**（v0.3.8+）
- ADR-0006: **marked v18 GFM 严格化的后处理修法**
- ADR-0007: **不引入 UI 组件库（自实现）**

> 这些决策散落在 commit message 和 `00-product-blueprint.md` 原则里，**下一步**：每个开一个 ADR md 详写。

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
