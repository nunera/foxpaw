import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Environment } from '../../config.ts';
import { loadSpacesSettings } from '../../human/settings.ts';
import { stateDir } from '../../settings.ts';
import type { ToolFeature, ToolRuntime } from '../core.ts';

export type SpacesFeatureOptions = { env?: Environment };
type Space = { userContext: string; name: string };

/**
 * Agent spaces (`spaces` settings key, docs/human-loop.md): with `enabled`, `open` puts this session's tabs in a
 * container (user context) of their own, so their cookies and logins stay apart from the user's. `perSession: true`
 * (default) gives each session a fresh container, removed with its tabs when the session ends; `false` shares one
 * agent container across sessions and keeps it, so agent logins persist.
 */
export function spacesFeature(options: SpacesFeatureOptions = {}): ToolFeature {
  const env = options.env ?? process.env;
  let own: Promise<Space> | undefined;
  let created: { runtime: ToolRuntime; userContext: string } | undefined;
  const sharedFile = () => join(stateDir(env), 'spaces.json');

  const shared = async (runtime: ToolRuntime): Promise<Space> => {
    let saved: unknown;
    try { const parsed: unknown = JSON.parse(readFileSync(sharedFile(), 'utf8')); if (parsed && typeof parsed === 'object' && 'userContext' in parsed) saved = parsed.userContext; } catch { /* none yet */ }
    if (typeof saved === 'string') {
      const listed = await runtime.browser.bidi.commandOptional('browser.getUserContexts');
      const contexts = Array.isArray(listed.userContexts) ? listed.userContexts as Array<{ userContext?: unknown }> : [];
      if (contexts.some((entry) => entry.userContext === saved)) return { userContext: saved, name: 'agents' };
    }
    const userContext = await runtime.browser.createUserContext();
    mkdirSync(dirname(sharedFile()), { recursive: true });
    writeFileSync(sharedFile(), `${JSON.stringify({ userContext })}\n`);
    return { userContext, name: 'agents' };
  };

  return {
    name: 'spaces',
    description: [
      'Spaces: when the user enables them, `open` puts new tabs in this session\'s own container (`isolation: "space"` in `tabs`), with cookies and logins apart from the user\'s tabs. The user may need to sign in there once.',
    ],
    async space(runtime) {
      if (!loadSpacesSettings(env).enabled) return undefined;
      own ??= (async () => {
        if (!loadSpacesSettings(env).perSession) return await shared(runtime);
        const userContext = await runtime.browser.createUserContext();
        created = { runtime, userContext };
        return { userContext, name: 'session' };
      })().catch((error: unknown) => { own = undefined; throw error; });
      return await own;
    },
    async shutdown() {
      // Before the core closes the transport (features shut down first). Removing the container closes its tabs.
      if (created) await created.runtime.browser.removeUserContext(created.userContext).catch(() => undefined);
      created = undefined;
      own = undefined;
    },
  };
}
