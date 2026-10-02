import { expect, test } from 'bun:test';
import { ActionScope } from '../src/action-scope.ts';

test('arms subscriptions before the operation and unsubscribes after settling', async () => {
  const calls: string[] = []; let listener: ((event: { method: string; params: Record<string, unknown> }) => void) | undefined;
  const browser = { subscribe: async () => { calls.push('subscribe'); }, unsubscribe: async () => { calls.push('unsubscribe'); }, onEvent: (next: typeof listener) => { listener = next; return () => { calls.push('listener-stop'); }; }, waitFor: async () => {}, waitForUrl: async () => {}, waitForUrlChange: async () => {} };
  const scope = new ActionScope(browser, 'ctx', 'click', 100);
  await scope.arm();
  await scope.run(async () => { calls.push('input'); listener?.({ method: 'browsingContext.load', params: { context: 'ctx' } }); });
  expect(calls).toEqual(['subscribe', 'input', 'listener-stop', 'unsubscribe']);
});

test('runs the action before evaluating a completion condition', async () => {
  const calls: string[] = [];
  const browser = {
    subscribe: async () => { calls.push('subscribe'); },
    unsubscribe: async () => { calls.push('unsubscribe'); },
    onEvent: () => () => { calls.push('listener-stop'); },
    waitFor: async () => { calls.push('waitFor'); },
    waitForUrl: async () => {},
    waitForUrlChange: async () => {},
  };
  const scope = new ActionScope(browser, 'ctx', 'click', 100);
  await scope.arm('#result');
  await scope.run(async () => { calls.push('input'); });
  expect(calls).toEqual(['subscribe', 'input', 'waitFor', 'listener-stop', 'unsubscribe']);
});

test('cleans event subscriptions when an action fails', async () => {
  const calls: string[] = [];
  const browser = { subscribe: async () => { calls.push('subscribe'); }, unsubscribe: async () => { calls.push('unsubscribe'); }, onEvent: () => () => { calls.push('listener-stop'); }, waitFor: async () => {}, waitForUrl: async () => {}, waitForUrlChange: async () => {} };
  const scope = new ActionScope(browser, 'ctx', 'click', 100);
  await scope.arm();
  await expect(scope.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
  expect(calls).toEqual(['subscribe', 'listener-stop', 'unsubscribe']);
});

test('treats a stringified condition object as a condition instead of a CSS selector', async () => {
  const calls: string[] = [];
  const browser = { subscribe: async () => {}, unsubscribe: async () => {}, onEvent: () => () => {}, waitFor: async (_context: string, selector: string) => { calls.push(`waitFor:${selector}`); }, waitForUrl: async (_context: string, url: string) => { calls.push(`waitForUrl:${url}`); }, waitForUrlChange: async () => { calls.push('waitForUrlChange'); } };
  const scope = new ActionScope(browser, 'ctx', 'navigate', 100);
  await scope.arm('{"urlChanged": true}', 'https://before.test/');
  await scope.run(async () => {});
  expect(calls).toEqual(['waitForUrlChange']);
});

test('a wait rejected while the action also fails no longer becomes an unhandled rejection', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  try {
    const browser = { subscribe: async () => {}, unsubscribe: async () => {}, onEvent: () => () => {}, waitFor: async () => { throw new Error('Timed out waiting for selector'); }, waitForUrl: async () => {}, waitForUrlChange: async () => {} };
    const scope = new ActionScope(browser, 'ctx', 'click', 100);
    await scope.arm('#missing', undefined);
    await expect(scope.run(async () => { throw new Error('click failed'); })).rejects.toThrow('click failed');
    // unhandledRejection fires on a later event-loop turn, so one zero-delay yield is the
    // minimal platform-driven check that no rejection was left unhandled.
    await Bun.sleep(0);
    expect(unhandled).toEqual([]);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('still surfaces a rejected wait after a successful action', async () => {
  const browser = { subscribe: async () => {}, unsubscribe: async () => {}, onEvent: () => () => {}, waitFor: async () => { throw new Error('Timed out waiting for selector'); }, waitForUrl: async () => {}, waitForUrlChange: async () => {} };
  const scope = new ActionScope(browser, 'ctx', 'click', 100);
  await scope.arm('#missing', undefined);
  await expect(scope.run(async () => {})).rejects.toThrow('Timed out waiting for selector');
});

test('supports text and anyOf completion predicates', async () => {
  const browser = {
    subscribe: async () => {},
    unsubscribe: async () => {},
    onEvent: () => () => {},
    waitFor: async () => { throw new Error('Timed out waiting for selector'); },
    waitForText: async () => {},
    waitForUrl: async () => {},
    waitForUrlChange: async () => {},
  };
  const scope = new ActionScope(browser, 'ctx', 'click', 100);
  await scope.arm('{"anyOf":[{"selector":"#missing"},{"text":"Correct!"}]}');
  await expect(scope.run(async () => {})).resolves.toMatchObject({ completionReason: 'textAppears' });
});
