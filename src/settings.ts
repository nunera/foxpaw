import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Environment } from './config.ts';

/**
 * foxpaw's user configuration: one JSON file, `$XDG_CONFIG_HOME/foxpaw/config.json` (`FOXPAW_CONFIG` overrides;
 * `%APPDATA%\foxpaw\config.json` on Windows, `~/Library/Application Support/foxpaw/config.json` on macOS).
 * Each feature owns one top-level key (`policy`, `secrets`, `audit`, `spaces`, …) and validates it itself.
 */
export function settingsPath(env: Environment = process.env): string {
  if (env.FOXPAW_CONFIG) return env.FOXPAW_CONFIG;
  if (process.platform === 'win32') return join(env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'foxpaw', 'config.json');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'foxpaw', 'config.json');
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'foxpaw', 'config.json');
}

/** The parsed file, or {} when it doesn't exist. A file that exists but isn't a JSON object is an error, never ignored. */
export function readSettings(env: Environment = process.env): Record<string, unknown> {
  const path = settingsPath(env);
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${path} must contain a JSON object`);
  return parsed as Record<string, unknown>;
}

/** Where foxpaw keeps state that should survive restarts but isn't configuration (audit logs, recordings). */
export function stateDir(env: Environment = process.env): string {
  if (process.platform === 'win32') return join(env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'foxpaw', 'state');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'foxpaw', 'state');
  return join(env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'foxpaw');
}
