import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath, URL } from 'node:url';

// Pi Agent App — Vite 6 + Vue 3
// 1:1 复刻 Minimal Dashboard (Pi-Agent-Design.design 包)
// 后端预留: Vite dev 跨端口 API proxy, 解决 CORS 头缺失问题
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
    // Phase 2+: dev proxy 把 /api + /ws 转给本机 Pi SDK server (port 3001)
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        ws: true,  // WebSocket upgrade 也要 proxy
      },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
