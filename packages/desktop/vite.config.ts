import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `base: './'` is REQUIRED so the built assets resolve under Electron's
// `file://` protocol. See <electron-desktop-app> in the platform knowledge.
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome120',
  },
  server: { port: 5180 },
});
