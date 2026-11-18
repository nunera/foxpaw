import { firefoxBidiUrl } from './config.ts';
import { BidiClient, BidiError, BidiFeatureUnavailableError, type BidiEvent, type JsonObject } from './bidi.ts';

export type BrokerUpstream = Pick<BidiClient, 'command' | 'commandOptional' | 'sessionInfo' | 'subscribe' | 'unsubscribe' | 'onEvent' | 'close'>;

/**
 * Requests from all clients are dispatched concurrently: BidiClient matches responses to requests by id, so a slow
 * command (a long wait) must not block others. Only session establishment is serialized, because BidiClient.connect()
 * is not safe to enter twice while the first call is still negotiating `session.new`.
 */
export function createBroker(bidi: BrokerUpstream, port: number) {
  const clients = new Set<{ send(data: string): unknown }>();
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

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port,
    fetch(request, server) {
      if (server.upgrade(request)) return;
      return new Response('Firefox BiDi broker requires WebSocket', { status: 426 });
    },
    websocket: {
      open(socket) { clients.add(socket); if (idleTimer) { clearTimeout(idleTimer); idleTimer = undefined; } },
      close(socket) {
        clients.delete(socket);
        if (clients.size === 0) {
          idleTimer = setTimeout(async () => { await bidi.close(); server.stop(true); }, 250);
        }
      },
      async message(socket, raw) {
        if (typeof raw !== 'string') return;
        let request: Record<string, unknown>;
        try { request = JSON.parse(raw) as Record<string, unknown>; } catch { return; }
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
