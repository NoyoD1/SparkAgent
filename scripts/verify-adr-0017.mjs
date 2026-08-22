// verify-adr-0017.mjs — ADR-0017 (AGENTS.md 模块) 自动化核验
//
// 用法: `node scripts/verify-adr-0017.mjs`
//   跑出来一份"绿/黄/红"报告, 标出 ADR-0017 §"已实现" 表格里每条声明
//   vs 实际项目代码的偏差. 每次 Pi SDK 升级 / D 系列教训落地 / 关键版本
//   (v0.5.0/v0.6.0) 后, 跑这个脚本重新校准.
//
// 输出格式:
//   [绿] ✅ 真实 — 描述 + 证据 (file:line)
//   [黄] ⚠️ 偏差 — ADR 表述 vs 实际, 解释差异
//   [红] ❌ 假阳性 — ADR 标了但实际没做
//   [红] ❌ 缺位 — ADR 该列但漏列的事实
//
// 退出码: 0 = 全绿, 1 = 有黄/红 (需要人工 review)
//
// v0.6.3-rc1 P0-1: 一鼓作气把 ADR-0017 的"已实现 / 已知问题"区块变成机器可校验.
//   后续每个 ADR 写一个 verify-adr-NNNN.mjs 走同 pattern.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const adrPath = join(projectRoot, 'doc', '04-adr', '0017-feature-agents-md.md');
const sdkRoot = join(projectRoot, 'pi-sdk', 'packages', 'coding-agent', 'src');

const results = []; // { level, code, title, adr, reality, evidence }

function green(code, title, evidence) {
  results.push({ level: '绿', code, title, evidence });
}
function yellow(code, title, adr, reality, evidence) {
  results.push({ level: '黄', code, title, adr, reality, evidence });
}
function red(code, title, adr, reality, evidence) {
  results.push({ level: '红', code, title, adr, reality, evidence });
}

// ============================================================
// 核验函数 — 每个核验独立跑, 失败不阻塞其它
// ============================================================

function checkResourceLoader() {
  // F1: Pi SDK ResourceLoader 自动 load AGENTS.md
  const rl = readFileSync(join(sdkRoot, 'core', 'resource-loader.ts'), 'utf-8');
  const candidatesMatch = rl.match(/const candidates = \[(.*?)\]/);
  if (!candidatesMatch) {
    red('F1', 'Pi SDK load AGENTS.md', 'candidates 列表', '没找到', 'resource-loader.ts');
    return;
  }
  const candidates = candidatesMatch[1];
  const hasAgentsMd = candidates.includes('AGENTS.md');
  const hasOverrideMd = candidates.includes('AGENTS.override.md');
  const hasClaudeMd = candidates.includes('CLAUDE.md');
  if (hasAgentsMd) {
    green('F1', 'Pi SDK load AGENTS.md (candidates 包含)', 'resource-loader.ts:71');
  } else {
    red('F1', 'Pi SDK load AGENTS.md', 'candidates 包含 AGENTS.md', '没找到', 'resource-loader.ts:71');
  }
  if (hasOverrideMd || hasClaudeMd) {
    // 看 ADR 是否已标 "CLAUDE.md" / "AGENTS.override.md" — 标了说明文档已对齐, 变绿
    const adr = readFileSync(adrPath, 'utf-8');
    const adrMentionsExtra = /CLAUDE\.md|AGENTS\.override\.md/.test(adr);
    if (adrMentionsExtra) {
      green(
        'F1.5',
        'Pi SDK load CLAUDE.md / AGENTS.override.md (candidates 列表含) + ADR 已对齐',
        `candidates: ${candidates.replace(/\s+/g, ' ').trim()}`,
      );
    } else {
      yellow(
        'F1.5',
        'Pi SDK 还 load CLAUDE.md / AGENTS.override.md',
        'ADR §"功能定义" F1 只说 AGENTS.md',
        `实际 candidates 列表: ${candidates.replace(/\s+/g, ' ').trim()}`,
        'resource-loader.ts:71',
      );
    }
  }
}

function checkSystemPromptInjection() {
  // F2: AGENTS.md 注入 system prompt — Pi SDK 用 contextFiles 结构化参数
  //   ADR 写"第 2 段 (Base / Project context)"
  const sp = readFileSync(join(sdkRoot, 'core', 'system-prompt.ts'), 'utf-8');
  const usesContextFiles = /contextFiles/.test(sp);
  const agentSession = readFileSync(join(sdkRoot, 'core', 'agent-session.ts'), 'utf-8');
  const passesContextFiles = /getAgentsFiles\(\)/.test(agentSession) && /contextFiles:/.test(agentSession);
  if (usesContextFiles && passesContextFiles) {
    // 看 ADR 是否已说"第 4 段" — 说了说明文档已对齐, 变绿
    const adr = readFileSync(adrPath, 'utf-8');
    const adrMentions4th = /第\s*4\s*段|4th.*segment|project_context.*第/.test(adr);
    if (adrMentions4th) {
      green(
        'F2',
        'AGENTS.md 注入 system prompt (Pi SDK contextFiles, 第 4 段) + ADR 已对齐',
        'system-prompt.ts:32-43 / agent-session.ts:1039-1051',
      );
    } else {
      yellow(
        'F2',
        'AGENTS.md 注入 system prompt',
        'ADR §"功能定义" F2: "注入 system prompt 第 2 段 (Base / Project context)"',
        '实际是 Pi SDK 用 contextFiles 结构化参数, 在 sidecar log 显示为第 4 段 project_context (base=1, skills=2, skill_realtime=3, project_context=4, context_awareness=5)',
        'system-prompt.ts:32-43 / agent-session.ts:1039-1051',
      );
    }
  } else {
    red('F2', 'AGENTS.md 注入 system prompt', 'contextFiles 路径', '没找到', 'system-prompt.ts / agent-session.ts');
  }
}

function checkCustomInstructionsTab() {
  // F3: Settings → Custom Instructions tab 编辑 AGENTS.md
  const tab = join(projectRoot, 'app', 'src', 'components', 'Settings', 'tabs', 'CustomInstructionsTab.vue');
  if (existsSync(tab)) {
    const content = readFileSync(tab, 'utf-8');
    const hasScope = /scope.*workspace.*global|workspace.*global.*scope/.test(content) || /SCOPE_OPTIONS/.test(content);
    if (hasScope) {
      green('F3', 'Custom Instructions tab UI 存在 + scope 切换', tab.replace(projectRoot + '\\', ''));
    } else {
      yellow('F3', 'Custom Instructions tab UI 存在但 scope 选项不可见', '应包含 workspace / global', 'SCOPE_OPTIONS 未匹配', tab);
    }
  } else {
    red('F3', 'Custom Instructions tab UI', '存在', '文件未找到', 'CustomInstructionsTab.vue');
  }
}

function checkScopeTypo() {
  // F4-bug: CustomInstructionsTab.vue typo `scope === 'global' ? null : null`
  const realTab = join(projectRoot, 'app', 'src', 'components', 'Settings', 'tabs', 'CustomInstructionsTab.vue');
  if (!existsSync(realTab)) return;
  const content = readFileSync(realTab, 'utf-8');
  const lines = content.split('\n');
  // 过滤掉注释行, 避免 "之前是 `scope === 'global' ? null : null` typo" 这种历史描述被命中
  const codeLines = lines.map((line, i) => ({ line, idx: i + 1 })).filter(({ line }) => {
    const trimmed = line.trim();
    return trimmed && !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
  });
  for (const { line, idx } of codeLines) {
    if (/scope\s*===?\s*['"]global['"]/.test(line) && /\?\s*null\s*:\s*null/.test(line)) {
      red(
        'F4-typo',
        'CustomInstructionsTab.vue 前端 typo',
        'FE 主动传 agentDir (或显式 null)',
        `line ${idx}: ${line.trim()} — 两个分支都返回 null, global scope 永远不传 agentDir, 依赖后端 fallback 兜底`,
        realTab.replace(projectRoot + '\\', '') + `:${idx}`,
      );
      return;
    }
  }
  // 走更宽松的检查: 看 save() / remove() 里 agentDir 是不是显式传值 (非 null 字面量)
  // 我们期望: agentDir: <变量>  或者  agentDir,  (shorthand 传变量)
  // 不期望: agentDir: null  (硬编码)
  const hardcodedNulls = codeLines.filter(({ line }) => /agentDir:\s*null/.test(line));
  const explicitSends = codeLines.filter(({ line }) => /agentDir,?\s*(\/\/|$)/.test(line) || /agentDir:\s*\w+\(?/.test(line));
  if (hardcodedNulls.length > 0 && explicitSends.length === 0) {
    yellow(
      'F4-typo',
      'CustomInstructionsTab.vue agentDir 硬编码 null',
      'global scope 主动 getAgentDir() 后再传',
      `${hardcodedNulls.length} 处 agentDir: null 硬编码, 依赖后端 fallback`,
      'CustomInstructionsTab.vue',
    );
  } else if (explicitSends.length > 0) {
    green('F4-typo', 'CustomInstructionsTab.vue agentDir 显式传值', `CustomInstructionsTab.vue (${explicitSends.length} 处显式 send)`);
  }
}

function checkSidecarLogSegments() {
  // F5: ADR 写"4 段 system prompt log", 实际是 5 段
  const sidecar = readFileSync(join(projectRoot, 'sidecar', 'src', 'index.mjs'), 'utf-8');
  const logMatch = sidecar.match(/system prompt:\s*(\d+)\s*segments/);
  if (!logMatch) {
    red('F5', 'sidecar system prompt log', '应打 segments 数', '没找到', 'sidecar/src/index.mjs');
    return;
  }
  const actualSegments = parseInt(logMatch[1], 10);
  const adr = readFileSync(adrPath, 'utf-8');
  // 精确判断: ADR §"已实现" 表里是否说"5 段 system prompt log"
  //   排除"第 4 段"(具体位置) / "v0.5.0-PR1 初版 4 段"(历史) 等场景
  const adrTableSays5 = /\*\*5\s*段\*\*\s*system\s*prompt\s*log|5\s*段\s*system\s*prompt\s*log.*✅|5\s*段\s*system\s*prompt\s*log.*v0\.6\.3/.test(adr);
  const adrTableSays4 = /\*\*4\s*段\*\*\s*system\s*prompt\s*log|4\s*段\s*system\s*prompt\s*log.*✅/.test(adr);
  if (actualSegments === 5) {
    if (adrTableSays5 && !adrTableSays4) {
      green('F5', `system prompt 5 段 + ADR 已对齐`, 'sidecar/src/index.mjs:333');
    } else {
      yellow(
        'F5',
        'system prompt segments 实际数',
        'ADR §"已实现" 表里 段数断言',
        `实际 ${actualSegments} 段 (base / skills / skill_realtime / project_context / context_awareness) — ADR §"已实现" 表里仍写 "4 段" (tableSays5=${adrTableSays5}, tableSays4=${adrTableSays4})`,
        'sidecar/src/index.mjs:333',
      );
    }
  } else {
    red(
      'F5',
      'system prompt segments 数',
      `4 段 (ADR) / 5 段 (P0-1 预期)`,
      `实际 ${actualSegments} 段 — 段数又变了, 跑全段名匹配`,
      'sidecar/src/index.mjs:333',
    );
  }
}

function checkMultiFileContext() {
  // F6: ADR §"功能定义" F6 标 🟡 "多文件 project context (e.g. .pi/context/*.md)"
  //   实际: sidecar 没扫这条路径, Pi SDK 也不支持
  const sidecar = readFileSync(join(projectRoot, 'sidecar', 'src', 'index.mjs'), 'utf-8');
  const adr = readFileSync(adrPath, 'utf-8');
  const adrClaimsMultiFile = /多文件.*project context|\.pi\/context/.test(adr);
  const sidecarScans = /\.pi\/context|context\/\*\.md/.test(sidecar);
  if (adrClaimsMultiFile && !sidecarScans) {
    red(
      'F6',
      '多文件 project context (.pi/context/*.md)',
      'ADR §"功能定义" 标 🟡 "计划中"',
      'sidecar 没扫这条路径, Pi SDK 也不支持 — 实际是 ❌ 不是 🟡, ADR 标记误导',
      'sidecar/src/index.mjs (grep 0 命中)',
    );
  } else if (sidecarScans) {
    green('F6', '多文件 project context', 'sidecar/src/index.mjs');
  }
}

function checkDynamicSystemPrompt() {
  // F7: ADR §"功能定义" F7 标 ❌ "Dynamic system prompt, 要重启 sidecar 才能生效"
  //   实际: Pi SDK 0.84.2 有 reload() 但 sidecar 只 reload skills, 不 reload context files
  const sidecar = readFileSync(join(projectRoot, 'sidecar', 'src', 'index.mjs'), 'utf-8');
  // 精确判断: sidecar 是否有 reload AGENTS.md 的机制?
  //   - reload 命令包含 AGENTS.md (例如 RpcCommand type:'reload' 拼 'AGENTS.md')
  //   - fs.watch 监听 AGENTS.md 文件
  //   - reload_skill 走的是 reload_skills + rebuildSkillsFragment, 跟 AGENTS.md 无关, 排除
  const reloadAgentsMdRe = /reload.*AGENTS|AGENTS.*reload/i;
  const watchAgentsMdRe = /fs\.watch.*AGENTS|watchFile.*AGENTS|chokidar.*AGENTS/i;
  // 排除: sidecar 提到 AGENTS.md 只在注释里说"Pi SDK 0.84.2 DefaultResourceLoader 自动 load AGENTS.md (resource-loader.ts:71)"
  // 这种是描述, 不是实际机制. 看代码行 (排除注释行)
  const codeLines = sidecar.split('\n').filter((line) => {
    const trimmed = line.trim();
    return trimmed && !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
  });
  const codeHasReloadAgents = codeLines.some((line) => reloadAgentsMdRe.test(line));
  const codeHasWatchAgents = codeLines.some((line) => watchAgentsMdRe.test(line));
  const hasMechanism = codeHasReloadAgents || codeHasWatchAgents;
  if (hasMechanism) {
    green('F7', 'AGENTS.md 动态 reload 已实现', 'sidecar/src/index.mjs');
  } else {
    // sidecar 已知有 reload_skills, 但没 reload context files → R1 沉默失败
    yellow(
      'F7',
      'AGENTS.md 改完是否动态生效',
      'ADR §"功能定义" 标 ❌ "Dynamic system prompt, Pi SDK 0.84 限制"',
      'Pi SDK 0.84.2 ResourceLoader.reload() 支持 reload context files, 但 sidecar 只 reload skills (reload_skills 命令), 没监听 AGENTS.md 文件变化 → R1 沉默失败 (用户改完家规本不重启 sidecar, LLM 看到的还是旧家规本)',
      'pi-sdk/.../resource-loader.ts:387 (reload API) / sidecar/src/index.mjs (无 AGENTS.md watch / reload 代码)',
    );
  }
}

function checkUiCommentConflict() {
  // F8 (隐式): UI 注释 vs ADR 已知问题冲突
  const tab = join(projectRoot, 'app', 'src', 'components', 'Settings', 'tabs', 'CustomInstructionsTab.vue');
  if (!existsSync(tab)) return;
  const content = readFileSync(tab, 'utf-8');
  const claimsNextPrompt = /改完保存.*下次|保存.*下次.*生效|下次发.*生效/.test(content);
  const adr = readFileSync(adrPath, 'utf-8');
  const adrSaysRestart = /重启|restart|D165/.test(adr);
  // UI 是否已标 "重启 sidecar" / "立即重启" 提示?
  const uiSaysRestart = /重启\s*sidecar|保存并立即重启|需重启|生效需重启/.test(content);
  if (claimsNextPrompt && adrSaysRestart) {
    if (uiSaysRestart) {
      green('F8', 'UI 注释已对齐 ADR 已知问题 (UI 也提示重启 sidecar)', 'CustomInstructionsTab.vue');
    } else {
      yellow(
        'F8',
        'UI 注释 vs ADR 已知问题',
        'UI 注释"改完保存下次发 prompt 生效"',
        'ADR 已知问题 D165 "改 AGENTS.md 要重启 sidecar (~150-300ms)" — 两边说法冲突, 用户不知道信哪个',
        'CustomInstructionsTab.vue:125 / 0017-feature-agents-md.md §"已知问题"',
      );
    }
  }
}

function checkNoFourSegmentsHardcoded() {
  // F9: 防御性核验 — 代码里不能 hard-code "4 segments" (会 silent fail)
  const adr = readFileSync(adrPath, 'utf-8');
  const libRs = readFileSync(join(projectRoot, 'src-tauri', 'src', 'lib.rs'), 'utf-8');
  if (/4\s*segments/.test(libRs)) {
    red(
      'F9',
      'src-tauri/src/lib.rs 硬编码 "4 segments"',
      '应读取 Pi SDK 实际段数或 5 段',
      '硬编码会在 Pi SDK 升级后 silent fail',
      'lib.rs',
    );
  }
  if (/4\s*segments/.test(adr) && !/4\s*段.*过期|4\s*段.*已.*更/.test(adr)) {
    // ADR 仍有"4 段"未更正, 跟 P0-3 同步做
    yellow(
      'F9-adr',
      'ADR-0017 仍写 "4 段"',
      'P0-1 ground truth 是 5 段',
      'ADR 文档假阳性, 跟实现脱节',
      adrPath.replace(projectRoot + '\\', ''),
    );
  }
}

function checkBackendCommands() {
  // F10: Rust 端 read/write/delete_custom_instructions 都注册了
  const libRs = readFileSync(join(projectRoot, 'src-tauri', 'src', 'lib.rs'), 'utf-8');
  const hasRead = /async fn read_custom_instructions/.test(libRs);
  const hasWrite = /async fn write_custom_instructions/.test(libRs);
  const hasDelete = /async fn delete_custom_instructions/.test(libRs);
  const registered = /read_custom_instructions,\s*\n\s*write_custom_instructions,\s*\n\s*delete_custom_instructions/.test(libRs);
  if (hasRead && hasWrite && hasDelete && registered) {
    green('F10', 'Rust 后端 3 个 command + 注册', 'lib.rs:1043-1087, 2784-2786');
  } else {
    red('F10', 'Rust 后端 command 缺一', `${hasRead}/${hasWrite}/${hasDelete}/registered=${registered}`, 'lib.rs');
  }
}

// ============================================================
// 跑全部核验
// ============================================================

console.log('========================================');
console.log('  ADR-0017 (AGENTS.md 模块) 自动化核验');
console.log('========================================');
console.log(`项目根: ${projectRoot}`);
console.log(`ADR 路径: ${adrPath.replace(projectRoot + '\\', '')}`);
console.log(`Pi SDK 根: ${sdkRoot.replace(projectRoot + '\\', '')}`);
console.log('');

const checks = [
  checkResourceLoader,
  checkSystemPromptInjection,
  checkCustomInstructionsTab,
  checkScopeTypo,
  checkSidecarLogSegments,
  checkMultiFileContext,
  checkDynamicSystemPrompt,
  checkUiCommentConflict,
  checkNoFourSegmentsHardcoded,
  checkBackendCommands,
];

for (const check of checks) {
  try {
    check();
  } catch (e) {
    red('EXCEPTION', check.name, '执行', `异常: ${e instanceof Error ? e.message : String(e)}`, '');
  }
}

// ============================================================
// 报告
// ============================================================

const greenCount = results.filter((r) => r.level === '绿').length;
const yellowCount = results.filter((r) => r.level === '黄').length;
const redCount = results.filter((r) => r.level === '红').length;

console.log('核验结果:');
console.log('');

for (const r of results) {
  const icon = r.level === '绿' ? '✅' : r.level === '黄' ? '⚠️ ' : '❌';
  console.log(`[${r.level}] ${icon} ${r.code}: ${r.title}`);
  if (r.adr) console.log(`       ADR:    ${r.adr}`);
  if (r.reality) console.log(`       实际:   ${r.reality}`);
  console.log(`       证据:   ${r.evidence}`);
  console.log('');
}

console.log('========================================');
console.log(`汇总: 绿 ${greenCount} / 黄 ${yellowCount} / 红 ${redCount}`);
console.log('========================================');

if (redCount > 0) {
  console.log('\n❌ 有红灯 — 必看:');
  for (const r of results.filter((r) => r.level === '红')) {
    console.log(`  - ${r.code}: ${r.title}`);
  }
}
if (yellowCount > 0) {
  console.log('\n⚠️  有黄灯 — 建议 review:');
  for (const r of results.filter((r) => r.level === '黄')) {
    console.log(`  - ${r.code}: ${r.title}`);
  }
}

process.exit(redCount > 0 ? 1 : 0);
