// Direct sidecar smoke test — spawn sidecar child, pipe stdin, collect stdout
const { spawn } = require('node:child_process');
const path = require('node:path');

const sidecarPath = path.resolve(__dirname, 'sidecar', 'src', 'index.mjs');
const apiKey = process.env.SMOKE_KEY || 'sk-fake-test-key-12345';
const useRealKey = !!process.env.SMOKE_KEY;

console.log(`[smoke] sidecar=${sidecarPath}`);
console.log(`[smoke] key=${useRealKey ? 'real (from env SMOKE_KEY)' : 'fake (expect 401/403)'}`);

const child = spawn('node', [sidecarPath], { stdio: ['pipe', 'pipe', 'pipe'] });

let eventCount = 0;
let chunkCount = 0;
let fullText = '';
let lastError = null;

child.stdout.setEncoding('utf-8');
child.stdout.on('data', (chunk) => {
  const lines = chunk.split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      eventCount++;
      if (event.type === 'agent_start') console.log('  [event] agent_start');
      else if (event.type === 'message_start') console.log('  [event] message_start');
      else if (event.type === 'message_update') {
        chunkCount++;
        fullText += event.delta;
        process.stdout.write(`  [chunk ${chunkCount}] ${event.delta}\n`);
      }
      else if (event.type === 'message_end') console.log('  [event] message_end');
      else if (event.type === 'agent_end') console.log('  [event] agent_end');
      else if (event.type === 'error') {
        lastError = event.message;
        console.log(`  [ERROR] ${event.message}`);
      }
    } catch (e) {
      console.log(`  [PARSE-FAIL] ${line.slice(0, 100)}`);
    }
  }
});

child.stderr.setEncoding('utf-8');
child.stderr.on('data', (chunk) => {
  console.log(`  [sidecar stderr] ${chunk.trim()}`);
});

child.on('exit', (code) => {
  console.log('');
  console.log(`[smoke] events=${eventCount}, chunks=${chunkCount}, exitCode=${code}`);
  if (chunkCount > 0) {
    console.log(`[smoke] FULL TEXT: ${fullText}`);
    console.log('[smoke] ✅ PROTOCOL + STREAMING WORKS');
  } else if (lastError && /HTTP 4\d\d/.test(lastError)) {
    console.log('[smoke] ✅ PROTOCOL WORKS (HTTP error from upstream, expected with fake key)');
  } else {
    console.log('[smoke] ❌ FAIL');
    process.exit(1);
  }
});

// Send config + prompt
const configMsg = JSON.stringify({
  type: 'config',
  provider: 'openai-compatible',
  model: 'deepseek-v4-flash',
  baseUrl: 'https://token.sensenova.cn/v1',
  apiKey,
  thinkingLevel: 'medium',
});
const promptMsg = JSON.stringify({
  type: 'prompt',
  sessionId: 'smoke-node-1',
  content: '用中文说一句 hello',
});

console.log('[smoke] sending config...');
child.stdin.write(configMsg + '\n');
setTimeout(() => {
  console.log('[smoke] sending prompt...');
  child.stdin.write(promptMsg + '\n');
  setTimeout(() => {
    console.log('[smoke] closing stdin (waiting for sidecar to exit)...');
    child.stdin.end();
  }, 100);
}, 100);

// Timeout safety
setTimeout(() => {
  console.log('[smoke] timeout 25s, killing child');
  child.kill();
  process.exit(1);
}, 25000);
