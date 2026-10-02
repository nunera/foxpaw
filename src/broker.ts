import { firefoxBidiUrl } from './config.ts';
import { BidiClient, BidiError, BidiFeatureUnavailableError, type BidiEvent, type JsonObject } from './bidi.ts';

const port = Number(process.env.FIREFOX_BIDI_BROKER_PORT ?? '9223');
const endpoint = firefoxBidiUrl();
const bidi = new BidiClient(endpoint);
const clients = new Set<{ send(data: string): unknown }>();
let tail = Promise.resolve();
let idleTimer: Timer | undefined;

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
      const run = async () => {
        try {
          const params = request.params && typeof request.params === 'object' && !Array.isArray(request.params) ? request.params as JsonObject : {};
          const timeoutMs = typeof request.timeoutMs === 'number' && Number.isFinite(request.timeoutMs) && request.timeoutMs > 0 ? request.timeoutMs : undefined;
          if (request.kind === 'sessionInfo') {
            respond({ result: await bidi.sessionInfo() });
          } else if (request.kind === 'command' || request.kind === 'commandOptional') {
            if (typeof request.method !== 'string') throw new Error('Broker command requires method');
            const result = request.kind === 'command' ? await bidi.command(request.method, params, timeoutMs) : await bidi.commandOptional(request.method, params, timeoutMs);
            respond({ result });
          } else if (request.kind === 'subscribe' || request.kind === 'unsubscribe') {
            const events = Array.isArray(request.events) && request.events.every((event) => typeof event === 'string') ? request.events : undefined;
            const contexts = Array.isArray(request.contexts) && request.contexts.every((context) => typeof context === 'string') ? request.contexts : undefined;
            if (!events) throw new Error('Broker subscription requires events');
            if (request.kind === 'subscribe') await bidi.subscribe(events, contexts); else await bidi.unsubscribe(events, contexts);
            respond({ result: {} });
          } else throw new Error(`Unsupported broker request ${request.kind}`);
        } catch (error) {
          if (error instanceof BidiError) respond({ error: { method: error.method, error: error.error, data: error.data, unavailable: error instanceof BidiFeatureUnavailableError } });
          else respond({ error: { method: 'broker', error: error instanceof Error ? error.message : String(error), data: {} } });
        }
      };
      tail = tail.then(run, run);
      await tail;
    },
  },
});

function broadcast(message: { kind: 'event'; method: string; params: JsonObject }): void {
  const encoded = JSON.stringify(message);
  for (const client of clients) client.send(encoded);
}

process.on('SIGINT', async () => { await bidi.close(); server.stop(true); });
process.on('SIGTERM', async () => { await bidi.close(); server.stop(true); });
