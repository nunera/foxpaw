import { settingsPath } from '../settings.ts';
import { decide, loadPolicy, possibleClasses } from './policy.ts';
import { loadSecrets, parseSource, resolveSecret } from './secrets.ts';

const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));

/** `foxpaw policy show | check <url> <action>` */
export async function policyCommand(args: string[]): Promise<void> {
  const [sub, url, action] = args;
  const loaded = loadPolicy();
  if (!loaded.ok) throw new Error(`invalid policy, every action is refused: ${loaded.reason}`);
  if (sub === 'show') { print({ config: settingsPath(), ...loaded.policy }); return; }
  if (sub !== 'check' || !url || !action) throw new Error('Usage: foxpaw policy show | foxpaw policy check <url> <action>');
  try { new URL(url); } catch { throw new Error(`${JSON.stringify(url)} is not an absolute URL`); }
  const classes = possibleClasses(action);
  print({
    url,
    action,
    // Clicks, Enter, batches, and dialogs depend on the element; both possible outcomes are shown.
    ...(classes.length > 1 ? { note: `${action} is irreversible on submit/pay/delete/… controls or inside POST forms, otherwise write` } : {}),
    decisions: Object.fromEntries(classes.map((actionClass) => [actionClass, decide(loaded.policy, actionClass, url)])),
  });
}

/** `foxpaw secrets list | check <name>`: never prints a value. */
export async function secretsCommand(args: string[]): Promise<void> {
  const [sub, name] = args;
  const loaded = loadSecrets();
  if (!loaded.ok) throw new Error(loaded.reason);
  if (sub === 'list') {
    print(Object.entries(loaded.secrets).map(([secret, entry]) => {
      const source = parseSource(entry.source);
      return { name: secret, source: entry.source, kind: typeof source === 'string' ? 'invalid' : source.kind, origins: entry.origins };
    }));
    return;
  }
  if (sub !== 'check' || !name) throw new Error('Usage: foxpaw secrets list | foxpaw secrets check <name>');
  const entry = loaded.secrets[name];
  if (!entry) throw new Error(`no secret named ${JSON.stringify(name)} in ${settingsPath()}`);
  await resolveSecret(entry.source);
  print({ name, source: entry.source, resolves: true, origins: entry.origins });
}
