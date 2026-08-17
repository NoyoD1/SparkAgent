// Cross-platform 前端 build 包装.
// Tauri 2 在 Windows 跑 beforeBuildCommand 用 cmd /C, 直接 `cd ../app` 跨 shell 不可靠.
// 用 node 脚本 (跨平台) 调 npm 走绝对 path.
//
// 用法: `node scripts/build-fe.mjs`  (cwd 任意, 自动定位 app/)
// Tauri conf: "beforeBuildCommand": "node ../scripts/build-fe.mjs"
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// __dirname = <project>/scripts/, 往上 1 级 = <project>/
const projectRoot = resolve(__dirname, '..');
const appDir = join(projectRoot, 'app');

if (!existsSync(join(appDir, 'package.json'))) {
  console.error(`[build-fe] app/package.json not found at ${appDir}`);
  process.exit(1);
}

console.log(`[build-fe] running: npm run build (cwd=${appDir})`);
execSync('npm run build', { cwd: appDir, stdio: 'inherit' });
console.log(`[build-fe] done`);
