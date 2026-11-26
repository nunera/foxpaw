import { randomUUID } from 'node:crypto';
import type { BidiEvent, JsonObject } from '../bidi.ts';
import type { Holder, HumanGate } from './gate.ts';
import { overlayCall, overlayFunction, type OverlayMessage } from './page.ts';
import type { HumanLoopSettings } from './settings.ts';

const SANDBOX = 'foxpaw';
const CALL_TIMEOUT_MS = 5_000;
type Upstream = { command(method: string, params?: JsonObject, timeoutMs?: number): Promise<JsonObject> };
type Installed = { script: Promise<string | undefined> };

/**
 * The broker's side of the in-page human loop: installs the page script (src/human/page.ts) in every tab a client
 * leases, keeps its label and pause state current, moves the agent cursor, and turns hotkey presses into pause and
 * resume. Its commands go straight to Firefox, past leases and pause.
 */
export class Overlays {
  /** Unguessable, though pages cannot reach it anyway: it exists only in the sandbox realm. */
  readonly channel = `foxpaw-human-loop-${randomUUID()}`;
  #tabs = new Map<string, Installed>();
  #subscription?: Promise<unknown>;
  gate?: HumanGate;

  constructor(private readonly upstream: Upstream, private readonly settings: HumanLoopSettings, private readonly tabOf: (context: string) => string) {}

  /** Before the leasing command goes out, so the preload script is registered before a navigation it starts. */
  async install(tab: string, holder: Holder): Promise<void> {
    if (this.#tabs.has(tab)) { this.#push(tab); return; }
    const declaration = overlayFunction({ label: holder.label, color: holder.color, hotkey: this.settings.hotkey, visuals: this.settings.overlay });
    const channel = { type: 'channel', value: { channel: this.channel } };
    const script = (async () => {
      await (this.#subscription ??= this.upstream.command('session.subscribe', { events: ['script.message'] }).catch((error: unknown) => { this.#subscription = undefined; throw error; }));
      const added = await this.upstream.command('script.addPreloadScript', { functionDeclaration: declaration, arguments: [channel], contexts: [tab], sandbox: SANDBOX });
      return typeof added.script === 'string' ? added.script : undefined;
    })().catch(() => undefined);
    this.#tabs.set(tab, { script });
    await script;
    // The current document; not awaited, since a page with an open dialog would hold it.
    void this.upstream.command('script.callFunction', { functionDeclaration: declaration, arguments: [channel], target: { context: tab, sandbox: SANDBOX }, awaitPromise: false }, CALL_TIMEOUT_MS).catch(() => undefined);
  }

  remove(tab: string, closed: boolean): void {
    const installed = this.#tabs.get(tab);
    if (!installed) return;
    this.#tabs.delete(tab);
    void installed.script.then((script) => script ? this.upstream.command('script.removePreloadScript', { script }) : undefined).catch(() => undefined);
    if (!closed) this.#call(tab, overlayCall('remove'));
  }

  /** Pause state or a label changed: every overlay shows it. */
  refresh(): void { for (const tab of this.#tabs.keys()) this.#push(tab); }

  pointer(tab: string, points: Array<{ x: number; y: number }>): void {
    if (this.settings.overlay && this.#tabs.has(tab)) this.#call(tab, overlayCall('move', points));
  }

  /** Handles the page script's messages; true when the event was one (it then goes to no client). */
  message(event: BidiEvent): boolean {
    if (event.method !== 'script.message' || event.params.channel !== this.channel) return false;
    const source = event.params.source as JsonObject | undefined;
    const context = typeof source?.context === 'string' ? source.context : undefined;
    const message = messageOf(event.params.data);
    if (!context || !message) return true;
    const tab = this.tabOf(context);
    // Only a tab an agent controls has the script; anything else is stale (a released tab's old document).
    if (!this.gate?.leaseOf(tab)) return true;
    if (message.type === 'toggle') this.gate.toggle('hotkey in the page');
    else this.#push(context);
    return true;
  }

  #push(context: string): void {
    const lease = this.gate?.leaseOf(this.tabOf(context));
    if (!lease) return;
    this.#call(context, overlayCall('state', { label: lease.holder.label, color: lease.holder.color, paused: this.gate!.pauseState.paused }));
  }

  #call(context: string, functionDeclaration: string): void {
    void this.upstream.command('script.callFunction', { functionDeclaration, target: { context, sandbox: SANDBOX }, awaitPromise: false }, CALL_TIMEOUT_MS).catch(() => undefined);
  }
}

/** The page script's message, from its serialized RemoteValue ({type: 'object', value: [[key, value], …]}). */
function messageOf(data: unknown): OverlayMessage | undefined {
  const remote = data as { type?: unknown; value?: unknown } | undefined;
  if (remote?.type !== 'object' || !Array.isArray(remote.value)) return undefined;
  for (const entry of remote.value as unknown[]) {
    if (!Array.isArray(entry) || entry[0] !== 'type') continue;
    const value = (entry[1] as { value?: unknown } | undefined)?.value;
    if (value === 'toggle' || value === 'ready') return { type: value };
  }
  return undefined;
}
