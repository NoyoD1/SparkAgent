# ADR-0025: Pi Agent 功能完整性快照 + 优化/补充 backlog (2026-08-25)

**Status**: Snapshot (2026-08-25)
**Author**: Pi Agent team
**ADR**: 0025
**Relates to**: ADR-0024 (OOM postmortem, 7 条教训 → 多数本 ADR 跟进)

> 这不是决策文档, 是项目当前功能状态快照 + 待办清单. 决策部分看对应 ADR.

## 当前状态 (v3.60.6, commit `4338752`)

### 已做 (核心功能, 14 个 feature, ADR 0001-0024 全覆盖)

| 模块 | 状态 | ADR / commit |
|---|---|---|
| 架构基础 (Tauri 2 + Vue 3 + Pi SDK 0.84.2) | ✅ | 0001-0006 |
| 7 内置 provider + openai-compatible 自配 | ✅ | 0005, 0012 |
| 三层权限 (bash sandbox + dangerousWhitelist + 12 条 BUILTIN_DENY_LIST) | ✅ | 0008, 0020 |
| MCP server 集成 | ✅ | 0018, 0023 |
| External tools (subprocess) + 静默热重载 | ✅ | 0019, 0023 |
| User tools (preset 包装 builtin) | ✅ | 0014, 0023 |
| BrowserPanel (内嵌浏览器 reverse RPC) | ✅ | 0022 |
| Skill 系统 (3 个, 5 段 system prompt) | ✅ | 0015 |
| Session 持久化 (localStorage + jsonl) | ✅ | 0007, 0011 |
| Compaction (auto, LLM 视角 context) | ✅ | 0016 |
| AGENTS.md / project_context 自动注入 | ✅ | 0017 |
| Slash command (Pi SDK 内置 22 个 + 1 自定义) | ✅ | 0005 |
| Tools Tab inline edit | ✅ | v3.59 (`a0a6fd0`) |
| 归档批量删除 (清空按钮) | ✅ | v3.58 (`59e3211`) |
| 滚动跟随 (rAF + isNearBottom) | ✅ | v3.60 (`9b6a401`) |
| OOM 真凶 #1 修复 (fs.watch 5s grace) | ✅ | v3.57 (`5f73589`) |

### 临时撤回 (流式显示实验 6 个 commit, user 撤回到 v3.59 base)

v3.60 + v3.60.1 (mask + Transition) + v3.60.2 (节流) + v3.60.3 (逐字累加) + v3.60.4 (diag_log) + v3.60.5 (拆 watch) + v3.60.6 (revert). 整段回到 v3.42 / v3.55 base 行为, 滚动跟随保留.

## 待做 (按 user 优先级排)

### 紧急 (下次 OOM 触发时再做)

- **OOM 真凶 #2 治本** — chat store `assistant.content` 1MB 截断 + Tauri config WebView2 4GB heap. ADR-0024 "决策 (待 user 拍板)" 章节. 30 行改动, 5-10 分钟. 详见 ADR-0024 §"治本修法"

### 优化 (user 已决定顺序: 2 → 3 → 5)

#### 2. chat store 拆分 (chat.ts 2200+ 行)

`app/src/stores/chat.ts` 是项目最大文件, 包含: sendPrompt 入口 / listener 注册清理 / 14 个 case 分发 / reactive refs / queue / streaming / retry / ghost title / compaction / usage 累积. 任意一个出 bug 都要在 2200+ 行里找.

**目标**: facade pattern, 主 chat.ts 暴露原 API 不变 (Vue 组件零改动), 内部拆 4 个子 store 模块:

- `chatMessages.ts` — messages / usage / 14 case event 分发
- `chatQueue.ts` — sendQueue / dequeue
- `chatStream.ts` — streaming / retry / hang / phase 状态机
- `chatTransport.ts` — Tauri listener 注册清理 / ghost title / sidecar 通讯

**风险**: reactive 跨子 store 触发顺序. 需要 watch + 同步确保 event handler 顺序.

#### 3. 结构化日志 (Tauri + sidecar + FE 三端)

现在:
- Tauri 端: `debug_log()` 写 `D:/UnityWork/Tools/Pi/.tauri-debug.log`, 145MB 跨几天累积, 无 rotate
- sidecar 端: `console.error` 走 stderr, Tauri 端捕获写 log (混在一起)
- FE 端: `console.log` 在 WebView2 DevTools, user 看不到

**目标**: 统一一个 log 系统:
- 三端都走同一个格式 (level + module + timestamp + message)
- 写到同一个 log 文件 (rotate 7 天)
- FE 端用 `diag_log` Tauri command (已经 v3.60.4 加了, 但没 rotate)
- 加 log level 控制 (DEBUG / INFO / WARN / ERROR)

#### 5. session lifecycle policy (auto-archive + auto-delete)

现在 100+ session 累积, chat store 内存吃紧 (ADR-0024 §"user 删 session 后不 OOM 的原因"). user 之前手动清空按钮 (v3.58) 缓解, 但需要 **自动** lifecycle.

**目标**:
- 30 天没动 (last used) 的 session 自动 archive (从主列表隐藏, 保留数据)
- 90 天没动的 session 自动删 jsonl (保留 metadata 在 session store, 删本地文件)
- 启动时跑一次 cleanup
- Tauri 端实现 (有 fs / time API), FE 端 startup 触发

### 中等 (从 ADR-0024 教训来, user 没明确要)

- smoke test 自动化 (spawn sidecar + 发 prompt + 断言 message_update > 0)
- mention / reference 解析 edge case (D214 v5/v6/v6.1 修过, 还有 D214 v7 chip CSS)
- composer 附件 UX 打磨
- 暗色模式适配
- autosave / draft 恢复
- 多语言 (i18n) — 完全没, 现状中文硬编码
- error boundary (OOM 后 Tauri 友好提示 + 自动恢复)
- session 搜索 / 标签 / 收藏 / 分类

### 长期 (缺失 feature)

- 多 agent 协作 (ADR-0090 superseded, 需求不明确搁置)
- plugin 系统 (现 user tool / mcp / external tool 硬编码, 大工程)
- 多人协作 / 实时同步 (过度需求, 不做)
- 权限 per-tool 细粒度 (现只 bash 全局)
- user-defined slash command (现只 Pi SDK 内置 22)
- prompt template 库
- session 导出 / 分享 UI (jsonl 已有)
- diff / patch view for edit tool
- terminal output 渲染 (bash 工具长输出)
- 图片 preview 增强 (LLM vision 输出)
- 语音输入
- git 集成 (commit 工具结果自动 git add)
- manual context 压缩 (现只 auto)
- 测试框架 (单元 / 集成 / E2E, 完全没)
- Telemetry (OOM 自动上报, 启动时统计 message_end max size 警告)

## 决策 (本 ADR 不立新决策, 是状态快照)

本 ADR 记录项目当前功能完整度, 给后续 work 一个明确 backlog. 优化 2 / 3 / 5 在用户拍板后, 各自单独 commit + 单独 ADR 跟进.

## 何时 Revisit

每 1-2 月 review 一次:
- 新 feature 做完, 更新本 ADR 的 "已做" 章节
- 新增优化项, 加到 "待做" 对应优先级
- 移除已完成 / 已撤回项

---

## 后续 Review (2026-08-25, v3.60.6)

- v3.60 流式显示实验 6 个 commit 全失败 + 撤回到 v3.59 base, 教训: **没经过 user 实际跑过的视觉确认, 别 commit 流式显示类 UX 改动**
- ADR-0024 7 条排查教训中, 第 1 / 2 / 3 / 6 / 7 都在本 ADR backlog 里 (自动 / 结构化日志 / chat store 拆分 / smoke test / telemetry). 教训 4 (结构化) + 5 (reset --hard) 是 process 教训, 不在 backlog
