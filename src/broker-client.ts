import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import { get } from 'node:http';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { firefoxBidiBrokerUrl } from './config.ts';
import { BidiError, BidiFeatureUnavailableError, type BidiEvent, type JsonObject } from './bidi.ts';
import { dataDir } from './launch.ts';
import { readBrokerToken } from './token.ts';

export const BROKER_URL = firefoxBidiBrokerUrl();
type Pending = { resolve(value: JsonObject): void; reject(error: Error): void };

const SELF = fileURLToPath(import.meta.url);
// Inside a `bun build --compile` binary, modules live under /$bunfs (B:/~BUN on Windows).
const COMPILED = SELF.startsWith('/$bunfs/') || /^[A-Za-z]:[\\/]~BUN[\\/]/.test(SELF);

/**
 * How this process starts the broker (`foxpaw broker`): the compiled foxpaw binary itself; or this runtime with the
 * CLI next to this module (cli.ts from source, cli.js in the built package). Under Bun embedded in a host such as
 * omp, process.execPath is the host, which behaves as plain `bun` when BUN_BE_BUN=1 is set.
 */
export function brokerCommand(): { command: string[]; env: Record<string, string> } {
  if (COMPILED) return { command: [process.execPath, 'broker'], env: {} };
  const cli = join(dirname(SELF), SELF.endsWith('.ts') ? 'cli.ts' : 'cli.js');
  return { command: [process.execPath, cli, 'broker'], env: process.versions.bun ? { BUN_BE_BUN: '1' } : {} };
}

type Health = 'broker' | 'legacy' | 'down' | 'other';
/** node:http rather than fetch: it never routes loopback through an HTTP(S)_PROXY from the environment. */
function health(url: string): Promise<Health> {
  const { promise, resolve } = Promise.withResolvers<Health>();
  const endpoint = new URL(url);
  const request = get({ host: endpoint.hostname, port: endpoint.port || 80, path: '/health', timeout: 1000 }, (response) => {
    let body = '';
    response.setEncoding('utf8');
    response.on('data', (chunk: string) => { body += chunk; });
    response.on('end', () => {
      if (response.statusCode === 503) resolve('down');                     // shutting down: start a new one
      else if (response.statusCode === 200 && body.includes('"foxpaw":"broker"')) resolve('broker');
      // Brokers from before /health (and before tokens) answer every plain request with 426 and this text.
      else if (response.statusCode === 426 && body.includes('Firefox BiDi broker')) resolve('legacy');
      else resolve('other');
    });
  });
  request.on('timeout', () => request.destroy());
  request.on('error', () => resolve('down'));
  return promise;
}

export type BrokerEndpoint = {
  /** Broker base URL, e.g. ws://127.0.0.1:9223 */
  url: string;
  /** Token of the running broker; undefined only for a broker from before tokens. */
  token?: string;
  /** Plain WebDriver BiDi URL with the token, for any BiDi client. */
  sessionUrl: string;
};

const withToken = (url: string, path: string, token?: string): string => {
  const endpoint = new URL(path, url);
  if (token) endpoint.searchParams.set('token', token);
  return endpoint.toString();
};

/**
 * Make sure a foxpaw broker answers at `url`, starting one in the background if needed, and return how to reach it.
 * The broker exits once its last client leaves (or a minute after starting if none connects), so connect soon after.
 */
export async function ensureBroker(url: string = BROKER_URL, timeoutMs = 10_000): Promise<BrokerEndpoint> {
  const deadline = Date.now() + timeoutMs;
  const port = Number(new URL(url).port || 80);
  let child: ChildProcess | undefined;
  let running = false;
  for (;;) {
    const state = await health(url);
    if (state === 'broker' || state === 'legacy') {
      const token = state === 'broker' ? readBrokerToken(port) : undefined;
      if (state === 'legacy' || token) return { url, ...(token ? { token } : {}), sessionUrl: withToken(url, '/session', token) };
    }
    if (state === 'other') throw new Error(`Something other than the foxpaw broker answers at ${url}. Set FIREFOX_BIDI_BROKER_URL to a free port.`);
    if (Date.now() > deadline) throw new Error(`The foxpaw broker did not start at ${url}; see ${join(dataDir(), 'broker.log')}`);
    // One broker at a time; a new one only after the last exited (it loses the port race to a broker still closing).
    if (state === 'down' && !running) {
      child = spawnBroker(url);
      running = true;
      child.once('exit', () => { running = false; });
      child.once('error', () => { running = false; });
    }
    await sleep(50);
  }
}

function spawnBroker(url: string): ChildProcess {
  const { command, env } = brokerCommand();
  mkdirSync(dataDir(), { recursive: true });
  const log = openSync(join(dataDir(), 'broker.log'), 'a');
  const child = spawn(command[0]!, command.slice(1), {
    detached: true,
    stdio: ['ignore', log, log],
    env: { ...process.env, ...env, FIREFOX_BIDI_BROKER_PORT: new URL(url).port || '9223' },
  });
  child.unref();
  return child;
}

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

  /** Send a broker request of a kind other than the BiDi ones above (features such as tab leases add their own). */
  async request(kind: string, payload: JsonObject = {}, timeoutMs?: number): Promise<JsonObject> { return await this.#request(kind, payload, timeoutMs); }

  async close(): Promise<void> {
    this.#socket?.close();
    this.#socket = undefined;
    for (const pending of this.#pending.values()) pending.reject(new Error('Firefox broker client closed'));
    this.#pending.clear();
  }

  async #connect(): Promise<WebSocket> {
    if (this.#socket?.readyState === WebSocket.OPEN) return this.#socket;
    const deadline = Date.now() + this.timeoutMs;
    for (;;) {
      const { token } = await ensureBroker(this.url, Math.max(1_000, deadline - Date.now()));
      const socket = new WebSocket(withToken(this.url, '/', token));
      this.#socket = socket;
      socket.on('message', (data, isBinary) => { if (!isBinary) this.#receive(data.toString()); });
      socket.on('close', () => { if (this.#socket === socket) this.#socket = undefined; });
      const deferred = Promise.withResolvers<void>();
      const timer = setTimeout(() => deferred.reject(new Error(`Timed out connecting to Firefox broker at ${this.url}`)), 2_000);
      socket.once('open', () => { clearTimeout(timer); deferred.resolve(); });
      socket.once('error', (error) => { clearTimeout(timer); deferred.reject(new Error(`Unable to connect to Firefox broker at ${this.url}: ${error.message}`)); });
      try { await deferred.promise; return socket; } catch (error) {
        socket.terminate();
        // The broker began shutting down between its health check and this connection: check (and start) again.
        if (Date.now() > deadline) throw error;
      }
    }
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

  #receive(raw: string): void {
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
