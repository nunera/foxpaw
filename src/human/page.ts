import type { Hotkey } from './settings.ts';

export type OverlayConfig = { label: string; color: string; hotkey: Hotkey; visuals: boolean };
export type OverlayState = { label?: string; color?: string; paused?: boolean };
export type OverlayApi = { state(next: OverlayState): void; move(points: Array<{ x: number; y: number }>): void; remove(): void };
/** Messages the page script sends on its channel: it loaded in a document, or the user pressed the hotkey. */
export type OverlayMessage = { type: 'ready' } | { type: 'toggle' };

// The little of the DOM the script uses (this project compiles without the DOM library).
type Style = { setProperty(name: string, value: string, priority: string): void };
type PageElement = {
  style: Style; isConnected: boolean; textContent: string | null;
  append(...nodes: PageElement[]): void; remove(): void; setAttribute(name: string, value: string): void;
  attachShadow(init: { mode: 'closed' }): PageElement; getBoundingClientRect(): unknown; querySelector(selector: string): PageElement | null;
};
type PageKeyEvent = { isTrusted: boolean; repeat: boolean; code: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean; preventDefault(): void; stopImmediatePropagation(): void };
export type PageWindow = {
  top: unknown;
  document: { readyState: string; documentElement: PageElement | null; createElement(tag: string): PageElement; createElementNS(namespace: string, tag: string): PageElement };
  addEventListener(type: string, listener: (event: PageKeyEvent) => void, options?: boolean | { once: boolean }): void;
  removeEventListener(type: string, listener: (event: PageKeyEvent) => void, options?: boolean): void;
  setTimeout(callback: () => void, ms: number): number;
  clearTimeout(id: number | undefined): void;
};

/**
 * Runs in the `foxpaw` sandbox realm of an agent-controlled tab (and its frames), as a preload script for every new
 * document and once for the current one. The page cannot see or call it: the sandbox reaches the DOM through Xray
 * wrappers, and the channel back to the broker exists only in the sandbox.
 *
 * - The hotkey listener ignores synthetic (`isTrusted: false`) events, so a page cannot pause or resume the agent.
 * - The top-level document gets a corner label (agent name, active/paused), a border while paused, and the agent's
 *   cursor. They live in a closed shadow root with `pointer-events: none`: never clickable, and invisible to
 *   `elementFromPoint`, so they do not change what the agent's clicks hit. Styles are set through CSSOM, which a
 *   page's Content-Security-Policy does not block.
 *
 * Self-contained: it is sent to the browser as source text (`overlayFunction`).
 */
export function overlayMain(channel: (message: OverlayMessage) => void, config: OverlayConfig, win: PageWindow, scope: Record<string, unknown>): OverlayApi {
  const installed = scope.__foxpawOverlay as OverlayApi | undefined;
  if (installed) return installed;
  const doc = win.document;
  const state = { label: config.label, color: config.color, paused: false };
  const hotkey = config.hotkey;
  const onKey = (event: PageKeyEvent) => {
    if (!event.isTrusted || event.repeat) return;
    if (event.code !== hotkey.code || event.ctrlKey !== hotkey.ctrl || event.altKey !== hotkey.alt || event.shiftKey !== hotkey.shift || event.metaKey !== hotkey.meta) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    channel({ type: 'toggle' });
  };
  win.addEventListener('keydown', onKey, true);

  const css = (element: PageElement, properties: Record<string, string>): PageElement => {
    for (const [name, value] of Object.entries(properties)) element.style.setProperty(name, value, 'important');
    return element;
  };
  let host: PageElement | undefined;
  let label: PageElement | undefined;
  let border: PageElement | undefined;
  let cursor: PageElement | undefined;
  let cursorShown = false;
  let fade: number | undefined;
  const build = () => {
    if (host || !config.visuals || win.top !== win) return;
    host = css(doc.createElement('foxpaw-overlay'), { all: 'initial', position: 'fixed', inset: '0', display: 'block', 'pointer-events': 'none', 'z-index': '2147483647', contain: 'strict' });
    const root = host.attachShadow({ mode: 'closed' });
    border = css(doc.createElement('div'), { position: 'fixed', inset: '0', border: '3px solid #d97706', display: 'none', 'pointer-events': 'none' });
    label = css(doc.createElement('div'), {
      position: 'fixed', right: '10px', bottom: '10px', padding: '3px 9px', 'border-radius': '999px', color: '#fff',
      font: '600 11px/1.5 system-ui, sans-serif', 'letter-spacing': '0.01em', 'box-shadow': '0 1px 4px rgba(0,0,0,.35)',
      opacity: '0.9', 'pointer-events': 'none', 'white-space': 'nowrap', 'max-width': '60vw', overflow: 'hidden', 'text-overflow': 'ellipsis',
    });
    cursor = css(doc.createElementNS('http://www.w3.org/2000/svg', 'svg'), {
      position: 'fixed', left: '0', top: '0', width: '20px', height: '22px', opacity: '0', 'pointer-events': 'none',
      transition: 'transform 180ms ease-out, opacity 300ms', filter: 'drop-shadow(0 1px 2px rgba(0,0,0,.5))',
    });
    cursor.setAttribute('viewBox', '0 0 20 22');
    const arrow = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
    arrow.setAttribute('d', 'M1 1 L1 17 L5.5 13 L8.5 20 L11.5 18.7 L8.6 12 L14.5 12 Z');
    arrow.setAttribute('stroke', '#fff');
    arrow.setAttribute('stroke-width', '1.5');
    arrow.setAttribute('stroke-linejoin', 'round');
    cursor.append(arrow);
    root.append(border, label, cursor);
  };
  const render = () => {
    if (!label || !border || !cursor) return;
    label.textContent = state.paused ? `⏸ ${state.label} paused · ${hotkey.text} resumes` : `● ${state.label} · agent active · ${hotkey.text} pauses`;
    css(label, { background: state.paused ? '#b45309' : state.color });
    css(border, { display: state.paused ? 'block' : 'none' });
    cursor.querySelector('path')?.setAttribute('fill', state.color);
  };
  // Mounted once the page has loaded, after frameworks that hydrate the whole document have done so.
  const mount = () => {
    build();
    if (host && !host.isConnected && doc.documentElement) doc.documentElement.append(host);
    render();
  };
  if (doc.readyState === 'complete') mount(); else win.addEventListener('load', mount, { once: true });

  const api: OverlayApi = {
    state(next) {
      if (next.label !== undefined) state.label = next.label;
      if (next.color !== undefined) state.color = next.color;
      if (next.paused !== undefined) state.paused = next.paused;
      if (doc.readyState === 'complete') mount();
    },
    move(points) {
      mount();
      const pointer = cursor;
      if (!pointer || !points.length) return;
      if (!cursorShown) {
        // The first position is taken without animating from the corner.
        css(pointer, { transition: 'none', transform: `translate(${points[0]!.x}px, ${points[0]!.y}px)` });
        pointer.getBoundingClientRect();
        css(pointer, { transition: 'transform 180ms ease-out, opacity 300ms' });
        cursorShown = true;
      }
      let index = 0;
      const step = () => {
        const point = points[index++];
        if (!point) return;
        css(pointer, { transform: `translate(${point.x}px, ${point.y}px)`, opacity: '1' });
        if (index < points.length) win.setTimeout(step, 200);
      };
      step();
      win.clearTimeout(fade);
      fade = win.setTimeout(() => css(pointer, { opacity: '0.45' }), 2_500);
    },
    remove() {
      win.removeEventListener('keydown', onKey, true);
      win.removeEventListener('load', mount);
      win.clearTimeout(fade);
      host?.remove();
      delete scope.__foxpawOverlay;
    },
  };
  scope.__foxpawOverlay = api;
  channel({ type: 'ready' });
  return api;
}

/** The function declaration for `script.addPreloadScript` / `script.callFunction`: its one argument is the channel. */
export function overlayFunction(config: OverlayConfig): string {
  return `(channel) => (${overlayMain.toString()})(channel, ${JSON.stringify(config)}, window, globalThis)`;
}

/** Calls the installed overlay in a document's sandbox; a document without it (not loaded yet) is left alone. */
export function overlayCall(method: 'state' | 'move' | 'remove', argument?: unknown): string {
  return `() => { globalThis.__foxpawOverlay?.${method}(${argument === undefined ? '' : JSON.stringify(argument)}); }`;
}
