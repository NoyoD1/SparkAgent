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
 * 路径: dev 模式从 cwd 找 sidecar/src/index.mjs.
 *       production 模式需要 bundle Node + sidecar (Phase 3+ TODO).
 */
use serde::Deserialize;
use std::process::Stdio;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

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
}

#[derive(Debug, Clone, Deserialize)]
pub struct PromptMsg {
    pub session_id: String,
    pub content: String,
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
pub fn run_prompt(app: AppHandle, config: SidecarConfig, prompt: PromptMsg) {
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

        // 写 config
        let config_msg = serde_json::json!({
            "type": "config",
            "provider": config.provider,
            "model": config.model,
            "baseUrl": config.base_url,
            "apiKey": config.api_key,
            "thinkingLevel": config.thinking_level,
            "workspacePath": config.workspace_path,
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
        // v0.3.5+: 不要 drop(stdin) — 关 stdin 会让 sidecar 立即收到 EOF, 触发 close 事件
        // 导致 readline 调 abort 把正在飞行的 fetch 掐死 (网络请求还没发出去).
        //
        // 正确做法: 保持 stdin 打开, sidecar 的 readline 继续等下一行.
        // fetch 跑完正常 emit agent_end → Rust 这边 stdout reader 收到 → break 退出循环 →
        // 后续 `drop(child)` 时 `kill_on_drop=true` 触发 TerminateProcess 杀 sidecar,
        // 这时 OS 才把 stdin 关掉. 整个 fetch / stream 期间 stdin 都保持打开.
        //
        // `stdin` 这个变量在 task 结束时 (block 末尾) 会自动 drop, 但那时候 child 已经被杀,
        // pipe 已经断了, 这里的 drop 只是清理 fd 而已, 不会再触发 sidecar 的 close 事件.
        debug_log(&format!("run_prompt: wrote config + prompt, keeping stdin open until agent_end"));

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

        // child 在这里 drop, kill_on_drop 触发
        drop(child);
        log::info!("[sidecar:{session_id}] done");
    });
}
