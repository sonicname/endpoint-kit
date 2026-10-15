import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: {
      index: 'src/index.ts',
      'openapi/index': 'src/openapi/index.ts',
      // Optional adapters live on their own subpaths so the main entry stays fetch-only.
      'axios/index': 'src/adapters/axios.ts',
      'ofetch/index': 'src/adapters/ofetch.ts',
      'testing/index': 'src/testing.ts',
      'tanstack-query/index': 'src/tanstack-query.ts',
      'server/index': 'src/server/index.ts',
    },
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    clean: true,
    splitting: false,
    treeshake: true,
    minify: false,
    target: 'es2022',
    outDir: 'dist',
  },
  {
    entry: { cli: 'src/cli.ts' },
    format: ['esm'],
    dts: false,
    sourcemap: false,
    splitting: false,
    target: 'node18',
    platform: 'node',
    outDir: 'dist',
    banner: { js: '#!/usr/bin/env node' },
    // Optional YAML support: resolved at runtime only when a .yaml spec is given.
    external: ['yaml'],
  },
]);
