/**
 * useChipPreview — 全局 chip 预览弹窗状态
 *
 * D214 v7: 用户点 chip 主体 (不是 × 按钮) 触发, 弹一个浮层显示完整
 *   skill/tool/mcp body. Composer 和 ChatMessage 都用同一个状态 (singleton)
 *   避免多组件各自管一份 ref, 也避免 Teleport 重复挂载.
 *
 * 用法:
 *   // 任意处触发预览
 *   const { openRef } = useChipPreview();
 *   openRef('skill', 'huashu-design', chipEl, event);  // event 用于定位
 *
 *   // App.vue mount 一次, 渲染浮层
 *   <ChipPreview />
 */
import { ref, type Ref } from 'vue';

export interface ChipPreviewState {
  kind: 'skill' | 'tool' | 'mcp';
  name: string;
  body: string;             // 拉到的 body (markdown / JSON / YAML 文本)
  title: string;            // 显示用标题 (e.g. "Skill · huashu-design")
  pos: { top: number; left: number; width: number };  // 锚点 chip 位置, 浮层跟着走
  loading: boolean;
  error: string | null;
}

const current = ref<ChipPreviewState | null>(null);

export function useChipPreview(): {
  current: Ref<ChipPreviewState | null>;
  openRef: (kind: 'skill' | 'tool' | 'mcp', name: string, anchor: HTMLElement) => Promise<void>;
  closeRef: () => void;
} {
  function closeRef() {
    current.value = null;
  }

  /**
   * 打开预览: 算位置 + 异步拉 body + 写状态.
   * 拉到之前先显示 loading 状态, 失败时显示 error.
   */
  async function openRef(
    kind: 'skill' | 'tool' | 'mcp',
    name: string,
    anchor: HTMLElement,
  ): Promise<void> {
    const rect = anchor.getBoundingClientRect();
    current.value = {
      kind,
      name,
      body: '',
      title: `${kind.toUpperCase()} · ${name}`,
      pos: {
        top: rect.top,
        left: rect.left,
        width: rect.width,
      },
      loading: true,
      error: null,
    };

    try {
      const body = await fetchRefBody(kind, name);
      // 拉完之后如果 user 已经手动关掉了, 就别覆盖
      if (current.value && current.value.kind === kind && current.value.name === name) {
        current.value = { ...current.value, body, loading: false };
      }
    } catch (e) {
      if (current.value && current.value.kind === kind && current.value.name === name) {
        current.value = {
          ...current.value,
          loading: false,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    }
  }

  return { current, openRef, closeRef };
}

/**
 * fetchRefBody — 按 kind 走对应 store + Tauri command 拉 body
 *   集中在这里, 避免在 click handler 里堆一堆 if/else.
 *
 * D214 v8.2: 启动时序问题 — store 可能还没从 sidecar / Tauri 拉数据 (FE 启动
 *   不一定先访问 Skills/Tools/MCP tab), 这时如果直接点 chat 气泡里的历史
 *   chip, 会因为 find 不到对应的 entry 抛 "X 不存在". 修法: find 失败时
 *   主动调对应 store 的 refresh 一次, 再 find, 仍找不到才 throw.
 *   这样 chat 历史里的 chip 不需要 user 先在输入框 "/" 触发被动刷新.
 */
async function fetchRefBody(kind: 'skill' | 'tool' | 'mcp', name: string): Promise<string> {
  // 动态 import 避免循环依赖 (store import tauri, tauri 不依赖 store)
  const { useSkillsStore } = await import('@/stores/skills');
  const { useUserToolsStore } = await import('@/stores/userTools');
  const { useMcpServersStore } = await import('@/stores/mcpServers');
  const { useSessionStore } = await import('@/stores/session');
  const { piTauri } = await import('@/lib/tauri');

  if (kind === 'skill') {
    const skillsStore = useSkillsStore();
    let skill = skillsStore.skills.find((s: any) => s.name === name);
    if (!skill) {
      // 启动时 store 是空, 主动拉一次 (跟 Composer.vue ensureResourcesLoaded 同 pattern)
      try { await skillsStore.refreshFromTauri(); } catch (e) { console.warn('[useChipPreview] skills refresh failed:', e); }
      skill = skillsStore.skills.find((s: any) => s.name === name);
    }
    if (!skill) throw new Error(`Skill 不存在: ${name}`);
    const parsed = await piTauri.readSkillFile(skill.filePath);
    // skill body: frontmatter 下面那部分 (raw 去掉 yaml 头)
    return parsed.raw || parsed.body || '';
  }

  if (kind === 'tool') {
    const userToolsStore = useUserToolsStore();
    const sessionStore = useSessionStore();
    let tool = userToolsStore.tools.find((t: any) => t.name === name);
    if (!tool) {
      try { await userToolsStore.refresh(); } catch (e) { console.warn('[useChipPreview] userTools refresh failed:', e); }
      tool = userToolsStore.tools.find((t: any) => t.name === name);
    }
    if (!tool) throw new Error(`Tool 不存在: ${name}`);
    return await piTauri.readUserTool({
      scope: tool.scope,
      workspacePath: sessionStore.activeWorkspace?.path ?? null,
      agentDir: null,
      name,
    });
  }

  if (kind === 'mcp') {
    const mcpServersStore = useMcpServersStore();
    const sessionStore = useSessionStore();
    let mcp = mcpServersStore.servers.find((s: any) => s.name === name);
    if (!mcp) {
      try { await mcpServersStore.refresh(); } catch (e) { console.warn('[useChipPreview] mcpServers refresh failed:', e); }
      mcp = mcpServersStore.servers.find((s: any) => s.name === name);
    }
    if (!mcp) throw new Error(`MCP server 不存在: ${name}`);
    return await piTauri.readMcpServer({
      scope: mcp.scope,
      workspacePath: sessionStore.activeWorkspace?.path ?? null,
      agentDir: null,
      name,
    });
  }

  throw new Error(`Unknown ref kind: ${kind}`);
}
