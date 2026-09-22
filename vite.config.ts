import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: process.env.BASE_PATH || '/',
  assetsInclude: ['**/*.gcode'],
  worker: { format: 'es' },
  build: { target: 'es2022' },
  test: { environment: 'node', testTimeout: 30_000 },
});
