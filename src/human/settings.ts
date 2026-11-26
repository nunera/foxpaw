import { z } from 'zod';
import type { Environment } from '../config.ts';
import { readSettings } from '../settings.ts';

/** A key chord the page script matches on `KeyboardEvent.code`, so it works with any keyboard layout. */
export type Hotkey = { ctrl: boolean; alt: boolean; shift: boolean; meta: boolean; code: string; text: string };
export type HumanLoopSettings = { hotkey: Hotkey; overlay: boolean };
export type SpacesSettings = { enabled: boolean; perSession: boolean };

export const DEFAULT_HOTKEY = 'Ctrl+Alt+P';
const MODIFIERS: Record<string, 'ctrl' | 'alt' | 'shift' | 'meta'> = { ctrl: 'ctrl', control: 'ctrl', alt: 'alt', option: 'alt', shift: 'shift', meta: 'meta', cmd: 'meta', command: 'meta', super: 'meta' };

/** "Ctrl+Alt+P" → a chord. At least Ctrl, Alt, or Meta is required, so plain typing in a page never toggles pause. */
export function parseHotkey(text: string): Hotkey {
  const hotkey: Hotkey = { ctrl: false, alt: false, shift: false, meta: false, code: '', text };
  const parts = text.split('+').map((part) => part.trim()).filter(Boolean);
  for (const [index, part] of parts.entries()) {
    const modifier = MODIFIERS[part.toLowerCase()];
    if (modifier && index < parts.length - 1) { hotkey[modifier] = true; continue; }
    if (index !== parts.length - 1) throw new Error(`hotkey ${JSON.stringify(text)}: unknown modifier ${JSON.stringify(part)}`);
    if (/^[a-z]$/i.test(part)) hotkey.code = `Key${part.toUpperCase()}`;
    else if (/^[0-9]$/.test(part)) hotkey.code = `Digit${part}`;
    else if (/^F([1-9]|1[0-2])$/i.test(part)) hotkey.code = part.toUpperCase();
    else throw new Error(`hotkey ${JSON.stringify(text)}: the key must be a letter, a digit, or F1–F12`);
  }
  if (!hotkey.code) throw new Error(`hotkey ${JSON.stringify(text)} names no key`);
  if (!hotkey.ctrl && !hotkey.alt && !hotkey.meta) throw new Error(`hotkey ${JSON.stringify(text)} needs Ctrl, Alt, or Meta`);
  return hotkey;
}

const humanLoopSchema = z.object({
  hotkey: z.string().optional(),
  overlay: z.boolean().optional(),
}).strict();
const spacesSchema = z.object({
  enabled: z.boolean().optional(),
  perSession: z.boolean().optional(),
}).strict();

/** The `humanLoop` settings key: the pause hotkey and whether agent-controlled tabs show the label and cursor. */
export function loadHumanLoopSettings(env: Environment = process.env): HumanLoopSettings {
  const parsed = humanLoopSchema.parse(readSettings(env).humanLoop ?? {});
  return { hotkey: parseHotkey(parsed.hotkey ?? DEFAULT_HOTKEY), overlay: parsed.overlay ?? true };
}

/** The `spaces` settings key: whether each tool session opens its tabs in a container of its own. */
export function loadSpacesSettings(env: Environment = process.env): SpacesSettings {
  const parsed = spacesSchema.parse(readSettings(env).spaces ?? {});
  return { enabled: parsed.enabled ?? false, perSession: parsed.perSession ?? true };
}
