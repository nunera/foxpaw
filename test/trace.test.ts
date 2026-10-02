import { expect, test } from 'bun:test';
import { TraceRecorder } from '../src/trace.ts';

test('writes redacted JSONL traces only through explicit export', async () => {
  const trace = new TraceRecorder(); trace.start(); trace.record({ action: 'fill', parameters: { value: 'secret', authorization: 'Bearer secret' } });
  const output = `/tmp/zen-trace-${Date.now()}.jsonl`; await trace.export(output); const content = await Bun.file(output).text();
  expect(content).toContain('[REDACTED]'); expect(content).not.toContain('Bearer secret');
});
