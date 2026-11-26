import type { IncomingHttpHeaders } from 'node:http';
import { tokensMatch } from './token.ts';

const LOOPBACK_HOSTS: Record<string, true> = { '127.0.0.1': true, localhost: true, '[::1]': true };

/**
 * Why a request to one of foxpaw's loopback servers must be refused, or undefined to let it through.
 *
 * - Any `Origin` header: browsers send one with every WebSocket and cross-site fetch, so a web page in any browser
 *   could otherwise drive the signed-in browser through 127.0.0.1. Firefox's own Remote Agent applies the same rule;
 *   programs (the extension, the CLI, BiDi libraries) send none.
 * - A `Host` that isn't loopback: a DNS-rebinding page reaches 127.0.0.1 under its own host name.
 * - A missing or wrong token, when one is required: other users on this machine can reach 127.0.0.1 too.
 */
export function refuseRequest(headers: IncomingHttpHeaders, url: string, token?: string): string | undefined {
  if (headers.origin !== undefined) return 'requests from web pages (with an Origin header) are refused';
  const host = (headers.host ?? '').toLowerCase().replace(/:\d+$/, '');
  if (!LOOPBACK_HOSTS[host]) return `Host ${JSON.stringify(headers.host ?? '')} is not loopback`;
  if (token === undefined) return undefined;
  const fromQuery = new URL(url, 'http://127.0.0.1').searchParams.get('token');
  const authorization = headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  return tokensMatch(token, fromQuery ?? authorization) ? undefined : 'missing or wrong token';
}
