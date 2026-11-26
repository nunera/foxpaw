import type { z as Zod } from 'zod';
import type { PageNode } from '../../locator.ts';
import type { ToolFeature } from '../core.ts';
import { PageHandles, readTab } from './page-model.ts';

const DEFAULT_MAX_NODES = 400;
const MAX_NODES_LIMIT = 2_000;

export type SnapshotLine = { handle: string; text: string };
/** Lines in document order: `~ ` changed and `+ ` added, then `- ` removed (their last text). Indentation is dropped. */
export type SnapshotDiff = { lines: string[]; added: number; removed: number; changed: number; unchanged: number };

/** `role "name" = "value" [states] handle`, indented two spaces per nesting level. */
export function snapshotLine(node: Pick<PageNode, 'depth' | 'role' | 'name' | 'value' | 'states'>, handle: string): string {
  const parts = [`${'  '.repeat(node.depth)}${node.role}`];
  if (node.name) parts.push(JSON.stringify(node.name));
  if (node.value !== undefined) parts.push(`= ${JSON.stringify(node.value)}`);
  if (node.states.length) parts.push(`[${node.states.join(', ')}]`);
  parts.push(handle);
  return parts.join(' ');
}

/** Compares lines by handle: a handle names the same element across snapshots of one document. */
export function diffSnapshot(previous: ReadonlyMap<string, string>, current: readonly SnapshotLine[]): SnapshotDiff {
  const lines: string[] = [];
  const present = new Set<string>();
  let added = 0;
  let changed = 0;
  let unchanged = 0;
  for (const line of current) {
    present.add(line.handle);
    const before = previous.get(line.handle);
    if (before === line.text) unchanged++;
    else if (before === undefined) { added++; lines.push(`+ ${line.text.trimStart()}`); }
    else { changed++; lines.push(`~ ${line.text.trimStart()}`); }
  }
  let removed = 0;
  for (const [handle, text] of previous) {
    if (present.has(handle)) continue;
    removed++;
    lines.push(`- ${text.trimStart()}`);
  }
  return { lines, added, removed, changed, unchanged };
}

/** Rough token count of text sent to a model (about four characters per token). */
export const approximateTokens = (text: string) => Math.ceil(text.length / 4);

/**
 * `snapshot`: a compact text tree of the tab (every frame), one line per meaningful element, each with an el_* handle
 * that every element action accepts. Later snapshots of the same document return only what changed.
 */
export function snapshotFeature(handles: PageHandles): ToolFeature {
  return {
    name: 'snapshot',
    params: (z: typeof Zod) => ({
      full: z.boolean().optional().describe('snapshot: return the whole tree, not a diff against the previous snapshot of this document.'),
      maxNodes: z.number().int().positive().max(MAX_NODES_LIMIT).optional().describe(`snapshot: most lines to return (default ${DEFAULT_MAX_NODES}).`),
    }),
    description: [
      `Snapshots: \`snapshot\` {tabId, root?, maxNodes?, full?} returns \`tree\`, one line per meaningful element of the page and its iframes (cross-origin too): \`role "name" = "value" [states] el_N\`, indented by nesting. Handles are stable: the same element keeps its el_N across snapshots until the page navigates, and every element action accepts it as \`handle\`. A later snapshot of the same document returns \`mode: "diff"\` with only \`~\` changed, \`+\` added, and \`-\` removed lines plus \`unchanged\` (a count); \`full: true\` forces the whole tree. Prefer it over inspect for reading a page; snapshot again after acting to see what changed.`,
    ],
    actions: {
      async snapshot(call, runtime) {
        const { params } = call;
        const { context, tabId } = await runtime.target(call.action, params.tabId, params.target);
        await runtime.browser.watchPrompts();
        const prompt = runtime.browser.openPrompt(context.id);
        if (prompt) throw new Error(JSON.stringify({ tabId, action: call.action, actionPerformed: false, error: 'A page dialog is open in this tab. Call dialog first.', openPrompt: prompt }));
        const maxNodes = typeof params.maxNodes === 'number' ? params.maxNodes : DEFAULT_MAX_NODES;
        const root = params.root?.trim() || undefined;
        const page = await readTab(runtime.browser, context.id, { root, max: maxNodes });
        const state = handles.tab(tabId, page.top.documentId);
        const lines = page.nodes.map((node) => {
          const handle = handles.handleFor(runtime, tabId, state, node);
          return { handle, text: snapshotLine(node, handle) };
        });
        const tree = lines.map((line) => line.text).join('\n');
        // A diff only compares like with like: the same scope and limit.
        const scope = JSON.stringify([root ?? null, maxNodes]);
        const previous = params.full !== true && state.baseline?.scope === scope ? state.baseline.lines : undefined;
        state.baseline = { scope, lines: new Map(lines.map((line) => [line.handle, line.text])) };
        const frames = page.frames.slice(1).map((frame) => ({ context: frame.context, url: frame.url }));
        const summary = { tabId, url: page.top.url, ...(frames.length ? { frames } : {}), nodes: lines.length, ...(page.truncated ? { truncated: true } : {}) };
        if (!previous) return { details: { ...summary, mode: 'full', tree, tokens: { full: approximateTokens(tree) } } };
        const diff = diffSnapshot(previous, lines);
        const text = diff.lines.join('\n');
        return {
          details: {
            ...summary,
            mode: 'diff',
            diff: text,
            added: diff.added,
            removed: diff.removed,
            changed: diff.changed,
            unchanged: diff.unchanged,
            tokens: { full: approximateTokens(tree), diff: approximateTokens(text) },
          },
        };
      },
    },
  };
}
