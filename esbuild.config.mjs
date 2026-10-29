import { build, context } from 'esbuild';
import process from 'process';

const watch = !process.argv.includes('production');

const shared = {
  entryPoints: ['src/main.js'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'es2020',
  outfile: 'main.js',
  external: ['obsidian', 'electron', '@electron/remote'],
  logLevel: 'info',
  sourcemap: false,
  minify: !watch,
  legalComments: 'none',
};

if (watch) {
  const ctx = await context(shared);
  await ctx.watch();
  console.log('[vault-meta] watching src/main.js');
} else {
  await build(shared);
  console.log('[vault-meta] build complete');
}
