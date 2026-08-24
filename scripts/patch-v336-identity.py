#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v3.36 patch: replace resolve_secrets body in src-tauri/src/lib.rs
with identity pass-through (rollback P3-C keychain parsing).
Lines 269..318 (1-indexed) → 0-indexed 268..318 inclusive.
"""
import io
path = "src-tauri/src/lib.rs"
with open(path, "r", encoding="utf-8") as f:
    lines = f.readlines()
start = 269 - 1  # 0-indexed
end = 318        # 0-indexed inclusive

# Build replacement as a list of lines ending with \n (preserve file style)
new_block_lines = [
    "#[tauri::command]\n",
    "async fn resolve_secrets(values: Vec<String>) -> Result<Vec<String>, String> {\n",
    "    // v3.36 (2026-08-24): 回滚 P3-C keychain 解析, 改 identity pass-through.\n",
    "    //   背景: P3-C 引入 keychain 引用 (\"keychain:pi-agent:MCP_XXX\") 让 MCP / external tool\n",
    "    //     env 里的 secret 走 OS keychain 解析. 副作用: sidecar 启动 MCP / external tool 时\n",
    "    //     调 resolve_secrets 走 callTauriCommand, keychain 解析失败 / 找不到 secret 走\n",
    "    //     60s timeout 兜底 — 整条 send_prompt 链路要等 60s.\n",
    "    //   user 反馈: \"key 都在本地个人电脑, 直填到 mcp / tool 配置就行, 为什么要走 keychain?\"\n",
    "    //     user 角度完全合理 — 1 分延迟大头是 keychain 60s timeout, 不是 LLM API.\n",
    "    //   修法 (回滚 v3.22 之前行为): Tauri 端 resolve_secrets 改 identity, env values 原样返.\n",
    "    //     - sidecar 端 resolveSecretEnv 立即拿到原值, 不 60s timeout\n",
    "    //     - MCP / external tool 拿到 env 原值 (含 \"keychain:...\" literal), 实际 fail\n",
    "    //       但启动快 (0s wait, 不影响 main vision 流程)\n",
    "    //     - user 后续自己改 MCP / external tool config, 把 \"keychain:...\" 引用换成明文 key\n",
    "    //   backward compat: sidecar binary 没改, 仍调 callTauriCommand(\"resolve_secrets\"),\n",
    "    //     Tauri 端 identity 返, sidecar 立即收到.\n",
    "    //\n",
    "    // 之前 v3.22 行为 (keyring 解析, 60s timeout) 注释保留在下面 reference, 方便对比:\n",
    "    //\n",
    "    //   P3-C: 用 keyring::get_secret 走 SERVICE_SECRET 独立 keychain\n",
    "    //   P3-F+: lookup fallback (试整个 name + last-segment short name)\n",
    "    //   PREFIX = \"keychain:\", 不在 keychain 引用 (没 \"keychain:\" 前缀) 直接 pass-through\n",
    "    Ok(values)\n",
    "}\n",
]
lines[start:end+1] = new_block_lines
with open(path, "w", encoding="utf-8") as f:
    f.writelines(lines)
print(f"OK, replaced lines 269..318 (1-indexed) with identity pass-through ({len(new_block_lines)} new lines)")
