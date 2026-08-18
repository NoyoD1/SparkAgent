// v0.5.0-PR3 (D_Debug_Build_Automation): 一键 build debug .exe, 让 user
//   能快速拿到跟随最新 FE 改动的 .exe 跑 F12 console 给 AI 排查问题.
//
// 用法: `node scripts/build-debug.mjs`
//  - 自动跑 `cargo tauri build --debug` (Tauri 2 会触发 beforeBuildCommand 重新
//    build dist + 嵌新 dist 进 target/debug/pi-agent-desktop.exe, 不需要手跑 vite)
//  - 完成后输出 debug .exe 路径 + 大小 + 时间戳, 提示 user 双击跑
//
// 跟 build-fe.mjs 区别: build-fe.mjs 只 build FE (vite), Tauri 自己嵌.
//   build-debug.mjs 一次跑完, user 一行命令拿新 .exe.
//
// 跟 release build 区别: debug 模式 Tauri 2 默认开 devtools (F12 console 可用),
//   release 模式默认关. debug 体积大 + 慢, 但适合排查问题.
//
// D186 v5 教训: 改完 FE 后光跑 `cargo tauri build` 嵌新 dist 是 release 链,
//   debug 链是独立的 target/debug/ 目录. 这个脚本保证 debug 链也跟最新 FE 同步.

import { execSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const debugExe = join(projectRoot, 'src-tauri', 'target', 'debug', 'pi-agent-desktop.exe');

console.log('[build-debug] running: cargo tauri build --debug');
console.log('[build-debug] (Tauri 2 会自动跑 beforeBuildCommand 重新 build dist + 嵌新 dist 进 debug .exe)');
const startTime = Date.now();
try {
  // Tauri 2 cargo tauri build --debug 走 beforeBuildCommand → 跑 npm run build
  // 然后嵌新 dist 进 target/debug/pi-agent-desktop.exe
  execSync('cargo tauri build --debug', { cwd: projectRoot, stdio: 'inherit' });
} catch (e) {
  console.error('[build-debug] cargo tauri build --debug FAILED:', e instanceof Error ? e.message : String(e));
  process.exit(1);
}
const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

if (!existsSync(debugExe)) {
  console.error(`[build-debug] 期望的 .exe 不存在: ${debugExe}`);
  process.exit(1);
}
const stat = statSync(debugExe);
const sizeMB = (stat.size / 1024 / 1024).toFixed(2);
const mtime = stat.mtime.toLocaleString('zh-CN', { hour12: false });

console.log('');
console.log('============================================================');
console.log('[build-debug] ✅ 完成');
console.log(`[build-debug] ⏱️  耗时: ${elapsed}s`);
console.log(`[build-debug] 📁 .exe 路径: ${debugExe}`);
console.log(`[build-debug] 📦 大小: ${sizeMB} MB`);
console.log(`[build-debug] 🕐 时间戳: ${mtime}`);
console.log('[build-debug] 🔧 devtools: debug 模式默认开, 双击跑后按 F12 看 console');
console.log('[build-debug] 💡 排查问题贴 console 日志截图 (含 [chat] / [sidecar] / [Composer] 前缀) 给 AI');
console.log('============================================================');
