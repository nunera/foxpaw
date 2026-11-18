// Minimal local typing of the omp host API this extension uses. The real '@oh-my-pi/pi-coding-agent' package is
// provided by the host at load time and is not a dependency of this repository. The host injects its own zod as
// `pi.zod`, which may be zod 3; the extension sticks to APIs both versions share.
declare module '@oh-my-pi/pi-coding-agent' {
  import type { z } from 'zod';

  export type ToolContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
  export type ToolResult<TDetails> = { content: ToolContent[]; details?: TDetails; isError?: boolean };

  export interface ToolDefinition<TParams extends z.ZodType, TDetails = unknown> {
    name: string;
    label: string;
    description: string;
    parameters: TParams;
    loadMode?: 'essential' | 'discoverable';
    execute(toolCallId: string, params: z.infer<TParams>, signal: AbortSignal | undefined): Promise<ToolResult<TDetails>>;
  }

  export interface ExtensionAPI {
    zod: typeof z;
    registerTool<TParams extends z.ZodType, TDetails = unknown>(tool: ToolDefinition<TParams, TDetails>): void;
    on(event: 'session_shutdown', handler: () => Promise<void> | void): void;
  }
}
