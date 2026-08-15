// Simple WS test script — 连 server, 发 fake config, 看回包
const WebSocket = require('ws');
const ws = new WebSocket('ws://127.0.0.1:3001/api/chat');

const events = [];
ws.on('open', () => {
  console.log('WS connected');
  // 1. fake config
  ws.send(JSON.stringify({
    type: 'config',
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    apiKey: 'sk-fake-key-for-test',
    thinkingLevel: 'medium',
  }));
});
ws.on('message', (raw) => {
  const ev = JSON.parse(raw.toString());
  events.push(ev.type);
  console.log('  <', ev.type, ev.type === 'error' || ev.type === 'config_error' ? ev.message : '');
  if (ev.type === 'config_ok' || ev.type === 'config_error') {
    // 2. send prompt
    setTimeout(() => {
      ws.send(JSON.stringify({
        type: 'prompt',
        sessionId: 'test-sess-1',
        content: 'hello',
      }));
    }, 100);
  }
  if (ev.type === 'error' || ev.type === 'agent_end') {
    setTimeout(() => {
      console.log('\nEvent sequence:', events.join(' -> '));
      ws.close();
      process.exit(0);
    }, 200);
  }
});
ws.on('error', (e) => {
  console.error('WS error:', e.message);
  process.exit(1);
});
setTimeout(() => {
  console.error('timeout');
  process.exit(1);
}, 10000);
