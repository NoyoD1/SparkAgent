# Chat 核心 (Chat Core)

> 状态: 🟢 95%
> 最后更新: 2026-08-17 (v0.4.1.3 step 累加 + 跑马灯 + max-width 720)
> spec 涉及: `app/src/components/ChatMain/` + `app/src/stores/chat.ts` + `sidecar/src/index.mjs`

---

## 1. Spec

**核心对话能力** — 用户发消息，AI 流式回复，消息以 Markdown 渲染，思考过程可见，工具调用可折叠。

### 1.1 必备能力

- ✅ 多轮对话（消息按时间顺序追加）
- ✅ 流式输出（用户看到 token 逐字出现）
- ✅ Markdown 渲染（标题 / 列表 / 代码块 / 表格 / 引用 / 链接 / 图片）
- ✅ 代码高亮（语法着色）
- ✅ 思考过程（reasoning_content）单独展示，可折叠
- ✅ 工具调用（tool_call）结果展示，可折叠
- ✅ 复制消息 / 复制代码块
- ✅ 重试（regenerate）— 单条消息级别
- ✅ **Pi SDK 集成 v0.4** — sidecar 用 `@earendil-works/pi-ai` + `@earendil-works/pi-agent-core`,7 内置 provider + 自定义 openai-compatible (商汤等) 全跑通
- ✅ **7 tool 集成 v0.4.1** — sidecar 用 `@earendil-works/pi-coding-agent`, `createReadTool`/`createWriteTool`/`createEditTool`/`createBashTool`/`createLsTool`/`createFindTool`/`createGrepTool` 全跑通（fauxProvider 烟测 PASS, 真 key 端到端 OK）
- ✅ **Step 累加 UI v0.4.1** — 1 turn = 1 step group, Cursor 风格, 默认全折叠 (current step 也折叠), isActive 走 accent 边 + spinner. final body 渲染 `lastStep.stepText` 防跨 turn 重复
- 🟡 中断生成（Stop 按钮）— **v0.4.1 必做（未做）**
- ❌ 编辑用户消息后重发（edit & resend）
- ❌ 引用回复（quote & reply）
- ❌ 消息分支（fork from message N）
- ❌ Token 计数显示（输入 / 输出 / 总计）
- ❌ 多模态输入（图片 / 音频）— 不做为主入口

### 1.2 不做什么

- ❌ Markdown WYSIWYG 编辑器（用户输入 raw markdown）
- ❌ 富文本（粗体按钮等）— 用户会 markdown
- ❌ LaTeX 数学公式 — 如需要走扩展
- ❌ 实时协作（光标位置同步）— 不在 v1.x

---

## 2. 当前实现

| 文件 | 职责 |
|---|---|
| `app/src/components/ChatMain/ChatMain.vue` | 列表容器 + 滚动行为 + composer 挂载 |
| `app/src/components/ChatMain/ChatHeader.vue` | 当前 session 标题 + 操作按钮 |
| `app/src/components/ChatMain/ChatMessage.vue` | 单条消息渲染（user / assistant / system）|
| `app/src/components/ChatMain/Composer.vue` | 输入框 + 附件 + 工具栏 |
| `app/src/components/ChatMain/MarkdownContent.vue` | marked 渲染 + 代码高亮 + v-html |
| `app/src/components/ChatMain/ChatMessageNav.vue` | 消息间导航（上下条 / 跳到最新）|
| `app/src/stores/chat.ts` | 消息状态机 + 事件订阅 + 流式 append + step 累加 state (v0.4.1) |
| `app/src/components/ChatMain/StepGroup.vue` | 单 step 渲染（标题 + thinking + tool_calls, 默认全折叠）**v0.4.1 新建** |
| `sidecar/src/index.mjs` | Pi SDK `Agent` + `createModels` + 7 tool 工厂集成 → JSON Lines 事件 (v0.4 重写, v0.4.1 加 tool + turn 边界) |

### 2.1 事件流（v0.4.1 扩展）

```
agent_start → turn_start → message_start → message_update(N) → [tool_start / tool_update / tool_end] → message_end → turn_end → ... → agent_end
```

每个事件含 `sessionId`，多 session 并发不串。

**v0.4.1 新增 turn 边界事件**：
- `turn_start` — 标一个新 turn 起点（Pi SDK Agent.prompt 一次可能跑 N turn, tool_call 链）
- `turn_end` — 标 turn 终点，payload `{ message, toolResults }`
- FE 用来做 step 累加 UI（1 turn = 1 step group），不需要新协议

**v0.4.1 修复 event name**：
- ❌ `tool_call_*`（v0.4 集成时凭印象写错）
- ✅ `tool_execution_*`（v0.84+ 实际命名）→ sidecar 映射成 JSON Lines `tool_*`

### 2.2 折叠行为

- `thinking` block 默认折叠（v0.3.8.11）
- `tool_call` block 默认折叠，但 tool 列表展开
- 折叠时不能"漏出"内容（v0.3.8.11 leak 修复）
- **Step group 默认全折叠**（v0.4.1.1）— 包括 current step，isActive 走左边 accent 边 + spinner 提示，不强制展开
- **thinking 样式**（v0.4.1.2）— fs-11 italic fg-tertiary + 灰底 + 6px padding，跟正文 14px 区分
- **tool_call 样式**（v0.4.1.2）— fs-11 mono 紧凑 padding (2px)

### 2.3 颜色（v0.3.8.26+）

- `thinking` 内 markdown 用 `fg-tertiary`（区别于正文 `fg-primary`）
- `tool_call` name 用 `fg-secondary` + mono 字体
- 通过 `:deep(.pad-md)` 穿透 scoped 到 v-html 子元素
- **Step 标题**（v0.4.1.2）— 12px fg-tertiary 无 emoji
- **session 跑马灯**（v0.4.1.3）— `.is-streaming::after` 2px 底部 accent gradient + 0.8s linear infinite（marching ants），不依赖 is-active

### 2.4 ChatMain max-width（v0.4.1.3）

- `.pad-chatmain__list-inner` max-width 880px → **720px**（居中, 两侧留白）
- `.pad-chatmain__composer-area` max-width 880px → **720px**（跟 list-inner 同步）
- `.pad-hero__composer` + `.pad-hero__tabstrip` 已经 720px, 不动

---

## 3. 已知问题 / 限制

- 🟡 没有"中断生成"按钮（v0.4 必做）
- 🟡 没有"重试"按钮（当前 mock 已有，真实流接上后测）
- 🟡 消息没有时间戳显示（chat store 有，但 UI 没暴露）
- 🟡 长消息（> 10K token）性能未测
- 🟡 滚动行为：用户向上滚时新消息自动滚到底逻辑没做

---

## 4. 待办（Roadmap）

### P0（v0.4 必做）
- [ ] **Stop 按钮**：用户能中断正在生成的流（同时中断 sidecar + LLM fetch）
- [ ] **重试**：单条 assistant 消息重发，重跑 LLM
- [ ] **Token 计数**：输入 / 输出 / 总计显示

### P1（v0.4 - v0.5）
- [ ] **编辑用户消息后重发**：fork 出一条新对话线
- [ ] **引用回复**：拖选消息 → 插入到 composer
- [ ] **消息分支树**：可视化分支

### P2（v0.5+）
- [ ] 多模态输入（图片 attachment，OCR 给 LLM）
- [ ] 消息搜索（跨 session）
- [ ] 消息操作快捷键（Y / E / R for copy / edit / retry）

---

## 5. Changelog

- **2026-08-17 · v0.4.1.3 polish** · session 跑马灯 marching ants（别人 agent session 跑时也能看到）+ chat 内容收窄 880→720. user feedback "session 跑马灯效果 (别人 agent 界面)" + "中间回复内容的区域还是太宽了"
- **2026-08-17 · v0.4.1.2 fix** · final body 渲染 `lastStep.stepText`（per-turn 隔离, 不跨 turn 重复）+ step UI 美化（标题 12px fg-tertiary, thinking fs-11 italic + 灰底, tool_call fs-11 mono 紧凑）. user feedback "内容重复" + "step UI 不够精致"
- **2026-08-17 · v0.4.1.1 fix** · step 默认全折叠 (current step 也折叠) + 删 stepText 在 step 内重复渲染. user feedback "内容重复" + "默认展开太占地方"
- **2026-08-17 · v0.4.1 step 累加 UI** · 新建 `StepGroup.vue`, 1 turn = 1 step group 可折叠累加. sidecar 透传 `turn_start` / `turn_end` 标 step 边界. types.ts 加 `Step` interface + `ChatMessage.steps?`. ChatMessage 改用 steps prop. user feedback "步骤流式回复能不能再美化好看一些"
- **2026-08-17 · v0.4.1 7 tool 集成** · 改用 `@earendil-works/pi-coding-agent` 7 tool 工厂 (D102 反转, "直接使用 pi-coding-agent 包的"). 修了 2 个 bug: event name `tool_call_*` → `tool_execution_*` + cost 必填 (`pi-ai/src/models.ts:882` calculateCost 假设 `model.cost` 已定义). fauxProvider 烟测 PASS
- **2026-08-16 · v0.4 (Pi SDK 集成)** · sidecar 重写用 `@earendil-works/pi-ai` + `@earendil-works/pi-agent-core`,支持 7 内置 provider + 自定义 openai-compatible (商汤 deepseek-v4-flash 真 key 端到端跑通). 修了 5 字段必填 + 错误 emit + event 去重 + import 路径. ADR-0012 记录决策
- **2026-08-16 · v0.3.8.27** · 移除 composer 上方 fade mask（用户反馈"膏药贴"）
- **2026-08-16 · v0.3.8.26** · thinking/tools 文字色区分（`:deep(.pad-md)` + `fg-secondary`）
- **2026-08-16 · v0.3.8.11** · thinking 默认折叠 + leak 修复
- **2026-08-16 · v0.3.8.6** · tool_call 流式 + 折叠
- **2026-08-15 · v0.3.7** · ChatMessage 重构（avatar + 内容分离 + 工具块独立）
- **2026-08-14 · v0.3.5** · 消息渲染基础稳定
- **2026-08-13 · v0.3.3** · sidecar camelCase serde 修复，消息流接通
- **2026-08-12 · v0.3** · Tauri sidecar 接通
- **2026-08-10 · v0.2** · web form 流式 chat
