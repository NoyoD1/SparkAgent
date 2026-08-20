/**
 * 2026-08-21 v0.6.3-rc1 P2-1: MCP server JSON 导入解析器
 *
 * 支持 3 种 JSON 格式 (auto-detect):
 *   1. 单个 server object: { "name": "...", "command": "...", "args": [...] }
 *   2. array:             [{...}, {...}, ...]
 *   3. Claude Desktop 标准: { "mcpServers": { "filesystem": {...}, "fetch": {...} } }
 *      (这是 Anthropic 官方 Claude Desktop / Cursor 用的标准格式, 复用现有配置)
 *
 * 跟 store / Rust 端校验规则同步:
 *   - name 必填, 1-64 char, [A-Za-z0-9._@-], 不跟 builtin 7 个重
 *   - command 必填, 非空
 *   - args 可选 string[]
 *   - env 可选 Record<string, string>
 *   - cwd 可选 string
 *   - timeout 可选 number
 *
 * 不在解析器里校验 builtin 冲突 (那是 store / Rust 端的事, 这里只做语法 + 字段类型).
 */

import { BUILTIN_TOOL_NAMES_MCP } from '@/stores/mcpServers';

export type ImportFormat = 'single' | 'array' | 'claudeDesktop';

export interface ParsedServer {
  /** server 名 (从 name 字段或外层 key 提取) */
  name: string;
  /** 启动命令 */
  command: string;
  /** 完整 JSON body (跟写入文件的格式一致) */
  body: string;
  /** 检测出的输入格式, 给 UI 显示 */
  sourceFormat: ImportFormat;
}

export interface ImportParseResult {
  /** 解析成功的 servers */
  servers: ParsedServer[];
  /** 解析失败的 entries (含失败原因, UI 给用户看) */
  invalid: Array<{ raw: unknown; reason: string }>;
  /** 检测出的整体格式 */
  format: ImportFormat | 'mixed' | 'unknown';
  /** 顶部 error (整个 JSON 都不合法时) */
  topError: string | null;
}

/**
 * 主入口: 解析 JSON 字符串, 返回 servers + invalid + format.
 * 不抛异常, 错误进 topError / invalid.
 */
export function parseMcpImportJson(jsonText: string): ImportParseResult {
  const result: ImportParseResult = {
    servers: [],
    invalid: [],
    format: 'unknown',
    topError: null,
  };

  // 1. 整体 parse
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (e) {
    result.topError = `JSON parse 失败: ${e instanceof Error ? e.message : String(e)}`;
    return result;
  }

  if (parsed === null || typeof parsed !== 'object') {
    result.topError = 'JSON 顶层必须是 object 或 array, 不接受 null / string / number';
    return result;
  }

  // 2. 探测格式
  const obj = parsed as Record<string, unknown>;

  // Claude Desktop 格式: { mcpServers: { name: {...} } }
  if (typeof obj.mcpServers === 'object' && obj.mcpServers !== null && !Array.isArray(obj.mcpServers)) {
    result.format = 'claudeDesktop';
    const mcpServers = obj.mcpServers as Record<string, unknown>;
    for (const [name, raw] of Object.entries(mcpServers)) {
      const serverResult = tryBuildServerFromObject(name, raw, 'claudeDesktop');
      if (serverResult.server) {
        result.servers.push(serverResult.server);
      } else {
        result.invalid.push({ raw, reason: serverResult.error ?? 'unknown' });
      }
    }
    return result;
  }

  // array 格式: [{...}, {...}]
  if (Array.isArray(parsed)) {
    result.format = 'array';
    parsed.forEach((item, idx) => {
      const serverResult = tryBuildServerFromObject(null, item, 'array', idx);
      if (serverResult.server) {
        result.servers.push(serverResult.server);
      } else {
        result.invalid.push({ raw: item, reason: serverResult.error ?? 'unknown' });
      }
    });
    return result;
  }

  // 单个 object 格式: {name, command, args}
  // 启发式: 有 name + command 字段就当 single
  if (typeof obj.name === 'string' && typeof obj.command === 'string') {
    result.format = 'single';
    const serverResult = tryBuildServerFromObject(obj.name, obj, 'single');
    if (serverResult.server) {
      result.servers.push(serverResult.server);
    } else {
      result.invalid.push({ raw: obj, reason: serverResult.error ?? 'unknown' });
    }
    return result;
  }

  // 4. 不识别
  result.topError =
    '无法识别 JSON 格式. 支持: ① 单个 server {name, command, args} ② array [{...}] ③ Claude Desktop {mcpServers: {name: {...}}}';
  result.invalid.push({
    raw: parsed,
    reason: '顶层 JSON 不匹配任何已知格式',
  });
  return result;
}

/**
 * 从一个 server config object 构造 ParsedServer.
 * @param nameOverride: 强制使用这个 name (Claude Desktop 格式 + array 格式用)
 * @param index: array 格式的索引, 错误信息里用
 * @returns: { server } 成功 / { error } 失败
 */
function tryBuildServerFromObject(
  nameOverride: string | null,
  raw: unknown,
  sourceFormat: ImportFormat,
  index?: number,
): { server: ParsedServer | null; error?: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { server: null, error: 'server config 必须是 JSON object' };
  }
  const obj = raw as Record<string, unknown>;
  const where = index !== undefined ? `[${index}]` : `"${nameOverride ?? '?'}"`;

  // 1. name
  const name = (nameOverride ?? (typeof obj.name === 'string' ? obj.name : '')).trim();
  if (!name) {
    return { server: null, error: `${where}: 缺 name 字段或为空` };
  }
  // FE 端预校验 (跟 Rust 端 parse_mcp_server_name 一致)
  // 限制: [A-Za-z0-9._@-] (跟 Rust 端一致, 拒绝 / 因为 Windows 文件名不允许)
  if (name.length > 64) {
    return { server: null, error: `${where}: name 长度 ${name.length} 超过 64` };
  }
  if (!/^[A-Za-z0-9._@-]+$/.test(name)) {
    return { server: null, error: `${where}: name '${name}' 含非法字符, 只能 [A-Za-z0-9._@-]` };
  }
  if (name === '.' || name === '..') {
    return { server: null, error: `${where}: name 不能是 '.' 或 '..'` };
  }
  if ((BUILTIN_TOOL_NAMES_MCP as readonly string[]).includes(name)) {
    return { server: null, error: `${where}: name '${name}' 跟 builtin tool 重名` };
  }

  // 2. command
  const command = typeof obj.command === 'string' ? obj.command.trim() : '';
  if (!command) {
    return { server: null, error: `${where}: 缺 command 字段或为空` };
  }

  // 3. args (可选)
  if (obj.args !== undefined) {
    if (!Array.isArray(obj.args)) {
      return { server: null, error: `${where}: args 必须是 array` };
    }
    for (let i = 0; i < obj.args.length; i++) {
      if (typeof obj.args[i] !== 'string') {
        return { server: null, error: `${where}: args[${i}] 必须是 string` };
      }
    }
  }

  // 4. env (可选)
  if (obj.env !== undefined) {
    if (!obj.env || typeof obj.env !== 'object' || Array.isArray(obj.env)) {
      return { server: null, error: `${where}: env 必须是 object` };
    }
    for (const [k, v] of Object.entries(obj.env)) {
      if (typeof v !== 'string') {
        return { server: null, error: `${where}: env.${k} 必须是 string` };
      }
    }
  }

  // 5. cwd (可选)
  if (obj.cwd !== undefined && typeof obj.cwd !== 'string') {
    return { server: null, error: `${where}: cwd 必须是 string` };
  }

  // 6. timeout (可选)
  if (obj.timeout !== undefined && typeof obj.timeout !== 'number') {
    return { server: null, error: `${where}: timeout 必须是 number` };
  }

  // 7. type (可选, 默认 stdio) v0.6.3-rc1 P2-1.3
  if (obj.type !== undefined) {
    if (typeof obj.type !== 'string') {
      return { server: null, error: `${where}: type 必须是 string` };
    }
    if (!['stdio', 'http', 'sse'].includes(obj.type)) {
      return { server: null, error: `${where}: type 必须是 'stdio' | 'http' | 'sse', got '${obj.type}'` };
    }
  }

  // 构造完整 body (跟用户填的等价, 含 name / type / command / args / env / cwd / timeout)
  const body: Record<string, unknown> = { name, command };
  if (obj.type !== undefined) body.type = obj.type;  // 不传时 Rust 端默认 stdio
  if (obj.args !== undefined) body.args = obj.args;
  if (obj.env !== undefined) body.env = obj.env;
  if (obj.cwd !== undefined) body.cwd = obj.cwd;
  if (obj.timeout !== undefined) body.timeout = obj.timeout;

  return {
    server: {
      name,
      command,
      body: JSON.stringify(body, null, 2),
      sourceFormat,
    },
  };
}

/**
 * UI 给用户的格式描述
 */
export function describeFormat(format: ImportFormat | 'mixed' | 'unknown'): string {
  switch (format) {
    case 'single': return '单个 server object';
    case 'array': return 'array of servers';
    case 'claudeDesktop': return 'Claude Desktop 标准格式 (mcpServers)';
    case 'mixed': return 'mixed (多个格式)';
    case 'unknown': return '未识别';
  }
}
