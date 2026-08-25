// 2026-08-25 v3.63: chat store 拆分 (commit 1) — 抽 storage utilities
//   user 报告: chat store 2200+ 行太大 (ADR-0024 教训: 出问题不知道查哪).
//   拆 chatStorage.ts: localStorage load / save / sanitize, 跟 Pinia store 解耦.
//   后续 commit 继续抽 chatStream / chatQueue / chatListeners / chatMessages /
//   chatGhostTitle / chatErrors, chat.ts 改 facade. 这次先抽 storage, 风险最小.
//
// 设计原则:
// - module-level exports (没用 class / Pinia), 跟 chat.ts 共享 SessionChatData interface
// - localStorage 读写封装, 不在 chat.ts 内部出现
// - sanitizeForStorage 剥图片 in-memory base64 (避免 5MB quota 撑爆), 保留 savedPath

import type { ChatMessage, ThinkingBlock, ToolCallBlock } from '@/lib/mock/types';

export interface SessionChatData {
  messages: ChatMessage[];
  thinking: ThinkingBlock[];
  toolCalls: ToolCallBlock[];
}

export const STORAGE_KEY = 'pi-agent:chat:v1';

/** 从 localStorage 读全部 session 的 chat data, 失败 / 无 / 旧格式 → 返回 {}. */
export function loadFromStorage(): Record<string, SessionChatData> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const data = parsed as Record<string, SessionChatData>;
    // ADR-0022 v3.9: 升级路径 — 旧 localStorage 可能有 base64, load 时也剥掉
    //   跟 save 一样 sanitize, 避免 reload 后旧 base64 还在 quota 里撑着
    return sanitizeForStorage(data);
  } catch {
    return {};
  }
}

/** 写全部 session chat data 到 localStorage, 失败 console.warn 静默. */
export function saveToStorage(data: Record<string, SessionChatData>): void {
  try {
    // ADR-0022 v3.9: 持久化前 strip image 的 in-memory base64
    //   防止 localStorage quota (5MB) 被图片撑爆, 之前一发送图片就 QuotaExceededError
    //   base64 在 reload 后会丢失, 但 savedPath + thumbnail 还在 — click preview 时从 savedPath 重读
    const sanitized = sanitizeForStorage(data);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sanitized));
  } catch (e) {
    console.warn('[chat] localStorage save failed', e);
  }
}

/**
 * 深拷贝 + 剥掉 message.images[].data (in-memory base64)
 * 其余字段全部保留, 包括 images 的 savedPath / thumbnail / mimeType / bytes
 */
export function sanitizeForStorage(data: Record<string, SessionChatData>): Record<string, SessionChatData> {
  const out: Record<string, SessionChatData> = {};
  for (const [k, v] of Object.entries(data)) {
    out[k] = {
      messages: v.messages.map((m) => {
        if (!m.images || m.images.length === 0) return m;
        return {
          ...m,
          images: m.images.map((img) => {
            // 保留所有持久化字段, 只丢 in-memory data
            const { data: _data, ...rest } = img;
            return rest;
          }),
        };
      }),
      thinking: v.thinking,
      toolCalls: v.toolCalls,
    };
  }
  return out;
}

/** 生成 message id, 'u' = user, 'a' = assistant. */
export function genMessageId(role: 'u' | 'a'): string {
  return `msg-${Date.now()}-${role}`;
}

/** 空白 session data (兜底, 防止 undefined 报错). */
export function emptySessionData(): SessionChatData {
  return { messages: [], thinking: [], toolCalls: [] };
}
