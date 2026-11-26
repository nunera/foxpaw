export type FrameRef = { context: string; documentId: string };
export type Locator = { css?: string; role?: string; name?: string; exact?: boolean; checked?: boolean; disabled?: boolean; within?: string; frame?: FrameRef };
export type ElementIdentity = { tag: string; role: string | null; name: string | null };
export type ResolvedLocator = { selector: string; frame: FrameRef; identity: ElementIdentity };

type Evaluator = (context: string, expression: string) => Promise<unknown>;

// Inspection and action resolution must select the same node, including controls without IDs.
const selectorFunction = `element => {
  const segment = node => {
    const root = node.getRootNode();
    const parts = [];
    while (node && node.nodeType === Node.ELEMENT_NODE) {
      if (node.id) {
        const byId = '#' + CSS.escape(node.id);
        if (root.querySelectorAll(byId).length === 1) { parts.unshift(byId); break; }
      }
      const siblings = node.parentElement ? [...node.parentElement.children].filter(s => s.tagName === node.tagName) : [];
      parts.unshift(node.tagName.toLowerCase() + (siblings.length > 1 ? ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')' : ''));
      node = node.parentElement;
    }
    return parts.join(' > ');
  };
  const root = element.getRootNode();
  return root instanceof ShadowRoot ? css(root.host) + ' >>> ' + segment(element) : segment(element);
}`;

export async function documentFrame(evaluate: Evaluator, context: string): Promise<FrameRef> {
  const value = await evaluate(context, 'location.href + "\\u0000" + performance.timeOrigin');
  if (typeof value !== 'string') throw new Error('Firefox did not return a frame document ID');
  return { context, documentId: value };
}

export async function resolveLocator(evaluate: Evaluator, context: string, locator: Locator): Promise<ResolvedLocator> {
  const frame = locator.frame ?? await documentFrame(evaluate, context);
  const current = await documentFrame(evaluate, frame.context);
  if (current.documentId !== frame.documentId) throw new Error('Stale element handle. Call inspect again.');
  if (!locator.css && !locator.role) throw new Error('A locator requires css or role');
  const result = await evaluate(frame.context, `(() => {
    const locator = ${JSON.stringify({ ...locator, frame: undefined })};
    const scope = locator.within ? document.querySelector(locator.within) : document;
    if (!scope) throw new Error('No scope matches ' + locator.within);
    const parts = locator.css?.split('>>>').map(part => part.trim()).filter(Boolean);
    const all = [];
    const walk = root => {
      for (const element of root.querySelectorAll('*')) { all.push(element); if (element.shadowRoot) walk(element.shadowRoot); }
    };
    const findCss = () => {
      if (!parts) return all;
      let roots = [scope];
      for (const part of parts) {
        const next = [];
        for (const root of roots) for (const element of root.querySelectorAll(part)) next.push(element);
        roots = next.map(element => element.shadowRoot ?? element);
      }
      return roots.map(root => root.host ?? root).filter(element => element instanceof Element);
    };
    ${semanticFunctions}
    const css = ${selectorFunction};
    walk(scope);
    const plain = locator.css && locator.role === undefined && locator.name === undefined && locator.checked === undefined && locator.disabled === undefined && locator.within === undefined && !locator.css.includes('>>>');
    const candidates = plain
      ? [...document.querySelectorAll(locator.css)]
      : findCss().filter(element => {
        const currentRole = role(element);
        const checked = element instanceof HTMLInputElement ? element.checked : element.getAttribute('aria-checked') === 'true';
        const disabled = 'disabled' in element ? Boolean(element.disabled) : element.getAttribute('aria-disabled') === 'true';
        return (!locator.role || currentRole === locator.role) && (locator.name === undefined || (locator.exact === false ? (name(element) || '').includes(locator.name) : name(element) === locator.name)) && (locator.checked === undefined || checked === locator.checked) && (locator.disabled === undefined || disabled === locator.disabled);
      });
    if (candidates.length !== 1) throw new Error('Expected exactly one locator match, found ' + candidates.length);
    const element = candidates[0];
    const rawUnique = locator.css && !locator.css.includes('>>>') && (() => { const matches = document.querySelectorAll(locator.css); return matches.length === 1 && matches[0] === element; })();
    return { selector: rawUnique ? locator.css : css(element), identity: { tag: element.tagName.toLowerCase(), role: role(element), name: name(element) } };
  })()`);
  if (!result || typeof result !== 'object') throw new Error('Firefox returned malformed locator result');
  const record = result as { selector?: unknown; identity?: ElementIdentity };
  if (typeof record.selector !== 'string' || !record.identity) throw new Error('Firefox returned malformed locator result');
  return { selector: record.selector, frame, identity: record.identity };
}

// Shared by inspection, locator resolution, and action-time verification so identities compare equal.
export const semanticFunctions = `
    const text = element => (element.innerText || element.textContent || '').trim().replace(/\\s+/g, ' ');
    const role = element => element.getAttribute('role') || (element.matches('a[href]') ? 'link' : element.matches('button') ? 'button' : element.matches('select') ? 'combobox' : element.matches('textarea,input:not([type]),input[type=text],input[type=email],input[type=password],input[type=search],input[type=tel],input[type=url]') ? 'textbox' : element.matches('input[type=number]') ? 'spinbutton' : element.matches('input[type=checkbox]') ? 'checkbox' : element.matches('input[type=radio]') ? 'radio' : null);
    const name = element => { const ids = element.getAttribute('aria-labelledby'); const labelled = ids?.split(/\\s+/).map(id => document.getElementById(id)?.textContent?.trim() || '').filter(Boolean).join(' '); return labelled || element.getAttribute('aria-label') || ('labels' in element && element.labels?.length ? [...element.labels].map(text).join(' ') : null) || element.getAttribute('alt') || element.getAttribute('title') || element.getAttribute('placeholder') || text(element) || null; };
`;

export async function queryElements(evaluate: Evaluator, context: string, selector: string, fields?: Record<string, string>): Promise<unknown[]> {
  if (!selector?.trim()) throw new Error('query requires selector');
  const value = await evaluate(context, `(() => {
    ${semanticFunctions}
    const fields = ${JSON.stringify(fields ?? { tag: 'tag', role: 'role', name: 'name', text: 'text' })};
    const sensitive = field => /(?:csrf|token|secret|session|auth|password|oauth)/i.test(field);
    return [...document.querySelectorAll(${JSON.stringify(selector)})].map(element =>
      Object.fromEntries(Object.entries(fields).map(([key, field]) => [key,
        field === 'tag' ? element.tagName.toLowerCase() :
        field === 'role' ? role(element) :
        field === 'name' ? name(element) :
        field === 'text' ? text(element) :
        (element instanceof HTMLInputElement && element.type === 'password' && field === 'value') || sensitive(field) ? '[REDACTED]' : element.getAttribute(field)
      ]))
    );
  })()`);
  if (!Array.isArray(value)) throw new Error('Firefox returned malformed query result');
  return value;
}

export async function semanticSnapshot(evaluate: Evaluator, frame: FrameRef, mode: 'interactive' | 'content' | 'semantic', maxElements: number, root?: string): Promise<unknown[]> {
  const current = await documentFrame(evaluate, frame.context);
  if (current.documentId !== frame.documentId) throw new Error('Stale frame. Call inspect again.');
  const selectors = mode === 'content' ? 'h1,h2,h3,h4,h5,h6,p,li,dt,dd,td,th' : '*';
  const value = await evaluate(frame.context, `(() => {
    const mode = ${JSON.stringify(mode)};
    const rootSelector = ${JSON.stringify(root?.trim() ?? '')};
    ${semanticFunctions}
    const css = ${selectorFunction};
    const interactive = element => !element.matches('input[type=password]') && (Boolean(role(element)) || element.tabIndex >= 0 || element.matches('[onclick],[onpointerdown],[contenteditable=true]'));
    const scope = (() => {
      if (!rootSelector) return [document];
      let roots = [document];
      for (const part of rootSelector.split('>>>').map(part => part.trim()).filter(Boolean)) {
        const next = [];
        for (const current of roots) for (const element of current.querySelectorAll(part)) next.push(element);
        roots = next.map(element => element.shadowRoot ?? element);
      }
      return roots.map(current => current.host ?? current);
    })();
    return scope.flatMap(root => [...(root.matches?.(${JSON.stringify(selectors)}) ? [root] : []), ...root.querySelectorAll(${JSON.stringify(selectors)})]).filter(element => element.getClientRects().length && (mode !== 'interactive' || interactive(element))).slice(0, ${maxElements}).map(element => ({ selector: css(element), tag: element.tagName.toLowerCase(), role: role(element), name: name(element), text: text(element).slice(0, 240), checked: element instanceof HTMLInputElement ? element.checked : element.getAttribute('aria-checked'), disabled: 'disabled' in element ? Boolean(element.disabled) : element.getAttribute('aria-disabled') === 'true', landmarkPath: [...element.closest('main,nav,aside,header,footer,[role=main],[role=navigation]') ? [element.closest('main,nav,aside,header,footer,[role=main],[role=navigation]')] : []].map(node => ({ tag: node.tagName.toLowerCase(), role: node.getAttribute('role'), name: node.getAttribute('aria-label') })) }));
  })()`);
  return Array.isArray(value) ? value : [];
}

export type FormField = {
  selector: string;
  id: string | null;
  kind: string;
  label: string | null;
  value: string | boolean | null;
  required: boolean;
  disabled: boolean;
  checked?: boolean;
  options?: Array<{ value: string; label: string; selected: boolean }>;
};

export type FormSchema = {
  title: string | null;
  fields: FormField[];
  submit: { selector: string; visible: boolean; disabled: boolean } | null;
};

/**
 * Compact, redacted control inventory for a scoped form or question.
 * Hidden and secret-bearing controls are deliberately excluded.
 */
export async function formSchema(evaluate: Evaluator, frame: FrameRef, root?: string): Promise<FormSchema> {
  const current = await documentFrame(evaluate, frame.context);
  if (current.documentId !== frame.documentId) throw new Error('Stale frame. Call inspect again.');
  const value = await evaluate(frame.context, `(() => {
    const rootSelector = ${JSON.stringify(root?.trim() ?? '')};
    const resolve = selector => {
      if (!selector) return document;
      let current = document;
      for (const part of selector.split('>>>').map(part => part.trim()).filter(Boolean)) {
        const element = current.querySelector(part);
        if (!element) throw new Error('No element matches ' + selector);
        current = element.shadowRoot ?? element;
      }
      return current;
    };
    const scope = resolve(rootSelector);
    const text = element => (element.innerText || element.textContent || '').trim().replace(/\\s+/g, ' ');
    const selector = ${selectorFunction};
    const visible = element => Boolean(element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden' && getComputedStyle(element).display !== 'none');
    const secret = element => element.type === 'password' || /(?:csrf|token|secret|session|auth|password|oauth)/i.test([element.name, element.id, element.autocomplete].filter(Boolean).join(' '));
    const label = element => {
      const ids = element.getAttribute('aria-labelledby');
      if (ids) {
        const labelled = ids.split(/\\s+/).map(id => document.getElementById(id)).filter(Boolean).map(text).filter(Boolean).join(' ');
        if (labelled) return labelled;
      }
      if (element.getAttribute('aria-label')) return element.getAttribute('aria-label');
      if ('labels' in element && element.labels?.length) return [...element.labels].map(text).filter(Boolean).join(' ') || null;
      return element.getAttribute('placeholder') || null;
    };
    const controls = [...scope.querySelectorAll('input,textarea,select,[contenteditable=true]')]
      .filter(element => element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement || element instanceof HTMLElement)
      .filter(element => !(element instanceof HTMLInputElement && (element.type === 'hidden' || secret(element))))
      .filter(visible)
      .map(element => {
        const input = element instanceof HTMLInputElement ? element : undefined;
        const select = element instanceof HTMLSelectElement ? element : undefined;
        const disabled = 'disabled' in element ? Boolean(element.disabled) : element.getAttribute('aria-disabled') === 'true';
        const field = {
          selector: selector(element),
          id: element.id || null,
          kind: input?.type || (select ? 'select' : element instanceof HTMLTextAreaElement ? 'textarea' : 'contenteditable'),
          label: label(element),
          value: input?.type === 'checkbox' || input?.type === 'radio' ? input.checked : (element.value ?? element.textContent ?? ''),
          required: Boolean('required' in element && element.required) || element.getAttribute('aria-required') === 'true',
          disabled,
          ...(input?.type === 'checkbox' || input?.type === 'radio' ? { checked: input.checked } : {}),
          ...(select ? { options: [...select.options].map(option => ({ value: option.value, label: option.text.trim(), selected: option.selected })) } : {}),
        };
        return field;
      });
    const titleElement = scope.querySelector('h1,h2,h3,h4,h5,h6,legend,[role=heading]');
    const submit = [...scope.querySelectorAll('button,input[type=submit],input[type=button]')].find(element => /submit|check|save|grade/i.test([element.value, text(element), element.getAttribute('aria-label')].filter(Boolean).join(' ')));
    return {
      title: titleElement ? text(titleElement) || null : null,
      fields: controls,
      submit: submit ? { selector: selector(submit), visible: visible(submit), disabled: 'disabled' in submit ? Boolean(submit.disabled) : submit.getAttribute('aria-disabled') === 'true' } : null,
    };
  })()`);
  if (!value || typeof value !== 'object') throw new Error('Firefox returned malformed form schema');
  return value as FormSchema;
}

/** A frame of a tab, as BiDi sees it: every (i)frame, same-origin or not, is its own browsing context. */
export type FrameInfo = FrameRef & { url: string; parent: string | null };
export type Box = { x: number; y: number; width: number; height: number };
/** One meaningful element of a document, from `pageNodesFunction`. `sharedId` is the BiDi node reference. */
export type PageNode = {
  sharedId: string;
  depth: number;
  /** Display role: implicit ARIA roles plus heading, landmarks, iframe, text, clickable. */
  role: string;
  name: string | null;
  value?: string;
  states: string[];
  selector: string;
  /** What handle resolution compares; names are cut at IDENTITY_NAME_LENGTH. */
  identity: ElementIdentity;
  interactive: boolean;
  /** In the frame's viewport. */
  box: Box;
  /** Set on iframe nodes: the child browsing context and where its viewport starts in this frame's viewport. */
  childContext?: string;
  contentOffset?: { x: number; y: number };
};
export type FrameNodes = { nodes: PageNode[]; truncated: boolean };
export const IDENTITY_NAME_LENGTH = 200;

/** Handle identity check: same tag and role, and the same accessible name as far as it was recorded. */
export function sameIdentity(recorded: ElementIdentity, current: ElementIdentity): boolean {
  return recorded.tag === current.tag && recorded.role === current.role
    && (recorded.name ?? '').slice(0, IDENTITY_NAME_LENGTH) === (current.name ?? '').slice(0, IDENTITY_NAME_LENGTH);
}

/** `script.callFunction` declaration taking one node: its unique selector and identity, or null once it left the document. */
export const locateNodeFunction = `element => {
  ${semanticFunctions}
  const css = ${selectorFunction};
  if (!(element instanceof Element) || !element.isConnected) return null;
  return { selector: css(element), identity: { tag: element.tagName.toLowerCase(), role: role(element), name: name(element) } };
}`;

/**
 * In-page source of a function `(options) => { nodes, truncated }` that walks one document (open shadow roots
 * included, iframes not entered) and returns its meaningful elements in document order with their nesting depth.
 * Hidden subtrees are skipped. Controls, links, and images are leaves; text blocks don't nest other text.
 * Each entry's `node` is the element itself, so BiDi returns its shared node reference.
 */
export const pageNodesFunction = `options => {
  ${semanticFunctions}
  const css = ${selectorFunction};
  const clip = (value, length) => value.length > length ? value.slice(0, length - 1) + '…' : value;
  const secret = element => element.type === 'password' || /(?:csrf|token|secret|session|auth|password|oauth)/i.test([element.name, element.id, element.autocomplete].filter(Boolean).join(' '));
  const LEAVES = new Set(['button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'switch', 'combobox', 'listbox', 'slider', 'spinbutton', 'img', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'tab', 'iframe', 'clickable']);
  const NOT_INTERACTIVE = new Set(['img', 'iframe']);
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'TITLE']);
  const sectioned = element => Boolean(element.parentElement?.closest('article,aside,main,nav,section'));
  const displayRole = element => {
    const explicit = element.getAttribute('role')?.trim().split(/\\s+/)[0];
    if (explicit) return ['presentation', 'none', 'generic'].includes(explicit) ? null : explicit;
    const tag = element.localName;
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'input') {
      const type = element.type;
      if (type === 'hidden') return null;
      if (['button', 'submit', 'reset', 'image', 'file'].includes(type)) return 'button';
      if (type === 'range') return 'slider';
    }
    const implicit = role(element);
    if (implicit) return element instanceof HTMLSelectElement && (element.multiple || element.size > 1) ? 'listbox' : implicit;
    if (tag === 'input') return 'textbox';
    if (tag === 'img') return element.getAttribute('alt') ? 'img' : null;
    if (tag === 'iframe' || tag === 'frame') return 'iframe';
    if (tag === 'summary') return 'button';
    if (tag === 'nav') return 'navigation';
    if (tag === 'main') return 'main';
    if (tag === 'aside') return 'complementary';
    if (tag === 'form') return 'form';
    if (tag === 'dialog') return 'dialog';
    if (tag === 'table') return 'table';
    if (tag === 'header' && !sectioned(element)) return 'banner';
    if (tag === 'footer' && !sectioned(element)) return 'contentinfo';
    if (element.isContentEditable && element.hasAttribute('contenteditable')) return 'textbox';
    if (element.hasAttribute('onclick') || (element.hasAttribute('tabindex') && element.tabIndex >= 0)) return 'clickable';
    return null;
  };
  const ownText = element => [...element.childNodes].some(child => child.nodeType === Node.TEXT_NODE && child.textContent.trim());
  const labelOnly = element => {
    const ids = element.getAttribute('aria-labelledby');
    const labelled = ids?.split(/\\s+/).map(id => document.getElementById(id)?.textContent?.trim() || '').filter(Boolean).join(' ');
    return labelled || element.getAttribute('aria-label') || (element instanceof HTMLTableElement ? element.caption?.textContent?.trim() : null) || null;
  };
  const displayName = (element, kind) => {
    if (kind === 'text' || kind === 'heading') return clip(text(element), 100) || null;
    if (kind === 'iframe') { let host = null; try { host = new URL(element.src).host; } catch {} return element.title || element.name || element.getAttribute('aria-label') || host; }
    if (!LEAVES.has(kind)) return labelOnly(element);
    if (element instanceof HTMLInputElement && ['button', 'submit', 'reset'].includes(element.type)) return element.value || name(element);
    // A select's text is all its options; its name comes from labels only.
    if (element instanceof HTMLSelectElement) return clip(labelOnly(element) || [...element.labels].map(text).join(' '), 100) || null;
    const value = name(element);
    return value ? clip(value, 100) : null;
  };
  const valueOf = element => {
    if (element instanceof HTMLSelectElement) return [...element.selectedOptions].map(option => option.text.trim()).join(', ');
    if (element instanceof HTMLTextAreaElement || (element instanceof HTMLInputElement && !['checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'file', 'hidden'].includes(element.type))) return secret(element) ? undefined : element.value ? clip(element.value, 40) : undefined;
    return undefined;
  };
  const statesOf = (element, kind) => {
    const states = [];
    if (kind === 'heading') states.push('h' + (element.localName.match(/^h([1-6])$/)?.[1] ?? element.getAttribute('aria-level') ?? '2'));
    const checked = element instanceof HTMLInputElement && ['checkbox', 'radio'].includes(element.type) ? (element.indeterminate ? 'mixed' : element.checked) : element.getAttribute('aria-checked') === 'mixed' ? 'mixed' : element.getAttribute('aria-checked') === 'true';
    if (checked === 'mixed') states.push('mixed'); else if (checked) states.push('checked');
    if (('disabled' in element && element.disabled) || element.getAttribute('aria-disabled') === 'true') states.push('disabled');
    const expanded = element.getAttribute('aria-expanded');
    if (expanded === 'true') states.push('expanded'); else if (expanded === 'false') states.push('collapsed');
    if (element.getAttribute('aria-selected') === 'true') states.push('selected');
    if (element.getAttribute('aria-pressed') === 'true') states.push('pressed');
    if (('required' in element && element.required) || element.getAttribute('aria-required') === 'true') states.push('required');
    if (element.getAttribute('aria-invalid') === 'true') states.push('invalid');
    if (element.getRootNode().activeElement === element) states.push('focused');
    return states;
  };
  const scopes = (() => {
    if (!options.root) return [document.documentElement];
    let roots = [document];
    for (const part of options.root.split('>>>').map(part => part.trim()).filter(Boolean)) {
      const next = [];
      for (const current of roots) for (const element of current.querySelectorAll(part)) next.push(element);
      roots = next.map(element => element.shadowRoot ?? element);
    }
    return roots.map(current => current.host ?? current).filter(element => element instanceof Element);
  })();
  const nodes = [];
  let truncated = false;
  const visit = (element, depth, inText) => {
    if (truncated || SKIP.has(element.tagName) || element.getAttribute('aria-hidden') === 'true') return;
    const style = getComputedStyle(element);
    if (!element.getClientRects().length && style.display !== 'contents') return;
    let kind = displayRole(element);
    // A label's text is already its control's name.
    if (!kind && !inText && ownText(element) && !(element instanceof HTMLLabelElement && element.control)) kind = 'text';
    const shown = kind && style.visibility !== 'hidden' && !(element instanceof HTMLInputElement && element.type === 'hidden');
    if (shown) {
      const interactive = LEAVES.has(kind) && !NOT_INTERACTIVE.has(kind);
      // Interactive-only walks keep iframes too: their child frames are read through them.
      if (!options.interactiveOnly || interactive || kind === 'iframe') {
        if (nodes.length >= options.max) { truncated = true; return; }
        const rect = element.getBoundingClientRect();
        const identityName = name(element);
        const entry = {
          node: element, depth, role: kind, name: displayName(element, kind), states: statesOf(element, kind), selector: css(element),
          identity: { tag: element.tagName.toLowerCase(), role: role(element), name: identityName === null ? null : identityName.slice(0, ${IDENTITY_NAME_LENGTH}) },
          interactive,
          box: { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) },
        };
        const value = valueOf(element);
        if (value !== undefined) entry.value = value;
        if (kind === 'iframe' && element.contentWindow) {
          const frameStyle = getComputedStyle(element);
          entry.childWindow = element.contentWindow;
          entry.contentOffset = { x: rect.left + element.clientLeft + parseFloat(frameStyle.paddingLeft), y: rect.top + element.clientTop + parseFloat(frameStyle.paddingTop) };
        }
        nodes.push(entry);
      }
      if (LEAVES.has(kind)) return;
    }
    const childDepth = shown && !options.interactiveOnly ? depth + 1 : depth;
    const childInText = inText || kind === 'text' || kind === 'heading';
    if (element.shadowRoot) for (const child of element.shadowRoot.children) visit(child, childDepth, childInText);
    for (const child of element.children) visit(child, childDepth, childInText);
  };
  for (const scope of scopes) visit(scope, 0, false);
  return { nodes, truncated };
}`;
