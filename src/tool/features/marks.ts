import { randomBytes } from 'node:crypto';
import type { z as Zod } from 'zod';
import type { Box } from '../../locator.ts';
import type { ActionCall, ToolFeature } from '../core.ts';
import { PageHandles, readTab } from './page-model.ts';

const MARKS_LIMIT = 300;
export type Mark = { n: number; handle: string; role: string; name: string | null; box: Box };
type Drawn = { token: string; frames: string[]; marks: Mark[]; truncated: boolean };

// Draws numbered boxes (frame-viewport coordinates) in a closed shadow root, positioned in document coordinates so
// full-page captures line up too. The host carries only a random token, for removal.
const drawFunction = `(boxes, token) => {
  const html = document.documentElement;
  const positioned = getComputedStyle(html).position !== 'static';
  const origin = positioned ? { x: html.getBoundingClientRect().left + html.clientLeft, y: html.getBoundingClientRect().top + html.clientTop } : { x: -scrollX, y: -scrollY };
  const host = document.createElement('div');
  host.setAttribute('data-foxpaw-marks', token);
  host.style.cssText = 'all:initial;position:absolute;left:0;top:0;width:0;height:0;overflow:visible;z-index:2147483647;pointer-events:none';
  const root = host.attachShadow({ mode: 'closed' });
  for (const mark of boxes) {
    const box = document.createElement('div');
    box.style.cssText = 'position:absolute;box-sizing:border-box;border:2px solid #e11d48;left:' + (mark.x - origin.x) + 'px;top:' + (mark.y - origin.y) + 'px;width:' + mark.width + 'px;height:' + mark.height + 'px';
    const label = document.createElement('span');
    label.textContent = String(mark.n);
    label.style.cssText = 'position:absolute;left:-2px;top:-2px;background:#e11d48;color:#fff;font:bold 11px/13px monospace;padding:0 3px';
    box.append(label);
    root.append(box);
  }
  html.append(host);
  return true;
}`;
const removeExpression = (token: string) => `document.querySelectorAll('[data-foxpaw-marks=${JSON.stringify(token)}]').forEach((host) => host.remove())`;

/**
 * `screenshot` with `marks: true`: numbered boxes over the interactive elements in view (every frame), drawn just for
 * the capture and removed right after, plus `marks` mapping each number to its el_* handle (the same handles
 * `snapshot` gives).
 */
export function marksFeature(handles: PageHandles): ToolFeature {
  const drawn = new WeakMap<ActionCall, Drawn>();
  return {
    name: 'marks',
    params: (z: typeof Zod) => ({
      marks: z.boolean().optional().describe('screenshot: number the interactive elements in the image and return marks [{n, handle, role, name, box}].'),
    }),
    description: [
      'Marks: `screenshot` with `marks: true` draws numbered boxes over the interactive elements in view (iframes included) for that one capture and returns `marks: [{n, handle, role, name, box}]`; act on a numbered element with its `handle`. Boxes are CSS pixels in the image (document coordinates with `fullPage`).',
    ],
    async before(call, runtime) {
      const { params } = call;
      if (call.action !== 'screenshot' || params.marks !== true) return;
      if (params.handle || params.selector || params.role || params.name !== undefined || params.locator) throw new Error('marks applies to page screenshots; drop the element target (handle, selector, role, name, locator).');
      const { context, tabId } = await runtime.target(call.action, params.tabId, params.target);
      // The core action reports an open dialog; page script would block behind it.
      if (runtime.browser.openPrompt(context.id)) return;
      const fullPage = params.fullPage === true;
      const view = await runtime.browser.evaluateValue(context.id, '({ width: innerWidth, height: innerHeight, x: scrollX, y: scrollY })') as { width: number; height: number; x: number; y: number };
      const page = await readTab(runtime.browser, context.id, { max: MARKS_LIMIT, interactiveOnly: true });
      const state = handles.tab(tabId, page.top.documentId);
      const shown = page.nodes.filter(({ interactive, viewBox: box }) => interactive && box.width > 0 && box.height > 0
        && (fullPage || (box.x < view.width && box.y < view.height && box.x + box.width > 0 && box.y + box.height > 0)));
      const token = randomBytes(8).toString('hex');
      const marks: Mark[] = [];
      const byFrame = new Map<string, Array<Box & { n: number }>>();
      for (const [index, node] of shown.entries()) {
        const n = index + 1;
        const box = fullPage ? { ...node.viewBox, x: node.viewBox.x + view.x, y: node.viewBox.y + view.y } : node.viewBox;
        marks.push({ n, handle: handles.handleFor(runtime, tabId, state, node), role: node.role, name: node.name, box });
        byFrame.set(node.frame.context, [...byFrame.get(node.frame.context) ?? [], { n, ...node.box }]);
      }
      const entry: Drawn = { token, frames: [...byFrame.keys()], marks, truncated: page.truncated };
      drawn.set(call, entry);
      try {
        for (const [frame, boxes] of byFrame) await runtime.browser.evaluateValue(frame, `(${drawFunction})(${JSON.stringify(boxes)}, ${JSON.stringify(token)})`);
      } catch (error) {
        drawn.delete(call);
        await Promise.all(entry.frames.map((frame) => runtime.browser.evaluateValue(frame, removeExpression(token)).catch(() => undefined)));
        throw new Error(`Could not draw screenshot marks: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    async after(call, outcome, runtime) {
      const entry = drawn.get(call);
      if (!entry) return;
      drawn.delete(call);
      await Promise.all(entry.frames.map((frame) => runtime.browser.evaluateValue(frame, removeExpression(entry.token)).catch(() => undefined)));
      if (!outcome.result) return;
      return { ...outcome, result: { ...outcome.result, details: { ...outcome.result.details, marks: entry.marks, ...(entry.truncated ? { marksTruncated: true } : {}) } } };
    },
  };
}
