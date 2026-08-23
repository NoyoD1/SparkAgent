/**
 * Extension Tools store — ADR-0022 v3.4 + ADR-0023 P3-D
 *
 * Pi 内置 7 个 tool (read/write/edit/bash/ls/find/grep) 之外, 还有"嫁接"工具
 *   (extension tools), 由 sidecar 通过 file-queue / custom register 注入:
 *   - web_navigate / web_get_text / web_screenshot (browser panel, ADR-0022) — 静态
 *   - mcp__xxx (MCP 嫁接, ADR-0023 P3) — 静态 (配置决定)
 *   - external (external tools, ADR-0023 P3-B) — 动态 (从 <workspace>/.pi/tools/external 扫)
 *
 * 这个 store 管 user 的 enable/disable preference:
 *   - 默认全部启用
 *   - toggle 时存 localStorage
 *   - PoC 阶段: preference 暂未传到 sidecar 真正过滤 tool, 只是 UI 体现
 *     后续 P3.1: 把 enabled list 写到 <agentDir>/settings.json 的 browserTools.enabled,
 *                sidecar loadBrowserTools 时读这个 list 过滤
 */
import { defineStore } from 'pinia';
import { ref, computed, watch } from 'vue';
import { piTauri } from '@/lib/tauri';

export interface ExtensionToolDef {
  name: string;
  label: string;
  description: string;
  source: 'browser' | 'mcp' | 'external';
}

export const EXTENSION_TOOLS: readonly ExtensionToolDef[] = [
  {
    name: 'web_navigate',
    label: 'Web Navigate',
    description: '让 agent 用内置 WebView2 浏览器打开指定 URL, 返回页面 text',
    source: 'browser',
  },
  {
    name: 'web_get_text',
    label: 'Web Get Text',
    description: '读取内置 WebView2 浏览器当前页面的 text (不重新导航)',
    source: 'browser',
  },
  {
    name: 'web_screenshot',
    label: 'Web Screenshot',
    description: '截内置 WebView2 浏览器当前页面, 给 vision model 看图分析',
    source: 'browser',
  },
];

const STORAGE_KEY = 'pi-agent:extension-tools:v1';

function loadEnabled(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  // 默认全启用
  const out: Record<string, boolean> = {};
  for (const t of EXTENSION_TOOLS) out[t.name] = true;
  return out;
}

export const useExtensionToolsStore = defineStore('extensionTools', () => {
  const enabled = ref<Record<string, boolean>>(loadEnabled());

  // ADR-0023 P3-D: external tools 动态加载 (从 Tauri list_external_tools 拉)
  //   - 每次 refresh() 重新扫 (跟 list_user_tools / list_mcp_servers 同 pattern)
  //   - workspace 切换时也要 refresh (旧 tool 列表跟新 workspace 不匹配)
  const externalTools = ref<Array<{
    name: string;
    description: string;
    runtime: string;
    entry: string;
    entryPath: string;
    manifest: string;
    manifestPath: string;
    scope: 'workspace' | 'global';
    isValid: boolean;
    error: string | null;
  }>>([]);
  const externalLoading = ref(false);
  const externalError = ref<string | null>(null);

  // 持久化
  watch(
    enabled,
    (v) => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(v));
      } catch {}
    },
    { deep: true },
  );

  function isEnabled(name: string): boolean {
    return enabled.value[name] !== false; // 默认 true
  }
  function setEnabled(name: string, val: boolean) {
    enabled.value = { ...enabled.value, [name]: val };
  }
  function toggle(name: string) {
    setEnabled(name, !isEnabled(name));
  }

  /** ADR-0023 P3-D: 重新扫 external tool 文件夹, 给 Tools tab 用 */
  async function refreshExternal(workspacePath: string | null, agentDir: string | null) {
    externalLoading.value = true;
    externalError.value = null;
    try {
      externalTools.value = await piTauri.listExternalTools(workspacePath, agentDir);
    } catch (e) {
      externalError.value = e instanceof Error ? e.message : String(e);
      externalTools.value = [];
    } finally {
      externalLoading.value = false;
    }
  }

  // 派生: 静态 + 动态合并
  const allExtensionTools = computed<ExtensionToolDef[]>(() => {
    const staticOnes = [...EXTENSION_TOOLS];
    const dynamicOnes: ExtensionToolDef[] = externalTools.value.map((t) => ({
      name: t.name,
      label: t.name,
      description: t.description || t.error || '(无描述)',
      source: 'external',
    }));
    return [...staticOnes, ...dynamicOnes];
  });

  return {
    enabled, isEnabled, setEnabled, toggle,
    EXTENSION_TOOLS,
    externalTools, externalLoading, externalError,
    refreshExternal, allExtensionTools,
  };
});
