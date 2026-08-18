/**
 * v0.4.5 Slash commands (Pi SDK 暴露) — Pinia store
 *
 * 数据:
 *   - commands: sidecar 启动时 emit slash_snapshot 存这里 (name + description + argumentHint + source)
 *   - source: 'builtin' (Pi SDK BUILTIN_SLASH_COMMANDS 21 个, 走 Pi CLI 内部, 不支持 RPC 触发)
 *           'custom' (v0.4.5c: .pi/commands/<name>.md, 可以 RPC 触发)
 *           'extension' / 'prompt' / 'skill' (Pi SDK extension 系统注册的)
 *
 * UI:
 *   - Settings → Agent 能力 → Slash tab (跟 Skills tab 同 pattern)
 *   - Composer / prefix autocomplete (v0.4.5d)
 *
 * v0.4.5 范围: sidecar emit builtin commands (BUILTIN_SLASH_COMMANDS 21 个),
 *   v0.4.5c/d 加 custom command + RpcCommand 'slash' 触发.
 */
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { piTauri } from '@/lib/tauri';

export interface SlashCommandInfo {
  name: string;
  description: string;
  argumentHint: string | null;
  source: 'builtin' | 'custom' | 'extension' | 'prompt' | 'skill';
}

export const useSlashStore = defineStore('slash', () => {
  const commands = ref<SlashCommandInfo[]>([]);
  /** sidecar 是否已经 emit slash_snapshot */
  const hasSnapshot = ref(false);

  // 订阅 sidecar emit 的 slash_snapshot (走 chat:event channel, 跟 skills_snapshot 同 pattern)
  piTauri.on((event) => {
    if (event.type === 'slash_snapshot') {
      commands.value = event.commands;
      hasSnapshot.value = true;
      console.log(`[slash] snapshot received: ${event.commands.length} commands`);
    }
  });

  function getByName(name: string): SlashCommandInfo | undefined {
    return commands.value.find((c) => c.name === name);
  }

  return {
    commands,
    hasSnapshot,
    getByName,
  };
});
