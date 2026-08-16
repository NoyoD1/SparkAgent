// 独立烟测: 验证 pi-ai + pi-agent-core 集成层能跑, 校准 AgentEvent 字段名.
// 不动 sidecar/src/index.mjs — 这是临时验证脚本, 跑完可删.
//
// 用法: node sidecar/test-smoke-faux.mjs
// 预期: 看到 agent.subscribe 收到的事件, 校准 sidecar mapAgentEventToIPC() 的字段名.
import { Agent } from '@earendil-works/pi-agent-core';
import {
  createModels,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
  fauxAssistantMessage,
} from '@earendil-works/pi-ai';

console.error('[smoke] start');

// 构造 faux provider, mock 返回 "Hello from pi-agent-core!"
// fauxProvider() 返回 { provider, setResponses, ... }, 不是 Provider 直接
const faux = fauxProvider({
  models: [{
    id: 'faux-1',
    name: 'Faux Test Model',
    api: 'faux',
    contextWindow: 8000,
    maxTokens: 4000,
  }],
});
// setResponses 单独调 (不是 options.responses)
faux.setResponses([
  () => fauxAssistantMessage([
    fauxThinking('The user wants a hello. Let me think...'),
    fauxText('Hello from pi-agent-core!'),
  ]),
]);

const models = createModels();
models.setProvider(faux.provider);    // .provider 不是 faux 本身
const model = models.getModel('faux', 'faux-1');

if (!model) {
  console.error('[smoke] !!! model not found');
  process.exit(1);
}

console.error('[smoke] model:', model.id, model.provider, model.api);

const agent = new Agent({
  initialState: {
    systemPrompt: 'You are a test agent.',
    model,
  },
  streamFn: models.streamSimple.bind(models),
});

let eventCount = 0;
const eventLog = [];
agent.subscribe((event) => {
  eventCount += 1;
  eventLog.push(event);
  // 打印所有 event, 校准字段名
  console.error(`[smoke] event #${eventCount}:`);
  console.error(JSON.stringify(event, null, 2));
});

try {
  await agent.prompt('Say hello');
  console.error(`[smoke] DONE — total events: ${eventCount}`);
  console.error('[smoke] event types seen:', [...new Set(eventLog.map((e) => e.type))].join(', '));
  // 检查关键 event type 是否出现
  const types = new Set(eventLog.map((e) => e.type));
  const expected = ['message_start', 'message_update', 'message_end', 'agent_end'];
  const missing = expected.filter((t) => !types.has(t));
  if (missing.length > 0) {
    console.error('[smoke] !!! missing event types:', missing);
    process.exit(2);
  }
  console.error('[smoke] PASS — all expected event types present');
} catch (e) {
  console.error('[smoke] !!! agent.prompt threw:', e);
  process.exit(3);
}
