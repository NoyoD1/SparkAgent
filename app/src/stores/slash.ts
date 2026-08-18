/**
 * v0.4.5.2 User 自定义快捷提示词模板 (Slash commands) — Pinia store
 *
 * 跟 v0.4.6.1 agents store / v0.4.4 skills store 同 pattern.
 *
 * 数据:
 *   - commands: sidecar 启动时 emit slash_snapshot + custom 字段, 存这里
 *     (D184 v9 ❷: user 14:30 原话 "Slash tab是单独用于给用户自定义快捷提示词模板的,
 *      不是用来显示builtin的" — builtin 22 个走 Pi CLI 内部, 不显示)
 *   - Tauri 端 list_commands / read_command / write_command / delete_command
 *     主动拉/写 (跟 v0.4.4.6 skills 同 pattern), 写完/删除后立刻 refresh
 *
 * UI:
 *   - Settings → Slash tab (v0.4.5.2 恢复, D184 v9 ❷): 列表 + 新建/编辑/删除
 *   - Composer `/` popover 暂不显示 (v0.4.7b 改 @ 引用嵌入时再加)
 *
 * 存储: <workspace>/.pi/commands/<name>.md (frontmatter name/description + body)
 */
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { piTauri } from '@/lib/tauri';
import { useSessionStore } from './session';

export interface CommandInfo {
  name: string;
  description: string;
  body: string;
  filePath: string;
}

export const useSlashStore = defineStore('slash', () => {
  const commands = ref<CommandInfo[]>([]);
  /** sidecar 是否已经 emit slash_snapshot (含 custom 字段) */
  const hasSnapshot = ref(false);
  /** v0.4.5.2: Tauri 端 list_commands 拉过没 (跟 v0.4.4.6 skills 同 pattern) */
  const hasTauriList = ref(false);
  const lastError = ref<string | null>(null);

  // 订阅 sidecar emit 的 slash_snapshot (走 chat:event channel, 跟 skills_snapshot 同 pattern)
  //   v0.4.5.2: payload 加了 custom 字段 (user 自定义)
  piTauri.on((event) => {
    if (event.type === 'slash_snapshot') {
      const snap = event as any;
      // v0.4.5.2: 只存 custom, 不存 builtin (D184 v9 ❷)
      if (Array.isArray(snap.custom)) {
        commands.value = snap.custom.map((c: any) => ({
          name: c.name,
          description: c.description ?? '(无描述)',
          body: c.body ?? '',
          filePath: c.filePath ?? '',
        }));
      }
      hasSnapshot.value = true;
      console.log(`[slash] snapshot received: ${commands.value.length} custom commands (builtin 22 not shown per D184 v9 ❷)`);
    }
  });

  /** v0.4.5.2: 主动从 Tauri 端 list_commands 拉 (新建/编辑/删除后立刻调) */
  async function refreshFromTauri(): Promise<void> {
    const sessionStore = useSessionStore();
    const ws = sessionStore.activeWorkspace;
    try {
      const res = await piTauri.listCommands({
        workspacePath: ws?.path ?? null,
        agentDir: null,
      });
      commands.value = res.map((c) => ({
        name: c.name,
        description: c.description ?? '(无描述)',
        body: c.body ?? '',
        filePath: c.filePath,
      }));
      hasTauriList.value = true;
      lastError.value = null;
      console.log(`[slash] tauri list: ${res.length} commands`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      lastError.value = msg;
      console.error('[slash] listCommands invoke failed', msg);
    }
  }

  async function create(name: string, body: string, description: string = ''): Promise<void> {
    const sessionStore = useSessionStore();
    const ws = sessionStore.activeWorkspace;
    if (!ws) throw new Error('请先选一个 workspace');
    const fullContent = `---\nname: ${name}\ndescription: ${description || '(无描述)'}\n---\n\n${body}`;
    await piTauri.writeCommand({
      workspacePath: ws.path,
      agentDir: null,
      name,
      content: fullContent,
    });
    await refreshFromTauri();
  }

  async function update(name: string, body: string, description: string): Promise<void> {
    const sessionStore = useSessionStore();
    const ws = sessionStore.activeWorkspace;
    if (!ws) throw new Error('请先选一个 workspace');
    const fullContent = `---\nname: ${name}\ndescription: ${description || '(无描述)'}\n---\n\n${body}`;
    await piTauri.writeCommand({
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
    await piTauri.deleteCommand({
      workspacePath: ws.path,
      agentDir: null,
      name,
    });
    await refreshFromTauri();
  }

  return {
    commands,
    hasSnapshot,
    hasTauriList,
    lastError,
    refreshFromTauri,
    create,
    update,
    remove,
  };
});
