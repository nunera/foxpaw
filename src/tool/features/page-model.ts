import type { ZenBrowser } from '../../browser.ts';
import type { Box, FrameInfo, FrameNodes, FrameRef, PageNode } from '../../locator.ts';
import type { ToolRuntime } from '../core.ts';

/** A node of any frame of a tab. Depth counts across frames: a child frame's nodes nest under its iframe's line. */
export type TabNode = PageNode & { frame: FrameRef; frameUrl: string; /** In the top-level viewport. */ viewBox: Box };
export type TabPage = { top: FrameInfo; /** Frames that were read, top first. */ frames: FrameInfo[]; nodes: TabNode[]; truncated: boolean };

/**
 * Reads a tab's meaningful nodes across all its frames: the top document, then each child frame (same- or
 * cross-origin, through its own browsing context) right after the iframe that shows it. Frames whose iframe is hidden
 * or outside `root` aren't read. `max` caps the total.
 */
export async function readTab(browser: Pick<ZenBrowser, 'frames' | 'pageNodes'>, context: string, options: { root?: string; max: number; interactiveOnly?: boolean }): Promise<TabPage> {
  const frames = await browser.frames(context);
  const top = frames[0];
  if (!top) throw new Error('The tab has no readable document');
  const byContext = new Map(frames.map((frame) => [frame.context, frame]));
  const read: FrameInfo[] = [];
  const nodes: TabNode[] = [];
  let truncated = false;
  const visit = async (frame: FrameInfo, depth: number, offset: { x: number; y: number }, root?: string): Promise<void> => {
    let page: FrameNodes;
    try {
      page = await browser.pageNodes(frame.context, { root, max: options.max - nodes.length, interactiveOnly: options.interactiveOnly });
    } catch (error) {
      // A child frame navigating away mid-read is left out; the top document's failure is the caller's.
      if (frame === top) throw error;
      return;
    }
    read.push(frame);
    if (page.truncated) truncated = true;
    for (const node of page.nodes) {
      if (nodes.length >= options.max) { truncated = true; return; }
      nodes.push({ ...node, depth: node.depth + depth, frame: { context: frame.context, documentId: frame.documentId }, frameUrl: frame.url, viewBox: { ...node.box, x: Math.round(node.box.x + offset.x), y: Math.round(node.box.y + offset.y) } });
      const child = node.childContext ? byContext.get(node.childContext) : undefined;
      if (child && node.contentOffset && !read.includes(child)) {
        await visit(child, node.depth + depth + 1, { x: offset.x + node.contentOffset.x, y: offset.y + node.contentOffset.y });
      }
    }
  };
  await visit(top, 0, { x: 0, y: 0 }, options.root);
  return { top, frames: read, nodes, truncated };
}

type TabHandles = { documentId: string; handles: Map<string, string>; baseline?: { scope: string; lines: Map<string, string> } };

/**
 * Snapshot and marks handles, per tab: the same element (BiDi node) keeps its el_* handle for as long as the tab's
 * top document lives. A new top document starts over.
 */
export class PageHandles {
  #tabs = new Map<string, TabHandles>();

  tab(tabId: string, documentId: string): TabHandles {
    let state = this.#tabs.get(tabId);
    if (!state || state.documentId !== documentId) {
      state = { documentId, handles: new Map() };
      this.#tabs.set(tabId, state);
    }
    return state;
  }

  // Re-registers on every read so a handle follows its element's current selector and name.
  handleFor(runtime: Pick<ToolRuntime, 'registerElement'>, tabId: string, state: TabHandles, node: TabNode): string {
    const key = `${node.frame.documentId}\u0000${node.sharedId}`;
    const handle = runtime.registerElement({ tabId, locator: { css: node.selector, frame: node.frame }, frame: node.frame, identity: node.identity, nodeId: node.sharedId }, state.handles.get(key));
    state.handles.set(key, handle);
    return handle;
  }
}
