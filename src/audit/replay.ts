import { readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import type { Environment } from '../config.ts';
import { documentFrame, type Locator } from '../locator.ts';
import { createBrowserTool, type BrowserTool, type ToolParams } from '../tool/core.ts';
import { defaultFeatures } from '../tool/features/index.ts';
import { auditDir, isRedacted, readEntries, type AuditEntry, type AuditTarget } from './log.ts';

/**
 * Record & replay. `record` turns one audit session's successful page-changing actions into a script (version 1);
 * `replay` runs it through a full zen_browser tool, so policy and audit apply exactly as they do for an agent.
 */
export type ScriptLocator = { role: string; name: string } | { css: string };
/** An element by durable locator: role+name when it had both, else its CSS selector; `frameUrl` for iframes. */
export type ScriptTarget = { locator: ScriptLocator; frameUrl?: string };
export type ScriptStep = {
  action: string;
  /** Tab alias: t1 is the tab replay starts in; `open` steps create the others. */
  tab: string;
  /** Tool params without tabId/target/element fields. A typed value is `{ "$var": "v1" }`. */
  params: Record<string, unknown>;
  target?: ScriptTarget;
  /** open: the alias of the tab it creates. */
  opens?: string;
  /** The audit entry this step came from. */
  source?: { session: string; seq: number };
};
export type ScriptVar = { length: number; step: number; field: string; target?: string };
export type ReplayScript = {
  version: 1;
  startUrl: string;
  recorded?: { session: string; host?: string; from?: number; to?: number; at: string };
  vars: Record<string, ScriptVar>;
  steps: ScriptStep[];
};

const locatorSchema = z.union([z.object({ role: z.string(), name: z.string() }).strict(), z.object({ css: z.string() }).strict()]);
const targetSchema = z.object({ locator: locatorSchema, frameUrl: z.string().optional() }).strict();
const scriptSchema = z.object({
  version: z.literal(1),
  startUrl: z.string(),
  recorded: z.object({ session: z.string(), host: z.string().optional(), from: z.number().optional(), to: z.number().optional(), at: z.string() }).optional(),
  vars: z.record(z.string(), z.object({ length: z.number(), step: z.number(), field: z.string(), target: z.string().optional() })),
  steps: z.array(z.object({
    action: z.string(),
    tab: z.string(),
    params: z.record(z.string(), z.unknown()),
    target: targetSchema.optional(),
    opens: z.string().optional(),
    source: z.object({ session: z.string(), seq: z.number() }).optional(),
  }).strict()),
}).strict();

export function parseScript(text: string): ReplayScript {
  const parsed = scriptSchema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error(`Not a version 1 foxpaw script: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
  return parsed.data as ReplayScript;
}

// What record keeps: actions that change a page or a tab.
const PAGE_CHANGING: Record<string, true> = {
  open: true, navigate: true, reload: true, history: true, click: true, double_click: true, right_click: true, hover: true,
  drag: true, pointer: true, fill: true, fill_many: true, type: true, press: true, scroll: true, select: true, select_many: true,
  check: true, check_many: true, batch: true, submit_form: true, upload: true, dialog: true, close: true, fill_secret: true,
};
// Actions whose own `waitFor` param exists; others get a following wait_url step.
const TAKES_WAIT: Record<string, true> = {
  navigate: true, reload: true, history: true, click: true, double_click: true, right_click: true, hover: true, drag: true,
  pointer: true, fill: true, type: true, press: true, scroll: true, select: true, check: true, upload: true, submit_form: true,
};
const ELEMENT_FIELDS = ['handle', 'selector', 'role', 'name', 'locator'] as const;

/** A URL without query and fragment: what a `url` wait matches against (it ignores the query). */
function waitUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'data:' || parsed.protocol === 'about:') return url;
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch { return url; }
}

const failedEntry = (entry: AuditEntry) => entry.outcome !== 'ok'
  || entry.result.actionPerformed === false || entry.result.verified === false || entry.result.waitCompleted === false
  || entry.result.failedStepIndex !== undefined;

function scriptTarget(described: AuditTarget): ScriptTarget {
  return {
    locator: described.role && described.name ? { role: described.role, name: described.name } : { css: described.selector },
    ...(described.frameUrl ? { frameUrl: described.frameUrl } : {}),
  };
}

const hasElement = (params: Record<string, unknown>) => ELEMENT_FIELDS.some((key) => params[key] !== undefined);

/**
 * Replaces element fields with a durable `target`. Without a description, plain selector/role/locator fields are
 * durable already and stay; a handle or a frame-bound locator can't be replayed and is an error.
 */
function durable(params: Record<string, unknown>, described: AuditTarget | null | undefined, where: string): { params: Record<string, unknown>; target?: ScriptTarget } {
  if (!hasElement(params)) return { params };
  if (described) {
    const rest = { ...params };
    for (const key of ELEMENT_FIELDS) delete rest[key];
    return { params: rest, target: scriptTarget(described) };
  }
  if (params.handle !== undefined || (params.locator as Locator | undefined)?.frame) throw new Error(`${where} names its element by ${params.handle !== undefined ? `handle ${String(params.handle)}` : 'a frame-bound locator'} and the audit log has no description of it, so it can't be replayed.`);
  return { params };
}

export type RecordRange = { from?: number; to?: number };

/** Converts one session's entries (any order) into a script. */
export function recordScript(entries: AuditEntry[], range: RecordRange = {}, now = new Date()): { script: ReplayScript; skipped: Array<{ seq: number; action: string; reason: string }> } {
  const sessions = new Set(entries.map((entry) => entry.session));
  if (sessions.size > 1) throw new Error(`Entries from ${sessions.size} sessions (${[...sessions].join(', ')}); record one session.`);
  const selected = entries
    .filter((entry) => (range.from === undefined || entry.seq >= range.from) && (range.to === undefined || entry.seq <= range.to))
    .sort((a, b) => a.seq - b.seq);
  const skipped: Array<{ seq: number; action: string; reason: string }> = [];
  const kept = selected.filter((entry) => {
    if (!PAGE_CHANGING[entry.action]) return false;
    if (failedEntry(entry)) { skipped.push({ seq: entry.seq, action: entry.action, reason: entry.outcome === 'ok' ? 'did not complete (unverified, wait failed, or stopped)' : `${entry.outcome}: ${entry.result.error ?? ''}` }); return false; }
    return true;
  });
  const first = kept[0];
  if (!first) throw new Error('No successful page-changing actions in that range.');
  // Replay starts in a fresh tab anyway, so a leading `open` is that tab rather than a step.
  const opensStart = first.action === 'open' && first.result.openedTabId !== undefined;
  const startTab = opensStart ? first.result.openedTabId : first.tabId;
  const startUrl = opensStart
    ? kept.find((entry) => entry.tabId === startTab)?.urlBefore ?? (typeof first.params.url === 'string' ? first.params.url : undefined)
    : first.urlBefore;
  if (!startTab || !startUrl) throw new Error(`Step seq ${first.seq} (${first.action}) has no tab or starting URL in the log.`);
  const aliases = new Map<string, string>([[startTab, 't1']]);
  const vars: Record<string, ScriptVar> = {};
  const steps: ScriptStep[] = [];
  const label = (target?: AuditTarget | null) => target ? (target.role && target.name ? `${target.role} "${target.name}"` : target.selector) : undefined;

  const withVars = (value: unknown, stepIndex: number, field: string, target?: string): unknown => {
    if (!isRedacted(value)) return value;
    const name = `v${Object.keys(vars).length + 1}`;
    vars[name] = { length: value.$redacted, step: stepIndex, field, ...(target ? { target } : {}) };
    return { $var: name };
  };

  for (const [index, entry] of kept.entries()) {
    if (opensStart && index === 0) continue;
    const where = `seq ${entry.seq} (${entry.action})`;
    const tab = entry.tabId === undefined ? undefined : aliases.get(entry.tabId);
    if (!tab) throw new Error(`${where} acts on ${entry.tabId ?? 'an unknown tab'}, which the recorded range neither starts in nor opens. Narrow it with --from/--to.`);
    const raw = { ...entry.params };
    for (const key of ['action', 'tabId', 'target']) delete raw[key];
    const top = durable(raw, entry.target, where);
    const params = top.params;
    const stepIndex = steps.length;
    const described = label(entry.target);
    for (const key of ['value', 'text', 'promptText', 'expression']) if (key in params) params[key] = withVars(params[key], stepIndex, key, described);
    if (params.fields && typeof params.fields === 'object') {
      params.fields = Object.fromEntries(Object.entries(params.fields as Record<string, unknown>).map(([selector, value]) => [selector, withVars(value, stepIndex, `fields.${selector}`, selector)]));
    }
    if (Array.isArray(params.batch)) {
      params.batch = params.batch.map((raw: Record<string, unknown>, position: number) => {
        const step = durable(raw, entry.stepTargets?.[position], `${where} batch step ${position}`);
        const out: Record<string, unknown> = { ...step.params, ...(step.target ? { target: step.target } : {}) };
        for (const key of ['value', 'text']) if (key in out) out[key] = withVars(out[key], stepIndex, `batch.${position}.${key}`, label(entry.stepTargets?.[position]));
        return out;
      });
    }
    const step: ScriptStep = { action: entry.action, tab, params, ...(top.target ? { target: top.target } : {}), source: { session: entry.session, seq: entry.seq } };

    // The change the step caused, as a wait, so replay doesn't run ahead of the page.
    let wait: { url: string } | { documentChanged: true } | undefined;
    if (entry.urlAfter !== undefined && entry.urlBefore !== undefined && entry.urlAfter !== entry.urlBefore) wait = { url: waitUrl(entry.urlAfter) };
    else if (entry.documentChanged) wait = { documentChanged: true };
    const ownWait = params.waitFor !== undefined || params.waitUrl !== undefined;
    let followUp: ScriptStep | undefined;
    if (entry.action === 'open') {
      const opened = entry.result.openedTabId;
      if (!opened) throw new Error(`${where} has no opened tab in the log.`);
      const alias = `t${aliases.size + 1}`;
      aliases.set(opened, alias);
      step.opens = alias;
      // The new tab's first recorded URL is where it settled (after redirects); fall back to what was opened.
      const landed = kept.slice(index + 1).find((later) => later.tabId === opened)?.urlBefore ?? (typeof params.url === 'string' ? params.url : undefined);
      if (landed) followUp = { action: 'wait_url', tab: alias, params: { url: waitUrl(landed) } };
    } else if (entry.action === 'close') {
      if (entry.tabId) aliases.delete(entry.tabId);
    } else if (wait && !ownWait) {
      if (TAKES_WAIT[entry.action]) params.waitFor = wait;
      else if ('url' in wait) followUp = { action: 'wait_url', tab, params: { url: wait.url } };
    }
    steps.push(step);
    if (followUp) steps.push(followUp);
  }

  return {
    script: {
      version: 1,
      startUrl,
      recorded: { session: first.session, host: first.host, ...(range.from === undefined ? {} : { from: range.from }), ...(range.to === undefined ? {} : { to: range.to }), at: now.toISOString() },
      vars,
      steps,
    },
    skipped,
  };
}

export type StepReport = { index: number; action: string; tab: string; tabId?: string; status: 'ok' | 'failed' };
export type ReplayReport = { ok: boolean; startTabId?: string; steps: StepReport[]; failure?: StepReport & { error: string; url?: string } };
export type ReplayOptions = {
  /** Run in the one existing tab whose URL contains this, instead of a fresh tab at startUrl. */
  tabUrl?: string;
  vars?: Record<string, string>;
  onStep?: (step: StepReport) => void;
};

const describeVar = (script: ReplayScript, name: string) => {
  const spec = script.vars[name]!;
  return `${name}: ${spec.length} chars, step ${spec.step + 1} ${spec.field}${spec.target ? ` of ${spec.target}` : ''}`;
};

/** What replay would do, one line per step, then the values it needs; touches no browser. */
export function planScript(script: ReplayScript): string[] {
  const lines = script.steps.map((step, index) => {
    const target = step.target ? ` ${'role' in step.target.locator ? `${step.target.locator.role} "${step.target.locator.name}"` : step.target.locator.css}${step.target.frameUrl ? ` in frame ${step.target.frameUrl}` : ''}` : '';
    return `${String(index + 1).padStart(3)}/${script.steps.length} ${step.tab} ${step.action}${target} ${JSON.stringify(step.params)}${step.opens ? ` → ${step.opens}` : ''}`;
  });
  const names = Object.keys(script.vars);
  return [`start: ${script.startUrl}`, ...lines, ...(names.length ? ['needs --var for:', ...names.map((name) => `  ${describeVar(script, name)}`)] : [])];
}

const errorText = (error: unknown) => {
  const text = error instanceof Error ? error.message : String(error);
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (parsed && typeof parsed === 'object' && parsed.error !== undefined) return typeof parsed.error === 'string' ? parsed.error : JSON.stringify(parsed.error);
  } catch { /* a plain message */ }
  return text;
};

/** Why a completed tool call still means the step did not do what it did when recorded, or undefined. */
function stepProblem(details: Record<string, unknown>, nextAction: string | undefined): string | undefined {
  if (details.actionPerformed === false) return typeof details.error === 'string' ? details.error : 'the action was not performed';
  if (details.verified === false) return `the input was sent but did not read back: ${String(details.verifyError ?? '')}`;
  if (details.waitCompleted === false) return `the page did not change as recorded: ${String(details.waitError ?? 'wait failed')}`;
  if (typeof details.failedStepIndex === 'number') return `stopped at step ${details.failedStepIndex}: ${JSON.stringify(details.error ?? details.status ?? '')}`;
  if (details.error !== undefined) return typeof details.error === 'string' ? details.error : JSON.stringify(details.error);
  const prompt = details.openPrompt as { type?: unknown; message?: unknown } | undefined;
  if (prompt && nextAction !== 'dialog') return `a ${String(prompt.type)} dialog opened (${String(prompt.message ?? '')}) and the script does not handle it`;
  return undefined;
}

function substitute(value: unknown, vars: Record<string, string>): unknown {
  if (Array.isArray(value)) return value.map((item) => substitute(item, vars));
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  if (typeof record.$var === 'string' && Object.keys(record).length === 1) {
    const replacement = vars[record.$var];
    if (replacement === undefined) throw new Error(`Missing value for ${record.$var}`);
    return replacement;
  }
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, substitute(item, vars)]));
}

/** Runs a script through `tool`, stopping at the first step that fails or behaves differently than recorded. */
export async function replayScript(script: ReplayScript, tool: Pick<BrowserTool, 'execute' | 'runtime'>, options: ReplayOptions = {}): Promise<ReplayReport> {
  const values = options.vars ?? {};
  const missing = Object.keys(script.vars).filter((name) => values[name] === undefined);
  if (missing.length) throw new Error(`The script types values that are not stored; pass --var for ${missing.map((name) => describeVar(script, name)).join('; ')}`);
  const steps: StepReport[] = [];
  const report = (step: StepReport) => { steps.push(step); options.onStep?.(step); };

  const tabs = new Map<string, string>();
  const run = async (params: ToolParams) => (await tool.execute(params)).details;
  const listed = await run({ action: 'tabs' }) as { tabs: Array<{ tabId: string; url: string }>; activeTabId?: string };
  if (options.tabUrl) {
    const matching = listed.tabs.filter((tab) => tab.url.includes(options.tabUrl!));
    if (matching.length !== 1) throw new Error(`--tab-url ${JSON.stringify(options.tabUrl)} matches ${matching.length} tabs; it must match exactly one.`);
    tabs.set('t1', matching[0]!.tabId);
  } else {
    // Without any visible tab (a fresh Zen window hides its empty tab), open places the tab itself.
    const reference = listed.activeTabId ?? listed.tabs[0]?.tabId;
    const opened = await run({ action: 'open', ...(reference ? { tabId: reference } : {}), url: script.startUrl });
    if (typeof opened.tabId !== 'string') throw new Error(`Could not open ${script.startUrl}: ${JSON.stringify(opened)}`);
    tabs.set('t1', opened.tabId);
    await run({ action: 'wait_url', tabId: opened.tabId, url: waitUrl(script.startUrl) });
  }
  const startTabId = tabs.get('t1');

  // A frame is found again by URL in the tab's current frame tree.
  const frameRef = async (tabId: string, frameUrl: string) => {
    const { context } = await tool.runtime.target('inspect', tabId);
    const browser = tool.runtime.browser;
    const inTab = new Set(await browser.treeIds(context.id));
    const frames = (await browser.contexts()).filter((candidate) => inTab.has(candidate.id) && candidate.id !== context.id && waitUrl(candidate.url) === waitUrl(frameUrl));
    if (frames.length !== 1) throw new Error(`frame ${frameUrl} matches ${frames.length} frames in ${tabId}`);
    return await documentFrame(browser.evaluateValue.bind(browser), frames[0]!.id);
  };
  const elementFields = async (tabId: string, target: ScriptTarget): Promise<Partial<ToolParams>> => {
    const frame = target.frameUrl ? await frameRef(tabId, target.frameUrl) : undefined;
    if ('role' in target.locator) return { locator: { role: target.locator.role, name: target.locator.name, exact: true, ...(frame ? { frame } : {}) } };
    return frame ? { locator: { css: target.locator.css, frame } } : { selector: target.locator.css };
  };

  for (const [index, step] of script.steps.entries()) {
    const tabId = tabs.get(step.tab);
    const base = { index, action: step.action, tab: step.tab, ...(tabId ? { tabId } : {}) };
    let url: string | undefined;
    try {
      if (!tabId) throw new Error(`tab ${step.tab} is not open at this point of the script`);
      const params = substitute(step.params, values) as Record<string, unknown>;
      if (Array.isArray(params.batch)) {
        params.batch = await Promise.all(params.batch.map(async (raw: Record<string, unknown>) => {
          const { target, ...rest } = raw;
          return target ? { ...rest, ...(await elementFields(tabId, target as ScriptTarget)) } : rest;
        }));
      }
      const details = await run({ ...params, ...(step.target ? await elementFields(tabId, step.target) : {}), action: step.action, tabId } as ToolParams);
      url = typeof details.url === 'string' ? details.url : undefined;
      const problem = stepProblem(details, script.steps[index + 1]?.action);
      if (problem) throw new Error(problem);
      if (step.opens) {
        const opened = typeof details.tabId === 'string' && details.tabId !== tabId ? details.tabId : (details.tab as { tabId?: unknown } | undefined)?.tabId;
        if (typeof opened !== 'string') throw new Error('open did not report the new tab');
        tabs.set(step.opens, opened);
      }
      if (step.action === 'close') tabs.delete(step.tab);
      report({ ...base, status: 'ok' });
    } catch (error) {
      const failed = { ...base, status: 'failed' as const, error: errorText(error), ...(url ? { url } : {}) };
      report(failed);
      return { ok: false, ...(startTabId ? { startTabId } : {}), steps, failure: failed };
    }
  }
  return { ok: true, ...(startTabId ? { startTabId } : {}), steps };
}

const RECORD_USAGE = 'Usage: foxpaw record --session ID [--from N] [--to N] -o script.json';
const REPLAY_USAGE = 'Usage: foxpaw replay script.json [--dry-run] [--tab-url substring] [--var NAME=VALUE ...]';

/** `foxpaw record`. */
export async function recordCommand(args: string[], env: Environment = process.env): Promise<void> {
  let session: string | undefined;
  let output: string | undefined;
  const range: RecordRange = {};
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    const value = () => { const next = args[++index]; if (!next) throw new Error(`${flag} needs a value\n${RECORD_USAGE}`); return next; };
    const number = () => { const parsed = Number(value()); if (!Number.isInteger(parsed)) throw new Error(`${flag} needs a whole number\n${RECORD_USAGE}`); return parsed; };
    if (flag === '--session') session = value();
    else if (flag === '--from') range.from = number();
    else if (flag === '--to') range.to = number();
    else if (flag === '-o' || flag === '--output') output = value();
    else throw new Error(`Unknown option ${flag}\n${RECORD_USAGE}`);
  }
  if (!session || !output) throw new Error(RECORD_USAGE);
  const entries = readEntries(auditDir(env), { session });
  if (!entries.length) throw new Error(`No audit entries for session ${session} in ${auditDir(env)}.`);
  const { script, skipped } = recordScript(entries, range);
  writeFileSync(output, `${JSON.stringify(script, null, 2)}\n`);
  console.log(`Wrote ${script.steps.length} steps to ${output}${Object.keys(script.vars).length ? `; replay needs ${Object.keys(script.vars).map((name) => `--var ${name}=…`).join(' ')}` : ''}.`);
  for (const skip of skipped) console.error(`skipped seq ${skip.seq} ${skip.action}: ${skip.reason}`);
}

/** `foxpaw replay`. Exits non-zero when a step fails. */
export async function replayCommand(args: string[]): Promise<void> {
  let file: string | undefined;
  const options: ReplayOptions = { vars: {} };
  let dryRun = false;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!;
    const value = () => { const next = args[++index]; if (!next) throw new Error(`${flag} needs a value\n${REPLAY_USAGE}`); return next; };
    if (flag === '--dry-run') dryRun = true;
    else if (flag === '--tab-url') options.tabUrl = value();
    else if (flag === '--var') {
      const pair = value();
      const split = pair.indexOf('=');
      if (split < 1) throw new Error(`--var needs NAME=VALUE\n${REPLAY_USAGE}`);
      options.vars![pair.slice(0, split)] = pair.slice(split + 1);
    } else if (!flag.startsWith('-') && file === undefined) file = flag;
    else throw new Error(`Unknown option ${flag}\n${REPLAY_USAGE}`);
  }
  if (!file) throw new Error(REPLAY_USAGE);
  const script = parseScript(readFileSync(file, 'utf8'));
  if (dryRun) { for (const line of planScript(script)) console.log(line); return; }
  options.onStep = (step) => console.log(`${String(step.index + 1).padStart(3)}/${script.steps.length} ${step.status.padEnd(6)} ${step.tab} ${step.action}${step.tabId ? ` (${step.tabId})` : ''}`);
  const tool = createBrowserTool(z, { features: defaultFeatures({ host: 'cli' }) });
  try {
    const result = await replayScript(script, tool, options);
    if (result.failure) {
      const failure = result.failure;
      console.error(`Replay stopped at step ${failure.index + 1} (${failure.action} in ${failure.tabId ?? failure.tab}): ${failure.error}${failure.url ? `\nPage: ${failure.url}` : ''}`);
      process.exitCode = 1;
    } else console.log(`Replayed ${result.steps.length} steps in ${result.startTabId}.`);
  } finally {
    await tool.shutdown();
  }
}
