# ADR-0006: marked v18 GFM 严格化的后处理修法

- **状态**: Accepted
- **日期**: 2026-08-15
- **决策者**: 自己

## 背景

升级 `marked` 到 v18+ 后，**严格按 GFM 规范**要求 `**bold**` 两侧必须有空白边界。LLM 输出的中文 markdown 经常直接用 `**bold**` 不加空格（如 `中文**加粗**中文`），结果不解析，字面 `**` 输出。

## 备选

### 锁旧版本 marked（v15 / v16）
- ✅ 不用改代码
- ❌ 错过 v18 安全修复
- ❌ 升级时必然要解决（marked major 版本激进）

### 前置 preprocessor（给所有 `**` 加空格）
- ✅ 简单
- ❌ 破坏 `**bold**` 内部结构
- ❌ 代码 / 公式里的 `**` 也被改

### 后处理 regex（marked.parse 后替换字面 `**X**`）✅
- ✅ 不破坏 marked 内部
- ✅ 限定 regex 不匹配已有 `<strong>`
- ✅ 简单可读
- ❌ 边界 case（`<` `>` `*` 嵌套）需小心
- ❌ 性能开销（每次 parse 多一道 regex）

### 换渲染库（`markdown-it` / `micromark`）
- ✅ 同样支持 GFM
- ❌ 同样有 GFM 严格化问题（不解决根本问题）
- ❌ 迁移成本

### 写自定义 parser
- ✅ 完全控制
- ❌ 过度工程
- ❌ 安全风险（自写 parser 易出 XSS）

## 决策

**后处理 regex**：

```ts
// MarkdownContent.vue
import { marked } from 'marked';
let html = marked.parse(content);
// GFM v18+ 严格边界: 中文**bold**中文 不解析, 补一道后处理
html = html.replace(/\*\*([^*\n<>]+?)\*\*/g, '<strong>$1</strong>');
```

理由：
1. 不破坏 marked 内部
2. 限定 regex 范围（`[^*\n<>]` 不匹配 `<` `>` 避免误伤 HTML 标签）
3. 跟 LLM 输出习惯对齐（LLM 经常不空格）

## 后果

- 正面:
  - 不锁 marked 版本（享受安全修复）
  - 不破坏 LLM 输出的其他 markdown 元素
  - 实现简单（一行 regex）
- 负面:
  - 边界 case（`<` `>` `*` 嵌套）要手动测
  - 每次 parse 多一道 regex（性能开销可忽略 — 几 ms）
- 中性:
  - 这是 workaround — 长期应该等 LLM 输出格式更稳定 / 或自定 marked tokenizer
  - 不影响 user 消息渲染（user 也写 markdown，但概率低）

## 何时 Revisit

- LLM 输出格式稳定（不再有 `中文**bold**中文` 漏空格）
- marked 升级后改了行为（regex 不再有效）
- 出现 XSS 报告（review regex 是否能绕过）
- 改用其他渲染库（连带重写）
- v1.0 之前考虑换成 marked 插件（`marked-extended-tables` 等）— 顺便关掉 GFM 严格化
