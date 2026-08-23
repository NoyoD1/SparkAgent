# ADR-0021 白话版 — Web 工具 (web_search + web_fetch)

> 配套 [0021-web-tools.md](0021-web-tools.md) 的简化说明.
> 这份只讲 "做什么 / 为什么 / 多大工作量", 不讲架构细节.

---

## 一句话总结

LLM 现在只能看本地文件 + 跑 bash, 加 2 个工具让它能搜网 (web_search) 和抓页面 (web_fetch). Brave Search 当 provider, API key 走 Tauri keychain (跟 LLM key 同机制).

---

## 加完后 LLM 能干啥

之前: "查 Pi Agent 项目最新版本" → LLM 答"我训练数据截止 XXXX 年, 不知道"
现在: LLM 自动调 web_search → 拿 5-10 条结果 → 可能再 web_fetch 某个 GitHub 页面 → 综合给你最新版本号

---

## 拍板的 7 件事

| # | 决策 | 选什么 |
|---|---|---|
| Q1 | Search provider | **Brave Search** (隐私 + free 2000 req/月 + JSON 简单) |
| Q2 | HTTP 客户端 | **ureq** (Rust 已有依赖) |
| Q3 | API key 存储 | **Tauri keychain** (跟 LLM key 同一 service 不同 username) |
| Q4 | Sidecar 拿 key | **Tauri 启动时从 keychain 读, 写到 stdin config** (跟 LLM apiKey 同 pattern) |
| Q5 | HTML→text | **手写 strip** (MVP 80 分够用, P1 再升级) |
| Q6 | 缓存 | **5 分钟内存 LRU** (跟 ADR-0019 S-2 一致) |
| Q7 | 工具名 | **`web_search` / `web_fetch`** (跟 ADR-0019 一致) |

---

## 分 3 阶段做 (1.5 天)

### 阶段 1: 关键文件 (1 天)

- Tauri 5 个 command:
  - 3 个 keychain: `save_web_search_key` / `delete_web_search_key` / `has_web_search_key`
  - 2 个 web tool: `web_search` (调 Brave) / `web_fetch` (抓页面)
- Sidecar 2 个 tool definition
- 5min LRU 缓存

### 阶段 2: FE UI (半天)

- Settings → 通用 加 "Web 搜索" section
- Provider 下拉 (目前只 Brave)
- API key input (password 框, save 写 keychain)
- Test 按钮 (跑一个 `web_search({query: "test"})` 验证 key 有效)
- 状态显示 (有 key / 无 key)

### 阶段 3: 验证 + commit

- F12 全流程
- 检查 Windows Credential Manager 里有新 entry
- commit + push

---

## 关键文件

| 文件 | 改什么 |
|---|---|
| `src-tauri/src/lib.rs` | 5 个新 Tauri command |
| `src-tauri/src/sidecar.rs` | 读 keychain 加 webSearchKey 到 config |
| `sidecar/src/index.mjs` | 2 个 tool definition + cache + Brave client |
| `app/src/components/Settings/tabs/GeneralTab.vue` | Web 搜索 UI |
| `app/src/lib/tauri.ts` | 5 个 TS wrapper |
| `doc/04-adr/0021-web-tools.md` | 主 ADR |

---

## 总投入: 1.5 天

---

## 不做的 (P1 / 后续)

- 多 provider 切换 (Brave / Google / Bing) — MVP 简单
- HTML→Markdown 完整转换 (用 html-to-text) — MVP 80 分够 LLM 用
- 高级搜索参数解析 — 走原始 query 字符串
- 持久化缓存 — 5min 内存够
- 跨 session 复用 — 跟 session log 集成是 P1
