// vitest config (2026-11-14): only adds the setup that puts the shared relationship resolver (sftk-relmap.js) on
// globalThis, as popup.html loads it before the files that call it. Everything else stays vitest's default.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./test/setup-relmap.mjs'],
  },
});
