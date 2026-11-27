import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Approver } from '../src/trust/approve.ts';
import { classifyCall, classifyElement, decide, loadPolicy, parsePolicy, type Policy } from '../src/trust/policy.ts';
import { policyFeature } from '../src/tool/features/policy.ts';
import type { ActionCall, TargetDescription, ToolParams, ToolRuntime } from '../src/tool/core.ts';

const policyOf = (raw: unknown): Policy => {
  const loaded = parsePolicy(raw);
  if (!loaded.ok) throw new Error(loaded.reason);
  return loaded.policy;
};
const configFile = (settings: unknown) => {
  const path = join(mkdtempSync(join(tmpdir(), 'foxpaw-policy-')), 'config.json');
  writeFileSync(path, typeof settings === 'string' ? settings : JSON.stringify(settings));
  return { FOXPAW_CONFIG: path };
};
const element = (facts: Partial<TargetDescription>): TargetDescription => ({ tabId: 'tab_1', url: 'https://shop.example/cart', selector: '#x', tag: 'button', role: 'button', name: null, text: '', ...facts });

// `frames` maps a target's selector (or handle) to the URL of the iframe it lives in; others live in the top document.
type FakeOptions = { url?: string; facts?: TargetDescription; prompt?: { type: string; message: string }; frames?: Record<string, string> };
function fakeRuntime(options: FakeOptions = {}) {
  const described: unknown[] = [];
  const frameUrls = new Map(Object.entries(options.frames ?? {}).map(([key, url], index) => [key, { context: `frame_${index}`, url }]));
  const frameOf = (target: { selector?: string; handle?: string }) => frameUrls.get(target.handle ?? target.selector ?? '');
  const runtime = {
    browser: {
      openPrompt: () => options.prompt,
      bidi: { command: async () => ({}) },
      evaluateValue: async (context: string, expression: string) => {
        if (expression !== 'location.href') throw new Error(`unexpected evaluate ${expression}`);
        return [...frameUrls.values()].find((frame) => frame.context === context)?.url;
      },
    },
    tabId: () => 'tab_1',
    target: async (action: string, tabId?: string) => {
      if (!tabId && action !== 'screenshot') throw new Error(`${action} requires tabId`);
      return { context: { id: 'ctx_1', url: options.url ?? 'https://shop.example/cart', parent: null }, tabId: 'tab_1' };
    },
    resolve: async (_context: unknown, _tabId: string, target: { selector?: string; handle?: string }) => ({ selector: target.selector ?? '#x', frame: { context: frameOf(target)?.context ?? 'ctx_1', documentId: 'doc' }, identity: { tag: 'button', role: 'button', name: null } }),
    describe: async (_context: unknown, _tabId: string, target: unknown) => { described.push(target); return options.facts; },
  } as unknown as ToolRuntime;
  return { runtime, described };
}
const call = (params: Partial<ToolParams> & { action: string }): ActionCall => ({ action: params.action, params: params as ToolParams });
const fakeApprover = (answer: boolean | 'hang', seen: unknown[] = []): Approver => ({
  name: 'fake',
  available: async () => true,
  ask: async (request, signal) => {
    seen.push(request);
    if (answer === 'hang') return await new Promise<boolean>((resolve) => signal.addEventListener('abort', () => resolve(true)));
    return answer;
  },
});
const refusalOf = async (promise: Promise<unknown>) => {
  try { await promise; } catch (error) { return JSON.parse((error as Error).message) as Record<string, unknown> & { policy: Record<string, string> }; }
  throw new Error('expected a refusal');
};

test('built-in default allows reads and writes and asks for irreversible actions', () => {
  const policy = policyOf(undefined);
  expect(decide(policy, 'read', 'https://any.example/').decision).toBe('allow');
  expect(decide(policy, 'write', 'https://any.example/').decision).toBe('allow');
  expect(decide(policy, 'irreversible', 'https://any.example/').decision).toBe('ask');
});

test('the most specific site rule that sets a class wins, falling back per class', () => {
  const policy = policyOf({
    default: { write: 'ask' },
    sites: [
      { match: '*.bank.example', read: 'allow', write: 'deny', irreversible: 'deny' },
      { match: '*.eu.bank.example', write: 'ask' },
      { match: 'https://pay.eu.bank.example', irreversible: 'ask' },
    ],
  });
  expect(decide(policy, 'write', 'https://www.bank.example/').decision).toBe('deny');
  expect(decide(policy, 'write', 'https://x.eu.bank.example/').decision).toBe('ask');
  expect(decide(policy, 'irreversible', 'https://pay.eu.bank.example/send').decision).toBe('ask');
  // The exact origin sets only irreversible; write falls to the next most specific rule, not the default.
  expect(decide(policy, 'write', 'https://pay.eu.bank.example/').decision).toBe('ask');
  expect(decide(policy, 'irreversible', 'http://pay.eu.bank.example/').decision).toBe('deny');
  // A wildcard covers subdomains, not the bare domain, and never a lookalike.
  expect(decide(policy, 'write', 'https://bank.example/').decision).toBe('ask');
  expect(decide(policy, 'write', 'https://evilbank.example/').decision).toBe('ask');
  expect(decide(policy, 'irreversible', 'https://www.bank.example/').rule).toBe('sites[0] (*.bank.example)');
});

test('invalid policy config fails closed with the path and the reason', async () => {
  const bad = loadPolicy(configFile({ policy: { default: { write: 'maybe' }, sites: [{ match: 'https://bank.example/login' }] } }));
  expect(bad.ok).toBe(false);
  if (bad.ok) return;
  expect(bad.reason).toContain('policy.default.write');
  expect(bad.reason).toContain('policy.sites[0].match');
  expect(parsePolicy({ sites: [{ match: 'a.example' }, { match: 'A.example' }] }).ok).toBe(false);
  expect(parsePolicy({ approval: { method: 'command' } }).ok).toBe(false);

  const env = configFile({ policy: { sites: [{ match: '*.bank.example', reed: 'allow' }] } });
  const refusal = await refusalOf(policyFeature({ env }).before!(call({ action: 'tabs' }), fakeRuntime().runtime));
  expect(refusal.actionPerformed).toBe(false);
  expect(refusal.policy.decision).toBe('deny');
  expect(refusal.policy.reason).toContain(env.FOXPAW_CONFIG);
  expect(refusal.policy.reason).toContain('reed');

  const unparsable = await refusalOf(policyFeature({ env: configFile('{ not json') }).before!(call({ action: 'tabs' }), fakeRuntime().runtime));
  expect(unparsable.policy.reason).toContain('invalid');
});

test('classifies clicks by the element: submit controls, risky words, POST forms', () => {
  expect(classifyElement(element({ tag: 'button', form: { action: 'https://shop.example/x', method: 'get' } }), 'click').actionClass).toBe('irreversible');
  expect(classifyElement(element({ tag: 'button', type: 'button', name: 'Show details', form: { action: 'https://shop.example/x', method: 'get' } }), 'click').actionClass).toBe('write');
  expect(classifyElement(element({ tag: 'input', type: 'submit' }), 'click').actionClass).toBe('irreversible');
  expect(classifyElement(element({ tag: 'a', role: 'link', name: 'Place Order' }), 'click').actionClass).toBe('irreversible');
  expect(classifyElement(element({ tag: 'div', name: null, text: 'Unsubscribe from all' }), 'click').actionClass).toBe('irreversible');
  // Word boundaries: "Payment options" and "Postcode" are not "pay" or "post".
  expect(classifyElement(element({ tag: 'a', role: 'link', name: 'Payment options' }), 'click').actionClass).toBe('write');
  expect(classifyElement(element({ tag: 'input', type: 'text', role: 'textbox', name: 'Postcode' }), 'click').actionClass).toBe('write');
  expect(classifyElement(element({ tag: 'input', type: 'text', role: 'textbox', name: 'Card', form: { action: 'https://shop.example/pay', method: 'post' } }), 'enter').actionClass).toBe('irreversible');
  expect(classifyElement(undefined, 'enter').actionClass).toBe('irreversible');
});

test('classifies calls against the live page per action', async () => {
  const pay = element({ name: 'Pay', text: 'Pay', form: { action: 'https://shop.example/pay', method: 'post' } });
  const { runtime, described } = fakeRuntime({ facts: pay });
  expect((await classifyCall(call({ action: 'inspect', tabId: 'tab_1' }), runtime)).actionClass).toBe('read');
  expect((await classifyCall(call({ action: 'fill', tabId: 'tab_1', selector: '#a', value: 'x' }), runtime)).actionClass).toBe('write');
  expect((await classifyCall(call({ action: 'evaluate', tabId: 'tab_1', expression: '1' }), runtime)).actionClass).toBe('write');
  expect((await classifyCall(call({ action: 'submit_form', tabId: 'tab_1', selector: 'form' }), runtime)).actionClass).toBe('irreversible');
  const click = await classifyCall(call({ action: 'click', tabId: 'tab_1', selector: '#pay' }), runtime);
  expect(click).toMatchObject({ actionClass: 'irreversible', urls: ['https://shop.example/cart'], tabId: 'tab_1', target: pay });
  expect((await classifyCall(call({ action: 'press', tabId: 'tab_1', key: 'Tab' }), runtime)).actionClass).toBe('write');
  expect((await classifyCall(call({ action: 'press', tabId: 'tab_1', key: 'Enter' }), runtime)).actionClass).toBe('irreversible');
  expect((await classifyCall(call({ action: 'type', tabId: 'tab_1', selector: '#q', text: 'hello\n' }), runtime)).actionClass).toBe('irreversible');
  const batch = await classifyCall(call({ action: 'batch', tabId: 'tab_1', batch: [{ action: 'fill', selector: '#a', value: 'x' }, { action: 'commit', selector: '#go' }] }), runtime);
  expect(batch.actionClass).toBe('irreversible');
  expect(batch.why).toContain('step 1 (commit)');
  expect(described).toContainEqual({ action: 'commit', selector: '#go' });
  // navigate is decided on both the current page and the destination.
  expect((await classifyCall(call({ action: 'navigate', tabId: 'tab_1', url: 'https://bank.example/' }), runtime)).urls).toEqual(['https://shop.example/cart', 'https://bank.example/']);
  const confirm = fakeRuntime({ prompt: { type: 'confirm', message: 'Delete 3 files?' } });
  expect((await classifyCall(call({ action: 'dialog', tabId: 'tab_1', dialogAction: 'accept' }), confirm.runtime)).actionClass).toBe('irreversible');
  expect((await classifyCall(call({ action: 'dialog', tabId: 'tab_1', dialogAction: 'dismiss' }), confirm.runtime)).actionClass).toBe('write');
});

test('ask blocks on the approver; approval lets the action through, denial refuses it', async () => {
  const facts = element({ name: 'Pay', text: 'Pay', form: { action: 'https://shop.example/pay', method: 'post' } });
  const env = configFile({});
  const seen: unknown[] = [];
  const pay = call({ action: 'click', tabId: 'tab_1', selector: '#pay' });
  await policyFeature({ env, approval: { approvers: [fakeApprover(true, seen)] } }).before!(pay, fakeRuntime({ facts }).runtime);
  expect(seen[0]).toMatchObject({ version: 1, site: 'https://shop.example', action: 'click', class: 'irreversible', target: { name: 'Pay', text: 'Pay' }, form: { action: 'https://shop.example/pay', method: 'post' } });

  const denied = await refusalOf(policyFeature({ env, approval: { approvers: [fakeApprover(false)] } }).before!(pay, fakeRuntime({ facts }).runtime));
  expect(denied).toMatchObject({ action: 'click', tabId: 'tab_1', actionPerformed: false, policy: { decision: 'ask', class: 'irreversible', site: 'https://shop.example' } });
  expect(denied.policy.reason).toContain('denied via fake');

  const none = await refusalOf(policyFeature({ env, approval: { approvers: [] } }).before!(pay, fakeRuntime({ facts }).runtime));
  expect(none.policy.reason).toContain('no approver is available');
});

test('an approver that never answers is a denial after the timeout, even if it later says yes', async () => {
  const env = configFile({ policy: { approval: { timeoutMs: 50 } } });
  const refusal = await refusalOf(policyFeature({ env, approval: { approvers: [fakeApprover('hang')] } }).before!(call({ action: 'submit_form', tabId: 'tab_1', selector: 'form' }), fakeRuntime().runtime));
  expect(refusal.policy.reason).toContain('no answer within');
});

test('an ordinary click under the default policy runs without asking anyone', async () => {
  const asked: unknown[] = [];
  const facts = element({ tag: 'button', name: 'Add item', text: 'Add item' });
  await policyFeature({ env: configFile({}), approval: { approvers: [fakeApprover(false, asked)] } }).before!(call({ action: 'click', tabId: 'tab_1', role: 'button', name: 'Add item' }), fakeRuntime({ facts }).runtime);
  expect(asked).toEqual([]);
});

test('an element inside an iframe is held to the stricter of the tab\'s and the iframe\'s rules', async () => {
  const env = configFile({ policy: { sites: [{ match: 'bank.example', write: 'allow', irreversible: 'allow' }, { match: '*.evil.example', write: 'deny' }] } });
  const frames = { '#evil-input': 'https://ads.evil.example/frame', '#evil-button': 'https://ads.evil.example/frame' };
  const bank = { url: 'https://bank.example/home', frames };
  // The same fill in the top document is allowed; inside the evil.example iframe it is refused by that site's rule.
  await policyFeature({ env }).before!(call({ action: 'fill', tabId: 'tab_1', selector: '#amount', value: '1' }), fakeRuntime(bank).runtime);
  const refused = await refusalOf(policyFeature({ env }).before!(call({ action: 'fill', tabId: 'tab_1', selector: '#evil-input', value: '1' }), fakeRuntime(bank).runtime));
  expect(refused.policy).toMatchObject({ decision: 'deny', class: 'write', site: 'https://ads.evil.example', rule: 'sites[1] (*.evil.example)' });
  // Batch steps count too, even when only one step is in the iframe.
  const batch = await refusalOf(policyFeature({ env }).before!(call({ action: 'batch', tabId: 'tab_1', batch: [{ action: 'fill', selector: '#amount', value: '1' }, { action: 'check', selector: '#evil-input', checked: true }] }), fakeRuntime(bank).runtime));
  expect(batch.policy.site).toBe('https://ads.evil.example');

  // A Pay click inside the iframe asks (default irreversible) although the bank tab allows irreversible actions,
  // and the approver is told about the iframe.
  const seen: Array<{ site: string; frames?: string[] }> = [];
  const facts = element({ name: 'Pay', text: 'Pay' });
  await refusalOf(policyFeature({ env, approval: { approvers: [fakeApprover(false, seen)] } }).before!(call({ action: 'click', tabId: 'tab_1', selector: '#evil-button' }), fakeRuntime({ ...bank, facts }).runtime));
  expect(seen[0]).toMatchObject({ site: 'https://ads.evil.example', frames: ['https://ads.evil.example/frame'] });
  // The same click in the bank's own document runs.
  await policyFeature({ env, approval: { approvers: [fakeApprover(false)] } }).before!(call({ action: 'click', tabId: 'tab_1', selector: '#pay' }), fakeRuntime({ ...bank, facts }).runtime);

  const classified = await classifyCall(call({ action: 'click', tabId: 'tab_1', selector: '#evil-button' }), fakeRuntime({ ...bank, facts }).runtime);
  expect(classified.urls).toEqual(['https://bank.example/home', 'https://ads.evil.example/frame']);
});

test('deny rules refuse without asking; reads on default config never touch the page', async () => {
  const env = configFile({ policy: { sites: [{ match: 'shop.example', write: 'deny' }] } });
  const asked: unknown[] = [];
  const refusal = await refusalOf(policyFeature({ env, approval: { approvers: [fakeApprover(true, asked)] } }).before!(call({ action: 'fill', tabId: 'tab_1', selector: '#a', value: 'x' }), fakeRuntime().runtime));
  expect(refusal.policy).toMatchObject({ decision: 'deny', class: 'write', rule: 'sites[0] (shop.example)' });
  expect(asked).toEqual([]);

  const { runtime, described } = fakeRuntime();
  let targeted = 0;
  const counting = { ...runtime, target: async (...args: Parameters<ToolRuntime['target']>) => { targeted++; return await runtime.target(...args); } };
  await policyFeature({ env: configFile({}) }).before!(call({ action: 'inspect', tabId: 'tab_1' }), counting);
  expect(targeted).toBe(0);
  expect(described).toEqual([]);
});

test('signing in is a write, so logins don\'t ask; sign-up forms and risky buttons still do', async () => {
  const login = { form: { action: 'https://bank.example/session', method: 'post', passwordFields: 1 } };
  expect(classifyElement(element({ ...login, name: 'Sign in', text: 'Sign in' }), 'click').actionClass).toBe('write');
  expect(classifyElement(element({ ...login, name: 'Continue', text: 'Continue' }), 'enter').actionClass).toBe('write');
  // A one-password form whose button still says what it really does keeps its weight.
  expect(classifyElement(element({ ...login, name: 'Confirm transfer', text: 'Confirm transfer' }), 'click').actionClass).toBe('irreversible');
  // Two password fields: creating an account or changing a password.
  const signUp = { form: { action: 'https://bank.example/users', method: 'post', passwordFields: 2 } };
  expect(classifyElement(element({ ...signUp, name: 'Sign up', text: 'Sign up' }), 'click').actionClass).toBe('irreversible');
  // submit_form follows the same rule; any other form stays irreversible.
  const { runtime } = fakeRuntime({ facts: element({ ...login, name: 'Sign in', text: 'Sign in' }) });
  expect((await classifyCall(call({ action: 'submit_form', tabId: 'tab_1', selector: '#login' }), runtime)).actionClass).toBe('write');
  const other = fakeRuntime({ facts: element({ form: { action: 'https://shop.example/pay', method: 'post', passwordFields: 0 }, name: 'Next', text: 'Next' }) });
  expect((await classifyCall(call({ action: 'submit_form', tabId: 'tab_1', selector: '#f' }), other.runtime)).actionClass).toBe('irreversible');
});
