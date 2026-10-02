import { expect, test } from 'bun:test';
import { z } from 'zod';

const runIntegration = process.env.FIREFOX_BIDI_INTEGRATION === '1';
const extensionPath = process.env.ZEN_BROWSER_EXTENSION ?? new URL('../extension/zen-browser.ts', import.meta.url).pathname;

type Tab = { tabId: string };
type Result = { details: { tabs?: Tab[]; tab?: Tab; elements?: unknown[] } };
type Tool = { parameters: z.ZodType; execute(id: string, params: unknown): Promise<Result> };

// Uses the shared broker, not a competing direct BiDi session. Only the disposable test tab is changed.
test.skipIf(!runIntegration)('query dispatch extracts matches and rejects a missing selector', async () => {
  // Import the repository-owned extension; the shared broker is still used.
  const { default: register } = await import(extensionPath);
  let tool: Tool | undefined;
  let shutdown: (() => Promise<void>) | undefined;
  register({
    zod: z,
    registerTool(value: Tool) { tool = value; },
    on(event: string, handler: () => Promise<void>) { if (event === 'session_shutdown') shutdown = handler; },
  });
  if (!tool) throw new Error('Extension did not register its tool');
  const registered = tool;
  const invoke = async (params: Record<string, unknown>) => registered.execute('query-regression', registered.parameters.parse(params));
  let tabId: string | undefined;
  try {
    const reference = (await invoke({ action: 'tabs' })).details.tabs?.[0];
    if (!reference) throw new Error('Zen has no reference tab');
    const html = '<!doctype html><title>Zen query regression</title><span id="label">Account name</span><input class="item" aria-labelledby="label"><input id="updates" type="checkbox"><a class="item" href="/docs" data-code="a&quot;b"> Read   docs </a>';
    tabId = (await invoke({ action: 'open', tabId: reference.tabId, isolation: 'test', url: `data:text/html,${encodeURIComponent(html)}` })).details.tab?.tabId;
    if (!tabId) throw new Error('Extension did not return a test tab');

    await expect(invoke({ action: 'inspect', tabId, root: 'input[type=checkbox]', mode: 'interactive' })).resolves.toMatchObject({
      details: { elements: [{ selector: '#updates', tag: 'input', role: 'checkbox' }] },
    });

    expect((await invoke({ action: 'query', tabId, selector: '.item' })).details.elements).toEqual([
      { tag: 'input', role: 'textbox', name: 'Account name', text: '' },
      { tag: 'a', role: 'link', name: 'Read docs', text: 'Read docs' },
    ]);
    expect((await invoke({ action: 'query', tabId, selector: 'a', fields: { label: 'text', destination: 'href', code: 'data-code', missing: 'data-missing' } })).details.elements).toEqual([
      { label: 'Read docs', destination: '/docs', code: 'a"b', missing: null },
    ]);
    expect((await invoke({ action: 'query', tabId, selector: '.missing' })).details.elements).toEqual([]);
    await expect(invoke({ action: 'query', tabId, locator: { role: 'link' } })).rejects.toThrow('query requires selector');
    await expect(invoke({ action: 'query', tabId, selector: '   ' })).rejects.toThrow('query requires selector');
    await expect(invoke({ action: 'query', tabId, selector: '[' })).rejects.toThrow();
    // A page-side selector error must not poison the extension's serial action queue.
    expect((await invoke({ action: 'query', tabId, selector: 'input', fields: { label: 'name' } })).details.elements).toEqual([{ label: 'Account name' }, { label: null }]);
  } finally {
    try { if (tabId) await invoke({ action: 'close', tabId }); }
    finally { await shutdown?.(); }
  }
}, 30_000);
