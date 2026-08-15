# Pi Agent Server

> **Node.js 22 + Hono + WebSocket**, 包装 [`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) SDK.
> Phase 2 纯 SDK demo: 一个 WS endpoint, 接 prompt, 流式回推.

## 快速开始

```powershell
cd D:\UnityWork\Tools\Pi\server
cp .env.example .env
# 编辑 .env 填 API key + 选模型
npm install
npm run dev
```

服务起在 `http://localhost:3001` (HTTP) + `ws://localhost:3001/api/chat` (WS).

## 消息协议

**Client → Server:**
```json
{ "type": "prompt", "sessionId": "sess-1", "content": "你好" }
```

**Server → Client (stream events):**
```json
{ "type": "ready" }
{ "type": "agent_start" }
{ "type": "message_start" }
{ "type": "message_update", "delta": "你好" }
...
{ "type": "message_end" }
{ "type": "agent_end" }
```

详细事件类型见 `src/types.ts`.

## 健康检查

```bash
curl http://localhost:3001/health
# { "ok": true, "sessions": [], "model": { "provider": "anthropic", ... } }
```

## 配置

| Env | 默认 | 说明 |
|---|---|---|
| `PORT` | 3001 | HTTP + WS 端口 |
| `PI_MODEL_PROVIDER` | anthropic | LLM provider id (anthropic/openai/moonshotai/google/deepseek/...) |
| `PI_MODEL_ID` | claude-sonnet-4-6 | model id, 走 `getModel(provider, id)` |
| `PI_THINKING_LEVEL` | medium | off/low/medium/high |
| `ANTHROPIC_API_KEY` | - | Pi SDK 自动 pick up, 同理其他 provider 的 API key |

## 当前 demo 范围 (Phase 2)

- ✅ WS 接 prompt, 调 `createAgentSession`, 流式回推
- ✅ 默认只给 read/ls/grep/find 4 个只读工具 (避免 agent 改文件)
- ✅ in-memory session 缓存 (按 sessionId 复用, server 重启即丢)
- ❌ 落 sqlite 持久化 (Phase 3+)
- ❌ OAuth / 多 provider 自动切换 (Phase 3+)
- ❌ 业务 Extension 注入 (Phase 3+)
- ❌ 多用户/鉴权 (Phase 3+)
