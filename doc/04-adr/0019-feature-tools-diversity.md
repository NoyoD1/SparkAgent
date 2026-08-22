# ADR-0019: Tools 多样性扩展 (联网 / 沙箱 / 交互 / 子代理 / 多模态) roadmap

- **状态**: Accepted (2026-08-23 拍板, 待执行)
- **日期**: 2026-08-23
- **Type**: Functional / Roadmap
- **Module**: Tools (extension)
- **决策者**: user
- **Relates to**: [0014-feature-tools](0014-feature-tools.md) (父 ADR, 7 内置 tool), [0018-feature-mcp](0018-feature-mcp.md) (MCP 扩展, 同 Pi SDK customTools 接入点), [0008-tool-permission](0008-tool-permission.md) (permission 模式)

## 背景

Pi Agent Desktop v0.6.3-rc1 已拉通 LLM 配置 / Skill / MCP / userSendMessage + llmRecover 闭环,
但 **tools 多样性不足**——LLM 只能"在本地 workspace 里读写文件 + 跑 bash", 缺联网 / 交互 / 子代理 / 多模态等关键能力.
用户明确痛点:

1. **bash 用不了** (在 Windows 上跑不起来)
2. **缺联网搜索 / 内容获取** (LLM 训练先验过时, 无法动态取新信息)
3. **沙箱权限没完全做好** (write/edit 限 workspace 内, 但 bash 是进程级, 能突破沙箱)
4. **tools 多样性不足** (7 内置 + 派生 + MCP 仍覆盖不到 6 大维度: 联网 / 交互 / 任务管理 / 记忆 / 多模态 / 子代理)

## 现状摘要 (v0.6.3-rc1)

### 已实现 (作为基线)

| 能力 | 落地形式 | 位置 |
|---|---|---|
| 7 内置 tool | read / write / edit / bash / ls / find / grep | Pi SDK 0.84.2 (`pi-sdk/packages/coding-agent/src/core/tools/`) |
| User tool 派生 | builtin + preset args 模板, JSON 文件存 | `app/src/stores/userTools.ts` + ToolsTab |
| MCP 集成 | stdio / http / sse transport, 复杂 schema, 热重载 | `sidecar/src/mcpClient.mjs` + index.mjs |
| Skills | hot reload + Unicode + permission | `app/src/stores/skills.ts` |
| Slash command | 3 类资源 (skill/tool/MCP) + @ 引用 + force-read + chip | D214 v1~v8.2 |
| Permission 3 模式 | ask / smart / allow | 0008-tool-permission |
| 沙箱 (write/edit) | workspacePath 限定 | sidecar |
| Tool 错误 sanitize | 401/403/429/5xx 分类 | `sidecar/src/errorSanitizer.mjs` (P2-6) |

### 7 内置 tool 详单 (确认 user "8 个" 的偏差)

- 实际只有 7 个: `read` / `write` / `edit` / `bash` / `ls` / `find` / `grep`
- 第 8 个可能是某次派生的 user tool, 不影响本 roadmap

### 痛点根因 (2026-08-23 user 确认)

1. **bash "用不了"**: 实际是 **auto-discovery 太窄 + sidecar 没传 shellPath**
   - Pi SDK 0.84.2 `shell.ts:67-107` 只搜 `%ProgramFiles%\Git\bin\bash.exe` + `%ProgramFiles(x86)%\Git\bin\bash.exe` + `where bash.exe`
   - **miss 场景**: Git for Windows 用户级安装 (`%LOCALAPPDATA%\Programs\Git\bin\bash.exe`, 新版默认), 走 `where bash.exe` 时 sidecar 进程 PATH 也没继承到
   - 兜底救场也缺: `sidecar/src/index.mjs:782` `createBashToolDefinition(cwdResolved)` **没传 `shellPath` 选项**, user 在 settings 写了路径也接不住
   - **根因不是 shell 跑不起来, 是发现机制覆盖不全 + 缺 user override UI**
2. **没联网**: Pi SDK 0.84.2 无 `web_search` / `web_fetch` 内置; project 端也没包装
3. **沙箱不完整**: bash 走进程级, 不受 workspace 限定, 能执行任意 shell 命令

## 功能定义 (应该做什么) — 按优先级分 P0/P1/P2

### P0 — 必修 (blocker, 必须先做)

#### P0-1 修通 bash (dedicated bash entry, 手动填为主 + 自动检测辅助)

**根因复述 (2026-08-23 user 确认)**: 
- Pi SDK 自带 search 太窄 (3 个路径 + PATH), miss user-scope Git for Windows 安装
- 即使扩搜索列表, **user 装在非常规路径 (e.g. `D:\DevTools\Git\bin\bash.exe`) 仍然 cover 不到**
- sidecar 也没把 shellPath 传给 bash tool
- **正解: bash 单独开一个 entry, user 手填是 source of truth, 自动检测只是填表辅助**

**架构原则 (user 拍板 2026-08-23)**:
- bash 是 Pi Agent 关键依赖 (所有 tool 假设 bash 语法), 应该有**专属配置入口**, 不藏在通用 shell 检测里
- **Source of truth = `settings.bash.path` 字段**, **自动检测 + 用户手动** 都是合法写入路径
  - 区别只在 UI 表现 (手动是 input, 自动检测是 button + 候选列表), 落盘都是同一个字段同一套 validate
  - `source` 字段记写入来源 ('auto' | 'manual'), 排查用, 不影响行为
- 自动检测覆盖不全 (e.g. `D:\DevTools\Git\bin\bash.exe` 非常规路径), 所以**手填必须是一等公民**, 不是"高级选项"
- 没 `bash.path` → fallback Pi SDK 自带 search (3 路径 + PATH, 跟现状一致)

**修法 (5 个 component)**:

1. **settings.json 单独 `bash` 字段** (写到 `~/.pi/agent/settings.json`) — **source of truth**
   ```json
   {
     "bash": {
       "path": "D:\\DevTools\\Git\\bin\\bash.exe",
       "source": "manual",                    // 'manual' | 'auto' (排查用, 不影响行为)
       "lastVerified": "2026-08-23T02:30:00Z", // 上次跑 bash --version 成功时间
       "version": "5.2.21"                     // 验证时记录
     }
   }
   ```
   - 不跟 `shell` 字段混 (shell 留作 P2 fallback, 暂不实现)
   - 跟 `compaction.enabled` 同文件, 走同一套 Tauri 读写 helper
   - **写入路径 1 (auto)**: 启动时静默 run detect_bash_candidates, 1+ 候选 → 取第一个 + source="auto" 写下去
   - **写入路径 2 (manual)**: UI 输入框 on-blur validate 通过 → source="manual" 写下去 (覆盖 auto)
   - **写入路径 3 (manual from auto list)**: UI 点候选 → 填入 input → 走 on-blur, source="auto"

2. **Tauri Rust 新增 4 command** (放 `src-tauri/src/lib.rs`)
   - `get_bash_config()` → 读 settings.json 的 `bash` 字段
   - `set_bash_config({ path, source })` → 校验 exists + 跑 `<path> --version` 拿 version → 写 settings.json
   - `detect_bash_candidates()` → PATH + Git for Windows 注册表 + 常见位置 + WSL, 过滤 shell_type ∈ {bash, wsl}
   - `verify_bash_path(path)` → 单独给"测试"按钮用, 跑 `<path> --version` 返回 { ok, version, error }
   - `clear_bash_config()` → 删 `bash` 字段, 下次启动 fallback

3. **FE: General tab 新增 "Bash 路径" section** (置顶, 紧挨 auto-compaction toggle)
   ```
   ┌─ Bash 路径 ────────────────────────────────┐
   │  [D:\DevTools\Git\bin\bash.exe        ]   │
   │  状态: ✓ v5.2.21 (上次验证 5 分钟前)       │
   │  来源: 手动                                │
   │                                            │
   │  [🔍 自动检测]  [🧪 测试]  [↻ 清除]       │
   │                                            │
   │  自动检测结果:                              │
   │    • C:\Users\你\AppData\Local\Programs\Git│
   │    • C:\Program Files\Git\bin             │
   │    • (空 = 找不到)                        │
   └────────────────────────────────────────────┘
   ```
   - **输入框 on-blur** → 调 `set_bash_config` 立即校验 + 持久化 + source="manual" (覆盖 auto) + toast "已保存"
   - **自动检测按钮** → 调 `detect_bash_candidates` → 列候选 → user 点 → 填入 input → 走 on-blur, source="auto"
   - **测试按钮** → 调 `verify_bash_path` → 更新 lastVerified/version + 显示输出
   - **清除按钮** → 调 `clear_bash_config` → 下次启动 fallback Pi SDK search

4. **Sidecar 启动读 settings + 传给 bash tool** (改 `sidecar/src/index.mjs:782`)
   ```js
   bash: createBashToolDefinition(cwdResolved, { 
     shellPath: settings.bash?.path  // user/auto 填的, 没填 → undefined → Pi SDK 自带 search 兜底
   })
   ```
   - 启动 log 加 `bash shell: D:\DevTools\Git\bin\bash.exe (source=manual, version=5.2.21)`
   - 或: `bash shell: (unset, fallback to Pi SDK auto-discovery)`
   - shellPath 设了但文件不存在 → 不崩, stderr warning, fallback Pi SDK search

5. **0 候选 + user 没手填 兜底**
   - app 启动时调 detect_bash_candidates + 读 get_bash_config
   - 0 candidate + 没手填 → 弹一次性 toast: `未检测到 bash, 请安装 Git for Windows 或在 Settings → Bash 路径手动指定` + 跳官网按钮
   - bash tool 在 LLM 视角报错 (走 errorSanitizer): `[🔧 bash_not_found] 系统未安装 bash 或未在 Settings 配置路径, 请装 Git for Windows 或 Settings → Bash 路径手动指定`

**端到端核验**:
1. 装 Git for Windows 到非常规路径 (e.g. `D:\DevTools\Git\`) → 启 app
2. F12 应看到 toast "未检测到 bash" (auto-detect 找不到)
3. 进 Settings → Bash 路径, 粘贴 `D:\DevTools\Git\bin\bash.exe` → on-blur 立刻显示 "✓ v5.2.21"
4. 重启 app → 启 session, F12 看到 `[sidecar] bash shell: D:\DevTools\Git\bin\bash.exe (source=manual, version=5.2.21)`
5. 配 activeProvider, 跑 `node -v` → 返回 v24.16.0
6. 跑 `echo $PI_SESSION_ID` → 返回 session id
7. 跑 `ls -la` → 返回目录列表

#### P0-2 bash 沙箱 (补 P0-1 漏洞)

- **A 方案 (推荐, 最小修复)**: bash cwd 强制 = workspacePath, 跑外面走 permission 弹窗
- **B 方案 (中等)**: 配置 deny 列表 (`rm -rf` / `format` / 网下载执行) + 注入 `commandPrefix` (e.g. `set -euo pipefail` + 路径检查)
- **C 方案 (重)**: bash 跑在 Docker / WSL 容器, 跟主进程完全隔离
- 决策: 见 [决策点 Q2]
- **兼容 P0-1**: shell 可能是 bash / pwsh / wsl, cwd 限定通用; command syntax 检查需按 shell type 分支 (bash 走 POSIX, pwsh 走 PowerShell)

#### P0-3 联网 tool (`web_search` + `web_fetch`)

- **A 方案 (推荐)**: 自己包装, sidecar 内置两个 tool, key 存 keychain (Tauri settings 新增字段)
- **B 方案 (省事)**: 靠 MCP, 引导 user 装 `mcp-server-fetch` / Brave Search MCP server
- **C 方案 (保守)**: 不做联网, 强调本地 coding 工具 (跟 user 目标冲突, 不推荐)
- 决策: 见 [决策点 Q1]

### P1 — 核心扩展 (按 6 个维度展开, 每个维度独立可选)

#### 维度 1: 交互 (LLM 中途跟 user loop)

| Tool | 做什么 | 落地方式 |
|---|---|---|
| `ask_user` | LLM 中途向 user 提问 (多选/单选/自由文本) | 走 Pi SDK `extension_ui_request`, chat.ts:1655 当前只接 confirm, 需补 select/input/notify/editor |
| `plan_approval` | LLM 出方案让 user approve 再执行 | method=confirm 扩展 plan 模式 |
| `notify` | LLM 长任务中途回报进度 | method=notify 弹 toast |

**前置**: chat store 补 5 个 method handler

#### 维度 2: 任务管理 (持久 todo)

| Tool | 做什么 | 落地方式 |
|---|---|---|
| `todo_write` / `todo_read` | LLM 维护自己的 todo (任务拆解) | 本地 JSON `<workspace>/.pi/todos/<sessionId>.json` |
| `task_status` | 看后台任务状态 | 复用 chat store 现有 step 折叠 |

#### 维度 3: 记忆 / 状态 (跨 session)

| Tool | 做什么 | 落地方式 |
|---|---|---|
| `memory_write` / `memory_read` | 跨 session 持久记忆 | `<agentDir>/memory/<key>.md`, FE Memory tab |
| `session_list` / `session_read` | LLM 调历史 session | 走 chat store, FE 端已有 sessions 列表 |
| `agent_rules_read` | 读 `AGENTS.md` | v0.6.3-rc1 已实现, 挂个 tool wrapper |

#### 维度 4: 多模态 / 文档

| Tool | 做什么 | 落地方式 |
|---|---|---|
| `image_read` | OCR / 看图 | 走 activeProvider vision API |
| `pdf_read` | 读 PDF | 走 pdf skill (已有) |
| `docx_read` / `xlsx_read` | 读 Office | 走 docx/xlsx skill (已有 skill 框架) |
| `image_generate` | 文生图 | 走 DALL-E / Stability / Replicate, key 存 keychain |

**通用机制**: 走 `MEDIA_PROVIDER` 配置项决定用哪个, 跟现有 `PROVIDER` 模式一致 (不硬编码)

#### 维度 5: 子代理 / 委托

| Tool | 做什么 | 落地方式 |
|---|---|---|
| `task` | 派 sub-agent 跑子任务 | 复用 Pi SDK agent session fork |
| `explore` | 只读调查 (read/grep/find/ls 限定) | 同上, tool 白名单窄 |
| `verify` | 验证 LLM 之前的产出 | 跟 verifier mavis 角色对齐 |

**价值**: 长任务可拆 / 可并行 / 可验证, 跟"分阶段但一鼓作气"风格一致

#### 维度 6: 代码 / 仓库

| Tool | 做什么 | 落地方式 |
|---|---|---|
| `git_status` / `git_diff` / `git_log` | 结构化 git | wrap `simple-git` 依赖 |
| `git_commit` / `git_push` | 同上 | 同上 |
| `lint` / `test` / `build` | 跑项目命令 | preset list (npm test / cargo test / pytest 等) |
| `pr_create` | 起 MR/PR | 走 GitLab/GitHub API (已有自建 GitLab) |

**不硬编码**: 项目类型自动检测 (`package.json` → npm, `Cargo.toml` → cargo)

### P2 — 进阶 (锦上添花, 不进 v0.7 排期)

| Tool | 价值 | 备注 |
|---|---|---|
| `datetime` / `cron_schedule` | 时间操作 | 跟 LLM 训练 cutoff 互补 |
| `calculator` / `unit_convert` | 数学 / 单位 | 大 LLM 算小数常错 |
| `json_query` / `yaml_query` / `sql_query` | 数据操作 | LLM 处理结构化数据 |
| `weather` / `location` | 实时数据 | 联网 tool 的特化 |
| `translate` | 翻译 | 多语言项目用 |
| `email` / `webhook` / `notification` (outbound) | 通知 | 跟 P1 维度 1 notify 不同, 是 outbound |

### 结构层改进 (横切, 影响所有 tool, 不增加 tool)

| ID | 改进 | 痛点 |
|---|---|---|
| S-1 | Per-tool Permission Remember (弹窗加"本次 session 不再问"复选框, 存 `<sessionId>/permission_memory.json`) | 每次都弹, 体验瓶颈 |
| S-2 | Tool Result Cache (web_fetch / read / grep 结果, key=hash(toolName+args), TTL 5min) | 重复请求浪费 |
| S-3 | Tool Call Budget (每 session 每 tool 限频, 默认 50/turn / 200/session, 超限弹窗) | 失控风险 |
| S-4 | Tool Schema 自动验证 (sidecar 解析 schema 给 LLM 详细错误, 跟 P2-6 错误 sanitize 联动) | LLM 自己看 error 重试 |
| S-5 | Tool Call Audit Log (写 `<workspace>/.pi/audit/<sessionId>.jsonl`, FE 开"工具执行历史"面板) | 调试 / 排查 |
| S-6 | Tool Composition 优化 (UI 表现: 并行/串行标记, 复用 step 折叠) | 已有但 UI 渲染补 |
| S-7 | Tool Marketplace / 模板 (ToolsTab 加导入/导出, 跨 workspace 复用) | 跟 user tool 派生联动 |

## 备选 / 关键决策 (2026-08-23 全部拍板)

### 决策点 Q1: 联网 tool 实现路径

- **A (推荐)**: 自己包装 — 少教育成本, key 走 Tauri keychain, sidecar 内置
- **B (省事)**: 靠 MCP — 少代码, 但 user 装 MCP 学习成本高, 缺 key 仍没法用
- **C (保守)**: 不做联网 — 跟 user 目标"动态自行获取联网内容"直接冲突

**拍板: A** (2026-08-23, 跟 0018 MCP 框架并存, 关键联网能力 self-host)

### 决策点 Q2: bash 沙箱粒度

- **A (推荐)**: 只限定 cwd — 最小修复, 跑外面走 permission
- **B**: deny 列表 + commandPrefix 注入 — 中等, 缺灵活性
- **C**: 完全容器化隔离 (Docker / WSL) — 最安全, Windows 部署复杂, 首次启动慢

**拍板: A** (2026-08-23, 跟 write/edit 的 workspace 沙箱一致)

### 决策点 Q3: 子代理 (维度 5) 做不做

- **A**: 做 (task / explore / verify) — 跟"分阶段但一鼓作气"风格一致
- **B**: 不做 — Pi SDK 0.84.2 fork 机制可能不成熟, 砍掉避免踩坑

**拍板: A** (2026-08-23, 跟"分阶段但一鼓作气"风格一致, 跟 user 主程多次表达的偏好对齐)

### 决策点 Q4: 一次性交付范围

- **A**: P0 全 + P1 一个维度 (一鼓作气, user 工作量最大)
- **B (推荐)**: P0 全 + P1 三个维度 (维度 1 交互 + 维度 2 任务管理 + 维度 3 记忆, 覆盖度足够)
- **C**: P0 全 + P1 六个维度 (跨度大, 长线)

**拍板: B** (2026-08-23, 阶段 1 P0-1 修通 bash 最先开干)

### 决策点 Q5: bash "用不了" 的具体现象 [已澄清 2026-08-23]

- 实际现象: sidecar 启动时 `createBashToolDefinition` 走 Pi SDK 自带 search → 3 个路径全 miss → 抛 `No bash shell found` → bash tool 在 LLM 视角不可用
- 根因: Git for Windows 用户级安装, 不在 Pi SDK 默认搜索范围 + `where bash.exe` 走 PATH 也 miss; 此外 user 装在非常规路径 (e.g. `D:\DevTools\Git\`) 扩搜索列表也 cover 不到
- 修法: 见 P0-1 5-component 方案 (dedicated bash entry + 手动填为主 + 自动检测辅助)

### 决策点 Q6 (新增): 首次启动 shell 选定的 UX

- **A (推荐)**: 静默 auto-pick recommended=true 的, 写 settings, 不弹窗 (跟"不打扰 user"原则一致)
- **B**: 弹一次性 onboarding dialog 展示候选列表让 user 确认 (透明, 但打断首次体验)
- **C**: 永远显示在 Settings tab, 不自动选, 等 user 自己来配 (最透明, 但新 user 不一定会去配)

**拍板: A** (2026-08-23, 静默写 settings, source="auto" 诚实记录; user 后续手填会覆盖, source 改 "manual")

### 决策点 Q7 (新增): shell 切换是否热生效

- **A (推荐)**: 写 settings → 提示"下次启动 sidecar 生效", 不热生效 (Pi SDK 0.84.2 不支持 mid-session 改 shellPath, 强做要重建 session 丢状态)
- **B**: 写 settings → 自动 kill 当前 sidecar + 重启 (保持状态困难, 不推荐)

**拍板: A** (2026-08-23, 保 session 状态)

## 端到端核验 (P0 三个, user 拍板后写)

### P0-1 修通 bash

1. sidecar 启动 log 应含 `[sidecar] detected shell: <X> (fallback order: bash → pwsh → cmd)`
2. 配 activeProvider, 跑 `node -v` → 返回 v24.16.0
3. 跑 `echo $PI_SESSION_ID` → 返回 session id (说明 PI_* env 注入成功)
4. 跑 `dir` (Windows cmd) 或 `ls -la` (bash) → 返回目录列表

### P0-2 bash 沙箱 (假设选 A)

1. 切到 workspace A, 跑 `pwd` → 应返回 A 路径
2. 跑 `cd ..` → 跑 `pwd` → 应弹 permission (跑出 workspace 边界)
3. deny 列表里的 `rm -rf /` → 弹 permission, 拒绝

### P0-3 联网 (假设选 A)

1. 配 Tauri settings → web search key (Tavily / Brave / SerpAPI)
2. 跑 `web_search("Pi Agent Desktop v0.6 release")` → 返回结果列表
3. 跑 `web_fetch("https://example.com")` → 返回 markdown 内容
4. keychain 验证: 重启 app, 不重新配, 仍能用

## 已知问题 / 技术债 (现状)

- ❌ bash 不能跑 (用户痛点, P0-1 必修, 根因已澄清 2026-08-23) → ✅ **P0-1 已修 (commit 0db984f)**
- ❌ 无联网 tool (P0-3 必修)
- 🟡 bash 沙箱不完整 (P0-2 部分修) → 只做了 cwd 限定 (settings.shellCommandPrefix), deny list 没做 (需要 Extension API, 留 P1)
- 🟡 Permission 弹窗偶发 lost (沿 0014 P0, 未修)
- 🟡 `smart` 分类 hardcoded (沿 0014 P1, 未修)
- 🟡 没 per-tool remember decision (沿 0014 P0, 未修, S-1 可解)
- 🟡 Tool Result 无 cache (S-2 待做)
- 🟡 Tool Call 无 budget (S-3 待做)
- 🟡 Tool Schema 错误信息粗 (S-4 待做, 跟 P2-6 联动)
- 🟡 Tool Call 无 audit log (S-5 待做)
- 🟡 Tool Composition UI 不明显 (S-6 待做)
- 🟡 无 Tool Marketplace (S-7 待做)

### 衍生技术债 (P0-1 落地时同步处理)

- 🟡 sidecar 没读 settings.json 的 `bash` 字段 (改 `sidecar/src/index.mjs:782`)
- 🟡 Tauri 端缺 `get_bash_config` / `set_bash_config` / `detect_bash_candidates` / `verify_bash_path` 4 个 command
- 🟡 FE 端 General tab 缺 Bash 路径 section (新增子组件, 跟 Compaction toggle 同级, 置顶)
- 🟡 errorSanitizer 缺 `bash_not_found` category (P2-6 已实现的 5 个 category 不含)
- 🟡 settings.json 读写 helper (跟 compaction.enabled 复用, 检查 lib.rs 现有 helper 是否通用)

## 后续规划

### 推荐路径 (Q1-A + Q2-A + Q3-A + Q4-B + Q6-A + Q7-A)

| 阶段 | 内容 | 估时 | 阻塞 |
|---|---|---|---|
| 阶段 1 | P0-1 (修通 bash, dedicated entry + 自动检测辅助) | 0.5-1 天 | 无 |
| 阶段 2 | P0-2A (bash 沙箱, cwd 限定) | 1-2 天 | 阶段 1 (先有 bash 跑得通, 再加沙箱) |
| 阶段 3 | P0-3A (联网 web_search + web_fetch) | 1 周 | Tauri keychain 配 key |
| 阶段 4 | P1 维度 1 (交互, ask_user + plan_approval + notify) | 1 周 | 阶段 1 后 chat store 5 method handler 改完 |
| 阶段 5 | P1 维度 2 (任务管理, todo_write/read + task_status) | 0.5 周 | 无 |
| 阶段 6 | P1 维度 3 (记忆 / 状态, memory + session_list + agent_rules) | 1 周 | 阶段 3 改完 (复用 settings/keychain 模式) |
| 阶段 7 | 结构层 S-1 ~ S-7 (按 user 优先级排序) | 2 周 | 横切, 阶段 1-6 任一阶段后并行 |
| 阶段 8 | P1 维度 4 / 5 / 6 (多模态 / 子代理 / 代码) | 2 周 | 阶段 6 完 |
| 阶段 9 | P2 全部 | 不排期 | v0.8+ |

**总估时**: ~8 周 (并行可压到 5 周)

## 待执行变更清单 (P0-1 阶段 1, 半天到一天)

> user 拍板"开干"后按此清单执行. 顺序按编译依赖排, 先 Rust 后 FE 最后 sidecar.

### 1. Rust 端 (`src-tauri/src/lib.rs`)

新增 5 个 Tauri command (跟 `get_compaction_enabled` / `set_compaction_enabled` 同 pattern, 写 `~/.pi/agent/settings.json`):

```rust
#[tauri::command]
async fn get_bash_config() -> Result<Option<BashConfig>, String>

#[tauri::command]
async fn set_bash_config(args: SetBashConfigArgs) -> Result<BashConfig, String>
// args = { path: String, source: String }  // source = "manual" | "auto"
// 内部: validate existsSync + spawn "<path> --version" 拿 version, 写 settings.json

#[tauri::command]
async fn detect_bash_candidates() -> Result<Vec<ShellInfo>, String>
// 4 段扫描: where PATH / Git for Windows 注册表 (HKLM + HKCU) / 6 个常见位置 stat / WSL 探测
// 过滤 shell_type ∈ {bash, wsl}, 按 bash > wsl 排序

#[tauri::command]
async fn verify_bash_path(path: String) -> Result<VerifyResult, String>
// 单独给"测试"按钮用, 跑 <path> --version
// 返回 { ok: bool, version: Option<String>, error: Option<String> }

#[tauri::command]
async fn clear_bash_config() -> Result<(), String>
// 删 settings.json 的 bash 字段
```

加 2 个 struct:

```rust
#[derive(Serialize, Deserialize, Clone)]
struct BashConfig {
    path: String,
    source: String,        // 'auto' | 'manual'
    last_verified: Option<String>,  // ISO 8601
    version: Option<String>,
}

#[derive(Serialize)]
struct ShellInfo {
    shell_type: String,    // 'bash' | 'wsl' | 'pwsh' | 'powershell'
    path: String,
    source: String,        // 'PATH' | 'registry' | 'common' | 'wsl'
    version: Option<String>,
}
```

注册到 `tauri::Builder::default().invoke_handler(...)` (跟现有 commands 平铺)。

### 2. FE 类型 + Tauri wrapper (`app/src/lib/tauri.ts`)

加 5 个 TS 函数 wrapper + 1 个 interface:

```ts
export interface TauriBashConfig {
  path: string;
  source: 'auto' | 'manual';
  lastVerified?: string;
  version?: string;
}

export interface TauriShellInfo {
  shellType: 'bash' | 'wsl' | 'pwsh' | 'powershell';
  path: string;
  source: 'PATH' | 'registry' | 'common' | 'wsl';
  version?: string;
}

export const piTauri = {
  // ... 现有
  getBashConfig: () => invoke<TauriBashConfig | null>('get_bash_config'),
  setBashConfig: (args: { path: string; source: 'auto' | 'manual' }) =>
    invoke<TauriBashConfig>('set_bash_config', { args }),
  detectBashCandidates: () => invoke<TauriShellInfo[]>('detect_bash_candidates'),
  verifyBashPath: (path: string) =>
    invoke<{ ok: boolean; version?: string; error?: string }>('verify_bash_path', { path }),
  clearBashConfig: () => invoke<void>('clear_bash_config'),
};
```

### 3. FE store (`app/src/stores/config.ts`)

加 `bashConfig` state + `detectBash` / `setBash` / `verifyBash` / `clearBash` 4 个 action (跟 `compactionEnabled` 同 pattern).

### 4. FE UI (`app/src/components/Settings/tabs/GeneralTab.vue`)

加 "Bash 路径" section, 置顶在 auto-compaction toggle 之前:

```
┌─ Bash 路径 ────────────────────────────────┐
│  [D:\DevTools\Git\bin\bash.exe        ]   │
│  状态: ✓ v5.2.21 (上次验证 5 分钟前)       │
│  来源: 手动                                │
│                                            │
│  [🔍 自动检测]  [🧪 测试]  [↻ 清除]       │
│                                            │
│  自动检测结果:                              │
│    • C:\Users\你\AppData\Local\Programs\Git│
│    • C:\Program Files\Git\bin             │
│    • (空 = 找不到)                        │
└────────────────────────────────────────────┘
```

行为:
- onMounted → `getBashConfig` (没设过 → null) + `detectBashCandidates` (列候选)
- 没设过 + 1+ 候选 → 静默 auto-pick 第一个 → `setBashConfig({ source: 'auto' })` → 不弹窗
- 没设过 + 0 候选 → 弹一次性 toast 引导去 Settings (不自动写)
- 输入框 on-blur → `setBashConfig({ source: 'manual' })` → 立即校验 + 持久化 + toast
- 点 [🔍 自动检测] → 重跑 `detectBashCandidates` + 重渲染列表
- 点候选 → 填入 input + 走 on-blur, source="auto"
- 点 [🧪 测试] → `verifyBashPath` → 更新 lastVerified/version + 显示输出
- 点 [↻ 清除] → `clearBashConfig` → input 清空 + 提示"下次启动 fallback Pi SDK search"

### 5. Sidecar (`sidecar/src/index.mjs`)

`sidecar/src/index.mjs:782` 改 1 行 + 启动 log:

```js
// 改前
bash: createBashToolDefinition(cwdResolved),

// 改后
bash: createBashToolDefinition(cwdResolved, { 
  shellPath: settings.bash?.path  // 来自 ~/.pi/agent/settings.json
}),
```

启动 log 加:
```
[sidecar] bash shell: <path> (source=<auto|manual>, version=<v>)
[sidecar] bash shell: (unset, fallback to Pi SDK auto-discovery)
```

`settings` 从 `~/.pi/agent/settings.json` 读 (跟 compaction.enabled 复用现有 read helper).

### 6. errorSanitizer (`sidecar/src/errorSanitizer.mjs`)

加 `bash_not_found` category (P2-6 联动):

```js
const BASH_NOT_FOUND_HINTS = [
  '安装 Git for Windows (https://git-scm.com/download/win)',
  '或到 Settings → Bash 路径手动指定 bash 路径',
];
```

`classifyToolError` 加分支识别 `No bash shell found` 关键字.

### 7. 端到端 smoke (7 步)

1. 装 Git for Windows 到非常规路径 (e.g. `D:\DevTools\Git\`) → 启 app
2. F12 应看到 toast "未检测到 bash" (auto-detect 找不到)
3. 进 Settings → Bash 路径, 粘贴 `D:\DevTools\Git\bin\bash.exe` → on-blur 立刻显示 "✓ v5.2.21"
4. 重启 app → 启 session, F12 看到 `[sidecar] bash shell: D:\DevTools\Git\bin\bash.exe (source=manual, version=5.2.21)`
5. 配 activeProvider, 跑 `node -v` → 返回 v24.16.0
6. 跑 `echo $PI_SESSION_ID` → 返回 session id (PI_* env 注入成功)
7. 跑 `ls -la` → 返回目录列表

### 改动文件 / 行数估

| 文件 | 改动 | 行数 |
|---|---|---|
| `src-tauri/src/lib.rs` | 5 command + 2 struct + 注册 | +230 |
| `app/src/lib/tauri.ts` | 5 wrapper + 2 interface | +25 |
| `app/src/stores/config.ts` | state + 4 action | +80 |
| `app/src/components/Settings/tabs/GeneralTab.vue` | Bash section 完整 UI | +120 |
| `sidecar/src/index.mjs` | 改 1 行 + 启动 log | +5 |
| `sidecar/src/errorSanitizer.mjs` | bash_not_found category | +15 |
| **总计** | | **~475 行** |

## 何时 Revisit

- **bash 还是用不了**: user 报告后, 立刻 P0-1, 不需要再开 ADR
- **LLM 需要查实时信息**: user 报告后, 立刻 P0-3
- **user tool 撞名频繁**: 维度 5 子代理做不做, 看 user 反馈
- **沙箱误伤正常 bash 命令**: P0-2A → B 升级
- **联网 tool key 滥用**: 走 S-3 budget + keychain 加密
- **多模态 / 子代理 反馈好**: P2 整体前置

## 决策汇总 (2026-08-23 全部拍板)

| ID | 问题 | 拍板 | 关键理由 |
|---|---|---|---|
| Q1 | 联网 tool 实现路径 | **A** 自包装 | key 走 keychain, 跟 MCP 框架并存 |
| Q2 | bash 沙箱粒度 | **A** cwd 限定 | 跟 write/edit workspace 沙箱一致, 最小修复 |
| Q3 | 子代理 (维度 5) 做不做 | **A** 做 | 跟"分阶段但一鼓作气"风格一致 |
| Q4 | 一次性交付范围 | **B** P0+3 维度 | 阶段 1 P0-1 修通 bash 最先开干 |
| Q5 | bash "用不了" 根因 | **已澄清** | Pi SDK search 太窄 + sidecar 没传 shellPath + user 非常规路径安装 |
| Q6 | 首次启动 shell 选定 UX | **A** 静默 auto-pick | source="auto" 诚实记录, 手填可覆盖 |
| Q7 | shell 切换是否热生效 | **A** 等重启 | 保 session 状态, 不重建 Pi SDK session |

**7/7 决策已落地, ADR 状态: Accepted, 待执行**.

---

## 后续 Review

> **不可变原则**: 决策落地后不改原文章节, 变更只追加 ## 后续 Review 段. 推翻用新 ADR `Superseded by` 标注.

### 2026-08-23 拍板

- ✅ Q1~Q7 全部拍板 (见 [决策汇总](#决策汇总-2026-08-23-全部拍板))
- ✅ ADR 状态: Accepted, 待执行
- 待 user 给"开干"信号后按 [待执行变更清单](#待执行变更清单-p0-1-阶段-1-半天到一天) 执行 P0-1

### 2026-08-23 落地 P0-1 + P0-2 (commit 0db984f + 后续 P0-2 commit)

**P0-1 修通 bash** — 5-component 修法:
- `src-tauri/src/lib.rs`: +5 Tauri command (get/set/verify/clear/detect) + 2 struct (BashConfig/ShellInfo) + invoke_handler 注册
- `app/src/lib/tauri.ts`: +5 invoke wrapper + 2 interface
- `app/src/components/Settings/tabs/GeneralTab.vue`: +Bash 路径 section (input + 自动检测 + 测试 + 清除)
- `sidecar/src/index.mjs`: 读 settings.bash.path 传 createBashToolDefinition({shellPath})
- `sidecar/src/errorSanitizer.mjs`: +bash_not_found category
- `doc/04-adr/0019-feature-tools-diversity.md` + `0019-plain-summary.md`: 新 ADR + 白话版

**意外修**: sidecar .mjs 文件里掺 TS 语法 (bun 1.3.14 strict 不认), 写 `scripts/build-sidecar-stage1.mjs` 用 TypeScript transpileModule 预处理

**P0-2 bash 沙箱** (Q2-A 拍板路径, **设计纠正 2026-08-23**):
- **第一版设计错了** — 我在 sidecar 里写了 `wrapBashWithSandbox` 包 bash tool, 但 Pi SDK 0.84.2 内部用 `_baseToolDefinitions` (agent-session.ts:348, 2564), 根本不用我传进去的 `builtinToolDefs` 对象, wrap 函数是 dead code
- **正确路径** — Pi SDK 启动时读 `settings.shellCommandPrefix` + `settings.shellPath` (agent-session.ts:2562-2574, bash.ts:345), 把这两个字段写进 settings.json 即可生效
- `sidecar/src/index.mjs`: 撤掉 wrapBashWithSandbox, 加 mirror 逻辑 — 启动时读自己的 `settings.bash.path` 字段, mirror 到 `settings.shellPath` (Pi SDK 用) 和 `settings.shellCommandPrefix` (`cd "<workspacePath>" &&` 让每次 bash invocation 强制 cd 回 workspace cwd)
- `sidecar/src/errorSanitizer.mjs`: +bash_dangerous category (留作 P1 Extension API 用, 当前不触发)
- **deny list 暂不实现** — 之前 wrap 路径根本到不了 agent 调用的 tool, 走 Pi SDK 的 Extension API (tool_call event) 才能拦截, 改造比 P0-2 范围大, 留 P1

**端到端核验 (P0-1 7 步 + P0-2 验证)** — 待 user 跑:
- P0-1: 7 步 smoke (1-7) 同 ADR P0-1 端到端核验段
- P0-2: 跑 `pwd` (应回 workspace, 跟之前一样) + 跑 `cd /tmp && pwd` (第二条 pwd 应回 workspace, 这次该生效)
  ⚠️ **deny list 不验证** — P0-2 实际只做了 cwd 限定, 没 deny list

**已知遗留 (进 P1 backlog)**:
- ~~bash deny list (P0-2 已修)~~ → ❌ 实际未做, 走 Extension API 重做
- bash path 检测 (命令里的绝对路径判定是否出 workspace) — 复杂度高
- workspace 切换时 bash tool 不会自动重建 (cwd 缓存)
- smart 模式分类 hardcoded (沿 0014 已知问题)
