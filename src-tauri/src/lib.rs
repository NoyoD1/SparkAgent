/**
 * Pi Agent Desktop — Tauri 2 main
 *
 * 架构:
 *   [Vue frontend] --invoke/listen--> [Tauri commands + events] --stdin/stdout--> [Node sidecar]
 *   keychain (keyring crate) 存 apiKey, 不进 localStorage / 不进 WS / 不进 .env
 */
mod config_store;
mod index_file;
mod keyring;
mod sidecar;

use serde::Deserialize;
use tauri::{AppHandle, Manager};

/// Debug log to <project>/.tauri-debug.log (DEBUG ONLY).
/// 用 file 而非 stderr 是因为 cargo tauri dev 的 stderr 被 bash task pipe 吃了看不见.
fn debug_log(msg: &str) {
    let log_path = std::path::PathBuf::from("D:/UnityWork/Tools/Pi/.tauri-debug.log");
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
    {
        use std::io::Write;
        let ts = chrono::Utc::now().format("%H:%M:%S%.3f");
        let _ = writeln!(f, "[{ts}] {msg}");
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientConfig {
    /// Frontend provider config id, 用作 keychain 索引 (例如 "prov-shangtang-1")
    pub provider_id: String,
    /// Provider type: 'openai-compatible' | 'anthropic' | 'openai' | ...
    pub provider: String,
    pub model: String,
    /// OpenAI-compatible 用, 内置 provider 忽略
    #[serde(default)]
    pub base_url: Option<String>,
    /// 'off' | 'low' | 'medium' | 'high'
    #[serde(default)]
    pub thinking_level: Option<String>,
    /// v0.3.8.11: 当前 workspace 目录绝对路径, 注入 system message
    #[serde(default)]
    pub workspace_path: Option<String>,
    /// v0.4.1+ tool permission 初始 mode: 'ask' (默认) | 'smart' | 'allow'
    #[serde(default)]
    pub permission_mode: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeychainInfoDto {
    pub provider_id: String,
    pub configured: bool,
    /// Masked preview, 例如 "sk-FLzj***oMY", configured=false 时为 null
    pub preview: Option<String>,
}

// ====== Keychain commands ======

#[tauri::command]
async fn save_api_key(
    app: AppHandle,
    provider_id: String,
    api_key: String,
) -> Result<(), String> {
    if provider_id.is_empty() {
        return Err("provider_id is empty".to_string());
    }
    if api_key.is_empty() {
        return Err("api_key is empty".to_string());
    }
    keyring::save(&provider_id, &api_key)?;
    index_file::add(&app, &provider_id)?;
    Ok(())
}

#[tauri::command]
async fn delete_api_key(
    app: AppHandle,
    provider_id: String,
) -> Result<(), String> {
    keyring::delete(&provider_id)?;
    index_file::remove(&app, &provider_id)?;
    Ok(())
}

#[tauri::command]
async fn list_api_keys(app: AppHandle) -> Result<Vec<KeychainInfoDto>, String> {
    let idx = index_file::load(&app);
    let mut out = Vec::with_capacity(idx.provider_ids.len());
    for id in idx.provider_ids {
        let (configured, preview) = match keyring::get(&id) {
            Ok(Some(k)) => (true, Some(crate::keyring::mask(&k))),
            Ok(None) => (false, None),
            Err(_) => (false, None),
        };
        out.push(KeychainInfoDto {
            provider_id: id,
            configured,
            preview,
        });
    }
    Ok(out)
}

#[tauri::command]
async fn has_api_key(provider_id: String) -> Result<bool, String> {
    Ok(keyring::get(&provider_id)?.is_some())
}

// ====== LLM command ======

#[tauri::command]
async fn send_prompt(
    app: AppHandle,
    session_id: String,
    content: String,
    config: ClientConfig,
) -> Result<(), String> {
    debug_log(&format!(
        "send_prompt: session={}, content_len={}, provider={}, model={}, providerId={}, baseUrl={:?}",
        session_id, content.len(), config.provider, config.model, config.provider_id, config.base_url
    ));
    if content.trim().is_empty() {
        return Err("content is empty".to_string());
    }
    // 从 keychain 取 key (永不出现在前端, 不进日志)
    let api_key = match keyring::get(&config.provider_id) {
        Ok(Some(k)) => k,
        Ok(None) => {
            debug_log(&format!("send_prompt: no apiKey in keychain for {}", config.provider_id));
            return Err(format!(
                "No API key for provider \"{}\" in OS keychain. Add it in Settings → Providers.",
                config.provider_id
            ));
        }
        Err(e) => {
            debug_log(&format!("send_prompt: keychain get err: {e}"));
            return Err(format!("Keychain read error: {e}"));
        }
    };

    // base_url: openai-compatible 必须, 内置 provider 暂不实现 (Phase 3 MVP 只支持 openai-compatible)
    let base_url = if config.provider == "openai-compatible" {
        config
            .base_url
            .clone()
            .ok_or_else(|| "openai-compatible needs baseUrl".to_string())?
    } else {
        String::new() // sidecar 内置 provider 暂未实现
    };

    debug_log(&format!(
        "send_prompt: dispatching to sidecar, base_url={base_url}, key_len={}",
        api_key.len()
    ));
    // v0.4.1+ active sidecar map 由 .manage() 注册, 这里 clone Arc 出来 owned (要在 move app 前)
    let active = app.state::<std::sync::Arc<sidecar::ActiveSidecars>>().inner().clone();
    sidecar::run_prompt(
        app,
        sidecar::SidecarConfig {
            provider: config.provider,
            model: config.model,
            base_url,
            api_key,
            thinking_level: config.thinking_level,
            workspace_path: config.workspace_path,  // v0.3.8.11
            permission_mode: config.permission_mode.unwrap_or_else(|| "ask".to_string()),  // v0.4.1+
        },
        sidecar::PromptMsg {
            session_id: session_id.clone(),
            content,
        },
        active,
    );
    Ok(())
}

// ====== Migration helper ======
// Phase 3 bootstrap: 从 server/.env 读 SHANGTANG_KEY (或任何 *_KEY), 写到 keychain.
// 一次性命令, 跑完可以删 server/.

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationEntry {
    pub env_var: String,
    pub provider_id: String,
    pub preview: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationResult {
    pub migrated: Vec<MigrationEntry>,
    pub skipped: Vec<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ModelInfoDto {
    pub id: String,
    pub label: Option<String>,
}

#[tauri::command]
async fn fetch_provider_models(
    provider_id: String,
    base_url: String,
) -> Result<Vec<ModelInfoDto>, String> {
    let api_key = keyring::get(&provider_id)?
        .ok_or_else(|| format!("No API key in keychain for \"{provider_id}\""))?;
    let clean_base = base_url.trim_end_matches('/');
    let url = format!("{clean_base}/models");

    // ureq 是同步 HTTP, 用 spawn_blocking 避免阻塞 Tauri runtime
    let url_clone = url.clone();
    let api_key_clone = api_key.clone();
    let models: Vec<ModelInfoDto> = tokio::task::spawn_blocking(move || -> Result<Vec<ModelInfoDto>, String> {
        let resp = ureq::get(&url_clone)
            .set("Authorization", &format!("Bearer {api_key_clone}"))
            .timeout(std::time::Duration::from_secs(15))
            .call()
            .map_err(|e| format!("fetch {url_clone}: {e}"))?;
        let body: serde_json::Value = resp
            .into_json()
            .map_err(|e| format!("parse {url_clone}: {e}"))?;
        let arr = body
            .get("data")
            .and_then(|d| d.as_array())
            .ok_or_else(|| "no .data array in response".to_string())?;
        Ok(arr
            .iter()
            .filter_map(|m| m.get("id").and_then(|i| i.as_str()).map(|s| s.to_string()))
            .map(|id| ModelInfoDto { id, label: None })
            .collect())
    })
    .await
    .map_err(|e| format!("join: {e}"))??;

    Ok(models)
}

#[tauri::command]
async fn migrate_from_env(app: AppHandle, env_path: Option<String>) -> Result<MigrationResult, String> {
    let path = env_path.unwrap_or_else(|| "../server/.env".to_string());
    let abs_path = std::path::Path::new(&path)
        .canonicalize()
        .unwrap_or_else(|_| std::path::PathBuf::from(&path));
    let result = match std::fs::read_to_string(&abs_path) {
        Ok(s) => s,
        Err(e) => {
            return Ok(MigrationResult {
                migrated: vec![],
                skipped: vec![],
                error: Some(format!("read {path}: {e}")),
            });
        }
    };
    let mut migrated = Vec::new();
    let mut skipped = Vec::new();
    for line in result.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        // 形如 KEY=value, value 可能带 # 注释
        let Some((key, value_raw)) = trimmed.split_once('=') else {
            continue;
        };
        let key = key.trim();
        let value = value_raw
            .split('#')
            .next()
            .unwrap_or("")
            .trim()
            .trim_matches(|c| c == '"' || c == '\'');
        if !key.ends_with("_KEY") || value.is_empty() {
            continue;
        }
        // 推导 provider_id: SHANGTANG_KEY → prov-shangtang-N
        // 简化: 全部映射成 prov-<lowercased-key-suffix>-1
        let suffix = key.trim_end_matches("_KEY").to_lowercase();
        let provider_id = format!("prov-{suffix}-1");
        match keyring::save(&provider_id, value) {
            Ok(()) => {
                index_file::add(&app, &provider_id)?;
                migrated.push(MigrationEntry {
                    env_var: key.to_string(),
                    provider_id: provider_id.clone(),
                    preview: crate::keyring::mask(value),
                });
            }
            Err(e) => {
                skipped.push(format!("{key}: {e}"));
            }
        }
    }
    Ok(MigrationResult {
        migrated,
        skipped,
        error: None,
    })
}

// ====== Workspace default ======
// v0.3.5+ 初始状态 (无 workspace) 发送消息时, 自动用 <home>/PiAgent 作默认工作区.
// 不弹 picker 强迫用户选, 但用户仍可通过 sidebar/tab strip 的"本地"下拉手动选别的.

#[tauri::command]
async fn ensure_default_workspace(app: AppHandle) -> Result<String, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|e| format!("home_dir: {e}"))?;
    // Windows: C:\Users\<user>\PiAgent; macOS: /Users/<user>/PiAgent; Linux: /home/<user>/PiAgent
    let default_path = home.join("PiAgent");
    std::fs::create_dir_all(&default_path)
        .map_err(|e| format!("create_dir_all({}): {e}", default_path.display()))?;
    Ok(default_path.to_string_lossy().to_string())
}

// ====== App config (provider list, active, thinking level) ======
// v0.3.8+ 持久化到 <app_data_dir>/config.json, 替代 WebView2 localStorage.
// 原因: 清 WebView2 缓存时 localStorage 也被擦, provider 配置就丢了.

#[tauri::command]
async fn load_app_config(app: AppHandle) -> Result<config_store::AppConfig, String> {
    Ok(config_store::load(&app))
}

#[tauri::command]
async fn save_app_config(
    app: AppHandle,
    config: config_store::AppConfig,
) -> Result<(), String> {
    config_store::save(&app, &config)
}

// ====== App entry ======

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // v0.4.1+ active sidecar stdin map, 跨 invoke handler 共享.
    // Arc 包一层让 spawn task + invoke handler 都能拿到 owned clone.
    let active_sidecars = std::sync::Arc::new(sidecar::ActiveSidecars::default());

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(active_sidecars.clone())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            // 确保 app data dir 存在 (index_file + config_store 用)
            let _ = app
                .path()
                .app_data_dir()
                .map(|p| std::fs::create_dir_all(p));
            log::info!("Pi Agent Desktop started");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            save_api_key,
            delete_api_key,
            list_api_keys,
            has_api_key,
            send_prompt,
            fetch_provider_models,
            migrate_from_env,
            ensure_default_workspace,
            load_app_config,
            save_app_config,
            // v0.4.1+ tool permission
            sidecar::send_permission_response,
            sidecar::set_permission_mode,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
