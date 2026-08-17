/**
 * Sidecar spawn + IPC bridge.
 *
 * 流式架构:
 *   Tauri command (send_prompt)
 *     → tokio::spawn 启动 node sidecar (单进程单 prompt, 简单 MVP)
 *     → stdin 写 {config} + {prompt}
 *     → 后台 task 读 stdout, 逐行 parse 成 JSON event, emit 'chat:event' 给 frontend
 *     → 收到 agent_end → 自然结束, child drop 时 kill_on_drop 杀进程
 *
 * v0.4.1+ tool permission:
 *   - 写完 config + prompt 后, stdin 移到 ActiveSidecars map
 *   - FE invoke send_permission_response / set_permission_mode 拿 map 里的 stdin 写后续消息
 *   - agent_end 后 task 移除 map entry, 进程被杀, stdin 关闭
 *
 * 路径: dev 模式从 cwd 找 sidecar/src/index.mjs.
 *       production 模式需要 bundle Node + sidecar (Phase 3+ TODO).
 */
use serde::Deserialize;
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, Command};
use tokio::sync::Mutex;

/// v0.4.1+ active sidecar 进程 stdin 全局表 (per-session).
/// 让 FE 端 invoke (send_permission_response / set_permission_mode) 能写到指定 session 的 stdin.
/// task 结束 (agent_end) 时移除 entry, 避免悬空 handle.
pub struct ActiveSidecars(pub Mutex<HashMap<String, ChildStdin>>);

impl Default for ActiveSidecars {
    fn default() -> Self {
        Self(Mutex::new(HashMap::new()))
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct SidecarConfig {
    /// Provider type: 'openai-compatible' / 'anthropic' / 'openai' / ...
    pub provider: String,
    pub model: String,
    /// Required for openai-compatible. 内置 provider 忽略.
    #[serde(default)]
    pub base_url: String,
    /// API key (从 keychain 读出来, 不在 client bundle / 不进日志)
    pub api_key: String,
    /// 'off' | 'low' | 'medium' | 'high'
    #[serde(default)]
    pub thinking_level: Option<String>,
    /// v0.3.8.11: 当前 workspace 目录绝对路径, 注入到 system message
    /// 让 LLM 知道在哪个目录下读写文件 (注意: 实际 file system tools 还没接)
    #[serde(default)]
    pub workspace_path: Option<String>,
    /// v0.4.1+ tool permission 初始 mode: 'ask' (默认) | 'smart' | 'allow'
    #[serde(default = "default_permission_mode")]
    pub permission_mode: String,
    /// v0.4.2 step 1+: per-workspace stable sessionId (uuid v7), 让 sidecar 用同一 session 加载历史.
    /// FE 从 AppConfig.per_workspace_session_id[workspace_path] 读, 切 workspace 时同步.
    /// 第一次没有 → sidecar 内部生成一个 (跟 v0.4.1 兼容).
    #[serde(default)]
    pub session_id: Option<String>,
}

fn default_permission_mode() -> String {
    "ask".to_string()
}

#[derive(Debug, Clone, Deserialize)]
pub struct PromptMsg {
    pub session_id: String,
    pub content: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PermissionResponseMsg {
    pub tool_call_id: String,
    pub allow: bool,
    #[serde(default)]
    pub reason: Option<String>,
    /// sessionId 用来定位到指定 sidecar 进程的 stdin
    pub session_id: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SetPermissionModeMsg {
    pub mode: String,
    pub session_id: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CompactSessionMsg {
    /// sessionId 用来定位到指定 sidecar 进程的 stdin
    pub session_id: String,
}

fn find_sidecar_script() -> Result<std::path::PathBuf, String> {
    // 用 CARGO_MANIFEST_DIR (编译时绝对路径 = src-tauri/), parent() = 项目根
    // 不用 current_dir() 因为 cargo tauri dev 时 binary 的 cwd 是 src-tauri/
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let project_root = std::path::Path::new(manifest_dir).parent().ok_or_else(|| {
        format!("CARGO_MANIFEST_DIR ({manifest_dir}) has no parent (cannot find project root)")
    })?;
    let script = project_root.join("sidecar").join("src").join("index.mjs");
    if !script.exists() {
        return Err(format!(
            "Sidecar script not found at {}. cwd={:?}",
            script.display(),
            std::env::current_dir().ok()
        ));
    }
    Ok(script)
}

fn emit_error(app: &AppHandle, session_id: &str, message: &str) {
    let event = serde_json::json!({
        "type": "error",
        "sessionId": session_id,
        "message": message,
    });
    if let Err(e) = app.emit("chat:event", &event) {
        log::error!("emit error event failed: {e}");
    }
    let end = serde_json::json!({
        "type": "agent_end",
        "sessionId": session_id,
    });
    let _ = app.emit("chat:event", &end);
}

/// Spawn sidecar, send config + prompt, stream events to frontend.
/// 每个 prompt 一个独立 sidecar 进程 (MVP 简单版).
/// 进程在收到 'agent_end' 事件后自然结束.
///
/// v0.4.1+ 参数 active 必须是 owned Arc<...> 因为 spawn task 跨 await 需要 'static lifetime.
pub fn run_prompt(
    app: AppHandle,
    config: SidecarConfig,
    prompt: PromptMsg,
    active: Arc<ActiveSidecars>,
) {
    let session_id = prompt.session_id;
    debug_log(&format!("run_prompt: session={session_id}"));
    tokio::spawn(async move {
        let script = match find_sidecar_script() {
            Ok(s) => {
                debug_log(&format!("sidecar script: {}", s.display()));
                s
            }
            Err(e) => {
                debug_log(&format!("sidecar not found: {e}"));
                emit_error(&app, &session_id, &e);
                return;
            }
        };

        let mut child = match Command::new("node")
            .arg(&script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
        {
            Ok(c) => {
                debug_log(&format!("node spawned, pid={}", c.id().unwrap_or(0)));
                c
            }
            Err(e) => {
                debug_log(&format!("spawn node failed: {e}"));
                emit_error(&app, &session_id, &format!("spawn node failed: {e}"));
                return;
            }
        };

        let mut stdin = match child.stdin.take() {
            Some(s) => s,
            None => {
                emit_error(&app, &session_id, "no stdin pipe");
                return;
            }
        };
        let stdout = match child.stdout.take() {
            Some(s) => s,
            None => {
                emit_error(&app, &session_id, "no stdout pipe");
                return;
            }
        };
        let stderr = match child.stderr.take() {
            Some(s) => s,
            None => {
                emit_error(&app, &session_id, "no stderr pipe");
                return;
            }
        };

        // 写 config (含 v0.4.1+ permissionMode + v0.4.2 step 1+ sessionId)
        let config_msg = serde_json::json!({
            "type": "config",
            "provider": config.provider,
            "model": config.model,
            "baseUrl": config.base_url,
            "apiKey": config.api_key,
            "thinkingLevel": config.thinking_level,
            "workspacePath": config.workspace_path,
            "permissionMode": config.permission_mode,
            "sessionId": config.session_id,
        });
        let line = match serde_json::to_string(&config_msg) {
            Ok(s) => format!("{s}\n"),
            Err(e) => {
                emit_error(&app, &session_id, &format!("ser config: {e}"));
                return;
            }
        };
        if let Err(e) = stdin.write_all(line.as_bytes()).await {
            emit_error(&app, &session_id, &format!("write config: {e}"));
            return;
        }

        // 写 prompt
        let prompt_msg = serde_json::json!({
            "type": "prompt",
            "sessionId": session_id,
            "content": prompt.content,
        });
        let line = match serde_json::to_string(&prompt_msg) {
            Ok(s) => format!("{s}\n"),
            Err(e) => {
                emit_error(&app, &session_id, &format!("ser prompt: {e}"));
                return;
            }
        };
        if let Err(e) = stdin.write_all(line.as_bytes()).await {
            emit_error(&app, &session_id, &format!("write prompt: {e}"));
            return;
        }

        // v0.4.1+ 注册 stdin 到 active map, 让 FE 端 send_permission_response / set_permission_mode 找得到
        {
            let mut map = active.0.lock().await;
            map.insert(session_id.clone(), stdin);
        }
        debug_log(&format!("run_prompt: wrote config + prompt, stdin registered to active map"));

        // 后台读 stderr → log
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                debug_log(&format!("stderr: {line}"));
                log::warn!("[sidecar stderr] {line}");
            }
        });

        // 主 task: 读 stdout, 逐行 emit event
        let mut reader = BufReader::new(stdout).lines();
        let mut got_agent_end = false;
        let mut event_count = 0u32;
        while let Ok(Some(line)) = reader.next_line().await {
            event_count += 1;
            debug_log(&format!("stdout[{event_count}]: {line}"));
            log::info!("[sidecar:{session_id}] {line}");
            if line.trim().is_empty() {
                continue;
            }
            let mut event: serde_json::Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(e) => {
                    log::warn!("[sidecar:{session_id}] bad json: {e} line={line}");
                    continue;
                }
            };
            // 注入 sessionId 给 frontend dispatch
            if let Some(obj) = event.as_object_mut() {
                obj.insert("sessionId".to_string(), serde_json::json!(session_id));
            }
            let event_type = event
                .get("type")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if let Err(e) = app.emit("chat:event", &event) {
                log::error!("emit failed: {e}");
            }
            if event_type == "agent_end" {
                got_agent_end = true;
                break;
            }
        }

        if !got_agent_end {
            // 异常退出 (stream 断了没收到 agent_end), 补发一个让前端收尾
            log::warn!("[sidecar:{session_id}] stream ended without agent_end");
            let end = serde_json::json!({
                "type": "agent_end",
                "sessionId": session_id,
            });
            let _ = app.emit("chat:event", &end);
        }

        // v0.4.1+ 从 active map 移除 stdin (Agent 自然结束, 后续 permission_response 不应到达)
        {
            let mut map = active.0.lock().await;
            map.remove(&session_id);
        }
        // child 在这里 drop, kill_on_drop 触发
        drop(child);
        log::info!("[sidecar:{session_id}] done");
    });
}

/// v0.4.1+ FE 端 PermissionDialog 点了允许/拒绝, 写到对应 sidecar stdin
#[tauri::command]
pub async fn send_permission_response(
    msg: PermissionResponseMsg,
    active: State<'_, Arc<ActiveSidecars>>,
) -> Result<(), String> {
    debug_log(&format!(
        "send_permission_response: session={} tool={} allow={}",
        msg.session_id, msg.tool_call_id, msg.allow
    ));
    let mut map = active.0.lock().await;
    let stdin = map
        .get_mut(&msg.session_id)
        .ok_or_else(|| format!("no active sidecar for session={}", msg.session_id))?;
    let ipc = serde_json::json!({
        "type": "permission_response",
        "toolCallId": msg.tool_call_id,
        "allow": msg.allow,
        "reason": msg.reason,
    });
    let line = format!("{}\n", serde_json::to_string(&ipc).map_err(|e| format!("ser: {e}"))?);
    stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|e| format!("write permission_response: {e}"))?;
    Ok(())
}

/// v0.4.1+ FE 端切了 permission mode, 实时同步到 sidecar
#[tauri::command]
pub async fn set_permission_mode(
    msg: SetPermissionModeMsg,
    active: State<'_, Arc<ActiveSidecars>>,
) -> Result<(), String> {
    debug_log(&format!(
        "set_permission_mode: session={} mode={}",
        msg.session_id, msg.mode
    ));
    let mut map = active.0.lock().await;
    let stdin = map
        .get_mut(&msg.session_id)
        .ok_or_else(|| format!("no active sidecar for session={}", msg.session_id))?;
    let ipc = serde_json::json!({
        "type": "set_permission_mode",
        "mode": msg.mode,
    });
    let line = format!("{}\n", serde_json::to_string(&ipc).map_err(|e| format!("ser: {e}"))?);
    stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|e| format!("write set_permission_mode: {e}"))?;
    Ok(())
}

/// v0.4.2 step 1+: FE 端手动触发压缩 (e.g. 用户在 UI 点了"压缩历史"按钮).
/// 调 AgentSession.compact() 走 LLM-driven summary, 自动 persist 到 session.jsonl.
/// 期间 sidecar 会 emit compaction_start → compaction_end, FE 显示 toast / banner.
#[tauri::command]
pub async fn compact_session(
    msg: CompactSessionMsg,
    active: State<'_, Arc<ActiveSidecars>>,
) -> Result<(), String> {
    debug_log(&format!("compact_session: session={}", msg.session_id));
    let mut map = active.0.lock().await;
    let stdin = map
        .get_mut(&msg.session_id)
        .ok_or_else(|| format!("no active sidecar for session={}", msg.session_id))?;
    let ipc = serde_json::json!({
        "type": "compact_session",
    });
    let line = format!("{}\n", serde_json::to_string(&ipc).map_err(|e| format!("ser: {e}"))?);
    stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|e| format!("write compact_session: {e}"))?;
    Ok(())
}

fn debug_log(msg: &str) {
    let log_path = std::path::PathBuf::from("D:/UnityWork/Tools/Pi/.tauri-debug.log");
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
    {
        use std::io::Write;
        let ts = chrono::Utc::now().format("%H:%M:%S%.3f");
        let _ = writeln!(f, "[{ts}] [sidecar] {msg}");
    }
}
