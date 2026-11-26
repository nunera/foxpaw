// Cross-compiles standalone foxpaw binaries (Bun inside) into dist/bin/foxpaw-<os>-<arch>[.exe].
// `bun run build:bin` builds every target; `bun run build:bin linux-x64 darwin-arm64` builds only those.
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const TARGETS = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'windows-x64'];

const root = join(import.meta.dir, '..');
const outdir = join(root, 'dist/bin');
const requested = process.argv.slice(2);
const unknown = requested.filter((target) => !TARGETS.includes(target));
if (unknown.length) {
  console.error(`Unknown target ${unknown.join(', ')}; choose from ${TARGETS.join(', ')}`);
  process.exit(2);
}

await mkdir(outdir, { recursive: true });
for (const target of requested.length ? requested : TARGETS) {
  const outfile = join(outdir, `foxpaw-${target}${target.startsWith('windows') ? '.exe' : ''}`);
  const build = Bun.spawnSync(
    [process.execPath, 'build', '--compile', `--target=bun-${target}`, join(root, 'src/cli.ts'), '--outfile', outfile],
    { stdout: 'inherit', stderr: 'inherit' },
  );
  if (build.exitCode !== 0) process.exit(build.exitCode ?? 1);
}
