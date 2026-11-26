import { z } from 'zod';
import packageJson from '../../package.json' with { type: 'json' };
import type { BrowserTool, ToolParams } from '../tool/core.ts';

/**
 * The Model Context Protocol (JSON-RPC 2.0) side of `foxpaw mcp`, independent of the transport: stdio.ts and http.ts
 * feed it one parsed message at a time per session and write back what it returns. It serves one tool, zen_browser.
 */
export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;
export const LATEST_PROTOCOL_VERSION = PROTOCOL_VERSIONS[0];

type Id = string | number;
export type JsonRpcResponse = { jsonrpc: '2.0'; id: Id | null; result?: unknown; error?: { code: number; message: string; data?: unknown } };

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;

export const rpcError = (id: Id | null, code: number, message: string): JsonRpcResponse => ({ jsonrpc: '2.0', id, error: { code, message } });

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isId = (value: unknown): value is Id => typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);

/** One client's conversation: its in-flight requests, so `notifications/cancelled` can abort them. */
export type McpSession = { inFlight: Map<Id, AbortController>; close(): void };

export type McpServer = {
  /** Session state for one client (one stdio pipe, one HTTP Mcp-Session-Id). */
  session(): McpSession;
  /**
   * Handle one parsed message. Returns the response for requests, undefined for notifications and client responses,
   * and undefined for a request the client cancelled meanwhile (the protocol says not to answer those).
   */
  handle(message: unknown, session: McpSession): Promise<JsonRpcResponse | undefined>;
};

export function createMcpServer(tool: BrowserTool): McpServer {
  // The JSON Schema hosts see; `$schema` is dropped because some hosts reject unknown top-level keys.
  const { $schema: _, ...inputSchema } = z.toJSONSchema(tool.parameters, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  const toolEntry = { name: tool.name, title: tool.label, description: tool.description, inputSchema };

  const callTool = async (params: Record<string, unknown>, signal: AbortSignal) => {
    if (params.name !== tool.name) throw Object.assign(new Error(`Unknown tool ${JSON.stringify(params.name)}`), { code: INVALID_PARAMS });
    const parsed = tool.parameters.safeParse(params.arguments ?? {});
    if (!parsed.success) return { content: [{ type: 'text', text: `Invalid arguments for ${tool.name}:\n${z.prettifyError(parsed.error)}` }], isError: true };
    try {
      const { content } = await tool.execute(parsed.data as ToolParams, signal);
      return { content, isError: false };
    } catch (error) {
      return { content: [{ type: 'text', text: messageOf(error) }], isError: true };
    }
  };

  const request = async (method: string, params: Record<string, unknown>, signal: AbortSignal): Promise<unknown> => {
    switch (method) {
      case 'initialize': {
        const requested = params.protocolVersion;
        const protocolVersion = (PROTOCOL_VERSIONS as readonly unknown[]).includes(requested) ? requested : LATEST_PROTOCOL_VERSION;
        return {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'foxpaw', title: 'foxpaw', version: packageJson.version },
          instructions: 'foxpaw drives the user\'s signed-in Zen or Firefox through the zen_browser tool. Call it with action "tabs" first; "launch" starts a browser foxpaw can drive if none is running.',
        };
      }
      case 'ping': return {};
      case 'tools/list': return { tools: [toolEntry] };
      case 'tools/call': return await callTool(params, signal);
      default: throw Object.assign(new Error(`Method not found: ${method}`), { code: METHOD_NOT_FOUND });
    }
  };

  const notification = (method: string, params: Record<string, unknown>, session: McpSession): void => {
    if (method === 'notifications/cancelled' && isId(params.requestId)) {
      session.inFlight.get(params.requestId)?.abort(new Error(typeof params.reason === 'string' ? params.reason : 'cancelled by the client'));
    }
    // notifications/initialized and the rest (progress, roots/list_changed, …) need nothing from a server with one static tool.
  };

  const handle = async (message: unknown, session: McpSession): Promise<JsonRpcResponse | undefined> => {
    if (!isObject(message) || message.jsonrpc !== '2.0') return rpcError(null, INVALID_REQUEST, 'Expected a JSON-RPC 2.0 message object');
    const { id, method } = message;
    if (method === undefined && ('result' in message || 'error' in message)) return undefined;   // a response; we never ask
    if (typeof method !== 'string') return rpcError(isId(id) ? id : null, INVALID_REQUEST, 'Missing method');
    if (message.params !== undefined && !isObject(message.params)) return rpcError(isId(id) ? id : null, INVALID_PARAMS, 'params must be an object');
    const params = (message.params ?? {}) as Record<string, unknown>;
    if (id === undefined) { notification(method, params, session); return undefined; }
    if (!isId(id)) return rpcError(null, INVALID_REQUEST, 'id must be a string or number');

    const controller = new AbortController();
    session.inFlight.set(id, controller);
    try {
      const result = await request(method, params, controller.signal);
      return controller.signal.aborted ? undefined : { jsonrpc: '2.0', id, result };
    } catch (error) {
      if (controller.signal.aborted) return undefined;
      const code = isObject(error) && typeof error.code === 'number' ? error.code : -32603;
      return rpcError(id, code, messageOf(error));
    } finally {
      session.inFlight.delete(id);
    }
  };

  const session = (): McpSession => {
    const inFlight = new Map<Id, AbortController>();
    return { inFlight, close: () => { for (const controller of inFlight.values()) controller.abort(new Error('MCP session ended')); inFlight.clear(); } };
  };

  return { session, handle };
}
