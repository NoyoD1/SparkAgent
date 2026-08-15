<script setup lang="ts">
/**
 * AddProviderForm — Phase 3 Tauri 流程
 *
 * 流程: 类型 + (openai-compatible) baseUrl + API Key (存 OS keychain) + 创建 + 拉取模型
 *   - API key 不存 localStorage, 不进 WS, 永不出现在前端 (除了输入框输入瞬间)
 *   - 走 piTauri.saveApiKey(providerId, apiKey) 存到 Windows Credential Manager
 *   - 拉模型走 piTauri.fetchProviderModels(providerId, baseUrl), Rust 从 keychain 取 key
 */
import { ref, computed } from 'vue';
import { Plus, Server, Globe, Sparkles, AlertCircle, Loader2, Check, ArrowLeft, KeyRound } from 'lucide-vue-next';
import { useConfigStore, PROVIDER_OPTIONS, type ProviderType } from '@/stores/config';
import { fetchProviderModels } from '@/lib/providers-api';
import { piTauri } from '@/lib/tauri';
import PadSelect, { type PadSelectOption } from '@/components/ui/PadSelect.vue';

const emit = defineEmits<{
  close: [];
  added: [id: string];
}>();

const config = useConfigStore();

const type = ref<ProviderType>('anthropic');
const label = ref<string>('');
const baseUrl = ref<string>('');
const apiKey = ref<string>('');
const submitState = ref<'idle' | 'submitting' | 'ok' | 'fail'>('idle');
const submitMessage = ref<string>('');

const needsBaseUrl = computed(() =>
  PROVIDER_OPTIONS.find((o) => o.id === type.value)?.needsBaseUrl ?? false,
);
const needsApiKey = computed(() => true); // 全部 provider 都需要 key

const typeOptions = computed<PadSelectOption<ProviderType>[]>(() =>
  PROVIDER_OPTIONS.map((o) => ({
    value: o.id,
    label: o.label,
    description: o.needsBaseUrl
      ? '需要 baseUrl + API Key, key 存 OS keychain'
      : '需要 API Key, key 存 OS keychain (Phase 3 内置 provider LLM 调 待补)',
  })),
);

const currentTypeOption = computed(() =>
  typeOptions.value.find((o) => o.value === type.value),
);

async function submit() {
  if (needsBaseUrl.value && !baseUrl.value.trim()) {
    submitState.value = 'fail';
    submitMessage.value = 'OpenAI 兼容需要 baseUrl';
    return;
  }
  if (needsApiKey.value && !apiKey.value.trim()) {
    submitState.value = 'fail';
    submitMessage.value = '需要填 API Key';
    return;
  }
  submitState.value = 'submitting';
  submitMessage.value = '创建 + 存 keychain + 拉取模型…';
  try {
    // 1. 先在 localStorage 建占位 (拿到 providerId, 后面用)
    const provider = config.addProvider({
      type: type.value,
      label: label.value.trim() || undefined,
      baseUrl: needsBaseUrl.value ? baseUrl.value.trim() : undefined,
    });
    // 2. 存 API key 到 keychain
    await piTauri.saveApiKey(provider.id, apiKey.value.trim());
    // 3. 拉取模型
    const result = await fetchProviderModels({
      type: type.value,
      providerId: provider.id,
      baseUrl: needsBaseUrl.value ? baseUrl.value.trim() : undefined,
    });
    if (result.ok && result.models) {
      config.setProviderModels(provider.id, result.models);
      submitState.value = 'ok';
      submitMessage.value = `已创建, key 已存 keychain, 拉到 ${result.models.length} 个模型`;
      setTimeout(() => emit('added', provider.id), 700);
    } else {
      // provider 已建 + key 已存, 只是 fetch 失败 (让用户手动加 model)
      submitState.value = 'ok';
      submitMessage.value = `已创建, key 已存 keychain. 拉模型失败: ${result.error ?? '未知错误'} — 手动加 model id`;
      setTimeout(() => emit('added', provider.id), 1500);
    }
  } catch (e) {
    submitState.value = 'fail';
    submitMessage.value = e instanceof Error ? e.message : String(e);
  }
}

function cancel() {
  emit('close');
}
</script>

<template>
  <div class="pad-addprov">
    <div class="pad-addprov__head">
      <button class="pad-addprov__back" type="button" @click="cancel">
        <ArrowLeft :size="14" :stroke-width="1.75" />
        <span>返回列表</span>
      </button>
      <p class="pad-addprov__sub">选 provider 类型, API key 存 OS keychain (Windows Credential Manager / macOS Keychain / Linux Secret Service)</p>
    </div>

    <div class="pad-addprov__body">
      <div class="pad-addprov__field">
        <label class="pad-addprov__label">
          <Server :size="12" :stroke-width="1.75" /> 类型
        </label>
        <PadSelect
          v-model="type"
          :options="typeOptions"
          placeholder="选 provider 类型"
        />
        <p v-if="currentTypeOption?.description" class="pad-addprov__hint">
          {{ currentTypeOption.description }}
        </p>
      </div>

      <div class="pad-addprov__field">
        <label class="pad-addprov__label">
          <Sparkles :size="12" :stroke-width="1.75" /> 名称
          <span class="pad-addprov__label-hint">(可选, 默认自动)</span>
        </label>
        <input
          v-model="label"
          class="pad-addprov__input"
          type="text"
          :placeholder="`${currentTypeOption?.label ?? 'Provider'} #${config.providers.length + 1}`"
        />
      </div>

      <Transition name="pad-addprov-fade">
        <div v-if="needsBaseUrl" class="pad-addprov__field">
          <label class="pad-addprov__label">
            <Globe :size="12" :stroke-width="1.75" /> Base URL
            <span class="pad-addprov__label-hint">如 https://token.sensenova.cn/v1</span>
          </label>
          <input
            v-model="baseUrl"
            class="pad-addprov__input"
            type="text"
            placeholder="https://your-proxy.com/v1"
          />
        </div>
      </Transition>

      <!-- API Key (Phase 3: 存 OS keychain, 永不出现在前端除了输入瞬间) -->
      <div class="pad-addprov__field">
        <label class="pad-addprov__label">
          <KeyRound :size="12" :stroke-width="1.75" /> API Key
          <span class="pad-addprov__label-hint">存 OS keychain, 不进 localStorage</span>
        </label>
        <input
          v-model="apiKey"
          class="pad-addprov__input pad-addprov__input--key"
          type="password"
          placeholder="sk-..."
          autocomplete="off"
        />
        <p class="pad-addprov__hint">
          key 在前端只活在输入瞬间, 提交后立刻进 keychain, 明文不会再出现.
        </p>
      </div>
    </div>

    <div class="pad-addprov__foot">
      <Transition name="pad-addprov-fade">
        <div
          v-if="submitMessage"
          class="pad-addprov__result"
          :class="{
            'is-ok': submitState === 'ok',
            'is-fail': submitState === 'fail',
            'is-submitting': submitState === 'submitting',
          }"
        >
          <span class="pad-addprov__result-icon">
            <Loader2 v-if="submitState === 'submitting'" :size="12" :stroke-width="1.75" class="is-spinning" />
            <Check v-else-if="submitState === 'ok'" :size="12" :stroke-width="2" />
            <AlertCircle v-else :size="12" :stroke-width="1.75" />
          </span>
          <span class="pad-addprov__result-text">{{ submitMessage }}</span>
        </div>
      </Transition>

      <div class="pad-addprov__foot-actions">
        <button class="pad-addprov__btn" type="button" @click="cancel">取消</button>
        <button
          class="pad-addprov__btn pad-addprov__btn--primary"
          type="button"
          :disabled="submitState === 'submitting'"
          @click="submit"
        >
          <Loader2 v-if="submitState === 'submitting'" :size="14" :stroke-width="1.75" class="is-spinning" />
          <Plus v-else :size="14" :stroke-width="1.75" />
          <span>{{ submitState === 'submitting' ? '创建中' : '创建 + 存 keychain' }}</span>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pad-addprov {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  background: transparent;
  border: none;
  border-radius: 0;
  overflow: hidden;
}
.pad-addprov__head {
  display: flex;
  align-items: center;
  gap: var(--pad-sp-2);
  padding: var(--pad-sp-2) var(--pad-sp-3);
  border-bottom: 1px solid var(--pad-divider);
  flex-shrink: 0;
  flex-wrap: wrap;
}
.pad-addprov__back {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 8px;
  border-radius: var(--pad-radius-sm);
  font-size: var(--pad-fs-12);
  color: var(--pad-fg-secondary);
  background: transparent;
  border: 1px solid transparent;
  cursor: pointer;
  transition: background var(--pad-dur-fast) ease, color var(--pad-dur-fast) ease;
  flex-shrink: 0;
}
.pad-addprov__back:hover {
  background: var(--pad-bg-hover);
  color: var(--pad-fg-primary);
}
.pad-addprov__sub {
  font-size: var(--pad-fs-11);
  color: var(--pad-fg-tertiary);
  margin: 0;
  line-height: 1.3;
  flex: 1;
  min-width: 0;
}
.pad-addprov__body {
  display: flex;
  flex-direction: column;
  gap: var(--pad-sp-3);
  padding: var(--pad-sp-3) var(--pad-sp-4);
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
.pad-addprov__field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.pad-addprov__label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--pad-fs-12);
  font-weight: var(--pad-fw-medium);
  color: var(--pad-fg-secondary);
  flex-wrap: wrap;
}
.pad-addprov__label-hint {
  font-size: var(--pad-fs-11);
  color: var(--pad-fg-tertiary);
  font-weight: var(--pad-fw-regular);
}
.pad-addprov__input {
  height: 32px;
  padding: 0 var(--pad-sp-2);
  background: var(--pad-bg-input);
  border: 1px solid var(--pad-border);
  border-radius: var(--pad-radius-md);
  font-size: var(--pad-fs-13);
  color: var(--pad-fg-primary);
  font-family: inherit;
  outline: none;
  transition: border-color var(--pad-dur-fast) ease, box-shadow var(--pad-dur-fast) ease;
}
.pad-addprov__input:focus {
  border-color: var(--pad-accent);
  box-shadow: 0 0 0 3px var(--pad-accent-soft);
}
.pad-addprov__input--key {
  font-family: var(--pad-font-mono);
  letter-spacing: 0.02em;
}
.pad-addprov__hint {
  font-size: var(--pad-fs-11);
  color: var(--pad-fg-tertiary);
  margin: 0;
  line-height: 1.4;
}
.pad-addprov__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--pad-sp-3);
  padding: var(--pad-sp-2) var(--pad-sp-3);
  background: var(--pad-bg-elevated);
  border-top: 1px solid var(--pad-divider);
  flex-shrink: 0;
}
.pad-addprov__foot-actions {
  display: flex;
  gap: var(--pad-sp-2);
  margin-left: auto;
  flex-shrink: 0;
}
.pad-addprov__result {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--pad-fs-12);
  min-width: 0;
  flex: 1;
  color: var(--pad-fg-secondary);
}
.pad-addprov__result-icon {
  flex-shrink: 0;
  display: inline-flex;
}
.pad-addprov__result.is-ok { color: var(--pad-success-text); }
.pad-addprov__result.is-fail { color: var(--pad-danger-text); }
.pad-addprov__result.is-submitting { color: var(--pad-warning-text); }
.pad-addprov__result-text {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pad-addprov__btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 var(--pad-sp-3);
  border-radius: var(--pad-radius-md);
  font-size: var(--pad-fs-13);
  color: var(--pad-fg-primary);
  background: var(--pad-bg-input);
  border: 1px solid var(--pad-border);
  cursor: pointer;
  transition: background var(--pad-dur-fast) ease, color var(--pad-dur-fast) ease, border-color var(--pad-dur-fast) ease;
  font-family: inherit;
}
.pad-addprov__btn:hover:not(:disabled) {
  background: var(--pad-bg-hover);
  color: var(--pad-fg-primary);
  border-color: var(--pad-border-strong);
}
.pad-addprov__btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.pad-addprov__btn--primary {
  background: var(--pad-accent);
  color: var(--pad-fg-inverse);
  border-color: transparent;
}
.pad-addprov__btn--primary:hover:not(:disabled) {
  background: var(--pad-accent-hover);
  border-color: transparent;
}
.is-spinning {
  animation: pad-spin 1s linear infinite;
}
@keyframes pad-spin {
  to { transform: rotate(360deg); }
}
.pad-addprov-fade-enter-active,
.pad-addprov-fade-leave-active {
  transition: opacity var(--pad-dur-base) var(--pad-ease-out-soft), transform var(--pad-dur-base) var(--pad-ease-out-soft);
}
.pad-addprov-fade-enter-from,
.pad-addprov-fade-leave-to {
  opacity: 0;
  transform: translateY(4px);
}
</style>
