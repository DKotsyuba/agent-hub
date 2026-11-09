/** Vite preview/build setup; the fixed loopback endpoint is owned by the root agent. */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';
import os from 'node:os';
import path from 'node:path';
export default defineConfig({ plugins: [react(), tailwindcss()], cacheDir: path.join(os.tmpdir(), 'vite-cache'), resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } }, server: { host: '127.0.0.1', port: 4173, strictPort: true } });
