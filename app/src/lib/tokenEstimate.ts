/**
 * v0.5.0-D 第12轮: Token 估算工具
 *
 * 用途: 6 分类 context breakdown (消息/工具/系统提示词/技能/记忆/其他)
 * Pi SDK 0.84.2 给的 usage.input/output/cacheRead/cacheWrite 是 LLM 端实际 token 数,
 * 但 FE 端要按"token 来源"分, 需要从内容侧估算.
 *
 * 精度: rough estimate. 真实 LLM token 数 (BPE/SentencePiece) 需要 tokenizer lib,
 * FE 端用启发式 (中文 1 char ≈ 1 token, 英文 1 token ≈ 4 chars) 够用.
 *
 * 不引第三方依赖, 保持 bundle 小.
 */

/**
 * 估算一段文本的 token 数 (启发式).
 * - CJK 字符 (U+4E00-U+9FFF + 扩展): 每个 1 token
 * - 其他字符: 每 4 个 1 token
 * - 不考虑 subword / BPE 实际切分, 仅按字符类型粗估
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let tokens = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    // CJK Unified Ideographs + 扩展 A-G
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||  // 扩展 A
      (code >= 0x20000 && code <= 0x2a6df) || // 扩展 B
      (code >= 0x2a700 && code <= 0x2b73f) ||
      (code >= 0x2b740 && code <= 0x2b81f) ||
      (code >= 0x2b820 && code <= 0x2ceaf) ||
      (code >= 0xf900 && code <= 0xfaff)    // CJK Compatibility Ideographs
    ) {
      tokens += 1;
    } else {
      tokens += 0.25;
    }
  }
  return Math.ceil(tokens);
}

/**
 * Token breakdown 6 分类 (Pi SDK usage.input 的来源构成)
 * 数字是估算的 token 数, 跟 LLM 实际 usage.input 可能略有出入
 *
 * v0.5.0-D 第21轮 (D208): 真实数据 (REAL) 来自 Pi SDK lastUsage 4 分类
 *   input / output / cacheRead / cacheWrite, 这些是 LLM 端实测数字, 不估算.
 *   6 分类 (FE 估算) 跟 4 分类 (REAL 数据) 是两个维度, 互补:
 *   - 4 分类告诉"用了多少 token" (input/output/cacheRead/cacheWrite)
 *   - 6 分类告诉"用在哪里" (消息/工具/系统提示词/技能/记忆/其他)
 *   FE 端 UI 主显示 4 分类 REAL, 6 分类 ESTIMATED 作为辅助.
 */
export interface ContextBreakdown {
  messages: number;        // 消息 (user + assistant content 累加, FE 估算)
  tools: number;           // 工具 (7 tool definitions 估算 ~800 tokens, FE 估算)
  systemPrompts: number;   // 系统提示词 (base + context_awareness + response_style, ~2500, FE 估算)
  skills: number;          // 技能 (enabled skills 的 .md content 累加, FE 估算)
  memory: number;          // 记忆 (AGENTS.md content, FE 暂未读取, 估 0)
  other: number;           // 其他 = contextTokens - 上 5 项之和 (RE: 跟 LLM 真实值对齐)
}

/**
 * v0.5.0-D 第21轮 (D208): Token breakdown REAL 数据 (Pi SDK lastUsage 4 分类)
 *   这是 LLM 端实测的 token 数, 不是 FE 估算.
 *   - input: 本次新加入 context 的 input tokens (没 cache 命中的部分)
 *   - output: 本次 response 的 output tokens
 *   - cacheRead: 命中 cache 的 input tokens (节省的部分)
 *   - cacheWrite: 本次新写入 cache 的 input tokens
 *   total = input + output + cacheRead + cacheWrite
 *   context (context window usage) = input + cacheRead (LLM 看到的 context 大小)
 */
export interface ContextBreakdownReal {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
