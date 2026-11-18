import { expect, test } from 'bun:test';
import { createBroker, type BrokerUpstream } from '../src/broker.ts';
import type { BidiEvent, JsonObject } from '../src/bidi.ts';

function connect(port: number): Promise<{ socket: WebSocket; messages: Array<Record<string, unknown>> }> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  const messages: Array<Record<string, unknown>> = [];
  socket.addEventListener('message', (message) => messages.push(JSON.parse(String(message.data))));
  return new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve({ socket, messages }), { once: true });
    socket.addEventListener('error', () => reject(new Error('connect failed')), { once: true });
  });
}
const until = async (predicate: () => boolean) => { for (let i = 0; i < 200 && !predicate(); i++) await Bun.sleep(5); expect(predicate()).toBe(true); };

test('dispatches client requests concurrently and routes responses to the issuing client', async () => {
  const inFlight = new Map<string, PromiseWithResolvers<JsonObject>>();
  let listener: ((event: BidiEvent) => void) | undefined;
  let sessionCalls = 0;
  const upstream: BrokerUpstream = {
    sessionInfo: async () => { sessionCalls++; return {}; },
    command: (method) => { const deferred = Promise.withResolvers<JsonObject>(); inFlight.set(method, deferred); return deferred.promise; },
    commandOptional: async () => ({}),
    subscribe: async () => {},
    unsubscribe: async () => {},
    onEvent: (next) => { listener = next; return () => {}; },
    close: async () => {},
  };
  const broker = createBroker(upstream, 0);
  try {
    const port = broker.server.port as number;
    const a = await connect(port);
    const b = await connect(port);
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
