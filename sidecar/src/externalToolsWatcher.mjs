// 2026-08-24 ADR-0023 P3-G: External tool config dir 热重载 watcher
//
// 跟 mcpWatcher.mjs 100% 同 pattern, 监听两个 external tool 目录:
//   - <workspace>/.pi/tools/external/<name>/manifest.json
//   - <agentDir>/tools/external/<name>/manifest.json
// debounce 300ms 后调 callback.
//
// 设计要点 (跟 mcpWatcher 一致):
//   - node fs.watch (recursive 不开, Windows quirk)
//   - dir 级别监听, 覆盖 add/remove/modify
//   - debounce 防多文件连改触发多次
//   - 错误降级: watcher 挂了只 log, 不 crash sidecar
//
// 跟 mcpWatcher 唯一区别: callback 触发后 sidecar 端不能热更新 Pi SDK tool list
//   (Pi SDK 0.84.2 tool 注册只在 createAgentSession 时一次), 必须 restart sidecar.
//   修法: 触发后写 <agentDir>/external_tools_restart_request.json, Tauri 端 watcher
//   100ms 轮询看到 → 调 restart_all_sidecars("external_tool_manifest_changed"),
//   silent restart 链路接通. 跟 UI save 触发 silent restart 同 pattern.
import { watch, existsSync } from 'node:fs';
import { join } from 'node:path';

const DEBOUNCE_MS = 300;

/**
 * 装 watcher 监听两个 external tool config dir.
 * @param workspacePath 当前 active workspace
 * @param agentDir agent 数据目录
 * @param onChange debounced 后调用的 callback (无参)
 * @returns { close(): void, status: { active: boolean, dirs: string[] } }
 */
export function watchExternalToolsDirs(workspacePath, agentDir, onChange) {
  const dirs = [];
  if (agentDir) {
    const globalDir = join(agentDir, 'tools', 'external');
    if (existsSync(globalDir)) dirs.push(globalDir);
  }
  if (workspacePath) {
    const workspaceDir = join(workspacePath, '.pi', 'tools', 'external');
    if (existsSync(workspaceDir)) dirs.push(workspaceDir);
  }

  if (dirs.length === 0) {
    console.error('[sidecar] P3-G: no external tools config dir exists yet, watcher not installed (will retry on first reload)');
    return { close: () => {}, status: { active: false, dirs: [] } };
  }

  const watchers = [];
  let debounceTimer = null;
  const debouncedFire = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      try {
        onChange();
      } catch (e) {
        console.error('[sidecar] P3-G: onChange callback threw:', e instanceof Error ? e.message : String(e));
      }
    }, DEBOUNCE_MS);
  };

  for (const dir of dirs) {
    try {
      // persistent: false → process 退出时自动关
      // recursive: false → 只看 dir 级别 (跟 mcpWatcher 一致)
      // 注意: 跟 mcpWatcher 不同, 这里 dir 下是 <name>/ 子目录, 改的是子目录里的 manifest.json.
      //   fs.watch dir 级别仍然能 catch (Windows: 修改子文件 dir 也会收到 'change' 事件).
      //   简化: 跟 mcpWatcher 一致不递归, 大部分 editor save 行为是 'change' on dir.
      const w = watch(dir, { persistent: false, recursive: false }, (eventType, filename) => {
        // 关心 manifest.json 跟子目录变化 (子目录新建 = 新 tool, 删除 = 删 tool)
        // 简化: 不细 filter, 任何变化都 debounce (300ms 防 editor save 临时文件触发多次)
        debouncedFire();
      });
      w.on('error', (e) => {
        console.error(`[sidecar] P3-G: watcher error on ${dir}:`, e instanceof Error ? e.message : String(e));
      });
      watchers.push(w);
    } catch (e) {
      console.error(`[sidecar] P3-G: install watcher on ${dir} failed:`, e instanceof Error ? e.message : String(e));
    }
  }

  console.error(`[sidecar] P3-G: watcher installed on ${watchers.length} dir(s): [${dirs.join(', ')}] (debounce=${DEBOUNCE_MS}ms)`);

  return {
    close: () => {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      for (const w of watchers) {
        try { w.close(); } catch { /* ignore */ }
      }
    },
    status: { active: true, dirs },
  };
}
