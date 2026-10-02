import { expect, test } from 'bun:test';
import type { BidiTransport } from '../src/bidi.ts';
import { ZenBrowser, ZenEmptyTabContextFilter, type Context } from '../src/browser.ts';

test('keeps Zen empty-tab contexts private after they navigate', () => {
  const filter = new ZenEmptyTabContextFilter();
  const hidden: Context = { id: 'zen-empty-1', url: 'about:blank', title: '', parent: null };
  const secondHidden: Context = { id: 'zen-empty-2', url: 'about:blank', title: '', parent: null };
  const visible: Context = { id: 'visible', url: 'https://example.test', title: 'Example', parent: null };

  expect(filter.visible([visible, hidden, secondHidden]).map((context) => context.id)).toEqual(['visible']);

  const navigatedHidden = { ...hidden, url: 'https://console.cloud.google.com', title: 'Google Cloud' };
  const laterBlank: Context = { id: 'later-blank', url: 'about:blank', title: '', parent: null };
  expect(filter.visible([visible, navigatedHidden, secondHidden, laterBlank]).map((context) => context.id)).toEqual(['visible', 'later-blank']);
});

test('rechecks the URL after starting lifecycle subscriptions', async () => {
  let url = 'http://localhost:5173/start';
  let unsubscribed = 0;
  const bidi: BidiTransport = {
    command: async (method) => {
      if (method === 'script.evaluate') return { result: { type: 'string', value: url } };
      return {};
    },
    commandOptional: async () => ({}),
    onEvent: () => () => {},
    subscribe: async () => { url = 'http://localhost:5173/future'; },
    unsubscribe: async () => { unsubscribed++; },
    close: async () => {},
  };

  await expect(new ZenBrowser(bidi).waitForUrl('ctx', '/future', 50)).resolves.toBeUndefined();
  expect(unsubscribed).toBe(1);
});

function pageChangeSnapshot(snapshot: { url: string; documentId: string; text: string; elementCount: number }) {
  return {
    type: 'success',
    result: {
      type: 'object',
      value: Object.entries(snapshot).map(([key, value]) => [key, { type: typeof value === 'number' ? 'number' : 'string', value }]),
    },
  };
}

test('waits for a substantial primary-content update and cleans lifecycle subscriptions', async () => {
  const snapshots = [
    { url: 'https://example.test/', documentId: 'https://example.test/\u00001', text: 'Initial page instructions.', elementCount: 2 },
    { url: 'https://example.test/', documentId: 'https://example.test/\u00001', text: 'Updated page instructions with enough new feedback to represent a page update.', elementCount: 2 },
  ];
  let unsubscribed = 0;
  const bidi: BidiTransport = {
    command: async (method) => method === 'script.evaluate' ? pageChangeSnapshot(snapshots.shift() ?? snapshots[0]!) : {},
    commandOptional: async () => ({}),
    onEvent: () => () => {},
    subscribe: async () => {},
    unsubscribe: async () => { unsubscribed++; },
    close: async () => {},
  };

  const result = await new ZenBrowser(bidi).waitForPageChange('ctx', 250);
  expect(result.type).toBe('dom');
  expect(result.changedCharacters).toBeGreaterThanOrEqual(24);
  expect(unsubscribed).toBe(1);
});


test('treats a lifecycle navigation as a page change', async () => {
  let listener: ((event: { method: string; params: Record<string, unknown> }) => void) | undefined;
  const snapshot = { url: 'https://example.test/', documentId: 'https://example.test/\u00001', text: 'Initial page instructions.', elementCount: 2 };
  const bidi: BidiTransport = {
    command: async (method) => method === 'script.evaluate' ? pageChangeSnapshot(snapshot) : {},
    commandOptional: async () => ({}),
    onEvent: (next) => { listener = next; return () => {}; },
    subscribe: async () => { listener?.({ method: 'browsingContext.navigationStarted', params: { context: 'ctx' } }); },
    unsubscribe: async () => {},
    close: async () => {},
  };

  await expect(new ZenBrowser(bidi).waitForPageChange('ctx', 50)).resolves.toEqual({ type: 'navigation' });
});
test('times out when the primary content has no significant change', async () => {
  const snapshot = { url: 'https://example.test/', documentId: 'https://example.test/\u00001', text: 'Initial page instructions.', elementCount: 2 };
  const bidi: BidiTransport = {
    command: async (method) => method === 'script.evaluate' ? pageChangeSnapshot(snapshot) : {},
    commandOptional: async () => ({}),
    onEvent: () => () => {},
    subscribe: async () => {},
    unsubscribe: async () => {},
    close: async () => {},
  };

  await expect(new ZenBrowser(bidi).waitForPageChange('ctx', 0)).rejects.toThrow('Timed out waiting for a significant page change');
});


test('forwards an evaluation timeout to the transport', async () => {
  let requestedTimeout: number | undefined;
  const bidi: BidiTransport = {
    command: async (method, _params, timeoutMs) => {
      requestedTimeout = timeoutMs;
      return method === 'script.evaluate' ? { type: 'success', result: { type: 'number', value: 2 } } : {};
    },
    commandOptional: async () => ({}),
    onEvent: () => () => {},
    subscribe: async () => {},
    unsubscribe: async () => {},
    close: async () => {},
  };

  await expect(new ZenBrowser(bidi).evaluateValue('ctx', '1 + 1', 600_000)).resolves.toBe(2);
  expect(requestedTimeout).toBe(600_000);
});
test('fill uses native keyboard input, then verifies the DOM value', async () => {
  const actions: unknown[] = [];
  let valueRead = 0;
  const bidi: BidiTransport = {
    command: async (method, params) => {
      if (method === 'script.evaluate') {
        const expression = params && typeof params === 'object' && 'expression' in params && typeof params.expression === 'string' ? params.expression : '';
        if (expression.includes('return element;')) return { type: 'success', result: { type: 'node', sharedId: 'field' } };
        if (expression.includes('interactiveTarget')) return { type: 'success', result: { type: 'object', value: [['x', { type: 'number', value: 40 }], ['y', { type: 'number', value: 20 }], ['identity', { type: 'object', value: [['tag', { type: 'string', value: 'input' }], ['role', { type: 'string', value: 'textbox' }], ['name', { type: 'null' }]] }]] } };
        return { type: 'success', result: { type: 'boolean', value: true } };
      }
      if (method === 'script.callFunction') {
        const declaration = params && typeof params === 'object' && 'functionDeclaration' in params && typeof params.functionDeclaration === 'string' ? params.functionDeclaration : '';
        if (declaration.includes('!element.disabled')) return { type: 'success', result: { type: 'boolean', value: true } };
        if (declaration.includes('document.activeElement')) return { type: 'success', result: { type: 'boolean', value: true } };
        if (declaration.includes('element.value')) return { type: 'success', result: { type: 'string', value: valueRead++ === 0 ? 'before' : 'answer' } };
      }
      if (method === 'input.performActions') actions.push(params);
      return {};
    },
    commandOptional: async () => ({}),
    onEvent: () => () => {},
    subscribe: async () => {},
    unsubscribe: async () => {},
    close: async () => {},
  };

  await expect(new ZenBrowser(bidi).fill('ctx', '#answer', 'answer')).resolves.toEqual({
    requestedValue: 'answer', actualValue: 'answer', focused: true, replaced: true,
  });
  expect(actions).toHaveLength(2);
  expect(JSON.stringify(actions[0])).toContain('"pointerDown"');
  expect(JSON.stringify(actions[1])).toContain('\uE003');
  expect(JSON.stringify(actions[1])).toContain('"a"');
});

test('openWithOutcome preserves the created context when navigation times out', async () => {
  const bidi: BidiTransport = {
    command: async (method) => {
      if (method === 'browsingContext.create') return { context: 'created-context' };
      if (method === 'browsingContext.navigate') throw new Error('Timed out waiting for navigation');
      if (method === 'script.evaluate') return { type: 'success', result: { type: 'string', value: 'about:blank' } };
      return {};
    },
    commandOptional: async () => ({}),
    onEvent: () => () => {},
    subscribe: async () => {},
    unsubscribe: async () => {},
    close: async () => {},
  };

  await expect(new ZenBrowser(bidi).openWithOutcome('https://page.example')).resolves.toEqual({
    context: { id: 'created-context', url: 'about:blank', parent: null },
    created: true,
    navigationStarted: false,
    error: 'Timed out waiting for navigation',
  });
});

