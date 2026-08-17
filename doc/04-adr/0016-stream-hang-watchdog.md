# ADR-0016: Stream hang watchdog (30s 没新 event → abort + finishUp 兜底)

- **状态**: Accepted
- **日期**: 2026-08-17
- **决策者**: AI 拍板, 用户后续确认
- **Relates to**: [ADR-0012](0012-pi-sdk-integration.md), [ADR-0003](0003-desktop-only-sidecar.md), [ADR-0015](0015-llm-retry-5x-exponential-backoff.md)

## 背景

Pi SDK `agent-loop.ts:281-359` `streamAssistantResponse`:
```javascript
const response = await streamFunction(config.model, llmContext, {...});
for await (const event of response) {
  // ... emit message_update / thinking / tool_call ...
}
// 关键: 只有当 response 真正 emit 'done' 或 'error' event 时, 才 emit message_end 然后 return
```

**问题**: 商汤 deepseek-v4-flash stream 偶尔不 emit done event (或 hang 很久才 emit). 在 `for await` 永远等待期间:
- Pi SDK 永不 emit `message_end` / `agent_end`
- Sidecar 永远不调 `finishUp`
- FE 永远停在"生成中..."状态
- **整次对话卡死, 用户必须重启 Pi Agent**

实测日志 (2026-08-17 13:xx):
```
[sidecar:sess-mswqxh2q-x03m] thinking 完 (stdout[149])
[90+ 秒无任何新 event]
... 整次对话死锁
```

Pi SDK 0.84 没内置 stream timeout. 必须 sidecar 自己兜底.

## 备选

### 方案 A: 不管, 让用户自己重启 ❌
- ❌ **核心功能不可用**: LLM hang 直接废掉一次对话, 不能接受

### 方案 B: 缩短 streaming 内部超时 (Pi SDK maxRetryDelayMs) ❌
- ❌ `maxRetryDelayMs` 只 cap `Retry-After` 头, 不控制 stream 超时
- ❌ 改 Pi SDK 内部违反 ADR-0012 决策 (用 SDK 公开 API)

### 方案 C: Sidecar 层加 30s 没新 event → force finishUp ✅ (推荐)
- ✅ **简单**: setInterval 检查 lastStreamEventTime, 超时调 finishUp
- ✅ **不影响正常流**: 正常 LLM 每 100-500ms emit event, 30s 阈值远超正常
- ✅ **不依赖 SDK 改动**: sidecar 模块级, 不动 Pi SDK
- ❌ **可能误杀慢 LLM**: 长 thinking (5-10s) + 大 tool output + 跨 provider 跳, 30s 可能不够

### 方案 D: 监听 AbortController 事件 + 用 stream 内置 cancel ❌
- ❌ Pi SDK stream function 没暴露 cancel hook
- ❌ 复杂, 跟方案 C 效果差不多

## 决策

**选方案 C: Sidecar 层加 30s stream hang watchdog**

```javascript
// sidecar/src/index.mjs
const STREAM_HANG_TIMEOUT_MS = 30_000;   // 30s
const STREAM_HANG_CHECK_MS = 5_000;      // 每 5s 检查

let lastStreamEventTime = 0;
let hangWatchdog = null;
let currentAbortController = null;
let currentFinishUp = null;  // module-level, 让 setInterval 能调

function startHangWatchdog() {
  stopHangWatchdog();
  lastStreamEventTime = Date.now();
  hangWatchdog = setInterval(() => {
    const idle = Date.now() - lastStreamEventTime;
    if (idle > STREAM_HANG_TIMEOUT_MS) {
      console.error(`[sidecar] WATCHDOG: ${Math.round(idle / 1000)}s no stream event, force finish`);
      if (currentAbortController) currentAbortController.abort();
      setTimeout(() => {
        if (currentFinishUp) {
          console.error('[sidecar] WATCHDOG: emit finishUp manually');
          currentFinishUp();
        }
      }, 1000);  // 1s 兜底, 让 abort 走完
      stopHangWatchdog();
    }
  }, STREAM_HANG_CHECK_MS);
}

function stopHangWatchdog() {
  if (hangWatchdog) {
    clearInterval(hangWatchdog);
    hangWatchdog = null;
  }
}

function resetHangWatchdog() {
  lastStreamEventTime = Date.now();
}

// agent.subscribe 任何 event 都 reset
agent.subscribe((event) => {
  resetHangWatchdog();
  // ...
});
```

关键技术点:
- **module-level `currentFinishUp`**: setInterval 在模块 scope, runPrompt 的 `finishUp` 是 closure, **必须 module-level 暴露**让 setInterval 能调
- **abort + 1s 兜底 finishUp**: `ac.abort()` 让 Pi SDK 走 error 路径正常 emit agent_end, 但**如果 abort 没让 SDK emit** (race condition), 1s 后手动 `currentFinishUp()` 兜底
- **任何 event 都 reset watchdog**: 包括 thinking / tool_execution / text_delta 等所有事件, 不只是 message_update

## 后果

### 正面
- ✅ **修 0 号 bug**: "卡在生成中" 这种卡死, 现在 30s 后自动 finishUp, FE 收到 agent_end, streaming 状态清, 用户能发下一条
- ✅ **副作用小**: 正常 LLM 100-500ms emit 一次 event, 30s 阈值远大于正常, 不会误杀
- ✅ **可观测**: sidecar log `WATCHDOG: 31s no stream event, force finish` 留痕
- ✅ **不依赖 SDK 改动**: sidecar 模块级, Pi SDK 升级也不影响

### 负面
- ❌ **30s 阈值是猜的**: 长 thinking (5-10s) + 大 tool output + 跨 provider, 可能误杀
- ❌ **不区分 LLM hang vs 用户长时间思考**: 用户让 LLM "think for 10 minutes" 这种场景, watchdog 30s 还是会触发
- ❌ **跟 retry 机制部分重叠**: hang 30s 后 abort → 触发 retry → 又是 30s hang → 又是 retry → 5 次用完用户等 31s*5 = 155s
- ❌ **sidecar log 多**: 正常情况每 5s 检查 1 次, 长时间没 event 时 log 噪声

### 中性
- 🟡 **跟 retry (ADR-0015) 互动**: watchdog 触发的 abort 不会自动 retry, 走 `error` event 走 retry loop. 实际 = hang → retry 5 次 = 155s 总窗口
- 🟡 **跟 ADR-0003 兼容**: per-prompt spawn 模式意味着 watchdog 在 runPrompt 生命周期内, runPrompt 结束 stopWatchdog
- 🟡 **跟 ADR-0012 兼容**: 不动 Pi SDK 内部, 走 sidecar 模块

## 何时 Revisit

- ❗ **用户反馈 30s 太短误杀长 thinking** → 阈值提到 60s 或 120s (待 LLM 慢但能跑通场景)
- ❗ **用户用 1M+ token 长 thinking 场景** → 改成"基于 message_update 频率自适应" (10s 内至少 1 个 event 视为正常)
- ❗ **Pi SDK 0.85+ 内置 stream timeout** → 标 Superseded, 改用 SDK
- ❗ **stream hang 跟 retry 互动太复杂** → 引入"hang 状态"独立于 retry, hang 30s 后只 emit error 不进 retry (避免 155s 等待)
- ❗ **多次 hang 触发 watchdog** → 累计 3 次直接换 provider (skill 级别 fallback)
