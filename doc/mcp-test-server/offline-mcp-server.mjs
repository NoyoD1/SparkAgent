// 2026-08-21 v0.6.3-rc1 P2-1: 离线 MCP server (测试用)
//
// 纯 Node.js stdlib 实现, 零依赖. 跟 @modelcontextprotocol/sdk 走 JSON-RPC over stdio
//   兼容. 提供 4 个 demo tool 验证 MCP 集成.
//
// 工具清单 (通过 listTools 暴露):
//   - echo      { message: string }              → 复读 message
//   - add       { a: number, b: number }          → a + b
//   - hello     { name?: string }                  → "Hello, {name}!" (默认 "World")
//   - sysinfo   {}                                  → 平台 + Node 版本 + PID + 时间
//
// 用法 (在 MCP tab UI 里配置):
//   command: node
//   args:    D:\path\to\doc\mcp-test-server\offline-mcp-server.mjs
//   (或者绝对路径的 .mjs 文件, sidecar 启动时 spawn 这个进程)
//
// 调试: 直接 node 这个文件, 走 JSON-RPC 跟它对话, e.g.:
//   > {"jsonrpc":"2.0","id":1,"method":"initialize","params":{...}}
//   > {"jsonrpc":"2.0","method":"notifications/initialized"}
//   > {"jsonrpc":"2.0","id":2,"method":"tools/list"}
//
// 实现要点:
//   - 走 JSON-RPC 2.0 over stdio (line-delimited JSON, 每行一个 message)
//   - 不依赖 @modelcontextprotocol/sdk, 纯 Node.js readline + process.stdout
//   - server info 写死 name="offline-mcp-test" version="0.1.0", LLM 看到的 tool 名前缀
//     会是 mcp_offline-mcp-test_<tool> (mcp_<server-name>_<tool-name>)
//   - 错误处理: 收到未知 method → -32601 Method not found; tool 抛错 → tool result isError=true

import { createInterface } from 'node:readline';
import { EOL } from 'node:os';

// ====== MCP server metadata (暴露给 LLM 看到 server 信息) ======
const SERVER_INFO = {
  name: 'offline-mcp-test',
  version: '0.1.0',
};
const SERVER_CAPABILITIES = {
  tools: {},  // 声明支持 tools 能力 (resources / prompts 不支持)
};

// ====== Tool 定义 (跟 @modelcontextprotocol/sdk types 简化) ======
const TOOLS = [
  {
    name: 'echo',
    description: '复读用户输入的 message 原文返回. 适合验证 MCP 通信链路是否通.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: '要复读的文本' },
      },
      required: ['message'],
    },
    handler: async (args) => ({
      content: [{ type: 'text', text: `echo: ${args.message}` }],
    }),
  },
  {
    name: 'add',
    description: '两个整数相加. 返回 a + b. 适合验证 number 类型参数.',
    inputSchema: {
      type: 'object',
      properties: {
        a: { type: 'number', description: '第一个加数' },
        b: { type: 'number', description: '第二个加数' },
      },
      required: ['a', 'b'],
    },
    handler: async (args) => {
      const sum = (args.a ?? 0) + (args.b ?? 0);
      return {
        content: [{ type: 'text', text: `${args.a} + ${args.b} = ${sum}` }],
      };
    },
  },
  {
    name: 'hello',
    description: '打招呼. 不传 name 默认 "World". 适合验证 optional 参数.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '要打招呼的名字 (可选)' },
      },
    },
    handler: async (args) => {
      const name = args.name || 'World';
      return {
        content: [{ type: 'text', text: `Hello, ${name}!` }],
      };
    },
  },
  {
    name: 'sysinfo',
    description: '返回当前 Node 进程的系统信息 (平台 / 版本 / PID / 时间). 适合验证 tool 调用上下文.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async () => {
      const info = {
        platform: process.platform,
        nodeVersion: process.version,
        pid: process.pid,
        uptimeSec: Math.round(process.uptime()),
        nowIso: new Date().toISOString(),
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(info, null, 2) }],
      };
    },
  },
];

// ====== JSON-RPC 2.0 helpers ======
let nextId = 1;

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + EOL);
}

function sendResult(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message, data) {
  send({
    jsonrpc: '2.0',
    id,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  });
}

// JSON-RPC 标准错误码
const ERR_PARSE = -32700;
const ERR_INVALID_REQUEST = -32600;
const ERR_METHOD_NOT_FOUND = -32601;
const ERR_INVALID_PARAMS = -32602;
const ERR_INTERNAL = -32603;

// ====== MCP method handlers ======
async function handleInitialize(id, params) {
  // params.protocolVersion 可选, 我们不强校验 (server 跟 client 协商, 这里用最新协议)
  // params.capabilities 不用 (server 主动 declare 自己的 capabilities)
  // params.clientInfo 记一下给 log 用
  console.error(`[offline-mcp] initialize: client=${params?.clientInfo?.name ?? 'unknown'} v${params?.clientInfo?.version ?? '?'} protocol=${params?.protocolVersion ?? '?'}`);
  return {
    protocolVersion: '2024-11-05',  // MCP 1.x 主流协议版本
    capabilities: SERVER_CAPABILITIES,
    serverInfo: SERVER_INFO,
  };
}

function handleInitialized() {
  // notification, 不返回 result (MCP 规范)
  console.error('[offline-mcp] client 已发 initialized notification');
  return null;
}

function handleToolsList() {
  // 返回 tool 列表 (inputSchema 完整, 让 client 包装成 LLM schema)
  return {
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  };
}

async function handleToolsCall(id, params) {
  const name = params?.name;
  const args = params?.arguments ?? {};
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) {
    // tool 不存在 → 返回 isError=true 的 result, 不抛 exception
    return {
      content: [{ type: 'text', text: `Unknown tool: ${name}` }],
      isError: true,
    };
  }
  try {
    const result = await tool.handler(args);
    return result;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[offline-mcp] tool ${name} threw: ${msg}`);
    return {
      content: [{ type: 'text', text: `Tool error: ${msg}` }],
      isError: true,
    };
  }
}

// ====== Routing table ======
const METHOD_HANDLERS = {
  initialize: handleInitialize,
  'notifications/initialized': handleInitialized,
  'tools/list': handleToolsList,
  'tools/call': handleToolsCall,
  // ping: 标准 MCP keep-alive, 实现一下方便 client 探活
  ping: () => ({}),
};

function routeMessage(msg) {
  const { id, method, params } = msg;
  if (!method || typeof method !== 'string') {
    if (id !== undefined) sendError(id, ERR_INVALID_REQUEST, 'method 字段缺失或不是 string');
    return;
  }
  const handler = METHOD_HANDLERS[method];
  if (!handler) {
    console.error(`[offline-mcp] unknown method: ${method}`);
    if (id !== undefined) sendError(id, ERR_METHOD_NOT_FOUND, `Method not found: ${method}`);
    return;
  }
  // notification (id 缺失) 不回 result
  if (id === undefined) {
    Promise.resolve(handler(params)).catch((e) => {
      console.error(`[offline-mcp] notification ${method} handler error:`, e);
    });
    return;
  }
  Promise.resolve(handler(id, params))
    .then((result) => {
      if (result === null) return;  // notification-style handler
      sendResult(id, result);
    })
    .catch((e) => {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[offline-mcp] ${method} handler error: ${msg}`);
      sendError(id, ERR_INTERNAL, `Internal error: ${msg}`);
    });
}

// ====== Stdio loop ======
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

console.error(`[offline-mcp] starting: ${SERVER_INFO.name} v${SERVER_INFO.version} (pid=${process.pid})`);
console.error('[offline-mcp] tools:', TOOLS.map((t) => t.name).join(', '));

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch (e) {
    sendError(undefined, ERR_PARSE, `Parse error: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  if (!msg || msg.jsonrpc !== '2.0') {
    sendError(msg?.id, ERR_INVALID_REQUEST, 'jsonrpc 字段必须是 "2.0"');
    return;
  }
  routeMessage(msg);
});

rl.on('close', () => {
  console.error('[offline-mcp] stdin closed, exiting');
  process.exit(0);
});

// 优雅退出 (sidecar 关闭时调 stop, 走 SIGTERM)
process.on('SIGTERM', () => {
  console.error('[offline-mcp] SIGTERM received, exiting');
  process.exit(0);
});
process.on('SIGINT', () => {
  console.error('[offline-mcp] SIGINT received, exiting');
  process.exit(0);
});
