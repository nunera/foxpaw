import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { BidiError, BidiFeatureUnavailableError, type BidiEvent } from '../../bidi.ts';
import type { ZenBrowser } from '../../browser.ts';
import type { Environment } from '../../config.ts';
import { dataDir } from '../../launch.ts';
import { readSettings } from '../../settings.ts';
import type { ToolFeature, ToolRuntime } from '../core.ts';

const EVENTS = ['browsingContext.downloadWillBegin', 'browsingContext.downloadEnd'];
const OWN_ACTIONS: Record<string, true> = { downloads: true, wait_download: true, launch: true };

export type DownloadsConfig = { redirect: boolean; directory?: string };
const configSchema = z.object({
  redirect: z.boolean().default(true),
  directory: z.string().min(1).optional(),
}).strict();

/** The `downloads` key of the settings file, with defaults. An invalid key is an error, never ignored. */
export function downloadsConfig(settings: Record<string, unknown> = readSettings()): DownloadsConfig {
  const parsed = configSchema.safeParse(settings.downloads ?? {});
  if (!parsed.success) throw new Error(`Invalid "downloads" settings: ${parsed.error.issues.map((issue) => `${issue.path.join('.') || 'downloads'}: ${issue.message}`).join('; ')}`);
  return parsed.data;
}

export type DownloadState = 'in_progress' | 'complete' | 'canceled';
type Download = {
  id: string; context: string; root: Promise<string | undefined>; url: string; suggestedFilename: string;
  state: DownloadState; path?: string; startedAt: number; endedAt?: number; claimed: boolean;
  /** Position in the sequence of actions and downloads, which orders them without relying on clock resolution. */
  sequence: number;
};
/** What tracking this browser allows: events at all, and whether downloads go to foxpaw's directory. */
type Tracking = { tracking: true; directory?: string; note?: string } | { tracking: false; reason: string };

export type DownloadsOptions = { env?: Environment; settings?: Record<string, unknown> };

/**
 * Tracks downloads (`browsingContext.downloadWillBegin`/`downloadEnd`) and, where the build supports
 * `browser.setDownloadBehavior`, sends them to a per-session directory under the foxpaw data dir instead of the
 * user's Downloads folder (reset when the session ends). `downloads` lists them; `wait_download` waits for the
 * download the previous action on a tab started.
 */
export function downloadsFeature(options: DownloadsOptions = {}): ToolFeature {
  const env = options.env ?? process.env;
  const config = downloadsConfig(options.settings ?? readSettings(env));
  const directory = config.directory ?? join(dataDir(env), 'downloads', `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`);
  const downloads = new Map<string, Download>();
  const waiters = new Set<() => void>();
  // The sequence number of the last action on each tab (and on any tab): a download that begins after it is that action's.
  let sequence = 0;
  const armed = new Map<string, number>();
  let lastAction = 0;
  let setup: Promise<Tracking> | undefined;
  let browser: ZenBrowser | undefined;
  let stopListening: (() => void) | undefined;
  let subscribed = false;
  let redirected = false;

  const record = (event: BidiEvent) => {
    if (!EVENTS.includes(event.method) || !browser) return;
    const { params } = event;
    const id = typeof params.download === 'string' ? params.download : undefined;
    const context = typeof params.context === 'string' ? params.context : undefined;
    if (!id || !context) return;
    let entry = downloads.get(id);
    if (!entry) {
      entry = {
        id, context, root: browser.rootOf(context).catch(() => undefined), url: typeof params.url === 'string' ? params.url : '',
        suggestedFilename: typeof params.suggestedFilename === 'string' ? params.suggestedFilename : '', state: 'in_progress', startedAt: Date.now(), claimed: false, sequence: ++sequence,
      };
      downloads.set(id, entry);
    }
    if (event.method === 'browsingContext.downloadEnd') {
      entry.state = params.status === 'canceled' ? 'canceled' : 'complete';
      if (typeof params.filepath === 'string') entry.path = params.filepath;
      entry.endedAt = Date.now();
    }
    for (const wake of [...waiters]) wake();
  };

  const start = (runtime: ToolRuntime) => setup ??= (async (): Promise<Tracking> => {
    browser = runtime.browser;
    stopListening ??= browser.onEvent(record);
    try {
      await browser.subscribe(EVENTS);
      subscribed = true;
    } catch (error) {
      // An older build rejects the event names; anything else (no browser yet) is retried on the next action.
      if (!(error instanceof BidiError)) throw error;
      return { tracking: false, reason: `This Zen/Firefox build does not report downloads (${error.error}).` };
    }
    if (!config.redirect) return { tracking: true, note: 'downloads.redirect is false: downloads go where the browser puts them.' };
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      await browser.bidi.commandOptional('browser.setDownloadBehavior', { downloadBehavior: { type: 'allowed', destinationFolder: directory } });
      redirected = true;
      return { tracking: true, directory };
    } catch (error) {
      if (!(error instanceof BidiFeatureUnavailableError)) throw error;
      return { tracking: true, note: 'This Zen/Firefox build does not support browser.setDownloadBehavior: downloads go where the browser puts them.' };
    }
  })().catch((error: unknown) => {
    setup = undefined;
    throw error;
  });

  const view = async (runtime: ToolRuntime, entry: Download) => {
    const root = await entry.root;
    return {
      id: entry.id,
      ...(root ? { tabId: runtime.tabId(root) } : {}),
      url: entry.url,
      suggestedFilename: entry.suggestedFilename,
      state: entry.state,
      ...(entry.path ? { path: entry.path } : {}),
      startedAt: new Date(entry.startedAt).toISOString(),
      ...(entry.endedAt ? { endedAt: new Date(entry.endedAt).toISOString() } : {}),
    };
  };

  return {
    name: 'downloads',
    description: [
      'Downloads: a click (or navigation) that starts a download is tracked. Call `wait_download` {tabId, timeoutMs} right after that action: it returns the first download the tab started since the previous action began, once it completes or is canceled, with `path` on disk. `downloads` {tabId?} lists this session\'s downloads (url, suggestedFilename, path, state).',
    ],
    actions: {
      async downloads(call, runtime) {
        const tracking = await start(runtime);
        const { params } = call;
        const root = params.tabId || params.target ? (await runtime.target(call.action, params.tabId, params.target)).context.id : undefined;
        const listed = [];
        for (const entry of downloads.values()) if (root === undefined || await entry.root === root) listed.push(await view(runtime, entry));
        return { details: { ...(root ? { tabId: runtime.tabId(root) } : {}), ...tracking, downloads: listed } };
      },
      async wait_download(call, runtime, signal) {
        const tracking = await start(runtime);
        if (!tracking.tracking) throw new Error(tracking.reason);
        const { params } = call;
        const { context, tabId } = await runtime.target(call.action, params.tabId, params.target);
        const since = armed.get(tabId) ?? lastAction;
        const timeoutMs = params.timeoutMs ?? 10_000;
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          let candidate: Download | undefined;
          for (const entry of downloads.values()) {
            if (!entry.claimed && entry.sequence > since && await entry.root === context.id) { candidate = entry; break; }
          }
          if (candidate && candidate.state !== 'in_progress') {
            candidate.claimed = true;
            return { details: { tabId, download: await view(runtime, candidate) } };
          }
          const remaining = deadline - Date.now();
          if (remaining <= 0 || signal?.aborted) {
            throw new Error(JSON.stringify({
              tabId, action: call.action, waitCompleted: false,
              error: candidate ? `The download of ${candidate.suggestedFilename || candidate.url} did not finish within ${timeoutMs} ms.` : `No download started in ${tabId} within ${timeoutMs} ms of the previous action.`,
              ...(candidate ? { download: await view(runtime, candidate) } : {}),
            }));
          }
          const woke = Promise.withResolvers<void>();
          const wake = () => woke.resolve();
          const timer = setTimeout(wake, remaining);
          waiters.add(wake);
          signal?.addEventListener('abort', wake, { once: true });
          try { await woke.promise; } finally {
            clearTimeout(timer);
            waiters.delete(wake);
            signal?.removeEventListener('abort', wake);
          }
        }
      },
    },
    async before(call, runtime) {
      if (OWN_ACTIONS[call.action]) return;
      lastAction = ++sequence;
      if (typeof call.params.tabId === 'string') armed.set(call.params.tabId, lastAction);
      // Tracking must be on before the action that triggers a download; failing to start it never refuses the action.
      await start(runtime).catch(() => undefined);
    },
    async shutdown() {
      stopListening?.();
      if (!browser) return;
      if (redirected) await browser.bidi.commandOptional('browser.setDownloadBehavior', { downloadBehavior: null }).catch(() => undefined);
      if (subscribed) await browser.unsubscribe(EVENTS).catch(() => undefined);
    },
  };
}
