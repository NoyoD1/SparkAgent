// 2026-08-25 v3.64: chat store 拆分 (commit 2) — 抽 streaming / retry / hang / phase / listener 状态
//   user 报告: chat store 2200+ 行太大. 这次抽 streaming 相关状态 + functions 到 module.
//   后续 commit 抽 queue / listeners / messages / ghost title / errors.
//
// 设计说明:
// - reactive ref 抽到 module-level singleton (跟 chat.ts Pinia store 共享).
//   风险: 多 store instance / 测试时 state 共享. Pi Agent 单实例 OK, 不影响生产.
// - compaction 状态 (compactionBySession, lastCompactionBySession) **留在 chat.ts**,
//   因为它依赖 contextTokensBySession 跟 usage 一起, 后续 v3.65+ 抽 chatUsage 时一起搬.
// - functions 全部用 closure 捕获 ref (跟原 chat.ts 行为一致).
//
// 不动行为: 所有 Vue 组件引用 useChatStore().streamingBySession 等不变, 内部从 module-level
// ref 直接导出.

import { ref } from 'vue';

// ===== reactive state (module-level singleton) =====

/** v0.4.2+: 当前 session 是否在 streaming (LLM call 期间). */
export const streamingBySession = ref<Record<string, boolean>>({});

/** v0.4.2+ LLM 错误重试: retryBySession 记录当前 retry 状态 (attempt 进度 + 上次错误).
 *  v0.6.3-rc1: 取消 D210 的 FE 端 auto-retry, 当前只反映 Pi SDK 内部 retry (auto_retry_* events). */
export const retryBySession = ref<Record<string, { attempt: number; maxAttempts: number; errorMessage: string } | null>>({});

/** v0.5.0-D 第17轮 (D204): stream hang detector — 30s 无事件 + 仍 isStreaming → 标 hang. */
export const streamHangBySession = ref<Record<string, boolean>>({});

/** 上次 stream event 时间戳 (ms), hang detector 用. */
export const lastStreamEventAt = new Map<string, number>();

/** hang detector setTimeout handle. */
export const streamHangTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** v0.5.0-D 第25轮 (D210.2) BUG FIX: listener off 函数 Map.
 *  之前 sendPrompt 创建的 listener (const off = await piTauri.on(...)) 是 local 变量,
 *  sendPrompt 返回后 off 函数就丢了. agent_end willRetry=true 分支不调 off, 下次 sendPrompt
 *  又调 piTauri.on() 加新 listener, 老 listener 一直活着. 修法: Map 跟踪 off 函数.
 *  chat.ts sendPrompt 内部直接 import 用, cleanupListenerForSession 也 import 用. */
export const listenerOffBySession = new Map<string, () => void>();

/** v0.5.1: 阶段状态 (thinking / text / tool), UI status icon 切换. */
export const phaseBySession = ref<Record<string, 'idle' | 'thinking' | 'text' | 'tool'>>({});

// ===== 常量 =====

/** v0.5.0-D 第17轮 (D204): 30s 无事件 + 仍 isStreaming → 标 hang, 不 force stop. */
export const STREAM_HANG_TIMEOUT_MS = 30_000;

// ===== functions (闭包捕获 ref) =====

/** 取某 session 是否在 streaming. */
export function isStreaming(sessionId: string): boolean {
  return !!streamingBySession.value[sessionId];
}

/** 清空某 session hang 标记 + 重置 watchdog (UI "AI 响应较慢" 提示消失). */
export function clearStreamHang(sessionId: string): void {
  streamHangBySession.value = { ...streamHangBySession.value, [sessionId]: false };
  touchStreamEvent(sessionId);
  startStreamHangWatchdog(sessionId);
}

/** 记录某 session 收到 streaming event 的时间 (hang detector 用). */
export function touchStreamEvent(sessionId: string): void {
  lastStreamEventAt.set(sessionId, Date.now());
}

/** 启动 30s hang detector. 30s 内无事件 + 仍 isStreaming → 标 hang=true. */
export function startStreamHangWatchdog(sessionId: string): ReturnType<typeof setTimeout> {
  stopStreamHangWatchdog(sessionId);
  const timer = setTimeout(() => {
    // v0.6.3-rc1: 30s watchdog 只 warn + UI 提示, **不** force stop streaming
    //   user 反馈: "AI 有时候回复确实会超过 30 秒, 但实际上它真的在回复"
    //   之前 D209 + D210 的 force stop + auto retry 强制打断, 不合理.
    //   业务规则: 除非 sidecar 主动 emit error event, 或 user 主动 stop, 否则不中断 stream.
    const last = lastStreamEventAt.get(sessionId) || 0;
    const stillStreaming = !!streamingBySession.value[sessionId];
    if (stillStreaming && Date.now() - last >= STREAM_HANG_TIMEOUT_MS) {
      streamHangBySession.value = { ...streamHangBySession.value, [sessionId]: true };
      console.warn(
        `[chat] 30s slow stream detected for ${sessionId} (no events for ${STREAM_HANG_TIMEOUT_MS}ms). ` +
        `UI shows slow-response hint. Stream NOT force-stopped (user 反馈: AI 真的在回复时被强打断不合理). ` +
        `User 可以手动点 stop, 或继续等 LLM 真正 emit agent_end.`,
      );
    }
  }, STREAM_HANG_TIMEOUT_MS);
  streamHangTimers.set(sessionId, timer);
  return timer;
}

/** 停止某 session 的 hang detector timer. */
export function stopStreamHangWatchdog(sessionId: string): void {
  const t = streamHangTimers.get(sessionId);
  if (t) {
    clearTimeout(t);
    streamHangTimers.delete(sessionId);
  }
}

/** 设置某 session 阶段 (thinking / text / tool / idle), UI status icon 切换. */
export function setPhase(sessionId: string, phase: 'idle' | 'thinking' | 'text' | 'tool'): void {
  if (phaseBySession.value[sessionId] === phase) return;
  phaseBySession.value = { ...phaseBySession.value, [sessionId]: phase };
}

/** 取某 session 阶段. */
export function getPhase(sessionId: string): 'idle' | 'thinking' | 'text' | 'tool' {
  return phaseBySession.value[sessionId] ?? 'idle';
}

/** v0.5.0-D 第25轮 (D210.2) BUG FIX: 调 listener 的 off() + 从 Map 删除.
 *  sendPrompt 进来前 + watchdog force stop 时 + agent_end willRetry=false 都调. */
export function cleanupListenerForSession(sessionId: string): void {
  const off = listenerOffBySession.get(sessionId);
  if (off) {
    try { off(); } catch (e) { console.warn('[chat] D210.2: listener off() failed (ignored)', e); }
    listenerOffBySession.delete(sessionId);
  }
}
