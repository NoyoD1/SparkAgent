#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v3.37 patch (Part 3): 删 lib.rs migrate_from_env + MigrationEntry/Result.
Keychain 完全移除, 这些迁移命令不再需要.
"""
import os

lib_path = "src-tauri/src/lib.rs"
with open(lib_path, "r", encoding="utf-8") as f:
    lib = f.read()

# 1. 删 MigrationEntry + MigrationResult struct + comment
old_structs = '''// ====== Migration helper ======
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

'''
new_structs = '// v3.37 (2026-08-24): 删 MigrationEntry / MigrationResult struct (keychain 迁移命令已删)\n\n'
if old_structs not in lib:
    print("ERROR: old_structs not found")
    raise SystemExit(1)
lib = lib.replace(old_structs, new_structs)

# 2. 删 migrate_from_env fn
old_migrate = '''#[tauri::command]
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
                index_file::add(&app, &provider_id, index_file::Scope::Llm)?;
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

'''
new_migrate = '// v3.37 (2026-08-24): 删 migrate_from_env Tauri command (keychain 迁移, 跟 v3.37 一起删)\n\n'
if old_migrate not in lib:
    print("ERROR: old_migrate not found")
    raise SystemExit(1)
lib = lib.replace(old_migrate, new_migrate)

# 3. 删 generate_handler! 里 migrate_from_env 引用
old_handler_ref = '''            get_model_catalog,  // v0.5.0-D D213: 静态 catalog
            migrate_from_env,
            ensure_default_workspace,'''
new_handler_ref = '''            get_model_catalog,  // v0.5.0-D D213: 静态 catalog
            // v3.37 (2026-08-24): 删 migrate_from_env (keychain 迁移, 跟 v3.37 一起删)
            ensure_default_workspace,'''
if old_handler_ref not in lib:
    print("ERROR: old_handler_ref not found")
    raise SystemExit(1)
lib = lib.replace(old_handler_ref, new_handler_ref)

with open(lib_path, "w", encoding="utf-8") as f:
    f.write(lib)
print(f"updated {lib_path} - removed migrate_from_env + struct + handler ref")
