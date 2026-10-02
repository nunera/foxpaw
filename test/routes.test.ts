import { expect, test } from 'bun:test';
import { RouteManager } from '../src/routes.ts';
import type { BidiClient } from '../src/bidi.ts';

test('executes a fulfill route only for its intercepted request', async () => {
  const commands: Array<{ method: string; params: Record<string, unknown> }> = [];
  let listener: ((event: { method: string; params: Record<string, unknown> }) => void) | undefined;
  const client = {
    commandOptional: async (method: string, params: Record<string, unknown> = {}) => {
      commands.push({ method, params });
      return method === 'network.addIntercept' ? { intercept: 'intercept_1' } : {};
    },
    subscribe: async () => {},
    onEvent: (next: typeof listener) => { listener = next; return () => {}; },
  } as unknown as BidiClient;
  const routes = new RouteManager(client);
  await routes.add({ url: 'https://fixture.test/*', phases: ['beforeRequestSent'], action: 'fulfill', status: 200, body: 'fixture' });
  listener?.({ method: 'network.beforeRequestSent', params: { intercepts: ['intercept_1'], request: { request: 'request_1' } } });
  await Promise.resolve();
  await Promise.resolve();
  expect(commands.at(-1)).toEqual({ method: 'network.provideResponse', params: { request: 'request_1', response: { statusCode: 200, headers: [], body: { type: 'base64', value: 'Zml4dHVyZQ==' } } } });
});
