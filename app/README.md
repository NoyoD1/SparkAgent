# Pi Agent App

> **Web / 桌面通用、对人协作、可挂业务系统** 的 AI agent 客户端。
> 本目录是 Phase 1 前端: Vite + Vue 3 + TypeScript, 1:1 复刻 `Pi-Agent-Design.design/pages/chat.html`, mock 后端。

## 1. 项目定位

- **形态**: 产品级应用, 不是内部工具
- **跨端**: Web (本目录) + Tauri 桌面 (Phase 3+)
- **架构**: 浏览器 / Tauri → 自己的 Web/桌面 UI (本目录) → Node.js 后端 (同根 `../server/`) → Pi SDK
- **后端**: Phase 2+ 接 `earendil-works/pi` 的 `createAgentSession`, 通过 WebSocket 流式输出
- **业务集成**: 通过 Pi 的 Extension 机制注入, 不改 server 源码

## 2. 目录结构

```
app/
├── src/
│   ├── main.ts                   # 入口, createApp + Pinia
│   ├── App.vue                   # 根组件, 挂 ChatView
│   ├── views/
│   │   └── ChatView.vue          # 1:1 复刻 chat.html 顶层布局
│   ├── components/
│   │   ├── TitleBar.vue          # 36px 顶部栏 (search/edit/help/panel/win)
│   │   ├── Sidebar/              # 248px 左栏 (TabBar/FunctionList/Tree/User)
│   │   ├── ChatMain/             # 中间 (Header/Message/Composer)
│   │   ├── TaskDrawer/           # 340px 右栏 (待办 / 上下文)
│   │   └── ui/                   # IconButton / Avatar 原子组件
│   ├── stores/                   # Pinia: ui / session / chat
│   ├── lib/mock/                 # Phase 1 mock 数据 (types/sessions/messages)
│   └── assets/styles/            # tokens.css (321 --pad-* 变量) + main.css
├── package.json                  # vue 3.5 / pinia 2.3 / lucide-vue-next 0.469 / vite 6
├── vite.config.ts                # port 5174, alias @, Phase 2+ proxy 预留
└── tsconfig.json
```

## 3. 启动

```powershell
cd D:\UnityWork\Tools\Pi\app
npm install
npm run dev          # http://localhost:5174
```

> ⚠️ **必须先问用户再启 dev server** (跨项目规则, 避免跟用户手动启的进程冲突)

## 4. 设计 token 源

- **源文件**: `../Pi-Agent-Design.design/colors_and_type.css` (321 个 `--pad-*` 变量)
- **复制到**: `src/assets/styles/tokens.css` (改 token 必须改源文件后重新复制)
- **品牌色**: `--pad-accent-500: #5b5bff` (紫, 不是蓝)
- **字体**: `--pad-font-sans` = `PingFang SC, HarmonyOS Sans SC, "Segoe UI", system-ui, sans-serif`
- **暗色**: tokens.css 自带 `.dark {}` 块, 全套映射

## 5. 1:1 复刻基线 (chat.html)

| 区域         | 文件                          | 复刻来源           |
| ------------ | ----------------------------- | ------------------ |
| 顶层布局     | `views/ChatView.vue`          | chat.html L61-79   |
| TitleBar     | `components/TitleBar.vue`     | chat.html L63-76   |
| Sidebar      | `components/Sidebar/*.vue`    | chat.html L81-175  |
| ChatMain     | `components/ChatMain/*.vue`   | chat.html L178-290 |
| TaskDrawer   | `components/TaskDrawer/*.vue` | chat.html L293-349 |

> 1:1 = 视觉/尺寸/颜色/字重/间距/动画严格一致; mock 数据 (5 workspaces + 1 active session + 2 messages) 跟 chat.html 静态演示完全相同。

## 6. 已知问题 / Phase 边界

- **mock 后端**: Composer 发送后只 push 到 Pinia, 不调真 API。Phase 2 接 `../server/` 时改 `stores/chat.ts` 的 `appendUserMessage` 走 WS。
- **窗口控制**: TitleBar 里的 min/max/close 按钮目前是占位。Tauri Phase 3 接 `getCurrentWindow()`。
- **v0.1 死代码**: `.backup_v0_legacy/` 里是旧 Tailwind 版的 TitleBar/MessageItem/types/mock, 等用户 review 后删。

## 7. 接下来 (Phase 2+)

- [ ] 写 `../server/` (Node.js 22 + Hono + WS, 包装 Pi SDK 的 `createAgentSession`)
- [ ] Vite dev proxy 启用 `/api` + `/ws` → `localhost:3001`
- [ ] `stores/chat.ts` 把 user/assistant 消息流转走 WS 流
- [ ] Tauri 2 desktop packaging, 复用 `src/` 不动
