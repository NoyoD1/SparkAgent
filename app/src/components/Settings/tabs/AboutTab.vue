<script setup lang="ts">
/**
 * AboutTab — 关于 / 版本信息
 * 显示 Pi Agent App 版本 + Pi SDK 版本 + 仓库链接
 */
import { computed } from 'vue';
import { Info, Github, ExternalLink } from 'lucide-vue-next';

const version = '0.1.0';
const buildDate = '2026-08-15';

// Pi SDK 版本从 window 注入 (vite define) — 简化: 写死
const piSdkVersion = '0.84.2';
</script>

<template>
  <div class="pad-about">
    <div class="pad-about__brand">
      <div class="pad-about__logo">π</div>
      <div>
        <h3 class="pad-about__title">Pi Agent App</h3>
        <p class="pad-about__ver">v{{ version }} · {{ buildDate }}</p>
      </div>
    </div>

    <div class="pad-about__card">
      <Info :size="14" :stroke-width="1.75" />
      <div>
        <div class="pad-about__card-title">关于</div>
        <div class="pad-about__card-desc">
          Web / 桌面通用 AI agent 客户端, 包装
          <a href="https://github.com/earendil-works/pi" target="_blank" rel="noopener" class="pad-about__link">
            earendil-works/pi
            <ExternalLink :size="11" :stroke-width="1.75" />
          </a>
          (v{{ piSdkVersion }}). BYOK 模型 — 你自己的 API key, server 内存 only.
        </div>
      </div>
    </div>

    <div class="pad-about__card">
      <Github :size="14" :stroke-width="1.75" />
      <div>
        <div class="pad-about__card-title">技术栈</div>
        <div class="pad-about__card-desc">
          Vite + Vue 3 + TypeScript + Pinia · Hono + ws · Pi SDK · lucide-vue-next
        </div>
      </div>
    </div>

    <div class="pad-about__card pad-about__card--muted">
      <div>
        <div class="pad-about__card-title">致谢</div>
        <div class="pad-about__card-desc">
          Design tokens 来自 Pi-Agent-Design 包 (321 个 --pad-* 变量). Pi SDK 由 mitsuhiko (Armin Ronacher) 维护.
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pad-about {
  display: flex;
  flex-direction: column;
  gap: var(--pad-sp-3);
}

.pad-about__brand {
  display: flex;
  align-items: center;
  gap: var(--pad-sp-3);
  padding-bottom: var(--pad-sp-3);
  border-bottom: 1px solid var(--pad-border);
}
.pad-about__logo {
  width: 40px;
  height: 40px;
  border-radius: var(--pad-radius-md);
  background: var(--pad-accent);
  color: var(--pad-fg-inverse);
  font-size: 24px;
  font-weight: var(--pad-fw-semibold);
  display: flex;
  align-items: center;
  justify-content: center;
}
.pad-about__title {
  font-size: var(--pad-fs-15);
  font-weight: var(--pad-fw-semibold);
  color: var(--pad-fg-primary);
  margin: 0;
}
.pad-about__ver {
  font-size: var(--pad-fs-12);
  color: var(--pad-fg-tertiary);
  margin: 2px 0 0 0;
}

.pad-about__card {
  display: flex;
  align-items: flex-start;
  gap: var(--pad-sp-2);
  padding: var(--pad-sp-3);
  background: var(--pad-bg-active);
  border-radius: var(--pad-radius-md);
  font-size: var(--pad-fs-12);
  line-height: var(--pad-lh-base);
  color: var(--pad-fg-secondary);
}
.pad-about__card--muted {
  background: transparent;
  border: 1px solid var(--pad-border);
}
.pad-about__card-title {
  font-size: var(--pad-fs-13);
  font-weight: var(--pad-fw-medium);
  color: var(--pad-fg-primary);
  margin-bottom: 2px;
}
.pad-about__card-desc {
  color: var(--pad-fg-secondary);
}
.pad-about__link {
  color: var(--pad-accent);
  text-decoration: none;
  display: inline-flex;
  align-items: center;
  gap: 2px;
}
.pad-about__link:hover {
  text-decoration: underline;
}
</style>
