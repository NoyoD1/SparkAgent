# ADR-0008: Tool permission 3 模式 (ask / smart / allow)

- **状态**: Accepted
- **日期**: 2026-08-17 (v0.4.1 引入), 2026-08-18 (v0.5.0-D 第 2 轮加 workspace 沙箱)
- **决策者**: user
- **Relates to**: [0005-pi-sdk-integration](0005-pi-sdk-integration.md), [0006-rpc-mode-migration](0006-rpc-mode-migration.md)

## 背景

LLM 调 tool (read / write / edit / bash / ls / find / grep) 时, 哪些要用户确认? 哪些自动放行?

风险: 不确认 → LLM 误删 / 改系统文件. 全确认 → 体验差 (每个 read 都弹).

## 备选

- **A. 3 模式 (ask / smart / allow) + Pi SDK Extension API + workspace 沙箱** — 选这个
- B. 全 ask — 太安全, 体验差
- C. 全 allow — 太危险
- D. 白名单/黑名单 — 灵活但配置负担大

## 决策

**3 模式** (`configStore.permissionMode`):
- `ask` (默认): 每个 tool call 显式 confirm
- `smart`: 读类 (`read` / `ls` / `find` / `grep`) 自动放行, 写类 (`write` / `edit`) + `bash` 弹 confirm
- `allow`: 全部自动放行 (最危险, 默认不推荐)

**实现** (Pi SDK Extension API):

```js
const permissionExtension = (pi) => {
  pi.on("tool_call", async (event, ctx) => {
    const { toolName, toolCallId, input } = event;
    if (mode === 'ask' || shouldAsk(toolName, mode)) {
      const ok = await requestUserConfirm({ toolName, input });
      if (!ok) return { block: true, reason: 'user denied' };
    }
    return {}; // 放行
  });
};

const loader = new DefaultResourceLoader({
  cwd, agentDir,
  extensionFactories: [{
    name: 'pi-agent-permission',
    factory: permissionExtension,
    hidden: true,
  }],
});
```

**Workspace 沙箱** (v0.5.0-D 第 2 轮, 写在同一个 Extension 里):
- `write` / `edit` 工具的 path 必须在 `workspacePath` 之下, 否则 block
- `bash` 工具无法静态检查, 由 permission 弹窗兜底 (用户看 command string 确认)
- `read` / `ls` / `find` / `grep` 不强制 (允许跨目录查询)
- 防 LLM 误把文件写到 Pi Agent Desktop 自身目录 (user 反馈 "agent 把桌面端程序给改掉了")

**Path 校验** (`isPathWithinWorkspace`):
- 把 filePath 跟 workspacePath 都 resolve 成绝对路径
- Windows 大小写不敏感 + 反斜杠统一转 `/`
- 防 prefix 误判: workspace=`D:\work`, filePath=`D:\workspace-evil\foo.txt` → reject (用 `startsWith(w + '/')` 防 prefix 误判)

## 后果

- ✅ 风险/体验平衡: smart 模式 80% 自动 + 20% 关键操作 confirm
- ✅ Pi SDK Extension API 自动桥接 (AgentSession 内部 `agent.beforeToolCall = runner.emitToolCall`)
- ✅ Workspace 沙箱防 LLM 误改客户端自身目录
- ❌ `bash` 静态分析做不到, 依赖用户看 command (体验瓶颈)
- ❌ `smart` 模式的"读 vs 写"分类 hardcoded, 改模式要改代码
- ❌ Permission 弹窗在某些 provider 上偶发 lost (类似 Stop 按钮的 abort lost 问题)

## 何时 Revisit

- 出现"频繁弹窗打扰"反馈 → 加 per-tool remember decision
- `smart` 模式分类争议 → 重新评估分类
- 沙箱误判频繁 → 评估 path canonicalization
- Pi SDK 0.85+ 暴露更稳定 Extension API → 评估
