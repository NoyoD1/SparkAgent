# ADR-0002: Minimalist Copy 设计系统

- **状态**: Accepted
- **日期**: 2026-08-16
- **决策者**: 用户

## 背景

v0.3.x 早期用紫色 accent + Tailwind 风风格，跟 Pi Agent 极简理念不符。设计师（用户）提供 `Pi-Agent-Design.design/assets/Minimalist Copy/` 作为设计源。

## 备选

### Minimalist Copy（monochrome）
- ✅ 极简：黑/白/灰 5 档 surface
- ✅ 不抢 LLM 内容焦点
- ✅ border-driven 风格统一（不靠 shadow / gradient）
- ✅ 12px radius + 4px base spacing — 不浮夸
- ❌ 无品牌色（v1.0 商业化可能需要）
- ❌ 视觉记忆点弱（用户首次记忆成本略高）

### 保留紫色 accent
- ✅ 有品牌色
- ❌ 跟"开发者工具"调性冲突（紫色偏 B 端/创意）
- ❌ 跟 Minimalist Copy 调性对立

### 彩色 accent 切换（用户可选）
- ✅ 灵活
- ❌ 设计 token 复杂度 ×N
- ❌ 跨设计一致性难保证

### 纯黑（terminal 风）
- ✅ 极简更彻底
- ❌ 跟 Pi Agent 略不同（Pi Agent 走白底）
- ❌ 用户没指定

## 决策

**Minimalist Copy（monochrome black/white/gray）**。

理由：
1. 用户主动指定（`Pi-Agent-Design.design/assets/Minimalist Copy/`）
2. 跟"开发者工具 + 极简 + 不抢 LLM 焦点"产品定位一致
3. 调色板 5 档（page / card / popover / hover / active）能覆盖所有 UI 分层需求
4. border-driven 风格 + 12px radius 是当下 design system 主流之一

## 后果

- 正面:
  - 视觉一致性强（所有组件走同一 token）
  - dark theme 实现简单（灰阶反序覆盖即可）
  - 不堆品牌色干扰 LLM 内容
- 负面:
  - v1.0 商业化时可能要补品牌色
  - 设计师后续改主题成本不低
- 中性:
  - 用户每次改动要同步整个 token ramp
  - 5 档调色板是"中庸"选择 — 不是极致极简（0 background）也不是多彩

## 何时 Revisit

- v1.0 商业化需要品牌色（提前在 v0.x 加 `--pad-brand` token 预留位）
- 用户主动反悔
- 改 dark theme 出现不可解决的对比度问题
- 新增组件类（如 chart）需要更多 surface 档
