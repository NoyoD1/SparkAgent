# UI / 主题 (UI & Theming)

> 状态: ✅ 90%
> 最后更新: 2026-08-16
> spec 涉及: `app/src/assets/styles/tokens.css` + `app/src/components/` + `Pi-Agent-Design.design/assets/Minimalist Copy/`

---

## 1. Spec

**极简 + monochrome + border-driven**。用户专注内容，UI 退到背景。**Minimalist Copy 设计系统**是 v0.3.8.19+ 唯一权威。

### 1.1 必备能力

- ✅ **Light / Dark / Auto 三种主题模式**（v0.3.8.16+）
- ✅ **主题持久化**（localStorage）
- ✅ **主题应用** via `<html data-theme="...">`
- ✅ **暗色对比度 4.5:1+**（WCAG AA）— v0.3.8.17 redo
- ✅ **Primitive ramp 完整覆盖**（v0.3.8.18+）— 暗色不掉白方块
- ✅ **Minimalist Copy 调色板**：monochrome black/white/gray，无品牌色
- ✅ **12px radius**（sm 6 / md 10 / lg 12 / xl 16）
- ✅ **4px base spacing**
- ✅ **Border-driven**（不靠 shadow，1px border 分层）
- ✅ **5 档嵌套调色板**：page / card / popover / hover / active
- ✅ **字体**：系统字体（中文 PingFang/Microsoft YaHei）+ mono（JetBrains Mono）
- 🟡 **字号调节** — 基础档（默认 / 大 / 特大）
- ❌ **多语言**（i18n）— 未做（当前中文为主，英文能渲染但没专门本地化）
- ❌ **自定义 accent color** — 故意不做（破坏 monochrome 原则）
- ❌ **主题导出 / 导入** — 不做（用户不用换）

### 1.2 不做什么

- ❌ 鲜艳的品牌色（保持 monochrome）
- ❌ 渐变背景（破坏 minimalist）
- ❌ 动画过渡夸张（200ms 内）
- ❌ 圆角很大（> 16px）
- ❌ 阴影堆叠（border 替代）
- ❌ Emoji 装饰（功能性图标为主）

---

## 2. 当前实现

| 文件 | 职责 |
|---|---|
| `app/src/assets/styles/tokens.css` | 全部 design token（primitive + semantic）|
| `app/src/assets/styles/main.css` | 全局样式 + reset |
| `app/src/components/Settings/tabs/AppearanceTab.vue` | 主题切换 UI |
| `app/src/stores/ui.ts` | 主题状态 + 持久化 |
| `Pi-Agent-Design.design/assets/Minimalist Copy/` | 设计源（唯一权威）|

### 2.1 Token 结构（v0.3.8.19+）

```css
/* Primitive ramp (10 阶) */
--pad-bg-50 ~ --pad-bg-900
--pad-fg-50 ~ --pad-fg-900
--pad-border-50 ~ --pad-border-900

/* Semantic role (light 主题) */
--pad-bg-page: #fafafa
--pad-bg-card: #ffffff
--pad-bg-popover: #ffffff
--pad-bg-hover: #f5f5f5
--pad-bg-active: #ebebeb
--pad-fg-primary: #0a0a0a
--pad-fg-secondary: #525252
--pad-fg-tertiary: #a3a3a3
--pad-border: #e5e5e5
--pad-primary: #18181b
--pad-primary-foreground: #fafafa

/* Dark 主题覆盖 */
[data-theme="dark"] {
  --pad-bg-page: #0a0a0a
  --pad-bg-card: #171717
  --pad-bg-popover: #262626
  /* ... 完整覆盖 */
}
```

### 2.2 关键设计决策

- **D1: 不用 UI 组件库**（不引 Naive UI / Element Plus / Ant Design）— 自己实现，保持极简一致
- **D2: 不用 Tailwind** — 纯 CSS + CSS variables（v0.3.8.19 决策）
- **D3: 5 档调色板** — nested card 永远走 5 档之一，不 0 也不重
- **D4: Border 替代 background 差异** — 不靠底色分层，靠 1px border

### 2.3 滚动条

- sidebar / dropdown / drawer：**隐藏**（minimalist 原则）
- 主内容（chat list / settings）：保留 slim 滚动条
- 实现：scrollbar-width: none + ::-webkit-scrollbar { display: none }

---

## 3. 已知问题 / 限制

- 🟡 中英混排字号没做微调（中文略小）
- 🟡 Dark 主题下代码块配色待优化（某些 token 高亮不够亮）
- 🟡 高 DPI 屏（200%+）下 1px border 渲染不够锐利
- 🟡 没有"系统主题变化自动跟随"（Auto 模式启动时检测，不持续监听）

---

## 4. 待办（Roadmap）

### P0（v1.0 必做）
- [ ] 暗色代码块配色优化
- [ ] Auto 模式监听 OS 主题变化

### P1（v1.0 必做）
- [ ] i18n 基础（en-US + zh-CN）
- [ ] 字号档（默认 / 大 / 特大）
- [ ] 字号 + 语言持久化

### P2（v1.0+）
- [ ] 高 DPI 屏 border 锐化
- [ ] 设计 token 文档化（给 plugin 作者用）
- [ ] 设计 token 导出（给 figma 同步用）

---

## 5. Changelog

- **2026-08-16 · v0.3.8.27** · 移除 composer fade mask
- **2026-08-16 · v0.3.8.25** · composer 无 focus 边框 + nested card 恢复
- **2026-08-16 · v0.3.8.24** · drawer 背景去除（over-correction，后续恢复）
- **2026-08-16 · v0.3.8.23** · 整张界面统一背景（无"膏药贴"）
- **2026-08-16 · v0.3.8.22** · 标题栏 8px 圆角 + Windows 11 窗口适配
- **2026-08-16 · v0.3.8.20** · workspace 列表隐藏滚动条
- **2026-08-16 · v0.3.8.19** · Minimalist Copy 完整迁移（accent 改近黑，radius 收紧）
- **2026-08-16 · v0.3.8.18** · dark theme primitive ramp 补全
- **2026-08-16 · v0.3.8.17** · dark theme 4.5:1+ 对比度 redo
- **2026-08-16 · v0.3.8.16** · light/dark/auto 三模式
- **2026-08-15 · v0.3.5** · 初始 3 列布局
