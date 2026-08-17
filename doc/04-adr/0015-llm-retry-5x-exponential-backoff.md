# ADR-0015: LLM 调用失败自动重试 5 次 (1s/2s/4s/8s/16s 指数退避)

- **状态**: Accepted
- **日期**: 2026-08-17
- **决策者**: 用户
- **Relates to**: [ADR-0012](0012-pi-sdk-integration.md), [ADR-0003](0003-desktop-only-sidecar.md)

## 背景

v0.4.1 sidecar 每次 LLM 调用失败立即终止:
- 商汤 deepseek-v4-flash 报 `429 quota exceeded` → 立即断流
- 商汤偶尔 `stream hang` (不 emit done) → 30s watchdog 兜底 finishUp, 但单次不重试
- 网络抖动 / 5xx / model provider 临时 down → 同样直接报错

实测场景 (2026-08-17 14:xx): 用户发消息, 商汤前两次立即 429, 第三次调了 `ls` 又 429, **整次对话废了** — 用户必须手动重发.

用户反馈 (2026-08-17):
> "且不能在think阶段直接中断, 加一个重试/重连机制, 最大尝试次数 5 次"

Pi SDK Agent class 本身**没有内置重试** (只有 `maxRetryDelayMs` 是 cap provider `Retry-After` 头, 不是 retry count). 必须 sidecar 自己实现.

## 备选

### 方案 A: 让用户手动重发 ❌
- ✅ 简单, 0 代码
- ❌ 跟"AI 助手"定位冲突 (AI 应该抗干扰, 不该把网络问题甩给用户)
- ❌ 实测: 用户看到 429 弹窗 + 错误后, 大概率放弃这次对话

### 方案 B: 1 次重试 (固定 3s 后) ❌
- ✅ 简单
- ❌ 网络抖动用 3s 修不好, 429 quota 5 分钟修不好
- ❌ 治标不治本, 修 1 次治不了"短时间不可用"

### 方案 C: 5 次指数退避 (1s/2s/4s/8s/16s) + UI 实时提示 ✅ (推荐)
- ✅ **总等待 ~31s 重试窗口**: 1+2+4+8+16 = 31s, 网络抖动用前 3 次就修好了, quota 用尽也撑得久
- ✅ **指数退避**: 短错 (1s) 抢修, 长错 (16s) 攒够时间让 provider 恢复
- ✅ **UI 实时提示**: `retry_start` 事件带 `attempt/maxAttempts/delayMs`, FE banner 显示"重试中 1/5..."+ 旋转图标
- ✅ **不区分错误类型**: 429 / 5xx / network 全部重试 (用户明确要求, 简化逻辑)
- ❌ 用户等 31s 后仍失败, 会失望 (但至少比直接断流好)
- ❌ Sidecar 资源占用 (每次 retry 占一次 LLM 调用)

### 方案 D: 智能分错误类型 (429 不重试, 5xx/network 重试) ❌
- ❌ 复杂度↑, 错误识别代码难维护 (不同 provider 错误格式不同)
- ❌ 用户反馈明确"最大 5 次", 不区分类型更符合预期

## 决策

**选方案 C: 5 次指数退避 (1s/2s/4s/8s/16s) + UI 提示**

```javascript
// sidecar/src/index.mjs runPrompt 函数加 retry 状态机
const MAX_RETRIES = 5;
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000];  // 5 次退避

// event handler 拦截
if (event.type === 'error' && currentAttempt < MAX_RETRIES) {
  lastError = sanitizeErrBody(...);
  shouldRetry = currentAttempt < MAX_RETRIES;
  return;  // 不 forward 给 FE, 等 retry loop 决定
}
if (event.type === 'agent_end' && shouldRetry) return;  // 拦截, 保持 streaming

// retry loop
while (shouldRetry && currentAttempt < MAX_RETRIES && !ac.signal.aborted) {
  currentAttempt++;
  // 1. pop 失败 assistant message
  // 2. emit retry_start { attempt, maxAttempts, delayMs, errorMessage }
  // 3. sleep delayMs (abort 兼容, ac.signal.addEventListener)
  // 4. agent.continue() 调 Pi SDK 公开 API (不重 add user message)
}

// 5 次都失败 / abort → emit 最终 error + finishUp
```

关键技术点:
- **agent.continue() 不重 add user message**: 走 Pi SDK 内部 `runContinuation()`, state 干净
- **拦截 `error` / `agent_end` 不 forward FE**: 保持 `streamingBySession=true` → 侧栏 shimmer 不间断
- **abort 兼容**: retry sleep 期间 `ac.signal.addEventListener` 立即 reject, agent.continue() 走新 runPrompt 旧 ac.abort()

IPC 协议加 2 事件:
- `retry_start { attempt, maxAttempts, delayMs, errorMessage, sessionId }`
- `retry_end { success, attempts, finalError?, aborted?, sessionId }`

## 后果

### 正面
- ✅ **用户抗干扰**: 429 / 5xx / 网络抖动 5 次重试, 大概率在窗口内恢复
- ✅ **总 31s 等待**: 1+2+4+8+16 = 31s, 短错快修 (前 2 次), 长错慢修 (后 3 次)
- ✅ **UI 透明**: FE banner 实时显示 attempt 进度 + 错误, 用户知道在等什么
- ✅ **不 forward 中间 error**: FE `streamingBySession` 保持, 侧栏流光 shimmer 持续
- ✅ **5 次都失败回退到原 error UX**: 不影响用户最终能看到错误

### 负面
- ❌ **31s 仍失败 → 用户失望**: 但比 0s 直接断流好 (至少有重试机会)
- ❌ **quota 类错误重试无意义**: 429 配额用完, 31s 内不会恢复, 浪费 4 次 LLM 调用
- ❌ **agent.continue() 失败模式未充分测**: 边界情况 (tool_call 中断 / 消息不一致) 可能漏

### 中性
- 🟡 **FE 端 retry banner**: 在 ChatMessage 加 `.pad-msg__retry` (浅黄底 + 旋转图标 + "1/5" 进度), 走 warning 配色
- 🟡 **跟 stream hang watchdog (30s) 并存**: watchdog 30s 兜底 stream hang; retry 31s 兜底 LLM error. 两个不同事件流不冲突
- 🟡 **跟 ADR-0003 兼容**: per-prompt sidecar spawn 意味着 retry 都在同一次 runPrompt 进程内, 不跨进程

## 何时 Revisit

- ❗ **quota 类错误频繁触发 (用户用 paid provider)** → 改成"只对 transient 重试" (5xx / network / 408, 不对 429)
- ❗ **31s 窗口太短, 长错没修好** → 扩展到 10 次 (退避到 ~17 分钟)
- ❗ **Pi SDK 0.85+ 加了原生 retry 机制** → 用 SDK 内置替代, ADR 标 Superseded
- ❗ **FE 反馈 retry banner 太抢戏** → 加折叠 / 缩到 sidebar 状态条
- ❗ **5 次都失败时增加"立即重试"按钮** (不重发请求, 单纯再走一遍 5 次 retry)
