// 模拟 user 的 MCP config, 验证 parseMcpImportJson 解析结果
// 1) 模拟 claudeDesktop 解析逻辑 (跟 mcpImport.ts 一致, 纯函数无外部 import)

const BUILTIN_TOOL_NAMES_MCP = ['read', 'write', 'edit', 'bash', 'ls', 'find', 'grep'];

function tryBuildServerFromObject(nameOverride, raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'server config 必须是 JSON object' };
  }
  const obj = raw;
  const where = nameOverride ?? '?';
  const name = (nameOverride ?? (typeof obj.name === 'string' ? obj.name : '')).trim();
  if (!name) return { error: `${where}: 缺 name 字段或为空` };
  if (name.length > 64) return { error: `${where}: name 长度 ${name.length} 超过 64` };
  if (!/^[A-Za-z0-9._@-]+$/.test(name)) {
    return { error: `${where}: name '${name}' 含非法字符` };
  }
  if (BUILTIN_TOOL_NAMES_MCP.includes(name)) {
    return { error: `${where}: name '${name}' 跟 builtin tool 重名` };
  }
  const serverType = typeof obj.type === 'string' ? obj.type : 'stdio';
  if (!['stdio', 'http', 'sse'].includes(serverType)) {
    return { error: `${where}: type 必须是 stdio|http|sse, got ${serverType}` };
  }
  const command = typeof obj.command === 'string' ? obj.command.trim() : '';
  if (serverType === 'stdio' && !command) {
    return { error: `${where}: type=stdio 缺 command` };
  }
  if (obj.args !== undefined) {
    if (!Array.isArray(obj.args)) return { error: `${where}: args 必须是 array` };
  }
  if (obj.env !== undefined) {
    if (!obj.env || typeof obj.env !== 'object' || Array.isArray(obj.env)) {
      return { error: `${where}: env 必须是 object` };
    }
  }
  const body = { name };
  if (obj.type !== undefined) body.type = obj.type;
  if (obj.url !== undefined) body.url = obj.url;
  if (obj.command !== undefined) body.command = obj.command;
  if (obj.args !== undefined) body.args = obj.args;
  if (obj.env !== undefined) body.env = obj.env;
  if (obj.cwd !== undefined) body.cwd = obj.cwd;
  if (obj.timeout !== undefined) body.timeout = obj.timeout;
  return { server: { name, command, body: JSON.stringify(body, null, 2) } };
}

function parseMcpImportJson(jsonText) {
  const result = { servers: [], invalid: [], format: 'unknown', topError: null };
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (e) {
    result.topError = `JSON parse 失败: ${e.message}`;
    return result;
  }
  if (parsed === null || typeof parsed !== 'object') {
    result.topError = 'JSON 顶层必须是 object 或 array';
    return result;
  }
  const obj = parsed;
  if (typeof obj.mcpServers === 'object' && obj.mcpServers !== null && !Array.isArray(obj.mcpServers)) {
    result.format = 'claudeDesktop';
    const mcpServers = obj.mcpServers;
    for (const [name, raw] of Object.entries(mcpServers)) {
      const r = tryBuildServerFromObject(name, raw);
      if (r.server) result.servers.push(r.server);
      else result.invalid.push({ raw, reason: r.error });
    }
    return result;
  }
  return result;
}

const userJson = `{
  "mcpServers": {
    "MiniMax": {
      "command": "uvx",
      "args": ["minimax-coding-plan-mcp", "-y"],
      "env": {
        "MINIMAX_API_KEY": "MINIMAX_API_KEY",
        "MINIMAX_API_HOST": "https://api.minimaxi.com"
      }
    }
  }
}`;

const result = parseMcpImportJson(userJson);
console.log('=== topError ===', result.topError);
console.log('=== format ===', result.format);
console.log('=== servers ===');
for (const s of result.servers) {
  console.log('name:', s.name);
  console.log('command:', s.command);
  console.log('body:');
  console.log(s.body);
}
console.log('=== invalid ===', result.invalid);
