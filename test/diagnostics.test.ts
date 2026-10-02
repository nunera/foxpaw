import { expect, test } from 'bun:test';
import { summarizeDiagnostic } from '../src/diagnostics.ts';

test('correlates navigation, network, and console events to an action', () => {
  const diagnostic = summarizeDiagnostic('click', 'ctx', 1, [{ method: 'browsingContext.load', params: { context: 'ctx' } }, { method: 'network.responseCompleted', params: { url: 'https://example.test/a', status: 200 } }, { method: 'log.entryAdded', params: { level: 'error', text: 'boom' } }]);
  expect(diagnostic.navigation).toHaveLength(1); expect(diagnostic.network).toEqual([{ method: 'network.responseCompleted', url: 'https://example.test/a', status: 200, resourceType: undefined, errorText: undefined }]); expect(diagnostic.console).toEqual([{ level: 'error', text: 'boom', timestamp: undefined }]);
});
