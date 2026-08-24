// v3.40 (2026-08-24): User tool config dir 热重载 watcher
//
// 跟 externalToolsWatcher 100% 同 pattern, 监听 user tool 目录:
//   - <agentDir>/tools/*.json (e.g. tools/my_grep.json)
//   - <workspacePath>/.pi/tools/*.json (同名覆盖 global)
//
// 跟 externalToolsWatcher 唯一区别: dir path 不一样 (tools vs tools/external),
//   callback 触发后 reason 不同 ('user_tool_changed' vs 'external_tool_changed'),
//   写同一个 external_tools_restart_request.json file queue, Tauri 端收到后 kill sidecar.
//
// 设计要点 (跟 mcpWatcher / externalToolsWatcher 一致):
//   - node fs.watch (recursive 不开, Windows quirk)
//   - dir 级别监听, 覆盖 add/remove/modify
//   - debounce 300ms: 防多文件连改触发多次 reload
//   - 错误降级: watcher 挂了只 log, 不 crash sidecar
//   - 退出时 close 所有 watcher (防 fd 泄漏)
import { watch, existsSync } from 'node:fs';
import { join } from 'node:path';

const DEBOUNCE_MS = 300;

/**
 * 装 watcher 监听两个 user tool config dir.
 * @param workspacePath 当前 active workspace
 * @param agentDir agent 数据目录
 * @param onChange debounced 后调用的 callback (无参)
 * @returns { close(): void, status: { active: boolean, dirs: string[] } }
 */
export function watchUserToolsDirs(workspacePath, agentDir, onChange) {
  const dirs = [];
  if (agentDir) {
    const globalDir = join(agentDir, 'tools');
    if (existsSync(globalDir)) dirs.push(globalDir);
  }
  if (workspacePath) {
    const workspaceDir = join(workspacePath, '.pi', 'tools');
    if (existsSync(workspaceDir)) dirs.push(workspaceDir);
  }

  if (dirs.length === 0) {
    console.error('[sidecar] v3.40: no user tools config dir exists yet, watcher not installed (will retry on first reload)');
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
        console.error('[sidecar] v3.40: onChange callback threw:', e instanceof Error ? e.message : String(e));
      }
    }, DEBOUNCE_MS);
  };

  for (const dir of dirs) {
    try {
      // persistent: false → process 退出时自动关
      // recursive: false → 只看 dir 级别 (跟 mcpWatcher / externalToolsWatcher 一致)
      //   监听 tools/ 根目录会同时 catch tools/*.json (user tool 增删改)
      //   跟 tools/external/ 子目录修改 (external tool 增删改) 各自走不同 watcher.
      //   不递归, 大部分 editor save 行为是 'change' on dir.
      const w = watch(dir, { persistent: false, recursive: false }, (eventType, filename) => {
        // 关心 *.json 变化 (新建/删除/修改). 不细 filter, 任何变化都 debounce (300ms).
        debouncedFire();
      });
      w.on('error', (e) => {
        console.error(`[sidecar] v3.40: watcher error on ${dir}:`, e instanceof Error ? e.message : String(e));
      });
      watchers.push(w);
    } catch (e) {
      console.error(`[sidecar] v3.40: install watcher on ${dir} failed:`, e instanceof Error ? e.message : String(e));
    }
  }

  console.error(`[sidecar] v3.40: user tools watcher installed on ${watchers.length} dir(s): [${dirs.join(', ')}] (debounce=${DEBOUNCE_MS}ms)`);

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
