# ADR-0022 白话版 — 浏览器方式 Web 工具

> 配套 [0022-web-browser-tools.md](0022-web-browser-tools.md) 的简化说明.
> 这份只讲 "做什么 / 为什么 / 多大工作量", 不讲架构细节.

---

## 一句话总结

P0-3 用 Brave API 走公开 SaaS, 内网不能用. 现在加 **headless Chromium 浏览器**, LLM 让浏览器去开任何 URL — 公共网站、内网 Confluence、Jira 全能.

---

## 为什么浏览器优先 (而不是 Brave + 内网代理)

- **不会自建搜索服务** (你拍的)
- 浏览器能访问**任意 URL** — 内外网统一, 不需要配 base URL
- 同一份代码, 公共网站 (Google) 和内网应用 (Confluence) 都用 `web_browse_url(url)`
- Brave 内网代理要自建, 复杂, 没必要

---

## 加完后 LLM 能干啥

- 之前 `web_fetch` 只能拿静态 HTML
- 现在浏览器能跑 JS 渲染 — 复杂 SPA (Notion / 各种内部系统) 也能拿内容
- 截图能力 — 视觉内容 (图表、UI) LLM 看得见
- 内外网统一 — 同一份代码, 公共网站和内网应用都能访问

---

## 拍板的 7 件事

| # | 决策 | 选什么 |
|---|---|---|
| Q1 | 浏览器引擎 | **chromiumoxide** (Rust, 跟 Tauri 集成干净, binary size 不变) |
| Q2 | LLM tool 数量 | **3 个 tool** — `web_browse_url` + `web_browse` + `web_screenshot` |
| Q3 | Browser 实例 | **单实例 per session** (复用, 启动 1-2s 不是问题) |
| Q4 | HTML→text | **复用 P0-3 手写 htmlToText** (80 分够用, P1 升级) |
| Q5 | 搜索引擎 (web_browse 用) | **DuckDuckGo HTML** (无 key, 无反爬, 国内外网都通) |
| Q6 | 资源限制 | 30s/page, 10MB max, 单 browser ~50MB 内存 |
| Q7 | 错误处理 | 明确报错, LLM 知道 "web 不可用" 走其他路径 |

---

## 3 个 LLM 工具

```
web_browse_url(url)   — 打开 URL, 拿主内容 (markdown)
web_browse(query)     — DuckDuckGo 搜 query, 返回 top 10 标题+URL+snippet
web_screenshot(url)   — 打开 URL, 截图 (base64 PNG) + 文字
```

**跟 P0-3 共存**:
- `web_search` (Brave) — 快、简单 query 用
- `web_fetch` (HTTP) — 静态页
- `web_browse_url` (browser) — JS 渲染页、内网应用
- `web_screenshot` (browser) — 视觉内容

LLM 自己挑.

---

## 分 4 阶段做 (1 周)

| Day | 内容 |
|---|---|
| 1-2 | chromiumoxide 集成 + BrowserPool |
| 3-4 | 3 个 LLM tool + 5min cache + 复用 P0-3 htmlToText |
| 5 | Tauri 4 个 IPC command + FE 状态 section |
| 6-7 | 验证 + commit + push |

---

## 内网/外网统一 (不需额外配置)

| 场景 | 怎么用 |
|---|---|
| 公共网站 | `web_browse_url('https://github.com/...')` |
| 内网应用 | `web_browse_url('http://wiki.corp.local/page/123')` |
| 不存在的 URL | tool 明确返回 "navigate failed", LLM 走其他路径 |
| 断网 | tool 明确返回 "network error", LLM 知道 |

**没有任何 base URL 配置需要 user 填**.

---

## 跟 Phase 2 / Phase 3 的关系

| 阶段 | 内容 | 状态 |
|---|---|---|
| **Phase 1 (本 ADR)** | 浏览器 (chromiumoxide) | 待实施 |
| **Phase 2** | 3rd party 搜索 API (Exa / Tavily / 等) + Provider 原生工具 (KIMI / GLM / MIMO) | 暂缓 |
| **Phase 3** | 不做 (跳过) | — |

---

## 总投入: 1 周

---

## 不做的 (YAGNI)

- 多 browser 实例并行 — 太重
- Cookie 持久化 / 登录态 — 隐私风险
- 点击 / 滚动 / 表单 — 太重, Phase 2 评估
- 反爬对抗 (CAPTCHA / UA 轮换) — 跟 LLM 用途不匹配
