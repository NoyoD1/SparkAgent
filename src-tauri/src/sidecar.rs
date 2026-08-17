/**
 * Sidecar spawn + IPC bridge.
 *
 * v0.5.0 全量重写: 跟之前 v0.4.x 比, 不再在 Rust 端手写 stdin/stdout 协议解析, 全用
 *   Pi SDK 0.84.2 提供的 runRpcMode() 轮子.
 *
 * 协议:
 *   - argv[2] = config JSON (one-shot init: workspacePath / provider / model / apiKey /
 *     baseUrl / sessionId / thinkingLevel / tools)
 *   - stdin line 1+ = Pi SDK RpcCommand (prompt / steer / follow_up / abort / set_model /
 *     cycle_model / set_thinking_level / set_steering_mode / set_follow_up_mode / compact /
 *     set_auto_compaction / set_auto_retry / abort_retry / bash / abort_bash / get_state /
 *     get_commands / get_session_stats / export_html / switch_session / fork / clone /
 *     get_fork_messages / get_entries / get_tree / get_last_assistant_text / set_session_name /
 *     get_messages / extension_ui_response) — 完整 list 见 @earendil-works/pi-coding-agent/modes/rpc/rpc-types
 *   - stdout = Pi SDK RpcResponse + RpcEvent + extension_ui_request
 *
 * 流式架构 (跟之前一样, 但逻辑简化):
 *   Tauri command (send_prompt / send_rpc_command)
 *     → tokio::spawn 启动 sidecar .exe (单进程多 RpcCommand, 一次 prompt → agent_end)
 *     → spawn 时 argv[1] 传 config JSON (bun runtime 重新设置 process.argv,
 *       argv[0] = "bun", argv[1] = .exe 路径, argv[2] = user arg = config JSON)
 *     → stdin 写第一个 RpcCommand (prompt)
 *     → 注册 stdin 到 ActiveSidecars map, 让后续 send_rpc_command (e.g. permission_response
 *       → extension_ui_response / set_model / abort / compact) 找得到
 *     → 后台 task 读 stdout 逐行 parse RpcEvent, emit 'chat:event' 给 frontend
 *     → 收到 agent_end → 移除 map entry, child drop 时 kill_on_drop 杀进程
 *
 * 路径: 走 CARGO_MANIFEST_DIR 编译时绝对路径找 sidecar/dist/pi-agent-sidecar.exe
 *       (bun build --compile 产物, D163 跨项目规则: release 不依赖 system Node).
 */
use serde::Deserialize;
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, Command};
use tokio::sync::Mutex;

/// v0.5.0 active sidecar 进程 stdin 全局表 (per-session).
/// 让 FE 端 invoke (send_rpc_command) 能写到指定 session 的 stdin.
/// task 结束 (agent_end) 时移除 entry, 避免悬空 handle.
pub struct ActiveSidecars(pub Mutex<HashMap<String, ChildStdin>>);

impl Default for ActiveSidecars {
    fn default() -> Self {
        Self(Mutex::new(HashMap::new()))
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
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

fn find_sidecar_script() -> Result<std::path::PathBuf, String> {
    // v0.5.6: 不再依赖 system node + sidecar/src/index.mjs (D163 / D144 跨项目规则).
    //   之前调 `Command::new("node") .arg(&script)`, 要求用户机器装 Node.js + 项目内 .mjs
    //   文件存在, MSI/NSIS installer 不打 .mjs 源码 → release .exe 在用户机器 fail.
    //   现在调 `pi-agent-sidecar.exe` (bun build --compile 出的 standalone executable),
    //   108 MB self-contained, 拷任何 Windows 机器都能直接跑, 不依赖 system Node / 项目源码.
    // dev 模式: bun compile 后产物在 sidecar/dist/pi-agent-sidecar.exe, Tauri .exe 走
    //   CARGO_MANIFEST_DIR 找.
    // 路径: <project_root>/sidecar/dist/pi-agent-sidecar.exe
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let project_root = std::path::Path::new(manifest_dir).parent().ok_or_else(|| {
        format!("CARGO_MANIFEST_DIR ({manifest_dir}) has no parent (cannot find project root)")
    })?;
    let exe = project_root.join("sidecar").join("dist").join("pi-agent-sidecar.exe");
    if !exe.exists() {
        return Err(format!(
            "Sidecar executable not found at {}. Run `bun build --compile --target=bun-windows-x64 --outfile {}` first. cwd={:?}",
            exe.display(),
            exe.display(),
            std::env::current_dir().ok()
        ));
    }
    Ok(exe)
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

/// v0.5.0: 启动 sidecar, argv[2] 传 config JSON, stdin 第一个 RpcCommand 是 prompt.
/// 后续 send_rpc_command 写同一个 stdin.
/// session 在收到 'agent_end' 事件后自然结束.
pub fn run_prompt(
    app: AppHandle,
    config: SidecarConfig,
    session_id: String,
    initial_command_json: String,
    active: Arc<ActiveSidecars>,
) {
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

        // v0.5.0: config 走 argv[2] (跟 Pi SDK main.ts pattern 一致)
        let config_arg = match serde_json::to_string(&serde_json::json!({
            "type": "config",
            "provider": config.provider,
            "model": config.model,
            "baseUrl": config.base_url,
            "apiKey": config.api_key,
            "thinkingLevel": config.thinking_level,
            "workspacePath": config.workspace_path,
            "permissionMode": config.permission_mode,
            "sessionId": config.session_id,
        })) {
            Ok(s) => s,
            Err(e) => {
                emit_error(&app, &session_id, &format!("ser config: {e}"));
                return;
            }
        };

        let mut child = match Command::new(&script)
            .arg(&config_arg)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
        {
            Ok(c) => {
                debug_log(&format!("sidecar spawned, pid={}", c.id().unwrap_or(0)));
                c
            }
            Err(e) => {
                debug_log(&format!("spawn sidecar failed: {e}"));
                emit_error(&app, &session_id, &format!("spawn sidecar failed: {e}"));
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

        // v0.5.0: stdin line 1 = 第一个 RpcCommand (e.g. prompt)
        let line = format!("{initial_command_json}\n");
        if let Err(e) = stdin.write_all(line.as_bytes()).await {
            emit_error(&app, &session_id, &format!("write initial command: {e}"));
            return;
        }

        // 注册 stdin 到 active map, 让 FE 端 send_rpc_command (e.g. extension_ui_response /
        // set_model / abort / compact) 找得到
        {
            let mut map = active.0.lock().await;
            map.insert(session_id.clone(), stdin);
        }
        debug_log(&format!(
            "run_prompt: wrote initial RpcCommand, stdin registered to active map"
        ));

        // 后台读 stderr → log
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                debug_log(&format!("stderr: {line}"));
                log::warn!("[sidecar stderr] {line}");
            }
        });

        // 主 task: 读 stdout, 逐行 emit RpcEvent 给 frontend
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
            // 注入 sessionId 给 frontend dispatch (RpcEvent 自身没 sessionId 字段)
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

        // 从 active map 移除 stdin (Agent 自然结束, 后续 RpcCommand 不应到达)
        {
            let mut map = active.0.lock().await;
            map.remove(&session_id);
        }
        // child 在这里 drop, kill_on_drop 触发
        drop(child);
        log::info!("[sidecar:{session_id}] done");
    });
}

/// v0.5.0: 通用 stdin 透传 — FE 端发任意 RpcCommand 写到指定 sidecar stdin.
/// 之前 v0.4.x 的 send_permission_response / set_permission_mode / compact_session 3 个
/// 特殊 invoke 全部合并到这一个 — Rust 端不解析 RpcCommand, 直接 JSON.stringify 后
/// 写一行 stdin. 权限弹窗响应 → extension_ui_response RpcCommand; abort → abort
/// RpcCommand; set_model → set_model RpcCommand; compact → compact RpcCommand; 等等.
///
/// v0.5.0 fix: 之前用 nested struct `msg: RpcCommandMsg` 让 Tauri 期望 `msg: { ... }` 包裹,
///   跟 FE 端 invoke 习惯不一致, 报 'missing required key msg'. 改成两个顶层参数,
///   Tauri 2 自动 camelCase 转换 (session_id <-> sessionId, command_json <-> commandJson).
#[tauri::command]
pub async fn send_rpc_command(
    session_id: String,
    command_json: String,
    active: State<'_, Arc<ActiveSidecars>>,
) -> Result<(), String> {
    debug_log(&format!(
        "send_rpc_command: session={} cmd={}",
        session_id,
        command_json.chars().take(120).collect::<String>()
    ));
    let mut map = active.0.lock().await;
    let stdin = map
        .get_mut(&session_id)
        .ok_or_else(|| format!("no active sidecar for session={}", session_id))?;
    let line = format!("{}\n", command_json);
    stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|e| format!("write rpc_command: {e}"))?;
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
