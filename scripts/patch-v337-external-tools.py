#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v3.37 patch (Part 6): externalTools.mjs 删 resolveSecretEnv 注入."""
path = "sidecar/src/externalTools.mjs"
with open(path, "r", encoding="utf-8") as f:
    src = f.read()

# 1. JSDoc 改
old_jsdoc = '''/**
 * Scan 2 个目录 (global + workspace), 给每个 manifest 启 subprocess, 包成 Pi SDK ToolDefinition.
 *
 * @param workspacePath 当前 active workspace 绝对路径 (可以 null, 表示没 workspace)
 * @param agentDir 全局 agent dir (通常 <user.home>/.pi/agent, 必有)
 * @param resolveSecretEnv ADR-0023 P3-C 注入: 把 manifest.env 里 keychain: 引用解析成明文
 *   (来自 index.mjs, 走 callTauriCommand("resolve_secrets") 通道)
 * @returns ToolDefinition[] (跟 builtin 22 tool 同样的 schema)
 */
export async function loadExternalTools(workspacePath, agentDir, resolveSecretEnv) {'''
new_jsdoc = '''/**
 * Scan 2 个目录 (global + workspace), 给每个 manifest 启 subprocess, 包成 Pi SDK ToolDefinition.
 *
 * v3.37 (2026-08-24): 删 resolveSecretEnv 参数 (keychain 完全移除, env 原值透传)
 *   user 自己在 external tool manifest.env 配明文.
 *
 * @param workspacePath 当前 active workspace 绝对路径 (可以 null, 表示没 workspace)
 * @param agentDir 全局 agent dir (通常 <user.home>/.pi/agent, 必有)
 * @returns ToolDefinition[] (跟 builtin 22 tool 同样的 schema)
 */
export async function loadExternalTools(workspacePath, agentDir) {'''
assert old_jsdoc in src, "old_jsdoc not found"
src = src.replace(old_jsdoc, new_jsdoc)

# 2. scanAndAppend 调用删第 5 个参数
old_call1 = '''    await scanAndAppend(globalDir, out, seen, 'global', resolveSecretEnv);
  }
  // 2. workspace scope: <workspacePath>/.pi/tools/external/*/manifest.json (同名覆盖 global)
  if (workspacePath) {
    const wsDir = join(workspacePath, '.pi', 'tools', 'external');
    await scanAndAppend(wsDir, out, seen, 'workspace', resolveSecretEnv);'''
new_call1 = '''    await scanAndAppend(globalDir, out, seen, 'global');
  }
  // 2. workspace scope: <workspacePath>/.pi/tools/external/*/manifest.json (同名覆盖 global)
  if (workspacePath) {
    const wsDir = join(workspacePath, '.pi', 'tools', 'external');
    await scanAndAppend(wsDir, out, seen, 'workspace');'''
assert old_call1 in src, "old_call1 not found"
src = src.replace(old_call1, new_call1)

# 3. scanAndAppend 签名 + 注释改
old_scan = '''function scanAndAppend(dir, out, seen, scope, resolveSecretEnv) {
  if (!existsSync(dir)) return;
  let entries;
  try {
    entries = readdirSync(dir);
  } catch (e) {
    console.error(`[externalTools] scan ${dir} failed:`, e);
    return;
  }
  // 2026-08-24 P3-E bug fix: tryBuildToolFromManifest 是 async (P3-C 加了 await resolveSecretEnv 后),
  //   scanAndAppend 必须 await 它才能拿到真 ToolDefinition. 之前漏了 await, Promise 直接进 out,
  //   后续 .name 返 undefined, LLM API 收到 [null, null] 烂工具列表报 "tools.10.function.name is empty".
  //   改用 for...of + await (顺序处理, 跟之前 while 行为一致, 启动 0.x s 多花在 await subprocess spawn).
  return (async () => {
    for (const entry of entries) {
      const fullDir = join(dir, entry);
      try {
        const stat = statSync(fullDir);
        if (!stat.isDirectory()) continue;
      } catch {
        continue;
      }
      const manifestPath = join(fullDir, 'manifest.json');
      if (!existsSync(manifestPath)) continue;
      // 关键: await, 拿 resolved value (ToolDefinition 或 null)
      const def = await tryBuildToolFromManifest(manifestPath, scope, resolveSecretEnv);'''
new_scan = '''function scanAndAppend(dir, out, seen, scope) {
  if (!existsSync(dir)) return;
  let entries;
  try {
    entries = readdirSync(dir);
  } catch (e) {
    console.error(`[externalTools] scan ${dir} failed:`, e);
    return;
  }
  // 2026-08-24 P3-E bug fix: tryBuildToolFromManifest 是 async, scanAndAppend 必须 await 它
  //   才能拿到真 ToolDefinition. 之前漏了 await, Promise 直接进 out, 后续 .name 返 undefined,
  //   LLM API 收到 [null, null] 烂工具列表报 "tools.10.function.name is empty".
  //   改用 for...of + await (顺序处理, 跟之前 while 行为一致, 启动 0.x s 多花在 await subprocess spawn).
  // v3.37 (2026-08-24): 删 resolveSecretEnv 参数 (keychain 完全移除)
  return (async () => {
    for (const entry of entries) {
      const fullDir = join(dir, entry);
      try {
        const stat = statSync(fullDir);
        if (!stat.isDirectory()) continue;
      } catch {
        continue;
      }
      const manifestPath = join(fullDir, 'manifest.json');
      if (!existsSync(manifestPath)) continue;
      // 关键: await, 拿 resolved value (ToolDefinition 或 null)
      const def = await tryBuildToolFromManifest(manifestPath, scope);'''
assert old_scan in src, "old_scan not found"
src = src.replace(old_scan, new_scan)

# 4. tryBuildToolFromManifest 签名 + env 解析逻辑改
old_build = '''async function tryBuildToolFromManifest(manifestPath, scope, resolveSecretEnv) {'''
new_build = '''async function tryBuildToolFromManifest(manifestPath, scope) {'''
assert old_build in src, "old_build not found"
src = src.replace(old_build, new_build)

# 5. 删 env 解析逻辑 (line 230-242)
old_env = '''  // 4. 启 subprocess
  // ADR-0023 P3-C: 解析 manifest.env 里的 keychain: 引用
  //   跟 MCP 同 pattern — 拿到明文 secret 后再传给 spawn
  //   注意: externalTools.mjs 不直接 import index.mjs (避免循环), resolveSecretEnv
  //   通过构造函数注入
  let resolvedEnv;
  try {
    if (manifest.env && typeof manifest.env === 'object' && Object.keys(manifest.env).length > 0) {
      resolvedEnv = await resolveSecretEnv(manifest.env);
    }
  } catch (e) {
    console.error(`[externalTools] ${name}: env 解析失败, 跳过这个 tool:`, e);
    return null;
  }

  const subprocess = new ExternalToolProcess({
    name,
    runtime,
    entryPath,
    toolDir,
    timeoutMs: typeof timeout === 'number' && timeout > 0 ? timeout : 30000,
    extraEnv: resolvedEnv,
  });'''
new_env = '''  // 4. 启 subprocess
  // v3.37 (2026-08-24): 删 keychain 解析, manifest.env 原值透传给 subprocess
  //   user 自己在 manifest.env 配明文. 之前 P3-C 走 resolveSecretEnv 解析 "keychain:..." 引用.
  const subprocess = new ExternalToolProcess({
    name,
    runtime,
    entryPath,
    toolDir,
    timeoutMs: typeof timeout === 'number' && timeout > 0 ? timeout : 30000,
    extraEnv: manifest.env,
  });'''
assert old_env in src, "old_env not found"
src = src.replace(old_env, new_env)

# 6. extraEnv 注释改
old_extraenv_comment = '''        // ADR-0023 P3-C: extraEnv 是 manifest.env 经过 resolveSecretEnv 解析后的明文 secret dict,
        //   跟 process.env 合并, manifest 的值优先 (跟 MCP 同 pattern)'''
new_extraenv_comment = '''        // v3.37 (2026-08-24): extraEnv 是 manifest.env 原值透传, 跟 process.env 合并,
        //   manifest 的值优先 (跟 MCP 同 pattern). 之前 P3-C 走 resolveSecretEnv 解析, 现在删.'''
assert old_extraenv_comment in src, "old_extraenv_comment not found"
src = src.replace(old_extraenv_comment, new_extraenv_comment)

with open(path, "w", encoding="utf-8") as f:
    f.write(src)
print(f"updated {path}")

# 验证
if "resolveSecretEnv" in src:
    print("WARN: still has resolveSecretEnv reference!")
else:
    print(f"{path} clean (no resolveSecretEnv)")
