import { BidiError, type BidiEvent, type JsonObject } from './bidi.ts';

/**
 * Raw WebDriver BiDi over the broker's one Firefox session.
 *
 * A client that speaks plain BiDi (ws://127.0.0.1:9223/session) gets a virtual session of its own: `session.new`
 * and `session.end` are answered here, and `session.status` reports this client's view (ready unless it holds a
 * session). Everything else runs on the shared session, with ownership kept per client:
 *
 * - Events reach a client only through its own subscriptions (event names, and the top-level tabs it named).
 * - A request held by a network intercept goes only to the client that added that intercept. Clients that fail
 *   closed on requests they do not own (a submit guard) would otherwise answer each other's requests.
 * - When a client ends its session or disconnects, its held requests are failed (closed, never let through), and
 *   its intercepts, preload scripts and subscriptions are removed. A request an intercept of a departed client
 *   still holds is failed by the broker.
 */
export type MuxUpstream = {
  command(method: string, params?: JsonObject, timeoutMs?: number): Promise<JsonObject>;
  sessionInfo(): Promise<JsonObject>;
  /** A client's own command, as opposed to the mux's bookkeeping. The broker passes it through tab leases and pause. */
  forward?(client: RawClient, method: string, params: JsonObject, timeoutMs: number): Promise<JsonObject>;
  /** The client's virtual session ended (session.end or disconnect): the broker releases its tab leases. */
  ended?(client: RawClient): void;
};

const COMMAND_TIMEOUT_MS = 10 * 60_000;     // clients keep their own deadlines; navigation waits can be long
// How the broker answers a held request nobody will answer anymore: closed.
const RELEASE: Record<string, [string, JsonObject]> = {
  'network.beforeRequestSent': ['network.failRequest', {}],
  'network.responseStarted': ['network.failRequest', {}],
  'network.authRequired': ['network.continueWithAuth', { action: 'cancel' }],
};
// Commands that answer a held request.
const ANSWERS: Record<string, true> = {
  'network.continueRequest': true, 'network.failRequest': true, 'network.continueResponse': true,
  'network.provideResponse': true, 'network.continueWithAuth': true,
};

type Subscription = { events: string[]; contexts?: Set<string> };

export class RawClient {
  session?: string;
  readonly subscriptions = new Map<string, Subscription>();
  readonly intercepts = new Set<string>();
  readonly preloads = new Set<string>();
  readonly held = new Map<string, string>();   // request id -> the event that holds it
  constructor(readonly send: (message: JsonObject) => void) {}
}

const refused = (error: string, message: string) => new BidiError('broker', error, { message });
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

/** Which frames belong to which tab, shared by the mux (event routing) and the broker (tab leases). */
export class ContextTree {
  #parents = new Map<string, string | undefined>(); // browsing context -> parent (frames to their tab)
  #tracking?: Promise<void>;

  constructor(private readonly upstream: Pick<MuxUpstream, 'command'>) {}

  /** Learn the contexts that exist now, then each one created (the events arrive through `event`). */
  track(): Promise<void> {
    this.#tracking ??= (async () => {
      await this.upstream.command('session.subscribe', { events: ['browsingContext.contextCreated', 'browsingContext.contextDestroyed'] });
      const tree = await this.upstream.command('browsingContext.getTree', {});
      const walk = (nodes: unknown, parent?: string): void => {
        for (const node of Array.isArray(nodes) ? nodes as JsonObject[] : []) {
          if (typeof node.context !== 'string') continue;
          this.#parents.set(node.context, parent);
          walk(node.children, node.context);
        }
      };
      walk(tree.contexts);
    })().catch((error: unknown) => { this.#tracking = undefined; throw error; });
    return this.#tracking;
  }

  created(context: string, parent: string | undefined): void { this.#parents.set(context, parent); }
  destroyed(context: string): void { this.#parents.delete(context); }
  has(context: string): boolean { return this.#parents.has(context); }

  /** The top-level context (tab) a context belongs to; an unknown context counts as a tab of its own. */
  tab(context: string): string;
  tab(context: string | undefined): string | undefined;
  tab(context: string | undefined): string | undefined {
    let current = context;
    for (let depth = 0; current !== undefined && depth < 64; depth++) {
      const parent = this.#parents.get(current);
      if (parent === undefined) return current;
      current = parent;
    }
    return current;
  }

  clear(): void { this.#parents.clear(); this.#tracking = undefined; }
}

export class RawMux {
  readonly clients = new Set<RawClient>();
  #owners = new Map<string, RawClient>();          // intercept id -> its client
  #retired = new Set<string>();                    // intercepts of departed clients

  constructor(private readonly upstream: MuxUpstream, private readonly timeoutMs = COMMAND_TIMEOUT_MS, readonly tree = new ContextTree(upstream)) {}

  open(send: (message: JsonObject) => void): RawClient {
    const client = new RawClient(send);
    this.clients.add(client);
    return client;
  }

  async close(client: RawClient): Promise<void> {
    this.clients.delete(client);
    await this.#release(client);
  }

  /** The Firefox session is gone, and every virtual session with it: returns the clients to disconnect. */
  dropAll(): RawClient[] {
    const clients = [...this.clients];
    this.clients.clear(); this.#owners.clear(); this.#retired.clear(); this.tree.clear();
    return clients;
  }

  async message(client: RawClient, raw: string): Promise<void> {
    let request: JsonObject;
    try { request = JSON.parse(raw) as JsonObject; } catch { return; }
    const { id, method } = request;
    if (typeof id !== 'number' || typeof method !== 'string') {
      client.send({ type: 'error', id: typeof id === 'number' ? id : null, error: 'invalid argument', message: 'a command needs a numeric id and a method' });
      return;
    }
    const params = request.params && typeof request.params === 'object' && !Array.isArray(request.params) ? request.params as JsonObject : {};
    try {
      client.send({ type: 'success', id, result: await this.#handle(client, method, params) });
    } catch (error) {
      if (error instanceof BidiError) client.send({ type: 'error', id, error: error.error, message: String(error.data.message ?? error.message) });
      else client.send({ type: 'error', id, error: 'unknown error', message: error instanceof Error ? error.message : String(error) });
    }
  }

  event({ method, params }: BidiEvent): void {
    const context = typeof params.context === 'string' ? params.context : undefined;
    if (method === 'browsingContext.contextCreated' && context) this.tree.created(context, typeof params.parent === 'string' ? params.parent : undefined);
    if (params.isBlocked === true && Array.isArray(params.intercepts)) this.#blocked(method, params);
    else {
      const source = params.source && typeof params.source === 'object' ? (params.source as JsonObject).context : undefined;
      const tab = this.tree.tab(context ?? (typeof source === 'string' ? source : undefined));
      for (const client of this.clients) {
        if (client.session && this.#wants(client, method, tab)) client.send({ type: 'event', method, params });
      }
    }
    if (method === 'browsingContext.contextDestroyed' && context) this.tree.destroyed(context);
  }

  async #handle(client: RawClient, method: string, params: JsonObject): Promise<JsonObject> {
    if (method === 'session.status') {
      return client.session ? { ready: false, message: 'this connection already has a session' } : { ready: true, message: '' };
    }
    if (method === 'session.new') {
      if (client.session) throw refused('session not created', 'Maximum number of active sessions');
      const info = await this.upstream.sessionInfo();
      await this.tree.track();
      client.session = crypto.randomUUID();
      return { sessionId: client.session, capabilities: (info.capabilities as JsonObject | undefined) ?? {} };
    }
    if (!client.session) throw refused('invalid session id', 'no session on this connection: send session.new first');
    switch (method) {
      case 'session.end':
        await this.#release(client);
        client.session = undefined;
        return {};
      case 'session.subscribe': {
        const result = await this.#forward(client, method, params);
        if (typeof result.subscription === 'string') {
          client.subscriptions.set(result.subscription, {
            events: strings(params.events), contexts: Array.isArray(params.contexts) ? new Set(strings(params.contexts)) : undefined });
        }
        return result;
      }
      case 'session.unsubscribe': {
        const ids = Array.isArray(params.subscriptions) ? strings(params.subscriptions) : this.#matching(client, params);
        if (!ids.length || ids.some((id) => !client.subscriptions.has(id))) throw refused('invalid argument', 'no such subscription on this connection');
        await this.#forward(client, method, { subscriptions: ids });
        for (const id of ids) client.subscriptions.delete(id);
        return {};
      }
      case 'network.addIntercept': {
        const result = await this.#forward(client, method, params);
        if (typeof result.intercept === 'string') { client.intercepts.add(result.intercept); this.#owners.set(result.intercept, client); }
        return result;
      }
      case 'network.removeIntercept': {
        const intercept = String(params.intercept);
        if (!client.intercepts.has(intercept)) throw refused('no such intercept', 'this connection did not add that intercept');
        const result = await this.#forward(client, method, params);
        client.intercepts.delete(intercept); this.#owners.delete(intercept);
        return result;
      }
      case 'script.addPreloadScript': {
        const result = await this.#forward(client, method, params);
        if (typeof result.script === 'string') client.preloads.add(result.script);
        return result;
      }
      case 'script.removePreloadScript': {
        const result = await this.#forward(client, method, params);
        client.preloads.delete(String(params.script));
        return result;
      }
    }
    if (ANSWERS[method] && typeof params.request === 'string') client.held.delete(params.request);
    return await this.#forward(client, method, params);
  }

  #forward(client: RawClient, method: string, params: JsonObject): Promise<JsonObject> {
    return this.upstream.forward ? this.upstream.forward(client, method, params, this.timeoutMs) : this.upstream.command(method, params, this.timeoutMs);
  }

  /** The old by-events unsubscribe, limited to this client's own subscriptions. */
  #matching(client: RawClient, params: JsonObject): string[] {
    const events = new Set(strings(params.events));
    const contexts = Array.isArray(params.contexts) ? new Set(strings(params.contexts)) : undefined;
    return [...client.subscriptions].filter(([, sub]) => sub.events.some((name) => events.has(name)) &&
      (!contexts || (sub.contexts !== undefined && [...sub.contexts].some((context) => contexts.has(context))))).map(([id]) => id);
  }

  #blocked(method: string, params: JsonObject): void {
    const request = (params.request as JsonObject | undefined)?.request;
    if (typeof request !== 'string') return;
    const intercepts = strings(params.intercepts);
    const owner = intercepts.map((id) => this.#owners.get(id)).find((client) => client?.session);
    if (owner) {
      owner.held.set(request, method);
      owner.send({ type: 'event', method, params });
    } else if (intercepts.some((id) => this.#retired.has(id))) {
      void this.#answer(request, method);       // its client is gone: fail it rather than hold it forever
    }
  }

  #answer(request: string, phase: string): Promise<unknown> {
    const [method, extra] = RELEASE[phase] ?? RELEASE['network.beforeRequestSent']!;
    return this.upstream.command(method, { request, ...extra }).catch(() => undefined);
  }

  async #release(client: RawClient): Promise<void> {
    this.upstream.ended?.(client);
    for (const id of client.intercepts) { this.#owners.delete(id); this.#retired.add(id); }
    await Promise.allSettled([...client.held].map(([request, phase]) => this.#answer(request, phase)));
    await Promise.allSettled([
      ...[...client.intercepts].map((intercept) => this.upstream.command('network.removeIntercept', { intercept })),
      ...[...client.preloads].map((script) => this.upstream.command('script.removePreloadScript', { script })),
      ...(client.subscriptions.size ? [this.upstream.command('session.unsubscribe', { subscriptions: [...client.subscriptions.keys()] })] : []),
    ]);
    client.held.clear(); client.intercepts.clear(); client.preloads.clear(); client.subscriptions.clear();
  }

  #wants(client: RawClient, method: string, tab: string | undefined): boolean {
    for (const sub of client.subscriptions.values()) {
      if (!sub.events.some((name) => name === method || method.startsWith(`${name}.`))) continue;
      if (!sub.contexts || (tab !== undefined && sub.contexts.has(tab))) return true;
    }
    return false;
  }
}
