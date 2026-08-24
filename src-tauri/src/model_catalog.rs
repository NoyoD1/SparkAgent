//! v0.5.0-D 第30轮 (D213) — Model metadata 静态 catalog.
//!
//! 2026-08-24 v3.28: 删了 7 个内置 provider catalog (anthropic/openai/deepseek/moonshotai/
//!   google/groq/minimax). user 反馈 '删除内置provider统一后面我都自己配置'. 现在所有
//!   provider 走 user 自配 (openai-compatible /v1/models 拉 + 手填 model id), catalog
//!   不再 hardcode 任何 model metadata. 老的 builtin provider 在 user config 里 type
//!   literal 仍保留 (ProviderType union 8 个, 兼容已配的).
//!
//!   副作用: applyCatalog (FE 走 getModelCatalog) 返空 HashMap, 任何 model metadata
//!   都不会自动填. user 自配的 model 自己手填 6 个 metadata 字段 (或者用
//!   openai-compatible 走 fetch_provider_models 走 best-effort parse).
//!
//! 之前 v0.5.0-D 时候的设计 (D213 反馈): 配完之后自动填 metadata 减手填负担. 现在
//!   user 明确不要内置, 退回手填 (control > 便利). 后续 P1 真要加 catalog 时再扩.
//!
//! openai-compatible: 之前 v0.4.4.x 加的 fetch_provider_models 仍存在 (Rust lib.rs),
//!   走 /v1/models 真打端点 + 启发式 parse. 不需要 catalog.

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
///
/// 2026-08-24 v3.28: 删了 7 个内置 catalog, 现在任何 provider type 都返空.
/// 保留这个函数 + Tauri command 是为了:
///   1. FE applyCatalog action 仍可调 (返 0, 不报错)
///   2. 未来 user 想加 catalog 时 (e.g. 配自家内部 LLM), 仍可走这个入口
pub fn get_catalog_for(_provider_type: &str) -> HashMap<String, ModelMetadata> {
    HashMap::new()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn all_catalogs_return_empty() {
        // v3.28: 全 0 builtin. 验证不返 stale data.
        for t in [
            "anthropic",
            "openai",
            "deepseek",
            "moonshotai",
            "google",
            "groq",
            "minimax",
            "openai-compatible",
            "unknown",
        ] {
            assert!(
                get_catalog_for(t).is_empty(),
                "{t} catalog should be empty after v3.28"
            );
        }
    }
}
