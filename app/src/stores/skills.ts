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
 *   - Settings → Skills tab (D187 user 原话, v0.4.4.1 改放设置面板)
 *
 * v0.4.4.6: refreshFromTauri 走 piTauri.listSkills (Rust 端 list_skills invoke) 主动拉, 写完/导入
 *   skill 后立刻刷新 UI 列表 (之前只能等 sidecar 启动时一次性 emit, user 反馈 "skill 添加后
 *   不立刻显示"). sidecar 的 skills_snapshot 仍保留 (用于 system prompt 注入, 不动).
 */
import { defineStore } from 'pinia';
import { ref, watch } from 'vue';
import { piTauri } from '@/lib/tauri';
import { useSessionStore } from './session';

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
  /** v0.4.4.6: Tauri 端 list_skills 是否已经成功拉过 (跟 sidecar 的 hasSnapshot 是两套,
   *   FE 启动时调 refreshFromTauri 立刻有数据, 不必等 sidecar 启动) */
  const hasTauriList = ref(false);

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

  // v0.4.4.6: 主动从 Tauri 端 list_skills 拉 (写完/导入 skill 后立刻调)
  //   走 Rust std::fs::read_dir 扫两个目录, 跟 sidecar 的 skills_snapshot 解耦
  //   (sidecar 那个用于 system prompt 注入, 跟 UI 列表无关)
  async function refreshFromTauri(): Promise<void> {
    const sessionStore = useSessionStore();
    const ws = sessionStore.activeWorkspace;
    try {
      const res = await piTauri.listSkills({
        workspacePath: ws?.path ?? null,
        agentDir: null,  // 让 Rust 端 fallback 算 (USERPROFILE/HOME + .pi/agent)
      });
      skills.value = res.skills.map((s) => ({
        name: s.name,
        description: s.description ?? '',
        filePath: s.filePath,
        baseDir: s.baseDir,
        disableModelInvocation: s.disableModelInvocation,
      }));
      diagnostics.value = res.diagnostics;
      hasTauriList.value = true;
      console.log(`[skills] tauri list: ${res.skills.length} skills, ${res.diagnostics.length} diagnostics`);
    } catch (e) {
      console.error('[skills] listSkills invoke failed', e);
    }
  }

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
    hasTauriList,
    isEnabled,
    enable,
    disable,
    toggle,
    getEnabledNames,
    refreshFromTauri,
  };
});
