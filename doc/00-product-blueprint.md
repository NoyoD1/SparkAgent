# 00 · 产品蓝图 (Product Blueprint)

> 一句话：**Pi Agent = 本地优先 + BYOK + 桌面优先的 AI Agent 客户端**。基于 `earendil-works/pi` agent 框架的极简理念，落地到商用产品形态。

---

## 1. 一句话定位

**给开发者 / 技术从业者的本地 AI Agent 桌面端**。你出 API key（BYOK），我们出 UI / 工具 / 记忆 / 扩展能力。数据全部在你本机，key 不出本机。

---

## 2. 用户画像

| 类型 | 占比 | 核心需求 | Pi Agent 怎么答 |
|---|---|---|---|
| **开发者（主力）** | ~70% | 写代码 / 改文件 / 跑命令 / 调试 | BYOK 桌面端 + tool call + workspace 上下文 |
| **技术写作者 / 文档** | ~15% | 长文写作 / 整理 / 翻译 | Markdown 渲染好 + session 持久化 + 文件工具 |
| **产品 / 设计 / 运营** | ~10% | 整理需求 / 写方案 / 数据分析 | 多模型切换 + 历史会话 + 导出 |
| **研究 / 学习** | ~5% | 跨 session 知识积累 / 文献阅读 | 计划中：memory 系统 + 知识库 |

**不做**：
- 纯 C 端 chat 体验（不是 ChatGPT 替代品）
- 企业内网 / SSO / 审计（v1.x 不考虑）
- 多模态生成（图 / 视频 / 语音）作为核心入口（可作为扩展）
- 移动端（v1.x 不考虑）

---

## 3. 跟竞品差异化

| 维度 | Pi Agent | Claude Code | OpenAI Codex | Trae Work | MiniMax Code |
|---|---|---|---|---|---|
| **部署形态** | 桌面 app（Tauri） | CLI + IDE 插件 | Web + CLI | 桌面 app | IDE 插件 |
| **API Key** | **BYOK**（OS keychain） | Anthropic 官方 | OpenAI 官方 | 代理 | 内部 |
| **模型支持** | 7+ 内置 + 任意 OpenAI-compatible | Anthropic | OpenAI | 多 provider | 内部 |
| **价格** | 免费（你出 key） | 订阅 $20/月 | 订阅 $20/月 | 免费 + Pro | 内部 |
| **网络要求** | 仅 LLM API 流量 | 全程 | 全程 | 全程 | 全程 |
| **Tool / 文件** | 计划 v0.4 | 完整 | 完整 | 完整 | 完整 |
| **多 agent / subagent** | 计划 v0.7 | 有（Task 工具） | 部分 | 部分 | 完整 |
| **记忆系统** | 计划 v0.5 | 有（CLAUDE.md） | 有 | 有 | 有 |
| **MCP / 插件** | 计划 v0.6 | 有 | 有 | 有 | 有 |
| **数据归属** | **本机** | Anthropic 云 | OpenAI 云 | Trae 云 | MiniMax 云 |
| **可审计 / 可修改** | **完全开源** | 否 | 否 | 否 | 否 |

**Pi Agent 的护城河** = **本地 + BYOK + 开源**。对数据敏感 / 自带 key / 想自己改工具的开发者，是唯一选择。

---

## 4. 核心产品原则

1. **本地优先** — 不依赖任何云服务（除 LLM API 调用）。session / 配置 / key / 记忆全部本机
2. **BYOK (Bring Your Own Key)** — API key 走 OS keychain，**绝不**进 localStorage / WS 协议 / 日志 / 错误信息
3. **极简 (Minimalist)** — Minimalist Copy 设计系统，monochrome + 12px radius + border-driven，**不**堆功能
4. **可扩展** — 后续 MCP / Skills / Plugin 体系，**不**把所有功能硬塞进主程序
5. **可审计** — 关键路径（key 处理、tool call sandbox、prompt 构造）代码必须 review 友好，写明"为什么这么写"

---

## 5. 14 维度功能状态总表

> **每行对应 `03-features/<name>.md` 一个 spec。点击查看 spec + changelog。**

| # | 维度 | 状态 | 进度 | spec |
|---|---|---|---|---|
| 1 | Chat 核心（流式 / Markdown / 思考 / 工具展示） | 🟡 | 80% | [→](03-features/chat-core.md) |
| 2 | Session 管理（列表 / 切换 / 持久化） | 🟡 | 70% | [→](03-features/session.md) |
| 3 | Provider / 模型 / BYOK | ✅ | 90% | [→](03-features/provider.md) |
| 4 | Workspace（多工作区 / 文件树 / 上下文） | 🟡 | 40% | [→](03-features/workspace.md) |
| 5 | Tools（tool call / 内置工具 / 权限） | 🟡 | 30% | [→](03-features/tools.md) |
| 6 | Memory（跨会话记忆 / 项目级 / 用户级） | ❌ | 0% | [→](03-features/memory.md) |
| 7 | Skills / Slash Command | ❌ | 0% | [→](03-features/skills.md) |
| 8 | MCP / 插件市场 | ❌ | 0% | [→](03-features/mcp.md) |
| 9 | Subagent / Plan Mode | ❌ | 0% | [→](03-features/subagent.md) |
| 10 | UI / 主题（Light/Dark/Auto + 字体） | ✅ | 90% | [→](03-features/ui.md) |
| 11 | Desktop 集成（Tauri / 窗口 / 托盘 / 快捷键） | 🟡 | 50% | [→](03-features/desktop.md) |
| 12 | 安全（key 加密 / 错误脱敏 / 沙箱） | 🟡 | 60% | [→](03-features/security.md) |
| 13 | 可观测性（日志 / 监控 / crash report） | ❌ | 10% | [→](03-features/observability.md) |
| 14 | 协作 / 分享 | ❌ | 0% | [→](03-features/sharing.md) |
| 15 | 多平台（macOS / Linux / Web） | ❌ | 0% | [→](03-features/platform.md) |

**总进度估算**：约 38%。

---

## 6. 路线图概要

> 详细见 [02-roadmap.md](02-roadmap.md)

| Phase | 主题 | 关键交付 | 状态 |
|---|---|---|---|
| v0.1 - v0.2 | 骨架 | Web form + 多 provider BYOK + 流式 | ✅ |
| v0.3 | Tauri 化 | 桌面 app + OS keychain + Node sidecar | ✅ |
| v0.3.5 - v0.3.8.27 | UX Polish | 布局 / 主题 / 折叠 / 字体 / 设计系统 | ✅ |
| **v0.4** | **Tool Call 真正落地** | 文件读/写 / shell 执行 / 权限确认 | 🟡 进行中 |
| v0.5 | Memory | 跨会话 / 项目级 / 自动提取 | ❌ |
| v0.6 | Skills + MCP | 自定义指令 + MCP server 接入 | ❌ |
| v0.7 | Subagent / Plan | 多 agent 切换 / Plan 模式 | ❌ |
| v0.8 | 协作 / 分享 | session 导出 / 团队空间（如果做） | ❌ |
| v0.9 | 跨平台 | macOS / Linux 适配 | ❌ |
| **v1.0** | **稳定版** | 自动更新 + 完整文档 + 用户指南 | ❌ |

---

## 7. 商业化（待定）

> **用户已决策**：**每客户独立部署一套 server (C 方案, 2026-07-23)**。
> 这部分**待用户拍板后**补 spec 章节。

可能的商业化方向（**仅供讨论，未承诺**）：
- B 端：每个企业客户一份独立 server + 我们运维
- 渠道：插件市场抽成 / Skills 模板付费
- 服务：企业部署 + 定制集成 + 培训

**不算商业化**：
- 收集用户数据
- 在 LLM API 调用里加收成
- 强制账号注册

---

## 8. 不做什么（anti-feature）

明确写出来避免后续被反复提议：

- ❌ **不做**云同步 session / 配置（数据本机第一原则）
- ❌ **不做**账号系统（除非商业化方案明确要求）
- ❌ **不做**多模态生成为主入口（图 / 视频是扩展，不是核心）
- ❌ **不做**移动端（v1.x）
- ❌ **不做**社交功能（点赞 / 关注 / feed）
- ❌ **不做**账户余额 / 付费 token（API key 是用户的）
- ❌ **不做**强制更新（用户拒绝更新仍可用旧版）
- ❌ **不做**捆绑 IDE（不抢 VSCode / JetBrains 饭碗）

---

## 9. 名词表

| 术语 | 含义 |
|---|---|
| **Agent** | 在本 app 里指"一次 LLM 调用 + 工具循环"，**不**指长期存活的 daemon |
| **Session** | 一个完整对话 + 历史 messages，持久化到本机 |
| **Workspace** | 用户指定的工作目录，agent 知道 cwd |
| **Provider** | LLM 服务商（Anthropic / OpenAI / 自定义 OpenAI-compatible） |
| **BYOK** | Bring Your Own Key，API key 由用户提供，不经我们 |
| **Tool Call** | LLM 触发调用本地工具（读文件 / 跑命令 / 搜索） |
| **MCP** | Model Context Protocol，第三方工具标准化协议 |
| **Subagent** | 主 agent 委派给子 agent 的子任务 |
| **Plan Mode** | 先输出计划，等用户确认再执行的模式 |
