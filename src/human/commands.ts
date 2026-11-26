import { BrokerBidiClient, BROKER_URL } from '../broker-client.ts';
import type { JsonObject } from '../bidi.ts';

const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));

/** Requests to the running broker; never starts one (its pause and leases would end with this command). */
async function ask(kinds: Array<[string, JsonObject?]>): Promise<JsonObject[] | undefined> {
  const client = new BrokerBidiClient(BROKER_URL, 5_000, { start: false });
  try {
    const answers: JsonObject[] = [];
    for (const [kind, payload] of kinds) answers.push(await client.request(kind, payload ?? {}));
    return answers;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('No foxpaw broker is running')) return undefined;
    throw error;
  } finally {
    await client.close();
  }
}
const nothingRuns = { broker: 'not running', note: 'No agent is connected, so there is nothing to pause.' };

/** `foxpaw pause`: hold every agent's input, navigation, and script commands until `foxpaw resume`. */
export async function pauseCommand(): Promise<void> {
  print((await ask([['pause', { owner: 'foxpaw pause' }]]))?.[0] ?? nothingRuns);
}

/** `foxpaw resume` */
export async function resumeCommand(): Promise<void> {
  print((await ask([['resume']]))?.[0] ?? nothingRuns);
}

/** `foxpaw leases`: which agent controls which tab. */
export async function leasesCommand(): Promise<void> {
  const answers = await ask([['leases'], ['command', { method: 'browsingContext.getTree', params: { maxDepth: 0 } }]]);
  if (!answers) { print({ broker: 'not running', leases: [] }); return; }
  const [answer, tree] = answers as [JsonObject, JsonObject];
  const urls = new Map((Array.isArray(tree.contexts) ? tree.contexts as JsonObject[] : []).map((context) => [context.context, context.url]));
  const leases = Array.isArray(answer.leases) ? answer.leases as JsonObject[] : [];
  print({ pause: answer.pause, leases: leases.map(({ mine: _mine, ...lease }) => ({ ...lease, url: urls.get(lease.context) ?? null })) });
}

/** For `foxpaw status`: the pause state and lease count, or null when no broker runs. */
export async function humanLoopStatus(): Promise<JsonObject | null> {
  const answer = (await ask([['leases']]).catch(() => undefined))?.[0];
  if (!answer) return null;
  return { ...(answer.pause as JsonObject), leasedTabs: Array.isArray(answer.leases) ? answer.leases.length : 0 };
}
