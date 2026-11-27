import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

// oh-my-pi loads extension/zen-browser.ts with its own loader, which ignores import attributes: a
// `with { type: 'text' }` import anywhere in the extension's graph breaks loading the tool.
test('the omp extension imports no module that uses import attributes', async () => {
  const result = await Bun.build({ entrypoints: ['extension/zen-browser.ts'], target: 'bun', external: ['@oh-my-pi/*', 'zod'], metafile: true });
  expect(result.success).toBe(true);
  const modules = Object.keys(result.metafile!.inputs).filter((path) => path.endsWith('.ts'));
  expect(modules).toContain('src/tool/core.ts');
  const withAttributes = modules.filter((path) => /\bwith \{ type:/.test(readFileSync(path, 'utf8')));
  expect(withAttributes).toEqual([]);
});
