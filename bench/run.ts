import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import type { ToolContent, ToolParams } from '../src/tool/core.ts';
import { createBenchEnv } from './env.ts';
import { LOGIN, startFixtures } from './fixtures/server.ts';
import { compareSideEffects, TASKS, ToolCallError, type ToolDetails } from './tasks.ts';

/**
 * Deterministic suite: every task's scripted tool calls through createBrowserTool(z, { features: defaultFeatures() })
 * against a real headless Firefox or Zen, in a throwaway environment. Writes <out>/<date>.json and <date>.md and exits
 * 1 if any task failed or caused an unintended side effect.
 *
 *   bun bench/run.ts [--browser PATH] [--task ID ...] [--out DIR]
 */
const USAGE = 'Usage: bun bench/run.ts [--browser PATH] [--task ID ...] [--out DIR]';
const { values } = parseArgs({
  options: { browser: { type: 'string' }, task: { type: 'string', multiple: true }, out: { type: 'string' }, help: { type: 'boolean' } },
});
if (values.help) { console.log(USAGE); process.exit(0); }
const unknown = (values.task ?? []).filter((id) => !TASKS.some((task) => task.id === id));
if (unknown.length) { console.error(`Unknown task ${unknown.join(', ')}. Tasks: ${TASKS.map((task) => task.id).join(', ')}`); process.exit(2); }
const tasks = values.task?.length ? TASKS.filter((task) => values.task!.includes(task.id)) : TASKS;
const outDir = resolve(values.out ?? new URL('./results', import.meta.url).pathname);

export type TaskResult = {
  task: string;
  success: boolean;
  failure?: string;
  unintendedSideEffects: string[];
  approvalsAsked: number;
  toolCalls: number;
  wallMs: number;
  responseBytes: number;
  answer?: string;
};

const bench = await createBenchEnv(LOGIN.password);
Object.assign(process.env, bench.vars);
const fixtures = await startFixtures();
// Imported only now: the broker client reads FIREFOX_BIDI_BROKER_URL when it loads.
const { createBrowserTool } = await import('../src/tool/core.ts');
const { defaultFeatures } = await import('../src/tool/features/index.ts');
const results: TaskResult[] = [];
let browserName = 'unknown';
let exitCode = 0;

try {
  const launched = await bench.launch(values.browser);
  console.error(`browser: ${launched.browser} (pid ${launched.pid}), fixtures: ${fixtures.origins.a} ${fixtures.origins.b}`);
  bench.configure(fixtures.origins, 'deny');
  const tool = createBrowserTool(z, { features: defaultFeatures() });
  try {
    const session = await tool.runtime.browser.bidi.sessionInfo?.();
    const capabilities = session?.capabilities as { browserName?: string; browserVersion?: string } | undefined;
    if (capabilities?.browserName) browserName = `${capabilities.browserName} ${capabilities.browserVersion ?? ''}`.trim();
    const reference = ((await tool.execute({ action: 'tabs' })).details.tabs as Array<{ tabId: string }>)[0]?.tabId;

    for (const task of tasks) {
      fixtures.reset();
      bench.configure(fixtures.origins, task.approver);
      let calls = 0;
      let bytes = 0;
      const call = async (params: Record<string, unknown>): Promise<ToolDetails> => {
        calls++;
        let output: { content: ToolContent[]; details: ToolDetails };
        try { output = await tool.execute(tool.parameters.parse(params) as ToolParams); } catch (error) {
          const text = error instanceof Error ? error.message : String(error);
          bytes += Buffer.byteLength(text);
          let details: ToolDetails | undefined;
          try { details = JSON.parse(text) as ToolDetails; } catch {}
          throw new ToolCallError(text, details);
        }
        for (const block of output.content) bytes += Buffer.byteLength(block.type === 'text' ? block.text : block.data);
        return output.details;
      };
      const startedAt = performance.now();
      let answer: string | undefined;
      let failure: string | undefined;
      let tabId: string | undefined;
      try {
        const opened = await call({ action: 'open', ...(reference ? { tabId: reference } : {}), url: `${fixtures.origins[task.start.site]}${task.start.path}`, isolation: 'test' });
        tabId = (opened.tab as { tabId: string }).tabId;
        answer = await task.script({ call, tabId, origins: fixtures.origins, uploadFile: bench.uploadFile });
      } catch (error) {
        failure = `script: ${error instanceof Error ? error.message : String(error)}`;
      }
      const wallMs = Math.round(performance.now() - startedAt);
      if (tabId) await call({ action: 'close', tabId }).catch(() => undefined);
      const { unintended, missing } = compareSideEffects(task.expected, fixtures.sideEffects());
      failure ??= task.check({ state: fixtures.state, requests: fixtures.requests, answer: answer ?? '', downloadDir: bench.downloadDir });
      failure ??= missing.length ? `expected side effects missing: ${missing.join(', ')}` : undefined;
      failure ??= unintended.length ? `unintended side effects: ${unintended.join(', ')}` : undefined;
      const result: TaskResult = { task: task.id, success: failure === undefined, ...(failure ? { failure } : {}), unintendedSideEffects: unintended, approvalsAsked: bench.approvals(), toolCalls: calls, wallMs, responseBytes: bytes, ...(answer === undefined ? {} : { answer }) };
      results.push(result);
      console.error(`${result.success ? 'ok  ' : 'FAIL'} ${task.id} ${wallMs} ms${failure ? `: ${failure}` : ''}`);
    }
  } finally {
    await tool.shutdown();
  }
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  exitCode = 1;
} finally {
  await fixtures.close();
  await bench.cleanup();
}

if (results.length) {
  const date = new Date().toISOString().slice(0, 10);
  const report = { date, suite: 'deterministic', browser: browserName, node: process.versions.node, bun: process.versions.bun ?? null, tasks: results };
  const rows = results.map((result) => `| ${result.task} | ${result.success ? 'yes' : 'no'} | ${result.unintendedSideEffects.length} | ${result.approvalsAsked} | ${result.toolCalls} | ${result.wallMs} | ${result.responseBytes} |`);
  const failures = results.filter((result) => result.failure).map((result) => `- ${result.task}: ${result.failure}`);
  const total = (key: 'toolCalls' | 'wallMs' | 'responseBytes') => results.reduce((sum, result) => sum + result[key], 0);
  const markdown = [
    `# foxpaw deterministic suite, ${date}`,
    '',
    `Browser: ${browserName}. ${results.filter((result) => result.success).length}/${results.length} tasks succeeded.`,
    '',
    '| task | success | unintended side effects | approvals asked | tool calls | wall ms | response bytes |',
    '|---|---|---|---|---|---|---|',
    ...rows,
    `| **total** | ${results.filter((result) => result.success).length}/${results.length} | ${results.reduce((sum, result) => sum + result.unintendedSideEffects.length, 0)} | ${results.reduce((sum, result) => sum + result.approvalsAsked, 0)} | ${total('toolCalls')} | ${total('wallMs')} | ${total('responseBytes')} |`,
    ...(failures.length ? ['', 'Failures:', '', ...failures] : []),
    '',
  ].join('\n');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `${date}.json`), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(outDir, `${date}.md`), markdown);
  console.log(markdown);
  console.error(`wrote ${join(outDir, `${date}.json`)} and ${date}.md`);
  if (results.some((result) => !result.success)) exitCode = 1;
}
process.exit(exitCode);
