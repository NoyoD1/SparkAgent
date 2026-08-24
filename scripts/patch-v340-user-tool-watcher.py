#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v3.40 patch: 加 user tool file watcher (跟 v3.39 MCP / external 一样 silent restart).
- sidecar/src/index.mjs: 加 installUserToolsWatcher 函数 + 调
- 跟 v3.39 installMcpWatcher / installExternalToolsWatcher 同 pattern

user tool config 路径 (跟 Skills / Commands 同 pattern, workspace 优先):
  - <workspacePath>/.pi/tools/*.json
  - <agentDir>/tools/*.json

跟 external tool 不冲突: external 存 tools/external/*/manifest.json, user 存 tools/*.json.
监听 dir 级别 (覆盖 add/remove/modify 全部情况).

user 直接改 file 之前缺 watcher, silent restart 走 UI 路径 (userTools.write/delete 触发
triggerRestart) 是 work, 但 file 改不 work — user 报告 "MCP 配置后的热更失效了" 同根因,
现在 user tool 也补上.
"""
import os

path = "sidecar/src/index.mjs"
with open(path, "r", encoding="utf-8") as f:
    src = f.read()

# 1. 加 userToolsWatcher.mjs 引用 (跟 mcpWatcher / externalToolsWatcher 平行)
#    实际上外部工具 watcher 已经监听 tools/ 目录, 但 user tool 跟 external tool 路径不同:
#    user tool: <agentDir>/tools/*.json (e.g. tools/my_grep.json)
#    external tool: <agentDir>/tools/external/*/manifest.json
#    安装 installExternalToolsWatcher 只听 tools/external/, 不听 tools/*.json.
#    新加 installUserToolsWatcher 监听 tools/*.json (subdir 也 catch 间接 add/remove)
old_imports = '''// 2026-08-24 ADR-0023 P3-G: external tool config dir 热重载 watcher (跟 mcpWatcher 同 pattern)
import { watchExternalToolsDirs } from './externalToolsWatcher.mjs';'''
new_imports = '''// 2026-08-24 ADR-0023 P3-G: external tool config dir 热重载 watcher (跟 mcpWatcher 同 pattern)
import { watchExternalToolsDirs } from './externalToolsWatcher.mjs';
// v3.40 (2026-08-24): user tool config dir 热重载 watcher (跟 external 同 pattern,
//   但监听 tools/*.json 不含 tools/external/ 子目录)
import { watchUserToolsDirs } from './userToolsWatcher.mjs';'''
if old_imports not in src:
    raise SystemExit("old_imports not found")
src = src.replace(old_imports, new_imports)

# 2. 加 installUserToolsWatcher 函数 (跟 installExternalToolsWatcher 同 pattern)
#    插在 installExternalToolsWatcher 函数定义之后
#    用 watchUserToolsDirs helper (跟 watchMcpConfigDirs / watchExternalToolsDirs 同 pattern)
#    写 restart request (reason: 'user_tool_changed')
#    保存 close 句柄到 mcpState.userToolsWatcherClose
old_ext_func_close = '''  mcpState.externalWatcherClose = handle.close;
  console.error(`[sidecar] P3-G: external tools watcher installed (active=${handle.status.active}, dirs=[${handle.status.dirs.join(', ')}])`);
}'''
new_ext_func_close_with_user = '''  mcpState.externalWatcherClose = handle.close;
  console.error(`[sidecar] P3-G: external tools watcher installed (active=${handle.status.active}, dirs=[${handle.status.dirs.join(', ')}])`);
}

/**
 * v3.40 (2026-08-24): user tool config dir 热重载 watcher
 *
 * 跟 installExternalToolsWatcher 100% 同 pattern, 监听路径不同:
 *   - user tool: <agentDir>/tools/*.json + <workspacePath>/.pi/tools/*.json
 *   - external tool: <agentDir>/tools/external/*/manifest.json (P3-G 之前)
 * 两条 watcher 并存, 各自触发 silent restart, reason 区分:
 *   - 'user_tool_changed' (本函数)
 *   - 'external_tool_changed' (installExternalToolsWatcher)
 *   - 'mcp_config_changed' (installMcpWatcher, v3.39 改 silent restart)
 *
 * user 改 *.json 后 silent restart 走 file queue → Tauri 端 kill sidecar →
 *   下次 send_prompt lazy spawn 新 sidecar, 读新 user tool preset.
 * 之前缺这个 watcher, user 改 file 后热更失效 (跟 v3.39 之前 external tool 同根因).
 */
function installUserToolsWatcher(workspacePath, agentDir) {
  const handle = watchUserToolsDirs(workspacePath, agentDir, () => {
    writeRestartRequest(agentDir, 'user_tool_changed');
  });
  mcpState.userToolsWatcherClose = handle.close;
  console.error(`[sidecar] v3.40: user tools watcher installed (active=${handle.status.active}, dirs=[${handle.status.dirs.join(', ')}])`);
}'''
if old_ext_func_close not in src:
    raise SystemExit("old_ext_func_close not found")
src = src.replace(old_ext_func_close, new_ext_func_close_with_user)

# 3. 在 createAgentSession 末尾 installMcpWatcher 之后 + installExternalToolsWatcher 之后
#    调 installUserToolsWatcher
old_install_pair = '''  // P2-2: 装 fs watcher, config 改完自动 reload (MCP + external 都 silent restart, v3.39 统一)
  installMcpWatcher();
  installExternalToolsWatcher(workspacePath, agentDir);'''
new_install_triple = '''  // P2-2: 装 fs watcher, config 改完自动 reload
  //   - MCP config: installMcpWatcher → silent restart (v3.39)
  //   - external tool: installExternalToolsWatcher → silent restart (v3.39 P3-G 修)
  //   - user tool: installUserToolsWatcher → silent restart (v3.40)
  installMcpWatcher();
  installExternalToolsWatcher(workspacePath, agentDir);
  installUserToolsWatcher(workspacePath, agentDir);'''
if old_install_pair not in src:
    raise SystemExit("old_install_pair not found")
src = src.replace(old_install_pair, new_install_triple)

# 4. mcpState 加 userToolsWatcherClose 字段 (跟 externalWatcherClose 一样)
#    找 mcpState 定义, 找 .externalWatcherClose 字段后面加 .userToolsWatcherClose
old_state_field = '''    mcpState.externalWatcherClose = handle.close;'''
new_state_field = '''    mcpState.userToolsWatcherClose = handle.close;'''
# 这一行在 installUserToolsWatcher 函数体内, 已经在 step 2 加了.
# 这里不再需要改 mcpState type def. 检查 mcpState interface 是否有 externalWatcherClose, 加上 userToolsWatcherClose
# 找 mcpState 定义
import re
m = re.search(r"(mcpState: \{[^}]*?externalWatcherClose\?: \([^)]*\)[^,]*[,;])", src, re.DOTALL)
if m:
    print("找到 mcpState interface, 准备加 userToolsWatcherClose 字段")
    # 这个项目 mcpState 是 plain object 不是 interface, 跳过
else:
    print("mcpState 是 plain object (无 interface), 字段在第一次写时隐式, 不需要改 type")

with open(path, "w", encoding="utf-8") as f:
    f.write(src)
print(f"updated {path}")
