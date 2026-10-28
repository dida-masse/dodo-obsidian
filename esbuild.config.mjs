import esbuild from 'esbuild';

const ctx = await esbuild.context({
  entryPoints: ['src/main.ts'], bundle: true, outfile: 'main.js', format: 'cjs', target: 'es2022',
  external: ['obsidian', 'electron', '@codemirror/*', '@lezer/*'], platform: 'browser', logLevel: 'info', sourcemap: false, treeShaking: true,
});
if (process.argv[2] === 'watch') await ctx.watch(); else { await ctx.rebuild(); await ctx.dispose(); }
