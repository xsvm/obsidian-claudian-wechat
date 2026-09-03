import esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  external: ['obsidian', 'electron', 'http', 'crypto', '@codemirror/*', '@lezer/*'],
  format: 'cjs',
  target: 'es2020',
  platform: 'node',
  outfile: 'main.js',
  sourcemap: false,
  treeShaking: true,
});

console.log('claudian-wechat: build complete -> main.js');
