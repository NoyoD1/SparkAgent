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
    selectWorkspace,
  };
});
