import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { BidiError, type BidiEvent, type BidiTransport } from '../src/bidi.ts';
import { ZenBrowser } from '../src/browser.ts';
import type { FrameInfo, PageNode } from '../src/locator.ts';
import { createBrowserTool, type ActionCall, type ElementRecord, type ToolParams, type ToolRuntime } from '../src/tool/core.ts';
import { downloadsFeature } from '../src/tool/features/downloads.ts';
import { PageHandles } from '../src/tool/features/page-model.ts';
import { diffSnapshot, snapshotFeature, snapshotLine } from '../src/tool/features/snapshot.ts';

const box = { x: 0, y: 0, width: 10, height: 10 };
const node = (sharedId: string, role: string, name: string | null, extra: Partial<PageNode> = {}): PageNode => ({
  sharedId, depth: 0, role, name, states: [], selector: `#${sharedId}`, identity: { tag: 'div', role: null, name }, interactive: role === 'button', box, ...extra,
});

test('renders one compact line per node', () => {
  expect(snapshotLine({ depth: 2, role: 'textbox', name: 'Email "work"', value: 'a@b.test', states: ['required', 'focused'] }, 'el_3')).toBe('    textbox "Email \\"work\\"" = "a@b.test" [required, focused] el_3');
  expect(snapshotLine({ depth: 0, role: 'main', name: null, states: [] }, 'el_1')).toBe('main el_1');
});

test('a diff reports changed, added, and removed lines by handle and counts the rest', () => {
  const previous = new Map([['el_1', 'heading "Cart" [h1] el_1'], ['el_2', '  button "Pay" el_2'], ['el_3', '  text "2 items" el_3']]);
  const diff = diffSnapshot(previous, [
    { handle: 'el_1', text: 'heading "Cart" [h1] el_1' },
    { handle: 'el_2', text: '  button "Pay" [disabled] el_2' },
    { handle: 'el_4', text: '  text "Paid" el_4' },
  ]);
  expect(diff).toEqual({ lines: ['~ button "Pay" [disabled] el_2', '+ text "Paid" el_4', '- text "2 items" el_3'], added: 1, removed: 1, changed: 1, unchanged: 1 });
});

type FakeDom = { documentId: string; top: PageNode[]; child: PageNode[] };
function fakeRuntime(dom: FakeDom) {
  const records = new Map<string, ElementRecord>();
  let next = 1;
  const frames = (): FrameInfo[] => [
    { context: 'top', documentId: dom.documentId, url: 'https://shop.test/', parent: null },
    { context: 'pay', documentId: 'pay-doc', url: 'https://pay.test/', parent: 'top' },
  ];
  const runtime = {
    target: async () => ({ context: { id: 'top', url: 'https://shop.test/', parent: null }, tabId: 'tab_1' }),
    browser: {
      watchPrompts: async () => {},
      openPrompt: () => undefined,
      frames: async () => frames(),
      pageNodes: async (context: string) => ({ nodes: structuredClone(context === 'top' ? dom.top : dom.child), truncated: false }),
    },
    registerElement: (record: ElementRecord, handle?: string) => {
      if (handle !== undefined && !records.has(handle)) throw new Error('unknown handle');
      const id = handle ?? `el_${next++}`;
      records.set(id, record);
      return id;
    },
  };
  return { runtime: runtime as unknown as ToolRuntime, records };
}
const snapshot = async (runtime: ToolRuntime, feature: ReturnType<typeof snapshotFeature>, params: Partial<ToolParams> = {}) => {
  const call: ActionCall = { action: 'snapshot', params: { action: 'snapshot', tabId: 'tab_1', ...params } };
  return (await feature.actions!.snapshot!(call, runtime)).details as Record<string, unknown>;
};

test('snapshot handles stay stable, later calls diff, navigation and full reset', async () => {
  const dom: FakeDom = {
    documentId: 'doc-1',
    top: [node('h', 'heading', 'Checkout', { states: ['h1'] }), node('frame', 'iframe', 'Payment', { childContext: 'pay', contentOffset: { x: 5, y: 100 } }), node('note', 'text', 'Ready')],
    child: [node('card', 'textbox', 'Card number'), node('pay', 'button', 'Pay')],
  };
  const { runtime, records } = fakeRuntime(dom);
  const feature = snapshotFeature(new PageHandles());

  const first = await snapshot(runtime, feature);
  expect(first.mode).toBe('full');
  // Child-frame lines nest under their iframe, before the parent's next node.
  expect(first.tree).toBe('heading "Checkout" [h1] el_1\niframe "Payment" el_2\n  textbox "Card number" el_3\n  button "Pay" el_4\ntext "Ready" el_5');
  expect(first.frames).toEqual([{ context: 'pay', url: 'https://pay.test/' }]);
  expect(records.get('el_4')).toMatchObject({ tabId: 'tab_1', nodeId: 'pay', frame: { context: 'pay', documentId: 'pay-doc' } });

  // A sibling inserted before the button changes its selector, not its handle; only real changes are reported.
  dom.child = [node('error', 'text', 'Card declined'), node('card', 'textbox', 'Card number', { states: ['invalid'] }), node('pay', 'button', 'Pay', { selector: 'div > button:nth-of-type(2)' })];
  dom.top = dom.top.filter((entry) => entry.sharedId !== 'note');
  const second = await snapshot(runtime, feature);
  expect(second).toMatchObject({ mode: 'diff', added: 1, removed: 1, changed: 1, unchanged: 3 });
  expect(second.diff).toBe('+ text "Card declined" el_6\n~ textbox "Card number" [invalid] el_3\n- text "Ready" el_5');
  expect(records.get('el_4')?.locator.css).toBe('div > button:nth-of-type(2)');
  const tokens = second.tokens as { full: number; diff: number };
  expect(tokens.diff).toBeLessThan(tokens.full);

  expect(await snapshot(runtime, feature)).toMatchObject({ mode: 'diff', diff: '', unchanged: 5 });
  expect(await snapshot(runtime, feature, { full: true })).toMatchObject({ mode: 'full' });
  // Another scope is not diffed against this one.
  expect(await snapshot(runtime, feature, { root: 'main' })).toMatchObject({ mode: 'full' });

  dom.documentId = 'doc-2';
  const navigated = await snapshot(runtime, feature, { root: 'main' });
  expect(navigated.mode).toBe('full');
  expect(String(navigated.tree).split('\n')[0]).toBe('heading "Checkout" [h1] el_7');
});

// BiDi remote-value serialization of a plain JSON value.
function remote(value: unknown): Record<string, unknown> {
  if (value === null) return { type: 'null' };
  if (Array.isArray(value)) return { type: 'array', value: value.map(remote) };
  if (typeof value === 'object') return { type: 'object', value: Object.entries(value as object).map(([key, item]) => [key, remote(item)]) };
  return { type: typeof value, value };
}
function fakeBidi(handler: (method: string, params: Record<string, unknown>) => unknown): BidiTransport & { emit(event: BidiEvent): void; commands: Array<[string, Record<string, unknown>]> } {
  const listeners = new Set<(event: BidiEvent) => void>();
  const commands: Array<[string, Record<string, unknown>]> = [];
  const run = async (method: string, params: Record<string, unknown> = {}) => { commands.push([method, params]); return (await handler(method, params) ?? {}) as Record<string, unknown>; };
  return {
    commands,
    command: run,
    commandOptional: run,
    onEvent: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    subscribe: async () => {},
    unsubscribe: async () => {},
    close: async () => {},
    emit: (event) => { for (const listener of listeners) listener(event); },
  };
}

test('a handle follows its node through selector changes and goes stale once the node is gone', async () => {
  let location: unknown = { selector: '#list > button:nth-of-type(1)', identity: { tag: 'button', role: 'button', name: 'Save' } };
  const bidi = fakeBidi((method) => {
    if (method === 'browsingContext.getTree') return { contexts: [{ context: 'top', url: 'https://a.test/', children: [{ context: 'frame', url: 'https://b.test/', children: [] }] }] };
    if (method === 'script.evaluate') return { type: 'success', result: remote('https://b.test/\u00001') };
    if (method === 'script.callFunction') {
      if (location === 'gone') throw new BidiError('script.callFunction', 'no such node', {});
      return { type: 'success', result: remote(location) };
    }
    return {};
  });
  const tool = createBrowserTool(z, { client: bidi });
  const frame = { context: 'frame', documentId: 'https://b.test/\u00001' };
  const handle = tool.runtime.registerElement({ tabId: 'tab_1', locator: { css: '#save', frame }, frame, identity: { tag: 'button', role: 'button', name: 'Save' }, nodeId: 'node-1' });
  const context = { id: 'top', url: 'https://a.test/', parent: null };

  expect(await tool.runtime.resolve(context, 'tab_1', { handle })).toEqual({ selector: '#list > button:nth-of-type(1)', frame, identity: { tag: 'button', role: 'button', name: 'Save' } });
  location = { selector: '#list > button:nth-of-type(2)', identity: { tag: 'button', role: 'button', name: 'Save' } };
  expect((await tool.runtime.resolve(context, 'tab_1', { handle })).selector).toBe('#list > button:nth-of-type(2)');
  location = { selector: '#list > button:nth-of-type(2)', identity: { tag: 'button', role: 'button', name: 'Delete' } };
  await expect(tool.runtime.resolve(context, 'tab_1', { handle })).rejects.toThrow(`Stale element handle ${handle}`);
  // Rebinding keeps the handle and accepts the new identity; an unknown handle can't be rebound.
  expect(tool.runtime.registerElement({ tabId: 'tab_1', locator: { css: '#save', frame }, frame, identity: { tag: 'button', role: 'button', name: 'Delete' }, nodeId: 'node-1' }, handle)).toBe(handle);
  expect((await tool.runtime.resolve(context, 'tab_1', { handle })).identity.name).toBe('Delete');
  expect(() => tool.runtime.registerElement({ tabId: 'tab_1', locator: {}, frame, identity: { tag: 'a', role: null, name: null }, nodeId: 'x' }, 'el_999')).toThrow('Unknown element handle');
  location = 'gone';
  await expect(tool.runtime.resolve(context, 'tab_1', { handle })).rejects.toThrow(`Stale element handle ${handle}`);
  await expect(tool.runtime.resolve(context, 'tab_1', { selector: '#x', locator: { frame: { context: 'elsewhere', documentId: 'd' } } })).rejects.toThrow('is not a frame of tab_1');
});

test('selector waits see a cross-origin child frame; hidden waits need every frame', async () => {
  let childHas = false;
  const bidi = fakeBidi((method, params) => {
    if (method === 'browsingContext.getTree') return { contexts: [{ context: 'top', url: 'https://a.test/', children: [{ context: 'child', url: 'https://b.test/', children: [] }] }] };
    if (method !== 'script.evaluate') return {};
    const target = (params.target as { context: string }).context;
    const wantsVisible = String(params.expression).includes('=== true');
    // The top document never has the element; the child has it once `childHas` is set.
    const present = target === 'child' && childHas;
    return { type: 'success', result: remote(present === wantsVisible) };
  });
  const browser = new ZenBrowser(bidi);
  await expect(browser.waitFor('top', '#paid', 200)).rejects.toThrow('Timed out waiting for "#paid" to become visible');
  childHas = true;
  await expect(browser.waitFor('top', '#paid', 1_000)).resolves.toBeUndefined();
  await expect(browser.waitFor('top', '#paid', 200, 'hidden')).rejects.toThrow('to become hidden');
  childHas = false;
  await expect(browser.waitFor('top', '#paid', 1_000, 'hidden')).resolves.toBeUndefined();
});

test('wait_download returns the download the preceding action started, with its file', async () => {
  const bidi = fakeBidi((method) => {
    if (method === 'browsingContext.getTree') return { contexts: [{ context: 'top', url: 'https://a.test/', children: [] }] };
    return {};
  });
  const browser = new ZenBrowser(bidi);
  const runtime = {
    browser,
    tabId: () => 'tab_1',
    target: async () => ({ context: { id: 'top', url: 'https://a.test/', parent: null }, tabId: 'tab_1' }),
  } as unknown as ToolRuntime;
  const directory = mkdtempSync(join(tmpdir(), 'foxpaw-downloads-'));
  const feature = downloadsFeature({ settings: { downloads: { directory } } });
  const begin = (id: string, file: string) => bidi.emit({ method: 'browsingContext.downloadWillBegin', params: { context: 'top', download: id, url: `https://a.test/${file}`, suggestedFilename: file } });
  const end = (id: string, file: string) => bidi.emit({ method: 'browsingContext.downloadEnd', params: { context: 'top', download: id, url: `https://a.test/${file}`, status: 'complete', filepath: join(directory, file) } });

  await feature.before!({ action: 'navigate', params: { action: 'navigate', tabId: 'tab_1' } }, runtime);
  expect(bidi.commands.find(([method]) => method === 'browser.setDownloadBehavior')?.[1]).toEqual({ downloadBehavior: { type: 'allowed', destinationFolder: directory } });
  begin('old', 'old.csv');
  end('old', 'old.csv');
  await feature.before!({ action: 'click', params: { action: 'click', tabId: 'tab_1' } }, runtime);
  const waiting = feature.actions!.wait_download!({ action: 'wait_download', params: { action: 'wait_download', tabId: 'tab_1', timeoutMs: 1_000 } }, runtime);
  begin('new', 'report.pdf');
  end('new', 'report.pdf');
  expect((await waiting).details).toMatchObject({ tabId: 'tab_1', download: { suggestedFilename: 'report.pdf', state: 'complete', path: join(directory, 'report.pdf') } });
  await expect(feature.actions!.wait_download!({ action: 'wait_download', params: { action: 'wait_download', tabId: 'tab_1', timeoutMs: 50 } }, runtime)).rejects.toThrow('No download started in tab_1');
  expect(((await feature.actions!.downloads!({ action: 'downloads', params: { action: 'downloads' } }, runtime)).details.downloads as unknown[]).length).toBe(2);
  await feature.shutdown!();
  expect(bidi.commands.at(-1)).toEqual(['browser.setDownloadBehavior', { downloadBehavior: null }]);
  rmSync(directory, { recursive: true, force: true });
});
