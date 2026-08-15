# AGENTS.md — Pi Agent App

> 给后续 agent 看的项目工作约定。代码改动前必读。

## 这是什么

**产品级** web/桌面 AI agent 客户端 (用户对用户的业务系统) — **不是**内部工具,**不是** openwebui/ChatGPT-team 那种 agent-server-给-10-50-用户用的形态。

- 形态: 单用户本地 agent + 协作层 (Pi / Claude Code / Cursor / Trae 同类)
- 跨端: Web (本目录 Vite) + Tauri 2 (Phase 3+)
- 后端: 同根 `../server/` (Node.js 22 + Hono + WS) 包装 `earendil-works/pi` SDK
- 部署: 一份 server 支撑一个团队的 web/桌面客户端

## 1:1 复刻基线 (Phase 1)

- **唯一真值源**: `D:\UnityWork\Tools\Pi\Pi-Agent-Design.design\pages\chat.html`
- **设计 token 源**: `..\Pi-Agent-Design.design\colors_and_type.css` (321 `--pad-*` 变量, 已复制到 `src/assets/styles/tokens.css`)
- **复刻范围**: 5 个区, 视觉/尺寸/颜色/字重/间距/动画严格一致
  - TitleBar (36px) / Sidebar (248px) / ChatMain (flex-1) / TaskDrawer (340px) / 顶层 #app 容器
- **mock 数据**: 5 workspaces (NX_Photovoltaic 展开) + 1 active session "你好" + 1 user msg + 1 assistant msg + 1 thinking block

## 工作约定

1. **改代码前先拿授权**, 不在未确认范围时大刀阔斧重构。
2. **设计 token 一律走 `var(--pad-*)`**, 不写魔法值。`src/assets/styles/tokens.css` 是 single source of truth。
3. **CSS 走 `<style scoped>` 纯 CSS**, 不用 Tailwind / UnoCSS / 等 utility-first 框架。`<style scoped>` 覆盖不到的弹层 (NPopover 类) 用 `:global(.x)` 跨项目通用坑。
4. **图标用 `lucide-vue-next`**, 16px 默认, stroke-width 1.75, 跟 chat.html 的 `.lucide` class 一致。
5. **store 走 Pinia setup syntax** (`defineStore('x', () => { ... })`), 不用 options 语法。
6. **跨进程字段名严格对齐** (e.g. `modelId` 不是 `id`), 撞 1 字符就 400。
7. **OAuth / 字符串数组形态** 用兼容写法 (`getModelId` helper), 见 Spark 跨项目教训。

## 关键路径

- `src/views/ChatView.vue` — 顶层 3 列布局, padding/gap = `var(--pad-sp-2)` (8px), bg-active 外层
- `src/stores/ui.ts` — sidebarCollapsed / drawerCollapsed / activeTab / activeSessionId (初始 'sess-1')
- `src/stores/session.ts` — workspaces / sessions / expandedWorkspaceIds / activeSession / activeWorkspace
- `src/stores/chat.ts` — messagesBySession / thinkingBySession / toolCallsBySession / isStreaming
- `src/lib/mock/*` — Phase 2 会替换为 `../server/` WebSocket 流

## Phase 边界 (现在不做)

- ❌ 启动 dev server / `npm install` (要问用户, 跨项目规则)
- ❌ 接 Pi SDK (Phase 2)
- ❌ Tauri 打包 (Phase 3)
- ❌ 真实 workspace 文件树 / 用户登录 / 多用户协作 (产品级 + Phase 2+)

## 改完跑啥

- `npm run typecheck` (vue-tsc --noEmit)
- 1:1 对比: `npm run dev` 后浏览器开 http://localhost:5174, 跟 `..\Pi-Agent-Design.design\pages\chat.html` 截图对比

## 历史

- 2026-08-15: Phase 1 v0.1 起步, Vite + Vue 3 + TS + Pinia + lucide-vue-next
- 备份: `.backup_v0_legacy/` 含旧 Tailwind 版的 TitleBar / MessageItem / types / mock (待 review)
