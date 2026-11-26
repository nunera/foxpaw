import { expect, test } from 'bun:test';
import type { BidiTransport } from '../src/bidi.ts';
import { ZenBrowser } from '../src/browser.ts';

// A minimal open shadow root: the document retargets elementFromPoint and activeElement to the host, as browsers do.
class FakeInput {
  value = '';
  type = 'text';
  disabled = false;
  readOnly = false;
  required = false;
  autocomplete = '';
  inputMode = '';
  isContentEditable = false;
  tagName = 'INPUT';
  labels = [];
  focus() { host.shadowRoot.activeElement = this; page.activeElement = host; }
  contains(other: unknown) { return other === this; }
  getAttribute() { return null; }
  getClientRects() { return [{}]; }
  getBoundingClientRect() { return { left: 10, top: 10, width: 100, height: 20, right: 110, bottom: 30, x: 10, y: 10 }; }
  checkValidity() { return true; }
}
const input = new FakeInput();
const host = {
  tagName: 'SETTINGS-WIDGET',
  id: 'host',
  shadowRoot: { activeElement: null as unknown, querySelector: () => input, elementFromPoint: () => input },
  contains: () => false,
  getAttribute: () => null,
};
const page = { activeElement: null as unknown, querySelector: () => host, elementFromPoint: () => host, getElementById: () => null };
const globals = {
  document: page, HTMLInputElement: FakeInput, HTMLTextAreaElement: class {}, CSS: { escape: (value: string) => value },
  getComputedStyle: () => ({ visibility: 'visible', display: 'block' }), innerHeight: 800, innerWidth: 1200,
  location: { href: 'https://a.test/' }, performance: { timeOrigin: 1 }, requestAnimationFrame: (callback: () => void) => callback(),
};
const inPage = (source: string) => Function(...Object.keys(globals), `return ${source}`)(...Object.values(globals));
const remote = (value: unknown): Record<string, unknown> => value === null || value === undefined ? { type: 'null' }
  : typeof value === 'object' ? { type: 'object', value: Object.entries(value).map(([key, item]) => [key, remote(item)]) } : { type: typeof value, value };

function shadowPage(): BidiTransport {
  const run = async (method: string, params: Record<string, unknown> = {}) => {
    if (method === 'script.evaluate') {
      const expression = String(params.expression);
      if (expression.includes('return element;')) return { type: 'success', result: { type: 'node', sharedId: 'input' } };
      if (expression.includes('interactiveTarget')) return { type: 'success', result: remote({ x: 60, y: 20, identity: { tag: 'input', role: 'textbox', name: null } }) };
      return { type: 'success', result: remote(await inPage(expression)) };
    }
    if (method === 'script.callFunction') return { type: 'success', result: remote(inPage(String(params.functionDeclaration))(input)) };
    if (method === 'input.performActions') {
      const keys = (params.actions as Array<{ type: string; actions: Array<{ type: string; value?: string }> }>).filter((source) => source.type === 'key').flatMap((source) => source.actions);
      for (const key of keys) if (key.type === 'keyDown' && key.value === '\uE003') input.value = ''; else if (key.type === 'keyDown' && key.value && key.value.length === 1 && key.value !== 'a') input.value += key.value;
    }
    return {};
  };
  return { command: run, commandOptional: run, onEvent: () => () => {}, subscribe: async () => {}, unsubscribe: async () => {}, close: async () => {} };
}

test('fill focuses and verifies an input inside an open shadow root', async () => {
  await expect(new ZenBrowser(shadowPage()).fill('ctx', 'settings-widget >>> #display-name', 'Ad')).resolves.toMatchObject({ actualValue: 'Ad', focused: true });
});

test('field_state does not report a shadow input as covered by its own host', async () => {
  const state = await new ZenBrowser(shadowPage()).fieldState('ctx', 'settings-widget >>> #display-name');
  expect(state).toMatchObject({ covered: false, coveredBy: null, editable: true });
});
