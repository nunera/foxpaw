import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureBroker } from '../src/broker-client.ts';
import { tokenPath } from '../src/token.ts';

const previous = { data: process.env.XDG_DATA_HOME, runtime: process.env.XDG_RUNTIME_DIR };
beforeAll(() => {
  process.env.XDG_DATA_HOME = mkdtempSync(join(tmpdir(), 'foxpaw-data-'));        // broker.log goes here
  process.env.XDG_RUNTIME_DIR = mkdtempSync(join(tmpdir(), 'foxpaw-run-'));       // and the broker token here
});
afterAll(() => { process.env.XDG_DATA_HOME = previous.data; process.env.XDG_RUNTIME_DIR = previous.runtime; });

function freePort(): number {
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response() });
  const port = server.port as number;
  server.stop(true);
  return port;
}

test('starts a broker in the background, with a 0600 token, and finds it running the next time', async () => {
  const url = `ws://127.0.0.1:${freePort()}`;
  const first = await ensureBroker(url);
  expect(first.token).toBe(readFileSync(tokenPath(Number(new URL(url).port)), 'utf8'));
  expect(statSync(tokenPath(Number(new URL(url).port))).mode & 0o777).toBe(0o600);
  expect(first.sessionUrl).toBe(`${url}/session?token=${first.token}`);
  expect(await (await fetch(`${url.replace('ws', 'http')}/health`)).json()).toEqual({ foxpaw: 'broker' });
  expect(await ensureBroker(url, 1_000)).toEqual(first);

  // Its only client leaving makes it exit; nothing is left behind.
  const socket = new WebSocket(`${url}/?token=${first.token}`);
  await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
  socket.close();
  for (let i = 0; i < 100; i++) {
    const up = await fetch(`${url.replace('ws', 'http')}/health`).then(() => true, () => false);
    if (!up) return;
    await Bun.sleep(20);       // polling a real child process's exit; there is no event to await across processes
  }
  throw new Error('broker did not exit after its last client left');
});

test('refuses a port that some other program holds', async () => {
  const other = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('hello') });
  try {
    await expect(ensureBroker(`ws://127.0.0.1:${other.port}`, 1_000)).rejects.toThrow('Something other than the foxpaw broker');
  } finally {
    other.stop(true);
  }
});
