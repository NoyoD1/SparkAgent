# ADR-0003: 不引入 UI 组件库 (自研 Minimalist Copy)

- **状态**: Accepted
- **日期**: 2026-08-14
- **决策者**: user
- **Relates to**: [0001-tauri-2-shell](0001-tauri-2-shell.md)

## 背景

FE 组件库选型: Element Plus / Naive UI / PrimeVue / shadcn-vue / Headless UI / Reka UI / 自研...

走库 vs 自研?

## 备选

- **A. 自研 Minimalist Copy (pure CSS + scoped style)** — 选这个
- B. shadcn-vue (复制源码到项目, 可改) — 半自研
- C. Element Plus (成熟, 全) — bundle 大, 视觉跟系统不像
- D. Headless UI + Tailwind — 学习曲线 + Tailwind 跟项目风格不一致

## 决策

**自研 Minimalist Copy**:
- 5 档嵌套调色板: page / card / popover / hover / active — 通过 CSS 变量 `--pad-bg-*`
- Pure CSS 变量: `--pad-fs-13` (字号), `--pad-sp-2` (间距), `--pad-radius-md` (圆角)
- scoped style + `:deep()` 穿透 v-html
- 不引 Tailwind (跟 minimalist 风格冲突)
- 组件: Vue SFC 单文件, 全部 scope 内部
- Color: 跟 v0.3.8.26 起的 `fg-primary` / `fg-secondary` / `fg-tertiary` 三档灰阶

## 后果

- ✅ Bundle 小 (无外部 UI 库)
- ✅ 视觉一致 (全部走同一套 CSS 变量)
- ✅ 完全控制 (可改任何细节, 无库版本锁)
- ❌ 开发慢 (每个组件要手写)
- ❌ 复杂组件 (dropdown / popover / modal) 自己实现, 边角 case 容易漏

## 何时 Revisit

- 出现 5+ 个相似 dropdown 实现 → 抽公共 headless
- 视觉系统大改 (用户提"想要 macOS 风格") → 评估是否引 UI 库
