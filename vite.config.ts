import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import { gatewayMiddleware } from './mock/gateway.mjs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// Основная сборка: один IIFE-файл без догружаемых чанков и внешних зависимостей.
export default defineConfig({
  define: { __VERSION__: JSON.stringify(pkg.version) },
  build: {
    target: 'es2021',
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    lib: {
      entry: 'src/index.ts',
      formats: ['iife'],
      name: 'AvaiChatBundle',
      fileName: () => 'avai-chat.js',
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
        // Правообладатель и лицензия встроенной библиотеки Lit — в самом файле (BSD-3-Clause требует уведомления).
        postBanner: `/*! avai-chat ${pkg.version} | MIT © Most AI LLC (AvangardAI) | включает Lit (BSD-3-Clause) © Google LLC, см. THIRD-PARTY-NOTICES */`,
      },
    },
  },
  server: { port: 5173, open: '/dev.html' },
  plugins: [
    {
      name: 'mock-gateway',
      configureServer(server) {
        server.middlewares.use(gatewayMiddleware({ prefix: '/v1' }));
      },
    },
  ],
});
