# ADR-0014: Tool permission 3 模式 (ask / smart / allow)

- **状态**: Accepted
- **日期**: 2026-08-17
- **决策者**: 用户
- **Relates to**: [ADR-0012](0012-pi-sdk-integration.md), [ADR-0009](0009-sidecar-spawn-per-prompt.md)

## 背景

v0.4 集成 pi-coding-agent 后, sidecar 注册了 7 个 tool (read/write/edit/bash/ls/find/grep).
这些 tool 能读写用户 workspace 下任何文件 + 执行任意 bash 命令, **风险等级差异巨大**:
- **读类** (read/ls/find/grep): 只读, 不可逆, 跑飞了用户最多少看几行字 → **安全**
- **写类** (write/edit/bash): 改文件 + 跑命令, 跑飞了用户可能丢数据 / 装错依赖 / rm -rf → **危险**

实测场景: 用户说"看工作区", LLM 调 `ls` 是好事 (省得 LLM 瞎猜), 调 `bash rm -rf` 就出大事.

Pi SDK Agent class 暴露 `beforeToolCall` hook (v0.84+), 签名:
```typescript
beforeToolCall?: (ctx: BeforeToolCallContext, signal?: AbortSignal)
  => Promise<BeforeToolCallResult | undefined>
// undefined = 放行; { block: true, reason } = 阻止 (Pi SDK emit error tool result)
```

权限决策点必须**在 sidecar 这一层** (不依赖 FE, 离线跑也要工作).

## 备选

### 方案 A: 每个 tool 单独配置 (allowlist / denylist) ❌
- ✅ 精确控制
- ❌ 配置爆炸 (7 tool × 4 维度 = 28 配置)
- ❌ 用户理解成本高, 不直观

### 方案 B: 全局 on/off 开关 ❌
- ✅ 简单
- ❌ 二选一极端, 用户要不就是全部手动确认 (烦), 要不就是全部放行 (危险)

### 方案 C: 3 模式档位 (ask / smart / allow) ✅ (推荐)
- ✅ 中庸: ask 安全, smart 自动 + 安全, allow 放飞
- ✅ 跟 macOS 系统权限 / Cursor / Windsurf 等行业惯例一致
- ✅ smart 用 4 个明确白名单 (read/ls/find/grep) 区分读写, 用户易理解
- ❌ smart 写类仍需 ask, 用户偶尔被打断

### 方案 D: 让 LLM 自主判断 ❌
- ❌ "let LLM decide" 不可信 (LLM 没安全边界, 训练目标是 helpful not safe)

## 决策

**选方案 C: 3 模式档位**, 通过 sidecar 顶层变量 `currentPermissionMode` 控制:

| 模式 | 行为 | 适用场景 |
|---|---|---|
| **ask** (默认) | 每次 tool call 都问 FE, 等 permission_response | 高安全, 关键 workspace |
| **smart** | 读类 (read/ls/find/grep) 自动放行, 写类 (write/edit/bash) 问 | 日常使用, 平衡 |
| **allow** | 全部自动放行, 不问 | 全自动 / 测试 / 信任 workspace |

白名单 (写死, 不让用户改, 避免配置爆炸):
```javascript
const SMART_READ_ONLY_TOOLS = new Set(['read', 'ls', 'find', 'grep']);
```

实现位置: `sidecar/src/index.mjs` `beforeToolCall` hook + `pendingPermissionRequests` Map<toolCallId, {resolve}>:

```javascript
beforeToolCall: async (ctx, signal) => {
  const { name: toolName, id: toolCallId } = ctx.toolCall;
  const mode = currentPermissionMode;
  if (mode === 'allow') return undefined;
  if (mode === 'smart' && SMART_READ_ONLY_TOOLS.has(toolName)) return undefined;
  // ask / smart 写类: emit permission_request 给 FE, 等 response
  return new Promise((resolve) => {
    pendingPermissionRequests.set(toolCallId, { resolve });
    send({ type: 'permission_request', toolCallId, toolName, args: ctx.args, sessionId });
  });
}
```

FE 端 (`app/src/components/ChatMain/PermissionDialog.vue`): 弹窗让用户点"允许/拒绝", 调 `sendPermissionResponse(toolCallId, allow)` → sidecar 把结果 resolve 给 `beforeToolCall`.

持久化: `currentPermissionMode` 存 Tauri `config_store` (FE 重启后恢复).

**默认**: `ask` (最安全), 用户进 Settings → 权限设置 主动改 smart / allow.

## 后果

### 正面
- ✅ **平衡安全 + 体验**: smart 模式 80% 场景免打扰, 关键操作仍 confirm
- ✅ **FE 弹窗统一**: 不管 ask 还是 smart 写类, 都走同一套 permission dialog
- ✅ **abort 兼容**: tool pending 时 `signal.abort` 立即 resolve `{block: true, reason: 'Aborted'}`, 避免 FE 弹窗卡死
- ✅ **跟 Pi SDK 0.84+ 公开 API 对齐**, 不 wrapper 7 tool

### 负面
- ❌ **写类仍需 confirm**: smart 模式写文件 / 跑命令每次都问, 偶尔打断
- ❌ **配置 3 档而非 N 档**: 高级用户想"只对 edit 问, write 不问"做不到
- ❌ **白名单写死**: 如果用户想"ls 也问, 因为 ls 可能输出大文件"做不到

### 中性
- 🟡 **副作用**: 用户进 settings 才能改模式, **没改过的人永远 ask** (最安全)
- 🟡 **跟 ADR-0003 关联**: sidecar per-prompt spawn 模式意味着 `currentPermissionMode` 每次 prompt 重新读, 不会有跨 prompt 状态泄漏

## 何时 Revisit

- ❗ **用户频繁抱怨"为什么我每次写文件都要点确认"** → 考虑加"批量允许这个 session"按钮 (类似 Cursor 的"Allow for this session")
- ❗ **白名单漏了某个真正安全的 tool** (e.g. 用户希望 read 不问) → 改成用户可配置白名单
- ❗ **Pi SDK 升级到 0.85+ 改了 beforeToolCall 签名** → 重新适配
- ❗ **新加 tool 类型 (e.g. network call)** → 评估归到 read/write 哪一类, 决定走 ask 还是 smart 放行
- ❗ **出现"LLM 误调 tool 把用户数据改坏了"事件** → 默认改回 ask, 强制确认
