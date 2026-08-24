#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v3.37 patch (Part 5): sidecar 端删 keychain.
- index.mjs: 删 resolveSecretEnv 函数 + 删 2 处调用 (MCP + external tool)
- externalTools.mjs: 类似
"""
import os

# 1. index.mjs
path = "sidecar/src/index.mjs"
with open(path, "r", encoding="utf-8") as f:
    src = f.read()

# 1a. 删 MCP env 解析
old_mcp = '''    // ADR-0023 P3-C: 解析 env 里的 keychain: 引用, 拿到明文 secret 后再 spawn subprocess
    //   失败 throw (e.g. 引用了不存在的 secret), 让 caller 决定降级
    let resolvedEnv;
    try {
      resolvedEnv = await resolveSecretEnv(config.env);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[sidecar] P3-C: MCP '${config.name}' env 解析失败, 跳过: ${msg}`);
      results.push({
        name: config.name,
        status: 'failed',
        reason: `env 解析失败: ${msg}`,'''
new_mcp = '''    // v3.37 (2026-08-24): keychain 完全移除, MCP env 直接用 config.env 原值
    //   之前 P3-C 走 resolveSecretEnv 解析 "keychain:..." 引用, 现在 user 直填明文.
    //   副作用: env 里的 "keychain:..." literal 字符串 (e.g. user 忘了改) 实际会让
    //   MCP server 拿到字面 "keychain:..." 当 API key, 启动时 fail. 启动快 (0s wait).
    const resolvedEnv = config.env;'''
assert old_mcp in src, "old_mcp not found"
src = src.replace(old_mcp, new_mcp)

# 1b. 删 external tool resolveSecretEnv 参数 + 改注释
old_ext = '''  // ADR-0023 P3-B: 扫 external tool 文件夹, 启 subprocess, 跟其它 tool 同样 merge
  // P3-C: 传 resolveSecretEnv, 让 external tool manifest.env 也能用 keychain: 引用
  // 2026-08-24 P3-E fix: loadExternalTools 改 async 了 (P3-C bug: scanAndAppend 没 await,
  //   Promise 进 out, LLM 看到 [null,null] 烂工具列表). 必须 await.
  const externalTools = await loadExternalTools(workspacePath, agentDir, resolveSecretEnv);'''
new_ext = '''  // ADR-0023 P3-B: 扫 external tool 文件夹, 启 subprocess, 跟其它 tool 同样 merge
  // v3.37 (2026-08-24): 删 resolveSecretEnv 参数, keychain 完全移除, env 原值透传
  //   user 自己在 external tool manifest.env 配明文.
  // 2026-08-24 P3-E fix: loadExternalTools 改 async 了 (P3-C bug: scanAndAppend 没 await,
  //   Promise 进 out, LLM 看到 [null,null] 烂工具列表). 必须 await.
  const externalTools = await loadExternalTools(workspacePath, agentDir);'''
assert old_ext in src, "old_ext not found"
src = src.replace(old_ext, new_ext)

# 1c. 删 resolveSecretEnv 函数定义 (2048-2065)
old_func = '''/**
 * ADR-0023 P3-C (2026-08-24): 解析 env dict 里的 keychain: 引用
 *   - 输入: { KEY1: "keychain:pi-agent:foo", KEY2: "literal-value" }
 *   - 输出: { KEY1: "<actual secret from keychain>", KEY2: "literal-value" }
 *   - 走 callTauriCommand("resolve_secrets") 通道, Tauri 端从 OS keychain 读
 *   - 失败 (keychain 找不到): throw, 让 caller 决定 fail-fast
 *
 * 不在 keychain 引用 (没 "keychain:" 前缀) 直接 pass-through, 向后兼容明文.
 */
async function resolveSecretEnv(env) {
  if (!env || Object.keys(env).length === 0) return env;
  const keys = Object.keys(env);
  const values = keys.map((k) => env[k]);
  let resolvedValues;
  try {
    resolvedValues = await callTauriCommand('resolve_secrets', { values });
  } catch (e) {
    throw new Error(
      `解析 keychain secret 失败: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const out = {};
  for (let i = 0; i < keys.length; i++) {
    out[keys[i]] = resolvedValues[i];
  }
  return out;
}

'''
new_func = '''// v3.37 (2026-08-24): 删 resolveSecretEnv 函数 (keychain 完全移除)
//   MCP / external tool env 走 user 直填明文, sidecar 透传给 subprocess.
//   之前 P3-C 解析 "keychain:..." 引用, v3.36 改 identity pass-through, v3.37 整个删.

'''
assert old_func in src, "old_func not found"
src = src.replace(old_func, new_func)

with open(path, "w", encoding="utf-8") as f:
    f.write(src)
print(f"updated {path}")

# 2. externalTools.mjs
path2 = "sidecar/src/externalTools.mjs"
if os.path.exists(path2):
    with open(path2, "r", encoding="utf-8") as f:
        ext_src = f.read()
    if "resolveSecretEnv" in ext_src:
        print(f"WARN: {path2} still has resolveSecretEnv reference, need manual fix")
        # 找行
        for i, line in enumerate(ext_src.split("\n")):
            if "resolveSecretEnv" in line:
                print(f"  line {i+1}: {line[:200]}")
    else:
        print(f"{path2} clean (no resolveSecretEnv)")
else:
    print(f"{path2} not found")
