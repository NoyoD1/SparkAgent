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

## 后续 Review (v0.4.2 step 1, 2026-08-17)

**实现路径变更** (决策不变): v0.4.2 step 1 调研发现 `AgentSession` (pi-coding-agent 0.84+) **已经内置 LLM retry 状态机**, 没必要 sidecar 自写.

**Pi SDK 内置 retry** (agent-session.ts:2700-2726):
```typescript
const delayMs = settings.baseDelayMs * 2 ** (this._retryAttempt - 1);
this._emit({
  type: "auto_retry_start",
  attempt: this._retryAttempt,
  maxAttempts: ...,
  delayMs,
  errorMessage: ...,
});
// ... 走 prompt 再次
this._emit({
  type: "auto_retry_end",
  success: true | false,
  attempt: ...,
  finalError?: ...,
});
```

**关键差异**:
1. **触发条件**: AgentSession 在 `agent.state.messages[last].stopReason === "error"` 时自动 retry (line 670-675). 跟 sidecar 自己拦截 `error` 事件等价.
2. **退避算法**: `baseDelayMs * 2^(attempt-1)`, **跟 ADR-0015 的 [1s, 2s, 4s, 8s, 16s] 完全一致** (baseDelayMs=1000 + maxRetries=5)
3. **不重 add user message**: AgentSession 内部走 prompt continuation, 跟 sidecar `agent.continue()` 等价
4. **providerRetrySettings.maxRetries = 5**: 通过 SettingsManager 注入, sidecar 不需要自己数

**实施变更**:
- 旧 (v0.4.2 partial commit `88d05ea`): sidecar 自写 200 行 retry 状态机 (line 547-688), 拦截 `error` / `agent_end` 事件, pop 失败 assistant, 调 `agent.continue()`
- 新 (v0.4.2 step 1): sidecar 只订阅 `AgentSession` 的 `auto_retry_start` / `auto_retry_end` 事件, **map 到 IPC 协议转发给 FE**, 不再写 retry 状态机

**IPC 事件名重命名** (FE 端 chat store + tauri.ts + ChatMessage.vue 同步改):
- 旧: `retry_start { attempt, maxAttempts, delayMs, errorMessage, sessionId }` / `retry_end { success, attempts, finalError?, sessionId }`
- 新: `auto_retry_start { attempt, maxAttempts, delayMs, errorMessage, sessionId }` / `auto_retry_end { success, attempt, finalError?, sessionId }`
- 跟 Pi SDK 对齐, 跟 `compaction_*` 风格统一

**配置注入** (SettingsManager):
```javascript
const customSettings = new SettingsManager(cwd, agentDir);
customSettings.setProviderRetrySettings({ maxRetries: 5, baseDelayMs: 1000, maxRetryDelayMs: 16000 });
const { session } = await createAgentSession({
  cwd, model, sessionManager, resourceLoader,
  settingsManager: customSettings,
});
```

**Abort 兼容**: AgentSession 内置 retry 也走 `session.abort()`, 走 `_retryAbortController.abort()`. sidecar 不需要自己管 ac.signal.

**Watchdog 互动**: ADR-0016 stream hang watchdog 跟 AgentSession 内置 retry 仍然**两层互补**:
- watchdog 30s 兜底 stream hang (Provider 不 emit done)
- retry 5x 兜底 LLM 错误返回 (429 / 5xx / network)
- hang → abort → 触发 retry → 又 hang → 又 retry → 5 次用完用户等 30s*5 ≈ 150s
- 跟 ADR-0016 写的一致, 不变

**没变更的决策**:
- 5x retry 1s/2s/4s/8s/16s 指数退避
- 不区分错误类型 (429 / 5xx / network 全 retry)
- UI 实时提示 (retry banner 旋转 icon + "重试中 1/5")
- 5 次都失败回退到原 error UX

**省下的 sidecar 代码**: 删 ~140 行 retry 状态机 (commit `88d05ea` 引入的). 替换为 ~30 行 event forwarding.

**REVISIT 信号 (来自原始 ADR §何时 Revisit)**:
- 已有 1 个信号触发: "Pi SDK 0.85+ 加了原生 retry 机制 → 用 SDK 内置替代, ADR 标 Superseded" — **本条就是**, v0.84.2 已经内置, v0.85 升级时再核对
- 其他信号 (quota 不重试 / 31s 窗口太短 / FE retry banner 太抢戏 / 5 次都失败加按钮) — 仍 v0.5+ Revisit 候选

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
