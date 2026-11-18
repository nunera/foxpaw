import { expect, test } from 'bun:test';
import { z } from 'zod';
import type { ZodType } from 'zod';

type Tool = { parameters: ZodType; description: string };

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
  const anyOf = { anyOf: [{ text: 'Registration Results' }, { selector: '.spinner', state: 'hidden' }] };
  expect(registered.parameters.parse({ action: 'click', selector: '#register', waitFor: anyOf })).toMatchObject({ waitFor: anyOf });
  expect(() => registered.parameters.parse({ action: 'click', waitFor: { anyOf: [{ text: 'x' }], selector: '#y' } })).toThrow();
  expect(() => registered.parameters.parse({ action: 'click', waitFor: { txt: 'typo' } })).toThrow();
  expect(() => registered.parameters.parse({ action: 'batch', batch: [{ action: 'click', waitFor: { state: 'gone' } }] })).toThrow();
  for (const removed of ['controls', 'form_values', 'clear_many', 'trace_start', 'trace_replay', 'state_export', 'emulate', 'permissions', 'route_add', 'report', 'diagnostics', 'downloads']) {
    expect(() => registered.parameters.parse({ action: removed, tabId: 'tab_1' })).toThrow();
  }
  expect(registered.parameters.parse({ action: 'dialog', tabId: 'tab_1', dialogAction: 'accept' })).toMatchObject({ dialogAction: 'accept' });
  expect(registered.parameters.parse({ action: 'check', tabId: 'tab_1', selector: 'input[type=checkbox]', role: 'checkbox', name: 'CSCE 312-501', checked: true })).toMatchObject({ selector: 'input[type=checkbox]', role: 'checkbox', name: 'CSCE 312-501' });
  expect(registered.description).toContain('call `tabs` first');
  expect(registered.description).toContain('openPrompt');
});
