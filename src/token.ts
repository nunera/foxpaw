import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import type { Environment } from './config.ts';

/**
 * Per-user directory for foxpaw's runtime secrets: $XDG_RUNTIME_DIR/foxpaw (Linux), else a 0700 directory in the
 * system temp dir named after the user. Only this user can list or read it.
 */
export function runtimeDir(env: Environment = process.env): string {
  const base = env.XDG_RUNTIME_DIR || join(tmpdir(), `foxpaw-${process.platform === 'win32' ? userInfo().username : process.getuid?.() ?? userInfo().username}`);
  const dir = env.XDG_RUNTIME_DIR ? join(base, 'foxpaw') : base;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') chmodSync(dir, 0o700);
  return dir;
}

export const tokenPath = (port: number, env: Environment = process.env): string => join(runtimeDir(env), `broker-${port}.token`);

export const newToken = (): string => randomBytes(32).toString('base64url');

/** Save the token of the broker listening on `port`, 0600 and atomically, so a reader never sees half of it. */
export function saveBrokerToken(port: number, token: string, env: Environment = process.env): void {
  const path = tokenPath(port, env);
  const temporary = `${path}.${process.pid}`;
  writeFileSync(temporary, token, { mode: 0o600 });
  renameSync(temporary, path);
}

export function readBrokerToken(port: number, env: Environment = process.env): string | undefined {
  try { return readFileSync(tokenPath(port, env), 'utf8').trim() || undefined; } catch { return undefined; }
}

export function tokensMatch(expected: string, received: string | undefined | null): boolean {
  if (!received) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b);
}
