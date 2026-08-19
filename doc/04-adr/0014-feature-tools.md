# ADR-0014: Tools 模块 (7 tool / 3 模式 permission / 沙箱)

- **状态**: Accepted
- **日期**: 2026-08-19
- **Type**: Functional
- **Module**: Tools
- **决策者**: user
- **Relates to**: [0008-tool-permission](0008-tool-permission.md) (技术实现)

## 功能定义 (应该做什么)

- ✅ 7 内置 tool: read / write / edit / bash / ls / find / grep
- ✅ 3 模式 permission: ask (每次确认) / smart (读自动) / allow (全放行)
- ✅ Permission 弹窗 (in-app, 贴 Composer 顶)
- ✅ Workspace 沙箱 (write / edit 限 workspacePath 内)
- ✅ Pi SDK Extension API 接管
- ✅ Runtime 切换 mode (不需重启 sidecar)
- 🟡 Per-tool remember decision
- ❌ 自定义 tool 注册
- ❌ MCP 集成
- ❌ Tool 模板 / 分享

## 已实现 (v0.5.9+)

### 7 内置 tool

| Tool | 说明 | 状态 | 核验 |
|---|---|---|---|
| `read` | 读文件 | ✅ | "读 README.md" 触发, 返回文件内容 |
| `write` | 写文件 | ✅ | "写 hello.js" 触发, 文件创建 |
| `edit` | 编辑文件 | ✅ | "把 README.md 标题改成 X" 触发, 看 diff |
| `bash` | 跑命令 | ✅ | "跑 npm install" 触发, 看命令输出 |
| `ls` | 列目录 | ✅ | "列 workspace 文件" 触发, 返回文件列表 |
| `find` | 按名找 | ✅ | "找所有 .ts 文件" 触发, 返回路径列表 |
| `grep` | 按内容搜 | ✅ | "grep TODO" 触发, 返回匹配行 |

### 3 模式 permission

| 模式 | 默认 | 行为 | 核验 |
|---|---|---|---|
| `ask` | ✅ 默认 | 每个 tool call 显式 confirm | 切到 ask, 每次弹窗 |
| `smart` | ❌ | 读类自动放行, 写类 + bash 弹窗 | 切到 smart, read 不弹, write 弹 |
| `allow` | ❌ | 全部自动放行 | 切到 allow, 全不弹 (高风险) |

## 核验方法 (端到端)

### 7 tool 单独跑
1. 配一个 workspace, 走每个 tool
2. **read**: 读 README → 看返回内容
3. **write**: 写 hello.txt → 看文件创建
4. **edit**: 改 hello.txt → 看 diff
5. **bash**: 跑 `node -v` → 看返回
6. **ls**: 列目录 → 看返回
7. **find**: 按名找 → 看返回
8. **grep**: 搜内容 → 看返回

### 3 模式切换
1. 配 activeProvider 用 deepseek, 切 `ask` 模式
2. 触发 write tool → Permission 弹窗 → 确认 → 写成功
3. 切 `smart` 模式, 触发 read tool → 不弹 → 直接返回
4. 切 `smart` 模式, 触发 write tool → 弹窗
5. 切 `allow` 模式, 触发 write tool → 不弹 → 直接写 (注意风险)

### Workspace 沙箱
1. 切到 workspace A
2. 触发 write 到 A 内文件 → 成功
3. 触发 write 到 A 外文件 → Permission 弹窗, 拒绝 (沙箱 block)
4. 看弹窗 reason: `Path "..." is outside the active workspace "..."`

### Runtime mode 切换
1. 跑流式, 中途切 mode
2. 验证下一个 tool call 走新 mode (不需要重启)

## 已知问题 / 技术债

- 🟡 **Permission 弹窗偶发 lost**: 类似 Stop abort lost, 某些 provider 上没 emit extension_ui_response
- 🟡 **`smart` 分类 hardcoded**: 改分类要改代码
- 🟡 **没 per-tool remember**: 每次都弹, 体验瓶颈
- 🟡 **bash 静态分析做不到**: 只能让用户看 command string
- 🟡 **tool 错误信息有时被 sanitize**: 401/403 sanitize 后 user 看不到具体错误

## 后续规划

### P0 (v0.6)
- Permission 弹窗 lost 根因排查
- per-tool "session 内 remember" 选项 (弹窗加 "本次 session 不再问" 复选框)

### P1 (v0.6 - v0.7)
- 自定义 tool (用户写 .ts 工具)
- Tool 模板

### P2 (v0.7+)
- MCP 集成
- Tool 分享
