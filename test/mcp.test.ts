import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, existsSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import type { BrowserTool, ToolParams } from '../src/tool/core.ts';
import { createMcpServer } from '../src/mcp/server.ts';
import { serveHttp } from '../src/mcp/http.ts';

const CLI = new URL('../src/cli.ts', import.meta.url).pathname;
const TOKEN = 'mcp-test-token';

/** Environment that keeps spawned servers away from the user's broker, browser, and runtime dir. */
function isolatedEnv(): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), 'foxpaw-mcp-test-'));
  const port = 40_000 + Math.floor(Math.random() * 10_000);
  return {
    ...process.env as Record<string, string>,
    XDG_RUNTIME_DIR: dir, XDG_DATA_HOME: dir, XDG_STATE_HOME: dir, FOXPAW_CONFIG: join(dir, 'config.json'),
    FIREFOX_BIDI_URL: `ws://127.0.0.1:${port}/session`, FIREFOX_BIDI_BROKER_URL: `ws://127.0.0.1:${port + 1}`,
  };
}

/** A stand-in tool, so protocol behavior is tested without a browser. */
function fakeTool(execute: BrowserTool['execute']): BrowserTool {
  return {
    name: 'zen_browser', label: 'Zen / Firefox browser', description: 'test tool',
    parameters: z.object({ action: z.enum(['tabs', 'screenshot', 'wait', 'fail']), tabId: z.string().optional() }),
    execute, shutdown: async () => {}, runtime: undefined as never,
  };
}

type Message = { id: number; result?: unknown; error?: { code: number; message: string } };
type ToolsList = { tools: Array<{ name: string; inputSchema: { type: string; $schema?: string; required: string[]; properties: { action: { enum: string[] } } } }> };

test('stdio: initialize, tools/list, and tools/call with an invalid action, with only JSON-RPC on stdout', async () => {
  const child = spawn(process.execPath, [CLI, 'mcp'], { env: isolatedEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
  const lines: string[] = [];
  const waiting = new Map<number, (message: Message) => void>();
  createInterface({ input: child.stdout! }).on('line', (line) => {
    lines.push(line);
    const message = JSON.parse(line) as Message;           // anything that isn't JSON-RPC on stdout fails here
    waiting.get(message.id)?.(message);
  });
  const call = (id: number, method: string, params?: unknown) => {
    const answered = Promise.withResolvers<Message>();
    waiting.set(id, answered.resolve);
    child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })}\n`);
    return answered.promise;
  };
  const exited = Promise.withResolvers<number | null>();
  child.on('exit', exited.resolve);

  const init = await call(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  expect(init.result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'foxpaw' } });
  child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

  const { tools } = (await call(2, 'tools/list')).result as ToolsList;
  expect(tools).toHaveLength(1);
  const [tool] = tools;
  expect(tool!.name).toBe('zen_browser');
  expect(tool!.inputSchema.type).toBe('object');
  expect(tool!.inputSchema.$schema).toBeUndefined();
  expect(tool!.inputSchema.required).toEqual(['action']);
  expect(tool!.inputSchema.properties.action.enum).toContain('launch');
  expect(tool!.inputSchema.properties.action.enum).toContain('tabs');

  const invalid = await call(3, 'tools/call', { name: 'zen_browser', arguments: { action: 'no_such_action' } });
  expect(invalid.error).toBeUndefined();
  const result = invalid.result as { isError: boolean; content: Array<{ type: string; text: string }> };
  expect(result.isError).toBe(true);
  expect(result.content[0]!.text).toContain('action');

  expect((await call(4, 'tools/call', { name: 'other', arguments: {} })).error?.code).toBe(-32602);
  expect((await call(5, 'no/such/method')).error?.code).toBe(-32601);
  expect((await call(6, 'ping')).result).toEqual({});

  child.stdin!.end();
  expect(await exited.promise).toBe(0);
  expect(lines).toHaveLength(6);
}, 20_000);

test('tools/call maps text and image content, and tool errors become isError results', async () => {
  const server = createMcpServer(fakeTool(async (params: ToolParams) => {
    if (params.action === 'fail') throw new Error('No tab tab_9');
    return { content: [{ type: 'text', text: '{"ok":true}' }, { type: 'image', data: 'iVBOR', mimeType: 'image/png' }], details: {} };
  }));
  const session = server.session();
  const ok = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'zen_browser', arguments: { action: 'screenshot' } } }, session);
  expect(ok?.result).toEqual({ content: [{ type: 'text', text: '{"ok":true}' }, { type: 'image', data: 'iVBOR', mimeType: 'image/png' }], isError: false });
  const failed = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'zen_browser', arguments: { action: 'fail' } } }, session);
  expect(failed?.error).toBeUndefined();
  expect(failed?.result).toEqual({ content: [{ type: 'text', text: 'No tab tab_9' }], isError: true });
});

test('notifications/cancelled aborts the running call and suppresses its response', async () => {
  const started = Promise.withResolvers<AbortSignal>();
  const server = createMcpServer(fakeTool(async (_params, signal) => {
    const aborted = Promise.withResolvers<void>();
    signal!.addEventListener('abort', () => aborted.resolve());
    started.resolve(signal!);
    await aborted.promise;
    throw new Error('aborted');
  }));
  const session = server.session();
  const pending = server.handle({ jsonrpc: '2.0', id: 'call-1', method: 'tools/call', params: { name: 'zen_browser', arguments: { action: 'wait' } } }, session);
  const signal = await started.promise;
  expect(await server.handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'call-1', reason: 'user stopped' } }, session)).toBeUndefined();
  expect(signal.aborted).toBe(true);
  expect(await pending).toBeUndefined();
});

type Reply = { status: number; headers: Record<string, string | string[] | undefined>; body: string };
/** node:http rather than fetch, so a test can send any Host header. */
function send(port: number, options: { method?: string; path?: string; headers?: Record<string, string>; body?: unknown }): Promise<Reply> {
  const done = Promise.withResolvers<Reply>();
  const req = request({ host: '127.0.0.1', port, method: options.method ?? 'POST', path: options.path ?? '/mcp', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...options.headers } }, (response) => {
    let body = '';
    response.on('data', (chunk) => { body += chunk; });
    response.on('end', () => done.resolve({ status: response.statusCode ?? 0, headers: response.headers, body }));
  });
  req.on('error', done.reject);
  req.end(options.body === undefined ? undefined : JSON.stringify(options.body));
  return done.promise;
}
const INITIALIZE = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } };
const auth = { authorization: `Bearer ${TOKEN}` };

test('HTTP: refuses web pages, DNS rebinding, and requests without the token', async () => {
  const http = await serveHttp(createMcpServer(fakeTool(async () => ({ content: [], details: {} }))), { port: 0, token: TOKEN });
  try {
    expect((await send(http.port, { headers: { ...auth, origin: 'https://evil.example' }, body: INITIALIZE })).status).toBe(403);
    expect((await send(http.port, { headers: { ...auth, host: 'evil.example:9224' }, body: INITIALIZE })).status).toBe(403);
    expect((await send(http.port, { body: INITIALIZE })).status).toBe(403);
    expect((await send(http.port, { headers: { authorization: 'Bearer wrong' }, body: INITIALIZE })).status).toBe(403);
    expect((await send(http.port, { headers: auth, body: INITIALIZE })).status).toBe(200);
    expect((await send(http.port, { path: `/mcp?token=${TOKEN}`, body: INITIALIZE })).status).toBe(200);
  } finally {
    await http.close();
  }
});

test('HTTP: sessions start at initialize, gate later requests, and end on DELETE', async () => {
  const http = await serveHttp(createMcpServer(fakeTool(async () => ({ content: [{ type: 'text', text: '{"tabs":[]}' }], details: {} }))), { port: 0, token: TOKEN });
  try {
    const init = await send(http.port, { headers: auth, body: INITIALIZE });
    expect(init.status).toBe(200);
    expect(JSON.parse(init.body).result.protocolVersion).toBe('2025-06-18');
    const sessionId = init.headers['mcp-session-id'] as string;
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
    const inSession = { ...auth, 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' };

    expect((await send(http.port, { headers: inSession, body: { jsonrpc: '2.0', method: 'notifications/initialized' } })).status).toBe(202);
    const called = await send(http.port, { headers: inSession, body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'zen_browser', arguments: { action: 'tabs' } } } });
    expect(called.status).toBe(200);
    expect(JSON.parse(called.body)).toEqual({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: '{"tabs":[]}' }], isError: false } });

    // Clients that accept only SSE get the response as one event.
    const sse = await send(http.port, { headers: { ...inSession, accept: 'text/event-stream' }, body: { jsonrpc: '2.0', id: 3, method: 'ping' } });
    expect(sse.headers['content-type']).toBe('text/event-stream');
    expect(sse.body).toBe(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 3, result: {} })}\n\n`);

    expect((await send(http.port, { headers: auth, body: { jsonrpc: '2.0', id: 4, method: 'ping' } })).status).toBe(400);
    expect((await send(http.port, { headers: { ...auth, 'mcp-session-id': 'not-a-session' }, body: { jsonrpc: '2.0', id: 5, method: 'ping' } })).status).toBe(404);
    expect((await send(http.port, { headers: { ...inSession, 'mcp-protocol-version': '1999-01-01' }, body: { jsonrpc: '2.0', id: 6, method: 'ping' } })).status).toBe(400);
    expect((await send(http.port, { method: 'GET', headers: inSession })).status).toBe(405);

    expect((await send(http.port, { method: 'DELETE', headers: inSession })).status).toBe(204);
    expect((await send(http.port, { headers: inSession, body: { jsonrpc: '2.0', id: 7, method: 'ping' } })).status).toBe(404);
  } finally {
    await http.close();
  }
});

test('foxpaw mcp --http prints its URL and token on stderr, saves the token 0600, and removes it on exit', async () => {
  const env = isolatedEnv();
  const child = spawn(process.execPath, [CLI, 'mcp', '--http', '--port', '0'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout!.on('data', (chunk) => { stdout += chunk; });
  const stderr = createInterface({ input: child.stderr! });
  const printed: string[] = [];
  for await (const line of stderr) { printed.push(line); if (line.startsWith('Token file: ')) break; }
  const url = new URL(printed.find((line) => line.startsWith('foxpaw MCP server: '))!.slice('foxpaw MCP server: '.length));
  const token = printed.find((line) => line.startsWith('Authorization: Bearer '))!.slice('Authorization: Bearer '.length);
  const file = printed.find((line) => line.startsWith('Token file: '))!.slice('Token file: '.length);
  expect(url.hostname).toBe('127.0.0.1');
  expect(file).toBe(join(env.XDG_RUNTIME_DIR!, 'foxpaw', `mcp-${url.port}.token`));
  expect(readFileSync(file, 'utf8')).toBe(token);
  expect(statSync(file).mode & 0o777).toBe(0o600);

  const init = await send(Number(url.port), { headers: { authorization: `Bearer ${token}` }, body: INITIALIZE });
  expect(init.status).toBe(200);
  expect(init.headers['mcp-session-id']).toBeTruthy();

  const exited = Promise.withResolvers<number | null>();
  child.on('exit', exited.resolve);
  child.kill('SIGTERM');
  expect(await exited.promise).toBe(0);
  expect(existsSync(file)).toBe(false);
  expect(stdout).toBe('');
}, 20_000);
