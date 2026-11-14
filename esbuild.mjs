// Bundles the extension (and, with --test, the VS Code-free core for the test suite).
import { build, context } from 'esbuild';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');
const test = process.argv.includes('--test');

const common = {
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  sourcemap: !production,
  minify: production,
  // ssh2 probes for optional native accelerators and falls back to pure JS when they
  // are absent. Leaving them out is what keeps one .vsix working on every OS and CPU.
  external: ['vscode', 'cpu-features', './crypto/build/Release/sshcrypto.node'],
  logLevel: 'info',
};

const targets = test
  ? [{ ...common, entryPoints: ['src/core/index.ts'], outfile: 'out-test/core.js' }]
  : [{ ...common, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js' }];

for (const options of targets) {
  if (watch) await (await context(options)).watch();
  else await build(options);
}
