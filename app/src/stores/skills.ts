/**
 * v0.4.4 Skills (Pi SDK 暴露) — Pinia store
 *
 * 数据:
 *   - skills: sidecar 启动时 emit skills_snapshot 存这里 (name + description + filePath + baseDir + disableModelInvocation)
 *   - enabledByName: Record<name, true> — user 启用的 skill, 持久化到 localStorage
 *
 * 集成:
 *   - chat store send_prompt 把 enabledByName keys 传到 sidecar, 走 formatSkillsForPrompt 注入 system prompt
 *   - enable/disable 改 localStorage, 触发 sidecar restart (D165 systemPrompt 不可动态改, 走 v0.4.3 compact 端到端 pattern)
 *
 * UI:
 *   - Sidebar SkillsButton.vue: icon button + NPopover 显示 list + toggle
 */
import { defineStore } from 'pinia';
import { ref, watch } from 'vue';
import { piTauri } from '@/lib/tauri';

const STORAGE_KEY = 'pi-agent:skills:v1';

export interface SkillInfo {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  disableModelInvocation: boolean;
}

function loadEnabledFromStorage(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    return parsed as Record<string, boolean>;
  } catch {
    return {};
  }
}

function saveEnabledToStorage(data: Record<string, boolean>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (e) {
    console.warn('[skills] localStorage save failed', e);
  }
}

export const useSkillsStore = defineStore('skills', () => {
  const skills = ref<SkillInfo[]>([]);
  const enabledByName = ref<Record<string, boolean>>(loadEnabledFromStorage());
  const diagnostics = ref<Array<{ type: string; message: string; path?: string }>>([]);
  /** sidecar 是否已经 emit skills_snapshot (启动后才有 list) */
  const hasSnapshot = ref(false);

  // 持久化 enabledByName
  watch(
    enabledByName,
    (v) => saveEnabledToStorage(v),
    { deep: true },
  );

  // 订阅 sidecar emit 的 skills_snapshot (走 chat:event channel)
  //   不在 onMounted 调, 模块加载时立即注册 (跟 chat store 同 pattern)
  piTauri.on((event) => {
    if (event.type === 'skills_snapshot') {
      skills.value = event.skills;
      diagnostics.value = event.diagnostics;
      hasSnapshot.value = true;
      console.log(`[skills] snapshot received: ${event.skills.length} skills, ${event.diagnostics.length} diagnostics`);
    }
  });

  function isEnabled(name: string): boolean {
    return enabledByName.value[name] === true;
  }
  function enable(name: string) {
    enabledByName.value = { ...enabledByName.value, [name]: true };
  }
  function disable(name: string) {
    const next = { ...enabledByName.value };
    delete next[name];
    enabledByName.value = next;
  }
  function toggle(name: string) {
    if (isEnabled(name)) disable(name);
    else enable(name);
  }
  function getEnabledNames(): string[] {
    return Object.keys(enabledByName.value).filter((k) => enabledByName.value[k] === true);
  }

  return {
    skills,
    enabledByName,
    diagnostics,
    hasSnapshot,
    isEnabled,
    enable,
    disable,
    toggle,
    getEnabledNames,
  };
});
