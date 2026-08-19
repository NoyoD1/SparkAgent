# ADR-0006: v0.5.0 — sidecar 重写走 Pi SDK runRpcMode

- **状态**: Accepted
- **日期**: 2026-08-17
- **决策者**: user
- **Supersedes**: v0.4.2 step 1 的 `createAgentSession` + 手写 IPC 协议 (代码在, 思想被取代)
- **Relates to**: [0005-pi-sdk-integration](0005-pi-sdk-integration.md)

## 背景

v0.4.2 step 1 之后, sidecar 已经走 `createAgentSession` + `SessionManager` + `Extension API`, 但手写了:
- stdin readline + JSON parse
- 40+ case event map
- 5x retry watchdog
- 30s stream hang watchdog
- permission extension
- 700+ 行 FE event handler (chat store 累 state)

sidecar 836 行, FE chat store 700+ 行, 副作用越来越难维护.

user 16:18 明确指示: "去严格看一下用的 pi 的两噶包，里面是否已经提供了轮子，我们不要自己重复造轮子" + "判断哪些要改直接重新写，不要一直不断打补丁的方式导致后面越补越烂".

## 备选

- **A. sidecar 重写走 Pi SDK `runRpcMode` + `createAgentSessionRuntime`** — 选这个
- B. 继续打补丁 (user 反对)
- C. 整体换 LangChain.js — bundle 太大, 协议不一样

## 决策

**v0.5.0 大重构**, 14 commit (484de1b / 7ef5b8b / b251e92 / 78b9821 / 4879808 / 40d9b99 / 6b30141 / 16aebb8 / 7247efe / 4d849f1 / 115959e / 8758554 / 33fc5fa / v0.5.9 doc sync):

| 改动 | Before (v0.4.2 step 1) | After (v0.5.0+) |
|---|---|---|
| sidecar 总行数 | 836 | ~600 wrapper |
| stdin/stdout 协议 | 手写 | Pi SDK `runRpcMode` |
| 5x retry | 自写状态机 (commit 88d05ea) | Pi SDK `auto_retry_*` events |
| 30s hang watch | 自写 (commit 3bf926a) | Pi SDK 内置 |
| Permission Extension | 自写 50 行 | Pi SDK `pi.on("tool_call")` |
| Event 协议 | 自创 (sidecar 40+ case map) | Pi SDK RpcEvent |
| FE chat store | 700+ 行手写 event handler | ~200 行 (pull `get_state` + push events) |
| Tauri stdin 命令 | 6 个手写 (config/prompt/abort/permission_response/set_permission_mode/compact_session) | 透传 (Tauri 不解析) |

**后续 hotfix**:
- **v0.5.4 (commit 7247efe)**: 启动 runtime 后手动 sync `sessionManager.buildSessionContext().messages` → `agent.state.messages`. Pi SDK 0.84.2 `createAgentSessionFromServices` 不会自动 sync, 只在 switchSession/newSession 流程 sync. 不 sync → agent state 只有 [system], 即使 file load 了 history → "答第一次对话" bug.
- **v0.5.5 (commit 4d849f1)**: DeepSeek V4 Flash model behavior 幻觉, `appendSystemPromptOverride` 加 `<context_awareness>` 段.
- **v0.5.6 (commit 115959e)**: bun compile sidecar → `pi-agent-sidecar.exe` (D163 跨项目规则, 不依赖 system Node).
- **v0.5.8 (commit 33fc5fa)**: Tauri 2 标准 sidecar 机制 (`bundle.externalBin` + `app.shell().sidecar()`), 干净 Windows 机器 install MSI/NSIS 真能跑 (D172 跨项目规则, 补 v0.5.6 漏的标准机制).

**端到端验证** (v0.5.9 doc sync, 2026-08-17 22:02 + 23:07): user 干净 Windows 机器装 NSIS, 7 场景全 PASS (安装 / Provider / 消息 send / 工具 / think / 权限 / 上下文记忆).

## 后果

- ✅ sidecar 代码 -30%, FE chat store -70%
- ✅ 协议标准化 (走 Pi SDK RpcEvent)
- ✅ retry / hang watch / backpressure / extension UI 全 Pi SDK 内置
- ❌ 启动开销 +100ms (多走 RpcMode 协议层)
- ❌ Tauri 端不能解析 RpcCommand (要全透传, 调试时不便)

## 何时 Revisit

- 启动开销成问题 → 评估 sidecar 长连接 (持有 AgentSession, 复用进程)
- Pi SDK 0.85+ 大改 runRpcMode → 评估
- 跨 sidecar 通信需求 → 评估 IPC 协议
