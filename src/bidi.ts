export type JsonObject = Record<string, unknown>;

export type BidiEvent = { method: string; params: JsonObject };
type Pending = { method: string; resolve(value: JsonObject): void; reject(reason: Error): void; timer: Timer };

export class BidiError extends Error {

  constructor(readonly method: string, readonly error: string, readonly data: JsonObject) {
    super(`${method}: ${error}`);
  }
}

export type BidiTransport = {
  command(method: string, params?: JsonObject, timeoutMs?: number): Promise<JsonObject>;
  commandOptional(method: string, params?: JsonObject, timeoutMs?: number): Promise<JsonObject>;
  onEvent(listener: (event: BidiEvent) => void): () => void;
  sessionInfo?(): Promise<JsonObject>;
  subscribe(events: string[], contexts?: string[]): Promise<void>;
  unsubscribe(events: string[], contexts?: string[]): Promise<void>;
  close(): Promise<void>;
};

export class BidiFeatureUnavailableError extends BidiError {
  constructor(method: string, error: string, data: JsonObject) {
    super(method, error, data);
    this.name = 'BidiFeatureUnavailableError';
  }
}

const unsupportedErrors = new Set(['unknown command', 'unsupported operation', 'unsupported command']);

export class BidiClient {
  #socket?: WebSocket;
  #nextId = 1;
  #sessionStarted = false;
  #sessionInfo?: JsonObject;
  #pending = new Map<number, Pending>();
  #listeners = new Set<(event: BidiEvent) => void>();

  constructor(readonly url: string, readonly timeoutMs = 15_000) {
    const endpoint = new URL(url);
    if (!isLoopback(endpoint.hostname)) throw new Error(`Refusing non-loopback WebDriver BiDi endpoint: ${endpoint.host}`);
    if (!['ws:', 'wss:'].includes(endpoint.protocol)) throw new Error(`WebDriver BiDi requires a WebSocket URL, received ${endpoint.protocol}`);
  }

  async connect(): Promise<void> {
    if (this.#socket) return;
    const socket = new WebSocket(this.url);
    this.#socket = socket;
    socket.addEventListener('message', (event) => this.#receive(event.data));
    socket.addEventListener('close', () => this.#disconnect(new Error('WebDriver BiDi connection closed')));
    socket.addEventListener('error', () => this.#disconnect(new Error('WebDriver BiDi connection failed')));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out connecting to ${this.url}`)), this.timeoutMs);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error(`Unable to connect to ${this.url}`)); }, { once: true });
    });
    try {
      this.#sessionInfo = await this.#request('session.new', { capabilities: { alwaysMatch: {}, firstMatch: [{}] } });
      this.#sessionStarted = true;
    } catch (error) {
      socket.close();
      this.#disconnect(error instanceof Error ? error : new Error('WebDriver BiDi session could not start'));
      throw error;
    }
  }

  async command(method: string, params: JsonObject = {}, timeoutMs?: number): Promise<JsonObject> {
    await this.connect();
    return await this.#request(method, params, timeoutMs);
  }
  async sessionInfo(): Promise<JsonObject> {
    await this.connect();
    return this.#sessionInfo ?? {};
  }

  async commandOptional(method: string, params: JsonObject = {}, timeoutMs?: number): Promise<JsonObject> {
    try {
      return await this.command(method, params, timeoutMs);
    } catch (error) {
      if (error instanceof BidiError && unsupportedErrors.has(error.error.toLowerCase())) {
        throw new BidiFeatureUnavailableError(method, error.error, error.data);
      }
      throw error;
    }
  }

  onEvent(listener: (event: BidiEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async subscribe(events: string[], contexts?: string[]): Promise<void> {
    await this.command('session.subscribe', { events, ...(contexts?.length ? { contexts } : {}) });
  }
  async unsubscribe(events: string[], contexts?: string[]): Promise<void> {
    await this.command('session.unsubscribe', { events, ...(contexts?.length ? { contexts } : {}) });
  }

  async #request(method: string, params: JsonObject, timeoutMs = this.timeoutMs): Promise<JsonObject> {
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('WebDriver BiDi is not connected');
    const id = this.#nextId++;
    const deferred = Promise.withResolvers<JsonObject>();
    const timer = setTimeout(() => { this.#pending.delete(id); deferred.reject(new Error(`Timed out waiting for ${method}`)); }, timeoutMs);
    this.#pending.set(id, { method, resolve: deferred.resolve, reject: deferred.reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
    return await deferred.promise;
  }

  async close(): Promise<void> {
    if (this.#sessionStarted && this.#socket?.readyState === WebSocket.OPEN) {
      try { await this.#request('session.end', {}); } catch { /* transport already gone */ }
    }
    this.#socket?.close();
    this.#disconnect(new Error('WebDriver BiDi client closed'));
  }

  #receive(raw: unknown): void {
    if (typeof raw !== 'string') return;
    let response: JsonObject;
    try { response = JSON.parse(raw) as JsonObject; } catch { return; }
    if (typeof response.method === 'string') {
      const params = response.params;
      if (!params || typeof params !== 'object' || Array.isArray(params)) return;
      const event = { method: response.method, params: redactEvent(response.method, params as JsonObject) };
      for (const listener of this.#listeners) listener(event);
      return;
    }
    const id = response.id;
    if (typeof id !== 'number') return;
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id); clearTimeout(pending.timer);
    if (typeof response.error === 'string') { pending.reject(new BidiError(pending.method, response.error, response)); return; }
    pending.resolve((response.result as JsonObject | undefined) ?? {});
  }

  #disconnect(reason: Error): void {
    this.#sessionStarted = false; this.#socket = undefined;
    this.#sessionInfo = undefined;
    for (const [id, pending] of this.#pending) { this.#pending.delete(id); clearTimeout(pending.timer); pending.reject(reason); }
  }
}

export function redactEvent(_method: string, value: JsonObject): JsonObject { return redact(value) as JsonObject; }
function redact(value: unknown, key = ''): unknown {
  const sensitive = /^(cookie|cookies|authorization|proxy-authorization|value|body|postData|promptText|files?|path|upload|password|secret|token)$/i;
  if (sensitive.test(key)) return '[REDACTED]';
  if (typeof value === 'string') return key === 'url' ? redactUrl(value) : value;
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as JsonObject).map(([name, item]) => [name, redact(item, name)]));
}
function redactUrl(url: string): string {
  try { const parsed = new URL(url); for (const key of [...parsed.searchParams.keys()]) if (/^(token|password|secret)$/i.test(key)) parsed.searchParams.set(key, '[REDACTED]'); return parsed.toString(); } catch { return url; }
}
function isLoopback(hostname: string): boolean { return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]'; }
