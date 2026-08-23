/**
 * Extension Tools store — ADR-0022 v3.4 (2026-08-23)
 *
 * Pi 内置 7 个 tool (read/write/edit/bash/ls/find/grep) 之外, 还有"嫁接"工具
 *   (extension tools), 由 sidecar 通过 file-queue / custom register 注入:
 *   - web_navigate / web_get_text / web_screenshot (browser panel, ADR-0022)
 *   - mcp__xxx (后续 MCP 嫁接, 暂未实现 FE 展示)
 *
 * 这个 store 管 user 的 enable/disable preference:
 *   - 默认全部启用
 *   - toggle 时存 localStorage
 *   - PoC 阶段: preference 暂未传到 sidecar 真正过滤 tool, 只是 UI 体现
 *     后续 P3.1: 把 enabled list 写到 <agentDir>/settings.json 的 browserTools.enabled,
 *                sidecar loadBrowserTools 时读这个 list 过滤
 */
import { defineStore } from 'pinia';
import { ref, watch } from 'vue';

export interface ExtensionToolDef {
  name: string;
  label: string;
  description: string;
  source: 'browser' | 'mcp';
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

  return { enabled, isEnabled, setEnabled, toggle, EXTENSION_TOOLS };
});
