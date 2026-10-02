import { type BidiTransport, type BidiEvent, type JsonObject } from './bidi.ts';
import { detectCapabilities, type DetectedCapabilities } from './capabilities.ts';
import { documentFrame, resolveLocator, semanticFunctions, type ElementIdentity, type FrameRef, type Locator, type ResolvedLocator } from './locator.ts';
import { RouteManager, type RouteDefinition } from './routes.ts';

export type Context = {
  id: string;
  url: string;
  title?: string;
  parent: string | null;
};

export class ZenEmptyTabContextFilter {
  #initialized = false;
  #internal = new Set<string>();

  visible(contexts: Context[]): Context[] {
    if (!this.#initialized) {
      this.#initialized = true;
      for (const context of contexts) {
        if (context.url === 'about:blank' && !context.title) this.#internal.add(context.id);
      }
    }

    const present = new Set(contexts.map((context) => context.id));
    for (const context of this.#internal) if (!present.has(context)) this.#internal.delete(context);
    return contexts.filter((context) => !this.#internal.has(context.id));
  }
}

export type ScreenshotOptions = { fullPage?: boolean; selector?: string };
export type TextEntryResult = { requestedValue: string; actualValue: string; focused: boolean; replaced: boolean };
export type OpenResult = { context: Context; created: true; navigationStarted: boolean; error?: string };
export type PageChangeResult = { type: 'navigation' | 'dom'; changedCharacters?: number; changedElements?: number };
export type PageSummary = { heading: string | null; text: string };
export type FieldState = {
  selector: string;
  tag: string;
  type: string | null;
  value: string | boolean | null;
  editable: boolean;
  disabled: boolean;
  readOnly: boolean;
  visible: boolean;
  covered: boolean;
  coveredBy: string | null;
  inViewport: boolean;
  required: boolean;
  autocomplete: string | null;
  inputMode: string | null;
  contentEditable: boolean;
  invalid: boolean;
  label: string | null;
  helpText: string | null;
  documentId: string;
  bounds: { x: number; y: number; width: number; height: number };
};
export class PageEvaluationError extends Error {
  constructor(readonly details: { expression: string; message: string; line?: number; column?: number; stack?: unknown }) {
    super(details.message);
  }
}

export class ZenBrowser {
  #routes: RouteManager;
  #capabilities?: Promise<DetectedCapabilities>;

  constructor(readonly bidi: BidiTransport) {
    this.#routes = new RouteManager(bidi);
  }

  async capabilities(): Promise<DetectedCapabilities> {
    return await (this.#capabilities ??= detectCapabilities(this.bidi));
  }

  async requireFeature(feature: keyof Omit<DetectedCapabilities, 'diagnostics'>): Promise<void> {
    if (!(await this.capabilities())[feature]) throw new Error(`Feature unavailable in this Zen/Firefox build: ${feature}`);
  }

  onEvent(listener: (event: BidiEvent) => void): () => void {
    return this.bidi.onEvent(listener);
  }

  async subscribe(events: string[], contexts?: string[]): Promise<void> {
    await this.bidi.subscribe(events, contexts);
  }

  async unsubscribe(events: string[], contexts?: string[]): Promise<void> {
    await this.bidi.unsubscribe(events, contexts);
  }

  async contexts(): Promise<Context[]> {
    const result = await this.bidi.command('browsingContext.getTree', { maxDepth: 16 });
    const contexts = flattenContexts(result.contexts);
    return await Promise.all(contexts.map(async (context) => {
      try {
        const title = await this.evaluate(context.id, 'document.title');
        const remote = title.result as JsonObject | undefined;
        return { ...context, title: typeof remote?.value === 'string' ? remote.value : undefined };
      } catch {
        return context;
      }
    }));
  }

  async frames(context: string): Promise<FrameRef[]> {
    const contexts = await this.contexts();
    return await Promise.all(contexts.filter((candidate) => candidate.id === context || isDescendant(candidate, context, contexts)).map((candidate) => documentFrame(this.evaluateValue.bind(this), candidate.id)));
  }

  async target(titleOrUrl: string): Promise<Context> {
    const contexts = await this.contexts();
    const matches = contexts.filter((context) =>
      context.url.includes(titleOrUrl) || context.title?.includes(titleOrUrl),
    );
    if (matches.length !== 1) {
      const available = contexts.map(({ title, url }) => title ? `${title} (${url})` : url).join(', ');
      throw new Error(`Expected one tab matching ${JSON.stringify(titleOrUrl)}, found ${matches.length}. Available: ${available}`);
    }
    return matches[0]!;
  }

  async activate(context: string): Promise<void> {
    await this.bidi.command('browsingContext.activate', { context });
  }

  async open(url = 'about:blank', referenceContext?: string): Promise<Context> {
    const result = await this.openWithOutcome(url, referenceContext);
    if (result.error) throw new Error(result.error);
    return result.context;
  }

  async openWithOutcome(url = 'about:blank', referenceContext?: string): Promise<OpenResult> {
    const result = await this.bidi.command('browsingContext.create', {
      type: 'tab',
      background: false,
      ...(referenceContext ? { referenceContext } : {}),
    });
    if (typeof result.context !== 'string') throw new Error('Firefox did not return a browsing-context ID');
    const context: Context = { id: result.context, url: 'about:blank', parent: null };
    if (url === 'about:blank') return { context, created: true, navigationStarted: false };
    try {
      await this.navigate(context.id, url);
      return { context: { ...context, url }, created: true, navigationStarted: true };
    } catch (error) {
      const observedUrl = await this.url(context.id).catch(() => 'about:blank');
      return {
        context: { ...context, url: observedUrl },
        created: true,
        navigationStarted: observedUrl !== 'about:blank',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async close(context: string): Promise<void> {
    await this.bidi.command('browsingContext.close', { context });
  }

  async navigate(context: string, url: string): Promise<void> {
    await this.bidi.command('browsingContext.navigate', { context, url, wait: 'complete' });
  }

  async reload(context: string): Promise<void> {
    await this.navigate(context, await this.url(context));
  }

  async traverseHistory(context: string, delta: number): Promise<void> {
    await this.bidi.command('browsingContext.traverseHistory', { context, delta });
  }

  async handlePrompt(context: string, accept: boolean, userText?: string): Promise<void> {
    await this.bidi.command('browsingContext.handleUserPrompt', {
      context,
      accept,
      ...(userText === undefined ? {} : { userText }),
    });
  }

  async screenshot(context: string, options: ScreenshotOptions = {}): Promise<string> {
    const result = await this.bidi.command('browsingContext.captureScreenshot', {
      context,
      ...(options.fullPage || options.selector ? { origin: 'document' } : {}),
      ...(options.selector ? { clip: await this.clip(context, options.selector) } : {}),
    });
    if (typeof result.data !== 'string') throw new Error('Firefox did not return screenshot data');
    return result.data;
  }

  async evaluate(context: string, expression: string, timeoutMs?: number): Promise<JsonObject> {
    // Firefox's awaitPromise only awaits native promises; Zone.js (Angular) replaces window.Promise, so
    // `new Promise(...)` results would come back unresolved. An async function always returns a native
    // promise and `await` follows any thenable. Statement sequences cannot be wrapped and run as-is.
    const wrapped = asAwaitedExpression(expression);
    const result = await this.bidi.command('script.evaluate', {
      expression: wrapped ?? expression,
      target: { context },
      awaitPromise: true,
      resultOwnership: 'root',
    }, timeoutMs);
    if (result.type === 'exception') {
      const exception = result.exceptionDetails as JsonObject | undefined;
      const text = typeof exception?.text === 'string' ? exception.text : 'Page evaluation failed';
      const line = typeof exception?.lineNumber === 'number' ? exception.lineNumber : undefined;
      throw new PageEvaluationError({
        expression: expression.length > EXPRESSION_PREVIEW_LENGTH ? `${expression.slice(0, EXPRESSION_PREVIEW_LENGTH)}…` : expression,
        message: text,
        line: line !== undefined && wrapped !== undefined ? Math.max(0, line - 1) : line,
        column: typeof exception?.columnNumber === 'number' ? exception.columnNumber : undefined,
        stack: exception?.stackTrace,
      });
    }
    return result;
  }

  async evaluateValue(context: string, expression: string, timeoutMs?: number): Promise<unknown> {
    const result = await this.evaluate(context, expression, timeoutMs);
    return deserializeRemoteValue(result.result as JsonObject | undefined);
  }

  async url(context: string): Promise<string> {
    const value = await this.evaluateValue(context, 'location.href');
    if (typeof value !== 'string') throw new Error('Firefox did not return the current URL');
    return value;
  }

  async waitForEvent(context: string, methods: string[], timeoutMs = 10_000): Promise<BidiEvent> {
    await this.subscribe(methods, [context]);
    const deferred = Promise.withResolvers<BidiEvent>();
    const timer = setTimeout(() => deferred.reject(new Error(`Timed out waiting for ${methods.join(', ')}`)), timeoutMs);
    const stop = this.onEvent((event) => {
      if (methods.includes(event.method) && event.params.context === context) deferred.resolve(event);
    });
    try {
      return await deferred.promise;
    } finally {
      clearTimeout(timer);
      stop();
      await this.unsubscribe(methods, [context]).catch(() => undefined);
    }
  }

  async waitFor(context: string, selector: string, timeoutMs = 10_000): Promise<void> {
    const visible = await this.evaluateValue(context, `new Promise((resolve, reject) => {
      const ready = () => {
        const element = (() => { let root = document; let element; for (const part of __SELECTOR__.split('>>>').map(part => part.trim())) { element = root.querySelector(part); if (!element) return null; root = element.shadowRoot ?? element; } return element; })();
        return Boolean(element?.getClientRects().length && getComputedStyle(element).visibility !== 'hidden');
      };
      if (ready()) return resolve(true);
      const observer = new MutationObserver(() => { if (ready()) { observer.disconnect(); clearTimeout(timer); resolve(true); } });
      const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Timed out waiting for selector')); }, ${'__TIMEOUT__'});
      observer.observe(document, { childList: true, subtree: true, attributes: true });
    })`.replace('__SELECTOR__', JSON.stringify(selector)).replace('__TIMEOUT__', String(timeoutMs)), timeoutMs + IN_PAGE_WAIT_MARGIN_MS);
    if (visible !== true) throw new Error(`Timed out waiting for ${JSON.stringify(selector)}`);
  }

  async waitForText(context: string, text: string, timeoutMs = 10_000): Promise<void> {
    const found = await this.evaluateValue(context, `new Promise((resolve, reject) => {
      const ready = () => document.body?.innerText?.includes(${JSON.stringify(text)}) ?? false;
      if (ready()) return resolve(true);
      let observer;
      let poll;
      const finish = () => { observer?.disconnect(); clearInterval(poll); clearTimeout(timeout); resolve(true); };
      const timeout = setTimeout(() => { observer?.disconnect(); clearInterval(poll); reject(new Error('Timed out waiting for text')); }, ${timeoutMs});
      observer = new MutationObserver(() => { if (ready()) finish(); });
      poll = setInterval(() => { if (ready()) finish(); }, 25);
      observer.observe(document, { childList: true, subtree: true, characterData: true, attributes: true });
    })`, timeoutMs + IN_PAGE_WAIT_MARGIN_MS);
    if (found !== true) throw new Error(`Timed out waiting for text ${JSON.stringify(text)}`);
  }

  async waitForDocumentChange(context: string, previous: string, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ((await documentFrame(this.evaluateValue.bind(this), context)).documentId !== previous) return;
      await Bun.sleep(25);
    }
    throw new Error('Timed out waiting for document to change');
  }

  async waitForPageIdle(context: string, idleMs: number, timeoutMs = 10_000): Promise<void> {
    const settled = await this.evaluateValue(context, `new Promise((resolve, reject) => {
      let observer;
      let idleTimer;
      const finish = () => { observer?.disconnect(); clearTimeout(idleTimer); clearTimeout(timeout); resolve(true); };
      const timeout = setTimeout(() => { observer?.disconnect(); clearTimeout(idleTimer); reject(new Error('Timed out waiting for page idle')); }, ${timeoutMs});
      observer = new MutationObserver(() => { clearTimeout(idleTimer); idleTimer = setTimeout(finish, ${idleMs}); });
      idleTimer = setTimeout(finish, ${idleMs});
      observer.observe(document, { childList: true, subtree: true, characterData: true, attributes: true });
    })`, timeoutMs + IN_PAGE_WAIT_MARGIN_MS);
    if (settled !== true) throw new Error('Timed out waiting for page idle');
  }

  async waitForPageChange(context: string, timeoutMs = 10_000): Promise<PageChangeResult> {
    const lifecycleEvents = ['browsingContext.navigationStarted', 'browsingContext.domContentLoaded', 'browsingContext.load'];
    let navigationStarted = false;
    const stop = this.onEvent((event) => {
      if (lifecycleEvents.includes(event.method) && event.params.context === context) navigationStarted = true;
    });
    await this.subscribe(lifecycleEvents, [context]);
    try {
      let previous = await this.#pageChangeSnapshot(context);
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (navigationStarted) return { type: 'navigation' };
        await Bun.sleep(Math.max(0, Math.min(100, deadline - Date.now())));
        if (navigationStarted) return { type: 'navigation' };
        let current;
        try {
          current = await this.#pageChangeSnapshot(context);
        } catch (error) {
          if (navigationStarted) return { type: 'navigation' };
          throw error;
        }
        if (current.documentId !== previous.documentId || current.url !== previous.url) return { type: 'navigation' };
        const changedCharacters = changedCharacterCount(previous.text, current.text);
        const changedElements = Math.abs(previous.elementCount - current.elementCount);
        if (changedCharacters >= 24 || changedElements >= 3) {
          return { type: 'dom', ...(changedCharacters ? { changedCharacters } : {}), ...(changedElements ? { changedElements } : {}) };
        }
        previous = current;
      }
      throw new Error('Timed out waiting for a significant page change');
    } finally {
      stop();
      await this.unsubscribe(lifecycleEvents, [context]).catch(() => undefined);
    }
  }

  async #pageChangeSnapshot(context: string): Promise<{ url: string; documentId: string; text: string; elementCount: number }> {
    const value = await this.evaluateValue(context, `(() => {
      const root = document.querySelector('main,[role="main"],#app,#root') ?? document.body;
      return {
        url: location.href,
        documentId: location.href + '\\u0000' + performance.timeOrigin,
        text: root?.innerText ?? '',
        elementCount: root?.querySelectorAll('*').length ?? 0,
      };
    })()`);
    if (!value || typeof value !== 'object' || !('url' in value) || !('documentId' in value) || !('text' in value) || !('elementCount' in value)
      || typeof value.url !== 'string' || typeof value.documentId !== 'string' || typeof value.text !== 'string' || typeof value.elementCount !== 'number') {
      throw new Error('Firefox did not return a page-change snapshot');
    }
    return { url: value.url, documentId: value.documentId, text: value.text, elementCount: value.elementCount };
  }

  // Enough of the primary content to classify a wake-up (new view, in-place refresh, navigation) without another call.
  async pageSummary(context: string): Promise<PageSummary> {
    const value = await this.evaluateValue(context, `(() => {
      const root = document.querySelector('main,[role="main"],#app,#root') ?? document.body;
      const heading = [...document.querySelectorAll('h1')].find(element => element.getClientRects().length);
      return {
        heading: heading ? heading.innerText.trim().replace(/\\s+/g, ' ') || null : null,
        text: (root?.innerText ?? '').trim().replace(/\\s+/g, ' ').slice(0, ${PAGE_SUMMARY_TEXT_LENGTH}),
      };
    })()`);
    if (!value || typeof value !== 'object' || !('heading' in value) || !('text' in value) || typeof value.text !== 'string' || (value.heading !== null && typeof value.heading !== 'string')) {
      throw new Error('Firefox did not return a page summary');
    }
    return { heading: value.heading, text: value.text };
  }

  async waitForUrl(context: string, expected: string, timeoutMs = 10_000): Promise<void> {
    await this.#waitForLifecycle(context, (url) => url.includes(expected), `URL containing ${JSON.stringify(expected)}`, timeoutMs);
  }

  async waitForUrlChange(context: string, previous: string, timeoutMs = 10_000): Promise<void> {
    await this.#waitForLifecycle(context, (url) => url !== previous, `URL to change from ${JSON.stringify(previous)}`, timeoutMs);
  }

  async #waitForLifecycle(context: string, predicate: (url: string) => boolean, description: string, timeoutMs: number): Promise<void> {
    if (predicate(await this.url(context))) return;
    const events = ['browsingContext.navigationStarted', 'browsingContext.domContentLoaded', 'browsingContext.load'];
    await this.subscribe(events, [context]);
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        let timer: Timer | undefined;
        let poll: Timer | undefined;
        let stop: (() => void) | undefined;
        const settle = (error?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          clearInterval(poll);
          stop?.();
          if (error) reject(error); else resolve();
        };
        const check = (url: unknown) => {
          if (typeof url === 'string' && predicate(url)) settle();
        };
        timer = setTimeout(() => settle(new Error(`Timed out waiting for ${description}`)), timeoutMs);
        stop = this.onEvent((event) => {
          if (event.params.context === context) check(event.params.url);
        });
        void this.url(context).then(check, (error: unknown) => settle(error instanceof Error ? error : new Error(String(error))));
        poll = setInterval(() => {
          void this.url(context).then(check, (error: unknown) => settle(error instanceof Error ? error : new Error(String(error))));
        }, 25);
      });
    } finally { await this.unsubscribe(events, [context]).catch(() => undefined); }
  }

  async click(context: string, selector: string, expected?: ElementIdentity): Promise<ElementIdentity> {
    return await this.#aim(context, selector, 'click', 0, 0, expected);
  }

  async doubleClick(context: string, selector: string, expected?: ElementIdentity): Promise<ElementIdentity> {
    return await this.#aim(context, selector, 'doubleClick', 0, 0, expected);
  }

  async rightClick(context: string, selector: string, expected?: ElementIdentity): Promise<ElementIdentity> {
    return await this.#aim(context, selector, 'rightClick', 0, 0, expected);
  }

  async hover(context: string, selector: string, expected?: ElementIdentity): Promise<ElementIdentity> {
    return await this.#aim(context, selector, 'hover', 0, 0, expected);
  }

  async drag(context: string, source: string, destination: string, expected?: ElementIdentity): Promise<ElementIdentity> {
    const from = await this.coordinates(context, source, expected);
    const to = await this.coordinates(context, destination);
    await this.bidi.command('input.performActions', {
      context,
      actions: [{
        type: 'pointer',
        id: 'mouse',
        parameters: { pointerType: 'mouse' },
        actions: [
          { type: 'pointerMove', origin: 'viewport', x: from.x, y: from.y },
          { type: 'pointerDown', button: 0 },
          { type: 'pointerMove', origin: 'viewport', x: to.x, y: to.y, duration: 250 },
          { type: 'pointerUp', button: 0 },
        ],
      }],
    });
    return from.identity;
  }

  // `up` releases in place and targets nothing; every other action returns the identity it was aimed at.
  async pointer(context: string, selector: string, action: 'down' | 'move' | 'up' | 'click' | 'doubleClick' | 'rightClick' | 'hover', x = 0, y = 0, expected?: ElementIdentity): Promise<ElementIdentity | undefined> {
    if (action !== 'up') return await this.#aim(context, selector, action, x, y, expected);
    await this.bidi.command('input.performActions', {
      context,
      actions: [{ type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' }, actions: [{ type: 'pointerUp', button: 0 }] }],
    });
    return undefined;
  }

  async #aim(context: string, selector: string, action: 'down' | 'move' | 'click' | 'doubleClick' | 'rightClick' | 'hover', x: number, y: number, expected?: ElementIdentity): Promise<ElementIdentity> {
    const point = await this.coordinates(context, selector, expected);
    const move = { type: 'pointerMove', origin: 'viewport', x: point.x + x, y: point.y + y };
    const leftClick = [{ type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 }];
    const actions = action === 'click'
      ? [move, ...leftClick]
      : action === 'doubleClick'
        ? [move, ...leftClick, ...leftClick]
        : action === 'rightClick'
          ? [move, { type: 'pointerDown', button: 2 }, { type: 'pointerUp', button: 2 }]
          : action === 'down'
            ? [move, { type: 'pointerDown', button: 0 }]
            : [move];
    await this.bidi.command('input.performActions', {
      context,
      actions: [{ type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' }, actions }],
    });
    return point.identity;
  }

  async fill(context: string, selector: string, value: string): Promise<TextEntryResult> {
    return await this.#enterText(context, selector, value, true);
  }

  async type(context: string, selector: string | undefined, text: string): Promise<TextEntryResult | undefined> {
    if (selector) return await this.#enterText(context, selector, text, false);
    await this.bidi.command('input.performActions', {
      context,
      actions: [{
        type: 'key',
        id: 'keyboard',
        actions: Array.from(text).flatMap((value) => [
          { type: 'keyDown', value },
          { type: 'keyUp', value },
        ]),
      }],
    });
    return undefined;
  }

  async #enterText(context: string, selector: string, text: string, replace: boolean): Promise<TextEntryResult> {
    const editable = await this.#withElement(context, selector, 'element => (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element.isContentEditable) && !element.disabled && !element.readOnly');
    if (editable !== true) throw new Error(`Target is not an editable text control; inspect again: ${JSON.stringify(selector)}`);
    await this.pointer(context, selector, 'click');
    const focused = await this.#withElement(context, selector, 'element => { element.focus(); return document.activeElement === element; }');
    if (focused !== true) throw new Error(`Text target did not receive focus: ${JSON.stringify(selector)}`);
    const valueBefore = await this.#withElement(context, selector, 'element => element.value ?? element.textContent ?? ""');
    if (typeof valueBefore !== 'string') throw new Error(`Firefox did not return a text value for ${JSON.stringify(selector)}`);
    const keys = replace
      ? [
        { type: 'keyDown' as const, value: '\uE009' },
        { type: 'keyDown' as const, value: 'a' },
        { type: 'keyUp' as const, value: 'a' },
        { type: 'keyUp' as const, value: '\uE009' },
        { type: 'keyDown' as const, value: '\uE003' },
        { type: 'keyUp' as const, value: '\uE003' },
      ]
      : [];
    await this.bidi.command('input.performActions', {
      context,
      actions: [{
        type: 'key',
        id: 'keyboard',
        actions: [...keys, ...Array.from(text).flatMap((value) => [{ type: 'keyDown' as const, value }, { type: 'keyUp' as const, value }])],
      }],
    });
    await this.evaluateValue(context, 'new Promise(resolve => requestAnimationFrame(() => queueMicrotask(() => resolve(true))))');
    const actualValue = await this.#withElement(context, selector, 'element => element.value ?? element.textContent ?? ""');
    if (typeof actualValue !== 'string') throw new Error(`Firefox did not return a text value for ${JSON.stringify(selector)}`);
    const requestedValue = replace ? text : valueBefore + text;
    if (actualValue !== requestedValue) {
      throw new Error(`Page cleared or changed the entered value after native input for ${JSON.stringify(selector)}: expected ${JSON.stringify(requestedValue)}, received ${JSON.stringify(actualValue)}`);
    }
    return { requestedValue, actualValue, focused: true, replaced: replace };
  }

  async press(context: string, key: string, selector?: string): Promise<void> {
    if (selector) await this.coordinates(context, selector);
    if (selector) await this.#withElement(context, selector, 'element => element.focus()');
    await this.bidi.command('input.performActions', {
      context,
      actions: [{ type: 'key', id: 'keyboard', actions: chordActions(key) }],
    });
  }

  async scroll(context: string, dx: number, dy: number): Promise<void> {
    await this.evaluate(context, `window.scrollBy(${dx}, ${dy})`);
  }

  async select(context: string, selector: string, value: string): Promise<void> {
    await this.coordinates(context, selector);
    const index = await this.#withElement(context, selector, `element => {
      if (!(element instanceof HTMLSelectElement)) throw new Error('Target is not a select element');
      const index = [...element.options].findIndex(option => option.value === ${JSON.stringify(value)} || option.text.trim() === ${JSON.stringify(value)});
      if (index < 0) throw new Error('No option has the requested value or visible text');
      element.focus();
      return index;
    }`);
    if (typeof index !== 'number') throw new Error(`Firefox did not return an option index for ${JSON.stringify(selector)}`);
    await this.bidi.command('input.performActions', {
      context,
      actions: [{
        type: 'key',
        id: 'keyboard',
        actions: [
          { type: 'keyDown', value: '\uE011' },
          { type: 'keyUp', value: '\uE011' },
          ...Array.from({ length: index }).flatMap(() => [{ type: 'keyDown', value: '\uE015' }, { type: 'keyUp', value: '\uE015' }]),
        ],
      }],
    });
    const selected = await this.#withElement(context, selector, 'element => element instanceof HTMLSelectElement ? element.selectedIndex : undefined');
    if (selected !== index) throw new Error(`Native selection did not update ${JSON.stringify(selector)}`);
  }

  async scrollIntoView(context: string, selector: string): Promise<void> {
    await this.#withElement(context, selector, 'element => element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" })');
  }

  async fieldState(context: string, selector: string): Promise<FieldState> {
    const state = await this.evaluateValue(context, `(() => {
      let root = document;
      let element;
      for (const part of ${JSON.stringify(selector.split('>>>').map((part) => part.trim()))}) {
        element = root.querySelector(part);
        if (!element) throw new Error('No element matches ' + ${JSON.stringify(selector)});
        root = element.shadowRoot ?? element;
      }
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const x = Math.round(rect.left + rect.width / 2);
      const y = Math.round(rect.top + rect.height / 2);
      const hit = rect.width > 0 && rect.height > 0 ? document.elementFromPoint(x, y) : null;
      const input = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element : null;
      const label = input?.labels?.length ? [...input.labels].map(item => (item.innerText || item.textContent || '').trim()).filter(Boolean).join(' ') : element.getAttribute('aria-label');
      const describedBy = element.getAttribute('aria-describedby');
      const helpText = describedBy ? describedBy.split(/\\s+/).map(id => document.getElementById(id)?.textContent?.trim() || '').filter(Boolean).join(' ') : null;
      const secret = input?.type === 'password';
      const value = input?.type === 'checkbox' || input?.type === 'radio' ? input.checked : secret ? '[REDACTED]' : input?.value ?? (element.isContentEditable ? element.textContent ?? '' : null);
      return {
        selector: ${JSON.stringify(selector)},
        tag: element.tagName.toLowerCase(),
        type: input?.type ?? null,
        value,
        editable: Boolean((input || element.isContentEditable) && !input?.disabled && !input?.readOnly),
        disabled: Boolean(input?.disabled || element.getAttribute('aria-disabled') === 'true'),
        readOnly: Boolean(input?.readOnly),
        visible: Boolean(element.getClientRects().length && style.visibility !== 'hidden' && style.display !== 'none'),
        covered: Boolean(hit && hit !== element && !element.contains(hit) && !hit.contains(element)),
        coveredBy: hit && hit !== element && !element.contains(hit) && !hit.contains(element)
          ? hit.id ? '#' + CSS.escape(hit.id) : hit.getAttribute('data-testid') ? '[data-testid="' + CSS.escape(hit.getAttribute('data-testid')) + '"]' : hit.tagName.toLowerCase()
          : null,
        inViewport: rect.top >= 0 && rect.left >= 0 && rect.bottom <= innerHeight && rect.right <= innerWidth,
        required: Boolean(input?.required || element.getAttribute('aria-required') === 'true'),
        autocomplete: input?.autocomplete || null,
        inputMode: input?.inputMode || null,
        contentEditable: element.isContentEditable,
        invalid: Boolean(element.getAttribute('aria-invalid') === 'true' || (input && !input.checkValidity())),
        label: label || null,
        helpText,
        documentId: location.href + '\\u0000' + performance.timeOrigin,
        bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      };
    })()`);
    if (!state || typeof state !== 'object') throw new Error(`Firefox returned malformed field state for ${JSON.stringify(selector)}`);
    return state as FieldState;
  }

  async dismissTransientHint(context: string, selector: string): Promise<{ dismissed: boolean; tooltip: string | null }> {
    const result = await this.evaluateValue(context, `(() => {
      let root = document;
      let field;
      for (const part of ${JSON.stringify(selector.split('>>>').map((part) => part.trim()))}) {
        field = root.querySelector(part);
        if (!field) throw new Error('No element matches ' + ${JSON.stringify(selector)});
        root = field.shadowRoot ?? field;
      }
      const ids = ['aria-describedby', 'aria-errormessage', 'aria-controls'].flatMap(name => (field.getAttribute(name) || '').split(/\\s+/).filter(Boolean));
      const tooltip = ids.map(id => document.getElementById(id)).find(candidate => candidate && candidate.getClientRects().length && !candidate.closest('[role="dialog"], [aria-modal="true"]') && !candidate.querySelector('button,input,select,textarea,[role="button"]'));
      if (!tooltip) return { dismissed: false, tooltip: null };
      field.blur();
      return new Promise(resolve => setTimeout(() => resolve({
        dismissed: !tooltip.getClientRects().length || getComputedStyle(tooltip).visibility === 'hidden' || getComputedStyle(tooltip).display === 'none',
        tooltip: tooltip.id ? '#' + CSS.escape(tooltip.id) : tooltip.getAttribute('role') === 'tooltip' ? '[role="tooltip"]' : tooltip.tagName.toLowerCase(),
      }), 150));
    })()`);
    if (!result || typeof result !== 'object') throw new Error(`Firefox returned malformed transient-hint state for ${JSON.stringify(selector)}`);
    return result as { dismissed: boolean; tooltip: string | null };
  }

  async check(context: string, selector: string, checked: boolean): Promise<void> {
    const current = await this.#withElement(context, selector, `element => {
      if (element.tagName !== 'INPUT' || !['checkbox', 'radio'].includes(element.type)) throw new Error('Target is not a checkable input');
      return element.checked;
    }`);
    if (current === checked) return;
    const useLabel = await this.#withElement(context, selector, `element => {
      const label = element.labels?.[0] || element.closest('label');
      if (!label) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (!element.getClientRects().length || rect.width <= 0 || rect.height <= 0 || style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return true;
      const hit = document.elementFromPoint(Math.round(rect.left + rect.width / 2), Math.round(rect.top + rect.height / 2));
      return !hit || (hit !== element && !element.contains(hit));
    }`);
    if (useLabel === true) {
      const observed = await this.#withElement(context, selector, `element => {
        const label = element.labels?.[0] || element.closest('label');
        if (!label) throw new Error('Hidden checkable input has no associated visible label');
        label.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        if (!label.getClientRects().length) throw new Error('Associated label is not visible');
        const rect = label.getBoundingClientRect();
        const hit = document.elementFromPoint(Math.round(rect.left + rect.width / 2), Math.round(rect.top + rect.height / 2));
        if (!hit || (hit !== label && !label.contains(hit) && !hit.contains(label))) throw new Error('Associated label is covered by another element');
        label.click();
        return element.checked;
      }`);
      if (observed !== checked) throw new Error(`Check state did not update for ${JSON.stringify(selector)}`);
      return;
    }
    await this.click(context, selector);
    const observed = await this.#withElement(context, selector, 'element => element.checked');
    if (observed !== checked) throw new Error(`Check state did not update for ${JSON.stringify(selector)}`);
  }

  async submitForm(context: string, selector: string): Promise<void> {
    const submitted = await this.#withElement(context, selector, `element => {
      const form = element instanceof HTMLFormElement ? element : element.form || element.closest('form');
      if (!(form instanceof HTMLFormElement)) throw new Error('Submit target is not associated with a form');
      if (typeof form.requestSubmit === 'function') {
        const submitter = element instanceof HTMLButtonElement || element instanceof HTMLInputElement ? element : undefined;
        form.requestSubmit(submitter);
      } else {
        const submitter = element instanceof HTMLElement ? element : form.querySelector('button[type=submit],input[type=submit]');
        if (!(submitter instanceof HTMLElement)) throw new Error('Form has no usable submit control');
        submitter.click();
      }
      return true;
    }`);
    if (submitted !== true) throw new Error(`Form submission did not start for ${JSON.stringify(selector)}`);
  }

  async upload(context: string, selector: string, files: string[]): Promise<void> {
    const element = await this.#element(context, selector);
    await this.bidi.command('input.setFiles', { context, element, files });
  }

  async createUserContext(): Promise<string> {
    await this.requireFeature('browserUserContexts');
    const result = await this.bidi.commandOptional('browser.createUserContext');
    if (typeof result.userContext !== 'string') throw new Error('Firefox did not return a user-context ID');
    return result.userContext;
  }

  async removeUserContext(userContext: string): Promise<void> {
    await this.requireFeature('browserUserContexts');
    await this.bidi.commandOptional('browser.removeUserContext', { userContext });
  }

  async openInUserContext(url: string, referenceContext: string, userContext: string): Promise<Context> {
    await this.requireFeature('browserUserContexts');
    const result = await this.bidi.commandOptional('browsingContext.create', { type: 'tab', background: false, referenceContext, userContext });
    if (typeof result.context !== 'string') throw new Error('Firefox did not return a browsing-context ID');
    await this.navigate(result.context, url);
    return { id: result.context, url, parent: null };
  }

  async storageExport(userContext: string): Promise<unknown> {
    await this.requireFeature('storage');
    return await this.bidi.commandOptional('storage.getCookies', { partition: { type: 'storageKey', userContext } });
  }


  async resetEmulation(context: string): Promise<void> {
    await this.requireFeature('emulation');
    await this.bidi.commandOptional('emulation.setViewport', { context, viewport: null });
  }

  async resetPermission(context: string, name: string): Promise<void> {
    await this.requireFeature('permissions');
    await this.bidi.commandOptional('permissions.setPermission', { descriptor: { name }, state: 'prompt', origin: await this.url(context) });
  }
  async emulate(context: string, options: JsonObject): Promise<void> {
    await this.requireFeature('emulation');
    await this.bidi.commandOptional('emulation.setViewport', { context, ...options });
  }

  async setPermission(context: string, name: string, state: string): Promise<void> {
    await this.requireFeature('permissions');
    await this.bidi.commandOptional('permissions.setPermission', { descriptor: { name }, state, origin: await this.url(context) });
  }

  async addRoute(route: RouteDefinition): Promise<string> {
    await this.requireFeature('networkInterception');
    return await this.#routes.add(route);
  }

  async storageImport(userContext: string, cookies: unknown): Promise<void> {
    await this.requireFeature('storage');
    if (!Array.isArray(cookies)) throw new Error('State file contains malformed cookies');
    for (const cookie of cookies) {
      if (!cookie || typeof cookie !== 'object' || Array.isArray(cookie)) throw new Error('State file contains a malformed cookie');
      await this.bidi.commandOptional('storage.setCookie', { cookie, partition: { type: 'storageKey', userContext } });
    }
  }

  async removeRoute(intercept: string): Promise<void> {
    await this.requireFeature('networkInterception');
    await this.#routes.remove(intercept);
  }

  routes(): Array<{ intercept: string; route: RouteDefinition }> {
    return this.#routes.list();
  }

  async accessibilityFindings(context: string): Promise<unknown> {
    return await this.evaluateValue(context, `(() => {
      const text = element => (element.innerText || element.textContent || '').trim().replace(/\\s+/g, ' ');
      const role = element => element.getAttribute('role') || (element.matches('a[href]') ? 'link' : element.matches('button') ? 'button' : element.matches('input[type=checkbox]') ? 'checkbox' : null);
      const name = element => element.getAttribute('aria-label') || text(element) || null;
      const visible = element => element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden';
      const interactive = [...document.querySelectorAll('*')].filter(element => visible(element) && (role(element) || element.tabIndex >= 0 || element.matches('[onclick],[onpointerdown]')));
      const findings = interactive.flatMap(element => {
        const result = [];
        const currentRole = role(element); const currentName = name(element);
        if (currentRole && !currentName) result.push({ kind: 'unnamed-interactive-control', role: currentRole });
        if ((element.disabled || element.getAttribute('aria-disabled') === 'true') && element.matches('[onclick],[onpointerdown]')) result.push({ kind: 'disabled-control-with-click-handler', role: currentRole, name: currentName });
        if (!currentRole && element.tabIndex < 0 && getComputedStyle(element).cursor === 'pointer') result.push({ kind: 'visible-pointer-only-control', name: currentName });
        return result;
      });
      const groups = new Map();
      for (const element of interactive) { const landmark = element.closest('main,nav,aside,header,footer,[role]'); const key = [landmark?.tagName, landmark?.getAttribute('role'), role(element), name(element)].join('|'); groups.set(key, (groups.get(key) ?? 0) + 1); }
      for (const [key, count] of groups) if (count > 1) findings.push({ kind: 'duplicate-role-name-in-landmark', key, count });
      return findings;
    })()`);
  }

  async #withElement(context: string, selector: string, functionDeclaration: string): Promise<unknown> {
    const element = await this.#element(context, selector);
    const result = await this.bidi.command('script.callFunction', {
      functionDeclaration,
      target: { context },
      awaitPromise: true,
      arguments: [element],
    });
    if (result.type === 'exception') throw new Error(`Element operation failed: ${JSON.stringify(result.exceptionDetails)}`);
    const remote = result.result as JsonObject | undefined;
    return remote?.value;
  }

  async resolveLocator(context: string, locator: Locator): Promise<ResolvedLocator> {
    return await resolveLocator(this.evaluateValue.bind(this), context, locator);
  }

  async locator(context: string, role: string, name?: string): Promise<string> {
    return (await this.resolveLocator(context, { role, name })).selector;
  }

  async clip(context: string, selector: string): Promise<JsonObject> {
    // Document coordinates with origin 'document' capture the whole element without scrolling it into view.
    const value = await this.evaluateValue(context, `(() => {
      let root = document;
      let element;
      for (const part of ${JSON.stringify(selector.split('>>>').map((part) => part.trim()))}) {
        element = root.querySelector(part);
        if (!element) throw new Error('No element matches ' + ${JSON.stringify(selector)});
        root = element.shadowRoot ?? element;
      }
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) throw new Error('Element has no visible box: ' + ${JSON.stringify(selector)});
      return { type: 'box', x: rect.left + scrollX, y: rect.top + scrollY, width: rect.width, height: rect.height };
    })()`);
    if (!value || typeof value !== 'object') throw new Error(`Firefox did not return a screenshot clip for ${JSON.stringify(selector)}`);
    return value as JsonObject;
  }

  // With `expected`, every selector segment must match exactly one element and the element must still have the
  // identity it had when resolved; this rejects a view swap between resolution and the pointer action.
  async coordinates(context: string, selector: string, expected?: ElementIdentity): Promise<{ x: number; y: number; identity: ElementIdentity }> {
    const point = await this.evaluateValue(context, `(() => {
      ${semanticFunctions}
      const strict = ${expected !== undefined};
      let root = document;
      let element;
      for (const part of ${JSON.stringify(selector.split('>>>').map((part) => part.trim()))}) {
        const matches = strict ? root.querySelectorAll(part) : [root.querySelector(part)].filter(Boolean);
        if (!matches.length) throw new Error("No element matches " + ${JSON.stringify(selector)});
        if (matches.length > 1) throw new Error("Expected exactly one element for " + ${JSON.stringify(selector)} + " at action time, found " + matches.length);
        element = matches[0];
        root = element.shadowRoot ?? element;
      }
      const identity = { tag: element.tagName.toLowerCase(), role: role(element), name: name(element) };
      const interactiveTarget = element instanceof HTMLInputElement && ['checkbox', 'radio'].includes(element.type) && !(element.getClientRects().length && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0)
        ? element.labels?.[0] || element.closest('label') || element
        : element;
      interactiveTarget.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      const rect = interactiveTarget.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) throw new Error("Target is not visible");
      const x = Math.round(rect.left + rect.width / 2);
      const y = Math.round(rect.top + rect.height / 2);
      const hit = document.elementFromPoint(x, y);
      const composedContains = (ancestor, node) => {
        for (let current = node; current; current = current.parentNode || current.getRootNode().host) {
          if (current === ancestor) return true;
        }
        return false;
      };
      if (!hit || (!composedContains(hit, interactiveTarget) && !composedContains(interactiveTarget, hit))) {
        throw new Error("Target is covered by another element");
      }
      return { x, y, identity };
    })()`);
    if (!point || typeof point !== 'object' || !('x' in point) || !('y' in point) || !('identity' in point) || typeof point.x !== 'number' || typeof point.y !== 'number' || !point.identity || typeof point.identity !== 'object') {
      throw new Error(`Firefox did not return actionable coordinates for ${JSON.stringify(selector)}`);
    }
    const identity = point.identity as ElementIdentity;
    if (expected && JSON.stringify(identity) !== JSON.stringify(expected)) {
      throw new Error(`Target changed after it was resolved; no pointer action was sent. Expected ${JSON.stringify(expected)}, found ${JSON.stringify(identity)} at ${JSON.stringify(selector)}`);
    }
    return { x: point.x, y: point.y, identity };
  }

  async elementId(context: string, selector: string): Promise<string> {
    const element = await this.#element(context, selector);
    if (typeof element.sharedId !== 'string') throw new Error(`Firefox did not return an element ID for ${JSON.stringify(selector)}`);
    return element.sharedId;
  }

  async #element(context: string, selector: string): Promise<JsonObject> {
    const expression = `(() => {
      let root = document;
      let element;
      for (const part of ${JSON.stringify(selector.split('>>>').map((part) => part.trim()))}) {
        element = root.querySelector(part);
        if (!element) return null;
        root = element.shadowRoot ?? element;
      }
      return element;
    })()`;
    const result = await this.evaluate(context, expression);
    const remote = result.result as JsonObject | undefined;
    if (!remote || remote.type !== 'node' || typeof remote.sharedId !== 'string') {
      throw new Error(`No element matches ${JSON.stringify(selector)}`);
    }
    return { sharedId: remote.sharedId };
  }
}

function isDescendant(candidate: Context, ancestor: string, contexts: Context[]): boolean {
  let parent = candidate.parent;
  while (parent) {
    if (parent === ancestor) return true;
    parent = contexts.find((context) => context.id === parent)?.parent ?? null;
  }
  return false;
}

function flattenContexts(value: unknown, parent: string | null = null): Context[] {
  if (!Array.isArray(value)) return [];
  const contexts: Context[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const context = asContext(entry as JsonObject);
    if (parent) context.parent = parent;
    contexts.push(context);
    contexts.push(...flattenContexts((entry as JsonObject).children, context.id));
  }
  return contexts;
}

function asContext(value: JsonObject): Context {
  if (typeof value.context !== 'string' || typeof value.url !== 'string') throw new Error('Malformed browsing context from Firefox');
  return {
    id: value.context,
    url: value.url,
    parent: typeof value.parent === 'string' ? value.parent : null,
  };
}

const EXPRESSION_PREVIEW_LENGTH = 240;
const PAGE_SUMMARY_TEXT_LENGTH = 300;
// In-page waits reject on their own timer; the transport deadline must outlast it so the page's error wins.
const IN_PAGE_WAIT_MARGIN_MS = 5_000;

// Returns the expression wrapped in an async arrow when it is a single expression, else undefined.
// The Function constructor only parses the source here; the wrapper is never invoked in this process.
function asAwaitedExpression(expression: string): string | undefined {
  const wrapped = `(async () => await (\n${expression.trimEnd().replace(/;$/, '')}\n))()`;
  try {
    new Function(wrapped);
    return wrapped;
  } catch {
    return undefined;
  }
}

function deserializeRemoteValue(remote: JsonObject | undefined): unknown {
  if (!remote || typeof remote.type !== 'string') return undefined;
  if (remote.type === 'undefined') return undefined;
  if (remote.type === 'null') return null;
  if (remote.type === 'array' && Array.isArray(remote.value)) {
    return remote.value.map((value) => deserializeRemoteValue(value as JsonObject));
  }
  if (remote.type === 'object' && Array.isArray(remote.value)) {
    return Object.fromEntries(
      remote.value.flatMap((entry) => {
        if (!Array.isArray(entry) || typeof entry[0] !== 'string') return [];
        return [[entry[0], deserializeRemoteValue(entry[1] as JsonObject)]];
      }),
    );
  }
  return remote.value;
}

function changedCharacterCount(before: string, after: string): number {
  let prefix = 0;
  const shared = Math.min(before.length, after.length);
  while (prefix < shared && before.charCodeAt(prefix) === after.charCodeAt(prefix)) prefix++;
  let suffix = 0;
  while (suffix < shared - prefix
    && before.charCodeAt(before.length - suffix - 1) === after.charCodeAt(after.length - suffix - 1)) suffix++;
  return before.length - prefix - suffix + after.length - prefix - suffix;
}

function chordActions(chord: string): Array<{ type: 'keyDown' | 'keyUp'; value: string }> {
  const keys: Record<string, string> = {
    Alt: '\uE00A', Backspace: '\uE003', Control: '\uE009', Delete: '\uE017', Down: '\uE015', End: '\uE010',
    Enter: '\uE007', Escape: '\uE00C', Home: '\uE011', Left: '\uE012', Meta: '\uE03D', Right: '\uE014',
    Shift: '\uE008', Tab: '\uE004', Up: '\uE013',
  };
  const values = chord.split('+').map((part) => keys[part] ?? (part.length === 1 ? part : undefined));
  if (values.some((value) => value === undefined)) throw new Error(`Unsupported key chord ${JSON.stringify(chord)}`);
  const resolved = values as string[];
  return [
    ...resolved.map((value) => ({ type: 'keyDown' as const, value })),
    ...[...resolved].reverse().map((value) => ({ type: 'keyUp' as const, value })),
  ];
}
