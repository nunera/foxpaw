import type { z as Zod } from 'zod';
import { InputVerificationError } from '../../browser.ts';
import type { Environment } from '../../config.ts';
import { documentFrame } from '../../locator.ts';
import { loadSecrets, Redactor, resolveSecret, type ResolveDeps } from '../../trust/secrets.ts';
import type { ActionCall, ToolFeature, ToolRuntime } from '../core.ts';

export type SecretsFeatureOptions = { env?: Environment; resolve?: Omit<ResolveDeps, 'env'> };
type SecretTab = { contextId: string; timeOrigin: unknown; fields: Array<{ context: string; selector: string }>; names: Set<string> };

const refuse = (call: ActionCall, error: string, extra: Record<string, unknown> = {}) => new Error(JSON.stringify({
  ...(call.params.tabId ? { tabId: call.params.tabId } : {}),
  action: call.action,
  actionPerformed: false,
  error,
  ...extra,
}));
const elementScript = (selector: string, body: string) => `(() => {
  let root = document; let element;
  for (const part of ${JSON.stringify(selector.split('>>>').map((part) => part.trim()))}) { element = root.querySelector(part); if (!element) return null; root = element.shadowRoot ?? element; }
  return ${body};
})()`;

/**
 * `fill_secret` fills a configured secret (`secrets` settings key, docs/secrets.md) into a field on an allowed origin
 * without the model passing or seeing the value. Afterwards every result and error is redacted, and the tab is in
 * secret mode until its document changes: no `evaluate`, no screenshots unless every filled field is a password field,
 * and no `assert` on `value`.
 */
export function secretsFeature(options: SecretsFeatureOptions = {}): ToolFeature {
  const redactor = new Redactor();
  const secretTabs = new Map<string, SecretTab>();

  // Secret mode ends when the tab's top document is replaced (a new performance.timeOrigin), not on pushState.
  const secretTab = async (call: ActionCall, runtime: ToolRuntime) => {
    if (!secretTabs.size) return undefined;
    let found;
    try { found = await runtime.target(call.action, call.params.tabId, call.params.target); } catch { return undefined; }
    const entry = secretTabs.get(found.tabId);
    if (!entry) return undefined;
    const timeOrigin = await runtime.browser.evaluateValue(entry.contextId, 'performance.timeOrigin').catch(() => entry.timeOrigin);
    if (timeOrigin !== entry.timeOrigin) {
      secretTabs.delete(found.tabId);
      return undefined;
    }
    return { tabId: found.tabId, entry };
  };

  return {
    name: 'secrets',
    params: (z: typeof Zod) => ({
      secret: z.string().optional().describe('fill_secret: name of a secret the user configured (never its value).'),
    }),
    description: [
      'Secrets: `fill_secret` {tabId, handle|selector|role/name, secret: "<name>"} fills a secret the user configured into a field, only on the origins they allowed. You never pass or see the value; results show `[secret:<name>]` wherever it would appear. Until the page navigates, that tab refuses `evaluate`, screenshots (unless every filled field is a password field), and `assert` on `value`.',
    ],
    actions: {
      async fill_secret(call, runtime) {
        const { params } = call;
        const name = params.secret;
        if (typeof name !== 'string' || !name) throw refuse(call, 'fill_secret requires secret: the name of a configured secret.');
        const loaded = loadSecrets(options.env);
        if (!loaded.ok) throw refuse(call, `The secrets configuration is invalid: ${loaded.reason}`);
        const entry = loaded.secrets[name];
        if (!entry) throw refuse(call, `No secret named ${JSON.stringify(name)} is configured.`, { configured: Object.keys(loaded.secrets) });
        const { context, tabId } = await runtime.target(call.action, params.tabId, params.target);
        const resolved = await runtime.resolve(context, tabId, params);
        // The field's own document and the tab's top document must both be allowed: a cross-origin iframe on an
        // allowed site is not.
        const evaluate = runtime.browser.evaluateValue.bind(runtime.browser);
        const [topOrigin, frameOrigin] = await Promise.all([evaluate(context.id, 'location.origin'), evaluate(resolved.frame.context, 'location.origin')]);
        for (const origin of new Set([topOrigin, frameOrigin])) {
          if (typeof origin !== 'string' || !entry.origins.includes(origin)) {
            throw refuse(call, `Secret ${JSON.stringify(name)} may only be filled on ${entry.origins.join(', ')}; this field is on ${String(origin)}. Nothing was filled.`, { tabId, secret: name, origin, allowedOrigins: entry.origins });
          }
        }
        const editable = await evaluate(resolved.frame.context, elementScript(resolved.selector, 'element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement'));
        if (editable !== true) throw refuse(call, 'fill_secret only fills input and textarea elements.', { tabId, secret: name, selector: resolved.selector });
        let value: string;
        try { value = await resolveSecret(entry.source, { ...options.resolve, env: options.env ?? process.env }); } catch (error) {
          throw refuse(call, `Could not read secret ${JSON.stringify(name)}: ${error instanceof Error ? error.message : String(error)}`, { tabId, secret: name });
        }
        redactor.add(name, value);
        const timeOrigin = await evaluate(context.id, 'performance.timeOrigin');
        const current = secretTabs.get(tabId);
        const tab: SecretTab = current && current.timeOrigin === timeOrigin ? current : { contextId: context.id, timeOrigin, fields: [], names: new Set() };
        // The page must not have navigated between the origin check and the fill.
        if ((await documentFrame(evaluate, resolved.frame.context)).documentId !== resolved.frame.documentId) throw refuse(call, 'The page changed before the secret was filled; nothing was filled. Inspect again.', { tabId, secret: name });
        tab.fields.push({ context: resolved.frame.context, selector: resolved.selector });
        tab.names.add(name);
        secretTabs.set(tabId, tab);
        try {
          await runtime.browser.fill(resolved.frame.context, resolved.selector, value);
        } catch (error) {
          // A field that kept only part of the secret (maxlength, input masks) still holds secret text.
          const partial = await evaluate(resolved.frame.context, elementScript(resolved.selector, 'element.value')).catch(() => undefined);
          if (typeof partial === 'string' && partial.length >= 4) redactor.add(name, partial);
          if (error instanceof InputVerificationError) {
            return { details: { tabId, filled: true, verified: false, secret: name, selector: resolved.selector, note: 'The keys were sent, but the field does not hold the full secret (maxlength or a script changed it). The value is withheld. Do not resend; tell the user.' } };
          }
          throw error;
        }
        return { details: { tabId, filled: true, secret: name, selector: resolved.selector } };
      },
    },
    async before(call, runtime) {
      const { action, params } = call;
      if (action !== 'evaluate' && action !== 'screenshot' && action !== 'assert' && action !== 'assert_many' && action !== 'batch') return;
      const secret = await secretTab(call, runtime);
      if (!secret) return;
      const names = [...secret.entry.names].join(', ');
      if (action === 'evaluate') throw refuse(call, `This tab holds a filled secret (${names}), so evaluate is refused until the page navigates.`, { tabId: secret.tabId, secretMode: true });
      if (action === 'screenshot') {
        for (const field of secret.entry.fields) {
          const type = await runtime.browser.evaluateValue(field.context, elementScript(field.selector, 'element.type')).catch(() => null);
          if (type !== 'password') throw refuse(call, `This tab holds a filled secret (${names}) in a field that is not a password field (${field.selector}), so screenshots are refused until the page navigates.`, { tabId: secret.tabId, secretMode: true });
        }
        return;
      }
      const properties = action === 'assert' ? [params.property] : action === 'assert_many' ? (params.properties ?? []).map((check) => check.property) : (params.batch ?? []).filter((step) => step.action === 'assert').map((step) => step.property);
      if (properties.includes('value')) throw refuse(call, `This tab holds a filled secret (${names}), so asserting on value is refused until the page navigates.`, { tabId: secret.tabId, secretMode: true });
    },
    async after(_call, outcome) {
      if (!redactor.size) return;
      return {
        startedAt: outcome.startedAt,
        ...(outcome.result ? { result: { details: redactor.value(outcome.result.details), ...(outcome.result.image === undefined ? {} : { image: outcome.result.image }) } } : {}),
        ...('error' in outcome ? { error: redactor.error(outcome.error) } : {}),
      };
    },
  };
}
