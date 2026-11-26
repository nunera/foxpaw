import { randomBytes } from 'node:crypto';
import type { Context } from '../../browser.ts';
import type { Environment } from '../../config.ts';
import { documentFrame } from '../../locator.ts';
import { readSettings } from '../../settings.ts';
import { decide, loadPolicy } from '../../trust/policy.ts';
import { AuditLog, auditConfig, auditDir, redactParams, scrub, type AuditEntry, type AuditResult, type AuditTarget, type Host } from '../../audit/log.ts';
import type { ActionCall, ActionOutcome, Target, TargetDescription, ToolFeature, ToolRuntime } from '../core.ts';

// Actions that change a page or a tab; with `screenshots: "writes"` they get before/after screenshots.
const WRITE_ACTIONS: Record<string, true> = {
  navigate: true, reload: true, history: true, click: true, double_click: true, right_click: true, drag: true, pointer: true,
  fill: true, fill_many: true, type: true, press: true, select: true, select_many: true, check: true, check_many: true,
  batch: true, submit_form: true, upload: true, dialog: true, close: true, fill_secret: true,
};
// Element fields here name a wait condition or a query scope, not an element the action acts on.
const NOT_ACTING_ON_ELEMENT: Record<string, true> = { query: true, table: true, inspect: true, form_schema: true, wait_for: true, wait_for_change: true };
// Their text would be what is typed in them.
const VALUE_TAGS: Record<string, true> = { input: true, textarea: true, select: true };
const VALUE_ROLES: Record<string, true> = { textbox: true, searchbox: true, combobox: true, spinbutton: true };
const ERROR_LIMIT = 400;

export type AuditOptions = {
  host?: Host;
  env?: Environment;
  /** The parsed settings file; read from `env` when omitted. */
  settings?: Record<string, unknown>;
  now?: () => Date;
};

type Pending = {
  seq: number;
  contextId?: string;
  tabId?: string;
  urlBefore?: string;
  documentBefore?: string;
  target?: AuditTarget;
  stepTargets?: Array<AuditTarget | null>;
  screenshots: NonNullable<AuditEntry['screenshots']>;
  wantsScreenshots: boolean;
  actionStart: number;
};

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * Records every action (including refusals by earlier features) as one line of the audit log. Must run last: its
 * `before` sees only actions every other feature let through, and anything that throws before it is a refusal.
 */
export function auditFeature(options: AuditOptions = {}): ToolFeature {
  const env = options.env ?? process.env;
  const config = auditConfig(options.settings ?? readSettings(env));
  if (!config.enabled) return { name: 'audit' };
  const now = options.now ?? (() => new Date());
  const log = new AuditLog(auditDir(env), now);
  log.prune(config.retainDays);
  const session = randomBytes(6).toString('hex');
  const host = options.host ?? 'unknown';
  const pending = new WeakMap<ActionCall, Pending>();
  let seq = 0;

  const wantsScreenshots = (action: string) => config.screenshots === 'all' ? action !== 'tabs' && action !== 'launch' : config.screenshots === 'writes' && WRITE_ACTIONS[action] === true;

  const treeUrl = async (runtime: ToolRuntime, contextId: string): Promise<string | undefined> => {
    const tree = await runtime.browser.bidi.command('browsingContext.getTree', { root: contextId, maxDepth: 0 }).catch(() => undefined);
    const first = (tree?.contexts as Array<{ url?: unknown }> | undefined)?.[0];
    return typeof first?.url === 'string' ? first.url : undefined;
  };

  const documentOf = async (runtime: ToolRuntime, contextId: string) => runtime.browser.openPrompt(contextId)
    ? undefined
    : (await documentFrame(runtime.browser.evaluateValue.bind(runtime.browser), contextId).catch(() => undefined))?.documentId;

  const describe = async (runtime: ToolRuntime, context: Context, tabId: string, spec: Target): Promise<AuditTarget | undefined> => {
    let described: TargetDescription | undefined;
    try { described = await runtime.describe(context, tabId, spec); } catch { return undefined; }
    if (!described) return undefined;
    const { tabId: _tab, url: _url, text, ...rest } = described;
    const hideText = VALUE_TAGS[described.tag] || (described.role !== null && VALUE_ROLES[described.role]);
    const frame = spec.locator?.frame;
    const frameUrl = frame && frame.context !== context.id ? await treeUrl(runtime, frame.context) : undefined;
    return { ...rest, ...(text && !hideText ? { text } : {}), ...(frameUrl ? { frameUrl } : {}) };
  };

  // Screenshots go around the tool, so they honor what would refuse a `screenshot` action: an open dialog, or a
  // policy that doesn't simply allow reads on the page (never asking the user just for the audit's sake).
  // The reason is recorded instead of the image.
  const screenshot = async (runtime: ToolRuntime, contextId: string, url: string, name: string): Promise<{ path: string } | { skipped: string }> => {
    if (runtime.browser.openPrompt(contextId)) return { skipped: 'a page dialog is open' };
    const loaded = loadPolicy(env);
    if (!loaded.ok) return { skipped: 'the policy configuration is invalid' };
    const ruling = decide(loaded.policy, 'read', url);
    if (ruling.decision !== 'allow') return { skipped: `policy ${ruling.rule} says ${ruling.decision} for reads on ${ruling.site ?? 'this page'}` };
    try { return { path: log.saveScreenshot(name, await runtime.browser.screenshot(contextId)) }; } catch (error) { return { skipped: message(error).slice(0, ERROR_LIMIT) }; }
  };

  const summarize = (details: Record<string, unknown>, action: string, removed: string[]): AuditResult => {
    const result: AuditResult = {};
    if (typeof details.actionPerformed === 'boolean') result.actionPerformed = details.actionPerformed;
    if (typeof details.verified === 'boolean') result.verified = details.verified;
    if (typeof details.waitCompleted === 'boolean' || details.waitCompleted === null) result.waitCompleted = details.waitCompleted;
    if (typeof details.navigation === 'boolean') result.navigation = details.navigation;
    if (typeof details.failedStepIndex === 'number') result.failedStepIndex = details.failedStepIndex;
    if (action === 'open') {
      const opened = typeof details.tabId === 'string' ? details.tabId : (details.tab as { tabId?: unknown } | undefined)?.tabId;
      if (typeof opened === 'string') result.openedTabId = opened;
    }
    const prompt = details.openPrompt as { type?: unknown } | undefined;
    if (typeof prompt?.type === 'string') result.openPrompt = prompt.type;
    const problem = details.waitError ?? details.error;
    if (problem !== undefined) result.error = scrub(typeof problem === 'string' ? problem : JSON.stringify(problem), removed).slice(0, ERROR_LIMIT);
    return result;
  };

  const summarizeError = (error: unknown, removed: string[]): AuditResult => {
    const text = message(error);
    let parsed: Record<string, unknown> | undefined;
    try { const value: unknown = JSON.parse(text); if (value && typeof value === 'object' && !Array.isArray(value)) parsed = value as Record<string, unknown>; } catch { /* a plain message */ }
    const detail = parsed?.error === undefined ? text : typeof parsed.error === 'string' ? parsed.error : JSON.stringify(parsed.error);
    const result: AuditResult = { error: scrub(detail, removed).slice(0, ERROR_LIMIT) };
    if (typeof parsed?.actionPerformed === 'boolean') result.actionPerformed = parsed.actionPerformed;
    if (typeof parsed?.failedStepIndex === 'number') result.failedStepIndex = parsed.failedStepIndex;
    const policy = parsed?.policy as { decision?: unknown; reason?: unknown } | undefined;
    if (policy) result.policy = { ...(typeof policy.decision === 'string' ? { decision: policy.decision } : {}), ...(typeof policy.reason === 'string' ? { reason: scrub(policy.reason, removed) } : {}) };
    return result;
  };

  return {
    name: 'audit',
    description: [`Audit: every action is recorded (without typed values) in a local log the user can review with \`foxpaw log\`.`],
    async before(call, runtime) {
      const state: Pending = { seq: ++seq, screenshots: {}, wantsScreenshots: wantsScreenshots(call.action), actionStart: Date.now() };
      pending.set(call, state);
      const { params } = call;
      if (call.action === 'tabs' || call.action === 'launch') return;
      let resolved: { context: Context; tabId: string };
      // The action itself fails the same way; that failure is what gets recorded.
      try { resolved = await runtime.target(call.action, params.tabId, params.target); } catch { state.actionStart = Date.now(); return; }
      const { context, tabId } = resolved;
      state.contextId = context.id;
      state.tabId = tabId;
      state.urlBefore = context.url;
      state.documentBefore = await documentOf(runtime, context.id);
      if (!runtime.browser.openPrompt(context.id) && !NOT_ACTING_ON_ELEMENT[call.action]) {
        state.target = await describe(runtime, context, tabId, params);
        if (Array.isArray(params.batch)) {
          state.stepTargets = await Promise.all(params.batch.map(async (step) => await describe(runtime, context, tabId, step) ?? null));
        }
      }
      if (state.wantsScreenshots) {
        // A filled secret would be visible in the screenshot after it; never photograph one.
        const shot = call.action === 'fill_secret' ? { skipped: 'secret input' } : await screenshot(runtime, context.id, context.url, `${session}-${state.seq}-before`);
        if ('path' in shot) state.screenshots.before = shot.path; else state.screenshots.beforeSkipped = shot.skipped;
      }
      state.actionStart = Date.now();
    },
    async after(call, outcome, runtime): Promise<ActionOutcome | void> {
      const finishedAt = Date.now();
      const state = pending.get(call);
      pending.delete(call);
      const { params, removed } = redactParams(call.params);
      const entry: AuditEntry = {
        time: now().toISOString(),
        session,
        host,
        seq: state?.seq ?? ++seq,
        action: call.action,
        ...(state?.tabId ?? call.params.tabId ? { tabId: state?.tabId ?? call.params.tabId } : {}),
        ...(state?.urlBefore ? { urlBefore: state.urlBefore } : {}),
        params,
        outcome: outcome.result ? 'ok' : state ? 'failed' : 'refused',
        result: outcome.result ? summarize(outcome.result.details, call.action, removed) : summarizeError(outcome.error, removed),
        durationMs: finishedAt - (state?.actionStart ?? outcome.startedAt),
      };
      if (state?.target) entry.target = state.target;
      if (state?.stepTargets) entry.stepTargets = state.stepTargets;
      if (state?.contextId) {
        const contextId = state.contextId;
        const urlAfter = await treeUrl(runtime, contextId);
        if (urlAfter !== undefined) {
          entry.urlAfter = urlAfter;
          const documentAfter = await documentOf(runtime, contextId);
          if (state.documentBefore && documentAfter) entry.documentChanged = documentAfter !== state.documentBefore;
          if (state.wantsScreenshots && call.action !== 'fill_secret') {
            const shot = await screenshot(runtime, contextId, urlAfter, `${session}-${entry.seq}-after`);
            if ('path' in shot) state.screenshots.after = shot.path; else state.screenshots.afterSkipped = shot.skipped;
          }
        } else if (state.wantsScreenshots) state.screenshots.afterSkipped = 'the tab is closed';
        if (call.action === 'fill_secret') state.screenshots.afterSkipped = 'secret input';
        if (Object.keys(state.screenshots).length) entry.screenshots = state.screenshots;
      }
      try {
        log.append(entry);
      } catch (error) {
        // Never fail an action that already ran because its record could not be written; say so instead.
        if (!outcome.result) { console.error(`foxpaw audit: could not write ${log.dir}: ${message(error)}`); return; }
        return { ...outcome, result: { ...outcome.result, details: { ...outcome.result.details, auditError: `Audit log not written: ${message(error)}` } } };
      }
    },
  };
}
