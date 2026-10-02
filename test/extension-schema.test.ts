import { expect, test } from 'bun:test';
import { z } from 'zod';
import type { ZodType } from 'zod';

type Tool = { parameters: ZodType };

const extensionPath = process.env.ZEN_BROWSER_EXTENSION ?? new URL('../extension/zen-browser.ts', import.meta.url).pathname;
test('registers the significant page-change wait action', async () => {
  const { default: register } = await import(extensionPath) as { default: (api: unknown) => void };
  let tool: Tool | undefined;
  register({
    zod: z,
    registerTool(value: Tool) { tool = value; },
    on() {},
  });
  const registered = tool;
  if (!registered) throw new Error('Extension did not register its tool');

  expect(registered.parameters.parse({ action: 'wait_for_change', tabId: 'tab_1', timeoutMs: 3_600_000 })).toMatchObject({ action: 'wait_for_change', tabId: 'tab_1', timeoutMs: 3_600_000 });
  expect(registered.parameters.parse({ action: 'evaluate', expression: 'document.title', timeoutMs: 3_600_000 })).toMatchObject({ action: 'evaluate', expression: 'document.title', timeoutMs: 3_600_000 });
  expect(() => registered.parameters.parse({ action: 'wait_for_change', timeoutMs: 3_600_001 })).toThrow();
});
