# ADR-0010: Sidecar 直接 fetch 不引 Pi SDK

- **状态**: Accepted → **Superseded by ADR-XXXX（v0.4 计划推翻）**
- **日期**: 2026-08-12（拍板） / 2026-08-16（计划推翻）
- **决策者**: 自己

## 背景

earendil-works/pi 有 Pi Agent SDK。sidecar 要调 LLM API — 引 SDK 还是直接 fetch？

## 备选

### 引用 Pi SDK
- ✅ Pi Agent 协议支持（流式 / tool call / thinking）
- ✅ 跟 earendil-works/pi 主线同步
- ❌ SDK getBuiltinModel 只支持内置 provider 名（anthropic/openai/...），不支持自定义 baseUrl
- ❌ createProvider 需要 Model<TApi> 对象 — 跟"动态配置 provider"模式冲突
- ❌ SDK 体积大（依赖 Pi Agent 整套）

### 引用 OpenAI SDK
- ✅ 生态成熟
- ❌ 只能调 OpenAI-compatible（Anthropic 不兼容）
- ❌ 跟 BYOK 多 provider 目标冲突

### 直接 fetch（`POST {baseUrl}/chat/completions`）✅
- ✅ 任意 OpenAI-compatible provider
- ✅ 依赖最少（只用 `fetch` builtin）
- ✅ 单 turn chat 简单可控
- ❌ 没用 Pi SDK 的协议支持（流式 SSE 要自己 parse）
- ❌ tool call 不支持（v0.4 必做）
- ❌ thinking mode 兼容性要手动处理

## 决策

**直接 fetch**（`sidecar/src/openai-compatible.mjs`）。

理由：
1. Pi SDK getBuiltinModel 不支持自定义 baseUrl，跟"7 内置 + 任意自定义"需求冲突
2. 直接 fetch 简单，单 turn chat completion 代码 < 200 行
3. 依赖最少（Node 20+ fetch builtin）

**已知 trade-off**：tool call 不支持 — 这是 v0.4 必做。

## 后果（v0.3 阶段）

- 正面:
  - 实现简单，可读可改
  - 自定义 provider 支持（任意 OpenAI-compatible）
  - 包小（sidecar < 50KB）
- 负面:
  - tool call 不能做（v0.4 必做 → 推翻本 ADR）
  - thinking mode 字段名要手动兼容（reasoning_content / reasoning / thinking 几个名字）
  - Pi Agent 协议演进跟不上（pi SDK 升级我们看不到）

## 何时 Revisit / 已确定推翻

- **v0.4 必做**：
  - 集成 `pi-agent` SDK 替代直接 fetch
  - 利用 SDK 的 tool call / streaming / thinking 协议
  - 解决 Pi SDK getBuiltinModel 不支持自定义的问题（fork + patch 或自己 wrap）

→ 见 `02-roadmap.md` v0.4 必做项第 1 条

## 修订日志

- **2026-08-16**: 标记 v0.4 计划推翻，新增"何时 Revisit"段
- **2026-08-12**: Accepted
