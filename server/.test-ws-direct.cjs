// test-ws-direct.cjs - 直接连 server WS, 不走 vite proxy
const WebSocket = require('ws');

const URLS = [
  'ws://localhost:3001/api/chat',
  'ws://127.0.0.1:3001/api/chat',
  'ws://[::1]:3001/api/chat',
];

const TEST_KEY = process.env.ANTHROPIC_KEY || 'sk-ant-PLACEHOLDER';

let idx = 0;
function tryNext() {
  if (idx >= URLS.length) {
    console.error('\n[FAIL] 所有 URL 都不通');
    process.exit(1);
  }
  const url = URLS[idx++];
  console.log(`\n[TRY] ${url}`);

  const ws = new WebSocket(url);
  const timer = setTimeout(() => {
    console.error(`[TIMEOUT] ${url} 5s 内没收到 ready`);
    ws.terminate();
    tryNext();
  }, 5000);

  ws.on('open', () => {
    console.log('  [open]');
    // 先发 config
    ws.send(JSON.stringify({
      type: 'config',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      apiKey: TEST_KEY,
      thinkingLevel: 'medium',
    }));
    console.log('  [send config]');

    // 立刻发 prompt
    setTimeout(() => {
      ws.send(JSON.stringify({
        type: 'prompt',
        sessionId: 'test-sess-1',
        content: '用中文回复一句 hello (1-2 句)',
      }));
      console.log('  [send prompt]');
    }, 200);
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { msg = raw.toString(); }
    const summary = msg.type === 'message_update'
      ? `${msg.type} delta=${JSON.stringify((msg.delta || '').slice(0, 40))}`
      : msg.type === 'error'
        ? `${msg.type} message=${JSON.stringify((msg.message || '').slice(0, 100))}`
        : `${msg.type} ${msg.model || msg.toolName || msg.sessionId || ''}`;
    console.log(`  [recv] ${summary}`);
  });

  ws.on('close', (code, reason) => {
    clearTimeout(timer);
    console.log(`  [close] code=${code} reason=${reason.toString()}`);
    if (code === 1000) {
      console.log(`\n[OK] ${url} stream 完整收尾`);
      process.exit(0);
    } else {
      tryNext();
    }
  });

  ws.on('error', (e) => {
    clearTimeout(timer);
    console.error(`  [error] ${e.message}`);
  });
}

tryNext();
