import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Porta fixa 1420: o daemon libera `http://localhost:1420` no CORS (docs/app-api.md).
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: '127.0.0.1',
    watch: {
      // src-tauri é compilado pelo cargo, não faz parte do bundle do front
      ignored: ['**/src-tauri/**'],
    },
  },
  build: {
    target: 'chrome105',
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
  },
});
