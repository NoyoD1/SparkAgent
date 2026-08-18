#!/usr/bin/env python3
"""v0.5.0-D 第11轮 STATUS.md 增量更新.

改动:
1. 生成时间: 2026-08-18 20:12 → 2026-08-19 01:35
2. 已落地阶段: 追加 v0.5.0-D 1-11
3. 当前版本: v0.5.0 (含 -PR2 + -PR3) → v0.5.0-D 第11轮
4. Release 产物 sizes 更新 (15.6/46.7/32.6 → 15.09/44.57/31.15)
5. Chat 核心 维度: 95% → 100% (narrative UI 完成)
6. 在 Section 0 之前插入 v0.5.0-D 1-11 速览
7. 文档同步缺口: v0.5.0-D 完成后状态
"""
import re
from pathlib import Path
from datetime import datetime

status_path = Path("STATUS.md")
text = status_path.read_text(encoding="utf-8")

# 1. 更新生成时间
text = text.replace(
    "> **生成时间**: 2026-08-18 20:12",
    f"> **生成时间**: 2026-08-19 01:35 (v0.5.0-D 第11轮 — narrative UI 完工)",
    1
)

# 2. 更新已落地阶段: 追加 v0.5.0-D 1-11
old_landed = "v0.5.0-PR2 (Provider current 归 input box) → v0.5.0-PR3 (Stop hang fix)"
new_landed = (
    "v0.5.0-PR2 (Provider current 归 input box) → v0.5.0-PR3 (Stop hang fix) → "
    "v0.5.0-D 第1-9轮 (echo filter 9 轮死循环, D194 教训) → "
    "v0.5.0-D 第10轮 (revert filter 死循环, 改回 v0.5.0-PR3 简单 append) → "
    "v0.5.0-D 第11轮 (per-step group narrative 风格, MiniMax Code UI 化)"
)
text = text.replace(old_landed, new_landed, 1)

# 3. 更新当前版本
text = text.replace(
    "| 当前版本 | v0.5.0 (含 -PR2 + -PR3) / last commit `33642a7` |",
    "| 当前版本 | **v0.5.0-D 第11轮** (含 -PR2 + -PR3 + D 1-11) / last commit `27966b2` |",
    1
)

# 4. 更新 Release 产物 sizes
text = text.replace(
    "| Release 产物 | `.exe 15.6 MB` / `.msi 46.7 MB` / `.nsis 32.6 MB` / sidecar 108 MB (bun compiled) |",
    "| Release 产物 | `.exe 15.09 MB` / `.msi 44.57 MB` / `.nsis 31.15 MB` / sidecar 108 MB (bun compiled) |",
    1
)

# 5. 更新 Chat 核心 维度: 95% → 100%
old_chat = "| 1 | Chat 核心 | 🟡 80% | ✅ 流式/Markdown/思考/工具/step/compaction 全做,Stop v0.5.0-PR3 兜底修 | **95%** | spec 没追到 v0.4.3-v0.5.0-PR3 |"
new_chat = "| 1 | Chat 核心 | 🟡 80% | ✅ 流式/Markdown/思考/工具/step/compaction 全做,Stop v0.5.0-PR3 兜底修,narrative UI v0.5.0-D 第11轮完工 | **100%** | spec 没追到 v0.4.3-v0.5.0-D 第11轮 |"
text = text.replace(old_chat, new_chat, 1)

# 6. 在 Section 0 之前插入 v0.5.0-D 1-11 速览
v050d_summary = """
## v0.5.0-D 1-11 轮速览 (D194 + D197)

> **9 轮 echo filter 死循环 + revert + narrative UI 化**, 集中处理 chat 核心问题

### v0.5.0-D 第1-9轮 (D194): echo filter 9 轮死循环
- 触发: deepseek-v4-flash / sensenova-6.7-flash-lite 在第一段 text_delta 原样复读 user 输入
- 错误路线: text-based heuristic filter, 每轮加规则漏 case
  - 第4轮: pure `startsWith` 漏 "X X The user"
  - 第5轮: + "X [sep] X" 模式 漏 "X? 我是 pi"
  - 第6轮: + "X 问句标点" 规则 (early return bug)
  - 第7轮: + afterFirst empty 也剥
  - 第8轮: 修 early return bug
  - 第9轮: 激进 always-strip (无 conditions) — "改了个寂寞 原地转圈" (用户反馈)
- **D194 教训**: 复杂文本启发式规则链 = 死胡同. 真 fix 在 system prompt + model 层, 不在 chat store 文本层

### v0.5.0-D 第10轮 (D194 revert): 删 echo filter 死循环
- chat.ts 删 2 个函数 (splitMessageContentIntoStep + stripLeadingUserEcho, 129 行)
- text_delta handler 改回 v0.5.0-PR3 简单 append
- 保留 v0.5.0-D 真有效修复: placeholder bug 修, assistantId const, willRetry 静默, auto_retry_start/end toast
- sidecar system prompt 简化: 5 条规则 → 1+1 条 (no-echo 带 Bad/Good 反例 + HTML 包代码块)
- **关键修复**: 第1条 no-echo 配 Bad/Good 反例, 实测 model 对 "具体反例" 比 "否定指令" 遵守率显著提升
- Commit: `c34d30e`

### v0.5.0-D 第11轮 (D197): per-step group narrative 风格 (MiniMax Code UI 化)
- 用户反馈: 图1 (旧 step group) 有 "框框" 突兀感, 跟整体 narrative 风格不一致
- 参考图2 (MiniMax Code) 重做 step group 视觉:
  - step head: 去掉 border + background, 仅 inline 文字 + chevron (opacity 0.7, hover opacity 1)
  - step body: 去掉 left border, 仅 padding-left 16px 缩进
  - thinking: 去掉 background block, 纯 italic text
  - tool card: 变 inline pill (单行, muted bg), status 变 simple dot + text
  - step number 圆形标签: 隐藏
  - current step: opacity 1 + 颜色微调 (不再 accent border)
  - assistant message 整体 gap 从 6px 缩到 2px, 更紧凑 narrative
- Commit: `27966b2`
- 6 个 artifacts: debug .exe 24.20 MB / release .exe 15.09 MB / debug .msi 47.36 MB / debug NSIS 32.54 MB / release .msi 44.57 MB / release NSIS 31.15 MB

### 端到端验证 (D197 后)
- 7 场景 NSIS install + chat 核心 PASS (用户实测)
- 第10轮: echo 修好 (新 prompt Bad/Good 反例对 sensenova-6.7-flash-lite 生效)
- 第11轮: chat UI 跟 MiniMax Code 一致, narrative 流式观感 OK

### 后续观察
- 系统 prompt 反例 prompt 是否长期有效: 需观察 1-2 周, sensenova / deepseek 系列
- 若 echo 复现, 候选方案:
  1. 换 model (deepseek-v4-flash / claude-haiku 比 sensenova-6.7-flash-lite 遵守率高)
  2. 接受 echo + 文档化 (model 层问题不在 chat store 处理)

---

"""
# 找到第一个 "## 0." 的位置, 插入 summary
m = re.search(r"^## 0\. 整体进度速览", text, re.MULTILINE)
if m:
    insert_pos = m.start()
    text = text[:insert_pos] + v050d_summary + "\n" + text[insert_pos:]

# 7. 更新 "文档同步缺口" 那段 (原 line 47 提到 7 spec 滞后)
old_doc_gap = "> **doc 滞后提醒**: 7 个 spec 文件(doc/03-features/)的状态栏还停留在 v0.4.2 step 1 之前(最后更新 2026-08-16),但实际代码已推进到 v0.5.0-PR3。**这是工作区已知问题,改完功能要回头同步 spec 状态**。"
new_doc_gap = "> **doc 滞后提醒**: 7 个 spec 文件(doc/03-features/)的状态栏还停留在 v0.4.2 step 1 之前(最后更新 2026-08-16),实际代码已推进到 v0.5.0-D 第11轮 (commit 27966b2, 2026-08-19)。**这是工作区已知问题,改完功能要回头同步 spec 状态**。P0 #12 (见 §4) 估时 1-2h, 本周可补。"
text = text.replace(old_doc_gap, new_doc_gap, 1)

# 8. 写回
status_path.write_text(text, encoding="utf-8")
print(f"OK: STATUS.md updated, {len(text)} chars")

# 验证
final = status_path.read_text(encoding="utf-8")
assert "v0.5.0-D 第11轮" in final, "v0.5.0-D 第11轮 not in final"
assert "27966b2" in final, "27966b2 not in final"
assert "2026-08-19 01:35" in final, "new timestamp not in final"
assert "100%" in final, "100% not in final (Chat 核心)"
assert "v0.5.0-D 1-11 轮速览" in final, "summary section not added"
print("OK: 5 assertions pass")
