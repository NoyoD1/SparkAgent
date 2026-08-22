/**
 * v0.5.0-D 第30轮 (D213) — Model metadata 静态 catalog.
 *
 * 背景 (用户 D213 反馈): provider 配完之后, 每个 model 的 6 个 metadata 字段
 *   (type/vision/contextWindow/maxOutput/maxRounds/reasoning) 都要手填. 但这些其实
 *   每个厂家都是公开/标准的, 完全可以一次性维护让 FE 自动填.
 *
 * 现实情况:
 *   - Anthropic: 没 list API, 必须静态 catalog
 *   - OpenAI: /v1/models 只返 id, 必须静态 catalog
 *   - Google Gemini: /v1beta/models 真有 inputTokenLimit/outputTokenLimit,
 *     走 PI/P2 加 live API 解析 (本期不做, 留 TODO)
 *   - DeepSeek / Moonshot / Groq / MiniMax: list API 只返 id, 静态 catalog
 *   - openai-compatible: 部分 (OpenRouter / Together 风格) 响应有 context_length 字段,
 *     fetch_provider_models 那边做 best-effort parse, 走 catalog fallback
 *
 * 维护策略:
 *   - 本文件覆盖每个内置 provider 主流 5-10 个 model, 数据以官方文档为准
 *   - maxRounds 不在 catalog 里 (各家都没标准, 留给用户自己配)
 *   - model_type 暂时都 "chat", 未来加 image / embedding 等再扩
 *   - 加新 model: 直接在本文件加一行 + 跑 cargo check 验
 */
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ModelMetadata {
    /// 上下文窗口 (tokens). None = 未知, FE form 留空让用户填
    pub context_window: Option<u32>,
    /// 单次回复最大 tokens
    pub max_output: Option<u32>,
    /// 是否支持图片输入
    pub vision: Option<bool>,
    /// 是否思考模型 (DeepSeek-R1 / Claude extended thinking / OpenAI o1)
    pub reasoning: Option<bool>,
    /// "chat" | "image" | "embedding" | "video" | "audio" — 路由用
    pub model_type: Option<String>,
}

/// 给定 provider type, 返回该 provider 所有已知 model 的 metadata.
/// FE 在添加新 provider / 拉新 model 列表时调.
pub fn get_catalog_for(provider_type: &str) -> HashMap<String, ModelMetadata> {
    match provider_type {
        "anthropic" => anthropic_catalog(),
        "openai" => openai_catalog(),
        "deepseek" => deepseek_catalog(),
        "moonshotai" => moonshotai_catalog(),
        "google" => google_catalog(),
        "groq" => groq_catalog(),
        "minimax" => minimax_catalog(),
        _ => HashMap::new(),  // openai-compatible 走 best-effort parse, 不进 catalog
    }
}

/// 单条插入 helper — 减少 catalog 定义的 boilerplate
fn m(context: u32, max_out: u32, vision: bool, reasoning: bool) -> ModelMetadata {
    ModelMetadata {
        context_window: Some(context),
        max_output: Some(max_out),
        vision: Some(vision),
        reasoning: Some(reasoning),
        model_type: Some("chat".to_string()),
    }
}

/// Anthropic Claude 3.x 系列. 全部 200K ctx.
/// (v0.4.4.6 FE 硬编码 BUILTIN_MODELS 跟这同步)
fn anthropic_catalog() -> HashMap<String, ModelMetadata> {
    let mut c = HashMap::new();
    // Claude 3.5 系列 — 8K out, vision
    c.insert("claude-3-5-sonnet-latest".into(),    m(200_000, 8_192, true, false));
    c.insert("claude-3-5-sonnet-20241022".into(),  m(200_000, 8_192, true, false));
    c.insert("claude-3-5-sonnet-20240620".into(),  m(200_000, 8_192, true, false));
    c.insert("claude-3-5-haiku-latest".into(),     m(200_000, 8_192, true, false));
    // Claude 3 Opus — 4K out, vision
    c.insert("claude-3-opus-latest".into(),        m(200_000, 4_096, true, false));
    c.insert("claude-3-opus-20240229".into(),      m(200_000, 4_096, true, false));
    // Claude 3 Haiku — 4K out, 纯文本 (没 vision)
    c.insert("claude-3-haiku-20240307".into(),     m(200_000, 4_096, false, false));
    c
}

/// OpenAI GPT-4o / o1 / o3-mini 系列
fn openai_catalog() -> HashMap<String, ModelMetadata> {
    let mut c = HashMap::new();
    // GPT-4o — 128K ctx, 16K out, vision
    c.insert("gpt-4o".into(),        m(128_000, 16_384, true,  false));
    c.insert("gpt-4o-mini".into(),   m(128_000, 16_384, true,  false));
    c.insert("gpt-4o-2024-08-06".into(), m(128_000, 16_384, true,  false));
    // GPT-4 Turbo — 128K ctx, 4K out, vision
    c.insert("gpt-4-turbo".into(),          m(128_000, 4_096, true,  false));
    c.insert("gpt-4-turbo-2024-04-09".into(), m(128_000, 4_096, true,  false));
    // GPT-4 classic — 8K ctx, 8K out, no vision
    c.insert("gpt-4".into(),                m(8_192, 8_192, false, false));
    c.insert("gpt-4-32k".into(),           m(32_768, 8_192, false, false));
    // GPT-3.5 Turbo — 16K ctx
    c.insert("gpt-3.5-turbo".into(),       m(16_385, 4_096, false, false));
    // o1 reasoning 系列
    c.insert("o1".into(),         m(200_000, 100_000, true,  true));
    c.insert("o1-mini".into(),    m(128_000, 65_536,  false, true));
    c.insert("o1-preview".into(), m(128_000, 32_768,  false, true));
    c.insert("o3-mini".into(),    m(200_000, 100_000, false, true));
    c
}

/// DeepSeek. chat / reasoner / coder — 64K ctx.
fn deepseek_catalog() -> HashMap<String, ModelMetadata> {
    let mut c = HashMap::new();
    c.insert("deepseek-chat".into(),     m(64_000, 8_192,  false, false));
    c.insert("deepseek-reasoner".into(), m(64_000, 32_768, false, true));  // R1 系列
    c.insert("deepseek-coder".into(),   m(64_000, 8_192,  false, false));
    c
}

/// Moonshot Kimi. 8K / 32K / 128K 三个档.
fn moonshotai_catalog() -> HashMap<String, ModelMetadata> {
    let mut c = HashMap::new();
    c.insert("moonshot-v1-8k".into(),    m(8_192,  8_192, false, false));
    c.insert("moonshot-v1-32k".into(),   m(32_768, 8_192, false, false));
    c.insert("moonshot-v1-128k".into(),  m(131_072, 8_192, false, false));
    c.insert("moonshot-v1-auto".into(),  m(131_072, 8_192, false, false));  // auto-routing
    c
}

/// Google Gemini. 1M-2M 上下文, vision 默认.
fn google_catalog() -> HashMap<String, ModelMetadata> {
    let mut c = HashMap::new();
    // Gemini 1.5 Pro — 2M ctx, vision
    c.insert("gemini-1.5-pro".into(),          m(2_097_152, 8_192, true, false));
    c.insert("gemini-1.5-pro-latest".into(),  m(2_097_152, 8_192, true, false));
    c.insert("gemini-1.5-pro-002".into(),     m(2_097_152, 8_192, true, false));
    // Gemini 1.5 Flash — 1M ctx, vision
    c.insert("gemini-1.5-flash".into(),        m(1_048_576, 8_192, true, false));
    c.insert("gemini-1.5-flash-latest".into(), m(1_048_576, 8_192, true, false));
    c.insert("gemini-1.5-flash-8b".into(),     m(1_048_576, 8_192, true, false));
    // Gemini 2.0 Flash
    c.insert("gemini-2.0-flash-exp".into(),    m(1_048_576, 8_192, true, false));
    // Gemini 2.0 Flash Thinking (reasoning model)
    c.insert("gemini-2.0-flash-thinking-exp".into(), m(1_048_576, 65_536, true, true));
    c
}

/// Groq 跑的 Llama 3.x / Mixtral.
fn groq_catalog() -> HashMap<String, ModelMetadata> {
    let mut c = HashMap::new();
    // Llama 3.1 — 128K ctx
    c.insert("llama-3.1-70b-versatile".into(), m(131_072, 8_192, false, false));
    c.insert("llama-3.1-8b-instant".into(),   m(131_072, 8_192, false, false));
    // Llama 3.2 — 128K ctx
    c.insert("llama-3.2-1b-preview".into(),    m(131_072, 8_192, false, false));
    c.insert("llama-3.2-3b-preview".into(),    m(131_072, 8_192, false, false));
    // Llama 3.2 Vision
    c.insert("llama-3.2-11b-vision-preview".into(),  m(131_072, 8_192, true, false));
    c.insert("llama-3.2-90b-vision-preview".into(),  m(131_072, 8_192, true, false));
    // Mixtral
    c.insert("mixtral-8x7b-32768".into(),      m(32_768,  4_096, false, false));
    c
}

/// MiniMax. 256K / 64K / 8K.
///   M2.7 = M2 衍生 (user 2026-08-22 确认: 跟 M2 同样 256K context, 等同处理)
fn minimax_catalog() -> HashMap<String, ModelMetadata> {
    let mut c = HashMap::new();
    c.insert("MiniMax-M2".into(),  m(262_144, 16_384, false, false));
    c.insert("MiniMax-M2.7".into(), m(262_144, 16_384, false, false));
    c.insert("MiniMax-M1".into(),  m(65_536,  16_384, false, false));
    c.insert("abab6.5s-chat".into(), m(8_192, 8_192, false, false));
    c
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn all_catalogs_nonempty() {
        for t in ["anthropic", "openai", "deepseek", "moonshotai", "google", "groq", "minimax"] {
            let c = get_catalog_for(t);
            assert!(!c.is_empty(), "{t} catalog is empty");
        }
    }
    #[test]
    fn all_metadata_have_context_window() {
        for t in ["anthropic", "openai", "deepseek", "moonshotai", "google", "groq", "minimax"] {
            for (id, m) in get_catalog_for(t) {
                assert!(m.context_window.is_some(), "{t}/{id} missing context_window");
                assert!(m.max_output.is_some(), "{t}/{id} missing max_output");
            }
        }
    }
    #[test]
    fn context_window_at_least_max_output() {
        for t in ["anthropic", "openai", "deepseek", "moonshotai", "google", "groq", "minimax"] {
            for (id, m) in get_catalog_for(t) {
                let ctx = m.context_window.unwrap();
                let out = m.max_output.unwrap();
                assert!(ctx >= out, "{t}/{id} ctx {ctx} < max_output {out}");
            }
        }
    }
    #[test]
    fn openai_compatible_returns_empty() {
        assert!(get_catalog_for("openai-compatible").is_empty());
        assert!(get_catalog_for("unknown").is_empty());
    }
}
