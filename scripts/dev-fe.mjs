// Cross-platform 前端 dev 包装 (跟 build-fe.mjs 同模式, 启 Vite dev server).
// Tauri conf: "beforeDevCommand": "node ../scripts/dev-fe.mjs"
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const appDir = join(projectRoot, 'app');

if (!existsSync(join(appDir, 'package.json'))) {
  console.error(`[dev-fe] app/package.json not found at ${appDir}`);
  process.exit(1);
}

console.log(`[dev-fe] running: npm run dev (cwd=${appDir})`);
execSync('npm run dev', { cwd: appDir, stdio: 'inherit' });
