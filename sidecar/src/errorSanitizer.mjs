// 2026-08-21 v0.6.3-rc1 P2-6: 工具错误 sanitize — 把底层异常 (fetch failed / stack trace /
// 4xx 5xx raw status) 翻译成 user 看得懂的分类 + 行动提示.
//
// 之前 user 看到的是 raw error: "fetch failed" / "401 Unauthorized" / "ECONNREFUSED 127.0.0.1:3000"
// 根本分不清是 key 过期 / rate limit / 服务器挂了 / 网络问题.
//
// 现在输出格式: "[<emoji> <分类>] <行动提示>\n原始: <raw error>"
//  - emoji + 分类: 让 user 一眼看出问题类型
//  - 行动提示: 告诉 user 怎么修 (去 Settings 改 key / 等 30s 重试 / 检查 url)
//  - 原始: 留底, dev tools 排查用
//
// 检测优先级 (前匹配覆盖后):
//   1. HTTP status code (401/403/404/408/429/5xx/4xx) — 数字最具体
//   2. Node 网络错误代码 (ECONN* / ENOTFOUND / ETIMEDOUT)
//   3. fetch failed / AbortError — 通用兜底
//   4. 未知 — 返回 category='unknown', user 看到原始消息自己排查

const ICON_BY_CATEGORY = {
  auth_expired: '🔐',       // 401 - API key 过期/无效
  forbidden: '🚫',          // 403 - 鉴权通过但无权限
  not_found: '🔍',          // 404 - URL 错或资源不存在
  timeout_server: '⏱️',      // 408 - 服务器处理超时
  rate_limit: '⏱️',         // 429 - 请求太频繁
  server_error: '🔌',       // 5xx - 远程服务挂了
  client_error: '⚠️',       // 4xx - 请求格式问题
  connect_refused: '🔌',     // ECONNREFUSED - 端口没起
  dns_failed: '🌐',          // ENOTFOUND - DNS 解析失败
  connection_reset: '🔌',   // ECONNRESET - 连接被重置
  network_timeout: '⏱️',     // ETIMEDOUT - 网络层超时
  fetch_failed: '🔌',       // fetch failed - 通用 fetch 失败
  aborted: '⏹️',            // AbortError - 操作被中止 (含 timeout)
  spawn_failed: '🚫',       // stdio 子进程 spawn 失败 (ENOENT 等)
  bash_not_found: '🔧',     // ADR-0019 P0-1: bash shell 没装或没配置, 跟 spawn_failed 区分
  bash_dangerous: '🛡️',    // ADR-0019 P0-2: bash 命令匹配沙箱 deny list (rm -rf / format / 等)
  unknown: '❓',
};

/**
 * 把任意 error 转成 { category, hint, original }.
 * @param err: 任意 Error / string
 * @param ctx: 上下文 (e.g. { timeoutMs } for aborted 提示)
 */
export function classifyToolError(err, ctx = {}) {
  const original = err instanceof Error ? err.message : String(err);
  const lower = original.toLowerCase();
  const name = err && typeof err === 'object' ? err.name : '';

  // 1. HTTP status code — 数字最具体
  //    排除 port 数字 (e.g. "1:443" 里的 443 不算 4xx), 用 negative lookbehind/lookahead
  //    排除前后紧跟 : 或数字 (port / hex / 版本号)
  const httpMatch = original.match(/(?<![:\d])(4\d{2}|5\d{2})(?![:\d])/);
  if (httpMatch) {
    const code = httpMatch[1];
    if (code === '401') return {
      category: 'auth_expired',
      hint: '鉴权失败 (401): API key 可能过期、填错, 或 token 失效. 去 Settings → Provider 检查 key, 必要时重新生成',
      original,
    };
    if (code === '403') return {
      category: 'forbidden',
      hint: '权限不足 (403): key 有效但无访问权限 (e.g. token scope 不够 / 资源 ACL 拒绝). 联系服务方开权限',
      original,
    };
    if (code === '404') return {
      category: 'not_found',
      hint: '找不到资源 (404): URL 路径错, 或资源已删. 检查 url 字段 / MCP server 文档',
      original,
    };
    if (code === '408') return {
      category: 'timeout_server',
      hint: '服务器处理超时 (408): 远程 server 太久没响应, 可能是 server 端 bug 或负载高',
      original,
    };
    if (code === '429') return {
      category: 'rate_limit',
      hint: '请求被限流 (429): 短时间内调用太多次, 30-60 秒后重试, 或调整调用频率',
      original,
    };
    if (code.startsWith('5')) return {
      category: 'server_error',
      hint: `远程服务异常 (${code}): server 端 bug 或维护中, 稍后重试`,
      original,
    };
    if (code.startsWith('4')) return {
      category: 'client_error',
      hint: `请求被拒绝 (${code}): 请求参数 / body 不符合 server 期望, 检查 MCP tool args`,
      original,
    };
  }

  // 2. Node 网络错误 (按 error code 字符串匹配, 不依赖 err.code 因为我们 catch 的是 SDK 包装过的 Error)
  if (lower.includes('econnrefused')) return {
    category: 'connect_refused',
    hint: '连接被拒 (ECONNREFUSED): 远程服务没在监听, 检查 url 端口 / MCP server 是否启动',
    original,
  };
  if (lower.includes('enotfound')) return {
    category: 'dns_failed',
    hint: 'DNS 解析失败 (ENOTFOUND): 域名不存在或网络不通, 检查 url 域名 / DNS 设置',
    original,
  };
  if (lower.includes('econnreset')) return {
    category: 'connection_reset',
    hint: '连接被重置 (ECONNRESET): 网络不稳定或 server 主动断开, 重试一次',
    original,
  };
  if (lower.includes('etimedout') || lower.includes('network timeout')) return {
    category: 'network_timeout',
    hint: '网络层超时 (ETIMEDOUT): 可能是防火墙 / 代理拦截, 检查网络',
    original,
  };

  // 3. fetch failed / AbortError — 通用兜底
  if (lower.includes('fetch failed') || lower.includes('failed to fetch')) return {
    category: 'fetch_failed',
    hint: 'HTTP 请求失败: 检查 url / 网络 / 鉴权 header / 防火墙',
    original,
  };
  if (name === 'AbortError' || lower.includes('aborted') || lower.includes('this operation was aborted')) {
    const timeoutPart = ctx.timeoutMs ? ` (timeout=${ctx.timeoutMs}ms)` : '';
    return {
      category: 'aborted',
      hint: `操作被中止${timeoutPart}: 可能是 timeout, 或 user 主动中断. 调高 timeout 字段或重试`,
      original,
    };
  }

  // stdio 子进程 spawn 失败 (e.g. ENOENT = 找不到 .exe / 路径错)
  if (lower.includes('enoent') || lower.includes('spawn') && lower.includes('eno')) return {
    category: 'spawn_failed',
    hint: '子进程启动失败 (ENOENT): command 路径错或文件不存在, 检查 .pi/mcp/<name>.json 里的 command 字段',
    original,
  };

  // ADR-0019 P0-1: bash tool 找不到 shell (跟 MCP 的 spawn_failed 区分, 这里专指 bash tool)
  //   Pi SDK 抛 "No bash shell found. Options: 1. Install Git for Windows..."
  //   或 user 配的 shellPath 文件不存在
  if (lower.includes('no bash shell found') || lower.includes('custom shell path not found')) {
    return {
      category: 'bash_not_found',
      hint: 'bash shell 不可用: 1) 安装 Git for Windows (https://git-scm.com/download/win)  2) 或到 Settings → Bash 路径手动指定 bash.exe 绝对路径',
      original,
    };
  }

  // 4. 未知 — 原样返回, user 看到原始消息自己排查
  return {
    category: 'unknown',
    hint: '未知错误类型, 看原始消息排查',
    original,
  };
}

/**
 * 把 classify 结果拼成 user 看到的字符串.
 * 格式: "[<emoji> <category>] <hint>\n原始: <original>"
 */
export function formatToolError(classified) {
  const icon = ICON_BY_CATEGORY[classified.category] || '❓';
  return `[${icon} ${classified.category}] ${classified.hint}\n原始: ${classified.original}`;
}
