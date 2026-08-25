# Pi Agent Desktop OOM 深度分析 (D213 / D214 全链路复盘)

> 分析时间: 2026-08-25
> 范围: 整个工程 (Tauri 2 + Vue 3 + Pi SDK 0.84.2 + 自写 sidecar)
> 数据: 实机进程采样 + 源码审查 (src-tauri/, app/src/, sidecar/src/) + .tauri-debug.log 47 万行
> 目的: 给别的 LLM 推理修复方案用的**问题诊断报告** (不写修复代码)

---

## 一、TL;DR

OOM **不是单点问题**, 是 4 个独立但叠加的内存消耗源, 其中 3 个在前端 (chat store), 1 个在 sidecar. 真正的硬伤:

1. **chatData reactive 持有 user message images.data base64** (单 session 6.7MB 起步)
2. **`watch(chatData, deep)` + `saveToStorage` 每次 text_delta 深拷贝整个 chatData** (瞬时 2x 内存)
3. **ChatMain `v-for="msg in messages"` 无虚拟滚动** (长对话 DOM 节点 + Vue 响应式依赖线性)
4. **spawn-per-prompt sidecar 全量灌 session jsonl 进内存** (200K context → 几百 MB 对象图)

之前 ADR-0024 写的 "message_end 拆 final content 覆盖" 路径**不存在** (v0.5.0-D 第10轮 revert 删了), 真实根因是上面 4 条.

---

## 二、架构总览 (4 层进程 + 数据流)

```
┌──────────────────────────────────────────────────────────┐
│ Layer 1: pi-agent-desktop.exe (Tauri 主进程, ~50MB)      │
│   - Rust, 跑在 Windows. 启动 Tauri 2 + Job Object        │
│   - 持有 WebView2 主窗口 (Layer 2a)                       │
│   - 持有 sidecar 进程管理 (Layer 3)                       │
│   - 持有 ephemeral WebView2 (Layer 2b, 每次 web_navigate)│
└──────────────────────────────────────────────────────────┘
        ↕ Tauri IPC (chat:event / chat:invoke)
┌──────────────────────────────────────────────────────────┐
│ Layer 2a: WebView2 主窗口渲染进程 (Vue 3)                │
│   - 单进程, ~250-300MB WS / ~200MB PRIV (实测)           │
│   - 持有 chat store reactive 全部数据 (chatData)         │
│   - 持有 v-for 全部 DOM 节点 (无虚拟滚动)                 │
└──────────────────────────────────────────────────────────┘
        ↕ Tauri WebviewWindow API
┌──────────────────────────────────────────────────────────┐
│ Layer 2b: WebView2 browser-panel + ephemeral            │
│   - browser-panel: 用户主动开, 长期 1 个 WebviewWindow   │
│   - ephemeral: LLM 调 web_navigate 时临时创建 + 销毁     │
│   - 每组 = 5-6 个 Chromium 进程 (browser + renderer +     │
│     GPU + utility), 实测合计 ~1.1GB                       │
│   - v3.62 / v3.62.1 改独立 data dir, 销毁时清            │
└──────────────────────────────────────────────────────────┘
        ↕ stdio JSON-RPC
┌──────────────────────────────────────────────────────────┐
│ Layer 3: pi-agent-sidecar.exe (Node + bun, ~200-400MB)   │
│   - spawn-per-prompt 模式: 每次 send_prompt 新进程       │
│   - 跑 Pi SDK 0.84.2 createAgentSession 整个 agent loop  │
│   - sessionManager 全量加载 session jsonl 进内存         │
│   - 受 Job Object 限制: 1GB / 100 procs / 1 core         │
└──────────────────────────────────────────────────────────┘
        ↕ spawn child (mcp / external tool / bash)
┌──────────────────────────────────────────────────────────┐
│ Layer 4: 子进程 (mcp server / external tool / bash)     │
│   - python / node / bun 各种 (per-tool)                  │
│   - **不在 Job Object** (attach race window)            │
│   - 无限资源, 实测 LLM web_screenshot 10956 base64 OK    │
└──────────────────────────────────────────────────────────┘
```

---

## 三、已确认的 4 个 OOM 真凶 (按风险排序)

### 真凶 #1 (已修): fs.watch 自激 → silent restart → 空 message 累积

**位置**: `sidecar/src/externalToolsWatcher.mjs:13-17, 28-32, 66-71` + `sidecar/src/mcpWatcher.mjs` 同 pattern

**机制**:
- sidecar 启动时装 `fs.watch` 监听 MCP / external tool config dir
- Windows `ReadDirectoryChangesW` 启动后有几秒延迟事件 (装 watcher 时 mtime 扫描 + IDE 同步 + 目录加载)
- 延迟事件触发 → silent restart_all_sidecars (Tauri 端 fire-and-forget) → 正在跑 LLM call 的 sidecar 被 kill
- 流式 0 emit → chat store 创建空 message → user 看到 "多次空回复"
- "多次 sendPrompt 累积 → WebView2 OOM" (项目自认, externalToolsWatcher.mjs:13 注释)

**修复** (v3.57, 已 commit): 装 watcher 时记 `readyAt`, 5s 内 callback 静默 skip (`STARTUP_GRACE_MS = 5_000`)

**风险等级**: ✅ 已修复. 现状不再因 fs.watch 触发 OOM.

---

### 真凶 #2 (新发现, **未修**): user message images.data base64 累积

**位置**:
- `app/src/stores/chat.ts:837-848` (`appendUserMessage` 推 user message, images 含 base64)
- `app/src/stores/chat.ts:998` (sendPrompt 拼 attachmentsImagesForMsg 时 `data: img.base64` 注释写"in-memory, sendPrompt 走 Pi SDK images[] 用同一份 base64")
- `app/src/stores/chatStorage.ts:67-87` (`sanitizeForStorage` 持久化时 strip base64, **但 in-memory chatData 仍存 base64**)

**机制**:
1. user 上传图片 (5MB 原图 → ~6.7MB base64)
2. `appendUserMessage` 推 user message, `images[].data = base64` 存进 chatData
3. 多张图累积, 单 session chatData 6.7MB+ 起步
4. **切 session 不释放** (session.ts:618 `selectSession` 只改 activeSessionId, 不动 chat store)
5. 多个 session 累积, chatData 整体几十 MB
6. WebView2 渲染进程 JS heap 爆 → OOM

**关键证据** (.tauri-debug.log 实测, 47 万行搜索):
- 4 个 6.7MB event 全是 `role: "user"`, type 是 message_start / message_end / agent_end
- 11:50:49, 11:50:50, 11:51:02, 12:06:22, 12:06:22 5 个 event, 单 session 累积 6.7MB
- 都包含 `data:image/png;base64,iVBORw0KGgo...`

**修复方向 (供参考, 不写)**:
- `appendUserMessage` 推 user message 时 `images[].data = undefined` (只存 savedPath + thumbnail)
- ChatMessage.vue 渲染时 `data ?? await read_image_as_data_url(savedPath)` (Tauri command 已存在)
- 切 session 时 lazy reload 非活跃 session 的图

**风险等级**: 🔴 **高**, 单一最大风险. 删会话释放说明 baseline 决定 OOM.

---

### 真凶 #3 (新发现, **未修**): watch(chatData, deep) + saveToStorage 每次深拷贝

**位置**:
- `app/src/stores/chat.ts:92-96`: `watch(chatData, (v) => saveToStorage(v), { deep: true })`
- `app/src/stores/chatStorage.ts:51-61`: `saveToStorage` → `sanitizeForStorage` 深拷贝整个 chatData
- `app/src/stores/chatStorage.ts:67-87`: `sanitizeForStorage` 逐 session 深拷贝 + strip base64

**机制**:
1. LLM 流式响应: 1 turn 20-50 次 `message_update` (text_delta 累积)
2. 每次 `chatData.value = { ...chatData.value, [sid]: { ...d2 } }` 触发 deep watch
3. `saveToStorage(chatData)` → `sanitizeForStorage(chatData)` 整个对象图深拷贝
4. **这一刻瞬时内存 = chatData in-memory + 一份完整深拷贝** (峰值 2x)
5. 长 session 累积 base64 时, 每次 text_delta 触发 save, 短时间 20+ 次深拷贝
6. GC 压力 + 瞬时峰值 → WebView2 OOM

**修复方向 (供参考)**:
- `watch` 改 `flush: 'post'` + debounce 500ms (1 turn 完才 save)
- 或 `chatData.value` 改 `shallowRef` + 显式 `markDirty()` + 定时 flush
- 或 `sanitizeForStorage` 改成 mutable in-place (不深拷贝)

**风险等级**: 🟡 **中**, 叠加真凶 #2 时加剧. 单独触发可能性低, 但跟 #2 共存必爆.

---

### 真凶 #4 (新发现, **未修**): ChatMain 无虚拟滚动

**位置**: `app/src/components/ChatMain/ChatMain.vue:339` `v-for="(msg, idx) in messages"`

**机制**:
- 长对话几百条 message, 每条含 steps / toolCalls / thinking / images
- 全部 `v-for` 渲染进 DOM, 节点数线性增长
- Vue 3 reactive 依赖追踪: 每条 message 任何字段变化都触发整个数组响应式重新计算
- WebView2 渲染进程 DOM 节点 + JS heap 双线增长

**证据**:
- ChatMain.vue:339 显式 `v-for`, 没引虚拟滚动库 (package.json 没 vue-virtual-scroller / @tanstack/vue-virtual)
- 实测 renderer 进程 288MB WS / 235MB PRIV (user 报告里)

**修复方向**:
- 引入 `vue-virtual-scroller` 或 `@tanstack/vue-virtual`
- `v-for` 换虚拟列表, 配 `RecycleScroller` 或 `DynamicScroller`
- 滚动锚定逻辑: 用 `IntersectionObserver` 找可视区 item, scroll 到 anchor (D214 v15.1.14 第五版教训)

**风险等级**: 🟡 **中**, 长对话场景独立 OOM. 跟 #2 叠加放大.

---

## 四、已用 .tauri-debug.log 验证的事实

### 4.1 6.7MB event 都是 user role (不是 assistant)

```bash
# 实测 .tauri-debug.log > 500KB events
[11:50:49.711] [sidecar] stdout[29]: {"type":"message_start","message":{"role":"user","content":[
  {"type":"text","text":"图片什么内容？"},{"data":"iVBORw0KGgo..."}]}} ... length=6726312
[11:50:50.015] [sidecar] stdout[30]: {"type":"message_end","message":{"role":"user"...}} ... length=6726310
[11:51:02.787] [sidecar] stdout[358]: {"type":"agent_end","messages":[{"role":"user"...}} ... length=6728349
[12:06:22.501] [sidecar] stdout[29]: {"type":"message_start","message":{"role":"user"...}} ... length=6726311
[12:06:22.791] [sidecar] stdout[30]: {"type":"message_end","message":{"role":"user"...}} ... length=6726309
```

### 4.2 OOM 时间分布 (user 北京时间报告)

- user 报告 OOM 时间: 2026-08-25 1:00 北京 (凌晨)
- .tauri-debug.log 大 payload 事件: 19:50-20:41 北京 (前晚) — 时间吻合

### 4.3 "删了历史会话后好了" 现象

- memory 已知 (D213 OOM lesson): "user 删 session 后不 OOM 的原因 (不是 fs.watch 修法生效): chat store 内存回到 baseline, WebView2 渲染进程有足够余量装 6.7MB"
- 本次复现: 同现象, 1:00 OOM → 删 session → 3:00 跑 wuxi_weather 任务 log 12:50-13:01 没 OOM

### 4.4 4 个 OOM 字符串全来自 user 自己测试

- log 里 25 个 "OOM" 字符串, 24 个是 6:12/6:26 user 跑 `node -e OOM test` 自己的
- 真正 Tauri 进程 OOM 死时, debug_log() 写不进, 所以 log 里没直接 "OOM 死" 记录 (要靠 baseline 间接推断)

---

## 五、次要风险 (代码看出来, 没具体复现)

### 5.1 spawn-per-prompt sidecar 残留累积 (低概率)

**位置**: `src-tauri/src/sidecar.rs:156-338` (`run_prompt`)

**机制**:
- 每次 send_prompt 新 spawn Node 进程 (基线 ~200MB V8 heap)
- agent_end 丢失时 (Pi SDK 0.84.2 + MiniMax/DeepSeek V4 Flash 已知), 旧 sidecar 不主动 exit
- `kill_sidecar` (line 513) + `restart_all_sidecars` (line 550) 有 force kill 兜底
- 但 abort / stream hang 后重试路径, 旧 sidecar 仍能 hold 几百 MB

**证据**:
- 实测 sidecar PRIV 381MB > WS 204MB (V8 commit 大量虚拟内存)
- 30s watchdog 没看到代码 (memory 说有, 但代码没体现, 可能注释过期)

**修复方向**:
- 给 ActiveSidecars 加 N=3 上限
- agent_end 监听加 60s 超时强杀

**风险等级**: 🟢 **低**, 实测主要 OOM 走 #2 / #3, 这条独立触发少.

### 5.2 sidecar 全量灌 session jsonl (中等)

**位置**: `sidecar/src/index.mjs:1952-1963`

```js
// ====== v0.5.4 hotfix: sync sessionManager history → agent.state.messages ======
const initialMessages = runtime.session.sessionManager.buildSessionContext().messages;
runtime.session.agent.state.messages = initialMessages;
```

**机制**:
- 每次 spawn 新 sidecar, 全量读 session jsonl 进 V8 heap
- 长 session 几百条 message + 工具结果, 几百 MB 对象图
- sidecar 1GB Job 限制 → 接近爆

**修复方向**:
- `buildSessionContext` 前 token 估算
- 超阈值先 compact (Pi SDK 自带 compact 能力)

**风险等级**: 🟡 **中**, 跟 LLM 上下文大小强相关.

### 5.3 sidecar fork 的子进程不受 Job 限制

**位置**: `src-tauri/src/sandbox/job_object.rs:13-19` 注释

```
已知限制 (2026-08-23):
  - 跨进程 race: sidecar spawn 完到 attach 之间的窗口期, sidecar 可能 fork bash.
    Windows Job 默认 child 继承 parent 的 Job 成员状态, 所以 race 期间 fork 的 bash
    也会自动加入 (但 sidecar 还没 attach, 所以 race 期间的子进程不在 Job).
```

**机制**:
- external tool subprocess (python / node / bun) 走 `externalTools.mjs` spawn
- mcp server 走 `mcpClient.mjs` spawn
- bash tool 走 Pi SDK builtin, fork 出去
- 这些**子进程不在 Job 里**, 没内存限制
- LLM 跑 web_screenshot + web_navigate 频繁时, 累积子进程风险

**修复方向**:
- sidecar 内部自己 attach child to Job (跟 Rust 端同 pattern)
- 或: sidecar 启动时记录所有 spawn child pid, 定期 TerminateProcess

**风险等级**: 🟢 **低**, 实测 web_navigate 单次 10956 bytes base64 OK.

### 5.4 WebView2 EBWebView 磁盘 cache 552MB (v3.63 已修, **有效**)

- 实测: Cache 305MB + Code Cache 189MB + Extensions 27MB + 其他 = 552MB
- v3.63 启动时清 `EBWebView/Default/Cache` (阈值 200MB), 验证 350MB mock → 0MB
- 风险: 0 (已修)

### 5.5 localStorage 5MB quota

- `sanitizeForStorage` 已经 strip base64, quota 风险低
- 风险: 0 (sanitize 有效)

---

## 六、监控 / 复现建议 (给推理修复的 LLM)

### 6.1 关键指标 (需要在 WebView2 注入)

```js
// 监控用, 在 chat store 关键路径加
performance.memory  // Chrome only, WebView2 应该能用
  - usedJSHeapSize  // 当前 JS heap
  - totalJSHeapSize // 分配的总 heap
  - jsHeapSizeLimit // 浏览器给的硬上限 (WebView2 ~4GB 默认)

// 监控 chatData size
JSON.stringify(chatData.value).length  // 大概的序列化大小

// 监控每 session message count + image total base64 size
for (const [sid, d] of Object.entries(chatData.value)) {
  const base64Total = d.messages.reduce((sum, m) =>
    sum + (m.images || []).reduce((s, img) => s + (img.data?.length || 0), 0), 0);
  console.log(`session ${sid}: ${d.messages.length} msgs, base64=${base64Total / 1024 / 1024}MB`);
}
```

### 6.2 复现路径

**稳定复现 OOM** (用真凶 #2 + #3 叠加):
1. 创建新 session
2. 上传 5 张 1MB+ 原图 (或 1 张 5MB+ 大图)
3. 跑 10+ turn LLM 交互 (触发 20-50 次/turn 的 watch + saveToStorage)
4. 切到别 session 再切回 (让 chatData 多次深拷贝)
5. WebView2 渲染进程 OOM 死

**单独测真凶 #4**:
1. 创建新 session
2. 让 LLM 跑长对话 (50+ turn)
3. ChatMain v-for 渲染几百条 message
4. 滚动 / 切换折叠 → 响应变慢 → OOM

### 6.3 关键代码位置 (给 LLM 跳读)

| 文件 | 行号 | 内容 | 跟 OOM 关系 |
|---|---|---|---|
| `app/src/stores/chat.ts` | 92-96 | `watch(chatData, deep)` | 真凶 #3 |
| `app/src/stores/chat.ts` | 837-848 | `appendUserMessage` 推 user message | 真凶 #2 (入口) |
| `app/src/stores/chat.ts` | 998 | `data: img.base64` 注释 | 真凶 #2 (注释) |
| `app/src/stores/chatStorage.ts` | 51-87 | `saveToStorage` + `sanitizeForStorage` | 真凶 #3 (深拷贝) |
| `app/src/components/ChatMain/ChatMain.vue` | 339 | `v-for="(msg, idx) in messages"` | 真凶 #4 |
| `app/src/stores/session.ts` | 618-624 | `selectSession` 不释放 chat store | 真凶 #2 切 session 不释放 |
| `src-tauri/src/sidecar.rs` | 156-338 | `run_prompt` spawn 流程 | spawn-per-prompt 基线 |
| `sidecar/src/index.mjs` | 1952-1963 | `buildSessionContext` 全量灌 | 次要 #5.2 |
| `sidecar/src/externalToolsWatcher.mjs` | 13-32 | 5s grace period | 真凶 #1 (已修) |
| `src-tauri/src/sandbox/job_object.rs` | 8, 46 | 1GB / process Job 限制 | 次要 #5.3 |
| `src-tauri/src/lib.rs` | 112-148 | `cleanup_webview2_disk_cache` | 已修 (v3.63) |
| `app/src/lib/mock/types.ts` | (MessageImage) | image schema 定义 | 真凶 #2 schema |

### 6.4 实测内存分布 (2026-08-25 user 本机)

```
pi-agent-sidecar.exe (Node/bun):  WS 204MB / PRIV 381MB
pi-agent-desktop.exe (Tauri):     WS 52MB / PRIV 18MB
WebView2 进程树 ×2 (主 + 浏览器): 合计 ~2.2GB
EBWebView 磁盘缓存:                552MB (Cache 305 + Code 189 + 其他)
```

---

## 七、修复方向参考 (不写代码, 给推理用)

按 ROI 排序:

1. **真凶 #2 (单点治本, 改动小, ROI 最高)**: `appendUserMessage` images.data 改 savedPath 引用, 渲染时 lazy read. 改 3 处 (chat.ts + ChatMessage.vue + read_image_as_data_url Tauri command 已存在), 1 commit, 估 1-2h.

2. **真凶 #3 (防御, 改动小)**: `watch(chatData, deep)` → debounce 500ms + 不深拷贝 sanitize. 改 2 处 (chat.ts + chatStorage.ts), 1 commit, 估 30min.

3. **真凶 #4 (大改, 但收益大)**: ChatMain 引入虚拟滚动. 改 1 处 (ChatMain.vue), 1-2 commit, 估半天. 注意 D214 v15.1.14 教训: 滚动锚定要用 IntersectionObserver 找可视 item 重新 scroll, 不要改 scrollTop 数值.

4. **真凶 #2 + selectSession 释放非活跃 session (中等)**: session.ts:618 selectSession 加 hook, 清非活跃 session 的 messages, 切回 lazy reload. 改 2 处 (session.ts + chat.ts), 1 commit, 估 1h.

5. **次要 #5.1 (防御)**: sidecar.rs ActiveSidecars 加 N=3 上限, agent_end 60s 超时强杀. 改 1 处, 1 commit, 估 30min.

**强烈建议** (user 拍板): 1 + 2 + 3 三件套一起做, 估 1-2 天. 1+2 修内存根本, 3 修长对话扩展性.

**不推荐先做的**:
- 真凶 #1 修法: 已被 v3.57 修了, 不要再动
- 次要 #5.4 / #5.5: 风险 0
- 改 Pi SDK / spawn-per-prompt 架构: 改动巨大, ROI 低, 留给后续

---

## 八、文档自检 + 已修正的旧错误

### 之前 ADR-0024 写的 (错的)

- ❌ "真凶 #1: fs.watch 自激" — 实际是 v3.57 已修, 现存风险 0
- ❌ "真凶 #2: chat store 6.7MB content → Vue reactive → JS heap 爆" — **路径错**! 真实路径是 user message.images.data base64 累积, 不是 message_end 拆 content 覆盖 (v0.5.0-D 第10轮 revert 删了). 实际现象对, 根因错.

### 本文档 (对)

- ✅ 真凶 #1: fs.watch 自激 (已修 v3.57)
- ✅ 真凶 #2: user message images.data base64 累积 (新发现, 未修)
- ✅ 真凶 #3: watch deep + 深拷贝 save (新发现, 未修)
- ✅ 真凶 #4: 无虚拟滚动 (新发现, 未修)
- ✅ 次要 #5.1-5.5: 代码看出来, 没复现

### 之前 Pi Agent 自己的报告 (部分对, 部分不全)

- ✅ 4 个根源框架对
- ✅ spawn-per-prompt 风险对, 但**权重不对** (不是主凶)
- ✅ WebView2 渲染膨胀对, 但**根因分析错** (它说 v-for 全量渲染, 我发现叠加 #2 的 base64 才是真凶)
- ✅ localStorage 深拷贝对, 但**没指出 watch 触发频率** (这才是关键)
- ✅ 全量上下文加载对 (次要 #5.2)
- ⚠️ "agent_end 在 MiniMax / DeepSeek V4 Flash 偶尔丢失" — 没在源码里找到确切证据, 可能是 Pi SDK 内部行为, 需要 debug 验证

---

*本报告由 Mavis 手工分析 + 实机数据 + 源码审查, 数据 2026-08-25 当天. 不写修复代码, 留给别的 LLM 推理.*
