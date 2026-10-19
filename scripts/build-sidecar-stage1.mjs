// ADR-0019 P0-1: sidecar build with TS type stripping
// 根因: sidecar/src/*.mjs 文件里夹杂 TS 语法 (e.g. `let allSkills: any[] = []`),
//       bun 1.3.14 strict 模式不认 .mjs 里的 TS 语法, 但项目源码就是这样写的.
// 修法: 用 TypeScript transpileModule 剥类型, 输出到 .js, 再 bun build --compile.
//   之前 (2026-08-21) 是怎么过的? 推测是更老版本的 bun 没那么 strict, 或手动跑过 tsc.
//   不去考古, 写个一次性的 preprocess 兜底, 跑通就行.

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
// v3.69 (开源整理): 原来硬编码 `D:/UnityWork/Tools/Pi/app/node_modules/typescript`,
//   别人 clone 后 require 直接抛 MODULE_NOT_FOUND, sidecar build 走不下去.
//   改成走 app/node_modules 的标准解析路径.
const require = createRequire(join(projectRoot, 'app', 'package.json'));
const ts = require('typescript');

const sidecarDir = join(projectRoot, 'sidecar');
const sidecarSrc = join(sidecarDir, 'src');
const tmpDir = join(sidecarDir, '.ts-stripped');
const sidecarOut = join(sidecarDir, 'dist', 'pi-agent-sidecar.exe');
const sidecarBin = join(projectRoot, 'src-tauri', 'binaries', 'pi-agent-sidecar-x86_64-pc-windows-msvc.exe');

// v3.69 (开源整理): 原来硬编码本机 bun 绝对路径 `C:\Users\nx_computer\.bun\...`,
//   别人机器上没有. 优先从 PATH 找 bun, 找不到再试常见的 install 位置.
function resolveBun() {
  const candidates = [
    'bun',                                              // PATH (推荐: install 后自带)
    join(process.env.USERPROFILE || '', '.bun', 'bin', 'bun.exe'),
    join(process.env.USERPROFILE || '', '.bun', 'bun-windows-x64', 'bun.exe'),
    '/usr/local/bin/bun',
    '/opt/homebrew/bin/bun',
  ];
  for (const c of candidates) {
    try {
      if (c === 'bun') {
        execSync('bun --version', { stdio: 'ignore' });
        return 'bun';
      }
      if (existsSync(c)) return c;
    } catch { /* 试下一个 */ }
  }
  console.error('[sidecar-build] 找不到 bun. 请先安装: https://bun.sh  (安装后确保 bun 在 PATH)');
  process.exit(1);
}
const bunExe = resolveBun();

console.log('[sidecar-build] 1/4 stripping TS types from .mjs files...');
if (existsSync(tmpDir)) {
  rmSync(tmpDir, { recursive: true, force: true });
}
mkdirSync(tmpDir, { recursive: true });

const files = ['index.mjs', 'mcpClient.mjs', 'mcpWatcher.mjs', 'externalToolsWatcher.mjs', 'userToolsWatcher.mjs', 'errorSanitizer.mjs', 'externalTools.mjs'];
for (const f of files) {
  const srcPath = join(sidecarSrc, f);
  if (!existsSync(srcPath)) {
    console.log(`[sidecar-build]   skip ${f} (not found)`);
    continue;
  }
  const src = readFileSync(srcPath, 'utf-8');
  // 关键: 临时把 .mjs 复制成 .ts, 让 transpileModule 当 TS 处理 (否则会留 <string> 之类的泛型)
  const tsAsInputPath = join(tmpDir, f.replace(/\.mjs$/, '.ts'));
  writeFileSync(tsAsInputPath, src, 'utf-8');
  const tsSource = readFileSync(tsAsInputPath, 'utf-8');
  const out = ts.transpileModule(tsSource, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      esModuleInterop: true,
      isolatedModules: true,
    },
    fileName: f.replace(/\.mjs$/, '.ts'),
  });
  if (out.diagnostics && out.diagnostics.length > 0) {
    for (const d of out.diagnostics) {
      const msg = ts.flattenDiagnosticMessageText(d.messageText, '\n');
      console.warn(`[sidecar-build]   warn ${f}: ${msg}`);
    }
  }
  // 输出 .mjs (跟原始同名, import './xxx.mjs' 路径保持不变, bun 能 resolve)
  const outPath = join(tmpDir, f);
  writeFileSync(outPath, out.outputText, 'utf-8');
  console.log(`[sidecar-build]   ${f} → ${outPath.split(/[\\\/]/).pop()} (${out.outputText.length} bytes)`);
}

console.log('[sidecar-build] 2/4 bun build --compile...');
const startTime = Date.now();
try {
  execSync(`"${bunExe}" build --compile ${join(tmpDir, 'index.mjs')} --outfile ${sidecarOut}`, { stdio: 'inherit' });
} catch (e) {
  console.error('[sidecar-build] bun build FAILED:', e instanceof Error ? e.message : String(e));
  process.exit(1);
}
const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
if (!existsSync(sidecarOut)) {
  console.error(`[sidecar-build] output not found: ${sidecarOut}`);
  process.exit(1);
}
const sizeMB = (statSync(sidecarOut).size / 1024 / 1024).toFixed(2);
console.log(`[sidecar-build] built: ${sizeMB} MB in ${elapsed}s`);

console.log('[sidecar-build] 3/4 copying to Tauri binaries...');
mkdirSync(dirname(sidecarBin), { recursive: true });
execSync(`copy /Y "${sidecarOut}" "${sidecarBin}"`, { stdio: 'inherit', shell: 'cmd.exe' });

console.log('[sidecar-build] 4/4 cleanup tmp...');
rmSync(tmpDir, { recursive: true, force: true });

console.log('');
console.log('============================================================');
console.log(`[sidecar-build] ✅ DONE`);
console.log(`[sidecar-build] ⏱️  elapsed: ${elapsed}s`);
console.log(`[sidecar-build] 📁 sidecar: ${sidecarOut}`);
console.log(`[sidecar-build] 📁 binaries: ${sidecarBin}`);
console.log('============================================================');
