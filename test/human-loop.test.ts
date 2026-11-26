import { afterEach, expect, test } from 'bun:test';
import { z } from 'zod';
import { createBroker } from '../src/broker.ts';
import type { BrokerUpstream } from '../src/broker.ts';
import type { BidiEvent, JsonObject } from '../src/bidi.ts';
import { overlayMain, type PageWindow } from '../src/human/page.ts';
import { parseHotkey } from '../src/human/settings.ts';
import { createBrowserTool } from '../src/tool/core.ts';
import { pauseFeature } from '../src/tool/features/pause.ts';

const TOKEN = 'test-token';

/** Firefox behind the broker: tabA (with frameA1 once created) and tabB; created tabs get fresh ids. */
function fakeFirefox() {
  const calls: Array<{ method: string; params: JsonObject }> = [];
  let raw: ((event: BidiEvent) => void) | undefined;
  let redacted: ((event: BidiEvent) => void) | undefined;
  let next = 0;
  const upstream: BrokerUpstream = {
    sessionInfo: async () => ({ sessionId: 'real', capabilities: { browserName: 'firefox' } }),
    command: async (method, params = {}) => {
      calls.push({ method, params });
      if (method === 'session.subscribe') return { subscription: `sub-${++next}` };
      if (method === 'script.addPreloadScript') return { script: `pre-${++next}` };
      if (method === 'browsingContext.create') return { context: `tabNew${++next}` };
      if (method === 'browsingContext.getTree') return { contexts: [{ context: 'tabA', url: 'https://a.example/', children: [] }, { context: 'tabB', url: 'https://b.example/', children: [] }] };
      return {};
    },
    commandOptional: async () => ({}),
    subscribe: async () => {},
    unsubscribe: async () => {},
    onEvent: (listener) => { redacted = listener; return () => {}; },
    onRawEvent: (listener) => { raw = listener; return () => {}; },
    onDisconnect: () => () => {},
    close: async () => {},
  };
  const emit = (method: string, params: JsonObject) => { raw!({ method, params }); redacted?.({ method, params }); };
  return { upstream, calls, emit, sent: (method: string) => calls.filter((call) => call.method === method) };
}

type Reply = { result?: JsonObject; error?: { error: string; data: JsonObject } };
type Envelope = { socket: WebSocket; events: JsonObject[]; send(kind: string, payload?: JsonObject): Promise<Reply>; command(method: string, params: JsonObject, timeoutMs?: number): Promise<Reply> };
async function envelope(port: number): Promise<Envelope> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/?token=${TOKEN}`);
  const waiting = new Map<number, (reply: Reply) => void>();
  const events: JsonObject[] = [];
  socket.addEventListener('message', (message) => {
    const data = JSON.parse(String(message.data)) as JsonObject;
    if (data.kind === 'event') events.push(data); else waiting.get(data.id as number)?.(data as Reply);
  });
  const opened = Promise.withResolvers<unknown>();
  socket.addEventListener('open', opened.resolve, { once: true });
  socket.addEventListener('error', opened.reject, { once: true });
  await opened.promise;
  let id = 0;
  const send = (kind: string, payload: JsonObject = {}) => {
    const reply = Promise.withResolvers<Reply>();
    const n = ++id;
    waiting.set(n, reply.resolve);
    socket.send(JSON.stringify({ id: n, kind, ...payload }));
    return reply.promise;
  };
  return { socket, events, send, command: (method, params, timeoutMs) => send('command', { method, params, ...(timeoutMs ? { timeoutMs } : {}) }) };
}

type Raw = { socket: WebSocket; send(method: string, params?: JsonObject): Promise<JsonObject> };
async function rawClient(port: number): Promise<Raw> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/session?token=${TOKEN}`);
  const waiting = new Map<number, (message: JsonObject) => void>();
  socket.addEventListener('message', (message) => {
    const data = JSON.parse(String(message.data)) as JsonObject;
    if (data.type !== 'event') waiting.get(data.id as number)?.(data);
  });
  const opened = Promise.withResolvers<unknown>();
  socket.addEventListener('open', opened.resolve, { once: true });
  socket.addEventListener('error', opened.reject, { once: true });
  await opened.promise;
  let id = 0;
  return {
    socket,
    send: (method, params = {}) => {
      const reply = Promise.withResolvers<JsonObject>();
      const n = ++id;
      waiting.set(n, reply.resolve);
      socket.send(JSON.stringify({ id: n, method, params }));
      return reply.promise;
    },
  };
}

const until = async (predicate: () => boolean) => { for (let i = 0; i < 200 && !predicate(); i++) await Bun.sleep(5); expect(predicate()).toBe(true); };
/** Asks the broker until `tab` is free: each round trip lets it handle a client's disconnect first. */
const freed = async (client: Envelope, tab: string) => {
  const holders = async () => ((await client.send('leases')).result!.leases as JsonObject[]).filter((lease) => lease.context === tab);
  for (let i = 0; i < 200 && (await holders()).length; i++);
  expect(await holders()).toEqual([]);
};
const brokers: Array<{ shutdown(): Promise<void> }> = [];
afterEach(async () => { for (const broker of brokers.splice(0)) await broker.shutdown(); });
async function start() {
  const firefox = fakeFirefox();
  const broker = await createBroker(firefox.upstream, 0, { token: TOKEN });
  brokers.push(broker);
  return { ...firefox, port: broker.port };
}
const click = (context: string) => ({ context, actions: [{ type: 'pointer', id: 'mouse', actions: [{ type: 'pointerMove', origin: 'viewport', x: 40, y: 60 }, { type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 }] }] });

test('a tab one client acts on is refused to other envelope and raw clients, naming the holder', async () => {
  const { port, emit, sent } = await start();
  const a = await envelope(port), b = await envelope(port);
  const r = await rawClient(port);
  await r.send('session.new');
  await a.send('identify', { owner: 'agent A' });

  expect((await a.command('input.performActions', click('tabA'))).result).toEqual({});
  const refused = await b.command('browsingContext.navigate', { context: 'tabA', url: 'https://evil.example/' });
  expect(refused.error).toMatchObject({ error: 'tab leased', data: { leasedBy: 'agent A', context: 'tabA' } });
  emit('browsingContext.contextCreated', { context: 'frameA1', parent: 'tabA' });
  // A frame counts as its tab; script evaluation is refused too (it can change the page).
  expect((await b.command('script.evaluate', { expression: '1', target: { context: 'frameA1' }, awaitPromise: false })).error?.error).toBe('tab leased');
  const rawRefusal = await r.send('browsingContext.reload', { context: 'tabA' });
  expect(rawRefusal).toMatchObject({ type: 'error', error: 'tab leased' });
  expect(String(rawRefusal.message)).toContain('agent A');
  expect(sent('browsingContext.navigate')).toEqual([]);
  expect(sent('browsingContext.reload')).toEqual([]);
  // Looking is allowed: screenshots and the tree.
  expect((await b.command('browsingContext.captureScreenshot', { context: 'tabA' })).result).toEqual({});

  // Script evaluation alone takes no lease (listing tabs evaluates titles everywhere).
  expect((await b.command('script.evaluate', { expression: 'document.title', target: { context: 'tabB' }, awaitPromise: false })).result).toEqual({});
  expect((await r.send('input.performActions', click('tabB'))).type).toBe('success');
  expect((await a.command('input.performActions', click('tabB'))).error?.data.leasedBy).toBe('BiDi client 3');

  // A tab a client creates is its own at once.
  const created = (await b.command('browsingContext.create', { type: 'tab' })).result!.context as string;
  expect((await a.command('browsingContext.navigate', { context: created, url: 'https://a.example/' })).error?.error).toBe('tab leased');

  const listed = (await b.send('leases')).result!;
  expect((listed.leases as JsonObject[]).map((lease) => [lease.context, lease.owner, lease.mine])).toEqual([
    ['tabA', 'agent A', false], ['tabB', 'BiDi client 3', false], [created, 'client 2', true],
  ]);
});

test('lease with waitMs queues until the holder releases; leases end when the holder disconnects or the tab closes', async () => {
  const { port, emit } = await start();
  const a = await envelope(port), b = await envelope(port);
  expect((await a.send('lease', { context: 'tabA', owner: 'agent A' })).result).toEqual({ context: 'tabA', owner: 'agent A' });
  expect((await b.send('lease', { context: 'tabA', owner: 'agent B' })).error?.error).toBe('tab leased');

  let granted: Reply | undefined;
  void b.send('lease', { context: 'tabA', owner: 'agent B', waitMs: 5_000 }).then((reply) => { granted = reply; });
  expect((await b.send('leases')).result).toBeDefined();     // answered in order: the queued lease is still waiting
  expect(granted).toBeUndefined();
  expect((await a.send('release', { context: 'tabA' })).result).toEqual({ released: ['tabA'] });
  await until(() => granted !== undefined);
  expect(granted!.result).toEqual({ context: 'tabA', owner: 'agent B' });
  expect((await a.command('input.performActions', click('tabA'))).error?.data.leasedBy).toBe('agent B');

  // B disconnects: its lease ends, and A may act on the tab.
  b.socket.close();
  await freed(a, 'tabA');
  expect((await a.command('input.performActions', click('tabA'))).result).toEqual({});

  // A raw client's leases end with its connection too.
  const r = await rawClient(port);
  await r.send('session.new');
  expect((await r.send('input.performActions', click('tabB'))).type).toBe('success');
  expect((await a.command('input.performActions', click('tabB'))).error?.error).toBe('tab leased');
  r.socket.close();
  await freed(a, 'tabB');
  expect((await a.command('input.performActions', click('tabB'))).result).toEqual({});

  // The tab closes: its lease is gone with it.
  emit('browsingContext.contextDestroyed', { context: 'tabA' });
  expect(((await a.send('leases')).result!.leases as JsonObject[]).map((lease) => lease.context)).toEqual(['tabB']);
});

test('pause holds input from every client until resume, refuses it after its timeout, and lets reads through', async () => {
  const { port, sent } = await start();
  const agent = await envelope(port), user = await envelope(port);
  const r = await rawClient(port);
  await r.send('session.new');
  expect((await user.send('pause', { owner: 'foxpaw pause' })).result).toMatchObject({ paused: true, by: 'foxpaw pause' });

  let clicked: Reply | undefined;
  let rawClicked: JsonObject | undefined;
  void agent.command('input.performActions', click('tabA')).then((reply) => { clicked = reply; });
  void r.send('browsingContext.navigate', { context: 'tabB', url: 'https://b.example/next' }).then((reply) => { rawClicked = reply; });
  expect((await agent.command('browsingContext.getTree', {})).result).toBeDefined();          // reads pass
  const timedOut = await agent.command('script.evaluate', { expression: '1', target: { context: 'tabA' } }, 50);
  expect(timedOut.error).toMatchObject({ error: 'paused', data: { paused: true } });
  expect(clicked).toBeUndefined();
  expect(rawClicked).toBeUndefined();
  expect(sent('input.performActions')).toEqual([]);
  expect(sent('browsingContext.navigate')).toEqual([]);
  expect(sent('script.evaluate')).toEqual([]);
  expect((await agent.send('pauseState')).result).toMatchObject({ paused: true });

  expect((await user.send('resume')).result).toEqual({ paused: false });
  await until(() => clicked !== undefined && rawClicked !== undefined);
  expect(clicked!.result).toEqual({});
  expect(rawClicked!.type).toBe('success');
  expect(sent('input.performActions')).toHaveLength(1);
});

test('the page script toggles pause only on trusted presses of the hotkey', () => {
  const messages: unknown[] = [];
  const listeners = new Map<string, (event: never) => void>();
  const win = {
    top: {}, document: { readyState: 'complete' },
    addEventListener: (type: string, listener: (event: never) => void) => listeners.set(type, listener),
    removeEventListener: (type: string) => listeners.delete(type),
    setTimeout: () => 0, clearTimeout: () => {},
  } as unknown as PageWindow;
  const scope: Record<string, unknown> = {};
  const api = overlayMain((message) => messages.push(message), { label: 'agent A', color: '#2563eb', hotkey: parseHotkey('Ctrl+Alt+P'), visuals: true }, win, scope);
  expect(messages).toEqual([{ type: 'ready' }]);
  let prevented = 0;
  const press = (overrides: Record<string, unknown>) => listeners.get('keydown')!({
    isTrusted: true, repeat: false, code: 'KeyP', ctrlKey: true, altKey: true, shiftKey: false, metaKey: false,
    preventDefault: () => { prevented++; }, stopImmediatePropagation: () => {}, ...overrides,
  } as never);
  press({ isTrusted: false });                    // a page's dispatchEvent
  press({ altKey: false });
  press({ code: 'KeyO' });
  press({ repeat: true });
  expect(messages).toEqual([{ type: 'ready' }]);
  press({});
  expect(messages).toEqual([{ type: 'ready' }, { type: 'toggle' }]);
  expect(prevented).toBe(1);
  // Installing again in the same document reuses it; removing it stops listening.
  expect(overlayMain(() => {}, { label: 'x', color: '#000000', hotkey: parseHotkey('Ctrl+Alt+P'), visuals: true }, win, scope)).toBe(api);
  api.remove();
  expect(listeners.has('keydown')).toBe(false);
  expect(() => parseHotkey('P')).toThrow('needs Ctrl, Alt, or Meta');
});

test('hotkey messages on the overlay channel toggle pause from agent-controlled tabs only, and reach no client', async () => {
  const { port, emit, sent } = await start();
  const a = await envelope(port);
  await a.send('subscribe', { events: ['script.message'] });
  await a.send('lease', { context: 'tabA', owner: 'agent A' });
  const [preload] = sent('script.addPreloadScript');
  expect(preload!.params).toMatchObject({ contexts: ['tabA'], sandbox: 'foxpaw' });
  const channel = ((preload!.params.arguments as JsonObject[])[0]!.value as JsonObject).channel as string;
  const message = (context: string, type: string, onChannel = channel) => emit('script.message', {
    channel: onChannel, source: { realm: 'r1', context }, data: { type: 'object', value: [['type', { type: 'string', value: type }]] },
  });
  const paused = async () => ((await a.send('pauseState')).result!.paused);

  message('tabB', 'toggle');                     // a tab no agent controls (a stale document)
  expect(await paused()).toBe(false);
  message('tabA', 'toggle', 'someone-elses-channel');
  expect(await paused()).toBe(false);
  message('tabA', 'toggle');
  expect(await paused()).toBe(true);
  message('tabA', 'toggle');
  expect(await paused()).toBe(false);
  expect(a.events.filter((event) => (event.params as JsonObject).channel === channel)).toEqual([]);
  expect(a.events).toHaveLength(1);              // only the other channel's message

  // Releasing the tab removes its overlay and the preload script.
  await a.send('release', { context: 'tabA' });
  await until(() => sent('script.removePreloadScript').length === 1);
  message('tabA', 'toggle');
  expect(await paused()).toBe(false);
});

test('the tool reports a pause it waited out instead of hanging', async () => {
  const requests: Array<[string, JsonObject]> = [];
  const client = {
    command: async () => ({}), commandOptional: async () => ({}), onEvent: () => () => {}, subscribe: async () => {}, unsubscribe: async () => {}, close: async () => {},
    request: async (kind: string, payload: JsonObject = {}) => { requests.push([kind, payload]); return { paused: true, since: 0, by: 'hotkey in the page' }; },
  };
  const tool = createBrowserTool(z, { client, features: [pauseFeature()] });
  const failure = await tool.execute({ action: 'click', tabId: 'tab_1', selector: 'button', timeoutMs: 200 }).catch((error: Error) => JSON.parse(error.message));
  expect(failure).toMatchObject({ action: 'click', paused: true, actionPerformed: false });
  expect(failure.note).toContain('paused');
  expect(requests).toEqual([['pauseState', { waitMs: 200 }]]);
});
