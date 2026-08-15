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
 */
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

const INDEX_FILE: &str = "keychain_index.json";

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct Index {
    pub provider_ids: Vec<String>,
}

fn index_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("mkdir app_data: {e}"))?;
    Ok(dir.join(INDEX_FILE))
}

pub fn load(app: &tauri::AppHandle) -> Index {
    match index_path(app)
        .and_then(|p| fs::read_to_string(&p).map_err(|e| format!("read: {e}")))
        .and_then(|s| serde_json::from_str::<Index>(&s).map_err(|e| format!("parse: {e}")))
    {
        Ok(idx) => idx,
        Err(_) => Index::default(),
    }
}

pub fn save(app: &tauri::AppHandle, idx: &Index) -> Result<(), String> {
    let path = index_path(app)?;
    let json = serde_json::to_string_pretty(idx).map_err(|e| format!("ser: {e}"))?;
    fs::write(&path, json).map_err(|e| format!("write: {e}"))?;
    Ok(())
}

pub fn add(app: &tauri::AppHandle, provider_id: &str) -> Result<(), String> {
    let mut idx = load(app);
    if !idx.provider_ids.iter().any(|x| x == provider_id) {
        idx.provider_ids.push(provider_id.to_string());
        save(app, &idx)?;
    }
    Ok(())
}

pub fn remove(app: &tauri::AppHandle, provider_id: &str) -> Result<(), String> {
    let mut idx = load(app);
    idx.provider_ids.retain(|x| x != provider_id);
    save(app, &idx)
}
