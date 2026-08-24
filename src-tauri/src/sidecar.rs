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
use std::sync::OnceLock;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
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
    // v0.5.0-v0.1: 删 active_agent 字段 (multi-agent persona 回滚, 详见 ADR-0024 superseded by ADR-0025)
}

// v0.5.0-v0.1: 删 ActiveAgentConfig struct (multi-agent persona 回滚)

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
    // ADR-0022: 启动 sidecar 浏览器请求轮询 (处理 web_navigate / web_get_text tool)
    crate::sidecar::ensure_browser_watcher(app.clone());
    // ADR-0023 P3-G: external tool config 改 → silent restart (跟 UI save 同一路径)
    crate::sidecar::ensure_external_tools_watcher(app.clone());
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
            // v0.5.0-v0.1: 删 activeAgent 字段 (multi-agent persona 回滚)
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

                // ADR-0020 P-Sec1 (2026-08-23): 把 sidecar 进程 attach 到全局 sandbox Job
                //   - 限制: 1GB mem / 进程, 100 子进程, 1 核 CPU hard cap
                //   - 失败不阻塞主流程 (降级到 P0-2 baseline, 记 stderr)
                let pid = pair.1.pid();
                if let Err(e) = crate::sandbox::attach_pid_to_job(pid) {
                    log::warn!("[sandbox] attach pid {pid} to Job failed: {e} (sandbox 降级到 P0-2 baseline)");
                    debug_log(&format!("sandbox attach failed: {e}"));
                }
                pair
            }
            Err(e) => {
                debug_log(&format!("spawn sidecar failed: {e}"));
                emit_error(&app, &session_id, &format!("spawn sidecar failed: {e}"));
                return;
            }
        };

        // v3.35 (2026-08-24): 回滚到 v3.32 sync child.write() 阻塞.
        //   v3.33 (thread spawn) 跟 v3.34 (chunked helper) 都没解 vision 死锁:
        //     - v3.33: 0.4s 写完 130KB, sidecar 0.4s 启动期间 stdin pipe 130KB 已满 → sidecar 启动 hang → exit 1
        //     - v3.34: 0.32s 写 48KB 期间 sidecar 0.4s 启动 hang (同样 race)
        //   真正稳的行为: Tauri sync 阻塞 1 分写完 130KB, 期间 sidecar 0.4s 启动 OK (stdin pipe 一直是空的),
        //     1 分后 Tauri 写完, sidecar 早就 ready → vision 通.
        //   关键: vision LLM API 本身 1 分, user 感知不到 Tauri 多阻塞 1 分.
        //   v3.33/v3.34 我之前以为"修了 1 分阻塞", 实际暴露了 race, 现在承认局限回滚.
        let line = format!("{initial_command_json}\n");
        debug_log(&format!(
            "run_prompt: writing initial RpcCommand sync, line_len={}",
            line.len()
        ));
        if let Err(e) = child.write(line.as_bytes()) {
            emit_error(&app, &session_id, &format!("write initial command: {e}"));
            return;
        }
        debug_log(&format!(
            "run_prompt: initial RpcCommand written, registering child to map"
        ));

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

/// Bug #2 修 (2026-08-18): force-spawn 跑 compact
/// 跟 run_prompt 几乎一样, 但:
///   - 不注册到 ActiveSidecars (compact 是 fire-and-forget, 完即退, 不需要后续 send_rpc_command)
///   - 初始命令是 { type: 'compact' } (不是 prompt)
///   - 退出条件是 `compaction_end` event (compact 走 LLM 总结, 不发 agent_end)
/// 背景: send_rpc_command 走 ActiveSidecars 找 child, 闲置 session 时 map 已空, 报
///   "no active sidecar for session=..." → FE 视觉"点了没反应". force-spawn 单独跑 compact
///   跟 prompt 解耦, 不依赖当前 session 是否在 active.
pub fn run_compact(
    app: AppHandle,
    config: SidecarConfig,
    session_id: String,
    active: Arc<ActiveSidecars>,
) {
    debug_log(&format!("run_compact: session={session_id}"));
    crate::sidecar::ensure_browser_watcher(app.clone());
    crate::sidecar::ensure_external_tools_watcher(app.clone());
    tauri::async_runtime::spawn(async move {
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
            "skills": config.skills,
            "modelMetadata": config.model_metadata,
        })) {
            Ok(s) => s,
            Err(e) => {
                emit_error(&app, &session_id, &format!("ser config: {e}"));
                return;
            }
        };

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
                debug_log(&format!("compact sidecar spawned, session={session_id}"));

                // ADR-0020 P-Sec1: attach to sandbox Job (跟 run_prompt 一样)
                let pid = pair.1.pid();
                if let Err(e) = crate::sandbox::attach_pid_to_job(pid) {
                    log::warn!("[sandbox] attach compact pid {pid} to Job failed: {e}");
                }
                pair
            }
            Err(e) => {
                debug_log(&format!("spawn compact sidecar failed: {e}"));
                emit_error(&app, &session_id, &format!("spawn sidecar failed: {e}"));
                return;
            }
        };

        // 写初始 compact RpcCommand (不带 id, Pi SDK 用默认 routing)
        let initial = serde_json::json!({ "type": "compact" });
        let line = match serde_json::to_string(&initial) {
            Ok(s) => format!("{s}\n"),
            Err(e) => {
                emit_error(&app, &session_id, &format!("ser compact cmd: {e}"));
                return;
            }
        };
        if let Err(e) = child.write(line.as_bytes()) {
            emit_error(&app, &session_id, &format!("write compact cmd: {e}"));
            return;
        }

        // ⚠️ 不注册到 ActiveSidecars (compact 独立 fire-and-forget)

        let mut got_compaction_end = false;
        let mut event_count = 0u32;
        while let Some(event) = rx.recv().await {
            event_count += 1;
            match event {
                CommandEvent::Stdout(bytes) => {
                    let line = String::from_utf8_lossy(&bytes);
                    debug_log(&format!("compact stdout[{event_count}]: {line}"));
                    log::info!("[sidecar:compact:{session_id}] {line}");
                    if line.trim().is_empty() {
                        continue;
                    }
                    let mut event_json: serde_json::Value =
                        match serde_json::from_str(line.as_ref()) {
                            Ok(v) => v,
                            Err(e) => {
                                log::warn!("[sidecar:compact:{session_id}] bad json: {e} line={line}");
                                continue;
                            }
                        };
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
                    // compact 退出条件: compaction_end (走 LLM 总结替换 history, 不发 agent_end)
                    if event_type == "compaction_end" {
                        got_compaction_end = true;
                        break;
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    let line = String::from_utf8_lossy(&bytes);
                    debug_log(&format!("compact stderr: {line}"));
                    log::warn!("[sidecar:compact stderr:{session_id}] {line}");
                }
                CommandEvent::Error(s) => {
                    log::error!("[sidecar:compact err:{session_id}] {s}");
                    debug_log(&format!("compact CommandEvent::Error: {s}"));
                }
                CommandEvent::Terminated(payload) => {
                    debug_log(&format!(
                        "compact sidecar terminated: code={:?} signal={:?}",
                        payload.code, payload.signal
                    ));
                    break;
                }
                _ => {}
            }
        }

        if !got_compaction_end {
            log::warn!("[sidecar:compact:{session_id}] stream ended without compaction_end");
            // 补发一个 compaction_end 避免 FE UI 永远显示"压缩中"
            let end = serde_json::json!({
                "type": "compaction_end",
                "sessionId": session_id,
                "reason": "stream_ended",
                "aborted": false,
                "willRetry": false,
                "errorMessage": "压缩流程异常结束, 请重试",
            });
            let _ = app.emit("chat:event", &end);
        }

        // 主动 kill child (force 结束, 避免 hang)
        let _ = child.kill();
        log::info!("[sidecar:compact:{session_id}] done, killed");

        // 防御性清理: 万一 active map 还有这个 sid 的 child (理论上没有)
        {
            let mut map = active.0.lock().await;
            map.remove(&session_id);
        }
    });
}

/// v0.4.6 Bug 修 (abort 后重发继续走): force kill sidecar child.
/// 背景: spawn-per-prompt 模式下, abort 触发后 Pi SDK 应该 emit agent_end 然后 sidecar
///   退出. 但实际在某些 provider (MiniMax / DeepSeek V4 Flash) 上 agent_end 偶尔 lost,
///   30s 兜底 forceStopStreaming 翻 streaming=false 但旧 sidecar 还在跑, AgentSession state
///   还在 hold. 下次 send_prompt 启新 sidecar 时, 如果 piSessionId 复用,resume 加载旧
///   jsonl 看到 incomplete message → "顺着我前面打断的继续往下走".
/// 修法: forceStop 时调这个 invoke, kill 旧 child + 主动移除 active map entry.
/// 副作用: 旧 sidecar 不会 emit agent_end, FE 30s 兜底已经 force 翻 streaming=false, 所以
///   用户视觉无差异.
#[tauri::command]
pub async fn kill_sidecar(
    session_id: String,
    active: State<'_, Arc<ActiveSidecars>>,
) -> Result<bool, String> {
    let mut map = active.0.lock().await;
    let existed = if let Some(mut child) = map.remove(&session_id) {
        log::warn!("[sidecar] kill_sidecar: session={} killing child", session_id);
        // child.kill() 是 sync, 内部用 Child::kill (Windows TerminateProcess)
        let _ = child.kill();
        true
    } else {
        log::info!("[sidecar] kill_sidecar: session={} no active child (already exited?)", session_id);
        false
    };
    Ok(existed)
}

/// ADR-0023 (2026-08-23): 静默重启所有 active sidecar
///
/// 触发场景: 改了"需要重启"的配置 (MCP server / external tool / dangerousWhitelist / bash.path
///   / system prompt override / user tool preset), Pi SDK 0.84.2 的 tool 注册只在
///   createAgentSession 时一次, 必须新 sidecar 进程才生效.
///
/// 实现: 列 `ActiveSidecars` map, 对每个 child kill (Windows TerminateProcess),
///   移除 map entry. 下次 send_prompt 时 Tauri run_prompt 走 lazy spawn 路径,
///   读新 config 起新 sidecar. FE 无感 (1-2 秒, 不弹 modal).
///
/// 副作用: 正在 streaming 的 LLM 响应会被断掉, run_prompt task 走 "stream ended
///   without agent_end" 路径发 synthesized agent_end (line 308), FE 收到后
///   弹 "response interrupted by restart" 提示 (跟正常 error 一样的视觉).
///
/// 同时 emit `sidecar:restart` 事件 (全局), FE 监听这个事件弹 "已保存, 新配置将在
///   下次对话生效" toast (跟 agent_end 事件解耦, 即使没 active sidecar 也能感知).
///
/// @param reason 给 log + FE 弹 toast 用的描述 (e.g. "mcp_server_changed")
/// @returns killed count (u32), FE 可选择性忽略
#[tauri::command]
pub async fn restart_all_sidecars(
    reason: String,
    active: State<'_, Arc<ActiveSidecars>>,
    app: AppHandle,
) -> Result<u32, String> {
    let mut map = active.0.lock().await;
    let session_ids: Vec<String> = map.keys().cloned().collect();
    let count = session_ids.len() as u32;
    log::info!("[sidecar] restart_all_sidecars: reason={reason} killing {count} sidecar(s)");
    for session_id in &session_ids {
        if let Some(mut child) = map.remove(session_id) {
            log::warn!(
                "[sidecar] restart_all_sidecars: session={session_id} killing (reason={reason})"
            );
            let _ = child.kill();
            // 注意: 不要在这里 emit agent_end. run_prompt task 自己会 emit synthesized
            //   agent_end 走 stream-ended-without-agent_end 路径. 那个事件已经被 FE
            //   处理为 streaming=false + error indicator, 跟"被 restart 打断"是
            //   一样的视觉, 没必要多发一次.
        } else {
            log::info!("[sidecar] restart_all_sidecars: session={session_id} not in map (race?)");
        }
    }
    // 全局事件: 通知 FE "已经 restart, 新配置下次 send_prompt 生效"
    let event = serde_json::json!({
        "type": "sidecar_restarted",
        "reason": reason,
        "killed": count,
        "timestamp": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0),
    });
    if let Err(e) = app.emit("sidecar:event", &event) {
        log::error!("[sidecar] restart_all_sidecars: emit sidecar:event failed: {e}");
    }
    Ok(count)
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
    // v3.35 (2026-08-24): 跟 run_prompt 同步回滚到 v3.32 sync write.
    //   跟 run_prompt 同样理由: 写 stdin 跟 sidecar 启动没同步, sync 阻塞 1 分期间 sidecar 启动 OK.
    //   后续 RpcCommand 一般小 (1-10KB), sync write 几 ms 完, 实际不阻塞. 一致性也保留.
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

// ====== ADR-0022 (2026-08-23): WebView2 内嵌浏览器 — sidecar 触发入口 ======
// 背景: sidecar 的 stdin/stdout 是 Pi SDK runRpcMode 100% 管控, 没法 reverse RPC
//   (没法在 stdout 插 tauri_call 这种结构). 所以 sidecar → Tauri 的浏览器命令走
//   "文件队列":
//   - sidecar 写 <agentDir>/browser_request.json = { id, command, args }
//   - 这边 watcher 100ms 轮询, 看到了就 dispatch 到 browser_navigate /
//     browser_get_text / browser_get_url, 写结果到 <agentDir>/browser_response.json
//   - sidecar 看到 response 文件就 resolve, unlink
//   (id 匹配防 stale 串, 跟 sidecar 那边 callTauriCommand 的协议对得上)
//
// 单例: Tauri 进程只起一个 watcher 任务, 多次 run_prompt / run_compact 调用
//   ensure_browser_watcher 不会重复 spawn. OnceLock<()> 简单够用 (不像 tokio Mutex
//   需要 .lock().await 才能 check).

static BROWSER_WATCHER_INIT: OnceLock<()> = OnceLock::new();

pub fn ensure_browser_watcher(app: AppHandle) {
    // 单 spawn 守卫
    if BROWSER_WATCHER_INIT.get().is_some() {
        return;
    }
    if BROWSER_WATCHER_INIT.set(()).is_err() {
        // 竞争输了, 别人已经 spawn, 不用再起
        return;
    }

    tauri::async_runtime::spawn(async move {
        // 1. 算路径: <HOME>/.pi/agent/browser_{request,response}.json
        //    跟 lib.rs::pi_settings_path 算的是同一个 agent_dir, 但这边不依赖那个
        //    私有函数, 自己重算 (跨模块共享路径容易耦合坏).
        let home = match app.path().home_dir() {
            Ok(h) => h,
            Err(e) => {
                log::error!("[browser] watcher: home_dir failed: {e}");
                return;
            }
        };
        let agent_dir = home.join(".pi").join("agent");
        let req_path = agent_dir.join("browser_request.json");
        let res_path = agent_dir.join("browser_response.json");
        // 2. 确保 agent_dir 存在 (settings.json 同目录, 正常情况下已在; 兜底)
        if let Err(e) = std::fs::create_dir_all(&agent_dir) {
            log::error!("[browser] watcher: create_dir_all failed: {e}");
            return;
        }
        log::info!(
            "[browser] watcher started, req={} res={}",
            req_path.display(),
            res_path.display()
        );

        // 3. 主轮询循环 — 100ms 一次
        loop {
            tokio::time::sleep(Duration::from_millis(100)).await;
            // 3.1 读 request 文件 — 不存在就下一轮
            let content = match std::fs::read_to_string(&req_path) {
                Ok(c) => c,
                Err(_) => continue,
            };
            // 3.2 解析 JSON, 坏了就删文件防卡死, 下一轮
            let req: serde_json::Value = match serde_json::from_str(&content) {
                Ok(v) => v,
                Err(e) => {
                    log::warn!("[browser] watcher: bad request json: {e} content={content}");
                    let _ = std::fs::remove_file(&req_path);
                    continue;
                }
            };
            let id = req
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let command = req
                .get("command")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let args = req.get("args").cloned().unwrap_or_else(|| serde_json::json!({}));
            if id.is_empty() || command.is_empty() {
                log::warn!("[browser] watcher: missing id/command in request, drop");
                let _ = std::fs::remove_file(&req_path);
                continue;
            }
            // 3.3 立刻删 request, 避免被下一次轮询重复处理
            //    (sidecar 等 response 期间不会重写 request, 删了不冲突)
            if let Err(e) = std::fs::remove_file(&req_path) {
                log::warn!("[browser] watcher: remove_file failed: {e}");
            }
            log::info!("[browser] watcher: dispatch id={id} cmd={command}");

            // 3.4 dispatch — 调用 lib.rs 里现成的 browser_navigate / get_text / get_url
            //    这些都是 #[tauri::command] + pub async fn, 走 crate:: 直接调
            //    v0.6.3-rc1 P3-C: 加 resolve_secrets, 跟 browser_* 共用同一文件队列
            //    (browser_request.json 名字历史遗留, 现在是 generic tauri_call 通道)
            let (result, error): (Option<serde_json::Value>, Option<String>) = match command.as_str() {
                "browser_navigate" => {
                    let url = args
                        .get("url")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    if url.is_empty() {
                        (None, Some("missing args.url".to_string()))
                    } else {
                        match crate::browser_navigate(app.clone(), url).await {
                            Ok(text) => (Some(serde_json::Value::String(text)), None),
                            Err(e) => (None, Some(e)),
                        }
                    }
                }
                "browser_get_text" => match crate::browser_get_text(app.clone()).await {
                    Ok(text) => (Some(serde_json::Value::String(text)), None),
                    Err(e) => (None, Some(e)),
                },
                "browser_get_url" => match crate::browser_get_url(app.clone()).await {
                    Ok(url) => (Some(serde_json::Value::String(url)), None),
                    Err(e) => (None, Some(e)),
                },
                "browser_screenshot" => match crate::browser_screenshot(app.clone()).await {
                    Ok(b64) => (Some(serde_json::Value::String(b64)), None),
                    Err(e) => (None, Some(e)),
                },
                // ADR-0023 P3-C: sidecar 发来一批 env value, 解析 keychain: 引用返明文
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
                other => (None, Some(format!("unknown command: {other}"))),
            };

            // 3.5 写 response — 失败只能 log, 没法 retry (没 ack 机制)
            let response = if let Some(err) = error {
                serde_json::json!({ "id": id, "error": err })
            } else {
                serde_json::json!({ "id": id, "result": result })
            };
            match std::fs::write(
                &res_path,
                serde_json::to_string(&response).unwrap_or_default(),
            ) {
                Ok(_) => log::info!("[browser] watcher: response id={id} sent"),
                Err(e) => log::error!("[browser] watcher: write response failed: {e}"),
            }
        }
    });
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

// ====== 2026-08-24 ADR-0023 P3-G: external tool config 热重载 watcher ======
// 背景: sidecar 端 externalToolsWatcher 监听 <agentDir>/tools/external/*/manifest.json +
//   <workspace>/.pi/tools/external/*/manifest.json, debounce 300ms 后调 callback, callback
//   写 <agentDir>/external_tools_restart_request.json (跟 browser_request 一样的 file queue 风格).
//   原因: Pi SDK 0.84.2 tool 注册只在 createAgentSession 时一次, 不能 mid-session 替换.
//   跟 mcpWatcher 不一样: mcpWatcher 触发后走 reloadMcpSubsystem 替换 mcpState.customTools
//   (LLM 下一轮 turn 看到, 因为 mcp watcher reload 跟 createAgentSession 同源); external tool
//   必须 kill 老 sidecar + spawn 新 sidecar 才能让 LLM 看到新 tool list.
//
// 单例 + 100ms 轮询 + atomic 处理 (跟 ensure_browser_watcher 同 pattern).
static EXTERNAL_TOOLS_WATCHER_INIT: OnceLock<()> = OnceLock::new();

pub fn ensure_external_tools_watcher(app: AppHandle) {
    if EXTERNAL_TOOLS_WATCHER_INIT.get().is_some() {
        return;
    }
    if EXTERNAL_TOOLS_WATCHER_INIT.set(()).is_err() {
        return;
    }

    tauri::async_runtime::spawn(async move {
        let home = match app.path().home_dir() {
            Ok(h) => h,
            Err(e) => {
                log::error!("[external_tools] watcher: home_dir failed: {e}");
                return;
            }
        };
        let agent_dir = home.join(".pi").join("agent");
        let req_path = agent_dir.join("external_tools_restart_request.json");
        if let Err(e) = std::fs::create_dir_all(&agent_dir) {
            log::error!("[external_tools] watcher: create_dir_all failed: {e}");
            return;
        }
        log::info!("[external_tools] watcher started, req={}", req_path.display());

        loop {
            tokio::time::sleep(Duration::from_millis(100)).await;
            // 1. 读 request 文件 — 不存在就下一轮
            let content = match std::fs::read_to_string(&req_path) {
                Ok(c) => c,
                Err(_) => continue,
            };
            // 2. 解析 + 立刻删文件, 防下一轮重复处理
            let req: serde_json::Value = match serde_json::from_str(&content) {
                Ok(v) => v,
                Err(e) => {
                    log::warn!("[external_tools] watcher: bad request json: {e}");
                    let _ = std::fs::remove_file(&req_path);
                    continue;
                }
            };
            let reason = req
                .get("reason")
                .and_then(|v| v.as_str())
                .unwrap_or("external_tool_changed")
                .to_string();
            if let Err(e) = std::fs::remove_file(&req_path) {
                log::warn!("[external_tools] watcher: remove_file failed: {e}");
            }
            log::info!("[external_tools] watcher: restart requested (reason={reason})");

            // 3. 调 restart_all_sidecars — 跟 FE 调 silent restart 走同一路径
            //    拿 active map 的 Arc clone, 不需要 Tauri State
            let active = app
                .state::<std::sync::Arc<ActiveSidecars>>()
                .inner()
                .clone();
            let mut map = active.0.lock().await;
            let session_ids: Vec<String> = map.keys().cloned().collect();
            let count = session_ids.len() as u32;
            log::info!(
                "[external_tools] watcher: killing {count} sidecar(s) (reason={reason})"
            );
            for session_id in &session_ids {
                if let Some(mut child) = map.remove(session_id) {
                    log::warn!(
                        "[external_tools] watcher: killing session={session_id} (reason={reason})"
                    );
                    let _ = child.kill();
                }
            }
            // emit sidecar:event 跟 FE 走同样 toast 链路 (App.vue 监听 type==sidecar_restarted 弹 toast)
            // reason 前面拼前缀, 让 user 看出 "改了 external tool 触发的" 而不是普通改 MCP
            let event = serde_json::json!({
                "type": "sidecar_restarted",
                "reason": format!("external_tool_manifest_changed:{reason}"),
                "killed": count,
                "timestamp": std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0),
            });
            if let Err(e) = app.emit("sidecar:event", &event) {
                log::error!("[external_tools] watcher: emit failed: {e}");
            }
        }
    });
}
