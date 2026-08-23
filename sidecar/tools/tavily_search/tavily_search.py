#!/usr/bin/env python3
"""
tavily_search — Web search via Tavily API

ADR-0023 (2026-08-23): 这是 Pi Agent 的第一个 external tool example.
  - 通过 stdio JSON-RPC 跟 sidecar 通信
  - 调 Tavily REST API (https://api.tavily.com/search)
  - 纯 stdlib (urllib), 无外部依赖

配置:
  TAVILY_API_KEY  必填 env var, 在 Pi Agent settings.json 里配
                  (keychain 也行, 这里简单用 env)

用法 (user 视角):
  1. 把这个文件夹 copy 到 <workspace>/.pi/tools/external/tavily_search/
     或 <agentDir>/tools/external/tavily_search/
  2. 重启 Pi Agent sidecar (改配置后 FE 自动 trigger, 见 ADR-0023 P3-A)
  3. LLM 看到 tavily_search tool, 调它搜

协议 (跟 sidecar/externalTools.mjs 对齐):
  stdout: 一行一个 JSON
    { "type": "ready" }
    { "id": "...", "type": "result", "content": [{"type":"text","text":"..."}] }
    { "id": "...", "type": "error", "error": "..." }
  stdin: 一行一个 JSON
    { "id": "...", "type": "call", "args": {...} }
"""

import json
import os
import sys
import urllib.request
import urllib.error
import urllib.parse


TAVILY_API_URL = "https://api.tavily.com/search"


def send(obj):
    """stdout 写一行 JSON + flush. 跟 sidecar JSON-RPC 协议对齐."""
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def call_tavily(args: dict) -> str:
    """调 Tavily API, 返格式化文本结果."""
    api_key = os.environ.get("TAVILY_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError(
            "TAVILY_API_KEY 未设置. 在 Pi Agent Settings → General 配"
            "(或环境变量), 然后重启 sidecar."
        )

    query = args.get("query", "").strip()
    if not query:
        raise ValueError("query 不能为空")

    max_results = int(args.get("max_results", 5))
    max_results = max(1, min(20, max_results))  # clamp 1-20

    search_depth = args.get("search_depth", "basic")
    if search_depth not in ("basic", "advanced"):
        search_depth = "basic"

    topic = args.get("topic", "general")
    if topic not in ("general", "news"):
        topic = "general"

    body = json.dumps({
        "api_key": api_key,
        "query": query,
        "max_results": max_results,
        "search_depth": search_depth,
        "topic": topic,
        "include_answer": search_depth == "advanced",  # advanced 才返 answer
    }).encode("utf-8")

    req = urllib.request.Request(
        TAVILY_API_URL,
        data=body,
        method="POST",
        headers={"Content-Type": "application/json"},
    )

    try:
        with urllib.request.urlopen(req, timeout=25) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        # Tavily 4xx/5xx: body 通常有 detail 字段
        try:
            err_body = json.loads(e.read().decode("utf-8"))
            detail = err_body.get("detail", str(e))
        except Exception:
            detail = f"HTTP {e.code} {e.reason}"
        raise RuntimeError(f"Tavily API 错误: {detail}") from e
    except urllib.error.URLError as e:
        raise RuntimeError(f"网络错误: {e.reason}") from e
    except TimeoutError as e:
        raise RuntimeError("Tavily API 超时") from e

    # 格式化结果为 LLM 友好的文本
    lines = []

    # 1) AI answer (advanced 模式才有)
    answer = data.get("answer")
    if answer:
        lines.append(f"[AI Answer]\n{answer}\n")

    # 2) Results
    results = data.get("results", [])
    if not results:
        lines.append("(Tavily 没找到相关结果)")
        return "\n".join(lines)

    lines.append(f"[Results: {len(results)}]")
    for i, r in enumerate(results, 1):
        title = r.get("title", "(无标题)")
        url = r.get("url", "")
        content = r.get("content", "").strip()
        # 截 content 到 500 char, 防 LLM context 爆
        if len(content) > 500:
            content = content[:500] + "..."
        score = r.get("score")
        score_str = f" (relevance={score:.2f})" if isinstance(score, (int, float)) else ""
        lines.append(f"\n{i}. {title}{score_str}")
        lines.append(f"   URL: {url}")
        if content:
            lines.append(f"   {content}")

    return "\n".join(lines)


def main():
    # 1) 启动 ready
    send({"type": "ready"})

    # 2) 循环读 stdin, 处理 tool call
    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError as e:
            send({"type": "error", "error": f"bad json: {e}"})
            continue

        msg_type = msg.get("type")
        if msg_type != "call":
            # 忽略非 call 消息
            continue

        call_id = msg.get("id", "")
        args = msg.get("args") or {}

        try:
            text = call_tavily(args)
            send({
                "id": call_id,
                "type": "result",
                "content": [{"type": "text", "text": text}],
            })
        except Exception as e:
            send({
                "id": call_id,
                "type": "error",
                "error": f"{type(e).__name__}: {e}",
            })


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        # 正常退出
        sys.exit(0)
    except Exception as e:
        # 启动阶段错误 (e.g. import 失败), 写 stderr 方便 sidecar log
        print(f"tavily_search.py fatal: {e}", file=sys.stderr)
        sys.exit(1)
