/**
 * v0.4.6.1 Multi-agent persona (主/子 agent 库) — Pinia store
 *
 * 数据:
 *   - agents: Tauri 端 list_agents 拿 (name + description + role + body + filePath)
 *   - activeName: Tauri 端 list_agents 拿 (从 <ws>/.pi/active_agent.json 读)
 *
 * 集成 (跟 v0.4.4 skills 同 pattern, D165 systemPrompt 不可动态改):
 *   - chat store send_prompt 把 activeAgent = { name, body } 传到 sidecar
 *   - sidecar 启动时拼到 appendSystemPromptOverride 注入 system prompt
 *   - 切主 agent = 写 active_agent.json, 下次发 prompt 时 sidecar 启动自动生效
 *
 * UI:
 *   - Sidebar "AGENT 团队" group: 主 agent 标 [主] (绿点), 子 agent 标 [子] (灰点)
 *   - Composer 顶部 selector: 显示当前 active name, 点开下拉选
 *   - Settings → Agents tab (v0.4.6.1 改造 CustomInstructionsTab): 列表 + 新建/编辑/删除 + 标 [主]/[子]
 *
 * v0.4.6.1: 旧数据迁移 — 如果 <ws>/AGENTS.md 存在 + <ws>/.pi/agents/ 不存在, 第一次调
 *   refreshFromTauri 时自动 writeAgent('default', AGENTS.md 内容) + Toast 提示 "已迁移到新位置".
 */
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { piTauri } from '@/lib/tauri';
import { useSessionStore } from './session';

export interface AgentInfo {
  name: string;
  description: string;
  /** 'main' | 'sub' */
  role: string;
  body: string;
  filePath: string;
}

export const useAgentsStore = defineStore('agents', () => {
  const agents = ref<AgentInfo[]>([]);
  const activeName = ref<string | null>(null);
  /** refreshFromTauri 是否成功过 (区分 "还没拉过" vs "拉过 0 个") */
  const hasTauriList = ref(false);
  const lastError = ref<string | null>(null);

  /** 旧数据迁移: 检测到 <ws>/AGENTS.md 存在 + <ws>/.pi/agents/ 不存在, 自动迁移到 default agent */
  let migrationChecked = false;
  async function tryMigrateFromAgentsMd(workspacePath: string): Promise<void> {
    if (migrationChecked) return;
    migrationChecked = true;
    try {
      // 用 list_agents 探一下, 如果 .pi/agents/ 已经存在 (user 自己建的), 不迁移
      // 简化: 通过 list_agents 返回 0 agents 推断 .pi/agents/ 不存在
      // (没目录 + 没文件 = 0 agents)
      if (agents.value.length > 0) return;

      // 读旧 AGENTS.md
      const old = await piTauri.readCustomInstructions({
        scope: 'workspace',
        workspacePath,
        agentDir: null,
      });
      if (!old.filePath || !old.content) return;

      // 自动迁移到 default agent (role: main, 因为是旧的"项目背景规则")
      await piTauri.writeAgent({
        workspacePath,
        agentDir: null,
        name: 'default',
        content: old.content,
      });
      await piTauri.setMainAgent({
        workspacePath,
        agentDir: null,
        name: 'default',
      });
      console.log('[agents] migrated <ws>/AGENTS.md to <ws>/.pi/agents/default.md (role: main)');

      // 提示 user (v0.4.6.1 没用 toast — 后续 v0.4.6.2 polish 加 UI 提示)
      console.log('[agents] migration done. user can see new "default" agent in list.');
    } catch (e) {
      console.warn('[agents] migration from AGENTS.md skipped:', e instanceof Error ? e.message : String(e));
    }
  }

  /** 主动从 Tauri 端 list_agents 拉 (切主 agent / 新建/编辑/删除后立刻调) */
  async function refreshFromTauri(): Promise<void> {
    const sessionStore = useSessionStore();
    const ws = sessionStore.activeWorkspace;
    try {
      const res = await piTauri.listAgents({
        workspacePath: ws?.path ?? null,
        agentDir: null,
      });
      agents.value = res.agents.map((a) => ({
        name: a.name,
        description: a.description ?? '',
        role: a.role,
        body: a.body,
        filePath: a.filePath,
      }));
      activeName.value = res.activeName;
      hasTauriList.value = true;
      lastError.value = null;
      console.log(`[agents] tauri list: ${res.agents.length} agents, active=${res.activeName ?? 'none'}`);

      // 旧数据迁移 (仅第一次)
      if (ws && !migrationChecked) {
        await tryMigrateFromAgentsMd(ws.path);
        // 迁移完后重新拉一次 (新加了 default)
        if (migrationChecked) {
          const res2 = await piTauri.listAgents({
            workspacePath: ws.path,
            agentDir: null,
          });
          agents.value = res2.agents.map((a) => ({
            name: a.name,
            description: a.description ?? '',
            role: a.role,
            body: a.body,
            filePath: a.filePath,
          }));
          activeName.value = res2.activeName;
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      lastError.value = msg;
      console.error('[agents] listAgents invoke failed', msg);
    }
  }

  /** 切主 agent (写 active_agent.json + 下次发 prompt 时 sidecar 启动自动生效) */
  async function setMain(name: string): Promise<void> {
    const sessionStore = useSessionStore();
    const ws = sessionStore.activeWorkspace;
    if (!ws) {
      throw new Error('请先选一个 workspace');
    }
    await piTauri.setMainAgent({
      workspacePath: ws.path,
      agentDir: null,
      name,
    });
    activeName.value = name;
    console.log(`[agents] set main: ${name} (生效: 下次发 prompt 时 sidecar 启动自动 reload)`);
  }

  async function create(name: string, body: string, role: 'main' | 'sub' = 'sub'): Promise<void> {
    const sessionStore = useSessionStore();
    const ws = sessionStore.activeWorkspace;
    if (!ws) throw new Error('请先选一个 workspace');
    // 自动补 frontmatter (write_agent 已经做了, 但我们加 role 字段)
    const fullContent = `---\nname: ${name}\ndescription: (无描述)\nrole: ${role}\n---\n\n${body}`;
    await piTauri.writeAgent({
      workspacePath: ws.path,
      agentDir: null,
      name,
      content: fullContent,
    });
    await refreshFromTauri();
  }

  async function update(name: string, body: string, role: 'main' | 'sub'): Promise<void> {
    const sessionStore = useSessionStore();
    const ws = sessionStore.activeWorkspace;
    if (!ws) throw new Error('请先选一个 workspace');
    const fullContent = `---\nname: ${name}\ndescription: (无描述)\nrole: ${role}\n---\n\n${body}`;
    await piTauri.writeAgent({
      workspacePath: ws.path,
      agentDir: null,
      name,
      content: fullContent,
    });
    await refreshFromTauri();
  }

  async function remove(name: string): Promise<void> {
    const sessionStore = useSessionStore();
    const ws = sessionStore.activeWorkspace;
    if (!ws) throw new Error('请先选一个 workspace');
    await piTauri.deleteAgent({
      workspacePath: ws.path,
      agentDir: null,
      name,
    });
    await refreshFromTauri();
  }

  /** 给 chat store send_prompt 用: 拿当前 active agent 的 body 拼成 activeAgent 字段 */
  async function getActiveAgentConfig(): Promise<{ name: string; body: string } | null> {
    if (!activeName.value) return null;
    const sessionStore = useSessionStore();
    const ws = sessionStore.activeWorkspace;
    if (!ws) return null;
    try {
      const info = await piTauri.readAgent({
        workspacePath: ws.path,
        agentDir: null,
        name: activeName.value,
      });
      return { name: info.name, body: info.body };
    } catch {
      return null;
    }
  }

  return {
    agents,
    activeName,
    hasTauriList,
    lastError,
    refreshFromTauri,
    setMain,
    create,
    update,
    remove,
    getActiveAgentConfig,
  };
});
