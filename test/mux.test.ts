import { afterEach, expect, test } from 'bun:test';
import { createBroker, type BrokerUpstream } from '../src/broker.ts';
import type { BidiEvent, JsonObject } from '../src/bidi.ts';

/** Firefox behind the broker: records commands, hands out ids, emits events on demand. */
function fakeFirefox() {
  const calls: Array<{ method: string; params: JsonObject }> = [];
  let raw: ((event: BidiEvent) => void) | undefined;
  let lost: ((reason: Error) => void) | undefined;
  let next = 0;
  const upstream: BrokerUpstream = {
    sessionInfo: async () => ({ sessionId: 'real', capabilities: { browserName: 'firefox' } }),
    command: async (method, params = {}) => {
      calls.push({ method, params });
      if (method === 'session.subscribe') return { subscription: `sub-${++next}` };
      if (method === 'network.addIntercept') return { intercept: `int-${++next}` };
      if (method === 'script.addPreloadScript') return { script: `pre-${++next}` };
      if (method === 'browsingContext.getTree') return { contexts: [{ context: 'tabA', children: [] }, { context: 'tabB', children: [] }] };
      return {};
    },
    commandOptional: async () => ({}),
    subscribe: async () => {},
    unsubscribe: async () => {},
    onEvent: () => () => {},
    onRawEvent: (listener) => { raw = listener; return () => {}; },
    onDisconnect: (listener) => { lost = listener; return () => {}; },
    close: async () => {},
  };
  return { upstream, calls, emit: (method: string, params: JsonObject) => raw!({ method, params }), lose: () => lost!(new Error('gone')) };
}

type Raw = { socket: WebSocket; events: JsonObject[]; send(method: string, params?: JsonObject): Promise<JsonObject>; closed: Promise<void> };

async function rawClient(port: number): Promise<Raw> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/session`);
  const events: JsonObject[] = [];
  const waiting = new Map<number, (message: JsonObject) => void>();
  let id = 0;
  const closing = Promise.withResolvers<void>();
  socket.addEventListener('close', () => closing.resolve());
  socket.addEventListener('message', (message) => {
    const data = JSON.parse(String(message.data)) as JsonObject;
    if (data.type === 'event') events.push(data); else waiting.get(data.id as number)?.(data);
  });
  const opened = Promise.withResolvers<unknown>();
  socket.addEventListener('open', opened.resolve, { once: true });
  socket.addEventListener('error', opened.reject, { once: true });
  await opened.promise;
  return {
    socket, events, closed: closing.promise,
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
const brokers: Array<{ shutdown(): Promise<void> }> = [];
afterEach(async () => { for (const broker of brokers.splice(0)) await broker.shutdown(); });

function start() {
  const firefox = fakeFirefox();
  const broker = createBroker(firefox.upstream, 0);
  brokers.push(broker);
  return { ...firefox, port: broker.server.port as number };
}

const blocked = (request: string, intercept: string, context: string) =>
  ({ isBlocked: true, intercepts: [intercept], context, request: { request, url: 'https://example.com/submit?token=x', method: 'POST' } });

test('each raw connection gets its own session, and a fresh connection sees none (a released session)', async () => {
  const { port, calls } = start();
  const a = await rawClient(port), b = await rawClient(port);
  const first = await a.send('session.new', { capabilities: {} });
  const second = await b.send('session.new', { capabilities: {} });
  expect(first.type).toBe('success');
  expect((first.result as JsonObject).sessionId).not.toBe((second.result as JsonObject).sessionId);
  expect((await a.send('session.new', {})).error).toBe('session not created');
  expect(calls.some((call) => call.method === 'session.new')).toBe(false);   // the real session is never re-created
  await a.send('session.end');
  const probe = await rawClient(port);
  expect(((await probe.send('session.status')).result as JsonObject).ready).toBe(true);
  expect((await probe.send('browsingContext.getTree')).error).toBe('invalid session id');
});

test('a held request goes only to the client whose intercept holds it, with its real URL', async () => {
  const { port, emit } = start();
  const a = await rawClient(port), b = await rawClient(port);
  await a.send('session.new'); await b.send('session.new');
  await a.send('session.subscribe', { events: ['network.beforeRequestSent'], contexts: ['tabA'] });
  await b.send('session.subscribe', { events: ['network'] });            // B listens to every tab's network
  const intercept = ((await a.send('network.addIntercept', { phases: ['beforeRequestSent'], contexts: ['tabA'] })).result as JsonObject).intercept as string;
  emit('network.beforeRequestSent', blocked('r1', intercept, 'tabA'));
  // Events go out in order on each socket: once this later, unblocked one reaches B, the held one would have too.
  emit('network.responseCompleted', { context: 'tabA', isBlocked: false });
  await until(() => a.events.length === 1 && b.events.length === 1);
  expect(b.events.map((event) => event.method)).toEqual(['network.responseCompleted']);   // B would have failed r1
  expect(((a.events[0]!.params as JsonObject).request as JsonObject).url).toBe('https://example.com/submit?token=x');
  expect((await b.send('network.removeIntercept', { intercept })).error).toBe('no such intercept');
});

test('a client that disconnects without ending leaves nothing behind, and nothing let through', async () => {
  const { port, emit, calls } = start();
  const a = await rawClient(port);
  await a.send('session.new');
  await a.send('session.subscribe', { events: ['network.beforeRequestSent'], contexts: ['tabA'] });
  const intercept = ((await a.send('network.addIntercept', { phases: ['beforeRequestSent'], contexts: ['tabA'] })).result as JsonObject).intercept as string;
  const script = ((await a.send('script.addPreloadScript', { functionDeclaration: '() => {}' })).result as JsonObject).script as string;
  emit('network.beforeRequestSent', blocked('held-1', intercept, 'tabA'));
  await until(() => a.events.length === 1);
  const keep = await rawClient(port);                                     // keeps the broker from going idle
  a.socket.close();
  await until(() => calls.some((call) => call.method === 'network.removeIntercept'));
  const after = (method: string) => calls.filter((call) => call.method === method).map((call) => call.params);
  expect(after('network.failRequest')).toEqual([{ request: 'held-1' }]);
  expect(after('network.continueRequest')).toEqual([]);
  expect(after('network.removeIntercept')).toEqual([{ intercept }]);
  expect(after('script.removePreloadScript')).toEqual([{ script }]);
  expect(after('session.unsubscribe')).toEqual([{ subscriptions: [expect.stringMatching(/^sub-/)] }]);
  emit('network.beforeRequestSent', blocked('late', intercept, 'tabA'));  // already in flight when it was removed
  await until(() => after('network.failRequest').length === 2);
  keep.socket.close();
});

test('events reach a client through its own subscriptions, frames counted as their tab', async () => {
  const { port, emit } = start();
  const a = await rawClient(port), b = await rawClient(port);
  await a.send('session.new'); await b.send('session.new');
  await a.send('session.subscribe', { events: ['browsingContext.load', 'log.entryAdded'], contexts: ['tabA'] });
  await b.send('session.subscribe', { events: ['browsingContext.load'], contexts: ['tabB'] });
  emit('browsingContext.contextCreated', { context: 'frameA1', parent: 'tabA' });
  emit('browsingContext.load', { context: 'frameA1' });
  emit('log.entryAdded', { source: { context: 'tabB' }, text: 'not for A' });
  emit('browsingContext.load', { context: 'tabB' });
  emit('log.entryAdded', { source: { context: 'tabA' }, text: 'last' });   // in order: anything A got wrongly came before
  await until(() => a.events.length >= 2 && b.events.length >= 1);
  a.events.pop();
  expect(a.events.map((event) => [event.method, (event.params as JsonObject).context])).toEqual([['browsingContext.load', 'frameA1']]);
  expect(b.events.map((event) => [event.method, (event.params as JsonObject).context])).toEqual([['browsingContext.load', 'tabB']]);
});

test('losing Firefox disconnects every raw client', async () => {
  const { port, lose } = start();
  const a = await rawClient(port);
  await a.send('session.new');
  lose();
  await a.closed;
});
