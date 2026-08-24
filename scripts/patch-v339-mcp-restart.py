#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v3.39 patch: MCP 配置改动走 silent restart (跟 external tool 一样).
- 修 installExternalToolsWatcher orphan code block (缺 function 头)
- 改 installMcpWatcher 不调 reloadMcpSubsystem (实际无效, Pi SDK tool 白名单 freeze),
  改写 external_tools_restart_request.json (跟 external 一样, 走 silent restart)
- 提取共用 writeRestartRequest helper (避免重复)

背景 (v3.39 commit):
  - 之前 v3.22 引入 MCP hot reload 走 reloadMcpSubsystem, 注释说 "Pi SDK 0.84.2 不支持
    mid-conversation 改 tool 白名单, 新的 tool 会在 LLM 下一轮 turn 看到" — 实际错的.
  - 实测: Pi SDK createAgentSession 时 freeze tool 白名单, mcpState.customTools 改
    LLM 永远看不到. reloadMcpSubsystem 实际无效.
  - v3.22 external tool watcher 走 silent restart 路径 (写 file queue → Tauri kill sidecar)
    是对的. v3.39 让 MCP 也走同一路径.
  - 副作用: 之前 user 改 MCP config 后 reloadMcpSubsystem 实际无效, LLM 看不到新 tool
    (user 报告 "MCP 配置后的热更失效了" 就是这个 bug).
"""
import os

path = "sidecar/src/index.mjs"
with open(path, "r", encoding="utf-8") as f:
    src = f.read()

# 1. 提取 writeRestartRequest helper (放在 installMcpWatcher 之前, 跟 reloadMcpSubsystem 同 module-level)
#    跟 installExternalToolsWatcher 写同样 file, 只是 reason 不同.
#    实际上 installExternalToolsWatcher 用了 atomic write (.tmp + rename), 共用 helper.
helper_block = '''
// ====== v3.39 (2026-08-24): 共用 writeRestartRequest helper ======
//   跟 installExternalToolsWatcher 写同样 file queue (external_tools_restart_request.json).
//   reason 区分: 'mcp_config_changed' / 'external_tool_changed' / 'user_force_retest'.
//   之前 reloadMcpSubsystem 走 mid-session reload, 实际 Pi SDK 0.84.2 tool 白名单 freeze,
//   reloadMcpSubsystem 不真生效. 改 silent restart (跟 external tool 一样).
function writeRestartRequest(agentDir, reason) {
  const externalRestartReqPath = join(agentDir, 'external_tools_restart_request.json');
  try {
    const payload = JSON.stringify({
      ts: Date.now(),
      reason,
    });
    // atomic write: 写 .tmp 再 rename, 防 Tauri 读到半截 JSON
    const tmp = externalRestartReqPath + '.tmp';
    writeFileSync(tmp, payload, 'utf-8');
    try {
      renameSync(tmp, externalRestartReqPath);
    } catch (renameErr) {
      // rename 失败 (Tauri 正在读?), 回退直接写 (Tauri 那侧 JSON.parse 失败会 skip, 安全)
      writeFileSync(externalRestartReqPath, payload, 'utf-8');
    }
    console.error(`[sidecar] v3.39: external_tools_restart_request written (reason=${reason}, ts=${Date.now()})`);
  } catch (e) {
    console.error('[sidecar] v3.39: write restart request failed:', e instanceof Error ? e.message : String(e));
  }
}

'''

# 找 installMcpWatcher 之前插入 helper
install_mcp_marker = "function installMcpWatcher() {"
idx = src.find(install_mcp_marker)
if idx < 0:
    raise SystemExit("installMcpWatcher not found")
src = src[:idx] + helper_block + src[idx:]

# 2. 改 installMcpWatcher callback: reloadMcpSubsystem() → writeRestartRequest('mcp_config_changed')
#    (atomic, 改 mcpState.customTools reload 不真生效, silent restart 是真治法)
old_mcp_callback = '''function installMcpWatcher() {
  // 先关旧的 (理论上只有 createAgentSession 走一次, 防御)
  if (mcpState.watcherClose) {
    try { mcpState.watcherClose(); } catch { /* ignore */ }
  }
  const handle = watchMcpConfigDirs(mcpState.workspacePath, mcpState.agentDir, () => {
    // fire-and-forget: watcher callback 是同步的, reload 是 async
    reloadMcpSubsystem().catch((e) => {
      console.error('[sidecar] P2-2: reload failed:', e instanceof Error ? e.message : String(e));
    });
  });
  mcpState.watcherClose = handle.close;
}'''
new_mcp_callback = '''function installMcpWatcher() {
  // 先关旧的 (理论上只有 createAgentSession 走一次, 防御)
  if (mcpState.watcherClose) {
    try { mcpState.watcherClose(); } catch { /* ignore */ }
  }
  const handle = watchMcpConfigDirs(mcpState.workspacePath, mcpState.agentDir, () => {
    // v3.39 (2026-08-24): 改 silent restart (跟 external tool 一样)
    //   之前 reloadMcpSubsystem 走 mid-session reload, 实际 Pi SDK 0.84.2 tool 白名单
    //   freeze, LLM 看不到新 tool. silent restart 走 file queue → Tauri 端 kill sidecar
    //   → 下次 send_prompt lazy spawn 新 sidecar, createAgentSession 读新 MCP config.
    //   实际 reloadMcpSubsystem 注释说 "下一轮 turn 看到新 tool" 实际错的.
    writeRestartRequest(mcpState.agentDir, 'mcp_config_changed');
  });
  mcpState.watcherClose = handle.close;
}'''
if old_mcp_callback not in src:
    raise SystemExit("old_mcp_callback not found")
src = src.replace(old_mcp_callback, new_mcp_callback)

# 3. 加 function 头 (line 1834 orphan block) + 改用 writeRestartRequest helper
#    之前 line 1834 `{ const externalRestartReqPath = ...` 是 orphan block, 没 function 头, 永远不执行.
#    加 function 头 `function installExternalToolsWatcher(workspacePath, agentDir) {`
#    改用 writeRestartRequest helper 避免重复
old_orphan = '''// ====== 2026-08-24 ADR-0023 P3-G: external tool config dir 热重载 watcher ======
//   跟 mcpWatcher 100% 同 pattern, 但 reload 路径不同:
//   - MCP: 走 reloadMcpSubsystem() (kill clients + 重 init + 替换 mcpState, Pi SDK 下一轮 turn 看到新 tool)
//   - external: Pi SDK 0.84.2 tool 注册只在 createAgentSession 时一次, 不能 mid-session 替换.
//     修法: watcher 触发后写 <agentDir>/external_tools_restart_request.json, Tauri 端
//     ensure_external_tools_watcher 100ms 轮询看到 → 调 restart_all_sidecars("external_tool_manifest_changed").
//     走 file queue 而不 emit stdout: 此刻 runRpcMode 已经接管 stdout, write 会被吞.
//     writeFileSync 走 fs, 跟 stdout 无关, 安全.
//
//   emit reason: "manifest_modified" / "tool_added" / "tool_removed" — 都 restart, 不区分细节
//   (区分没意义, restart 后新 sidecar 自然读到最新状态).
{
  const externalRestartReqPath = join(agentDir, 'external_tools_restart_request.json');
  const handle = watchExternalToolsDirs(workspacePath, agentDir, () => {
    try {
      const payload = JSON.stringify({
        ts: Date.now(),
        reason: 'manifest_modified',
      });
      // atomic write: 写 .tmp 再 rename, 防 Tauri 读到半截 JSON
      const tmp = externalRestartReqPath + '.tmp';
      writeFileSync(tmp, payload, 'utf-8');
      try {
        renameSync(tmp, externalRestartReqPath);
      } catch (renameErr) {
        // rename 失败 (Tauri 正在读?), 回退直接写 (Tauri 那侧 JSON.parse 失败会 skip, 安全)
        writeFileSync(externalRestartReqPath, payload, 'utf-8');
      }
      console.error(`[sidecar] P3-G: external_tools_restart_request written (ts=${Date.now()})`);
    } catch (e) {
      console.error('[sidecar] P3-G: write restart request failed:', e instanceof Error ? e.message : String(e));
    }
  });
  // 保存 close 句柄 (sidecar 退出时调, 防止 fd 泄漏 — 跟 mcpState.watcherClose 同样的防御)
  mcpState.externalWatcherClose = handle.close;
  console.error(`[sidecar] P3-G: external tools watcher installed (active=${handle.status.active}, dirs=[${handle.status.dirs.join(', ')}])`);
}'''
new_function = '''// ====== 2026-08-24 ADR-0023 P3-G: external tool config dir 热重载 watcher ======
//   跟 mcpWatcher 100% 同 pattern, reload 路径也跟 v3.39 后 MCP 一样 —
//   watcher 触发后写 <agentDir>/external_tools_restart_request.json, Tauri 端
//   ensure_external_tools_watcher 100ms 轮询看到 → 调 restart_all_sidecars.
//   走 file queue 而不 emit stdout: 此刻 runRpcMode 已经接管 stdout, write 会被吞.
//   writeFileSync 走 fs, 跟 stdout 无关, 安全.
//
// v3.39 (2026-08-24) 修: 之前这函数缺 function 头 (line 1834 orphan code block), 永远不执行!
//   user 改 external tool config 后热更失效就是这个 bug. 加 function 头 + 用 writeRestartRequest helper.
//   reason: 'external_tool_changed' (跟 MCP 'mcp_config_changed' 区分, Tauri 端能区分弹 toast).
function installExternalToolsWatcher(workspacePath, agentDir) {
  const handle = watchExternalToolsDirs(workspacePath, agentDir, () => {
    writeRestartRequest(agentDir, 'external_tool_changed');
  });
  // 保存 close 句柄 (sidecar 退出时调, 防止 fd 泄漏 — 跟 mcpState.watcherClose 同样的防御)
  mcpState.externalWatcherClose = handle.close;
  console.error(`[sidecar] P3-G: external tools watcher installed (active=${handle.status.active}, dirs=[${handle.status.dirs.join(', ')}])`);
}'''
if old_orphan not in src:
    raise SystemExit("old_orphan not found")
src = src.replace(old_orphan, new_function)

# 4. 在 installMcpWatcher 之后调 installExternalToolsWatcher
#    line 720 installMcpWatcher() 后面加
old_install_call = '''  // P2-2: 装 fs watcher, config 改完自动 reload
  installMcpWatcher();'''
new_install_call = '''  // P2-2: 装 fs watcher, config 改完自动 reload (MCP + external 都 silent restart, v3.39 统一)
  installMcpWatcher();
  installExternalToolsWatcher(workspacePath, agentDir);'''
if old_install_call not in src:
    raise SystemExit("old_install_call not found")
src = src.replace(old_install_call, new_install_call)

with open(path, "w", encoding="utf-8") as f:
    f.write(src)
print(f"updated {path}")
