/**
 * config_store — v0.3.8+ provider 配置持久化
 *
 * 把原本在 WebView2 localStorage 的 provider config 移到 Rust 文件
 * `%APPDATA%\com.piagent.desktop\config.json`, 避免清 WebView2 缓存时
 * 把用户已配置的 provider / 拉取的 model list / active 状态全擦掉.
 *
 * apiKey 不在这里 (走 keyring / Windows Credential Manager, 独立 OS 存储).
 *
 * 序列化用 camelCase 跟前端 TypeScript 一致, 避免 frontend deserialize 还要写 snake_case.
 */
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    /// schema 版本, 未来 migration 用
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub providers: Vec<ProviderConfigDto>,
    #[serde(default)]
    pub active_provider_id: Option<String>,
    /// 'off' | 'low' | 'medium' | 'high'
    #[serde(default = "default_thinking_level")]
    pub thinking_level: String,
    /// v0.4.1+ tool permission 模式: 'ask' | 'smart' | 'allow'
    /// - ask: 每个 tool call 显式 confirm (最安全)
    /// - smart: 读自动放行, 写/命令/删 confirm
    /// - allow: 全部自动放行 (最危险)
    /// 旧 config.json 没这字段 → 默认 'ask' (跟 v0.4.1 推荐一致, 防首次用户误删)
    #[serde(default = "default_permission_mode")]
    pub permission_mode: String,
    /// v0.4.2 step 1+: 每 workspace 关联 sessionId (key=workspace 绝对路径, value=sessionId uuidv7).
    /// 切回 workspace 时让 sidecar 加载同一 session, 实现短期记忆 (per-workspace 隔离).
    /// 旧 config.json 没这字段 → 默认空 HashMap, 第一次切 workspace 时 sidecar 会生成新 sessionId.
    #[serde(default)]
    pub per_workspace_session_id: std::collections::HashMap<String, String>,
}

fn default_thinking_level() -> String {
    "medium".to_string()
}

fn default_permission_mode() -> String {
    "ask".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfigDto {
    pub id: String,
    /// 'openai' | 'anthropic' | 'deepseek' | 'moonshotai' | 'google' | 'groq' | 'minimax' | 'openai-compatible'
    pub r#type: String,
    pub label: String,
    #[serde(default)]
    pub base_url: Option<String>,
    // P2 #1 fix: 删 api_key_env dead code. 旧 v0.2 设计字段, 实际没人用, 保留会误导后续开发.
    //   注: 旧 config.json 里这个字段会被 serde silently drop (unknown field), 数据不会丢但也没意义.
    #[serde(default)]
    pub models: Vec<ModelInfoDto>,
    #[serde(default)]
    pub active_model_id: Option<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    pub created_at: String,
    pub updated_at: String,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfoDto {
    pub id: String,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub fetched_at: Option<String>,
    // v0.4.4.6: model metadata (跟 FE ModelInfo 对齐, Pi SDK 0.84.2 ModelDefinitionSchema 简化白名单)
    //   - type: 模型类型 (chat / image / video / audio / embedding), 决定路由
    //   - vision: 是否支持图片输入 (Pi SDK input: ['text', 'image'])
    //   - context_window: 最大上下文 token (Pi SDK contextWindow)
    //   - max_output: 单次回复 token 上限 (Pi SDK maxTokens)
    //   - max_rounds: LLM 连续 tool call 最多多少轮 (我们自己的, Pi SDK 没对应, 后续 Extension 层拦截)
    //   - reasoning: 是否思考模型 (Pi SDK reasoning)
    #[serde(default)]
    pub model_type: Option<String>,  // "chat" | "image" | "video" | "audio" | "embedding"
    #[serde(default)]
    pub vision: Option<bool>,
    #[serde(default)]
    pub context_window: Option<u32>,
    #[serde(default)]
    pub max_output: Option<u32>,
    #[serde(default)]
    pub max_rounds: Option<u32>,
    #[serde(default)]
    pub reasoning: Option<bool>,
}

/// 配置文件路径: <app_data_dir>/config.json
/// Windows:  C:\Users\<user>\AppData\Roaming\com.piagent.desktop\config.json
/// macOS:    ~/Library/Application Support/com.piagent.desktop/config.json
/// Linux:    ~/.config/com.piagent.desktop/config.json
pub fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("create_dir_all({}): {e}", dir.display()))?;
    Ok(dir.join("config.json"))
}

/// 加载配置. 文件不存在 / 解析失败 → 返回默认值, 不抛错 (让前端能从空状态起步).
pub fn load(app: &AppHandle) -> AppConfig {
    let path = match config_path(app) {
        Ok(p) => p,
        Err(_) => return AppConfig::default(),
    };
    if !path.exists() {
        return AppConfig::default();
    }
    let raw = match fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) => {
            crate::debug_log(&format!(
                "config_store::load read failed at {}: {e}",
                path.display()
            ));
            return AppConfig::default();
        }
    };
    match serde_json::from_str::<AppConfig>(&raw) {
        Ok(c) => c,
        Err(e) => {
            crate::debug_log(&format!(
                "config_store::load parse failed: {e}; falling back to default"
            ));
            AppConfig::default()
        }
    }
}

/// 保存配置. 用 pretty print (人读得懂, diff 友好).
pub fn save(app: &AppHandle, config: &AppConfig) -> Result<(), String> {
    let path = config_path(app)?;
    let json = serde_json::to_string_pretty(config)
        .map_err(|e| format!("serialize AppConfig: {e}"))?;
    // 原子写: 先写 .tmp 再 rename, 避免半写状态导致下次 parse 失败
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, &json).map_err(|e| format!("write tmp {}: {e}", tmp.display()))?;
    fs::rename(&tmp, &path).map_err(|e| format!("rename {} -> {}: {e}", tmp.display(), path.display()))?;
    crate::debug_log(&format!(
        "config_store::save ok: {} bytes to {}",
        json.len(),
        path.display()
    ));
    Ok(())
}
