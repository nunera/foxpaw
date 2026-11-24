import { firefoxBidiUrl } from './config.ts';
import { BidiClient, BidiError, BidiFeatureUnavailableError, type BidiEvent, type JsonObject } from './bidi.ts';
import { RawMux, type RawClient } from './mux.ts';

export type BrokerUpstream = Pick<BidiClient, 'command' | 'commandOptional' | 'sessionInfo' | 'subscribe' | 'unsubscribe' | 'onEvent' | 'onRawEvent' | 'onDisconnect' | 'close'>;
type SocketData = { raw: boolean; client?: RawClient };

/**
 * Requests from all clients are dispatched concurrently: BidiClient matches responses to requests by id, so a slow
 * command (a long wait) must not block others. Only session establishment is serialized, because BidiClient.connect()
 * is not safe to enter twice while the first call is still negotiating `session.new`.
 *
 * Two protocols share the one Firefox session: foxpaw's own envelope (`{id, kind, ...}`) on `/`, and plain
 * WebDriver BiDi on `/session` for clients that speak it themselves (see mux.ts).
 */
export function createBroker(bidi: BrokerUpstream, port: number) {
  const clients = new Set<{ send(data: string): unknown }>();
  const raw = new Map<RawClient, { close(code?: number, reason?: string): unknown }>();
  const mux = new RawMux(bidi);
  let idleTimer: Timer | undefined;
  let session: Promise<unknown> = Promise.resolve();

  const ensureSession = (): Promise<JsonObject> => {
    const ready = session.then(() => bidi.sessionInfo());
    session = ready.then(() => undefined, () => undefined);
    return ready;
  };
  const broadcast = (message: { kind: 'event' } & BidiEvent): void => {
    const encoded = JSON.stringify(message);
    for (const client of clients) client.send(encoded);
  };
  bidi.onEvent((event) => broadcast({ kind: 'event', ...event }));
  bidi.onRawEvent((event) => mux.event(event));
  bidi.onDisconnect(() => {
    for (const client of mux.dropAll()) { raw.get(client)?.close(1011, 'Firefox session ended'); raw.delete(client); }
  });
  const idleCheck = (): void => {
    if (clients.size === 0 && raw.size === 0) {
      idleTimer = setTimeout(async () => { await bidi.close(); server.stop(true); }, 250);
    }
  };

  const server = Bun.serve<SocketData>({
    hostname: '127.0.0.1',
    port,
    fetch(request, server) {
      if (server.upgrade(request, { data: { raw: new URL(request.url).pathname === '/session' } })) return;
      return new Response('Firefox BiDi broker requires WebSocket', { status: 426 });
    },
    websocket: {
      open(socket) {
        if (idleTimer) { clearTimeout(idleTimer); idleTimer = undefined; }
        if (socket.data.raw) {
          const client = mux.open((message) => socket.send(JSON.stringify(message)));
          socket.data.client = client;
          raw.set(client, socket);
        } else clients.add(socket);
      },
      async close(socket) {
        const client = socket.data.client;
        if (client) {
          await mux.close(client);           // before an idle shutdown can end the shared session
          raw.delete(client);
        } else clients.delete(socket);
        idleCheck();
      },
      async message(socket, data) {
        if (typeof data !== 'string') return;
        if (socket.data.client) { await mux.message(socket.data.client, data); return; }
        let request: Record<string, unknown>;
        try { request = JSON.parse(data) as Record<string, unknown>; } catch { return; }
        if (typeof request.id !== 'number' || typeof request.kind !== 'string') return;
        const respond = (message: JsonObject) => socket.send(JSON.stringify({ id: request.id, ...message }));
        try {
          const params = request.params && typeof request.params === 'object' && !Array.isArray(request.params) ? request.params as JsonObject : {};
          const timeoutMs = typeof request.timeoutMs === 'number' && Number.isFinite(request.timeoutMs) && request.timeoutMs > 0 ? request.timeoutMs : undefined;
          if (request.kind === 'sessionInfo') {
            respond({ result: await ensureSession() });
          } else if (request.kind === 'command' || request.kind === 'commandOptional') {
            if (typeof request.method !== 'string') throw new Error('Broker command requires method');
            await ensureSession();
            const result = request.kind === 'command' ? await bidi.command(request.method, params, timeoutMs) : await bidi.commandOptional(request.method, params, timeoutMs);
            respond({ result });
          } else if (request.kind === 'subscribe' || request.kind === 'unsubscribe') {
            const events = Array.isArray(request.events) && request.events.every((event) => typeof event === 'string') ? request.events : undefined;
            const contexts = Array.isArray(request.contexts) && request.contexts.every((context) => typeof context === 'string') ? request.contexts : undefined;
            if (!events) throw new Error('Broker subscription requires events');
            await ensureSession();
            if (request.kind === 'subscribe') await bidi.subscribe(events, contexts); else await bidi.unsubscribe(events, contexts);
            respond({ result: {} });
          } else throw new Error(`Unsupported broker request ${request.kind}`);
        } catch (error) {
          if (error instanceof BidiError) respond({ error: { method: error.method, error: error.error, data: error.data, unavailable: error instanceof BidiFeatureUnavailableError } });
          else respond({ error: { method: 'broker', error: error instanceof Error ? error.message : String(error), data: {} } });
        }
      },
    },
  });

  return { server, shutdown: async () => { await bidi.close(); server.stop(true); } };
}

if (import.meta.main) {
  const broker = createBroker(new BidiClient(firefoxBidiUrl()), Number(process.env.FIREFOX_BIDI_BROKER_PORT ?? '9223'));
  process.on('SIGINT', () => { void broker.shutdown(); });
  process.on('SIGTERM', () => { void broker.shutdown(); });
}
