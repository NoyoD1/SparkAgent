<script setup lang="ts">
/**
 * SidebarFunctionList — 4 function rows + v0.4.6.1 AGENT 团队 group.
 * 1:1 mirrors chat.html's nav.function-list block + Trae IDE "AGENT 团队" (D184 v8).
 *
 * v0.3.5+ "新建任务" 不再自动拉 picker, 改跳回 ChatMain 的 initial hero:
 *   用户在中间 area 的 "本地" tab 下拉里手动选文件夹 / 创建 workspace,
 *   或直接在 composer 里发消息 (会触发 ensureDefaultWorkspace 自动建).
 *
 * v0.4.6.1: 新增 AGENT 团队 group (跟 Trae IDE 截图一致, D184 v8 Q3 拍板).
 *   主 agent 标 [主] 绿点, 子 agent 标 [子] 灰点. 跟未来 ADR-0022 sub-agent 衔接:
 *   "子 agent" = 数据层 (备选 persona 库), "sub-agent" = 调用层 (独立 sidecar 进程).
 */
import { Plug, Zap, Briefcase, LayoutTemplate, Plus, Bot, Circle } from 'lucide-vue-next';
import { storeToRefs } from 'pinia';
import { onMounted } from 'vue';
import { useSessionStore } from '@/stores/session';
import { useAgentsStore } from '@/stores/agents';

const sessionStore = useSessionStore();
const agentsStore = useAgentsStore();
const { agents, activeName } = storeToRefs(agentsStore);

/**
 * 新建任务 — v0.3.5+: 单纯跳回首页 (clear active session), 不弹 picker.
 * 后续 workspace/session 创建走中间 hero 的"本地"下拉 或 composer 自动建.
 */
function createNewTask() {
  sessionStore.clearActiveSession();
}

async function pickMainAgent(name: string) {
  if (name === activeName.value) return;
  try {
    await agentsStore.setMain(name);
  } catch (e) {
    console.error('[SidebarFunctionList] setMain failed', e);
  }
}

onMounted(() => {
  // 第一次 sidebar 出现时拉一次 (后续切 workspace / 写完 agent 后 UI 各处各自 refresh)
  if (!agentsStore.hasTauriList) {
    agentsStore.refreshFromTauri();
  }
});
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

    <!-- v0.4.6.1 AGENT 团队 group (跟 Trae IDE 截图一致) -->
    <div class="pad-agentgroup">
      <div class="pad-agentgroup__label">
        <Bot :size="12" :stroke-width="1.75" />
        <span>AGENT 团队</span>
        <span class="pad-agentgroup__count">{{ agents.length }}</span>
      </div>
      <div v-if="agents.length === 0" class="pad-agentgroup__empty">
        <span>暂无 agent</span>
      </div>
      <button
        v-for="a in agents"
        :key="a.name"
        class="pad-agentrow"
        :class="{ 'is-main': a.name === activeName }"
        :title="a.description || a.name"
        @click="pickMainAgent(a.name)"
      >
        <Circle
          :size="8"
          :stroke-width="0"
          :fill="a.name === activeName ? 'var(--pad-fg-success, #22c55e)' : 'var(--pad-fg-tertiary)'"
        />
        <span class="pad-funcnav__label pad-agentrow__name">{{ a.name }}</span>
        <span class="pad-agentrow__tag" :class="`is-${a.role}`">{{ a.role === 'main' ? '主' : '子' }}</span>
      </button>
    </div>
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

/* v0.4.6.1 AGENT 团队 group */
.pad-agentgroup {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: var(--pad-sp-3);
  padding-top: var(--pad-sp-2);
  border-top: 1px solid var(--pad-border-subtle, rgba(0,0,0,0.06));
}
.pad-agentgroup__label {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px var(--pad-sp-3);
  font-size: 10px;
  font-weight: var(--pad-fw-medium);
  color: var(--pad-fg-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.pad-agentgroup__count {
  margin-left: auto;
  font-size: 10px;
  color: var(--pad-fg-tertiary);
  background: var(--pad-bg-muted, rgba(0,0,0,0.04));
  padding: 0 6px;
  border-radius: 8px;
}
.pad-agentgroup__empty {
  padding: 4px var(--pad-sp-3);
  font-size: 11px;
  color: var(--pad-fg-tertiary);
  font-style: italic;
}
.pad-agentrow {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 28px;
  padding: 0 var(--pad-sp-3);
  border-radius: var(--pad-radius-md);
  font-size: var(--pad-fs-12);
  color: var(--pad-fg-secondary);
  background: transparent;
  border: none;
  cursor: pointer;
  text-align: left;
  transition: background var(--pad-dur-fast) ease, color var(--pad-dur-fast) ease;
}
.pad-agentrow:hover {
  background: var(--pad-bg-hover);
  color: var(--pad-fg-primary);
}
.pad-agentrow.is-main {
  background: var(--pad-bg-success-soft, rgba(34,197,94,0.08));
  color: var(--pad-fg-primary);
}
.pad-agentrow__name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pad-agentrow__tag {
  font-size: 9px;
  padding: 1px 5px;
  border-radius: 3px;
  font-weight: var(--pad-fw-medium);
  text-transform: uppercase;
  letter-spacing: 0.3px;
}
.pad-agentrow__tag.is-main {
  background: var(--pad-bg-success, rgba(34,197,94,0.15));
  color: var(--pad-fg-success, #22c55e);
}
.pad-agentrow__tag.is-sub {
  background: var(--pad-bg-muted, rgba(0,0,0,0.04));
  color: var(--pad-fg-tertiary);
}

/* Collapsed sidebar — hide label, center icons */
:global(.pad-sidebar.is-collapsed) .pad-funcrow,
:global(.pad-sidebar.is-collapsed) .pad-newtask,
:global(.pad-sidebar.is-collapsed) .pad-agentrow {
  justify-content: center;
  padding: 0;
}
:global(.pad-sidebar.is-collapsed) .pad-funcnav__label,
:global(.pad-sidebar.is-collapsed) .pad-agentgroup__label,
:global(.pad-sidebar.is-collapsed) .pad-agentrow__tag,
:global(.pad-sidebar.is-collapsed) .pad-agentgroup__count {
  display: none;
}
</style>
