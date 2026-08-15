// test-stream.cjs - 一次连接, 唯一 sessionId, 完整看 stream pipeline
const WebSocket = require('ws');

const URL = 'ws://localhost:3001/api/chat';
const TEST_KEY = process.env.ANTHROPIC_KEY || 'sk-ant-PLACEHOLDER-DO-NOT-USE';
const SID = 'stream-test-' + Date.now();

console.log(`[test] URL: ${URL}`);
console.log(`[test] sessionId: ${SID}`);

const ws = new WebSocket(URL);
const events = [];
const startedAt = Date.now();

const timer = setTimeout(() => {
  console.error(`\n[TIMEOUT] 25s 内没收到 agent_end`);
  console.error(`[events so far] ${JSON.stringify(events.map(e => e.type), null, 0)}`);
  ws.terminate();
  process.exit(1);
}, 25000);

ws.on('open', () => {
  console.log(`[t+${Date.now() - startedAt}ms] [open]`);
  ws.send(JSON.stringify({
    type: 'config',
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    apiKey: TEST_KEY,
    thinkingLevel: 'medium',
  }));
  console.log(`[t+${Date.now() - startedAt}ms] [send config]`);

  setTimeout(() => {
    ws.send(JSON.stringify({
      type: 'prompt',
      sessionId: SID,
      content: '用一句话回 hello, 中文',
    }));
    console.log(`[t+${Date.now() - startedAt}ms] [send prompt]`);
  }, 300);
});

ws.on('message', (raw) => {
  const t = Date.now() - startedAt;
  let msg;
  try { msg = JSON.parse(raw.toString()); } catch { msg = { type: 'raw', data: raw.toString().slice(0, 80) }; }
  events.push(msg);

  let summary;
  switch (msg.type) {
    case 'message_update':
      summary = `delta=${JSON.stringify((msg.delta || '').slice(0, 50))}`;
      break;
    case 'tool_start':
      summary = `tool=${msg.toolName} args=${JSON.stringify((msg.args || '').slice(0, 60))}`;
      break;
    case 'tool_update':
    case 'tool_end':
      summary = `tool=${msg.toolName ?? msg.toolCallId}`;
      break;
    case 'agent_end':
      summary = `done`;
      break;
    case 'error':
      summary = `message=${JSON.stringify((msg.message || '').slice(0, 120))}`;
      break;
    default:
      summary = msg.model || msg.sessionId || msg.provider || '';
  }
  console.log(`[t+${t}ms] [recv] ${msg.type} ${summary}`);

  if (msg.type === 'agent_end' || msg.type === 'error') {
    clearTimeout(timer);
    setTimeout(() => {
      const totalText = events
        .filter(e => e.type === 'message_update')
        .map(e => e.delta || '')
        .join('');
      console.log(`\n[stats]`);
      console.log(`  events count: ${events.length}`);
      console.log(`  message_update count: ${events.filter(e => e.type === 'message_update').length}`);
      console.log(`  full text: ${JSON.stringify(totalText.slice(0, 200))}`);
      console.log(`  final: ${msg.type === 'agent_end' ? 'AGENT_END' : 'ERROR'}`);
      ws.close();
      process.exit(0);
    }, 500);
  }
});

ws.on('close', (code) => {
  console.log(`[t+${Date.now() - startedAt}ms] [close] code=${code}`);
});

ws.on('error', (e) => {
  console.error(`[t+${Date.now() - startedAt}ms] [error] ${e.message}`);
});
