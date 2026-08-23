# ADR-0020: 沙箱加固 (Job Object + 审计 + AppContainer filesystem)

- **状态**: Accepted (2026-08-23 拍板, P-Sec1 待实施)
- **日期**: 2026-08-23
- **Type**: Security / Infrastructure
- **Module**: Sandbox (P0-2 升级)
- **决策者**: user
- **Relates to**: [0019-feature-tools-diversity](0019-feature-tools-diversity.md) (P0-2 deny list 是基线, 本 ADR 是 OS 层加固), ADR-0019 P0.5 计划 (热更, 跟本 ADR 独立)

## 背景

ADR-0019 P0-2 完成了 **基线沙箱**: 12 条 BUILTIN_DENY_LIST + 用户白名单 + cwd 限定. F12 实测能挡 80% 常见危险命令.

但 user (主程) 明确要求达到"**小团队**"安全级别 (per-user Pi Agent Desktop + WS 转发 + agent MCP 协议, WS/MCP 层另起 ADR-0021). 实地分析后, P0-2 在小团队场景下仍有 4 类硬伤:

| 风险类别 | P0-2 当前 | 需要 OS 层加固 |
|---|---|---|
| 1. LLM 给 `python -c "os.system('rm -rf /')"` 之类子进程逃逸 | ❌ 漏 (deny list 只看命令字符串) | AppContainer filesystem |
| 2. LLM 写无限循环 / fork bomb 把单机卡死 | ❌ 漏 (没资源限制) | Job Object |
| 3. 误操作后查"谁干的" | ⚠️ 只 stderr, 关 Tauri 没了 | 审计日志持久化 |
| 4. LLM 读 `~/.ssh/id_rsa` / `~/.aws/credentials` | ❌ 漏 | AppContainer filesystem |

**架构澄清 (2026-08-23 user 拍板)**:
- 多用户场景: **每用户各自的 Pi 进程 + WS 转发 + agent MCP 协议**, 不是"一个 Pi 服务多人"
- 跨用户越权风险 → **WS/MCP 层处理** (另起 ADR-0021), **不在 Pi 客户端范围**
- Pi 客户端 OS 层加固 = **per-user 视角的本地安全**, 跟 P0-2 一脉相承, 范围明确收窄

## 现状摘要 (v0.6.3-rc1 + P0-2 收工后)

### 已有 (作为基线)

| 能力 | 落地形式 | 位置 |
|---|---|---|
| 12 条 deny list regex | Extension API tool_call hook | `sidecar/src/index.mjs:1534` createDangerousCommandExtension |
| 用户白名单 | settings.json dangerousWhitelist + FE UI | lib.rs:3060, GeneralTab.vue |
| cwd 限定 (每次 cd 回 workspace) | Pi SDK shellCommandPrefix 镜像 | `sidecar/src/index.mjs:864-883` |
| write/edit/grep workspace 沙箱 | path.resolve + symlink 解析 | `sidecar/src/index.mjs:1595` realpathNoFollow |
| 错误信息 sanitize | bash_not_found / bash_dangerous 分类 | `sidecar/src/errorSanitizer.mjs` |

### 缺什么 (P0-2 留下的洞)

- ❌ **没有资源限制** — bash 跑多久不限, 用多少内存不限, fork 多少进程不限
- ❌ **没有持久审计** — block / allow 事件只写 stderr, Tauri 关了就没
- ❌ **bash 进程看到所有用户文件** — `~/.ssh` / `~/.aws` / `C:\Users\OtherUser` 都能读
- ❌ **子进程逃逸** — `python` / `node` / `perl` 之类 sub-shell 完全不受 deny list 约束

## 目标 (应该做什么)

### P-Sec1 — Job Object 资源限制 + 审计日志 (1-2 天)

**目标**: 挡 #2 (DoS) + 解决 #3 (审计). 是后续 P-Sec2 的基础, 风险低, 价值高.

**做什么**:

1. **Job Object 资源限制** (Windows 内建 API, 走 `windows` crate)
   - 内存上限: **1 GB / bash 进程**
   - 进程数上限: **100 个** (含子进程)
   - CPU 限速: **1 核 100%** (Windows 8+ `JobObjectCpuRateControlInformation`)
   - Job close 时自动 kill 所有成员 (`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`)
   - **作用机制**: Tauri 启动 sidecar 时 `AssignProcessToJobObject(job, sidecar_handle)`, sidecar fork 的所有 bash 进程自动继承 Job 成员身份, 限制自动生效
   - **零侵入 Pi SDK**: 不改 `createBashToolDefinition`, 不改 sidecar JS, 只在 Tauri 进程层加一个 HANDLE 关联

2. **审计日志** (sidecar 内写, 不依赖 Tauri)
   - 路径: `<agentDir>/audit.log` (跟 settings.json 同目录, `<HOME>/.pi/agent/audit.log`)
   - 格式: **JSONL** (一行一个 JSON 对象, 跟 `.jsonl` session log 一致)
   - 字段: `{ts: ISO8601, session: string, tool: 'bash', command: string, cwd: string, exit_code: number|null, block_reason: string|null, matched_pattern: string|null, allowed: boolean}`
   - 写入点:
     - deny list 命中 + 在白名单 → `allowed: true, block_reason: null`
     - deny list 命中 + 不在白名单 → `allowed: false, block_reason: <reason>, matched_pattern: <regex source>`
     - 通过 deny list 的普通 bash → `allowed: true`
   - **Tauri 启动时 rotate**: 文件 > 10MB → 改名 `audit.log.1` (覆盖老的)
   - **FE 后续可加 "工具执行历史" 面板读这个 log** (P1 阶段)

### P-Sec2 — AppContainer filesystem 隔离 (3-5 天)

**目标**: 挡 #1 (子进程逃逸) + 解决 #4 (本地 secrets 读). 复杂度高, 分两步:

**P-Sec2.1 (Day 1-2): 沙箱 bash wrapper binary**

- 新增 Rust 二进制: `src-tauri/src/bin/sandbox-bash.rs` → 编译为 `sandbox-bash.exe`
- **作用**: 替换用户 bash. Pi SDK 看到的 `bash.path` 指向 sandbox-bash.exe, 行为兼容 (接收 `-c "<command>"`), 内部走 AppContainer 隔离
- **调用契约**:
  ```
  sandbox-bash.exe --real-bash <path-to-real-bash> --workspace <path> --tmp <path> -- <bash args>
  ```
  例: Pi SDK 跑 `bash -c "ls"`, 实际执行 `sandbox-bash.exe -c "ls"`, sandbox-bash 内部:
  1. 解析 argv, 拿 command
  2. 调 `create_app_container_token("PiAgentSandbox", capabilities)`
  3. 调 `CreateProcessAsUserW(token, real_bash, ["-c", command], env=appcontainer_env)`
  4. Wait + 透传 stdout/stderr/exit code
  5. 返回

**P-Sec2.2 (Day 3-5): AppContainer profile + capabilities**

- 一次性创建 AppContainer profile "PiAgentSandbox" (Tauri 启动时检查, 不存在就建)
- Capabilities (Windows `AppContainer` 用 SID 表达):
  - ✅ 读 `workspace` 路径
  - ✅ 写 `tmp` 路径
  - ✅ 读 `C:\Windows\System32` (bash 跑要 load DLL)
  - ✅ 读 `C:\Program Files\Git\` (用户 Git for Windows 安装)
  - ✅ 读 `C:\Program Files (x86)\Git\`
  - ❌ **拒绝读** `C:\Users\<user>\.ssh` / `.aws` / `.config` (默认 deny, 无 capability 不可见)
  - ❌ **拒绝写** 用户文档 / 桌面 / AppData
- AppContainer 默认 network deny, 本阶段不动 (P-Sec3 再加)

**P-Sec2.3 (Day 5): bash.path 自动指向 sandbox-bash**

- 改造 `set_bash_config` / `verify_bash_path`:
  - `set_bash_config(real_path)` → Tauri 实际写 `bash.path = <sandbox-bash.exe path>`, 配 `bash.realPath = <real_path>` 备用字段
  - Sidecar 读 `bash.path` → 拿到的是 sandbox-bash.exe, 跟 Pi SDK 兼容 (bash 行为)
  - sandbox-bash.exe 读 `bash.realPath` (从 settings.json 同步, 启动时一次性) 知道真 bash 在哪
- 不破坏 P0-1 的 user-facing UX (用户还是配 bash 路径), 只是底层 wrap 了一层

### 不做 (明确划线)

| 不做项 | 原因 |
|---|---|
| **P-Sec3 (AppContainer network 隔离)** | 影响 `npm install` / `git clone` / `pip install` 之类工作流, 团队场景需要白名单维护, ROI 不高. 留 P1 阶段 |
| **跨用户越权 (A 看见 B 的文件)** | 架构上是 per-user Pi + WS 转发, **不在 Pi 客户端范围**. 走 ADR-0021 (WS / MCP 协议) |
| **agent-to-agent 通信安全** | WS server 端能力, 同上, 走 ADR-0021 |
| **WSL / Docker 沙箱** | 跨平台但部署复杂, 当前 Windows-only 场景不需要. 留 P1 评估 |
| **syscall 过滤 (seccomp-bpf / eBPF)** | Windows 平台无对应机制, 复杂度爆炸, 价值边际递减. 不做 |

## 备选 / 关键决策 (2026-08-23 全部拍板)

### 决策点 Q1: 沙箱 OS 层技术路线

- **A (推荐)**: Windows Job Object + AppContainer (本 ADR 路线) — 内建 API, 零外部依赖
- **B**: Docker 容器 — 跨平台但启动慢 (200-500ms / bash 调用), 商业部署要 Docker Desktop 许可
- **C**: WSL + bubblewrap — 偏 Linux 工具链, Windows 部署需要 WSL2 backend
- **D**: 不做 OS 层加固, 维持 P0-2 — 80% 日常坑, 但子进程逃逸 / DoS / 跨用户越权都挡不住

**拍板: A** (2026-08-23, 当前 Pi Agent Desktop 是 Windows 单平台, 走 Windows 内建 API 是最优解; 跨平台需求未来另起 ADR)

### 决策点 Q2: Job Object 限速位置

- **A (推荐)**: Tauri 启动 sidecar 时 attach Job, 所有 sidecar 子进程自动继承 — **零侵入 Pi SDK**
- **B**: Sidecar 内部为每个 bash 进程 attach 新 Job — 灵活但需要 hook Pi SDK 的 spawn, 改 createBashToolDefinition, 风险大
- **C**: 走 shellCommandPrefix 在 bash 内 `ulimit` — Linux 风格, Windows 不支持, 不可行

**拍板: A** (2026-08-23, 简单, 风险低, 覆盖 100% 场景)

### 决策点 Q3: AppContainer 替代方案 (P-Sec2 范围内)

- **A (推荐)**: sandbox-bash.exe wrapper binary (本 ADR 路线) — 透明替换, Pi SDK 无感知
- **B**: Hook Pi SDK 的 child_process.spawn — 改 Pi SDK 或 wrap createBashToolDefinition, 工程量更大
- **C**: 走 WSL 子系统 — 跨平台但 Pi SDK 当前用的是 Windows bash, 切换成本高

**拍板: A** (2026-08-23, 单一 binary, 单点可控)

### 决策点 Q4: 审计日志格式

- **A (推荐)**: JSONL (一行一 JSON) — 跟现有 session log `.jsonl` 一致, FE / 后处理工具友好
- **B**: SQLite — 强大但需要新依赖, 单机单机本机用不上查询能力
- **C**: 纯文本 — 难解析, 后期想做"工具历史"面板费劲

**拍板: A** (2026-08-23, 跟现有约定一致, 零新依赖)

### 决策点 Q5: 审计日志保留期

- **A (推荐)**: 单文件 10MB rotate, 总保留约 30MB (audit.log + audit.log.1) — 1-3 个月日常用量
- **B**: 不限大小, 永久保留 — 隐私 + 磁盘风险
- **C**: 7 天后自动删 — 太短, 排查来不及

**拍板: A** (2026-08-23, 平衡排查需求 + 磁盘预算)

## 端到端核验

### P-Sec1 (完成后 user F12 测试)

1. 启动 Tauri, sidecar 启动 → cmd 窗口日志有 `[job-object] sandbox job created: mem=1GB procs=100 cpu=1core`
2. 跑 `node -e "let a=[]; while(true) a.push(new Array(1e7))"` → **进程被 kill** (内存超 1GB)
3. 跑 `:(){ :|:& };:` (fork bomb) → **进程被 kill** (子进程数超 100)
4. 跑 `while true; do echo hi; done` 超过 5 分钟 → **仍能跑** (CPU 限速不杀, 只限速; 这是设计, 用户可以 Ctrl+C 终止)
5. 跑任意 bash → `<agentDir>/audit.log` 多一行 JSON, 包含 command / cwd / allowed
6. 跑 `rm -rf /tmp/test-block.txt` (deny list 命中) → audit.log 有 `allowed: false, block_reason, matched_pattern`
7. 跑 `rm -rf /tmp/whitelist-test.txt` (白名单命中) → audit.log 有 `allowed: true, block_reason: null`

### P-Sec2 (完成后 user F12 测试)

1. sidecar 启动 → 走 `sandbox-bash.exe` 路径 (Tauri 自动 wrap), `[sandbox-bash] real-bash=<path> workspace=<p> tmp=<p>`
2. 跑 `cat /c/Users/<user>/.ssh/id_rsa` → **bash 启动失败** 或读出空 (AppContainer 看不到该路径)
3. 跑 `echo hello > /tmp/test.txt && cat /tmp/test.txt` → **正常** (tmp 路径可写可读)
4. 跑 `echo hello > /workspace/test.txt && cat /workspace/test.txt` → **正常** (workspace 可写可读)
5. 跑 `python -c "import os; os.system('rm -rf /tmp/whatever')"` → 仍然在 deny list, 走 P0-2 路径 block
6. 跑 `python -c "import os; os.system('echo hi > /c/Users/<user>/Documents/leak.txt')"` → **写入失败** (Documents 不在 capability 里)
7. 跑 `git status` (需要读 `.git/`) → 正常 (workspace 内)

## 风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| AppContainer profile 创建失败 (权限不够) | 中 | 高 | Fallback 到 P0-2 状态, Tauri 启动 toast 警告 "sandbox 降级到 baseline" |
| sandbox-bash.exe 路径解析错 (用户配了非标准路径) | 中 | 中 | `verify_bash_path` 测一次, 失败 → 不启用 AppContainer, 仅 Job Object |
| 某些 bash 内置命令在 AppContainer 跑不动 | 低-中 | 中 | 已知: `cygpath`, Git credential manager 可能需要额外 capability. 收集 user 反馈, 后续 add capability |
| Job Object CPU 限速影响 LLM 训练脚本性能 | 低 | 低 | CPU 限 1 核足够, LLM 训练场景用户应自己用专用工具 |
| 审计日志敏感信息泄露 (命令里含密码) | 中 | 中 | 文档告知风险, 后续可加 redaction (P1) |
| Windows 7 用户 (AppContainer 是 8+) | 低 | 高 | 检测 Windows 版本, 7 用户降级到 P-Sec1 only, toast 提示升级 |

## 实施计划

### 阶段 1: P-Sec1 (1-2 天, 优先开工)

- [ ] ADR-0020 (本文件) 拍板
- [ ] 0020-plain-summary.md 白话版
- [ ] Tauri: 加 `windows` crate 依赖 (Cargo.toml)
- [ ] Tauri: 新增 `src-tauri/src/sandbox/job_object.rs` (Job Object 创建 + attach)
- [ ] Tauri: 在 sidecar spawn 处 attach Job (找现有 spawn 代码 hook)
- [ ] Sidecar: audit log 写入 (extension 已有点, 加 file write)
- [ ] 验证 + commit + push

### 阶段 2: P-Sec2 (3-5 天)

- [ ] 新增 `src-tauri/src/bin/sandbox-bash.rs` wrapper binary
- [ ] Tauri: `src-tauri/src/sandbox/app_container.rs` (profile 创建 + token 派生)
- [ ] Tauri: `set_bash_config` 改造 (自动指向 sandbox-bash.exe)
- [ ] 测试 + edge case 修复 (Git credential manager 等)
- [ ] 验证 + commit + push

### 阶段 3 (后续, 独立 ADR)

- [ ] ADR-0021: WS / MCP 协议安全 (auth, capability, audit)
- [ ] ADR-0019 P0.5: 热更 (system prompt / whitelist / bash.path)
- [ ] P1 阶段: 跨平台 (bubblewrap / sandbox-exec) 评估

## 不在范围

- 跨用户越权 (WS / MCP 协议层负责, 走 ADR-0021)
- agent-to-agent 通信权限 (同上)
- 网络隔离 (P-Sec3, 后续 P1 评估)
- 跨平台沙箱 (未来评估, 当前 Windows-only)
- syscall 过滤 (Windows 无对应, 不做)
