import { afterEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findBrowser, installAutoconfig, launchBrowser, profileLockOwner, ProfileInUseError } from '../src/launch.ts';

const started: number[] = [];
afterEach(() => { for (const pid of started.splice(0)) { try { process.kill(pid); } catch { /* already gone */ } } });

function freePort(): number {
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response() });
  const port = server.port as number;
  server.stop(true);
  return port;
}

/** A stand-in browser: records its arguments, then listens on the --remote-debugging-port it was given (or exits). */
function fakeBrowser(dir: string, behavior: 'listen' | 'exit'): string {
  const path = join(dir, 'firefox');
  writeFileSync(path, `#!${process.execPath}
await Bun.write(process.env.FAKE_ARGS, JSON.stringify(process.argv.slice(2)));
${behavior === 'exit' ? 'process.exit(0);' : `
const flag = process.argv.find((arg) => arg.startsWith('--remote-debugging-port='));
Bun.serve({ hostname: '127.0.0.1', port: Number(flag.split('=')[1]), fetch: () => new Response('') });
setTimeout(() => process.exit(0), 20_000);`}
`);
  chmodSync(path, 0o755);
  return path;
}

function setup(behavior: 'listen' | 'exit') {
  const root = mkdtempSync(join(tmpdir(), 'foxpaw-launch-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const browser = fakeBrowser(bin, behavior);
  const port = freePort();
  const args = join(root, 'args.json');
  const env = { PATH: bin, XDG_DATA_HOME: join(root, 'data'), FIREFOX_BIDI_URL: `ws://127.0.0.1:${port}/session`, FAKE_ARGS: args };
  return { root, browser, port, env, args: () => JSON.parse(readFileSync(args, 'utf8')) as string[] };
}

test('launches its own profile in a new instance and waits for remote control', async () => {
  const { root, browser, port, env, args } = setup('listen');
  const result = await launchBrowser({ env, timeoutMs: 10_000 });
  started.push(result.pid!);
  const profile = join(root, 'data', 'foxpaw', 'profile');
  expect(result).toMatchObject({ started: true, browser, profile, mode: 'flag', url: `ws://127.0.0.1:${port}/session` });
  expect(args()).toEqual(['--new-instance', '--profile', profile, ...(process.platform === 'linux' ? ['--name', 'foxpaw', '--class', 'foxpaw'] : []), `--remote-debugging-port=${port}`]);
  expect(readFileSync(join(profile, 'user.js'), 'utf8')).toContain('"browser.shell.checkDefaultBrowser", false');

  // Something listens now: a second launch starts nothing.
  expect(await launchBrowser({ env })).toEqual({ url: `ws://127.0.0.1:${port}/session`, started: false });
});

test('never edits a profile the user brings, and refuses one that is open', async () => {
  const { root, env } = setup('listen');
  const profile = join(root, 'everyday');
  mkdirSync(profile);
  symlinkSync(`127.0.0.1:+${process.pid}`, join(profile, 'lock'));
  expect(profileLockOwner(profile)).toBe(process.pid);
  await expect(launchBrowser({ env, profile })).rejects.toBeInstanceOf(ProfileInUseError);
  expect(existsSync(join(profile, 'user.js'))).toBe(false);
});

test('a lock left by a process that is gone does not count', () => {
  const profile = mkdtempSync(join(tmpdir(), 'foxpaw-lock-'));
  const gone = Bun.spawnSync([process.execPath, '-e', 'console.log(process.pid)']).stdout.toString().trim();
  symlinkSync(`127.0.0.1:+${gone}`, join(profile, 'lock'));
  expect(profileLockOwner(profile)).toBeUndefined();
});

test('reports a browser that exits instead of opening remote control', async () => {
  const { env } = setup('exit');
  await expect(launchBrowser({ env, timeoutMs: 10_000 })).rejects.toThrow('stopped before remote control started (exit code 0)');
});

test('finds the configured browser before searching PATH', () => {
  const { browser, env } = setup('listen');
  expect(findBrowser(env)).toBe(browser);
  expect(findBrowser({ ...env, FIREFOX_BIDI_BROWSER: '/opt/zen/zen' })).toBe('/opt/zen/zen');
});

test('installs the AutoConfig into a browser directory, but not over another AutoConfig', () => {
  const app = mkdtempSync(join(tmpdir(), 'foxpaw-app-'));
  mkdirSync(join(app, 'defaults', 'pref'), { recursive: true });
  writeFileSync(join(app, 'defaults', 'pref', 'channel-prefs.js'), 'pref("app.update.channel", "release");\n');
  installAutoconfig(app);
  expect(readFileSync(join(app, 'defaults', 'pref', 'foxpaw-autoconfig.js'), 'utf8')).toContain('"foxpaw.cfg"');
  expect(readFileSync(join(app, 'foxpaw.cfg'), 'utf8')).toContain('FOXPAW_REMOTE_CONTROL');

  const managed = mkdtempSync(join(tmpdir(), 'foxpaw-app-'));
  mkdirSync(join(managed, 'defaults', 'pref'), { recursive: true });
  writeFileSync(join(managed, 'defaults', 'pref', 'autoconfig.js'), 'pref("general.config.filename", "mozilla.cfg");\n');
  expect(() => installAutoconfig(managed)).toThrow('already names an AutoConfig file');
  expect(existsSync(join(managed, 'foxpaw.cfg'))).toBe(false);
});
