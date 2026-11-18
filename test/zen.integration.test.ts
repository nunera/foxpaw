import { expect, test } from 'bun:test';
import { BidiClient } from '../src/bidi.ts';
import { ZenBrowser } from '../src/browser.ts';
import { documentFrame, semanticSnapshot, type ElementIdentity } from '../src/locator.ts';

const runIntegration = process.env.FIREFOX_BIDI_INTEGRATION === '1';
const fixture = `data:text/html,${encodeURIComponent(`<!doctype html><main aria-label="Primary"><label>Search<input id="q"></label><span id="aria-name">Aria search</span><input id="aria-input" aria-labelledby="aria-name"><input id="c" type="checkbox"><button id="b" onclick="this.dataset.clicks=(+this.dataset.clicks||0)+1">Press</button><button id="duplicate-primary">Duplicate</button><div id="hover" onmouseenter="this.dataset.hovered=1">Hover</div><div id="drop" onpointerup="this.dataset.dropped=1">Drop</div><button id="rerender">Rerender</button><x-fixture id="host"></x-fixture><iframe id="frame" srcdoc="&lt;button id='inside'&gt;Inside frame&lt;/button&gt;"></iframe></main><nav aria-label="Secondary"><button id="duplicate-secondary">Duplicate</button></nav><script>customElements.define('x-fixture',class extends HTMLElement{connectedCallback(){this.attachShadow({mode:'open'}).innerHTML='<button id="shadow">Shadow button</button>'}});console.error('fixture-console-error');setTimeout(()=>document.body.insertAdjacentHTML('beforeend','<div id="late">late</div>'),25)</script>`)}`;

// Deliberately opt-in: it needs a fresh local Firefox-family BiDi session.
test.skipIf(!runIntegration)('drives semantic, frame, lifecycle, stale-node, and screenshot paths', async () => {
  const client = new BidiClient(process.env.FIREFOX_BIDI_URL ?? 'ws://127.0.0.1:9222/session');
  const browser = new ZenBrowser(client);
  let context: string | undefined;
  try {
    const reference = (await browser.contexts())[0];
    if (!reference) throw new Error('Firefox has no browsing context to use as a reference');
    const page = await browser.open(fixture, reference.id);
    context = page.id;

    await browser.waitFor(context, '#q');
    expect(await browser.locator(context, 'textbox', 'Search')).toBe('#q');
    expect(await browser.locator(context, 'textbox', 'Aria search')).toBe('#aria-input');
    await browser.fill(context, '#q', 'native input');
    expect(await browser.evaluateValue(context, 'q.value')).toBe('native input');

    await browser.check(context, '#c', true);
    expect(await browser.evaluateValue(context, 'c.checked')).toBe(true);
    await browser.doubleClick(context, '#b');
    expect(await browser.evaluateValue(context, 'b.dataset.clicks')).toBe('2');
    await browser.hover(context, '#hover');
    expect(await browser.evaluateValue(context, 'hover.dataset.hovered')).toBe('1');
    await browser.drag(context, '#hover', '#drop');
    expect(await browser.evaluateValue(context, 'drop.dataset.dropped')).toBe('1');

    const shadow = await browser.resolveLocator(context, { role: 'button', name: 'Shadow button' });
    expect(shadow.selector).toBe('#host >>> #shadow');
    await browser.click(context, shadow.selector);
    await browser.evaluateValue(context, `new Promise(resolve => { const frame = document.querySelector('#frame'); if (frame.contentDocument?.readyState === 'complete') resolve(true); else frame.addEventListener('load', () => resolve(true), { once: true }); })`);
    const frames = await browser.frames(context);
    const child = frames.find((frame) => frame.context !== context);
    if (!child) throw new Error(`Fixture iframe did not create a child browsing context: ${JSON.stringify(await browser.contexts())}`);
    expect(await browser.locator(child.context, 'button', 'Inside frame')).toBe('#inside');

    const before = await browser.elementId(context, '#rerender');
    await browser.evaluateValue(context, `rerender.replaceWith(Object.assign(document.createElement('button'), { id: 'rerender', textContent: 'Rerendered' }))`);
    expect(await browser.elementId(context, '#rerender')).not.toBe(before);
    await browser.waitFor(context, '#late');

    await browser.subscribe(['browsingContext.load'], [context]);
    const loaded = Promise.withResolvers<string>();
    const stop = browser.onEvent((event) => {
      if (event.method === 'browsingContext.load' && event.params.context === context) { stop(); loaded.resolve(event.method); }
    });
    await browser.reload(context);
    await expect(loaded.promise).resolves.toBe('browsingContext.load');

    const viewport = await browser.screenshot(context);
    const fullPage = await browser.screenshot(context, { fullPage: true });
    const element = await browser.screenshot(context, { selector: '#q' });
    expect(viewport.length).toBeGreaterThan(0);
    expect(fullPage.length).toBeGreaterThan(0);
    expect(element.length).toBeGreaterThan(0);
  } finally {
    if (context) await browser.close(context).catch(() => undefined);
    await client.close();
  }
}, 30_000);

test.skipIf(!runIntegration)('probes user contexts read-only and opens an isolated tab', async () => {
  const client = new BidiClient(process.env.FIREFOX_BIDI_URL ?? 'ws://127.0.0.1:9222/session');
  const browser = new ZenBrowser(client);
  let context: string | undefined;
  let userContext: string | undefined;
  try {
    const capabilities = await browser.capabilities();
    expect(typeof capabilities.browserUserContexts).toBe('boolean');
    if (!capabilities.browserUserContexts) expect(typeof capabilities.unavailable?.browserUserContexts).toBe('string');
    if (!capabilities.browserUserContexts) return;

    const reference = (await browser.contexts())[0];
    if (!reference) throw new Error('Firefox has no browsing context to use as a reference');
    userContext = await browser.createUserContext();
    context = (await browser.openInUserContext('data:text/html,<main>isolated</main>', reference.id, userContext)).id;
    expect(await browser.evaluateValue(context, 'document.body.textContent')).toContain('isolated');
  } finally {
    if (context) await browser.close(context).catch(() => undefined);
    if (userContext) await browser.removeUserContext(userContext).catch(() => undefined);
    await client.close();
  }
}, 30_000);

test.skipIf(!runIntegration)('keeps inspected no-ID form controls bound to their own nodes across sequential fills', async () => {
  const client = new BidiClient(process.env.FIREFOX_BIDI_URL ?? 'ws://127.0.0.1:9222/session');
  const browser = new ZenBrowser(client);
  let userContext: string | undefined;
  try {
    const reference = (await browser.contexts())[0]!;
    userContext = await browser.createUserContext();
    const html = '<main><label>First<input></label><label>Workspace<input></label><label>Email<input type="email"></label><label>Password<input type="password"></label><button>Save</button><button>Save</button></main>';
    const page = await browser.openInUserContext(`data:text/html,${encodeURIComponent(html)}`, reference.id, userContext);
    const evaluate = browser.evaluateValue.bind(browser);
    const frame = await documentFrame(evaluate, page.id);
    const snapshot = await semanticSnapshot(evaluate, frame, 'interactive', 15) as Array<ElementIdentity & { selector: string }>;
    const records = [];
    for (const item of snapshot) records.push({ ...item, nodeId: await browser.elementId(page.id, item.selector) });

    const values = ['Example', 'Workspace', 'fixture@example.test', 'LocalOnly-2026!'];
    for (const [index, record] of records.entries()) {
      const resolved = await browser.resolveLocator(page.id, { css: record.selector, role: record.role ?? undefined, name: record.name ?? undefined, frame });
      expect(await browser.elementId(page.id, resolved.selector)).toBe(record.nodeId);
      expect(resolved.identity).toEqual({ tag: record.tag, role: record.role, name: record.name });
      if (record.tag === 'input') await browser.fill(page.id, resolved.selector, values[index]!);
    }
    expect(await evaluate(page.id, '[...document.querySelectorAll("input")].map(input => input.value)')).toEqual(values);
    expect((await browser.contexts()).some(context => context.id === page.id)).toBe(true);
  } finally {
    if (userContext) await browser.removeUserContext(userContext);
    await client.close();
  }
}, 30_000);

test.skipIf(!runIntegration)('handles hostile form controls without bypassing native interaction', async () => {
  const client = new BidiClient(process.env.FIREFOX_BIDI_URL ?? 'ws://127.0.0.1:9222/session');
  const browser = new ZenBrowser(client);
  let context: string | undefined;
  try {
    const reference = (await browser.contexts())[0];
    if (!reference) throw new Error('Firefox has no browsing context to use as a reference');
    const html = `<!doctype html>
      <style>#covered { position:absolute; top:500px; left:10px } #overlay { position:absolute; z-index:2; top:490px; left:0; width:300px; height:80px }</style>
      <main>
        <label>Answer<input id="answer" aria-describedby="answer-hint" onfocus="document.querySelector('#answer-hint').hidden=false" onblur="document.querySelector('#answer-hint').hidden=true"></label><div id="answer-hint" role="tooltip" hidden>Enter a number</div>
        <input id="hidden-check" type="checkbox" hidden><label for="hidden-check">Hidden check</label>
        <input id="covered"><div id="overlay"></div>
        <x-field id="host"></x-field>
        <button id="rerender" onclick="answer.replaceWith(Object.assign(document.createElement('input'), { id: 'answer' }))">Rerender</button>
      </main>
      <script>customElements.define('x-field', class extends HTMLElement { constructor() { super(); this.attachShadow({mode:'open'}).innerHTML = '<input id="shadow-answer">'; } });</script>`;
    context = (await browser.open(`data:text/html,${encodeURIComponent(html)}`, reference.id)).id;

    await expect(browser.fill(context, '#answer', 'native')).resolves.toMatchObject({ actualValue: 'native', focused: true });
    await expect(browser.dismissTransientHint(context, '#answer')).resolves.toEqual({ dismissed: true, tooltip: '#answer-hint' });
    await expect(browser.fill(context, '#host >>> #shadow-answer', 'shadow')).resolves.toMatchObject({ actualValue: 'shadow' });
    await browser.check(context, '#hidden-check', true);
    await expect(browser.fill(context, '#covered', 'blocked')).rejects.toThrow('covered');
    await browser.click(context, '#rerender');
    await expect(browser.fill(context, '#answer', 'after-rerender')).resolves.toMatchObject({ actualValue: 'after-rerender' });
  } finally {
    if (context) await browser.close(context).catch(() => undefined);
    await client.close();
  }
}, 30_000);

test.skipIf(!runIntegration)('awaits Zone.js promises and refuses pointer input after a view swap', async () => {
  const client = new BidiClient(process.env.FIREFOX_BIDI_URL ?? 'ws://127.0.0.1:9222/session');
  const browser = new ZenBrowser(client);
  let context: string | undefined;
  try {
    const reference = (await browser.contexts())[0];
    if (!reference) throw new Error('Firefox has no browsing context to use as a reference');
    // Zone.js replaces window.Promise with a non-native thenable class, which Firefox's awaitPromise does not follow.
    const html = `<!doctype html><script>
      const Native = Promise;
      window.Promise = class ZoneAwarePromise { constructor(fn) { this.p = new Native(fn); } then(a, b) { return this.p.then(a, b); } };
    </script><main><button class="option" onclick="window.clicks = (window.clicks ?? 0) + 1">A</button></main>`;
    context = (await browser.open(`data:text/html,${encodeURIComponent(html)}`, reference.id)).id;

    // Page-side timers keep the promise pending across the BiDi round trip; an already-settled value would not prove awaiting.
    expect(await browser.evaluateValue(context, 'new Promise(resolve => setTimeout(() => resolve(42), 50))')).toBe(42);
    expect(await browser.evaluateValue(context, 'var zoneProbe = 6; zoneProbe * 7')).toBe(42);
    await browser.evaluateValue(context, "setTimeout(() => document.querySelector('main').insertAdjacentHTML('beforeend', '<p id=late>late</p>'), 100), true");
    await expect(browser.waitFor(context, '#late', 2_000)).resolves.toBeUndefined();

    const resolved = await browser.resolveLocator(context, { css: '.option' });
    await browser.evaluateValue(context, "document.querySelector('.option').textContent = 'B', true");
    await expect(browser.click(context, resolved.selector, resolved.identity)).rejects.toThrow('Target changed');
    await browser.evaluateValue(context, "document.querySelector('main').insertAdjacentHTML('beforeend', '<button class=option>A</button>'), true");
    await expect(browser.click(context, resolved.selector, resolved.identity)).rejects.toThrow('found 2');
    expect(await browser.evaluateValue(context, 'window.clicks ?? 0')).toBe(0);
  } finally {
    if (context) await browser.close(context).catch(() => undefined);
    await client.close();
  }
}, 30_000);
