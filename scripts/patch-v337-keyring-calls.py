#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v3.37 patch (Part 4): 改 4 处 keyring::get → config_store::lookup_api_key."""
path = "src-tauri/src/lib.rs"
with open(path, "r", encoding="utf-8") as f:
    lib = f.read()

# 1. invoke_external_tool (line 2808-2818)
old1 = '''        // 从 keychain 拿 apiKey (跟 send_prompt 一致, 防止 provider 配了但 key 没存就 spawn 失败)
        let api_key = match keyring::get(&config.provider_id) {
            Ok(Some(k)) => k,
            Ok(None) => {
                return Err(format!(
                    "No API key for provider \\"{}\\" in OS keychain. Add it in Settings → Providers.",
                    config.provider_id
                ));
            }
            Err(e) => return Err(format!("Keychain read error: {e}")),
        };'''
new1 = '''        // v3.37 (2026-08-24): 从 settings.json 读 apiKey (跟 send_prompt 一致)
        let api_key = match crate::config_store::lookup_api_key(&app, &config.provider_id) {
            Some(k) => k,
            None => {
                return Err(format!(
                    "No API key for provider \\"{}\\" in settings.json. Add it in Settings → Providers (apiKey 字段).",
                    config.provider_id
                ));
            }
        };'''
assert old1 in lib, "old1 not found"
lib = lib.replace(old1, new1)

# 2. compact_session (line 3413-3423)
old2 = '''    // 跟 send_prompt 一样: 走 keychain 拿 apiKey (永不在 FE)
    let api_key = match keyring::get(&config.provider_id) {
        Ok(Some(k)) => k,
        Ok(None) => {
            return Err(format!(
                "No API key for provider \\"{}\\" in OS keychain.",
                config.provider_id
            ));
        }
        Err(e) => return Err(format!("Keychain read error: {e}")),
    };'''
new2 = '''    // v3.37 (2026-08-24): 跟 send_prompt 一样, 从 settings.json 读 apiKey
    let api_key = match crate::config_store::lookup_api_key(&app, &config.provider_id) {
        Some(k) => k,
        None => {
            return Err(format!(
                "No API key for provider \\"{}\\" in settings.json.",
                config.provider_id
            ));
        }
    };'''
assert old2 in lib, "old2 not found"
lib = lib.replace(old2, new2)

# 3. fetch_provider_models (line 3510-3511)
old3 = '''    let api_key = keyring::get(&provider_id)?
        .ok_or_else(|| format!("No API key in keychain for \\"{provider_id}\""))?;'''
new3 = '''    // v3.37 (2026-08-24): 从 settings.json 读 apiKey (跟 send_prompt 一致)
    let api_key = crate::config_store::lookup_api_key(app, &provider_id)
        .ok_or_else(|| format!("No API key in settings.json for \\"{provider_id}\\" (Settings → Providers 加 apiKey 字段)"))?;'''
# fetch_provider_models 没拿 app handle, 看上面
print("--- need to add app handle to fetch_provider_models ---")

with open(path, "w", encoding="utf-8") as f:
    f.write(lib)
print("done (1+2 ok, 3 needs app handle)")
