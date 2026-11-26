import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { firefoxBidiBrokerUrl, firefoxBidiUrl } from './config.ts';
import { BidiClient, BidiError, BidiFeatureUnavailableError, BrowserUnavailableError, type BidiEvent, type JsonObject } from './bidi.ts';
import { launchBrowser } from './launch.ts';
import { refuseRequest } from './loopback.ts';
import { DEFAULT_HOLD_MS, Holder, HumanGate } from './human/gate.ts';
import { Overlays } from './human/overlay.ts';
import { loadHumanLoopSettings, parseHotkey, DEFAULT_HOTKEY, type HumanLoopSettings } from './human/settings.ts';
import { ContextTree, RawMux, type RawClient } from './mux.ts';
import { newToken, saveBrokerToken } from './token.ts';

export type BrokerUpstream = Pick<BidiClient, 'command' | 'commandOptional' | 'sessionInfo' | 'subscribe' | 'unsubscribe' | 'onEvent' | 'onRawEvent' | 'onDisconnect' | 'close'>;
export type BrokerOptions = {
  /** Every WebSocket handshake must carry it (`?token=` or `Authorization: Bearer`). */
  token: string;
  /** Starts a browser when none is listening; the session is then retried once. */
  launch?: () => Promise<unknown>;
  /** Exit when no client has connected this long after start (a broker spawned for a client that never came). */
  startupGraceMs?: number;
  /** The `humanLoop` settings (pause hotkey, overlays); defaults when omitted. */
  humanLoop?: HumanLoopSettings;
};
export type Broker = { port: number; shutdown(): Promise<void>; closed: Promise<void> };

/** Body of `GET /health`; `foxpaw ensure` checks it to tell the broker from some other program on the port. */
export const BROKER_HEALTH = { foxpaw: 'broker' } as const;

/**
 * Requests from all clients are dispatched concurrently: BidiClient matches responses to requests by id, so a slow
 * command (a long wait) must not block others. Only session establishment is serialized, because BidiClient.connect()
 * is not safe to enter twice while the first call is still negotiating `session.new`.
 *
 * Two protocols share the one Firefox session: foxpaw's own envelope (`{id, kind, ...}`) on `/`, and plain
 * WebDriver BiDi on `/session` for clients that speak it themselves (see mux.ts).
 *
 * Every request passes refuseRequest (no web-page Origin, loopback Host, the token on WebSocket handshakes).
 * Once the last client leaves, the broker ends the Firefox session and exits. From that moment it refuses new
 * connections and health checks (503), so a client never lands on a broker that is about to stop: it starts a new one.
 *
 * Every client command from either protocol passes the human loop (src/human): tab leases and the user's pause.
 * Envelope kinds beyond BiDi: identify, lease, release, leases, pause, resume, pauseState (docs/human-loop.md).
 */
export async function createBroker(bidi: BrokerUpstream, port: number, options: BrokerOptions): Promise<Broker> {
  const clients = new Map<WebSocket, Holder>();
  const raw = new Map<RawClient, { ws: WebSocket; holder: Holder }>();
  let nextHolder = 1;
  let idleTimer: NodeJS.Timeout | undefined;
  let closing = false;
  let session: Promise<unknown> = Promise.resolve();
  let launching: Promise<unknown> | undefined;
  const closed = Promise.withResolvers<void>();

  const sessionInfo = async (): Promise<JsonObject> => {
    try {
      return await bidi.sessionInfo();
    } catch (error) {
      if (!(error instanceof BrowserUnavailableError) || !options.launch) throw error;
      await (launching ??= options.launch().finally(() => { launching = undefined; }));
      return await bidi.sessionInfo();
    }
  };
  const tree = new ContextTree({ command: (method, params, timeoutMs) => bidi.command(method, params, timeoutMs) });
  const overlays = new Overlays(bidi, options.humanLoop ?? { hotkey: parseHotkey(DEFAULT_HOTKEY), overlay: true }, (context) => tree.tab(context));
  const gate = new HumanGate(tree, {
    leased: (tab, holder) => overlays.install(tab, holder),
    released: (tab, _holder, closedTab) => overlays.remove(tab, closedTab),
    pauseChanged: () => overlays.refresh(),
    pointer: (tab, points) => overlays.pointer(tab, points),
  });
  overlays.gate = gate;
  const mux = new RawMux({
    command: (method, params, timeoutMs) => bidi.command(method, params, timeoutMs),
    sessionInfo,
    forward: (client, method, params, timeoutMs) => gate.command(raw.get(client)!.holder, method, params, timeoutMs, (left) => bidi.command(method, params, left)),
    ended: (client) => { const entry = raw.get(client); if (entry) gate.release(entry.holder); },
  }, undefined, tree);
  const ensureSession = (): Promise<JsonObject> => {
    const ready = session.then(sessionInfo);
    session = ready.then(() => undefined, () => undefined);
    return ready;
  };
  const broadcast = (message: { kind: 'event' } & BidiEvent): void => {
    const encoded = JSON.stringify(message);
    for (const client of clients.keys()) client.send(encoded);
  };
  const ownMessage = (event: BidiEvent) => event.method === 'script.message' && event.params.channel === overlays.channel;
  bidi.onEvent((event) => { if (!ownMessage(event)) broadcast({ kind: 'event', ...event }); });
  bidi.onRawEvent((event) => {
    if (overlays.message(event)) return;
    mux.event(event);
    if (event.method === 'browsingContext.contextDestroyed' && typeof event.params.context === 'string') gate.closed(event.params.context);
  });
  bidi.onDisconnect(() => {
    gate.reset();
    for (const client of mux.dropAll()) { raw.get(client)?.ws.close(1011, 'Firefox session ended'); raw.delete(client); }
  });

  const http = createServer((request: IncomingMessage, response: ServerResponse) => {
    const refusal = refuseRequest(request.headers, request.url ?? '/');
    if (refusal) { response.writeHead(403).end(refusal); return; }
    if (closing) { response.writeHead(503).end('foxpaw broker is shutting down'); return; }
    if (new URL(request.url ?? '/', 'http://127.0.0.1').pathname === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(BROKER_HEALTH));
      return;
    }
    response.writeHead(426).end('Firefox BiDi broker requires WebSocket');
  });
  const wss = new WebSocketServer({ noServer: true });
  http.on('upgrade', (request, socket, head) => {
    const refusal = closing ? 'foxpaw broker is shutting down' : refuseRequest(request.headers, request.url ?? '/', options.token);
    if (refusal) {
      socket.end(`HTTP/1.1 ${closing ? '503 Service Unavailable' : '403 Forbidden'}\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(refusal)}\r\n\r\n${refusal}`);
      return;
    }
    const isRaw = new URL(request.url ?? '/', 'http://127.0.0.1').pathname === '/session';
    wss.handleUpgrade(request, socket, head, (ws) => accept(ws, isRaw));
  });

  const shutdown = async (): Promise<void> => {
    if (closing) return await closed.promise;
    closing = true;
    clearTimeout(idleTimer);
    await bidi.close();
    for (const ws of wss.clients) ws.terminate();
    http.close(() => closed.resolve());
    http.closeAllConnections();
    await closed.promise;
  };
  const armIdle = (delayMs: number): void => {
    clearTimeout(idleTimer);
    if (clients.size === 0 && raw.size === 0) idleTimer = setTimeout(() => { void shutdown(); }, delayMs);
  };

  const accept = (ws: WebSocket, isRaw: boolean): void => {
    clearTimeout(idleTimer);
    idleTimer = undefined;
    let client: RawClient | undefined;
    const id = nextHolder++;
    const holder = new Holder(id, isRaw ? `BiDi client ${id}` : `client ${id}`);
    if (isRaw) {
      client = mux.open((message) => ws.send(JSON.stringify(message)));
      raw.set(client, { ws, holder });
    } else clients.set(ws, holder);
    ws.on('close', async () => {
      gate.drop(holder);
      if (client) {
        await mux.close(client);           // before an idle shutdown can end the shared session
        raw.delete(client);
      } else clients.delete(ws);
      if (!closing) armIdle(250);
    });
    ws.on('message', async (data, isBinary) => {
      if (isBinary) return;
      const text = data.toString();
      if (client) { await mux.message(client, text); return; }
      await envelope(ws, holder, text);
    });
  };

  const envelope = async (ws: WebSocket, holder: Holder, data: string): Promise<void> => {
    let request: Record<string, unknown>;
    try { request = JSON.parse(data) as Record<string, unknown>; } catch { return; }
    if (typeof request.id !== 'number' || typeof request.kind !== 'string') return;
    const respond = (message: JsonObject) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ id: request.id, ...message })); };
    try {
      const params = request.params && typeof request.params === 'object' && !Array.isArray(request.params) ? request.params as JsonObject : {};
      const timeoutMs = typeof request.timeoutMs === 'number' && Number.isFinite(request.timeoutMs) && request.timeoutMs > 0 ? request.timeoutMs : undefined;
      if (request.kind === 'sessionInfo') {
        respond({ result: await ensureSession() });
      } else if (request.kind === 'command' || request.kind === 'commandOptional') {
        if (typeof request.method !== 'string') throw new Error('Broker command requires method');
        const method = request.method;
        await ensureSession();
        const result = await gate.command(holder, method, params, timeoutMs, (left) => request.kind === 'command' ? bidi.command(method, params, left) : bidi.commandOptional(method, params, left));
        respond({ result });
      } else if (request.kind === 'subscribe' || request.kind === 'unsubscribe') {
        const events = Array.isArray(request.events) && request.events.every((event) => typeof event === 'string') ? request.events : undefined;
        const contexts = Array.isArray(request.contexts) && request.contexts.every((context) => typeof context === 'string') ? request.contexts : undefined;
        if (!events) throw new Error('Broker subscription requires events');
        await ensureSession();
        if (request.kind === 'subscribe') await bidi.subscribe(events, contexts); else await bidi.unsubscribe(events, contexts);
        respond({ result: {} });
      } else respond({ result: await humanLoop(holder, request.kind, request) });
    } catch (error) {
      if (error instanceof BidiError) respond({ error: { method: error.method, error: error.error, data: error.data, unavailable: error instanceof BidiFeatureUnavailableError } });
      else respond({ error: { method: 'broker', error: error instanceof Error ? error.message : String(error), data: {} } });
    }
  };

  /** The human-loop envelope kinds (docs/human-loop.md). */
  const humanLoop = async (holder: Holder, kind: string, request: Record<string, unknown>): Promise<JsonObject> => {
    const owner = typeof request.owner === 'string' && request.owner.trim() ? request.owner.trim().slice(0, 60) : undefined;
    const color = typeof request.color === 'string' && /^#[0-9a-f]{6}$/i.test(request.color) ? request.color : undefined;
    const waitMs = typeof request.waitMs === 'number' && Number.isFinite(request.waitMs) && request.waitMs > 0 ? Math.min(request.waitMs, 3_600_000) : 0;
    const leaseList = () => gate.leases().map((lease) => ({ context: lease.tab, owner: lease.holder.label, color: lease.holder.color, since: lease.since, mine: lease.holder === holder }));
    switch (kind) {
      case 'identify':
        if (owner) { holder.rename(owner, color); overlays.refresh(); }
        return { owner: holder.label, color: holder.color };
      case 'lease': {
        if (typeof request.context !== 'string') throw new Error('lease requires context');
        if (owner) { holder.rename(owner, color); overlays.refresh(); }
        await ensureSession();
        const lease = await gate.lease(holder, request.context, waitMs);
        return { context: lease.tab, owner: lease.holder.label };
      }
      case 'release':
        return { released: gate.release(holder, typeof request.context === 'string' ? request.context : undefined) };
      case 'leases': return { leases: leaseList(), pause: gate.pauseState };
      case 'pause': return gate.pause(owner ?? holder.label);
      case 'resume': return gate.resume();
      case 'pauseState': return await gate.waitForResume(Math.min(waitMs, DEFAULT_HOLD_MS * 6));
      default: throw new Error(`Unsupported broker request ${kind}`);
    }
  };

  const listening = Promise.withResolvers<void>();
  http.once('error', listening.reject);
  http.listen(port, '127.0.0.1', () => listening.resolve());
  await listening.promise;
  if (options.startupGraceMs !== undefined) armIdle(options.startupGraceMs);
  return { port: (http.address() as AddressInfo).port, shutdown, closed: closed.promise };
}

/**
 * Run the broker in this process until its last client leaves. Its token is saved for its port (see token.ts) only
 * once it owns the port, so a second broker that fails to bind never replaces a running broker's token.
 * FIREFOX_BIDI_AUTO_LAUNCH=1 starts a browser on demand.
 */
export async function runBroker(env: Record<string, string | undefined> = process.env): Promise<Broker> {
  const port = Number(env.FIREFOX_BIDI_BROKER_PORT ?? (new URL(firefoxBidiBrokerUrl(env)).port || '9223'));
  const token = newToken();
  const broker = await createBroker(new BidiClient(firefoxBidiUrl(env)), port, {
    token,
    startupGraceMs: 60_000,
    humanLoop: humanLoopSettings(env),
    ...(env.FIREFOX_BIDI_AUTO_LAUNCH === '1' ? { launch: () => launchBrowser({ env }) } : {}),
  });
  saveBrokerToken(broker.port, token, env);      // before any connection is processed: this runs in the same tick
  process.on('SIGINT', () => { void broker.shutdown(); });
  process.on('SIGTERM', () => { void broker.shutdown(); });
  void broker.closed.then(() => process.exit(0));
  return broker;
}

/** An invalid `humanLoop` key must not keep the broker (and every agent) from starting: it falls back to defaults. */
function humanLoopSettings(env: Record<string, string | undefined>): HumanLoopSettings {
  try { return loadHumanLoopSettings(env); } catch (error) {
    console.error(`foxpaw broker: ignoring the humanLoop settings: ${error instanceof Error ? error.message : String(error)}`);
    return { hotkey: parseHotkey(DEFAULT_HOTKEY), overlay: true };
  }
}
