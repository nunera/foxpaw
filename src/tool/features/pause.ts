import { BidiError } from '../../bidi.ts';
import { brokerRequests } from '../../broker-client.ts';
import type { ActionCall, ActionOutcome, ToolFeature } from '../core.ts';

const NOTE = 'The user paused foxpaw to take over the browser (Ctrl+Alt+P in a tab, or `foxpaw pause`). Do not retry in a loop or work around it: wait for the user, or ask them whether to continue.';
/** How long an action waits for a resume before it reports the pause (capped well below host tool timeouts). */
const MAX_WAIT_MS = 30_000;

const isPauseError = (error: unknown) => (error instanceof BidiError && error.error === 'paused') || (error instanceof Error && error.message.includes('broker: paused'));

/**
 * The tool side of the user's pause (the broker holds the commands, src/human/gate.ts): an action that starts while
 * paused waits up to its timeout for a resume, then reports `paused: true` with a note instead of hanging silently.
 * An action the pause caught halfway reports the same, and that part of it may have run.
 */
export function pauseFeature(): ToolFeature {
  const refusal = (call: ActionCall, error: string, extra: Record<string, unknown>) => new Error(JSON.stringify({
    ...(call.params.tabId ? { tabId: call.params.tabId } : {}),
    action: call.action,
    paused: true,
    error,
    ...extra,
    note: NOTE,
  }));
  return {
    name: 'pause',
    description: [
      'Pause: the user can pause every agent at any time to take over (Ctrl+Alt+P in an agent-controlled tab, or `foxpaw pause`). A paused action waits up to its `timeoutMs` for a resume, then fails with `paused: true`: nothing more was sent. Do not retry in a loop; wait or ask the user.',
    ],
    async before(call, runtime) {
      const broker = brokerRequests(runtime.browser.bidi);
      if (!broker || call.action === 'launch') return;
      const waitMs = Math.min(typeof call.params.timeoutMs === 'number' ? call.params.timeoutMs : 10_000, MAX_WAIT_MS);
      const state = await broker.request('pauseState', { waitMs }, waitMs + 5_000);
      if (state.paused === true) throw refusal(call, 'The user paused foxpaw; nothing was sent.', { actionPerformed: false, ...(typeof state.since === 'number' ? { pausedSince: new Date(state.since).toISOString() } : {}) });
    },
    async after(call, outcome): Promise<ActionOutcome | void> {
      if (outcome.result || !isPauseError(outcome.error)) return;
      return { ...outcome, error: refusal(call, 'The user paused foxpaw while this action ran; the rest of it was not sent.', { actionPerformed: 'partly or not at all: check the page before continuing' }) };
    },
  };
}
