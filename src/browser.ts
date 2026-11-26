import { setTimeout as sleep } from 'node:timers/promises';
import { BidiError, type BidiTransport, type BidiEvent, type JsonObject } from './bidi.ts';
import { detectCapabilities, type DetectedCapabilities } from './capabilities.ts';
import { documentFrame, locateNodeFunction, pageNodesFunction, resolveLocator, semanticFunctions, type ElementIdentity, type FrameInfo, type FrameNodes, type Locator, type PageNode, type ResolvedLocator } from './locator.ts';

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
export type WaitState = 'visible' | 'hidden';
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

/** Input was sent to the page, but reading the control back did not show the requested state. Retrying repeats the input. */
export class InputVerificationError extends Error {
  override readonly name = 'InputVerificationError';
}

/** A node reference no longer points at an element in its document (removed, or the frame navigated). */
export class StaleNodeError extends Error {
  override readonly name = 'StaleNodeError';
}

export type InvalidField = { name: string; validationMessage: string };
/** Constraint validation blocked the submission; nothing was submitted. */
export class FormInvalidError extends Error {
  override readonly name = 'FormInvalidError';
  constructor(readonly invalidFields: InvalidField[]) {
    super(`Form not submitted: ${invalidFields.length} field(s) fail validation`);
  }
}

export type OpenPrompt = { type: string; message: string; defaultValue?: string };
const PROMPT_EVENTS = ['browsingContext.userPromptOpened', 'browsingContext.userPromptClosed', 'browsingContext.contextDestroyed'];

export class ZenBrowser {
  #capabilities?: Promise<DetectedCapabilities>;
  #prompts = new Map<string, OpenPrompt>();
  #promptWatch?: Promise<void>;

  constructor(readonly bidi: BidiTransport) {
    bidi.onEvent((event) => {
      const context = event.params.context;
      if (typeof context !== 'string') return;
      if (event.method === 'browsingContext.userPromptOpened') this.#prompts.set(context, asPrompt(event.params));
      else if (event.method === 'browsingContext.userPromptClosed' || event.method === 'browsingContext.contextDestroyed') this.#prompts.delete(context);
    });
  }

  /** Subscribes once, session-wide, to user-prompt lifecycle events so open dialogs can be reported per tab. */
  async watchPrompts(): Promise<void> {
    await (this.#promptWatch ??= this.subscribe(PROMPT_EVENTS).catch((error: unknown) => {
      this.#promptWatch = undefined;
      throw error;
    }));
  }

  /** The alert/confirm/prompt/beforeunload dialog currently open in a top-level context, if one was observed. */
  openPrompt(context: string): OpenPrompt | undefined {
    return this.#prompts.get(context);
  }

  /** Resolves when a dialog opens in `context`; `stop` detaches the listener. */
  promptOpened(context: string): { opened: Promise<OpenPrompt>; stop(): void } {
    const deferred = Promise.withResolvers<OpenPrompt>();
    const stop = this.onEvent((event) => {
      if (event.method === 'browsingContext.userPromptOpened' && event.params.context === context) deferred.resolve(asPrompt(event.params));
    });
    return { opened: deferred.promise, stop };
  }

  async capabilities(): Promise<DetectedCapabilities> {
    return await (this.#capabilities ??= detectCapabilities(this.bidi));
  }

  async requireFeature(feature: 'browserUserContexts'): Promise<void> {
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
    // A context with an open dialog would block or fail page evaluation; its title is left unknown.
    return await Promise.all(contexts.map(async (context) => {
      if (this.#prompts.has(context.id)) return context;
      try {
        const title = await this.evaluate(context.id, 'document.title');
        const remote = title.result as JsonObject | undefined;
        return { ...context, title: typeof remote?.value === 'string' ? remote.value : undefined };
      } catch {
        return context;
      }
    }));
  }

  /** IDs of `context` and every frame inside it, from the browser's tree without evaluating page script. */
  async treeIds(context: string): Promise<string[]> {
    const result = await this.bidi.command('browsingContext.getTree', { root: context });
    return flattenContexts(result.contexts).map((entry) => entry.id);
  }

  /** The tab's frames, top first: one per browsing context in its tree, cross-origin ones included. Frames whose
   * document can't be read right now (mid-navigation) are left out. */
  async frames(context: string): Promise<FrameInfo[]> {
    const result = await this.bidi.command('browsingContext.getTree', { root: context });
    const tree = flattenContexts(result.contexts);
    const frames = await Promise.all(tree.map(async (entry) => {
      try {
        return { ...await documentFrame(this.evaluateValue.bind(this), entry.id), url: entry.url, parent: entry.id === context ? null : entry.parent };
      } catch (error) {
        if (entry.id === context) throw error;
        return undefined;
      }
    }));
    return frames.filter((frame) => frame !== undefined);
  }

  /** The top-level context holding `context` (itself when it is one), or undefined once it is gone. */
  async rootOf(context: string): Promise<string | undefined> {
    const result = await this.bidi.command('browsingContext.getTree', {});
    const all = flattenContexts(result.contexts);
    let current = all.find((entry) => entry.id === context);
    while (current?.parent) current = all.find((entry) => entry.id === current!.parent);
    return current?.id;
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

  /**
   * Selects the tab. Firefox also waits for the window to take keyboard focus, which Wayland compositors refuse to a
   * window the user isn't looking at (it is marked urgent instead), so that wait never ends there. The tab is selected
   * either way; past a short cap the wait is dropped.
   */
  async activate(context: string): Promise<void> {
    try {
      await this.bidi.command('browsingContext.activate', { context }, ACTIVATE_WAIT_MS);
    } catch (error) {
      if (!(error instanceof Error && error.message.includes('Timed out waiting'))) throw error;
    }
  }

  async open(url = 'about:blank', referenceContext?: string): Promise<Context> {
    const result = await this.openWithOutcome(url, referenceContext);
    if (result.error) throw new Error(result.error);
    return result.context;
  }

  /** Opens a tab (in `userContext` when given) and navigates it; a failed navigation is reported, not thrown. */
  async openWithOutcome(url = 'about:blank', referenceContext?: string, userContext?: string): Promise<OpenResult> {
    if (userContext) await this.requireFeature('browserUserContexts');
    // Created in the background, then selected: `background: false` has the same never-ending focus wait as activate.
    const result = await this.bidi.command('browsingContext.create', {
      type: 'tab',
      background: true,
      ...(referenceContext ? { referenceContext } : {}),
      ...(userContext ? { userContext } : {}),
    });
    if (typeof result.context !== 'string') throw new Error('Firefox did not return a browsing-context ID');
    await this.activate(result.context);
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
    await this.bidi.command('browsingContext.reload', { context, wait: 'complete' });
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
    this.#prompts.delete(context);
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

  /** Like evaluateValue, but DOM nodes come back as `{ sharedId }` and windows as `{ context }` (their browsing context). */
  async evaluateReferences(context: string, expression: string, timeoutMs?: number): Promise<unknown> {
    const result = await this.evaluate(context, expression, timeoutMs);
    return deserializeRemoteValue(result.result as JsonObject | undefined, true);
  }

  /** Meaningful elements of one frame's document (see pageNodesFunction). */
  async pageNodes(context: string, options: { root?: string; max: number; interactiveOnly?: boolean }): Promise<FrameNodes> {
    const value = await this.evaluateReferences(context, `(${pageNodesFunction})(${JSON.stringify({ root: options.root?.trim() || undefined, max: options.max, interactiveOnly: options.interactiveOnly === true })})`);
    if (!value || typeof value !== 'object' || !('nodes' in value) || !Array.isArray(value.nodes)) throw new Error('Firefox returned a malformed page snapshot');
    const nodes = value.nodes.flatMap((raw: Record<string, unknown>) => {
      const { node, childWindow, ...rest } = raw as { node?: { sharedId?: unknown }; childWindow?: { context?: unknown } };
      if (typeof node?.sharedId !== 'string') return [];
      return [{ ...rest, sharedId: node.sharedId, ...(typeof childWindow?.context === 'string' ? { childContext: childWindow.context } : {}) } as PageNode];
    });
    return { nodes, truncated: 'truncated' in value && value.truncated === true };
  }

  /** The current selector and identity of a node by its BiDi reference; throws StaleNodeError once it left its document. */
  async locateNode(context: string, sharedId: string): Promise<{ selector: string; identity: ElementIdentity }> {
    let result: JsonObject;
    try {
      result = await this.bidi.command('script.callFunction', { functionDeclaration: locateNodeFunction, target: { context }, awaitPromise: false, arguments: [{ sharedId }] });
    } catch (error) {
      if (error instanceof BidiError && (error.error === 'no such node' || error.error === 'no such frame')) throw new StaleNodeError(error.error);
      throw error;
    }
    if (result.type === 'exception') throw new Error('Could not locate the element in the page');
    const value = deserializeRemoteValue(result.result as JsonObject | undefined);
    if (value === null) throw new StaleNodeError('node left the document');
    if (!value || typeof value !== 'object' || !('selector' in value) || typeof value.selector !== 'string' || !('identity' in value)) throw new Error('Firefox returned a malformed node location');
    return { selector: value.selector, identity: value.identity as ElementIdentity };
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
      const source = event.params.source as { context?: unknown } | undefined;
      if (methods.includes(event.method) && (event.params.context === context || source?.context === context)) deferred.resolve(event);
    });
    try {
      return await deferred.promise;
    } finally {
      clearTimeout(timer);
      stop();
      await this.unsubscribe(methods, [context]).catch(() => undefined);
    }
  }

  // Every frame of the tab is checked, cross-origin ones through their own browsing context: the top document (and
  // its same-origin frames) by an in-page observer that answers as soon as the condition holds, the other frames once
  // per slice. Visible: any frame satisfies it. Hidden: every frame does.
  async waitFor(context: string, selector: string, timeoutMs = 10_000, state: WaitState = 'visible'): Promise<void> {
    const ready = `const shown = (doc) => { let root = doc; let element; for (const part of ${JSON.stringify(selector)}.split('>>>').map(part => part.trim())) { element = root.querySelector(part); if (!element) return false; root = element.shadowRoot ?? element; } return Boolean(element.getClientRects().length && element.ownerDocument.defaultView.getComputedStyle(element).visibility !== 'hidden'); };
      const ready = () => documents().some(shown) === ${state === 'visible'};`;
    await this.#waitInFrames(context, ready, { poll: 100, observe: '{ childList: true, subtree: true, attributes: true }' }, timeoutMs, state, `Timed out waiting for ${JSON.stringify(selector)} to become ${state}`);
  }

  async waitForText(context: string, text: string, timeoutMs = 10_000, state: WaitState = 'visible'): Promise<void> {
    const ready = `const ready = () => documents().some((doc) => doc.body?.innerText?.includes(${JSON.stringify(text)}) ?? false) === ${state === 'visible'};`;
    await this.#waitInFrames(context, ready, { poll: 25, observe: '{ childList: true, subtree: true, characterData: true, attributes: true }' }, timeoutMs, state, `Timed out waiting for text ${JSON.stringify(text)} to become ${state}`);
  }

  // `ready` is in-page source defining `ready()`: true when the condition holds in that frame (and its same-origin frames).
  async #waitInFrames(context: string, ready: string, watch: { poll: number; observe: string }, timeoutMs: number, state: WaitState, timeoutMessage: string): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const slice = Math.max(0, Math.min(deadline - Date.now(), FRAME_WAIT_SLICE_MS));
      const children = (await this.treeIds(context).catch(() => [context])).filter((id) => id !== context);
      const [top, ...others] = await Promise.all([
        this.evaluateValue(context, `new Promise((resolve) => {
          ${SAME_ORIGIN_DOCUMENTS}
          ${ready}
          if (ready()) return resolve(true);
          const finish = (value) => { observer.disconnect(); clearInterval(poll); clearTimeout(timer); resolve(value); };
          const observer = new MutationObserver(() => { if (ready()) finish(true); });
          const poll = setInterval(() => { if (ready()) finish(true); }, ${watch.poll});
          const timer = setTimeout(() => finish(false), ${slice});
          observer.observe(document, ${watch.observe});
        })`, slice + IN_PAGE_WAIT_MARGIN_MS),
        // A frame that can't be read right now (navigating, closing) has no matching element or text.
        ...children.map((child) => this.evaluateValue(child, `(() => { ${SAME_ORIGIN_DOCUMENTS} ${ready} return ready(); })()`).then((value) => value === true, () => state === 'hidden')),
      ]);
      if (state === 'visible' ? top === true || others.some(Boolean) : top === true && others.every(Boolean)) return;
      if (Date.now() >= deadline) throw new Error(timeoutMessage);
    }
  }

  async waitForDocumentChange(context: string, previous: string, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ((await documentFrame(this.evaluateValue.bind(this), context)).documentId !== previous) return;
      await sleep(25);
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

  // `root` scopes the comparison to one element where any text or element-count change counts; a root that is absent counts as empty, so its appearance is a change.
  async waitForPageChange(context: string, timeoutMs = 10_000, root?: string): Promise<PageChangeResult> {
    const lifecycleEvents = ['browsingContext.navigationStarted', 'browsingContext.domContentLoaded', 'browsingContext.load'];
    let navigationStarted = false;
    const stop = this.onEvent((event) => {
      if (lifecycleEvents.includes(event.method) && event.params.context === context) navigationStarted = true;
    });
    await this.subscribe(lifecycleEvents, [context]);
    try {
      let previous = await this.#pageChangeSnapshot(context, root);
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (navigationStarted) return { type: 'navigation' };
        await sleep(Math.max(0, Math.min(100, deadline - Date.now())));
        if (navigationStarted) return { type: 'navigation' };
        let current;
        try {
          current = await this.#pageChangeSnapshot(context, root);
        } catch (error) {
          if (navigationStarted) return { type: 'navigation' };
          throw error;
        }
        if (current.documentId !== previous.documentId || current.url !== previous.url) return { type: 'navigation' };
        const changedCharacters = changedCharacterCount(previous.text, current.text);
        const changedElements = Math.abs(previous.elementCount - current.elementCount);
        if (root === undefined ? changedCharacters >= 24 || changedElements >= 3 : changedCharacters > 0 || changedElements > 0 || current.text !== previous.text) {
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

  async #pageChangeSnapshot(context: string, rootSelector?: string): Promise<{ url: string; documentId: string; text: string; elementCount: number }> {
    const value = await this.evaluateValue(context, `(() => {
      const root = ${rootSelector === undefined ? `document.querySelector('main,[role="main"],#app,#root') ?? document.body` : `document.querySelector(${JSON.stringify(rootSelector)})`};
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

  /** Matches `expected` against the URL without its query string (a `?` in `expected` matches the full URL), once that document has loaded. */
  async waitForUrl(context: string, expected: string, timeoutMs = 10_000): Promise<void> {
    await this.#waitForLoadedUrl(context, (url) => urlMatches(url, expected), `a loaded URL matching ${JSON.stringify(expected)}`, timeoutMs);
  }

  async waitForUrlChange(context: string, previous: string, timeoutMs = 10_000): Promise<void> {
    await this.#waitForLoadedUrl(context, (url) => url !== previous, `a loaded URL other than ${JSON.stringify(previous)}`, timeoutMs);
  }

  // Completes only once a document with a matching URL has parsed (domContentLoaded/load, or readyState past
  // "loading"), never on navigationStarted, whose URL is a destination that has not loaded yet.
  async #waitForLoadedUrl(context: string, predicate: (url: string) => boolean, description: string, timeoutMs: number): Promise<void> {
    const loadedMatch = async () => {
      const state = await this.evaluateValue(context, '({ href: location.href, loaded: document.readyState !== "loading" })');
      return Boolean(state && typeof state === 'object' && 'href' in state && 'loaded' in state && typeof state.href === 'string' && state.loaded === true && predicate(state.href));
    };
    if (await loadedMatch()) return;
    const events = ['browsingContext.domContentLoaded', 'browsingContext.load'];
    const done = Promise.withResolvers<void>();
    let settled = false;
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (error) done.reject(error); else done.resolve();
    };
    // Listen before subscribing so no event between the subscription and the listener is lost.
    const stop = this.onEvent((event) => {
      if (event.params.context === context && events.includes(event.method) && typeof event.params.url === 'string' && predicate(event.params.url)) settle();
    });
    const timer = setTimeout(() => settle(new Error(`Timed out waiting for ${description}`)), timeoutMs);
    // Polling also catches same-document URL changes (pushState, fragments), which emit no load event.
    // Evaluation can fail while a navigation replaces the document; the next check retries.
    let polling = false;
    const check = () => {
      if (polling || settled) return;
      polling = true;
      void loadedMatch().then((matched) => { if (matched) settle(); }, () => undefined).finally(() => { polling = false; });
    };
    const poll = setInterval(check, 100);
    try {
      await this.subscribe(events, [context]);
      check();
      await done.promise;
    } finally {
      clearTimeout(timer);
      clearInterval(poll);
      stop();
      await this.unsubscribe(events, [context]).catch(() => undefined);
    }
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
    const focused = await this.#withElement(context, selector, `element => { ${SHADOW_PIERCING} element.focus(); return deepActive() === element; }`);
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
      throw new InputVerificationError(`Keys were sent, but the field now reads ${JSON.stringify(actualValue)} instead of ${JSON.stringify(requestedValue)} for ${JSON.stringify(selector)}`);
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

  // Sets the option directly and fires one bubbling input + change, as a single user choice would; keyboard
  // stepping would skip disabled options and fire change on every option it passes.
  async select(context: string, selector: string, value: string): Promise<{ selectedIndex: number; changed: boolean }> {
    await this.coordinates(context, selector);
    const outcome = await this.#withElement(context, selector, `element => {
      if (!(element instanceof HTMLSelectElement)) throw new Error('Target is not a select element');
      if (element.disabled) throw new Error('Select element is disabled');
      const options = [...element.options];
      const requested = ${JSON.stringify(value)};
      const byValue = options.findIndex(option => option.value === requested);
      const index = byValue >= 0 ? byValue : options.findIndex(option => option.text.trim() === requested);
      if (index < 0) throw new Error('No option has the requested value or visible text');
      const option = options[index];
      if (option.disabled || option.closest('optgroup')?.disabled) throw new Error('Option ' + JSON.stringify(option.text.trim()) + ' is disabled and cannot be selected');
      if (element.selectedIndex === index) return { index, changed: false };
      element.focus();
      element.selectedIndex = index;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return { index, changed: true };
    }`);
    if (!outcome || typeof outcome !== 'object' || !('index' in outcome) || typeof outcome.index !== 'number' || !('changed' in outcome)) throw new Error(`Firefox did not return an option index for ${JSON.stringify(selector)}`);
    const selected = await this.#withElement(context, selector, 'element => element.selectedIndex');
    if (selected !== outcome.index) throw new InputVerificationError(`Option was set and change fired, but ${JSON.stringify(selector)} now has selectedIndex ${JSON.stringify(selected)} instead of ${outcome.index}`);
    return { selectedIndex: outcome.index, changed: outcome.changed === true };
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
      ${SHADOW_PIERCING}
      const hit = rect.width > 0 && rect.height > 0 ? deepHit(x, y) : null;
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
      ${SHADOW_PIERCING}
      const label = element.labels?.[0] || element.closest('label');
      if (!label) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (!element.getClientRects().length || rect.width <= 0 || rect.height <= 0 || style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return true;
      const hit = deepHit(Math.round(rect.left + rect.width / 2), Math.round(rect.top + rect.height / 2));
      return !hit || (hit !== element && !element.contains(hit));
    }`);
    if (useLabel === true) {
      await this.#withElement(context, selector, `element => {
        ${SHADOW_PIERCING}
        const label = element.labels?.[0] || element.closest('label');
        if (!label) throw new Error('Hidden checkable input has no associated visible label');
        label.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        if (!label.getClientRects().length) throw new Error('Associated label is not visible');
        const rect = label.getBoundingClientRect();
        const hit = deepHit(Math.round(rect.left + rect.width / 2), Math.round(rect.top + rect.height / 2));
        if (!hit || (hit !== label && !label.contains(hit) && !hit.contains(label))) throw new Error('Associated label is covered by another element');
        label.click();
      }`);
    } else await this.click(context, selector);
    // Framework-controlled checkboxes may settle asynchronously (e.g. after an API call).
    const deadline = Date.now() + CHECK_SETTLE_MS;
    let observed: unknown;
    do {
      observed = await this.#withElement(context, selector, 'element => element.checked');
      if (observed === checked) return;
      await sleep(50);
    } while (Date.now() < deadline);
    throw new InputVerificationError(`The control was clicked, but ${JSON.stringify(selector)} still reads checked=${JSON.stringify(observed)} after ${CHECK_SETTLE_MS} ms`);
  }

  // Runs constraint validation first: requestSubmit() silently does nothing on an invalid form.
  async submitForm(context: string, selector: string): Promise<void> {
    const outcome = await this.#withElement(context, selector, `element => {
      const form = element instanceof HTMLFormElement ? element : element.form || element.closest('form');
      if (!(form instanceof HTMLFormElement)) throw new Error('Submit target is not associated with a form');
      const submitter = (element instanceof HTMLButtonElement && element.type === 'submit') || (element instanceof HTMLInputElement && ['submit', 'image'].includes(element.type)) ? element : null;
      if (!form.noValidate && !submitter?.formNoValidate && !form.checkValidity()) {
        return { submitted: false, invalidFields: [...form.elements].filter(field => field.willValidate && !field.validity.valid).map(field => ({
          name: field.name || field.id || field.getAttribute('aria-label') || field.tagName.toLowerCase(),
          validationMessage: field.validationMessage,
        })) };
      }
      form.requestSubmit(submitter);
      return { submitted: true };
    }`);
    if (!outcome || typeof outcome !== 'object' || !('submitted' in outcome)) throw new Error(`Form submission did not start for ${JSON.stringify(selector)}`);
    if (outcome.submitted !== true) throw new FormInvalidError('invalidFields' in outcome && Array.isArray(outcome.invalidFields) ? outcome.invalidFields as InvalidField[] : []);
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
    const result = await this.bidi.commandOptional('browsingContext.create', { type: 'tab', background: true, referenceContext, userContext });
    if (typeof result.context !== 'string') throw new Error('Firefox did not return a browsing-context ID');
    await this.activate(result.context);
    await this.navigate(result.context, url);
    return { id: result.context, url, parent: null };
  }

  async #withElement(context: string, selector: string, functionDeclaration: string): Promise<unknown> {
    const element = await this.#element(context, selector);
    const result = await this.bidi.command('script.callFunction', {
      functionDeclaration,
      target: { context },
      awaitPromise: true,
      arguments: [element],
    });
    if (result.type === 'exception') {
      const exception = result.exceptionDetails as JsonObject | undefined;
      throw new Error(`Element operation failed: ${typeof exception?.text === 'string' ? exception.text : 'page exception'}`);
    }
    return deserializeRemoteValue(result.result as JsonObject | undefined);
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

function asPrompt(params: JsonObject): OpenPrompt {
  return {
    type: typeof params.type === 'string' ? params.type : 'unknown',
    message: typeof params.message === 'string' ? params.message : '',
    ...(typeof params.defaultValue === 'string' ? { defaultValue: params.defaultValue } : {}),
  };
}

// The query string is ignored unless `expected` asks for one: SSO pages carry the destination host in `?service=…`.
function urlMatches(href: string, expected: string): boolean {
  if (expected.includes('?')) return href.includes(expected);
  try {
    const url = new URL(href);
    url.search = '';
    return url.href.includes(expected);
  } catch {
    return href.split('?')[0]!.includes(expected);
  }
}

const EXPRESSION_PREVIEW_LENGTH = 240;
const PAGE_SUMMARY_TEXT_LENGTH = 300;
// In-page waits reject on their own timer; the transport deadline must outlast it so the page's error wins.
const IN_PAGE_WAIT_MARGIN_MS = 5_000;
// Cross-frame waits re-read the tab's frame tree and check the other frames this often.
const FRAME_WAIT_SLICE_MS = 300;
// In-page source defining `documents()`: the top document plus every reachable same-origin (i)frame document, recursively.
const SAME_ORIGIN_DOCUMENTS = `const documents = (doc = document, found = []) => { found.push(doc); for (const frame of doc.querySelectorAll('iframe,frame')) { try { if (frame.contentDocument) documents(frame.contentDocument, found); } catch {} } return found; };`;
// In-page source defining `deepHit(x, y)` and `deepActive()`: elementFromPoint and activeElement retarget to a shadow
// host; these descend through open shadow roots to the element actually hit or focused.
const SHADOW_PIERCING = `const deepHit = (x, y) => { let hit = document.elementFromPoint(x, y); while (hit?.shadowRoot) { const inner = hit.shadowRoot.elementFromPoint(x, y); if (!inner || inner === hit) break; hit = inner; } return hit; };
  const deepActive = () => { let active = document.activeElement; while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement; return active; };`;
// How long `check` keeps reading the control back after input, for frameworks that update it asynchronously.
const CHECK_SETTLE_MS = 1_000;
// How long a tab activation may wait for its window to take focus (see `activate`); focused windows answer at once.
const ACTIVATE_WAIT_MS = 1_500;

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

// With `references`, nodes become `{ sharedId }` and windows `{ context }`, so callers can address them again.
function deserializeRemoteValue(remote: JsonObject | undefined, references = false): unknown {
  if (!remote || typeof remote.type !== 'string') return undefined;
  if (remote.type === 'undefined') return undefined;
  if (remote.type === 'null') return null;
  if (references && remote.type === 'node') return { sharedId: remote.sharedId };
  if (references && remote.type === 'window') return { context: (remote.value as JsonObject | undefined)?.context };
  if (remote.type === 'array' && Array.isArray(remote.value)) {
    return remote.value.map((value) => deserializeRemoteValue(value as JsonObject, references));
  }
  if (remote.type === 'object' && Array.isArray(remote.value)) {
    return Object.fromEntries(
      remote.value.flatMap((entry) => {
        if (!Array.isArray(entry) || typeof entry[0] !== 'string') return [];
        return [[entry[0], deserializeRemoteValue(entry[1] as JsonObject, references)]];
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
