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
// v0.6.3-rc1 P2-4: 升级到支持复杂 schema (oneOf/anyOf/allOf/$ref/递归嵌套)
//   - 之前 P2-1 简化: 只处理 primitive + array(Any) + object({}), 复杂情况降级 Type.Any()
//   - 现在: 完整支持 JSON Schema 2020-12 常用子集, LLM 看到正确的工具参数描述
//   - 错误兜底: 任何解析失败 / 不支持的子集 → Type.Any() (Pi SDK TypeBox 跟 JSON Schema 互转,
//     简单 case LLM 能看懂, 复杂 case 降级也不影响调用 — args 走 MCP server 自己 schema 校验)
//
// 跟 P1-5 user tool 不同: user tool args 是手填 JSON, MCP args 是动态从 server 拉,
//   所以必须能处理任意 schema.
//
// $ref 解析: 用 rootSchema (本次调用的最外层 schema) 找 definitions / $defs.
//   循环引用 (e.g. Tree 节点有 children: Tree[]) 用 visitedRefs Set 防无限递归.
export function jsonSchemaToTypeBox(schema) {
  if (!schema || typeof schema !== 'object') return Type.Any();
  // rootSchema = 最外层 schema (整个 tool 的 inputSchema, 含 $defs / definitions)
  return convertSchema(schema, schema, new Set());
}

/**
 * 递归把 JSON Schema 子树转 TypeBox.
 * @param schema  当前 schema 子树 (可能是 $ref 解析后的, 或原 propSchema)
 * @param root    根 schema ($ref 解析用 — definitions / $defs 都在 root)
 * @param visited 已访问过的 $ref path, 循环引用检测用 (e.g. "definitions/Tree")
 */
function convertSchema(schema, root, visited) {
  if (!schema || typeof schema !== 'object') return Type.Any();

  // 1. $ref 解析 (优先于 type 判断, JSON Schema 2020-12 $ref 可跟 type 共存但通常不)
  if (typeof schema.$ref === 'string') {
    const refPath = schema.$ref;
    // 循环检测: 同一 $ref 在当前调用链出现第二次就当 Any 处理
    if (visited.has(refPath)) {
      // console.warn 防止日志爆炸, 只在调试时开
      // console.error(`[mcpClient] circular $ref detected: ${refPath}, fallback to Any`);
      return Type.Any();
    }
    const resolved = resolveRef(root, refPath);
    if (!resolved) {
      console.error(`[mcpClient] P2-4: $ref '${refPath}' 解析失败 (root 没找到), fallback to Any`);
      return Type.Any();
    }
    visited.add(refPath);
    try {
      return convertSchema(resolved, root, visited);
    } finally {
      visited.delete(refPath);  // 回溯时移除, 允许同一 ref 在不同分支被引用
    }
  }

  // 2. 顶层组合子 (oneOf / anyOf / allOf) — 优先于 type
  //    注: P2-1 之前这些直接 fallthrough 到 Type.Any, 现在真支持
  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    return Type.Union(schema.oneOf.map((s) => convertSchema(s, root, new Set(visited))));
  }
  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    return Type.Union(schema.anyOf.map((s) => convertSchema(s, root, new Set(visited))));
  }
  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    // 简化: allOf 当 object 走, 合并所有 properties / required
    // (对常见 case "allOf: [{$ref: Base}, {extra props}]" 足够, 跟 Type.Intersect 比起来 LLM 更易理解)
    const merged = mergeAllOf(schema.allOf, root, visited);
    if (merged) return merged;
    // 兜底: 全是非 object 走 Type.Intersect (TypeBox 支持)
    return Type.Intersect(schema.allOf.map((s) => convertSchema(s, root, new Set(visited))));
  }

  // 3. const (literal 值, JSON Schema 2020-12 新增)
  if (schema.const !== undefined) {
    return Type.Literal(schema.const);
  }

  // 4. 按 type 分支
  const descOptions = {};
  if (typeof schema.description === 'string') descOptions.description = schema.description;
  // format 透传 (e.g. "date-time", "uri", "email"), TypeBox 在 compile 时会保留到 JSON Schema 输出
  if (typeof schema.format === 'string') descOptions.format = schema.format;

  switch (schema.type) {
    case 'string': {
      const opts = { ...descOptions };
      if (Array.isArray(schema.enum)) opts.enum = schema.enum;
      return Type.String(opts);
    }
    case 'number':
    case 'integer': {
      const opts = { ...descOptions };
      if (typeof schema.minimum === 'number') opts.minimum = schema.minimum;
      if (typeof schema.maximum === 'number') opts.maximum = schema.maximum;
      return Type.Number(opts);
    }
    case 'boolean': {
      return Type.Boolean(descOptions);
    }
    case 'null': {
      return Type.Null(descOptions);
    }
    case 'array': {
      // P2-4: 递归处理 items (之前固定 Any)
      // items 可以是 schema 或 schema[] (tuple). 简化: 只取 items (单 schema), tuple 降级
      let itemType = Type.Any();
      if (schema.items && typeof schema.items === 'object' && !Array.isArray(schema.items)) {
        itemType = convertSchema(schema.items, root, new Set(visited));
      }
      const opts = { ...descOptions, items: itemType };
      if (typeof schema.minItems === 'number') opts.minItems = schema.minItems;
      if (typeof schema.maxItems === 'number') opts.maxItems = schema.maxItems;
      return Type.Array(itemType, opts);
    }
    case 'object': {
      // P2-4: 递归处理 nested object properties (之前固定空 object)
      const props = {};
      const requiredSet = new Set(Array.isArray(schema.required) ? schema.required : []);
      if (schema.properties && typeof schema.properties === 'object') {
        for (const [k, p] of Object.entries(schema.properties)) {
          // P2-4 fix: required 字段不包 Type.Optional, 必须在 Type.Object 构造前决定
          // (Type.Object 看 props 是不是 Optional 决定要不要放 required, 包晚了会全 required)
          const childType = convertSchema(p, root, new Set(visited));
          props[k] = requiredSet.has(k) ? childType : Type.Optional(childType);
        }
      }
      const opts = { ...descOptions, additionalProperties: false };
      // P2-4: 显式 additionalProperties schema 支持 (e.g. additionalProperties: {type: 'string'})
      if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        opts.additionalProperties = convertSchema(schema.additionalProperties, root, new Set(visited));
      } else if (schema.additionalProperties === true) {
        opts.additionalProperties = Type.Any();
      }
      return Type.Object(props, opts);
    }
    default: {
      // 未知 type / 缺 type — 兜底 Any
      return Type.Any();
    }
  }
}

/**
 * $ref 解析. 支持格式:
 *   - "#/definitions/Foo" (JSON Schema draft-07)
 *   - "#/$defs/Foo"     (JSON Schema 2020-12)
 *   - "#/components/schemas/Foo" (OpenAPI)
 * @returns 解析后的 schema, 失败返回 null
 */
function resolveRef(root, ref) {
  if (!ref.startsWith('#/')) return null;
  const path = ref.slice(2).split('/');
  let cur = root;
  for (const seg of path) {
    if (!cur || typeof cur !== 'object') return null;
    cur = cur[decodeURIComponent(seg)];
  }
  return cur && typeof cur === 'object' ? cur : null;
}

/**
 * 合并 allOf 里的 object schemas.
 * 简化策略: 把所有 object 类型成员的 properties / required 合并, 冲突后者覆盖.
 * 非 object 类型走 Type.Intersect.
 */
function mergeAllOf(schemas, root, visited) {
  const objectMembers = [];
  for (const s of schemas) {
    // 解析 $ref 优先 (常见 pattern: allOf: [{$ref: Base}, {extra}])
    const resolved = (typeof s.$ref === 'string') ? resolveRef(root, s.$ref) : s;
    if (resolved && typeof resolved === 'object' && resolved.type === 'object') {
      objectMembers.push(resolved);
    } else {
      return null;  // 含有非 object, 走 Intersect 分支
    }
  }
  if (objectMembers.length === 0) return null;

  const props = {};
  const required = new Set();
  for (const s of objectMembers) {
    if (s.properties && typeof s.properties === 'object') {
      for (const [k, p] of Object.entries(s.properties)) {
        // 跟 object case 一样: Type.Object 前决定 required
        const childType = convertSchema(p, root, new Set(visited));
        props[k] = required.has(k) ? childType : Type.Optional(childType);
      }
    }
    if (Array.isArray(s.required)) {
      for (const r of s.required) required.add(r);
    }
  }
  return Type.Object(props, { additionalProperties: false });
}
