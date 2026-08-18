<script setup lang="ts">
/**
 * SidebarFunctionList — 4 function rows.
 * 1:1 mirrors chat.html's nav.function-list block.
 *
 * v0.3.5+ "新建任务" 不再自动拉 picker, 改跳回 ChatMain 的 initial hero:
 *   用户在中间 area 的 "本地" tab 下拉里手动选文件夹 / 创建 workspace,
 *   或直接在 composer 里发消息 (会触发 ensureDefaultWorkspace 自动建).
 *
 * v0.4.6.2: 删掉底部 v0.4.6.1 新加的 "AGENT 团队" group (D184 v9 ❷ user 14:30
 *   "用原来旧的上面你的素材, 然后左侧栏的底部agent那个区域删除")
 *   AGENT 团队 group 已经迁到 WorkspaceTree.vue 底部 (user 之前做的 Trae 风格),
 *   改造后显示真实 agent 数据 (主/子 标 + 圆点 + 切主 + 折叠).
 */
import { Plug, Zap, Briefcase, LayoutTemplate, Plus } from 'lucide-vue-next';
import { useSessionStore } from '@/stores/session';

const sessionStore = useSessionStore();

/**
 * 新建任务 — v0.3.5+: 单纯跳回首页 (clear active session), 不弹 picker.
 * 后续 workspace/session 创建走中间 hero 的"本地"下拉 或 composer 自动建.
 */
function createNewTask() {
  sessionStore.clearActiveSession();
}
</script>

<template>
  <nav class="pad-funcnav">
    <button class="pad-newtask" @click="createNewTask">
      <Plus :size="14" :stroke-width="1.75" />
      <span class="pad-funcnav__label">新建任务</span>
    </button>

    <button class="pad-funcrow">
      <Plug :size="16" :stroke-width="1.75" />
      <span class="pad-funcnav__label">插件市场</span>
    </button>
    <button class="pad-funcrow">
      <Zap :size="16" :stroke-width="1.75" />
      <span class="pad-funcnav__label">自动化</span>
    </button>
    <button class="pad-funcrow">
      <Briefcase :size="16" :stroke-width="1.75" />
      <span class="pad-funcnav__label">办公助理</span>
    </button>
    <button class="pad-funcrow">
      <LayoutTemplate :size="16" :stroke-width="1.75" />
      <span class="pad-funcnav__label">模板库</span>
    </button>

    <!-- v0.4.6.2: 删掉 v0.4.6.1 在底部新加的 "AGENT 团队" group (D184 v9 ❷).
         AGENT 团队 group 迁到 WorkspaceTree.vue 底部 (user 之前做的 Trae 风格). -->
  </nav>
</template>

<style scoped>
.pad-funcnav {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 0 var(--pad-sp-2);
  flex-shrink: 0;
}
.pad-funcrow,
.pad-newtask {
  display: flex;
  align-items: center;
  gap: var(--pad-sp-2);
  width: 100%;
  height: 32px;
  padding: 0 var(--pad-sp-3);
  border-radius: var(--pad-radius-md);
  font-size: var(--pad-fs-13);
  color: var(--pad-fg-secondary);
  background: transparent;
  border: none;
  cursor: pointer;
  text-align: left;
  transition:
    background var(--pad-dur-fast) ease,
    color var(--pad-dur-fast) ease;
}
.pad-newtask {
  color: var(--pad-fg-primary);
  font-weight: var(--pad-fw-medium);
}
.pad-newtask:hover {
  background: var(--pad-bg-hover);
}
.pad-funcrow:hover {
  background: var(--pad-bg-hover);
  color: var(--pad-fg-primary);
}

/* Collapsed sidebar — hide label, center icons */
:global(.pad-sidebar.is-collapsed) .pad-funcrow,
:global(.pad-sidebar.is-collapsed) .pad-newtask {
  justify-content: center;
  padding: 0;
}
:global(.pad-sidebar.is-collapsed) .pad-funcnav__label {
  display: none;
}
</style>
