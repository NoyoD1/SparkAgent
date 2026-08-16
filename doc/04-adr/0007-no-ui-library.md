# ADR-0007: 不引入 UI 组件库（自实现原子组件）

- **状态**: Accepted
- **日期**: 2026-08-14
- **决策者**: 自己（基于 Minimalist Copy 设计源）

## 背景

Vue 生态有完整 UI 库（Naive UI / Element Plus / Ant Design Vue / Vuetify）。要不要引？引哪个？

## 备选

### Naive UI
- ✅ TS 友好
- ✅ 主题系统强（可定制）
- ❌ 默认风格跟 Minimalist Copy 冲突
- ❌ 覆盖主题要写大量 override

### Element Plus
- ✅ 生态最广
- ❌ 默认风格偏 B 端（蓝色 / 阴影）
- ❌ 主题覆盖成本极高

### Ant Design Vue
- ✅ 企业级完整
- ❌ 风格跟极简对立
- ❌ Bundle 大

### 自实现（Avatar / IconButton / PadSelect / ResizeHandle）✅
- ✅ 极简风格 100% 控制
- ✅ 包小（每个组件 < 5KB）
- ✅ 不被组件库 default style 绑架
- ❌ 开发慢（每个组件要写）
- ❌ 无障碍需要自己做
- ❌ Modal / Drawer / Tooltip 复杂组件要自己写

## 决策

**自实现原子组件 + 复杂组件按需引入**。

当前自实现 4 个：
- `Avatar.vue` — 头像（支持 text / slot / image）
- `IconButton.vue` — 图标按钮
- `PadSelect.vue` — 选择器
- `ResizeHandle.vue` — 拖拽手柄

复杂组件（Modal / Dropdown / Tooltip / Tabs）：
- 优先自实现
- 如果复杂度超阈值（> 200 行），考虑引第三方（如 `floating-vue` 做 popper）

**绝不**整体引 Naive UI / Element Plus。

理由：
1. Minimalist Copy 调色板 + border-driven 风格跟现成 UI 库都不契合
2. 主题 override 成本超过自实现
3. 原子组件逻辑简单（< 100 行），自实现成本低
4. 复杂组件（Modal / Tooltip）的 popper 库可以单独引，不污染整体

## 后果

- 正面:
  - 设计风格 100% 一致
  - Bundle 小（4 个原子组件 < 20KB）
  - 主题切换 / dark mode 不用过 UI 库 override 层
- 负面:
  - 复杂组件开发慢（如 TaskDrawer 折叠动效花了几轮迭代）
  - 无障碍需要自己做（aria-* / 键盘导航）
  - 团队规模大时维护成本高
- 中性:
  - 适合"小团队 + 极简风格 + 自有设计系统"场景
  - 大团队 / 多产品线会反向 — 引 UI 库效率更高

## 何时 Revisit

- 项目超过 5 个 dev（维护成本可能超过收益）
- 用户主动要"换有现成组件的"（极小概率）
- Modal / Drawer / Tooltip 复杂度过高（独立引 floating-vue 等 popper 库）
- 出现大量重复组件实现（自实现 5+ 个相似 Modal 时考虑抽库）
- v1.0 商业化需要更"成熟" UI 感（不是 minimalist 风格 — 需重新评估）
