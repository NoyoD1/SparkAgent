<script setup lang="ts">
/**
 * v0.4.5 SlashTab — 设置面板 tab
 *
 * 走 Pi SDK 0.84.2 slash-commands.ts 的 BUILTIN_SLASH_COMMANDS (21 个) + 自定义 command
 * 数据从 sidecar 启动时 emit 的 slash_snapshot 拿 (跟 skills_snapshot 同 pattern).
 *
 * source 分类:
 *   - 'builtin' (21 个 Pi SDK 内置, 走 Pi CLI 内部, 不支持 RPC 触发, UI 灰显)
 *   - 'custom' (v0.4.5c: .pi/commands/<name>.md, 可以 RPC 触发)
 *   - 'extension' / 'prompt' / 'skill' (Pi SDK extension 系统)
 */
import { computed } from 'vue';
import { storeToRefs } from 'pinia';
import { Terminal, Info } from 'lucide-vue-next';
import { useSlashStore } from '@/stores/slash';

const slashStore = useSlashStore();
const { commands, hasSnapshot } = storeToRefs(slashStore);

const builtinCommands = computed(() => commands.value.filter((c) => c.source === 'builtin'));
const customCommands = computed(() => commands.value.filter((c) => c.source === 'custom'));
const otherCommands = computed(() => commands.value.filter((c) => c.source !== 'builtin' && c.source !== 'custom'));
</script>

<template>
  <div class="pad-slashtab">
    <div class="pad-slashtab__header">
      <h2 class="pad-slashtab__title">Slash commands</h2>
      <p class="pad-slashtab__subtitle">
        管理 Pi SDK 启用的 slash commands (走 <code>BUILTIN_SLASH_COMMANDS</code> +
        <code>.pi/commands/</code> 自定义). 在 Composer 输入 <code>/</code> 触发.
      </p>
    </div>

    <div class="pad-slashtab__card">
      <div class="pad-slashtab__card-head">
        <Terminal :size="14" :stroke-width="1.75" />
        <span class="pad-slashtab__card-title">
          {{ commands.length }} commands 加载
          <span v-if="hasSnapshot" class="pad-slashtab__count">
            · {{ builtinCommands.length }} 内置 + {{ customCommands.length }} 自定义 + {{ otherCommands.length }} 扩展
          </span>
        </span>
      </div>

      <div v-if="!hasSnapshot" class="pad-slashtab__empty">
        <Terminal :size="20" :stroke-width="1.5" />
        <div class="pad-slashtab__empty-title">⏳ 等待 sidecar 加载 slash commands...</div>
        <div class="pad-slashtab__empty-desc">
          sidecar 启动时会 emit <code>slash_snapshot</code> (走 <code>chat:event</code> channel).
          如果一直不显示, 检查 sidecar stderr 是否有报错.
        </div>
      </div>

      <ul v-else-if="commands.length === 0" class="pad-slashtab__list">
        <li class="pad-slashtab__empty">
          <span>暂无任何 slash command</span>
        </li>
      </ul>

      <ul v-else class="pad-slashtab__list">
        <!-- 内置 commands (21 个 Pi SDK 内置) — 走 Pi CLI 内部, 不可 RPC 触发 -->
        <li v-if="builtinCommands.length > 0" class="pad-slashtab__group-label">
          内置 (Pi SDK BUILTIN_SLASH_COMMANDS)
        </li>
        <li v-for="cmd in builtinCommands" :key="`builtin-${cmd.name}`" class="pad-slashtab__item is-builtin">
          <div class="pad-slashtab__item-body">
            <div class="pad-slashtab__item-name">
              <code>/{{ cmd.name }}</code>
              <span v-if="cmd.argumentHint" class="pad-slashtab__hint">{{ cmd.argumentHint }}</span>
              <span class="pad-slashtab__tag pad-slashtab__tag--builtin">Pi CLI 内部</span>
            </div>
            <div class="pad-slashtab__item-desc">{{ cmd.description }}</div>
          </div>
        </li>

        <!-- 自定义 commands (.pi/commands/*.md, v0.4.5c) -->
        <li v-if="customCommands.length > 0" class="pad-slashtab__group-label">
          自定义 (.pi/commands/*.md, v0.4.5c)
        </li>
        <li v-for="cmd in customCommands" :key="`custom-${cmd.name}`" class="pad-slashtab__item">
          <div class="pad-slashtab__item-body">
            <div class="pad-slashtab__item-name">
              <code>/{{ cmd.name }}</code>
              <span v-if="cmd.argumentHint" class="pad-slashtab__hint">{{ cmd.argumentHint }}</span>
              <span class="pad-slashtab__tag pad-slashtab__tag--custom">custom</span>
            </div>
            <div class="pad-slashtab__item-desc">{{ cmd.description }}</div>
          </div>
        </li>

        <!-- Extension / prompt / skill 来源 -->
        <li v-if="otherCommands.length > 0" class="pad-slashtab__group-label">
          扩展 / 提示词 / 技能
        </li>
        <li v-for="cmd in otherCommands" :key="`other-${cmd.name}`" class="pad-slashtab__item">
          <div class="pad-slashtab__item-body">
            <div class="pad-slashtab__item-name">
              <code>/{{ cmd.name }}</code>
              <span v-if="cmd.argumentHint" class="pad-slashtab__hint">{{ cmd.argumentHint }}</span>
              <span class="pad-slashtab__tag" :class="`pad-slashtab__tag--${cmd.source}`">{{ cmd.source }}</span>
            </div>
            <div class="pad-slashtab__item-desc">{{ cmd.description }}</div>
          </div>
        </li>
      </ul>
    </div>

    <div class="pad-slashtab__hint">
      <Info :size="12" :stroke-width="1.75" />
      <span>
        v0.4.5 scope: Pi SDK 内置 21 个 commands UI 暴露 (不可 RPC 触发, 走 Pi CLI 内部).
        v0.4.5c/d 加自定义 <code>.pi/commands/*.md</code> + Composer <code>/</code> 触发.
      </span>
    </div>
  </div>
</template>

<style scoped>
.pad-slashtab { /* 跟 SkillsTab 一致 */ }
.pad-slashtab__header { padding: 24px 0 16px 0; }
.pad-slashtab__title { font-size: var(--pad-fs-22); font-weight: var(--pad-fw-semibold); color: var(--pad-fg-primary); margin: 0 0 4px 0; }
.pad-slashtab__subtitle { font-size: var(--pad-fs-13); color: var(--pad-fg-secondary); margin: 0; line-height: 1.5; }
.pad-slashtab__subtitle code { font-family: var(--pad-font-mono); font-size: 11px; background: var(--pad-bg-muted, rgba(0,0,0,0.04)); padding: 1px 4px; border-radius: 2px; }
.pad-slashtab__card { background: var(--pad-bg-base, #fff); border: 1px solid var(--pad-border-subtle, #e0e0e0); border-radius: var(--pad-radius-md, 8px); overflow: hidden; }
.pad-slashtab__card-head { display: flex; align-items: center; gap: 8px; padding: 10px 14px; background: var(--pad-bg-muted, rgba(0,0,0,0.02)); border-bottom: 1px solid var(--pad-border-subtle, #e0e0e0); color: var(--pad-fg-secondary); }
.pad-slashtab__card-title { font-size: var(--pad-fs-13); font-weight: var(--pad-fw-medium); }
.pad-slashtab__count { color: var(--pad-fg-tertiary); font-weight: normal; }
.pad-slashtab__empty { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 40px 20px; gap: 8px; color: var(--pad-fg-tertiary); }
.pad-slashtab__empty-title { font-size: var(--pad-fs-14); color: var(--pad-fg-secondary); }
.pad-slashtab__empty-desc { font-size: var(--pad-fs-12); color: var(--pad-fg-tertiary); text-align: center; line-height: 1.5; }
.pad-slashtab__empty-desc code { font-family: var(--pad-font-mono); font-size: 11px; background: var(--pad-bg-muted, rgba(0,0,0,0.04)); padding: 1px 4px; border-radius: 2px; }
.pad-slashtab__list { list-style: none; padding: 0; margin: 0; }
.pad-slashtab__group-label { padding: 8px 14px 4px; font-size: var(--pad-fs-11); font-weight: var(--pad-fw-medium); color: var(--pad-fg-tertiary); text-transform: uppercase; letter-spacing: 0.5px; }
.pad-slashtab__item { display: flex; align-items: center; gap: 8px; padding: 8px 14px; border-top: 1px solid var(--pad-border-subtle, rgba(0,0,0,0.04)); }
.pad-slashtab__item.is-builtin { opacity: 0.6; }
.pad-slashtab__item-body { flex: 1; min-width: 0; }
.pad-slashtab__item-name { display: flex; align-items: center; gap: 8px; }
.pad-slashtab__item-name code { font-family: var(--pad-font-mono); font-size: var(--pad-fs-13); color: var(--pad-fg-primary); font-weight: var(--pad-fw-medium); }
.pad-slashtab__hint { font-family: var(--pad-font-mono); font-size: 10px; color: var(--pad-fg-tertiary); background: var(--pad-bg-muted, rgba(0,0,0,0.04)); padding: 1px 6px; border-radius: 3px; }
.pad-slashtab__item-desc { font-size: var(--pad-fs-12); color: var(--pad-fg-secondary); margin-top: 2px; }
.pad-slashtab__tag { font-size: 9px; font-weight: var(--pad-fw-medium); padding: 1px 6px; border-radius: 3px; text-transform: uppercase; letter-spacing: 0.3px; }
.pad-slashtab__tag--builtin { background: var(--pad-bg-muted, rgba(0,0,0,0.06)); color: var(--pad-fg-tertiary); }
.pad-slashtab__tag--custom { background: var(--pad-bg-accent-soft, rgba(99,102,241,0.08)); color: var(--pad-fg-accent, #6366f1); }
.pad-slashtab__tag--extension { background: var(--pad-bg-success-soft, rgba(34,197,94,0.08)); color: var(--pad-fg-success, #22c55e); }
.pad-slashtab__tag--prompt { background: var(--pad-bg-warning-soft, rgba(217,119,6,0.08)); color: var(--pad-fg-warning, #d97706); }
.pad-slashtab__tag--skill { background: var(--pad-bg-accent-soft, rgba(99,102,241,0.08)); color: var(--pad-fg-accent, #6366f1); }
.pad-slashtab__hint { display: flex; align-items: center; gap: 6px; padding: 12px 16px; color: var(--pad-fg-tertiary); font-size: 11px; line-height: 1.5; }
.pad-slashtab__hint code { font-family: var(--pad-font-mono); font-size: 10px; background: var(--pad-bg-muted, rgba(0,0,0,0.04)); padding: 1px 4px; border-radius: 2px; }
</style>
