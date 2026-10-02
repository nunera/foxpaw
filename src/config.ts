type Environment = Record<string, string | undefined>;

export function firefoxBidiUrl(environment: Environment = process.env): string {
  return environment.FIREFOX_BIDI_URL ?? environment.ZEN_BIDI_URL ?? 'ws://127.0.0.1:9222/session';
}

export function firefoxBidiBrokerUrl(environment: Environment = process.env): string {
  return environment.FIREFOX_BIDI_BROKER_URL ?? environment.ZEN_BIDI_BROKER_URL ?? 'ws://127.0.0.1:9223';
}
