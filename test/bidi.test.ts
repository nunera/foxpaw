import { expect, test } from 'bun:test';
import { BidiClient } from '../src/bidi.ts';

test('rejects non-loopback BiDi endpoints before connecting', () => {
  expect(() => new BidiClient('ws://192.168.1.5:9222/session')).toThrow('Refusing non-loopback');
});

test('accepts local WebSocket endpoints', () => {
  expect(() => new BidiClient('ws://127.0.0.1:9222/session')).not.toThrow();
  expect(() => new BidiClient('ws://localhost:9222/session')).not.toThrow();
});

test('rejects HTTP endpoints', () => {
  expect(() => new BidiClient('http://127.0.0.1:9222/session')).toThrow('requires a WebSocket URL');
});

test('opens one BiDi session, routes commands, and ends the session', async () => {
  const methods: string[] = [];
  const server = Bun.serve<{ opened: boolean }>({
    port: 0,
    fetch(request, webServer) {
      if (webServer.upgrade(request, { data: { opened: true } })) return;
      return new Response('WebSocket required', { status: 426 });
    },
    websocket: {
      message(socket, raw) {
        const request = JSON.parse(String(raw)) as { id: number; method: string; params: unknown };
        methods.push(request.method);
        const result = request.method === 'session.new' ? { sessionId: 'session-1', capabilities: { browserName: 'zen' } } : { echoed: request.params };
        socket.send(JSON.stringify({ id: request.id, result }));
      },
    },
  });
  const client = new BidiClient(`ws://127.0.0.1:${server.port}/session`);

  try {
    await expect(client.command('session.status', { ready: true })).resolves.toEqual({ echoed: { ready: true } });
    await expect(client.sessionInfo()).resolves.toEqual({ sessionId: 'session-1', capabilities: { browserName: 'zen' } });
  } finally {
    await client.close();
    server.stop(true);
  }

  expect(methods).toEqual(['session.new', 'session.status', 'session.end']);
});


test('dispatches BiDi events without confusing them for responses', async () => {
  let emit!: (payload: unknown) => void;
  const server = Bun.serve<{ socket: unknown }>({
    port: 0,
    fetch(request, webServer) {
      if (webServer.upgrade(request, { data: { socket: null } })) return;
      return new Response('WebSocket required', { status: 426 });
    },
    websocket: {
      open(socket) {
        emit = (payload) => socket.send(JSON.stringify(payload));
      },
      message(socket, raw) {
        const request = JSON.parse(String(raw)) as { id: number; method: string; params: unknown };
        socket.send(JSON.stringify({ id: request.id, result: {} }));
      },
    },
  });
  const client = new BidiClient(`ws://127.0.0.1:${server.port}/session`);
  const received = new Promise<string>((resolve) => client.onEvent((event) => resolve(event.method)));

  try {
    await client.command('session.status');
    emit({ method: 'log.entryAdded', params: { text: 'hello' } });
    await expect(received).resolves.toBe('log.entryAdded');
  } finally {
    await client.close();
    server.stop(true);
  }
});

test('classifies only unsupported protocol commands as unavailable', async () => {
  const server = Bun.serve({
    port: 0,
    fetch(request, webServer) {
      if (webServer.upgrade(request)) return;
      return new Response('WebSocket required', { status: 426 });
    },
    websocket: {
      message(socket, raw) {
        const request = JSON.parse(String(raw)) as { id: number; method: string };
        socket.send(JSON.stringify(request.method === 'session.new'
          ? { id: request.id, result: {} }
          : request.method === 'missing.command'
            ? { id: request.id, error: 'unknown command' }
            : { id: request.id, error: 'invalid argument' }));
      },
    },
  });
  const client = new BidiClient(`ws://127.0.0.1:${server.port}/session`);
  try {
    await expect(client.commandOptional('missing.command')).rejects.toThrow('unknown command');
    await expect(client.commandOptional('known.command')).rejects.toThrow('invalid argument');
  } finally { await client.close(); server.stop(true); }
});

test('redacts sensitive event payload values before listeners observe them', async () => {
  let emit!: (payload: unknown) => void;
  const server = Bun.serve({
    port: 0,
    fetch(request, webServer) { if (webServer.upgrade(request)) return; return new Response('WebSocket required', { status: 426 }); },
    websocket: {
      open(socket) { emit = (payload) => socket.send(JSON.stringify(payload)); },
      message(socket, raw) { const request = JSON.parse(String(raw)) as { id: number }; socket.send(JSON.stringify({ id: request.id, result: {} })); },
    },
  });
  const client = new BidiClient(`ws://127.0.0.1:${server.port}/session`);
  const seen = new Promise<Record<string, unknown>>((resolve) => client.onEvent((event) => resolve(event.params)));
  try {
    await client.command('session.status');
    emit({ method: 'network.beforeRequestSent', params: { authorization: 'Bearer secret', body: 'password', promptText: 'typed', path: '/tmp/file', url: 'https://x.test/?token=secret' } });
    await expect(seen).resolves.toEqual({ authorization: '[REDACTED]', body: '[REDACTED]', promptText: '[REDACTED]', path: '[REDACTED]', url: 'https://x.test/?token=%5BREDACTED%5D' });
  } finally { await client.close(); server.stop(true); }
});
