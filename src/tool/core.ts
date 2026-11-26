import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { z as Zod } from 'zod';
import type { BidiTransport } from '../bidi.ts';
import { BrokerBidiClient } from '../broker-client.ts';
import { ZenBrowser, ZenEmptyTabContextFilter, PageEvaluationError, InputVerificationError, FormInvalidError, StaleNodeError, type Context, type OpenPrompt } from '../browser.ts';
import { ActionScope, type ActionScopeResult, type WaitCondition, type WaitPredicate } from '../action-scope.ts';
import { documentFrame, formSchema, queryElements, sameIdentity, semanticSnapshot, type ElementIdentity, type FrameRef, type Locator, type ResolvedLocator } from '../locator.ts';
import { summarizeDiagnostic } from '../diagnostics.ts';
import { launchBrowser } from '../launch.ts';

/**
 * The `zen_browser` tool without a host: oh-my-pi registers it (extension/zen-browser.ts), the MCP server serves it
 * (src/mcp). Features (src/tool/features) add actions, parameters, and hooks that run around every action.
 */
export type Target = { selector?: string; handle?: string; role?: string; name?: string; locator?: Locator };
/** Parameters after schema validation. Features read their own extra parameters from the index signature. */
export type ToolParams = Target & {
  action: string;
  tabId?: string; target?: string; url?: string; destination?: string; text?: string; value?: string; key?: string;
  property?: string; equals?: unknown; pointer?: 'down' | 'move' | 'up'; checked?: boolean; files?: string[];
  dx?: number; dy?: number; timeoutMs?: number; output?: string; format?: 'path' | 'base64'; fullPage?: boolean;
  dialogAction?: 'accept' | 'dismiss'; promptText?: string; eventTypes?: string[]; eventLimit?: number; root?: string;
  mode?: 'interactive' | 'content' | 'semantic'; maxElements?: number; fields?: Record<string, string>;
  dismissTransientHints?: boolean; waitFor?: unknown; waitUrl?: string; isolation?: 'live' | 'test';
  batch?: Array<Target & { action: string; [key: string]: unknown }>;
  properties?: Array<Target & { property: string; equals: unknown }>; expression?: string;
  [key: string]: unknown;
};
export type ToolContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
export type ActionCall = { action: string; params: ToolParams };
export type ActionResult = { details: Record<string, unknown>; image?: string };
export type ElementRecord = { tabId: string; locator: Locator; frame: FrameRef; identity: ElementIdentity; nodeId: string };
/** What an element-targeting action is about to act on, for policy decisions and audit records. */
export type TargetDescription = { tabId: string; url: string; selector: string; tag: string; type?: string; role: string | null; name: string | null; text: string; form?: { action: string; method: string } };

/** Shared state and helpers features use; the same objects the core actions use. */
export type ToolRuntime = {
  browser: ZenBrowser;
  /** Stable tab id (tab_N) for a browsing context. */
  tabId(contextId: string): string;
  /** The tab a page-changing or reading action targets (tabId, or a unique URL/title `target`). */
  target(action: string, tabId?: string, target?: string): Promise<{ context: Context; tabId: string }>;
  resolve(context: Context, tabId: string, target: Target): Promise<ResolvedLocator>;
  /** Resolves the element `target` names without acting on it; undefined when it names no element. */
  describe(context: Context, tabId: string, target: Target): Promise<TargetDescription | undefined>;
  pageState(context: Context): Promise<{ url: string; title: string; documentId: string }>;
  /** Mints an el_* handle that core element actions accept. With `handle` (one it minted before), rebinds that handle
   * to `record` instead, so a handle can stay the same while the element's selector or name changes. */
  registerElement(record: ElementRecord, handle?: string): string;
};

export type ActionOutcome = { result?: ActionResult; error?: unknown; startedAt: number };
export type ToolFeature = {
  name: string;
  /** Actions this feature implements. Their names join the `action` enum. */
  actions?: Record<string, (call: ActionCall, runtime: ToolRuntime, signal?: AbortSignal) => Promise<ActionResult>>;
  /** Extra parameters, as a zod shape built with the host's zod. */
  params?(z: typeof Zod): Record<string, Zod.ZodType>;
  /** Paragraphs appended to the tool description. */
  description?: string[];
  /** Runs before every action, in feature order. Throwing refuses the action; nothing reaches the page. */
  before?(call: ActionCall, runtime: ToolRuntime): Promise<void>;
  /** Runs after every action, success or failure, in feature order. Returning an outcome replaces it (redaction). */
  after?(call: ActionCall, outcome: ActionOutcome, runtime: ToolRuntime): Promise<ActionOutcome | void>;
  /** The container (user context) `open` puts new tabs in, unless `isolation: "test"`; the first feature with one wins. */
  space?(runtime: ToolRuntime): Promise<{ userContext: string; name: string } | undefined>;
  shutdown?(): Promise<void>;
};
export type BrowserToolOptions = { client?: BidiTransport; features?: ToolFeature[] };
export type BrowserTool = {
  name: string;
  label: string;
  description: string;
  parameters: Zod.ZodType;
  execute(params: ToolParams, signal?: AbortSignal): Promise<{ content: ToolContent[]; details: Record<string, unknown> }>;
  shutdown(): Promise<void>;
  runtime: ToolRuntime;
};

const ACTIONS = [
  'tabs', 'inspect', 'form_schema', 'field_state', 'query', 'table', 'events', 'wait_event',
  'open', 'activate', 'close', 'navigate', 'reload', 'history', 'click', 'double_click', 'right_click',
  'hover', 'drag', 'pointer', 'fill', 'fill_many', 'type', 'press', 'scroll', 'select', 'select_many',
  'check', 'check_many', 'assert', 'assert_many', 'batch', 'submit_form', 'upload', 'wait_for',
  'wait_for_change', 'wait_url', 'evaluate', 'dialog', 'screenshot', 'launch',
] as const;
type Action = typeof ACTIONS[number];
export const CORE_ACTIONS: readonly string[] = ACTIONS;
// Only reading and waiting may fall back to the one focused tab. Anything that can change a page must name its tab,
// because the focused tab is usually the one the user is working in. `open` uses the tab only to place the new one.
const FOCUS_FALLBACK: Partial<Record<Action, true>> = { inspect: true, form_schema: true, field_state: true, query: true, table: true, events: true, wait_event: true, wait_for: true, wait_for_change: true, wait_url: true, assert: true, assert_many: true, screenshot: true, open: true };
// Actions that may run while a page dialog is open; everything else would block on it or act behind it.
const PROMPT_SAFE: Partial<Record<Action, true>> = { tabs: true, dialog: true, close: true, activate: true, open: true };
const VERIFIED_ACTIONS: Partial<Record<Action, true>> = { fill: true, type: true, select: true, check: true };
const QUERY_LIMIT = 200;
const TABLE_ROW_LIMIT = 200;
const DIAGNOSTIC_LIMIT = 20;
const PROMPT_NOTE = 'A page dialog is open and blocks this tab. Read openPrompt, then call dialog with dialogAction "accept" or "dismiss" (promptText for a prompt) before any other action on this tab.';
const UNVERIFIED_NOTE = 'The input was sent, but reading the control back did not match. Do not resend it; check the field (field_state) first.';

type TestContext = { raw: string; tabs: Set<string> };
type BatchStep = Target & { action: 'fill' | 'select' | 'check' | 'clear' | 'click' | 'commit' | 'press' | 'assert' | 'scroll'; value?: string; text?: string; checked?: boolean; key?: string; property?: string; equals?: unknown; waitFor?: WaitCondition };
type Guarded = { performed: boolean; verifyError?: string; result?: ActionScopeResult; prompt?: OpenPrompt; failed?: { error: unknown } };

const keyCodes: Record<string, string> = {
  Enter: '\uE007', Escape: '\uE00C', Tab: '\uE004', ArrowUp: '\uE013', ArrowDown: '\uE015',
  ArrowLeft: '\uE012', ArrowRight: '\uE014', Backspace: '\uE003', Delete: '\uE017',
  Home: '\uE011', End: '\uE010',
};
const keyValue = (key: string) => keyCodes[key] ?? keyCodes[key.charAt(0).toUpperCase() + key.slice(1).toLowerCase()] ?? key;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const hasElementTarget = (target: Target) => Boolean(target.handle || target.selector || target.role || target.name !== undefined || target.locator);

export function createBrowserTool(z: typeof Zod, options: BrowserToolOptions = {}): BrowserTool {
  const features = options.features ?? [];
  const browser = new ZenBrowser(options.client ?? new BrokerBidiClient());
  const emptyTabContexts = new ZenEmptyTabContextFilter();
  const tabIds = new Map<string, string>();
  const elements = new Map<string, ElementRecord>();
  const tabIsolation = new Map<string, 'live' | 'test' | 'space'>();
  const tabTestContext = new Map<string, string>();
  const testContexts = new Map<string, TestContext>();
  const eventBuffer: Array<{ method: string; params: Record<string, unknown>; receivedAt: number }> = [];
  let isZen: Promise<boolean> | undefined;
  const targetsZen = () => (isZen ??= (async () => {
    const session = await browser.bidi.sessionInfo?.();
    const capabilities = session?.capabilities;
    return Boolean(capabilities && typeof capabilities === 'object' && !Array.isArray(capabilities) && 'browserName' in capabilities && capabilities.browserName === 'zen');
  })());
  const lastActivated = new Map<string, number>();
  let nextTab = 1;
  let nextElement = 1;
  let nextTest = 1;
  let eventLimit = 100;
  let tail = Promise.resolve();

  // Test user contexts are disposable; removing one also closes its tabs. Nothing else in the profile is touched.
  const shutdown = async () => {
    for (const feature of features) await feature.shutdown?.().catch(() => undefined);
    for (const test of testContexts.values()) await browser.removeUserContext(test.raw).catch(() => undefined);
    testContexts.clear();
    await browser.bidi.close();
  };
  browser.onEvent((event) => {
    eventBuffer.push({ ...event, receivedAt: Date.now() });
    if (eventBuffer.length > eventLimit) eventBuffer.splice(0, eventBuffer.length - eventLimit);
  });

  const serialize = async <T>(work: () => Promise<T>) => {
    const previous = tail;
    const gate = Promise.withResolvers<void>();
    tail = previous.then(() => gate.promise);
    await previous;
    try { return await work(); } finally { gate.resolve(); }
  };
  const allRoots = async () => (await browser.contexts()).filter((context) => context.parent === null);
  const visibleRoots = async (contexts: Context[]) => await targetsZen() ? emptyTabContexts.visible(contexts) : contexts;
  const roots = async () => visibleRoots(await allRoots());
  const tabId = (contextId: string) => {
    let id = tabIds.get(contextId);
    if (!id) {
      id = `tab_${nextTab++}`;
      tabIds.set(contextId, id);
      tabIsolation.set(id, 'live');
    }
    return id;
  };
  // A tab with an open dialog is not evaluated: page script there would block behind the dialog.
  const focusOf = async (context: Context) => browser.openPrompt(context.id)
    ? { focused: false, visible: false }
    : await browser.evaluateValue(context.id, '({ focused: document.hasFocus(), visible: document.visibilityState === "visible" })').catch(() => ({ focused: false, visible: false }));
  const isFocused = (value: unknown, requireVisible: boolean) => Boolean(value && typeof value === 'object' && 'focused' in value && value.focused === true && (!requireVisible || ('visible' in value && value.visible === true)));
  const tabs = async () => {
    const snapshot = await Promise.all((await roots()).map(async (context) => ({ context, tabId: tabId(context.id), focus: await focusOf(context) })));
    const visibleFocused = snapshot.filter((tab) => isFocused(tab.focus, true));
    const focused = visibleFocused.length === 1 ? visibleFocused : snapshot.filter((tab) => isFocused(tab.focus, false));
    const activeContextId = focused.length === 1 ? focused[0]!.context.id : undefined;
    const records = snapshot.map(({ context, tabId: id }) => {
      const active = context.id === activeContextId;
      const openPrompt = browser.openPrompt(context.id);
      return { tabId: id, url: context.url, title: context.title ?? '', isolation: tabIsolation.get(id) ?? 'live', active, focused: active, lastActivatedAt: lastActivated.get(context.id), ...(openPrompt ? { openPrompt } : {}) };
    });
    return { tabs: records, activeTabId: activeContextId ? tabId(activeContextId) : undefined };
  };
  const target = async (action: string, requestedTabId?: string, requestedTarget?: string) => {
    const all = await allRoots();
    const visible = await visibleRoots(all);
    const available = visible.map((context) => ({ context, tabId: tabId(context.id) }));
    if (requestedTabId) {
      const selected = available.find((tab) => tab.tabId === requestedTabId);
      if (selected) return selected;
      throw new Error(JSON.stringify({ action, actionPerformed: false, error: 'Unknown or closed tabId. Call tabs for current tabIds.', tabId: requestedTabId }));
    }
    if (requestedTarget) {
      const query = requestedTarget.toLocaleLowerCase();
      const matched = available.filter(({ context }) => context.url.toLocaleLowerCase().includes(query) || context.title?.toLocaleLowerCase().includes(query));
      if (matched.length === 1) return matched[0]!;
      throw new Error(`target ${JSON.stringify(requestedTarget)} matches ${matched.length} tabs; it must match exactly one. Call tabs and pass a tabId.`);
    }
    if (!FOCUS_FALLBACK[action as Action]) throw new Error(`${action} can change the page, so it requires tabId (from tabs) or a target matching exactly one tab. It never falls back to the focused tab.`);
    const focused = (await Promise.all(available.map(async (entry) => ({ ...entry, focused: isFocused(await focusOf(entry.context), false) })))).filter((entry) => entry.focused);
    if (focused.length === 1) return focused[0]!;
    if (action === 'open') {
      const visibleIds = new Set(visible.map((context) => context.id));
      const internal = all.filter((context) => !visibleIds.has(context.id));
      const focusedInternal = (await Promise.all(internal.map(async (context) => ({ context, tabId: tabId(context.id), focused: isFocused(await focusOf(context), false) })))).filter((entry) => entry.focused);
      if (focusedInternal.length === 1) return focusedInternal[0]!;
      if (!available.length && internal.length === 1) return { context: internal[0]!, tabId: tabId(internal[0]!.id) };
    }
    throw new Error(`${action} requires a tabId or a unique target. Call tabs and use its activeTabId or tabId.`);
  };
  const pageState = async (context: Context) => ({
    url: await browser.url(context.id),
    title: await browser.evaluateValue(context.id, 'document.title') as string,
    documentId: (await documentFrame(browser.evaluateValue.bind(browser), context.id)).documentId,
  });
  // selector, role, name, and locator fields narrow one locator together; none of them is silently dropped.
  const resolve = async (context: Context, currentTabId: string, params: Target): Promise<ResolvedLocator> => {
    if (params.handle) {
      if (params.selector || params.role || params.name !== undefined || params.locator) throw new Error('handle cannot be combined with selector, role, name, or locator.');
      const record = elements.get(params.handle);
      if (!record) throw new Error(`Unknown element handle ${JSON.stringify(params.handle)}. Call inspect again.`);
      if (record.tabId !== currentTabId) throw new Error(`Element handle ${JSON.stringify(params.handle)} belongs to another tab.`);
      // Bound to the node itself, not to its selector: siblings appearing or disappearing don't break it.
      const stale = `Stale element handle ${params.handle}. Call inspect (or snapshot) again.`;
      if (!(await browser.treeIds(context.id)).includes(record.frame.context)) throw new Error(stale);
      if ((await documentFrame(browser.evaluateValue.bind(browser), record.frame.context)).documentId !== record.frame.documentId) throw new Error(stale);
      let located: { selector: string; identity: ElementIdentity };
      try {
        located = await browser.locateNode(record.frame.context, record.nodeId);
      } catch (error) {
        if (error instanceof StaleNodeError) throw new Error(stale);
        throw error;
      }
      if (!sameIdentity(record.identity, located.identity)) throw new Error(stale);
      return { selector: located.selector, frame: record.frame, identity: located.identity };
    }
    const locator: Locator = { ...params.locator };
    for (const [key, value, label] of [['css', params.selector, 'selector'], ['role', params.role, 'role'], ['name', params.name, 'name']] as const) {
      if (value === undefined) continue;
      if (locator[key] !== undefined && locator[key] !== value) throw new Error(`${label} ${JSON.stringify(value)} conflicts with locator.${key} ${JSON.stringify(locator[key])}.`);
      locator[key] = value;
    }
    if (!locator.css && !locator.role) throw new Error('This action requires handle, selector, role, or locator (name alone does not identify an element).');
    if (locator.frame && !(await browser.treeIds(context.id)).includes(locator.frame.context)) throw new Error(`locator.frame ${JSON.stringify(locator.frame.context)} is not a frame of ${currentTabId}. Use a frame from inspect or snapshot of this tab.`);
    return await browser.resolveLocator(context.id, locator);
  };
  const diagnose = (scope: ActionScope, error?: unknown) => {
    const diagnostic = summarizeDiagnostic(scope.action, scope.context, scope.startedAt, scope.events, error instanceof PageEvaluationError ? error : undefined);
    return {
      ...diagnostic,
      navigation: diagnostic.navigation.slice(-DIAGNOSTIC_LIMIT),
      network: diagnostic.network.slice(-DIAGNOSTIC_LIMIT),
      networkCount: diagnostic.network.length,
      console: diagnostic.console.slice(-DIAGNOSTIC_LIMIT),
    };
  };
  const asWaitCondition = (value: unknown): WaitCondition | undefined => {
    if (value === undefined || typeof value === 'string') return value;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('waitFor must be a selector string or a wait-condition object.');
    const validatePredicate = (predicate: unknown) => {
      if (!predicate || typeof predicate !== 'object' || Array.isArray(predicate)) throw new Error('waitFor contains a malformed predicate.');
      const record = predicate as Record<string, unknown>;
      const allowed: Record<string, true> = { selector: true, text: true, state: true, url: true, urlChanged: true, documentChanged: true, pageIdleMs: true };
      if (!Object.keys(record).length || Object.keys(record).some((key) => !allowed[key])) throw new Error('waitFor contains an unsupported predicate.');
      if ((record.selector !== undefined && typeof record.selector !== 'string') || (record.text !== undefined && typeof record.text !== 'string') || (record.state !== undefined && record.state !== 'visible' && record.state !== 'hidden') || (record.url !== undefined && typeof record.url !== 'string') || (record.urlChanged !== undefined && typeof record.urlChanged !== 'boolean') || (record.documentChanged !== undefined && typeof record.documentChanged !== 'boolean') || (record.pageIdleMs !== undefined && (typeof record.pageIdleMs !== 'number' || record.pageIdleMs < 0))) throw new Error('waitFor contains an invalid predicate value.');
      return record as WaitPredicate;
    };
    const record = value as Record<string, unknown>;
    if ('anyOf' in record) {
      if (Object.keys(record).length !== 1 || !Array.isArray(record.anyOf) || !record.anyOf.length) throw new Error('waitFor.anyOf must be a non-empty predicate array.');
      return { anyOf: record.anyOf.map(validatePredicate) };
    }
    return validatePredicate(record);
  };
  // Races the input and its wait against a page dialog opening in the tab. A dialog blocks the page (and often the
  // pending input command), so it ends the action: the input is reported as performed and the dialog as open.
  // Input whose read-back fails (InputVerificationError) still counts as performed; the wait still runs.
  const runGuarded = async (contextId: string, scope: ActionScope | undefined, perform: () => Promise<void>): Promise<Guarded> => {
    const state: { performed: boolean; verifyError?: string } = { performed: false };
    const body = async () => {
      try { await perform(); } catch (error) {
        if (!(error instanceof InputVerificationError)) throw error;
        state.verifyError = error.message;
      }
      state.performed = true;
    };
    const guard = browser.promptOpened(contextId);
    const work = scope ? scope.run(body) : body().then(() => undefined);
    try {
      return await Promise.race<Guarded>([
        work.then((result) => ({ ...state, ...(result ? { result } : {}) }), (error: unknown) => ({ ...state, failed: { error } })),
        guard.opened.then((prompt) => {
          void work.catch(() => undefined);
          void scope?.settle();
          return { ...state, performed: true, prompt };
        }),
      ]);
    } finally { guard.stop(); }
  };
  const verification = (verifyError: string | undefined) => verifyError === undefined ? {} : { verified: false, verifyError, note: UNVERIFIED_NOTE };
  const promptReport = (prompt: OpenPrompt) => ({ openPrompt: prompt, note: PROMPT_NOTE });
  // Every frame of the tab, cross-origin ones included, top document first; elements from other frames name theirs.
  const inspect = async (context: Context, currentTabId: string, mode: 'interactive' | 'content' | 'semantic', root?: string, maxElements = 100) => {
    const frames = await browser.frames(context.id);
    const top = frames[0]!;
    const nodes: Record<string, unknown>[] = [];
    let truncated = false;
    for (const frame of frames) {
      const remaining = maxElements - nodes.length;
      // One extra element reveals whether the list was cut at maxElements. A child frame that can't be read
      // (navigating away) contributes nothing; the top document's errors are the action's.
      const snapshot = await semanticSnapshot(browser.evaluateValue.bind(browser), frame, mode, remaining + 1, root).catch((error: unknown) => {
        if (frame === top) throw error;
        return [];
      });
      if (snapshot.length > remaining) truncated = true;
      nodes.push(...await Promise.all(snapshot.slice(0, remaining).map(async (node) => {
        const item = node as Record<string, unknown>;
        const handle = `el_${nextElement++}`;
        const frameRef: FrameRef = { context: frame.context, documentId: frame.documentId };
        const locator: Locator = { css: String(item.selector), role: typeof item.role === 'string' ? item.role : undefined, name: typeof item.name === 'string' ? item.name : undefined, exact: true, frame: frameRef };
        const identity = { tag: String(item.tag), role: typeof item.role === 'string' ? item.role : null, name: typeof item.name === 'string' ? item.name : null };
        const nodeId = await browser.elementId(frame.context, locator.css!);
        elements.set(handle, { tabId: currentTabId, locator, frame: frameRef, identity, nodeId });
        return { handle, ...item, ...(frame === top ? {} : { frame: { context: frame.context, url: frame.url } }) };
      })));
      if (truncated) break;
    }
    return {
      tabId: currentTabId,
      frame: { context: top.context, documentId: top.documentId },
      ...(frames.length > 1 ? { frames: frames.slice(1).map(({ context: id, url, documentId, parent }) => ({ context: id, url, documentId, parent })) } : {}),
      elements: nodes,
      count: nodes.length,
      truncated,
    };
  };
  const assertValue = async (context: Context, targetSpec: Target, property: string, equals: unknown) => {
    const resolved = await resolve(context, tabId(context.id), targetSpec);
    const actual = await browser.evaluateValue(resolved.frame.context, `(() => {
      let root = document; let element;
      for (const part of ${JSON.stringify(resolved.selector.split('>>>').map((part) => part.trim()))}) { element = root.querySelector(part); if (!element) throw new Error('No element matches'); root = element.shadowRoot ?? element; }
      return element[${JSON.stringify(property)}];
    })()`);
    if (!Object.is(actual, equals)) throw new Error(`Assertion failed for ${JSON.stringify(resolved.selector)}.${property}: expected ${JSON.stringify(equals)}, received ${JSON.stringify(actual)}`);
    return { selector: resolved.selector, property, value: actual };
  };
  // Like single actions, the wait is armed before input. Once input was performed, a failed wait, a failed
  // read-back, or an opened dialog is reported on the step, never thrown, so the step is not repeated.
  const runBatchStep = async (context: Context, currentTabId: string, step: BatchStep, options?: { dismissTransientHints?: boolean; timeoutMs?: number }) => {
    const before = await pageState(context);
    const condition = asWaitCondition(step.waitFor);
    const scope = condition === undefined ? undefined : new ActionScope(browser, context.id, `batch:${step.action}`, options?.timeoutMs ?? 10_000);
    await scope?.arm(condition, before.url, before.documentId);
    let result: Record<string, unknown> = {};
    const perform = async () => {
      if (step.action === 'assert') {
        if (!step.property) throw new Error('assert requires property');
        result = await assertValue(context, step, step.property, step.equals);
        return;
      }
      const resolved = await resolve(context, currentTabId, step);
      result = { selector: resolved.selector };
      if (step.action === 'fill') {
        const value = step.value ?? step.text;
        if (value === undefined) throw new Error('fill requires value');
        result = { ...result, ...(await browser.fill(resolved.frame.context, resolved.selector, value)) };
        if (options?.dismissTransientHints) result = { ...result, transientHint: await browser.dismissTransientHint(resolved.frame.context, resolved.selector) };
      } else if (step.action === 'clear') {
        result = { ...result, ...(await browser.fill(resolved.frame.context, resolved.selector, '')) };
      } else if (step.action === 'select') {
        if (step.value === undefined) throw new Error('select requires value');
        result = { ...result, ...(await browser.select(resolved.frame.context, resolved.selector, step.value)) };
      } else if (step.action === 'check') {
        if (step.checked === undefined) throw new Error('check requires checked');
        await browser.check(resolved.frame.context, resolved.selector, step.checked);
      } else if (step.action === 'press') {
        if (!step.key) throw new Error('press requires key');
        await browser.press(resolved.frame.context, keyValue(step.key), resolved.selector);
      } else if (step.action === 'scroll') {
        await browser.scrollIntoView(resolved.frame.context, resolved.selector);
      } else {
        result = { ...result, target: await browser.click(resolved.frame.context, resolved.selector, resolved.identity) };
      }
    };
    const outcome = await runGuarded(context.id, scope, perform);
    if (outcome.prompt) return { action: step.action, ...result, actionPerformed: true, ...verification(outcome.verifyError), ...(scope ? { waitCompleted: false } : {}), ...promptReport(outcome.prompt) };
    if (outcome.failed) {
      if (!outcome.performed) throw outcome.failed.error;
      return { action: step.action, ...result, actionPerformed: true, ...verification(outcome.verifyError), waitCompleted: false, waitError: message(outcome.failed.error), after: await pageState(context).catch(() => undefined), summary: await browser.pageSummary(context.id).catch(() => undefined) };
    }
    const prompt = browser.openPrompt(context.id);
    return { action: step.action, ...result, actionPerformed: true, ...verification(outcome.verifyError), ...(scope ? { waitCompleted: true } : {}), ...(prompt ? promptReport(prompt) : { after: await pageState(context) }) };
  };

  const locatorShape = z.object({
    css: z.string().optional(), role: z.string().optional(), name: z.string().optional(), exact: z.boolean().optional(),
    checked: z.boolean().optional(), disabled: z.boolean().optional(), within: z.string().optional().describe('CSS selector of an ancestor to search within.'),
    frame: z.object({ context: z.string(), documentId: z.string() }).optional().describe('Frame from inspect; the locator resolves in that document only.'),
  });
  const targetShape = {
    handle: z.string().optional().describe('Element handle (el_*) from inspect. Preferred: it is bound to one element and fails if that element changed. Do not combine with selector/role/name/locator.'),
    selector: z.string().optional().describe('CSS selector; `>>>` crosses open shadow roots. Combined with role/name, all must match the same single element.'),
    role: z.string().optional().describe('ARIA role (button, link, textbox, checkbox, radio, combobox, …). Narrows selector when both are given.'),
    name: z.string().optional().describe('Exact accessible name; needs role or selector alongside.'),
    locator: locatorShape.optional().describe('Structured locator; its fields narrow together with selector/role/name.'),
  };
  // `.strict()` rather than `z.strictObject`: the host's `pi.zod` may be zod 3, which lacks `strictObject`.
  const waitPredicate = z.object({
    selector: z.string().optional().describe('CSS selector that must be visible (or gone with state "hidden").'),
    text: z.string().optional().describe('Case-sensitive substring of the page\'s visible text (document.body.innerText) that must be present (or gone with state "hidden").'),
    state: z.enum(['visible', 'hidden']).optional().describe('Applies to selector/text. Default "visible".'),
    url: z.string().optional().describe('A loaded document\'s URL, ignoring its query string, must contain this (include "?" to match the query too).'),
    urlChanged: z.boolean().optional().describe('A document with a different URL must have loaded.'),
    documentChanged: z.boolean().optional().describe('A new document must load (full navigation).'),
    pageIdleMs: z.number().nonnegative().optional().describe('No DOM mutations for this many milliseconds.'),
  }).strict();
  const waitCondition = z.union([z.string(), waitPredicate, z.object({ anyOf: z.array(waitPredicate).min(1) }).strict()])
    .describe('Condition checked after the action, armed before input. A string is a CSS selector to become visible. An object requires every given key; {anyOf: [...]} completes on the first matching predicate. Uses timeoutMs (default 10000).');
  const batchStep = z.object({ ...targetShape, action: z.enum(['fill', 'select', 'check', 'clear', 'click', 'commit', 'press', 'assert', 'scroll']), value: z.string().optional(), text: z.string().optional(), checked: z.boolean().optional(), key: z.string().optional(), property: z.string().optional(), equals: z.unknown().optional(), waitFor: waitCondition.optional() });

  const featureActions = features.flatMap((feature) => Object.keys(feature.actions ?? {}));
  const featureParams = Object.assign({}, ...features.map((feature) => feature.params?.(z) ?? {})) as Record<string, Zod.ZodType>;
  const description = [
      'Control visible real Zen and Firefox tabs (the user\'s logged-in profile) through local loopback WebDriver BiDi. `batch` runs reversible field edits sequentially, reports each completed step, and never rolls back browser side effects. `commit` is an explicit irreversible click.',
      '',
      'Targeting: call `tabs` first and pass its `tabId` on every call. Actions that can change a page (click, fill, navigate, close, …) require `tabId` or a `target` matching one tab; they never act on whichever tab is focused. Prefer element `handle`s from `inspect`; `selector`, `role`, `name`, and `locator` narrow one element together and must match exactly one. `inspect` and `query` cover every frame of the tab, cross-origin iframes included; an element from an iframe carries `frame: {context, url}`, and its handle acts inside that frame. A selector/role locator searches the top document unless `locator.frame` names a frame (from inspect `frames`).',
      '',
      'No browser: if a call fails with "No browser is listening", `launch` starts one for foxpaw in its own profile, next to the user\'s everyday browser (the user signs in there once). Do not tell the user to restart their everyday browser unless they ask to use that profile.',
      '',
      'Dialogs: if a response contains `openPrompt` ({type, message}), the page opened an alert/confirm/prompt/beforeunload dialog (e.g. "Are you sure?") and is blocked. The action did run; do not repeat it. Call `dialog` with `dialogAction: "accept"` or `"dismiss"` (and `promptText` for a prompt) next; other actions on that tab are refused until then.',
      '',
      'Verification: fill/type/select/check read the control back. `verified: false` with `verifyError` means the input WAS sent but the value differs: do not resend; inspect the field. `submit_form` checks form validity first and, if invalid, fails with `submitted: false` and `invalidFields`.',
      '',
      'Waiting: NEVER use bash `sleep` between browser steps. Put `waitFor` on the action that triggers the change (click, navigate, press, select, submit_form, batch steps); the wait is armed before input, so fast results are not missed. If only the wait fails, the response has `actionPerformed: true`, `waitCompleted: false`, `waitError`, and a page `summary` (a batch stops at that step): do not repeat the click; read the summary.',
      '`waitFor`: a CSS selector string, `{selector?, text?, state?: "visible"|"hidden", url?, urlChanged?, documentChanged?, pageIdleMs?}` (every given key must hold), or `{anyOf: [...]}` (first match wins). `text` is a case-sensitive substring of the visible page text. Selector and text waits search every frame of the tab, cross-origin iframes included: "visible" holds when any frame matches, "hidden" when none does.',
      'Standalone waits, after the fact:',
      '- wait_for {selector | text | waitFor, timeoutMs}: returns when the element is visible or the text is present; `waitFor: {selector|text, state: "hidden"}` waits for it to disappear.',
      '- wait_for_change {selector?, timeoutMs}: returns on navigation or a content change. With `selector`, any change inside that element (its appearance counts); without, at least 24 changed characters or 3 elements in the main content.',
      '- wait_url {url, timeoutMs}: returns once a document whose URL (query string ignored unless `url` contains "?") contains `url` has loaded, e.g. after an SSO redirect lands on that site.',
      '- wait_event {eventTypes, timeoutMs}: returns on a raw BiDi event for this tab.',
      '`timeoutMs` defaults to 10000. Wait for the final content ("Registration Results"), not a loading placeholder ("Loading…", "Processing…"): e.g. `waitFor: {anyOf: [{text: "Registration Results"}, {text: "Error"}]}`, or `{selector: ".spinner", state: "hidden"}` followed by reading the result.',
      ...features.flatMap((feature) => feature.description?.length ? ['', ...feature.description] : []),
    ].join('\n');
  const parameters = z.object({
      ...featureParams,
      action: z.enum([...ACTIONS, ...featureActions] as [string, ...string[]]),
      tabId: z.string().optional().describe('Tab from `tabs` (tab_N). Pass it on every call; required for actions that can change a page.'),
      target: z.string().optional().describe('Alternative to tabId: URL or title substring that must match exactly one tab.'),
      url: z.string().optional().describe('open/navigate: destination. wait_url: substring the loaded URL must contain.'),
      ...targetShape,
      destination: z.string().optional().describe('drag: CSS selector of the drop target.'),
      text: z.string().optional().describe('type: text to append. fill: alias of value. wait_for: visible text to wait for.'),
      value: z.string().optional().describe('fill: new field value. select: option value or visible text.'),
      key: z.string().optional().describe('press: key or chord, e.g. "Enter", "Control+Shift+R".'),
      property: z.string().optional().describe('assert: element property to compare.'),
      equals: z.unknown().optional().describe('assert: expected property value.'),
      pointer: z.enum(['down', 'move', 'up']).optional(),
      checked: z.boolean().optional().describe('check: desired checked state.'),
      files: z.array(z.string()).optional().describe('upload: absolute file paths.'),
      dx: z.number().optional().describe('scroll/pointer: horizontal offset. history: traversal delta (-1 = back).'),
      dy: z.number().optional().describe('scroll/pointer: vertical offset.'),
      timeoutMs: z.number().int().positive().max(3_600_000).optional().describe('Wait and evaluate timeout in ms (default 10000, max one hour).'),
      output: z.string().optional().describe('screenshot: file path for the PNG (default /tmp/zen-bidi-<timestamp>.png).'),
      format: z.enum(['path', 'base64']).optional(),
      fullPage: z.boolean().optional(),
      dialogAction: z.enum(['accept', 'dismiss']).optional().describe('dialog: accept or dismiss the open page dialog.'),
      promptText: z.string().optional().describe('dialog: text to enter into a prompt() before accepting.'),
      eventTypes: z.array(z.string()).optional().describe('events/wait_event: BiDi event names, e.g. "browsingContext.load", "log.entryAdded", "browsingContext.downloadWillBegin".'),
      eventLimit: z.number().int().positive().max(500).optional(),
      root: z.string().optional().describe('inspect/form_schema: CSS selector limiting the scope. table: selector of tables (or their containers).'),
      mode: z.enum(['interactive', 'content', 'semantic']).optional(),
      maxElements: z.number().int().positive().max(500).optional(),
      fields: z.record(z.string(), z.string()).optional().describe('query: map of output name -> tag|role|name|text|<attribute>. fill_many/select_many/check_many: map of CSS selector -> value ("true"/"false" for check_many).'),
      dismissTransientHints: z.boolean().optional(),
      waitFor: waitCondition.optional(),
      waitUrl: z.string().optional().describe('Shorthand for waitFor: {url}.'),
      isolation: z.enum(['live', 'test']).optional().describe('open: "test" opens the tab in a disposable container with its own cookies.'),
      batch: z.array(batchStep).optional(),
      properties: z.array(z.object({ ...targetShape, property: z.string(), equals: z.unknown() })).optional().describe('assert_many: property checks.'),
      expression: z.string().optional().describe('evaluate: JavaScript expression or statements.'),
    });

  const dispatch = async (params: ToolParams): Promise<ActionResult> => {
        if (params.action === 'launch') {
          const launched = await launchBrowser();
          const details = launched.started
            ? { ...launched, note: 'Started a browser for foxpaw in its own profile, next to the user\'s everyday browser. The user signs in there once; logins persist. Call tabs next.' }
            : { ...launched, note: 'A browser is already listening for remote control; nothing was started. Call tabs next.' };
          return { details };
        }
        await browser.watchPrompts();
        const timeout = params.timeoutMs ?? 10_000;
        let details: Record<string, unknown>;
        let image: string | undefined;
        if (params.action === 'tabs') {
          details = { ...(await tabs()), capabilities: await browser.capabilities() };
        } else {
          const { context, tabId: currentTabId } = await target(params.action, params.tabId, params.target);
          const blocking = browser.openPrompt(context.id);
          if (blocking && !PROMPT_SAFE[params.action as Action]) throw new Error(JSON.stringify({ tabId: currentTabId, action: params.action, actionPerformed: false, error: 'A page dialog is open in this tab.', ...promptReport(blocking) }));
          if (params.action === 'open') {
            if (!params.url) throw new Error('open requires url');
            if (params.isolation === 'test') {
              const raw = await browser.createUserContext();
              const id = `testctx_${nextTest++}`;
              const test: TestContext = { raw, tabs: new Set() };
              testContexts.set(id, test);
              const opened = await browser.openInUserContext(params.url, context.id, raw).catch(async (error: unknown) => {
                testContexts.delete(id);
                await browser.removeUserContext(raw).catch(() => undefined);
                throw error;
              });
              const openedTabId = tabId(opened.id);
              tabIsolation.set(openedTabId, 'test');
              tabTestContext.set(openedTabId, id);
              test.tabs.add(openedTabId);
              details = { tab: { tabId: openedTabId, url: opened.url, isolation: 'test' }, testContext: id };
            } else {
              let space: { userContext: string; name: string } | undefined;
              for (const feature of features) if ((space = await feature.space?.(runtime))) break;
              const opened = await browser.openWithOutcome(params.url, context.id, space?.userContext);
              const openedTabId = tabId(opened.context.id);
              if (space) tabIsolation.set(openedTabId, 'space');
              details = {
                tabId: openedTabId,
                created: opened.created,
                navigationStarted: opened.navigationStarted,
                url: opened.context.url,
                ...(space ? { isolation: 'space', space: space.name } : {}),
                ...(opened.error === undefined ? {} : { error: opened.error }),
              };
            }
          } else if (params.action === 'dialog') {
            if (!params.dialogAction) throw new Error('dialog requires dialogAction');
            try {
              await browser.handlePrompt(context.id, params.dialogAction === 'accept', params.promptText);
            } catch (error) {
              throw new Error(`No page dialog could be handled in ${currentTabId}: ${message(error)}`);
            }
            details = { tabId: currentTabId, dialogAction: params.dialogAction, handled: true, prompt: blocking ?? null };
          } else if (params.action === 'inspect') {
            details = await inspect(context, currentTabId, params.mode ?? 'interactive', params.root, params.maxElements);
          } else if (params.action === 'form_schema') {
            const frame = await documentFrame(browser.evaluateValue.bind(browser), context.id);
            details = { tabId: currentTabId, form: await formSchema(browser.evaluateValue.bind(browser), frame, params.root) };
          } else if (params.action === 'field_state') {
            const resolved = await resolve(context, currentTabId, params);
            details = { tabId: currentTabId, field: await browser.fieldState(resolved.frame.context, resolved.selector), selector: resolved.selector };
          } else if (params.action === 'table') {
            const selector = params.selector ?? params.root ?? 'table';
            const tables = await browser.evaluateValue(context.id, `(() => {
              const roots = [...document.querySelectorAll(${JSON.stringify(selector)})];
              const tables = roots.flatMap((root) => root instanceof HTMLTableElement ? [root] : [...root.querySelectorAll('table')]);
              return tables.map((table) => ({
                headers: [...table.querySelectorAll('thead th')].map((cell) => (cell.innerText || cell.textContent || '').trim()),
                rows: [...table.rows].slice(0, ${TABLE_ROW_LIMIT}).map((row) => [...row.cells].map((cell) => ({ text: (cell.innerText || cell.textContent || '').trim(), tag: cell.tagName.toLowerCase() }))),
                rowCount: table.rows.length,
                truncated: table.rows.length > ${TABLE_ROW_LIMIT},
              }));
            })()`);
            details = { tabId: currentTabId, tables };
          } else if (params.action === 'query') {
            if (!params.selector?.trim()) throw new Error('query requires selector');
            const selector = params.selector;
            const frames = await browser.frames(context.id);
            const matches = (await Promise.all(frames.map(async (frame, index) => {
              if (index === 0) return await queryElements(browser.evaluateValue.bind(browser), frame.context, selector, params.fields);
              const found = await queryElements(browser.evaluateValue.bind(browser), frame.context, selector, params.fields).catch(() => []);
              return found.map((match) => ({ ...match as Record<string, unknown>, frame: { context: frame.context, url: frame.url } }));
            }))).flat();
            details = { tabId: currentTabId, elements: matches.slice(0, QUERY_LIMIT), total: matches.length, truncated: matches.length > QUERY_LIMIT };
          } else if (params.action === 'batch') {
            if (!params.batch?.length) throw new Error('batch requires at least one step');
            const steps: Record<string, unknown>[] = [];
            let stopped: Record<string, unknown> | undefined;
            for (const [index, step] of params.batch.entries()) {
              const startedAt = Date.now();
              const completed: Record<string, unknown> = await runBatchStep(context, currentTabId, step as BatchStep, { timeoutMs: timeout }).catch((error: unknown) => {
                const failure = { tabId: currentTabId, failedStepIndex: index, actionPerformed: false, stepResults: steps, error: message(error), rollback: 'not attempted; browser side effects are not atomic' };
                throw new Error(JSON.stringify(failure));
              });
              const status = 'openPrompt' in completed ? 'promptOpened' : 'waitError' in completed ? 'waitFailed' : 'verifyError' in completed ? 'unverified' : 'completed';
              steps.push({ index, status, elapsedMs: Date.now() - startedAt, ...completed });
              if (status !== 'completed') {
                stopped = { failedStepIndex: index, actionPerformed: true, status, note: 'The step input was performed; do not repeat it. Check the page before continuing.' };
                break;
              }
            }
            const prompt = browser.openPrompt(context.id);
            details = { tabId: currentTabId, failedStepIndex: null, ...stopped, stepResults: steps, ...(prompt ? promptReport(prompt) : { final: await pageState(context) }), committed: steps.some((step) => step.action === 'commit') };
          } else if (params.action === 'fill_many' || params.action === 'select_many' || params.action === 'check_many') {
            if (!params.fields || !Object.keys(params.fields).length) throw new Error(`${params.action} requires a non-empty fields object`);
            const action = params.action === 'fill_many' ? 'fill' : params.action === 'select_many' ? 'select' : 'check';
            const steps: BatchStep[] = Object.entries(params.fields).map(([selector, raw]) => ({ action, selector, ...(action === 'check' ? { checked: raw === 'true' || raw === '1' } : { value: raw }) }));
            const completed: Record<string, unknown>[] = [];
            let failure: Record<string, unknown> | undefined;
            for (const [index, step] of steps.entries()) {
              try {
                const result: Record<string, unknown> = await runBatchStep(context, currentTabId, step, { dismissTransientHints: params.dismissTransientHints === true });
                if ('openPrompt' in result || 'verifyError' in result) {
                  failure = { failedStepIndex: index, actionPerformed: true, ...result };
                  break;
                }
                completed.push({ index, ...result });
              } catch (error) {
                const field = step.selector ? await browser.fieldState(context.id, step.selector).catch(() => undefined) : undefined;
                failure = {
                  failedStepIndex: index,
                  actionPerformed: false,
                  error: {
                    selector: step.selector,
                    reason: field?.covered ? 'covered' : message(error),
                    ...(field?.coveredBy ? { coveredBy: field.coveredBy } : {}),
                  },
                };
                break;
              }
            }
            details = failure
              ? { tabId: currentTabId, completed, ...failure, rollback: 'not attempted' }
              : { tabId: currentTabId, completed, failedStepIndex: null };
          } else if (params.action === 'assert') {
            if (!params.property || params.equals === undefined) throw new Error('assert requires property and equals');
            details = { tabId: currentTabId, assertion: await assertValue(context, params, params.property, params.equals) };
          } else if (params.action === 'assert_many') {
            if (!params.properties?.length) throw new Error('assert_many requires properties');
            details = { tabId: currentTabId, assertions: await Promise.all(params.properties.map((property) => assertValue(context, property, property.property, property.equals))) };
          } else if (params.action === 'events') {
            if (params.eventLimit) eventLimit = params.eventLimit;
            if (params.eventTypes?.length) await browser.subscribe(params.eventTypes, [context.id]);
            const contexts = new Set(await browser.treeIds(context.id));
            const ofTab = (event: { params: Record<string, unknown> }) => {
              const source = event.params.source as { context?: unknown } | undefined;
              return (typeof event.params.context === 'string' && contexts.has(event.params.context)) || (typeof source?.context === 'string' && contexts.has(source.context));
            };
            details = { tabId: currentTabId, events: eventBuffer.filter(ofTab) };
          } else if (params.action === 'wait_event') {
            if (!params.eventTypes?.length) throw new Error('wait_event requires eventTypes');
            details = { tabId: currentTabId, event: await browser.waitForEvent(context.id, params.eventTypes, timeout) };
          } else if (params.action === 'close') {
            await browser.close(context.id);
            const testId = tabTestContext.get(currentTabId);
            const test = testId ? testContexts.get(testId) : undefined;
            if (testId && test) {
              test.tabs.delete(currentTabId);
              tabTestContext.delete(currentTabId);
              if (!test.tabs.size) {
                await browser.removeUserContext(test.raw);
                testContexts.delete(testId);
              }
            }
            details = { tabId: currentTabId };
          } else if (params.action === 'activate') {
            await browser.activate(context.id);
            lastActivated.set(context.id, Date.now());
            details = { tabId: currentTabId, activated: true };
          } else if (params.action === 'evaluate') {
            if (!params.expression) throw new Error('evaluate requires expression');
            const guard = browser.promptOpened(context.id);
            const evaluation = browser.evaluateValue(context.id, params.expression, timeout);
            try {
              details = await Promise.race([
                evaluation.then((value) => ({ tabId: currentTabId, value })),
                guard.opened.then((prompt) => { void evaluation.catch(() => undefined); return { tabId: currentTabId, ...promptReport(prompt) }; }),
              ]);
            } finally { guard.stop(); }
          } else if (params.action === 'screenshot') {
            const resolved = hasElementTarget(params) ? await resolve(context, currentTabId, params) : undefined;
            image = await browser.screenshot(resolved?.frame.context ?? context.id, { fullPage: params.fullPage, selector: resolved?.selector });
            // The image is returned inline; `path` (default) also writes it to disk, `base64` skips the file.
            if (params.format === 'base64') details = { tabId: currentTabId, mimeType: 'image/png' };
            else { const output = params.output ?? join(tmpdir(), `foxpaw-${Date.now()}.png`); await writeFile(output, Buffer.from(image, 'base64')); details = { tabId: currentTabId, mimeType: 'image/png', path: output }; }
          } else if (params.action === 'wait_for_change') {
            const before = await pageState(context);
            const change = await browser.waitForPageChange(context.id, timeout, params.selector);
            const after = await pageState(context);
            details = { tabId: currentTabId, actionPerformed: true, actionResult: change, waitCompleted: true, ...after, navigation: after.documentId !== before.documentId || after.url !== before.url, summary: await browser.pageSummary(context.id) };
          } else {
            const action = params.action;
            const before = await pageState(context);
            let resolved: ResolvedLocator | undefined;
            let actionResult: unknown;
            let aimed: ElementIdentity | undefined;
            const loc = async () => resolved ??= await resolve(context, currentTabId, params);
            const perform = async (): Promise<void> => {
              switch (action) {
                case 'navigate': if (!params.url) throw new Error('navigate requires url'); await browser.navigate(context.id, params.url); return;
                case 'reload': await browser.reload(context.id); return;
                case 'history': if (params.dx === undefined) throw new Error('history requires dx'); await browser.traverseHistory(context.id, params.dx); return;
                case 'click': { const located = await loc(); aimed = await browser.click(located.frame.context, located.selector, located.identity); return; }
                case 'double_click': { const located = await loc(); aimed = await browser.doubleClick(located.frame.context, located.selector, located.identity); return; }
                case 'right_click': { const located = await loc(); aimed = await browser.rightClick(located.frame.context, located.selector, located.identity); return; }
                case 'hover': { const located = await loc(); aimed = await browser.hover(located.frame.context, located.selector, located.identity); return; }
                case 'drag': { if (!params.destination) throw new Error('drag requires destination'); const located = await loc(); aimed = await browser.drag(located.frame.context, located.selector, params.destination, located.identity); return; }
                case 'pointer': { if (!params.pointer) throw new Error('pointer requires pointer'); const located = await loc(); aimed = await browser.pointer(located.frame.context, located.selector, params.pointer, params.dx ?? 0, params.dy ?? 0, located.identity); return; }
                case 'fill': {
                  const value = params.value ?? params.text;
                  if (value === undefined) throw new Error('fill requires value');
                  const located = await loc();
                  actionResult = await browser.fill(located.frame.context, located.selector, value);
                  return;
                }
                case 'type': {
                  if (params.text === undefined) throw new Error('type requires text');
                  const located = hasElementTarget(params) ? await loc() : undefined;
                  actionResult = await browser.type(located?.frame.context ?? context.id, located?.selector, params.text);
                  return;
                }
                case 'press': {
                  if (!params.key) throw new Error('press requires key');
                  const located = hasElementTarget(params) ? await loc() : undefined;
                  await browser.press(located?.frame.context ?? context.id, keyValue(params.key), located?.selector);
                  return;
                }
                case 'scroll': {
                  if (params.dx === undefined && params.dy === undefined) { const located = await loc(); await browser.scrollIntoView(located.frame.context, located.selector); return; }
                  await browser.scroll(context.id, params.dx ?? 0, params.dy ?? 0);
                  return;
                }
                case 'select': {
                  if (params.value === undefined) throw new Error('select requires value');
                  const located = await loc();
                  actionResult = await browser.select(located.frame.context, located.selector, params.value);
                  return;
                }
                case 'check': { if (params.checked === undefined) throw new Error('check requires checked'); const located = await loc(); await browser.check(located.frame.context, located.selector, params.checked); return; }
                case 'upload': { if (!params.files?.length) throw new Error('upload requires files'); const located = await loc(); await browser.upload(located.frame.context, located.selector, params.files); return; }
                case 'submit_form': { const located = await loc(); await browser.submitForm(located.frame.context, located.selector); return; }
                case 'wait_for': return;
                case 'wait_url': if (!params.url) throw new Error('wait_url requires url'); await browser.waitForUrl(context.id, params.url, timeout); return;
                default: throw new Error(`Unsupported action ${action}`);
              }
            };
            // A plain CSS selector or `text` is the wait condition itself; resolving it first would fail before the element appears.
            const locatorFree = !params.handle && !params.role && !params.locator && params.name === undefined;
            const condition = action === 'wait_for'
              ? asWaitCondition(params.waitFor) ?? (locatorFree && params.selector ? params.selector : locatorFree && params.text !== undefined ? { text: params.text } : (await loc()).selector)
              : asWaitCondition(params.waitFor) ?? (params.waitUrl ? { url: params.waitUrl } : undefined);
            const scope = new ActionScope(browser, context.id, action, timeout);
            await scope.arm(condition, before.url, before.documentId);
            const outcome = await runGuarded(context.id, scope, perform);
            const element = { selector: resolved?.selector, ...(aimed ? { target: aimed } : {}) };
            const verified = outcome.verifyError !== undefined ? verification(outcome.verifyError) : VERIFIED_ACTIONS[action as Action] && (action !== 'type' || hasElementTarget(params)) ? { verified: true } : {};
            const submitted = action === 'submit_form' ? { submitted: true } : {};
            if (outcome.prompt) {
              details = { tabId: currentTabId, actionPerformed: true, actionResult: actionResult ?? action, ...submitted, ...verified, waitCompleted: condition === undefined ? null : false, ...element, ...promptReport(outcome.prompt) };
            } else if (outcome.failed) {
              const { error } = outcome.failed;
              const diagnostic = diagnose(scope, error);
              if (!outcome.performed) {
                const field = resolved ? await browser.fieldState(resolved.frame.context, resolved.selector).catch(() => undefined) : undefined;
                throw new Error(JSON.stringify({
                  tabId: currentTabId,
                  action,
                  actionPerformed: false,
                  error: message(error),
                  ...(error instanceof FormInvalidError ? { submitted: false, invalidFields: error.invalidFields } : {}),
                  selector: resolved?.selector,
                  ...(field === undefined ? {} : { field }),
                  diagnostic,
                }));
              }
              const prompt = browser.openPrompt(context.id);
              details = {
                tabId: currentTabId,
                actionPerformed: true,
                actionResult: actionResult ?? action,
                ...submitted,
                ...verified,
                waitCompleted: false,
                waitError: message(error),
                ...(prompt ? promptReport(prompt) : { pageStateAfterAction: await pageState(context).catch(() => undefined), summary: await browser.pageSummary(context.id).catch(() => undefined) }),
                ...element,
                diagnostic,
              };
            } else {
              const prompt = browser.openPrompt(context.id);
              const after = prompt ? undefined : await pageState(context);
              details = {
                tabId: currentTabId,
                actionPerformed: true,
                actionResult: actionResult ?? action,
                ...submitted,
                ...verified,
                waitCompleted: condition === undefined ? null : true,
                ...(after ? { ...after, navigation: after.documentId !== before.documentId || after.url !== before.url } : promptReport(prompt!)),
                ...outcome.result,
                ...element,
              };
            }
          }
        }
        return { details, ...(image === undefined ? {} : { image }) };
  };

  const describe = async (context: Context, currentTabId: string, targetSpec: Target): Promise<TargetDescription | undefined> => {
    if (!hasElementTarget(targetSpec)) return undefined;
    const resolved = await resolve(context, currentTabId, targetSpec);
    const facts = await browser.evaluateValue(resolved.frame.context, `(() => {
      let root = document; let element;
      for (const part of ${JSON.stringify(resolved.selector.split('>>>').map((part) => part.trim()))}) { element = root.querySelector(part); if (!element) return null; root = element.shadowRoot ?? element; }
      const form = element.form ?? element.closest('form');
      return {
        tag: element.tagName.toLowerCase(),
        type: element.getAttribute('type') ?? undefined,
        // Never a field's value (it may be a password or a filled secret); a button-like input's value is its label.
        text: (element.innerText || (/^(submit|button|reset)$/i.test(element.getAttribute('type') ?? '') ? element.value : '') || element.getAttribute('aria-label') || '').trim().slice(0, 120),
        form: form ? { action: form.action || location.href, method: (form.method || 'get').toLowerCase() } : undefined,
      };
    })()`) as { tag: string; type?: string; text: string; form?: { action: string; method: string } } | null;
    if (!facts) return undefined;
    return { tabId: currentTabId, url: context.url, selector: resolved.selector, role: resolved.identity.role, name: resolved.identity.name, ...facts };
  };

  const runtime: ToolRuntime = {
    browser,
    tabId,
    target,
    resolve,
    describe,
    pageState,
    registerElement: (record, handle) => {
      if (handle !== undefined) {
        if (!elements.has(handle)) throw new Error(`Unknown element handle ${JSON.stringify(handle)}`);
        elements.set(handle, record);
        return handle;
      }
      const minted = `el_${nextElement++}`;
      elements.set(minted, record);
      return minted;
    },
  };
  const handlers = Object.fromEntries(features.flatMap((feature) => Object.entries(feature.actions ?? {})));

  const execute = async (params: ToolParams, signal?: AbortSignal) => await serialize(async () => {
    if (signal?.aborted) throw new Error('Firefox browser action aborted');
    const call: ActionCall = { action: params.action, params };
    const startedAt = Date.now();
    let outcome: ActionOutcome;
    try {
      for (const feature of features) await feature.before?.(call, runtime);
      const handler = handlers[params.action];
      outcome = { result: handler ? await handler(call, runtime, signal) : await dispatch(params), startedAt };
    } catch (error) {
      outcome = { error, startedAt };
    }
    for (const feature of features) outcome = await feature.after?.(call, outcome, runtime) ?? outcome;
    if (!outcome.result) throw outcome.error;
    const { details, image } = outcome.result;
    const content: ToolContent[] = [{ type: 'text', text: JSON.stringify(details) }];
    if (image !== undefined) content.push({ type: 'image', data: image, mimeType: 'image/png' });
    return { content, details };
  });

  return { name: 'zen_browser', label: 'Zen / Firefox browser', description, parameters, execute, shutdown, runtime };
}
