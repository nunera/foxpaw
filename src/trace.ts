import type { ActionDiagnostic } from './diagnostics.ts';
export type TraceEntry = { action: string; parameters: Record<string, unknown>; locator?: unknown; before?: unknown; after?: unknown; diagnostic?: ActionDiagnostic; screenshotPath?: string };
const redact = (value: unknown, key = ''): unknown => /^(value|text|body|authorization|proxy-authorization|promptText|password|secret|token)$/i.test(key) ? '[REDACTED]' : Array.isArray(value) ? value.map(item => redact(item)) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([name, item]) => [name, redact(item, name)])) : value;
export class TraceRecorder {
  #next = 1; #active?: { id: string; entries: TraceEntry[] };
  start(): string { const id = `trace_${this.#next++}`; this.#active = { id, entries: [] }; return id; }
  record(entry: TraceEntry): void { this.#active?.entries.push({ ...entry, parameters: redact(entry.parameters) as Record<string, unknown> }); }
  entries(): TraceEntry[] { return this.#active?.entries ?? []; }
  async export(output: string): Promise<void> { if (!this.#active) throw new Error('No active trace.'); await Bun.write(output, this.#active.entries.map(entry => JSON.stringify(entry)).join('\n') + (this.#active.entries.length ? '\n' : '')); }
  async stop(output: string): Promise<string> { await this.export(output); const id = this.#active!.id; this.#active = undefined; return id; }
}
export const safeReplayActions: Record<string, true> = {
  inspect: true,
  query: true,
  wait_for: true,
  wait_for_change: true,
  wait_url: true,
  wait_event: true,
  hover: true,
  scroll: true,
  screenshot: true,
};
