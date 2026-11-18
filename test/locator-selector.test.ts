import { expect, test } from 'bun:test';
import { resolveLocator } from '../src/locator.ts';

// Minimal DOM: just enough selector grammar for what resolveLocator emits and the tests request:
// compound = tag? #id? [attr=value]? :nth-of-type(n)?, joined by " > ".
class FakeElement {
  nodeType = 1;
  children: FakeElement[] = [];
  parentElement: FakeElement | null = null;
  constructor(readonly tagName: string, readonly attrs: Record<string, string> = {}, readonly label: string | null = null) {}
  get id() { return this.attrs.id ?? ''; }
  get checked() { return false; }
  get innerText() { return this.label ?? ''; }
  get textContent() { return this.label ?? ''; }
  get shadowRoot() { return null; }
  get labels() { return this.label ? [{ innerText: this.label, textContent: this.label }] : []; }
  add(child: FakeElement) { child.parentElement = this; this.children.push(child); return child; }
  getAttribute(name: string) { return this.attrs[name] ?? null; }
  getRootNode(): unknown { return fakeDocument; }
  getClientRects() { return [{}]; }
  querySelectorAll(selector: string) { return all(this).filter(element => element !== this && matchesChain(element, selector)); }
  matches(selector: string) {
    // Role detection only: comma lists of tag, tag[attr], tag[attr=value], tag:not([attr]).
    return selector.split(',').some(part => {
      const parsed = /^([a-z]+)(?:\[([a-z-]+)(?:=([^\]]+))?\]|:not\(\[([a-z-]+)\]\))?$/.exec(part.trim());
      if (!parsed) throw new Error('Unsupported matches selector ' + part);
      const [, tag, attr, value, notAttr] = parsed;
      if (this.tagName.toLowerCase() !== tag) return false;
      if (attr && (value === undefined ? !(attr in this.attrs) : this.attrs[attr] !== value)) return false;
      return !(notAttr && notAttr in this.attrs);
    });
  }
}

function all(root: FakeElement): FakeElement[] {
  return root.children.flatMap(child => [child, ...all(child)]);
}

function matchesCompound(element: FakeElement, compound: string): boolean {
  const parsed = /^([a-z]+|\*)?(?:#([^\s\[:]+))?(?:\[([a-z-]+)=([^\]]+)\])?(?::nth-of-type\((\d+)\))?$/i.exec(compound.trim());
  if (!parsed) throw new Error('Unsupported selector ' + compound);
  const [, tag, id, attr, value, nth] = parsed;
  if (tag && tag !== "*" && element.tagName.toLowerCase() !== tag.toLowerCase()) return false;
  if (id && element.id !== id) return false;
  if (attr && element.attrs[attr] !== value) return false;
  if (nth) {
    const same = element.parentElement?.children.filter(sibling => sibling.tagName === element.tagName) ?? [element];
    if (same.indexOf(element) + 1 !== Number(nth)) return false;
  }
  return true;
}

function matchesChain(element: FakeElement, selector: string): boolean {
  const parts = selector.split(' > ');
  let node: FakeElement | null = element;
  for (let index = parts.length - 1; index >= 0; index--) {
    if (!node || !matchesCompound(node, parts[index]!)) return false;
    node = index > 0 ? node.parentElement : node;
  }
  return true;
}

const html = new FakeElement('HTML');
const body = html.add(new FakeElement('BODY'));
const fakeDocument = {
  getElementById: (id: string) => all(html).find(element => element.id === id) ?? null,
  querySelectorAll: (selector: string) => [html, ...all(html)].filter(element => matchesChain(element, selector)),
};

async function resolve(locator: Parameters<typeof resolveLocator>[2]) {
  const evaluate = async (_context: string, expression: string) => {
    if (expression === 'location.href + "\\u0000" + performance.timeOrigin') return 'https://example.test\u0000123';
    return Function('document', 'CSS', 'Element', 'HTMLInputElement', 'ShadowRoot', 'Node', `return ${expression}`)(
      fakeDocument,
      { escape: (value: string) => value },
      FakeElement,
      class HTMLInputElement {},
      class ShadowRoot {},
      { ELEMENT_NODE: 1 },
    );
  };
  return resolveLocator(evaluate, 'frame', locator);
}

test('role+name narrows same-CSS checkboxes and returns a selector for only the named one', async () => {
  const form = body.add(new FakeElement('FORM'));
  const first = form.add(new FakeElement('INPUT', { type: 'checkbox' }, 'Email me'));
  const second = form.add(new FakeElement('INPUT', { type: 'checkbox' }, 'Text me'));

  const resolved = await resolve({ css: 'input[type=checkbox]', role: 'checkbox', name: 'Text me' });

  expect(resolved.identity.name).toBe('Text me');
  expect(fakeDocument.querySelectorAll(resolved.selector)).toEqual([second]);
  expect(fakeDocument.querySelectorAll(resolved.selector)).not.toContain(first);
  body.children.pop();
});

test('name alone filters css matches instead of taking the plain fast path', async () => {
  const form = body.add(new FakeElement('FORM'));
  form.add(new FakeElement('INPUT', { type: 'checkbox' }, 'A'));
  const b = form.add(new FakeElement('INPUT', { type: 'checkbox' }, 'B'));

  const resolved = await resolve({ css: 'input[type=checkbox]', name: 'B' });

  expect(fakeDocument.querySelectorAll(resolved.selector)).toEqual([b]);
  body.children.pop();
});

test('a unique raw css is returned unchanged', async () => {
  const form = body.add(new FakeElement('FORM'));
  form.add(new FakeElement('BUTTON', { id: 'save' }, 'Save'));

  const resolved = await resolve({ css: '#save' });

  expect(resolved.selector).toBe('#save');
  body.children.pop();
});

test('duplicate ids yield a handle selector that matches exactly one element', async () => {
  const form = body.add(new FakeElement('FORM'));
  form.add(new FakeElement('BUTTON', { id: 'dup' }, 'One'));
  const second = form.add(new FakeElement('BUTTON', { id: 'dup' }, 'Two'));

  const resolved = await resolve({ role: 'button', name: 'Two' });

  expect(resolved.selector).not.toBe('#dup');
  expect(fakeDocument.querySelectorAll(resolved.selector)).toEqual([second]);
  body.children.pop();
});
