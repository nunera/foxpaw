import { z } from 'zod';
import type { Context } from '../browser.ts';
import type { Environment } from '../config.ts';
import { readSettings, settingsPath } from '../settings.ts';
import { CORE_ACTIONS, type ActionCall, type TargetDescription, type ToolRuntime } from '../tool/core.ts';

/**
 * The `policy` settings key: per-site decisions for three classes of action. Pure parts (config, matching,
 * classification of element facts) live here; src/tool/features/policy.ts applies them around every action.
 */
export type Decision = 'allow' | 'ask' | 'deny';
export type ActionClass = 'read' | 'write' | 'irreversible';
export type ClassRules = Record<ActionClass, Decision>;
export type SiteRule = { match: string; read?: Decision; write?: Decision; irreversible?: Decision };
export type ApprovalMethod = 'auto' | 'notify-send' | 'osascript' | 'powershell' | 'command' | 'browser';
export type ApprovalConfig = { method: ApprovalMethod[]; command?: string[]; timeoutMs: number };
export type Policy = { default: ClassRules; sites: SiteRule[]; approval: ApprovalConfig };
export type LoadedPolicy = { ok: true; policy: Policy } | { ok: false; reason: string };

export const CLASSES: readonly ActionClass[] = ['read', 'write', 'irreversible'];
export const BUILTIN_DEFAULT: ClassRules = { read: 'allow', write: 'allow', irreversible: 'ask' };
export const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000;
const SEVERITY: Record<Decision, number> = { allow: 0, ask: 1, deny: 2 };
const CLASS_SEVERITY: Record<ActionClass, number> = { read: 0, write: 1, irreversible: 2 };

// "*.bank.example" (subdomains), "bank.example" (that host, any scheme/port), or "https://bank.example" (one origin).
type Matcher = { kind: 'origin'; origin: string } | { kind: 'host'; host: string } | { kind: 'wildcard'; suffix: string };
const HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)*$/;
export function parseMatch(match: string): Matcher | string {
  const value = match.trim().toLowerCase();
  if (value.includes('://')) {
    let url: URL;
    try { url = new URL(value); } catch { return 'is not a valid origin URL'; }
    if (url.origin === 'null') return 'has no origin (use http:// or https://)';
    if (url.pathname !== '/' || url.search || url.hash || url.username || url.password || !(value === url.origin || value === `${url.origin}/`)) return 'must be a bare origin like https://bank.example (no path, query, or credentials)';
    return { kind: 'origin', origin: url.origin };
  }
  if (value.startsWith('*.')) return HOST.test(value.slice(2)) ? { kind: 'wildcard', suffix: value.slice(2) } : 'must be *.host, host, or an origin';
  return HOST.test(value) ? { kind: 'host', host: value } : 'must be *.host, host, or an origin';
}

// Higher is more specific: an exact origin beats an exact host beats any wildcard; longer wildcards beat shorter ones.
function specificity(matcher: Matcher): number {
  if (matcher.kind === 'origin') return 1_000_000;
  if (matcher.kind === 'host') return 1000 + matcher.host.split('.').length;
  return matcher.suffix.split('.').length;
}
function matches(matcher: Matcher, url: URL): boolean {
  if (matcher.kind === 'origin') return url.origin === matcher.origin;
  const host = url.hostname.toLowerCase();
  if (matcher.kind === 'host') return host === matcher.host;
  return host.endsWith(`.${matcher.suffix}`);
}

const decision = z.enum(['allow', 'ask', 'deny']);
const method = z.enum(['auto', 'notify-send', 'osascript', 'powershell', 'command', 'browser']);
const classRules = { read: decision.optional(), write: decision.optional(), irreversible: decision.optional() };
const policySchema = z.object({
  default: z.object(classRules).strict().optional(),
  sites: z.array(z.object({
    match: z.string().superRefine((value, ctx) => {
      const parsed = parseMatch(value);
      if (typeof parsed === 'string') ctx.addIssue({ code: 'custom', message: `${JSON.stringify(value)} ${parsed}` });
    }),
    ...classRules,
  }).strict()).optional(),
  approval: z.object({
    method: z.union([method, z.array(method).min(1)]).optional(),
    command: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
    timeoutMs: z.number().int().positive().max(3_600_000).optional(),
  }).strict().optional(),
}).strict().superRefine((value, ctx) => {
  const seen = new Map<string, number>();
  for (const [index, site] of (value.sites ?? []).entries()) {
    const parsed = parseMatch(site.match);
    if (typeof parsed === 'string') continue;
    const key = parsed.kind === 'origin' ? parsed.origin : parsed.kind === 'host' ? parsed.host : `*.${parsed.suffix}`;
    const first = seen.get(key);
    if (first !== undefined) ctx.addIssue({ code: 'custom', path: ['sites', index, 'match'], message: `duplicates sites.${first}.match (${key})` });
    else seen.set(key, index);
  }
  const methods = value.approval?.method === undefined ? [] : [value.approval.method].flat();
  if (methods.includes('command') && !value.approval?.command) ctx.addIssue({ code: 'custom', path: ['approval', 'command'], message: 'approval.method "command" needs approval.command' });
});

/** Validates the raw `policy` value. Any problem names its path; callers refuse every action on failure. */
export function parsePolicy(raw: unknown, source = 'config'): LoadedPolicy {
  const parsed = policySchema.safeParse(raw ?? {});
  if (!parsed.success) {
    const reason = parsed.error.issues.map((issue) => `policy${issue.path.map((part) => typeof part === 'number' ? `[${part}]` : `.${String(part)}`).join('')}: ${issue.message}`).join('; ');
    return { ok: false, reason: `${source}: ${reason}` };
  }
  const value = parsed.data;
  const methods = value.approval?.method === undefined ? ['auto' as const] : [value.approval.method].flat();
  const command = value.approval?.command === undefined ? undefined : [value.approval.command].flat();
  return {
    ok: true,
    policy: {
      default: { ...BUILTIN_DEFAULT, ...value.default },
      sites: value.sites ?? [],
      approval: { method: methods, ...(command ? { command } : {}), timeoutMs: value.approval?.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS },
    },
  };
}

/** Reads `policy` from the settings file. An unreadable file or invalid value fails closed with path and reason. */
export function loadPolicy(env: Environment = process.env): LoadedPolicy {
  const path = settingsPath(env);
  let settings: Record<string, unknown>;
  try { settings = readSettings(env); } catch (error) {
    return { ok: false, reason: `${path}: ${error instanceof Error ? error.message : String(error)}` };
  }
  return parsePolicy(settings.policy, path);
}

export type Ruling = { decision: Decision; rule: string; site?: string };
/** The decision for one class on one URL: the most specific matching site that sets the class, else the default. */
export function decide(policy: Policy, actionClass: ActionClass, url?: string): Ruling {
  let parsed: URL | undefined;
  try { parsed = url ? new URL(url) : undefined; } catch { parsed = undefined; }
  const site = parsed && parsed.origin !== 'null' ? parsed.origin : parsed?.href;
  if (parsed) {
    const candidates = policy.sites
      .map((rule) => ({ rule, matcher: parseMatch(rule.match) }))
      .filter((entry): entry is { rule: SiteRule; matcher: Matcher } => typeof entry.matcher !== 'string' && matches(entry.matcher, parsed))
      .sort((a, b) => specificity(b.matcher) - specificity(a.matcher));
    for (const { rule } of candidates) {
      const value = rule[actionClass];
      if (value) return { decision: value, rule: `sites[${policy.sites.indexOf(rule)}] (${rule.match})`, ...(site ? { site } : {}) };
    }
  }
  return { decision: policy.default[actionClass], rule: 'default', ...(site ? { site } : {}) };
}

/** True when this class is allowed on every site, so classifying a call further cannot change the outcome. */
export function allowedEverywhere(policy: Policy, actionClass: ActionClass): boolean {
  return policy.default[actionClass] === 'allow' && policy.sites.every((site) => site[actionClass] === undefined || site[actionClass] === 'allow');
}

export const stricter = (a: Ruling, b: Ruling): Ruling => SEVERITY[b.decision] > SEVERITY[a.decision] ? b : a;

// Word-boundary, case-insensitive: "Pay" and "Place order" match; "Payment" and "Checkbox" don't.
export const RISKY_WORDS = /\b(pay|purchase|buy|order|checkout|delete|remove|send|submit|confirm|transfer|publish|post|sign|unsubscribe)\b/i;
// The words that keep their weight even on a sign-in form ("Sign in", "Submit", "Confirm" are how people log in).
const SIGN_IN_RISKY_WORDS = /\b(pay|purchase|buy|order|checkout|delete|remove|send|transfer|publish|unsubscribe)\b/i;
const READ_ACTIONS: Record<string, true> = { tabs: true, inspect: true, form_schema: true, field_state: true, query: true, table: true, events: true, wait_event: true, wait_for: true, wait_for_change: true, wait_url: true, assert: true, assert_many: true, screenshot: true, hover: true, scroll: true, activate: true };
const IRREVERSIBLE_ACTIONS: Record<string, true> = { evaluate: true };
// The class depends on the element, the key, or the open dialog.
const ELEMENT_ACTIONS: Record<string, true> = { click: true, double_click: true, press: true, type: true, pointer: true, batch: true, dialog: true, submit_form: true };

/** Every class an action could end up in; actions not listed (including other features' actions) are writes. */
export function possibleClasses(action: string): ActionClass[] {
  if (READ_ACTIONS[action]) return ['read'];
  if (IRREVERSIBLE_ACTIONS[action]) return ['irreversible'];
  if (ELEMENT_ACTIONS[action]) return ['write', 'irreversible'];
  return ['write'];
}

export type Classification = { actionClass: ActionClass; why: string };

/**
 * Signing in: a form with exactly one password field (sign-up and password-change forms have two or more). Logging in
 * is a write, not irreversible, or every login would ask and people would turn the prompts off. Buttons that still
 * say pay, delete, send, and so on keep their weight.
 */
function signIn(facts: TargetDescription): Classification | undefined {
  if (facts.form?.passwordFields !== 1) return undefined;
  for (const label of [facts.name, facts.text]) if (label && SIGN_IN_RISKY_WORDS.test(label)) return undefined;
  return { actionClass: 'write', why: 'signing in (a form with one password field)' };
}

/** Classifies a click or an Enter key on an element from its facts (runtime.describe()). */
export function classifyElement(facts: TargetDescription | undefined, trigger: 'click' | 'enter'): Classification {
  if (!facts) return trigger === 'enter'
    ? { actionClass: 'irreversible', why: 'Enter without a target goes to the focused element, which may submit a form' }
    : { actionClass: 'write', why: 'no element' };
  const login = signIn(facts);
  if (login) return login;
  const type = facts.type?.toLowerCase();
  if ((facts.tag === 'input' && (type === 'submit' || type === 'image')) || (facts.tag === 'button' && facts.form && (type === undefined || type === 'submit'))) {
    return { actionClass: 'irreversible', why: 'submit control' };
  }
  for (const label of [facts.name, facts.text]) {
    const word = label ? RISKY_WORDS.exec(label)?.[1] : undefined;
    if (word) return { actionClass: 'irreversible', why: `${JSON.stringify(label!.slice(0, 60))} matches "${word.toLowerCase()}"` };
  }
  if (facts.form?.method === 'post') return { actionClass: 'irreversible', why: 'inside a form with method=post' };
  return { actionClass: 'write', why: trigger === 'enter' ? 'Enter on an ordinary element' : 'ordinary element' };
}

const isEnter = (key: unknown) => typeof key === 'string' && (/(^|\+)(enter|return)$/i.test(key.trim()) || key === '\uE007');
// Actions whose handle/selector/role/name names the element they act on (elsewhere `selector` is a query or a wait).
const ELEMENT_TARGETED: Record<string, true> = { field_state: true, assert: true, click: true, double_click: true, right_click: true, hover: true, drag: true, pointer: true, fill: true, type: true, press: true, scroll: true, select: true, check: true, upload: true, submit_form: true, screenshot: true, fill_secret: true };

export type ClassifiedCall = Classification & {
  action: string;
  /** URLs the decision applies to (tab, iframes the targets live in, destination); the strictest ruling wins. */
  urls: string[];
  /** URLs of cross-origin or same-origin iframes the call's target elements live in. */
  frames?: string[];
  tabId?: string;
  contextId?: string;
  target?: TargetDescription;
};

/**
 * Classifies a call against the live page: element facts for clicks and Enter, the dialog text for `dialog`, and the
 * URL of every frame a target element lives in, so an iframe is held to its own site's rules as well as the tab's.
 */
export async function classifyCall(call: ActionCall, runtime: ToolRuntime): Promise<ClassifiedCall> {
  const { action, params } = call;
  const destination = typeof params.url === 'string' && (action === 'open' || action === 'navigate') ? [params.url] : [];
  const static_ = possibleClasses(action);
  if (action === 'tabs' || action === 'launch') return { action, actionClass: static_[0]!, why: 'no page', urls: [] };
  let tab: { context: Context; tabId: string } | undefined;
  let missing: unknown;
  // A call whose tab can't be found fails in the action itself; until then only the default rules apply.
  try { tab = await runtime.target(action, params.tabId, params.target); } catch (error) { missing = error; }
  const urls = action === 'open' ? destination : [...(tab ? [tab.context.url] : []), ...destination];
  // Core actions without their tab can't run either: fail with the action's own error instead of asking first.
  if (!tab && (CORE_ACTIONS.includes(action) || static_.length > 1)) throw missing;
  if (!tab) return { action, urls, actionClass: static_[0]!, why: action };
  const { context, tabId } = tab;
  const frames = new Set<string>();
  const named = (target: Record<string, unknown>) => Boolean(target.handle || target.selector || target.role || target.name !== undefined || target.locator);
  const locate = async (target: Record<string, unknown>) => {
    if (!named(target)) return;
    const { frame } = await runtime.resolve(context, tabId, target);
    if (frame.context === context.id) return;
    const href = await runtime.browser.evaluateValue(frame.context, 'location.href');
    if (typeof href === 'string') frames.add(href);
  };
  const element = async (target: Record<string, unknown>, trigger: 'click' | 'enter') => {
    await locate(target);
    const facts = named(target) ? await runtime.describe(context, tabId, target) : undefined;
    return { ...classifyElement(facts, trigger), ...(facts ? { target: facts } : {}) };
  };
  const classified = (classification: Classification & { target?: TargetDescription }): ClassifiedCall => ({
    action, tabId, contextId: context.id, ...classification, urls: [...urls, ...frames], ...(frames.size ? { frames: [...frames] } : {}),
  });
  if (static_.length === 1) {
    if (ELEMENT_TARGETED[action]) await locate(params);
    if (action === 'assert_many') for (const check of params.properties ?? []) await locate(check);
    return classified({ actionClass: static_[0]!, why: static_[0] === 'irreversible' ? `${action} is always irreversible` : action });
  }
  if (action === 'click' || action === 'double_click') return classified(await element(params, 'click'));
  // Submitting a form is irreversible, except signing in.
  if (action === 'submit_form') {
    await locate(params);
    const facts = named(params) ? await runtime.describe(context, tabId, params) : undefined;
    return classified({ ...(facts && signIn(facts)) || { actionClass: 'irreversible', why: 'submit_form' }, ...(facts ? { target: facts } : {}) });
  }
  if (action === 'pointer') {
    if (params.pointer === 'up') return classified(await element(params, 'click'));
    await locate(params);
    return classified({ actionClass: 'write', why: 'pointer' });
  }
  if (action === 'press' || action === 'type') {
    if (action === 'press' ? isEnter(params.key) : typeof params.text === 'string' && /[\r\n]/.test(params.text)) return classified(await element(params, 'enter'));
    await locate(params);
    return classified({ actionClass: 'write', why: action === 'press' ? 'key press' : 'typing' });
  }
  if (action === 'dialog') {
    if (params.dialogAction !== 'accept') return classified({ actionClass: 'write', why: 'dismissing a dialog' });
    const prompt = runtime.browser.openPrompt(context.id);
    const word = prompt ? RISKY_WORDS.exec(prompt.message)?.[1] : undefined;
    return classified(word ? { actionClass: 'irreversible', why: `accepting a dialog that says ${JSON.stringify(prompt!.message.slice(0, 80))} (matches "${word.toLowerCase()}")` } : { actionClass: 'write', why: 'accepting a dialog' });
  }
  // batch: the most severe step decides; its target is the one shown to the approver. Every step's frame counts.
  let worst: Classification & { target?: TargetDescription } = { actionClass: 'read', why: 'batch' };
  for (const [index, step] of (params.batch ?? []).entries()) {
    let stepClass: Classification & { target?: TargetDescription };
    if (step.action === 'commit') stepClass = { ...(await element(step, 'click')), actionClass: 'irreversible', why: 'batch commit step' };
    else if (step.action === 'click') stepClass = await element(step, 'click');
    else if (step.action === 'press' && isEnter(step.key)) stepClass = await element(step, 'enter');
    else {
      await locate(step);
      stepClass = step.action === 'assert' || step.action === 'scroll' ? { actionClass: 'read', why: step.action } : { actionClass: 'write', why: step.action === 'press' ? 'key press' : step.action };
    }
    if (CLASS_SEVERITY[stepClass.actionClass] > CLASS_SEVERITY[worst.actionClass]) worst = { ...stepClass, why: `step ${index} (${step.action}): ${stepClass.why}` };
  }
  return classified(worst);
}
