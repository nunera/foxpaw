import { expect, test } from 'bun:test';
import type { BidiEvent, BidiTransport } from '../src/bidi.ts';
import { FormInvalidError, InputVerificationError, ZenBrowser, ZenEmptyTabContextFilter, type Context } from '../src/browser.ts';

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

// BiDi remote-value serialization of a plain JSON value, as Firefox returns it from script.evaluate/callFunction.
function remote(value: unknown): Record<string, unknown> {
  if (value === null) return { type: 'null' };
  if (value === undefined) return { type: 'undefined' };
  if (Array.isArray(value)) return { type: 'array', value: value.map(remote) };
  if (typeof value === 'object') return { type: 'object', value: Object.entries(value).map(([key, item]) => [key, remote(item)]) };
  return { type: typeof value, value };
}

type Handler = (method: string, params: Record<string, unknown>) => unknown;
type Fake = BidiTransport & { commands: string[]; emit(event: BidiEvent): void; subscribed(): Promise<string[]> };
function fakeBidi(handler: Handler, overrides: Partial<BidiTransport> = {}): Fake {
  const commands: string[] = [];
  const listeners = new Set<(event: BidiEvent) => void>();
  let subscription = Promise.withResolvers<string[]>();
  return {
    commands,
    command: async (method, params = {}) => { commands.push(method); return (await handler(method, params) ?? {}) as Record<string, unknown>; },
    commandOptional: async (method, params = {}) => { commands.push(method); return (await handler(method, params) ?? {}) as Record<string, unknown>; },
    onEvent: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    subscribe: async (events) => { subscription.resolve(events); },
    unsubscribe: async () => {},
    close: async () => {},
    emit: (event) => { for (const listener of listeners) listener(event); },
    // Resolves on the next subscribe call, i.e. once the code under test is listening.
    subscribed: async () => { const events = await subscription.promise; subscription = Promise.withResolvers<string[]>(); return events; },
    ...overrides,
  };
}
const evaluated = (value: unknown) => ({ type: 'success', result: remote(value) });
const declaration = (params: Record<string, unknown>) => typeof params.functionDeclaration === 'string' ? params.functionDeclaration : '';
const expression = (params: Record<string, unknown>) => typeof params.expression === 'string' ? params.expression : '';

test('rechecks the URL after starting lifecycle subscriptions', async () => {
  let url = 'http://localhost:5173/start';
  let unsubscribed = 0;
  const bidi = fakeBidi((method) => method === 'script.evaluate' ? evaluated({ href: url, loaded: true }) : {}, {
    subscribe: async () => { url = 'http://localhost:5173/future'; },
    unsubscribe: async () => { unsubscribed++; },
  });

  await expect(new ZenBrowser(bidi).waitForUrl('ctx', '/future', 500)).resolves.toBeUndefined();
  expect(unsubscribed).toBe(1);
});

test('URL waits ignore the query string and require the matching document to have loaded', async () => {
  let state = { href: 'https://sso.example/login?service=https%3A%2F%2Fhowdy.tamu.edu%2F', loaded: true };
  const browser = new ZenBrowser(fakeBidi((method) => method === 'script.evaluate' ? evaluated(state) : {}));
  await expect(browser.waitForUrl('ctx', 'howdy.tamu.edu', 150)).rejects.toThrow('Timed out');
  await expect(browser.waitForUrl('ctx', 'service=https', 150)).rejects.toThrow('Timed out');
  await expect(browser.waitForUrl('ctx', '?service=https', 150)).resolves.toBeUndefined();
  state = { href: 'https://howdy.tamu.edu/home#done', loaded: false };
  await expect(browser.waitForUrl('ctx', 'howdy.tamu.edu', 150)).rejects.toThrow('Timed out');
  state = { ...state, loaded: true };
  await expect(browser.waitForUrl('ctx', 'howdy.tamu.edu/home#done', 150)).resolves.toBeUndefined();
});

test('URL waits complete on domContentLoaded for the URL, never on navigationStarted', async () => {
  const bidi = fakeBidi((method) => method === 'script.evaluate' ? evaluated({ href: 'https://a.example/form', loaded: true }) : {});
  const browser = new ZenBrowser(bidi);
  const started = browser.waitForUrl('ctx', '/confirmation', 300);
  await bidi.subscribed();
  bidi.emit({ method: 'browsingContext.navigationStarted', params: { context: 'ctx', url: 'https://a.example/confirmation' } });
  await expect(started).rejects.toThrow('Timed out');
  const loaded = browser.waitForUrl('ctx', '/confirmation', 300);
  await bidi.subscribed();
  bidi.emit({ method: 'browsingContext.domContentLoaded', params: { context: 'ctx', url: 'https://a.example/confirmation' } });
  await expect(loaded).resolves.toBeUndefined();
});

test('tracks open dialogs, skips page evaluation for them, and clears them once handled', async () => {
  const evaluatedContexts: unknown[] = [];
  const bidi = fakeBidi((method, params) => {
    if (method === 'browsingContext.getTree') return { contexts: [{ context: 'a', url: 'https://a.example/', children: [] }, { context: 'b', url: 'https://b.example/', children: [] }] };
    if (method === 'script.evaluate') {
      const target = params.target;
      evaluatedContexts.push(target && typeof target === 'object' && 'context' in target ? target.context : undefined);
      return evaluated('Title');
    }
    return {};
  });
  const browser = new ZenBrowser(bidi);
  const watching = browser.watchPrompts();
  await expect(bidi.subscribed()).resolves.toEqual(['browsingContext.userPromptOpened', 'browsingContext.userPromptClosed', 'browsingContext.contextDestroyed']);
  await watching;
  await browser.watchPrompts();

  const watcher = browser.promptOpened('a');
  bidi.emit({ method: 'browsingContext.userPromptOpened', params: { context: 'a', type: 'confirm', message: 'Drop CSCE 312?', handler: 'ignore' } });
  await expect(watcher.opened).resolves.toEqual({ type: 'confirm', message: 'Drop CSCE 312?' });
  watcher.stop();
  expect(browser.openPrompt('a')).toEqual({ type: 'confirm', message: 'Drop CSCE 312?' });

  const contexts = await browser.contexts();
  expect(evaluatedContexts).toEqual(['b']);
  expect(contexts.find((context) => context.id === 'a')?.title).toBeUndefined();

  await browser.handlePrompt('a', false);
  expect(bidi.commands).toContain('browsingContext.handleUserPrompt');
  expect(browser.openPrompt('a')).toBeUndefined();
});

test('reload uses browsingContext.reload', async () => {
  const bidi = fakeBidi(() => ({}));
  await new ZenBrowser(bidi).reload('ctx');
  expect(bidi.commands).toEqual(['browsingContext.reload']);
});

test('wait_event matches events whose source is the tab', async () => {
  const bidi = fakeBidi(() => ({}));
  const waiting = new ZenBrowser(bidi).waitForEvent('ctx', ['log.entryAdded'], 200);
  await bidi.subscribed();
  bidi.emit({ method: 'log.entryAdded', params: { source: { context: 'other' }, text: 'no' } });
  bidi.emit({ method: 'log.entryAdded', params: { source: { context: 'ctx' }, text: 'yes' } });
  await expect(waiting).resolves.toMatchObject({ params: { text: 'yes' } });
});

test('the capability probe only lists user contexts', async () => {
  const bidi = fakeBidi(() => ({ userContexts: [] }));
  await expect(new ZenBrowser(bidi).capabilities()).resolves.toEqual({ browserUserContexts: true });
  expect(bidi.commands).toEqual(['browser.getUserContexts']);
});

const node = { type: 'success', result: { type: 'node', sharedId: 'element' } };
const point = evaluated({ x: 10, y: 10, identity: { tag: 'select', role: 'combobox', name: null } });

test('select sets the option directly with one input/change and no key presses', async () => {
  let selectedIndex = 0;
  const bidi = fakeBidi((method, params) => {
    if (method === 'script.evaluate') return expression(params).includes('interactiveTarget') ? point : node;
    if (method === 'script.callFunction') {
      if (declaration(params).includes("new Event('change'")) { selectedIndex = 2; return evaluated({ index: 2, changed: true }); }
      if (declaration(params).includes('selectedIndex')) return evaluated(selectedIndex);
    }
    return {};
  });
  await expect(new ZenBrowser(bidi).select('ctx', '#term', 'Spring 2027')).resolves.toEqual({ selectedIndex: 2, changed: true });
  expect(bidi.commands).not.toContain('input.performActions');
});

test('select refuses disabled options and reports a lost selection as unverified input', async () => {
  const refusing = fakeBidi((method, params) => {
    if (method === 'script.evaluate') return expression(params).includes('interactiveTarget') ? point : node;
    if (method === 'script.callFunction') return { type: 'exception', exceptionDetails: { text: 'Error: Option "Choose a term" is disabled and cannot be selected' } };
    return {};
  });
  await expect(new ZenBrowser(refusing).select('ctx', '#term', 'Choose a term')).rejects.toThrow('is disabled');

  const reset = fakeBidi((method, params) => {
    if (method === 'script.evaluate') return expression(params).includes('interactiveTarget') ? point : node;
    if (method === 'script.callFunction') return declaration(params).includes("new Event('change'") ? evaluated({ index: 2, changed: true }) : evaluated(0);
    return {};
  });
  await expect(new ZenBrowser(reset).select('ctx', '#term', 'Spring 2027')).rejects.toBeInstanceOf(InputVerificationError);
});

test('check polls the read-back, then reports clicked-but-unchanged input as unverified', async () => {
  let reads = 0;
  const bidi = fakeBidi((method, params) => {
    if (method === 'script.evaluate') return expression(params).includes('interactiveTarget') ? evaluated({ x: 1, y: 1, identity: { tag: 'input', role: 'checkbox', name: null } }) : node;
    if (method === 'script.callFunction') {
      if (declaration(params).includes('Target is not a checkable input')) return evaluated(false);
      if (declaration(params).includes('const label')) return evaluated(false);
      if (declaration(params) === 'element => element.checked') { reads++; return evaluated(false); }
    }
    return {};
  });
  // check() polls with real sleeps for its fixed one-second settle window; the elapsed time is the behavior under test.
  const started = Date.now();
  const error = await new ZenBrowser(bidi).check('ctx', '#c', true).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(InputVerificationError);
  expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  expect(reads).toBeGreaterThan(1);
  expect(bidi.commands).toContain('input.performActions');
});

test('submitForm reports invalid fields instead of a silent no-op', async () => {
  const bidi = fakeBidi((method) => {
    if (method === 'script.evaluate') return node;
    if (method === 'script.callFunction') return evaluated({ submitted: false, invalidFields: [{ name: 'email', validationMessage: 'Please enter an email address.' }] });
    return {};
  });
  const error = await new ZenBrowser(bidi).submitForm('ctx', '#send').catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(FormInvalidError);
  if (!(error instanceof FormInvalidError)) throw error;
  expect(error.invalidFields).toEqual([{ name: 'email', validationMessage: 'Please enter an email address.' }]);
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

