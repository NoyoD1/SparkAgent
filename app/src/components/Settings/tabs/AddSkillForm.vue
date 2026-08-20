<script setup lang="ts">
/**
 * AddSkillForm — v0.4.4 Skills "添加自定义" form
 *
 * 走 Pi SDK 0.84.2 SKILL.md 格式 (frontmatter 解析). 收集:
 *   - name (a-zA-Z0-9._-)  → 写文件时用作文件名
 *   - description           → frontmatter.description
 *   - body                  → frontmatter 之后的所有 markdown 内容
 *   - scope                 → 'workspace' (写到 <ws>/.pi/skills/<name>.md) / 'global' (写到 <agentDir>/skills/<name>.md)
 *
 * 写完 emit 'created' 给 SkillsTab, SkillsTab 切回 'list' view, 提示 user 重启 .exe
 * (D165 systemPrompt 不可动态改, sidecar 重启才会 loadSkills 看到新文件).
 *
 * 不做 (D184 不推测, v0.4.4.x polish):
 *   - 复杂 name 校验提示 (只看客户端 1-64 char + 字符集)
 *   - 编辑 / 删除 skill
 *   - 测试 skill 预览
 *   - 上传 .md 文件
 */
import { ref, computed } from 'vue';
import { ArrowLeft, Save, AlertCircle, Loader2, Check, FileText, Sparkles, Upload, FileArchive, Link } from 'lucide-vue-next';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { piTauri } from '@/lib/tauri';
import { useSessionStore } from '@/stores/session';
import { useSkillsStore } from '@/stores/skills';

const emit = defineEmits<{
  close: [];
  created: [filePath: string];
  zipImported: [info: { name: string; targetDir: string; fileCount: number }];
  urlImported: [info: { name: string; targetPath: string; bytes: number }];
}>();

const importState = ref<'idle' | 'importing' | 'fail'>('idle');
const importMessage = ref<string>('');
const importUrl = ref<string>('');

const sessionStore = useSessionStore();

const scope = ref<'workspace' | 'global'>('workspace');
const name = ref<string>('');
const description = ref<string>('');
const body = ref<string>('# 在此写 skill 的 prompt / 指令\n\n比如:\n- 这个 skill 用于 ...\n- 调用方式: ...\n');
const submitState = ref<'idle' | 'submitting' | 'ok' | 'fail'>('idle');
const submitMessage = ref<string>('');

/** 拿当前 active workspace path (跟 sidecar workspacePath 保持一致) */
const activeWorkspacePath = computed<string | null>(() => {
  const id = sessionStore.activeWorkspaceId;
  if (!id) return null;
  const ws = sessionStore.workspaces.find((w) => w.id === id);
  return ws?.path ?? null;
});

// Pi SDK 0.84.2 skill name 约束: a-zA-Z0-9._-, 1-64 char (跟 Rust write_skill_file 校验一致)
const nameValid = computed(() => {
  if (!name.value) return null;
  if (name.value.length > 64) return false;
  if (!/^[a-zA-Z0-9._-]+$/.test(name.value)) return false;
  if (name.value === '.' || name.value === '..') return false;
  return true;
});

const finalBody = computed(() => {
  // 拼 frontmatter + body. body 开头如果是 '---' 视为已经有 frontmatter, 不重复加
  const trimmedBody = body.value.trim();
  const hasFrontmatter = trimmedBody.startsWith('---');
  if (hasFrontmatter) {
    return trimmedBody + '\n';
  }
  return `---\nname: ${name.value}\ndescription: ${description.value || '(no description)'}\n---\n\n${trimmedBody}\n`;
});

async function importFromMd() {
  importState.value = 'importing';
  importMessage.value = '';
  try {
    // 1. Tauri 2 dialog:open 选文件 (md / markdown)
    const selected = await openDialog({
      multiple: false,
      title: '选择 SKILL.md 文件',
      filters: [
        { name: 'Markdown / SKILL.md', extensions: ['md', 'markdown'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    if (!selected || typeof selected !== 'string') {
      importState.value = 'idle';
      return;
    }
    // 2. invoke read_skill_file → 解析 frontmatter
    const parsed = await piTauri.readSkillFile(selected);
    // 3. 填到 form
    name.value = parsed.name;
    description.value = parsed.description ?? '';
    // body 用 parsed.body (strip 掉 frontmatter block), 没 frontmatter 时 = raw
    body.value = parsed.hasFrontmatter ? parsed.body : parsed.raw;
    importState.value = 'idle';
    importMessage.value = `已加载 ${parsed.path} (name="${parsed.name}"${parsed.description ? `, description 已填充` : ''})`;
    console.log('[skills] imported from', parsed.path, '— name:', parsed.name, 'description:', parsed.description, 'disableModelInvocation:', parsed.disableModelInvocation);
  } catch (e) {
    importState.value = 'fail';
    importMessage.value = e instanceof Error ? e.message : String(e);
  }
}

/**
 * v0.4.4.4: 从 .zip 压缩包导入 (多文件 skill pack)
 * 跟 .md 导入区别: zip 整目录解到 target/<name>/, 跳过 form, 直接 emit zipImported.
 * 2 种 zip layout 都支持:
 *   - 根级 SKILL.md (单文件)
 *   - 子目录 <name>/SKILL.md (GitHub release 标准 layout, 保留所有文件)
 */
async function importFromZip() {
  importState.value = 'importing';
  importMessage.value = '';
  try {
    // 1. Tauri 2 dialog:open 选 .zip
    const selected = await openDialog({
      multiple: false,
      title: '选择 skill 压缩包 (.zip)',
      filters: [
        { name: 'Zip 压缩包', extensions: ['zip'] },
      ],
    });
    if (!selected || typeof selected !== 'string') {
      importState.value = 'idle';
      return;
    }
    // 2. 决定 scope (跟 manual submit 一样)
    const wsPath = activeWorkspacePath.value;
    const isWorkspace = scope.value === 'workspace';
    if (isWorkspace && !wsPath) {
      importState.value = 'fail';
      importMessage.value = '当前没有 active workspace. 切到一个 workspace 或选 "Global" 范围';
      return;
    }
    // 3. invoke import_skill_zip
    const result = await piTauri.importSkillZip({
      zipPath: selected,
      scope: scope.value,
      workspacePath: isWorkspace ? wsPath : null,
      agentDir: null, // global: Rust 端 fallback 算 (跟 write_skill_file 一致)
    });
    // v0.4.4.6: 写完后立刻调 list_skills 刷新 skills store (跟 sidecar skills_snapshot 解耦, user 不用重启 .exe 也能看到)
    const skillsStore = useSkillsStore();
    await skillsStore.refreshFromTauri();
    // 4. emit zipImported (SkillsTab 关 form + 显示 toast)
    importState.value = 'idle';
    importMessage.value = `已解压 ${result.fileCount} 个文件到 ${result.targetDir}`;
    console.log('[skills] zip imported:', result);
    emit('zipImported', { name: result.name, targetDir: result.targetDir, fileCount: result.fileCount });
  } catch (e) {
    importState.value = 'fail';
    importMessage.value = e instanceof Error ? e.message : String(e);
  }
}

/**
 * v0.4.4.5: 从 URL 导入 (raw .md content, 走 Tauri ureq sync HTTP)
 * 跟 .zip 一样跳过 form, 直接 emit urlImported. 限制: 必须是单文件 raw .md,
 * 不支持 URL 指向 zip (那是 v0.4.4.4 工作), 不支持 git clone.
 */
async function importFromUrl() {
  const url = importUrl.value.trim();
  if (!url) {
    importState.value = 'fail';
    importMessage.value = '请输入 URL';
    return;
  }
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    importState.value = 'fail';
    importMessage.value = 'URL 必须以 http:// 或 https:// 开头';
    return;
  }
  importState.value = 'importing';
  importMessage.value = '';
  try {
    const wsPath = activeWorkspacePath.value;
    const isWorkspace = scope.value === 'workspace';
    if (isWorkspace && !wsPath) {
      importState.value = 'fail';
      importMessage.value = '当前没有 active workspace. 切到一个 workspace 或选 "Global" 范围';
      return;
    }
    const result = await piTauri.importSkillUrl({
      url,
      scope: scope.value,
      workspacePath: isWorkspace ? wsPath : null,
      agentDir: null, // global: Rust 端 fallback 算 (跟 write_skill_file 一致)
    });
    // v0.4.4.6: 写完后立刻调 list_skills 刷新 skills store
    const skillsStore = useSkillsStore();
    await skillsStore.refreshFromTauri();
    importState.value = 'idle';
    importMessage.value = `已 fetch ${result.bytes} bytes 到 ${result.targetPath}`;
    importUrl.value = ''; // 清空输入
    console.log('[skills] url imported:', result);
    emit('urlImported', { name: result.name, targetPath: result.targetPath, bytes: result.bytes });
  } catch (e) {
    importState.value = 'fail';
    importMessage.value = e instanceof Error ? e.message : String(e);
  }
}

async function submit() {
  if (!name.value.trim()) {
    submitState.value = 'fail';
    submitMessage.value = 'name 不能为空';
    return;
  }
  if (nameValid.value === false) {
    submitState.value = 'fail';
    submitMessage.value = 'name 只能含 [a-zA-Z0-9._-], 长度 1-64';
    return;
  }
  if (!description.value.trim()) {
    submitState.value = 'fail';
    submitMessage.value = 'description 必填 (Pi SDK 用来让 LLM 知道何时调用这个 skill)';
    return;
  }
  submitState.value = 'submitting';
  submitMessage.value = '写 SKILL.md...';
  try {
    const args: {
      scope: 'workspace' | 'global';
      name: string;
      body: string;
      workspacePath?: string | null;
      agentDir?: string | null;
    } = {
      scope: scope.value,
      name: name.value.trim(),
      body: finalBody.value,
    };
    if (scope.value === 'workspace') {
      // workspace: 拿 session store 当前 active workspace path
      const wsPath = activeWorkspacePath.value;
      if (!wsPath) {
        submitState.value = 'fail';
        submitMessage.value = '当前没有 active workspace. 切到一个 workspace 或选 "Global" 范围';
        return;
      }
      args.workspacePath = wsPath;
    } else {
      // global: 不传 agentDir, Rust 端 fallback 算 (USERPROFILE/HOME + .pi/agent,
      //   跟 Pi SDK 0.84.2 getAgentDir() 一致, sidecar 启动时用的同一路径)
      args.agentDir = null;
    }
    const filePath = await piTauri.writeSkillFile(args);
    submitState.value = 'ok';
    submitMessage.value = `已写入 ${filePath}`;
    // v0.4.4.6: 写完后立刻调 list_skills 刷新 skills store (跟 sidecar skills_snapshot 解耦, user 不用重启 .exe 也能看到)
    const skillsStore = useSkillsStore();
    await skillsStore.refreshFromTauri();
    // v0.4.4 占位: 提示 user 重启 .exe. skills store 不会自动刷新 (sidecar 没重启).
    // 后续 v0.4.4.x polish: 写完自动 restart sidecar.
    console.warn('[skills] created at', filePath, '— 重启 release .exe 让 sidecar 重新加载 skills 注入 system prompt (D165 systemPrompt 不可动态改).');
    // emit 后 SkillsTab 切回 'list' + 显示 toast
    setTimeout(() => emit('created', filePath), 600);
  } catch (e) {
    submitState.value = 'fail';
    submitMessage.value = e instanceof Error ? e.message : String(e);
  }
}
</script>

<template>
  <div class="pad-addskill">
    <div class="pad-addskill__head">
      <button class="pad-addskill__back" @click="emit('close')">
        <ArrowLeft :size="14" :stroke-width="1.75" />
        <span>返回 Skills 列表</span>
      </button>
      <h3 class="pad-addskill__title">
        <Sparkles :size="16" :stroke-width="1.75" />
        添加自定义 skill
      </h3>
      <p class="pad-addskill__subtitle">
        创建一个 <code>SKILL.md</code> 文件 (Pi SDK 0.84.2 <code>loadSkills</code> 格式). 走 frontmatter + markdown body.
        启用后会在每次 send_prompt 时注入 system prompt.
        <strong>已有 SKILL.md?</strong> 下面"从文件导入"自动解析 frontmatter.
      </p>
    </div>

    <div class="pad-addskill__import-row">
      <button
        type="button"
        class="pad-addskill__import-btn"
        :disabled="importState === 'importing'"
        @click="importFromMd"
      >
        <Loader2 v-if="importState === 'importing'" :size="14" :stroke-width="1.75" class="pad-addskill__spinner" />
        <Upload v-else :size="14" :stroke-width="1.75" />
        <span>{{ importState === 'importing' ? '加载中...' : '从 .md 导入' }}</span>
      </button>
      <button
        type="button"
        class="pad-addskill__import-btn pad-addskill__import-btn--zip"
        :disabled="importState === 'importing'"
        @click="importFromZip"
      >
        <Loader2 v-if="importState === 'importing'" :size="14" :stroke-width="1.75" class="pad-addskill__spinner" />
        <FileArchive v-else :size="14" :stroke-width="1.75" />
        <span>{{ importState === 'importing' ? '解压中...' : '从 .zip 导入 (整目录)' }}</span>
      </button>
      <span v-if="importMessage" class="pad-addskill__import-hint" :class="{ 'is-fail': importState === 'fail' }">
        {{ importMessage }}
      </span>
    </div>

    <!-- v0.4.4.5: URL 导入 (raw .md content, 走 Tauri ureq sync HTTP) -->
    <div class="pad-addskill__import-url">
      <label class="pad-addskill__import-url-label" for="addskill-url">从 URL 导入 (raw .md)</label>
      <div class="pad-addskill__import-url-row">
        <input
          id="addskill-url"
          v-model="importUrl"
          type="url"
          class="pad-addskill__input pad-addskill__import-url-input"
          placeholder="https://raw.githubusercontent.com/.../SKILL.md"
          :disabled="importState === 'importing'"
          @keyup.enter="importFromUrl"
        />
        <button
          type="button"
          class="pad-addskill__import-btn pad-addskill__import-btn--url"
          :disabled="importState === 'importing' || !importUrl.trim()"
          @click="importFromUrl"
        >
          <Loader2 v-if="importState === 'importing'" :size="14" :stroke-width="1.75" class="pad-addskill__spinner" />
          <Link v-else :size="14" :stroke-width="1.75" />
          <span>{{ importState === 'importing' ? 'fetch 中...' : '导入' }}</span>
        </button>
      </div>
    </div>

    <form class="pad-addskill__form" @submit.prevent="submit">
      <!-- Scope: workspace / global -->
      <div class="pad-addskill__field">
        <label class="pad-addskill__label">范围</label>
        <div class="pad-addskill__scope-options">
          <label class="pad-addskill__scope-option" :class="{ 'is-active': scope === 'workspace' }">
            <input type="radio" v-model="scope" value="workspace" />
            <div>
              <div class="pad-addskill__scope-title">Workspace</div>
              <div class="pad-addskill__scope-desc">写到当前 workspace 的 <code>.pi/skills/</code> — 跟随 workspace 走, 团队共享</div>
            </div>
          </label>
          <label class="pad-addskill__scope-option" :class="{ 'is-active': scope === 'global' }">
            <input type="radio" v-model="scope" value="global" />
            <div>
              <div class="pad-addskill__scope-title">Global</div>
              <div class="pad-addskill__scope-desc">写到 <code>~/.pi/agent/skills/</code> — 所有 workspace 共享, 个人</div>
            </div>
          </label>
        </div>
      </div>

      <!-- Name -->
      <div class="pad-addskill__field">
        <label class="pad-addskill__label" for="addskill-name">Name</label>
        <input
          id="addskill-name"
          v-model="name"
          type="text"
          class="pad-addskill__input"
          :class="{ 'is-error': nameValid === false }"
          placeholder="my-skill"
          maxlength="64"
          autocomplete="off"
        />
        <div class="pad-addskill__hint">
          只能含 <code>[a-zA-Z0-9._-]</code>, 1-64 字符. 跟 Pi SDK 0.84.2 frontmatter.name 一致.
        </div>
      </div>

      <!-- Description -->
      <div class="pad-addskill__field">
        <label class="pad-addskill__label" for="addskill-desc">Description</label>
        <input
          id="addskill-desc"
          v-model="description"
          type="text"
          class="pad-addskill__input"
          placeholder="这个 skill 用于 ... (必填, Pi SDK 用来让 LLM 知道何时调用)"
          maxlength="200"
          autocomplete="off"
        />
      </div>

      <!-- Body -->
      <div class="pad-addskill__field">
        <label class="pad-addskill__label" for="addskill-body">Body (markdown)</label>
        <textarea
          id="addskill-body"
          v-model="body"
          class="pad-addskill__textarea"
          rows="8"
          spellcheck="false"
        />
        <div class="pad-addskill__hint">
          frontmatter (<code>name</code> + <code>description</code>) 会自动从上面 form 拼, 你只需要写 skill 实际内容.
          如果 body 开头已经是 <code>---</code>, 会用你写的 frontmatter 不重复加.
        </div>
      </div>

      <!-- 预览 -->
      <div class="pad-addskill__preview">
        <div class="pad-addskill__preview-head">
          <FileText :size="12" :stroke-width="1.75" />
          <span>预览 (frontmatter + body)</span>
        </div>
        <pre class="pad-addskill__preview-body">{{ finalBody }}</pre>
      </div>

      <!-- Submit -->
      <div class="pad-addskill__actions">
        <button type="button" class="pad-addskill__btn pad-addskill__btn--ghost" @click="emit('close')">
          取消
        </button>
        <button
          type="submit"
          class="pad-addskill__btn pad-addskill__btn--primary"
          :disabled="submitState === 'submitting' || nameValid === false"
        >
          <Loader2 v-if="submitState === 'submitting'" :size="14" :stroke-width="1.75" class="pad-addskill__spinner" />
          <Check v-else-if="submitState === 'ok'" :size="14" :stroke-width="1.75" />
          <Save v-else :size="14" :stroke-width="1.75" />
          <span>{{ submitState === 'submitting' ? '写入中...' : submitState === 'ok' ? '已写入' : '写入 SKILL.md' }}</span>
        </button>
      </div>

      <div v-if="submitMessage" class="pad-addskill__status" :class="{ 'is-ok': submitState === 'ok', 'is-fail': submitState === 'fail' }">
        <AlertCircle v-if="submitState === 'fail'" :size="12" :stroke-width="1.75" />
        <Check v-else-if="submitState === 'ok'" :size="12" :stroke-width="1.75" />
        <span>{{ submitMessage }}</span>
      </div>
    </form>
  </div>
</template>

<style scoped>
.pad-addskill {
  max-width: 720px;
}
.pad-addskill__head {
  margin-bottom: 16px;
}
.pad-addskill__back {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: transparent;
  border: none;
  color: var(--pad-fg-tertiary);
  font-size: 11px;
  cursor: pointer;
  padding: 4px 6px;
  margin-bottom: 12px;
  border-radius: var(--pad-radius-sm, 4px);
}
.pad-addskill__back:hover {
  background: var(--pad-bg-hover, rgba(0, 0, 0, 0.04));
  color: var(--pad-fg-secondary);
}
.pad-addskill__title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 18px;
  font-weight: 600;
  color: var(--pad-fg-primary);
  margin: 0 0 4px;
}
.pad-addskill__subtitle {
  font-size: 12px;
  color: var(--pad-fg-tertiary);
  margin: 0;
  line-height: 1.5;
}
.pad-addskill__subtitle code {
  font-family: var(--pad-font-mono, ui-monospace, monospace);
  font-size: 11px;
  background: var(--pad-bg-secondary, rgba(0, 0, 0, 0.04));
  padding: 1px 4px;
  border-radius: 3px;
}

/* v0.4.4.3 从文件导入 row */
.pad-addskill__import-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  background: var(--pad-bg-secondary, rgba(0, 0, 0, 0.02));
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-md);
  margin-bottom: 16px;
}
.pad-addskill__import-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  font-size: 12px;
  font-weight: 500;
  background: var(--pad-card);
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-md);
  color: var(--pad-fg-secondary);
  cursor: pointer;
  transition: all 0.15s;
  white-space: nowrap;
}
.pad-addskill__import-btn:hover:not(:disabled) {
  background: var(--pad-accent-primary, #6366f1);
  border-color: var(--pad-accent-primary, #6366f1);
  color: white;
}
.pad-addskill__import-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.pad-addskill__import-hint {
  font-size: 11px;
  color: var(--pad-fg-tertiary);
  line-height: 1.4;
  word-break: break-all;
}
.pad-addskill__import-hint.is-fail {
  color: var(--pad-fg-warning, #d97706);
}

/* v0.4.4.5 URL 导入行 */
.pad-addskill__import-url {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  background: var(--pad-bg-secondary, rgba(0, 0, 0, 0.02));
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-md);
  margin-bottom: 16px;
}
.pad-addskill__import-url-label {
  font-size: 11px;
  font-weight: 500;
  color: var(--pad-fg-secondary);
}
.pad-addskill__import-url-row {
  display: flex;
  gap: 6px;
}
.pad-addskill__import-url-input {
  flex: 1;
  font-family: var(--pad-font-mono, ui-monospace, monospace);
  font-size: 11px;
}
.pad-addskill__import-btn--url {
  flex-shrink: 0;
}

.pad-addskill__form {
  background: var(--pad-card);
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-lg);
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.pad-addskill__field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.pad-addskill__label {
  font-size: 12px;
  font-weight: 500;
  color: var(--pad-fg-secondary);
}
.pad-addskill__input,
.pad-addskill__textarea {
  width: 100%;
  padding: 8px 10px;
  font-size: 13px;
  font-family: inherit;
  color: var(--pad-fg-primary);
  background: var(--pad-card);
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-md);
  outline: none;
  transition: border-color 0.15s;
  font-variant-numeric: tabular-nums;
}
.pad-addskill__textarea {
  font-family: var(--pad-font-mono, ui-monospace, monospace);
  font-size: 12px;
  line-height: 1.5;
  resize: vertical;
  min-height: 120px;
}
.pad-addskill__input:focus,
.pad-addskill__textarea:focus {
  border-color: var(--pad-accent-primary, #6366f1);
}
.pad-addskill__input.is-error {
  border-color: var(--pad-fg-warning, #d97706);
}
.pad-addskill__hint {
  font-size: 11px;
  color: var(--pad-fg-tertiary);
  line-height: 1.5;
}
.pad-addskill__hint code {
  font-family: var(--pad-font-mono, ui-monospace, monospace);
  font-size: 10px;
  background: var(--pad-bg-secondary, rgba(0, 0, 0, 0.04));
  padding: 1px 4px;
  border-radius: 3px;
}

.pad-addskill__scope-options {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.pad-addskill__scope-option {
  display: flex;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-md);
  cursor: pointer;
  background: var(--pad-card);
  transition: all 0.15s;
}
.pad-addskill__scope-option:hover {
  background: var(--pad-bg-hover, rgba(0, 0, 0, 0.02));
}
.pad-addskill__scope-option.is-active {
  border-color: var(--pad-accent-primary, #6366f1);
  background: var(--pad-bg-accent-soft, rgba(99, 102, 241, 0.04));
}
.pad-addskill__scope-option input {
  margin-top: 2px;
  accent-color: var(--pad-accent-primary, #6366f1);
}
.pad-addskill__scope-title {
  font-size: 12px;
  font-weight: 500;
  color: var(--pad-fg-primary);
  margin-bottom: 2px;
}
.pad-addskill__scope-desc {
  font-size: 11px;
  color: var(--pad-fg-tertiary);
  line-height: 1.4;
}
.pad-addskill__scope-desc code {
  font-family: var(--pad-font-mono, ui-monospace, monospace);
  font-size: 10px;
  background: var(--pad-bg-secondary, rgba(0, 0, 0, 0.04));
  padding: 1px 3px;
  border-radius: 3px;
}

.pad-addskill__preview {
  background: var(--pad-bg-secondary, rgba(0, 0, 0, 0.02));
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-md);
  overflow: hidden;
}
.pad-addskill__preview-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  background: var(--pad-card);
  border-bottom: 1px solid var(--pad-border);
  color: var(--pad-fg-tertiary);
  font-size: 11px;
  font-weight: 500;
}
.pad-addskill__preview-body {
  margin: 0;
  padding: 10px;
  font-family: var(--pad-font-mono, ui-monospace, monospace);
  font-size: 11px;
  line-height: 1.6;
  color: var(--pad-fg-secondary);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 200px;
  overflow-y: auto;
}

.pad-addskill__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 4px;
}
.pad-addskill__btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  font-size: 12px;
  font-weight: 500;
  border-radius: var(--pad-radius-md);
  cursor: pointer;
  border: 1px solid transparent;
  transition: all 0.15s;
}
.pad-addskill__btn--ghost {
  background: transparent;
  border-color: var(--pad-border);
  color: var(--pad-fg-secondary);
}
.pad-addskill__btn--ghost:hover {
  background: var(--pad-bg-hover, rgba(0, 0, 0, 0.04));
}
.pad-addskill__btn--primary {
  background: var(--pad-accent-primary, #6366f1);
  color: white;
}
.pad-addskill__btn--primary:hover:not(:disabled) {
  background: var(--pad-accent-primary-hover, #4f46e5);
}
.pad-addskill__btn--primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.pad-addskill__spinner {
  animation: pad-addskill-spin 1s linear infinite;
}
@keyframes pad-addskill-spin {
  to { transform: rotate(360deg); }
}

.pad-addskill__status {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  font-size: 11px;
  border-radius: var(--pad-radius-sm, 4px);
  background: var(--pad-bg-tertiary, rgba(0, 0, 0, 0.04));
  color: var(--pad-fg-tertiary);
}
.pad-addskill__status.is-ok {
  background: var(--pad-bg-success-soft, rgba(34, 197, 94, 0.08));
  color: var(--pad-fg-success, #16a34a);
}
.pad-addskill__status.is-fail {
  background: var(--pad-bg-warning-soft, rgba(217, 119, 6, 0.08));
  color: var(--pad-fg-warning, #d97706);
}
</style>
