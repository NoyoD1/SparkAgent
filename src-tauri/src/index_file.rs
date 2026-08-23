/**
 * Keychain index file — keyring crate 没有 list API,
 * 我们用一个小 JSON 文件记录所有存过 key 的 provider_id.
 *
 * 位置: app_data_dir / keychain_index.json
 *   Windows: %APPDATA%\com.piagent.app\
 *   macOS:   ~/Library/Application Support/com.piagent.app/
 *   Linux:   ~/.local/share/com.piagent.app/
 *
 * 这个文件只存 provider_id (不存 apiKey 内容), 相当于一个 "keychain 簿记".
 * 实际 key 在 OS keychain 里.
 *
 * ADR-0023 P3-C (2026-08-24): 加 KEY_LLM / KEY_SECRET 两个独立 index 文件,
 *   跟 keyring service 命名空间对齐, 避免 list API 混 LLM apiKey 跟通用 secret.
 */
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

const INDEX_FILE_LLM: &str = "keychain_index.json"; // 跟 P3-C 之前一致, 兼容老用户
const INDEX_FILE_SECRET: &str = "keychain_secret_index.json"; // P3-C 引入, 跟 LLM 隔离

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct Index {
    pub provider_ids: Vec<String>,
}

/// 选择 index file: 跟 keyring service 配对
#[derive(Debug, Clone, Copy)]
pub enum Scope {
    Llm,
    Secret,
}

fn index_path(app: &tauri::AppHandle, scope: Scope) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("mkdir app_data: {e}"))?;
    let filename = match scope {
        Scope::Llm => INDEX_FILE_LLM,
        Scope::Secret => INDEX_FILE_SECRET,
    };
    Ok(dir.join(filename))
}

pub fn load(app: &tauri::AppHandle, scope: Scope) -> Index {
    match index_path(app, scope)
        .and_then(|p| fs::read_to_string(&p).map_err(|e| format!("read: {e}")))
        .and_then(|s| serde_json::from_str::<Index>(&s).map_err(|e| format!("parse: {e}")))
    {
        Ok(idx) => idx,
        Err(_) => Index::default(),
    }
}

pub fn save(app: &tauri::AppHandle, idx: &Index, scope: Scope) -> Result<(), String> {
    let path = index_path(app, scope)?;
    let json = serde_json::to_string_pretty(idx).map_err(|e| format!("ser: {e}"))?;
    fs::write(&path, json).map_err(|e| format!("write: {e}"))?;
    Ok(())
}

pub fn add(app: &tauri::AppHandle, provider_id: &str, scope: Scope) -> Result<(), String> {
    let mut idx = load(app, scope);
    if !idx.provider_ids.iter().any(|x| x == provider_id) {
        idx.provider_ids.push(provider_id.to_string());
        save(app, &idx, scope)?;
    }
    Ok(())
}

pub fn remove(app: &tauri::AppHandle, provider_id: &str, scope: Scope) -> Result<(), String> {
    let mut idx = load(app, scope);
    idx.provider_ids.retain(|x| x != provider_id);
    save(app, &idx, scope)
}

