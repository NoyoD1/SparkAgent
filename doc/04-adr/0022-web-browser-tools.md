# ADR-0022: 浏览器方式 Web 工具 (chromiumoxide, 内外网统一访问)

- **状态**: Accepted (2026-08-23 拍板, 待实施)
- **日期**: 2026-08-23
- **Type**: Functional / Tools
- **Module**: Tools (联网能力 Phase 1)
- **决策者**: user
- **Relates to**: [0021-web-tools](0021-web-tools.md) (P0-3 公开 SaaS 路径, B 路), ADR-0019 P0-3 章节

## 背景

ADR-0021 P0-3 实现了"自实现 Brave API"的 web 工具（B 路），**对内网场景不友好**：
- Brave API 是公开 SaaS，内网环境无法访问
- 即使配 `webSearchBaseUrl` 指向内网代理，user 明确表示"不会自建搜索"

**新约束（user 2026-08-23 拍板）**：
1. **内网不会自建搜索服务**
2. **Phase 1 走浏览器方式**（任何 URL 都能访问，内外网统一）
3. Phase 2 再做"3rd party 搜索 API 配置 + Provider 原生工具"

浏览器方式天然支持内外网：URL 是公共网站就走公网，是内网 Confluence/Jira/Wiki 就走内网，**同一份代码**。

## 现状摘要

### 已有（作为基础）

| 能力 | 位置 |
|---|---|
| P0-3 `web_search` (Brave API) | `sidecar/src/index.mjs:loadWebTools` |
| P0-3 `web_fetch` (任意 URL fetch) | 同上 |
| Pi SDK customTools 机制 | `sidecar/src/index.mjs:allCustomTools` |
| 5min LRU 缓存 | 同上 |
| Keychain (Brave API key) | `src-tauri/src/keyring.rs` |

### 缺什么

- ❌ **JavaScript 渲染** — `web_fetch` 只能拿静态 HTML，复杂 SPA 拿不到内容
- ❌ **登录态 / Cookie** — 内网 Confluence / Jira 通常要登录，匿名 fetch 拿不到
- ❌ **截图** — 视觉内容（图表、UI）LLM 看不到
- ❌ **点击 / 滚动** — 翻页、点 "more"、滚动加载更多结果

## 目标

**MVP 范围**（Phase 1）：
- ✅ Headless Chromium 实例（Rust 进程内）
- ✅ 3 个 LLM 工具：
  - `web_browse_url(url)` — 导航到 URL，提取主内容（HTML→markdown）
  - `web_browse(query)` — 打开 Google/Bing 搜索 query，提取 top 10 标题+URL+snippet
  - `web_screenshot(url)` — 导航到 URL，截图 + 提取主文字
- ✅ 内外网统一访问（不需要 base URL 配置）
- ✅ 单 browser 实例 per session，30s 超时，5min 缓存（跟 P0-3 一致）

**不做**（P2 阶段）：
- ❌ 点击 / 滚动 / 表单提交 — 太重，Phase 2 评估
- ❌ 登录态持久化（Cookie jar）— 隐私 + 安全风险大，Phase 2 评估
- ❌ 多 browser 实例并行 — 资源开销大，Phase 2 评估
- ❌ 反爬对抗（CAPTCHA 识别、user agent 轮换）— 跟 LLM 用途不匹配

## 备选 / 关键决策

### 决策点 Q1: 浏览器引擎技术选型

- **A (推荐)**: **chromiumoxide**（Rust crate，async）— 跟 Tauri 集成干净，binary 不变大
- **B**: Playwright in sidecar — Node 生态成熟，文档多，但要装 ~200MB Chromium
- **C**: Tauri WebView2 (Edge) — 复用 Windows 自带 Edge，但自动化能力受限
- **D**: Puppeteer (sidecar) — 同 Playwright，Chrome only

**拍板: A** (2026-08-23, 跟 Tauri Rust 栈一致, sync API 友好, binary size 不变)

### 决策点 Q2: LLM 工具数量

- **A (推荐)**: 3 个 tool — `web_browse_url` + `web_browse(query)` + `web_screenshot`
- **B**: 1 个统一 tool `web_browser(action, ...)` — LLM 通过 action 参数选
- **C**: 只 1 个 `web_browse_url` — 搜索让 LLM 自己拼 URL（duckduckgo.com/?q=xxx）

**拍板: A** (2026-08-23, 3 个 tool 语义清晰, LLM 选错成本低)

### 决策点 Q3: Browser 实例管理

- **A (推荐)**: **单实例 per session** — 启动时创建，整个 session 复用
- **B**: 每次 tool 调用都新建 — 干净，但慢（每次 1-3s 启动）
- **C**: 进程级单例 — 所有 session 共享，可能有并发问题

**拍板: A** (2026-08-23, 启动慢不是问题, sidecar 启动时已建立, 复用省 1-3s/tool)

### 决策点 Q4: HTML→text 提取方式

- **A (推荐)**: chromiumoxide 自带 `Page.content()` 返回完整 HTML，**复用 P0-3 的 `htmlToText` 函数**
- **B**: chromiumoxide 用 Readability 算法（类似 reader mode）
- **C**: 引入 readability crate

**拍板: A** (2026-08-23, 复用已有代码, P0-3 的 htmlToText 80 分够用, 后续 P1 升级 Readability)

### 决策点 Q5: 搜索引擎选择（给 `web_browse(query)` 用）

- **A (推荐)**: **DuckDuckGo** (https://duckduckgo.com/html/?q=) — 无需 API key，无反爬，HTML 简单
- **B**: Google — 反爬强，IP 限频
- **C**: Bing — 反爬中等，HTML 结构稳定

**拍板: A** (2026-08-23, DDG HTML 版专为爬虫设计, 不需要 key, 国内外网都通)

### 决策点 Q6: 资源限制

- **A (推荐)**: 30s 超时 / page，10MB max content，**单 browser instance 内存 ~50MB**
- **B**: 60s / 50MB — 慢但全
- **C**: 不限 — 失控风险

**拍板: A** (2026-08-23, 30s 够 LLM 大部分查询场景, 10MB 截断跟 web_fetch 一致)

### 决策点 Q7: 错误处理 / offline 优雅降级

- **A (推荐)**: 浏览器启动失败 / 导航超时 → tool 返回明确错误，LLM 知道"web 不可用" 走其他路径
- **B**: 自动重试 N 次
- **C**: 切到 P0-3 Brave API 兜底

**拍板: A** (2026-08-23, 简单优先, 降级到 Brave 是 Phase 2 评估, 现在不混路径)

## 端到端核验

### 启动流程

1. sidecar 启动时（`run_prompt`）
2. sidecar 检查 `tools` 列表里有没有 `web_browse*` / `web_screenshot` 名字
3. 有 → **lazy init chromiumoxide Browser**（首次 tool 调用时启动，约 1-2s）
4. 没 → 跳过

### Tool 调用

| Tool | 流程 |
|---|---|
| `web_browse_url(url)` | 1. 检查缓存 2. 启动 browser（lazy） 3. `page.navigate(url)` 4. 等 load 5. `page.content()` 拿 HTML 6. `htmlToText` 转 markdown 7. 截断 50KB 8. 缓存 + 返回 |
| `web_browse(query)` | 1. 检查缓存 2. 启动 browser 3. `page.navigate('https://duckduckgo.com/html/?q=' + encodeURIComponent(query))` 4. 等 load 5. 解析搜索结果列表（title + url + snippet）6. 转 markdown 7. 缓存 + 返回 |
| `web_screenshot(url)` | 1. 检查缓存（key 包含 url） 2. 启动 browser 3. `page.navigate(url)` 4. 等 load 5. `page.screenshot()` 拿 PNG bytes 6. 转 base64 7. 同时 `htmlToText` 拿文字 8. 返回 `{screenshot: base64, text: markdown}` |

### 验证清单

1. ✅ `web_browse_url('https://www.rust-lang.org')` → 返回主页 main content
2. ✅ `web_browse('Rust 1.80 release notes')` → 返回 DDG top 10 结果
3. ✅ `web_screenshot('https://github.com')` → 返回 base64 PNG + 文字
4. ✅ 内网 URL（如 `http://wiki.corp.local`）能正常打开（DNS 解析后）
5. ✅ 无网络时，tool 返回明确 "navigate failed" 错误，不 crash
6. ✅ JavaScript 渲染页面（SPA）能拿到渲染后内容
7. ✅ 5min 缓存命中 → sidecar stderr log `[web-browser] cache hit`
8. ✅ 30s 超时强制 kill navigation
9. ✅ binary size 增量 < 5MB（chromiumoxide 不带 Chromium 自身，依赖 system Chrome）

## 风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| 系统没装 Chrome / Edge，chromiumoxide 启动失败 | 中 | 高 | 文档说明依赖，FE 加 "Web 浏览需要 Chrome/Edge" 检测 |
| Chromium 启动慢（1-2s）影响首次调用体验 | 中 | 低 | lazy init + warm-up 提示 |
| LLM 滥用浏览器跑大量请求，触发反爬 | 中 | 中 | per-session request 计数 + rate limit |
| 内网 URL 含敏感信息，audit log 泄露 | 中 | 中 | audit log 记录 URL 但**不记录**返回内容 |
| chromiumoxide API 升级 break | 低 | 中 | 锁定版本，定期 review |

## 实施计划

### 阶段 1: 基础设施（1-2 天）

- [ ] `src-tauri/Cargo.toml` 加 `chromiumoxide = "0.x"` 依赖
- [ ] `src-tauri/src/sandbox/browser.rs` 新文件：
  - `pub struct BrowserPool` — 单实例 wrapper
  - `pub fn new() -> Result<Browser>` — lazy init
  - `pub fn navigate(url) -> Result<PageHandle>`
  - `pub fn screenshot(page) -> Result<Vec<u8>>`
- [ ] 错误类型定义（NetworkError, TimeoutError, NavigationError）

### 阶段 2: 3 个 LLM 工具（2-3 天）

- [ ] `sidecar/src/index.mjs` 加 `loadWebBrowserTools()`
  - `web_browse_url(url)` — 通过 IPC 调 Tauri `browser_navigate` command
  - `web_browse(query)` — DDG search + parse
  - `web_screenshot(url)` — screenshot + text
- [ ] 5min LRU 缓存（key 包含 url + tool name）
- [ ] 复用 P0-3 的 `htmlToText` 函数

### 阶段 3: Tauri IPC + FE UI（1 天）

- [ ] Tauri 4 个 command：
  - `browser_navigate(url, timeout) → {html: string, status: u16, elapsed_ms: u64}`
  - `browser_screenshot(url, timeout) → {png_base64: string, text: string}`
  - `browser_status() → {healthy: bool, last_used: ISO8601}`
  - `browser_close()` — 主动清理（一般不需要，session 结束自动）
- [ ] FE Settings 加 "Web 浏览" section（轻量，只显示状态，不配 key）

### 阶段 4: 验证 + commit

- [ ] F12 测试 3 个 tool
- [ ] 内网 URL 测试（用 `http://localhost:port` 模拟内网服务）
- [ ] offline 测试（关网 / 给个不存在的 URL）
- [ ] ADR-0022 commit message
- [ ] commit + push

## 关键文件

| 文件 | 改动 |
|---|---|
| `src-tauri/Cargo.toml` | + `chromiumoxide` 依赖 |
| `src-tauri/src/sandbox/browser.rs` | 新文件，BrowserPool |
| `src-tauri/src/lib.rs` | + 4 个 browser_* Tauri command |
| `sidecar/src/index.mjs` | + `loadWebBrowserTools()` + 3 tool def + 复用 P0-3 htmlToText |
| `app/src/components/Settings/tabs/GeneralTab.vue` | + "Web 浏览" section (轻量) |
| `app/src/lib/tauri.ts` | + 4 个 browser_* wrapper |
| `doc/04-adr/0022-web-browser-tools.md` | 本文件 |

## 不在范围

- 3rd party 搜索 API 适配（Exa / Tavily / SearXNG 等）— Phase 2
- Provider 原生 web 搜索工具（KIMI / GLM / MIMO）— Phase 2
- 多 browser 实例并行 — Phase 2 评估
- Cookie jar / 登录态持久化 — Phase 2 评估
- 点击 / 滚动 / 表单 / 鼠标 — Phase 2 评估
- 反爬对抗（CAPTCHA / UA 轮换 / IP 池）— 不做
- 跨 session 复用 — Phase 2
