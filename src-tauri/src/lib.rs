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

use serde::Deserialize;
use crate::sidecar::kill_sidecar;  // v0.4.6: register tauri command (force kill sidecar on abort)
use tauri::{AppHandle, Manager};
use std::path::{Path, PathBuf};
use std::collections::HashMap;
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

    // 5. name 校验 (跟 write_skill_file 一致)
    if name.is_empty() || name.len() > 64 {
        return Err(format!("skill name 长度必须 1-64, got {} ({})", name.len(), name));
    }
    if !name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')) {
        return Err(format!("skill name 只能含 [a-zA-Z0-9._-], got '{}'", name));
    }
    if name == "." || name == ".." {
        return Err("skill name 不能是 '.' 或 '..'".to_string());
    }

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

    // 6. name 校验 (跟 write_skill_file 一致)
    if name.is_empty() || name.len() > 64 {
        return Err(format!("skill name 长度必须 1-64, got {} ({})", name.len(), name));
    }
    if !name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')) {
        return Err(format!("skill name 只能含 [a-zA-Z0-9._-], got '{}'", name));
    }
    if name == "." || name == ".." {
        return Err("skill name 不能是 '.' 或 '..'".to_string());
    }

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
    std::fs::read_to_string(&path)
        .map_err(|e| format!("read_to_string({}): {}", path.display(), e))
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
            // 2.1: 文件树浏览器 (UI-only, 不走 sidecar)
            list_workspace_tree,
            // 2.2: workspace 模板 (空目录 / git clone)
            create_empty_dir,
            git_clone,
            load_app_config,
            save_app_config,
            // v0.4.4 Skills: 写自定义 SKILL.md 到 workspace 或 global agentDir
            write_skill_file,
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
            // v0.5.0: 通用 RpcCommand 透传 (替代 v0.4.x 的 3 个特殊 stdin command)
            sidecar::send_rpc_command,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
