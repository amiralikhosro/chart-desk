import { defineConfig, type Plugin } from 'vite';
import { createFeedHandler } from './feeds.mjs';

/** News + calendar proxy (same handler as production `server.mjs`). */
function feedsPlugin(): Plugin {
  return {
    name: 'chart-desk-feeds',
    configureServer(server) {
      const handle = createFeedHandler({ dataDir: 'data' });
      server.middlewares.use((req, res, next) => {
        if (!handle(req, res)) next();
      });
    },
  };
}

export default defineConfig({
  plugins: [feedsPlugin()],
  build: {
    chunkSizeWarningLimit: 2500,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('vela-pinets') || id.includes('/pinets/')) return 'pine';
          if (id.includes('@luxalgo/vela')) return 'vela';
        },
      },
    },
  },
  optimizeDeps: {
    include: ['@luxalgo/vela', '@luxalgo/vela-pinets', 'pinets'],
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/lbank-api': {
        target: 'https://api.lbank.info',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/lbank-api/, '') || '/',
      },
      '/lbank-perp': {
        target: 'https://lbkperp.lbank.com',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/lbank-perp/, '') || '/',
      },
      '/lbank-ws': {
        target: 'wss://www.lbkex.net',
        changeOrigin: true,
        ws: true,
        rewrite: (p) => p.replace(/^\/lbank-ws/, '') || '/',
      },
    },
  },
  preview: { host: true, port: 4173 },
});
