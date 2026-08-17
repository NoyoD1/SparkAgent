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
use std::path::PathBuf;

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
    /// v0.4.2 step 1+: per-workspace stable sessionId (从 AppConfig.per_workspace_session_id[workspace] 读),
    /// 让 sidecar 用同一 session 加载历史. None 时 sidecar 内部生成新 sessionId (跟 v0.4.1 兼容).
    #[serde(default)]
    pub session_id: Option<String>,
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

// ====== v0.4.4 Skills (Pi SDK 暴露) ======

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WriteSkillFileArgs {
    /// "workspace" 写到 <workspacePath>/.pi/skills/<name>.md
    /// "global"   写到 <agentDir>/skills/<name>.md (跟 Pi SDK 0.84.2 loadSkills 默认路径一致)
    scope: String,
    /// Skill name (a-zA-Z0-9._-), 跟 Pi SDK 0.84.2 frontmatter.name 一致
    name: String,
    /// SKILL.md 完整内容 (含 frontmatter), UTF-8 markdown
    body: String,
    /// workspace scope 必填, global scope 不需要
    workspace_path: Option<String>,
    /// global scope 必填, workspace scope 不需要
    agent_dir: Option<String>,
}

#[tauri::command]
async fn write_skill_file(args: WriteSkillFileArgs) -> Result<String, String> {
    // 1. name 校验: 1-64 char, [a-zA-Z0-9._-], 不含路径分隔符 / .. 防 path traversal
    if args.name.is_empty() || args.name.len() > 64 {
        return Err(format!("skill name 长度必须 1-64, got {}", args.name.len()));
    }
    if !args.name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')) {
        return Err(format!(
            "skill name 只能含 [a-zA-Z0-9._-], got '{}'",
            args.name
        ));
    }
    if args.name == "." || args.name == ".." {
        return Err("skill name 不能是 '.' 或 '..'".to_string());
    }
    if args.body.is_empty() {
        return Err("skill body 不能为空 (至少要 frontmatter + 内容)".to_string());
    }

    // 2. scope → 路径
    let target_path: PathBuf = match args.scope.as_str() {
        "workspace" => {
            let ws = args.workspace_path.as_ref().ok_or("workspace scope 需要 workspacePath")?;
            if ws.is_empty() {
                return Err("workspace path 不能为空".to_string());
            }
            PathBuf::from(ws).join(".pi").join("skills").join(format!("{}.md", args.name))
        }
        "global" => {
            // global scope: agentDir 走 Pi SDK 0.84.2 getAgentDir() 默认路径
            //   Windows: %USERPROFILE%/.pi/agent
            //   macOS/Linux: $HOME/.pi/agent
            // FE 可以不传 (None), Rust 端 fallback 算. 跟 sidecar 启动时 getAgentDir() 一致.
            let dir = match args.agent_dir.as_ref().filter(|s| !s.is_empty()) {
                Some(d) => PathBuf::from(d),
                None => {
                    // Fallback: USERPROFILE/HOME + .pi/agent (跟 Pi SDK 0.84.2 getAgentDir 一致)
                    let home = std::env::var("USERPROFILE")
                        .ok()
                        .or_else(|| std::env::var("HOME").ok())
                        .or_else(|| std::env::var("HOMEDRIVE").ok().zip(std::env::var("HOMEPATH").ok()).map(|(d, p)| format!("{}\\{}", d, p)))
                        .ok_or("global scope 没传 agentDir, 也找不到 USERPROFILE/HOME env")?;
                    PathBuf::from(home).join(".pi").join("agent")
                }
            };
            dir.join("skills").join(format!("{}.md", args.name))
        }
        other => return Err(format!("scope 必须是 'workspace' 或 'global', got '{}'", other)),
    };

    // 3. 安全: target 必须在 base 之内 (防 path traversal 即使已经过滤 name)
    let base_path = target_path.parent().map(|p| p.to_path_buf()).ok_or("invalid target path")?;
    if !base_path.exists() {
        std::fs::create_dir_all(&base_path).map_err(|e| format!("创建目录失败 {:?}: {}", base_path, e))?;
    }

    // 4. 写文件
    std::fs::write(&target_path, args.body.as_bytes()).map_err(|e| format!("写文件失败 {:?}: {}", target_path, e))?;

    // 5. 返回绝对路径
    let abs = std::fs::canonicalize(&target_path).unwrap_or(target_path);
    Ok(abs.to_string_lossy().to_string())
}

// ====== v0.4.4.3 Skill 导入: 从本地 .md 文件读 + 解析 frontmatter ======

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ParsedSkillFile {
    /// 文件绝对路径
    path: String,
    /// 文件 raw content (UTF-8)
    raw: String,
    /// frontmatter 解析后的 name (从 'name: xxx' 提取), 没 frontmatter 时 = 文件 basename (无 .md)
    name: String,
    /// frontmatter 解析后的 description, 没 frontmatter 时 = None
    description: Option<String>,
    /// frontmatter 解析后的 disable-model-invocation, 没 frontmatter 时 = false
    disable_model_invocation: bool,
    /// frontmatter 之后的所有 markdown 内容 (strip 掉 frontmatter block), 没 frontmatter 时 = raw
    body: String,
    /// 是否有 frontmatter block (--- ... ---)
    has_frontmatter: bool,
}

/// 解析 SKILL.md frontmatter (简单 line-based, 不引 YAML 库)
/// 格式:
///   ---
///   name: my-skill
///   description: Some description
///   disable-model-invocation: false
///   ---
///   # body markdown
fn parse_skill_frontmatter(raw: &str) -> ParsedSkillFile {
    let trimmed = raw.trim_start_matches('\u{feff}'); // strip BOM
    let lines: Vec<&str> = trimmed.lines().collect();

    // 找 frontmatter block: 第一行必须是 '---', 然后找下一个 '---'
    let has_frontmatter = lines.first().map(|l| l.trim() == "---").unwrap_or(false);
    let (fm_end_idx, body_start_idx) = if has_frontmatter {
        let mut end = None;
        for (i, l) in lines.iter().enumerate().skip(1) {
            if l.trim() == "---" {
                end = Some(i);
                break;
            }
        }
        match end {
            Some(e) => (e, e + 1),
            None => (0, 0), // 没找到结束, 视为无 frontmatter
        }
    } else {
        (0, 0)
    };

    // 解析 frontmatter key: value
    let mut name: Option<String> = None;
    let mut description: Option<String> = None;
    let mut disable_model_invocation = false;
    if has_frontmatter && fm_end_idx > 1 {
        for line in &lines[1..fm_end_idx] {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') { continue; }
            if let Some((k, v)) = line.split_once(':') {
                let k = k.trim();
                let v = v.trim().trim_matches('"').trim_matches('\'');
                match k {
                    "name" => name = Some(v.to_string()),
                    "description" => description = Some(v.to_string()),
                    "disable-model-invocation" => {
                        disable_model_invocation = matches!(v.to_lowercase().as_str(), "true" | "yes" | "1");
                    }
                    _ => {} // 忽略未知字段
                }
            }
        }
    }

    // body: frontmatter 之后的所有内容
    let body = if has_frontmatter && body_start_idx < lines.len() {
        lines[body_start_idx..].join("\n")
    } else {
        raw.to_string()
    };

    ParsedSkillFile {
        path: String::new(), // caller 填
        raw: raw.to_string(),
        name: name.unwrap_or_default(),
        description,
        disable_model_invocation,
        body,
        has_frontmatter,
    }
}

#[tauri::command]
async fn read_skill_file(path: String) -> Result<ParsedSkillFile, String> {
    // 1. path 必须存在 + 是文件
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("文件不存在: {}", path));
    }
    if !p.is_file() {
        return Err(format!("不是文件: {}", path));
    }

    // 2. 扩展名检查 (软警告, 不阻止)
    if p.extension().map(|e| e.to_ascii_lowercase() != "md").unwrap_or(true) {
        // 不是 .md, 但仍读 — user 可能强制选
    }

    // 3. 读文件
    let raw = std::fs::read_to_string(&p).map_err(|e| format!("读文件失败: {}", e))?;

    // 4. 解析 frontmatter
    let mut parsed = parse_skill_frontmatter(&raw);
    parsed.path = std::fs::canonicalize(&p).unwrap_or(p).to_string_lossy().to_string();

    // 5. 如果没 frontmatter, name 走 basename (去 .md)
    if parsed.name.is_empty() {
        parsed.name = parsed.path
            .rsplit(|c| c == '/' || c == '\\')
            .next()
            .unwrap_or("skill")
            .trim_end_matches(".md")
            .to_string();
    }

    Ok(parsed)
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
    // v0.4.2 step 1+: 从 AppConfig.per_workspace_session_id 读 sessionId (per-workspace stable)
    // 让 sidecar 用同一 session 加载历史, 实现短期记忆 + per-workspace 隔离
    let session_id_for_sidecar = match (&config.workspace_path, &config.session_id) {
        (Some(ws), Some(sid)) if !ws.is_empty() && !sid.is_empty() => Some(sid.clone()),
        _ => None,
    };

    // v0.5.0: 构造 Pi SDK RpcCommand.prompt 协议 (跟 Pi SDK main.ts 一致)
    // RpcCommand.prompt schema: { id?, type: "prompt", message, images?, streamingBehavior?: "steer" | "followUp" }
    // Pi SDK 0.84.2 runRpcMode 接收后 emit preflightResult 调 success(id, "prompt") → RpcResponse.
    let prompt_cmd = serde_json::json!({
        "id": format!("prompt-{session_id}"),
        "type": "prompt",
        "message": content,
        "streamingBehavior": "steer",
    });
    let prompt_cmd_json = serde_json::to_string(&prompt_cmd)
        .map_err(|e| format!("ser prompt cmd: {e}"))?;

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
            session_id: session_id_for_sidecar,  // v0.4.2 step 1+
        },
        session_id.clone(),
        prompt_cmd_json,
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
        .plugin(tauri_plugin_shell::init())  // v0.5.8: Tauri 2 sidecar 机制 (D172)
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
            // v0.4.4 Skills: 写自定义 SKILL.md 到 workspace 或 global agentDir
            write_skill_file,
            // v0.4.4.3 Skill 导入: 读本地 .md 文件 + 解析 frontmatter
            read_skill_file,
            // v0.5.0: 通用 RpcCommand 透传 (替代 v0.4.x 的 3 个特殊 stdin command)
            sidecar::send_rpc_command,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
