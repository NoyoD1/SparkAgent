// Phase 2 BYOK e2e plumbing test (fake key, 真 key 走 user 浏览器)
// 验证: WS 连 → config_ok → prompt dispatch → agent 跑 → agent_end

const WebSocket = require('ws');
const ws = new WebSocket('ws://127.0.0.1:3001/api/chat');

const events = [];
let allText = '';

ws.on('open', () => {
  console.log('1. WS open');
  // Step 1: 发 fake config (sk-fake 是合法字符串, model 是真)
  ws.send(JSON.stringify({
    type: 'config',
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    apiKey: 'sk-fake-key-plumbing-test-only',
    thinkingLevel: 'medium',
  }));
});

ws.on('message', (raw) => {
  const ev = JSON.parse(raw.toString());
  events.push(ev);
  switch (ev.type) {
    case 'ready':
      console.log('  2. ready');
      break;
    case 'config_ok':
      console.log(`  3. config_ok (${ev.provider}/${ev.model})`);
      console.log('  4. 发 prompt "ping"');
      ws.send(JSON.stringify({
        type: 'prompt',
        sessionId: 'plumbing-test-sess',
        content: 'ping',
      }));
      break;
    case 'config_error':
      console.log('  3. config_error:', ev.message);
      process.exit(1);
      break;
    case 'agent_start':
      console.log('  5. agent_start');
      break;
    case 'message_start':
      console.log('  6. message_start');
      break;
    case 'message_update':
      allText += ev.delta;
      process.stdout.write('.');
      break;
    case 'message_end':
      console.log('  7. message_end');
      break;
    case 'agent_end':
      console.log('  8. agent_end');
      console.log(`\n\n--- Summary ---`);
      console.log(`Events: ${events.length}`);
      console.log(`Streamed text: ${JSON.stringify(allText)} (fake key 不会产 LLM 输出, 正常)`);
      console.log(`Last event: ${ev.type}`);
      console.log('\n✅ WS 协议层通: ready → config_ok → agent_start → (LLM 401 错误转空 message) → agent_end');
      console.log('   真 key 会在 message_update 阶段产出真实文本');
      ws.close();
      setTimeout(() => process.exit(0), 200);
      break;
    case 'error':
      console.log('  !. error:', ev.message);
      break;
  }
});

ws.on('error', (e) => {
  console.error('WS error:', e.message);
  process.exit(1);
});

setTimeout(() => {
  console.error('timeout');
  process.exit(1);
}, 30000);
