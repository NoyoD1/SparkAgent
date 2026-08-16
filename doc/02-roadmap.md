# 02 · 路线图 (Roadmap)

> v0.4 → v1.0 阶段划分 + 每 phase 必做项 + 验收标准。
> 状态：🟢 当前阶段 / ⚪ 未来阶段 / ✅ 已完成

---

## 阶段总览

| Phase | 主题 | 关键交付 | 状态 | 预计开始 |
|---|---|---|---|---|
| v0.1 - v0.2 | 骨架 | Web form + 多 provider BYOK + 流式 | ✅ | 2026-07 |
| v0.3 | Tauri 化 | 桌面 app + OS keychain + Node sidecar | ✅ | 2026-08 上 |
| v0.3.5 - v0.3.8.27 | UX Polish | 布局 / 主题 / 折叠 / 字体 / 设计系统 | ✅ | 2026-08 中 |
| **v0.4** | **Tool Call 真正落地** | 文件读/写 / shell / 权限确认 / abort | 🟢 | **2026-08 中** |
| v0.5 | Memory | 跨会话 / 项目级 / 自动提取 | ⚪ | TBD |
| v0.6 | Skills + MCP | 自定义指令 + MCP server 接入 | ⚪ | TBD |
| v0.7 | Subagent / Plan | 多 agent 切换 / Plan 模式 | ⚪ | TBD |
| v0.8 | 协作 / 分享 | session 导出 / 团队空间 | ⚪ | TBD |
| v0.9 | 跨平台 | macOS / Linux 适配 | ⚪ | TBD |
| **v1.0** | **稳定版** | 自动更新 + 完整文档 + 用户指南 | ⚪ | TBD |

---

## 🟢 v0.4 · Tool Call 真正落地（**当前**）

**为什么这个最重要**：没 tool call，Pi Agent 就是个 chat 客户端；有了 tool call，才是 agent 客户端。

### 必做项

| # | 项 | spec | 验收 |
|---|---|---|---|
| 1 | Sidecar 集成 `pi-agent` SDK 替代直接 fetch | [tools.md](03-features/tools.md) | SDK 流式 API 接通，消息格式对齐 |
| 2 | 内置 tool: `read_file` / `write_file` / `edit_file` | [tools.md](03-features/tools.md) | LLM 能读 / 写用户指定 workspace 内的文件 |
| 3 | 内置 tool: `bash` / `run_command` | [tools.md](03-features/tools.md) | LLM 能跑命令，结果回传；workspace 外默认拒绝 |
| 4 | 内置 tool: `list_dir` / `glob` / `grep` | [tools.md](03-features/tools.md) | LLM 能浏览 workspace |
| 5 | **Tool permission system**（v0.4 最关键）| [tools.md](03-features/tools.md) + [security.md](03-features/security.md) | 每个 tool call 用户显式 confirm（至少第一次），白名单 / 黑名单 |
| 6 | **Abort / Stop button** | [chat-core.md](03-features/chat-core.md) | 用户能中断生成 + tool call |
| 7 | Tool result 持久化到 session | [tools.md](03-features/tools.md) | 重新打开 session 能看到 tool history |
| 8 | Workspace 路径安全校验 | [security.md](03-features/security.md) | tool 拒绝 path traversal (`../` etc) |
| 9 | Tauri fs / shell 权限加到 capabilities | [desktop.md](03-features/desktop.md) | `core:fs:allow-read-text-file` 等 |
| 10 | Sidecar 错误恢复（v0.3.8.13 已有基础）| [observability.md](03-features/observability.md) | 401/403 / network error / sidecar crash 都能恢复 |

### 不做（推到后续 phase）

- ❌ Subagent（在 tool call 稳定后单独做）
- ❌ Memory（在 tool call 上验证后做）
- ❌ Plan Mode（需要 subagent + 稳定 tool）

### 验收标准（v0.4 完成定义）

- [ ] 启动 app → 配置 BYOK → 选 workspace → 发"读 README.md 给我总结"
- [ ] LLM 调用 `read_file` 工具 → 显示 tool call UI（折叠 / 展开）→ 输出总结
- [ ] 发"在 src/foo.ts 加一个 hello 函数" → LLM 调用 `edit_file` → 实际写入文件 → diff 显示
- [ ] 发"跑 npm test" → LLM 调用 `bash` → 输出在 UI → 用户中途点 Stop → 真的中断
- [ ] session 重启后历史完整恢复（messages + tool calls + tool results）

---

## ⚪ v0.5 · Memory 系统

### 必做项

| # | 项 | spec | 验收 |
|---|---|---|---|
| 1 | 项目级 memory（`./AGENTS.md` 类似 Pi Agent 机制）| [memory.md](03-features/memory.md) | 每个 workspace 自己的 memory 文件 |
| 2 | 用户级 memory（`%APPDATA%\com.piagent.desktop\memory.md`）| [memory.md](03-features/memory.md) | 跨项目生效 |
| 3 | 自动从对话提取要点（"记住这个" / "以后别这样"）| [memory.md](03-features/memory.md) | 用户说一次就记住 |
| 4 | Memory 编辑器（settings tab）| [memory.md](03-features/memory.md) | 用户能手动增删改 |
| 5 | Memory 在 system prompt 注入（已有 workspace prompt 机制扩展）| [memory.md](03-features/memory.md) | LLM 知道 user preferences / project context |

---

## ⚪ v0.6 · Skills + MCP

### 必做项

| # | 项 | spec | 验收 |
|---|---|---|---|
| 1 | Slash command（`/help` `/clear` `/model` `/commit` 等）| [skills.md](03-features/skills.md) | 至少 10 个内置 command |
| 2 | 用户自定义 slash command（`.claude/commands/*.md` 类似）| [skills.md](03-features/skills.md) | Markdown + frontmatter 加载 |
| 3 | Skills 包（带 description / when-to-use 触发条件）| [skills.md](03-features/skills.md) | 跟 Claude Skills 兼容 |
| 4 | MCP server 接入（stdio transport）| [mcp.md](03-features/mcp.md) | 配 mcp.json 就能用 |
| 5 | MCP 工具在 tool call 列表里出现 | [mcp.md](03-features/mcp.md) | LLM 能调用 MCP 暴露的工具 |
| 6 | 插件市场 UI（v1 可不做，先支持本地 / git 加载）| [mcp.md](03-features/mcp.md) | 从 git URL 装插件 |

---

## ⚪ v0.7 · Subagent + Plan Mode

### 必做项

| # | 项 | spec | 验收 |
|---|---|---|---|
| 1 | Plan mode（先输出计划 → 用户 approve → 执行）| [subagent.md](03-features/subagent.md) | 类似 Claude Code 的 ExitPlanMode |
| 2 | Subagent 委派（主 agent 调子 agent 跑独立任务）| [subagent.md](03-features/subagent.md) | 类似 Claude Code 的 Task 工具 |
| 3 | Agent profile（不同 agent 配不同 system prompt / tools）| [subagent.md](03-features/subagent.md) | settings 里能选 agent |

---

## ⚪ v0.8 · 协作 / 分享

### 必做项

| # | 项 | spec | 验收 |
|---|---|---|---|
| 1 | Session 导出（Markdown / JSON / 完整含 tool calls）| [sharing.md](03-features/sharing.md) | 一键导出到剪贴板 / 文件 |
| 2 | Session 分享链接（加密 + 过期）| [sharing.md](03-features/sharing.md) | 跟 Claude Artifacts 类似 |
| 3 | 团队空间（如 B 端需要，待定）| [sharing.md](03-features/sharing.md) | spec 待商业化方案确定后写 |

---

## ⚪ v0.9 · 跨平台

### 必做项

| # | 项 | spec | 验收 |
|---|---|---|---|
| 1 | macOS 适配（Dock / Menu Bar / 全局快捷键）| [platform.md](03-features/platform.md) | Tauri 2 macOS target 编译通过 + 真机测 |
| 2 | Linux 适配（AppImage / deb）| [platform.md](03-features/platform.md) | Ubuntu 22.04 + Fedora 测 |
| 3 | Web 版本（如需要，存疑）| [platform.md](03-features/platform.md) | 决策：是否值得做（v0.2 形态的回归）|

---

## 🎯 v1.0 · 稳定版

### 必做项

| # | 项 | spec | 验收 |
|---|---|---|---|
| 1 | 自动更新（`tauri-plugin-updater`）| [desktop.md](03-features/desktop.md) | 用户收到新版本提示 → 静默下载 → 下次启动安装 |
| 2 | 完整用户文档（`docs/user-guide/`）| [README.md](README.md) | 新用户 5 分钟上手 |
| 3 | Crash report（`tauri-plugin-sentry` 或自实现）| [observability.md](03-features/observability.md) | 崩溃自动上报（用户 opt-in）|
| 4 | 性能审计（启动 / 内存 / CPU）| [01-architecture.md](01-architecture.md) | 满足 [性能预算](01-architecture.md#9-性能预算) |
| 5 | 完整 E2E 测试覆盖（Playwright + Tauri）| [observability.md](03-features/observability.md) | 核心 flow 100% 覆盖 |
| 6 | 安全审计（key / tool / network）| [security.md](03-features/security.md) | 第三方安全 review |
| 7 | README + LICENSE + 官网 ready | — | 开源发布 |

---

## 不在 roadmap（明确不做）

- ❌ 移动端（iOS / Android）— v2.0+ 再说
- ❌ 浏览器插件 — v2.0+ 再说
- ❌ 多模态生成为主入口 — 不做（可作为扩展 tool）
- ❌ 账号 / 社交 / feed — 不做
- ❌ 强制更新 — 不做
- ❌ Bundle IDE — 不抢 VSCode 饭碗
