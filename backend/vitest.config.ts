// vitest.config wires Vitest to discover *.test.ts files alongside the
// modules they exercise. No globals — tests import { describe, it, expect }
// from 'vitest' explicitly.

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globals: false,
    // Use forks so each test file runs in a separate Node process — this
    // lets `node:sqlite` (a Node built-in that Vite's dev transformer
    // does not understand) resolve via the real Node loader rather than
    // through Vite's module pipeline.
    pool: 'forks',
    server: {
      deps: {
        // Belt + suspenders: tell Vitest to externalise any node: builtin
        // import so it never reaches the Vite transformer.
        external: [/^node:/],
      },
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/server.ts'],
    },
  },
});
