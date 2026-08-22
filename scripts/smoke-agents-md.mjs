// smoke-agents-md.mjs — 轻量端到端 AGENTS.md 核验 (不动 LLM)
//
// 用法: `node scripts/smoke-agents-md.mjs`
//   跑出来一份"绿/黄/红"报告, 标出 AGENTS.md 模块的 6 个关键 invariant:
//     1. Pi SDK loadProjectContextFiles 真存在且接受 {cwd, agentDir}
//     2. candidates 列表包含 AGENTS.md / AGENTS.override.md / CLAUDE.md (Pi SDK 实际行为, 跟 ADR 标 "4 candidates" 不同的 5 个)
//     3. sidecar log 是 "5 segments" (不是 ADR 初版写的 "4 segments")
//     4. system-prompt.ts 用 contextFiles 参数 (不是字符串拼接)
//     5. Rust 后端 read_custom_instructions / write_custom_instructions / delete_custom_instructions 都注册
//     6. CustomInstructionsTab.vue resolveAgentDir() helper 显式 getAgentDir (P0-2 修复)
//
// 跟 verify-adr-0017.mjs 区别: verify-adr-0017.mjs 跑"绿色/黄色/红色"细致分类;
//   smoke-agents-md.mjs 跑"pass/fail" 严格判定, 适合 CI / git hook / 提交前自动跑.
//
// 退出码: 0 = 全 pass, 1 = 有 fail (阻止提交 / 触发 CI fail)
//
// v0.6.3-rc1 P1-1: 轻量版端到端. 真发 prompt 给 LLM 的"全功能 e2e"留给 P1-1.5 (要 LLM key).

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const sdkRoot = join(projectRoot, 'pi-sdk', 'packages', 'coding-agent', 'src');

let passCount = 0;
let failCount = 0;
const fails = [];

function pass(name, evidence) {
  passCount++;
  console.log(`  ✅ ${name}`);
  if (evidence) console.log(`     ${evidence}`);
}
function fail(name, why, evidence) {
  failCount++;
  fails.push({ name, why, evidence });
  console.log(`  ❌ ${name}`);
  if (why) console.log(`     ${why}`);
  if (evidence) console.log(`     ${evidence}`);
}
function section(title) {
  console.log('');
  console.log(`▶ ${title}`);
}

// ============================================================
// Invariant 1: Pi SDK loadProjectContextFiles 真存在且接受 {cwd, agentDir}
// ============================================================
section('Invariant 1: Pi SDK loadProjectContextFiles 签名');
{
  const rl = join(sdkRoot, 'core', 'resource-loader.ts');
  if (!existsSync(rl)) {
    fail('loadProjectContextFiles 文件存在', 'resource-loader.ts 不存在', rl);
  } else {
    const content = readFileSync(rl, 'utf-8');
    const hasFn = /export function loadProjectContextFiles\s*\(/.test(content);
    const hasCwdParam = /cwd:\s*string/.test(content);
    const hasAgentDirParam = /agentDir:\s*string/.test(content);
    if (hasFn && hasCwdParam && hasAgentDirParam) {
      pass('loadProjectContextFiles({cwd, agentDir}) 签名匹配', 'resource-loader.ts:118-156');
    } else {
      fail(
        'loadProjectContextFiles 签名不匹配',
        `hasFn=${hasFn} hasCwdParam=${hasCwdParam} hasAgentDirParam=${hasAgentDirParam}`,
        'resource-loader.ts:118',
      );
    }
  }
}

// ============================================================
// Invariant 2: candidates 列表 (Pi SDK 实际行为, 跟 ADR 标的不同)
// ============================================================
section('Invariant 2: candidates 列表 — 包含 AGENTS.md / AGENTS.override.md / CLAUDE.md');
{
  const rl = join(sdkRoot, 'core', 'resource-loader.ts');
  if (!existsSync(rl)) {
    fail('candidates 检查', 'resource-loader.ts 不存在');
  } else {
    const content = readFileSync(rl, 'utf-8');
    const match = content.match(/const candidates = \[(.*?)\]/);
    if (!match) {
      fail('candidates 数组存在', '没找到 candidates 数组', 'resource-loader.ts:71');
    } else {
      const c = match[1];
      const required = ['AGENTS.override.md', 'AGENTS.md', 'CLAUDE.md'];
      const missing = required.filter((r) => !c.includes(r));
      if (missing.length === 0) {
        pass(`candidates 含 ${required.length} 个关键文件`, `candidates: ${c.replace(/\s+/g, ' ').trim()}`);
      } else {
        fail('candidates 缺关键文件', `缺: ${missing.join(', ')}`, `实际: ${c}`);
      }
    }
  }
}

// ============================================================
// Invariant 3: sidecar log 是 "5 segments" (不是 ADR 初版 "4 segments")
// ============================================================
section('Invariant 3: sidecar system prompt log = 5 segments');
{
  const sidecar = join(projectRoot, 'sidecar', 'src', 'index.mjs');
  if (!existsSync(sidecar)) {
    fail('sidecar index.mjs 存在', '文件不存在');
  } else {
    const content = readFileSync(sidecar, 'utf-8');
    const match = content.match(/system prompt:\s*(\d+)\s*segments/);
    if (!match) {
      fail('system prompt log 存在', '没找到 "system prompt: N segments" 字符串');
    } else {
      const n = parseInt(match[1], 10);
      if (n === 5) {
        pass('sidecar log 5 segments (跟 ADR v0.6.3-rc1 一致)', 'sidecar/src/index.mjs:333');
      } else {
        fail('sidecar log segments 数', `实际 ${n} 段, 预期 5 段 (D214 v5 加的 skill_realtime)`, 'sidecar/src/index.mjs:333');
      }
    }
  }
}

// ============================================================
// Invariant 4: system-prompt.ts 用 contextFiles 参数 (结构化方式)
// ============================================================
section('Invariant 4: system-prompt.ts 用 contextFiles 结构化参数 (不是字符串拼接)');
{
  const sp = join(sdkRoot, 'core', 'system-prompt.ts');
  const agentSession = join(sdkRoot, 'core', 'agent-session.ts');
  if (!existsSync(sp) || !existsSync(agentSession)) {
    fail('system-prompt.ts / agent-session.ts 存在', '至少一个文件不存在');
  } else {
    const spContent = readFileSync(sp, 'utf-8');
    const asContent = readFileSync(agentSession, 'utf-8');
    const usesContextFiles = /contextFiles/.test(spContent);
    const passesContextFiles = /getAgentsFiles\(\)/.test(asContent) && /contextFiles:/.test(asContent);
    if (usesContextFiles && passesContextFiles) {
      pass('contextFiles 路径完整 (Pi SDK 用结构化参数, 不让 sidecar 拼字符串)', 'system-prompt.ts:32-43 / agent-session.ts:1039-1051');
    } else {
      fail('contextFiles 路径', `usesContextFiles=${usesContextFiles} passesContextFiles=${passesContextFiles}`);
    }
  }
}

// ============================================================
// Invariant 5: Rust 后端 3 个 command 都注册
// ============================================================
section('Invariant 5: Rust 后端 read/write/delete_custom_instructions 都注册');
{
  const libRs = join(projectRoot, 'src-tauri', 'src', 'lib.rs');
  if (!existsSync(libRs)) {
    fail('lib.rs 存在', '文件不存在');
  } else {
    const content = readFileSync(libRs, 'utf-8');
    const hasRead = /async fn read_custom_instructions/.test(content);
    const hasWrite = /async fn write_custom_instructions/.test(content);
    const hasDelete = /async fn delete_custom_instructions/.test(content);
    // 注册到 invoke_handler — 三个都得在 invoke_handler 块里
    const hasRegister = /read_custom_instructions,[\s\n]+write_custom_instructions,[\s\n]+delete_custom_instructions/.test(content);
    if (hasRead && hasWrite && hasDelete && hasRegister) {
      pass('3 个 command 实现 + 注册', 'lib.rs:1043-1087, 2784-2786');
    } else {
      fail('Rust command 缺一', `read=${hasRead} write=${hasWrite} delete=${hasDelete} register=${hasRegister}`);
    }
  }
}

// ============================================================
// Invariant 6: CustomInstructionsTab.vue P0-2 修复 (resolveAgentDir helper)
// ============================================================
section('Invariant 6: CustomInstructionsTab.vue P0-2 修复 (FE 主动 getAgentDir)');
{
  const tab = join(projectRoot, 'app', 'src', 'components', 'Settings', 'tabs', 'CustomInstructionsTab.vue');
  if (!existsSync(tab)) {
    fail('CustomInstructionsTab.vue 存在', '文件不存在');
  } else {
    const content = readFileSync(tab, 'utf-8');
    // 排除注释行
    const codeLines = content.split('\n').filter((line) => {
      const t = line.trim();
      return t && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    });
    const hasResolveHelper = codeLines.some((l) => /async function resolveAgentDir/.test(l) || /resolveAgentDir\s*=\s*async/.test(l));
    const hasGetAgentDirCall = codeLines.some((l) => /piTauri\.getAgentDir\(\)/.test(l));
    // 老 typo 不能在 code 行里出现
    const hasOldTypo = codeLines.some((l) => /scope\s*===?\s*['"]global['"]/.test(l) && /\?\s*null\s*:\s*null/.test(l));
    if (hasResolveHelper && hasGetAgentDirCall && !hasOldTypo) {
      pass('resolveAgentDir() helper + piTauri.getAgentDir() 调用 + 无老 typo', 'CustomInstructionsTab.vue');
    } else {
      fail('P0-2 修复未完整', `hasResolveHelper=${hasResolveHelper} hasGetAgentDirCall=${hasGetAgentDirCall} hasOldTypo=${hasOldTypo}`);
    }
  }
}

// ============================================================
// 报告
// ============================================================
console.log('');
console.log('========================================');
console.log(`汇总: pass ${passCount} / fail ${failCount}`);
console.log('========================================');

if (failCount > 0) {
  console.log('\n❌ 失败项:');
  for (const f of fails) {
    console.log(`  - ${f.name}: ${f.why}`);
  }
  process.exit(1);
} else {
  console.log('\n✅ 全部 6 个 invariant 通过');
  process.exit(0);
}
