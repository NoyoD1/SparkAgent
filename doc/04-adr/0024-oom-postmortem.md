# ADR-0024: 长文本 streaming 触发 WebView2 OOM 事故复盘 (D213)

**Status**: Postmortem (2026-08-25)
**Author**: Pi Agent team
**ADR**: 0024
**Relates to**: ADR-0023 (silent restart watcher 自激是这个事故的表层原因之一)

> 这不是决策文档, 是事故复盘. 决策部分看 ADR-0023 (watcher 修法) + v3.58 (归档清空) + v3.59 (inline edit 恢复).

## TL;DR

13 个 commit (v3.45 ~ v3.55) + 6 次假设验证, 都没修到. **真凶是 chat store 收 6.7MB 单 message_end event 时 Vue 3 reactive 把整个 message 包 Proxy, JS heap 爆 → WebView2 渲染进程 OOM**. 删除所有 session 后症状消失 (只是 baseline 重置, 不是治本).

## 时间线

| 日期 | 现象 | 验证 |
|---|---|---|
| 8/24 19:00 | user 报告 "回复时拖拽窗口边框不适配" + "白话文 UI 错位" | 怀疑 100dvh / 渲染层 |
| 8/24 19-23 | v3.45-v3.55 共 13 个 commit, 改 v-html / 节流 / raw text / 撤回 100dvh / rAF throttle, 全失败 | OOM 还在 |
| 8/24 23 | v3.55 raw text streaming 改完, **OOM 还在** | 渲染层不是凶手 |
| 8/24 23:42 | A 线 retry 关闭 (`setAutoRetryEnabled(false)`), build + 测 | 修了 retry 但 OOM 还在, retry 不是凶手 |
| 8/25 00:13 | 加诊断 log (`diag_log` Tauri command 转 Rust `.tauri-debug.log`), 跑一次 | 拿到关键证据 |
| 8/25 00:57 | **定位真凶 #1**: `.tauri-debug.log` 11 次 `OSError: [Errno 22] Invalid argument`, 紧邻 18ms 前 3 次 `external_tools_restart_request written` | fs.watch 自激 silent restart → sidecar 4 秒内自杀 |
| 8/25 01:14 | v3.57 修法: 3 个 watcher 加 5s startup grace period | log 显示 17:24 跑通 1 个 LLM call, 0 OSError, 但 user 仍报 OOM |
| 8/25 01:25 | user 删了所有 session 后测试, **不 OOM 了, 速度变快** | 但 log 显示 17:23 / 17:35 两次同样长 prompt 都跑通 — fs.watch 修法本来就在工作, session 累积是另一层 |
| 8/25 01:40 | **定位真凶 #2**: `.tauri-debug.log` 1971 个 `message_end` events, **最大 6.7MB** (6,726,314 bytes) | LLM (deepseek-v4-flash) 长 prompt 触发 web_search, 累积 web_search 结果 + thinking + final answer, 单 message_end 6.7MB 进 chat store → Vue 3 reactive 触发 OOM |

## 之前的 13 个 commit 全失败原因

```text
v3.45  Tauri 端 Resized emit + FE 强制 reflow
v3.46  chat store rAF 60 FPS + 强制 chatData.value = {...} 整体 reactive trigger
v3.47  MarkdownContent 内部 rAF 节流 + chat store throttle 32ms (30 FPS)  ← reverted
v3.48  MarkdownContent 增量 append (跳过 markdown parse)  ← 字符串拼接 O(n²)
v3.49  撤 v3.46 整体 trigger, 改回局部 trigger
v3.50  MarkdownContent 改 v-html → insertAdjacentText (text node 累积)
v3.51  sendPrompt 删 throw 改 provider.models[0] 兜底
v3.52  同 v3.51
v3.53  (空, no commit found in log)
v3.54  推翻重写, 改回 v-html + 30 FPS 节流
v3.55  换思路, streaming 期间 v-text raw text + message_end 1 次 set innerHTML
```

**全部失败原因**: Vue 3 reactive 在 **6.7MB JSON push 进 store 时** 直接 OOM, 渲染层压根没机会跑. 改 v-html / 节流 / raw text 全部无效, 因为 6.7MB 进 store 这一步就已经爆了.

## 真凶 #1: fs.watch 自激 (修了)

`sidecar/src/{mcpWatcher,externalToolsWatcher,userToolsWatcher}.mjs` 在 sidecar 启动时装 `fs.watch(dir, ...)`. Windows 上 `ReadDirectoryChangesW` 启动后有几秒延迟事件 (装 watcher 期间 mtime 扫描 / 目录加载 / 跟 IDE 同步 等触发). 没有任何抑制, 4 秒内 fs.watch 延迟事件触发 → `writeRestartRequest()` → Tauri 端 100ms 轮询看到 → `child.kill()` 杀 sidecar → 正在跑的 LLM call 中断 → 流式 0 emit (messageUpdate=0) → chat store 创建空 assistant message → user 看到空回复, 重发 → 多个 sendPrompt + 多个空 message 累积 → WebView2 渲染进程内存爆 → OOM.

**触发链时间线** (user 16:56 那次):
```
16:56:28.155  sendPrompt#7lu0gp
16:56:28.216  ghost sidecar 也 spawn (parallel)
16:56:28.798  sidecar 启动完成, emit skills_snapshot
16:56:32.193  LLM message_start (4 秒后)
16:56:32.362  v3.39: external_tools_restart_request written (reason=user_tool_changed)
16:56:32.362  v3.39: external_tools_restart_request written (reason=external_tool_changed)
16:56:32.363  v3.39: external_tools_restart_request written (reason=external_tool_changed)  ← 3 个 watcher 都触发
16:56:32.382  Exception ignored in: <_io.TextIOWrapper name='<stdout>' mode='w' encoding='gbk'>
16:56:32.382  OSError: [Errno 22] Invalid argument
16:56:32.559  sidecar terminated: code=Some(1) signal=None
```

**修法** (v3.57 commit `5f73589`): 3 个 watcher 加 `STARTUP_GRACE_MS = 5_000`, 装 watcher 时记 `readyAt`, callback 触发时 `Date.now() - readyAt < 5000` 静默 skip, 不调 `writeRestartRequest`.

**副作用**: `OSError [Errno 22] Invalid argument` 是 sidecar 进程退出时 Bun GC 清理 stdout handle 触发 EINVAL, **不是真凶, 是症状**. `Exception ignored` 表示 shutdown 时异常被吞.

## 真凶 #2: chat store 累积 + LLM response 单 event 6.7MB (没修, 等 user 决定优先级)

`.tauri-debug.log` 1971 个 `message_end` events, 大小分布:

| 排名 | bytes | 备注 |
|---|---|---|
| max | **6,726,314** | (6.7MB) |
| 第 2-4 | 6,726,312 | 几乎相同 |
| 第 5-7 | 250,675 | |
| 第 8 | 222,800 | |
| 第 9-10 | 131,129 | |
| 中位数 | ~100KB-1MB | |

**user 跑 `deepseek-v4-flash` 长 prompt 触发 web_search, LLM response 累积 web_search 结果 + thinking + final answer, 单 `message_end` event 6.7MB**. Tauri 端 emit 给 WebView2, WebView2 端 chat store (Vue 3 reactive) 收到这 6.7MB JSON, **Vue 3 把整个 message 包 Proxy 触发 JS heap 爆**, 渲染进程 OOM, 浏览器报 "Out of Memory".

**user 删 session 后不 OOM 的原因 (不是 fs.watch 修法生效)**:
- chat store 内存回到 baseline, WebView2 渲染进程有足够余量装 6.7MB
- 下次累积还是会 OOM, 只是时间问题

**之前 13 个 commit 全失败原因**: 都改渲染层 (v-html / 节流 / raw text), 但 Vue 3 reactive 在 6.7MB message 入 store 时直接 OOM, 渲染层压根没机会跑.

## 配套修法

| Commit | 内容 | 状态 |
|---|---|---|
| v3.57 (`5f73589`) | fs.watch 启动 5s grace period, 抑制 Windows ReadDirectoryChangesW 延迟事件 | ✅ 修了真凶 #1 |
| v3.58 (`59e3211`) | 归档 session 批量删除 ("清空" 按钮), 让 user 快速缓解 chat store 累积 | ✅ 缓解, 不治本 |
| v3.59 (`a0a6fd0`) | 恢复 v3.43 + v3.44 inline edit 模式 (从 git reflog cherry-pick) | ✅ 找回 user 之前撤回的 UI 改进 |

## 治本修法 (未做, user 决定优先级)

| 修法 | 风险 | 价值 |
|---|---|---|
| chat store 收 `message_end` 时跳过 content 字段 (delta 已累积, message_end 是 final authoritative 重复) | 低 | 治本 #2, 6.7MB 不会进 store |
| message_end 大 content (>1MB) 走 IPC 分块 + 渐进 patch, 不一次性 push reactive | 中 | 治本 #2 完美 |
| WebView2 启动加 `--js-flags="--max-old-space-size=4096"` 提 heap 上限 | 低 | 缓解 |
| LLM response 限 maxOutput / 长 prompt 强制分轮 | 中 | 缓解 (LLM 配置层) |
| 自动 session 归档 + 限制 archived 数量 (单 workspace 最多 50 个) | 中 | 缓解 #2 累积 |

## 排查过程教训

1. **不要先改代码, 先看数据** — user 一直说"还是 OOM", 我连续 13 个 commit 改渲染层, 全错. 直到 1:25 看 `.tauri-debug.log` 才看到 6.7MB message_end. **应该第一次就 grep log 找异常, 不要瞎猜**.

2. **不要硬编码假设** — 一开始怀疑 100dvh (1 个 commit), 然后 v-html (3 个 commit), 然后 retry (1 个 commit), 然后 fs.watch (1 个 commit). 每个假设都没经验数据支持. **真凶完全不在这些路径上**.

3. **侧车 / 前端 / 渲染 三个进程要分开看** — sidecar 跑通不代表前端没崩. log 看到 sidecar 跑通 (17:24 第一次 18.7 秒跑完) ≠ user 看到不 OOM (WebView2 渲染进程还卡着). **要看完整链路, 任何一环都可能挂**.

4. **OOM 排查从 event size 分布入手** — 不是"渲染代码哪里有问题", 而是"event payload 体积分布 + 接收端单次 load 大小". 这个事故的 signal 是 `message_end` 6.7MB, 跟渲染层代码无关.

5. **reset --hard 不带 commit 的 inline 改动会丢** — v3.43 + v3.44 改的 inline edit 模式, 当初没单独 commit, reset --hard 之后 git reflog 还能看到, 但 working tree 已经覆盖. user 后来问"我那个内联编辑哪去了", 只能从 reflog cherry-pick 找回. **教训: 中间任何想保留的改动, 先 commit 一下再 reset**, 不要"反正要撤回就不 commit" 的心态.

6. **chat store 2000+ 行单文件, 排查 OOM 时找代码位置很难** — 之前反复在 chat.ts 跟 MarkdownContent.vue 之间跳. **应该拆 store (chatTransport / chatMessages / chatQueue / chatStream), 出问题时知道查哪个**.

7. **没有结构化日志, user 端 OOM 现象跟 log 数据对不上** — user 报告"OOM 崩了", log 显示 sidecar 跑通. **应该有 telemetry 自动上报, 别让 user 翻 145MB log 文件**.

## 相关 ADR

- **ADR-0023** (silent restart 机制): fs.watch 自激就是这条链路上的副作用, v3.57 修法是 watcher 启动期抑制
- ADR-0019 (P0-1 紧急 hotfix): v0.5.4 hotfix 把 `sessionManager.buildSessionContext()` 灌进 `agent.state.messages`, 跟"session 累积"半相关

## 决策 (已经做)

✅ v3.57: fs.watch 启动 5s grace period
✅ v3.58: 归档 session 批量删除 UI
✅ v3.59: 恢复 v3.43 + v3.44 inline edit 模式
✅ force push 远端 (`cf19ded...a0a6fd0`)

## 决策 (待 user 拍板)

⏳ v3.60: chat store 治本 (message_end content 去重 / 大 content 分块)
⏳ v3.61: WebView2 heap 配置 + 自动 session 归档
⏳ 拆分 chat store 为 4 个子 store
⏳ Telemetry 自动上报 OOM 现场
