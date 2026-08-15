/**
 * Pi WS Client — 跟 server 的 /api/chat 端点单 WS 长连接.
 *
 * v0.2 协议 (apiKey 走 server .env, 不走协议):
 *   client → server: { type: 'config', provider, model, thinkingLevel, baseUrl? }
 *                    { type: 'prompt', sessionId, content }
 *   server → client: ready | config_ok | config_error | agent_* | message_* | tool_* | error
 *
 * 设计:
 * - 单例 WS, 整个 app 一个连接
 * - 自动重连 (backoff)
 * - sendConfig/sendPrompt 都是 fire-and-forget, 不等 server 回 ack
 *   (server 错误通过 on() listener 收 config_error / error 事件)
 */

import type { ServerToClient, ClientToServer } from '@/lib/api-types';

type Handler = (event: ServerToClient) => void;

const WS_URL: string = (() => {
  if (import.meta.env.DEV) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${location.host}/api/chat`;
  }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/api/chat`;
})();

class PiWsClient {
  private ws: WebSocket | null = null;
  private handlers = new Set<Handler>();
  private reconnectTimer: number | null = null;
  private connectPromise: Promise<void> | null = null;
  private isOpen = false;
  /** 当前连接已发过的 config (防止重复发) */
  private configSent = false;

  /** 注册事件 listener, 返回 unsubscribe */
  on(h: Handler): () => void {
    this.handlers.add(h);
    void this.ensureConnected();
    return () => this.handlers.delete(h);
  }

  ensureConnected(): Promise<void> {
    if (this.isOpen) return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = new Promise<void>((resolve, reject) => {
      try {
        this.ws = new WebSocket(WS_URL);
      } catch (e) {
        reject(e);
        this.connectPromise = null;
        return;
      }
      const onOpen = () => {
        this.isOpen = true;
        cleanup();
        resolve();
      };
      const onError = (e: Event) => {
        cleanup();
        reject(e);
        this.connectPromise = null;
      };
      const cleanup = () => {
        this.ws?.removeEventListener('open', onOpen);
        this.ws?.removeEventListener('error', onError);
      };
      this.ws.addEventListener('open', onOpen, { once: true });
      this.ws.addEventListener('error', onError, { once: true });
      this.ws.addEventListener('message', (ev) => this.handleMessage(ev));
      this.ws.addEventListener('close', () => this.handleClose());
    }).catch((err) => {
      console.error('[pi-ws] connect failed', err);
      this.scheduleReconnect();
      throw err;
    });
    return this.connectPromise;
  }

  private handleMessage(ev: MessageEvent) {
    let parsed: ServerToClient;
    try {
      parsed = JSON.parse(ev.data) as ServerToClient;
    } catch {
      console.warn('[pi-ws] bad JSON', ev.data);
      return;
    }
    for (const h of this.handlers) {
      try {
        h(parsed);
      } catch (e) {
        console.error('[pi-ws] handler threw', e);
      }
    }
  }

  private handleClose() {
    this.isOpen = false;
    this.configSent = false;  // 重连后要重发 config
    this.connectPromise = null;
    this.scheduleReconnect();
  }

  private scheduleReconnect() {
    if (this.reconnectTimer != null) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      void this.ensureConnected();
    }, 2000);
  }

  private send(msg: ClientToServer) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('[pi-ws] not open');
    }
    this.ws.send(JSON.stringify(msg));
  }

  /**
   * v0.2: 发 config (provider + model + thinkingLevel, 不含 apiKey)
   * apiKey 走 server .env
   * v0.2+: openai-compatible 传 apiKeyEnv (server 从 process.env[apiKeyEnv] 读)
   */
  async sendConfig(
    provider: string,
    model: string,
    thinkingLevel: 'off' | 'low' | 'medium' | 'high' = 'medium',
    baseUrl?: string,
    apiKeyEnv?: string,
  ): Promise<void> {
    await this.ensureConnected();
    this.send({ type: 'config', provider, model, thinkingLevel, baseUrl, apiKeyEnv });
    this.configSent = true;
  }

  /**
   * v0.2: 发 prompt. 每次都先发 config (让 server 拿到最新 active provider/model).
   * configGetter 是函数, 避免模块循环依赖, 调用时才读 store
   * 不再传 apiKey, server 从 .env 读
   */
  async sendPrompt(
    sessionId: string,
    content: string,
    configGetter: () => { provider: string; model: string; baseUrl?: string; apiKeyEnv?: string; thinkingLevel: 'off' | 'low' | 'medium' | 'high' } | null,
  ): Promise<void> {
    await this.ensureConnected();
    const cfg = configGetter();
    if (!cfg || !cfg.provider || !cfg.model) {
      throw new Error('[pi-ws] 未配置 Provider (去 Settings → Providers 选 provider + model, key 走 server .env)');
    }
    this.send({
      type: 'config',
      provider: cfg.provider,
      model: cfg.model,
      thinkingLevel: cfg.thinkingLevel,
      baseUrl: cfg.baseUrl,
      apiKeyEnv: cfg.apiKeyEnv,
    });
    this.configSent = true;
    this.send({ type: 'prompt', sessionId, content });
  }

  close() {
    if (this.reconnectTimer != null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this.isOpen = false;
    this.configSent = false;
  }
}

export const piWs = new PiWsClient();
void piWs.ensureConnected();
