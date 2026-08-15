import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { MockSession, MockWorkspace } from '@/lib/mock/types';
import { mockWorkspaces, mockSessions } from '@/lib/mock/sessions';
import { useUiStore } from './ui';

export const useSessionStore = defineStore('session', () => {
  const workspaces = ref<MockWorkspace[]>(mockWorkspaces);
  const sessions = ref<MockSession[]>(mockSessions);

  // expanded workspace IDs
  const expandedWorkspaceIds = ref<Set<string>>(new Set(['ws-1']));

  const activeSessionId = computed(() => useUiStore().activeSessionId);

  const activeSession = computed<MockSession | null>(() => {
    const id = activeSessionId.value;
    if (!id) return null;
    return sessions.value.find((s) => s.id === id) ?? null;
  });

  const activeWorkspace = computed<MockWorkspace | null>(() => {
    const s = activeSession.value;
    if (!s) return null;
    return workspaces.value.find((w) => w.id === s.workspaceId) ?? null;
  });

  function getWorkspace(id: string): MockWorkspace | undefined {
    return workspaces.value.find((w) => w.id === id);
  }

  function getSessionsByWorkspace(workspaceId: string): MockSession[] {
    return sessions.value.filter((s) => s.workspaceId === workspaceId);
  }

  function toggleWorkspaceExpanded(id: string) {
    const set = expandedWorkspaceIds.value;
    if (set.has(id)) {
      set.delete(id);
    } else {
      set.add(id);
    }
    // trigger reactivity
    expandedWorkspaceIds.value = new Set(set);
  }

  function isWorkspaceExpanded(id: string): boolean {
    return expandedWorkspaceIds.value.has(id);
  }

  function selectSession(id: string) {
    useUiStore().setActiveSession(id);
  }

  function createNewSession(workspaceId?: string): MockSession {
    const ws = workspaceId ?? workspaces.value[0]?.id ?? 'ws-1';
    const newSession: MockSession = {
      id: `sess-${Date.now()}`,
      workspaceId: ws,
      title: '新任务',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    sessions.value = [newSession, ...sessions.value];
    useUiStore().setActiveSession(newSession.id);
    if (!expandedWorkspaceIds.value.has(ws)) {
      toggleWorkspaceExpanded(ws);
    }
    return newSession;
  }

  return {
    workspaces,
    sessions,
    expandedWorkspaceIds,
    activeSession,
    activeWorkspace,
    getWorkspace,
    getSessionsByWorkspace,
    toggleWorkspaceExpanded,
    isWorkspaceExpanded,
    selectSession,
    createNewSession,
  };
});
