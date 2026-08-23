# ADR-0021: Web 工具 (web_search + web_fetch) — ADR-0019 P0-3 实施

- **状态**: Accepted (2026-08-23 拍板, 待实施)
- **日期**: 2026-08-23
- **Type**: Functional / Tools
- **Module**: Tools (联网能力)
- **决策者**: user
- **Relates to**: [0019-feature-tools-diversity](0019-feature-tools-diversity.md) (父 ADR, P0-3 章节列了目标), [0020-sandbox-hardening](0020-sandbox-hardening.md) (沙箱前置)

## 背景

ADR-0019 P0-3 列了 2 个 LLM 工具 (web_search / web_fetch) 作为必修:
- LLM 训练数据有截止日期, 没法知道实时信息 (新闻 / 文档 / 价格 / 公告)
- 联网搜索 + 抓取是补足这个的核心能力

ADR-0019 Q1 已拍板 A (自己包装, key 走 Tauri keychain). 本 ADR 拍板实施细节.

## 现状摘要 (v0.6.3-rc1 + P-Sec1 收工后)

### 已有 (作为基础)

| 能力 | 落地形式 | 位置 |
|---|---|---|
| OS keychain | keyring crate (Windows Credential Manager / macOS Keychain / Linux Secret Service) | `src-tauri/src/keyring.rs` |
| LLM apiKey 入 keychain | `save_api_key` / `get_api_key` / `delete_api_key` 3 个 Tauri command | `src-tauri/src/lib.rs` |
| LLM apiKey 传到 sidecar | Tauri → sidecar stdin 第 1 行 config JSON (含 apiKey 字段) | `sidecar/src/index.mjs:0-100` |
| Tauri→sidecar RPC | stdin/stdout 协议 (Tauri 写命令, sidecar 写事件/结果) | `sidecar/src/index.mjs` |
| 7 内置 + MCP + user tool | customTools 合并到 Pi SDK | `sidecar/src/index.mjs:702-712` |
| HTTP 客户端 (Rust) | ureq 2 (sync, no async SSL) | `src-tauri/Cargo.toml` |
| HTTP 客户端 (Node) | Node 18+ 内置 fetch (bun compile 后可用) | bun runtime |

### 缺什么

- ❌ **LLM 看不到 web_search / web_fetch 工具** — 没有定义
- ❌ **Tauri 没 web 联网 command** — 调 Brave / Google / Bing API 没人接
- ❌ **API key 存哪** — Brave 跟 LLM key 不同 service, keychain 里要新开 "pi-agent-search-brave" entry
- ❌ **HTML→text** — web_fetch 抓回来是 HTML, LLM 看不下去, 要 strip 标签

## 目标 (P0-3 这一波做什么)

**MVP 范围**:
- ✅ 1 个 search provider (Brave Search)
- ✅ 2 个 LLM 工具 (web_search + web_fetch)
- ✅ API key 走 Tauri keychain, 跟 LLM key 同 `pi-agent` service 但不同 username
- ✅ 5 分钟结果缓存 (per ADR-0019 S-2, 节流省 key 配额)
- ✅ Markdown 格式输出 (LLM 友好)
- ✅ FE 配置 UI (key 录入 + test 按钮)

**不做** (P1 / 后续):
- 多 provider 切换 (Brave / Google CSE / Bing 同时配, 运行时选) — 加一层 abstraction 但 MVP 简单为先
- HTML→Markdown 完整转换 (用 html-to-text 简化版, 标签 strip + 段落重排, 不引重型依赖)
- 高级搜索参数 (date filter, site: filter, language) — 走 Brave 的原始 query 字符串, 不解析
- 智能 retry / 退避 — Brave 一次失败直接报错, 不 retry

## 备选 / 关键决策 (2026-08-23 全部拍板)

### 决策点 Q1: Search provider 选哪个

- **A (推荐)**: Brave Search — 隐私优先, free tier 2000 req/month + 1 req/s, JSON API 简单
- **B**: Google Custom Search JSON API — 成熟, 但 free tier 只有 100 req/day 太抠
- **C**: Tavily — AI-focused, free tier 1000 req/month, 适合 agent 但有 vendor lock-in
- **D**: DuckDuckGo Instant Answer — 无需 key, 但只有简单结果, 覆盖差

**拍板: A** (2026-08-23, 隐私 + 配额 + 简单 3 因素综合最好)

### 决策点 Q2: HTTP 客户端 (Tauri Rust 端)

- **A (推荐)**: ureq 2 (已在 Cargo.toml) — sync, no async, 简单, MVP 够用
- **B**: reqwest — async, 更流行, 但要加 tokio runtime (已在用但要复杂管理)
- **C**: 复用 keyring 的 sync 风格 (Tauri command 默认 sync, ureq 更顺)

**拍板: A** (2026-08-23, 跟现有 dependency 一致, MVP 优先)

### 决策点 Q3: API key 存储

- **A (推荐)**: Tauri keychain, service="pi-agent", username="search-brave" — 跟 LLM key 同一 service 不同 username
- **B**: settings.json 单独字段 `webSearchKey` — 简单, 但 settings.json 是 plain text, 安全性差
- **C**: 单独 .env 文件 — 更差, 容易 commit 误传

**拍板: A** (2026-08-23, 跟 LLM key 一致机制, 不引入新概念)

### 决策点 Q4: Sidecar 拿 key 的方式

- **A (推荐)**: Tauri 启动 sidecar 时, 把 key 从 keychain 读出, 放到 stdin 第 1 行 config JSON 的 `webSearchKey` 字段
  - 跟 LLM apiKey 同 pattern
  - Sidecar 内存里持有, 不会写盘
  - 关 sidecar = key 没了 (跟 LLM key 一样的生命周期)
- **B**: Tauri command web_search, sidecar 通过反向 RPC 调用
  - 安全 (key 不出 keychain), 但要新加反向 RPC 协议, 工程量大
- **C**: Tauri 启动 sidecar 时通过环境变量传
  - 简单, 但 env var 在进程列表可见, 略差

**拍板: A** (2026-08-23, 跟 LLM apiKey 完全同 pattern, 0 新增复杂度, 接受"内存持有"风险)

### 决策点 Q5: web_fetch 的 HTML→text

- **A (推荐)**: 手写简单 strip (用 regex 剥 script/style, 替换 block tag 为换行, 去所有剩余 tag)
  - 0 新依赖, 100 行内搞定
  - 质量 80 分 (能读但不够漂亮)
- **B**: html-to-text crate — 专门做这事的, 质量 90 分
  - 加 1 个依赖
- **C**: html2md crate — 转 Markdown, 质量 95 分
  - 依赖重, 编译慢

**拍板: A** (2026-08-23, MVP 优先, 80 分够 LLM 用. P1 再换 B/C)

### 决策点 Q6: 缓存策略

- **A (推荐)**: 5 分钟 TTL, 内存 LRU (100 条上限)
  - 节流 + 省 Brave 配额
  - web_search 跟 web_fetch 都走同一 cache
  - 跟 ADR-0019 S-2 工具结果缓存一致
- **B**: 不缓存 — 简单, 但 LLM 重复查会浪费 key 配额
- **C**: 持久化到文件 — 跨 session 复用, 但 5min 内一般同 session 就能复用, 多余

**拍板: A** (2026-08-23, 跟 ADR-0019 S-2 一致)

### 决策点 Q7: tool name 命名

- **A (推荐)**: `web_search` / `web_fetch` — 跟 ADR-0019 P0-3 章节一致, LLM 直观
- **B**: `pi_web_search` / `pi_web_fetch` — 加前缀避免跟其他工具冲突
- **C**: 跟 builtin tool 一致小写 (read/write/edit) — `websearch` / `webfetch`

**拍板: A** (2026-08-23, 跟 ADR-0019 一致)

## 端到端核验 (P0-3 完成后 user F12 测试)

### 配置流程

1. FE Settings → 新增 "Web 搜索" section
2. 用户填 Brave API key → save_web_search_key Tauri command → 写 keychain
3. 关 Tauri, 重开 → Tauri 从 keychain 读 key, 写到 sidecar config
4. cmd 窗口: `[web-search] keychain has key for search-brave: yes` (masked 显示前 2 后 4)

### LLM 工具调用

1. 跑: "查一下 Pi Agent 项目最新版本" → LLM 决定调 web_search
2. sidecar web_search 工具 → 调 Brave API → 拿 5-10 条结果 → 转 markdown → 返回 LLM
3. LLM 看到结果, 可能再 web_fetch 某个具体链接
4. sidecar web_fetch → HTTP GET → strip HTML → 截断 50KB → 返回 LLM
5. LLM 综合输出答案

### 验证清单

1. ✅ 配置 key 后 test 按钮返回 Brave 200
2. ✅ LLM 调 web_search 拿到真实结果 (不是 mock / not error)
3. ✅ 5 分钟内重复查同样 query, 走 cache (sidecar stderr log "[web] cache hit")
4. ✅ 删 key 后 web_search 报错, 错误信息明确 (key 未配置)
5. ✅ keychain 显示 1 条新 entry (`pi-agent:search-brave`)
6. ❌ 错误码 401/403/429 都分得清 (per P2-6 errorSanitizer pattern)
7. ❌ HTML 抓取后转 text, 关键内容保留, script/style 剥掉

## 风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| Brave API rate limit (1 req/s) | 中 | 中 | 5min 缓存 + 文档告知 user |
| key 写在 sidecar 内存里, sidecar crash dump 泄露 | 低 | 中 | P1 阶段可加 mlock 内存锁, MVP 接受风险 |
| HTML→text 质量差, LLM 看不懂 | 中 | 中 | MVP 80 分够用, P1 换 html-to-text |
| user 配错 key 一直失败 | 中 | 低 | test 按钮 + error sanitizer 明确报错 |
| Brave API 服务变更 / endpoint 改 | 低 | 中 | adapter pattern 隔离, P1 写 abstract SearchProvider 接口 |
| web_fetch 抓到大文件卡死 | 中 | 中 | 限制 50KB, 超时 10s |

## 实施计划

### 阶段 1: 关键文件 (~1 天)

- [ ] Tauri: 3 个 web search keychain Tauri command
  - `save_web_search_key(key)` → 写 keychain `pi-agent:search-brave`
  - `delete_web_search_key()` → 删
  - `has_web_search_key()` → 查 (FE "已配置" 状态)
- [ ] Tauri: 2 个 web tool Tauri command (用 ureq)
  - `web_search({ query, count? })` → 调 Brave API, 返回 markdown snippet list
  - `web_fetch({ url })` → 抓 URL, HTML→text, 截断
- [ ] Tauri: `run_prompt` 启动 sidecar 时读 keychain, 加到 config 的 `webSearchKey` 字段
- [ ] Sidecar: 2 个 tool definition
  - `web_search` (customTool, execute = 调 Tauri command via RPC 或者直接调 Brave API 用内存里的 key)
  - `web_fetch` (customTool, execute = 调 Tauri command 或者直接 fetch)
- [ ] Sidecar: 5min LRU 缓存

### 阶段 2: FE UI (~半天)

- [ ] `app/src/components/Settings/tabs/GeneralTab.vue` 加 "Web 搜索" section
  - Provider 下拉 (目前只 Brave)
  - API key input (password type, save 写 keychain)
  - Test 按钮 (拿 key 调 web_search({query: "test"}) 看是否 200)
  - 显示状态 (有 key / 无 key)
- [ ] `app/src/lib/tauri.ts` 加 wrapper

### 阶段 3: 验证 + commit

- [ ] F12 测试全流程
- [ ] 检查 keychain (Windows Credential Manager)
- [ ] 检查 cmd 窗口 sandbox + web 启动日志
- [ ] 写 ADR-0021 commit message
- [ ] commit + push

## 关键文件

| 文件 | 改动 |
|---|---|
| `src-tauri/src/lib.rs` | 5 个新 Tauri command (3 keychain + 2 web tool) |
| `src-tauri/src/sidecar.rs` | 启动 sidecar 时读 keychain 加 webSearchKey 到 config |
| `sidecar/src/index.mjs` | 2 个 tool definition + 5min LRU cache + Brave API client |
| `app/src/components/Settings/tabs/GeneralTab.vue` | Web 搜索 section |
| `app/src/lib/tauri.ts` | 5 个新 TS wrapper |
| `doc/04-adr/0021-web-tools.md` | 本文件 |

## 不在范围

- 多 search provider (Brave / Google / Bing 切换) — P1 再说
- 高级搜索参数解析 (date filter, site:, language) — 走原始 query 字符串
- HTML→Markdown 完整转换 — P1 用 html-to-text 替换手写
- 持久化缓存 — 5min TTL 内存够用
- 跨 session 复用 web 工具结果 — 跟 session log 集成是 P1 话题
- Agent-to-agent 通过 web tool — 不是 P0-3 范围
