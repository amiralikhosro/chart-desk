import { defineConfig } from 'vite';

export default defineConfig({
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
