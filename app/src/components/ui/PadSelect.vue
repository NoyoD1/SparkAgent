<script setup lang="ts" generic="T extends string | number">
/**
 * PadSelect — 自定义下拉, 走 --pad-* design tokens, 不依赖原生 <select>
 *
 * Usage:
 *   <PadSelect v-model="type" :options="PROVIDER_OPTIONS" option-label="label" option-value="id" />
 *
 * 特性:
 * - 搜索: 支持 (可选, :searchable="true")
 * - 分组: 支持 (option 里有 group 字段)
 * - 键盘: ↑↓ 上下, Enter 选, Esc 关
 * - 弹层: 默认向下, 接近底部自动 flip 向上
 * - 点击外部关闭
 */
import { ref, computed, nextTick, onMounted, onBeforeUnmount } from 'vue';
import { ChevronDown, Check, Search } from 'lucide-vue-next';

export interface PadSelectOption<T> {
  value: T;
  label: string;
  description?: string;
  group?: string;
  disabled?: boolean;
}

const props = withDefaults(defineProps<{
  modelValue: T | null;
  options: PadSelectOption<T>[];
  optionLabel?: keyof PadSelectOption<T>;
  optionValue?: keyof PadSelectOption<T>;
  placeholder?: string;
  disabled?: boolean;
  /** 输入框可搜索, 过滤选项 */
  searchable?: boolean;
  /** 错误状态, 加红边 */
  invalid?: boolean;
  /** label 在按钮上方的位置 (跟 Form 配套) */
  size?: 'sm' | 'md';
}>(), {
  placeholder: '请选择',
  disabled: false,
  searchable: false,
  invalid: false,
  size: 'md',
});

const emit = defineEmits<{
  'update:modelValue': [value: T];
  change: [value: T];
}>();

const open = ref(false);
const triggerRef = ref<HTMLButtonElement | null>(null);
const menuRef = ref<HTMLDivElement | null>(null);
const searchQuery = ref('');
const activeIndex = ref(0);
const flipUp = ref(false);
const windowHeight = ref(typeof window !== 'undefined' ? window.innerHeight : 0);
if (typeof window !== 'undefined') {
  window.addEventListener('resize', () => { windowHeight.value = window.innerHeight; });
}

const filteredOptions = computed(() => {
  if (!props.searchable || !searchQuery.value) return props.options;
  const q = searchQuery.value.toLowerCase();
  return props.options.filter((o) =>
    o.label.toLowerCase().includes(q) || o.description?.toLowerCase().includes(q),
  );
});

const groupedOptions = computed(() => {
  const groups = new Map<string, PadSelectOption<T>[]>();
  for (const opt of filteredOptions.value) {
    const g = opt.group ?? '';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(opt);
  }
  return Array.from(groups.entries()).map(([label, opts]) => ({ label, opts }));
});

const selectedOption = computed(() =>
  props.options.find((o) => o.value === props.modelValue) ?? null,
);

function toggle() {
  if (props.disabled) return;
  open.value = !open.value;
  if (open.value) {
    searchQuery.value = '';
    activeIndex.value = Math.max(
      0,
      filteredOptions.value.findIndex((o) => o.value === props.modelValue),
    );
    nextTick(calcFlip);
  }
}

function close() {
  open.value = false;
  searchQuery.value = '';
}

function pick(opt: PadSelectOption<T>) {
  if (opt.disabled) return;
  emit('update:modelValue', opt.value);
  emit('change', opt.value);
  close();
  triggerRef.value?.focus();
}

function onKeydown(e: KeyboardEvent) {
  if (props.disabled) return;
  if (!open.value) {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      toggle();
    }
    return;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    close();
    triggerRef.value?.focus();
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    const max = filteredOptions.value.length - 1;
    activeIndex.value = Math.min(max, activeIndex.value + 1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    activeIndex.value = Math.max(0, activeIndex.value - 1);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const opt = filteredOptions.value[activeIndex.value];
    if (opt) pick(opt);
  } else if (e.key === 'Home') {
    e.preventDefault();
    activeIndex.value = 0;
  } else if (e.key === 'End') {
    e.preventDefault();
    activeIndex.value = filteredOptions.value.length - 1;
  }
}

function calcFlip() {
  if (!triggerRef.value) return;
  const rect = triggerRef.value.getBoundingClientRect();
  const menuHeight = Math.min(filteredOptions.value.length * 36 + 16, 320);
  const spaceBelow = window.innerHeight - rect.bottom;
  flipUp.value = spaceBelow < menuHeight + 8 && rect.top > menuHeight + 8;
}

// 全局点击关闭
function onDocClick(e: MouseEvent) {
  if (!open.value) return;
  const target = e.target as Node;
  if (
    !triggerRef.value?.contains(target) &&
    !menuRef.value?.contains(target)
  ) {
    close();
  }
}

onMounted(() => document.addEventListener('mousedown', onDocClick));
onBeforeUnmount(() => document.removeEventListener('mousedown', onDocClick));
</script>

<template>
  <div class="pad-select" :class="{ 'is-open': open, 'is-disabled': disabled, 'is-invalid': invalid, [`is-${size}`]: true }">
    <button
      ref="triggerRef"
      type="button"
      class="pad-select__trigger"
      :disabled="disabled"
      :aria-expanded="open"
      :aria-haspopup="true"
      @click="toggle"
      @keydown="onKeydown"
    >
      <span class="pad-select__label">
        <span v-if="selectedOption">{{ selectedOption.label }}</span>
        <span v-else class="pad-select__placeholder">{{ placeholder }}</span>
      </span>
      <ChevronDown
        :size="14"
        :stroke-width="1.75"
        :class="['pad-select__chev', { 'is-flipped': open }]"
      />
    </button>

    <Teleport to="body">
      <div
        v-if="open"
        ref="menuRef"
        class="pad-select__menu"
        :class="{ 'is-flipped': flipUp }"
        :style="triggerRef ? {
          left: triggerRef.getBoundingClientRect().left + 'px',
          width: triggerRef.getBoundingClientRect().width + 'px',
          top: (flipUp ? triggerRef.getBoundingClientRect().top : triggerRef.getBoundingClientRect().bottom + 4) + 'px',
          bottom: flipUp ? (windowHeight - triggerRef.getBoundingClientRect().top + 4) + 'px' : 'auto',
        } : {}"
        role="listbox"
      >
        <div v-if="searchable" class="pad-select__search">
          <Search :size="14" :stroke-width="1.75" />
          <input
            v-model="searchQuery"
            class="pad-select__search-input"
            type="text"
            :placeholder="`搜索 ${options.length} 项...`"
            @keydown.stop="onKeydown"
          />
        </div>
        <div class="pad-select__list">
          <template v-for="group in groupedOptions" :key="group.label || '_'">
            <div v-if="group.label" class="pad-select__group-label">{{ group.label }}</div>
            <button
              v-for="opt in group.opts"
              :key="String(opt.value)"
              type="button"
              class="pad-select__item"
              :class="{
                'is-active': opt.value === modelValue,
                'is-highlighted': filteredOptions[activeIndex]?.value === opt.value,
                'is-disabled': opt.disabled,
              }"
              :disabled="opt.disabled"
              @click="pick(opt)"
              @mouseenter="activeIndex = filteredOptions.findIndex((o) => o.value === opt.value)"
            >
              <span class="pad-select__item-body">
                <span class="pad-select__item-label">{{ opt.label }}</span>
                <span v-if="opt.description" class="pad-select__item-desc">{{ opt.description }}</span>
              </span>
              <Check v-if="opt.value === modelValue" :size="14" :stroke-width="2" class="pad-select__item-check" />
            </button>
          </template>
          <div v-if="filteredOptions.length === 0" class="pad-select__empty">
            没有匹配的选项
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.pad-select {
  position: relative;
  display: inline-block;
  width: 100%;
}

.pad-select__trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  gap: var(--pad-sp-2);
  background: var(--pad-bg-input);
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-md);
  color: var(--pad-fg-primary);
  font-size: var(--pad-fs-13);
  font-family: inherit;
  cursor: pointer;
  transition: border-color var(--pad-dur-fast) ease, box-shadow var(--pad-dur-fast) ease;
  user-select: none;
}
.is-md .pad-select__trigger {
  height: 32px;
  padding: 0 var(--pad-sp-2);
}
.is-sm .pad-select__trigger {
  height: 28px;
  padding: 0 var(--pad-sp-2);
  font-size: var(--pad-fs-12);
}
.pad-select__trigger:hover:not(:disabled) {
  border-color: var(--pad-fg-tertiary);
}
.pad-select__trigger:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.pad-select.is-open .pad-select__trigger {
  border-color: var(--pad-accent);
  box-shadow: 0 0 0 3px var(--pad-accent-soft);
}
.pad-select.is-invalid .pad-select__trigger {
  border-color: var(--pad-danger);
}

.pad-select__label {
  flex: 1;
  text-align: left;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pad-select__placeholder {
  color: var(--pad-fg-tertiary);
}
.pad-select__chev {
  color: var(--pad-fg-tertiary);
  flex-shrink: 0;
  transition: transform var(--pad-dur-base) var(--pad-ease-in-out);
}
.pad-select__chev.is-flipped {
  transform: rotate(180deg);
}
</style>

<style>
/* 弹层用 unscoped, 因为 Teleport 到 body
   v3 redesign: hover 跟 active 视觉对比拉开, 跟 design tokens 调性统一
   - 弹层: 12px 圆角 + 1px border + 0 8px 24px shadow (跟 design system 阴影一致)
   - item: 36px 高, 8/12 padding, hover 浅灰底, active 浅紫底 + 左侧 2px accent
   - group label: 上方分组用 11px 小字 + 200ms 间距
   - checkmark: 紫色, 跟 active 一起增强 selected 视觉
*/
.pad-select__menu {
  position: fixed;
  z-index: 300;
  max-height: 320px;
  display: flex;
  flex-direction: column;
  background: var(--pad-popover);
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-lg);
  box-shadow: var(--pad-shadow-popover-lg);
  overflow: hidden;
  animation: pad-select-fade-in var(--pad-dur-base) var(--pad-ease-out-soft);
}
@keyframes pad-select-fade-in {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: translateY(0); }
}

.pad-select__search {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--pad-divider);
  color: var(--pad-fg-tertiary);
}
.pad-select__search-input {
  flex: 1;
  background: transparent;
  border: none;
  outline: none;
  font-size: var(--pad-fs-13);
  color: var(--pad-fg-primary);
  font-family: inherit;
}
.pad-select__search-input::placeholder {
  color: var(--pad-fg-tertiary);
}

.pad-select__list {
  flex: 1;
  overflow-y: auto;
  padding: 4px;
}

.pad-select__group-label {
  padding: 10px 12px 4px;
  font-size: var(--pad-fs-11);
  color: var(--pad-fg-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  font-weight: var(--pad-fw-medium);
}

.pad-select__item {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  gap: var(--pad-sp-2);
  min-height: 36px;
  padding: 8px 12px 8px 14px; /* 留 2px 给左侧 active 边条 */
  background: transparent;
  border: none;
  border-radius: var(--pad-radius-md);
  color: var(--pad-fg-primary);
  font-size: var(--pad-fs-13);
  line-height: 1.4;
  text-align: left;
  cursor: pointer;
  transition: background var(--pad-dur-fast) ease;
  font-family: inherit;
}
/* hover 跟 keyboard highlight: 浅一档灰, 不抢戏
 * v0.3.8.18: 之前用 var(--pad-bg-200) 直接拿 primitive, dark 模式没覆盖
 * (是 #f5f5f5 浅灰, 在 dark bg 上刺眼). 改用 --pad-bg-hover (semantic role),
 * dark 下是 #2a2f3a 跟菜单/列表 hover 一致. */
.pad-select__item:hover:not(.is-disabled):not(.is-active) {
  background: var(--pad-bg-hover);
}
.pad-select__item.is-highlighted:not(.is-disabled):not(.is-active) {
  background: var(--pad-bg-hover);
}
/* active (selected): 浅紫底 + 左侧 2px accent + 略重字 */
.pad-select__item.is-active {
  background: var(--pad-accent-soft);
  color: var(--pad-fg-primary);
  font-weight: var(--pad-fw-medium);
}
.pad-select__item.is-active::before {
  content: '';
  position: absolute;
  left: 4px;
  top: 8px;
  bottom: 8px;
  width: 2px;
  border-radius: 1px;
  background: var(--pad-accent);
}
.pad-select__item.is-disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.pad-select__item-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}
.pad-select__item-label {
  font-weight: inherit;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pad-select__item-desc {
  font-size: var(--pad-fs-11);
  color: var(--pad-fg-tertiary);
  font-weight: var(--pad-fw-regular);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pad-select__item.is-active .pad-select__item-desc {
  color: var(--pad-fg-secondary);
}
.pad-select__item-check {
  color: var(--pad-accent);
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.pad-select__empty {
  padding: var(--pad-sp-3);
  font-size: var(--pad-fs-12);
  color: var(--pad-fg-tertiary);
  text-align: center;
}
</style>
