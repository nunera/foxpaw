import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent';
import { BrokerBidiClient } from '../src/broker-client.ts';
import { ZenBrowser, ZenEmptyTabContextFilter, PageEvaluationError, type Context } from '../src/browser.ts';
import { ActionScope, type WaitCondition } from '../src/action-scope.ts';
import { documentFrame, formSchema, queryElements, semanticSnapshot, type ElementIdentity, type FrameRef, type Locator, type ResolvedLocator } from '../src/locator.ts';
import { summarizeDiagnostic, type ActionDiagnostic } from '../src/diagnostics.ts';
import { TraceRecorder, safeReplayActions, type TraceEntry } from '../src/trace.ts';

const ACTIONS = [
  'tabs', 'inspect', 'controls', 'form_schema', 'form_values', 'field_state', 'query', 'table',
  'events', 'diagnostics', 'report', 'wait_event', 'downloads', 'open', 'activate',
  'close', 'navigate', 'reload', 'history', 'click', 'double_click', 'right_click',
  'hover', 'drag', 'pointer', 'fill', 'fill_many', 'clear_many', 'type', 'press',
  'scroll', 'select', 'select_many', 'check', 'check_many', 'assert', 'assert_many',
  'batch', 'submit_form', 'upload', 'wait_for', 'wait_for_change', 'wait_url', 'evaluate', 'dialog',
  'screenshot', 'trace_start', 'trace_stop', 'trace_export', 'trace_replay',
  'state_export', 'state_import', 'emulate', 'permissions', 'route_add', 'route_remove',
  'route_list',
] as const;
type Action = typeof ACTIONS[number];
type ElementRecord = { tabId: string; locator: Locator; frame: FrameRef; identity: { tag: string; role: string | null; name: string | null }; nodeId: string };
type TestContext = { raw: string; tabs: Set<string>; routes: Map<string, string>; emulated: Set<string>; permissions: Map<string, Set<string>> };
type Target = { selector?: string; handle?: string; role?: string; name?: string; locator?: Locator };
type BatchStep = Target & { action: 'fill' | 'select' | 'check' | 'clear' | 'click' | 'commit' | 'press' | 'assert' | 'scroll'; value?: string; text?: string; checked?: boolean; key?: string; property?: string; equals?: unknown; waitFor?: WaitCondition };

const keyCodes: Record<string, string> = {
  Enter: '\uE007', Escape: '\uE00C', Tab: '\uE004', ArrowUp: '\uE013', ArrowDown: '\uE015',
  ArrowLeft: '\uE012', ArrowRight: '\uE014', Backspace: '\uE003', Delete: '\uE017',
  Home: '\uE011', End: '\uE010',
};

export default function registerZenBrowser(pi: ExtensionAPI) {
  const browser = new ZenBrowser(new BrokerBidiClient());
  const emptyTabContexts = new ZenEmptyTabContextFilter();
  const tabIds = new Map<string, string>();
  const elements = new Map<string, ElementRecord>();
  const tabIsolation = new Map<string, 'live' | 'test'>();
  const tabTestContext = new Map<string, string>();
  const testContexts = new Map<string, TestContext>();
  const diagnostics = new Map<string, ActionDiagnostic[]>();
  const eventBuffer: Array<{ method: string; params: Record<string, unknown>; receivedAt: number }> = [];
  const trace = new TraceRecorder();
  let isZen: Promise<boolean> | undefined;
  const targetsZen = () => (isZen ??= (async () => {
    const session = await browser.bidi.sessionInfo?.();
    const capabilities = session?.capabilities;
    return Boolean(capabilities && typeof capabilities === 'object' && !Array.isArray(capabilities) && capabilities.browserName === 'zen');
  })());
  const lastActivated = new Map<string, number>();
  let nextTab = 1;
  let nextElement = 1;
  let nextTest = 1;
  let eventLimit = 100;
  let tail = Promise.resolve();

  pi.on('session_shutdown', async () => { await browser.bidi.close(); });
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
  const tabs = async () => {
    const snapshot = await Promise.all((await roots()).map(async (context) => ({
      context,
      tabId: tabId(context.id),
      focused: await browser.evaluateValue(context.id, '({ focused: document.hasFocus(), visible: document.visibilityState === "visible" })').catch(() => ({ focused: false, visible: false })),
    })));
    const visibleFocused = snapshot.filter((tab) => tab.focused && typeof tab.focused === 'object' && tab.focused.focused === true && tab.focused.visible === true);
    const focused = visibleFocused.length === 1 ? visibleFocused : snapshot.filter((tab) => tab.focused && typeof tab.focused === 'object' && tab.focused.focused === true);
    const activeContextId = focused.length === 1 ? focused[0]!.context.id : undefined;
    const records = snapshot.map(({ context, tabId: id }) => {
      const active = context.id === activeContextId;
      return { tabId: id, url: context.url, title: context.title ?? '', isolation: tabIsolation.get(id) ?? 'live', active, focused: active, lastActivatedAt: lastActivated.get(context.id) };
    });
    return { tabs: records, activeTabId: activeContextId ? tabId(activeContextId) : undefined };
  };
  const target = async (action: Action, requestedTabId?: string, requestedTarget?: string, allowInternalReference = false) => {
    const all = await allRoots();
    const visible = await visibleRoots(all);
    const available = visible.map((context) => ({ context, tabId: tabId(context.id) }));
    if (requestedTabId) {
      const selected = available.find((tab) => tab.tabId === requestedTabId);
      if (selected) return selected;
      throw new Error(JSON.stringify({ action, actionPerformed: false, error: 'Tab closed during action dispatch', tabId: requestedTabId }));
    }
    if (requestedTarget) {
      const query = requestedTarget.toLocaleLowerCase();
      const matched = available.filter(({ context }) => context.url.toLocaleLowerCase().includes(query) || context.title?.toLocaleLowerCase().includes(query));
      if (matched.length === 1) return matched[0]!;
    }
    if (!requestedTabId && !requestedTarget) {
      const focused = await Promise.all(available.map(async (entry) => ({ ...entry, focused: await browser.evaluateValue(entry.context.id, 'document.hasFocus()').catch(() => false) === true })));
      if (focused.filter((entry) => entry.focused).length === 1) return focused.find((entry) => entry.focused)!;
      if (allowInternalReference) {
        const visibleIds = new Set(visible.map((context) => context.id));
        const internal = all.filter((context) => !visibleIds.has(context.id));
        const focusedInternal = await Promise.all(internal.map(async (context) => ({
          context,
          tabId: tabId(context.id),
          focused: await browser.evaluateValue(context.id, 'document.hasFocus()').catch(() => false) === true,
        })));
        if (focusedInternal.filter((entry) => entry.focused).length === 1) return focusedInternal.find((entry) => entry.focused)!;
        if (!available.length && internal.length === 1) return { context: internal[0]!, tabId: tabId(internal[0]!.id) };
      }
    }
    throw new Error(`${action} requires a tabId or a unique target. Call tabs and use its activeTabId or tabId.`);
  };
  const pageState = async (context: Context) => ({
    url: await browser.url(context.id),
    title: await browser.evaluateValue(context.id, 'document.title') as string,
    documentId: (await documentFrame(browser.evaluateValue.bind(browser), context.id)).documentId,
  });
  const resolve = async (context: Context, currentTabId: string, params: Target) => {
    if (params.handle) {
      const record = elements.get(params.handle);
      if (!record) throw new Error(`Unknown element handle ${JSON.stringify(params.handle)}. Call inspect again.`);
      if (record.tabId !== currentTabId) throw new Error(`Element handle ${JSON.stringify(params.handle)} belongs to another tab.`);
      const resolved = await browser.resolveLocator(context.id, record.locator);
      const nodeId = await browser.elementId(resolved.frame.context, resolved.selector);
      if (nodeId !== record.nodeId || resolved.frame.documentId !== record.frame.documentId || JSON.stringify(resolved.identity) !== JSON.stringify(record.identity)) throw new Error(`Stale element handle ${params.handle}. Call inspect again.`);
      return resolved;
    }
    const locator = params.locator ?? (params.role ? { role: params.role, name: params.name } : { css: params.selector });
    if (!locator.css && !locator.role) throw new Error('This action requires selector, handle, role, or locator');
    return await browser.resolveLocator(context.id, locator);
  };

  const requireTest = (currentTabId: string) => {
    if (tabIsolation.get(currentTabId) !== 'test') throw new Error('State operations require an isolated test tab.');
    const id = tabTestContext.get(currentTabId);
    const context = id ? testContexts.get(id) : undefined;
    if (!id || !context) throw new Error('State operations require an isolated test tab.');
    return [id, context] as const;
  };
  const redactCookieState = (state: unknown) => {
    if (!state || typeof state !== 'object' || !('cookies' in state) || !Array.isArray(state.cookies)) return state;
    return { ...state, cookies: state.cookies.map((cookie) => cookie && typeof cookie === 'object' && 'httpOnly' in cookie && cookie.httpOnly && 'value' in cookie ? { ...cookie, value: '[REDACTED]' } : cookie) };
  };
  const recordDiagnostic = (currentTabId: string, scope: ActionScope, error?: unknown) => {

    const diagnostic = summarizeDiagnostic(scope.action, scope.context, scope.startedAt, scope.events, error instanceof PageEvaluationError ? error : undefined);
    const records = diagnostics.get(currentTabId) ?? [];
    records.push(diagnostic);
    diagnostics.set(currentTabId, records.slice(-50));
    return diagnostic;
  };
  const asWaitCondition = (value: unknown): WaitCondition | undefined => {
    if (value === undefined || typeof value === 'string') return value;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('waitFor must be a selector string or a wait-condition object.');
    const validatePredicate = (predicate: unknown) => {
      if (!predicate || typeof predicate !== 'object' || Array.isArray(predicate)) throw new Error('waitFor contains a malformed predicate.');
      const record = predicate as Record<string, unknown>;
      const allowed: Record<string, true> = { selector: true, text: true, url: true, urlChanged: true, documentChanged: true, pageIdleMs: true };
      if (!Object.keys(record).length || Object.keys(record).some((key) => !allowed[key])) throw new Error('waitFor contains an unsupported predicate.');
      if ((record.selector !== undefined && typeof record.selector !== 'string') || (record.text !== undefined && typeof record.text !== 'string') || (record.url !== undefined && typeof record.url !== 'string') || (record.urlChanged !== undefined && typeof record.urlChanged !== 'boolean') || (record.documentChanged !== undefined && typeof record.documentChanged !== 'boolean') || (record.pageIdleMs !== undefined && (typeof record.pageIdleMs !== 'number' || record.pageIdleMs < 0))) throw new Error('waitFor contains an invalid predicate value.');
      return record;
    };
    const record = value as Record<string, unknown>;
    if ('anyOf' in record) {
      if (Object.keys(record).length !== 1 || !Array.isArray(record.anyOf) || !record.anyOf.length) throw new Error('waitFor.anyOf must be a non-empty predicate array.');
      return { anyOf: record.anyOf.map(validatePredicate) as Array<Exclude<WaitCondition, string | { anyOf: WaitCondition[] }>> };
    }
    return validatePredicate(record) as Exclude<WaitCondition, string | { anyOf: WaitCondition[] }>;
  };
  const inspect = async (context: Context, currentTabId: string, mode: 'interactive' | 'content' | 'semantic', root?: string, maxElements = 100) => {
    const frame = await documentFrame(browser.evaluateValue.bind(browser), context.id);
    const snapshot = await semanticSnapshot(browser.evaluateValue.bind(browser), frame, mode, Math.min(maxElements, 500), root);
    const nodes = await Promise.all(snapshot.map(async (node) => {
      const item = node as Record<string, unknown>;
      const handle = `el_${nextElement++}`;
      const locator: Locator = { css: String(item.selector), role: typeof item.role === 'string' ? item.role : undefined, name: typeof item.name === 'string' ? item.name : undefined, exact: true, frame };
      const identity = { tag: String(item.tag), role: typeof item.role === 'string' ? item.role : null, name: typeof item.name === 'string' ? item.name : null };
      const nodeId = await browser.elementId(frame.context, locator.css!);
      elements.set(handle, { tabId: currentTabId, locator, frame, identity, nodeId });
      return { handle, frame, documentId: frame.documentId, ...item };
    }));
    return { tabId: currentTabId, elements: nodes };
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
  const runBatchStep = async (context: Context, currentTabId: string, step: BatchStep, options?: { dismissTransientHints?: boolean }) => {
    const before = await pageState(context);
    let result: Record<string, unknown>;
    if (step.action === 'assert') {
      if (!step.property) throw new Error('assert requires property');
      result = await assertValue(context, step, step.property, step.equals);
    } else {
      const resolved = await resolve(context, currentTabId, step);
      result = { selector: resolved.selector };
      if (step.action === 'fill') {
        const value = step.value ?? step.text;
        if (value === undefined) throw new Error('fill requires value');
        const textEntry = await browser.fill(resolved.frame.context, resolved.selector, value);
        result = { ...result, ...textEntry };
        if (options?.dismissTransientHints) result = { ...result, transientHint: await browser.dismissTransientHint(resolved.frame.context, resolved.selector) };
      } else if (step.action === 'clear') {
        result = { ...result, ...(await browser.fill(resolved.frame.context, resolved.selector, '')) };
      } else if (step.action === 'select') {
        if (step.value === undefined) throw new Error('select requires value');
        await browser.select(resolved.frame.context, resolved.selector, step.value);
      } else if (step.action === 'check') {
        if (step.checked === undefined) throw new Error('check requires checked');
        await browser.check(resolved.frame.context, resolved.selector, step.checked);
      } else if (step.action === 'press') {
        if (!step.key) throw new Error('press requires key');
        await browser.press(resolved.frame.context, keyCodes[step.key] ?? keyCodes[step.key.charAt(0).toUpperCase() + step.key.slice(1).toLowerCase()] ?? step.key, resolved.selector);
      } else if (step.action === 'scroll') {
        await browser.scrollIntoView(resolved.frame.context, resolved.selector);
      } else {
        result = { ...result, target: await browser.click(resolved.frame.context, resolved.selector, resolved.identity) };
      }
    }
    if (step.waitFor) {
      const scope = new ActionScope(browser, context.id, `batch:${step.action}`, 10_000);
      await scope.arm(asWaitCondition(step.waitFor), before.url, before.documentId);
      await scope.run(async () => {});
    }
    return { action: step.action, ...result, after: await pageState(context) };
  };
  const replaySafe = async (context: Context, entry: TraceEntry, timeoutMs: number) => {
    const parameters = entry.parameters;
    const locator = entry.locator && typeof entry.locator === 'object' && 'selector' in entry.locator && typeof entry.locator.selector === 'string' ? entry.locator as { selector: string; frame?: { context?: string } } : undefined;
    if (entry.action === 'inspect') { await semanticSnapshot(browser.evaluateValue.bind(browser), await documentFrame(browser.evaluateValue.bind(browser), context.id), 'semantic', 500); return; }
    if (entry.action === 'query') { if (typeof parameters.selector !== 'string') throw new Error('Safe trace query lacks a selector.'); await browser.evaluateValue(context.id, `document.querySelectorAll(${JSON.stringify(parameters.selector)}).length`); return; }
    if (entry.action === 'wait_for') { const condition = parameters.waitFor; if (typeof condition === 'string') await browser.waitFor(context.id, condition, timeoutMs); else if (locator) await browser.waitFor(locator.frame && typeof locator.frame === 'object' && 'context' in locator.frame && typeof locator.frame.context === 'string' ? locator.frame.context : context.id, locator.selector, timeoutMs); else if (typeof parameters.selector === 'string') await browser.waitFor(context.id, parameters.selector, timeoutMs); else throw new Error('Safe trace wait lacks a locator.'); return; }
    if (entry.action === 'wait_for_change') { await browser.waitForPageChange(context.id, timeoutMs); return; }
    if (entry.action === 'wait_url') { if (typeof parameters.url !== 'string') throw new Error('Safe trace URL wait lacks a URL.'); await browser.waitForUrl(context.id, parameters.url, timeoutMs); return; }
    if (entry.action === 'wait_event') { if (!Array.isArray(parameters.eventTypes) || !parameters.eventTypes.every((event) => typeof event === 'string')) throw new Error('Safe trace event wait lacks event types.'); await browser.waitForEvent(context.id, parameters.eventTypes, timeoutMs); return; }
    if (entry.action === 'hover') { if (!locator) throw new Error('Safe trace hover lacks a locator.'); await browser.hover(context.id, locator.selector); return; }
    if (entry.action === 'scroll') { if (typeof parameters.dx === 'number' || typeof parameters.dy === 'number') await browser.scroll(context.id, typeof parameters.dx === 'number' ? parameters.dx : 0, typeof parameters.dy === 'number' ? parameters.dy : 0); else if (locator) await browser.scrollIntoView(context.id, locator.selector); else throw new Error('Safe trace scroll lacks a target.'); return; }
    if (entry.action === 'screenshot') { await browser.screenshot(context.id, {}); return; }
    throw new Error(`Safe trace replay rejects ${entry.action}.`);
  };

  const z = pi.zod;
  const targetShape = { selector: z.string().optional(), handle: z.string().optional(), role: z.string().optional(), name: z.string().optional(), locator: z.object({ css: z.string().optional(), role: z.string().optional(), name: z.string().optional(), exact: z.boolean().optional(), checked: z.boolean().optional(), disabled: z.boolean().optional(), within: z.string().optional(), frame: z.object({ context: z.string(), documentId: z.string() }).optional() }).optional() };
  const waitPredicate = z.object({ selector: z.string().optional(), text: z.string().optional(), url: z.string().optional(), urlChanged: z.boolean().optional(), documentChanged: z.boolean().optional(), pageIdleMs: z.number().nonnegative().optional() });
  const batchStep = z.object({ ...targetShape, action: z.enum(['fill', 'select', 'check', 'clear', 'click', 'commit', 'press', 'assert', 'scroll']), value: z.string().optional(), text: z.string().optional(), checked: z.boolean().optional(), key: z.string().optional(), property: z.string().optional(), equals: z.unknown().optional(), waitFor: z.unknown().optional() });

  pi.registerTool({
    name: 'zen_browser',
    label: 'Zen / Firefox browser',
    loadMode: 'essential',
    description: 'Control visible real Zen and Firefox tabs through local loopback WebDriver BiDi. `batch` runs reversible field edits sequentially, reports each completed step, and never rolls back browser side effects. `commit` is an explicit irreversible click.',
    parameters: z.object({
      action: z.enum(ACTIONS), tabId: z.string().optional(), target: z.string().optional(), url: z.string().optional(),
      ...targetShape, destination: z.string().optional(), text: z.string().optional(), value: z.string().optional(), key: z.string().optional(), property: z.string().optional(), equals: z.unknown().optional(), pointer: z.enum(['down', 'move', 'up']).optional(), checked: z.boolean().optional(), files: z.array(z.string()).optional(), dx: z.number().optional(), dy: z.number().optional(), timeoutMs: z.number().int().positive().max(3_600_000).optional(), output: z.string().optional(), format: z.enum(['path', 'base64']).optional(), fullPage: z.boolean().optional(), dialogAction: z.enum(['accept', 'dismiss']).optional(), promptText: z.string().optional(), eventTypes: z.array(z.string()).optional(), eventLimit: z.number().int().positive().max(500).optional(), root: z.string().optional(), include: z.array(z.string()).optional(), mode: z.enum(['interactive', 'content', 'semantic', 'controls']).optional(), maxElements: z.number().int().positive().max(500).optional(), fields: z.record(z.string(), z.string()).optional(), dismissTransientHints: z.boolean().optional(), waitFor: z.unknown().optional(), waitUrl: z.string().optional(), isolation: z.enum(['live', 'test']).optional(), kind: z.enum(['accessibility', 'performance', 'failure']).optional(), replayMode: z.enum(['dry_run', 'safe']).optional(), emulation: z.record(z.string(), z.unknown()).optional(), permission: z.object({ name: z.string(), state: z.string() }).optional(), route: z.object({ url: z.string(), phases: z.array(z.enum(['beforeRequestSent','responseStarted'])), action: z.enum(['continue','abort','fulfill']), headers: z.record(z.string(), z.string()).optional(), status: z.number().optional(), body: z.string().optional() }).optional(), routeId: z.string().optional(), batch: z.array(batchStep).optional(), stopOnFailure: z.boolean().optional(), waitAfterEachNavigation: z.boolean().optional(), verify: z.boolean().optional(), dispatch: z.array(z.enum(['input','change'])).optional(), properties: z.array(z.object({ ...targetShape, property: z.string(), equals: z.unknown() })).optional(),
      expression: z.string().optional(),
    }),
    async execute(_id, params, signal) {
      return await serialize(async () => {
        if (signal?.aborted) throw new Error('Firefox browser action aborted');
        const timeout = params.timeoutMs ?? 10_000;
        let details: Record<string, unknown>;
        let image: string | undefined;
        if (params.action === 'tabs') {
          const listed = await tabs();
          details = { ...listed, capabilities: await browser.capabilities() };
        } else if (params.action === 'trace_start') {
          details = { traceId: trace.start() };
        } else if (params.action === 'trace_stop') {
          if (!params.output) throw new Error('trace_stop requires output');
          details = { traceId: await trace.stop(params.output), output: params.output };
        } else if (params.action === 'trace_export') {
          if (!params.output) throw new Error('trace_export requires output');
          await trace.export(params.output);
          details = { output: params.output };
        } else {
          const selected = await target(params.action, params.tabId, params.target, params.action === 'open');
          const { context, tabId: currentTabId } = selected;
          if (params.action === 'open') {
            if (!params.url) throw new Error('open requires url');
            if (params.isolation === 'test') {
              await browser.requireFeature('browserUserContexts');
              const raw = await browser.createUserContext();
              const id = `testctx_${nextTest++}`;
              testContexts.set(id, { raw, tabs: new Set(), routes: new Map(), emulated: new Set(), permissions: new Map() });
              const opened = await browser.openInUserContext(params.url, context.id, raw);
              const openedTabId = tabId(opened.id);
              tabIsolation.set(openedTabId, 'test');
              tabTestContext.set(openedTabId, id);
              testContexts.get(id)!.tabs.add(openedTabId);
              details = { tab: { tabId: openedTabId, url: opened.url, isolation: 'test' }, testContext: id };
            } else {
              const opened = await browser.openWithOutcome(params.url, context.id);
              const openedTabId = tabId(opened.context.id);
              details = {
                tabId: openedTabId,
                created: opened.created,
                navigationStarted: opened.navigationStarted,
                url: opened.context.url,
                ...(opened.error === undefined ? {} : { error: opened.error }),
              };
            }
          } else if (params.action === 'inspect' || params.action === 'controls') {
            details = await inspect(context, currentTabId, params.mode === 'content' ? 'content' : params.mode === 'semantic' ? 'semantic' : 'interactive', params.root, params.maxElements);
          } else if (params.action === 'form_schema' || params.action === 'form_values') {
            details = { tabId: currentTabId, fields: await formSchema(browser.evaluateValue.bind(browser), context.id, params.root) };
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
                rows: [...table.rows].map((row) => [...row.cells].map((cell) => ({ text: (cell.innerText || cell.textContent || '').trim(), tag: cell.tagName.toLowerCase() }))),
              }));
            })()`);
            details = { tabId: currentTabId, tables };
          } else if (params.action === 'query') {
            if (!params.selector?.trim()) throw new Error('query requires selector');
            details = { tabId: currentTabId, elements: await queryElements(browser.evaluateValue.bind(browser), context.id, params.selector, params.fields) };
          } else if (params.action === 'batch') {
            if (!params.batch?.length) throw new Error('batch requires at least one step');
            const steps: Record<string, unknown>[] = [];
            for (const [index, step] of params.batch.entries()) {
              const startedAt = Date.now();
              try {
                const completed = await runBatchStep(context, currentTabId, step as BatchStep);
                steps.push({ index, status: 'completed', elapsedMs: Date.now() - startedAt, ...completed });
              } catch (error) {
                const failure = { tabId: currentTabId, failedStepIndex: index, stepResults: steps, error: error instanceof Error ? error.message : String(error), rollback: 'not attempted; browser side effects are not atomic' };
                throw new Error(JSON.stringify(failure));
              }
            }
            details = { tabId: currentTabId, failedStepIndex: null, stepResults: steps, final: await pageState(context), committed: steps.some((step) => step.action === 'commit') };
          } else if (params.action === 'fill_many' || params.action === 'clear_many' || params.action === 'select_many' || params.action === 'check_many') {
            if (!params.fields || !Object.keys(params.fields).length) throw new Error(`${params.action} requires a non-empty fields object`);
            const action = params.action === 'fill_many' ? 'fill' : params.action === 'clear_many' ? 'clear' : params.action === 'select_many' ? 'select' : 'check';
            const steps = Object.entries(params.fields).map(([selector, raw]) => ({ action, selector, ...(action === 'check' ? { checked: raw === 'true' || raw === '1' } : action === 'clear' ? {} : { value: raw }) })) as BatchStep[];
            const completed: Record<string, unknown>[] = [];
            let failure: Record<string, unknown> | undefined;
            for (const [index, step] of steps.entries()) {
              try {
                completed.push({ index, ...(await runBatchStep(context, currentTabId, step, { dismissTransientHints: params.dismissTransientHints === true })) });
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                const field = step.selector ? await browser.fieldState(context.id, step.selector).catch(() => undefined) : undefined;
                failure = {
                  failedStepIndex: index,
                  error: {
                    selector: step.selector,
                    reason: field?.covered ? 'covered' : message,
                    ...(field?.coveredBy ? { coveredBy: field.coveredBy } : {}),
                  },
                };
                break;
              }
            }
            details = failure
              ? { tabId: currentTabId, completed, ...failure, rollback: 'not attempted' }
              : { tabId: currentTabId, completed, failedStepIndex: null };
          } else if (params.action === 'assert' || params.action === 'assert_many') {
            if (params.action === 'assert') {
              if (!params.property || params.equals === undefined) throw new Error('assert requires property and equals');
              details = { tabId: currentTabId, assertion: await assertValue(context, params, params.property, params.equals) };
            } else {
              if (!params.properties?.length) throw new Error('assert_many requires properties');
              details = { tabId: currentTabId, assertions: await Promise.all(params.properties.map((property) => assertValue(context, property, property.property, property.equals))) };
            }
          } else if (params.action === 'submit_form') {
            const submit = await resolve(context, currentTabId, params);
            const before = await pageState(context);
            const scope = new ActionScope(browser, context.id, 'submit_form', timeout);
            const condition = asWaitCondition(params.waitFor);
            await scope.arm(condition, before.url, before.documentId);
            let actionPerformed = false;
            try {
              const result = await scope.run(async () => { await browser.submitForm(submit.frame.context, submit.selector); actionPerformed = true; });
              details = { tabId: currentTabId, submitted: true, actionPerformed, waitCompleted: condition === undefined ? null : true, selector: submit.selector, ...(await pageState(context)), ...result };
            } catch (error) {
              if (!actionPerformed) throw error;
              details = { tabId: currentTabId, submitted: true, actionPerformed, waitCompleted: false, waitError: error instanceof Error ? error.message : String(error), pageStateAfterAction: await pageState(context).catch(() => undefined), selector: submit.selector };
            }
          } else if (params.action === 'events' || params.action === 'downloads') {
            if (params.eventLimit) eventLimit = params.eventLimit;
            if (params.eventTypes?.length) await browser.subscribe(params.eventTypes, [context.id]);
            details = { tabId: currentTabId, [params.action]: eventBuffer.filter((event) => params.action === 'events' || event.method.startsWith('browser.download')) };
          } else if (params.action === 'diagnostics') {
            details = { tabId: currentTabId, diagnostics: diagnostics.get(currentTabId) ?? [] };
          } else if (params.action === 'report') {
            if (!params.kind) throw new Error('report requires kind');
            if (params.kind === 'failure') details = { tabId: currentTabId, report: (diagnostics.get(currentTabId) ?? []).at(-1) ?? 'No failed action diagnostics for this tab.' };
            else if (params.kind === 'performance') details = { tabId: currentTabId, report: await browser.evaluateValue(context.id, '({navigation:performance.getEntriesByType("navigation")[0]?.duration??0,resources:performance.getEntriesByType("resource").reduce((a,e)=>{a[e.initiatorType]=(a[e.initiatorType]||0)+1;return a},{}),transferSize:performance.getEntriesByType("resource").reduce((n,e)=>n+(e.transferSize||0),0),longTasks:PerformanceObserver.supportedEntryTypes?.includes("longtask")?performance.getEntriesByType("longtask").map(e=>({duration:e.duration,startTime:e.startTime})):[]})') };
            else details = { tabId: currentTabId, report: 'DOM semantic findings; not an accessibility conformance audit.', findings: await browser.accessibilityFindings(context.id) };
          } else if (params.action === 'wait_event') {
            if (!params.eventTypes?.length) throw new Error('wait_event requires eventTypes');
            const scope = new ActionScope(browser, context.id, 'wait_event', timeout);
            await scope.arm();
            await scope.run(async () => { await browser.waitForEvent(context.id, params.eventTypes!, timeout); });
            details = { tabId: currentTabId, ...recordDiagnostic(currentTabId, scope) };
          } else if (params.action === 'state_export') {
            const [id, test] = requireTest(currentTabId);
            if (!params.output) throw new Error('state_export requires output');
            await Bun.write(params.output, JSON.stringify({ format: 'zen-bidi-state-v1', testContext: id, cookies: redactCookieState(await browser.storageExport(test.raw)) }));
            details = { tabId: currentTabId, output: params.output };
          } else if (params.action === 'state_import') {
            const [, test] = requireTest(currentTabId);
            if (!params.output) throw new Error('state_import requires output');
            const state = await Bun.file(params.output).json();
            if (!state || typeof state !== 'object' || !('format' in state) || state.format !== 'zen-bidi-state-v1' || !('cookies' in state)) throw new Error('state_import accepts only a state file created by this relay.');
            const payload = state.cookies;
            if (!payload || typeof payload !== 'object' || !('cookies' in payload)) throw new Error('State file contains malformed cookies');
            await browser.storageImport(test.raw, payload.cookies);
            details = { tabId: currentTabId, imported: true };
          } else if (params.action === 'emulate') {
            const [, test] = requireTest(currentTabId);
            if (!params.emulation) throw new Error('emulate requires emulation');
            await browser.emulate(context.id, params.emulation);
            test.emulated.add(context.id);
            details = { tabId: currentTabId, emulated: true };
          } else if (params.action === 'permissions') {
            const [, test] = requireTest(currentTabId);
            if (!params.permission) throw new Error('permissions requires permission');
            await browser.setPermission(context.id, params.permission.name, params.permission.state);
            const names = test.permissions.get(context.id) ?? new Set<string>();
            names.add(params.permission.name);
            test.permissions.set(context.id, names);
            details = { tabId: currentTabId, permission: params.permission };
          } else if (params.action.startsWith('route_')) {
            const [id, test] = requireTest(currentTabId);
            if (params.action === 'route_add') {
              if (!params.route) throw new Error('route_add requires route');
              if (params.route.action === 'fulfill' && (params.route.status === undefined || params.route.body === undefined)) throw new Error('fulfill routes require status and body');
              const routeId = `route_${test.routes.size + 1}`;
              test.routes.set(routeId, await browser.addRoute(params.route));
              details = { tabId: currentTabId, routeId };
            } else if (params.action === 'route_remove') {
              if (!params.routeId || !test.routes.has(params.routeId)) throw new Error('Unknown routeId');
              await browser.removeRoute(test.routes.get(params.routeId)!);
              test.routes.delete(params.routeId);
              details = { tabId: currentTabId, removed: params.routeId };
            } else details = { tabId: currentTabId, routes: browser.routes(), testContext: id };
          } else if (params.action === 'trace_replay') {
            const mode = params.replayMode ?? 'dry_run';
            const entries = trace.entries();
            if (mode === 'safe') {
              const unsafe = entries.find((entry) => !safeReplayActions[entry.action]);
              if (unsafe) throw new Error(`Safe trace replay rejects ${unsafe.action}.`);
              for (const entry of entries) await replaySafe(context, entry, timeout);
            }
            details = { mode, entries: entries.length, replayed: mode === 'safe' };
          } else if (params.action === 'close') {
            const testId = tabTestContext.get(currentTabId);
            if (testId) {
              const test = testContexts.get(testId)!;
              for (const name of test.permissions.get(context.id) ?? []) await browser.resetPermission(context.id, name);
              if (test.emulated.has(context.id)) await browser.resetEmulation(context.id);
              await browser.close(context.id);
              test.tabs.delete(currentTabId);
              tabTestContext.delete(currentTabId);
              if (!test.tabs.size) {
                for (const route of test.routes.values()) await browser.removeRoute(route);
                await browser.removeUserContext(test.raw);
                testContexts.delete(testId);
              }
            } else await browser.close(context.id);
            details = { tabId: currentTabId };
          } else if (params.action === 'activate') {
            const refreshed = (await roots()).find((candidate) => tabId(candidate.id) === currentTabId);
            if (!refreshed) throw new Error(`Tab ${currentTabId} no longer exists. Call tabs to refresh the tab list.`);
            await browser.activate(refreshed.id);
            lastActivated.set(refreshed.id, Date.now());
            details = { tabId: currentTabId, activated: true, contextId: refreshed.id };
          } else {
            const before = await pageState(context);
            let resolved: ResolvedLocator | undefined;
            let actionResult: unknown;
            let actionPerformed = false;
            let target: ElementIdentity | undefined;
            const perform = async () => {
              const loc = async () => resolved ??= await resolve(context, currentTabId, params);
              switch (params.action) {
                case 'navigate': if (!params.url) throw new Error('navigate requires url'); return await browser.navigate(context.id, params.url);
                case 'reload': return await browser.reload(context.id);
                case 'history': if (params.dx === undefined) throw new Error('history requires dx'); return await browser.traverseHistory(context.id, params.dx);
                case 'click': { const located = await loc(); target = await browser.click(located.frame.context, located.selector, located.identity); return; }
                case 'double_click': { const located = await loc(); target = await browser.doubleClick(located.frame.context, located.selector, located.identity); return; }
                case 'right_click': { const located = await loc(); target = await browser.rightClick(located.frame.context, located.selector, located.identity); return; }
                case 'hover': { const located = await loc(); target = await browser.hover(located.frame.context, located.selector, located.identity); return; }
                case 'drag': { if (!params.destination) throw new Error('drag requires destination'); const located = await loc(); target = await browser.drag(located.frame.context, located.selector, params.destination, located.identity); return; }
                case 'pointer': { if (!params.pointer) throw new Error('pointer requires pointer'); const located = await loc(); target = await browser.pointer(located.frame.context, located.selector, params.pointer, params.dx ?? 0, params.dy ?? 0, located.identity); return; }
                case 'fill': {
                  const value = params.value ?? params.text;
                  if (value === undefined) throw new Error('fill requires value');
                  actionResult = await browser.fill((await loc()).frame.context, (await loc()).selector, value);
                  return;
                }
                case 'type':
                  if (params.text === undefined) throw new Error('type requires text');
                  actionResult = await browser.type(context.id, params.selector || params.handle || params.role || params.locator ? (await loc()).selector : undefined, params.text);
                  return;
                case 'press': if (!params.key) throw new Error('press requires key'); return await browser.press(context.id, keyCodes[params.key] ?? keyCodes[params.key.charAt(0).toUpperCase() + params.key.slice(1).toLowerCase()] ?? params.key, params.selector || params.handle || params.role || params.locator ? (await loc()).selector : undefined);
                case 'scroll':
                  if (params.dx === undefined && params.dy === undefined) return await browser.scrollIntoView((await loc()).frame.context, (await loc()).selector);
                  return await browser.scroll(context.id, params.dx ?? 0, params.dy ?? 0);
                case 'select':
                  if (params.value === undefined) throw new Error('select requires value');
                  return await browser.select((await loc()).frame.context, (await loc()).selector, params.value);
                case 'check': if (params.checked === undefined) throw new Error('check requires checked'); return await browser.check((await loc()).frame.context, (await loc()).selector, params.checked);
                case 'upload': if (!params.files?.length) throw new Error('upload requires files'); return await browser.upload((await loc()).frame.context, (await loc()).selector, params.files);
                case 'wait_for': return;
                case 'wait_url': if (!params.url) throw new Error('wait_url requires url'); return await browser.waitForUrl(context.id, params.url, timeout);
                case 'dialog': if (!params.dialogAction) throw new Error('dialog requires dialogAction'); return await browser.handlePrompt(context.id, params.dialogAction === 'accept', params.promptText);
                default: throw new Error(`Unsupported action ${params.action}`);
              }
            };
            if (params.action === 'evaluate') {
              if (!params.expression) throw new Error('evaluate requires expression');
              details = { tabId: currentTabId, value: await browser.evaluateValue(context.id, params.expression, timeout) };
            } else if (params.action === 'screenshot') {
              resolved = params.selector || params.handle || params.role || params.locator ? await resolve(context, currentTabId, params) : undefined;
              image = await browser.screenshot(resolved?.frame.context ?? context.id, { fullPage: params.fullPage, selector: resolved?.selector });
              // The image is returned inline; `path` (default) also writes it to disk, `base64` skips the file.
              if (params.format === 'base64') details = { tabId: currentTabId, mimeType: 'image/png' };
              else { const output = params.output ?? `/tmp/zen-bidi-${Date.now()}.png`; await Bun.write(output, Buffer.from(image, 'base64')); details = { tabId: currentTabId, mimeType: 'image/png', path: output }; }
            } else if (params.action === 'wait_for_change') {
              const change = await browser.waitForPageChange(context.id, timeout);
              const after = await pageState(context);
              details = { tabId: currentTabId, actionPerformed: true, actionResult: change, waitCompleted: true, ...after, navigation: after.documentId !== before.documentId || after.url !== before.url, summary: await browser.pageSummary(context.id) };
              trace.record({ action: params.action, parameters: params, before, after });
            } else {
              // A plain CSS selector is the wait condition itself; resolving it first would fail before the element appears.
              const condition = params.action === 'wait_for'
                ? asWaitCondition(params.waitFor) ?? (params.selector && !params.handle && !params.role && !params.locator ? params.selector : (resolved = await resolve(context, currentTabId, params)).selector)
                : asWaitCondition(params.waitFor) ?? (params.waitUrl ? { url: params.waitUrl } : undefined);
              const scope = new ActionScope(browser, context.id, params.action, timeout);
              await scope.arm(condition, before.url, before.documentId);
              try {
                const result = await scope.run(async () => { await perform(); actionPerformed = true; });
                const after = await pageState(context);
                details = { tabId: currentTabId, actionPerformed: true, actionResult: actionResult ?? params.action, waitCompleted: condition === undefined ? null : true, ...after, navigation: after.documentId !== before.documentId || after.url !== before.url, ...result, selector: resolved?.selector, ...(target ? { target } : {}) };
                trace.record({ action: params.action, parameters: params, locator: resolved, before, after, diagnostic: recordDiagnostic(currentTabId, scope) });
              } catch (error) {
                const waitError = error instanceof Error ? error.message : String(error);
                const diagnostic = recordDiagnostic(currentTabId, scope, error);
                if (!actionPerformed) {
                  const field = resolved ? await browser.fieldState(resolved.frame.context, resolved.selector).catch(() => undefined) : undefined;
                  throw new Error(JSON.stringify({
                    tabId: currentTabId,
                    action: params.action,
                    actionPerformed: false,
                    error: waitError,
                    selector: resolved?.selector,
                    ...(field === undefined ? {} : { field }),
                    diagnostic,
                  }));
                }
                details = {
                  tabId: currentTabId,
                  actionPerformed: true,
                  actionResult: params.action,
                  waitCompleted: false,
                  waitError,
                  pageStateAfterAction: await pageState(context).catch(() => undefined),
                  selector: resolved?.selector,
                  ...(target ? { target } : {}),
                  diagnostic,
                };
              }
            }
          }
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(details) }, ...(image === undefined ? [] : [{ type: 'image', data: image, mimeType: 'image/png' }])],
          details,
        };
      });
    },
  });
}
