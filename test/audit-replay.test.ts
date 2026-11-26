import { expect, test } from 'bun:test';
import type { AuditEntry } from '../src/audit/log.ts';
import { parseScript, planScript, recordScript, replayScript, type ReplayScript } from '../src/audit/replay.ts';
import type { BrowserTool, ToolParams } from '../src/tool/core.ts';

let seq = 0;
const entry = (overrides: Partial<AuditEntry> & Pick<AuditEntry, 'action'>): AuditEntry => ({
  time: new Date(2026, 10, 26, 10, 0, seq).toISOString(), session: 'feed1234beef', host: 'omp', seq: ++seq, tabId: 'tab_1',
  params: { action: overrides.action, tabId: overrides.tabId ?? 'tab_1' }, outcome: 'ok', result: { actionPerformed: true }, durationMs: 3, ...overrides,
});

function sampleLog(): AuditEntry[] {
  seq = 0;
  return [
    entry({ action: 'tabs', tabId: undefined, result: {} }),
    entry({ action: 'navigate', params: { action: 'navigate', tabId: 'tab_1', url: 'https://shop.test/cart?id=9' }, urlBefore: 'https://shop.test/', urlAfter: 'https://shop.test/cart?id=9', documentChanged: true }),
    entry({ action: 'inspect', result: {} }),
    entry({ action: 'fill', params: { action: 'fill', tabId: 'tab_1', handle: 'el_4', value: { $redacted: 6 } }, target: { selector: '#coupon', tag: 'input', role: 'textbox', name: 'Coupon' }, urlBefore: 'https://shop.test/cart?id=9', urlAfter: 'https://shop.test/cart?id=9', documentChanged: false, result: { actionPerformed: true, verified: true } }),
    entry({ action: 'click', params: { action: 'click', tabId: 'tab_1', handle: 'el_7' }, target: { selector: 'form > button:nth-of-type(2)', tag: 'button', role: 'button', name: null }, urlBefore: 'https://shop.test/cart?id=9', urlAfter: 'https://shop.test/checkout#top', documentChanged: true }),
    entry({ action: 'click', params: { action: 'click', tabId: 'tab_1', selector: '#pay' }, outcome: 'failed', result: { actionPerformed: false, error: 'covered' } }),
    entry({ action: 'open', params: { action: 'open', tabId: 'tab_1', url: 'https://help.test/' }, urlBefore: 'https://shop.test/checkout', urlAfter: 'https://shop.test/checkout', result: { openedTabId: 'tab_2' } }),
    entry({ action: 'click', tabId: 'tab_2', params: { action: 'click', tabId: 'tab_2', selector: '#faq', waitFor: { text: 'FAQ' } }, urlBefore: 'https://help.test/start', urlAfter: 'https://help.test/start', documentChanged: false }),
    entry({ action: 'batch', tabId: 'tab_2', params: { action: 'batch', tabId: 'tab_2', batch: [{ action: 'fill', handle: 'el_9', value: { $redacted: 3 } }, { action: 'click', selector: '#send' }] }, stepTargets: [{ selector: '#q', tag: 'input', role: 'searchbox', name: 'Ask' }, null], urlBefore: 'https://help.test/start', urlAfter: 'https://help.test/answers?q=1', documentChanged: true }),
    entry({ action: 'click', tabId: 'tab_9', params: { action: 'click', tabId: 'tab_9', selector: '#x' }, urlBefore: 'https://elsewhere.test/' }),
  ];
}

test('records successful page-changing actions as durable, versioned steps', () => {
  const { script, skipped } = recordScript(sampleLog(), { to: 9 }, new Date(2026, 10, 26, 12));
  expect(skipped).toEqual([{ seq: 6, action: 'click', reason: 'failed: covered' }]);
  expect(script.version).toBe(1);
  expect(script.startUrl).toBe('https://shop.test/');
  expect(script.recorded).toMatchObject({ session: 'feed1234beef', host: 'omp', to: 9 });
  expect(script.vars).toEqual({
    v1: { length: 6, step: 1, field: 'value', target: 'textbox "Coupon"' },
    v2: { length: 3, step: 6, field: 'batch.0.value', target: 'searchbox "Ask"' },
  });
  expect(script.steps).toEqual([
    { action: 'navigate', tab: 't1', params: { url: 'https://shop.test/cart?id=9', waitFor: { url: 'https://shop.test/cart' } }, source: { session: 'feed1234beef', seq: 2 } },
    // handle → role+name; no wait because the page didn't change.
    { action: 'fill', tab: 't1', params: { value: { $var: 'v1' } }, target: { locator: { role: 'textbox', name: 'Coupon' } }, source: { session: 'feed1234beef', seq: 4 } },
    // No accessible name: CSS fallback. The fragment is not part of the wait.
    { action: 'click', tab: 't1', params: { waitFor: { url: 'https://shop.test/checkout' } }, target: { locator: { css: 'form > button:nth-of-type(2)' } }, source: { session: 'feed1234beef', seq: 5 } },
    { action: 'open', tab: 't1', params: { url: 'https://help.test/' }, opens: 't2', source: { session: 'feed1234beef', seq: 7 } },
    // Waits until the new tab lands where it did when recorded (after its redirect).
    { action: 'wait_url', tab: 't2', params: { url: 'https://help.test/start' } },
    // A plain selector is durable already; its own waitFor stays.
    { action: 'click', tab: 't2', params: { selector: '#faq', waitFor: { text: 'FAQ' } }, source: { session: 'feed1234beef', seq: 8 } },
    { action: 'batch', tab: 't2', params: { batch: [{ action: 'fill', value: { $var: 'v2' }, target: { locator: { role: 'searchbox', name: 'Ask' } } }, { action: 'click', selector: '#send' }] }, source: { session: 'feed1234beef', seq: 9 } },
    // batch has no waitFor param, so the observed navigation becomes its own step.
    { action: 'wait_url', tab: 't2', params: { url: 'https://help.test/answers' } },
  ]);
  expect(parseScript(JSON.stringify(script))).toEqual(script);
  expect(planScript(script).at(-1)).toBe('  v2: 3 chars, step 7 batch.0.value of searchbox "Ask"');
});

test('a leading open becomes the fresh start tab instead of a second tab', () => {
  seq = 0;
  const log = [
    entry({ action: 'open', params: { action: 'open', url: 'https://help.test/' }, urlBefore: 'about:blank', result: { openedTabId: 'tab_2' } }),
    entry({ action: 'click', tabId: 'tab_2', params: { action: 'click', tabId: 'tab_2', selector: '#faq' }, urlBefore: 'https://help.test/start' }),
  ];
  const { script } = recordScript(log);
  expect(script.startUrl).toBe('https://help.test/start');
  expect(script.steps).toEqual([{ action: 'click', tab: 't1', params: { selector: '#faq' }, source: { session: 'feed1234beef', seq: 2 } }]);
});

test('refuses to record what it could not replay', () => {
  expect(() => recordScript(sampleLog())).toThrow('acts on tab_9, which the recorded range neither starts in nor opens');
  const log = sampleLog();
  delete log[3]!.target;
  expect(() => recordScript(log, { to: 5 })).toThrow('names its element by handle el_4');
  expect(() => recordScript(log, { from: 6, to: 6 })).toThrow('No successful page-changing actions');
  expect(() => recordScript([...sampleLog(), { ...sampleLog()[1]!, session: 'other' }])).toThrow('2 sessions');
  expect(() => parseScript(JSON.stringify({ version: 2, startUrl: 'x', vars: {}, steps: [] }))).toThrow('version 1');
});

type Call = ToolParams;
function fakeTool(respond: (params: Call) => Record<string, unknown> = () => ({ actionPerformed: true })): Pick<BrowserTool, 'execute' | 'runtime'> & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    runtime: undefined as never,
    execute: async (params) => {
      calls.push(params);
      if (params.action === 'tabs') return { content: [], details: { tabs: [{ tabId: 'tab_1', url: 'about:home' }, { tabId: 'tab_4', url: 'https://shop.test/old' }], activeTabId: 'tab_1' } };
      if (params.action === 'open') return { content: [], details: { tabId: params.url === 'https://help.test/' ? 'tab_8' : 'tab_7', created: true } };
      return { content: [], details: respond(params) };
    },
  };
}

test('replays in a fresh tab with typed values, locators, and opened-tab mapping', async () => {
  const { script } = recordScript(sampleLog(), { to: 9 });
  const tool = fakeTool();
  const progress: string[] = [];
  const report = await replayScript(script, tool, { vars: { v1: 'SAVE10', v2: 'how' }, onStep: (step) => progress.push(`${step.index}:${step.status}`) });
  expect(report).toMatchObject({ ok: true, startTabId: 'tab_7' });
  expect(progress).toEqual(['0:ok', '1:ok', '2:ok', '3:ok', '4:ok', '5:ok', '6:ok', '7:ok']);
  expect(tool.calls).toEqual([
    { action: 'tabs' },
    { action: 'open', tabId: 'tab_1', url: 'https://shop.test/' },
    { action: 'wait_url', tabId: 'tab_7', url: 'https://shop.test/' },
    { action: 'navigate', tabId: 'tab_7', url: 'https://shop.test/cart?id=9', waitFor: { url: 'https://shop.test/cart' } },
    { action: 'fill', tabId: 'tab_7', value: 'SAVE10', locator: { role: 'textbox', name: 'Coupon', exact: true } },
    { action: 'click', tabId: 'tab_7', waitFor: { url: 'https://shop.test/checkout' }, selector: 'form > button:nth-of-type(2)' },
    { action: 'open', tabId: 'tab_7', url: 'https://help.test/' },
    { action: 'wait_url', tabId: 'tab_8', url: 'https://help.test/start' },
    { action: 'click', tabId: 'tab_8', selector: '#faq', waitFor: { text: 'FAQ' } },
    { action: 'batch', tabId: 'tab_8', batch: [{ action: 'fill', value: 'how', locator: { role: 'searchbox', name: 'Ask', exact: true } }, { action: 'click', selector: '#send' }] },
    { action: 'wait_url', tabId: 'tab_8', url: 'https://help.test/answers' },
  ]);
});

test('replays in an existing tab chosen by URL', async () => {
  const script: ReplayScript = { version: 1, startUrl: 'https://shop.test/old', vars: {}, steps: [{ action: 'reload', tab: 't1', params: {} }] };
  const tool = fakeTool();
  await replayScript(script, tool, { tabUrl: 'shop.test' });
  expect(tool.calls).toEqual([{ action: 'tabs' }, { action: 'reload', tabId: 'tab_4' }]);
  await expect(replayScript(script, fakeTool(), { tabUrl: 'nowhere' })).rejects.toThrow('matches 0 tabs');
});

test('stops at the first step that fails or behaves differently, with a clear report', async () => {
  const { script } = recordScript(sampleLog(), { to: 5 });
  const waitFailed = fakeTool((params) => params.action === 'click' ? { actionPerformed: true, waitCompleted: false, waitError: 'Timed out waiting for a loaded URL', url: 'https://shop.test/cart?id=9' } : { actionPerformed: true });
  const report = await replayScript(script, waitFailed, { vars: { v1: 'SAVE10' } });
  expect(report.ok).toBe(false);
  expect(report.failure).toEqual({ index: 2, action: 'click', tab: 't1', tabId: 'tab_7', status: 'failed', error: 'the page did not change as recorded: Timed out waiting for a loaded URL', url: 'https://shop.test/cart?id=9' });
  expect(waitFailed.calls.at(-1)!.action).toBe('click');

  // A refusal (policy) or a missing element is thrown by the tool; nothing after it runs.
  const refused = fakeTool((params) => { if (params.action === 'fill') throw new Error(JSON.stringify({ action: 'fill', actionPerformed: false, error: 'Refused by policy: payment field' })); return { actionPerformed: true }; });
  const stopped = await replayScript(script, refused, { vars: { v1: 'SAVE10' } });
  expect(stopped.failure).toMatchObject({ index: 1, action: 'fill', error: 'Refused by policy: payment field' });
  expect(refused.calls.map((call) => call.action)).toEqual(['tabs', 'open', 'wait_url', 'navigate', 'fill']);

  const unverified = fakeTool((params) => params.action === 'fill' ? { actionPerformed: true, verified: false, verifyError: 'reads SAVE1' } : { actionPerformed: true });
  expect((await replayScript(script, unverified, { vars: { v1: 'SAVE10' } })).failure!.error).toContain('did not read back');

  const dialog = fakeTool((params) => params.action === 'navigate' ? { actionPerformed: true, openPrompt: { type: 'alert', message: 'Hi' } } : { actionPerformed: true });
  expect((await replayScript(script, dialog, { vars: { v1: 'SAVE10' } })).failure!.error).toContain('alert dialog opened');
});

test('requires every typed value before touching the browser', async () => {
  const { script } = recordScript(sampleLog(), { to: 9 });
  const tool = fakeTool();
  await expect(replayScript(script, tool, { vars: { v1: 'SAVE10' } })).rejects.toThrow('v2: 3 chars, step 7 batch.0.value of searchbox "Ask"');
  expect(tool.calls).toEqual([]);
});
