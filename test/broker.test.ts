import { expect, test } from 'bun:test';
import { request } from 'node:http';
import { WebSocket } from 'ws';
import { createBroker, type BrokerUpstream } from '../src/broker.ts';
import { BrowserUnavailableError, type BidiEvent, type JsonObject } from '../src/bidi.ts';

const TOKEN = 'test-token';

function connect(port: number, options: { path?: string; headers?: Record<string, string> } = {}): Promise<{ socket: WebSocket; messages: Array<Record<string, unknown>> }> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${options.path ?? `/?token=${TOKEN}`}`, { headers: options.headers });
  const messages: Array<Record<string, unknown>> = [];
  socket.on('message', (data) => messages.push(JSON.parse(data.toString())));
  const opened = Promise.withResolvers<{ socket: WebSocket; messages: Array<Record<string, unknown>> }>();
  socket.once('open', () => opened.resolve({ socket, messages }));
  socket.once('error', () => opened.reject(new Error('connect failed')));
  return opened.promise;
}
/** GET over node:http, which (unlike fetch) lets a test send any Host header. */
function get(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  const done = Promise.withResolvers<{ status: number; body: string }>();
  const req = request({ host: '127.0.0.1', port, path, headers }, (response) => {
    let body = '';
    response.on('data', (chunk) => { body += chunk; });
    response.on('end', () => done.resolve({ status: response.statusCode ?? 0, body }));
  });
  req.on('error', done.reject);
  req.end();
  return done.promise;
}
const until = async (predicate: () => boolean) => { for (let i = 0; i < 200 && !predicate(); i++) await new Promise((resolve) => setTimeout(resolve, 5)); expect(predicate()).toBe(true); };

const upstreamWith = (overrides: Partial<BrokerUpstream>): BrokerUpstream => ({
  sessionInfo: async () => ({}),
  command: async () => ({}),
  commandOptional: async () => ({}),
  subscribe: async () => {},
  unsubscribe: async () => {},
  onEvent: () => () => {},
  onRawEvent: () => () => {},
  onDisconnect: () => () => {},
  close: async () => {},
  ...overrides,
});

test('dispatches client requests concurrently and routes responses to the issuing client', async () => {
  const inFlight = new Map<string, PromiseWithResolvers<JsonObject>>();
  let listener: ((event: BidiEvent) => void) | undefined;
  let sessionCalls = 0;
  const broker = await createBroker(upstreamWith({
    sessionInfo: async () => { sessionCalls++; return {}; },
    command: (method) => { const deferred = Promise.withResolvers<JsonObject>(); inFlight.set(method, deferred); return deferred.promise; },
    onEvent: (next) => { listener = next; return () => {}; },
  }), 0, { token: TOKEN });
  try {
    const a = await connect(broker.port);
    const b = await connect(broker.port);
    a.socket.send(JSON.stringify({ id: 1, kind: 'command', method: 'slow.wait', params: {} }));
    b.socket.send(JSON.stringify({ id: 1, kind: 'command', method: 'fast.call', params: {} }));
    // Both upstream commands are pending at the same time: the second did not wait for the first.
    await until(() => inFlight.size === 2);
    inFlight.get('fast.call')!.resolve({ from: 'fast' });
    await until(() => b.messages.length === 1);
    expect(b.messages[0]).toEqual({ id: 1, result: { from: 'fast' } });
    expect(a.messages).toEqual([]);
    inFlight.get('slow.wait')!.resolve({ from: 'slow' });
    await until(() => a.messages.length === 1);
    expect(a.messages[0]).toEqual({ id: 1, result: { from: 'slow' } });
    expect(sessionCalls).toBe(2);

    listener?.({ method: 'browsingContext.load', params: {} });
    await until(() => a.messages.length === 2 && b.messages.length === 2);
    expect(a.messages[1]).toMatchObject({ kind: 'event', method: 'browsingContext.load' });
    a.socket.close(); b.socket.close();
  } finally {
    await broker.shutdown();
  }
});

test('refuses web pages, DNS rebinding, and clients without the token', async () => {
  const broker = await createBroker(upstreamWith({}), 0, { token: TOKEN });
  try {
    // What a page on any site sends when its script opens ws://127.0.0.1:9223.
    await expect(connect(broker.port, { headers: { Origin: 'https://evil.example' } })).rejects.toThrow('connect failed');
    await expect(connect(broker.port, { path: `/session?token=${TOKEN}`, headers: { Origin: 'null' } })).rejects.toThrow('connect failed');
    // A rebinding page reaches 127.0.0.1 under its own host name.
    await expect(connect(broker.port, { headers: { Host: `evil.example:${broker.port}` } })).rejects.toThrow('connect failed');
    expect((await get(broker.port, '/health', { Host: 'evil.example' })).status).toBe(403);
    // Another program (or user) on this machine without the token.
    await expect(connect(broker.port, { path: '/session' })).rejects.toThrow('connect failed');
    await expect(connect(broker.port, { path: '/?token=wrong' })).rejects.toThrow('connect failed');

    const viaHeader = await connect(broker.port, { path: '/session', headers: { Authorization: `Bearer ${TOKEN}` } });
    viaHeader.socket.close();
    expect(await get(broker.port, '/health')).toEqual({ status: 200, body: '{"foxpaw":"broker"}' });
  } finally {
    await broker.shutdown();
  }
});

test('refuses new connections once it starts shutting down, so clients start a fresh broker', async () => {
  const closing = Promise.withResolvers<void>();
  const closeCalled = Promise.withResolvers<void>();
  const broker = await createBroker(upstreamWith({ close: () => { closeCalled.resolve(); return closing.promise; } }), 0, { token: TOKEN });
  expect((await get(broker.port, '/health')).status).toBe(200);
  const client = await connect(broker.port);
  client.socket.close();
  await closeCalled.promise;                    // the last client left: the idle shutdown is ending the session
  expect((await get(broker.port, '/health')).status).toBe(503);
  await expect(connect(broker.port)).rejects.toThrow('connect failed');
  closing.resolve();
  await broker.closed;
});

test('launches a browser once when none is listening, then retries the session', async () => {
  let launches = 0;
  let available = false;
  const launch = async () => { launches++; available = true; };
  const broker = await createBroker(upstreamWith({
    sessionInfo: async () => { if (!available) throw new BrowserUnavailableError('ws://127.0.0.1:9/session'); return { capabilities: { browserName: 'firefox' } }; },
  }), 0, { token: TOKEN, launch });
  try {
    const a = await connect(broker.port);
    a.socket.send(JSON.stringify({ id: 1, kind: 'sessionInfo' }));
    a.socket.send(JSON.stringify({ id: 2, kind: 'sessionInfo' }));
    await until(() => a.messages.length === 2);
    expect(a.messages.map((message) => message.result)).toEqual([{ capabilities: { browserName: 'firefox' } }, { capabilities: { browserName: 'firefox' } }]);
    expect(launches).toBe(1);
    a.socket.close();
  } finally {
    await broker.shutdown();
  }
});
