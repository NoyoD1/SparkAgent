# ADR-0016: Compaction 模块 (auto-compaction / 手动 / 指示器)

- **状态**: Accepted
- **日期**: 2026-08-19
- **最后同步**: v0.5.0-D 第27轮 (D210.3 + D210.4 压缩 UX 统一, 3 态 divider 替代 toast)
- **Type**: Functional
- **Module**: Compaction
- **决策者**: user
- **Relates to**: [0007-session-management](0007-session-management.md), [0005-pi-sdk-integration](0005-pi-sdk-integration.md), [0010-feature-chat](0010-feature-chat.md) (divider 渲染)

## 功能定义 (应该做什么)

- ✅ Auto-compaction (context window 用到 90% 自动压缩历史)
- ✅ 手动 compaction (Composer "压缩" 按钮)
- ✅ Compaction settings: reserveTokens / keepRecentTokens (Pi SDK 内部)
- ✅ Context window 实时指示 (Composer "X.XK / YK")
- ✅ 70% 高亮 (提示建议手动压缩)
- ✅ **3 态 divider** (in_progress / success / failure, 走 chat 区域横线, 不用 toast) — D210.3/D210.4
- ✅ **上下文累加清零** (compaction 成功时 cumulativeUsage + contextTokens 清零重计) — D209
- 🟡 Compaction 节省 tokens 显示
- ❌ 阈值配置 UI (user 改 reserveTokens)
- ❌ Compaction summary 预览

## 已实现 (v0.5.0-D 第27轮)

| 功能 | 状态 | 实现位置 | 核验方法 |
|---|---|---|---|
| Auto-compaction | ✅ | Pi SDK `shouldCompact` 内部 | 长对话触发, sidecar emit `compaction_start` |
| 手动 compaction | ✅ | Composer 按钮 → `piTauri.compactSession` → 独立 sidecar | 任意 context % 下点压缩, 看 chat 区域出现 divider |
| **3 态 divider** (in_progress / success / failure) | ✅ (D210.3/D210.4) | `chat.ts` compact() + handleCompactionEnd + `ChatMessage.vue` | 点压缩 → 立即: "─── 🔄 正在压缩… ───" (spinner 旋转); 成功 → 原地更新: "── ✓ 上下文已压缩 ───"; 失败 (e.g. 1% context Nothing to compact) → 原地更新: "── ⚠ 压缩失败: <errorMessage> ───" (橙色) |
| **上下文累加清零** | ✅ (D209) | `chat.ts` handleCompactionEnd | 跨 turn contextTokens 累加, compaction 成功时清零重计 |
| **临时 listener 防丢失事件** | ✅ (D210.3) | `chat.ts` compact() 注册临时 handler, 收 compaction_end 自动 off | 之前 compact() 启独立 sidecar 跑, emit 事件无人接; 现在临时 handler 接住 |
| Context indicator | ✅ (v0.4.3) | `ContextIndicator.vue` 紧凑指示器 | 看 Composer 下面 "X.XK / YK" |
| 70% 高亮 | ✅ | `isContextHigh` 触发 accent 颜色 | 长对话, 看 indicator 变橙 |
| popover 二级展开 | ✅ (v0.4.3) | CSS + 4-cat REAL breakdown | hover indicator, 看 4 分类 + 合计行 |

## 核验方法 (端到端, Phase 1 完整版)

### Auto-compaction 触发
1. 配小 context window model (e.g. 8K) + 长 prompt
2. 跑 10+ turn 对话
3. 看 sidecar stderr log 触发 `compaction_start: reason=threshold`
4. 验证 LLM 继续跑 (不报 overflow)
5. 看 session jsonl 文件有 compaction entry
6. 验证 chat 区域出现 success divider (D210.4 UX, 不是 toast)

### 手动 compaction
1. 任意 context % 下点 Composer 压缩按钮
2. **D210.4 验证**: 立即看到 chat 区域 "─── 🔄 正在压缩… ───" (spinner 旋转), **没有任何 toast**
3. 几秒后 (成功): 同一条横线原地更新成 "── ✓ 上下文已压缩 ───"
4. 几秒后 (失败, e.g. 1% context Pi SDK 报 Nothing to compact): 同一条横线原地更新成 "── ⚠ 压缩失败: Nothing to compact (session too small) ───" (橙色)
5. 验证 context 指示器数字清零 (D209 累加源 reset)
6. 验证 LLM 仍能继续对话 (历史摘要保留)

### Context indicator
1. 看 Composer 下面 "X.XK / YK" 实时更新
2. 跑到 70%+ 时, indicator 变橙
3. hover indicator, 看 popover 二级展开
4. popover: 4 分类 (input/output/cacheRead/cacheWrite) + 合计行 + "累加跨 turn · 主动压缩后清零重计" 说明

### Compaction settings
1. 跑小 model (8K), 长对话
2. 看是否 ~90% 触发 (Pi SDK default)
3. 想改阈值: 暂时只能改 Pi SDK settingsManager, 后续 P0 暴露 UI

## 已知问题 / 技术债

- 🟡 **节省 token 没显示**: user 不知道压缩了多少 (D210.4 删了 toast, 但没补上"节省 X tokens" 显示)
- 🟡 **阈值 UI 没暴露**: user 改不了 reserveTokens
- 🟡 **summary 走当前 model**: 大对话用大模型压缩成本高, v0.6 考虑用小模型 (gpt-4o-mini) 专门做 summary
- 🟡 **compaction 跟 LLM 调用走同一 stream**: 慢的时候也卡
- 🟡 **Auto-compaction 不走 in_progress divider**: D210.3 临时 listener 是给手动 compact() 用的, Pi SDK 内部自动 compaction (threshold / overflow) 直接 emit compaction_end, 找不到 in_progress marker → 兜底直接 push success / failure (没经过 compact() 推过 in_progress). 后续 P1 主动 push in_progress 让 UX 一致
- 🟡 **errorMessage 可能很长**: D210.4 加了 max-width 480px + ellipsis 截断, 但完整错误看不到 (后续可加 hover title)

## 后续规划

### P0 (v0.6)
- 节省 token 显示 ("已压缩 X tokens", 弹 divider 上, 不弹 toast)
- 阈值 UI 暴露 (reserveTokens / keepRecentTokens)

### P1 (v0.6 - v0.7)
- Auto-compaction 也走 in_progress divider (UX 一致性)
- Compaction summary 预览
- 用小模型 (gpt-4o-mini) 做 summary 省钱

### P2 (v0.7+)
- Compaction 策略可配 (LRU / summary / hybrid)
