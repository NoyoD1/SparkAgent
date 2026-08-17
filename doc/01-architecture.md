# 01 · 架构 (Architecture)

> 当前架构 + 技术栈 + 部署形态 + 数据流。**改架构前先看这里 + 04-adr/**。

---

## 1. 顶层架构图

```
┌─────────────────────────────────────────────────────────────┐
│                   Pi Agent Desktop App                       │
│                                                              │
│  ┌────────────────────┐         ┌────────────────────┐     │
│  │   Frontend         │         │   Tauri 2 Host     │     │
│  │   (Vite + Vue 3)   │  IPC    │   (Rust)           │     │
│  │                    │ ◄─────► │                    │     │
│  │  - Components      │  invoke │  - Window control  │     │
│  │  - Pinia stores    │  listen │  - File system     │     │
│  │  - Composables     │         │  - Dialog          │     │
│  │  - Markdown render │         │  - Keychain        │     │
│  │                    │         │  - Config store    │     │
│  └─────────┬──────────┘         │  - Sidecar spawn   │     │
│            │                    └─────────┬──────────┘     │
│            │ WebView2 (Chromium)          │                 │
│            │                              │ spawn           │
│  ┌─────────▼──────────────────────────────▼──────────┐     │
│  │              Sidecar (.exe, v0.5.6 bun compiled)    │     │
│  │  (v0.5.8: Tauri 2 标准 sidecar 机制 externalBin)    │     │
│  │  (per-prompt, Pi SDK RPC 模式, stdin/stdout JSONL)  │     │
│  │                                                    │     │
│  │  - Pi SDK runRpcMode (40+ RpcCommand + RpcEvent)   │     │
│  │  - 自动 5x retry + 30s hang watch + auto-compaction │     │
│  │  - tool executor (v0.4.1: 7 内置 + permission)     │     │
│  │  - session persistence (per-workspace jsonl)        │     │
│  └─────────┬──────────────────────────────────────────┘     │
│            │ HTTPS                                            │
└────────────┼──────────────────────────────────────────────┘
             │
             ▼
      ┌──────────────┐
      │  LLM API     │
      │  (BYOK key)  │
      │  - Anthropic │
      │  - OpenAI    │
      │  - 7+ others │
      └──────────────┘
```

---

## 2. 三层职责

| 层 | 职责 | 关键文件 |
|---|---|---|
| **Frontend** | UI / 状态 / 用户交互 / Markdown 渲染 / 事件订阅 | `app/src/` |
| **Tauri Host** | 窗口 / OS keychain / 配置文件 / 进程管理 / 敏感路径 | `src-tauri/src/` |
| **Sidecar** | LLM 调用 / 流式解析 / tool 执行（v0.4+）/ memory（v0.5+） | `sidecar/src/` |

**为什么三层而不是两层（FE + Sidecar）**？
- Tauri 层负责**敏感操作**（keychain、文件路径、进程管理）— 永远不让 FE 直接做
- Sidecar 层负责**长时 LLM 通信 + 大 token 缓冲** — 不能跑在 WebView 里（WebView 单进程扛不住）
- 详见 [ADR-0003 desktop-only + sidecar 拆分](04-adr/)

---

## 3. 技术栈

### Frontend
| 库 | 版本 | 用途 |
|---|---|---|
| **Vue 3** | 3.x | UI 框架（Composition API + `<script setup>`）|
| **TypeScript** | 5.x | 类型系统 |
| **Vite** | 5.x | 构建 + dev server (port 5174) |
| **Pinia** | 2.x | 状态管理（4 个 store：ui/chat/session/config）|
| **marked** | 18+ | Markdown 渲染（v18 GFM 严格化见 [04-adr/](../04-adr/)）|
| **lucide-vue-next** | 0.469+ | 图标（**已 deprecated**，计划迁 `@lucide/vue`）|
| **highlight.js** | latest | 代码块高亮 |

### Tauri 2 (Rust)
| crate | 用途 |
|---|---|
| `tauri` | 桌面 runtime |
| `tauri-plugin-keyring` 或自实现 | OS keychain（Windows Credential Manager）|
| `serde` + `serde_json` | 配置 / 事件序列化 |
| `tokio` | 异步 runtime（sidecar 管理）|
| `dirs` | APPDATA / LOCALAPPDATA 路径 |

### Sidecar (Node.js 20+)
| 模块 | 用途 |
|---|---|
| `readline` (builtin) | stdin/stdout JSONL (Pi SDK runRpcMode 接管, v0.5.0+) |
| `fetch` (Node 20+ builtin) | LLM HTTPS 调用 |
| 第三方 SDK 暂未引入 | 直接 fetch 简化依赖（见 [04-adr/](../04-adr/)）|

### 设计系统
- **Design source of truth**: `Pi-Agent-Design.design/assets/Minimalist Copy/`
- **Token 实现**: `app/src/assets/styles/tokens.css`
- **组件库**: 自实现（不依赖 Naive UI / Element Plus，避免破坏极简风格）

---

## 4. 部署形态

| 形态 | 何时用 | 状态 |
|---|---|---|
| **Desktop App (Tauri)** | **主形态** — 用户日常使用 | ✅ v0.3+ |
| Web (浏览器) | ❌ 早期 v0.2 形态，**已废弃**（v0.3 切 desktop-only）| 🚫 |
| 移动端 | ❌ v1.x 不做 | — |
| CLI | ❌ v1.x 不做（不抢 Claude Code 饭碗）| — |

**每客户独立部署 server (C 方案)** 是商业形态（待 user 拍板后补 spec）。

---

## 5. 数据流：一次 LLM 调用

```
用户输入 message
  │
  ▼ (1) Composer 触发 chat store.sendMessage()
  │
  ▼ (2) chat store 调 piTauri.sendPrompt(sessionId, content, configGetter)
  │      (config = { providerId, provider, model, baseUrl, thinkingLevel, workspacePath })
  │
  ▼ (3) Tauri 前端通过 invoke('send_prompt', {...}) 调 Rust
  │
  ▼ (4) Rust 读 OS keychain 拿 apiKey (keychain key = providerId)
  │
  ▼ (5) Rust spawn sidecar .exe (v0.5.6 bun compiled, 108 MB self-contained) — 走
  │      Tauri 2 标准 sidecar 机制 `app.shell().sidecar("pi-agent-sidecar").spawn()`
  │      (v0.5.8, D172 跨项目规则: `bundle.externalBin` + `app.shell().sidecar()` 替代
  │       v0.5.6 的 `Command::new(&script)` 写死编译时绝对路径, 干净 Windows 机器 install
  │       MSI/NSIS 真能跑). 拿 `(Receiver<CommandEvent>, CommandChild)`, argv[1] = config JSON
  │
  ▼ (6) Sidecar runRpcMode 接管 stdin/stdout (JSONL 严格 LF-only), 创建 AgentSessionRuntime
  │
  ▼ (7) LLM stream events → runRpcMode 序列化 AgentSessionEvent JSONL emit 给 stdout
  │      (agent_start / turn_start / message_start / message_update / message_end / turn_end / agent_end / tool_* / auto_retry_*)
  │
  ▼ (8) Rust 读 stdout 走 `rx.recv()` 循环 `CommandEvent::Stdout` 透传 RpcEvent + RpcResponse
  │      → Tauri event 'chat:event' → Frontend
  │
  ▼ (9) 后续 send_rpc_command (abort / permission_response / set_model / ...) 走
  │      `CommandChild::write(rpc_command.as_bytes())` 写 stdin, sidecar runRpcMode 路由
  │
  ▼ (10) Frontend listen('chat:event') 触发 chat store handler
  │      - 增量更新 ChatMessage (streaming)
  │      - 折叠 / 展开 thinking / tool_call blocks
  │
  ▼ (11) agent_end 事件触发 → chat store finalize message + auto-save session (Pi SDK session-manager 写 jsonl)
```

**关键设计**：
- **apiKey 永远不出现在 FE / WS 协议 / 日志**（只在 step 4-6 的 Rust + sidecar 内部流过）
- **sessionId 全程标识**，支持多 session 并发
- **事件流而非请求-响应**，UI 可以边生成边展示
- **sidecar 一次 prompt 一个生命周期**（简化错误恢复，进程崩了重启简单）

---

## 6. 数据存储

| 数据 | 位置 | 加密 | 备份 |
|---|---|---|---|
| **API keys** | OS keychain (Windows Credential Manager) | 系统加密 | 系统级 |
| **Provider 配置** | `%APPDATA%\com.piagent.desktop\config.json` | ❌（仅 provider ID / model ID，不含 key）| 自维护 |
| **Session 历史** | `%APPDATA%\com.piagent.desktop\sessions\<session-id>.jsonl` | ❌（用户自管）| 用户导出 |
| **Workspace 元数据** | `%APPDATA%\com.piagent.desktop\workspaces.json` | ❌ | 自维护 |
| **前端 runtime** | `%LOCALAPPDATA%\com.piagent.desktop\EBWebView\` (WebView2) | — | — |

**v0.3.8+ 决策**：provider 配置迁出 localStorage 到 Rust 文件，**原因**：WebView2 缓存被清时 localStorage 也会没，provider 配置会丢。

---

## 7. 进程模型

| 进程 | 启动时机 | 生命周期 |
|---|---|---|
| **Tauri 主进程** | 用户启动 app | 整个 app 生命周期 |
| **WebView2** | Tauri 主进程启动后 | 同 Tauri 主进程 |
| **Sidecar** | 每次 `send_prompt` invoke | 单次 prompt 结束（或 abort）|

**Sidecar 一次一 spawn** 的取舍：
- ✅ 简单：崩了重启零成本，token / 内存不残留
- ✅ 配置变更立刻生效（不用通知长跑 sidecar）
- ❌ 每次启动 ~200ms 延迟（v0.4+ 考虑加 LRU 池）
- ❌ 真正的 abort 要 kill 进程（v0.4+ 用 AbortController）

---

## 8. 安全边界

| 边界 | 谁负责 | 策略 |
|---|---|---|
| **API Key 存储** | Tauri → OS keychain | 永不进 localStorage / WS / 日志 |
| **API Key 传输** | Tauri → Sidecar argv[1] (config JSON) | 短命，agent_end 即 sidecar exit |
| **API Key 错误脱敏** | Sidecar sanitize | 401/403 错误信息 regex 过滤 key 模式 |
| **CSP** | Tauri config | 当前 `csp: null`（**待 v0.4+ 严格化**）|
| **Tool 沙箱**（v0.4+）| Sidecar | workspacePath 内 + 白名单命令 + 用户确认 |
| **本地文件写入** | Tauri / Sidecar | 必须 user 显式 confirm（v0.4+）|

详见 [03-features/security.md](03-features/security.md)。

---

## 9. 性能预算

| 指标 | 预算 | 当前 |
|---|---|---|
| 启动到首屏 | < 1.5s | ~800ms |
| Vite HMR 重载 | < 300ms | ~150ms |
| send_prompt 到首个 token | < 500ms（含 sidecar spawn）| ~300ms |
| 单条消息渲染（< 5K token）| < 50ms | < 20ms |
| 包大小（exe + 资源）| < 80MB | TBD（Tauri 默认 ~10MB + WebView2 共享）|

---

## 10. 目录结构（核心部分）

```
D:\UnityWork\Tools\Pi\
├── doc/                          ← 本蓝图
├── app/                          ← Vite + Vue 3 前端
│   ├── package.json
│   ├── vite.config.ts
│   └── src/
│       ├── App.vue
│       ├── stores/{ui,chat,config,session}.ts
│       ├── lib/{tauri,dialog,providers-api,api-types}.ts
│       ├── lib/mock/             ← 仅 dev 用，生产删
│       ├── components/
│       │   ├── TitleBar.vue
│       │   ├── Sidebar/
│       │   ├── ChatMain/
│       │   ├── TaskDrawer/
│       │   ├── Settings/
│       │   └── ui/               ← 自实现原子组件
│       ├── views/ChatView.vue
│       └── assets/styles/{tokens.css, main.css}
├── sidecar/                      ← Sidecar (v0.5.6 bun compiled, self-contained .exe)
│   ├── package.json              ← npm dependencies (@earendil-works/pi-* 0.84.2)
│   ├── src/{index.mjs}           ← wrapper: 200+ lines, 走 Pi SDK runRpcMode
│   └── dist/pi-agent-sidecar.exe ← bun build --compile 产物, 108 MB, 必须 commit (D163)
├── src-tauri/                    ← Rust host
│   ├── Cargo.toml                ← v0.5.8: tauri-plugin-shell = "2" (D172)
│   ├── tauri.conf.json           ← v0.5.8: bundle.externalBin (D172)
│   ├── capabilities/default.json ← v0.5.8: shell:allow-spawn (D172)
│   ├── binaries/                 ← v0.5.8: Tauri 命名约定的 sidecar binary 拷贝
│   │   └── pi-agent-sidecar-x86_64-pc-windows-msvc.exe ← 108 MB, 必须 commit (D163+D172)
│   └── src/{main,lib,sidecar,keyring,config_store,index_file}.rs
│       └── sidecar.rs            ← v0.5.8: app.shell().sidecar() + Receiver<CommandEvent> + CommandChild
├── Pi-Agent-Design.design/       ← 设计源（v0.3.8.19+ 唯一权威 = Minimalist Copy/）
└── .gitignore
```
