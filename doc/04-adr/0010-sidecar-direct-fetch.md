# ADR-0010: Sidecar 直接 fetch 不引 SDK

- **状态**: Accepted → **Superseded by ADR-0012**
- **日期**: 2026-08-12（拍板）/ 2026-08-16（决定推翻）
- **决策者**: 自己

## 背景

earendil-works/pi 有 Pi Agent SDK。sidecar 要调 LLM API — 引 SDK 还是直接 fetch？v0.3 阶段决定**直接 fetch**（`sidecar/src/openai-compatible.mjs` 手写 SSE 解析）。

## 决策（v0.3 阶段）

**直接 fetch**（`POST {baseUrl}/chat/completions`）。

理由（v0.3 阶段）：
1. Pi SDK getBuiltinModel 只支持内置 provider 名，**当时以为**不支持自定义 baseUrl
2. 直接 fetch 简单，单 turn chat completion 代码 < 200 行
3. 依赖最少（Node 20+ fetch builtin）

## v0.3 后果

- 正面: 实现简单，可读可改；自定义 provider 支持（任意 OpenAI-compatible）；包小（sidecar < 50KB）
- 负面: **tool call 不能做**（v0.4 必做 → 决定推翻）；thinking mode 字段名要手动兼容；Pi Agent 协议演进跟不上
- 中性: 0 依赖

## v0.3 → v0.4 推翻决定

2026-08-16 audit `D:\AIWorkSpace\WorkBoddyWorkSpace\Agentplantform\Spark\spartagent\node_modules\@earendil-works\pi-ai\dist\models.d.ts` 后，发现 **ADR-0010 当时的"SDK getBuiltinModel 限制"是错的**。

Pi SDK v0.80.3+ 实际 API：

```ts
// pi-ai 核心导出
export function createProvider<TApi>(input: CreateProviderOptions<TApi>): Provider<TApi>;
export function createModels(options?: CreateModelsOptions): MutableModels;

export interface CreateProviderOptions<TApi> {
  id: string;                          // 任意字符串
  name?: string;
  baseUrl?: string;                    // 任意 endpoint (DeepSeek / Moonshot / Groq / 自定义)
  headers?: ProviderHeaders;
  auth: ProviderAuth;                  // apiKey / oauth / 自定义
  models: readonly Model<TApi>[];      // 任意 model 列表
  api: ProviderStreams | Partial<Record<TApi, ProviderStreams>>;
}

export interface MutableModels extends Models {
  setProvider(provider: Provider): void;   // 运行时动态加
  deleteProvider(id: string): void;
}
```

**Pi SDK 完全支持任意 baseUrl + 运行时动态 provider**。我之前的"不支持自定义"判断是基于旧版本印象或错误记忆。

→ 推翻本 ADR 决策，**集成 pi-ai + pi-agent-core**，见 [ADR-0012](0012-pi-sdk-integration.md)

## 修订日志

- **2026-08-16**: 推翻本 ADR，引入 ADR-0012
- **2026-08-12**: Accepted（v0.3 阶段直接 fetch）
