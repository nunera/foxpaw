import { randomUUID } from 'node:crypto';
import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { Environment } from '../config.ts';
import { refuseRequest } from '../loopback.ts';
import { runtimeDir } from '../token.ts';
import { INVALID_REQUEST, PARSE_ERROR, PROTOCOL_VERSIONS, rpcError, type McpServer, type McpSession } from './server.ts';

export const MCP_HTTP_PORT = 9224;
const BODY_LIMIT = 4 * 1024 * 1024;
// JSON-RPC has no code for this; -32800 is the Language Server Protocol's RequestCancelled, which MCP SDKs also use.
const REQUEST_CANCELLED = -32800;

export const mcpTokenPath = (port: number, env: Environment = process.env): string => join(runtimeDir(env), `mcp-${port}.token`);

/** Save the token of the MCP server listening on `port`, 0600 and atomically, like the broker's (token.ts). */
export function saveMcpToken(port: number, token: string, env: Environment = process.env): void {
  const path = mcpTokenPath(port, env);
  const temporary = `${path}.${process.pid}`;
  writeFileSync(temporary, token, { mode: 0o600 });
  renameSync(temporary, path);
}

export type McpHttpServer = { port: number; url: string; close(): Promise<void> };

/**
 * MCP Streamable HTTP (2025-06-18) on 127.0.0.1: POST /mcp carries one JSON-RPC message and gets its response as JSON
 * (or as a one-event SSE stream for clients that accept only text/event-stream); `initialize` opens a session named
 * by the Mcp-Session-Id response header, DELETE /mcp ends it, GET /mcp is 405 (the server never pushes messages).
 * Every request passes refuseRequest with `token`, so web pages, DNS rebinding, and other local users are refused.
 */
export async function serveHttp(server: McpServer, options: { port: number; token: string }): Promise<McpHttpServer> {
  const sessions = new Map<string, McpSession>();

  const json = (response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) =>
    response.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));

  const readBody = async (request: IncomingMessage): Promise<string | undefined> => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > BODY_LIMIT) return undefined;
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  };

  const post = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const body = await readBody(request);
    if (body === undefined) { json(response, 413, rpcError(null, INVALID_REQUEST, `Request body over ${BODY_LIMIT} bytes`)); return; }
    let message: unknown;
    try { message = JSON.parse(body); } catch { json(response, 400, rpcError(null, PARSE_ERROR, 'Parse error')); return; }
    if (typeof message !== 'object' || message === null || Array.isArray(message)) {
      json(response, 400, rpcError(null, INVALID_REQUEST, 'Expected one JSON-RPC message object (batches are not supported)'));
      return;
    }
    const { id, method } = message as Record<string, unknown>;
    const isRequest = id !== undefined && method !== undefined;

    const initialize = method === 'initialize' && isRequest;
    const sessionId = initialize ? randomUUID() : request.headers['mcp-session-id'];
    let session: McpSession | undefined;
    if (initialize) session = server.session();
    else {
      if (typeof sessionId !== 'string') { json(response, 400, rpcError(null, INVALID_REQUEST, 'Missing Mcp-Session-Id header; send initialize first')); return; }
      session = sessions.get(sessionId);
      if (!session) { json(response, 404, rpcError(null, INVALID_REQUEST, 'Unknown or ended session; initialize again')); return; }
      const version = request.headers['mcp-protocol-version'];
      if (typeof version === 'string' && !(PROTOCOL_VERSIONS as readonly string[]).includes(version)) {
        json(response, 400, rpcError(null, INVALID_REQUEST, `Unsupported MCP-Protocol-Version ${version}`));
        return;
      }
    }

    const answer = await server.handle(message, session);
    if (!isRequest && !answer) { response.writeHead(202).end(); return; }
    const reply = answer ?? rpcError(id as string | number, REQUEST_CANCELLED, 'Request cancelled');
    const headers: Record<string, string> = {};
    // A session exists only once its initialize succeeded.
    if (initialize && reply.result !== undefined && typeof sessionId === 'string') {
      sessions.set(sessionId, session);
      headers['mcp-session-id'] = sessionId;
    }
    const accept = request.headers.accept ?? '';
    if (accept.includes('text/event-stream') && !accept.includes('application/json')) {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...headers });
      response.end(`event: message\ndata: ${JSON.stringify(reply)}\n\n`);
    } else json(response, 200, reply, headers);
  };

  const http = createServer((request, response) => {
    const refusal = refuseRequest(request.headers, request.url ?? '/', options.token);
    if (refusal) { response.writeHead(403, { 'content-type': 'text/plain' }).end(refusal); return; }
    if (new URL(request.url ?? '/', 'http://127.0.0.1').pathname !== '/mcp') { response.writeHead(404).end(); return; }
    if (request.method === 'POST') {
      post(request, response).catch((error: unknown) => {
        if (!response.headersSent) json(response, 500, rpcError(null, -32603, error instanceof Error ? error.message : String(error)));
      });
    } else if (request.method === 'DELETE') {
      const sessionId = request.headers['mcp-session-id'];
      const session = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;
      if (!session) { response.writeHead(typeof sessionId === 'string' ? 404 : 400).end(); return; }
      session.close();
      sessions.delete(sessionId as string);
      response.writeHead(204).end();
    } else response.writeHead(405, { allow: 'POST, DELETE' }).end();
  });

  const listening = Promise.withResolvers<void>();
  http.once('error', listening.reject);
  http.listen(options.port, '127.0.0.1', () => listening.resolve());
  await listening.promise;
  const port = (http.address() as AddressInfo).port;

  const close = async () => {
    for (const session of sessions.values()) session.close();
    sessions.clear();
    const closed = Promise.withResolvers<void>();
    http.close(() => closed.resolve());
    http.closeAllConnections();
    await closed.promise;
  };
  return { port, url: `http://127.0.0.1:${port}/mcp`, close };
}

/** Remove the token file of a stopped server, so it never outlives the server it belongs to. */
export function removeMcpToken(port: number, env: Environment = process.env): void {
  rmSync(mcpTokenPath(port, env), { force: true });
}
