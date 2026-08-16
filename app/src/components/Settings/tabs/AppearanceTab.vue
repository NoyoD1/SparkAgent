<script setup lang="ts">
/**
 * AppearanceTab — 外观设置
 * v0.3.8.16: 主题切换 (light / dark / auto)
 * 未来: 强调色 / 字体大小 / UI 紧凑度
 */
import { computed } from 'vue';
import { Sun, Moon, Monitor, Palette } from 'lucide-vue-next';
import { useUiStore, type ThemeMode } from '@/stores/ui';

const ui = useUiStore();

interface ThemeOption {
  mode: ThemeMode;
  label: string;
  desc: string;
  icon: typeof Sun;
}

const THEME_OPTIONS: ThemeOption[] = [
  { mode: 'light', label: '浅色', desc: '明亮界面, 适合白天使用', icon: Sun },
  { mode: 'dark',  label: '深色', desc: '暗色界面, 适合长时间使用或夜间', icon: Moon },
  { mode: 'auto',  label: '跟随系统', desc: '根据操作系统设置自动切换', icon: Monitor },
];

const currentMode = computed(() => ui.themeMode);
function pickTheme(mode: ThemeMode) {
  ui.setThemeMode(mode);
}
</script>

<template>
  <div class="pad-appearance">
    <header class="pad-appearance__header">
      <Palette :size="20" :stroke-width="1.75" class="pad-appearance__header-icon" />
      <div>
        <h3 class="pad-appearance__title">外观</h3>
        <p class="pad-appearance__desc">主题, 强调色, 字体大小等 (主题已上线, 其他即将推出)</p>
      </div>
    </header>

    <!-- 主题选择 -->
    <section class="pad-appearance__section">
      <h4 class="pad-appearance__section-title">主题</h4>
      <div class="pad-appearance__theme-grid">
        <button
          v-for="opt in THEME_OPTIONS"
          :key="opt.mode"
          class="pad-appearance__theme-card"
          :class="{ 'is-selected': currentMode === opt.mode }"
          type="button"
          @click="pickTheme(opt.mode)"
        >
          <div class="pad-appearance__theme-icon">
            <component :is="opt.icon" :size="20" :stroke-width="1.75" />
          </div>
          <div class="pad-appearance__theme-label">{{ opt.label }}</div>
          <div class="pad-appearance__theme-desc">{{ opt.desc }}</div>
          <div v-if="currentMode === opt.mode" class="pad-appearance__theme-check">✓</div>
        </button>
      </div>
    </section>

    <!-- 强调色 (即将推出) — v0.3.8.19: 换成 monochrome 灰阶, 跟 minimalist 主题一致 -->
    <section class="pad-appearance__section is-disabled">
      <h4 class="pad-appearance__section-title">强调色 <span class="pad-appearance__badge">即将推出</span></h4>
      <div class="pad-appearance__swatches">
        <div class="pad-appearance__swatch is-active" style="background: #18181b"></div>
        <div class="pad-appearance__swatch" style="background: #52525b"></div>
        <div class="pad-appearance__swatch" style="background: #a1a1aa"></div>
        <div class="pad-appearance__swatch" style="background: #d4d4d8"></div>
        <div class="pad-appearance__swatch" style="background: #f4f4f5"></div>
      </div>
    </section>

    <!-- 字体大小 (即将推出) -->
    <section class="pad-appearance__section is-disabled">
      <h4 class="pad-appearance__section-title">UI 紧凑度 <span class="pad-appearance__badge">即将推出</span></h4>
      <div class="pad-appearance__density-row">
        <button class="pad-appearance__density-opt is-active" type="button">紧凑</button>
        <button class="pad-appearance__density-opt" type="button">默认</button>
        <button class="pad-appearance__density-opt" type="button">舒适</button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.pad-appearance {
  display: flex;
  flex-direction: column;
  gap: var(--pad-sp-6);
  padding: var(--pad-sp-6);
  max-width: 640px;
  margin: 0 auto;
}

.pad-appearance__header {
  display: flex;
  align-items: flex-start;
  gap: var(--pad-sp-3);
}
.pad-appearance__header-icon {
  color: var(--pad-fg-tertiary);
  margin-top: 2px;
}
.pad-appearance__title {
  font-size: var(--pad-fs-16);
  font-weight: var(--pad-fw-semibold);
  color: var(--pad-fg-primary);
  margin: 0 0 4px 0;
}
.pad-appearance__desc {
  font-size: var(--pad-fs-13);
  color: var(--pad-fg-tertiary);
  margin: 0;
}

.pad-appearance__section {
  display: flex;
  flex-direction: column;
  gap: var(--pad-sp-3);
}
.pad-appearance__section.is-disabled {
  opacity: 0.5;
  pointer-events: none;
}
.pad-appearance__section-title {
  font-size: var(--pad-fs-13);
  font-weight: var(--pad-fw-semibold);
  color: var(--pad-fg-primary);
  margin: 0;
  display: flex;
  align-items: center;
  gap: var(--pad-sp-2);
}
.pad-appearance__badge {
  font-size: var(--pad-fs-10);
  font-weight: var(--pad-fw-medium);
  color: var(--pad-fg-tertiary);
  background: var(--pad-bg-hover);
  padding: 1px 8px;
  border-radius: 999px;
}

.pad-appearance__theme-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--pad-sp-3);
}
.pad-appearance__theme-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 16px;
  background: var(--pad-card);
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-lg);
  cursor: pointer;
  text-align: left;
  transition:
    border-color var(--pad-dur-fast) ease,
    background var(--pad-dur-fast) ease,
    transform var(--pad-dur-fast) ease;
  font-family: inherit;
}
.pad-appearance__theme-card:hover {
  border-color: var(--pad-fg-tertiary);
  transform: translateY(-1px);
}
.pad-appearance__theme-card.is-selected {
  border-color: var(--pad-accent);
  background: var(--pad-accent-soft);
}
.pad-appearance__theme-icon {
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--pad-bg-hover);
  border-radius: var(--pad-radius-md);
  color: var(--pad-fg-secondary);
}
.pad-appearance__theme-card.is-selected .pad-appearance__theme-icon {
  background: var(--pad-card);
  color: var(--pad-accent);
}
.pad-appearance__theme-label {
  font-size: var(--pad-fs-14);
  font-weight: var(--pad-fw-semibold);
  color: var(--pad-fg-primary);
}
.pad-appearance__theme-desc {
  font-size: var(--pad-fs-12);
  color: var(--pad-fg-tertiary);
  line-height: var(--pad-lh-base);
}
.pad-appearance__theme-check {
  position: absolute;
  top: 12px;
  right: 12px;
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--pad-accent);
  color: var(--pad-card);
  border-radius: 50%;
  font-size: 12px;
  font-weight: var(--pad-fw-bold);
}

.pad-appearance__swatches {
  display: flex;
  gap: var(--pad-sp-2);
}
.pad-appearance__swatch {
  width: 36px;
  height: 36px;
  border-radius: var(--pad-radius-md);
  cursor: pointer;
  border: 2px solid transparent;
  transition: border-color var(--pad-dur-fast) ease, transform var(--pad-dur-fast) ease;
}
.pad-appearance__swatch.is-active {
  border-color: var(--pad-fg-primary);
}
.pad-appearance__swatch:hover {
  transform: scale(1.1);
}

.pad-appearance__density-row {
  display: flex;
  gap: var(--pad-sp-2);
}
.pad-appearance__density-opt {
  padding: 6px 14px;
  background: var(--pad-card);
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-md);
  color: var(--pad-fg-secondary);
  font-size: var(--pad-fs-13);
  cursor: pointer;
  font-family: inherit;
}
.pad-appearance__density-opt.is-active {
  background: var(--pad-accent);
  color: var(--pad-accent-foreground);
  border-color: var(--pad-accent);
}
</style>
