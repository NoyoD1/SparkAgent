// 2026-08-21 v0.6.3-rc1 P2-2: MCP config dir 热重载 watcher
//
// 监听 <workspace>/.pi/mcp/*.json + <agentDir>/mcp/*.json 文件变化,
// debounce 后调用 callback (由 sidecar 决定 reload 行为).
//
// 设计要点:
//   - 用 node fs.watch (recursive 不开, Windows recursive 有 quirk, 容易丢事件)
//   - 监听 dir 级别 (不是单个文件), 因为 add/remove 才会触发; 改文件内容 dir 也会触发
//   - debounce 300ms: 防多文件连改触发多次 reload (e.g. editor 临时备份 .bak / tmp)
//   - 错误降级: watcher 自身挂了 (e.g. dir 被删) 只 log, 不 crash sidecar
//   - 退出时 close 所有 watcher (防 fd 泄漏)
//   - **2026-08-25 修 (D213 OOM 真凶 #2)**: 启动 grace period, 抑制 fs.watch 启动后 5s 内
//     Windows ReadDirectoryChangesW 延迟事件. 修法: 装 watcher 时记 readyAt, callback 触发
//     时 Date.now() - readyAt < GRACE_MS 静默 skip.
import { watch, existsSync } from 'node:fs';
import { join } from 'node:path';

const DEBOUNCE_MS = 300;
// 2026-08-25: 启动 grace period 5s, 同 externalToolsWatcher
const STARTUP_GRACE_MS = 5_000;

/**
 * 装 watcher 监听两个 MCP config dir.
 * @param workspacePath: 当前 active workspace
 * @param agentDir: agent 数据目录
 * @param onChange: debounced 后调用的 callback (无参)
 * @returns: { close(): void, status: { active: boolean, dirs: string[] } }
 */
export function watchMcpConfigDirs(workspacePath, agentDir, onChange) {
  const dirs = [];
  if (agentDir) {
    const globalDir = join(agentDir, 'mcp');
    if (existsSync(globalDir)) dirs.push(globalDir);
  }
  if (workspacePath) {
    const workspaceDir = join(workspacePath, '.pi', 'mcp');
    if (existsSync(workspaceDir)) dirs.push(workspaceDir);
  }

  if (dirs.length === 0) {
    console.error('[sidecar] P2-2: no MCP config dir exists yet, watcher not installed (will retry on first reload)');
    return { close: () => {}, status: { active: false, dirs: [] } };
  }

  const watchers = [];
  let debounceTimer = null;
  // 2026-08-25: 启动 grace period (D213 OOM 真凶 #2)
  const readyAt = Date.now();
  let suppressedInGrace = 0;
  const debouncedFire = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (Date.now() - readyAt < STARTUP_GRACE_MS) {
        suppressedInGrace++;
        console.error(`[sidecar] P2-2: fs.watch event suppressed (startup grace ${STARTUP_GRACE_MS}ms, suppressed count=${suppressedInGrace})`);
        return;
      }
      try {
        onChange();
      } catch (e) {
        console.error('[sidecar] P2-2: onChange callback threw:', e instanceof Error ? e.message : String(e));
      }
    }, DEBOUNCE_MS);
  };

  for (const dir of dirs) {
    try {
      // persistent: false → process 退出时自动关, 不需要我们 cleanup
      // recursive: false → 只看 dir 级别 (add/remove/modify 都会触发 dir 上的 'change')
      // 注意 Windows 上 fs.watch 偶尔会发 'rename' 两次 (文件创建后 + close 后),
      // debounce 300ms 把它们合并成一次.
      const w = watch(dir, { persistent: false, recursive: false }, (eventType, filename) => {
        // 只关心 .json 变化, 忽略 .bak / .tmp / .swp (编辑器临时文件)
        if (filename && !filename.endsWith('.json')) return;
        debouncedFire();
      });
      w.on('error', (e) => {
        console.error(`[sidecar] P2-2: watcher error on ${dir}:`, e instanceof Error ? e.message : String(e));
      });
      watchers.push(w);
    } catch (e) {
      console.error(`[sidecar] P2-2: install watcher on ${dir} failed:`, e instanceof Error ? e.message : String(e));
    }
  }

  console.error(`[sidecar] P2-2: watcher installed on ${watchers.length} dir(s): [${dirs.join(', ')}] (debounce=${DEBOUNCE_MS}ms, startupGrace=${STARTUP_GRACE_MS}ms)`);

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
