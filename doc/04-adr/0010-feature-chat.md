# ADR-0010: Chat 模块 (流式对话 / Markdown / 思考 / 工具)

- **状态**: Accepted
- **日期**: 2026-08-19
- **最后同步**: v0.5.0-D 第12轮 (D198 user 反馈 + 4 项功能补完)
- **Type**: Functional
- **Module**: Chat
- **决策者**: user

## 功能定义 (应该做什么)

- ✅ 用户发消息 → AI 流式回复 (token 逐字出现)
- ✅ Markdown 渲染 (标题 / 列表 / 代码块 / 表格 / 引用 / 链接 / 图片)
- ✅ 代码高亮
- ✅ 思考过程 (reasoning_content) 单独展示, 可折叠
- ✅ 工具调用 (tool_call) 结果展示, 可折叠
- ✅ 复制消息 / 复制代码块
- ✅ Step 累加 UI (1 turn = 1 step group, narrative 风格)
- ✅ Stop 按钮 (中断生成, 30s 兜底)
- ✅ Token 计数 (6 分类: 消息/工具/系统提示词/技能/记忆/其他, FE 端估算) — v0.5.0-D 第12轮
- ✅ 引用回复 (quote & reply, 整条消息引用) — v0.5.0-D 第12轮
- ✅ LaTeX 数学公式 ($...$ inline + $$...$$ block, KaTeX 渲染) — v0.5.0-D 第12轮 (spec 升级 ❌→✅)
- 🟡 重试单条 assistant 消息
- 🟡 编辑用户消息后重发 (fork)
- 🟡 消息分支树 (fork from message N)
- ❌ 多模态输入 (图片 / 音频)
- ❌ 实时协作

> **v0.5.0-D 第12轮升级说明** (D198):
> - Token 计数: 旧 4 分类 (Input/Cache Read/Cache Write/Output, Pi SDK usage 维度) → 新 6 分类 (按 token 来源, 跟图2 一致)
> - 引用回复: spec 🟡 → ✅ (v1 整条消息引用, 后续可选中部分文字)
> - LaTeX: spec ❌ → ✅ (KaTeX 集成, inline + block 都支持)
> - Step group: 结构改 (text 移到 step group 外面, 不管 fold 都直接显示)

## 已实现 (v0.5.0-D 第12轮)

| 功能 | 状态 | 实现位置 | 核验方法 |
|---|---|---|---|
| 流式回复 | ✅ | `app/src/stores/chat.ts` subscribe `chat:event` | 发消息, 看 token 逐字出现 |
| Markdown 渲染 | ✅ | `app/src/components/ChatMain/MarkdownContent.vue` | 发含表格 / 列表 / 代码块, 看渲染 |
| 代码高亮 | ✅ | `marked` v18 + `highlight.js` 后处理 | 发代码块, 看颜色 |
| 思考展示 (可折叠) | ✅ | `ChatMessage.vue` pad-step-thinking | 触发 thinking 模型, 头部 "思考 N 次" 折叠块 |
| 工具调用展示 (可折叠) | ✅ | `ChatMessage.vue` pad-step-group__tools | 触发 tool call, 看 inline pill 卡 |
| 复制消息 | ✅ | `ChatMessage.vue` 复制按钮 | 点复制, 验证内容 (跨 step 拼接) |
| 复制代码块 | ✅ | `MarkdownContent.vue` 复制按钮 | hover 代码块, 点复制 |
| **Step 累加 (narrative 风格)** | ✅ | `ChatMessage.vue` v0.5.0-D 第12轮重构 | 多 turn 任务, step 头部 "思考 N 次, 调用 M 个工具"; **text 移到 step group 外面**, 不管 fold 都直接显示 |
| Stop 按钮 (30s 兜底) | ✅ | `Composer.vue` stop + 30s timer | 流式中途点 Stop, 30s 内必须停 |
| **6 分类 Token breakdown** | ✅ | `app/src/lib/tokenEstimate.ts` + `ContextIndicator.vue` popover | 点 Composer 上下文窗口按钮, 看 6 分类 (消息/工具/系统提示词/技能/记忆/其他) 百分比 + 估算 token 数; 数字下方有 "估算值 · 实际 LLM token 数可能差 10-20%" 说明 |
| **引用回复 (quote & reply)** | ✅ | `chat.ts` quoteBySession + `ChatMessage.vue` "引用" button + `Composer.vue` quote preview | 点 assistant message action bar 的 "引用" icon, composer 上方出现 blockquote 预览; send 时 quote 作为 markdown blockquote 前缀拼到 user message, 发送完自动清空 |
| **引用回复 v2 (选区引用)** | ✅ | `ChatMessage.vue` assistantRootRef + mouseup + floating button | 鼠标滑动选中 assistant message 文字, 浮动 "引用" button 出现在 selection 上方; 点击 → 只引用选中部分 (不是整条 message) |
| **LaTeX 数学公式** | ✅ | `MarkdownContent.vue` + `katex` 0.18 包 | 发 `E=mc^2` 看 inline 公式; 发 `$$\int_0^1 x dx$$` 看 block 公式居中; parse error 走 fallback mono 红字 |
| 跑马灯 marching ants | ✅ | `.is-streaming::after` 2px gradient | 看流式时底部 gradient |

## 核验方法 (端到端)

1. **流式 + Markdown**: 发含表格 / 列表 / 代码块的消息, 看流式 + 渲染
2. **思考 + tool call**: 触发 thinking 模型 + 调 tool, 看折叠块展开
3. **Stop**: 流式中途点 Stop, 30s 内必须停 (否则兜底强制 set streaming=false)
4. **复制**: 单条消息 + 代码块各点一次复制, 验证内容
5. **Step 累加 + narrative 风格**: 跑多 turn 任务, step 头部 "思考 N 次" 折叠; **text 始终可见** (不随 step 折叠)
6. **跑马灯**: 流式时看 session 底部 2px 渐变, 不依赖 is-active
7. **6 分类 token breakdown**: 点 Composer 上下文窗口按钮, 6 分类百分比总和 = 100%
8. **引用回复**: 点 assistant message "引用" icon, composer 上方出现 blockquote 预览; 写新消息 + send, 新消息正文含 "> " blockquote 引用
9. **LaTeX inline**: 发 `求导公式: $f'(x) = 2x$`, 看公式正常渲染
10. **LaTeX block**: 发 `高斯积分: $$\int_{-\infty}^{\infty} e^{-x^2} dx = \sqrt{\pi}$$`, 看公式居中 + 上下 margin

## 已知问题 / 技术债

- 🟡 **Stop abort lost**: Pi SDK `abort` 在某些 OpenAI-compatible provider 上偶发 `agent_end` 没 emit, 跑马灯卡住 (30s 强制 set streaming=false 兜底, **不是根因修**)
- 🟡 **重试单条消息**: 协议已就绪 (`runRpcMode` 支持), UI 没收
- 🟡 **消息分支**: 协议已就绪 (`fork` / `clone` RpcCommand), UI 没收
- 🟡 **Token 计数 6 分类是 FE 端估算**, 跟 LLM 实际 usage.input 可能差 10-20% (启发式: CJK 1 char ≈ 1 token, 其他 4 chars ≈ 1 token)
- 🟡 **LaTeX parse error 走 fallback mono 红字**, 不渲染错误位置 (后续可加 KaTeX 错误详情 tooltip)

## v0.5.0-D 第12轮 + D199 Bug 修复

> D199 user 反馈: "我使用了引用功能, 但是发送消息后, agent 好像无法正确识别"
> 根因: `sendPrompt(sessionId, text, ...)` 传的是原始 user 输入 `text`, 不是含 quote 块的 `fullUserText`. store 存的是含 quote 版本, sidecar 收到的是不含 quote 版本, 跟 AI 看到的不一致 → AI 报 "没引用任何外部来源".
> 修法: `sendPrompt(sessionId, fullUserText, ...)`, 跟 store 保持一致.
>
> v2 选区引用: 加了 mouseup 监听, 鼠标滑动选中 assistant message 文字, 浮动 "引用" button 出现在 selection 上方; 点击 → 只引用选中部分, 不是整条 message.

## v0.5.0-D 第13轮 (D200 修复)

> D200 user 反馈 3 个引用相关问题:
> 1. 引用并发送消息后 AI 没返回 → sensenova-6.7-flash-lite 小模型对 markdown blockquote prompt 偶发返回空 message, 不 emit agent_end, stream 卡住
> 2. 浮动 "引用" button 位置偏移到 message 顶部 → CSS 没 `position: relative`, button 跑到上层 positioned 容器
> 3. 有时候选区无法触发 "引用" button → selection 可能在 message 之外开始 (e.g. 列表项内深层 DOM), per-message mouseup 不冒泡到 message 根
>
> 修法:
> - 图1 (空 response): message_end handler 加 warning log, 提示 user 改 model (deepseek-v4-flash / claude-haiku). 不动 streaming 状态 (避免误关 stream 打破后续 turn)
> - 图2 (位置偏移): `.pad-msg--assistant` 加 `position: relative`, button 定位 anchor 修到 message 自身
> - 图3 (selection 漏): 改用 document-level mouseup + selectionchange 双兜底 (debounce 50ms), 抽出 `checkSelectionInMessage` 公共函数, 3 个入口都调

## 后续规划

### P0 (v0.6)
- Stop abort lost 根因排查 (OpenAI-compatible provider 兼容性)
- 重试单条消息 (hover assistant message → "重试" 按钮)

### P1 (v0.6 - v0.7)
- 编辑消息后重发 (fork)
- 消息分支树 (fork from message N)
- Token breakdown 真实数据: 走 sidecar 暴露 system prompt 实际 token 数, 替换 FE 估算

### P2 (v0.7+)
- 多模态输入 (图片 attachment)
- 实时协作
- 消息分支 UI 树状展示
