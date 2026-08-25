// 2026-08-25 v3.65: chat store 拆分 (commit 3) — 抽 send queue
//   user 报告: chat store 2200+ 行. 这次抽 send queue 到 module.
//   后续 v3.66+ 抽 listeners / usage / messages / ghost / errors.
//
// 设计: 跟 chatStream.ts 一样, ref 抽到 module-level singleton, Pinia store 共享.
//
// Send queue 业务:
// - 用户在 LLM 还在回的时候可以继续编辑+点 send, 但不能再 spawn 一个 sidecar (状态机冲突),
//   所以消息先进队, 等当前 turn 走完 (agent_end willRetry=false) 再自动出队发送.
// - 不在内存里限上限 (用户连发 100 条也允许).
// - session 切换 / force stop 都不清空 (用户随时能看到).
// - session 删除 (removeSession) 才清队列, 防内存泄漏.
// D214 v5: 队列 item 改 {llm, user} 对象 — llm 是发给 LLM 的完整 prompt (含 <reference> block),
//   user 是给 user 气泡显示的干净文本 (无 reference section, 但有 [[ref:...]] marker 转 chip).

import { ref } from 'vue';

export type QueueItem = { llm: string; user: string };

/** v0.6 (P0-1 补充 A): send queue, per-session FIFO. */
export const sendQueueBySession = ref<Record<string, QueueItem[]>>({});

/** 取某 session 队列长度, UI 用来显示 "队列中 N 条" 徽标. */
export function getQueueLength(sessionId: string): number {
  return sendQueueBySession.value[sessionId]?.length ?? 0;
}

/** 清空某 session 队列. 用户在 Composer 队列气泡上点 × 调. */
export function clearSendQueue(sessionId: string): void {
  if (!sendQueueBySession.value[sessionId]?.length) return;
  sendQueueBySession.value = { ...sendQueueBySession.value, [sessionId]: [] };
  console.log('[chat] clearSendQueue: session=', sessionId);
}

/** 删队列里某条 (按 index). 用户点队列气泡里某条 × 调. */
export function removeFromQueue(sessionId: string, index: number): void {
  const list = sendQueueBySession.value[sessionId];
  if (!list || index < 0 || index >= list.length) return;
  const next = list.filter((_, i) => i !== index);
  sendQueueBySession.value = { ...sendQueueBySession.value, [sessionId]: next };
  console.log('[chat] removeFromQueue: session=', sessionId, 'index=', index, 'remaining=', next.length);
}
