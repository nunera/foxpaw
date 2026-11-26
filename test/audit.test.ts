import { afterEach, expect, test } from 'bun:test';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLog, auditConfig, followEntries, formatTable, localDate, parseSince, readEntries, redactParams, type AuditEntry } from '../src/audit/log.ts';
import type { Context } from '../src/browser.ts';
import type { ActionCall, ActionOutcome, ToolFeature, ToolParams, ToolRuntime } from '../src/tool/core.ts';
import { auditFeature } from '../src/tool/features/audit.ts';

const dirs: string[] = [];
const tempDir = () => { const dir = mkdtempSync(join(tmpdir(), 'foxpaw-audit-')); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const PNG = Buffer.from('fake png').toString('base64');
type FakeOptions = { prompt?: boolean; describe?: Partial<ReturnType<typeof describedInput>> | null; closed?: boolean };
const describedInput = () => ({ tabId: 'tab_1', url: 'https://bank.test/login', selector: '#password', tag: 'input', type: 'password', role: 'textbox', name: 'Password', text: 'leaked-field-value' });

// The slice of the runtime audit uses: tab lookup, element description, page tree/document, screenshots.
function fakeRuntime(options: FakeOptions = {}): ToolRuntime & { screenshots: number } {
  const context: Context = { id: 'ctx-1', url: 'https://bank.test/login', parent: null };
  let url = context.url;
  let document = 1;
  const runtime = {
    screenshots: 0,
    tabId: () => 'tab_1',
    target: async () => ({ context, tabId: 'tab_1' }),
    describe: async () => options.describe === null ? undefined : { ...describedInput(), ...options.describe },
    resolve: async () => { throw new Error('unused'); },
    pageState: async () => { throw new Error('unused'); },
    registerElement: () => 'el_1',
    browser: {
      openPrompt: () => options.prompt ? { type: 'confirm', message: 'Sure?' } : undefined,
      evaluateValue: async () => `${url}\u0000${document}`,
      screenshot: async () => { runtime.screenshots++; return PNG; },
      bidi: { command: async () => options.closed ? { contexts: [] } : { contexts: [{ url }] } },
    },
    navigate(to: string) { url = to; document++; },
  };
  return runtime as unknown as ToolRuntime & { screenshots: number; navigate(to: string): void };
}

async function run(feature: ToolFeature, runtime: ToolRuntime, params: ToolParams, outcome: (runtime: ToolRuntime) => Omit<ActionOutcome, 'startedAt'>, refusedBy?: string) {
  const call: ActionCall = { action: params.action, params };
  if (!refusedBy) await feature.before!(call, runtime);
  return await feature.after!(call, { ...(refusedBy ? { error: new Error(refusedBy) } : outcome(runtime)), startedAt: Date.now() }, runtime);
}

function setup(audit: Record<string, unknown> = { screenshots: 'none' }, policy?: unknown) {
  const state = tempDir();
  // Policy is read from the config file, like the policy feature does; never the user's own file.
  const config = join(state, 'config.json');
  if (policy) writeFileSync(config, JSON.stringify({ policy }));
  const env = { XDG_STATE_HOME: state, FOXPAW_CONFIG: config };
  const feature = auditFeature({ env, settings: { audit }, host: 'mcp' });
  const dir = join(state, 'foxpaw', 'audit');
  const lines = () => readdirSync(dir).filter((name) => name.endsWith('.jsonl')).flatMap((name) => readFileSync(join(dir, name), 'utf8').trim().split('\n'));
  return { feature, dir, lines, entries: () => lines().map((line) => JSON.parse(line) as AuditEntry) };
}

test('log lines never contain typed values, expressions, prompt text, or field contents', async () => {
  const { feature, lines, entries, dir } = setup();
  const runtime = fakeRuntime();
  const secret = 'hunter2-correct-horse';
  const ok = { result: { details: { actionPerformed: true, verified: true, requestedValue: secret } } };
  await run(feature, runtime, { action: 'fill', tabId: 'tab_1', selector: '#password', value: secret }, () => ok);
  // Read-back failures echo the value in their message; the log keeps the failure, not the value.
  await run(feature, runtime, { action: 'type', tabId: 'tab_1', selector: '#password', text: secret }, () => ({ error: new Error(JSON.stringify({ actionPerformed: false, error: `field now reads "${secret}"` })) }));
  await run(feature, runtime, { action: 'fill_many', tabId: 'tab_1', fields: { '#user': 'alice@example.test', '#password': secret } }, () => ok);
  await run(feature, runtime, { action: 'batch', tabId: 'tab_1', batch: [{ action: 'fill', selector: '#password', value: secret }, { action: 'click', selector: '#go' }] }, () => ok);
  await run(feature, runtime, { action: 'evaluate', tabId: 'tab_1', expression: `localStorage.token = "${secret}"` }, () => ok);
  await run(feature, runtime, { action: 'dialog', tabId: 'tab_1', dialogAction: 'accept', promptText: secret }, () => ok);
  await run(feature, runtime, { action: 'fill_secret', tabId: 'tab_1', selector: '#password', secret: 'bank-password' }, () => ({ result: { details: { filled: true, secret: 'bank-password' } } }));

  const text = lines().join('\n');
  expect(text).not.toContain(secret);
  expect(text).not.toContain('alice@example.test');
  expect(text).not.toContain('leaked-field-value');
  const [fill, type, many, batch, evaluate, dialog, filled] = entries();
  expect(fill!.params.value).toEqual({ $redacted: secret.length });
  expect(fill!.target).toMatchObject({ selector: '#password', role: 'textbox', name: 'Password' });
  expect(fill!.target!.text).toBeUndefined();
  expect(type).toMatchObject({ outcome: 'failed', params: { text: { $redacted: secret.length } }, result: { actionPerformed: false } });
  expect(type!.result.error).toContain(`[redacted ${secret.length} chars]`);
  expect(many!.params.fields).toEqual({ '#user': { $redacted: 18 }, '#password': { $redacted: secret.length } });
  expect((batch!.params.batch as Array<Record<string, unknown>>)[0]!.value).toEqual({ $redacted: secret.length });
  expect(evaluate!.params.expression).toEqual({ $redacted: `localStorage.token = "${secret}"`.length });
  expect(dialog!.params.promptText).toEqual({ $redacted: secret.length });
  expect(filled!.params).toEqual({ action: 'fill_secret', tabId: 'tab_1', selector: '#password', secret: 'bank-password' });
  expect(fill).toMatchObject({ host: 'mcp', seq: 1, action: 'fill', tabId: 'tab_1', urlBefore: 'https://bank.test/login', urlAfter: 'https://bank.test/login', documentChanged: false, outcome: 'ok' });
  expect(new Set(entries().map((entry) => entry.session)).size).toBe(1);

  // Owner-only: the directory and the day file.
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  expect(statSync(join(dir, `${localDate(new Date())}.jsonl`)).mode & 0o777).toBe(0o600);
});

test('each tool instance logs under its own session id and sequence', async () => {
  const state = tempDir();
  const env = { XDG_STATE_HOME: state };
  const first = auditFeature({ env, settings: { audit: { screenshots: 'none' } } });
  const second = auditFeature({ env, settings: { audit: { screenshots: 'none' } } });
  const ok = () => ({ result: { details: {} } });
  await run(first, fakeRuntime(), { action: 'inspect', tabId: 'tab_1' }, ok);
  await run(second, fakeRuntime(), { action: 'inspect', tabId: 'tab_1' }, ok);
  await run(first, fakeRuntime(), { action: 'tabs' }, ok);
  const logged = readEntries(join(state, 'foxpaw', 'audit'));
  expect(logged.map((item) => item.seq)).toEqual([1, 1, 2]);
  expect(logged[0]!.session).not.toBe(logged[1]!.session);
  expect(logged[2]!.session).toBe(logged[0]!.session);
  expect(logged[0]!.host).toBe('unknown');
});

test('records refusals by earlier features with the policy reason', async () => {
  const { feature, entries } = setup();
  const refusal = JSON.stringify({ action: 'submit_form', actionPerformed: false, error: 'Refused by policy', policy: { decision: 'deny', reason: 'payments need a human', class: 'payment' } });
  await run(feature, fakeRuntime(), { action: 'submit_form', tabId: 'tab_1', selector: '#pay' }, () => ({}), refusal);
  expect(entries()[0]).toMatchObject({ action: 'submit_form', tabId: 'tab_1', outcome: 'refused', result: { actionPerformed: false, error: 'Refused by policy', policy: { decision: 'deny', reason: 'payments need a human' } } });
  expect(entries()[0]!.urlBefore).toBeUndefined();
});

test('takes before/after screenshots of writes and records why one was skipped', async () => {
  const runtime = fakeRuntime() as ToolRuntime & { screenshots: number; navigate(to: string): void };
  const { feature, entries } = setup({ screenshots: 'writes' });
  await run(feature, runtime, { action: 'click', tabId: 'tab_1', selector: '#go' }, (rt) => { (rt as typeof runtime).navigate('https://bank.test/home?x=1'); return { result: { details: { actionPerformed: true, navigation: true } } }; });
  await run(feature, runtime, { action: 'inspect', tabId: 'tab_1' }, () => ({ result: { details: {} } }));
  const [click, inspect] = entries();
  expect(click!.screenshots!.before).toMatch(/-1-before\.png$/);
  expect(click!.screenshots!.after).toMatch(/-1-after\.png$/);
  expect(readFileSync(click!.screenshots!.after!).toString()).toBe('fake png');
  expect(statSync(click!.screenshots!.before!).mode & 0o777).toBe(0o600);
  expect(click).toMatchObject({ urlAfter: 'https://bank.test/home?x=1', documentChanged: true });
  expect(inspect!.screenshots).toBeUndefined();
  expect(runtime.screenshots).toBe(2);

  // Reads that need approval (or are denied) on the page: no screenshot, and nobody is asked for one.
  const refused = setup({ screenshots: 'all' }, { sites: [{ match: 'bank.test', read: 'ask' }] });
  await run(refused.feature, runtime, { action: 'click', tabId: 'tab_1', selector: '#go' }, () => ({ result: { details: { actionPerformed: true } } }));
  const skipped = refused.entries()[0]!.screenshots!;
  expect(skipped.before).toBeUndefined();
  expect(skipped.beforeSkipped).toMatch(/^policy .+ says ask for reads on /);
  expect(skipped.afterSkipped).toBe(skipped.beforeSkipped);
  expect(runtime.screenshots).toBe(2);

  const dialog = setup({ screenshots: 'writes' });
  await run(dialog.feature, fakeRuntime({ prompt: true }), { action: 'dialog', tabId: 'tab_1', dialogAction: 'accept' }, () => ({ result: { details: { handled: true } } }));
  expect(dialog.entries()[0]!.screenshots).toEqual({ beforeSkipped: 'a page dialog is open', afterSkipped: 'a page dialog is open' });

  const closed = setup({ screenshots: 'writes' });
  await run(closed.feature, fakeRuntime({ closed: true }), { action: 'close', tabId: 'tab_1' }, () => ({ result: { details: { tabId: 'tab_1' } } }));
  expect(closed.entries()[0]!.screenshots!.afterSkipped).toBe('the tab is closed');
  expect(closed.entries()[0]!.urlAfter).toBeUndefined();

  const secret = setup({ screenshots: 'all' });
  await run(secret.feature, fakeRuntime(), { action: 'fill_secret', tabId: 'tab_1', selector: '#p', secret: 'bank' }, () => ({ result: { details: { filled: true } } }));
  expect(secret.entries()[0]!.screenshots).toEqual({ beforeSkipped: 'secret input', afterSkipped: 'secret input' });
});

test('disabled audit adds no hooks and writes nothing', () => {
  const state = tempDir();
  const feature = auditFeature({ env: { XDG_STATE_HOME: state }, settings: { audit: { enabled: false } } });
  expect(feature.before).toBeUndefined();
  expect(feature.after).toBeUndefined();
  expect(existsSync(join(state, 'foxpaw', 'audit'))).toBe(false);
});

test('validates the audit settings key', () => {
  expect(auditConfig({})).toEqual({ enabled: true, screenshots: 'writes', retainDays: 30 });
  expect(auditConfig({ audit: { screenshots: 'all', retainDays: 7 } })).toEqual({ enabled: true, screenshots: 'all', retainDays: 7 });
  expect(() => auditConfig({ audit: { screenshots: 'some' } })).toThrow('screenshots');
  expect(() => auditConfig({ audit: { retainDays: 0 } })).toThrow('retainDays');
  expect(() => auditConfig({ audit: { retain: 3 } })).toThrow();
});

test('prunes day logs and screenshot folders older than retainDays at startup', () => {
  const state = tempDir();
  const dir = join(state, 'foxpaw', 'audit');
  mkdirSync(join(dir, '2026-10-01'), { recursive: true });
  writeFileSync(join(dir, '2026-10-01', 'a-1-before.png'), 'x');
  for (const name of ['2026-10-01.jsonl', '2026-10-26.jsonl', '2026-10-27.jsonl', '2026-11-26.jsonl', 'notes.txt']) writeFileSync(join(dir, name), '');
  const now = () => new Date(2026, 10, 26, 12);
  expect(new AuditLog(dir, now).prune(30).sort()).toEqual(['2026-10-01', '2026-10-01.jsonl', '2026-10-26.jsonl']);
  expect(readdirSync(dir).sort()).toEqual(['2026-10-27.jsonl', '2026-11-26.jsonl', 'notes.txt']);

  writeFileSync(join(dir, '2026-11-01.jsonl'), '');
  auditFeature({ env: { XDG_STATE_HOME: state }, settings: { audit: { retainDays: 3 } }, now });
  expect(readdirSync(dir).sort()).toEqual(['2026-11-26.jsonl', 'notes.txt']);
});

const entry = (overrides: Partial<AuditEntry>): AuditEntry => ({
  time: new Date(2026, 10, 26, 10).toISOString(), session: 'aaaa1111bbbb', host: 'omp', seq: 1, action: 'click', tabId: 'tab_1',
  params: { action: 'click' }, outcome: 'ok', result: {}, durationMs: 5, ...overrides,
});

test('filters by time, session prefix, tab, and action across day files', () => {
  const dir = tempDir();
  const log = new AuditLog(dir);
  log.append(entry({ time: new Date(2026, 10, 25, 23).toISOString(), seq: 1 }));
  log.append(entry({ seq: 2, action: 'fill', tabId: 'tab_3' }));
  log.append(entry({ seq: 3, session: 'cccc2222dddd' }));
  appendFileSync(join(dir, '2026-11-26.jsonl'), 'not json\n');
  log.append(entry({ time: new Date(2026, 10, 26, 11).toISOString(), seq: 4 }));

  const seqs = (filter: Parameters<typeof readEntries>[1]) => readEntries(dir, filter).map((item) => `${item.session.slice(0, 4)}:${item.seq}`);
  expect(seqs({})).toEqual(['aaaa:1', 'aaaa:2', 'cccc:3', 'aaaa:4']);
  const now = new Date(2026, 10, 26, 12);
  expect(seqs({ since: parseSince('2026-11-26', now) })).toEqual(['aaaa:2', 'cccc:3', 'aaaa:4']);
  expect(seqs({ since: parseSince('90m', now) })).toEqual(['aaaa:4']);
  expect(seqs({ session: 'cccc' })).toEqual(['cccc:3']);
  expect(seqs({ tab: 'tab_3' })).toEqual(['aaaa:2']);
  expect(seqs({ action: 'click', session: 'aaaa' })).toEqual(['aaaa:1', 'aaaa:4']);
  expect(() => parseSince('yesterday')).toThrow('--since');
});

test('formats a readable table with target and outcome', () => {
  const table = formatTable([
    entry({ target: { selector: '#go', tag: 'button', role: 'button', name: 'Pay now' }, urlBefore: 'https://a.test/', urlAfter: 'https://a.test/done' }),
    entry({ seq: 2, action: 'navigate', params: { action: 'navigate', url: 'https://a.test/' }, outcome: 'refused', result: { error: 'Refused by policy' } }),
  ], new Date(2026, 10, 26, 12)).split('\n');
  expect(table[0]).toMatch(/^TIME\s+SESSION\s+SEQ\s+ACTION\s+TAB\s+TARGET\s+OUTCOME$/);
  expect(table[1]).toContain('aaaa1111');
  expect(table[1]).toContain('button "Pay now"');
  expect(table[1]).toContain('ok, → https://a.test/done');
  expect(table[2]).toContain('https://a.test/');
  expect(table[2]).toContain('refused: Refused by policy');
});

test('follow reports lines appended after it started, including partial writes', async () => {
  const dir = tempDir();
  const log = new AuditLog(dir);
  log.append(entry({ time: new Date().toISOString(), seq: 1 }));
  const seen: number[] = [];
  const firstDelivered = Promise.withResolvers<void>();
  const controller = new AbortController();
  const following = followEntries(dir, { action: 'click' }, (item) => { seen.push(item.seq); firstDelivered.resolve(); }, controller.signal, 5);
  const file = join(dir, `${localDate(new Date())}.jsonl`);
  const line = JSON.stringify(entry({ time: new Date().toISOString(), seq: 4 }));
  // One poll sees seq 2, seq 3 (filtered out), and half of seq 4; the rest of seq 4 arrives after that poll.
  log.append(entry({ time: new Date().toISOString(), seq: 2 }));
  log.append(entry({ time: new Date().toISOString(), seq: 3, action: 'fill' }));
  appendFileSync(file, line.slice(0, 20));
  await firstDelivered.promise;
  appendFileSync(file, `${line.slice(20)}\n`);
  controller.abort();
  await following;
  expect(seen).toEqual([2, 4]);
});

test('redactParams leaves non-value text alone', () => {
  expect(redactParams({ action: 'wait_for', text: 'Registration Results' }).params.text).toBe('Registration Results');
  expect(redactParams({ action: 'check_many', fields: { '#a': 'true' } }).params.fields).toEqual({ '#a': 'true' });
});
