import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import autoconfigPrefs from '../autoconfig/defaults/pref/foxpaw-autoconfig.js' with { type: 'text' };
import autoconfigCfg from '../autoconfig/foxpaw.cfg' with { type: 'text' };
import { firefoxBidiUrl, type Environment } from './config.ts';

/** Remote control started from inside the browser (no --remote-debugging-port) always listens here. */
export const DYNAMIC_PORT = 9222;
/** Environment variable the foxpaw AutoConfig checks before starting remote control. */
export const DYNAMIC_ENV = 'FOXPAW_REMOTE_CONTROL';
const MARKER = '.foxpaw';

export type LaunchMode = 'flag' | 'dynamic';
export type LaunchOptions = {
  /** Browser executable. Default: FIREFOX_BIDI_BROWSER, then the first Zen or Firefox found. */
  browser?: string;
  /** Profile directory. Default: FIREFOX_BIDI_PROFILE, then foxpaw's own profile. */
  profile?: string;
  /** `flag` passes --remote-debugging-port (pages see navigator.webdriver = true). `dynamic` relies on the
   * foxpaw AutoConfig to start remote control from inside the browser, which leaves it false. */
  mode?: LaunchMode;
  headless?: boolean;
  timeoutMs?: number;
  env?: Environment;
};
export type LaunchResult = {
  /** WebDriver BiDi endpoint to connect to. */
  url: string;
  /** False when something already listened on the port, so nothing was started. */
  started: boolean;
  browser?: string;
  profile?: string;
  mode?: LaunchMode;
  pid?: number;
  log?: string;
};

export class ProfileInUseError extends Error {
  constructor(readonly profile: string, readonly pid: number) {
    super(`Profile ${profile} is open in another browser process (pid ${pid}). Quit that browser first: starting the same profile again only opens a window in the running process and ignores the remote-control flag.`);
    this.name = 'ProfileInUseError';
  }
}

/** Where foxpaw keeps its own profile and logs. */
export function dataDir(env: Environment = process.env): string {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'foxpaw');
  if (process.platform === 'win32') return join(env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'foxpaw');
  return join(env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'foxpaw');
}
export const defaultProfileDir = (env: Environment = process.env): string => join(dataDir(env), 'profile');

const PATH_CANDIDATES = ['zen-twilight', 'zen-browser', 'zen', 'firefox', 'firefox-developer-edition', 'firefox-nightly', 'firefox-esr'];
const APP_CANDIDATES: Partial<Record<NodeJS.Platform, string[]>> = {
  darwin: ['/Applications/Zen.app/Contents/MacOS/zen', '/Applications/Twilight.app/Contents/MacOS/zen', '/Applications/Firefox.app/Contents/MacOS/firefox', '/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox', '/Applications/Firefox Nightly.app/Contents/MacOS/firefox'],
  win32: ['C:\\Program Files\\Zen Browser\\zen.exe', 'C:\\Program Files\\Zen Twilight\\zen.exe', 'C:\\Program Files\\Mozilla Firefox\\firefox.exe', 'C:\\Program Files\\Firefox Developer Edition\\firefox.exe'],
};

/** The browser to launch: FIREFOX_BIDI_BROWSER, else the first Zen or Firefox on PATH or in the usual install places. */
export function findBrowser(env: Environment = process.env): string | undefined {
  const configured = env.FIREFOX_BIDI_BROWSER;
  if (configured) return configured.includes('/') || configured.includes('\\') ? configured : onPath(configured, env) ?? configured;
  for (const name of PATH_CANDIDATES) {
    const found = onPath(name, env);
    if (found) return found;
  }
  return APP_CANDIDATES[process.platform]?.find((path) => existsSync(path));
}

function onPath(name: string, env: Environment): string | undefined {
  const extensions = process.platform === 'win32' ? ['.exe', ''] : [''];
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const extension of extensions) {
      const candidate = join(dir, name + extension);
      try { if (statSync(candidate).isFile()) return candidate; } catch { /* not here */ }
    }
  }
  return undefined;
}

/**
 * The pid holding a profile, or undefined. Firefox and Zen on Linux keep a `lock` symlink to `<host>:+<pid>` while the
 * profile is open. Other platforms lock with fcntl/file handles that can't be read this way; there this returns undefined.
 */
export function profileLockOwner(profile: string): number | undefined {
  let target: string;
  try { target = readlinkSync(join(profile, 'lock')); } catch { return undefined; }
  const pid = Number(/\+(\d+)$/.exec(target)?.[1]);
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try { process.kill(pid, 0); return pid; } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM' ? pid : undefined;     // alive, owned by someone else
  }
}

export function isListening(port: number, host = '127.0.0.1', timeoutMs = 500): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const socket = createConnection({ host, port });
  const done = (result: boolean) => { socket.destroy(); resolve(result); };
  socket.setTimeout(timeoutMs, () => done(false));
  socket.once('connect', () => done(true));
  socket.once('error', () => done(false));
  return promise;
}

/** Prefs for foxpaw's own profile only; a profile the user brings is never edited. */
const PROFILE_PREFS: Record<string, boolean | string> = {
  'browser.shell.checkDefaultBrowser': false,
  'browser.aboutwelcome.enabled': false,
  'browser.startup.homepage_override.mstone': 'ignore',
  'datareporting.policy.dataSubmissionPolicyBypassNotification': true,
  'zen.welcome-screen.seen': true,
  // A window waiting behind other windows still runs its timers at full speed.
  'dom.timeout.enable_budget_timer_throttling': false,
};

function prepareProfile(profile: string, managed: boolean): void {
  if (!managed) {
    if (!existsSync(profile)) throw new Error(`Profile directory ${profile} does not exist`);
    return;
  }
  mkdirSync(profile, { recursive: true });
  writeFileSync(join(profile, MARKER), 'Profile created by foxpaw. Sign in to the sites the agent should use here.\n');
  const lines = Object.entries(PROFILE_PREFS).map(([name, value]) => `user_pref(${JSON.stringify(name)}, ${JSON.stringify(value)});`);
  writeFileSync(join(profile, 'user.js'), `// Written by foxpaw at every launch of its own profile.\n${lines.join('\n')}\n`);
}

/** Keeps the browser out of the caller's systemd scope, so closing the terminal (or the agent) leaves it running. */
function ownScope(command: string[], env: Environment): string[] {
  if (process.platform !== 'linux') return command;
  const systemdRun = onPath('systemd-run', env);
  const runtime = env.XDG_RUNTIME_DIR;
  if (!systemdRun || !runtime || !existsSync(join(runtime, 'bus'))) return command;
  return [systemdRun, '--user', '--scope', '--quiet', '--collect', ...command];
}

/**
 * Start a Zen or Firefox that foxpaw can drive, next to the user's everyday browser: its own process (`--new-instance`)
 * and, by default, foxpaw's own profile, which the user signs in to once. If something already listens on the BiDi
 * port, nothing is started.
 */
export async function launchBrowser(options: LaunchOptions = {}): Promise<LaunchResult> {
  const env = options.env ?? process.env;
  const mode = options.mode ?? (env.FIREFOX_BIDI_LAUNCH === 'dynamic' ? 'dynamic' : 'flag');
  const url = firefoxBidiUrl(env);
  const endpoint = new URL(url);
  const port = Number(endpoint.port || DYNAMIC_PORT);
  if (mode === 'dynamic' && port !== DYNAMIC_PORT) throw new Error(`Dynamic remote control always listens on ${DYNAMIC_PORT}; FIREFOX_BIDI_URL points at ${port}`);
  if (await isListening(port, endpoint.hostname === 'localhost' ? '127.0.0.1' : endpoint.hostname)) return { url, started: false };

  const browser = options.browser ?? findBrowser(env);
  if (!browser) throw new Error('No Zen or Firefox found. Install one, or set FIREFOX_BIDI_BROWSER to the browser executable.');
  const defaultProfile = defaultProfileDir(env);
  const profile = options.profile ?? env.FIREFOX_BIDI_PROFILE ?? defaultProfile;
  const managed = profile === defaultProfile || existsSync(join(profile, MARKER)) || !existsSync(profile);
  const owner = profileLockOwner(profile);
  if (owner !== undefined) throw new ProfileInUseError(profile, owner);
  prepareProfile(profile, managed);

  const args = ['--new-instance', '--profile', profile];
  // Its own window class keeps foxpaw's browser apart from the everyday one (Linux remoting and window rules).
  if (managed && process.platform === 'linux') args.push('--name', 'foxpaw', '--class', 'foxpaw');
  if (mode === 'flag') args.push(`--remote-debugging-port=${port}`);
  if (options.headless) args.push('--headless');

  mkdirSync(dataDir(env), { recursive: true });
  const log = join(dataDir(env), 'browser.log');
  const output = openSync(log, 'a');
  const [command, ...rest] = ownScope([browser, ...args], env);
  const child = spawn(command!, rest, {
    detached: true,
    stdio: ['ignore', output, output],
    env: { ...env, ...(mode === 'dynamic' ? { [DYNAMIC_ENV]: '1' } : {}) },
  });
  let exit: string | undefined;
  child.once('exit', (code, signal) => { exit = signal ? `signal ${signal}` : `exit code ${code}`; });
  child.once('error', (error) => { exit = error.message; });
  child.unref();

  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  while (Date.now() < deadline) {
    if (await isListening(port)) return { url, started: true, browser, profile, mode, pid: child.pid, log };
    if (exit !== undefined) throw new Error(`${browser} stopped before remote control started (${exit}); see ${log}`);
    await sleep(200);
  }
  if (mode === 'dynamic') {
    child.kill();
    throw new Error(`${browser} started but remote control did not come up on ${port}. Dynamic mode needs the foxpaw AutoConfig in the browser's install directory: run \`foxpaw autoconfig install\` (on Nix, build the browser with foxpaw.lib.wrapFirefoxArgs or foxpaw.lib.withRemoteControl), or launch without --dynamic.`);
  }
  throw new Error(`${browser} did not open remote control on ${port} within ${Math.round((options.timeoutMs ?? 30_000) / 1000)}s; see ${log}`);
}

/** The AutoConfig, embedded so a compiled foxpaw binary carries it too. */
export const AUTOCONFIG = { prefs: autoconfigPrefs, cfg: autoconfigCfg } as const;

/**
 * The directory AutoConfig is read from: the one holding `omni.ja`, next to the real browser binary (symlinks resolved).
 * Returns undefined when the executable is a wrapper script (Nix, Flatpak); install the files with the package then.
 */
export function browserAppDir(browser: string): string | undefined {
  let real: string;
  try { real = realpathSync(browser); } catch { return undefined; }
  const candidates = [dirname(real), join(dirname(real), '..', 'Resources')];     // Linux/Windows; macOS bundles
  return candidates.find((dir) => existsSync(join(dir, 'omni.ja')));
}

/** Write the foxpaw AutoConfig into a browser's install directory. Refuses one that already uses another AutoConfig file. */
export function installAutoconfig(appDir: string): string[] {
  const prefsDir = join(appDir, 'defaults', 'pref');
  for (const file of existsSync(prefsDir) ? readdirSync(prefsDir) : []) {
    if (file === 'foxpaw-autoconfig.js' || !file.endsWith('.js')) continue;
    const text = readFileSync(join(prefsDir, file), 'utf8');
    if (text.includes('general.config.filename')) throw new Error(`${join(prefsDir, file)} already names an AutoConfig file, and a browser reads only one. Append the output of \`foxpaw autoconfig print\` (without its first line) to the file it names instead.`);
  }
  mkdirSync(prefsDir, { recursive: true });
  const written = [join(prefsDir, 'foxpaw-autoconfig.js'), join(appDir, 'foxpaw.cfg')];
  writeFileSync(written[0]!, AUTOCONFIG.prefs);
  writeFileSync(written[1]!, AUTOCONFIG.cfg);
  return written;
}
