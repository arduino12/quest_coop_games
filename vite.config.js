import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// `npm run dev` serves plain http (use with `adb reverse` or the ?emu desktop emulator).
// `npm run dev:https` serves a self-signed https site on your LAN so the Quest can open it directly.
export default defineConfig(({ mode }) => ({
  base: './',
  plugins: mode === 'https' ? [basicSsl()] : [],
  server: { host: true, port: 5173 },
  build: { target: 'es2022', chunkSizeWarningLimit: 6000 },
}));
