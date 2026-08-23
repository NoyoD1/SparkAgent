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
mod model_catalog;  // v0.5.0-D D213: 静态 model metadata catalog
mod sidecar;

use serde::{Deserialize, Serialize};
use crate::sidecar::kill_sidecar;  // v0.4.6: register tauri command (force kill sidecar on abort)
use tauri::{AppHandle, Emitter, Manager, State};
use std::path::{Path, PathBuf};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::SystemTime;
// v0.4.4.6: ClientConfig 用 sidecar::SkillsConfig / sidecar::ModelMetadataConfig
use sidecar::{SkillsConfig, ModelMetadataConfig};

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

// ====== D214 v7: ref body 内存 cache (skill / user tool / mcp server) ======
// 背景: Composer.send() 每次发消息都强制 read 3 类 ref body, 拼到 LLM prompt 头部.
//   同一个 skill 连续发 10 条消息 = 10 次磁盘 IO. skill 文件通常几 KB, 不算大,
//   但 IO 系统调用 + parse_frontmatter 有 overhead. 加个简单 in-memory cache,
//   mtime 没变就复用, 变了就重读 (invalid 隐式靠 mtime, 不需要主动清).
//
// 故意做简单版: HashMap + Mutex, 不上 LRU. 用户的 ref 总数一般 < 100,
//   即使全部 cache 也只占几 MB. 真正要严格控内存再说.
//
// key 设计: skill 用 `skill:{path}` (path 唯一), user tool / mcp server
//   用 `{kind}:{scope}:{name}` (name 在 scope 内唯一, 加 scope 防 workspace / global 撞)
struct RefBodyCacheEntry {
    body: String,
    mtime: SystemTime,
}
use std::sync::LazyLock;
static REF_BODY_CACHE: LazyLock<Mutex<HashMap<String, RefBodyCacheEntry>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// 通用 cache 读: mtime 一致返 cache, 不一致走 read_fn 重读 + 更新 cache.
/// read_fn 是 closure 传进来, 因为 3 类 (skill/tool/mcp) 各自有不同 read 逻辑
/// (skill 要 parse_frontmatter, tool/mcp 直接 read_to_string).
async fn read_with_cache<F, Fut>(
    cache_key: String,
    path: &Path,
    read_fn: F,
) -> Result<String, String>
where
    F: FnOnce(PathBuf) -> Fut,
    Fut: std::future::Future<Output = Result<String, String>>,
{
    // 1. 拿当前文件 mtime (失败 = 文件没了, 走 read_fn 让它自己报错)
    let current_mtime = std::fs::metadata(path).and_then(|m| m.modified()).ok();
    // 2. 查 cache: mtime 完全一致才算命中
    if let Some(mtime) = current_mtime {
        let cache = REF_BODY_CACHE.lock().expect("REF_BODY_CACHE poisoned");
        if let Some(entry) = cache.get(&cache_key) {
            if entry.mtime == mtime {
                return Ok(entry.body.clone());
            }
        }
    }
    // 3. miss 或 mtime 变了 → 走 read_fn (skill 走 parse_frontmatter, tool/mcp 走 read_to_string)
    let body = read_fn(path.to_path_buf()).await?;
    // 4. 更新 cache (mtime 拿到了才写, 拿不到说明文件没了, 不写)
    if let Some(mtime) = current_mtime {
        let mut cache = REF_BODY_CACHE.lock().expect("REF_BODY_CACHE poisoned");
        cache.insert(cache_key, RefBodyCacheEntry { body: body.clone(), mtime });
    }
    Ok(body)
}

/// write / delete 主动 invalidate (mtime 检查能 cover 99% 场景, 但 delete
/// 后再 read 之前 metadata 会失败, cache 不会更新, 老 entry 留着无害但占内存.
/// 主动清一下更干净.)
fn invalidate_ref_body_cache(cache_key: &str) {
    let mut cache = REF_BODY_CACHE.lock().expect("REF_BODY_CACHE poisoned");
    cache.remove(cache_key);
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
    /// v0.4.4 Skills (Pi SDK 暴露): FE 维护 enabled skill names, sidecar 走 formatSkillsForPrompt
    ///   注入 system prompt. enabled 改变必须重启 sidecar (D165 systemPrompt 不可动态改).
    #[serde(default)]
    pub skills: Option<SkillsConfig>,
    /// v0.4.4.6 model metadata: type / vision / contextWindow / maxOutput / maxRounds / reasoning.
    ///   FE 从 configStore.activeModel 读, sidecar 拼到 user-custom model object.
    #[serde(default)]
    pub model_metadata: Option<ModelMetadataConfig>,
    // v0.5.0-v0.1: 删 active_agent 字段 (multi-agent persona 回滚, 详见 ADR-0024 superseded by ADR-0025)
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
    /// P0-1 fix: 精确文件路径. 传了则直接覆盖该文件 (不走 scope→路径推算, 避免 global scope
    ///   agentDir fallback 路径不一致导致写到新位置产生重复). edit mode 必传.
    file_path: Option<String>,
}

// D212: skill name 公共校验 — 允许 Unicode 字母/数字 (含中文/日文/韩文等),
//   + 允许 . _ -, 禁止路径分隔符 / Windows 保留字符 / 控制字符 / 单独的 "." 或 ".."
//   跟 FE AddSkillForm.vue nameValid 保持一致 (双端不能各自一套).
//   复用点: write_skill_file / import_skill_url / import_skill_zip.
fn validate_skill_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.chars().count() > 64 {
        return Err(format!(
            "skill name 长度必须 1-64, got {}",
            name.chars().count()
        ));
    }
    if name == "." || name == ".." {
        return Err("skill name 不能是 '.' 或 '..'".to_string());
    }
    if name.chars().any(|c| {
        c.is_control()
            || matches!(
                c,
                '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'
            )
    }) {
        return Err(format!(
            "skill name 包含非法字符 (路径分隔符 / Windows 保留字符 / 控制字符), got '{}'",
            name
        ));
    }
    Ok(())
}

#[tauri::command]
async fn write_skill_file(args: WriteSkillFileArgs) -> Result<String, String> {
    // 1. name 校验 — 走公共 validate_skill_name, 跟 FE AddSkillForm.vue 保持一致
    validate_skill_name(&args.name)?;
    if args.body.is_empty() {
        return Err("skill body 不能为空 (至少要 frontmatter + 内容)".to_string());
    }

    // 2. file_path 优先 (P0-1 fix): edit mode 传精确路径, 直接覆盖不走推算
    let target_path: PathBuf = if let Some(ref fp) = args.file_path {
        let p = PathBuf::from(fp);
        // 安全校验: 必须是绝对路径且是 .md 文件
        if !p.is_absolute() {
            return Err("file_path 必须是绝对路径".to_string());
        }
        if p.extension().map(|e| e != "md").unwrap_or(true) {
            return Err("file_path 必须以 .md 结尾".to_string());
        }
        p
    } else {
        // 回退: scope → 路径推算 (原始 create 模式)
        match args.scope.as_str() {
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
        }
    };

    // 3. 安全: target 必须在 base 之内 (防 path traversal 即使已经过滤 name)
    let base_path = target_path.parent().map(|p| p.to_path_buf()).ok_or("invalid target path")?;
    if !base_path.exists() {
        std::fs::create_dir_all(&base_path).map_err(|e| format!("创建目录失败 {:?}: {}", base_path, e))?;
    }

    // 4. 写文件
    std::fs::write(&target_path, args.body.as_bytes()).map_err(|e| format!("写文件失败 {:?}: {}", target_path, e))?;

    // 4.5 D214 v7: invalidate ref body cache (写完 mtime 变了, 下次 read 会重读,
    //     这里主动清更干净, 避免持有老 body 引用)
    let canonical = std::fs::canonicalize(&target_path).unwrap_or(target_path.clone());
    invalidate_ref_body_cache(&format!("skill:{}", canonical.to_string_lossy()));

    // 5. 返回绝对路径
    let abs = std::fs::canonicalize(&target_path).unwrap_or(target_path);
    Ok(abs.to_string_lossy().to_string())
}

// ====== P0-1: 删除 skill 文件 (按精确路径) ======
#[tauri::command]
async fn delete_skill_file(file_path: String) -> Result<(), String> {
    let path = PathBuf::from(&file_path);
    // 安全校验: 必须是绝对路径且是 .md 文件
    // D214 v7: 先 invalidate cache (删了之后这条 entry 没意义, 主动清)
    if path.is_absolute() && path.extension().map(|e| e == "md").unwrap_or(false) {
        if let Ok(canonical) = std::fs::canonicalize(&path) {
            invalidate_ref_body_cache(&format!("skill:{}", canonical.to_string_lossy()));
        }
    }
    if !path.is_absolute() {
        return Err("file_path 必须是绝对路径".to_string());
    }
    if path.extension().map(|e| e != "md").unwrap_or(true) {
        return Err("file_path 必须以 .md 结尾".to_string());
    }
    if !path.exists() {
        return Err(format!("文件不存在: {:?}", path));
    }
    std::fs::remove_file(&path).map_err(|e| format!("删除文件失败 {:?}: {}", path, e))
}

// ====== 2026-08-21: Skill 热重载 ======
// 走 Pi SDK 内置 reload 命令 (rebuild runtime, 保持 session history 不丢).
// reload 会重建 runtime 并重新 loadSkills, 下一轮 prompt 自然用新 skills.
// 同时 emit skills_reloaded event → FE 刷新 skills store.
#[tauri::command]
async fn reload_skills(
    app: AppHandle,
    session_id: String,
    active: State<'_, std::sync::Arc<sidecar::ActiveSidecars>>,
) -> Result<(), String> {
    debug_log(&format!("reload_skills: session={}", session_id));
    let mut map = active.0.lock().await;
    let child = map
        .get_mut(&session_id)
        .ok_or_else(|| format!("no active sidecar for session={}", session_id))?;
    // Pi SDK 内置 reload 命令: rebuild runtime + reload skills + extensions + prompts + themes
    let line = format!("{{\"type\":\"reload\"}}\n");
    child
        .write(line.as_bytes())
        .map_err(|e| format!("write reload: {e}"))?;
    // emit skills_reloaded event → FE 刷新 skills store (skills_snapshot 会重新 emit)
    let event = serde_json::json!({
        "type": "skills_reloaded",
        "sessionId": session_id,
    });
    if let Err(e) = app.emit("chat:event", &event) {
        log::error!("emit skills_reloaded failed: {e}");
    }
    Ok(())
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

    // 3. 走 ref body cache 拿 raw (mtime 一致返 cache, 不一致重读)
    //    cache key 用 canonical path, 同一文件不管绝对/相对路径都命中同一 entry
    let canonical_path = std::fs::canonicalize(&p).unwrap_or(p.clone());
    let cache_key = format!("skill:{}", canonical_path.to_string_lossy());
    let raw = read_with_cache(cache_key, &p, |q| async move {
        std::fs::read_to_string(&q).map_err(|e| format!("读文件失败: {}", e))
    }).await?;

    // 4. 解析 frontmatter (每次都 parse — 很便宜, 比 cache parsed 更安全, 避免 frontmatter bug cache)
    let mut parsed = parse_skill_frontmatter(&raw);
    parsed.path = canonical_path.to_string_lossy().to_string();

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

// ====== v0.4.4.5 Skill 导入: 从 URL 导入 (raw .md content) ======

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportSkillUrlArgs {
    /// raw URL (https://...) — 假设 server 返回 text/markdown 或 text/plain
    /// 限制: 必须是单文件 .md raw content, 不支持 zip 指向 (zip 走 v0.4.4.4)
    url: String,
    /// scope: "workspace" | "global", 跟 write_skill_file 一样
    scope: String,
    /// workspace scope 必填
    workspace_path: Option<String>,
    /// global scope 不传, Rust fallback 算
    agent_dir: Option<String>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportedSkillUrl {
    /// skill name (从 URL 文件名去 .md 或 frontmatter.name)
    name: String,
    /// 写入的最终路径
    target_path: String,
    /// 描述 (从 SKILL.md frontmatter.description)
    description: Option<String>,
    /// raw content 大小 (bytes)
    bytes: usize,
}

#[tauri::command]
async fn import_skill_url(args: ImportSkillUrlArgs) -> Result<ImportedSkillUrl, String> {
    // 1. URL 校验
    if !args.url.starts_with("https://") && !args.url.starts_with("http://") {
        return Err("URL 必须以 http:// 或 https:// 开头".to_string());
    }

    // 2. 同步 fetch (ureq, 不引 async runtime / 不引 SSL cert chain 依赖)
    //    timeout 30s 避免 user 误贴无效 URL 卡住 UI
    let response = ureq::get(&args.url)
        .timeout(std::time::Duration::from_secs(30))
        .call()
        .map_err(|e| format!("fetch URL 失败: {}", e))?;
    let status = response.status();
    if !(200..300).contains(&status) {
        return Err(format!("HTTP {} — {}", status, args.url));
    }
    let raw = response
        .into_string()
        .map_err(|e| format!("解码 response 失败: {}", e))?;

    // 3. 解析 frontmatter
    let parsed = parse_skill_frontmatter(&raw);

    // 4. name: 优先 frontmatter.name, fallback URL 文件名去 .md
    let name = if !parsed.name.is_empty() {
        parsed.name
    } else {
        // URL 末段去 .md, 手切 (不引 url crate)
        let last = args.url.rsplit(|c| c == '/' || c == '?').next().unwrap_or("skill");
        last.trim_end_matches(".md").trim_end_matches(".markdown").to_string()
    };

    // 5. name 校验 — 走公共 validate_skill_name (D212 改用 Unicode 友好版本)
    validate_skill_name(&name)?;

    // 6. 拼 frontmatter + body (跟 AddSkillForm 行为一致)
    let body = if parsed.has_frontmatter {
        raw.clone()
    } else {
        // 没 frontmatter, 拼一个
        format!("---\nname: {}\ndescription: {}\n---\n\n{}", name, parsed.description.as_deref().unwrap_or("(imported from URL)"), raw)
    };

    // 7. 决定 target 路径 (跟 write_skill_file 一样, 但单文件)
    let target_path = match args.scope.as_str() {
        "workspace" => {
            let ws = args.workspace_path.as_ref().ok_or("workspace scope 需要 workspacePath")?;
            if ws.is_empty() {
                return Err("workspace path 不能为空".to_string());
            }
            PathBuf::from(ws).join(".pi").join("skills").join(format!("{}.md", name))
        }
        "global" => {
            let dir = match args.agent_dir.as_ref().filter(|s| !s.is_empty()) {
                Some(d) => PathBuf::from(d),
                None => {
                    let home = std::env::var("USERPROFILE")
                        .ok()
                        .or_else(|| std::env::var("HOME").ok())
                        .or_else(|| std::env::var("HOMEDRIVE").ok().zip(std::env::var("HOMEPATH").ok()).map(|(d, p)| format!("{}\\{}", d, p)))
                        .ok_or("global scope 没传 agentDir, 也找不到 USERPROFILE/HOME env")?;
                    PathBuf::from(home).join(".pi").join("agent")
                }
            };
            dir.join("skills").join(format!("{}.md", name))
        }
        other => return Err(format!("scope 必须是 'workspace' 或 'global', got '{}'", other)),
    };

    // 8. target 已存在 → 拒绝
    if target_path.exists() {
        return Err(format!("target 已存在: {:?} — 请先删除或选不同 name", target_path));
    }

    // 9. 创建 parent dir + 写文件
    let parent = target_path.parent().ok_or("invalid target path")?;
    if !parent.exists() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建 parent 失败: {}", e))?;
    }
    std::fs::write(&target_path, body.as_bytes()).map_err(|e| format!("写文件失败: {}", e))?;

    let abs = std::fs::canonicalize(&target_path).unwrap_or(target_path);
    Ok(ImportedSkillUrl {
        name,
        target_path: abs.to_string_lossy().to_string(),
        description: parsed.description,
        bytes: body.len(),
    })
}

// ====== v0.4.4.4 Skill 导入: 从 zip 压缩包导入 (多文件 skill pack 支持) ======

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportSkillZipArgs {
    /// zip 文件绝对路径 (user 通过 dialog 选)
    zip_path: String,
    /// scope: "workspace" | "global", 跟 write_skill_file 一样
    scope: String,
    /// workspace scope 必填
    workspace_path: Option<String>,
    /// global scope 不传, Rust fallback 算
    agent_dir: Option<String>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportedSkillZip {
    /// skill name (从 SKILL.md frontmatter.name 或 zip 根子目录名)
    name: String,
    /// 写入的最终目录 (workspace scope: <ws>/.pi/skills/<name>/, global scope: <agentDir>/skills/<name>/)
    target_dir: String,
    /// SKILL.md 绝对路径
    skill_md_path: String,
    /// 描述 (从 SKILL.md frontmatter.description)
    description: Option<String>,
    /// 是否多文件 (子目录模式), true = 整目录 copy, false = 单文件 SKILL.md
    multi_file: bool,
    /// 解压文件数
    file_count: usize,
}

#[tauri::command]
async fn import_skill_zip(args: ImportSkillZipArgs) -> Result<ImportedSkillZip, String> {
    use std::io::Read;

    // 1. zip_path 校验
    let zip_path = PathBuf::from(&args.zip_path);
    if !zip_path.exists() || !zip_path.is_file() {
        return Err(format!("zip 文件不存在: {}", args.zip_path));
    }
    if zip_path.extension().map(|e| e.to_ascii_lowercase() != "zip").unwrap_or(true) {
        return Err(format!("不是 .zip 文件: {}", args.zip_path));
    }

    // 2. 打开 zip
    let zip_file = std::fs::File::open(&zip_path).map_err(|e| format!("打开 zip 失败: {}", e))?;
    let mut archive = zip::ZipArchive::new(zip_file).map_err(|e| format!("解析 zip 失败: {}", e))?;

    // 3. 找 SKILL.md (两种 layout):
    //   - 根级 SKILL.md (zip 根有 SKILL.md)
    //   - 子目录 <name>/SKILL.md (zip 根是 <name>/, <name>/SKILL.md)
    // 优先: 子目录模式 (大多数 skill pack 工具的 layout, e.g. GitHub release)
    let mut skill_md_path_in_zip: Option<String> = None;
    let mut root_subdir: Option<String> = None;
    for i in 0..archive.len() {
        let entry = archive.by_index(i).map_err(|e| format!("读 entry 失败: {}", e))?;
        let name = entry.name().to_string();
        // 跳过目录 entry (zip crate 区分 dir/file)
        if name.ends_with('/') { continue; }
        // 只关心 SKILL.md, 第一次找到就决定模式
        if !name.ends_with("SKILL.md") { continue; }
        if skill_md_path_in_zip.is_some() { continue; } // 忽略后续 SKILL.md, 取第一个
        if name.contains('/') {
            // 子目录模式: <subdir>/SKILL.md
            let subdir = name.split('/').next().unwrap_or("").to_string();
            if !subdir.is_empty() && subdir != "." && subdir != ".." {
                skill_md_path_in_zip = Some(name.clone());
                root_subdir = Some(subdir);
            }
        } else {
            // 根级模式: SKILL.md
            skill_md_path_in_zip = Some(name.clone());
            root_subdir = None;
        }
    }

    let skill_md_in_zip = skill_md_path_in_zip.ok_or_else(|| {
        "zip 里没找到 SKILL.md. skill pack 必须在根或子目录里包含 SKILL.md (frontmatter + body)".to_string()
    })?;

    // 4. 读 SKILL.md 内容 (zip 里)
    let mut skill_md_buf = String::new();
    {
        let mut entry = archive.by_name(&skill_md_in_zip).map_err(|e| format!("读 SKILL.md 失败: {}", e))?;
        entry.read_to_string(&mut skill_md_buf).map_err(|e| format!("解码 SKILL.md 失败: {}", e))?;
    }

    // 5. 解析 frontmatter
    let parsed = parse_skill_frontmatter(&skill_md_buf);
    let name = if !parsed.name.is_empty() {
        parsed.name
    } else if let Some(sub) = &root_subdir {
        // frontmatter 没 name → 用 zip 根子目录名
        sub.clone()
    } else {
        // 根级 SKILL.md + 没 frontmatter name → 用 zip 文件名去 .zip
        zip_path.file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "skill".to_string())
    };

    // 6. name 校验 — 走公共 validate_skill_name (D212 改用 Unicode 友好版本)
    validate_skill_name(&name)?;

    // 7. 决定 target 目录
    let target_base = match args.scope.as_str() {
        "workspace" => {
            let ws = args.workspace_path.as_ref().ok_or("workspace scope 需要 workspacePath")?;
            if ws.is_empty() {
                return Err("workspace path 不能为空".to_string());
            }
            PathBuf::from(ws).join(".pi").join("skills")
        }
        "global" => {
            let dir = match args.agent_dir.as_ref().filter(|s| !s.is_empty()) {
                Some(d) => PathBuf::from(d),
                None => {
                    let home = std::env::var("USERPROFILE")
                        .ok()
                        .or_else(|| std::env::var("HOME").ok())
                        .or_else(|| std::env::var("HOMEDRIVE").ok().zip(std::env::var("HOMEPATH").ok()).map(|(d, p)| format!("{}\\{}", d, p)))
                        .ok_or("global scope 没传 agentDir, 也找不到 USERPROFILE/HOME env")?;
                    PathBuf::from(home).join(".pi").join("agent")
                }
            };
            dir.join("skills")
        }
        other => return Err(format!("scope 必须是 'workspace' 或 'global', got '{}'", other)),
    };
    let target_dir = target_base.join(&name);

    // 8. target 已存在 → 拒绝 (避免覆盖现有 skill, user 手动处理)
    if target_dir.exists() {
        return Err(format!("target 已存在: {:?} — 请先删除或选不同 name", target_dir));
    }

    // 9. 写到 target
    //   子目录模式 (root_subdir.is_some()): 解整个子目录到 target
    //   根级模式: 写 SKILL.md 到 target/<name>.md (跟 write_skill_file 一致)
    let multi_file = root_subdir.is_some();
    let mut file_count = 0usize;

    if let Some(subdir) = &root_subdir {
        // 子目录模式: 遍历 zip entries, 把 <subdir>/* 解到 target/
        std::fs::create_dir_all(&target_dir).map_err(|e| format!("创建 target dir 失败: {}", e))?;
        let prefix = format!("{}/", subdir);
        for i in 0..archive.len() {
            let mut entry = archive.by_index(i).map_err(|e| format!("读 entry 失败: {}", e))?;
            let name = entry.name().to_string();
            if !name.starts_with(&prefix) { continue; }
            // 相对路径 (去掉 prefix)
            let rel = &name[prefix.len()..];
            if rel.is_empty() { continue; } // 子目录本身
            let dest = target_dir.join(rel);
            if name.ends_with('/') {
                // directory entry
                std::fs::create_dir_all(&dest).map_err(|e| format!("创建子目录失败: {}", e))?;
            } else {
                if let Some(parent) = dest.parent() {
                    std::fs::create_dir_all(parent).map_err(|e| format!("创建 parent 失败: {}", e))?;
                }
                let mut out = std::fs::File::create(&dest).map_err(|e| format!("创建文件失败: {}", e))?;
                std::io::copy(&mut entry, &mut out).map_err(|e| format!("写文件失败: {}", e))?;
                file_count += 1;
            }
        }
    } else {
        // 根级模式: 写 SKILL.md 到 target/<name>.md
        std::fs::create_dir_all(&target_dir).map_err(|e| format!("创建 target dir 失败: {}", e))?;
        let dest = target_dir.join(format!("{}.md", name));
        std::fs::write(&dest, skill_md_buf.as_bytes()).map_err(|e| format!("写 SKILL.md 失败: {}", e))?;
        file_count = 1;
    }

    let target_dir_abs = std::fs::canonicalize(&target_dir).unwrap_or(target_dir.clone()).to_string_lossy().to_string();
    let skill_md_abs = {
        let p = if multi_file {
            target_dir.join("SKILL.md")
        } else {
            target_dir.join(format!("{}.md", name))
        };
        std::fs::canonicalize(&p).unwrap_or(p).to_string_lossy().to_string()
    };
    Ok(ImportedSkillZip {
        name,
        target_dir: target_dir_abs,
        skill_md_path: skill_md_abs,
        description: parsed.description,
        multi_file,
        file_count,
    })
}

// ====== v0.4.4.6: list_skills (FE 主动拉, 写完 skill 后立刻刷新 UI 列表) ======
// 之前 v0.4.4.x: sidecar 启动时 emit skills_snapshot 一次, 写完/导入后 UI 不刷新, 必须重启 .exe
//   才能看到新 skill (D175 / v0.4.4 已知坑, user 反馈 "skill添加后不立刻显示").
// 修法: Tauri 端 list_skills 走 std::fs::read_dir 扫两个目录 (workspace + global), 解析 frontmatter,
//   跟 sidecar 的 skills_snapshot 解耦 — 跟 system prompt 注入无关, 纯 UI 列表.
//   FE 在 write_skill_file / import_skill_zip / import_skill_url 完成后调 list_skills 立刻刷新.

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListSkillsArgs {
    /// workspace 目录绝对路径 (用于扫 <ws>/.pi/skills/)
    ///   跟 write_skill_file / import_skill_zip 走同一目录
    workspace_path: Option<String>,
    /// global agentDir 路径 (用于扫 <agentDir>/skills/)
    ///   跟 Pi SDK 0.84.2 getAgentDir() 默认路径一致
    ///   FE 可以不传, Rust 端 fallback 算 (USERPROFILE/HOME + .pi/agent)
    agent_dir: Option<String>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SkillListItem {
    /// skill name (frontmatter.name 或 basename 去 .md)
    name: String,
    /// description (frontmatter.description)
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    /// 文件绝对路径
    file_path: String,
    /// 父目录 (workspace: <ws>/.pi/skills/ 或 global: <agentDir>/skills/)
    base_dir: String,
    /// "workspace" | "global" — 跟 Pi SDK 0.84.2 getAgentDir 默认路径一致
    scope: String,
    /// frontmatter.disable-model-invocation
    disable_model_invocation: bool,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ListSkillsResponse {
    skills: Vec<SkillListItem>,
    /// 解析错误 (skill 文件存在但 frontmatter 坏了等), 不阻塞主流程
    diagnostics: Vec<ListSkillsDiagnostic>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ListSkillsDiagnostic {
    #[serde(rename = "type")]
    diag_type: String,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
}

fn resolve_agent_dir(override_dir: Option<String>) -> Result<PathBuf, String> {
    if let Some(d) = override_dir.filter(|s| !s.is_empty()) {
        return Ok(PathBuf::from(d));
    }
    let home = std::env::var("USERPROFILE")
        .ok()
        .or_else(|| std::env::var("HOME").ok())
        .or_else(|| {
            std::env::var("HOMEDRIVE").ok()
                .zip(std::env::var("HOMEPATH").ok())
                .map(|(d, p)| format!("{}\\{}", d, p))
        })
        .ok_or_else(|| "无法定位 home dir (USERPROFILE/HOME 都未设)".to_string())?;
    Ok(PathBuf::from(home).join(".pi").join("agent"))
}

fn list_skills_in_dir(dir: &Path, scope: &str, diagnostics: &mut Vec<ListSkillsDiagnostic>) -> Vec<SkillListItem> {
    let mut out = Vec::new();
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return out,
        Err(e) => {
            diagnostics.push(ListSkillsDiagnostic {
                diag_type: "read_dir_failed".to_string(),
                message: format!("read_dir({}): {}", dir.display(), e),
                path: Some(dir.to_string_lossy().to_string()),
            });
            return out;
        }
    };
    for entry in entries.flatten() {
        let p = entry.path();
        // 多文件 skill: <dir>/<name>/SKILL.md, 单文件: <dir>/<name>.md
        let skill_md_path = if p.is_dir() {
            p.join("SKILL.md")
        } else if p.is_file() && p.extension().and_then(|s| s.to_str()) == Some("md") {
            p.clone()
        } else {
            continue;
        };
        if !skill_md_path.exists() {
            // 多文件 skill 但没 SKILL.md, 跳过 (不是有效 skill)
            if p.is_dir() {
                diagnostics.push(ListSkillsDiagnostic {
                    diag_type: "missing_skill_md".to_string(),
                    message: format!("目录存在但没 SKILL.md: {}", p.display()),
                    path: Some(p.to_string_lossy().to_string()),
                });
            }
            continue;
        }
        let raw = match std::fs::read_to_string(&skill_md_path) {
            Ok(s) => s,
            Err(e) => {
                diagnostics.push(ListSkillsDiagnostic {
                    diag_type: "read_failed".to_string(),
                    message: format!("read({}): {}", skill_md_path.display(), e),
                    path: Some(skill_md_path.to_string_lossy().to_string()),
                });
                continue;
            }
        };
        let parsed = parse_skill_frontmatter(&raw);
        // name fallback: frontmatter 缺失 → 文件名去 .md
        let name = if !parsed.name.is_empty() {
            parsed.name
        } else {
            skill_md_path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("skill")
                .to_string()
        };
        out.push(SkillListItem {
            name,
            description: parsed.description,
            file_path: skill_md_path.to_string_lossy().to_string(),
            base_dir: dir.to_string_lossy().to_string(),
            scope: scope.to_string(),
            disable_model_invocation: parsed.disable_model_invocation,
        });
    }
    out
}

#[tauri::command]
async fn list_skills(args: ListSkillsArgs) -> Result<ListSkillsResponse, String> {
    let mut diagnostics = Vec::new();
    let mut all_skills: Vec<SkillListItem> = Vec::new();

    // 1. workspace scope: <ws>/.pi/skills/
    if let Some(ws) = args.workspace_path.as_ref().filter(|s| !s.is_empty()) {
        let skills_dir = PathBuf::from(ws).join(".pi").join("skills");
        all_skills.extend(list_skills_in_dir(&skills_dir, "workspace", &mut diagnostics));
    }

    // 2. global scope: <agentDir>/skills/  (跟 Pi SDK 0.84.2 loadSkills 默认路径一致)
    let agent_dir = resolve_agent_dir(args.agent_dir)?;
    let global_skills_dir = agent_dir.join("skills");
    all_skills.extend(list_skills_in_dir(&global_skills_dir, "global", &mut diagnostics));

    // 3. 按 name 排序 (稳定顺序, UI 一致)
    all_skills.sort_by(|a, b| a.name.cmp(&b.name));

    Ok(ListSkillsResponse {
        skills: all_skills,
        diagnostics,
    })
}

// ====== v0.4.6 Project rules / 自定义指令 (跟 Claude 桌面端 "自定义指令" 模式) ======
// 持久化到 <workspace>/AGENTS.md (per-workspace) + <agentDir>/AGENTS.md (global),
//   Pi SDK 0.84.2 DefaultResourceLoader 自动 load 这两个文件 (resource-loader.ts:71),
//   sidecar 启动时把 paths 传 appendSystemPromptSource → Pi SDK load 内容追加到 system prompt.
// 跟 v0.4.4 Skills 一样 pattern (workspace scope / global scope, std::fs 读写).

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CustomInstructionsArgs {
    /// "workspace" → <ws>/AGENTS.md, "global" → <agentDir>/AGENTS.md
    scope: String,
    /// workspace scope 必填
    workspace_path: Option<String>,
    /// global scope 不需要 (Rust 端 fallback 算, 跟 write_skill_file 一样)
    agent_dir: Option<String>,
    /// write 用: 完整文件内容 (markdown). read/delete 时不传
    #[serde(default)]
    content: Option<String>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CustomInstructionsContent {
    /// 文件绝对路径 (或 None 如果文件不存在)
    file_path: Option<String>,
    /// 文件内容 (或空 string 如果不存在)
    content: String,
    /// 文件 mtime (或 None 如果不存在)
    modified_at: Option<String>,
}

fn resolve_custom_instructions_path(scope: &str, workspace_path: Option<String>, agent_dir: Option<String>) -> Result<PathBuf, String> {
    match scope {
        "workspace" => {
            let ws = workspace_path.as_ref().filter(|s| !s.is_empty()).ok_or("workspace scope 需要 workspacePath")?;
            Ok(PathBuf::from(ws).join("AGENTS.md"))
        }
        "global" => {
            let dir = match agent_dir.as_ref().filter(|s| !s.is_empty()) {
                Some(d) => PathBuf::from(d),
                None => {
                    // 跟 write_skill_file / list_skills 一样的 fallback: USERPROFILE/HOME + .pi/agent
                    let home = std::env::var("USERPROFILE")
                        .ok()
                        .or_else(|| std::env::var("HOME").ok())
                        .or_else(|| {
                            std::env::var("HOMEDRIVE").ok()
                                .zip(std::env::var("HOMEPATH").ok())
                                .map(|(d, p)| format!("{}\\{}", d, p))
                        })
                        .ok_or_else(|| "无法定位 home dir (USERPROFILE/HOME 都未设)".to_string())?;
                    PathBuf::from(home).join(".pi").join("agent")
                }
            };
            Ok(dir.join("AGENTS.md"))
        }
        _ => Err(format!("scope 必须是 'workspace' 或 'global', got '{}'", scope)),
    }
}

#[tauri::command]
async fn read_custom_instructions(args: CustomInstructionsArgs) -> Result<CustomInstructionsContent, String> {
    let path = resolve_custom_instructions_path(&args.scope, args.workspace_path, args.agent_dir)?;
    if !path.exists() {
        return Ok(CustomInstructionsContent {
            file_path: None,
            content: String::new(),
            modified_at: None,
        });
    }
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("read({}): {}", path.display(), e))?;
    let metadata = std::fs::metadata(&path).ok();
    let modified_at = metadata
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| format!("{}", d.as_secs()));
    Ok(CustomInstructionsContent {
        file_path: Some(path.to_string_lossy().to_string()),
        content,
        modified_at,
    })
}

#[tauri::command]
async fn write_custom_instructions(args: CustomInstructionsArgs) -> Result<String, String> {
    let path = resolve_custom_instructions_path(&args.scope, args.workspace_path, args.agent_dir.clone())?;
    let content = args.content.as_ref().ok_or("write_custom_instructions 需要 content 字段")?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("create_dir_all({}): {}", parent.display(), e))?;
    }
    std::fs::write(&path, content)
        .map_err(|e| format!("write({}): {}", path.display(), e))?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
async fn delete_custom_instructions(args: CustomInstructionsArgs) -> Result<bool, String> {
    let path = resolve_custom_instructions_path(&args.scope, args.workspace_path, args.agent_dir)?;
    if !path.exists() {
        return Ok(false);
    }
    std::fs::remove_file(&path)
        .map_err(|e| format!("remove_file({}): {}", path.display(), e))?;
    Ok(true)
}

// v0.5.0-v0.1: 删 v0.4.6.1 + v0.4.6.2 multi-agent persona 全部 invoke + struct + helper (314 行)
//   user 16:24 拍板: agent 是边界定义/思维指导, 永远是 1 个通用 agent, single agent 链路
//   替代 = AGENTS.md (Custom Instructions tab 编辑) + Pi SDK 0.84.2 DefaultResourceLoader
//   自动 load (resource-loader.ts:71) + 注入 system prompt 段. 详见 ADR-0024 (superseded by ADR-0025)

// ====== v0.4.5.2: User 自定义快捷提示词模板 (Slash commands) ======
// 跟 v0.4.6.1 agents 同 pattern, 但存 <workspace>/.pi/commands/*.md
// D184 v9 ❷ user 14:30: "Slash tab是单独用于给用户自定义快捷提示词模板的,
//   不是用来显示builtin的". builtin 22 个走 Pi CLI 内部, 不显示.

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommandArgs {
    workspace_path: Option<String>,
    #[serde(default)]
    agent_dir: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    content: Option<String>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CommandInfo {
    name: String,
    description: String,
    body: String,
    file_path: String,
}

fn parse_command_name(name: &str) -> Result<String, String> {
    if name.is_empty() || name.len() > 64 {
        return Err(format!("command name 长度必须 1-64, got {}", name.len()));
    }
    if !name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')) {
        return Err(format!("command name 只能含 [a-zA-Z0-9._-], got '{}'", name));
    }
    Ok(name.to_string())
}

fn resolve_commands_dir(workspace_path: Option<String>) -> Result<PathBuf, String> {
    let ws = workspace_path.as_ref().filter(|s| !s.is_empty())
        .ok_or("command 操作需要 workspacePath")?;
    Ok(PathBuf::from(ws).join(".pi").join("commands"))
}

// v0.5.0-v0.1: 命令专用 frontmatter 解析 (跟 v0.4.6.1 parse_agent_frontmatter 同 pattern,
//   之前 list/read_command 复用 parse_agent_frontmatter, multi-agent 回滚后改用本函数)
//   只解析 name / description (不需要 role, 跟 v0.4.5.2 设计一致)
fn parse_command_frontmatter(content: &str) -> (std::collections::HashMap<String, String>, String) {
    let mut fm: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    if !content.starts_with("---") {
        return (fm, content.to_string());
    }
    let rest = &content[3..];
    if let Some(end_idx) = rest.find("\n---") {
        let header = &rest[..end_idx];
        let after = &rest[end_idx + 4..];
        let body_start = after.find('\n').map(|i| i + 1).unwrap_or(0);
        let body = after[body_start..].to_string();
        for line in header.lines() {
            if let Some((k, v)) = line.split_once(':') {
                let key = k.trim().to_string();
                let val = v.trim().trim_matches('"').trim_matches('\'').to_string();
                if !key.is_empty() {
                    fm.insert(key, val);
                }
            }
        }
        return (fm, body);
    }
    (fm, content.to_string())
}

#[tauri::command]
async fn list_commands(args: CommandArgs) -> Result<Vec<CommandInfo>, String> {
    let mut commands = Vec::new();
    let dir = resolve_commands_dir(args.workspace_path)?;
    if dir.exists() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(commands),
            Err(e) => return Err(format!("read_dir({}): {}", dir.display(), e)),
        };
        for entry in entries.flatten() {
            let p = entry.path();
            if !p.is_file() || p.extension().and_then(|s| s.to_str()) != Some("md") { continue; }
            let filename = match p.file_stem().and_then(|s| s.to_str()) {
                Some(s) => s.to_string(),
                None => continue,
            };
            let content = match std::fs::read_to_string(&p) {
                Ok(c) => c,
                Err(_) => continue,
            };
            let (fm, body) = parse_command_frontmatter(&content);  // v0.5.0-v0.1: 改用命令专用 frontmatter 解析 (之前复用 parse_agent_frontmatter 已被删)
            commands.push(CommandInfo {
                name: fm.get("name").cloned().unwrap_or_else(|| filename.clone()),
                description: fm.get("description").cloned().unwrap_or_else(|| "(无描述)".to_string()),
                body,
                file_path: p.to_string_lossy().to_string(),
            });
        }
    }
    commands.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(commands)
}

#[tauri::command]
async fn read_command(args: CommandArgs) -> Result<CommandInfo, String> {
    let name = args.name.as_ref().ok_or("read_command 需要 name 字段")?;
    parse_command_name(name)?;
    let dir = resolve_commands_dir(args.workspace_path)?;
    let path = dir.join(format!("{}.md", name));
    if !path.exists() {
        return Err(format!("command 不存在: {}", path.display()));
    }
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("read({}): {}", path.display(), e))?;
    let (fm, body) = parse_command_frontmatter(&content);
    Ok(CommandInfo {
        name: fm.get("name").cloned().unwrap_or_else(|| name.clone()),
        description: fm.get("description").cloned().unwrap_or_else(|| "(无描述)".to_string()),
        body,
        file_path: path.to_string_lossy().to_string(),
    })
}

#[tauri::command]
async fn write_command(args: CommandArgs) -> Result<String, String> {
    let name = args.name.as_ref().ok_or("write_command 需要 name 字段")?;
    parse_command_name(name)?;
    let content = args.content.as_ref().ok_or("write_command 需要 content 字段")?;
    let dir = resolve_commands_dir(args.workspace_path)?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("create_dir_all({}): {}", dir.display(), e))?;
    let path = dir.join(format!("{}.md", name));
    let final_content = if content.starts_with("---") {
        content.clone()
    } else {
        format!("---\nname: {}\ndescription: (无描述)\n---\n\n{}", name, content)
    };
    std::fs::write(&path, &final_content)
        .map_err(|e| format!("write({}): {}", path.display(), e))?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
async fn delete_command(args: CommandArgs) -> Result<bool, String> {
    let name = args.name.as_ref().ok_or("delete_command 需要 name 字段")?;
    parse_command_name(name)?;
    let dir = resolve_commands_dir(args.workspace_path)?;
    let path = dir.join(format!("{}.md", name));
    if !path.exists() {
        return Ok(false);
    }
    std::fs::remove_file(&path)
        .map_err(|e| format!("remove_file({}): {}", path.display(), e))?;
    Ok(true)
}

// ====== 2026-08-20 P1-5: User tools (从 builtin tool 派生的"args 预设"模板) ======
// 跟 Skills / Commands / CustomInstructions 同 pattern, 但:
//   - 文件扩展名是 .json (Skills/Commands 是 .md, frontmatter + body; user tool 是完整 JSON)
//   - 两层 scope (workspace + global, workspace 优先 — 跟 Skills/Commands 一致)
//   - name 校验: 1-64 char, [a-zA-Z0-9._-], 不能是 '.' / '..' 防 path traversal
//   - 额外校验: name 不能跟 builtin 7 个 tool 重 (read / write / edit / bash / ls / find / grep)
//
// JSON schema (跟 ADR 衍生 user tool 一致):
//   {
//     "name": "my_grep_todo",
//     "description": "在 src/**/*.ts 里找 TODO 注释, 排除测试文件",
//     "basedOn": "grep",
//     "args": { "pattern": "TODO", "path": "src", "include": "*.ts", "exclude": "*.test.ts" }
//   }
// 其中:
//   - name: 必填, 跟文件名一致 (sans .json 后缀)
//   - description: 必填, LLM 看的 (告诉 LLM 啥时候该用这个 tool)
//   - basedOn: 必填, 必须是 builtin 7 个 tool 之一
//   - args: 必填, JSON object (传给 builtin tool 时的预设 args, LLM 调时还能 override)
//
// user tool 真的接进 LLM 可见 tools list 在 sidecar 启动时实现 (Batch 2), 这里只做 CRUD.

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct UserToolArgs {
    /// "workspace" 写到 <workspacePath>/.pi/tools/<name>.json
    /// "global"   写到 <agentDir>/tools/<name>.json (跟 Skills/Commands global scope 一致)
    scope: String,
    /// user tool 名字, 跟文件名 sans .json 一致, 1-64 char, [a-zA-Z0-9._-]
    name: String,
    /// 完整 JSON 字符串 (含 name / description / basedOn / args)
    body: String,
    /// workspace scope 必填
    workspace_path: Option<String>,
    /// global scope 必填
    agent_dir: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadDeleteUserToolArgs {
    scope: String,
    name: String,
    workspace_path: Option<String>,
    agent_dir: Option<String>,
}

#[derive(Debug, serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct UserToolInfo {
    name: String,
    description: String,
    /// builtin tool name (read / write / edit / bash / ls / find / grep)
    based_on: String,
    /// JSON 字符串, 跟 file body 一致 (方便 FE 不重复读)
    body: String,
    file_path: String,
    /// "workspace" | "global"
    scope: String,
}

/// 跟 builtin 7 个 tool 重名 → 拒绝 (user tool 会跟 builtin 在同一个 LLM 可见 tools list, 重名会冲突)
const BUILTIN_TOOL_NAMES: &[&str] = &["read", "write", "edit", "bash", "ls", "find", "grep"];

fn parse_user_tool_name(name: &str) -> Result<String, String> {
    if name.is_empty() || name.len() > 64 {
        return Err(format!("user tool name 长度必须 1-64, got {}", name.len()));
    }
    if !name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')) {
        return Err(format!("user tool name 只能含 [a-zA-Z0-9._-], got '{}'", name));
    }
    if name == "." || name == ".." {
        return Err("user tool name 不能是 '.' 或 '..'".to_string());
    }
    if BUILTIN_TOOL_NAMES.contains(&name) {
        return Err(format!("user tool name '{}' 跟 builtin tool 重名, 拒绝保存. 加个前缀 (e.g. my_{})", name, name));
    }
    Ok(name.to_string())
}

fn resolve_user_tools_dir(scope: &str, workspace_path: Option<String>, agent_dir: Option<String>) -> Result<PathBuf, String> {
    match scope {
        "workspace" => {
            let ws = workspace_path.as_ref().filter(|s| !s.is_empty())
                .ok_or("workspace scope 需要 workspacePath")?;
            Ok(PathBuf::from(ws).join(".pi").join("tools"))
        }
        "global" => {
            let dir = agent_dir.as_ref().filter(|s| !s.is_empty())
                .ok_or("global scope 需要 agentDir")?;
            Ok(PathBuf::from(dir).join("tools"))
        }
        other => Err(format!("scope 必须是 'workspace' 或 'global', got '{}'", other)),
    }
}

/// 解析 user tool JSON body, 校验 basedOn 是不是 builtin 7 个之一.
/// 解析失败或 basedOn 不合法 → 拒绝保存 (避免 sidecar 启动加载时崩).
fn validate_user_tool_body(body: &str) -> Result<(), String> {
    let parsed: serde_json::Value = serde_json::from_str(body)
        .map_err(|e| format!("user tool body 不是合法 JSON: {}", e))?;
    let obj = parsed.as_object()
        .ok_or("user tool body 必须是 JSON object")?;
    let name = obj.get("name").and_then(|v| v.as_str())
        .ok_or("user tool body 缺 'name' 字段")?;
    if name.is_empty() {
        return Err("user tool body 'name' 字段不能为空".to_string());
    }
    let based_on = obj.get("basedOn").and_then(|v| v.as_str())
        .ok_or("user tool body 缺 'basedOn' 字段")?;
    if !BUILTIN_TOOL_NAMES.contains(&based_on) {
        return Err(format!(
            "user tool basedOn '{}' 不是 builtin tool, 必须是 [{}] 之一",
            based_on,
            BUILTIN_TOOL_NAMES.join(", ")
        ));
    }
    let args = obj.get("args");
    if args.is_none() {
        return Err("user tool body 缺 'args' 字段".to_string());
    }
    if !args.unwrap().is_object() {
        return Err("user tool body 'args' 字段必须是 JSON object".to_string());
    }
    let description = obj.get("description").and_then(|v| v.as_str())
        .ok_or("user tool body 缺 'description' 字段")?;
    if description.is_empty() {
        return Err("user tool body 'description' 字段不能为空".to_string());
    }
    Ok(())
}

/// 从 JSON body 抽出 UserToolInfo 字段 (parse + extract, 不做校验, 校验由 validate_user_tool_body 完成)
fn extract_user_tool_info(name: &str, body: &str, file_path: &str, scope: &str) -> Option<UserToolInfo> {
    let parsed: serde_json::Value = serde_json::from_str(body).ok()?;
    let obj = parsed.as_object()?;
    Some(UserToolInfo {
        name: name.to_string(),
        description: obj.get("description").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        based_on: obj.get("basedOn").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        body: body.to_string(),
        file_path: file_path.to_string(),
        scope: scope.to_string(),
    })
}

#[tauri::command]
async fn list_user_tools(workspace_path: Option<String>, agent_dir: Option<String>) -> Result<Vec<UserToolInfo>, String> {
    // 两层 scope 扫描: workspace 优先 (同名时 workspace 覆盖 global)
    // 抽成 closure (不用 `?` + `continue` 跨 await point, Rust async 限制)
    // 顺序: 先 global, 再 workspace (workspace 后写覆盖 global, 用 name 去重)
    let mut tools: Vec<UserToolInfo> = Vec::new();
    let mut seen_names: std::collections::HashSet<String> = std::collections::HashSet::new();

    // 闭包: 扫一个目录, 返回该 scope 找到的 tools + 看到的所有 name
    // closure 不能直接 mutate outer 状态 (闭包捕获 + send), 用 mut ref 参数
    fn scan_scope_dir<'a>(
        dir: &std::path::Path,
        scope: &'a str,
        tools: &'a mut Vec<UserToolInfo>,
        seen_names: &'a mut std::collections::HashSet<String>,
        workspace_override: bool,
    ) -> Result<(), String> {
        if !dir.exists() { return Ok(()); }
        let entries = std::fs::read_dir(dir)
            .map_err(|e| format!("read_dir({}): {}", dir.display(), e))?;
        for entry in entries.flatten() {
            let p = entry.path();
            if !p.is_file() || p.extension().and_then(|s| s.to_str()) != Some("json") { continue; }
            let filename = match p.file_stem().and_then(|s| s.to_str()) {
                Some(s) => s.to_string(),
                None => continue,
            };
            let body = match std::fs::read_to_string(&p) {
                Ok(s) => s,
                Err(e) => {
                    debug_log(&format!("list_user_tools: read {} failed: {}", p.display(), e));
                    continue;
                }
            };
            if let Some(info) = extract_user_tool_info(&filename, &body, &p.display().to_string(), scope) {
                if workspace_override && seen_names.contains(&filename) {
                    // workspace 覆盖 global: 删掉 global 那条
                    tools.retain(|t| t.name != filename);
                }
                seen_names.insert(filename);
                tools.push(info);
            }
        }
        Ok(())
    }

    // 1. global scope: <agentDir>/tools/*.json
    if let Some(agent_dir_str) = agent_dir.as_ref().filter(|s| !s.is_empty()) {
        let global_dir = PathBuf::from(agent_dir_str).join("tools");
        scan_scope_dir(&global_dir, "global", &mut tools, &mut seen_names, false)?;
    }
    // 2. workspace scope: <workspacePath>/.pi/tools/*.json (覆盖 global 同名)
    if let Some(ws_str) = workspace_path.as_ref().filter(|s| !s.is_empty()) {
        let workspace_dir = PathBuf::from(ws_str).join(".pi").join("tools");
        scan_scope_dir(&workspace_dir, "workspace", &mut tools, &mut seen_names, true)?;
    }

    tools.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(tools)
}

#[tauri::command]
async fn read_user_tool(args: ReadDeleteUserToolArgs) -> Result<String, String> {
    let dir = resolve_user_tools_dir(&args.scope, args.workspace_path, args.agent_dir)?;
    let path = dir.join(format!("{}.json", args.name));
    if !path.exists() {
        return Err(format!("user tool '{}' (scope={}) 不存在", args.name, args.scope));
    }
    // D214 v7: 走 ref body cache, mtime 一致返 cache
    let cache_key = format!("tool:{}:{}", args.scope, args.name);
    read_with_cache(cache_key, &path, |p| async move {
        std::fs::read_to_string(&p)
            .map_err(|e| format!("read_to_string({}): {}", p.display(), e))
    }).await
}

#[tauri::command]
async fn write_user_tool(args: UserToolArgs) -> Result<String, String> {
    // 1. name 校验
    let name = parse_user_tool_name(&args.name)?;
    // 2. body 校验: 合法 JSON + 必填字段 + basedOn 合法
    validate_user_tool_body(&args.body)?;
    // 3. body 里的 name 跟文件名一致 (防止"用 A 名字存 B 内容" 这种脏数据)
    let parsed: serde_json::Value = serde_json::from_str(&args.body)
        .map_err(|e| format!("internal: body re-parse failed: {}", e))?;
    let body_name = parsed.get("name").and_then(|v| v.as_str())
        .ok_or("body 缺 name 字段")?;
    if body_name != name {
        return Err(format!(
            "body 里的 name '{}' 跟文件名 '{}' 不一致, 拒绝保存",
            body_name, name
        ));
    }
    // 4. 解析路径
    let dir = resolve_user_tools_dir(&args.scope, args.workspace_path, args.agent_dir)?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("create_dir_all({}): {}", dir.display(), e))?;
    let path = dir.join(format!("{}.json", name));
    std::fs::write(&path, args.body.as_bytes())
        .map_err(|e| format!("write({}): {}", path.display(), e))?;
    // D214 v7: invalidate ref body cache
    invalidate_ref_body_cache(&format!("tool:{}:{}", args.scope, name));
    debug_log(&format!("write_user_tool: wrote {} (scope={})", path.display(), args.scope));
    Ok(path.display().to_string())
}

#[tauri::command]
async fn delete_user_tool(args: ReadDeleteUserToolArgs) -> Result<bool, String> {
    let dir = resolve_user_tools_dir(&args.scope, args.workspace_path, args.agent_dir)?;
    let path = dir.join(format!("{}.json", args.name));
    if !path.exists() {
        return Ok(false);
    }
    std::fs::remove_file(&path)
        .map_err(|e| format!("remove_file({}): {}", path.display(), e))?;
    // D214 v7: invalidate ref body cache
    invalidate_ref_body_cache(&format!("tool:{}:{}", args.scope, args.name));
    Ok(true)
}

// ====== 2026-08-21 v0.6.3-rc1 P2-1: MCP server 配置 CRUD ======
//   跟 P1-5 user tool 同 pattern: 两层 scope (workspace + global, workspace 优先)
//     - workspace: <workspacePath>/.pi/mcp/<name>.json
//     - global:   <agentDir>/mcp/<name>.json
//   JSON body schema (跟 sidecar mcpClient.mjs McpServerConfig 一致):
//     { name: string, command: string, args?: string[], env?: Record<string, string>, cwd?: string, timeout?: number }
//   name 跟 builtin 7 个 tool 不重 (跟 P1-5 一致), 防 mcp_<name>_<tool> 前缀冲突.
//   存 Tauri 4 个 invoke + 跟 list_user_tools 同 storage 模式.
//
//   跟 P1-5 user tool 的核心差异:
//   - name 校验字符放宽: MCP server name 允许更自由的字符 (e.g. 'fetch', '@scope/name'),
//     但还是限制 [A-Za-z0-9._@-], 1-64 char, 不跟 builtin 重
//   - body 校验: 必填 name + command (string), 其它字段 (args / env / cwd / timeout) 可选
//   - 不要求 body.name 跟 filename 一致 (server name 用 filename, 启动时 fallback 到 body.name)

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct McpServerArgs {
    /// "workspace" 写到 <workspacePath>/.pi/mcp/<name>.json
    /// "global"   写到 <agentDir>/mcp/<name>.json
    scope: String,
    /// server 名, 跟文件名 sans .json 一致, 1-64 char
    name: String,
    /// 完整 JSON 字符串 (含 name / command / args / env / cwd / timeout)
    body: String,
    /// workspace scope 必填
    workspace_path: Option<String>,
    /// global scope 必填
    agent_dir: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadDeleteMcpServerArgs {
    scope: String,
    name: String,
    workspace_path: Option<String>,
    agent_dir: Option<String>,
}

#[derive(Debug, serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct McpServerInfo {
    name: String,
    /// stdio 启动命令 (e.g. npx / node / .exe 绝对路径)
    /// http/sse 时为空字符串 (走 url 字段)
    command: String,
    /// 完整 JSON body (跟 file 内容一致, 方便 FE 不重复读)
    body: String,
    /// 绝对文件路径, FE 用于 debug / 显示
    file_path: String,
    /// 'workspace' | 'global'
    scope: String,
    /// v0.6.3-rc1 P2-1.3: transport 类型 (stdio | http | sse). 跟 P1-5 user tool 区分.
    ///   - stdio: 子进程走 JSON-RPC over stdio (P2-1.0 实现)
    ///   - http: HTTP POST (P2-1.8 实现, StreamableHTTPClientTransport)
    ///   - sse:  Server-Sent Events (P2-1.8 实现, SSEClientTransport)
    /// 旧配置没 type 字段时 fallback 到 "stdio" (向后兼容)
    #[serde(rename = "type")]
    server_type: String,
    /// v0.6.3-rc1 P2-1.8: http/sse 用的 URL. stdio 时为 null.
    /// FE 在 type=http/sse 时显示, stdio 时隐藏
    url: Option<String>,
}

fn parse_mcp_server_name(name: &str) -> Result<String, String> {
    if name.is_empty() || name.len() > 64 {
        return Err(format!("mcp server name 长度必须 1-64, got {}", name.len()));
    }
    // 允许 [a-zA-Z0-9._@-] (MCP server name 常见是 'fetch', '@scope/name' 之类)
    if !name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '@')) {
        return Err(format!("mcp server name 只能含 [A-Za-z0-9._@-], got '{}'", name));
    }
    if name == "." || name == ".." {
        return Err("mcp server name 不能是 '.' 或 '..'".to_string());
    }
    // 防 mcp_<server>_<tool> 前缀跟 builtin 7 个 tool 撞
    if BUILTIN_TOOL_NAMES.contains(&name) {
        return Err(format!(
            "mcp server name '{}' 跟 builtin tool 重名, 拒绝保存. 加个前缀 (e.g. mcp_{})",
            name, name
        ));
    }
    Ok(name.to_string())
}

fn resolve_mcp_servers_dir(scope: &str, workspace_path: Option<String>, agent_dir: Option<String>) -> Result<PathBuf, String> {
    match scope {
        "workspace" => {
            let ws = workspace_path.as_ref().filter(|s| !s.is_empty())
                .ok_or("workspace scope 需要 workspacePath")?;
            Ok(PathBuf::from(ws).join(".pi").join("mcp"))
        }
        "global" => Ok(resolve_mcp_agent_dir(agent_dir)?.join("mcp")),
        other => Err(format!("scope 必须是 'workspace' 或 'global', got '{}'", other)),
    }
}

/// v0.6.3-rc1 P2-1.6: 抽出 MCP 用的 agentDir 解析逻辑 (跟 resolve_mcp_servers_dir 共用).
///   FE 之前永远传 None, 兜底: 优先用 FE 传值, 拿不到用 <user.home>/.pi/agent.
///   USERPROFILE env 优先 (Windows), fallback HOME env (Unix).
///   跟 skill 用的 resolve_agent_dir (line 729, 没兜底) 不同, 命名区分一下.
fn resolve_mcp_agent_dir(agent_dir: Option<String>) -> Result<PathBuf, String> {
    let dir_str = agent_dir
        .as_ref()
        .filter(|s| !s.is_empty())
        .cloned()
        .or_else(|| {
            std::env::var_os("USERPROFILE")
                .or_else(|| std::env::var_os("HOME"))
                .map(|p| {
                    let home = p.to_string_lossy().to_string();
                    format!("{}{}.pi{}agent", home, std::path::MAIN_SEPARATOR, std::path::MAIN_SEPARATOR)
                })
        })
        .ok_or("global scope 需要 agentDir (FE 没传 + 环境变量也拿不到 home dir)")?;
    Ok(PathBuf::from(dir_str))
}

/// 解析 mcp server JSON body, 校验必填字段 + 字段类型.
/// 跟 sidecar/src/mcpClient.mjs tryParseMcpServerJson 校验规则保持一致 (FE 写之前 FE 校验,
///   FE 跳过时 Rust 端兜底, 防止脏数据落盘). bad JSON / 缺 name / 缺 command / command 不是
///   string → 拒绝保存.
fn validate_mcp_server_body(body: &str) -> Result<(), String> {
    let parsed: serde_json::Value = serde_json::from_str(body)
        .map_err(|e| format!("mcp server body 不是合法 JSON: {}", e))?;
    let obj = parsed.as_object()
        .ok_or("mcp server body 必须是 JSON object")?;
    let name = obj.get("name").and_then(|v| v.as_str())
        .ok_or("mcp server body 缺 'name' 字段或不是 string")?;
    if name.is_empty() {
        return Err("mcp server body 'name' 字段不能为空".to_string());
    }
    // 解析 type (先解析, 后面按 type 分支校验必填字段)
    let server_type = obj.get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("stdio");
    if !matches!(server_type, "stdio" | "http" | "sse") {
        return Err(format!("mcp server body 'type' 必须是 'stdio' | 'http' | 'sse', got '{}'", server_type));
    }

    // 按 type 分支校验必填字段:
    //   stdio: command 必填
    //   http/sse: url 必填, command/args/cwd 不需要
    if server_type == "stdio" {
        let command = obj.get("command").and_then(|v| v.as_str())
            .ok_or("mcp server body (type=stdio) 缺 'command' 字段或不是 string")?;
        if command.is_empty() {
            return Err("mcp server body 'command' 字段不能为空".to_string());
        }
    } else {
        // http / sse
        let url = obj.get("url").and_then(|v| v.as_str())
            .ok_or(format!("mcp server body (type={}) 缺 'url' 字段或不是 string", server_type))?;
        if url.is_empty() {
            return Err("mcp server body 'url' 字段不能为空".to_string());
        }
        // 简单 URL 格式校验: 必须是 http:// 或 https://
        if !url.starts_with("http://") && !url.starts_with("https://") {
            return Err(format!("mcp server body 'url' 必须是 http:// 或 https:// 开头, got '{}'", url));
        }
    }
    // args: 可选 (stdio 才有意义), 但如果有必须是 array of string
    if let Some(args) = obj.get("args") {
        if !args.is_array() {
            return Err("mcp server body 'args' 字段必须是 array".to_string());
        }
        for (i, arg) in args.as_array().unwrap().iter().enumerate() {
            if !arg.is_string() {
                return Err(format!("mcp server body 'args[{}]' 必须是 string", i));
            }
        }
    }
    // env: 可选, 但如果有必须是 object of string
    //   - stdio: 子进程环境变量
    //   - http/sse: HTTP request headers (e.g., "Authorization: Bearer xxx")
    if let Some(env) = obj.get("env") {
        let env_obj = env.as_object()
            .ok_or("mcp server body 'env' 字段必须是 object")?;
        for (k, v) in env_obj {
            if !v.is_string() {
                return Err(format!("mcp server body 'env.{}' 必须是 string", k));
            }
        }
    }
    // cwd: 可选 (stdio 才有意义), 但如果有必须是 string
    if let Some(cwd) = obj.get("cwd") {
        if !cwd.is_string() {
            return Err("mcp server body 'cwd' 字段必须是 string".to_string());
        }
    }
    // timeout: 可选, 但如果有必须是 number
    if let Some(timeout) = obj.get("timeout") {
        if !timeout.is_number() {
            return Err("mcp server body 'timeout' 字段必须是 number".to_string());
        }
    }
    // v0.6.3-rc1 P2-1.3 + P2-1.8: type 字段 (可选, 默认 "stdio")
    //   - stdio: 子进程 JSON-RPC over stdio (P2-1.0 实现)
    //   - http: StreamableHTTPClientTransport (P2-1.8 实现, 新 MCP 标准)
    //   - sse:  SSEClientTransport (P2-1.8 实现, 旧 MCP 标准, 兼容老 server)
    //   旧配置没 type 时默认 stdio, 行为不变 (向后兼容)
    if let Some(t) = obj.get("type") {
        let type_str = t.as_str()
            .ok_or("mcp server body 'type' 字段必须是 string")?;
        if !matches!(type_str, "stdio" | "http" | "sse") {
            return Err(format!(
                "mcp server body 'type' 必须是 'stdio' | 'http' | 'sse', got '{}'",
                type_str
            ));
        }
    }
    Ok(())
}

fn extract_mcp_server_info(name: &str, body: &str, file_path: &str, scope: &str) -> Option<McpServerInfo> {
    let parsed: serde_json::Value = serde_json::from_str(body).ok()?;
    let obj = parsed.as_object()?;
    // v0.6.3-rc1 P2-1.3: 读 type 字段, 默认 "stdio" (向后兼容)
    let server_type = obj.get("type")
        .and_then(|v| v.as_str())
        .filter(|t| matches!(*t, "stdio" | "http" | "sse"))
        .unwrap_or("stdio")
        .to_string();
    // v0.6.3-rc1 P2-1.8: 读 url 字段 (http/sse 必填, stdio 时为 None)
    let url = obj.get("url")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    Some(McpServerInfo {
        name: name.to_string(),
        command: obj.get("command").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        server_type,
        url,
        body: body.to_string(),
        file_path: file_path.to_string(),
        scope: scope.to_string(),
    })
}

#[tauri::command]
async fn list_mcp_servers(workspace_path: Option<String>, agent_dir: Option<String>) -> Result<Vec<McpServerInfo>, String> {
    debug_log(&format!("list_mcp_servers: enter workspace_path={:?} agent_dir={:?}", workspace_path, agent_dir));
    // 跟 P1-5 list_user_tools 同 pattern: 先 global, 再 workspace (workspace 后写覆盖 global, 用 name 去重)
    let mut servers: Vec<McpServerInfo> = Vec::new();
    let mut seen_names: std::collections::HashSet<String> = std::collections::HashSet::new();

    fn scan_scope_dir(
        dir: &std::path::Path,
        scope: &str,
        servers: &mut Vec<McpServerInfo>,
        seen_names: &mut std::collections::HashSet<String>,
        workspace_override: bool,
    ) -> Result<(), String> {
        if !dir.exists() {
            debug_log(&format!("list_mcp_servers: dir not exist, skip: {}", dir.display()));
            return Ok(());
        }
        debug_log(&format!("list_mcp_servers: scanning dir={} scope={}", dir.display(), scope));
        let entries = std::fs::read_dir(dir)
            .map_err(|e| format!("read_dir({}): {}", dir.display(), e))?;
        for entry in entries.flatten() {
            let p = entry.path();
            if !p.is_file() || p.extension().and_then(|s| s.to_str()) != Some("json") { continue; }
            let filename = match p.file_stem().and_then(|s| s.to_str()) {
                Some(s) => s.to_string(),
                None => continue,
            };
            let body = match std::fs::read_to_string(&p) {
                Ok(s) => s,
                Err(e) => {
                    debug_log(&format!("list_mcp_servers: read {} failed: {}", p.display(), e));
                    continue;
                }
            };
            if let Some(info) = extract_mcp_server_info(&filename, &body, &p.display().to_string(), scope) {
                if workspace_override && seen_names.contains(&filename) {
                    servers.retain(|s| s.name != filename);
                }
                seen_names.insert(filename);
                servers.push(info);
            }
        }
        Ok(())
    }

    // 1. global scope: <agentDir>/mcp/*.json
    // 1. global scope: <agentDir>/mcp/*.json (覆盖 global 同名)
    // v0.6.3-rc1 P2-1.6 fix: FE 永远传 None, 加兜底用 <user.home>/.pi/agent
    //   (跟 write_mcp_server 行为一致, 共享 resolve_agent_dir)
    if let Ok(agent_dir_path) = resolve_mcp_agent_dir(agent_dir) {
        let global_dir = agent_dir_path.join("mcp");
        scan_scope_dir(&global_dir, "global", &mut servers, &mut seen_names, false)?;
    } else {
        debug_log(&format!("list_mcp_servers: skip global scan, agent_dir 拿不到 (FE 没传, 环境变量也没 home)"));
    }
    // 2. workspace scope: <workspacePath>/.pi/mcp/*.json (覆盖 global 同名)
    if let Some(ws_str) = workspace_path.as_ref().filter(|s| !s.is_empty()) {
        let workspace_dir = PathBuf::from(ws_str).join(".pi").join("mcp");
        scan_scope_dir(&workspace_dir, "workspace", &mut servers, &mut seen_names, true)?;
    }

    servers.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(servers)
}

#[tauri::command]
async fn read_mcp_server(args: ReadDeleteMcpServerArgs) -> Result<String, String> {
    let dir = resolve_mcp_servers_dir(&args.scope, args.workspace_path, args.agent_dir)?;
    let path = dir.join(format!("{}.json", args.name));
    if !path.exists() {
        return Err(format!("mcp server '{}' (scope={}) 不存在", args.name, args.scope));
    }
    // D214 v7: 走 ref body cache, mtime 一致返 cache
    let cache_key = format!("mcp:{}:{}", args.scope, args.name);
    read_with_cache(cache_key, &path, |p| async move {
        std::fs::read_to_string(&p)
            .map_err(|e| format!("read_to_string({}): {}", p.display(), e))
    }).await
}

#[tauri::command]
async fn write_mcp_server(args: McpServerArgs) -> Result<String, String> {
    // 1. name 校验
    let name = parse_mcp_server_name(&args.name)?;
    // 2. body 校验
    validate_mcp_server_body(&args.body)?;
    // 3. 解析路径
    let dir = resolve_mcp_servers_dir(&args.scope, args.workspace_path, args.agent_dir)?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("create_dir_all({}): {}", dir.display(), e))?;
    let path = dir.join(format!("{}.json", name));
    std::fs::write(&path, args.body.as_bytes())
        .map_err(|e| format!("write({}): {}", path.display(), e))?;
    // D214 v7: invalidate ref body cache
    invalidate_ref_body_cache(&format!("mcp:{}:{}", args.scope, name));
    debug_log(&format!("write_mcp_server: wrote {} (scope={})", path.display(), args.scope));
    Ok(path.display().to_string())
}

#[tauri::command]
async fn delete_mcp_server(args: ReadDeleteMcpServerArgs) -> Result<bool, String> {
    let dir = resolve_mcp_servers_dir(&args.scope, args.workspace_path, args.agent_dir)?;
    let path = dir.join(format!("{}.json", args.name));
    if !path.exists() {
        return Ok(false);
    }
    std::fs::remove_file(&path)
        .map_err(|e| format!("remove_file({}): {}", path.display(), e))?;
    // D214 v7: invalidate ref body cache
    invalidate_ref_body_cache(&format!("mcp:{}:{}", args.scope, args.name));
    Ok(true)
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
            skills: config.skills,  // v0.4.4 Skills (Pi SDK 暴露) — 已存在但没传, 补上
            model_metadata: config.model_metadata,  // v0.4.4.6 model metadata
            // v0.5.0-v0.1: 删 active_agent 字段 (multi-agent persona 回滚)
        },
        session_id.clone(),
        prompt_cmd_json,
        active,
    );
    Ok(())
}

// ====== Bug #2 修 (2026-08-18): 独立 compact_session invoke ======
// 跟 send_prompt 签名一样, 但不走 send_rpc_command (避免闲置 session 找不到 active child).
// force-spawn 一个新 sidecar 专门跑 compact, 收到 compaction_end 就 kill.
// FE 端 (chat.ts compact()) 看到这个 invoke 直接调, 跟当前是否有 active sidecar 解耦.
#[tauri::command]
async fn compact_session(
    app: AppHandle,
    session_id: String,
    config: ClientConfig,
) -> Result<(), String> {
    debug_log(&format!(
        "compact_session: session={}, provider={}, model={}, workspace={:?}",
        session_id, config.provider, config.model, config.workspace_path
    ));

    // 跟 send_prompt 一样: 走 keychain 拿 apiKey (永不在 FE)
    let api_key = match keyring::get(&config.provider_id) {
        Ok(Some(k)) => k,
        Ok(None) => {
            return Err(format!(
                "No API key for provider \"{}\" in OS keychain.",
                config.provider_id
            ));
        }
        Err(e) => return Err(format!("Keychain read error: {e}")),
    };

    let base_url = if config.provider == "openai-compatible" {
        config
            .base_url
            .clone()
            .ok_or_else(|| "openai-compatible needs baseUrl".to_string())?
    } else {
        String::new()
    };

    let session_id_for_sidecar = match (&config.workspace_path, &config.session_id) {
        (Some(ws), Some(sid)) if !ws.is_empty() && !sid.is_empty() => Some(sid.clone()),
        _ => None,
    };

    let active = app.state::<std::sync::Arc<sidecar::ActiveSidecars>>().inner().clone();

    sidecar::run_compact(
        app,
        sidecar::SidecarConfig {
            provider: config.provider,
            model: config.model,
            base_url,
            api_key,
            thinking_level: config.thinking_level,
            workspace_path: config.workspace_path,
            permission_mode: config.permission_mode.unwrap_or_else(|| "ask".to_string()),
            session_id: session_id_for_sidecar,
            skills: config.skills,
            model_metadata: config.model_metadata,
        },
        session_id,
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
#[serde(rename_all = "camelCase")]
pub struct ModelInfoDto {
    pub id: String,
    pub label: Option<String>,
    /// 自动填充的 metadata (来自 catalog 或 openai-compatible 响应 parse)
    /// 都 Option — 没匹配到就让 FE 留空让用户填
    pub context_window: Option<u32>,
    pub max_output: Option<u32>,
    pub vision: Option<bool>,
    pub reasoning: Option<bool>,
    /// "chat" | "image" | "embedding" | "video" | "audio"
    pub model_type: Option<String>,
    /// 自动来源: "catalog" (内置静态) | "openai-compatible" (运行时 parse)
    /// | null (没匹配到, 用户手填)
    pub auto_source: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyConnectionResult {
    /// true = 连接/key 看起来 OK (实际 LLM 调通性以首次对话为准)
    pub ok: bool,
    /// 用户可见的简短状态 (e.g. "✓ 通了, 拿到 12 个 model" / "✗ 401 Unauthorized, key 无效")
    pub message: String,
    /// openai-compatible 时返回 /models 拉到的 model 数, 其它为 None
    pub model_count: Option<u32>,
    /// HTTP 延迟 ms (openai-compatible), 其它为 None
    pub latency_ms: Option<u32>,
    /// 详细原始错误 (ok=false 时), 方便 debug
    pub detail: Option<String>,
}

/// v0.5.0-D D213: 拉 model 列表 + 自动 metadata 填充.
///
/// 输入: provider_id (keychain 取 key), provider_type (走 catalog), base_url (openai-compatible 用)
/// 输出: Vec<ModelInfoDto>, 每条带自动填充的 metadata (catalog 或 openai-compatible 响应 parse)
///
/// 自动填充优先级:
///   1. openai-compatible 响应里有 context_length → 用响应里的
///   2. 内置 provider 走 model_catalog (静态)
///   3. 都没匹配 → 字段全 None, FE 让用户手填
#[tauri::command]
async fn fetch_provider_models(
    provider_id: String,
    provider_type: String,
    base_url: String,
) -> Result<Vec<ModelInfoDto>, String> {
    let api_key = keyring::get(&provider_id)?
        .ok_or_else(|| format!("No API key in keychain for \"{provider_id}\""))?;
    let clean_base = base_url.trim_end_matches('/');
    let url = format!("{clean_base}/models");

    // ureq 是同步 HTTP, 用 spawn_blocking 避免阻塞 Tauri runtime
    let url_clone = url.clone();
    let api_key_clone = api_key.clone();
    // raw models: (id, label, raw_json). raw_json 留着用 best-effort parse
    let raw_models: Vec<(String, Option<String>, Option<serde_json::Value>)> =
        tokio::task::spawn_blocking(move || -> Result<Vec<(String, Option<String>, Option<serde_json::Value>)>, String> {
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
            Ok(arr.iter().filter_map(|m| {
                let id = m.get("id").and_then(|i| i.as_str())?.to_string();
                let label = m.get("name").and_then(|n| n.as_str()).map(|s| s.to_string());
                Some((id, label, Some(m.clone())))
            }).collect())
        })
        .await
        .map_err(|e| format!("join: {e}"))??;

    // 静态 catalog lookup
    let catalog = model_catalog::get_catalog_for(&provider_type);

    // merge: openai-compatible parse 优先, 然后 catalog fallback
    let result: Vec<ModelInfoDto> = raw_models
        .into_iter()
        .map(|(id, label, raw)| {
            // 1) openai-compatible 启发式 parse
            let parsed = raw.as_ref().and_then(|v| parse_openai_compatible_meta(v));
            // 2) catalog fallback
            let from_catalog = catalog.get(&id);
            // 决定每个字段: 优先 parsed, 然后 catalog
            let pick = |parsed_v: Option<u32>, catalog_v: Option<u32>| -> Option<u32> {
                parsed_v.or(catalog_v)
            };
            let pick_bool = |parsed_v: Option<bool>, catalog_v: Option<bool>| -> Option<bool> {
                parsed_v.or(catalog_v)
            };
            let pick_str = |parsed_v: Option<String>, catalog_v: Option<String>| -> Option<String> {
                parsed_v.or(catalog_v)
            };
            let (cw, mo, vi, rs, mt) = match parsed.as_ref() {
                Some(p) => (
                    pick(p.context_window, from_catalog.and_then(|c| c.context_window)),
                    pick(p.max_output, from_catalog.and_then(|c| c.max_output)),
                    pick_bool(p.vision, from_catalog.and_then(|c| c.vision)),
                    pick_bool(p.reasoning, from_catalog.and_then(|c| c.reasoning)),
                    pick_str(p.model_type.clone(), from_catalog.and_then(|c| c.model_type.clone())),
                ),
                None => (
                    from_catalog.and_then(|c| c.context_window),
                    from_catalog.and_then(|c| c.max_output),
                    from_catalog.and_then(|c| c.vision),
                    from_catalog.and_then(|c| c.reasoning),
                    from_catalog.and_then(|c| c.model_type.clone()),
                ),
            };
            let auto_source = if parsed.is_some() {
                Some("openai-compatible".to_string())
            } else if from_catalog.is_some() {
                Some("catalog".to_string())
            } else {
                None
            };
            ModelInfoDto {
                id,
                label,
                context_window: cw,
                max_output: mo,
                vision: vi,
                reasoning: rs,
                model_type: mt,
                auto_source,
            }
        })
        .collect();
    Ok(result)
}

/// v0.5.0-D D213: best-effort parse openai-compatible 响应里的 metadata.
/// 不是所有 provider 都有, 解析失败 (字段缺失/类型错) 就返 None (FE 走 catalog fallback).
///
/// 已知字段约定 (各自 vendor 不一样, 这里尽量覆盖主流):
///   - context_length: u32 (OpenRouter / Together)
///   - max_completion_tokens / max_tokens: u32 (OpenRouter top_provider)
///   - modality / input_modalities: ["text", "image"] → vision
///   - input_modalities 包含 "image" → vision=true
///
/// 不动 catalog. openai-compatible parse 走 best-effort, 解析失败一律 None.
fn parse_openai_compatible_meta(m: &serde_json::Value) -> Option<model_catalog::ModelMetadata> {
    let context_window = m.get("context_length")
        .and_then(|v| v.as_u64())
        .map(|n| n as u32)
        .or_else(|| {
            m.get("max_context_length")
                .and_then(|v| v.as_u64())
                .map(|n| n as u32)
        });
    let max_output = m.get("max_completion_tokens")
        .and_then(|v| v.as_u64())
        .map(|n| n as u32)
        .or_else(|| {
            m.get("max_tokens")
                .and_then(|v| v.as_u64())
                .map(|n| n as u32)
        })
        .or_else(|| {
            // OpenRouter style: top_provider.max_completion_tokens
            m.get("top_provider")
                .and_then(|tp| tp.get("max_completion_tokens"))
                .and_then(|v| v.as_u64())
                .map(|n| n as u32)
        });
    // vision: input_modalities / modality
    let vision = m.get("input_modalities")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().any(|x| x.as_str() == Some("image")))
        .or_else(|| {
            m.get("modality")
                .and_then(|v| v.as_str())
                .map(|s| s.to_lowercase().contains("vision") || s.contains("image"))
        });
    // model_type: 看名字启发式 (image gen / embedding)
    let model_type: Option<String> = None;  // 暂不启发式, 都归 chat
    if context_window.is_none() && max_output.is_none() && vision.is_none() {
        return None;  // 一个字段都没 parse 到, 返 None 走 catalog fallback
    }
    Some(model_catalog::ModelMetadata {
        context_window,
        max_output,
        vision,
        reasoning: None,  // openai-compatible 响应里通常没 reasoning 字段
        model_type,
    })
}

/// v0.5.0-D D213: FE 主动拉 catalog (例如内置 provider 配完后想查所有已知 model).
#[tauri::command]
async fn get_model_catalog(provider_type: String) -> Result<HashMap<String, model_catalog::ModelMetadata>, String> {
    Ok(model_catalog::get_catalog_for(&provider_type))
}

/// P0 #1 fix: "测试连接" 按钮. 区分 provider 类型:
/// - openai-compatible: 真实 HTTP 调 <baseUrl>/models, 验 key + baseUrl + 返回 model 数
/// - 内置 provider (anthropic/openai/etc): 只验 keychain 里有 key (非空). 实际 LLM 调通性
///   由首次对话验证 (内置 provider 走 Pi SDK 内置端点, Tauri 这层不知道 URL, 不假装测).
///
/// `api_key` 可选: 传了就直接用 (避免 AddProviderForm 测连接时建临时 provider 污染 store);
/// 不传就从 keychain 拿 providerId 对应的 key.
#[tauri::command]
async fn verify_provider_connection(
    provider_id: String,
    provider_type: String,
    base_url: String,
    api_key: Option<String>,
) -> Result<VerifyConnectionResult, String> {
    let api_key = match api_key {
        Some(k) if !k.trim().is_empty() => k,
        _ => match keyring::get(&provider_id)? {
            Some(k) => k,
            None => {
                return Ok(VerifyConnectionResult {
                    ok: false,
                    message: "未找到 keychain 里的 API key, 请先保存".to_string(),
                    model_count: None,
                    latency_ms: None,
                    detail: Some(format!("keyring::get({provider_id}) returned None")),
                });
            }
        },
    };

    if api_key.trim().is_empty() {
        return Ok(VerifyConnectionResult {
            ok: false,
            message: "API key 为空, 请重新填".to_string(),
            model_count: None,
            latency_ms: None,
            detail: None,
        });
    }

    if provider_type == "openai-compatible" {
        if base_url.trim().is_empty() {
            return Ok(VerifyConnectionResult {
                ok: false,
                message: "openai-compatible 必须填 baseUrl".to_string(),
                model_count: None,
                latency_ms: None,
                detail: None,
            });
        }
        let clean_base = base_url.trim_end_matches('/');
        let url = format!("{clean_base}/models");
        let url_clone = url.clone();
        let api_key_clone = api_key.clone();
        // 用 spawn_blocking 包 ureq 同步 HTTP, 跟 fetch_provider_models 一致
        let res = tokio::task::spawn_blocking(move || -> Result<(u32, u32, String), String> {
            let start = std::time::Instant::now();
            let resp = ureq::get(&url_clone)
                .set("Authorization", &format!("Bearer {api_key_clone}"))
                .timeout(std::time::Duration::from_secs(15))
                .call();
            let latency = start.elapsed().as_millis() as u32;
            match resp {
                Ok(r) => {
                    let status = r.status() as u32;
                    let body_text = r.into_string().unwrap_or_default();
                    Ok((status, latency, body_text))
                }
                Err(ureq::Error::Status(status, response)) => {
                    let body = response.into_string().unwrap_or_default();
                    Err(format!("HTTP {status}: {body}"))
                }
                Err(e) => Err(format!("network error: {e}")),
            }
        })
        .await
        .map_err(|e| format!("join: {e}"))?;

        match res {
            Ok((status, latency, body)) => {
                if !(200..300).contains(&status) {
                    return Ok(VerifyConnectionResult {
                        ok: false,
                        message: format!("HTTP {status} (key 错或 baseUrl 错?)"),
                        model_count: None,
                        latency_ms: Some(latency),
                        detail: Some(body.chars().take(500).collect()),
                    });
                }
                // 尝试解析 .data 数组拿 model 数
                let model_count = serde_json::from_str::<serde_json::Value>(&body)
                    .ok()
                    .and_then(|v| v.get("data").and_then(|d| d.as_array()).map(|a| a.len() as u32));
                let msg = if let Some(n) = model_count {
                    if n > 0 {
                        format!("✓ 通了, 拿到 {n} 个 model (HTTP {status}, {latency}ms)")
                    } else {
                        format!("✓ 连通 (HTTP {status}, {latency}ms), 但返回 0 个 model")
                    }
                } else {
                    format!("✓ 连通 (HTTP {status}, {latency}ms), 但响应格式不像 OpenAI /models")
                };
                Ok(VerifyConnectionResult {
                    ok: true,
                    message: msg,
                    model_count,
                    latency_ms: Some(latency),
                    detail: None,
                })
            }
            Err(e) => Ok(VerifyConnectionResult {
                ok: false,
                message: format!("✗ 连不上: {e}"),
                model_count: None,
                latency_ms: None,
                detail: Some(e),
            }),
        }
    } else {
        // 内置 provider: 走 Pi SDK 内置端点, Tauri 这层没法独立测, 只验 keychain 存在
        Ok(VerifyConnectionResult {
            ok: true,
            message: format!("✓ Key 已存 ({} 字符), 实际连通性会在首次对话时验证", api_key.len()),
            model_count: None,
            latency_ms: None,
            detail: Some("built-in provider: Pi SDK 内置端点, 不在 Tauri 这层做 HTTP 测试".to_string()),
        })
    }
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

/// v0.6.3-rc1 P2-1.4: 返回默认 agent dir (全局 MCP 配置目录).
///   - Windows: C:\Users\<user>\.pi\agent
///   - macOS/Linux: <user.home>/.pi/agent
///   跟 ensure_default_workspace 同一个 home_dir 解析, 路径规范化.
///   FE 用这个显示 "global scope 会写到哪" (透明性), 也可以传给 MCP command 当 agentDir.
#[tauri::command]
async fn get_agent_dir(app: AppHandle) -> Result<String, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|e| format!("home_dir: {e}"))?;
    let agent_dir = home.join(".pi").join("agent");
    Ok(agent_dir.to_string_lossy().to_string())
}

/// v0.6 (Bug2 修): 读写 Pi SDK 0.84.2 settings.json 里的 compaction.enabled
///   文件路径: <agentDir>/settings.json (跟 Pi SDK 0.84.2 FileSettingsStorage 一致)
///   不走 sidecar RPC (依赖 active sidecar, 闲置 session 调不通 — 跟 compact 一样的坑)
///   限制: Pi SDK 启动时加载 settings, 不热更新. 改了要等下次 session 重启才生效.
fn pi_settings_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|e| format!("home_dir: {e}"))?;
    Ok(home.join(".pi").join("agent").join("settings.json"))
}

#[tauri::command]
async fn get_compaction_enabled(app: AppHandle) -> Result<bool, String> {
    let path = pi_settings_path(&app)?;
    if !path.exists() {
        // Pi SDK 0.84.2 DEFAULT_COMPACTION_SETTINGS.enabled = true
        return Ok(true);
    }
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("read settings.json: {e}"))?;
    let value: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("parse settings.json: {e}"))?;
    Ok(value
        .get("compaction")
        .and_then(|c| c.get("enabled"))
        .and_then(|e| e.as_bool())
        .unwrap_or(true))
}

#[tauri::command]
async fn set_compaction_enabled(app: AppHandle, enabled: bool) -> Result<(), String> {
    let path = pi_settings_path(&app)?;
    // 1. 确保 agent_dir 存在
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("create_dir_all({}): {e}", parent.display()))?;
    }
    // 2. 读现有 settings (可能不存在)
    let mut value: serde_json::Value = if path.exists() {
        let content = std::fs::read_to_string(&path)
            .map_err(|e| format!("read settings.json: {e}"))?;
        serde_json::from_str(&content).unwrap_or_else(|_| serde_json::json!({}))
    } else {
        serde_json::json!({})
    };
    // 3. 设置 compaction.enabled (保留其他字段)
    if !value.is_object() {
        value = serde_json::json!({});
    }
    let obj = value.as_object_mut().unwrap();
    let comp = obj
        .entry("compaction".to_string())
        .or_insert_with(|| serde_json::json!({}));
    if !comp.is_object() {
        *comp = serde_json::json!({});
    }
    comp["enabled"] = serde_json::Value::Bool(enabled);
    // 4. 写回 (用 pretty 格式, 跟 Pi SDK 自己写的一致)
    let pretty = serde_json::to_string_pretty(&value)
        .map_err(|e| format!("serialize settings: {e}"))?;
    std::fs::write(&path, pretty)
        .map_err(|e| format!("write settings.json: {e}"))?;
    debug_log(&format!(
        "set_compaction_enabled: enabled={} written to {}",
        enabled,
        path.display()
    ));
    Ok(())
}

// ====== ADR-0019 P0-1 (2026-08-23): Bash 路径配置 + 自动检测 ======
//   根因: Pi SDK 0.84.2 shell.ts:67-107 只搜 %ProgramFiles%\Git\bin\bash.exe + %ProgramFiles(x86)%\Git\bin\bash.exe + where.exe
//         miss 场景: Git for Windows 用户级安装 (e.g. C:\Users\你\AppData\Local\Programs\Git\bin\bash.exe) 跟非常规路径安装
//                    (e.g. D:\DevTools\Git\bin\bash.exe, user 真实情况)
//   修法: 5 个 Tauri command, 把 bash 路径写进 ~/.pi/agent/settings.json 的 bash 字段
//         - get_bash_config: 读
//         - set_bash_config: 写 (校验 + 跑 --version 拿 version)
//         - detect_bash_candidates: 自动检测 (PATH + 注册表 + 常见位置 + WSL)
//         - verify_bash_path: 单次测试, 给"测试"按钮用
//         - clear_bash_config: 删字段, 下次启动 fallback Pi SDK 自带 search
//   Sidecar 那边 sidecar/src/index.mjs:782 启动时读 settings.bash.path, 传给 createBashToolDefinition 的 shellPath 选项
//   Source of truth 是 settings.bash.path 字段, auto + manual 都是合法写入路径 (source 字段区分)

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BashConfig {
    path: String,
    /// 'auto' = 自动检测写入, 'manual' = 用户手填写入, 排查用, 不影响行为
    source: String,
    /// Unix epoch ms, 上次跑 bash --version 成功时间
    last_verified: Option<u64>,
    /// bash --version 输出第一行解析的版本字符串 (e.g. "5.2.21")
    version: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ShellInfo {
    /// 'bash' | 'wsl' | 'pwsh' | 'powershell'
    shell_type: String,
    path: String,
    /// 'PATH' | 'registry' | 'common' | 'wsl', 排查用
    source: String,
    version: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetBashConfigArgs {
    path: String,
    /// 'auto' | 'manual'
    source: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct VerifyBashResult {
    ok: bool,
    version: Option<String>,
    error: Option<String>,
}

/// 读 settings.json 的 bash 字段 (跟 get_compaction_enabled 走同一文件, 同 pattern)
fn read_bash_config_from_settings(value: &serde_json::Value) -> Option<BashConfig> {
    let bash = value.get("bash")?.as_object()?;
    let path = bash.get("path")?.as_str()?.to_string();
    let source = bash
        .get("source")
        .and_then(|s| s.as_str())
        .unwrap_or("manual")
        .to_string();
    let last_verified = bash.get("lastVerified").and_then(|v| v.as_u64());
    let version = bash
        .get("version")
        .and_then(|s| s.as_str())
        .map(|s| s.to_string());
    Some(BashConfig {
        path,
        source,
        last_verified,
        version,
    })
}

#[tauri::command]
async fn get_bash_config(app: AppHandle) -> Result<Option<BashConfig>, String> {
    let path = pi_settings_path(&app)?;
    if !path.exists() {
        return Ok(None);
    }
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("read settings.json: {e}"))?;
    let value: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("parse settings.json: {e}"))?;
    Ok(read_bash_config_from_settings(&value))
}

/// 跑 <path> --version, 拿第一行作为 version, 5s timeout.
/// 同步阻塞 IO, 包在 spawn_blocking 里不阻塞 tokio runtime.
fn run_bash_version_sync(path: &str) -> Result<String, String> {
    use std::process::Command;
    let output = Command::new(path)
        .arg("--version")
        .output()
        .map_err(|e| format!("spawn `{path} --version`: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "`{path} --version` exit code {:?}, stderr: {}",
            output.status.code(),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    // 拿第一行 (GNU bash 输出 "GNU bash, version 5.2.21(1)-release ...")
    let first_line = stdout.lines().next().unwrap_or("").trim();
    if first_line.is_empty() {
        return Err(format!(
            "`{path} --version` returned empty stdout"
        ));
    }
    Ok(first_line.to_string())
}

#[tauri::command]
async fn set_bash_config(
    app: AppHandle,
    args: SetBashConfigArgs,
) -> Result<BashConfig, String> {
    let path = pi_settings_path(&app)?;

    // 1. 校验 path 存在 + 是 file
    let p = std::path::Path::new(&args.path);
    if !p.exists() {
        return Err(format!("bash path 不存在: {}", args.path));
    }
    if !p.is_file() {
        return Err(format!("bash path 不是 file: {}", args.path));
    }

    // 2. 跑 --version 拿 version
    let path_clone = args.path.clone();
    let version_line = tokio::task::spawn_blocking(move || run_bash_version_sync(&path_clone))
        .await
        .map_err(|e| format!("spawn_blocking: {e}"))??;

    // 3. 解析 version (e.g. "GNU bash, version 5.2.21(1)-release ..." → "5.2.21")
    //    简单策略: 抓第一个 \d+\.\d+\.\d+
    let version = regex_extract_version(&version_line);

    // 4. 写 settings.json
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("create_dir_all({}): {e}", parent.display()))?;
    }
    let mut value: serde_json::Value = if path.exists() {
        let content = std::fs::read_to_string(&path)
            .map_err(|e| format!("read settings.json: {e}"))?;
        serde_json::from_str(&content).unwrap_or_else(|_| serde_json::json!({}))
    } else {
        serde_json::json!({})
    };
    if !value.is_object() {
        value = serde_json::json!({});
    }
    let obj = value.as_object_mut().unwrap();
    let now_ms = now_epoch_ms();
    let bash_obj = serde_json::json!({
        "path": args.path,
        "source": args.source,
        "lastVerified": now_ms,
        "version": version,
    });
    obj.insert("bash".to_string(), bash_obj);

    let pretty = serde_json::to_string_pretty(&value)
        .map_err(|e| format!("serialize settings: {e}"))?;
    std::fs::write(&path, pretty)
        .map_err(|e| format!("write settings.json: {e}"))?;

    debug_log(&format!(
        "set_bash_config: path={} source={} version={}",
        args.path, args.source, version.as_deref().unwrap_or("(unknown)")
    ));

    Ok(BashConfig {
        path: args.path,
        source: args.source,
        last_verified: Some(now_ms),
        version,
    })
}

/// 简单版本号提取: 抓第一个 \d+\.\d+(\.\d+)?  跟当前真实情况够用.
/// e.g. "GNU bash, version 5.2.21(1)-release (x86_64-pc-msys)" → "5.2.21"
fn regex_extract_version(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_digit() {
            // 收集数字序列
            let start = i;
            while i < bytes.len() && bytes[i].is_ascii_digit() {
                i += 1;
            }
            // 期待 .digit
            if i < bytes.len() && bytes[i] == b'.' && i + 1 < bytes.len() && bytes[i + 1].is_ascii_digit() {
                i += 1; // 跳过 .
                while i < bytes.len() && bytes[i].is_ascii_digit() {
                    i += 1;
                }
                // 可选第 3 段
                if i < bytes.len() && bytes[i] == b'.' && i + 1 < bytes.len() && bytes[i + 1].is_ascii_digit() {
                    i += 1;
                    while i < bytes.len() && bytes[i].is_ascii_digit() {
                        i += 1;
                    }
                }
                return Some(s[start..i].to_string());
            }
        }
        i += 1;
    }
    None
}

/// 生成当前时间戳 (Unix epoch milliseconds), 存 settings.json 供排查.
fn now_epoch_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[tauri::command]
async fn verify_bash_path(path: String) -> Result<VerifyBashResult, String> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Ok(VerifyBashResult {
            ok: false,
            version: None,
            error: Some(format!("路径不存在: {}", path)),
        });
    }
    let path_clone = path.clone();
    let result = tokio::task::spawn_blocking(move || run_bash_version_sync(&path_clone))
        .await
        .map_err(|e| format!("spawn_blocking: {e}"));
    match result {
        Ok(Ok(version_line)) => Ok(VerifyBashResult {
            ok: true,
            version: regex_extract_version(&version_line),
            error: None,
        }),
        Ok(Err(e)) => Ok(VerifyBashResult {
            ok: false,
            version: None,
            error: Some(e),
        }),
        Err(e) => Ok(VerifyBashResult {
            ok: false,
            version: None,
            error: Some(e),
        }),
    }
}

#[tauri::command]
async fn clear_bash_config(app: AppHandle) -> Result<(), String> {
    let path = pi_settings_path(&app)?;
    if !path.exists() {
        return Ok(());
    }
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("read settings.json: {e}"))?;
    let mut value: serde_json::Value =
        serde_json::from_str(&content).unwrap_or_else(|_| serde_json::json!({}));
    if let Some(obj) = value.as_object_mut() {
        obj.remove("bash");
    }
    let pretty = serde_json::to_string_pretty(&value)
        .map_err(|e| format!("serialize settings: {e}"))?;
    std::fs::write(&path, pretty)
        .map_err(|e| format!("write settings.json: {e}"))?;
    debug_log("clear_bash_config: removed bash field from settings.json");
    Ok(())
}

/// 在 PATH 各目录里找可执行文件, 找到返回绝对路径, 否则 None.
/// Windows 上 PATH 分隔符是 ';' (走 std::env::var 拿到的就是 ; 分隔, 跟 Unix 同 delimiter 字段).
fn search_path_for(basename: &str) -> Option<String> {
    let path_var = std::env::var_os("PATH")?;
    let path_str = path_var.to_string_lossy();
    for dir in std::env::split_paths(&path_var) {
        let candidate = dir.join(basename);
        if candidate.is_file() {
            return Some(candidate.to_string_lossy().to_string());
        }
    }
    let _ = path_str; // suppress unused warning if any
    None
}

/// 读 Windows 注册表, 找 Git for Windows 安装路径.
/// 优先 HKLM (机器级), 失败 fallback HKCU (用户级).
/// 用 winreg = "0.2" crate, 但本项目没引 winreg, 走 reg.exe 子进程 fallback.
#[cfg(windows)]
fn read_git_for_windows_install_path() -> Option<String> {
    use std::process::Command;
    // 优先 HKLM
    for hkey in &["HKLM\\SOFTWARE\\GitForWindows", "HKCU\\SOFTWARE\\GitForWindows"] {
        let output = Command::new("reg")
            .args(["query", hkey, "/v", "InstallPath"])
            .output()
            .ok()?;
        if !output.status.success() {
            continue;
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        // 解析 "    InstallPath    REG_SZ    C:\Program Files\Git"
        for line in stdout.lines() {
            if line.contains("InstallPath") {
                // 最后一个 REG_SZ 后的就是值
                if let Some(value) = line.split("REG_SZ").nth(1) {
                    let trimmed = value.trim();
                    if !trimmed.is_empty() {
                        // 拼 bin\bash.exe
                        let bash = std::path::Path::new(trimmed).join("bin").join("bash.exe");
                        if bash.is_file() {
                            return Some(bash.to_string_lossy().to_string());
                        }
                    }
                }
            }
        }
    }
    None
}

#[cfg(not(windows))]
fn read_git_for_windows_install_path() -> Option<String> {
    None
}

#[tauri::command]
async fn detect_bash_candidates() -> Result<Vec<ShellInfo>, String> {
    let mut candidates: Vec<ShellInfo> = Vec::new();

    // 1. PATH 搜索 (各 shell 命令的常见 basename)
    for (basename, stype) in &[
        ("bash.exe", "bash"),
        ("wsl.exe", "wsl"),
        ("pwsh.exe", "pwsh"),
        ("powershell.exe", "powershell"),
    ] {
        if let Some(p) = search_path_for(basename) {
            // 跑 --version 拿 version (best-effort, 失败也不影响列候选)
            let version = tokio::task::spawn_blocking({
                let p = p.clone();
                move || -> Option<String> {
                    use std::process::Command;
                    let out = Command::new(&p).arg("--version").output().ok()?;
                    if !out.status.success() {
                        return None;
                    }
                    let first = String::from_utf8_lossy(&out.stdout).lines().next()?.trim().to_string();
                    regex_extract_version(&first)
                }
            })
            .await
            .ok()
            .flatten();
            candidates.push(ShellInfo {
                shell_type: stype.to_string(),
                path: p,
                source: "PATH".to_string(),
                version,
            });
        }
    }

    // 2. Git for Windows 注册表
    if let Some(p) = read_git_for_windows_install_path() {
        let version = tokio::task::spawn_blocking({
            let p = p.clone();
            move || -> Option<String> {
                use std::process::Command;
                let out = Command::new(&p).arg("--version").output().ok()?;
                if !out.status.success() {
                    return None;
                }
                let first = String::from_utf8_lossy(&out.stdout).lines().next()?.trim().to_string();
                regex_extract_version(&first)
            }
        })
        .await
        .ok()
        .flatten();
        candidates.push(ShellInfo {
            shell_type: "bash".to_string(),
            path: p,
            source: "registry".to_string(),
            version,
        });
    }

    // 3. 常见位置扫描 (stat, 不存在静默跳过)
    let common_paths: &[&str] = &[
        r"C:\Program Files\Git\bin\bash.exe",
        r"C:\Program Files (x86)\Git\bin\bash.exe",
        // 用户级安装 (Git for Windows 较新版本默认)
        // 没法硬编码 username, 让 PATH / 注册表覆盖, 但 %LOCALAPPDATA% 跟 %ProgramFiles% 也用 env var
    ];
    for cp in common_paths {
        if std::path::Path::new(cp).is_file() {
            // 避免跟已有的 path 重复
            if !candidates.iter().any(|c| c.path == *cp) {
                candidates.push(ShellInfo {
                    shell_type: "bash".to_string(),
                    path: cp.to_string(),
                    source: "common".to_string(),
                    version: None,
                });
            }
        }
    }
    // 用户级 Git for Windows 走 env var 展开 (不硬编码 username)
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        let user_git = std::path::Path::new(&local_app_data)
            .join("Programs")
            .join("Git")
            .join("bin")
            .join("bash.exe");
        if user_git.is_file() {
            let p = user_git.to_string_lossy().to_string();
            if !candidates.iter().any(|c| c.path == p) {
                candidates.push(ShellInfo {
                    shell_type: "bash".to_string(),
                    path: p,
                    source: "common".to_string(),
                    version: None,
                });
            }
        }
    }

    // 4. WSL 探测 (仅 Windows, 走 wsl -l -q)
    #[cfg(windows)]
    {
        use std::process::Command;
        if let Ok(out) = Command::new("wsl").args(["-l", "-q"]).output() {
            if out.status.success() {
                let stdout = String::from_utf8_lossy(&out.stdout);
                for line in stdout.lines() {
                    let distro = line.trim().trim_start_matches('\u{0}').trim();
                    if distro.is_empty() || distro.contains("Windows Subsystem") {
                        continue;
                    }
                    let bash_path = format!(r"\\wsl$\{}\bin\bash", distro);
                    // 没法直接 stat UNC 路径, 先记下来
                    if !candidates.iter().any(|c| c.path == bash_path) {
                        candidates.push(ShellInfo {
                            shell_type: "wsl".to_string(),
                            path: bash_path,
                            source: "wsl".to_string(),
                            version: None,
                        });
                    }
                }
            }
        }
    }

    // 排序: bash > wsl > pwsh > powershell
    candidates.sort_by(|a, b| {
        let order = |t: &str| match t {
            "bash" => 0,
            "wsl" => 1,
            "pwsh" => 2,
            "powershell" => 3,
            _ => 99,
        };
        order(&a.shell_type).cmp(&order(&b.shell_type))
    });

    debug_log(&format!(
        "detect_bash_candidates: found {} candidate(s)",
        candidates.len()
    ));
    Ok(candidates)
}

// ====== ADR-0019 P0-2 (2026-08-23): 危险命令白名单 ======
//   存储: ~/.pi/agent/settings.json 的 dangerousWhitelist 字段
//   格式: [{ pattern: string, note: string, addedAt: ISO 8601 }, ...]
//   sidecar 启动时读, BUILTIN_DENY_LIST 匹配 + 不在 whitelist → block bash tool call.
//   设计原则:
//   - 跟 P0-1 bash 字段同 pattern (单一文件多字段, 走 pi_settings_path)
//   - pattern 必须是合法 RegExp (FE 端也校验一次, Rust 端二次防御)
//   - 排序按 addedAt asc (后加的在后面), UI 列表稳定
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WhitelistItem {
    /// JavaScript 风格正则 (Rust 编译成 RegExp 之前会被 RejectSyntax 自检)
    pattern: String,
    /// 用户加这条时的备注 (UI 显示, 不参与匹配)
    #[serde(default)]
    note: String,
    /// ISO 8601 时间戳
    #[serde(default)]
    added_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddWhitelistArgs {
    pattern: String,
    #[serde(default)]
    note: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoveWhitelistArgs {
    /// 跟 add 时一样, 用 pattern 唯一定位 (允许同 pattern 不同 note 共存, 删第一个匹配)
    pattern: String,
}

/// 读 settings.json 的 dangerousWhitelist 数组 (跟 read_bash_config_from_settings 同 pattern)
fn read_dangerous_whitelist_from_settings(value: &serde_json::Value) -> Vec<WhitelistItem> {
    let Some(arr) = value.get("dangerousWhitelist").and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for item in arr {
        let Some(obj) = item.as_object() else { continue };
        let Some(pattern) = obj.get("pattern").and_then(|p| p.as_str()) else { continue };
        if pattern.is_empty() { continue }
        out.push(WhitelistItem {
            pattern: pattern.to_string(),
            note: obj.get("note").and_then(|n| n.as_str()).unwrap_or("").to_string(),
            added_at: obj.get("addedAt").and_then(|a| a.as_str()).unwrap_or("").to_string(),
        });
    }
    out
}

/// 校验 whitelist pattern 合法性. 返回 Err 给 FE 端弹 toast.
fn validate_whitelist_pattern(pattern: &str) -> Result<(), String> {
    if pattern.is_empty() {
        return Err("pattern 不能为空".to_string());
    }
    if pattern.len() > 256 {
        return Err(format!("pattern 长度 {} 超过 256 字符", pattern.len()));
    }
    // 跟 JS 一样拒绝 /regex/ literal flags, 只走纯 pattern + 'i' flag (sidecar 编译时也是 'i')
    if pattern.starts_with('/') {
        return Err("pattern 不能以 '/' 开头 (我们只接受 pattern 字符串, 不接受 /regex/flags literal)".to_string());
    }
    Ok(())
}

#[tauri::command]
async fn get_dangerous_whitelist(app: AppHandle) -> Result<Vec<WhitelistItem>, String> {
    let path = pi_settings_path(&app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("read settings.json: {e}"))?;
    let value: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("parse settings.json: {e}"))?;
    Ok(read_dangerous_whitelist_from_settings(&value))
}

#[tauri::command]
async fn add_dangerous_whitelist_item(
    app: AppHandle,
    args: AddWhitelistArgs,
) -> Result<Vec<WhitelistItem>, String> {
    validate_whitelist_pattern(&args.pattern)?;
    if args.note.len() > 200 {
        return Err(format!("note 长度 {} 超过 200 字符", args.note.len()));
    }
    let path = pi_settings_path(&app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("create_dir_all({}): {e}", parent.display()))?;
    }
    let mut value: serde_json::Value = if path.exists() {
        let content = std::fs::read_to_string(&path)
            .map_err(|e| format!("read settings.json: {e}"))?;
        serde_json::from_str(&content).unwrap_or_else(|_| serde_json::json!({}))
    } else {
        serde_json::json!({})
    };
    if !value.is_object() {
        value = serde_json::json!({});
    }
    let obj = value.as_object_mut().unwrap();

    // 拿到现有 list (允许同 pattern 多条, user 可能不同 note)
    let list = obj.entry("dangerousWhitelist".to_string())
        .or_insert_with(|| serde_json::json!([]));
    if !list.is_array() {
        *list = serde_json::json!([]);
    }
    let arr = list.as_array_mut().unwrap();
    arr.push(serde_json::json!({
        "pattern": args.pattern,
        "note": args.note,
        "addedAt": now_epoch_ms_iso(),
    }));

    let pretty = serde_json::to_string_pretty(&value)
        .map_err(|e| format!("serialize settings: {e}"))?;
    std::fs::write(&path, pretty)
        .map_err(|e| format!("write settings.json: {e}"))?;

    debug_log(&format!(
        "add_dangerous_whitelist_item: pattern={} note={}",
        args.pattern, args.note
    ));
    Ok(read_dangerous_whitelist_from_settings(&value))
}

#[tauri::command]
async fn remove_dangerous_whitelist_item(
    app: AppHandle,
    args: RemoveWhitelistArgs,
) -> Result<Vec<WhitelistItem>, String> {
    let path = pi_settings_path(&app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("read settings.json: {e}"))?;
    let mut value: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("parse settings.json: {e}"))?;
    let Some(list) = value.get_mut("dangerousWhitelist").and_then(|v| v.as_array_mut()) else {
        return Ok(Vec::new());
    };
    // 删第一个 pattern 匹配的 (允许同 pattern 多条, 删最旧)
    let before_len = list.len();
    list.retain(|item| {
        let p = item.get("pattern").and_then(|v| v.as_str()).unwrap_or("");
        p != args.pattern
    });
    let removed = before_len - list.len();
    if removed == 0 {
        return Err(format!("没找到 pattern={} 的白名单条目", args.pattern));
    }
    let pretty = serde_json::to_string_pretty(&value)
        .map_err(|e| format!("serialize settings: {e}"))?;
    std::fs::write(&path, pretty)
        .map_err(|e| format!("write settings.json: {e}"))?;

    debug_log(&format!(
        "remove_dangerous_whitelist_item: pattern={} removed={}",
        args.pattern, removed
    ));
    Ok(read_dangerous_whitelist_from_settings(&value))
}

/// now_epoch_ms_iso — 跟 set_bash_config 用的一致, 这里复用 (放同模块)
fn now_epoch_ms_iso() -> String {
    // 直接返回 epoch ms 数字字符串. ISO 8601 字符串需要 chrono, 简单用数字即可 (跟 bash.lastVerified 一致).
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

// ====== 2.1: 文件树浏览器 ======
//   读 workspace 目录树, 给 sidebar UI 用. 不走 sidecar (UI-only, 不需要 LLM 介入).
//   - 限制 max_depth (默认 2 层, 防 node_modules 把 UI 撑爆)
//   - 跳过常见大目录 (.git, node_modules, target, dist, .next, .venv, __pycache__)
//   - 不跟 symlink (防 sandbox 之外的"穿透"风险, 见 ADR-0013 已知风险)
//   - 错误用 Result 返回, 不 panic; UI 自己显示 "加载失败" / "无权限"

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceTreeNode {
    name: String,
    path: String,
    is_dir: bool,
    children: Option<Vec<WorkspaceTreeNode>>,
}

fn read_tree_recursive(path: &Path, current_depth: u32, max_depth: u32) -> Result<Vec<WorkspaceTreeNode>, String> {
    if current_depth >= max_depth {
        return Ok(vec![]);
    }
    let entries = std::fs::read_dir(path)
        .map_err(|e| format!("read_dir({}): {e}", path.display()))?;
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let entry_path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        // 跳常见大目录 (front-end 友好)
        if matches!(name.as_str(),
            ".git" | "node_modules" | "target" | "dist" | ".next" | ".venv" | "__pycache__"
            | ".DS_Store" | "Thumbs.db" | "build" | ".cache" | ".parcel-cache" | ".turbo"
        ) {
            continue;
        }
        // 不跟 symlink (用 symlink_metadata 而不是 metadata, 防 symlink 逃逸)
        let meta = match std::fs::symlink_metadata(&entry_path) {
            Ok(m) => m,
            Err(_) => continue,  // 跳过无权限的 entry
        };
        let is_dir = meta.is_dir();
        // 文件在最后一层不再展开; 目录递归
        let children = if is_dir {
            Some(read_tree_recursive(&entry_path, current_depth + 1, max_depth)?)
        } else {
            None
        };
        out.push(WorkspaceTreeNode {
            name,
            path: entry_path.to_string_lossy().to_string(),
            is_dir,
            children,
        });
    }
    // 排序: 目录在前, 字母序
    out.sort_by(|a, b| {
        b.is_dir.cmp(&a.is_dir)  // true > false → dir first
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

#[tauri::command]
async fn list_workspace_tree(path: String, max_depth: Option<u32>) -> Result<Vec<WorkspaceTreeNode>, String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("path not found: {path}"));
    }
    // 同步 read_dir 在 tokio task 跑, 防止大目录 block UI thread
    let depth = max_depth.unwrap_or(2).min(5);  // 硬上限 5 层
    tokio::task::spawn_blocking(move || {
        read_tree_recursive(&p, 0, depth)
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}

// ====== 2.2: workspace 模板 - 空目录创建 ======
//   走 std::fs::create_dir 一次性建好. name 校验防 path traversal.

#[tauri::command]
async fn create_empty_dir(parent: String, name: String) -> Result<String, String> {
    // name 校验: 1-128 字符, 不含路径分隔符 / ..  / NUL
    if name.is_empty() || name.len() > 128 {
        return Err("name 长度必须 1-128".to_string());
    }
    if name.contains('/') || name.contains('\\') || name.contains('\0') || name == "." || name == ".." {
        return Err("name 含非法字符 (路径分隔符 / NUL / . / ..)".to_string());
    }
    let parent_path = PathBuf::from(&parent);
    if !parent_path.is_dir() {
        return Err(format!("parent 不是目录: {parent}"));
    }
    let target = parent_path.join(&name);
    if target.exists() {
        return Err(format!("目标已存在: {}", target.display()));
    }
    tokio::task::spawn_blocking(move || {
        std::fs::create_dir(&target)
            .map_err(|e| format!("create_dir({}): {e}", target.display()))?;
        Ok(target.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}

// ====== 2.2: workspace 模板 - Git clone ======
//   走 std::process::Command 调系统 git. 不走 Tauri shell plugin (避免再加一个 capability).
//   假设用户装了 git (Windows: git for windows / macOS: xcode-select / Linux: apt).
//   错误带 stderr 给 UI 显示.

#[tauri::command]
async fn git_clone(url: String, parent: String) -> Result<String, String> {
    let parent_path = PathBuf::from(&parent);
    if !parent_path.is_dir() {
        return Err(format!("parent 不是目录: {parent}"));
    }
    // url 简单校验 (跟前端 dialog 重复一下, 防直 invoke 调用绕过)
    if !url.starts_with("https://") && !url.starts_with("http://") && !url.starts_with("git@") && !url.starts_with("ssh://") {
        return Err("URL 格式不对 (需要 http(s) / git@ / ssh://)".to_string());
    }
    let url_clone = url.clone();
    let parent_clone = parent_path.clone();
    let output = tokio::task::spawn_blocking(move || {
        std::process::Command::new("git")
            .arg("clone")
            .arg(&url_clone)
            .arg(&parent_clone)
            .output()
    })
    .await
    .map_err(|e| format!("join: {e}"))?
    .map_err(|e| format!("spawn git: {e} (确认系统装了 git 并在 PATH)"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(format!(
            "git clone 失败 (exit={:?}): {}{}",
            output.status.code(),
            stderr.trim(),
            if !stdout.trim().is_empty() { format!("\n{stdout}") } else { String::new() }
        ));
    }
    // 解析出 clone 出来的目录名 (URL 最后一段去掉 .git)
    // 例: https://github.com/user/repo.git -> repo
    //     https://github.com/user/repo -> repo
    //     git@github.com:user/repo.git -> repo
    let seg = url
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .or_else(|| url.rsplit(':').next())
        .unwrap_or("repo");
    let dir_name = seg.trim_end_matches(".git");
    let cloned_path = parent_path.join(dir_name);
    if !cloned_path.exists() {
        return Err(format!("clone 完找不到目录: {}", cloned_path.display()));
    }
    Ok(cloned_path.to_string_lossy().to_string())
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
            compact_session,  // Bug #2 修 (2026-08-18): 独立 compact invoke
            kill_sidecar,  // v0.4.6 修 (2026-08-18): abort 兜底时 force kill 旧 sidecar
            fetch_provider_models,
            verify_provider_connection,  // P0 #1: 测试连接按钮
            get_model_catalog,  // v0.5.0-D D213: 静态 catalog
            migrate_from_env,
            ensure_default_workspace,
            get_agent_dir,  // v0.6.3-rc1 P2-1.4: 全局 MCP 目录路径 (FE 显示用)
            // v0.6 (Bug2 修): 读写 Pi SDK settings.json 里的 compaction.enabled
            //   不走 sidecar RPC, 直接改 ~/.pi/agent/settings.json
            get_compaction_enabled,
            set_compaction_enabled,
            // ADR-0019 P0-1 (2026-08-23): bash 路径配置 + 自动检测
            //   写 ~/.pi/agent/settings.json 的 bash 字段
            //   Sidecar 启动时读, 传给 createBashToolDefinition 的 shellPath 选项
            get_bash_config,
            set_bash_config,
            verify_bash_path,
            clear_bash_config,
            detect_bash_candidates,
            // 2.1: 文件树浏览器 (UI-only, 不走 sidecar)
            list_workspace_tree,
            // 2.2: workspace 模板 (空目录 / git clone)
            create_empty_dir,
            git_clone,
            load_app_config,
            save_app_config,
            // v0.4.4 Skills: 写自定义 SKILL.md 到 workspace 或 global agentDir
            write_skill_file,
            delete_skill_file,
            reload_skills,
            // v0.4.4.3 Skill 导入: 读本地 .md 文件 + 解析 frontmatter
            read_skill_file,
            // v0.4.4.4 Skill 导入: 从 zip 压缩包导入 (支持多文件 skill pack)
            import_skill_zip,
            // v0.4.4.5 Skill 导入: 从 URL fetch raw .md (走 ureq sync HTTP)
            import_skill_url,
            // v0.4.4.6 Skill 列表: FE 主动拉, 写完/导入后立刻刷新 UI (跟 sidecar skills_snapshot 解耦)
            list_skills,
            // v0.4.6 Project rules / 自定义指令 (跟 Claude 桌面端 "自定义指令" 模式)
            read_custom_instructions,
            write_custom_instructions,
            delete_custom_instructions,
            // v0.5.0-v0.1: 删 v0.4.6.1 + v0.4.6.2 multi-agent persona invoke (7 个)
            //   list_agents / read_agent / write_agent / delete_agent / set_main_agent +
            //   read_session_active_agent / write_session_active_agent
            // v0.4.5.2: User 自定义快捷提示词模板 (Slash commands, 不含 builtin)
            list_commands,
            read_command,
            write_command,
            delete_command,
            // 2026-08-20 P1-5: User tools (从 builtin tool 派生的 args 预设模板)
            //   存储: <workspacePath>/.pi/tools/*.json + <agentDir>/tools/*.json
            //   两层 scope, workspace 优先 (list 时同名覆盖 global)
            //   sidecar 启动时 (Batch 2) 加载 + merge 到 Pi SDK tools list
            list_user_tools,
            read_user_tool,
            write_user_tool,
            delete_user_tool,
            // 2026-08-21 v0.6.3-rc1 P2-1: MCP server 配置 (Model Context Protocol)
            //   存储: <workspacePath>/.pi/mcp/*.json + <agentDir>/mcp/*.json
            //   sidecar 启动时 spawn 每个 server, 通过 @modelcontextprotocol/sdk 走 JSON-RPC,
            //   拉 tools/list 转 Pi SDK ToolDefinition (mcp_<server>_<tool> 前缀防重)
            list_mcp_servers,
            read_mcp_server,
            write_mcp_server,
            delete_mcp_server,
            // ADR-0019 P0-2 (2026-08-23): 危险命令白名单
            //   存储: ~/.pi/agent/settings.json 的 dangerousWhitelist 字段
            //   格式: [{ pattern: string, note: string, addedAt: ISO 8601 }, ...]
            //   sidecar 启动时读, BUILTIN_DENY_LIST 匹配 + 不在 whitelist → block bash tool call
            get_dangerous_whitelist,
            add_dangerous_whitelist_item,
            remove_dangerous_whitelist_item,
            // v0.5.0: 通用 RpcCommand 透传 (替代 v0.4.x 的 3 个特殊 stdin command)
            sidecar::send_rpc_command,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
