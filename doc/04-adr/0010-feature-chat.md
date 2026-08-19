# ADR-0010: Chat 模块 (流式对话 / Markdown / 思考 / 工具)

- **状态**: Accepted (Phase 1 阶段完成)
- **日期**: 2026-08-19
- **最后同步**: v0.5.0-D 第27轮 (D210.4 压缩 UX 统一 + D210/D210.1/D210.2 auto-retry 完整闭环)
- **Type**: Functional
- **Module**: Chat
- **决策者**: user

## Phase 1 收尾总结 (2026-08-19)

**核心交付** (v0.5.0-D 第10-27 轮, D194 → D210.4):

| 类别 | 能力 | 关键 commit |
|---|---|---|
| 流式对话 | token 逐字出现 + Stop 按钮 + 30s 兜底 | 多轮迭代 |
| Step group narrative | 1 turn = 1 step group, 头部 "思考 N 次, 调用 M 个工具" | `27966b2` D197 |
| 思考 / 工具 | 折叠展开, 步骤内默认展开 | `27966b2` D197 |
| 引用回复 | markdown blockquote + 折叠预览 + 选区引用 | `8b3f7b4` `b5b985b` D206/D207 |
| LaTeX | inline + block (KaTeX) | `c05cfc5` D198 |
| **Token 4-cat REAL** | Pi SDK 实测 (input/output/cacheRead/cacheWrite), 累加跨 turn | `3a36ff2` `9584da2` D208/D209 |
| **Stream hang detection** | 30s 无事件 → 强制 force stop + 横线提示 | `232f01f` D204 + `c82030b` D210.1 |
| **Auto-retry** | stream hang + 空 message → 主动重发 last user msg 1 次 | `8da8a01` D210 + `16c7e4d` D210.2 |
| **Compaction divider** | in_progress / success / failure 3 态, 全部走分隔线 (无 toast) | `1a227ad` `e113e5d` D210.3/D210.4 |
| 复制 / 代码高亮 | 单条消息 / 代码块各一 | D198 |

**核心理念 (跨 10+ 轮验证的设计原则)**:

1. **UX 统一性**: 状态反馈全部走 chat 区域内的视觉元素 (横线 / placeholder / divider), 不弹 popup toast
   - 验证: D204 REVERT D200/D202/D203 emptyResponse popup → stream hang 横线; D210.4 REVERT compaction toast → divider
2. **行为预测性**: 失败时 user 永远有 visible 的 "下一步" (auto-retry, 重新发送, 手动重发)
   - 验证: D210 主动重发 1 次 + max=1 防 spam
3. **数据真实性优先**: 4-cat REAL (Pi SDK 实测) > 6-cat FE 估算 (启发式)
   - 验证: D209 拆掉"实测/估算"两区块, 只保留 4-cat REAL 累加
4. **跨文件 reference 一致**: 改 A 记得看 B 是不是依赖
   - 验证: D203 CSS scope 跨文件 keyframe reference bug; D210.1 setTimeout 永不复位 bug

---

## 功能定义 (Phase 1 已实现 ✅)

- ✅ 用户发消息 → AI 流式回复 (token 逐字出现)
- ✅ Markdown 渲染 (标题 / 列表 / 代码块 / 表格 / 引用 / 链接 / 图片)
- ✅ 代码高亮
- ✅ 思考过程 (reasoning_content) 单独展示, 可折叠
- ✅ 工具调用 (tool_call) 结果展示, 可折叠
- ✅ 复制消息 / 复制代码块
- ✅ Step 累加 UI (1 turn = 1 step group, narrative 风格)
- ✅ Stop 按钮 (中断生成, 30s 兜底)
- ✅ **Token 4 分类 REAL** (input / output / cacheRead / cacheWrite, Pi SDK lastUsage 实测, 跨 turn 累加) — D208/D209
- ✅ 引用回复 (quote & reply, 整条消息引用 + 选区部分引用) — D198/D199
- ✅ LaTeX 数学公式 ($...$ inline + $$...$$ block, KaTeX 渲染) — D198
- ✅ **引用 blockquote 可折叠** (短引用自动展开, 长引用默认 collapsed + 点击切换) — D207
- ✅ **Stream hang 30s 兜底** (无新事件 → 强制 force stop + chat 区域横线错误提示) — D204
- ✅ **FE 端 auto-retry** (stream hang + 空 message → 主动 resend 1 次, max 1) — D210/D210.1/D210.2
- ✅ **Compaction divider** (in_progress / success / failure 3 态, 全部走分隔线, 无 toast) — D210.3/D210.4
- ✅ **上下文累加** (cumulative usage 跨 turn 求和, compaction 成功时清零重计) — D209

## 功能定义 (Phase 2 待扩展 🟡 / ❌)

- 🟡 编辑用户消息后重发 (fork)
- 🟡 消息分支树 (fork from message N)
- ❌ 多模态输入 (图片 / 音频)
- ❌ 实时协作
- ❌ 消息分支 UI 树状展示
- 🟡 重试单条 assistant 消息 (D210 已实现 1 次, 单条精确重试用 hover "重试" 按钮)

---

## 已实现 (Phase 1 v0.5.0-D)

| 功能 | 状态 | 实现位置 | 核验方法 |
|---|---|---|---|
| 流式回复 | ✅ | `app/src/stores/chat.ts` subscribe `chat:event` | 发消息, 看 token 逐字出现 |
| Markdown 渲染 | ✅ | `app/src/components/ChatMain/MarkdownContent.vue` | 发含表格 / 列表 / 代码块, 看渲染 |
| 代码高亮 | ✅ | `marked` v18 + `highlight.js` 后处理 | 发代码块, 看颜色 |
| 思考展示 (可折叠) | ✅ | `ChatMessage.vue` pad-step-thinking | 触发 thinking 模型, 头部 "思考 N 次" 折叠块 |
| 工具调用展示 (可折叠) | ✅ | `ChatMessage.vue` pad-step-group__tools | 触发 tool call, 看 inline pill 卡 |
| 复制消息 | ✅ | `ChatMessage.vue` 复制按钮 | 点复制, 验证内容 (跨 step 拼接) |
| 复制代码块 | ✅ | `MarkdownContent.vue` 复制按钮 | hover 代码块, 点复制 |
| **Step 累加 (narrative 风格)** | ✅ | `ChatMessage.vue` v0.5.0-D 第12轮重构 | 多 turn 任务, step 头部 "思考 N 次, 调用 M 个工具"; text 移到 step group 外面, 不管 fold 都直接显示 |
| Stop 按钮 (30s 兜底) | ✅ | `Composer.vue` stop + 30s timer | 流式中途点 Stop, 30s 内必须停 |
| **Token 4-cat REAL breakdown** | ✅ | `ContextIndicator.vue` popover + `cumulativeUsageBySession` (累加) | 点 Composer 上下文窗口按钮, 看 4 分类 (input/output/cacheRead/cacheWrite) + 合计行; 数据源 Pi SDK lastUsage 实测, 跨 turn 累加; **D209 拆掉 6 分类 FE 估算 (启发式, 跟 LLM 实际差 10-20%)** |
| **引用回复 (整条 + 选区)** | ✅ | `chat.ts` quoteBySession + `ChatMessage.vue` "引用" button + `Composer.vue` quote preview + 选区 mouseup 浮动 button | 点 assistant action bar "引用" icon, composer 出现 blockquote 预览; 鼠标滑动选中 assistant 文字, 浮动 button 在 selection 上方, 点击只引用选区 |
| **引用 blockquote 可折叠** | ✅ | `ChatMessage.vue` isQuoteLong + isQuoteCollapsed + ChevronRight/Down 旋转 | 长引用 (>= 80 chars 或多行) 默认 collapsed, 显示首行 + chevron; 短引用自动展开; 点击切换 |
| **LaTeX 数学公式** | ✅ | `MarkdownContent.vue` + `katex` 0.18 包 | 发 `E=mc^2` 看 inline; 发 `$$\int_0^1 x dx$$` 看 block 居中; parse error 走 fallback mono 红字 |
| 跑马灯 marching ants | ✅ | `.is-streaming::after` 2px gradient | 看流式时底部 gradient |
| **Stream hang detection (30s 兜底)** | ✅ | `chat.ts` startStreamHangWatchdog + cleanupListenerForSession + listenerOffBySession | 流式挂死 30s → chat 区域出现 "── ⚠ 30s 无新事件 · 模型 / sidecar 已停止响应 ─── ×" 横线; force stop streaming + retry banner; 提示 user 重发或换 model |
| **FE 端 auto-retry (max 1)** | ✅ | `chat.ts` tryAutoRetry + autoRetryCountBySession + handleCompactionStart/End | stream hang 30s 后 + 最新 assistant message 是空 → 2s 延迟 resend last user msg 1 次; UI 显示 "LLM 调用失败, 正在重试 1/1 (LLM 异常, FE 主动重发中...)"; max 1 防 spam; user 新发消息清零 count |
| **Compaction divider (3 态)** | ✅ | `chat.ts` compact() push in_progress + handleCompactionEnd 原地更新 + `ChatMessage.vue` 按 state 渲染 icon | 点 "压缩" → chat 立即出现 "─── 🔄 正在压缩… ───" (spinner 旋转); 成功 → 原地更新 "── ✓ 上下文已压缩 ───"; 失败 (e.g. 1% context 报 Nothing to compact) → 原地更新 "── ⚠ 压缩失败: <errorMessage> ───" (橙色); 不再有任何 toast |
| **上下文累加 (跨 turn)** | ✅ | `chat.ts` cumulativeUsageBySession (D209) | 发消息 1 → context 涨; 发消息 2 → 继续涨 (累加); 主动压缩 → 清零重计; 4 分类 REAL 走累加源 |
| 0% 上下文 bug 修 | ✅ | `chat.ts` getContextWindow: `cw && cw > 0 ? cw : DEFAULT` | model 配 contextWindow=0 时回退 200K, 不再永远 0% |

---

## 核验方法 (端到端, Phase 1 完整版)

1. **流式 + Markdown**: 发含表格 / 列表 / 代码块的消息, 看流式 + 渲染
2. **思考 + tool call**: 触发 thinking 模型 + 调 tool, 看折叠块展开
3. **Stop**: 流式中途点 Stop, 30s 内必须停 (否则兜底强制 set streaming=false)
4. **复制**: 单条消息 + 代码块各点一次复制, 验证内容
5. **Step 累加 + narrative 风格**: 跑多 turn 任务, step 头部 "思考 N 次" 折叠; text 始终可见
6. **跑马灯**: 流式时看 session 底部 2px 渐变
7. **4-cat Token breakdown**: 点 Composer 上下文窗口按钮, 4 分类百分比总和 = 100%; 数字是 Pi SDK 实测, 累加跨 turn; 合计行 = 4 分类总和 + context 部分 (input+cacheRead)
8. **引用回复**: 点 assistant "引用" icon, composer 出现 blockquote 预览; 写新消息 + send, 正文含 "> " blockquote 引用; 长引用默认折叠, 短引用自动展开
9. **LaTeX inline / block**: 同 D198 验证方法
10. **Stream hang 30s 兜底** (D204+D210.1): 触发 LLM 异常 (e.g. 429 tpm exhausted / 卡 willRetry), 30s 后 → chat 区域出现横线 + retry banner 清除
11. **FE auto-retry** (D210+D210.2): 上一步 + 最新 assistant message 是空 → 2s 后 resend 1 次; max 1 防 spam; user 新发消息清零
12. **Compaction 3 态 divider** (D210.3+D210.4): 任意 context % 下点 "压缩" → 立即出现 spinner 横线; 成功/failure 原地更新; 不再有任何 toast
13. **上下文累加** (D209): 发消息 1 → context 涨 X; 发消息 2 → 涨 X+Y; 主动压缩 → 清零; 4-cat REAL 显示累加数字

---

## 已知问题 / 技术债

- 🟡 **Stop abort lost**: Pi SDK `abort` 在某些 OpenAI-compatible provider 上偶发 `agent_end` 没 emit, 跑马灯卡住 (30s 强制 set streaming=false 兜底; D209 force stop + D210 auto-retry 已经比 D203 latestAssistantEmpty 强很多, 但仍是兜底而非根因修)
- 🟡 **Auto-retry 上限 1**: 第一次重试还失败 → 让 user 决定 (不无限循环); user 反馈"再来一段"后能再享受 auto-retry 保护
- 🟡 **Compaction toast 4 → 0**: D210.4 已经全部走分隔线; 但 Pi SDK 内部自动 compaction (threshold / overflow) 找不到 in_progress marker 时, 兜底直接 push success / failure divider (没经过 compact() 推过 in_progress, 行为跟之前一致)
- 🟡 **引用回退**: 引用内容含 `` 块时, D203 之前在发送前剥离, 但 D205 简化后剥离逻辑丢了; 现在 D206/D207 保留 markdown blockquote + 前端 blockquote 视觉化, model 自己处理
- 🟡 **Pi SDK 429 tpm exhausted**: rate limit 错误, D210 auto-retry 1 次后还失败 → user 手动重发 (没有更多 auto-retry)
- 🟡 **LaTeX parse error 走 fallback mono 红字**, 不渲染错误位置 (后续可加 KaTeX 错误详情 tooltip)

---

## 跨轮迭代历史 (D194 → D210.4 完整时间线)

### v0.5.0-D 第10轮 (D194 REVERT, `c34d30e`)
> D194 user 反馈 9 轮 echo filter 迭代原地打转 (D194 起每轮加规则漏 case), text-based echo filter 不可靠 (model 复读有空格/标点/重复/无标点变体). 改回 v0.5.0-PR3 简单 append (在 message_update 块直接 `assistant.content += ame.delta + step.stepText += ame.delta`). 真正 fix 在 sidecar system prompt + model 选择层, 不在 chat store 文本层. 同步删 splitMessageContentIntoStep + stripLeadingUserEcho 整套函数.

### v0.5.0-D 第11轮 (D197, `27966b2`) - Narrative UI
> D197 加 narrative 风格 step group: 1 turn = 1 step, 头部 "思考 N 次, 调用 M 个工具" 折叠块; text 始终可见 (不随 step 折叠). 改 message_update 拆 step 累加.

### v0.5.0-D 第12轮 (D198, `c05cfc5`) - 4 chat 核心功能
> D198 一次发 4 个功能:
> 1. **Step group refactor**: text 移到 step group 外面, 不管 fold 都直接显示
> 2. **6-cat token breakdown**: D198 spec 加 6 分类 (消息/工具/系统提示词/技能/记忆/其他, FE 启发式估算, CJK 1 char ≈ 1 token)
> 3. **引用回复 (整条 message)**: 点 assistant action bar "引用" icon, composer 出现 blockquote 预览; send 时 quote 作为 markdown blockquote 前缀拼到 user message
> 4. **LaTeX**: 集成 katex 0.18 包, inline `$...$` + block `$$...$$` 都支持, parse error 走 fallback mono 红字

### v0.5.0-D 第13轮 (D199, `6a6978f`) - 引用修复 + 选区引用
> D199 user 反馈 "我使用了引用功能, 但是发送消息后, agent 好像无法正确识别". 根因: `sendPrompt(sessionId, text, ...)` 传的是原始 user 输入 `text`, 不是含 quote 块的 `fullUserText`. store 存的是含 quote 版本, sidecar 收到的是不含 quote 版本, 跟 AI 看到的不一致 → AI 报 "没引用任何外部来源". 修法: `sendPrompt(sessionId, fullUserText, ...)`, 跟 store 保持一致.
> V2 选区引用: 加了 mouseup 监听, 鼠标滑动选中 assistant message 文字, 浮动 "引用" button 出现在 selection 上方; 点击 → 只引用选中部分, 不是整条 message.

### v0.5.0-D 第14轮 (D200, `b379f76`) - 引用 UX 3 bug
> D200 user 反馈 3 个问题:
> 1. 引用并发送消息后 AI 没返回 → sensenova-6.7-flash-lite 小模型对 markdown blockquote prompt 偶发返回空 message, 不 emit agent_end, stream 卡住
> 2. 浮动 "引用" button 位置偏移到 message 顶部 → CSS 没 `position: relative`, button 跑到上层 positioned 容器
> 3. 有时候选区无法触发 "引用" button → selection 可能在 message 之外开始 (e.g. 列表项内深层 DOM), per-message mouseup 不冒泡到 message 根
>
> 修法:
> - 图1 (空 response): message_end handler 加 warning log, 提示 user 改 model. 不动 streaming 状态
> - 图2 (位置偏移): `.pad-msg--assistant` 加 `position: relative`
> - 图3 (selection 漏): 改用 document-level mouseup + selectionchange 双兜底 (debounce 50ms), 抽出 `checkSelectionInMessage` 公共函数

### v0.5.0-D 第15轮 (D201, `841559a`) - streaming placeholder + 引用标签
> D201 user 反馈 2 个问题:
> 1. streaming 期间左侧回复区没 loading 反馈 → 之前 (D200) step group 没 thinking/tools 不渲染, text body 没 stepText 也不渲染, empty state 因 isStreaming=true 不渲染 → user 看到"空白"
> 2. 引用还是被 sensenova 小模型误解读
>
> 修法:
> - 图1 (loading 反馈): `ChatMessage.vue` 加 streaming placeholder (`v-if="isStreaming && !hasContent && !hasThinkingOrTools && !errorMessage"`) → Loader2 + statusText (跟 Composer 状态文字一致)
> - 图2 (引用更明确): quote 格式升级到 `[引用上文 (messageId=msg-XXX)]\n> text\n\n[我的问题]\n<user text>`, 加 messageId 锚点让 model 知道引用的是哪条历史消息

### v0.5.0-D 第16轮 (D202, `6dce781`) - spin 动画 + emptyResponse UI
> D202 user 反馈 3 个 UX 问题:
> 1. 回复 loading 没动画效果, 只看到环形显示/隐藏 → 之前用 `pad-msg-cursor-blink` (opacity 0/1) 给 Loader2, 圆环在 show/hide 反复, 看起来不转
> 2. 模型返回空时 (D200 探测) 没 UI 提示 → 只 console.warn
> 3. streaming 期间底部没持续 loading 指示
>
> 修法:
> - 图1 (loading 动画): `.pad-msg__streaming-spinner` 的 animation 改用 `pad-step-spin` (rotation 0-360deg)
> - 图2 (空响应 UI): `ChatMessage.emptyResponse?: boolean` flag, placeholder 切到 `.is-warning` variant (AlertTriangle + "模型返回空 · 建议换 model 或点 Stop")
> - 图3 (底部 status bar): `ChatMain.vue` 在 Composer 上方加 thin status bar, isStreaming=true 时显示 (Loader2 + 文字轮换)

### v0.5.0-D 第17轮 (D203, `b545617`) - CSS scope 根因 + retryLastPrompt
> D203 user 反馈 3 个问题 (D202 修复没生效):
> 1. **D202 修复没生效** — 底部 status bar 的 spinner 仍然不转圈
> 2. **卡住没 error 提示** — 仍只在 message placeholder 里, 底部 status bar 始终 "生成中..."
> 3. **sensenova 仍然误解引用** — 即便 D201 加了 `[引用上文]` / `[我的问题]`, 引用内容含 `` 块 (AI thinking) 时, 小模型把 `` 当作 "我自己的思考"
>
> 根因:
> - **图1 spinner 不转**: Vue scoped CSS 给 `@keyframes pad-step-spin` 自动加 scope suffix, 但 `ChatMain.vue` 的 `.pad-chatmain__streaming-spinner` 用 `animation: pad-step-spin` (没 suffix) → 跨文件引用 keyframe 失败
> - **图2 status bar 没反映 emptyResponse**: D202 的 emptyResponse UI 只挂在 `ChatMessage.vue` 的 placeholder
> - **图3 quote 误解**: 引用内容包含 `` 块 (AI 可见的 thinking), 小模型误读
>
> 修法:
> - **图1 spinner**: 把 `@keyframes pad-step-spin` (和 `pad-msg-cursor-blink`) 提到全局 `app/src/assets/styles/main.css`, Vite 不会给全局 keyframe 加 scope suffix
> - **图2 status bar 警告**: `ChatMain.vue` 加 `latestAssistantEmpty` computed + "重新生成" button
> - **图3 quote 鲁棒**: 1) `chat.ts` 发送前剥离 `` 块; 2) 标签升级到 `[Pi 先前的回答 (messageId=...)]` / `[用户当前问题]`, 用角色名替代模糊词; 3) `console.log` 增加 fullUserText 调试打印

### v0.5.0-D 第17轮 (D204, `232f01f`) - REVERT D200/D202/D203 + stream hang ⭐
> D204 user 反馈 2 个问题:
> 1. 每次第一次默认发送都弹"模型返回空"错误 — 不合理
>    根因: D200 (b379f76) 在 message_end 探测"空 message" → D202 (6dce781) + D203 (b545617) 在 UI 弹 AlertTriangle. 实测 sensenova-6.7-flash-lite 合法地先发空 message (warmup / control), 再发 thinking + toolCall, D200 提前告警 → user 困惑
> 2. 底部 status bar 的 "重新生成" 按钮 + emptyResponse 主动告警 — 都不是 user 想要的 (user 已经在 D203 反馈"再思考一下, 小心一点修改")
>
> 修法:
> - **REVERT** D200 emptyResponse 主动告警 (false positive 太多)
> - **REVERT** D202/D203 的 `ChatMessage.emptyResponse` flag + ChatMain `latestAssistantEmpty` + "重新生成" button
> - **新增 stream hang detector**: track 每 session 最近一次事件时间, 30s 内没事件 + 仍 isStreaming → 标 streamHang=true
> - **UI**: chat 区域中间显示横线 "─── ⚠ 30s 无新事件 · 模型 / sidecar 已停止响应 ─── ×" (不是 popup)
> - **横线关闭**: 只清标记, 不会触发新请求, user 自行在 composer 重发即可, 不强行 retry
> - **REVERT D205**: 同步删底部 status bar (D202 第3 个修), 动态文字搬上去

### v0.5.0-D 第18轮 (D205, `3009f51`) - 删 status bar + 简化引用
> D205 user 反馈 2 个问题:
> 1. 左下角不要有这种提示 (底部 status bar 太重复)
> 2. 引用应该是很简单的东西, 发送后接到用户的输入里面, 只是前端可视化
>
> 修法:
> - **删底部 status bar**: `ChatMain.vue` 删 `.pad-chatmain__streaming-status` (template + script + CSS + Loader2 import)
> - **动态文字搬到 chat placeholder**: `PHASE_LABELS.idle: ['思考中…', '生成中…', '下笔中…']` 3-label 轮换
> - **引用格式简化**: `fullUserText = ${quote.content.trim()}\n\n${text}` (plain text, no labels, no `> `)
>
> **D205 走过头**: 完全去掉结构化标记, AI 识别不出"哪段是引用". D206 修.

### v0.5.0-D 第19轮 (D206, `8b3f7b4`) - 引用回归 ⭐
> D206 user 反馈: "D205 走过头". AI 识别不出 quote 哪段是引用.
>
> 修法:
> - **markdown blockquote 回归**: D205 去掉 `> ` 太极端, 加回最小结构化标记 `> ` (LLM 训练集里大量 markdown blockquote, 通用识别)
> - **quoteContent 字段**: 加到 `ChatMessage` type, 存原始引用文本 (没 `> ` 前缀), 给前端渲染做可视化
> - **appendUserMessage 签名升级**: `(sessionId, content, quoteContent=null)`
> - **前端 blockquote 样式**: `ChatMessage.vue` 拆 user 气泡为 `pad-msg__quote-block` (Quote icon + left border + grey bg + max-height 96px)
> - **extractNewQuestion(content, quoteContent) helper**: 拆分引用 + 新问题
> - **emptyResponse 字段注释掉** (D204 删的 auto-detection, 字段保留作 backward compat)

### v0.5.0-D 第20轮 (D207, `b5b985b`) - 引用可折叠
> D207 user 反馈: "我希望用户的这段引用的内容能够折叠, 而不是滑动的"
>
> 修法:
> - **可折叠**: 长引用默认 collapsed (首行 + chevron), 点击展开
> - **isQuoteLong + isQuoteCollapsed ref + toggleQuote() + quotePreviewText computed**
> - **QUOTE_COLLAPSE_THRESHOLD = 80 chars**
> - **ChevronRight (collapsed) → 旋转 90deg → ChevronDown (expanded)**
> - **点击 blockquote 切换**, cursor pointer + hover bg
> - **删 max-height/overflow-y** (D206 的 scroll 方案)

### v0.5.0-D 第21轮 (D208, `3a36ff2`) - Token breakdown REAL 数据 + 0% bug ⭐
> D208 user 反馈 2 个问题:
> 1. 上下文窗口占比一直是0, 需要重新发送对话后才正常计数
> 2. Token breakdown 真实数据验证
>
> 修法:
> - **0% bug 根因**: `getContextWindow()` 用 `?? DEFAULT_CONTEXT_WINDOW` 只处理 null/undefined, model 配了 contextWindow=0 时 ?? 不回退, 直接返 0 → percent = tokens/0 = 0%
>   - 修法: `cw && cw > 0 ? cw : DEFAULT_CONTEXT_WINDOW` (0/负数都回退 200K)
> - **4-cat REAL breakdown**: Pi SDK lastUsage (input/output/cacheRead/cacheWrite) 实测数据
>   - 数据源: `lastUsageBySession[sid]` (per-turn, 覆盖, message_end 写)
>   - `ContextBreakdownReal` interface + `getContextBreakdownReal` + `getContextBreakdownRealPercent` in chat store
> - **ContextIndicator UI**: 拆 2 区块 "实测 (Pi SDK)" + "估算 (FE)", 4 分类 dot 颜色 (input=#4f46e5 蓝紫 / output=#0891b2 青 / cacheRead=#16a34a 绿 / cacheWrite=#f59e0b 橙)

### v0.5.0-D 第22轮 (D209, `9584da2`) - willRetry 兜底 + 累加 + 拆"实测/估算"两区块 ⭐
> D209 user 反馈 2 个问题:
> 1. LLM 请求异常触发 willRetry 重试时, 会一直卡着
> 2. Token breakdown 数字要正确, 上下文窗口计数应该是累加的
>
> 修法:
> - **willRetry 兜底**: D204 stream hang watchdog 之前只 set streamHang=true 标记, 没清理 retry 状态 → isStreaming 仍 true → retry banner 一直挂着. 修法: stream hang 触发时, 强制 force stop streaming (跟 Composer.stop() 30s timeout 行为一致)
> - **累加**: 新加 `cumulativeUsageBySession` (D209 累加, 跨 turn 求和, 持久化 localStorage `pi-agent:cumulative-usage:v1`)
>   - `contextTokensBySession` 也改成累加 (input + cacheRead 总和)
>   - `lastUsageBySession` 保留 (per-turn, 调试/单次显示用)
>   - compaction 成功时清零 (`!event.aborted && !event.errorMessage`)
> - **拆"实测/估算"两区块**: user 反馈 "我要的不是你单独新建一个'实测 (Pi SDK)'计量, 而是数值正确显示在FE里面". 只保留 4-cat REAL (cumulativeUsageBySession) + 合计行
> - **删 6-cat FE 估算**: D198 设计的 6 分类 (消息/工具/系统提示词/技能/记忆/其他) 是 FE 启发式估算, 跟 LLM 实际差 10-20% → 整段删掉 (getContextBreakdown 函数保留, backward compat)

### v0.5.0-D 第23轮 (D210, `8da8a01`) - FE 端 auto-retry ⭐
> D210 user 反馈: "发送消息后 LLM 异常后, 不会主动重试发送, 会一直卡着"
>
> D209 修法 (上一轮): stream hang 30s → 强制 force stop streaming → user 看横线手动重发
> D210 增强: 30s 兜底 force stop 后, FE 主动 resend last user message 1 次, 让 user 不用手动操作
>
> 实现:
> - `autoRetryCountBySession: Record<string, number>` ref (per-session 计数)
> - `AUTO_RETRY_MAX = 1` (上限 1, 防 spam)
> - `AUTO_RETRY_DELAY_MS = 2_000` (2s 延迟, 让 sidecar 清理 + user 看到"正在重试..."指示)
> - `isAssistantMessageEmpty(msg)` helper: 检查 content + steps[].text + thinking + toolCalls 全空
> - `getLastUserMessageContent(sid)` helper: 找最近 user msg content
> - `tryAutoRetry(sid)` async: 30s 兜底后, 检查空 message + 重发 last user msg 1 次
> - `clearAutoRetryCount(sid)`: user 新发消息时清零
> - `sendPrompt` 入口: user 新发 → clearAutoRetryCount (允许下次再 auto-retry)
> - quote 不带: auto-retry 重发原始 user content, 不重复 quote
>
> Bug 修: 之前 `tryAutoRetry` 用 `activeSession.value?.id` 是未定义 ref, 编译过但 runtime 永远 true (任意 session 都触发 retry). 改成 `sessionStore.activeSessionId` 正确比较

### v0.5.0-D 第24轮 (D210.1, `c82030b`) - watchdog setTimeout 永不复位 bug
> D210 user 实测反馈: "看起来你还是没有自动尝试重发啊?"
> 30s+ 过去了, "等待 LLM 重试中..." banner 一直挂着, 永远不触发 stream hang 兜底.
>
> 根因 (D204 写 watchdog 时就有, D209/D210 都没发现):
> `startStreamHangWatchdog` 启动的 `setTimeout(..., 30_000)` 是一次性的 30s 倒计时 (从 sendPrompt 调用时算起), 不会因为后续到达的事件自动延后. listener 里只调 `touchStreamEvent` 更新 `lastStreamEventAt` 时间戳, 但 setTimeout 已经启起来了, 不会重置.
>
> 时间线:
> - t=0:  sendPrompt → 启动 setTimeout(..., 30_000), timer 在 t=30s 触发
> - t=0+1s: agent_start
> - t=0+2s: turn_start
> - ...
> - t=0+5s: agent_end willRetry=true (最后事件, lastStreamEventAt=5s)
> - t=30s: setTimeout 触发, 检查 Date.now() - last = 25s < 30s, 条件不满足, watchdog 直接 return
> - **30s 兜底永远不触发**
>
> 修法:
> - listener 接到每个事件时, 重新调 `startStreamHangWatchdog(sessionId)` (它内部 stopStreamHangWatchdog + setTimeout 启新的 30s timer). 这样 setTimeout 真正每次从最后事件算起 30s

### v0.5.0-D 第25轮 (D210.2, `16c7e4d`) - 重复 listener + autoRetryCount 误清零 双 bug
> D210.1 user 实测反馈: "等于重发了三次后, 会返回三个同样结果"
>
> 根因 (D210 写时漏了 2 个边界):
>
> **Bug 1: 重复 listener** — `agent_end willRetry=true` 分支不调 off() (要继续等 Pi SDK 内部 retry events). 下次 sendPrompt 又调 `piTauri.on()` 加新 listener, 老 listener 一直活着. 多次 auto-retry 后 N 个老 listener 都在, 每个事件被处理 N 次 → content 重复 N 次 / cumulative context 累加 N 次.
>
> 修法: `listenerOffBySession` Map 跟踪 off 函数. `sendPrompt` 进来前 + watchdog force stop 时调 `cleanupListenerForSession(sid)` 把老 listener 清掉.
>
> **Bug 2: autoRetryCount 在 resend 时被清零 → 无限 retry 循环** — `sendPrompt` 入口无条件 `clearAutoRetryCount`, 但 `tryAutoRetry` 走 `sendPrompt` resend 也被清零 → watchdog 再触发时 count 还是 0 又能 retry 一次 → 无限循环, max=1 失效.
>
> 修法: `sendPrompt` 加 `opts.fromAutoRetry` 参数. user 手动发不传 → clearAutoRetryCount; `tryAutoRetry` resend 传 `fromAutoRetry: true` → 跳过清零

### v0.5.0-D 第26轮 (D210.3, `1a227ad`) - 压缩无反应 bug
> D210.2 user 实测反馈: "现在重试算是正常了; 然后我测试了一下压缩上下文, 在上下文只占了1%的情况下点击压缩, 底部弹出了一个'开始压缩context'但是好像没有反应"
>
> 根因: chat store 的 chat:event listener 是 sendPrompt 临时创建的, `agent_end willRetry=false` 时会调 `off()` 注销. 之后 user 调 `compact()` → `piTauri.compactSession` 启**独立** sidecar 跑 compact, 这个 sidecar emit 的 `compaction_start` / `compaction_end` 事件走 `chat:event` channel, 但 store 已经没有 handler 接收 → 事件全丢, UI 永远卡"压缩中"
>
> 修法:
> 1. 提取 `handleCompactionStart` / `handleCompactionEnd` helper 函数
> 2. `sendPrompt` listener 的 `case 'compaction_start' / 'compaction_end'` 改成调 helper
> 3. `compact()` 在调 `compactSession` **之前** `piTauri.on()` 注册临时 handler:
>    - 调同样的 helper (行为一致)
>    - filter `sessionId === sid` (避免被其他 session 事件污染)
>    - 收到 `compaction_end` 后自动 `off()` 注销
> 4. `isCompacting(sid)` 防双击 → 不会有重复临时 handler

### v0.5.0-D 第27轮 (D210.4, `e113e5d`) - 压缩 UX 统一 ⭐ 当前轮
> D210.3 user 实测反馈: "这边的可视化 UI 效果不对, 应该是压缩失败要在上面提示, 包括压缩进行中都不要通过弹窗形式提示, 而是统一使用分隔线的形式, 做的整体一些"
> 截图显示: 两条 "上下文已压缩" 横线 (连续点两次 push 两条), 底部弹窗 "压缩失败: Compaction failed: Nothing to compact (session too small)"
>
> 修法:
> 1. **类型升级** `ChatMessage.compactionMarker`: `boolean` → `{ state: 'in_progress' | 'success' | 'failure', errorMessage? }` object, 3 种状态都可表达
> 2. **`compact()` UX**: 调 `compactSession` 之前 push 一条 `in_progress` system message (分隔线); catch 错误时: 找到刚才的 in_progress 原地更新成 `failure + errorMessage`, 不再 showToast
> 3. **`handleCompactionEnd` UX**: 删 success / failure / aborted 3 个 showToast; 找最近一条 in_progress divider 原地更新成 `success` / `failure` (避免累积多个 divider); 兜底: 找不到 in_progress (Pi SDK 内部自动 compaction 没走 compact() 推过) → 直接 push success/failure
> 4. **ChatMessage.vue divider 按 state 渲染**:
>    - `in_progress` → 🔄 Loader2 spinner + "正在压缩…"
>    - `success` → ✓ Check icon + "上下文已压缩"
>    - `failure` → ⚠ AlertTriangle + "压缩失败: <errorMessage>" (橙色警示)
>    - 3 种状态 line 颜色微调 (in_progress 弱化、failure 橙、success 正常)
>    - errorMessage 加 `max-width: 480px + ellipsis` 截断, 避免撑爆 chat 宽度

---

## 后续规划 (Phase 2)

### P0 (v0.6)
- 重试单条 assistant 消息 (hover → "重试" 按钮, D210 已实现 1 次 auto-retry, 单条精确重试用此)
- Stop abort lost 根因排查 (D210 已经比 D203 强很多, 但仍是兜底)

### P1 (v0.6 - v0.7)
- 编辑消息后重发 (fork) - 选段, 改, 重发
- 消息分支树 (fork from message N) - Pi SDK 有 `fork` / `clone` RpcCommand 协议, UI 待收
- Pi SDK 自动 compaction (threshold / overflow) 触发后也走 in_progress 分隔线 (D210.4 兜底逻辑已支持, 但应主动 push in_progress 让 UX 一致)

### P2 (v0.7+)
- 多模态输入 (图片 attachment)
- 实时协作
- 消息分支 UI 树状展示
- 引用内容用更聪明的可视化 (e.g. 引用来源 hover 显示完整 message)
- LaTeX parse error 详情 tooltip
