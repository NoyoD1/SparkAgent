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
// 2026-08-20 P0-1 补充 B: addSession 从全局 configStore 当前值复制 mode/model 作为新 session 初值.
//   config.ts 不反向 import session, 单向依赖安全.
import { useConfigStore } from './config';

export interface Workspace {
  id: string;
  name: string;        // 显示名, 默认 = 文件夹 basename
  path: string;        // 绝对路径
  /** 归一化后的路径 (Windows: 小写 + 正斜杠; macOS/Linux: 原样). 用于 dedup 比对. */
  pathNormalized: string;
  createdAt: string;
  /**
   * v0.6+: 是否默认 workspace (<home>/PiAgent). UI 用徽标提示, 删时弹窗升级文案.
   * 旧数据无此字段 → undefined → falsy (历史 ws 不算默认).
   */
  isDefault?: boolean;
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
  // ===== Phase 1 (v0.6): 扩展字段, 旧数据无这字段 → undefined → 默认 false/[] =====
  /** LLM 生成的标题 (Phase 6 自动生成), UI 显示优先级: autoTitle > title */
  autoTitle?: string;
  /** 归档标记, true = 不在 workspace 树显示, 在 sidebar 顶层 🗄 归档 section 显示 */
  archived?: boolean;
  /** 归档时间 (ISO), 排序用 */
  archivedAt?: string;
  /** Pin / 收藏, true = 在 workspace 树顶部 "📌 Pinned" section 显示 */
  pinned?: boolean;
  /** Pin 时间 (ISO), 排序用 */
  pinnedAt?: string;
  /** 用户自定义标签, 走 sidebar 搜索时也匹配 */
  tags?: string[];

  // ===== 2026-08-20 P0-1 补充 B: per-session 存授权模式 + model =====
  // 旧实现是全局共用 (configStore.permissionMode / activeProvider / activeModel), 业务上不合理:
  //   - 用户开新 session, 但全局 mode 切到 'ask' 了, 上一个 'smart' session 也跟着变
  //   - 多 session 并行 (一个跑 deepseek, 一个跑 minimax) 做不到
  // 新实现: 每 session 存自己用的 mode + provider + model. addSession 时从全局当前值复制作为初值.
  // undefined 表示"用全局默认" (兼容旧 session, 不强制 migrate).
  /** tool permission mode, undefined = 跟全局 configStore.permissionMode. */
  permissionMode?: 'ask' | 'smart' | 'allow';
  /** 当前 session 用的 provider id, undefined = 跟全局 configStore.activeProviderId. */
  providerId?: string;
  /** 当前 session 用的 model id, undefined = 跟全局 configStore.activeProvider.activeModelId. */
  modelId?: string;
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
    const wsList: Workspace[] = Array.isArray(parsed.workspaces) ? parsed.workspaces : [];
    // 0.2 兼容: 旧 localStorage 没 pathNormalized, 这里 lazy 补; 不补 saveToStorage,
    // 由后续 watch 自动持久化.
    for (const w of wsList) {
      if (!w.pathNormalized) {
        w.pathNormalized = normalizePathForCompare(w.path);
      }
    }
    return {
      workspaces: wsList,
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

/**
 * 归一化路径用于 dedup 比对.
 * - Windows: 统一正斜杠 + 小写 (大小写不敏感), 跟 isPathWithinWorkspace 行为一致.
 * - macOS/Linux: 原样 (大小写敏感, 不动 unicode, 见 ADR-0013 已知风险).
 *
 * 平台检测: 走 Tauri 2 的 `window.__TAURI_INTERNALS__` (同步拿到 platform 字符串).
 *   不用 navigator.userAgent (可能 UA 字符串不可靠) / 不用 process (浏览器没).
 *   拿不到时 (非 Tauri 环境, 例如 vite dev / unit test) 退化为: 路径含反斜杠或
 *   Windows 盘符 (^[A-Z]:) 视为 Windows, 否则 POSIX.
 *
 * 旧 path 不归一化 (避免历史 data 误判), 仅 addWorkspace 时算.
 */
function detectWindowsPath(p: string): boolean {
  // Windows 特征: 路径含反斜杠, 或以盘符开头 (e.g. C: D:)
  return p.includes('\\') || /^[A-Z]:/i.test(p);
}

function normalizePathForCompare(p: string): string {
  let isWin: boolean;
  try {
    const t = (typeof window !== 'undefined' ? (window as any).__TAURI_INTERNALS__ : null);
    if (t && typeof t.platform === 'string') {
      isWin = t.platform === 'windows';
    } else {
      isWin = detectWindowsPath(p);
    }
  } catch {
    isWin = detectWindowsPath(p);
  }
  if (isWin) {
    return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  }
  return p.replace(/\/+$/, '');
}

/**
 * 检查 candidatePath 是否 === basePath, 或 candidatePath 是 basePath 的祖先, 或 basePath 是 candidatePath 的祖先.
 * 用于 addWorkspace dedup: 拒绝同路径 / 父子嵌套.
 * @returns 'exact' | 'ancestor' | 'descendant' | null
 */
function pathRelation(candidate: string, base: string): 'exact' | 'ancestor' | 'descendant' | null {
  if (candidate === base) return 'exact';
  const cWithSlash = candidate.endsWith('/') ? candidate : candidate + '/';
  const bWithSlash = base.endsWith('/') ? base : base + '/';
  if (cWithSlash.startsWith(bWithSlash)) return 'descendant';  // candidate 在 base 之下
  if (bWithSlash.startsWith(cWithSlash)) return 'ancestor';   // candidate 是 base 的祖先
  return null;
}

export const useSessionStore = defineStore('session', () => {
  const initial = loadFromStorage();

  const workspaces = ref<Workspace[]>(initial.workspaces);
  const sessions = ref<Session[]>(initial.sessions);
  const activeWorkspaceId = ref<string | null>(initial.activeWorkspaceId);
  const activeSessionId = ref<string | null>(initial.activeSessionId);
  const expandedWorkspaceIds = ref<Set<string>>(new Set(initial.expandedWorkspaceIds));
  /**
   * v0.6+: 切 workspace in-flight flag. selectWorkspace 期间为 true,
   * sendPrompt 看到 true 拒绝发送 (避免 sidecar 还没就绪时写到错的 workspace).
   * UI 用来显示 skeleton.
   * sidecar 切换完成信号还没明确, 先用 chat store 发出的 session_ready 事件清零;
   * 见 chat.ts sendPrompt 入口的 "切换中" 兜底.
   */
  const isSwitchingWorkspace = ref(false);
  let switchingSafetyTimer: number | null = null;

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

  // ===== Phase 1: 新 getters (sidebar 改造用) =====

  /**
   * 当前 workspace 下未归档 session, 排序: pinned 优先, 再 updatedAt 倒序
   * workspace 树主列表用 (过滤掉 archived)
   */
  function activeSessionsByWorkspace(workspaceId: string): Session[] {
    return sessions.value
      .filter((s) => s.workspaceId === workspaceId && !s.archived)
      .sort((a, b) => {
        if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
        return b.updatedAt > a.updatedAt ? 1 : -1;
      });
  }

  /**
   * 当前 workspace 下 pinned + active 的 session
   * workspace 树顶部 "📌 Pinned" section 用
   */
  function pinnedSessionsByWorkspace(workspaceId: string): Session[] {
    return sessions.value
      .filter((s) => s.workspaceId === workspaceId && !s.archived && s.pinned)
      .sort((a, b) => {
        const ta = a.pinnedAt ?? a.updatedAt;
        const tb = b.pinnedAt ?? b.updatedAt;
        return tb > ta ? 1 : -1;
      });
  }

  /**
   * 跨所有 workspace 的归档 session, 排序: archivedAt 倒序
   * sidebar 顶层 🗄 归档 section 用
   */
  const archivedSessions = computed<Session[]>(() => {
    return sessions.value
      .filter((s) => s.archived)
      .sort((a, b) => (b.archivedAt ?? '') > (a.archivedAt ?? '') ? 1 : -1);
  });

  /**
   * 跨所有 workspace 搜 session, 匹配 title / autoTitle / tags
   * sidebar 顶层搜索框用
   * 返回: [{ session, match: 'title' | 'autoTitle' | 'tag:xxx' }, ...]
   */
  function searchSessions(query: string): Array<{ session: Session; match: 'title' | 'autoTitle' | `tag:${string}` }> {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const results: Array<{ session: Session; match: 'title' | 'autoTitle' | `tag:${string}` }> = [];
    for (const s of sessions.value) {
      if (s.title.toLowerCase().includes(q)) {
        results.push({ session: s, match: 'title' });
        continue;
      }
      if (s.autoTitle && s.autoTitle.toLowerCase().includes(q)) {
        results.push({ session: s, match: 'autoTitle' });
        continue;
      }
      if (s.tags && s.tags.length) {
        const hit = s.tags.find((t) => t.toLowerCase().includes(q));
        if (hit) {
          results.push({ session: s, match: `tag:${hit}` as `tag:${string}` });
          continue;
        }
      }
    }
    return results;
  }

  function toggleWorkspaceExpanded(id: string) {
    const set = new Set(expandedWorkspaceIds.value);
    if (set.has(id)) set.delete(id);
    else set.add(id);
    expandedWorkspaceIds.value = set;
  }

  // ===== Actions =====

  function addWorkspace(input: { name?: string; path: string; isDefault?: boolean }): Workspace {
    const normalized = normalizePathForCompare(input.path);
    // 0.2: dedup — 拒同路径 / 父子嵌套. 父子嵌套会造成同 session 在两个 ws 都看到
    //       + sandbox 行为不一致 (sub 写父区会被 block), 见 ADR-0013.
    for (const existing of workspaces.value) {
      const rel = pathRelation(normalized, existing.pathNormalized);
      if (rel) {
        console.warn(
          `[session] addWorkspace rejected: ${rel} match with existing "${existing.name}" (${existing.pathNormalized})`,
        );
        // 复用已有 ws (UX: 用户点完 picker 看到的就是已有的, 不会"消失")
        return existing;
      }
    }
    const ws: Workspace = {
      id: genId('ws'),
      name: input.name?.trim() || basename(input.path),
      path: input.path,
      pathNormalized: normalized,
      createdAt: new Date().toISOString(),
      isDefault: input.isDefault,
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
    const target = workspaces.value.find((w) => w.id === id);
    if (!target) return;
    // 0.4: 如果是默认 workspace, 清 isDefault 标记 (新建的同名会重新标记, 旧幽灵 id 不再被认)
    //       store 行为不变, UI 弹窗里已经说明这点.
    workspaces.value = workspaces.value.filter((w) => w.id !== id);
    // 删所有 session
    sessions.value = sessions.value.filter((s) => s.workspaceId !== id);
    // 清 active
    if (activeWorkspaceId.value === id) {
      activeWorkspaceId.value = workspaces.value[0]?.id ?? null;
      // 切到了别的 workspace, 标记 in-flight 等 sidecar 跟上
      isSwitchingWorkspace.value = true;
    }
    if (activeSessionId.value && !sessions.value.find((s) => s.id === activeSessionId.value)) {
      activeSessionId.value = null;
    }
    // 清 expanded
    const set = new Set(expandedWorkspaceIds.value);
    set.delete(id);
    expandedWorkspaceIds.value = set;
  }

  function addSession(
    workspaceId: string,
    title = '新任务',
    /**
     * 2026-08-20 P0-1 补充 B: per-session settings 初值.
     * 不传则从全局 configStore 当前值复制 (用户新建 session 时, 看到的还是他刚选的 model/mode).
     * 调用方传非 undefined 时完全用传入的 (e.g. 编程式新建带固定 mode).
     */
    defaults?: { permissionMode?: 'ask' | 'smart' | 'allow'; providerId?: string; modelId?: string },
  ): Session {
    // 复制全局当前值作为新 session 默认 (单向 import configStore, configStore 不引 session, 无循环).
    let initialMode: 'ask' | 'smart' | 'allow' | undefined;
    let initialProviderId: string | undefined;
    let initialModelId: string | undefined;
    if (defaults) {
      initialMode = defaults.permissionMode;
      initialProviderId = defaults.providerId;
      initialModelId = defaults.modelId;
    } else {
      try {
        const cfg = useConfigStore();
        initialMode = cfg.permissionMode;
        const activeProvider = cfg.activeProvider;
        initialProviderId = activeProvider?.id ?? undefined;
        initialModelId = activeProvider?.activeModelId ?? undefined;
      } catch (e) {
        // configStore 还没 init (e.g. 测试环境), 走 fallback undefined → 上层走全局 fallback
        console.warn('[session] addSession: configStore unavailable, leave per-session settings undefined', e);
      }
    }
    const sess: Session = {
      id: genId('sess'),
      workspaceId,
      title,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      // Bug #1 修 (2026-08-18): 每个 FE session 独立的 piSessionId
      piSessionId: genPiSessionId(),
      // 2026-08-20 P0-1 补充 B: per-session settings 初值
      permissionMode: initialMode,
      providerId: initialProviderId,
      modelId: initialModelId,
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
    if (activeWorkspaceId.value === id) return;  // no-op
    activeWorkspaceId.value = id;
    // 0.3: 切 ws 标记 in-flight. sidecar 还在切 (重启 + setSessionFile) 时,
    // sendPrompt 会被 chat store 拒绝, 避免写到错的 workspace.
    // 完成信号: sidecar 第一次 'message_start' (chat store 收到) 时由 chat store 清零;
    // 没 active session 的情况下, 用一个短 timeout 兜底 (~1.5s 通常 sidecar 已就绪).
    isSwitchingWorkspace.value = true;
    if (switchingSafetyTimer) window.clearTimeout(switchingSafetyTimer);
    switchingSafetyTimer = window.setTimeout(() => {
      isSwitchingWorkspace.value = false;
      switchingSafetyTimer = null;
    }, 1500);
  }

  /**
   * 0.3 配套: 切 workspace 完成时由 chat store 显式调, 取消 in-flight flag 早于 timeout.
   * 没有这个调用, 1.5s 兜底 timer 也会兜住; 但显式调能让 active session 立即可用.
   */
  function finishWorkspaceSwitch() {
    if (switchingSafetyTimer) {
      window.clearTimeout(switchingSafetyTimer);
      switchingSafetyTimer = null;
    }
    isSwitchingWorkspace.value = false;
  }

  // ===== Phase 1: 新 actions (sidebar 改造用) =====

  /**
   * 归档 session (软删除, 不删 Pi SDK file)
   * UI 流程: active session → 右键 → Archive → ConfirmDialog → 调本函数
   */
  function archiveSession(id: string) {
    const s = sessions.value.find((x) => x.id === id);
    if (!s) return;
    s.archived = true;
    s.archivedAt = new Date().toISOString();
    s.updatedAt = s.archivedAt;
  }

  /**
   * 恢复归档 session
   * UI 流程: archive 列表 → 右键 → Restore → 调本函数
   */
  function restoreSession(id: string) {
    const s = sessions.value.find((x) => x.id === id);
    if (!s) return;
    s.archived = false;
    s.archivedAt = undefined;
    s.updatedAt = new Date().toISOString();
  }

  /**
   * 永久删除 session (从 store 移除, chat store 联动)
   * ⚠️ 仅允许对 archived session 调, UI 必须在 archive 列表才显示此入口 (Phase 3 流程约束)
   * 实际不删 Pi SDK jsonl file, 跟现有 removeSession 行为一致
   */
  function deleteSessionPermanently(id: string) {
    sessions.value = sessions.value.filter((s) => s.id !== id);
    if (activeSessionId.value === id) {
      activeSessionId.value = null;
    }
  }

  /**
   * Pin / unpin session
   * pinned=true 时设 pinnedAt 时间, false 时清
   */
  function setPinned(id: string, pinned: boolean) {
    const s = sessions.value.find((x) => x.id === id);
    if (!s) return;
    s.pinned = pinned;
    s.pinnedAt = pinned ? new Date().toISOString() : undefined;
    s.updatedAt = new Date().toISOString();
  }

  function togglePin(id: string) {
    const s = sessions.value.find((x) => x.id === id);
    if (!s) return;
    setPinned(id, !s.pinned);
  }

  /**
   * 设置 LLM 生成的标题 (Phase 6 调用)
   * 注意: 不动 user 手动改的 title, 只填 autoTitle 字段
   */
  function setAutoTitle(id: string, title: string) {
    const s = sessions.value.find((x) => x.id === id);
    if (!s) return;
    s.autoTitle = title;
    s.updatedAt = new Date().toISOString();
  }

  /**
   * 加 tag (trim + 重复跳过)
   */
  function addTag(id: string, tag: string) {
    const s = sessions.value.find((x) => x.id === id);
    if (!s) return;
    const t = tag.trim();
    if (!t) return;
    if (!s.tags) s.tags = [];
    if (s.tags.includes(t)) return;
    s.tags = [...s.tags, t];
    s.updatedAt = new Date().toISOString();
  }

  /**
   * 删 tag
   */
  function removeTag(id: string, tag: string) {
    const s = sessions.value.find((x) => x.id === id);
    if (!s || !s.tags) return;
    s.tags = s.tags.filter((t) => t !== tag);
    s.updatedAt = new Date().toISOString();
  }

  // ===== 2026-08-20 P0-1 补充 B: per-session settings 读写 helpers =====
  // 设计: session 上字段 undefined → 用全局 configStore 当前值 (call-by-call 查, 不缓存)
  // 原因: 全局值可能在跑的时候改 (P1 的 set_permission_mode), 不缓存避免一致性问题.
  // 同时这些函数不抛错, 找不到 session / configStore 未 init 时返回 fallback, 上层零负担.

  /**
   * 取 session 的 permission mode, undefined → 走全局 configStore.permissionMode.
   * 永远返回合法值 (ask / smart / allow), 不会 undefined.
   */
  function getSessionPermissionMode(id: string): 'ask' | 'smart' | 'allow' {
    const s = sessions.value.find((x) => x.id === id);
    if (s?.permissionMode) return s.permissionMode;
    try {
      return useConfigStore().permissionMode;
    } catch {
      return 'ask';
    }
  }

  /**
   * 取 session 的 provider id, undefined → 走全局 configStore.activeProviderId.
   * 可能返回 null (没 active provider).
   */
  function getSessionProviderId(id: string): string | null {
    const s = sessions.value.find((x) => x.id === id);
    if (s?.providerId) return s.providerId;
    try {
      return useConfigStore().activeProviderId;
    } catch {
      return null;
    }
  }

  /**
   * 取 session 的 model id, undefined → 走 session provider 的 activeModelId.
   * 找不到 provider 时返回 null.
   */
  function getSessionModelId(id: string): string | null {
    const s = sessions.value.find((x) => x.id === id);
    if (s?.modelId) return s.modelId;
    const providerId = getSessionProviderId(id);
    if (!providerId) return null;
    try {
      const cfg = useConfigStore();
      const p = cfg.providers.find((x) => x.id === providerId);
      return p?.activeModelId ?? null;
    } catch {
      return null;
    }
  }

  /**
   * 直接设 session 自己的 permission mode (不联动全局).
   * UI 入口: Composer 切 mode → sessionStore.setSessionPermissionMode(activeId, mode).
   */
  function setSessionPermissionMode(id: string, mode: 'ask' | 'smart' | 'allow') {
    const s = sessions.value.find((x) => x.id === id);
    if (!s) return;
    s.permissionMode = mode;
    s.updatedAt = new Date().toISOString();
  }

  /**
   * 直接设 session 自己的 provider + model (不联动全局).
   * UI 入口: Composer 切 model → sessionStore.setSessionModel(activeId, providerId, modelId).
   */
  function setSessionModel(id: string, providerId: string, modelId: string) {
    const s = sessions.value.find((x) => x.id === id);
    if (!s) return;
    s.providerId = providerId;
    s.modelId = modelId;
    s.updatedAt = new Date().toISOString();
  }

  return {
    // state
    workspaces,
    sessions,
    activeWorkspaceId,
    activeSessionId,
    expandedWorkspaceIds,
    isSwitchingWorkspace,  // 0.3: 切 ws in-flight flag
    // computed
    activeSession,
    activeWorkspace,
    // getters
    getSessionsByWorkspace,
    getWorkspace,
    isWorkspaceExpanded,
    // Phase 1: 新 getters
    activeSessionsByWorkspace,
    pinnedSessionsByWorkspace,
    archivedSessions,
    searchSessions,
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
    finishWorkspaceSwitch,  // 0.3: sidecar 切完时由 chat store 调
    ensurePiSessionId,  // Bug #1 修 (2026-08-18): per-session 独立 piSessionId
    migrateOldSessionIds,  // Bug #1 修 (2026-08-18): 启动时迁移旧 per-workspace id
    // Phase 1: 新 actions
    archiveSession,
    restoreSession,
    deleteSessionPermanently,
    setPinned,
    togglePin,
    setAutoTitle,
    addTag,
    removeTag,
    // 2026-08-20 P0-1 补充 B: per-session settings helpers
    getSessionPermissionMode,
    getSessionProviderId,
    getSessionModelId,
    setSessionPermissionMode,
    setSessionModel,
  };
});
