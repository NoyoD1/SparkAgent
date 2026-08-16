# 03 · 功能维度索引 (Features)

> **14 个功能维度，每个一个 md**。每个 md 含：spec 定义 / 当前状态 / changelog / 待办。

## 索引

| # | 维度 | 状态 | 文档 | 一句话 |
|---|---|---|---|---|
| 1 | **Chat 核心** | 🟡 80% | [chat-core.md](chat-core.md) | 流式 / Markdown / 思考 / 工具展示 |
| 2 | **Session 管理** | 🟡 70% | [session.md](session.md) | 列表 / 切换 / 持久化 / 搜索 |
| 3 | **Provider / 模型 / BYOK** | ✅ 90% | [provider.md](provider.md) | 多 LLM / 自定义 / keychain |
| 4 | **Workspace** | 🟡 40% | [workspace.md](workspace.md) | 多工作区 / 文件树 / 上下文 |
| 5 | **Tools** | 🟡 30% | [tools.md](tools.md) | tool call / 内置工具 / 权限 |
| 6 | **Memory** | ❌ 0% | [memory.md](memory.md) | 跨会话 / 项目级 / 用户级 |
| 7 | **Skills / Slash Command** | ❌ 0% | [skills.md](skills.md) | 自定义指令 / 命令 |
| 8 | **MCP / 插件** | ❌ 0% | [mcp.md](mcp.md) | 第三方工具协议 |
| 9 | **Subagent / Plan** | ❌ 0% | [subagent.md](subagent.md) | 多 agent / Plan mode |
| 10 | **UI / 主题** | ✅ 90% | [ui.md](ui.md) | Light/Dark/Auto + 字体 |
| 11 | **Desktop 集成** | 🟡 50% | [desktop.md](desktop.md) | Tauri / 窗口 / 托盘 / 快捷键 |
| 12 | **安全** | 🟡 60% | [security.md](security.md) | key 加密 / 错误脱敏 / 沙箱 |
| 13 | **可观测性** | ❌ 10% | [observability.md](observability.md) | 日志 / 监控 / crash |
| 14 | **协作 / 分享** | ❌ 0% | [sharing.md](sharing.md) | session 导出 / 分享 |
| 15 | **多平台** | ❌ 0% | [platform.md](platform.md) | macOS / Linux / Web |

> **总进度** = ✅ 2 / 🟡 7 / ❌ 6 → 约 38% 已落地。

## 怎么更新

每个 md 文件的固定结构：

```markdown
# <维度名>

> 状态: ✅ / 🟡 / ❌
> 最后更新: YYYY-MM-DD

## 1. Spec（功能定义）
... 写清楚这个功能做什么 / 边界 / 不做什么

## 2. 当前实现
... 哪些已经做 / 在哪些文件

## 3. 已知问题 / 限制
... 当前有什么 bug / 没覆盖的 edge case

## 4. 待办（Roadmap）
- [ ] TODO 1
- [ ] TODO 2

## 5. Changelog
- 2026-08-16 · v0.3.8.x · 改了 XX
- 2026-08-15 · ...
```

**更新规则**：
- 改完代码后 → 同步改 spec 内"当前实现" + 加 changelog 行
- 状态变化（🟡 → ✅ 或 ❌ → 🟡）→ 同步更新 `00-product-blueprint.md` 总表
- 新增 TODO → 写进"待办"，优先级标 P0/P1/P2
