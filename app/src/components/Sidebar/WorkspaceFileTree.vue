<script setup lang="ts">
/**
 * WorkspaceFileTree — sidebar 文件树浏览器 (v0.6+ 2.1)
 *
 * 用途: 让用户 "看" 到 workspace 里有啥文件, 不用等 LLM tool call 输出.
 * 限制:
 *   - 默认 2 层深 (max-depth = 5, hard limit 写 Rust 里), 不递归 node_modules
 *   - 跳过大目录 (.git, target, dist, node_modules 等)
 *   - 不跟 symlink (防 sandbox 之外的"穿透"风险, 见 ADR-0013 已知风险)
 *
 * 交互:
 *   - 目录行: 点击展开/折叠
 *   - 文件行: 点击 → emit('reference-file', { path, name }) → 上层加入 composer 引用 chip
 *   - 可选 showBackHeader: 顶部显示 "← 返回" 按钮 (二级页面模式用), emit('back')
 *
 * 数据流: 组件 mount 时 invoke('list_workspace_tree', { path, maxDepth: 2 });
 *         切换 active workspace 时通过 key 强制 remount (在父组件用 :key="ws.id + ws.path")
 *         这里 watch path 变化重新加载 (应对父组件不复用的情况).
 */
import { ref, watch, onMounted } from 'vue';
import { ArrowLeft, ChevronRight, Folder, FolderOpen, FileText, Loader2 } from 'lucide-vue-next';
import { piTauri, type WorkspaceTreeNode } from '@/lib/tauri';

const props = withDefaults(defineProps<{
  workspacePath: string;
  workspaceName?: string;
  maxDepth?: number;
  /** v0.6+: 二级页面模式, 顶部显示 "返回" + workspace 名. 否则只在 sidebar 内显示小标题. */
  showBackHeader?: boolean;
}>(), {
  maxDepth: 2,
  workspaceName: '',
  showBackHeader: false,
});

const emit = defineEmits<{
  (e: 'reference-file', payload: { path: string; name: string }): void;
  (e: 'back'): void;
}>();

const tree = ref<WorkspaceTreeNode[] | null>(null);
const loading = ref(false);
const errorMsg = ref('');

// 展开 / 折叠 state, key = node.path
const expanded = ref<Set<string>>(new Set());

async function load() {
  if (!props.workspacePath) {
    tree.value = [];
    return;
  }
  loading.value = true;
  errorMsg.value = '';
  try {
    tree.value = await piTauri.listWorkspaceTree(props.workspacePath, props.maxDepth);
  } catch (e: any) {
    errorMsg.value = `加载失败: ${e?.message ?? e}`;
    tree.value = null;
  } finally {
    loading.value = false;
  }
}

function toggleNode(path: string) {
  const s = new Set(expanded.value);
  if (s.has(path)) s.delete(path);
  else s.add(path);
  expanded.value = s;
}

function isExpanded(path: string): boolean {
  return expanded.value.has(path);
}

/** v0.6+: 文件行点击 → 引用到 composer */
function onFileClick(path: string, name: string) {
  emit('reference-file', { path, name });
}

function onBack() {
  emit('back');
}

onMounted(() => {
  load();
});

// 当父组件切 active workspace (props 变化) 时重新加载
watch(() => props.workspacePath, () => {
  expanded.value = new Set();  // 清折叠 state
  load();
});
</script>

<template>
  <div class="pad-wsfiletree">
    <!-- v0.6+: 二级页面模式, 顶部显示返回按钮 + workspace 名 -->
    <div v-if="showBackHeader" class="pad-wsfiletree__back-header">
      <button class="pad-wsfiletree__back-btn" title="返回 session 列表" @click="onBack">
        <ArrowLeft :size="12" :stroke-width="2" />
        <span>返回</span>
      </button>
      <span class="pad-wsfiletree__ws-name" :title="workspacePath">{{ workspaceName || workspacePath }}</span>
    </div>
    <div v-else class="pad-wsfiletree__head">
      <span class="pad-wsfiletree__label">文件</span>
      <span v-if="loading" class="pad-wsfiletree__loading">
        <Loader2 :size="10" :stroke-width="2" class="pad-wsfiletree__spin" />
      </span>
    </div>

    <div v-if="errorMsg" class="pad-wsfiletree__error">{{ errorMsg }}</div>

    <div v-else-if="tree && tree.length === 0" class="pad-wsfiletree__empty">
      (空目录)
    </div>

    <ul v-else-if="tree" class="pad-wsfiletree__list">
      <li
        v-for="node in tree"
        :key="node.path"
        class="pad-wsfiletree__node"
      >
        <!-- 目录行 -->
        <div
          v-if="node.isDir"
          class="pad-wsfiletree__row"
          :class="{ 'is-expanded': isExpanded(node.path) }"
          @click="toggleNode(node.path)"
        >
          <ChevronRight :size="11" :stroke-width="2" class="pad-wsfiletree__chev" />
          <FolderOpen v-if="isExpanded(node.path)" :size="12" :stroke-width="1.75" class="pad-wsfiletree__icon" />
          <Folder v-else :size="12" :stroke-width="1.75" class="pad-wsfiletree__icon" />
          <span class="pad-wsfiletree__name" :title="node.path">{{ node.name }}</span>
        </div>
        <!-- 文件行 (v0.6+: 点击 → 引用到 composer) -->
        <div v-else class="pad-wsfiletree__row is-file" @click="onFileClick(node.path, node.name)">
          <span class="pad-wsfiletree__chev-spacer" />
          <FileText :size="12" :stroke-width="1.75" class="pad-wsfiletree__icon" />
          <span class="pad-wsfiletree__name" :title="node.path">{{ node.name }}</span>
        </div>
        <!-- 递归子节点 -->
        <ul
          v-if="node.isDir && isExpanded(node.path) && node.children && node.children.length > 0"
          class="pad-wsfiletree__list pad-wsfiletree__list--nested"
        >
          <li
            v-for="child in node.children"
            :key="child.path"
            class="pad-wsfiletree__node"
          >
            <div
              v-if="child.isDir"
              class="pad-wsfiletree__row"
              :class="{ 'is-expanded': isExpanded(child.path) }"
              @click="toggleNode(child.path)"
            >
              <ChevronRight :size="11" :stroke-width="2" class="pad-wsfiletree__chev" />
              <FolderOpen v-if="isExpanded(child.path)" :size="12" :stroke-width="1.75" class="pad-wsfiletree__icon" />
              <Folder v-else :size="12" :stroke-width="1.75" class="pad-wsfiletree__icon" />
              <span class="pad-wsfiletree__name" :title="child.path">{{ child.name }}</span>
            </div>
            <div v-else class="pad-wsfiletree__row is-file" @click="onFileClick(child.path, child.name)">
              <span class="pad-wsfiletree__chev-spacer" />
              <FileText :size="12" :stroke-width="1.75" class="pad-wsfiletree__icon" />
              <span class="pad-wsfiletree__name" :title="child.path">{{ child.name }}</span>
            </div>
          </li>
        </ul>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.pad-wsfiletree {
  margin: 2px 0 6px 0;
  border-radius: 4px;
  background: var(--pad-bg-base, transparent);
  /* v0.6.1: 跟 session 行统一 12px (跟 .pad-wstree 继承字号一致) */
  font-size: var(--pad-fs-12, 12px);
}

/* v0.6+: 二级页面模式顶部 header */
.pad-wsfiletree__back-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px 6px 8px;
  border-bottom: 1px solid var(--pad-border-subtle, var(--pad-bg-hover));
  margin-bottom: 4px;
}
.pad-wsfiletree__back-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border: 1px solid var(--pad-border-subtle, var(--pad-bg-hover));
  border-radius: 4px;
  background: transparent;
  color: var(--pad-fg-secondary);
  font-size: 11px;
  font-family: inherit;
  cursor: pointer;
  transition: background var(--pad-dur-fast) ease, color var(--pad-dur-fast) ease;
}
.pad-wsfiletree__back-btn:hover {
  background: var(--pad-bg-hover);
  color: var(--pad-fg-primary);
}
.pad-wsfiletree__ws-name {
  flex: 1;
  font-size: var(--pad-fs-12, 12px);
  font-weight: var(--pad-fw-medium, 500);
  color: var(--pad-fg-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  user-select: none;
}
.pad-wsfiletree__head {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  color: var(--pad-fg-tertiary);
  font-size: var(--pad-fs-11, 11px);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  user-select: none;
}
.pad-wsfiletree__label {
  flex: 1;
}
.pad-wsfiletree__loading {
  display: inline-flex;
  align-items: center;
}
.pad-wsfiletree__spin {
  animation: pad-wsfiletree-spin 0.8s linear infinite;
}
@keyframes pad-wsfiletree-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
.pad-wsfiletree__error {
  padding: 2px 8px;
  color: var(--pad-danger-text, #ff6b6b);
  font-size: var(--pad-fs-11, 11px);
}
.pad-wsfiletree__empty {
  padding: 2px 8px;
  color: var(--pad-fg-tertiary);
  font-size: var(--pad-fs-11, 11px);
}
.pad-wsfiletree__list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.pad-wsfiletree__list--nested {
  /* v0.6.1: 跟 session 缩进对齐 (.pad-wstree__sessions = 14px) */
  margin-left: 14px;
  border-left: 1px solid var(--pad-border-subtle, var(--pad-bg-hover));
}
.pad-wsfiletree__row {
  display: flex;
  align-items: center;
  gap: 6px;  /* 跟 .pad-wstree__session gap: 6px 对齐 */
  /* v0.6.1: 跟 session 行高/留白对齐, 行高 22px 跟 session 一致 */
  padding: 3px 8px;
  min-height: 22px;
  cursor: pointer;
  border-radius: 3px;
  user-select: none;
  color: var(--pad-fg-secondary);
}
.pad-wsfiletree__row:hover {
  background: var(--pad-bg-hover);
  color: var(--pad-fg-primary);
}
.pad-wsfiletree__row.is-file {
  cursor: pointer;  /* v0.6+: 文件可点击 → 引用到 composer */
}
.pad-wsfiletree__row.is-expanded .pad-wsfiletree__chev {
  transform: rotate(90deg);
}
.pad-wsfiletree__chev {
  flex-shrink: 0;
  color: var(--pad-fg-tertiary);
  transition: transform var(--pad-dur-fast) ease;
}
.pad-wsfiletree__chev-spacer {
  display: inline-block;
  width: 11px;  /* 跟 chev 尺寸对齐 */
  flex-shrink: 0;
}
.pad-wsfiletree__icon {
  flex-shrink: 0;
}
.pad-wsfiletree__name {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: var(--pad-fs-12, 12px);  /* v0.6.1: 跟 session 12px 对齐 */
}
</style>
