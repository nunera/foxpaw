import { fileURLToPath } from 'node:url';
import { firefoxBidiBrokerUrl } from './config.ts';
import { BidiError, BidiFeatureUnavailableError, type BidiEvent, type JsonObject } from './bidi.ts';

export const BROKER_URL = firefoxBidiBrokerUrl();
const brokerScript = fileURLToPath(new URL('./broker.ts', import.meta.url));
type Pending = { resolve(value: JsonObject): void; reject(error: Error): void };

export class BrokerBidiClient {
  #socket?: WebSocket;
  #nextId = 1;
  #pending = new Map<number, Pending>();
  #listeners = new Set<(event: BidiEvent) => void>();

  constructor(readonly url = BROKER_URL, readonly timeoutMs = 15_000) {
    const endpoint = new URL(url);
    if (endpoint.hostname !== '127.0.0.1' && endpoint.hostname !== 'localhost' && endpoint.hostname !== '::1') throw new Error(`Refusing non-loopback Firefox broker endpoint: ${endpoint.host}`);
  }

  async command(method: string, params: JsonObject = {}, timeoutMs?: number): Promise<JsonObject> { return await this.#request('command', { method, params, ...(timeoutMs === undefined ? {} : { timeoutMs }) }, timeoutMs); }
  async commandOptional(method: string, params: JsonObject = {}, timeoutMs?: number): Promise<JsonObject> { return await this.#request('commandOptional', { method, params, ...(timeoutMs === undefined ? {} : { timeoutMs }) }, timeoutMs); }
  async sessionInfo(): Promise<JsonObject> { return await this.#request('sessionInfo', {}); }
  async subscribe(events: string[], contexts?: string[]): Promise<void> { await this.#request('subscribe', { events, ...(contexts?.length ? { contexts } : {}) }); }
  async unsubscribe(events: string[], contexts?: string[]): Promise<void> { await this.#request('unsubscribe', { events, ...(contexts?.length ? { contexts } : {}) }); }
  onEvent(listener: (event: BidiEvent) => void): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }

  async close(): Promise<void> {
    this.#socket?.close();
    this.#socket = undefined;
    for (const pending of this.#pending.values()) pending.reject(new Error('Firefox broker client closed'));
    this.#pending.clear();
  }

  async #connect(): Promise<WebSocket> {
    if (this.#socket?.readyState === WebSocket.OPEN) return this.#socket;
    for (let attempt = 0; attempt < 21; attempt++) {
      const socket = new WebSocket(this.url);
      this.#socket = socket;
      socket.addEventListener('message', (message) => this.#receive(message.data));
      socket.addEventListener('close', () => { if (this.#socket === socket) this.#socket = undefined; });
      const deferred = Promise.withResolvers<void>();
      const timer = setTimeout(() => deferred.reject(new Error(`Timed out connecting to Firefox broker at ${this.url}`)), Math.min(this.timeoutMs, 500));
      socket.addEventListener('open', () => { clearTimeout(timer); deferred.resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); deferred.reject(new Error(`Unable to connect to Firefox broker at ${this.url}`)); }, { once: true });
      try { await deferred.promise; return socket; } catch { socket.close(); }
      if (attempt === 0) Bun.spawn([Bun.which('bun') ?? process.execPath, brokerScript], { stdout: 'ignore', stderr: 'ignore', stdin: 'ignore', env: { ...process.env, FIREFOX_BIDI_BROKER_PORT: new URL(this.url).port || '9223' } });
      await Bun.sleep(25);
    }
    throw new Error(`Unable to start Firefox broker at ${this.url}`);
  }

  async #request(kind: string, payload: JsonObject, timeoutMs = this.timeoutMs): Promise<JsonObject> {
    const socket = await this.#connect();
    const id = this.#nextId++;
    const deferred = Promise.withResolvers<JsonObject>();
    const timer = setTimeout(() => { this.#pending.delete(id); deferred.reject(new Error(`Timed out waiting for Zen broker ${kind}`)); }, timeoutMs);
    this.#pending.set(id, { resolve: (value) => { clearTimeout(timer); deferred.resolve(value); }, reject: (error) => { clearTimeout(timer); deferred.reject(error); } });
    socket.send(JSON.stringify({ id, kind, ...payload }));
    return await deferred.promise;
  }

  #receive(raw: unknown): void {
    if (typeof raw !== 'string') return;
    let message: Record<string, unknown>;
    try { message = JSON.parse(raw) as Record<string, unknown>; } catch { return; }
    if (message.kind === 'event' && typeof message.method === 'string' && message.params && typeof message.params === 'object' && !Array.isArray(message.params)) {
      const event = { method: message.method, params: message.params as JsonObject };
      for (const listener of this.#listeners) listener(event);
      return;
    }
    if (typeof message.id !== 'number') return;
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    if (message.error && typeof message.error === 'object' && !Array.isArray(message.error)) {
      const remote = message.error as { method?: unknown; error?: unknown; data?: unknown; unavailable?: unknown };
      const method = typeof remote.method === 'string' ? remote.method : 'broker';
      const error = typeof remote.error === 'string' ? remote.error : 'Firefox broker request failed';
      const data = remote.data && typeof remote.data === 'object' && !Array.isArray(remote.data) ? remote.data as JsonObject : {};
      pending.reject(remote.unavailable === true ? new BidiFeatureUnavailableError(method, error, data) : new BidiError(method, error, data));
      return;
    }
    pending.resolve(message.result && typeof message.result === 'object' && !Array.isArray(message.result) ? message.result as JsonObject : {});
  }
}
