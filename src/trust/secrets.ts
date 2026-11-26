import { z } from 'zod';
import type { Environment } from '../config.ts';
import { readSettings, settingsPath } from '../settings.ts';
import { runProgram, type Runner } from './approve.ts';

/**
 * The `secrets` settings key: named secrets, where each value comes from, and the origins allowed to receive it.
 * Values are resolved in-process right before a fill and never leave foxpaw except into the page field.
 */
export type SecretSource =
  | { kind: 'pass'; path: string }
  | { kind: 'bitwarden'; item: string; field: string }
  | { kind: 'op'; ref: string }
  | { kind: 'keyring'; service: string; account: string }
  | { kind: 'env'; variable: string };
export type SecretEntry = { source: string; origins: string[] };
export type LoadedSecrets = { ok: true; secrets: Record<string, SecretEntry> } | { ok: false; reason: string };

export function parseSource(source: string): SecretSource | string {
  const colon = source.indexOf(':');
  const scheme = colon < 0 ? '' : source.slice(0, colon);
  const rest = source.slice(colon + 1);
  if (!rest) return 'needs a value after the scheme';
  switch (scheme) {
    case 'pass': return { kind: 'pass', path: rest };
    case 'bitwarden': {
      const slash = rest.lastIndexOf('/');
      return slash > 0 && slash < rest.length - 1 ? { kind: 'bitwarden', item: rest.slice(0, slash), field: rest.slice(slash + 1) } : { kind: 'bitwarden', item: rest, field: 'password' };
    }
    case 'op': return rest.startsWith('op://') ? { kind: 'op', ref: rest } : 'must be op:op://vault/item/field';
    case 'keyring': {
      const slash = rest.indexOf('/');
      return slash > 0 && slash < rest.length - 1 ? { kind: 'keyring', service: rest.slice(0, slash), account: rest.slice(slash + 1) } : 'must be keyring:<service>/<account>';
    }
    case 'env': return /^[A-Za-z_][A-Za-z0-9_]*$/.test(rest) ? { kind: 'env', variable: rest } : 'must be env:<VARIABLE>';
    default: return 'must start with pass:, bitwarden:, op:, keyring:, or env:';
  }
}

const origin = z.string().transform((value, ctx) => {
  let url: URL | undefined;
  try { url = new URL(value); } catch { url = undefined; }
  if (!url || url.origin === 'null' || url.pathname !== '/' || url.search || url.hash || url.username || !(value === url.origin || value === `${url.origin}/`)) {
    ctx.addIssue({ code: 'custom', message: `${JSON.stringify(value)} must be a bare origin like https://bank.example` });
    return z.NEVER;
  }
  return url.origin;
});
const secretsSchema = z.record(
  z.string().regex(/^[A-Za-z0-9_.-]+$/, 'secret names use letters, digits, _, ., -'),
  z.object({
    source: z.string().superRefine((value, ctx) => {
      const parsed = parseSource(value);
      if (typeof parsed === 'string') ctx.addIssue({ code: 'custom', message: `${JSON.stringify(value)} ${parsed}` });
    }),
    origins: z.array(origin).min(1),
  }).strict(),
);

export function parseSecrets(raw: unknown, source = 'config'): LoadedSecrets {
  const parsed = secretsSchema.safeParse(raw ?? {});
  if (parsed.success) return { ok: true, secrets: parsed.data };
  const reason = parsed.error.issues.map((issue) => `secrets${issue.path.map((part) => typeof part === 'number' ? `[${part}]` : `.${String(part)}`).join('')}: ${issue.message}`).join('; ');
  return { ok: false, reason: `${source}: ${reason}` };
}

export function loadSecrets(env: Environment = process.env): LoadedSecrets {
  const path = settingsPath(env);
  let settings: Record<string, unknown>;
  try { settings = readSettings(env); } catch (error) {
    return { ok: false, reason: `${path}: ${error instanceof Error ? error.message : String(error)}` };
  }
  return parseSecrets(settings.secrets, path);
}

export type ResolveDeps = { run?: Runner; env?: Environment; platform?: NodeJS.Platform };
const BITWARDEN_FIELDS: Record<string, true> = { password: true, username: true, totp: true, notes: true, uri: true };

/** Reads one secret value. Errors name the source and the tool's message, never a value. */
export async function resolveSecret(source: string, deps: ResolveDeps = {}): Promise<string> {
  const parsed = parseSource(source);
  if (typeof parsed === 'string') throw new Error(`secret source ${JSON.stringify(source)} ${parsed}`);
  const run = deps.run ?? runProgram;
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const program = async (command: string, args: string[]) => {
    const result = await run(command, args, { env: { ...process.env, ...env } });
    if (result.code !== 0) throw new Error(`${command} ${result.code === null ? 'could not run' : `exited ${result.code}`} for ${source}${result.stderr.trim() ? `: ${result.stderr.trim().slice(0, 200)}` : ''}`);
    return result.stdout.replace(/\r?\n$/, '');
  };
  let value: string;
  switch (parsed.kind) {
    case 'env': {
      const found = env[parsed.variable];
      if (found === undefined) throw new Error(`environment variable ${parsed.variable} is not set`);
      value = found;
      break;
    }
    case 'pass': value = (await program('pass', ['show', parsed.path])).split(/\r?\n/)[0]!; break;
    case 'op': value = await program('op', ['read', '--no-newline', parsed.ref]); break;
    case 'keyring':
      if (platform === 'linux') value = await program('secret-tool', ['lookup', 'service', parsed.service, 'account', parsed.account]);
      else if (platform === 'darwin') value = await program('security', ['find-generic-password', '-s', parsed.service, '-a', parsed.account, '-w']);
      else throw new Error(`keyring: sources are supported on Linux (secret-tool) and macOS (security), not ${platform}`);
      break;
    case 'bitwarden':
      if (BITWARDEN_FIELDS[parsed.field]) value = await program('bw', ['get', parsed.field, parsed.item]);
      else {
        const item = JSON.parse(await program('bw', ['get', 'item', parsed.item])) as { fields?: Array<{ name?: string; value?: string }> };
        const field = item.fields?.find((entry) => entry.name === parsed.field);
        if (typeof field?.value !== 'string') throw new Error(`bitwarden item ${parsed.item} has no custom field ${parsed.field}`);
        value = field.value;
      }
      break;
  }
  if (!value) throw new Error(`secret source ${source} resolved to an empty value`);
  return value;
}

/**
 * Replaces every known secret value, in the forms it can take in tool output (raw, URL-encoded, form-encoded,
 * HTML-escaped as text or attribute, each also JSON-escaped up to three levels deep), with `[secret:<name>]`.
 * Page script can always transform a value further; secret mode refuses `evaluate` for that reason.
 */
export class Redactor {
  #needles: Array<{ needle: string; marker: string }> = [];

  get size(): number { return this.#needles.length; }

  add(name: string, value: string): void {
    if (!value) return;
    const marker = `[secret:${name}]`;
    const amp = value.replace(/&/g, '&amp;');
    const html = [amp.replace(/</g, '&lt;').replace(/>/g, '&gt;'), amp.replace(/"/g, '&quot;'), amp.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')];
    const forms = new Set<string>();
    for (const base of [value, new URLSearchParams({ v: value }).toString().slice(2), ...html]) {
      let escaped = base;
      for (let depth = 0; depth <= 3; depth++) {
        forms.add(escaped);
        forms.add(encodeURIComponent(escaped));
        escaped = JSON.stringify(escaped).slice(1, -1);
      }
    }
    for (const needle of forms) if (!this.#needles.some((entry) => entry.needle === needle)) this.#needles.push({ needle, marker });
    // Longest first, so a shorter form inside a longer one doesn't leave fragments behind.
    this.#needles.sort((a, b) => b.needle.length - a.needle.length);
  }

  text(input: string): string {
    let output = input;
    for (const { needle, marker } of this.#needles) if (output.includes(needle)) output = output.split(needle).join(marker);
    return output;
  }

  /** A deep copy of JSON-like data with every string (and key) redacted. */
  value<T>(input: T): T {
    if (typeof input === 'string') return this.text(input) as T;
    if (Array.isArray(input)) return input.map((item) => this.value(item)) as T;
    if (input && typeof input === 'object' && (Object.getPrototypeOf(input) === Object.prototype || Object.getPrototypeOf(input) === null)) {
      return Object.fromEntries(Object.entries(input).map(([key, item]) => [this.text(key), this.value(item)])) as T;
    }
    return input;
  }

  error(error: unknown): unknown {
    if (error instanceof Error) {
      const redacted = new Error(this.text(error.message));
      redacted.name = error.name;
      if (error.stack) redacted.stack = this.text(error.stack);
      return redacted;
    }
    return typeof error === 'string' ? this.text(error) : this.value(error);
  }
}
