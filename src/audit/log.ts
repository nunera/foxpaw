import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Environment } from '../config.ts';
import { readSettings, stateDir } from '../settings.ts';

/**
 * The audit log: one JSON line per zen_browser action (success, failure, refusal) in
 * `stateDir()/audit/YYYY-MM-DD.jsonl` (local date), screenshots in `stateDir()/audit/YYYY-MM-DD/`.
 * Entries never hold what was typed: see `redactParams`.
 */
export type Host = 'omp' | 'mcp' | 'cli' | 'unknown';
export type AuditConfig = { enabled: boolean; screenshots: 'none' | 'writes' | 'all'; retainDays: number };

const configSchema = z.object({
  enabled: z.boolean().default(true),
  screenshots: z.enum(['none', 'writes', 'all']).default('writes'),
  retainDays: z.number().int().positive().default(30),
}).strict();

/** The `audit` key of the settings file, with defaults. An invalid key is an error, never ignored. */
export function auditConfig(settings: Record<string, unknown> = readSettings()): AuditConfig {
  const parsed = configSchema.safeParse(settings.audit ?? {});
  if (!parsed.success) throw new Error(`Invalid "audit" settings: ${parsed.error.issues.map((issue) => `${issue.path.join('.') || 'audit'}: ${issue.message}`).join('; ')}`);
  return parsed.data;
}

export function auditDir(env: Environment = process.env): string {
  return join(stateDir(env), 'audit');
}

/** What an element action acted on. Never a field's contents. */
export type AuditTarget = {
  selector: string; tag: string; type?: string; role: string | null; name: string | null; text?: string;
  frameUrl?: string; form?: { action: string; method: string };
};
export type AuditResult = {
  actionPerformed?: boolean; verified?: boolean; waitCompleted?: boolean | null; navigation?: boolean;
  failedStepIndex?: number; openedTabId?: string; openPrompt?: string; error?: string;
  policy?: { decision?: string; reason?: string };
};
export type AuditEntry = {
  time: string;
  session: string;
  host: Host;
  seq: number;
  action: string;
  tabId?: string;
  urlBefore?: string;
  urlAfter?: string;
  documentChanged?: boolean;
  target?: AuditTarget;
  /** batch: one target per step (null when the step names no element or it could not be described). */
  stepTargets?: Array<AuditTarget | null>;
  params: Record<string, unknown>;
  outcome: 'ok' | 'failed' | 'refused';
  result: AuditResult;
  screenshots?: { before?: string; after?: string; beforeSkipped?: string; afterSkipped?: string };
  durationMs: number;
};

/** Marker that replaces a typed value: its length only. */
export type Redacted = { $redacted: number };
export const isRedacted = (value: unknown): value is Redacted => Boolean(value && typeof value === 'object' && !Array.isArray(value) && typeof (value as Redacted).$redacted === 'number' && Object.keys(value).length === 1);
const VALUE_ACTIONS: Record<string, true> = { fill: true, type: true, select: true };

/**
 * Params as logged: values of fill/type/select (also inside fill_many/select_many `fields` and batch steps),
 * `promptText`, and `expression` become `{ $redacted: length }`. `fill_secret` carries only the secret's name.
 * Also returns the raw strings removed, so error messages that echo them can be scrubbed.
 */
export function redactParams(params: Record<string, unknown>): { params: Record<string, unknown>; removed: string[] } {
  const removed: string[] = [];
  const hide = (value: unknown) => {
    if (typeof value !== 'string') return value;
    removed.push(value);
    return { $redacted: value.length } satisfies Redacted;
  };
  const out: Record<string, unknown> = { ...params };
  for (const key of ['promptText', 'expression']) if (key in out) out[key] = hide(out[key]);
  const action = String(params.action);
  if (VALUE_ACTIONS[action]) for (const key of ['value', 'text']) if (key in out) out[key] = hide(out[key]);
  if ((action === 'fill_many' || action === 'select_many') && out.fields && typeof out.fields === 'object') {
    out.fields = Object.fromEntries(Object.entries(out.fields as Record<string, unknown>).map(([selector, value]) => [selector, hide(value)]));
  }
  if (Array.isArray(out.batch)) {
    out.batch = out.batch.map((step: unknown) => {
      if (!step || typeof step !== 'object') return step;
      const copy = { ...(step as Record<string, unknown>) };
      if (copy.action === 'fill' || copy.action === 'select') for (const key of ['value', 'text']) if (key in copy) copy[key] = hide(copy[key]);
      return copy;
    });
  }
  return { params: out, removed };
}

/** Replaces every occurrence of a removed value (4+ characters) in a message, raw or JSON-escaped. */
export function scrub(text: string, removed: string[]): string {
  let out = text;
  for (const value of removed) {
    if (value.length < 4) continue;
    for (const form of new Set([value, JSON.stringify(value).slice(1, -1)])) out = out.split(form).join(`[redacted ${value.length} chars]`);
  }
  return out;
}

const pad = (value: number) => String(value).padStart(2, '0');
export const localDate = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const DATED = /^(\d{4}-\d{2}-\d{2})(\.jsonl)?$/;

/** Owner-only append-only writer for one directory. */
export class AuditLog {
  constructor(readonly dir: string, private readonly now: () => Date = () => new Date()) {}

  #ensureDir(path: string): void {
    if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
    chmodSync(path, 0o700);
  }

  append(entry: AuditEntry): void {
    this.#ensureDir(this.dir);
    const file = join(this.dir, `${localDate(new Date(entry.time))}.jsonl`);
    const created = !existsSync(file);
    appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    if (created) chmodSync(file, 0o600);
  }

  /** Saves a base64 PNG next to the day's log and returns its path. */
  saveScreenshot(name: string, base64: string): string {
    const day = join(this.dir, localDate(this.now()));
    this.#ensureDir(this.dir);
    this.#ensureDir(day);
    const path = join(day, `${name}.png`);
    writeFileSync(path, Buffer.from(base64, 'base64'), { mode: 0o600 });
    return path;
  }

  /** Removes day logs and screenshot directories older than `retainDays`. Returns what was removed. */
  prune(retainDays: number): string[] {
    if (!existsSync(this.dir)) return [];
    const cutoff = new Date(this.now());
    cutoff.setDate(cutoff.getDate() - retainDays);
    const keepFrom = localDate(cutoff);
    const removed: string[] = [];
    for (const name of readdirSync(this.dir)) {
      const day = DATED.exec(name)?.[1];
      if (!day || day >= keepFrom) continue;
      rmSync(join(this.dir, name), { recursive: true, force: true });
      removed.push(name);
    }
    return removed;
  }
}

export type LogFilter = { since?: number; session?: string; tab?: string; action?: string };

/** `2h`, `30m`, `45s`, `7d` (ago), a local date `2026-11-26` (its midnight), or any Date-parsable time. */
export function parseSince(value: string, now = new Date()): number {
  const relative = /^(\d+)\s*([smhd])$/.exec(value.trim());
  if (relative) return now.getTime() - Number(relative[1]) * { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[relative[2] as 's' | 'm' | 'h' | 'd'];
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (day) return new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])).getTime();
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new Error(`--since ${JSON.stringify(value)}: use 2h, 30m, 7d, a date (2026-11-26), or an ISO time`);
  return parsed;
}

export function matches(entry: AuditEntry, filter: LogFilter): boolean {
  if (filter.since !== undefined && Date.parse(entry.time) < filter.since) return false;
  if (filter.session && !entry.session.startsWith(filter.session)) return false;
  if (filter.tab && entry.tabId !== filter.tab) return false;
  if (filter.action && entry.action !== filter.action) return false;
  return true;
}

const parseLine = (line: string): AuditEntry | undefined => {
  if (!line.trim()) return undefined;
  try { return JSON.parse(line) as AuditEntry; } catch { return undefined; }
};

/** Entries from every day file that can contain matches, oldest first. Unparsable lines are skipped. */
export function readEntries(dir: string, filter: LogFilter = {}): AuditEntry[] {
  if (!existsSync(dir)) return [];
  const fromDay = filter.since === undefined ? '' : localDate(new Date(filter.since));
  return readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl') && DATED.test(name) && name.slice(0, 10) >= fromDay)
    .sort()
    .flatMap((name) => readFileSync(join(dir, name), 'utf8').split('\n').map(parseLine))
    .filter((entry): entry is AuditEntry => entry !== undefined && matches(entry, filter));
}

/**
 * Calls `onEntry` for every matching line appended to today's file from now on, switching files at midnight.
 * Polls every `intervalMs` until `signal` aborts.
 */
export async function followEntries(dir: string, filter: LogFilter, onEntry: (entry: AuditEntry) => void, signal: AbortSignal, intervalMs = 500, now: () => Date = () => new Date()): Promise<void> {
  const sizeOf = (path: string) => { try { return statSync(path).size; } catch { return 0; } };
  let file = join(dir, `${localDate(now())}.jsonl`);
  let offset = sizeOf(file);
  let partial = '';
  const poll = () => {
    const current = join(dir, `${localDate(now())}.jsonl`);
    if (current !== file) { drain(); file = current; offset = 0; partial = ''; }
    drain();
  };
  const drain = () => {
    const size = sizeOf(file);
    if (size <= offset) return;
    const fd = openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(size - offset);
      readSync(fd, buffer, 0, buffer.length, offset);
      offset = size;
      const lines = (partial + buffer.toString('utf8')).split('\n');
      partial = lines.pop() ?? '';
      for (const entry of lines.map(parseLine)) if (entry && matches(entry, filter)) onEntry(entry);
    } finally { closeSync(fd); }
  };
  const stopped = Promise.withResolvers<void>();
  const timer = setInterval(poll, intervalMs);
  signal.addEventListener('abort', () => { clearInterval(timer); poll(); stopped.resolve(); }, { once: true });
  if (signal.aborted) { clearInterval(timer); stopped.resolve(); }
  await stopped.promise;
}

const shorten = (text: string, max: number) => text.length > max ? `${text.slice(0, max - 1)}…` : text;

export function describeTarget(entry: AuditEntry): string {
  const target = entry.target;
  if (target) return target.role && target.name ? `${target.role} "${target.name}"` : target.selector;
  const params = entry.params;
  if (typeof params.url === 'string') return params.url;
  if (typeof params.secret === 'string') return `secret ${params.secret}`;
  if (typeof params.selector === 'string') return params.selector;
  if (typeof params.key === 'string') return `key ${params.key}`;
  if (Array.isArray(params.batch)) return `${params.batch.length} steps`;
  return '';
}

export function describeOutcome(entry: AuditEntry): string {
  const result = entry.result;
  if (entry.outcome !== 'ok') return `${entry.outcome}: ${result.error ?? 'unknown error'}`;
  const notes = [
    result.verified === false ? 'unverified' : '',
    result.waitCompleted === false ? 'wait failed' : '',
    result.failedStepIndex !== undefined ? `stopped at step ${result.failedStepIndex}` : '',
    result.openPrompt ? `dialog ${result.openPrompt}` : '',
    entry.urlAfter && entry.urlAfter !== entry.urlBefore ? `→ ${entry.urlAfter}` : '',
  ].filter(Boolean);
  return ['ok', ...notes].join(', ');
}

/** The readable `foxpaw log` table. */
export function formatTable(entries: AuditEntry[], now = new Date()): string {
  const today = localDate(now);
  const rows = entries.map((entry) => {
    const time = new Date(entry.time);
    const clock = `${pad(time.getHours())}:${pad(time.getMinutes())}:${pad(time.getSeconds())}`;
    return [localDate(time) === today ? clock : `${localDate(time)} ${clock}`, entry.session.slice(0, 8), String(entry.seq), entry.action, entry.tabId ?? '', shorten(describeTarget(entry), 48), shorten(describeOutcome(entry), 80)];
  });
  const header = ['TIME', 'SESSION', 'SEQ', 'ACTION', 'TAB', 'TARGET', 'OUTCOME'];
  const widths = header.map((title, column) => Math.max(title.length, ...rows.map((row) => row[column]!.length)));
  return [header, ...rows].map((row) => row.map((cell, column) => column === row.length - 1 ? cell : cell.padEnd(widths[column]!)).join('  ')).join('\n');
}

const LOG_USAGE = 'Usage: foxpaw log [--since 2h|2026-11-26] [--session ID] [--tab tab_3] [--action click] [--json] [--follow]';

/** `foxpaw log`. Without --since it shows today's entries. */
export async function logCommand(args: string[], env: Environment = process.env): Promise<void> {
  const filter: LogFilter = {};
  let json = false;
  let follow = false;
  let since: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    const value = () => { const next = args[++index]; if (!next) throw new Error(`${flag} needs a value\n${LOG_USAGE}`); return next; };
    if (flag === '--since') since = value();
    else if (flag === '--session') filter.session = value();
    else if (flag === '--tab') filter.tab = value();
    else if (flag === '--action') filter.action = value();
    else if (flag === '--json') json = true;
    else if (flag === '--follow' || flag === '-f') follow = true;
    else throw new Error(`Unknown option ${flag}\n${LOG_USAGE}`);
  }
  filter.since = since === undefined ? parseSince(localDate(new Date())) : parseSince(since);
  const dir = auditDir(env);
  const entries = readEntries(dir, filter);
  if (json) for (const entry of entries) process.stdout.write(`${JSON.stringify(entry)}\n`);
  else if (entries.length) console.log(formatTable(entries));
  else if (!follow) console.log(`No audit entries${since ? ` since ${since}` : ' today'} in ${dir}.`);
  if (!follow) return;
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  let printedHeader = entries.length > 0;
  await followEntries(dir, filter, (entry) => {
    if (json) { process.stdout.write(`${JSON.stringify(entry)}\n`); return; }
    const table = formatTable([entry]).split('\n');
    if (!printedHeader) { console.log(table[0]); printedHeader = true; }
    console.log(table[1]);
  }, controller.signal);
}
