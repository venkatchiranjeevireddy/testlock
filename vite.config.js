import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// Camera access needs HTTPS. `npm run dev` serves a self-signed certificate so a phone on the same Wi-Fi can open it.
export default defineConfig(({ command }) => ({
  plugins: command === 'serve' ? [basicSsl()] : [],
  build: { target: 'es2020', chunkSizeWarningLimit: 4000 },
  optimizeDeps: { exclude: ['mind-ar'] },
}));
