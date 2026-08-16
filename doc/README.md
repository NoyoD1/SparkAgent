# Pi Agent · 产品蓝图 (Product Blueprint)

> **这份 `doc/` 是 Pi Agent 的开发导向（living blueprint）**。所有功能决策、当前状态、未来规划都在这里。
> **改代码前先看对应 feature 的 spec + status**；**做完一个 spec 内的项要更新这里的 status**。

---

## 目录结构

| 路径 | 用途 | 谁来读 |
|---|---|---|
| `README.md` | 本文件 — 索引 | 所有人 |
| [`00-product-blueprint.md`](00-product-blueprint.md) | 定位 / 用户画像 / 竞品差异化 / 14 维度状态总表 | 新人、对外 |
| [`01-architecture.md`](01-architecture.md) | 前后端架构 / 技术栈 / 部署形态 / 数据流 | 开发 |
| [`02-roadmap.md`](02-roadmap.md) | v0.4 → v1.0 路线图 + 每 phase 必做项 | PM / 排期 |
| [`03-features/`](03-features/) | **14 个功能维度 spec**（每个一个 md，含 spec + 状态 + changelog） | 开发者 |
| [`04-adr/`](04-adr/) | Architecture Decision Records — 重大技术决策记录 | 决策时 |

---

## 怎么读这份 doc

1. **新进开发者 / 第一次了解 Pi Agent** → 先读 `00-product-blueprint.md` 知道"我们在做什么 / 跟 ClaudeCode/Codex/Trae 有什么不一样 / 现在到哪一步"
2. **要做一个功能 / 改一个组件** → 找 `03-features/<name>.md`，看 spec 怎么写、status 是 ✅/🟡/❌/💭、changelog 最近改了什么
3. **要做一个重大技术决策**（换架构 / 换关键依赖） → 先看 `04-adr/` 是否已有同类决策，**新增一个 ADR** 再写代码
4. **要排下一阶段工作** → 看 `02-roadmap.md` 当前 phase 缺什么 + `03-features/` 里 ❌ 项

---

## 状态图例

| 标记 | 含义 |
|---|---|
| ✅ | **已做** — 生产可用，质量达标，spec 内主要项已实现 |
| 🟡 | **部分** — 有但残缺（mock 状态 / 已知 bug / spec 还没全实现） |
| ❌ | **未做** — spec 已有但代码还没写 |
| 💭 | **待讨论** — 想法阶段，没定 spec |

---

## 当前版本快照

- **App version**: v0.3.8.27（2026-08-16）
- **技术栈**: Tauri 2 + Vue 3 + TypeScript + Vite + Pinia + Node.js sidecar
- **目标平台**: Windows 桌面（macOS / Linux 待 v0.9+）
- **API 协议**: OpenAI-compatible（`/v1/chat/completions`），覆盖 7 内置 provider + 自定义
- **设计系统**: Minimalist Copy（monochrome black/white/gray + 12px radius + border-driven）

---

## doc 维护规则

1. **完成 spec 内一个待办项** → 改 status + 在该 feature md 的 changelog 加一行（日期 + 一句话）
2. **新增 / 删功能维度** → 同步更新 `README.md` 目录结构 + `03-features/README.md` 索引
3. **重大决策**（换架构 / 换关键依赖 / 改产品定位） → 写 `04-adr/NNNN-<name>.md`，不靠记忆
4. **状态总表更新** → `00-product-blueprint.md` 的"14 维度状态总表" + 实际 feature md 状态必须同步
5. **路线图阶段切换** → `02-roadmap.md` 标 current phase + 调整后续 phase 范围

---

## 跟其他项目文档的边界

- **代码内注释**：写"这个怎么用 / 怎么工作"（实现级）
- **doc/03-features/**：写"这个功能 spec 是什么 / 状态如何"（产品级）
- **doc/04-adr/**：写"为什么当初这么选 / 备选是什么 / 取舍"（决策级）
- **CHANGELOG / commit message**：写"什么时候改了什么"（历史级）

四者不重叠，遇到不确定写哪就问自己"读者想知道什么"。
