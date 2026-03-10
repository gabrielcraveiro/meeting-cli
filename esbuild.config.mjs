import esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['src/cli.ts'],
  bundle: true,
  outfile: 'dist/cli.js',
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  banner: { js: '#!/usr/bin/env node' },
  external: ['fsevents'],
  minify: process.argv.includes('production'),
});

console.log('✅ Build complete → dist/cli.js');
