/**
 * OS keychain wrapper for Pi Agent apiKey storage.
 *
 * v0.3 design: apiKey 不进 localStorage / 不进 WS / 不进 .env
 * 走 OS 原生 keychain (Windows Credential Manager / macOS Keychain / Linux Secret Service)
 * 通过 keyring crate 调用.
 *
 * Service name:  "pi-agent"
 * Username:      provider.id (e.g. "prov-shangtang-1")
 *
 * 跟 frontend 配合:
 *   - Settings UI 显示 "已配置" (有 key) / "未配置" (无 key)
 *   - 不显示 key 内容 (永远前端拿不到明文)
 *   - 保存时: invoke('save_api_key', { providerId, apiKey })
 *   - 删除时: invoke('delete_api_key', { providerId })
 *   - 列表:   invoke('list_api_keys') → ['prov-shangtang-1', ...]
 */
use keyring::Entry;

const SERVICE: &str = "pi-agent";

// R5: 严格化 mask — 只显示前 2 字符 (provider prefix, e.g. "sk") + "..." + 后 4 字符
// 之前 4+4=8 字符对短 key 暴露比例偏高, 改为更保守
pub fn mask(key: &str) -> String {
    if key.len() <= 8 {
        return "***".to_string();
    }
    format!("{}...{}", &key[..2], &key[key.len() - 4..])
}

pub fn save(provider_id: &str, api_key: &str) -> Result<(), String> {
    let entry = Entry::new(SERVICE, provider_id).map_err(|e| format!("keychain new: {e}"))?;
    entry.set_password(api_key).map_err(|e| format!("keychain set: {e}"))?;
    Ok(())
}

pub fn get(provider_id: &str) -> Result<Option<String>, String> {
    let entry = Entry::new(SERVICE, provider_id).map_err(|e| format!("keychain new: {e}"))?;
    match entry.get_password() {
        Ok(pw) => Ok(Some(pw)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("keychain get: {e}")),
    }
}

pub fn delete(provider_id: &str) -> Result<(), String> {
    let entry = Entry::new(SERVICE, provider_id).map_err(|e| format!("keychain new: {e}"))?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()), // already gone
        Err(e) => Err(format!("keychain delete: {e}")),
    }
}
