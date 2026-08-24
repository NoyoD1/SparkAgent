<script setup lang="ts">
/**
 * 2026-08-20 P1-5: Settings → Tools tab
 *
 * 列出 builtin 7 个 tool (read/write/edit/bash/ls/find/grep) + user-defined tool.
 * 派生流程: 点 builtin 工具的 "派生" 按钮 → 弹 dialog 填 name / description / JSON body
 *   (预填默认 body) → 保存到 <workspace>/.pi/tools/<name>.json.
 * sidecar 启动时自动加载 user tool + merge 到 LLM 可见的 tools list (Batch 2 实现的).
 *
 * 跟其他 Settings tab 的差异:
 *   - body 是 JSON (跟 Skills/Commands 的 markdown frontmatter 不同), 用 textarea 直接编辑
 *   - name 不能跟 builtin 7 个重 (FE 预校验 + Rust 端兜底)
 *   - 简化版: 暂不支持 edit (只能 delete + 重新派生), 后续 P1.5.1 加
 *
 * 存储: <workspacePath>/.pi/tools/<name>.json + <agentDir>/tools/<name>.json
 *   两层 scope, workspace 优先 (跟 Skills/Commands/CustomInstructions 同 pattern).
 */
import { ref, onMounted, watch } from 'vue';
import { storeToRefs } from 'pinia';
import {
  Wrench, Plus, X, Save, Trash2, AlertCircle, Check, Info,
  FileCode, Edit3, BookOpen, Search, FileText, FileSearch, Terminal, Globe, Power, Package, RefreshCw,
} from 'lucide-vue-next';
import {
  useUserToolsStore,
  BUILTIN_TOOL_NAMES,
  BUILTIN_TOOL_LABEL,
  type BuiltinToolName,
} from '@/stores/userTools';
import { useSessionStore } from '@/stores/session';
import { useExtensionToolsStore } from '@/stores/extensionTools';
import { piTauri } from '@/lib/tauri';
import { pickFile, pickSavePath } from '@/lib/dialog';

const userToolsStore = useUserToolsStore();
const extensionToolsStore = useExtensionToolsStore();
const { tools, loading, error } = storeToRefs(userToolsStore);
const { externalLoading, externalError, allExtensionTools } = storeToRefs(extensionToolsStore);
const sessionStore = useSessionStore();

// builtin 工具 → lucide icon 映射 (UI 显示)
const BUILTIN_TOOL_ICON: Record<BuiltinToolName, any> = {
  read: FileText,
  write: Edit3,
  edit: BookOpen,
  bash: Terminal,
  ls: FileSearch,
  find: Search,
  grep: FileCode,
};

// ====== 派生 dialog state ======
const isDeriving = ref(false);
const derivingFromBuiltin = ref<BuiltinToolName | null>(null);
const formName = ref('');
const formDescription = ref('');
const formBody = ref('');
const isSaving = ref(false);
const toast = ref<{ type: 'ok' | 'fail' | 'warn'; message: string } | null>(null);

function startDerive(basedOn: BuiltinToolName) {
  isDeriving.value = true;
  derivingFromBuiltin.value = basedOn;
  // 预填默认 name (用户改成 my_<name>_<purpose> 这种)
  formName.value = `my_${basedOn}_`;
  formDescription.value = BUILTIN_TOOL_LABEL[basedOn];
  formBody.value = userToolsStore.buildDefaultBody(basedOn, formName.value, formDescription.value);
}

function cancelDerive() {
  isDeriving.value = false;
  derivingFromBuiltin.value = null;
  formName.value = '';
  formDescription.value = '';
  formBody.value = '';
}

async function saveDerive() {
  if (isSaving.value) return;
  isSaving.value = true;
  toast.value = null;
  try {
    // 校验 body 里 name 跟 formName 一致 (跟 Rust 端 write_user_tool 校验一致)
    const parsed = JSON.parse(formBody.value);
    parsed.name = formName.value;  // 同步 formName 到 body
    parsed.description = formDescription.value;  // 同步 description
    parsed.basedOn = derivingFromBuiltin.value;  // 同步 basedOn
    const finalBody = JSON.stringify(parsed, null, 2);

    await userToolsStore.write('workspace', formName.value, finalBody);
    toast.value = { type: 'ok', message: `已创建 ${formName.value}` };
    cancelDerive();
    await userToolsStore.refresh();
  } catch (e) {
    toast.value = { type: 'fail', message: e instanceof Error ? e.message : String(e) };
  } finally {
    isSaving.value = false;
  }
}

async function removeTool(scope: 'workspace' | 'global', name: string) {
  if (!confirm(`确认删除 user tool "${name}" (scope=${scope})?`)) return;
  try {
    await userToolsStore.remove(scope, name);
    toast.value = { type: 'ok', message: `已删除 ${name}` };
    await userToolsStore.refresh();
  } catch (e) {
    toast.value = { type: 'fail', message: e instanceof Error ? e.message : String(e) };
  }
}

// user tool 按 basedOn 分组,显示更清晰
// (暂时按字母顺序平铺, P1.5.1 加按 basedOn 分组)

onMounted(() => {
  userToolsStore.refresh();
  // ADR-0023 P3-D: 加载 external tools (Tavily 等, 从 workspace / agentDir 扫描)
  refreshExtension();
});

// workspace 切换时重新扫 (旧 tool 列表跟新 workspace 不匹配)
watch(
  () => sessionStore.activeWorkspace?.path ?? null,
  () => {
    refreshExtension();
  },
);

function refreshExtension() {
  void extensionToolsStore.refreshExternal(
    sessionStore.activeWorkspace?.path ?? null,
    null,  // agentDir 暂不传, 跟 user tool / MCP server 一致只扫 workspace
  );
}

// ====== ADR-0023 P3-D Phase 2: 工具导入导出 ======
//  - user tool: 单 JSON in/out
//  - external tool: ZIP in/out
//  - FE 用 @tauri-apps/plugin-dialog 选文件路径, Rust 负责实际读写
//  - 完成后弹 toast + 触发 P3-A 静默重启
async function importUserToolDialog() {
  const file = await pickFile({
    title: '选择 user tool JSON 文件',
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (!file || typeof file !== 'string') return;
  // 默认写到 workspace scope (跟 user tools 列表行为一致)
  const targetScope: 'workspace' | 'global' = sessionStore.activeWorkspace?.path
    ? 'workspace' : 'global';
  try {
    const written = await piTauri.importUserTool(
      targetScope,
      file,
      sessionStore.activeWorkspace?.path ?? null,
      null,  // agentDir 暂不传
    );
    toast.value = { type: 'ok', message: `已导入: ${written}` };
    await userToolsStore.refresh();
    void piTauri.restartAllSidecars('user_tool_changed');
  } catch (e) {
    toast.value = { type: 'fail', message: `导入失败: ${e instanceof Error ? e.message : String(e)}` };
  }
}

async function importExternalToolDialog() {
  const file = await pickFile({
    title: '选择 external tool ZIP 文件',
    filters: [{ name: 'ZIP', extensions: ['zip'] }],
  });
  if (!file || typeof file !== 'string') return;
  const targetScope: 'workspace' | 'global' = sessionStore.activeWorkspace?.path
    ? 'workspace' : 'global';
  try {
    const written = await piTauri.importExternalTool(
      targetScope,
      file,
      sessionStore.activeWorkspace?.path ?? null,
      null,
    );
    toast.value = { type: 'ok', message: `已导入: ${written}` };
    refreshExtension();
    void piTauri.restartAllSidecars('external_tool_changed');
  } catch (e) {
    toast.value = { type: 'fail', message: `导入失败: ${e instanceof Error ? e.message : String(e)}` };
  }
}

async function exportUserToolDialog(name: string) {
  const target = await pickSavePath({
    title: `导出 user tool "${name}"`,
    defaultPath: `${name}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (!target) return;
  try {
    const written = await piTauri.exportUserTool(
      'workspace',  // 暂只支持 workspace scope (跟 store 一致)
      name,
      target,
      sessionStore.activeWorkspace?.path ?? null,
      null,
    );
    toast.value = { type: 'ok', message: `已导出到: ${written}` };
  } catch (e) {
    toast.value = { type: 'fail', message: `导出失败: ${e instanceof Error ? e.message : String(e)}` };
  }
}

async function exportExternalToolDialog(name: string) {
  const target = await pickSavePath({
    title: `导出 external tool "${name}"`,
    defaultPath: `${name}.zip`,
    filters: [{ name: 'ZIP', extensions: ['zip'] }],
  });
  if (!target) return;
  try {
    const written = await piTauri.exportExternalTool(
      'workspace',
      name,
      target,
      sessionStore.activeWorkspace?.path ?? null,
      null,
    );
    toast.value = { type: 'ok', message: `已导出到: ${written}` };
  } catch (e) {
    toast.value = { type: 'fail', message: `导出失败: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// v3.19: 删 external tool (跟 import/export 配套)
async function deleteExternalToolDialog(name: string) {
  if (!confirm(`确认删除 external tool '${name}'?\n\n会从 <workspace>/.pi/tools/external/${name}/ 整个删掉 (含 manifest.json + entry 文件).\n删除后 sidecar 自动重启, LLM 立刻看不到这个 tool. 不可恢复, 建议先 export 备份.`)) {
    return;
  }
  try {
    const removed = await piTauri.deleteExternalTool(
      'workspace',
      name,
      sessionStore.activeWorkspace?.path ?? null,
      null,
    );
    if (removed) {
      toast.value = { type: 'ok', message: `已删除 '${name}'` };
    } else {
      toast.value = { type: 'warn', message: `'${name}' 不存在 (已删过?)` };
    }
    refreshExtension();
    void piTauri.restartAllSidecars('external_tool_changed');
  } catch (e) {
    toast.value = { type: 'fail', message: `删除失败: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// ====== 2026-08-24 P3-G: external tool Edit ======
//   之前 ToolsTab 只能派生 builtin / 导入 ZIP / 删除, 没法直接改已装的 tool.
//   Edit dialog 改 manifest.json (description / parameters / env 引用 / runtime 等),
//   改完调 write_external_tool_manifest + silent restart.
//   试跑 (Run) 走 slash command '/tools:name' → modal 真调, UI 这里不再单独做
//   (避免 invoke_external_tool 要全 config 的复杂度, Pi SDK 走 modal 路径更顺).

// Edit state
const editingExtName = ref<string | null>(null);
const editingExtJson = ref('');
const editingExtOriginal = ref<string | null>(null);  // 用于拿 manifestPath + scope (写回用)
const isSavingExt = ref(false);

async function startEditExternal(t: { name: string }) {
  // ExtensionToolDef 没 manifest 字段, 走 listExternalTools 拿完整 (含 manifest raw + manifestPath + scope)
  const list = await piTauri.listExternalTools(
    sessionStore.activeWorkspace?.path ?? null,
    null,
  );
  const full = list.find((x) => x.name === t.name);
  if (!full) {
    toast.value = { type: 'fail', message: `找不到 tool '${t.name}'` };
    return;
  }
  editingExtName.value = t.name;
  editingExtOriginal.value = full.manifest;
  try {
    const obj = JSON.parse(full.manifest);
    editingExtJson.value = JSON.stringify(obj, null, 2);
  } catch {
    editingExtJson.value = full.manifest;
  }
}
function cancelEditExternal() {
  editingExtName.value = null;
  editingExtJson.value = '';
  editingExtOriginal.value = null;
}
async function saveEditExternal() {
  const name = editingExtName.value;
  if (!name) return;
  isSavingExt.value = true;
  toast.value = null;
  try {
    // 解析验证
    JSON.parse(editingExtJson.value);
    await piTauri.writeExternalToolManifest({
      scope: 'workspace',
      name,
      manifest: editingExtJson.value,
      workspacePath: sessionStore.activeWorkspace?.path ?? null,
      agentDir: null,
    });
    toast.value = { type: 'ok', message: `已保存 ${name}, 静默重启中…` };
    cancelEditExternal();
    refreshExtension();
    void piTauri.restartAllSidecars('external_tool_manifest_changed');
  } catch (e) {
    toast.value = { type: 'fail', message: `保存失败: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    isSavingExt.value = false;
  }
}
</script>

<template>
  <div class="pad-toolstab">
    <div class="pad-toolstab__header">
      <h2 class="pad-toolstab__title">Tools — User 工具模板</h2>
      <p class="pad-toolstab__subtitle">
        从 <strong>builtin tool</strong> 派生 user 工具, 预设 args 避免每次重写.
        存 <code>&lt;workspace&gt;/.pi/tools/*.json</code> + <code>&lt;agentDir&gt;/tools/*.json</code>
        (workspace 优先). sidecar 启动时自动加载, LLM 调 user tool 时自动 merge preset args.
      </p>
    </div>

    <div v-if="toast" class="pad-toolstab__toast" :class="`is-${toast.type}`">
      <Check v-if="toast.type === 'ok'" :size="14" :stroke-width="1.75" />
      <AlertCircle v-else :size="14" :stroke-width="1.75" />
      <span>{{ toast.message }}</span>
      <button class="pad-toolstab__toast-close" @click="toast = null">×</button>
    </div>

    <div v-if="error" class="pad-toolstab__toast is-fail">
      <AlertCircle :size="14" :stroke-width="1.75" />
      <span>{{ error }}</span>
    </div>

    <!-- Builtin tools (7 个, 每个有"派生"按钮) -->
    <div class="pad-toolstab__section">
      <h3 class="pad-toolstab__section-title">
        <Wrench :size="14" :stroke-width="1.75" />
        <span>Builtin Tools (Pi SDK 内置, 不可修改)</span>
      </h3>
      <div class="pad-toolstab__builtin-grid">
        <div
          v-for="name in BUILTIN_TOOL_NAMES"
          :key="name"
          class="pad-toolstab__builtin-card"
        >
          <component :is="BUILTIN_TOOL_ICON[name]" :size="18" :stroke-width="1.5" class="pad-toolstab__builtin-icon" />
          <div class="pad-toolstab__builtin-body">
            <div class="pad-toolstab__builtin-name">{{ name }}</div>
            <div class="pad-toolstab__builtin-label">{{ BUILTIN_TOOL_LABEL[name] }}</div>
          </div>
          <button
            class="pad-toolstab__btn pad-toolstab__btn--primary"
            :disabled="isDeriving"
            @click="startDerive(name)"
            title="派生一个 user tool (预设 args 模板)"
          >
            <Plus :size="12" :stroke-width="1.75" />
            <span>派生</span>
          </button>
        </div>
      </div>
    </div>

    <!-- 派生 dialog -->
    <div v-if="isDeriving" class="pad-toolstab__dialog">
      <div class="pad-toolstab__dialog-head">
        <Plus :size="14" :stroke-width="1.75" />
        <span>派生自 <code>{{ derivingFromBuiltin }}</code></span>
        <button class="pad-toolstab__toast-close" @click="cancelDerive">
          <X :size="14" :stroke-width="1.75" />
        </button>
      </div>
      <div class="pad-toolstab__form">
        <div class="pad-toolstab__form-row">
          <label class="pad-toolstab__label">name <span class="pad-toolstab__hint-inline">(1-64 char, [A-Za-z0-9._-], 不能跟 builtin 重)</span></label>
          <input
            v-model="formName"
            class="pad-toolstab__input"
            placeholder="例如 my_grep_todo"
            spellcheck="false"
          />
        </div>
        <div class="pad-toolstab__form-row">
          <label class="pad-toolstab__label">description <span class="pad-toolstab__hint-inline">(给 LLM 看的, 告诉 LLM 啥时候该用这个 tool)</span></label>
          <input
            v-model="formDescription"
            class="pad-toolstab__input"
            placeholder="例如 在 src 下所有 .ts 文件里找 TODO 注释, 排除测试文件"
            spellcheck="false"
          />
        </div>
        <div class="pad-toolstab__form-row pad-toolstab__form-row--body">
          <label class="pad-toolstab__label">body (JSON)
            <span class="pad-toolstab__hint-inline">
              preset args 填在 "args" 字段. LLM 调时还能 override.
              <a
                href="https://github.com/earendil-works/pi-coding-agent/blob/main/src/core/tools/"
                target="_blank"
                rel="noopener"
                class="pad-toolstab__link"
              >参考 builtin schema</a>
            </span>
          </label>
          <textarea
            v-model="formBody"
            class="pad-toolstab__textarea"
            rows="14"
            spellcheck="false"
          />
        </div>
        <div class="pad-toolstab__form-actions">
          <button
            class="pad-toolstab__btn"
            @click="cancelDerive"
            :disabled="isSaving"
          >
            <X :size="14" :stroke-width="1.75" />
            <span>取消</span>
          </button>
          <button
            class="pad-toolstab__btn pad-toolstab__btn--primary"
            :disabled="isSaving"
            @click="saveDerive"
          >
            <Save :size="14" :stroke-width="1.75" />
            <span>{{ isSaving ? '保存中…' : '保存到 workspace' }}</span>
          </button>
        </div>
      </div>
    </div>

    <!-- User tools list -->
    <div class="pad-toolstab__section">
      <h3 class="pad-toolstab__section-title">
        <Wrench :size="14" :stroke-width="1.75" />
        <span>User Tools ({{ tools.length }})</span>
        <button
          class="pad-toolstab__btn pad-toolstab__btn--ghost"
          title="从 JSON 文件导入 user tool"
          @click="importUserToolDialog"
        >
          <Plus :size="12" :stroke-width="2" />
          <span>导入</span>
        </button>
        <button
          v-if="!loading && tools.length > 0"
          class="pad-toolstab__btn"
          @click="userToolsStore.refresh()"
          title="刷新列表"
        >
          <span>刷新</span>
        </button>
      </h3>

    <!-- ADR-0022 v3.4 + ADR-0023 P3-D: Extension Tools (静态 browser + 动态 external)
         v3-D: external tools 从 <workspace>/.pi/tools/external/ 动态扫
         PoC: 只展示 + toggle, 实际过滤后续 P3.1 (写到 settings.json 传 sidecar) -->
    <div class="pad-toolstab__section">
      <h3 class="pad-toolstab__section-title">
        <Globe :size="14" :stroke-width="1.75" />
        <span>Extension Tools ({{ allExtensionTools.length }})</span>
        <span class="pad-toolstab__hint-inline">嫁接 (browser + external tool), 可启停</span>
        <button
          class="pad-toolstab__btn pad-toolstab__btn--ghost"
          title="从 ZIP 文件导入 external tool"
          @click="importExternalToolDialog"
        >
          <Plus :size="12" :stroke-width="2" />
          <span>导入</span>
        </button>
        <button
          class="pad-toolstab__btn pad-toolstab__btn--ghost"
          type="button"
          :disabled="externalLoading"
          :title="externalLoading ? '加载中…' : '重新扫 external tool 文件夹'"
          @click="refreshExtension"
        >
          <RefreshCw v-if="externalLoading" :size="12" :stroke-width="1.75" class="pad-toolstab__spin" />
          <RefreshCw v-else :size="12" :stroke-width="1.75" />
          <span>刷新</span>
        </button>
      </h3>
      <div v-if="externalError" class="pad-toolstab__toast is-fail">
        <AlertCircle :size="13" :stroke-width="1.75" />
        <span>扫 external tool 失败: {{ externalError }}</span>
      </div>
      <div v-if="!externalLoading && allExtensionTools.length === 0" class="pad-toolstab__empty">
        <Package :size="20" :stroke-width="1.5" />
        <div class="pad-toolstab__empty-title">还没有 external tool</div>
        <div class="pad-toolstab__empty-desc">
          复制 <code>sidecar/tools/tavily_search/</code> 整个文件夹到
          <code>&lt;workspace&gt;/.pi/tools/external/</code>, 触发静默重启就能看到.
        </div>
      </div>
      <div v-else class="pad-toolstab__ext-grid">
        <div
          v-for="t in allExtensionTools"
          :key="t.name"
          class="pad-toolstab__ext-card"
          :class="{
            'is-disabled': !extensionToolsStore.isEnabled(t.name),
            'is-external': t.source === 'external',
          }"
        >
          <Globe v-if="t.source === 'browser'" :size="18" :stroke-width="1.5" class="pad-toolstab__builtin-icon" />
          <Package v-else :size="18" :stroke-width="1.5" class="pad-toolstab__builtin-icon" />
          <div class="pad-toolstab__builtin-body">
            <div class="pad-toolstab__builtin-name">
              <code>{{ t.name }}</code>
              <span :class="['pad-toolstab__scope-tag', `is-${t.source}`]">{{ t.source }}</span>
            </div>
            <div class="pad-toolstab__builtin-label">{{ t.label }} — {{ t.description }}</div>
          </div>
          <!-- v3-D Phase 2: external tool 卡片有 export 按钮 (ZIP 导出) -->
          <button
            v-if="t.source === 'external'"
            class="pad-toolstab__btn pad-toolstab__btn--ghost pad-toolstab__btn--sm"
            :title="`编辑 ${t.name} 的 manifest.json (env 引用 / parameters / description 等)`"
            @click="startEditExternal(t)"
          >
            <Edit3 :size="12" :stroke-width="1.75" />
          </button>
          <button
            v-if="t.source === 'external'"
            class="pad-toolstab__btn pad-toolstab__btn--ghost pad-toolstab__btn--sm"
            :title="`导出 ${t.name} 到 ZIP`"
            @click="exportExternalToolDialog(t.name)"
          >
            <Save :size="12" :stroke-width="1.75" />
          </button>
          <!-- v3.19: external tool 删除按钮 -->
          <button
            v-if="t.source === 'external'"
            class="pad-toolstab__btn pad-toolstab__btn--danger pad-toolstab__btn--sm"
            :title="`删除 ${t.name}`"
            @click="deleteExternalToolDialog(t.name)"
          >
            <Trash2 :size="12" :stroke-width="1.75" />
          </button>
          <button
            class="pad-toolstab__toggle"
            :class="{ 'is-on': extensionToolsStore.isEnabled(t.name) }"
            :title="extensionToolsStore.isEnabled(t.name) ? '点击停用' : '点击启用'"
            @click="extensionToolsStore.toggle(t.name)"
          >
            <Power :size="12" :stroke-width="2" />
            <span>{{ extensionToolsStore.isEnabled(t.name) ? '已启用' : '已停用' }}</span>
          </button>
        </div>
      </div>
    </div>
      <div v-if="loading" class="pad-toolstab__empty">
        <Wrench :size="20" :stroke-width="1.5" />
        <div>⏳ 加载中…</div>
      </div>
      <div v-else-if="tools.length === 0" class="pad-toolstab__empty">
        <Wrench :size="20" :stroke-width="1.5" />
        <div class="pad-toolstab__empty-title">暂无 user tool</div>
        <div class="pad-toolstab__empty-desc">点上面 builtin 工具的 "派生" 按钮创建你的第一个 user tool.</div>
      </div>
      <ul v-else class="pad-toolstab__list">
        <li v-for="t in tools" :key="`${t.scope}/${t.name}`" class="pad-toolstab__item">
          <div class="pad-toolstab__item-body">
            <div class="pad-toolstab__item-name">
              <code>{{ t.name }}</code>
              <span class="pad-toolstab__scope-tag" :class="`is-${t.scope}`">{{ t.scope }}</span>
              <span class="pad-toolstab__basedon-tag">基于 {{ t.basedOn }}</span>
            </div>
            <div class="pad-toolstab__item-desc">{{ t.description }}</div>
          </div>
          <div class="pad-toolstab__item-actions">
            <button
              class="pad-toolstab__btn"
              :title="`导出 ${t.name} 到 JSON`"
              @click="exportUserToolDialog(t.name)"
            >
              <Save :size="13" :stroke-width="1.75" />
            </button>
            <button
              class="pad-toolstab__btn pad-toolstab__btn--danger"
              title="删除"
              @click="removeTool(t.scope, t.name)"
            >
              <Trash2 :size="13" :stroke-width="1.75" />
            </button>
          </div>
        </li>
      </ul>
    </div>

    <div class="pad-toolstab__hint">
      <Info :size="12" :stroke-width="1.75" />
      <span>
        user tool 是 builtin tool 的"args 预设包装" — LLM 调你的 user tool 时,
        sidecar 自动把 preset args 跟 LLM 调的 args 合并, 调 builtin tool 的 execute.
        适合"经常跑同一个 command 但不想每次重写 args"的场景.
      </span>
    </div>

    <!-- 2026-08-24 P3-G: Edit external tool manifest.json dialog -->
    <!--   v3.24 fix: Teleport to body 避免父级 stacking context (transform / position) 干扰
         z-index, 否则 modal 背景遮罩盖不住兄弟 stacking context 里的内容 -->
    <Teleport to="body">
      <div v-if="editingExtName" class="pad-toolstab__modal-backdrop" @click.self="cancelEditExternal">
        <div class="pad-toolstab__modal">
          <h3 class="pad-toolstab__modal-title">
            <Edit3 :size="14" :stroke-width="1.75" />
            <span>编辑 manifest.json: <code>{{ editingExtName }}</code></span>
          </h3>
          <p class="pad-toolstab__modal-desc">
            改 description / parameters / env (v3.37 改: 明文 secret, 不再用 <code>keychain:</code> 引用) / runtime / entry 等.
            保存后触发静默重启, 下次对话生效. entry 文件 (Python 脚本) 不会动, 那个用编辑器改.
          </p>
          <textarea
            v-model="editingExtJson"
            class="pad-toolstab__modal-textarea"
            spellcheck="false"
            :rows="20"
          />
          <div class="pad-toolstab__modal-actions">
            <button class="pad-toolstab__btn pad-toolstab__btn--ghost" @click="cancelEditExternal">取消</button>
            <button
              class="pad-toolstab__btn pad-toolstab__btn--primary"
              :disabled="isSavingExt"
              @click="saveEditExternal"
            >
              <Save :size="12" :stroke-width="1.75" />
              <span>{{ isSavingExt ? '保存中…' : '保存并重启 sidecar' }}</span>
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
/* 跟 SlashTab 视觉一致, 用 pad-toolstab__ 前缀 */
.pad-toolstab {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.pad-toolstab__header {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.pad-toolstab__title {
  margin: 0;
  font-size: var(--pad-fs-20, 20px);
  font-weight: var(--pad-fw-semibold, 600);
  color: var(--pad-fg-primary);
}
.pad-toolstab__subtitle {
  margin: 0;
  font-size: var(--pad-fs-13, 13px);
  color: var(--pad-fg-secondary);
  line-height: 1.5;
}
.pad-toolstab__subtitle code {
  background: var(--pad-bg-active);
  padding: 1px 6px;
  border-radius: var(--pad-radius-sm);
  font-family: var(--pad-font-mono);
  font-size: var(--pad-fs-12);
}
.pad-toolstab__toast {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: var(--pad-radius-md);
  font-size: var(--pad-fs-13);
}
.pad-toolstab__toast.is-ok {
  background: color-mix(in srgb, var(--pad-success, #16a34a) 12%, transparent);
  color: var(--pad-success, #16a34a);
}
.pad-toolstab__toast.is-fail {
  background: color-mix(in srgb, var(--pad-danger, #dc2626) 12%, transparent);
  color: var(--pad-danger, #dc2626);
}
.pad-toolstab__toast-close {
  margin-left: auto;
  background: transparent;
  border: none;
  color: inherit;
  cursor: pointer;
  font-size: var(--pad-fs-16);
  line-height: 1;
  opacity: 0.7;
  padding: 0 4px;
}
.pad-toolstab__toast-close:hover { opacity: 1; }

.pad-toolstab__section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.pad-toolstab__section-title {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: var(--pad-fs-14, 14px);
  font-weight: var(--pad-fw-semibold, 600);
  color: var(--pad-fg-primary);
}

.pad-toolstab__builtin-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 8px;
}

/* ===== ADR-0022 v3.4: Extension Tools (嫁接 web_* / mcp__*) ===== */
.pad-toolstab__ext-grid {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.pad-toolstab__ext-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  background: var(--pad-bg-input);
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-md);
  transition: opacity var(--pad-dur-fast) ease;
}
.pad-toolstab__ext-card.is-disabled {
  opacity: 0.5;
}
.pad-toolstab__scope-tag.is-browser {
  background: color-mix(in srgb, var(--pad-accent) 14%, transparent);
  color: var(--pad-accent);
}
.pad-toolstab__scope-tag.is-external {
  background: color-mix(in srgb, #10b981 14%, transparent);
  color: #059669;
}
.pad-toolstab__scope-tag.is-mcp {
  background: color-mix(in srgb, #8b5cf6 14%, transparent);
  color: #7c3aed;
}
.pad-toolstab__spin {
  animation: pad-toolstab-spin 1s linear infinite;
}
@keyframes pad-toolstab-spin {
  to { transform: rotate(360deg); }
}
.pad-toolstab__toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 10px;
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-pill);
  background: transparent;
  font-family: inherit;
  font-size: var(--pad-fs-11, 11px);
  color: var(--pad-fg-tertiary);
  cursor: pointer;
  transition: all var(--pad-dur-fast) ease;
  flex-shrink: 0;
}
.pad-toolstab__toggle.is-on {
  background: color-mix(in srgb, var(--pad-success, #16a34a) 14%, transparent);
  border-color: var(--pad-success, #16a34a);
  color: var(--pad-success, #16a34a);
}
.pad-toolstab__toggle:hover {
  background: var(--pad-bg-hover);
}
.pad-toolstab__toggle.is-on:hover {
  background: color-mix(in srgb, var(--pad-success, #16a34a) 22%, transparent);
}
.pad-toolstab__builtin-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  background: var(--pad-bg-input);
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-md);
}
.pad-toolstab__builtin-icon {
  color: var(--pad-fg-secondary);
  flex-shrink: 0;
}
.pad-toolstab__builtin-body {
  flex: 1;
  min-width: 0;
}
.pad-toolstab__builtin-name {
  font-family: var(--pad-font-mono);
  font-size: var(--pad-fs-13);
  font-weight: var(--pad-fw-medium);
  color: var(--pad-fg-primary);
}
.pad-toolstab__builtin-label {
  font-size: var(--pad-fs-11, 11px);
  color: var(--pad-fg-tertiary);
}

.pad-toolstab__dialog {
  background: var(--pad-bg-input);
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-md);
  overflow: hidden;
}
.pad-toolstab__dialog-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--pad-divider);
  background: var(--pad-bg-active);
  font-size: var(--pad-fs-13);
  font-weight: var(--pad-fw-medium);
  color: var(--pad-fg-primary);
}
.pad-toolstab__dialog-head code {
  font-family: var(--pad-font-mono);
  background: var(--pad-muted);
  padding: 1px 6px;
  border-radius: var(--pad-radius-sm);
  font-size: var(--pad-fs-12);
}
.pad-toolstab__form {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px;
}
.pad-toolstab__form-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.pad-toolstab__label {
  font-size: var(--pad-fs-12, 12px);
  font-weight: var(--pad-fw-medium);
  color: var(--pad-fg-secondary);
}
.pad-toolstab__hint-inline {
  font-weight: var(--pad-fw-regular, 400);
  color: var(--pad-fg-tertiary);
  font-size: var(--pad-fs-11, 11px);
  margin-left: 4px;
}
.pad-toolstab__link {
  color: var(--pad-accent);
  text-decoration: none;
  margin-left: 4px;
}
.pad-toolstab__link:hover { text-decoration: underline; }
.pad-toolstab__input {
  padding: 6px 10px;
  background: var(--pad-popover);
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-sm);
  font-family: var(--pad-font-mono);
  font-size: var(--pad-fs-13);
  color: var(--pad-fg-primary);
}
.pad-toolstab__input:focus {
  outline: none;
  border-color: var(--pad-accent);
}
.pad-toolstab__textarea {
  padding: 8px 10px;
  background: var(--pad-popover);
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-sm);
  font-family: var(--pad-font-mono);
  font-size: var(--pad-fs-12, 12px);
  color: var(--pad-fg-primary);
  line-height: 1.5;
  resize: vertical;
  min-height: 200px;
}
.pad-toolstab__textarea:focus {
  outline: none;
  border-color: var(--pad-accent);
}
.pad-toolstab__form-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 4px;
}

.pad-toolstab__btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 12px;
  background: transparent;
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-sm);
  font-size: var(--pad-fs-12, 12px);
  color: var(--pad-fg-secondary);
  cursor: pointer;
  font-family: inherit;
  transition: all var(--pad-dur-fast) ease;
}
.pad-toolstab__btn:hover:not(:disabled) {
  background: var(--pad-bg-hover);
  color: var(--pad-fg-primary);
}
.pad-toolstab__btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.pad-toolstab__btn--primary {
  background: var(--pad-primary);
  color: var(--pad-fg-inverse);
  border-color: var(--pad-primary);
}
.pad-toolstab__btn--primary:hover:not(:disabled) {
  background: var(--pad-accent-hover);
  border-color: var(--pad-accent-hover);
}
.pad-toolstab__btn--danger:hover:not(:disabled) {
  color: var(--pad-danger, #dc2626);
  border-color: var(--pad-danger, #dc2626);
}

.pad-toolstab__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 32px 16px;
  background: var(--pad-bg-input);
  border: 1px dashed var(--pad-border);
  border-radius: var(--pad-radius-md);
  color: var(--pad-fg-tertiary);
  gap: 6px;
}
.pad-toolstab__empty-title {
  font-size: var(--pad-fs-13, 13px);
  font-weight: var(--pad-fw-medium);
  color: var(--pad-fg-secondary);
}
.pad-toolstab__empty-desc {
  font-size: var(--pad-fs-12, 12px);
  color: var(--pad-fg-tertiary);
}

.pad-toolstab__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.pad-toolstab__item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  background: var(--pad-bg-input);
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-md);
}
.pad-toolstab__item-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.pad-toolstab__item-name {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.pad-toolstab__item-name code {
  font-family: var(--pad-font-mono);
  font-size: var(--pad-fs-13, 13px);
  font-weight: var(--pad-fw-medium);
  color: var(--pad-fg-primary);
}
.pad-toolstab__scope-tag {
  font-size: var(--pad-fs-10, 10px);
  padding: 1px 6px;
  border-radius: var(--pad-radius-sm);
  font-weight: var(--pad-fw-medium);
  letter-spacing: 0.05em;
  text-transform: uppercase;
}
.pad-toolstab__scope-tag.is-workspace {
  background: color-mix(in srgb, var(--pad-accent) 14%, transparent);
  color: var(--pad-accent);
}
.pad-toolstab__scope-tag.is-global {
  background: var(--pad-muted);
  color: var(--pad-fg-secondary);
}
.pad-toolstab__basedon-tag {
  font-size: var(--pad-fs-10, 10px);
  color: var(--pad-fg-tertiary);
}
.pad-toolstab__item-desc {
  font-size: var(--pad-fs-12, 12px);
  color: var(--pad-fg-secondary);
  line-height: 1.4;
}
.pad-toolstab__item-actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}

.pad-toolstab__hint {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 10px 12px;
  background: var(--pad-bg-input);
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-md);
  font-size: var(--pad-fs-12, 12px);
  color: var(--pad-fg-tertiary);
  line-height: 1.5;
}

/* 2026-08-24 P3-G: Edit / Run dialog (跟现有 derive dialog 风格一致) */
.pad-toolstab__modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  /* z-index 提到 9999 防止任何 stacking context 干扰, 配合 Teleport to body 双保险 */
  z-index: 9999;
  padding: 20px;
}
.pad-toolstab__modal {
  background: var(--pad-bg-card);
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-md);
  padding: 20px;
  max-width: 720px;
  width: 100%;
  /* v3.42 (2026-08-24): 改 90vh → 90dvh 解决 Tauri 2 WebView2 拖拽窗口 resize 期间 modal 错位.
   *   跟 v3.41 main container 改 100% → 100dvh 同根因:
   *     - Tauri 2 WebView2 resize 时 vh 不立即更新, 锁在初始 viewport 算的高度
   *     - 90vh 让 modal 高度锁在初始 viewport * 0.9, resize 后 modal 高度可能比新 viewport
   *       还高 → 内容溢出截断 / textarea 跟 modal 容器错位 / 按钮被推出 modal
   *     - 90dvh (dynamic viewport height) 跟 v3.41 main container 100dvh 同步, resize 立即响应
   *   老浏览器 (Safari < 15.4) 走 fallback 90vh. */
  max-height: 90vh;  /* fallback for browsers without 90dvh */
  max-height: 90dvh;
  display: flex;
  flex-direction: column;
  gap: 12px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
  /* v3.24: 禁止内容溢出, 内部 overflow auto */
  overflow: hidden;
}
.pad-toolstab__modal-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: var(--pad-fs-15, 15px);
  font-weight: var(--pad-fw-medium);
  color: var(--pad-fg-primary);
  flex-shrink: 0;
}
.pad-toolstab__modal-title code {
  font-family: var(--pad-font-mono);
  font-size: var(--pad-fs-13, 13px);
  color: var(--pad-accent);
}
.pad-toolstab__modal-desc {
  margin: 0;
  font-size: var(--pad-fs-12, 12px);
  color: var(--pad-fg-secondary);
  line-height: 1.5;
  flex-shrink: 0;
}
.pad-toolstab__modal-desc code {
  font-family: var(--pad-font-mono);
  font-size: var(--pad-fs-12, 12px);
  background: var(--pad-bg-input);
  padding: 1px 4px;
  border-radius: 3px;
}
/* v3.24: textarea 弹性占满剩余空间, min-height 0 关键 (flexbox 默认 min-height auto) */
.pad-toolstab__modal-textarea {
  width: 100%;
  flex: 1 1 auto;
  min-height: 0;
  padding: 10px 12px;
  font-family: var(--pad-font-mono);
  font-size: var(--pad-fs-12, 12px);
  line-height: 1.5;
  background: var(--pad-bg-input);
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-sm);
  color: var(--pad-fg-primary);
  resize: none;  /* v3.24: 用 flex 控制高度, 不让 user 拖, 避免跟 modal 冲突 */
}
.pad-toolstab__modal-textarea:focus {
  outline: none;
  border-color: var(--pad-accent);
}
.pad-toolstab__modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  flex-shrink: 0;
}
</style>
