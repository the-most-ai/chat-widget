import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// Логика чата без интерфейса — ES-модуль для своего интерфейса сайта на нашем API.
export default defineConfig({
  build: {
    target: 'es2021',
    outDir: 'dist/core',
    emptyOutDir: false,
    sourcemap: true,
    lib: {
      entry: 'src/core/index.ts',
      formats: ['es'],
      fileName: () => 'avai-chat-core.js',
    },
    rollupOptions: {
      output: { banner: `/*! avai-chat-core ${pkg.version} | MIT © Most AI LLC (AvangardAI) */` },
    },
  },
});
