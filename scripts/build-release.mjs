// build-release.mjs — Release build 包装 (给别人用的版本)
//
// 用法: `node scripts/build-release.mjs` 或 `cd app && npm run build:release`
//   - 自动跑 `cargo tauri build` (Tauri 2 release 模式, 会触发 beforeBuildCommand 重新
//     build dist + 嵌新 dist 进 release .exe, 不需要手跑 vite)
//   - release 模式 Tauri 2 默认关 devtools (F12 console 不可用), 体积小, 优化后
//   - 完成后输出 release .exe + bundle 路径 (MSI / NSIS) + 大小 + 时间戳
//
// 跟 build-debug.mjs 区别:
//   - build-debug: 出 target/debug/pi-agent-desktop.exe, 大 (~26MB), devtools 开
//   - build-release: 出 target/release/pi-agent-desktop.exe, 小 (~7-10MB), devtools 关
//   - 跑 build-release 时机: 发版本 / 给别人用 / 上 store
//   - 跑 build-debug 时机: 日常开发 / 排查问题 / 改完 UI 想立刻看
//
// 跟 build-fe.mjs 区别: build-fe.mjs 只 build FE (vite), Tauri 自己嵌
//   build-release.mjs 一次跑完, 一行命令拿新 release .exe.

import { execSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const releaseExe = join(projectRoot, 'src-tauri', 'target', 'release', 'pi-agent-desktop.exe');
const releaseMsi = join(projectRoot, 'src-tauri', 'target', 'release', 'bundle', 'msi', 'Pi Agent_0.1.0_x64_en-US.msi');
const releaseNsis = join(projectRoot, 'src-tauri', 'target', 'release', 'bundle', 'nsis', 'Pi Agent_0.1.0_x64-setup.exe');

console.log('[build-release] running: cargo tauri build');
console.log('[build-release] (Tauri 2 会自动跑 beforeBuildCommand 重新 build dist + 嵌新 dist 进 release .exe)');
const startTime = Date.now();
try {
  // Tauri 2 cargo tauri build 走 beforeBuildCommand → 跑 npm run build
  // 然后嵌新 dist 进 target/release/pi-agent-desktop.exe
  execSync('cargo tauri build', { cwd: projectRoot, stdio: 'inherit' });
} catch (e) {
  console.error('[build-release] cargo tauri build FAILED:', e instanceof Error ? e.message : String(e));
  process.exit(1);
}
const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

if (!existsSync(releaseExe)) {
  console.error(`[build-release] 期望的 .exe 不存在: ${releaseExe}`);
  process.exit(1);
}
const stat = statSync(releaseExe);
const sizeMB = (stat.size / 1024 / 1024).toFixed(2);
const mtime = stat.mtime.toLocaleString('zh-CN', { hour12: false });

console.log('');
console.log('============================================================');
console.log('[build-release] ✅ 完成');
console.log(`[build-release] ⏱️  耗时: ${elapsed}s (比 debug 慢, 因为开了 LTO + strip)`);
console.log(`[build-release] 📁 .exe 路径: ${releaseExe}`);
console.log(`[build-release] 📦 大小: ${sizeMB} MB (比 debug 小 ~70%)`);
console.log(`[build-release] 🕐 时间戳: ${mtime}`);
console.log('[build-release] 🔒 devtools: release 模式默认关, F12 不可用');
console.log('');
console.log('[build-release] 📦 Bundle 安装包:');
if (existsSync(releaseMsi)) {
  const msiStat = statSync(releaseMsi);
  console.log(`[build-release]    MSI:  ${releaseMsi} (${(msiStat.size / 1024 / 1024).toFixed(2)} MB)`);
}
if (existsSync(releaseNsis)) {
  const nsisStat = statSync(releaseNsis);
  console.log(`[build-release]    NSIS: ${releaseNsis} (${(nsisStat.size / 1024 / 1024).toFixed(2)} MB)`);
}
console.log('[build-release] 💡 给别人用: 发 MSI (Windows Installer) 或 NSIS (.exe setup)');
console.log('============================================================');
