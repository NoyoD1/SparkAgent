import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath, URL } from 'node:url';

// Pi Agent App — Vite 6 + Vue 3
// 1:1 复刻 Minimal Dashboard (Pi-Agent-Design.design 包)
// Phase 3: 走 Tauri 2, 不再需要 localhost:3001 proxy (Rust host 直接 spawn sidecar)
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5174,
    strictPort: false,
  },
  // Tauri 2 dev: 固定端口 + 暴露给 Tauri WebView 访问
  clearScreen: false,
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
