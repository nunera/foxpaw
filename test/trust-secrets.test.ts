import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InputVerificationError } from '../src/browser.ts';
import type { Runner } from '../src/trust/approve.ts';
import { parseSecrets, Redactor, resolveSecret } from '../src/trust/secrets.ts';
import { secretsFeature } from '../src/tool/features/secrets.ts';
import type { ActionCall, ActionOutcome, ToolFeature, ToolParams, ToolRuntime } from '../src/tool/core.ts';

const SECRET = 'hunter2 "&/ +x';

function setup(options: { origins?: string[]; frameOrigin?: string; fieldType?: string; fillError?: Error } = {}) {
  const path = join(mkdtempSync(join(tmpdir(), 'foxpaw-secrets-')), 'config.json');
  writeFileSync(path, JSON.stringify({ secrets: { bank: { source: 'env:BANK_PW', origins: options.origins ?? ['https://bank.example'] } } }));
  const env = { FOXPAW_CONFIG: path, BANK_PW: SECRET };
  const page = { timeOrigin: 1000, fieldType: options.fieldType ?? 'password', fills: [] as Array<{ context: string; selector: string; value: string }>, value: '' };
  const runtime = {
    browser: {
      evaluateValue: async (context: string, expression: string) => {
        if (expression === 'location.origin') return context === 'frame_1' ? (options.frameOrigin ?? 'https://bank.example') : 'https://bank.example';
        if (expression === 'performance.timeOrigin') return page.timeOrigin;
        if (expression.includes('performance.timeOrigin')) return 'doc_1';
        if (expression.includes('HTMLInputElement')) return true;
        if (expression.includes('element.type')) return page.fieldType;
        if (expression.includes('element.value')) return page.value;
        throw new Error(`unexpected evaluate ${expression}`);
      },
      fill: async (context: string, selector: string, value: string) => {
        page.fills.push({ context, selector, value });
        if (options.fillError) throw options.fillError;
        page.value = value;
        return { requestedValue: value, actualValue: value, focused: true, replaced: true };
      },
    },
    target: async (action: string, tabId?: string) => {
      if (!tabId) throw new Error(`${action} requires tabId`);
      return { context: { id: tabId === 'tab_1' ? 'ctx_1' : 'ctx_2', url: 'https://bank.example/login', parent: null }, tabId };
    },
    resolve: async () => ({ selector: '#password', frame: { context: 'frame_1', documentId: 'doc_1' }, identity: { tag: 'input', role: 'textbox', name: 'Password' } }),
  } as unknown as ToolRuntime;
  const feature = secretsFeature({ env });
  return { feature, runtime, page, run: (params: Partial<ToolParams> & { action: string }, result?: () => Record<string, unknown>) => execute([feature], runtime, params, result) };
}

// The core's execute loop: before hooks, the handler (or a stand-in core action), after hooks.
async function execute(features: ToolFeature[], runtime: ToolRuntime, params: Partial<ToolParams> & { action: string }, coreResult: () => Record<string, unknown> = () => ({ ok: true })) {
  const call: ActionCall = { action: params.action, params: params as ToolParams };
  let outcome: ActionOutcome;
  try {
    for (const feature of features) await feature.before?.(call, runtime);
    const handler = features.find((feature) => feature.actions?.[call.action])?.actions?.[call.action];
    outcome = { result: handler ? await handler(call, runtime) : { details: coreResult() }, startedAt: 0 };
  } catch (error) { outcome = { error, startedAt: 0 }; }
  for (const feature of features) outcome = await feature.after?.(call, outcome, runtime) ?? outcome;
  if (!outcome.result) throw outcome.error;
  return outcome.result.details;
}
const errorOf = async (promise: Promise<unknown>) => {
  try { await promise; } catch (error) { return error as Error; }
  throw new Error('expected an error');
};

test('fill_secret fills the configured value on an allowed origin and returns only the name', async () => {
  const { run, page } = setup();
  const details = await run({ action: 'fill_secret', tabId: 'tab_1', selector: '#password', secret: 'bank' });
  expect(details).toEqual({ tabId: 'tab_1', filled: true, secret: 'bank', selector: '#password' });
  expect(page.fills).toEqual([{ context: 'frame_1', selector: '#password', value: SECRET }]);
  expect(JSON.stringify(details)).not.toContain('hunter2');
});

test('fill_secret refuses other origins, including a foreign iframe on an allowed page, and unknown names', async () => {
  const other = setup({ origins: ['https://other.example'] });
  const refused = await errorOf(other.run({ action: 'fill_secret', tabId: 'tab_1', selector: '#password', secret: 'bank' }));
  expect(JSON.parse(refused.message)).toMatchObject({ actionPerformed: false, secret: 'bank', origin: 'https://bank.example', allowedOrigins: ['https://other.example'] });
  expect(other.page.fills).toEqual([]);

  const framed = setup({ frameOrigin: 'https://evil.example' });
  const framedError = await errorOf(framed.run({ action: 'fill_secret', tabId: 'tab_1', selector: '#password', secret: 'bank' }));
  expect(JSON.parse(framedError.message)).toMatchObject({ actionPerformed: false, origin: 'https://evil.example' });
  expect(framed.page.fills).toEqual([]);

  const unknown = setup();
  const missing = await errorOf(unknown.run({ action: 'fill_secret', tabId: 'tab_1', selector: '#password', secret: 'nope' }));
  expect(JSON.parse(missing.message)).toMatchObject({ actionPerformed: false, configured: ['bank'] });
});

test('after a fill, every later result and error on any tab is redacted, in raw, URL, JSON-, and HTML-escaped forms', async () => {
  const { run } = setup();
  await run({ action: 'fill_secret', tabId: 'tab_1', selector: '#password', secret: 'bank' });
  const leaked = await run({ action: 'query', tabId: 'tab_2', selector: 'input' }, () => ({
    elements: [{ value: SECRET }, { href: `https://evil.example/?q=${encodeURIComponent(SECRET)}` }, { form: new URLSearchParams({ p: SECRET }).toString() }],
    nested: JSON.stringify({ field: { value: SECRET } }),
    html: `<p id="echo">Received ${SECRET.replace(/&/g, '&amp;')}</p><input value="${SECRET.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">`,
  }));
  const text = JSON.stringify(leaked);
  expect(text).not.toContain('hunter2');
  expect(text).toContain('[secret:bank]');
  const error = await errorOf(run({ action: 'field_state', tabId: 'tab_2', selector: '#x' }, () => { throw new Error(JSON.stringify({ error: `Keys were sent, but the field now reads ${JSON.stringify(SECRET)}` })); }));
  expect(error.message).not.toContain('hunter2');
  expect(error.message).toContain('[secret:bank]');
});

test('secret mode refuses evaluate and value asserts until the document changes', async () => {
  const { run, page } = setup();
  await run({ action: 'fill_secret', tabId: 'tab_1', selector: '#password', secret: 'bank' });
  const refused = JSON.parse((await errorOf(run({ action: 'evaluate', tabId: 'tab_1', expression: 'document.querySelector("#password").value' }))).message);
  expect(refused).toMatchObject({ action: 'evaluate', actionPerformed: false, secretMode: true });
  expect((await errorOf(run({ action: 'assert', tabId: 'tab_1', selector: '#password', property: 'value', equals: 'guess' }))).message).toContain('secret');
  expect((await errorOf(run({ action: 'batch', tabId: 'tab_1', batch: [{ action: 'assert', selector: '#password', property: 'value', equals: 'guess' }] }))).message).toContain('secret');
  // Other tabs are not in secret mode.
  expect(await run({ action: 'evaluate', tabId: 'tab_2', expression: '1' })).toEqual({ ok: true });
  page.timeOrigin = 2000;
  expect(await run({ action: 'evaluate', tabId: 'tab_1', expression: '1' })).toEqual({ ok: true });
});

test('secret mode allows screenshots only while every filled field is a password field', async () => {
  const { run, page } = setup();
  await run({ action: 'fill_secret', tabId: 'tab_1', selector: '#password', secret: 'bank' });
  expect(await run({ action: 'screenshot', tabId: 'tab_1' })).toEqual({ ok: true });
  // A "show password" toggle turns the field into plain text.
  page.fieldType = 'text';
  expect(JSON.parse((await errorOf(run({ action: 'screenshot', tabId: 'tab_1' }))).message)).toMatchObject({ actionPerformed: false, secretMode: true });
});

test('a fill the field truncated reports unverified and redacts the partial value too', async () => {
  const { run, page } = setup({ fillError: new InputVerificationError(`Keys were sent, but the field now reads "hunter2 " instead of ${JSON.stringify(SECRET)}`) });
  page.value = 'hunter2 ';
  const details = await run({ action: 'fill_secret', tabId: 'tab_1', selector: '#password', secret: 'bank' });
  expect(details).toMatchObject({ filled: true, verified: false, secret: 'bank' });
  expect(JSON.stringify(await run({ action: 'field_state', tabId: 'tab_1', selector: '#password' }, () => ({ value: 'hunter2 ' })))).not.toContain('hunter2');
});

test('secrets config is validated and sources resolve through their tools', async () => {
  expect(parseSecrets({ bank: { source: 'vault:x', origins: ['https://bank.example'] } }).ok).toBe(false);
  expect(parseSecrets({ bank: { source: 'env:X', origins: ['https://bank.example/login'] } }).ok).toBe(false);
  const ok = parseSecrets({ bank: { source: 'env:X', origins: ['https://bank.example/'] } });
  expect(ok.ok && ok.secrets.bank?.origins).toEqual(['https://bank.example']);

  const calls: string[][] = [];
  const run: Runner = async (command, args) => {
    calls.push([command, ...args]);
    if (command === 'bw' && args[1] === 'item') return { code: 0, stdout: JSON.stringify({ fields: [{ name: 'pin', value: '4321' }] }), stderr: '' };
    return { code: 0, stdout: 's3cret\nsecond line\n', stderr: '' };
  };
  expect(await resolveSecret('pass:web/bank', { run })).toBe('s3cret');
  expect(await resolveSecret('bitwarden:Bank', { run })).toBe('s3cret\nsecond line');
  expect(await resolveSecret('bitwarden:Bank/pin', { run })).toBe('4321');
  expect(await resolveSecret('keyring:bank/me', { run, platform: 'linux' })).toBe('s3cret\nsecond line');
  expect(await resolveSecret('keyring:bank/me', { run, platform: 'darwin' })).toBe('s3cret\nsecond line');
  expect(calls).toEqual([
    ['pass', 'show', 'web/bank'],
    ['bw', 'get', 'password', 'Bank'],
    ['bw', 'get', 'item', 'Bank'],
    ['secret-tool', 'lookup', 'service', 'bank', 'account', 'me'],
    ['security', 'find-generic-password', '-s', 'bank', '-a', 'me', '-w'],
  ]);
  await expect(resolveSecret('env:MISSING_VAR', { env: {} })).rejects.toThrow('MISSING_VAR');
  await expect(resolveSecret('pass:x', { run: async () => ({ code: 1, stdout: '', stderr: 'not in store' }) })).rejects.toThrow('not in store');
});

test('the redactor leaves unrelated text alone', () => {
  const redactor = new Redactor();
  redactor.add('pin', '4321');
  expect(redactor.value({ a: 'code 4321 ok', b: 4321, c: ['x'] })).toEqual({ a: 'code [secret:pin] ok', b: 4321, c: ['x'] });
});
