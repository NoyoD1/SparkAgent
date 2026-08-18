/**
 * Session store — 真实 workspace + session 管理
 *
 * 数据模型:
 *   Workspace = 一个本地文件夹路径, 用 Tauri dialog picker 选
 *   Session   = 在某个 workspace 下的对话, 有 title + 时间 + 消息 (消息存 chat store)
 *
 * 持久化: localStorage `pi-agent:session:v1`
 * 兼容旧版: load 时 mock 数据不导入, 空状态开始
 */
import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';

export interface Workspace {
  id: string;
  name: string;        // 显示名, 默认 = 文件夹 basename
  path: string;        // 绝对路径
  createdAt: string;
}

export interface Session {
  id: string;
  workspaceId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /**
   * Bug #1 修 (2026-08-18): per-session stable piSessionId (uuid v4),
   * 让 sidecar 用独立 jsonl 加载历史. addSession 时 lazy 生成 + 持久化.
   * 跟 per-workspace 固定 id 解耦: 不同 session 各自独立 context.
   */
  piSessionId?: string;
}

const STORAGE_KEY = 'pi-agent:session:v1';

function loadFromStorage(): {
  workspaces: Workspace[];
  sessions: Session[];
  activeWorkspaceId: string | null;
  activeSessionId: string | null;
  expandedWorkspaceIds: string[];
} {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    return {
      workspaces: Array.isArray(parsed.workspaces) ? parsed.workspaces : [],
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
      activeWorkspaceId: parsed.activeWorkspaceId ?? null,
      activeSessionId: parsed.activeSessionId ?? null,
      expandedWorkspaceIds: Array.isArray(parsed.expandedWorkspaceIds) ? parsed.expandedWorkspaceIds : [],
    };
  } catch {
    return defaultState();
  }
}

function defaultState() {
  return {
    workspaces: [] as Workspace[],
    sessions: [] as Session[],
    activeWorkspaceId: null as string | null,
    activeSessionId: null as string | null,
    expandedWorkspaceIds: [] as string[],
  };
}

function saveToStorage(s: {
  workspaces: Workspace[];
  sessions: Session[];
  activeWorkspaceId: string | null;
  activeSessionId: string | null;
  expandedWorkspaceIds: string[];
}) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch (e) {
    console.warn('[session] localStorage save failed', e);
  }
}

function genId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function basename(path: string): string {
  // Windows: C:\foo\bar\baz -> baz; Unix: /foo/bar/baz -> baz
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || path;
}

export const useSessionStore = defineStore('session', () => {
  const initial = loadFromStorage();

  const workspaces = ref<Workspace[]>(initial.workspaces);
  const sessions = ref<Session[]>(initial.sessions);
  const activeWorkspaceId = ref<string | null>(initial.activeWorkspaceId);
  const activeSessionId = ref<string | null>(initial.activeSessionId);
  const expandedWorkspaceIds = ref<Set<string>>(new Set(initial.expandedWorkspaceIds));

  // 持久化: 任何 state 变化都写 localStorage
  watch(
    [workspaces, sessions, activeWorkspaceId, activeSessionId, expandedWorkspaceIds],
    () => {
      saveToStorage({
        workspaces: workspaces.value,
        sessions: sessions.value,
        activeWorkspaceId: activeWorkspaceId.value,
        activeSessionId: activeSessionId.value,
        expandedWorkspaceIds: Array.from(expandedWorkspaceIds.value),
      });
    },
    { deep: true },
  );

  // ===== Computed =====
  const activeSession = computed<Session | null>(() => {
    const id = activeSessionId.value;
    if (!id) return null;
    return sessions.value.find((s) => s.id === id) ?? null;
  });

  const activeWorkspace = computed<Workspace | null>(() => {
    const wid = activeWorkspaceId.value;
    if (wid) {
      return workspaces.value.find((w) => w.id === wid) ?? null;
    }
    // fallback: 从 active session 推
    const s = activeSession.value;
    if (s) return workspaces.value.find((w) => w.id === s.workspaceId) ?? null;
    return null;
  });

  function getSessionsByWorkspace(workspaceId: string): Session[] {
    return sessions.value
      .filter((s) => s.workspaceId === workspaceId)
      .sort((a, b) => (b.updatedAt > a.updatedAt ? 1 : -1));
  }

  function getWorkspace(id: string): Workspace | undefined {
    return workspaces.value.find((w) => w.id === id);
  }

  function isWorkspaceExpanded(id: string): boolean {
    return expandedWorkspaceIds.value.has(id);
  }

  function toggleWorkspaceExpanded(id: string) {
    const set = new Set(expandedWorkspaceIds.value);
    if (set.has(id)) set.delete(id);
    else set.add(id);
    expandedWorkspaceIds.value = set;
  }

  // ===== Actions =====

  function addWorkspace(input: { name?: string; path: string }): Workspace {
    const ws: Workspace = {
      id: genId('ws'),
      name: input.name?.trim() || basename(input.path),
      path: input.path,
      createdAt: new Date().toISOString(),
    };
    workspaces.value = [...workspaces.value, ws];
    // 自动展开
    expandedWorkspaceIds.value = new Set([...expandedWorkspaceIds.value, ws.id]);
    // 如果是第一个, 设为 active
    if (workspaces.value.length === 1) {
      activeWorkspaceId.value = ws.id;
    }
    return ws;
  }

  function removeWorkspace(id: string) {
    workspaces.value = workspaces.value.filter((w) => w.id !== id);
    // 删所有 session
    sessions.value = sessions.value.filter((s) => s.workspaceId !== id);
    // 清 active
    if (activeWorkspaceId.value === id) {
      activeWorkspaceId.value = workspaces.value[0]?.id ?? null;
    }
    if (activeSessionId.value && !sessions.value.find((s) => s.id === activeSessionId.value)) {
      activeSessionId.value = null;
    }
    // 清 expanded
    const set = new Set(expandedWorkspaceIds.value);
    set.delete(id);
    expandedWorkspaceIds.value = set;
  }

  function addSession(workspaceId: string, title = '新任务'): Session {
    const sess: Session = {
      id: genId('sess'),
      workspaceId,
      title,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      // Bug #1 修 (2026-08-18): 每个 FE session 独立的 piSessionId
      piSessionId: genPiSessionId(),
    };
    sessions.value = [sess, ...sessions.value];
    activeSessionId.value = sess.id;
    if (activeWorkspaceId.value !== workspaceId) {
      activeWorkspaceId.value = workspaceId;
    }
    // 确保 workspace 展开
    if (!expandedWorkspaceIds.value.has(workspaceId)) {
      expandedWorkspaceIds.value = new Set([...expandedWorkspaceIds.value, workspaceId]);
    }
    return sess;
  }

  /**
   * Bug #1 修 (2026-08-18): 给现有 session lazy 生成 piSessionId (如果还没有).
   * 旧 session 升级上来时 piSessionId undefined → 第一次 sendPrompt 时补一个.
   * 不会改 session.id (FE sessionId 不变, 只补 piSessionId).
   *
   * 启动时 App.vue 会调 migrateOldSessionIds, 把 configStore.perWorkspaceSessionId
   * 里的旧 id 派给每个 workspace 的第一个旧 session (保留旧 per-workspace 历史),
   * 其余旧 session lazy 生成新 id.
   */
  function ensurePiSessionId(sessionId: string): string | undefined {
    const s = sessions.value.find((x) => x.id === sessionId);
    if (!s) return undefined;
    if (!s.piSessionId) {
      s.piSessionId = genPiSessionId();
    }
    return s.piSessionId;
  }

  /**
   * Bug #1 修 (2026-08-18): 启动时迁移旧 per-workspace piSessionId 数据.
   *
   * 旧实现 (v0.4.2 step 1) 是 per-workspace 固定一个 piSessionId:
   *   configStore.perWorkspaceSessionId: { [wsPath]: piSessionId }
   *   同一 workspace 下所有 FE session 共享同一个 jsonl → 串历史
   *
   * 新实现 (v0.4.5.x+ 修) 是 per-session 独立 piSessionId:
   *   Session.piSessionId: string
   *   每个 FE session 各自独立 jsonl → 不串
   *
   * 迁移策略: 对每个没有 piSessionId 的旧 session, 找它所属 workspace:
   *   - 如果该 workspace 还没分配过旧 id (perWorkspaceIds[ws] 存在 且 该 ws 下没 session 已用这个 id)
   *     → 用旧 id (保留该 workspace 的旧历史)
   *   - 否则 → 生成新 uuid (历史清空, 是可接受 trade-off)
   *
   * 接受 fallbackPerWorkspaceIds: { [wsPath]: piSessionId } 来自 configStore,
   * 不依赖 configStore 避免循环 import.
   *
   * 幂等: 多次调用安全, 已有 piSessionId 的 session 不动.
   */
  function migrateOldSessionIds(fallbackPerWorkspaceIds: Record<string, string> = {}): number {
    // 记录哪些 workspace 的旧 id 已经被分给 session 了 (避免重复)
    const usedFallbackIds = new Set<string>();
    let migrated = 0;
    for (const s of sessions.value) {
      if (s.piSessionId) continue;  // 已经有, 跳过
      const fallback = fallbackPerWorkspaceIds[s.workspaceId];
      if (fallback && !usedFallbackIds.has(fallback)) {
        s.piSessionId = fallback;
        usedFallbackIds.add(fallback);
        migrated += 1;
        console.log(`[session] migrate: session=${s.id} (ws=${s.workspaceId}) → use old per-workspace piSessionId=${fallback.slice(0, 16)}…`);
      } else {
        // 没有旧 id 或已经被用 → 生成新
        s.piSessionId = genPiSessionId();
        migrated += 1;
        console.log(`[session] migrate: session=${s.id} (ws=${s.workspaceId}) → new piSessionId=${s.piSessionId.slice(0, 16)}… (旧历史清空, 可接受)`);
      }
    }
    if (migrated > 0) {
      console.log(`[session] migrate: total ${migrated} session(s) migrated to per-session piSessionId`);
    }
    return migrated;
  }

  /** uuid v4 generator (跟 config.ensureSessionIdForWorkspace 同 pattern, 但每个 session 一个) */
  function genPiSessionId(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    // fallback (Node 18+ / 旧 WebView)
    return 'pi-sess-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function removeSession(id: string) {
    sessions.value = sessions.value.filter((s) => s.id !== id);
    if (activeSessionId.value === id) {
      activeSessionId.value = null;
    }
  }

  function renameSession(id: string, title: string) {
    const s = sessions.value.find((x) => x.id === id);
    if (!s) return;
    s.title = title;
    s.updatedAt = new Date().toISOString();
  }

  function touchSession(id: string) {
    const s = sessions.value.find((x) => x.id === id);
    if (!s) return;
    s.updatedAt = new Date().toISOString();
  }

  function selectSession(id: string) {
    activeSessionId.value = id;
    const s = sessions.value.find((x) => x.id === id);
    if (s) {
      activeWorkspaceId.value = s.workspaceId;
    }
  }

  /**
   * v0.3.5+ 清除 active session, 回到 ChatMain 的 initial hero.
   * 不删任何 session 数据, 单纯 deselect (activeSessionId = null).
   * 用法: sidebar "新建任务" 按钮, 跳回首页让用户走"本地"下拉流程.
   */
  function clearActiveSession() {
    activeSessionId.value = null;
  }

  function selectWorkspace(id: string) {
    activeWorkspaceId.value = id;
  }

  return {
    // state
    workspaces,
    sessions,
    activeWorkspaceId,
    activeSessionId,
    expandedWorkspaceIds,
    // computed
    activeSession,
    activeWorkspace,
    // getters
    getSessionsByWorkspace,
    getWorkspace,
    isWorkspaceExpanded,
    // actions
    toggleWorkspaceExpanded,
    addWorkspace,
    removeWorkspace,
    addSession,
    removeSession,
    renameSession,
    touchSession,
    selectSession,
    clearActiveSession,
    selectWorkspace,
    ensurePiSessionId,  // Bug #1 修 (2026-08-18): per-session 独立 piSessionId
    migrateOldSessionIds,  // Bug #1 修 (2026-08-18): 启动时迁移旧 per-workspace id
  };
});
