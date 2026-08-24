#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v3.37 patch: 完全移除 keychain 引用 (Tauri 端).
- 删 keyring.rs / index_file.rs 整个文件
- Cargo.toml 删 keyring 依赖
- lib.rs 删 mod keyring/mod index_file/KeychainInfoDto/8 Tauri commands
- lib.rs send_prompt / compact_session / 等 4 处 keyring::get 改从 settings.json 读
- config_store.rs ProviderConfigDto 加 api_key 字段
- sidecar.rs browser watcher 删 resolve_secrets branch
"""
import io
import os
import shutil
import re

ROOT = "src-tauri"

# 1. 删 keyring.rs / index_file.rs (mv to backup dir, 因为 mavis-trash 不可用)
backup_dir = os.path.join(ROOT, ".removed-v337")
os.makedirs(backup_dir, exist_ok=True)
for f in ["keyring.rs", "index_file.rs"]:
    src = os.path.join(ROOT, "src", f)
    dst = os.path.join(backup_dir, f)
    if os.path.exists(src):
        shutil.move(src, dst)
        print(f"moved {src} → {dst}")

# 2. Cargo.toml 删 keyring 依赖
cargo_path = os.path.join(ROOT, "Cargo.toml")
with open(cargo_path, "r", encoding="utf-8") as f:
    cargo = f.read()
# 删 keyring 依赖行 + 上面的注释
cargo = re.sub(
    r"\n# OS keychain \(Windows Credential Manager / macOS Keychain / Linux Secret Service\)\nkeyring = \{ version = \"3\", features = \[\"windows-native\", \"apple-native\", \"linux-native\"\] \}\n",
    "\n",
    cargo,
)
# 改 description
cargo = cargo.replace(
    "Pi Agent Desktop — Tauri 2 + Vue 3 + Node sidecar with OS keychain for API keys",
    "Pi Agent Desktop — Tauri 2 + Vue 3 + Node sidecar (apiKey 存 settings.json 明文)",
)
with open(cargo_path, "w", encoding="utf-8") as f:
    f.write(cargo)
print(f"updated {cargo_path}")

# 3. lib.rs 大块改
lib_path = os.path.join(ROOT, "src", "lib.rs")
with open(lib_path, "r", encoding="utf-8") as f:
    lib = f.read()

# 3a. 删 mod keyring/mod index_file + 改顶部注释
lib = lib.replace(
    " *   keychain (keyring crate) 存 apiKey, 不进 localStorage / 不进 WS / 不进 .env\n */\nmod config_store;\nmod index_file;\nmod keyring;\nmod model_catalog;",
    " *   apiKey 存 settings.json 明文 (跟 baseUrl/label 一起, 跟 MCP / external tool 配置文件同 pattern)\n *   user 自主管理, 跟 keychain 解耦 — keychain 之前会让 send_prompt 链路多 60s 解析 timeout.\n */\nmod config_store;\nmod model_catalog;",
)

# 3b. 删 KeychainInfoDto struct
old_keychain_info = '''#[derive(Debug, Clone, serde::Serialize)]
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
    index_file::add(&app, &provider_id, index_file::Scope::Llm)?;
    Ok(())
}

#[tauri::command]
async fn delete_api_key(
    app: AppHandle,
    provider_id: String,
) -> Result<(), String> {
    keyring::delete(&provider_id)?;
    index_file::remove(&app, &provider_id, index_file::Scope::Llm)?;
    Ok(())
}

#[tauri::command]
async fn list_api_keys(app: AppHandle) -> Result<Vec<KeychainInfoDto>, String> {
    let idx = index_file::load(&app, index_file::Scope::Llm);
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

// ====== ADR-0023 P3-C (2026-08-24): 通用 secret 管理 ======
//   给 MCP server env / external tool env 用的 keychain entry.
//   走独立 keyring service="pi-agent-secret" (跟 LLM apiKey 的 "pi-agent" 完全隔离,
//   list 互不干扰) + 独立 index file "keychain_secret_index.json".
//   命名建议: mcp-<server>-<field> / external-<tool>-<field> (跟 keychain 命名空间一致).
#[tauri::command]
async fn save_secret(app: AppHandle, name: String, value: String) -> Result<(), String> {
    if name.is_empty() {
        return Err("name is empty".to_string());
    }
    if value.is_empty() {
        return Err("value is empty".to_string());
    }
    // 命名校验: 跟 LLM provider_id 一样, 1-128 char, [A-Za-z0-9._@-]
    if name.len() > 128 {
        return Err(format!("secret name too long: {} > 128", name.len()));
    }
    if !name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '@')) {
        return Err(format!("secret name '{name}' 含非法字符, 只能 [A-Za-z0-9._@-]"));
    }
    keyring::save_secret(&name, &value)?;
    index_file::add(&app, &name, index_file::Scope::Secret)?;
    Ok(())
}

#[tauri::command]
async fn delete_secret(app: AppHandle, name: String) -> Result<(), String> {
    keyring::delete_secret(&name)?;
    index_file::remove(&app, &name, index_file::Scope::Secret)?;
    Ok(())
}

#[tauri::command]
async fn list_secrets(app: AppHandle) -> Result<Vec<KeychainInfoDto>, String> {
    // ADR-0023 P3-C: 独立 index file (keychain_secret_index.json) + 独立 service
    //   (pi-agent-secret), 跟 list_api_keys 完全隔离, 不会返回 LLM apiKey 条目
    // BUG FIX v3.14: 之前用 keyring::get (走 LLM service), 跟 save_secret 跨服务,
    //   导致 list 显示 "(keychain) 找不到" 但实际 secret 已存. 改用 get_secret.
    let idx = index_file::load(&app, index_file::Scope::Secret);
    let mut out = Vec::with_capacity(idx.provider_ids.len());
    for id in idx.provider_ids {
        let (configured, preview) = match keyring::get_secret(&id) {
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
async fn resolve_secrets(values: Vec<String>) -> Result<Vec<String>, String> {
    // v3.36 (2026-08-24): 回滚 P3-C keychain 解析, 改 identity pass-through.
    //   背景: P3-C 引入 keychain 引用 ("keychain:pi-agent:MCP_XXX") 让 MCP / external tool
    //     env 里的 secret 走 OS keychain 解析. 副作用: sidecar 启动 MCP / external tool 时
    //     调 resolve_secrets 走 callTauriCommand, keychain 解析失败 / 找不到 secret 走
    //     60s timeout 兜底 — 整条 send_prompt 链路要等 60s.
    //   user 反馈: "key 都在本地个人电脑, 直填到 mcp / tool 配置就行, 为什么要走 keychain?"
    //     user 角度完全合理 — 1 分延迟大头是 keychain 60s timeout, 不是 LLM API.
    //   修法 (回滚 v3.22 之前行为): Tauri 端 resolve_secrets 改 identity, env values 原样返.
    //     - sidecar 端 resolveSecretEnv 立即拿到原值, 不 60s timeout
    //     - MCP / external tool 拿到 env 原值 (含 "keychain:..." literal), 实际 fail
    //       但启动快 (0s wait, 不影响 main vision 流程)
    //     - user 后续自己改 MCP / external tool config, 把 "keychain:..." 引用换成明文 key
    //   backward compat: sidecar binary 没改, 仍调 callTauriCommand("resolve_secrets"),
    //     Tauri 端 identity 返, sidecar 立即收到.
    //
    // 之前 v3.22 行为 (keyring 解析, 60s timeout) 注释保留在下面 reference, 方便对比:
    //
    //   P3-C: 用 keyring::get_secret 走 SERVICE_SECRET 独立 keychain
    //   P3-F+: lookup fallback (试整个 name + last-segment short name)
    //   PREFIX = "keychain:", 不在 keychain 引用 (没 "keychain:" 前缀) 直接 pass-through
    Ok(values)
}'''
new_keychain_info = '// ====== v3.37 (2026-08-24): 移除 keychain 全部代码 ======\n//   之前 P3-C 引入 keychain 管理 LLM apiKey + MCP/external tool secret, 副作用:\n//     - send_prompt 链路 keychain 解析失败走 60s timeout 兜底 (实测 1 分 6 秒延迟)\n//     - user 角度: "key 都在本地个人电脑, 直填到 mcp / tool 配置就行, 为什么要走 keychain?"\n//   v3.37 修法 (完全移除):\n//     - LLM apiKey 存 settings.json 明文 (跟 baseUrl/label 一起, ProviderConfigDto.api_key)\n//     - MCP / external tool secret 改 user 自己在配置文件里直填明文\n//     - Settings → Secrets tab 整个删\n//     - Tauri 端 send_prompt / compact_session / 等内部从 settings.json 找 provider.api_key\n//     - 8 个 Tauri commands (save_api_key/delete_api_key/list_api_keys/has_api_key/\n//       save_secret/delete_secret/list_secrets/resolve_secrets) 整个删\n//     - keyring crate 依赖删 (Cargo.toml)\n//     - keyring.rs / index_file.rs 整个文件删\n//   现有 OS keychain 里的 key (LLM apiKey) 不 migrate, user 重输一次.\n//   跟其他 provider config 同步, user 在 Settings → Providers 加 provider 时直填 apiKey.'
lib = lib.replace(old_keychain_info, new_keychain_info)

# 3c. 改 send_prompt keyring::get → config_store 读
# 这是 send_prompt 主逻辑 (line 3443 附近)
old_sendp = '''    // 从 keychain 取 key (永不出现在前端, 不进日志)
    let api_key = match keyring::get(&config.provider_id) {
        Ok(Some(k)) => k,
        Ok(None) => {
            debug_log(&format!("send_prompt: no apiKey in keychain for {}", config.provider_id));
            return Err(format!(
                "No API key for provider \\"{}\\" in OS keychain. Add it in Settings → Providers.",
                config.provider_id
            ));
        }
        Err(e) => {
            debug_log(&format!("send_prompt: keychain get err: {e}"));
            return Err(format!("Keychain read error: {e}"));
        }
    };'''
new_sendp = '''    // v3.37 (2026-08-24): 从 settings.json 读 apiKey (明文, 跟 baseUrl 一样)
    //   之前走 keyring::get, 但 keychain 解析 60s timeout 拖慢整条 send_prompt 链路.
    //   apiKey 现在存 settings.json 的 ProviderConfigDto.api_key, user 直填.
    let api_key = match crate::config_store::lookup_api_key(&app, &config.provider_id) {
        Some(k) => k,
        None => {
            debug_log(&format!(
                "send_prompt: no apiKey in settings.json for {}",
                config.provider_id
            ));
            return Err(format!(
                "No API key for provider \\"{}\\" in settings.json. Add it in Settings → Providers (apiKey 字段).",
                config.provider_id
            ));
        }
    };'''
lib = lib.replace(old_sendp, new_sendp)

with open(lib_path, "w", encoding="utf-8") as f:
    f.write(lib)
print(f"updated {lib_path}")

# 4. config_store.rs 加 lookup_api_key + ProviderConfigDto.api_key 字段
cs_path = os.path.join(ROOT, "src", "config_store.rs")
with open(cs_path, "r", encoding="utf-8") as f:
    cs = f.read()

# 4a. ProviderConfigDto 加 api_key 字段 (在 base_url 后面)
old_dto = '''    #[serde(default)]
    pub base_url: Option<String>,
    // P2 #1 fix: 鍒?api_key_env dead code. 鏃?v0.2 璁捐瀛楁, 瀹為檯娌′汉鐢? 淇濈暀浼氳瀵煎悗缁紑鍙?'''
new_dto = '''    #[serde(default)]
    pub base_url: Option<String>,
    // v3.37 (2026-08-24): apiKey 改存 settings.json 明文 (跟 base_url 一起, 跟 MCP / external tool 配置同 pattern)
    //   之前走 keyring (SERVICE_LLM="pi-agent"), 现在完全移除 keychain 依赖, user 在 Settings → Providers
    //   加 provider 时直填 apiKey 字段 (Settings UI 同步改). 跟 .env / 配置文件明文 secret 一样.
    //   明文存, 因为 user 角度: "key 都在本地个人电脑, 不需要 keychain 多一层"
    #[serde(default)]
    pub api_key: Option<String>,
    // P2 #1 fix: 鍒?api_key_env dead code. 鏃?v0.2 璁捐瀛楁, 瀹為檯娌′汉鐢? 淇濈暀浼氳瀵煎悗缁紑鍙?'''
cs = cs.replace(old_dto, new_dto)

# 4b. 加 lookup_api_key helper 在文件末尾
# 先看末尾结构
if not cs.endswith("\n"):
    cs += "\n"
cs += """
// v3.37 (2026-08-24): 从 AppConfig 找 provider 的 apiKey (明文).
//   之前走 keyring::get, 副作用是 keychain 解析 60s timeout 拖慢 send_prompt 链路.
//   现在从 settings.json 明文读, lookup O(N) (providers 一般 < 10 个, 可接受).
//   - 返回 Some(apiKey) 表示找到, None 表示 provider 不存在 或 apiKey 未填.
//   - send_prompt 链路用 None 返 error "No API key for provider ..."
pub fn lookup_api_key(app: &tauri::AppHandle, provider_id: &str) -> Option<String> {
    let cfg = load(app);
    cfg.providers
        .into_iter()
        .find(|p| p.id == provider_id)
        .and_then(|p| p.api_key)
        .filter(|k| !k.is_empty())
}
"""

with open(cs_path, "w", encoding="utf-8") as f:
    f.write(cs)
print(f"updated {cs_path}")

# 5. sidecar.rs browser watcher dispatch match 删 resolve_secrets branch
sc_path = os.path.join(ROOT, "src", "sidecar.rs")
with open(sc_path, "r", encoding="utf-8") as f:
    sc = f.read()

# 5a. 删 resolve_secrets branch
old_resolve = '''                // ADR-0023 P3-C: sidecar 发来一批 env value, 解析 keychain: 引用返明文
                //   用法: resolve_secrets({ values: ["keychain:pi-agent:foo", "literal"] })
                //   返: { result: ["actual_secret", "literal"] } (跟 input 1:1 对应)
                "resolve_secrets" => {
                    let values: Vec<String> = match args.get("values").and_then(|v| v.as_array()) {
                        Some(arr) => arr.iter().filter_map(|v| v.as_str().map(String::from)).collect(),
                        None => Vec::new(),
                    };
                    match crate::resolve_secrets(values).await {
                        Ok(resolved) => (Some(serde_json::json!(resolved)), None),
                        Err(e) => (None, Some(e)),
                    }
                }
                other => (None, Some(format!("unknown command: {other}"))),'''
new_resolve = '''                // v3.37 (2026-08-24): 删 resolve_secrets branch (keychain 完全移除)
                //   之前 P3-C 通用 secret 管理用, sidecar 启 MCP / external tool 时调来解析
                //   "keychain:..." 引用. v3.37 改 user 直填明文, 不再走 keychain.
                other => (None, Some(format!("unknown command: {other}"))),'''
sc = sc.replace(old_resolve, new_resolve)

with open(sc_path, "w", encoding="utf-8") as f:
    f.write(sc)
print(f"updated {sc_path}")

# 6. 删 4 处 keyring::get (其他 send_prompt 路径, 不只主 send_prompt)
#    其他位置: line 2936, 3540, 3655, 3825
#    这些可能是 不同的 send_prompt (比如 webview / external tool / 别的 invoke)
#    让我先不改, build 跑看看哪里 break

print("=== patch-v337-remove-keychain.py done ===")
print("Note: 还有 4 处 keyring::get 没改 (其他 invoke 路径), build 会 fail.")
print("下一步: build 看错误, 继续 patch 那些位置.")
