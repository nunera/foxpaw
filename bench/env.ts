import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { isListening, launchBrowser, type LaunchResult } from '../src/launch.ts';
import type { SiteName } from './fixtures/server.ts';
import { SECRET_NAME, UPLOAD_CONTENT } from './tasks.ts';

/**
 * Everything a benchmark run touches lives in one temp directory: data, runtime, state, and config dirs, the browser
 * profile, downloads, and the approval log. BiDi and broker ports are random free ports, so a run never meets the
 * user's browser, broker, or settings.
 */
export type BenchEnv = {
  root: string;
  /** The variables foxpaw reads, pointing into `root`. foxpaw reads the broker URL at import: put these in process.env before importing src/tool. */
  vars: Record<string, string>;
  downloadDir: string;
  uploadFile: string;
  /** Writes foxpaw's config for one task: approvals go to the bench approver, the login secret is for site a only,
   * downloads go to `downloadDir`. Features that read their key once read it when the tool is created. */
  configure(origins: Record<SiteName, string>, approver: 'approve' | 'deny'): void;
  /** Approval requests logged since the last `configure`. */
  approvals(): number;
  launch(browser?: string): Promise<LaunchResult>;
  stopBrowser(): Promise<void>;
  cleanup(): Promise<void>;
};

const APPROVER = fileURLToPath(new URL('./approver.ts', import.meta.url));
export const LOGIN_PASSWORD_VAR = 'FOXPAW_BENCH_LOGIN_PASSWORD';

async function freePort(): Promise<number> {
  const server = createServer();
  const listening = Promise.withResolvers<void>();
  server.once('error', listening.reject);
  server.listen(0, '127.0.0.1', listening.resolve);
  await listening.promise;
  const { port } = server.address() as { port: number };
  const closed = Promise.withResolvers<void>();
  server.close(() => closed.resolve());
  await closed.promise;
  return port;
}

// Prefs for the throwaway profile: no first-run pages, downloads saved silently into the run's download directory.
const prefs = (downloadDir: string): Record<string, string | number | boolean> => ({
  'browser.shell.checkDefaultBrowser': false,
  'browser.aboutwelcome.enabled': false,
  'browser.startup.homepage_override.mstone': 'ignore',
  'datareporting.policy.dataSubmissionPolicyBypassNotification': true,
  'zen.welcome-screen.seen': true,
  'dom.timeout.enable_budget_timer_throttling': false,
  'browser.download.folderList': 2,
  'browser.download.dir': downloadDir,
  'browser.download.useDownloadDir': true,
  'browser.download.always_ask_before_handling_new_types': false,
  'browser.download.start_downloads_in_tmp_dir': false,
  'browser.download.alwaysOpenPanel': false,
  'app.update.enabled': false,
  'network.captive-portal-service.enabled': false,
  'network.connectivity-service.enabled': false,
});

export async function createBenchEnv(passwordValue: string): Promise<BenchEnv> {
  const root = mkdtempSync(join(tmpdir(), 'foxpaw-bench-'));
  const dir = (name: string) => { const path = join(root, name); mkdirSync(path, { recursive: true, mode: 0o700 }); return path; };
  const [bidiPort, brokerPort] = [await freePort(), await freePort()];
  const vars: Record<string, string> = {
    XDG_DATA_HOME: dir('data'),
    XDG_RUNTIME_DIR: dir('runtime'),
    XDG_STATE_HOME: dir('state'),
    XDG_CONFIG_HOME: dir('config'),
    FOXPAW_CONFIG: join(root, 'config', 'config.json'),
    FIREFOX_BIDI_URL: `ws://127.0.0.1:${bidiPort}/session`,
    FIREFOX_BIDI_BROKER_URL: `ws://127.0.0.1:${brokerPort}`,
    [LOGIN_PASSWORD_VAR]: passwordValue,
  };
  const downloadDir = dir('downloads');
  const profile = dir('profile');
  const home = dir('home');
  // A profile foxpaw didn't create (no .foxpaw marker) is used as is, so these prefs stay.
  writeFileSync(join(profile, 'user.js'), Object.entries(prefs(downloadDir)).map(([name, value]) => `user_pref(${JSON.stringify(name)}, ${JSON.stringify(value)});`).join('\n') + '\n');
  const uploadFile = join(dir('files'), 'notes.txt');
  writeFileSync(uploadFile, UPLOAD_CONTENT);
  const approvalsLog = join(root, 'approvals.jsonl');
  let browser: LaunchResult | undefined;

  const stopBrowser = async () => {
    if (!browser?.pid) return;
    const { pid } = browser;
    browser = undefined;
    try { process.kill(pid, 'SIGTERM'); } catch { return; }
    for (let waited = 0; waited < 10_000; waited += 100) {
      try { process.kill(pid, 0); } catch { break; }
      await sleep(100);
    }
    try { process.kill(pid, 'SIGKILL'); } catch {}
    while (await isListening(bidiPort)) await sleep(100);
  };

  return {
    root,
    vars,
    downloadDir,
    uploadFile,
    configure(origins, approver) {
      writeFileSync(approvalsLog, '');
      writeFileSync(vars.FOXPAW_CONFIG!, JSON.stringify({
        policy: { approval: { method: 'command', command: [process.execPath, APPROVER, approvalsLog, approver], timeoutMs: 10_000 } },
        secrets: { [SECRET_NAME]: { source: `env:${LOGIN_PASSWORD_VAR}`, origins: [origins.a] } },
        downloads: { directory: downloadDir },
      }, null, 2));
    },
    approvals: () => existsSync(approvalsLog) ? readFileSync(approvalsLog, 'utf8').split('\n').filter(Boolean).length : 0,
    async launch(executable) {
      if (await isListening(bidiPort)) throw new Error(`port ${bidiPort} is taken`);
      browser = await launchBrowser({ browser: executable, profile, headless: true, mode: 'flag', env: { ...process.env, ...vars, HOME: home }, timeoutMs: 60_000 });
      return browser;
    },
    stopBrowser,
    async cleanup() {
      await stopBrowser();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
