// 2026-08-21 v0.6.3-rc1 P2-1: MCP (Model Context Protocol) client wrapper
//
// 跟 sidecar/src/index.mjs 同包, sidecar 启动时给每个 enabled 的 MCP server
//   spawn 一个子进程, 用 @modelcontextprotocol/sdk 走 JSON-RPC over stdio
//   initialize, 拉 tools/list, 转成 Pi SDK ToolDefinition merge 到 customTools.
//
// 设计取舍:
//   - 用官方 SDK (@modelcontextprotocol/sdk), 不用自己写 JSON-RPC (协议细节容易错)
//   - 工具名加 mcp_<server>_<tool> 前缀, 防跟 builtin / user tool 撞名
//   - parameters 走 jsonSchemaToTypeBox 转 Pi SDK TypeBox (LLM 看到的 schema)
//   - lifecycle: sidecar 启动时 start, 关闭时 stop (SIGTERM 子进程, 避免僵尸)
//   - 错误降级: 1 个 server 启动失败不影响其它 server, 不影响 sidecar 自身
//
// 已知限制:
//   - transport 只支持 stdio (P2 后续支持 SSE / HTTP)
//   - 不支持 MCP 资源 (resources) / 提示 (prompts), 只支持 tools
//   - 不支持 MCP sampling (LLM 主动调用由 server 发起, 桌面端少见)
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { Type } from '@sinclair/typebox';

// MCP server 配置 schema (跟 .pi/mcp/*.json 一致, 跟 Rust 端 validate 同步).
// 必填: name, command
// 可选: args, env, cwd, timeout
// 暂不支持: transport (固定 stdio), enabled (默认 true)
export const McpServerConfig = {};  // type-only stub, used as marker
// 实际 type 描述 (JSDoc 风格, .mjs 不需要 TypeScript):
// {
//   name: string;            // server 唯一名 (文件 basename sans .json, 作为 mcp_<name>_<tool> 前缀)
//   command: string;         // 可执行文件 (e.g. npx / node / .exe 绝对路径)
//   args?: string[];         // 命令参数
//   env?: Record<string, string>;  // 额外环境变量
//   cwd?: string;            // 子进程 cwd, 默认 inherit
//   timeout?: number;        // 协议 timeout ms, 默认 30000
// }

// MCP 协议返回的 tool 描述 (listTools result)
// {
//   name: string;
//   description?: string;
//   inputSchema: {
//     type: 'object';
//     properties?: Record<string, unknown>;
//     required?: string[];
//     [key: string]: unknown;
//   };
// }

// Client 连接 / 初始化错误, 跟 spawn 错误区分 (上层 catch 决定降级策略).
export class McpServerError extends Error {
  constructor(serverName, phase, message) {
    super(`[MCP:${serverName}] ${phase}: ${message}`);
    this.serverName = serverName;
    this.phase = phase;
  }
}

// MCP server client wrapper.
// 封装 1 个 MCP server 的 lifecycle: connect → initialize → listTools → callTool → stop
//  v0.6.3-rc1 P2-1.8: 不再是"子进程" lifecycle — 改成"transport" lifecycle.
//   - stdio: 子进程 (StdioClientTransport)
//   - http: 长连接 HTTP (StreamableHTTPClientTransport, MCP 新标准)
//   - sse:  长连接 SSE  (SSEClientTransport, MCP 旧标准, 兼容老 server)
//
// 不持有 LLM 上下文 / permission 状态, 这些由 sidecar/src/index.mjs 的 extension
//   在 ToolDefinition.execute 闭包里注入.
export class McpServerClient {
  constructor(config) {
    this.config = config;
    this.client = null;
    this.transport = null;
    this.tools = [];
    // server 启动耗时 ms (从 connect 到 initialize 完成), 留作 log + 排查.
    this.startDurationMs = 0;
    // 子进程 PID (仅 stdio, 用于 log / 排查僵尸). transport 不暴露, 走 SDK 内部.
    this.childPid = null;
    // v0.6.3-rc1 P2-1.8: transport 类型 (stdio | http | sse, 默认 stdio)
    this.type = config.type ?? 'stdio';
  }

  get toolCount() { return this.tools.length; }

  // 启动: 按 type dispatch 创建 transport + JSON-RPC initialize + 拉 tools/list.
  // 失败 throw McpServerError (phase = 'spawn' | 'init' | 'list_tools'),
  //   上层 catch 决定降级 (log + 跳过这个 server, 不影响 sidecar 其它部分).
  async start() {
    const startTime = Date.now();
    try {
      // 1. 创建 transport (按 type dispatch)
      this.transport = this.createTransport();

      // 2. JSON-RPC initialize (包一层 timeout)
      this.client = new Client(
        { name: 'pi-agent-sidecar', version: '0.2.0' },
        { capabilities: {} },
      );
      this.client.registerCapabilities({});
      const timeoutMs = this.config.timeout ?? 30000;
      await this.connectWithTimeout(timeoutMs);

      // 3. 拉 tools/list
      const result = await this.client.listTools({});
      this.tools = (result.tools ?? []);
      this.startDurationMs = Date.now() - startTime;
    } catch (e) {
      // 失败时清理 (transport 可能半开)
      this.cleanup();
      const phase = this.diagnosePhase(e);
      throw new McpServerError(this.config.name, phase, e instanceof Error ? e.message : String(e));
    }
  }

  // v0.6.3-rc1 P2-1.8: 按 type dispatch 创建对应 transport.
  //   - stdio: 走 child_process spawn + JSON-RPC over stdin/stdout (原 P2-1 行为)
  //   - http:  StreamableHTTPClientTransport (MCP 新标准, 推荐)
  //   - sse:  SSEClientTransport (MCP 旧标准, 兼容老 server)
  createTransport() {
    if (this.type === 'http') {
      const url = this.requireUrl();
      return new StreamableHTTPClientTransport(url, {
        requestInit: { headers: this.buildHttpHeaders() },
      });
    }
    if (this.type === 'sse') {
      const url = this.requireUrl();
      return new SSEClientTransport(url, {
        requestInit: { headers: this.buildHttpHeaders() },
      });
    }
    // stdio (default, 包含 type=stdio 和 type 缺失)
    return new StdioClientTransport({
      command: this.config.command,
      args: this.config.args ?? [],
      env: { ...process.env, ...(this.config.env ?? {}) },
      cwd: this.config.cwd,
      // SDK 内部会 spawn child_process, 走 stdio line-delimited JSON
    });
  }

  // 解析 + 校验 url 字段 (http/sse 必填)
  requireUrl() {
    const urlStr = this.config.url;
    if (!urlStr) {
      throw new McpServerError(
        this.config.name, 'spawn',
        `type=${this.type} 必填 'url' 字段 (如 "https://api.example.com/mcp")`,
      );
    }
    let url;
    try {
      url = new URL(urlStr);
    } catch (e) {
      throw new McpServerError(
        this.config.name, 'spawn',
        `type=${this.type} 的 'url' 字段不是合法 URL: ${urlStr}`,
      );
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new McpServerError(
        this.config.name, 'spawn',
        `type=${this.type} 的 'url' 必须是 http:// 或 https://, got '${url.protocol}'`,
      );
    }
    return url;
  }

  // 把 env + headers 合并成 HTTP request headers
  //   - env: stdio 是子进程 env var; http/sse 时把每条 env 当 HTTP header (如 Authorization)
  //   - 后续可加独立 'headers' 字段 (P2-1.8 先用 env 兜住, 简单)
  buildHttpHeaders() {
    const headers = {};
    if (this.config.env) {
      for (const [k, v] of Object.entries(this.config.env)) {
        if (typeof v === 'string') headers[k] = v;
      }
    }
    return headers;
  }

  // 走 SDK 的 connect(), 但包一层 timeout (SDK 0.84.2 自身不强制 timeout, 我们手动控制).
  // 用 Promise.race 抢 connect() vs setTimeout, timeout 后清理 transport + reject.
  async connectWithTimeout(timeoutMs) {
    let timer = null;
    try {
      await Promise.race([
        this.client.connect(this.transport),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`connect timeout after ${timeoutMs}ms`)), timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  // 返回该 server 提供的 tool list (已经 initialize + listTools).
  getTools() {
    return this.tools;
  }

  // 调 server 的 tool. 返回 MCP 的 content 数组 (text / image / resource).
  // 错误 throw McpServerError (phase = 'call_tool'), 上层 catch 转 tool result isError.
  async callTool(toolName, args) {
    if (!this.client) {
      throw new McpServerError(this.config.name, 'call_tool', 'client not connected');
    }
    const timeoutMs = this.config.timeout ?? 30000;
    let timer = null;
    try {
      const callPromise = this.client.callTool({ name: toolName, arguments: args });
      const result = await Promise.race([
        callPromise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`callTool timeout after ${timeoutMs}ms`)), timeoutMs);
        }),
      ]);
      return result;
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  // 关闭 MCP server 子进程 + 清理 client / transport.
  // sidecar 关闭时调, 防止僵尸进程.
  // 走 best-effort: 已经 disconnect 的 transport 不重复 close, 异常 catch 不抛.
  async stop() {
    try {
      if (this.client) {
        try {
          await this.client.close();
        } catch {
          // SDK close 失败不抛, 子进程可能已经死
        }
        this.client = null;
      }
    } finally {
      this.cleanup();
    }
  }

  // 清理 transport 子进程 (走 transport.close()).
  // best-effort: kill 失败 / 子进程已死 都不抛.
  cleanup() {
    if (this.transport) {
      try {
        this.transport.close();
      } catch {
        // ignore
      }
      this.transport = null;
    }
  }

  // 粗判错误 phase (start() catch 用). 简单按错误消息关键词分:
  //   - 'ENOENT' / 'spawn' → spawn
  //   - 'timeout' / 'initialize' → init
  //   - 'listTools' / 'tools/list' → list_tools
  // 其它 fallback 'init'.
  // 真正的 phase 区分可以后续细化, 不阻塞 MCP 集成主流程.
  diagnosePhase(e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/ENOENT|spawn|executable/i.test(msg)) return 'spawn';
    if (/timeout|initialize|connection/i.test(msg)) return 'init';
    if (/listTools|tools\/list/i.test(msg)) return 'list_tools';
    return 'init';
  }
}

// MCP tool/call 返回的 result (跟 SDK 类型简化).
// {
//   content: Array<
//     | { type: 'text'; text: string }
//     | { type: 'image'; data: string; mimeType: string }
//     | { type: 'resource'; [key: string]: unknown }
//   >;
//   isError?: boolean;
// }

// 把 MCP tool 的 inputSchema (JSON Schema) 转 Pi SDK TypeBox.
// 简化实现: 只处理 4 种 primitive (string/number/boolean) + array + nested object.
// 复杂情况 (oneOf / anyOf / $ref / enum) 留 fallback Type.Any() — Pi SDK TypeBox
//   schema 跟 OpenAI JSON Schema 协议是互转的, 简单 schema LLM 能看懂, 复杂 schema
//   降级也不影响调用 (args 走 MCP server 自己 schema 校验).
//
// 跟 P1-5 user tool 不同: user tool args 是手填 JSON, MCP args 是动态从 server 拉,
//   所以必须能处理任意 schema.
export function jsonSchemaToTypeBox(schema) {
  if (!schema || typeof schema !== 'object') return Type.Any();
  const s = schema;
  if (s.type !== 'object' || !s.properties || typeof s.properties !== 'object') {
    // 非 object 类型 (顶层 string / number / array 等) → Type.Any() 兜底
    return Type.Any();
  }
  const props = {};
  const requiredSet = new Set(Array.isArray(s.required) ? s.required : []);
  for (const [key, propSchema] of Object.entries(s.properties)) {
    props[key] = jsonSchemaPropertyToTypeBox(propSchema, requiredSet.has(key));
  }
  const options = { additionalProperties: false };
  if (typeof s.description === 'string') options.description = s.description;
  return Type.Object(props, options);
}

function jsonSchemaPropertyToTypeBox(prop, isRequired) {
  if (!prop || typeof prop !== 'object') return wrapOptional(Type.Any(), isRequired);
  const p = prop;
  let base;
  const descOptions = {};
  if (typeof p.description === 'string') descOptions.description = p.description;
  switch (p.type) {
    case 'string': {
      const opts = { ...descOptions };
      if (p.enum) opts.enum = p.enum;
      base = Type.String(opts);
      break;
    }
    case 'number':
    case 'integer': {
      base = Type.Number(descOptions);
      break;
    }
    case 'boolean': {
      base = Type.Boolean(descOptions);
      break;
    }
    case 'array': {
      // 简化: 数组元素一律 Type.Any() (不递归 item schema), 后续 P2.2 增强
      base = Type.Array(Type.Any(), descOptions);
      break;
    }
    case 'object': {
      // nested object → 简化: 用空 Object 表达 (P2.2 增强递归)
      base = Type.Object({}, { ...descOptions, additionalProperties: false });
      break;
    }
    default: {
      // oneOf / anyOf / $ref / 未知 type → Type.Any() 兜底
      base = Type.Any();
    }
  }
  return wrapOptional(base, isRequired);
}

function wrapOptional(t, isRequired) {
  return isRequired ? t : Type.Optional(t);
}
