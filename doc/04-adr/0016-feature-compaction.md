# ADR-0016: Compaction 模块 (auto-compaction / 手动 / 指示器)

- **状态**: Accepted
- **日期**: 2026-08-19
- **最后同步**: v0.6 (N3+N4+N6+N7+P0-C 落地 + auto-compaction 通用 tab toggle)
- **Type**: Functional
- **Module**: Compaction
- **决策者**: user
- **Relates to**: [0007-session-management](0007-session-management.md), [0005-pi-sdk-integration](0005-pi-sdk-integration.md), [0010-feature-chat](0010-feature-chat.md) (divider 渲染)

## 功能定义 (应该做什么)

- ✅ Auto-compaction (Pi SDK 0.84.2 `shouldCompact(ctx, win, settings)` 检测 `ctx > win - reserveTokens`; 200K 窗口默认约 **92%** 触发, 跟 user 期望的 90% 差 2%, Pi SDK 内部硬编码改不了, ADR 已标注)
- ✅ 手动 compaction (Composer "压缩" 按钮 → 独立 sidecar force-spawn 跑 compact)
- 🟡 Compaction settings: reserveTokens / keepRecentTokens (Pi SDK 0.84.2 内部硬编码, `getCompactionReserveTokens`/`getCompactionKeepRecentTokens` 只读 getter, **不能在 UI 调整**)
- ✅ Context window 实时指示 (Composer "X.XK / YK" + popover 头部高亮 summary "X.XK / YK (Z%) · model 名")
- ✅ 70% 高亮 (提示建议手动压缩) — 阈值走 `isContextHigh()`, 跟 Pi SDK 触发阈值 92% **不是同一个**
- ✅ **3 态 divider** (in_progress / success / failure, 走 chat 区域横线, 不用 toast) — D210.3/D210.4
- ✅ **上下文累加清零** (compaction 成功时 contextTokens 清零, 跨 turn 不再手动累加改 per-turn 覆盖) — D209 + N4 反向修
- ✅ **节省 tokens 显示** (手动 compact 成功时显示"释放 X tokens", auto-compaction 路径不显示) — P0-C
- ✅ **6 分类 (FE 估算) 重新加到 popover** (消息/工具/系统提示词/记忆/技能/其他) — N3
- 🟡 **通用 tab 开关** (auto-compaction on/off, 关闭时 100% 触发靠 Pi SDK overflow 兜底) — N1+N2
- ❌ Compaction summary 预览
- ❌ 阈值配置 UI (user 改 reserveTokens, Pi SDK 0.84.2 不支持, 等升级)

## 已实现 (v0.6)

### v0.6 (N3 + N4 + N6 + N7 + P0-C + 第二/三批)

| 功能 | 状态 | 实现位置 | 核验方法 |
|---|---|---|---|
| **修 D209 累加 bug (N4+N7)** | ✅ | `chat.ts:1395-1506` message_end | Pi SDK 0.84.2 usage.input/cacheRead/cacheWrite 是 per-request, 跨 turn 累加会重复计算 cache 命中. 改 per-turn 覆盖, 公式 `input + cacheRead + cacheWrite` (跟 Claude Code 主流一致). 跨 turn 数字自然增长 (history 越来越长 LLM 报 totalTokens 也越来越大) |
| **节省 tokens 显示 (P0-C)** | ✅ | `chat.ts` compact() 记录 beforeCompact + handleCompactionEnd 算 freedTokens + `ChatMessage.vue` 渲染 | 手动 compact 成功 → divider "上下文已压缩 (释放 X tokens)". auto-compaction 路径不显示 (Pi SDK 不报"释放量") |
| **6 分类 (图 1 风格, N3)** | ✅ | `ContextIndicator.vue` popover 第二个 section (在 4 分类下面) | 重新渲染 `getContextBreakdown` (消息/工具/系统提示词/记忆/技能/其他, FE 估算, 跟 4 分类 REAL 互补) |
| **popover 头部高亮 summary (N6)** | ✅ | `ContextIndicator.vue` 新增 summary 行 | 显示 "X.XK / YK (Z%) · model 名". model 名用 per-session 优先 (Bug1 修, 之前用 configStore.activeModel 不跟 Composer 切 model 联动). 70% 高亮时整行橙色边框 |
| **通用 tab auto-compaction toggle (N1+N2)** | ✅ | `Settings/tabs/GeneralTab.vue` + Rust `set_compaction_enabled` | 写文件 (持久化, 兜底) + 给 active session 发 RPC 触发热更 (Pi SDK 内部 setCompactionEnabled 会 `this.settings = deepMergeSettings` 热更新). 闲置 session 走"下次启 sidecar 时读新 settings.json 自动生效" |
| **Bug2 修: 绕开 sidecar 依赖** | ✅ | `lib.rs` 新增 `get_compaction_enabled` / `set_compaction_enabled` Tauri commands | 之前 `sendRpcCommand(sid, { type: 'set_auto_compaction' })` 闲置 session 报 "no active sidecar". 改 Rust 端直接读写 `~/.pi/agent/settings.json` (跟 Pi SDK 0.84.2 `FileSettingsStorage.globalSettingsPath` 一致) |

### v0.5.0-D 第27轮 (D209 / D210.3 / D210.4)

| 功能 | 状态 | 实现位置 | 核验方法 |
|---|---|---|---|
| Auto-compaction | ✅ | Pi SDK `shouldCompact` 内部 | 长对话触发, sidecar emit `compaction_start` |
| 手动 compaction | ✅ | Composer 按钮 → `piTauri.compactSession` → 独立 sidecar (force-spawn) | 任意 context % 下点压缩, 看 chat 区域出现 divider |
| **3 态 divider** (in_progress / success / failure) | ✅ (D210.3/D210.4) | `chat.ts` compact() + handleCompactionEnd + `ChatMessage.vue` | 点压缩 → 立即: "─── 🔄 正在压缩… ───" (spinner 旋转); 成功 → 原地更新: "── ✓ 上下文已压缩 ───"; 失败 → 原地更新: "── ⚠ 压缩失败: <errorMessage> ───" (橙色) |
| **临时 listener 防丢失事件** | ✅ (D210.3) | `chat.ts` compact() 注册临时 handler, 收 compaction_end 自动 off | 之前 compact() 启独立 sidecar 跑, emit 事件无人接; 现在临时 handler 接住 |
| Context indicator | ✅ (v0.4.3) | `ContextIndicator.vue` 紧凑指示器 | 看 Composer 下面 "X.XK / YK" + 实时更新 |
| 70% 高亮 | ✅ | `isContextHigh` 触发 accent 颜色 | 长对话, 看 indicator 变橙 |
| popover 二级展开 | ✅ (v0.4.3) | CSS + 4-cat REAL breakdown | hover indicator, 看 4 分类 + 合计行 |

## 核验方法 (端到端)

### Auto-compaction 触发 (Pi SDK 内部)
1. 配小 context window model (e.g. 8K) + 长 prompt
2. 跑 10+ turn 对话
3. 看 sidecar stderr log 触发 `compaction_start: reason=threshold`
4. 验证 LLM 继续跑 (不报 overflow)
5. 看 session jsonl 文件有 compaction entry
6. 验证 chat 区域出现 success divider (D210.4 UX, 不是 toast)

### 手动 compaction (修后 v0.6)
1. 任意 context % 下点 Composer 压缩按钮
2. 立即看到 chat 区域 "─── 🔄 正在压缩… ───" (spinner 旋转), **没有任何 toast**
3. 几秒后 (成功): 同一条横线原地更新成 "── ✓ 上下文已压缩 (释放 X tokens) ───" (P0-C 数字)
4. 几秒后 (失败, e.g. 1% context Pi SDK 报 Nothing to compact): 原地更新成 "── ⚠ 压缩失败: <errorMessage> ───" (橙色)
5. 验证 context 指示器数字清零 (D209 累加源 reset)
6. 验证 LLM 仍能继续对话 (历史摘要保留)

### Context indicator (修后 v0.6)
1. 看 Composer 下面 "上下文 X%" 实时更新 — **不再虚高** (D209 累加 bug 修了)
2. 跑到 70%+ 时, indicator 变橙 (走 `isContextHigh` UI 阈值, 跟 Pi SDK 触发 92% 不是同一个)
3. hover indicator, popover 二级展开
4. popover 顶部: "X.XK / YK (Z%) · model 名" (N6, 70% 时变橙色)
5. popover 中间: 4 分类 REAL (input/output/cacheRead/cacheWrite) + 合计行 + "本次 turn 实测 · 主动压缩后清零重计"
6. popover 底部: 6 分类 FE 估算 (消息/工具/系统提示词/记忆/技能/其他, N3)

### Auto-compaction 通用 tab 开关 (v0.6 N1+N2)
1. Cmd+, 打开 Settings → 通用 tab
2. tab 打开时 F12 应该看到 `[GeneralTab] loaded compaction.enabled=... from settings.json` log
3. toggle 默认 "已启用" (Pi SDK `DEFAULT_COMPACTION_SETTINGS.enabled = true`)
4. 切 toggle → F12 看到 `[GeneralTab] set_compaction_enabled=X 写入 settings.json` + (有 active session) `[GeneralTab] 热更 RPC sent to sess-xxx` log
5. toast 根据 active session 情况分:
   - 有 active session: "已启用自动压缩 (当前 session 立即生效, threshold 92% 触发)"
   - 闲置 session: "已启用自动压缩 (当前 session 下次发 prompt 时生效, threshold 92% 触发)"
   - 没 active session: "已启用自动压缩 (下次 session 启动生效, threshold 92% 触发)"
6. 验证文件被改: `type %USERPROFILE%\.pi\agent\settings.json` 应该能看到 `"compaction": { "enabled": X }`

### Compaction settings 阈值
1. 跑小 model (8K), 长对话
2. 看是否 ~92% 触发 (Pi SDK default `reserveTokens=16384`, 200K 窗口下约 92%)
3. 想改阈值: **Pi SDK 0.84.2 不支持** (settingsManager 只暴露 enabled setter, reserveTokens/keepRecentTokens 是只读 getter, 不可改). 通用 tab 已经做开关, 阈值调整等 Pi SDK 升级

## 已知问题 / 技术债

- 🟡 **触发阈值不能调** (Pi SDK 0.84.2 限制): `reserveTokens=16384` 跟 `keepRecentTokens=20000` 是 Pi SDK 内部硬编码, settingsManager 只暴露 `enabled` setter, 不能改. user 期望 90% 触发, 实际 92% (200K 窗口下), 差 2% 体验上不严重
- 🟡 **summary 走当前 model**: 大对话用大模型压缩成本高, v0.7 考虑用小模型 (gpt-4o-mini) 专门做 summary
- 🟡 **compaction 跟 LLM 调用走同一 stream**: 慢的时候也卡
- 🟡 **Auto-compaction 不走 in_progress divider** (P1): D210.3 临时 listener 是给手动 compact() 用的, Pi SDK 内部自动 compaction (threshold / overflow) 直接 emit compaction_end, 找不到 in_progress marker → 兜底直接 push success / failure (没经过 compact() 推过 in_progress). 后续 P1 主动 push in_progress 让 UX 一致
- 🟡 **errorMessage 可能很长**: D210.4 加了 max-width 480px + ellipsis 截断, 但完整错误看不到 (后续可加 hover title)
- 🟡 **跨 session 不强制同步 enabled**: 通用 tab 写文件 + 给 active session RPC 热更, 其他闲置 session 不主动 kill, 等下次启 sidecar 自然读新值. 严格意义上"未启 sidecar 的 session"还是旧值, 实际跑 prompt 时才生效

## 后续规划

### P0 (v0.6) — ✅ 已完成
- ✅ 节省 token 显示 ("已压缩 X tokens", 嵌 success divider, 不弹 toast) — P0-C
- ❌ 阈值 UI 暴露 — **Pi SDK 0.84.2 不支持**, 改"通用 tab enabled 开关" (N1+N2) 作为替代
- ✅ 修 D209 累加 bug (N4+N7) — contextTokens 跨 turn 不再虚高, per-turn 覆盖, 公式 input+cacheRead+cacheWrite
- ✅ 6 分类 (N3) — 跟 4 分类 REAL 互补, "用在哪里" 维度
- ✅ popover 头部高亮 summary (N6) — "X.XK / YK (Z%) · model 名"
- ✅ 通用 tab auto-compaction 开关 (N1+N2) — 写 settings.json + RPC 热更, Bug2 修

### P1 (v0.7)
- Auto-compaction 也走 in_progress divider (UX 一致性) — 跟之前 R3 一致
- Compaction summary 预览
- 用小模型 (gpt-4o-mini) 做 summary 省钱 — 待查 Pi SDK 0.84.2 是否支持自定义 summarization model

### P2 (v0.7+)
- 升级 Pi SDK 后重评估 (R5/R6 风险) + 阈值 UI 改 reserveTokens (如果 0.84.2+ 暴露 setter)
- Compaction 策略可配 (LRU / summary / hybrid)
- 跨 session 强制同步 enabled (e.g. 写文件后主动 kill 所有 active sidecar, 让下次启 sidecar 读新值)

## 模拟脚本

`app/test-compaction-context.js` — 5 turn 对话 + 图 1 真实数据 + Claude Code 主流算法对齐验证
- 跑法: `node app/test-compaction-context.js`
- 输出: 修前 5 turn 后虚高到 863, 修后稳定 233 (跟真实 context 一致)
- 零依赖, 任何 Node 环境可跑

## 相关 commit

- `8e3fa18` v0.6 context window overhaul: N3+N4+N6+N7+P0-C + auto-compaction toggle
