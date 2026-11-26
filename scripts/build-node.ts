// Bundles the Node package into dist/: cli.js (the `foxpaw` bin), index.js (the library) and shared chunks, all in one
// directory, because broker-client starts the broker as `<runtime> <its own directory>/cli.js broker`. Dependencies
// stay external (they are package dependencies); text imports (AutoConfig files) are inlined. Needs only Bun: this is
// the `prepare` script, and Bun runs a git dependency's prepare without its devDependencies. Type declarations come
// from tsc separately (`prepack`, `build:node`).
import { chmod, mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const outdir = join(root, 'dist');

// Chunk names carry content hashes: drop the previous build's JavaScript, keep declarations and dist/bin.
await mkdir(outdir, { recursive: true });
for (const entry of await readdir(outdir)) {
  if (entry.endsWith('.js')) await rm(join(outdir, entry));
}

const result = await Bun.build({
  entrypoints: [join(root, 'src/cli.ts'), join(root, 'src/index.ts')],
  root: join(root, 'src'),
  outdir,
  target: 'node',
  format: 'esm',
  splitting: true,
  packages: 'external',
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

// src/cli.ts starts with `#!/usr/bin/env bun` (for running from source); the built CLI runs under Node.
const cli = join(outdir, 'cli.js');
const source = await Bun.file(cli).text();
const body = source.replace(/^(#![^\n]*\n|\/\/ @bun[^\n]*\n)+/, '');
await Bun.write(cli, `#!/usr/bin/env node\n${body}`);
await chmod(cli, 0o755);

for (const output of result.outputs) console.log(output.path.slice(root.length + 1));
