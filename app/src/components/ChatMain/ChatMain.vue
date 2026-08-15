<script setup lang="ts">
/**
 * ChatMain — middle column: ChatHeader + MessageList + Composer.
 * 1:1 mirrors chat.html's <section class="flex-1 flex flex-col bg-card ...">.
 */
import { computed } from 'vue';
import { storeToRefs } from 'pinia';
import { useChatStore } from '@/stores/chat';
import { useSessionStore } from '@/stores/session';
import ChatHeader from './ChatHeader.vue';
import ChatMessage from './ChatMessage.vue';
import Composer from './Composer.vue';

const chatStore = useChatStore();
const sessionStore = useSessionStore();
const { activeSession } = storeToRefs(sessionStore);

const messages = computed(() =>
  activeSession.value ? chatStore.getMessages(activeSession.value.id) : []
);
const thinking = computed(() =>
  activeSession.value ? chatStore.getThinking(activeSession.value.id) : []
);

// Map thinking block to its parent message id
const thinkingByMessageId = computed(() => {
  const map = new Map<string, typeof thinking.value[number]>();
  for (const t of thinking.value) {
    map.set(t.messageId, t);
  }
  return map;
});
</script>

<template>
  <section class="pad-chatmain">
    <ChatHeader />

    <div class="pad-chatmain__list pad-scroll">
      <div class="pad-chatmain__list-inner">
        <ChatMessage
          v-for="msg in messages"
          :key="msg.id"
          :message="msg"
          :thinking="msg.role === 'assistant' ? thinkingByMessageId.get(msg.id) : undefined"
        />
      </div>
    </div>

    <div class="pad-chatmain__composer">
      <Composer />
    </div>
  </section>
</template>

<style scoped>
.pad-chatmain {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--pad-card);
  border-radius: var(--pad-radius-xl);
  overflow: hidden;
}
.pad-chatmain__list {
  flex: 1;
  overflow-y: auto;
  padding: var(--pad-sp-4);
}
.pad-chatmain__list-inner {
  display: flex;
  flex-direction: column;
  gap: var(--pad-sp-4);
}
.pad-chatmain__composer {
  padding: var(--pad-sp-4);
  flex-shrink: 0;
}
</style>
