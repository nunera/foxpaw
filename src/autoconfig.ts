import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
// Text imports stay in this module, which only the CLI and the library entry load: hosts that run the tool's
// TypeScript with their own loader (oh-my-pi extensions) don't support import attributes.
import autoconfigPrefs from '../autoconfig/defaults/pref/foxpaw-autoconfig.js' with { type: 'text' };
import autoconfigCfg from '../autoconfig/foxpaw.cfg' with { type: 'text' };

/** The AutoConfig, embedded so a compiled foxpaw binary carries it too. */
export const AUTOCONFIG = { prefs: autoconfigPrefs, cfg: autoconfigCfg } as const;

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
