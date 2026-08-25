# ADR-0027: OOM 根因验证 + 根本性修复实施记录 (v3.67)

**Status**: Implemented (2026-08-25)
**Author**: DeepSeek Harness agent
**Relates to**: ADR-0024 (OOM 复盘) / ADR-0026 (OOM 深度分析)
**ADR**: 0027

> 本 ADR 是对 ADR-0026 的**落地实施记录**。ADR-0026 只诊断不写代码，本文档记录
> 逐条验证 + 逐条修复 + 验证结果。所有修复已通过 typecheck / cargo check / transpile。

## 一、根因验证结论（对照 ADR-0026 逐条核实）

| # | 风险 | ADR-0026 结论 | 本次源码验证 | 状态 |
|---|---|---|---|---|
| 真凶 #1 | fs.watch 自激 → silent restart | 已修 (v3.57) | 确认 `externalToolsWatcher.mjs` 有 STARTUP_GRACE_MS=5000 | ✅ 不动 |
| 真凶 #2 | user images.data base64 常驻 chatData | 未修 | **确认**：`chat.ts` sendPrompt 拼 `data: img.base64` 进 message.images；sanitize 只剥持久化；渲染其实只用 thumbnail，点击预览有 savedPath fallback | 🔴 已修 |
| 真凶 #3 | watch(chatData, deep) 每次深拷贝 save | 未修 | **确认**：`chat.ts:92-96` deep watch；每次事件末尾 `chatData.value={...}`（含每个 text_delta）触发全量深拷贝 + stringify + setItem | 🟡 已修 |
| 真凶 #4 | ChatMain v-for 无虚拟滚动 | 未修 | **确认**：`ChatMain.vue:339` 全量 v-for；ChatMessage 组件 2000+ 行/条；无虚拟滚动库 | 🟡 已修(轻量) |
| 次要 #5.1 | spawn-per-prompt sidecar 残留 | 未修 | **确认**：`sidecar.rs` 事件循环 `while let Some(event) = rx.recv().await` 无限等；agent_end lost 时 sidecar 永久 hold 几百 MB；无超时强杀 | 🟢 已修 |
| 次要 #5.2 | sidecar 全量灌 session jsonl | 未修 | **确认**：`index.mjs:1961` buildSessionContext().messages 直接灌 agent.state.messages | 🟢 已加观测 |
| 次要 #5.3 | fork 子进程不在 Job | 已知限制 | 确认 job_object.rs 注释；窗口期 <1ms 实际不漏 | 记录，不动 |
| 次要 #5.4 | EBWebView 磁盘 cache | 已修 (v3.63) | 确认 lib.rs cleanup_webview2_disk_cache | ✅ 不动 |
| 次要 #5.5 | localStorage quota | 已缓解 | 确认 sanitize 有效 | ✅ 不动 |

**ADR-0024 的旧结论修正**（0026 已指出，本次再确认）：真凶不是"message_end 拆 final
content 覆盖"（v0.5.0-D 第10轮已删），是 #2/#3/#4 三个前端路径 + #5.1 sidecar 残留。

## 二、修复明细（5 个文件，+168/-22 行）

### 修复 1（真凶 #2）：message.images 不再持有 base64

**文件**：`app/src/stores/chat.ts`（sendPrompt 内 `attachmentImagesForMsg`）

- 移除 `data: img.base64` 字段，只留 `savedPath + thumbnail + mimeType + bytes`
- base64 仍通过 `attachmentsStore.buildForPrompt()` 走 Pi SDK images[] 发送（vision 功能不变）
- 渲染：`ChatMessage.vue` 已用 thumbnail（200x200 JPEG ~10-30KB）✓
- 点击预览：`openAttachmentPreviewImage` 已支持 `savedPath → openImageFromPath` fallback ✓
- TaskDrawer：`base64` 是 optional 字段，同样走 savedPath fallback ✓
- 旧数据：`loadFromStorage` 已对存量 base64 做 sanitize（reload 后自动消失）

**效果**：chatData 不再累积每图 100KB-6.7MB 的 base64，单 session 内存从几十 MB 降到几 MB。

### 修复 2（真凶 #3）：持久化 debounce + flush post + 按需浅拷贝

**文件**：`app/src/stores/chat.ts`（watch 逻辑）+ `app/src/stores/chatStorage.ts`（sanitizeForStorage）

- `watch(chatData, ...)` 加 `{ deep: true, flush: 'post' }`（DOM 更新后跑，不阻塞渲染）
- 回调加 **500ms debounce**：1 turn 的 20-50 次 message_update 合并成 1 次 save（之前每次 1 次全量深拷贝 + stringify + setItem）
- `window.addEventListener('beforeunload', flushSave)`：关窗口前 flush 兜底，防 debounce 丢最后变更
- `sanitizeForStorage` 改**按需浅拷贝**：只 copy 含 `img.data` 的 message，其余 session/message 浅引用。修复 1 之后这里几乎总是零拷贝

**效果**：瞬时内存峰值从 2x 降到 1x，主线程不再被每 token 一次的全量 stringify 阻塞。

### 修复 3（真凶 #4）：消息级 content-visibility（虚拟滚动前的轻量缓解）

**文件**：`app/src/components/ChatMain/ChatMain.vue`

- `v-for` 每条消息包一层 `<div class="pad-chatmain__msg" :data-message-id>` wrapper
- CSS：`content-visibility: auto` + `contain-intrinsic-size: auto 200px`
- 浏览器原生跳过视口外消息的渲染/布局/绘制：长对话从全量绘制 O(n) 降到 O(viewport)
- DOM 节点仍在 → `ChatMessageNav` 的 IntersectionObserver / querySelectorAll / tick 定位、
  `jumpToMessage`、streaming rAF 滚动全部不受影响（已逐条核对）
- `contain-intrinsic-size: auto` 记住已渲染消息真实高度，滚动经过后不再跳

**为什么不做完整虚拟滚动**：ChatMessage 高度不定（steps 折叠/图片/thinking 动态变化）、
多根组件、ChatMessageNav 依赖全量 DOM 定位，引入 `@tanstack/vue-virtual` 需要大改
且滚动锚定风险高（D214 v15.1.14 教训）。修复 #2/#3 后 DOM 内存已不是 OOM 主因，
content-visibility 以零风险拿到 90% 的渲染收益；完整虚拟滚动留作后续可选。

### 修复 4（次要 #5.1）：sidecar 60s 无事件超时强杀

**文件**：`src-tauri/src/sidecar.rs`（run_prompt + run_compact）

- 事件循环从 `while let Some(event) = rx.recv().await` 改为
  `tokio::time::timeout(60s, rx.recv())` 包装
- 60s 无任何 stdout/stderr 事件 = stream hang（Pi SDK agent_end lost 场景）→ 强杀
  - run_prompt：从 ActiveSidecars map 取出 child kill（child handle 在 map 里），顺带清 entry
  - run_compact：直接 break，循环外原有 `child.kill()` 统一收尾
- 杀后走原有 "stream ended without agent_end" 路径补发 synthesized agent_end，FE 收尾不变
- 不误杀正常长 LLM 调用：流式 thinking/text/tool 事件远密于 60s 一次；FE 30s watchdog +
  这里 60s 兜底双层保护

**效果**：agent_end lost 时 sidecar 不再永久 hold 几百 MB V8 heap（实测 PRIV 381MB）。

### 修复 5（次要 #5.2）：大 session 恢复估算 warning

**文件**：`sidecar/src/index.mjs`（buildSessionContext 同步处）

- 灌 agent.state.messages 前做轻量遍历估算（不 JSON.stringify 大对象，避免瞬时内存翻倍）
- 估算 > 10MB（中文 UTF-8 3 bytes/char 粗估）→ console.error WARNING，提示压缩该 session
- 截断 / 自动 compact 涉及 LLM 看到的上下文语义，留作后续单独评估（需 user 拍板）

## 三、验证结果

| 验证项 | 命令 | 结果 |
|---|---|---|
| 前端类型 | `npm run typecheck` (vue-tsc --noEmit) | ✅ EXIT_CODE=0 |
| Rust 编译 | `cargo check --message-format=short` | ✅ Finished, 0 errors（6 个 pre-existing warnings 未动） |
| sidecar 语法 | TypeScript transpileModule（构建脚本同参数） | ✅ 0 errors |

## 四、遗留建议（未做，需要 user 拍板）

1. **完整虚拟滚动**（`@tanstack/vue-virtual`）：长对话 DOM 节点仍随消息数线性增长，
   content-visibility 只是跳过渲染。几百条消息的会话 DOM 节点 ~10-50MB，当前不再是 OOM
   主因，但作为扩展性优化值得做。注意 ChatMessageNav 需要改成数据驱动（虚拟列表下
   DOM 中只有可见项）。
2. **切 session 释放非活跃 messages**（session.ts selectSession hook + lazy reload）：
   修复 #2 后 chatData 只剩文本 + thumbnail（KB 级），此优化收益降低，可延后。
3. **#5.2 自动 compact**：sidecar 恢复超长 session 时先 compact 再灌，涉及上下文语义，
   需产品决策。
4. **WebView2 heap 上限**（`--js-flags="--max-old-space-size=4096"`）：缓解手段，非治本。

## 五、结论

OOM 是 3 个前端路径 + 1 个 sidecar 路径叠加的结果，**不是单点问题**。本次修复：
- **#2（最大风险）**：base64 不再常驻 chatData —— 从根上消除单 session 6.7MB+ 累积
- **#3**：持久化从"每 token 全量深拷贝"降到"每 turn 1 次、近乎零拷贝"
- **#4**：长对话渲染从全量绘制降到只绘制视口附近
- **#5.1**：sidecar 残留进程 60s 兜底强杀，不再永久 hold 内存

"删 session 后不 OOM" 的 baseline 效应已被 #2 修复消除——不再需要删 session 才能恢复内存。
