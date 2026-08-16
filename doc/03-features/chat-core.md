# Chat 核心 (Chat Core)

> 状态: 🟢 95%
> 最后更新: 2026-08-16 (v0.4 Pi SDK 集成端到端跑通)
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
- 🟡 中断生成（Stop 按钮）— **v0.4.1 必做**
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
| `app/src/stores/chat.ts` | 消息状态机 + 事件订阅 + 流式 append |
| `sidecar/src/index.mjs` | Pi SDK `Agent` + `createModels` 集成 → JSON Lines 事件 (v0.4 重写) |

### 2.1 事件流（v0.3.8.6+）

```
agent_start → message_start → message_update(N) → tool_start / tool_update / tool_end → message_end → agent_end
```

每个事件含 `sessionId`，多 session 并发不串。

### 2.2 折叠行为

- `thinking` block 默认折叠（v0.3.8.11）
- `tool_call` block 默认折叠，但 tool 列表展开
- 折叠时不能"漏出"内容（v0.3.8.11 leak 修复）

### 2.3 颜色（v0.3.8.26+）

- `thinking` 内 markdown 用 `fg-tertiary`（区别于正文 `fg-primary`）
- `tool_call` name 用 `fg-secondary` + mono 字体
- 通过 `:deep(.pad-md)` 穿透 scoped 到 v-html 子元素

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
