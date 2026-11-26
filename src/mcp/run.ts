import { z } from 'zod';
import { newToken } from '../token.ts';
import { createBrowserTool } from '../tool/core.ts';
import { defaultFeatures } from '../tool/features/index.ts';
import { MCP_HTTP_PORT, mcpTokenPath, removeMcpToken, saveMcpToken, serveHttp } from './http.ts';
import { createMcpServer } from './server.ts';
import { serveStdio } from './stdio.ts';

export const MCP_USAGE = 'Usage: foxpaw mcp [--http [--port N]]';

/**
 * `foxpaw mcp`: serve the zen_browser tool to MCP hosts, over stdio (default) or Streamable HTTP on 127.0.0.1
 * (`--http`, port 9224 unless `--port`; 0 picks a free one). Logs go to stderr only.
 */
export async function runMcp(args: string[]): Promise<void> {
  let http = false;
  let port = MCP_HTTP_PORT;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--http') http = true;
    else if (flag === '--port') {
      port = Number(args[++index]);
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`--port needs a port number\n${MCP_USAGE}`);
    } else throw new Error(`Unknown option ${flag}\n${MCP_USAGE}`);
  }

  const tool = createBrowserTool(z, { features: defaultFeatures({ host: 'mcp' }) });
  const server = createMcpServer(tool);
  let stopping: Promise<void> | undefined;

  if (!http) {
    // stdout belongs to JSON-RPC; anything a dependency logs goes to stderr instead.
    console.log = console.info = console.debug = console.error;
    // The host closing its end of the pipe while an answer is in flight is a normal way to end.
    process.stdout.on('error', () => {});
    const stop = () => (stopping ??= tool.shutdown());
    process.once('SIGINT', () => { void stop().then(() => process.exit(0)); });
    process.once('SIGTERM', () => { void stop().then(() => process.exit(0)); });
    await serveStdio(server, process.stdin, process.stdout);
    await stop();
    return;
  }

  const token = newToken();
  const served = await serveHttp(server, { port, token });
  saveMcpToken(served.port, token);        // only once this server owns the port, like the broker's token
  console.error(`foxpaw MCP server: ${served.url}\nAuthorization: Bearer ${token}\nToken file: ${mcpTokenPath(served.port)}`);
  const stop = () => (stopping ??= (async () => {
    removeMcpToken(served.port);
    await served.close();
    await tool.shutdown();
  })());
  const finished = Promise.withResolvers<void>();
  process.once('SIGINT', () => { void stop().then(finished.resolve); });
  process.once('SIGTERM', () => { void stop().then(finished.resolve); });
  await finished.promise;
}
