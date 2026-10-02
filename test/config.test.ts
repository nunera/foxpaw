import { expect, test } from 'bun:test';
import { firefoxBidiBrokerUrl, firefoxBidiUrl } from '../src/config.ts';

test('uses loopback Firefox BiDi endpoints by default', () => {
  expect(firefoxBidiUrl({})).toBe('ws://127.0.0.1:9222/session');
  expect(firefoxBidiBrokerUrl({})).toBe('ws://127.0.0.1:9223');
});

test('uses configured local Firefox BiDi endpoints', () => {
  expect(firefoxBidiUrl({ FIREFOX_BIDI_URL: 'ws://127.0.0.1:9333/session' })).toBe('ws://127.0.0.1:9333/session');
  expect(firefoxBidiBrokerUrl({ FIREFOX_BIDI_BROKER_URL: 'ws://127.0.0.1:9334' })).toBe('ws://127.0.0.1:9334');
});

test('keeps existing Zen endpoint overrides working', () => {
  expect(firefoxBidiUrl({ ZEN_BIDI_URL: 'ws://127.0.0.1:9444/session' })).toBe('ws://127.0.0.1:9444/session');
  expect(firefoxBidiBrokerUrl({ ZEN_BIDI_BROKER_URL: 'ws://127.0.0.1:9445' })).toBe('ws://127.0.0.1:9445');
  expect(firefoxBidiUrl({ FIREFOX_BIDI_URL: 'ws://127.0.0.1:9555/session', ZEN_BIDI_URL: 'ws://127.0.0.1:9444/session' })).toBe('ws://127.0.0.1:9555/session');
});
