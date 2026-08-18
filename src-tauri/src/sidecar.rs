/**
 * Sidecar spawn + IPC bridge.
 *
 * v0.5.8 重写 sidecar 启动机制 (D172 跨项目规则: Tauri 2 sidecar 必须走
 *   bundle.externalBin + app.shell().sidecar() 标准机制, 不能用 Command::new(&script)
 *   写死编译时绝对路径, 否则干净 Windows 机器 install MSI/NSIS 后启动 fail).
 *
 * v0.5.0 大重构: 跟之前 v0.4.x 比, 不再在 Rust 端手写 stdin/stdout 协议解析, 全用
 *   Pi SDK 0.84.2 提供的 runRpcMode() 轮子.
 *
 * 协议:
 *   - argv[1] = config JSON (one-shot init: workspacePath / provider / model / apiKey /
 *     baseUrl / sessionId / thinkingLevel / tools) — bun compiled .exe 行为:
 *     process.argv = ["bun", "<compiled .exe path>", <user arg>], 所以 config 是 argv[1]
 *   - stdin line 1+ = Pi SDK RpcCommand (prompt / steer / follow_up / abort / set_model /
 *     cycle_model / set_thinking_level / set_steering_mode / set_follow_up_mode / compact /
 *     set_auto_compaction / set_auto_retry / abort_retry / bash / abort_bash / get_state /
 *     get_commands / get_session_stats / export_html / switch_session / fork / clone /
 *     get_fork_messages / get_entries / get_tree / get_last_assistant_text / set_session_name /
 *     get_messages / extension_ui_response) — 完整 list 见 @earendil-works/pi-coding-agent/modes/rpc/rpc-types
 *   - stdout = Pi SDK RpcResponse + RpcEvent + extension_ui_request
 *
 * 流式架构:
 *   Tauri command (send_prompt / send_rpc_command)
 *     → app.shell().sidecar("pi-agent-sidecar").spawn() 启动 sidecar .exe
 *       (走 Tauri 2 标准 sidecar 机制, bundle.externalBin 声明, capabilities shell:allow-spawn 授权)
 *     → 拿 (Receiver<CommandEvent>, CommandChild), 写初始 RpcCommand 走 child.write()
 *     → 注册 CommandChild 到 ActiveSidecars map, 让后续 send_rpc_command 找得到
 *     → 后台 task 循环 rx.recv() 处理 CommandEvent::Stdout (emit 'chat:event') /
 *       Stderr (log) / Terminated (break)
 *     → 收到 agent_end → 移除 map entry, child drop 时 kill
 */
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tokio::sync::Mutex;

/// v0.5.8 active sidecar 进程 CommandChild 全局表 (per-session).
/// 让 FE 端 invoke (send_rpc_command) 能写到指定 session 的 stdin.
/// task 结束 (agent_end) 时移除 entry, 避免悬空 handle.
pub struct ActiveSidecars(pub Mutex<HashMap<String, CommandChild>>);

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
    /// v0.4.4 Skills (Pi SDK 暴露): FE 维护 enabled skill names, sidecar 走 formatSkillsForPrompt
    ///   注入 system prompt. enabled 改变必须重启 sidecar (D165 systemPrompt 不可动态改).
    #[serde(default)]
    pub skills: Option<SkillsConfig>,
    /// v0.4.4.6 model metadata: type / vision / contextWindow / maxOutput / maxRounds / reasoning.
    ///   FE 从 configStore.activeModel 读, sidecar 拼到 user-custom model object
    ///   (内置 provider 走 Pi SDK catalog 不需要). 缺省 → sidecar 用 hardcoded 默认值.
    #[serde(default)]
    pub model_metadata: Option<ModelMetadataConfig>,
    /// v0.4.6.1 Multi-agent persona: 当前 active agent name + content (从 <ws>/.pi/agents/<name>.md 读)
    ///   sidecar 启动时拼到 appendSystemPromptOverride 注入 system prompt.
    ///   切主 agent → sidecar 走 session 重建 path (Pi SDK 0.84.2 不支持 in-place 改 system prompt,
    ///   详见 ADR-0024 + D183 v3 现场重演). 缺省 → 没有 active agent, 不拼.
    #[serde(default)]
    pub active_agent: Option<ActiveAgentConfig>,
}

/// v0.4.6.1 Multi-agent persona: 当前 active agent name + body content.
///   sidecar 启动时读 <ws>/.pi/active_agent.json 拿 name, 读 <ws>/.pi/agents/<name>.md 拿 body.
#[derive(Debug, Clone, Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveAgentConfig {
    /// agent name (跟 <ws>/.pi/agents/<name>.md 文件名一致, 1-64 char)
    pub name: String,
    /// body (frontmatter 后面的 markdown, 已经是 raw content)
    pub body: String,
}

/// v0.4.4 Skills (Pi SDK 暴露): enabled skill names + 额外 skill paths.
#[derive(Debug, Clone, Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillsConfig {
    #[serde(default)]
    pub enabled_names: Vec<String>,
    #[serde(default)]
    pub extra_paths: Vec<String>,
}

/// v0.4.4.6 model metadata (Pi SDK 0.84.2 ModelDefinitionSchema 简化白名单).
#[derive(Debug, Clone, Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelMetadataConfig {
    /// 'chat' | 'image' | 'video' | 'audio' | 'embedding'
    #[serde(default)]
    pub model_type: Option<String>,
    /// 是否支持图片输入 (Pi SDK input: ['text', 'image'])
    #[serde(default)]
    pub vision: Option<bool>,
    /// 最大上下文 token (Pi SDK contextWindow)
    #[serde(default)]
    pub context_window: Option<u32>,
    /// 单次回复 token 上限 (Pi SDK maxTokens)
    #[serde(default)]
    pub max_output: Option<u32>,
    /// LLM 连续 tool call 最多多少轮 (我们自己的, Pi SDK 没对应, 后续 Extension 层拦截)
    #[serde(default)]
    pub max_rounds: Option<u32>,
    /// 是否思考模型 (Pi SDK reasoning)
    #[serde(default)]
    pub reasoning: Option<bool>,
}

fn default_permission_mode() -> String {
    "ask".to_string()
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

/// v0.5.8: 启动 sidecar 走 Tauri 2 标准 sidecar 机制 (D172).
///   `app.shell().sidecar("pi-agent-sidecar")` 由 bundle.externalBin 声明,
///   capabilities/default.json 的 shell:allow-spawn 授权, 自动 resolve 到:
///     - dev:  <project_root>/sidecar/dist/pi-agent-sidecar.exe (Tauri 开发模式)
///     - prod: <install_dir>/pi-agent-sidecar-x86_64-pc-windows-msvc.exe (MSI/NSIS 部署)
///   不再需要 find_sidecar_script() 写死编译时绝对路径 (v0.5.6 commit 115959e 的反模式).
///
/// argv[1] 传 config JSON, 初始 RpcCommand 走 child.write() 写到 stdin.
pub fn run_prompt(
    app: AppHandle,
    config: SidecarConfig,
    session_id: String,
    initial_command_json: String,
    active: Arc<ActiveSidecars>,
) {
    debug_log(&format!("run_prompt: session={session_id}"));
    tauri::async_runtime::spawn(async move {
        // v0.5.0: config 走 argv[1] (跟 Pi SDK main.ts pattern 一致)
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
            "skills": config.skills,        // v0.4.4 Skills (Pi SDK 暴露)
            "modelMetadata": config.model_metadata,  // v0.4.4.6 model metadata
            "activeAgent": config.active_agent,      // v0.4.6.1 multi-agent persona
        })) {
            Ok(s) => s,
            Err(e) => {
                emit_error(&app, &session_id, &format!("ser config: {e}"));
                return;
            }
        };

        // v0.5.8: 走 Tauri 2 标准 sidecar API. ShellExt 提供 app.shell(), 返回
        //   tauri_plugin_shell::Shell struct, .sidecar(name) 返回 Command struct.
        //   .args([config_arg]) 透传 config JSON 到 argv[1] (bun compiled .exe 行为).
        //   .spawn() 返回 Result<(Receiver<CommandEvent>, CommandChild), Error>.
        let (mut rx, mut child) = match app
            .shell()
            .sidecar("pi-agent-sidecar")
            .map_err(|e| format!("get sidecar handle: {e}"))
            .and_then(|cmd| {
                cmd.args([config_arg])
                    .spawn()
                    .map_err(|e| format!("spawn sidecar: {e}"))
            }) {
            Ok(pair) => {
                debug_log(&format!("sidecar spawned, session={session_id}"));
                pair
            }
            Err(e) => {
                debug_log(&format!("spawn sidecar failed: {e}"));
                emit_error(&app, &session_id, &format!("spawn sidecar failed: {e}"));
                return;
            }
        };

        // v0.5.8: 写初始 RpcCommand 到 stdin (CommandChild.write 是 sync method,
        //   内部用 BufWriter flush, 不会阻塞 event loop).
        let line = format!("{initial_command_json}\n");
        if let Err(e) = child.write(line.as_bytes()) {
            emit_error(&app, &session_id, &format!("write initial command: {e}"));
            return;
        }

        // 注册 CommandChild 到 active map, 让 FE 端 send_rpc_command 找得到.
        {
            let mut map = active.0.lock().await;
            map.insert(session_id.clone(), child);
        }
        debug_log(&format!(
            "run_prompt: wrote initial RpcCommand, child registered to active map"
        ));

        // v0.5.8: 主 task 循环 Receiver<CommandEvent>, 替代之前 BufReader 读 stdout.
        //   CommandEvent 枚举: Stdout(Vec<u8>) / Stderr(Vec<u8>) / Error(String) /
        //   Terminated(TerminatedPayload { code, signal }).
        let mut got_agent_end = false;
        let mut event_count = 0u32;
        while let Some(event) = rx.recv().await {
            event_count += 1;
            match event {
                CommandEvent::Stdout(bytes) => {
                    let line = String::from_utf8_lossy(&bytes);
                    debug_log(&format!("stdout[{event_count}]: {line}"));
                    log::info!("[sidecar:{session_id}] {line}");
                    if line.trim().is_empty() {
                        continue;
                    }
                    let mut event_json: serde_json::Value =
                        match serde_json::from_str(line.as_ref()) {
                            Ok(v) => v,
                            Err(e) => {
                                log::warn!("[sidecar:{session_id}] bad json: {e} line={line}");
                                continue;
                            }
                        };
                    // 注入 sessionId 给 frontend dispatch (RpcEvent 自身没 sessionId 字段)
                    if let Some(obj) = event_json.as_object_mut() {
                        obj.insert("sessionId".to_string(), serde_json::json!(session_id));
                    }
                    let event_type = event_json
                        .get("type")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    if let Err(e) = app.emit("chat:event", &event_json) {
                        log::error!("emit failed: {e}");
                    }
                    if event_type == "agent_end" {
                        got_agent_end = true;
                        break;
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    let line = String::from_utf8_lossy(&bytes);
                    debug_log(&format!("stderr: {line}"));
                    log::warn!("[sidecar stderr:{session_id}] {line}");
                }
                CommandEvent::Error(s) => {
                    log::error!("[sidecar err:{session_id}] {s}");
                    debug_log(&format!("CommandEvent::Error: {s}"));
                }
                CommandEvent::Terminated(payload) => {
                    debug_log(&format!(
                        "sidecar terminated: code={:?} signal={:?}",
                        payload.code, payload.signal
                    ));
                    log::info!(
                        "[sidecar:{session_id}] terminated code={:?} signal={:?}",
                        payload.code,
                        payload.signal
                    );
                    break;
                }
                _ => {
                    // 其他 event variant (目前 shell plugin 没暴露更多, 占位)
                }
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

        // 从 active map 移除 child (Agent 自然结束, 后续 RpcCommand 不应到达)
        {
            let mut map = active.0.lock().await;
            map.remove(&session_id);
        }
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
///
/// v0.5.8: child.write() 是 sync (CommandChild 内部 BufWriter, 不阻塞).
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
    let child = map
        .get_mut(&session_id)
        .ok_or_else(|| format!("no active sidecar for session={}", session_id))?;
    let line = format!("{}\n", command_json);
    child
        .write(line.as_bytes())
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
