import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { createBenchEnv, type BenchEnv } from './env.ts';
import { LOGIN, startFixtures, type Fixtures } from './fixtures/server.ts';
import { compareSideEffects, TASKS, type AgentServer, type Task } from './tasks.ts';

/**
 * LLM agent benchmark over one MCP stdio server, foxpaw or a comparator, on the same fixture tasks as the
 * deterministic suite. Measures success, input/output tokens, and unintended side effects per task.
 *
 * Two harnesses drive the model:
 * - `api` (default): a minimal agent loop on the Anthropic Messages API. Needs ANTHROPIC_API_KEY.
 * - `claude-code`: `claude -p` with only the MCP server's tools (`--tools ""`), so it runs on a Claude subscription.
 *   Token counts then include Claude Code's own system prompt, the same for every server.
 *
 *   bun bench/agent.ts --model MODEL --server foxpaw|playwright|chrome-devtools [--harness api|claude-code] [--task ID ...] [--max-turns N] [--out DIR] [--browser PATH]
 */
const USAGE = 'Usage: bun bench/agent.ts --model MODEL --server foxpaw|playwright|chrome-devtools [--harness api|claude-code] [--task ID ...] [--max-turns N] [--out DIR] [--browser PATH]';
const SERVERS: readonly AgentServer[] = ['foxpaw', 'playwright', 'chrome-devtools'];
const API_URL = `${process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com'}/v1/messages`;
const SYSTEM = 'You operate a web browser through the tools you have. Complete the user\'s task in the browser, doing only what the task asks. When you are done, answer with a short final message and no tool call.';
const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

const { values } = parseArgs({
  options: {
    model: { type: 'string' }, server: { type: 'string' }, task: { type: 'string', multiple: true }, 'max-turns': { type: 'string' },
    out: { type: 'string' }, browser: { type: 'string' }, harness: { type: 'string' }, help: { type: 'boolean' },
  },
});
if (values.help) { console.log(USAGE); process.exit(0); }
const harness = values.harness ?? 'api';
if (harness !== 'api' && harness !== 'claude-code') { console.error(USAGE); process.exit(2); }
const apiKey = process.env.ANTHROPIC_API_KEY;
if (harness === 'api' && !apiKey) { console.error('ANTHROPIC_API_KEY is not set. The api harness calls the Anthropic Messages API and does not run without it (use --harness claude-code to run on a Claude subscription); no results were written.'); process.exit(2); }
if (!values.model || !SERVERS.includes(values.server as AgentServer)) { console.error(USAGE); process.exit(2); }
const model = values.model;
const server = values.server as AgentServer;
const maxTurns = Number(values['max-turns'] ?? 30);
if (!Number.isInteger(maxTurns) || maxTurns < 1) { console.error('--max-turns needs a positive integer'); process.exit(2); }
const unknown = (values.task ?? []).filter((id) => !TASKS.some((task) => task.id === id));
if (unknown.length) { console.error(`Unknown task ${unknown.join(', ')}. Tasks: ${TASKS.map((task) => task.id).join(', ')}`); process.exit(2); }
const tasks = TASKS.filter((task) => (!values.task?.length || values.task.includes(task.id)) && (server === 'foxpaw' || !task.foxpawOnly));
const outDir = resolve(values.out ?? new URL('./results', import.meta.url).pathname);

type JsonObject = Record<string, unknown>;
type McpTool = { name: string; description?: string; inputSchema: JsonObject };
type McpContent = { type: string; text?: string; data?: string; mimeType?: string };
type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: JsonObject }
  | { type: 'tool_result'; tool_use_id: string; content: Array<{ type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }>; is_error?: boolean };
type Message = { role: 'user' | 'assistant'; content: string | ContentBlock[] };
type ApiResponse = { content: ContentBlock[]; stop_reason: string; usage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } };

/** JSON-RPC over a child's stdio, one message per line (MCP's stdio transport). */
class McpClient {
  #nextId = 1;
  #pending = new Map<number, { resolve(value: JsonObject): void; reject(error: Error): void }>();
  #exited: string | undefined;
  constructor(readonly child: ChildProcess) {
    createInterface({ input: child.stdout! }).on('line', (line) => {
      let message: { id?: number; result?: JsonObject; error?: { message?: string } };
      try { message = JSON.parse(line) as typeof message; } catch { return; }
      const pending = message.id === undefined ? undefined : this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id!);
      if (message.error) pending.reject(new Error(`MCP error: ${message.error.message ?? JSON.stringify(message.error)}`));
      else pending.resolve(message.result ?? {});
    });
    child.once('exit', (code, signal) => {
      this.#exited = signal ? `signal ${signal}` : `exit code ${code}`;
      for (const pending of this.#pending.values()) pending.reject(new Error(`MCP server exited (${this.#exited})`));
      this.#pending.clear();
    });
  }
  request(method: string, params: JsonObject = {}, timeoutMs = 180_000): Promise<JsonObject> {
    if (this.#exited) return Promise.reject(new Error(`MCP server exited (${this.#exited})`));
    const id = this.#nextId++;
    const deferred = Promise.withResolvers<JsonObject>();
    const timer = setTimeout(() => { this.#pending.delete(id); deferred.reject(new Error(`MCP ${method} timed out`)); }, timeoutMs);
    this.#pending.set(id, { resolve: (value) => { clearTimeout(timer); deferred.resolve(value); }, reject: (error) => { clearTimeout(timer); deferred.reject(error); } });
    this.child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return deferred.promise;
  }
  notify(method: string, params: JsonObject = {}): void { this.child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`); }
  async close(): Promise<void> {
    if (this.#exited) return;
    const exited = Promise.withResolvers<void>();
    this.child.once('exit', () => exited.resolve());
    this.child.stdin!.end();
    const timer = setTimeout(() => this.child.kill('SIGTERM'), 5_000);
    await exited.promise;
    clearTimeout(timer);
  }
}

/** The command for each server. Comparators run headless in their own isolated browser profile. */
function serverCommand(name: AgentServer): string[] {
  if (name === 'foxpaw') return [process.execPath, CLI, 'mcp'];
  if (name === 'playwright') return ['npx', '-y', '@playwright/mcp@latest', '--headless', '--isolated'];
  return ['npx', '-y', 'chrome-devtools-mcp@latest', '--headless', '--isolated'];
}

async function startServer(name: AgentServer, env: NodeJS.ProcessEnv): Promise<{ client: McpClient; tools: McpTool[] }> {
  const [command, ...args] = serverCommand(name);
  const child = spawn(command!, args, { env, stdio: ['pipe', 'pipe', 'inherit'] });
  const client = new McpClient(child);
  await client.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'foxpaw-bench', version: '1' } });
  client.notify('notifications/initialized');
  const tools: McpTool[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.request('tools/list', cursor ? { cursor } : {});
    tools.push(...(page.tools as McpTool[]));
    cursor = typeof page.nextCursor === 'string' ? page.nextCursor : undefined;
  } while (cursor);
  return { client, tools };
}

async function messages(body: JsonObject): Promise<ApiResponse> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey!, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
    });
    if (response.ok) return await response.json() as ApiResponse;
    const text = await response.text();
    // Rate limits and overload are worth waiting out; anything else (bad key, bad model) ends the run.
    if ((response.status === 429 || response.status === 529 || response.status >= 500) && attempt < 4) {
      await sleep(Number(response.headers.get('retry-after') ?? 0) * 1000 || 2 ** attempt * 5_000);
      continue;
    }
    throw new Error(`Anthropic API ${response.status}: ${text.slice(0, 500)}`);
  }
}

type AgentResult = {
  task: string; success: boolean; failure?: string; unintendedSideEffects: string[]; approvalsAsked?: number;
  inputTokens: number; outputTokens: number; turns: number; toolCalls: number; wallMs: number; answer: string;
};

type Drive = { answer: string; input: number; output: number; turns: number; toolCalls: number; failure?: string };

/** The api harness: our own loop on the Messages API, calling the MCP server directly. */
async function driveApi(goal: string, env: NodeJS.ProcessEnv): Promise<Drive> {
  const run: Drive = { answer: '', input: 0, output: 0, turns: 0, toolCalls: 0 };
  const { client, tools } = await startServer(server, env);
  try {
    const history: Message[] = [{ role: 'user', content: goal }];
    const apiTools = tools.map((tool) => ({ name: tool.name, description: tool.description ?? '', input_schema: { type: 'object', ...tool.inputSchema } }));
    for (;;) {
      if (run.turns >= maxTurns) { run.failure = `no final answer within ${maxTurns} turns`; break; }
      run.turns++;
      const reply = await messages({ model, max_tokens: 4096, system: SYSTEM, tools: apiTools, messages: history });
      run.input += reply.usage.input_tokens + (reply.usage.cache_creation_input_tokens ?? 0) + (reply.usage.cache_read_input_tokens ?? 0);
      run.output += reply.usage.output_tokens;
      history.push({ role: 'assistant', content: reply.content });
      const uses = reply.content.filter((block) => block.type === 'tool_use');
      if (!uses.length) {
        run.answer = reply.content.flatMap((block) => block.type === 'text' ? [block.text] : []).join('\n');
        break;
      }
      const results: ContentBlock[] = [];
      for (const use of uses) {
        run.toolCalls++;
        try {
          const result = await client.request('tools/call', { name: use.name, arguments: use.input });
          const content = (result.content as McpContent[] | undefined ?? []).map((block) => block.type === 'image' && block.data
            ? { type: 'image' as const, source: { type: 'base64' as const, media_type: block.mimeType ?? 'image/png', data: block.data } }
            : { type: 'text' as const, text: block.text ?? JSON.stringify(block) });
          results.push({ type: 'tool_result', tool_use_id: use.id, content: content.length ? content : [{ type: 'text', text: '(empty result)' }], ...(result.isError ? { is_error: true } : {}) });
        } catch (error) {
          results.push({ type: 'tool_result', tool_use_id: use.id, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], is_error: true });
        }
      }
      history.push({ role: 'user', content: results });
    }
  } finally {
    await client.close();
  }
  return run;
}

/**
 * The claude-code harness: `claude -p` in an empty directory with the MCP server as its only tools, reading its
 * stream-json output for tool calls, the final answer, and token usage.
 */
async function driveClaudeCode(goal: string, env: NodeJS.ProcessEnv): Promise<Drive> {
  const run: Drive = { answer: '', input: 0, output: 0, turns: 0, toolCalls: 0 };
  const dir = mkdtempSync(join(tmpdir(), 'foxpaw-agent-'));
  const [command, ...args] = serverCommand(server);
  const config = join(dir, 'mcp.json');
  writeFileSync(config, JSON.stringify({ mcpServers: { browser: { command, args, env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) } } }));
  try {
    const child = spawn('claude', [
      '-p', goal, '--model', model, '--max-turns', String(maxTurns),
      '--mcp-config', config, '--strict-mcp-config', '--tools', '', '--allowedTools', 'mcp__browser',
      '--append-system-prompt', SYSTEM, '--output-format', 'stream-json', '--verbose', '--no-session-persistence',
    ], { cwd: dir, env: process.env, stdio: ['ignore', 'pipe', 'inherit'] });
    for await (const line of createInterface({ input: child.stdout! })) {
      if (!line.trim()) continue;
      let event: JsonObject;
      try { event = JSON.parse(line) as JsonObject; } catch { continue; }
      if (event.type === 'assistant') {
        const content = ((event.message as JsonObject | undefined)?.content ?? []) as Array<{ type: string }>;
        run.toolCalls += content.filter((block) => block.type === 'tool_use').length;
      } else if (event.type === 'result') {
        const usage = (event.usage ?? {}) as Record<string, number | undefined>;
        run.input = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
        run.output = usage.output_tokens ?? 0;
        run.turns = Number(event.num_turns ?? 0);
        run.answer = typeof event.result === 'string' ? event.result : '';
        if (event.is_error === true || event.subtype !== 'success') run.failure = `claude ended with ${String(event.subtype)}`;
      }
    }
    const code = await new Promise<number | null>((done) => child.once('close', done));
    if (code !== 0 && !run.failure) run.failure = `claude exited with ${code}`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return run;
}

async function runTask(task: Task, fixtures: Fixtures, bench: BenchEnv): Promise<AgentResult> {
  fixtures.reset();
  bench.configure(fixtures.origins, task.approver);
  if (server === 'foxpaw') await bench.launch(values.browser);
  const env = server === 'foxpaw' ? { ...process.env, ...bench.vars } : process.env;
  const startedAt = performance.now();
  const goal = task.goal(fixtures.origins, server, bench.uploadFile);
  let run: Drive;
  try {
    run = harness === 'claude-code' ? await driveClaudeCode(goal, env) : await driveApi(goal, env);
  } finally {
    if (server === 'foxpaw') await bench.stopBrowser();
  }
  const { answer, turns, toolCalls } = run;
  const usage = { input: run.input, output: run.output };
  let failure = run.failure;
  const { unintended, missing } = compareSideEffects(task.expected, fixtures.sideEffects());
  failure ??= task.check({ state: fixtures.state, requests: fixtures.requests, answer, ...(server === 'foxpaw' ? { downloadDir: bench.downloadDir } : {}) });
  failure ??= missing.length ? `expected side effects missing: ${missing.join(', ')}` : undefined;
  failure ??= unintended.length ? `unintended side effects: ${unintended.join(', ')}` : undefined;
  return {
    task: task.id, success: failure === undefined, ...(failure ? { failure } : {}), unintendedSideEffects: unintended,
    ...(server === 'foxpaw' ? { approvalsAsked: bench.approvals() } : {}),
    inputTokens: usage.input, outputTokens: usage.output, turns, toolCalls, wallMs: Math.round(performance.now() - startedAt), answer,
  };
}

const bench = await createBenchEnv(LOGIN.password);
const fixtures = await startFixtures();
const results: AgentResult[] = [];
let exitCode = 0;
try {
  for (const task of tasks) {
    const result = await runTask(task, fixtures, bench);
    results.push(result);
    console.error(`${result.success ? 'ok  ' : 'FAIL'} ${task.id} in ${result.inputTokens} out ${result.outputTokens} tokens${result.failure ? `: ${result.failure}` : ''}`);
  }
} catch (error) {
  // An API or server failure ends the run; tasks that did not finish are not reported.
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  exitCode = 1;
} finally {
  await fixtures.close();
  await bench.cleanup();
}

if (results.length) {
  const date = new Date().toISOString().slice(0, 10);
  const name = `${date}-agent-${harness}-${server}-${model.replace(/[^A-Za-z0-9.-]/g, '_')}`;
  const sum = (key: 'inputTokens' | 'outputTokens' | 'toolCalls' | 'wallMs') => results.reduce((total, result) => total + result[key], 0);
  const markdown = [
    `# foxpaw agent benchmark, ${date}`,
    '',
    `Server: ${server}. Harness: ${harness}. Model: ${model}. ${results.filter((result) => result.success).length}/${results.length} tasks succeeded${results.length < tasks.length ? ` (run stopped after ${results.length} of ${tasks.length})` : ''}.`,
    '',
    '| task | success | unintended side effects | input tokens | output tokens | tool calls | wall ms |',
    '|---|---|---|---|---|---|---|',
    ...results.map((result) => `| ${result.task} | ${result.success ? 'yes' : 'no'} | ${result.unintendedSideEffects.length} | ${result.inputTokens} | ${result.outputTokens} | ${result.toolCalls} | ${result.wallMs} |`),
    `| **total** | ${results.filter((result) => result.success).length}/${results.length} | ${results.reduce((total, result) => total + result.unintendedSideEffects.length, 0)} | ${sum('inputTokens')} | ${sum('outputTokens')} | ${sum('toolCalls')} | ${sum('wallMs')} |`,
    ...(results.some((result) => result.failure) ? ['', 'Failures:', '', ...results.filter((result) => result.failure).map((result) => `- ${result.task}: ${result.failure}`)] : []),
    '',
  ].join('\n');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `${name}.json`), `${JSON.stringify({ date, suite: 'agent', harness, server, model, maxTurns, tasks: results }, null, 2)}\n`);
  writeFileSync(join(outDir, `${name}.md`), markdown);
  console.log(markdown);
  if (results.some((result) => !result.success)) exitCode = 1;
}
process.exit(exitCode);
