import { defineConfig } from 'tsup';

// Everything, the SDK included, goes into dist/index.js: the release tarball is
// unpacked and registered by path with no `npm install`.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  splitting: false,
  clean: true,
  noExternal: [/.*/],
  platform: 'node',
  banner: {
    js: "import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);",
  },
});
