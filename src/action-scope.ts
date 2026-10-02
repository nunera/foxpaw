import type { BidiEvent } from './bidi.ts';

export type WaitPredicate = {
  selector?: string;
  text?: string;
  url?: string;
  urlChanged?: boolean;
  documentChanged?: boolean;
  pageIdleMs?: number;
};
export type WaitCondition = string | WaitPredicate | { anyOf: WaitPredicate[] };
export type ActionScopeResult = { waitMode: 'none' | 'polling-fallback'; elapsedMs: number; trigger?: BidiEvent; completionReason?: string };

function stringifiedCondition(value: string): WaitCondition {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error(`Wait condition ${JSON.stringify(value)} is neither a valid selector nor valid JSON.`); }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`Wait condition ${JSON.stringify(value)} must decode to an object.`);
  const object = parsed as Record<string, unknown>;
  if ('anyOf' in object) {
    if (!Array.isArray(object.anyOf) || !object.anyOf.length) throw new Error(`Wait condition ${JSON.stringify(value)} requires a non-empty anyOf array.`);
    return { anyOf: object.anyOf.map((entry) => parsePredicate(entry, value)) };
  }
  return parsePredicate(object, value);
}

function parsePredicate(value: unknown, source: string): WaitPredicate {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Wait condition ${JSON.stringify(source)} contains a malformed predicate.`);
  const condition: WaitPredicate = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue;
    if (key === 'selector' && typeof entry === 'string') condition.selector = entry;
    else if (key === 'text' && typeof entry === 'string') condition.text = entry;
    else if (key === 'url' && typeof entry === 'string') condition.url = entry;
    else if ((key === 'urlChanged' || key === 'documentChanged') && typeof entry === 'boolean') condition[key] = entry;
    else if (key === 'pageIdleMs' && typeof entry === 'number' && entry >= 0) condition.pageIdleMs = entry;
    else throw new Error(`Wait condition ${JSON.stringify(source)} has an unsupported key or value at ${JSON.stringify(key)}.`);
  }
  if (!Object.keys(condition).length) throw new Error(`Wait condition ${JSON.stringify(source)} has no predicates.`);
  return condition;
}

type ScopeBrowser = {
  subscribe(events: string[], contexts?: string[]): Promise<void>;
  unsubscribe(events: string[], contexts?: string[]): Promise<void>;
  onEvent(listener: (event: BidiEvent) => void): () => void;
  waitFor(context: string, selector: string, timeoutMs: number): Promise<void>;
  waitForText?(context: string, text: string, timeoutMs: number): Promise<void>;
  waitForUrl(context: string, expected: string, timeoutMs: number): Promise<void>;
  waitForUrlChange(context: string, previous: string, timeoutMs: number): Promise<void>;
  waitForDocumentChange?(context: string, previous: string, timeoutMs: number): Promise<void>;
  waitForPageIdle?(context: string, idleMs: number, timeoutMs: number): Promise<void>;
};

export class ActionScope {
  readonly startedAt = Date.now();
  readonly events: BidiEvent[] = [];
  readonly diagnostics: BidiEvent[] = this.events;
  #stop?: () => void;
  #subscribed = false;
  #condition?: WaitCondition;
  #previousUrl?: string;
  #previousDocumentId?: string;

  constructor(readonly browser: ScopeBrowser, readonly context: string, readonly action: string, readonly timeoutMs: number) {}

  async arm(condition?: WaitCondition, previousUrl?: string, previousDocumentId?: string): Promise<void> {
    const eventTypes = ['browsingContext.navigationStarted', 'browsingContext.domContentLoaded', 'browsingContext.load', 'log.entryAdded', 'network.beforeRequestSent', 'network.responseCompleted'];
    await this.browser.subscribe(eventTypes, [this.context]);
    this.#subscribed = true;
    this.#stop = this.browser.onEvent((event) => {
      const source = event.params.source as { context?: unknown } | undefined;
      if (event.params.context === this.context || source?.context === this.context) this.events.push(event);
    });
    this.#condition = condition;
    this.#previousUrl = previousUrl;
    this.#previousDocumentId = previousDocumentId;
  }

  async run(operation: () => Promise<void>): Promise<ActionScopeResult> {
    try {
      await operation();
      const completion = this.#condition === undefined ? undefined : await this.#waitFor(this.#condition, this.#previousUrl, this.#previousDocumentId);
      return {
        waitMode: this.#condition === undefined ? 'none' : 'polling-fallback',
        elapsedMs: Date.now() - this.startedAt,
        ...(completion?.trigger ? { trigger: completion.trigger } : {}),
        ...(completion?.completionReason ? { completionReason: completion.completionReason } : {}),
      };
    } finally { await this.settle(); }
  }

  async settle(): Promise<void> {
    this.#stop?.(); this.#stop = undefined;
    if (this.#subscribed) { this.#subscribed = false; await this.browser.unsubscribe(['browsingContext.navigationStarted', 'browsingContext.domContentLoaded', 'browsingContext.load', 'log.entryAdded', 'network.beforeRequestSent', 'network.responseCompleted'], [this.context]).catch(() => undefined); }
  }

  async #waitFor(condition: WaitCondition, previousUrl?: string, previousDocumentId?: string): Promise<{ trigger?: BidiEvent; completionReason?: string }> {
    if (typeof condition === 'string' && condition.trimStart().startsWith('{')) condition = stringifiedCondition(condition);
    if (typeof condition === 'string') {
      await this.browser.waitFor(this.context, condition, this.timeoutMs);
      return { completionReason: 'selectorAppears' };
    }
    if ('anyOf' in condition) {
      return await Promise.any(condition.anyOf.map((predicate) => this.#waitFor(predicate, previousUrl, previousDocumentId)));
    }
    const waits: Array<Promise<string>> = [];
    if (condition.selector) waits.push(this.browser.waitFor(this.context, condition.selector, this.timeoutMs).then(() => 'selectorAppears'));
    if (condition.text) {
      if (!this.browser.waitForText) throw new Error('Text waits are unavailable in this browser transport.');
      waits.push(this.browser.waitForText(this.context, condition.text, this.timeoutMs).then(() => 'textAppears'));
    }
    if (condition.url) waits.push(this.browser.waitForUrl(this.context, condition.url, this.timeoutMs).then(() => 'urlMatches'));
    if (condition.urlChanged && previousUrl !== undefined) waits.push(this.browser.waitForUrlChange(this.context, previousUrl, this.timeoutMs).then(() => 'urlChanged'));
    if (condition.documentChanged && previousDocumentId !== undefined) {
      if (!this.browser.waitForDocumentChange) throw new Error('Document waits are unavailable in this browser transport.');
      waits.push(this.browser.waitForDocumentChange(this.context, previousDocumentId, this.timeoutMs).then(() => 'documentChanged'));
    }
    if (condition.pageIdleMs !== undefined) {
      if (!this.browser.waitForPageIdle) throw new Error('Idle waits are unavailable in this browser transport.');
      waits.push(this.browser.waitForPageIdle(this.context, condition.pageIdleMs, this.timeoutMs).then(() => 'pageIdle'));
    }
    if (!waits.length) throw new Error('Wait condition needs a previous URL or document ID for the requested predicate.');
    const results = await Promise.all(waits);
    return {
      trigger: this.events.find((event) => event.method.startsWith('browsingContext.')),
      completionReason: results.join('+'),
    };
  }
}
