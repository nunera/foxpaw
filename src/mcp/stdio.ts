import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { PARSE_ERROR, rpcError, type McpServer } from './server.ts';

/**
 * MCP over stdio: one JSON-RPC message per line on `input`, responses as lines on `output`, nothing else on `output`.
 * Requests run concurrently (the tool queues browser actions itself) and are answered as they finish. Resolves once
 * `input` ends; requests still running are aborted then, since nobody is left to read their answers.
 */
export async function serveStdio(server: McpServer, input: Readable, output: Writable): Promise<void> {
  const session = server.session();
  const send = (message: unknown) => { if (output.writable) output.write(`${JSON.stringify(message)}\n`); };
  for await (const line of createInterface({ input, crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    let message: unknown;
    try { message = JSON.parse(line); } catch { send(rpcError(null, PARSE_ERROR, 'Parse error: each line must be one JSON-RPC message')); continue; }
    void server.handle(message, session).then((response) => { if (response) send(response); });
  }
  session.close();
}
