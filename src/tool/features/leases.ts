import { randomBytes } from 'node:crypto';
import type { z as Zod } from 'zod';
import { BidiError, type JsonObject } from '../../bidi.ts';
import { brokerRequests } from '../../broker-client.ts';
import type { ActionCall, ActionOutcome, ToolFeature, ToolRuntime } from '../core.ts';

export type LeasesFeatureOptions = {
  /** Shown on the tabs this agent controls and to other agents; default "<host> <4 hex digits>". */
  label?: string;
  host?: string;
};

// Reading and waiting never take a tab; another agent may still be using it. `open` leases the tab it creates
// (the broker gives a client the tabs it creates), not the tab it opens next to.
const READS: Record<string, true> = {
  tabs: true, inspect: true, form_schema: true, field_state: true, query: true, table: true, events: true, wait_event: true,
  wait_for: true, wait_for_change: true, wait_url: true, assert: true, assert_many: true, screenshot: true, launch: true, open: true, release: true,
  snapshot: true, downloads: true, wait_download: true,
};
const LEASE_NOTE = 'Another agent (or program) is using this tab. Use a different tab or `open` a new one; to wait for it instead, pass waitForTabMs.';

const isLeaseError = (error: unknown) => (error instanceof BidiError && error.error === 'tab leased') || (error instanceof Error && error.message.includes('broker: tab leased'));

/**
 * Tab leases from the tool's side (the broker enforces them, src/human/gate.ts). Before an action that can change a
 * page, the tool leases its tab under this session's name, so a tab another agent holds is refused before anything
 * runs (or waited for, with `waitForTabMs`). `tabs` marks tabs other agents hold; `release` hands a tab back.
 */
export function leasesFeature(options: LeasesFeatureOptions = {}): ToolFeature {
  const label = options.label ?? `${options.host && options.host !== 'unknown' ? options.host : 'agent'} ${randomBytes(2).toString('hex')}`;
  const refusal = (call: ActionCall, tabId: string | undefined, error: string, leasedBy?: unknown) => new Error(JSON.stringify({
    ...(tabId ? { tabId } : {}),
    action: call.action,
    actionPerformed: false,
    error,
    ...(typeof leasedBy === 'string' ? { leasedBy } : {}),
    note: LEASE_NOTE,
  }));
  const leases = async (runtime: ToolRuntime) => {
    const broker = brokerRequests(runtime.browser.bidi);
    const answer = broker ? await broker.request('leases') : {};
    return Array.isArray(answer.leases) ? answer.leases as Array<{ context: string; owner: string; mine: boolean }> : [];
  };
  return {
    name: 'leases',
    actions: {
      async release(call, runtime) {
        const broker = brokerRequests(runtime.browser.bidi);
        if (!call.params.tabId && !call.params.target) throw new Error('release requires tabId (or a target matching one tab)');
        const { context, tabId } = await runtime.target('release', call.params.tabId, call.params.target);
        const answer = broker ? await broker.request('release', { context: context.id }) : {};
        return { details: { tabId, released: Array.isArray(answer.released) && answer.released.length > 0 } };
      },
    },
    params: (z: typeof Zod) => ({
      waitForTabMs: z.number().int().positive().max(600_000).optional().describe('When another agent holds the tab, wait up to this long for it instead of failing at once.'),
    }),
    description: [
      `Tab leases: a tab this session changes is leased to it ("${label}") until the session ends or \`release\` {tabId} hands it back. A tab another agent holds is refused with \`leasedBy\`; \`tabs\` marks such tabs \`leasedBy: "other"\`. Use another tab, or pass \`waitForTabMs\` to queue for it.`,
    ],
    async before(call, runtime) {
      const broker = brokerRequests(runtime.browser.bidi);
      if (!broker) return;
      if (call.action === 'open') { await broker.request('identify', { owner: label }); return; }
      if (READS[call.action] || (!call.params.tabId && !call.params.target)) return;
      let found;
      try { found = await runtime.target(call.action, call.params.tabId, call.params.target); } catch { return; }   // the action reports it
      const waitMs = typeof call.params.waitForTabMs === 'number' ? call.params.waitForTabMs : 0;
      try {
        await broker.request('lease', { context: found.context.id, owner: label, ...(waitMs ? { waitMs } : {}) }, waitMs + 15_000);
      } catch (error) {
        if (!isLeaseError(error)) throw error;
        const leasedBy = error instanceof BidiError ? error.data.leasedBy : undefined;
        throw refusal(call, found.tabId, `This tab is in use by ${typeof leasedBy === 'string' ? JSON.stringify(leasedBy) : 'another agent'}; nothing was sent.`, leasedBy);
      }
    },
    async after(call, outcome, runtime): Promise<ActionOutcome | void> {
      if (call.action === 'tabs' && outcome.result) {
        const others = new Map((await leases(runtime).catch(() => [])).filter((lease) => !lease.mine).map((lease) => [runtime.tabId(lease.context), lease.owner]));
        if (!others.size) return;
        const details = outcome.result.details;
        const tabs = Array.isArray(details.tabs) ? details.tabs as JsonObject[] : [];
        return { ...outcome, result: { ...outcome.result, details: { ...details, tabs: tabs.map((tab) => others.has(tab.tabId as string) ? { ...tab, leasedBy: 'other', leaseOwner: others.get(tab.tabId as string) } : tab) } } };
      }
      // A read (inspect, query, …) the broker refused on another agent's tab: name the holder.
      if (!outcome.result && isLeaseError(outcome.error) && !(outcome.error instanceof Error && outcome.error.message.includes(LEASE_NOTE))) {
        let found;
        try { found = await runtime.target(call.action, call.params.tabId, call.params.target); } catch { return; }
        const holder = (await leases(runtime).catch(() => [])).find((lease) => lease.context === found.context.id && !lease.mine);
        return { ...outcome, error: refusal(call, found.tabId, `This tab is in use by ${holder ? JSON.stringify(holder.owner) : 'another agent'}; the action was refused.`, holder?.owner) };
      }
    },
  };
}
