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
    #[serde(default)]
    pub api_key_env: Option<String>,
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
