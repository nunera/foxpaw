import { BidiError, type JsonObject } from '../bidi.ts';

/**
 * Tab leases and the user's pause, enforced in the broker for every client (foxpaw envelope and raw /session).
 *
 * Leases: a client that acts on a tab (navigation, input, closing, dialogs, … in it or a frame in it) holds that tab
 * exclusively until it releases it, disconnects, or the tab closes. Tabs a client creates are its own from the start.
 * Other clients' commands on a held tab are refused with an error naming the holder; `lease` with `waitMs` queues.
 * Script evaluation (`script.evaluate`, `script.callFunction`) on a held tab is refused too (it can change the page),
 * but does not take a lease by itself, because listing tabs evaluates `document.title` in every tab. Read-only
 * commands (`getTree`, `captureScreenshot`, `locateNodes`, `getRealms`) are never refused: any client may look.
 * Commands that target a realm instead of a context are not tied to a tab and pass.
 *
 * Pause: while the user has paused foxpaw, input, navigation, and script commands from every client are held (not
 * sent) and go out once resumed, or are refused when their timeout runs out first. Everything else passes.
 */
export class Holder {
  color: string;
  constructor(readonly id: number, public label: string) { this.color = colorFor(label); }
  rename(label: string, color?: string): void { this.label = label; this.color = color ?? colorFor(label); }
}

export type PauseState = { paused: boolean; since?: number; by?: string };
export type Lease = { tab: string; holder: Holder; since: number };
export type GateEvents = {
  /** A tab was leased; the gate awaits this before the command that took the lease goes out (overlay install). */
  leased?(tab: string, holder: Holder): Promise<void> | void;
  released?(tab: string, holder: Holder, closed: boolean): void;
  pauseChanged?(state: PauseState): void;
  /** Viewport pointer positions of an `input.performActions` on a leased tab, before it goes out. */
  pointer?(tab: string, points: Array<{ x: number; y: number }>): void;
};
export type Tabs = { tab(context: string): string; has(context: string): boolean; track(): Promise<void> };

/** How long an envelope command without its own timeout may wait out a pause (below the client's 15 s). */
export const DEFAULT_HOLD_MS = 10_000;
const PALETTE = ['#2563eb', '#7c3aed', '#db2777', '#059669', '#0891b2', '#4f46e5', '#c026d3', '#0d9488'];
/** Stable per name, so one agent keeps its color across tabs and reconnects. */
export function colorFor(label: string): string {
  let hash = 0;
  for (const char of label) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return PALETTE[hash % PALETTE.length]!;
}

const READ_ONLY: Record<string, true> = { 'browsingContext.getTree': true, 'browsingContext.captureScreenshot': true, 'browsingContext.locateNodes': true, 'script.getRealms': true, 'browsingContext.create': true };
const CHECK_ONLY: Record<string, true> = { 'script.evaluate': true, 'script.callFunction': true, 'script.disown': true };
const HELD: Record<string, true> = {
  'browsingContext.navigate': true, 'browsingContext.reload': true, 'browsingContext.traverseHistory': true, 'browsingContext.create': true,
  'browsingContext.close': true, 'browsingContext.activate': true, 'browsingContext.handleUserPrompt': true, 'browsingContext.setViewport': true,
  'script.evaluate': true, 'script.callFunction': true,
};
const tabScoped = (method: string) => /^(browsingContext|input|script)\./.test(method) && !READ_ONLY[method];
const heldOnPause = (method: string) => method.startsWith('input.') || HELD[method] === true;
function contextOf(params: JsonObject): string | undefined {
  if (typeof params.context === 'string') return params.context;
  const target = params.target;
  return target && typeof target === 'object' && typeof (target as JsonObject).context === 'string' ? (target as JsonObject).context as string : undefined;
}
function pointerPoints(params: JsonObject): Array<{ x: number; y: number }> {
  const points: Array<{ x: number; y: number }> = [];
  for (const source of Array.isArray(params.actions) ? params.actions as JsonObject[] : []) {
    if (source?.type !== 'pointer' || !Array.isArray(source.actions)) continue;
    for (const action of source.actions as JsonObject[]) {
      if (action?.type === 'pointerMove' && (action.origin ?? 'viewport') === 'viewport' && typeof action.x === 'number' && typeof action.y === 'number') points.push({ x: action.x, y: action.y });
    }
  }
  return points;
}

type Waiter = { holder?: Holder; resolve(): void; reject(error: Error): void; timer: NodeJS.Timeout };

export class HumanGate {
  #leases = new Map<string, Lease>();
  #queues = new Map<string, Waiter[]>();
  #held = new Set<Waiter>();
  #pause: PauseState = { paused: false };

  constructor(private readonly tabs: Tabs, private readonly events: GateEvents = {}) {}

  /** Runs one client command through pause and leases; `send` forwards it with the time left of its timeout. */
  async command(holder: Holder, method: string, params: JsonObject, timeoutMs: number | undefined, send: (timeoutMs?: number) => Promise<JsonObject>): Promise<JsonObject> {
    const started = Date.now();
    if (heldOnPause(method)) await this.#waitOutPause(holder, timeoutMs ?? DEFAULT_HOLD_MS);
    const context = tabScoped(method) ? contextOf(params) : undefined;
    let granted: string | undefined;
    if (context !== undefined) {
      await this.tabs.track();
      const tab = this.tabs.tab(context);
      const lease = this.#leases.get(tab);
      if (lease && lease.holder !== holder) throw leased(lease, method);
      if (!lease && !CHECK_ONLY[method]) { granted = tab; await this.#grant(tab, holder); }
      if (method === 'input.performActions' && tab === context) {
        const points = pointerPoints(params);
        if (points.length) this.events.pointer?.(tab, points);
      }
    }
    try {
      const result = await send(timeoutMs === undefined ? undefined : Math.max(1_000, timeoutMs - (Date.now() - started)));
      if (method === 'browsingContext.create' && typeof result.context === 'string' && !this.#leases.has(result.context)) await this.#grant(result.context, holder);
      return result;
    } catch (error) {
      // A lease on a context that does not exist would otherwise outlive it.
      if (granted && error instanceof BidiError && error.error === 'no such frame') this.#vacate(granted, false);
      throw error;
    }
  }

  /** Lease `context`'s tab explicitly; with `waitMs`, queue behind its holder for that long. */
  async lease(holder: Holder, context: string, waitMs = 0): Promise<Lease> {
    await this.tabs.track();
    if (!this.tabs.has(context)) throw new BidiError('broker', 'no such frame', { message: `No browsing context ${context}.` });
    const tab = this.tabs.tab(context);
    const current = this.#leases.get(tab);
    if (!current) return await this.#grant(tab, holder);
    if (current.holder === holder) return current;
    if (waitMs <= 0) throw leased(current, 'lease');
    const queue = this.#queues.get(tab) ?? [];
    this.#queues.set(tab, queue);
    const turn = Promise.withResolvers<void>();
    const waiter: Waiter = {
      holder, resolve: turn.resolve, reject: turn.reject,
      timer: setTimeout(() => {
        queue.splice(queue.indexOf(waiter), 1);
        const holderNow = this.#leases.get(tab);
        turn.reject(holderNow ? leased(holderNow, 'lease', waitMs) : new Error('lease wait timed out'));
      }, waitMs),
    };
    queue.push(waiter);
    await turn.promise;
    return this.#leases.get(tab)!;
  }

  /** Releases one tab (or every tab) the holder leases; returns the released tabs. */
  release(holder: Holder, context?: string): string[] {
    const tabs = context === undefined
      ? [...this.#leases.values()].filter((lease) => lease.holder === holder).map((lease) => lease.tab)
      : [this.tabs.tab(context)].filter((tab) => this.#leases.get(tab)?.holder === holder);
    for (const tab of tabs) this.#vacate(tab, false);
    return tabs;
  }

  /** The holder disconnected: its leases end, and its queued leases and held commands are refused. */
  drop(holder: Holder): void {
    for (const queue of this.#queues.values()) {
      for (const waiter of queue.filter((entry) => entry.holder === holder)) { queue.splice(queue.indexOf(waiter), 1); clearTimeout(waiter.timer); waiter.reject(new Error('client disconnected')); }
    }
    for (const waiter of [...this.#held].filter((entry) => entry.holder === holder)) { this.#held.delete(waiter); clearTimeout(waiter.timer); waiter.reject(new Error('client disconnected')); }
    this.release(holder);
  }

  /** A browsing context was destroyed; a closed tab ends its lease and refuses the lease requests queued for it. */
  closed(context: string): void {
    if (this.#leases.has(context)) this.#vacate(context, true);
    const queue = this.#queues.get(context);
    this.#queues.delete(context);
    for (const waiter of queue ?? []) { clearTimeout(waiter.timer); waiter.reject(new BidiError('broker', 'no such frame', { message: `Tab ${context} was closed.` })); }
  }

  /** The Firefox session is gone, and every tab with it. */
  reset(): void {
    for (const tab of [...this.#queues.keys()]) this.closed(tab);
    this.#leases.clear();
  }

  leaseOf(tab: string): Lease | undefined { return this.#leases.get(tab); }
  leases(): Lease[] { return [...this.#leases.values()]; }

  get pauseState(): PauseState { return { ...this.#pause }; }

  pause(by: string): PauseState {
    if (!this.#pause.paused) {
      this.#pause = { paused: true, since: Date.now(), by };
      this.events.pauseChanged?.(this.pauseState);
    }
    return this.pauseState;
  }

  resume(): PauseState {
    if (this.#pause.paused) {
      this.#pause = { paused: false };
      for (const waiter of this.#held) { clearTimeout(waiter.timer); waiter.resolve(); }
      this.#held.clear();
      this.events.pauseChanged?.(this.pauseState);
    }
    return this.pauseState;
  }

  toggle(by: string): PauseState { return this.#pause.paused ? this.resume() : this.pause(by); }

  /** The pause state, after waiting up to `waitMs` for a resume when paused. */
  async waitForResume(waitMs: number): Promise<PauseState> {
    if (this.#pause.paused && waitMs > 0) await this.#hold(undefined, waitMs).catch(() => undefined);
    return this.pauseState;
  }

  async #waitOutPause(holder: Holder, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    // Paused again between the resume and this command's turn: wait again, within the same timeout.
    while (this.#pause.paused) await this.#hold(holder, deadline - Date.now());
  }

  #hold(holder: Holder | undefined, waitMs: number): Promise<void> {
    const done = Promise.withResolvers<void>();
    const waiter: Waiter = {
      holder, resolve: done.resolve, reject: done.reject,
      timer: setTimeout(() => { this.#held.delete(waiter); done.reject(paused(this.#pause)); }, Math.max(0, waitMs)),
    };
    this.#held.add(waiter);
    return done.promise;
  }

  async #grant(tab: string, holder: Holder): Promise<Lease> {
    const lease = { tab, holder, since: Date.now() };
    this.#leases.set(tab, lease);
    await Promise.resolve(this.events.leased?.(tab, holder)).catch(() => undefined);
    return lease;
  }

  #vacate(tab: string, closed: boolean): void {
    const lease = this.#leases.get(tab);
    if (!lease) return;
    this.#leases.delete(tab);
    this.events.released?.(tab, lease.holder, closed);
    if (closed) return;
    const next = this.#queues.get(tab)?.shift();
    if (!next) return;
    clearTimeout(next.timer);
    void this.#grant(tab, next.holder!).then(() => next.resolve());   // queued lease requests always have a holder
  }
}

function leased(lease: Lease, method: string, waitedMs?: number): BidiError {
  const waited = waitedMs === undefined ? '' : ` after waiting ${waitedMs} ms`;
  return new BidiError('broker', 'tab leased', {
    message: `${method} refused${waited}: tab ${lease.tab} is in use by ${JSON.stringify(lease.holder.label)} (another agent or client). Use another tab, or lease this one with waitMs to queue until it is released.`,
    leasedBy: lease.holder.label,
    context: lease.tab,
  });
}

function paused(state: PauseState): BidiError {
  return new BidiError('broker', 'paused', {
    message: `The user paused foxpaw${state.by ? ` (${state.by})` : ''} and did not resume in time, so this command was not sent. The user has taken over the browser: wait, or ask them, before retrying.`,
    paused: true,
    ...(state.since ? { since: state.since } : {}),
  });
}
