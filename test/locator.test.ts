import { expect, test } from 'bun:test';
import { documentFrame, resolveLocator, semanticSnapshot } from '../src/locator.ts';

test('rejects a locator whose frame document changed', async () => {
  const evaluate = async () => 'second';
  await expect(resolveLocator(evaluate, 'frame', { css: '#save', frame: { context: 'frame', documentId: 'first' } })).rejects.toThrow('Stale element handle');
});

test('records a lifecycle-scoped document ID', async () => {
  await expect(documentFrame(async () => 'https://example.test\u0000123', 'frame')).resolves.toEqual({ context: 'frame', documentId: 'https://example.test\u0000123' });
});

test('executes an inspection snapshot with its requested mode', async () => {
  const expressions: string[] = [];
  const page = {
    getElementById: () => null,
    querySelectorAll: () => [{
      id: '',
      tagName: 'DIV',
      nodeType: 1,
      parentElement: null,
      getRootNode: () => page,
      tabIndex: -1,
      innerText: 'Example',
      textContent: 'Example',
      getAttribute: () => null,
      getClientRects: () => [{}],
      matches: () => false,
      closest: () => null,
    }],
  };
  const evaluate = async (_context: string, expression: string) => {
    expressions.push(expression);
    if (expressions.length === 1) return 'https://example.test\u0000123';
    return Function('document', 'CSS', 'HTMLInputElement', 'ShadowRoot', 'Node', `return ${expression}`)(
      page,
      { escape: (value: string) => value },
      class HTMLInputElement {},
      class ShadowRoot {},
      { ELEMENT_NODE: 1 },
    );
  };

  await expect(semanticSnapshot(evaluate, { context: 'frame', documentId: 'https://example.test\u0000123' }, 'content', 100)).resolves.toMatchObject([{ tag: 'div', text: 'Example' }]);
});

test('scopes an interactive snapshot to its root and includes a matching root control', async () => {
  const checkbox = {
    id: 'terms',
    tagName: 'INPUT',
    nodeType: 1,
    parentElement: null,
    getRootNode: () => page,
    tabIndex: -1,
    innerText: '',
    textContent: '',
    getAttribute: () => null,
    getClientRects: () => [{}],
    matches: (selector: string) => selector === 'input[type=checkbox]' || selector === '*',
    closest: () => null,
    querySelectorAll: () => [],
  };
  const page = {
    getElementById: () => null,
    querySelectorAll: (selector: string) => selector === 'input[type=checkbox]' ? [checkbox] : [],
  };
  const evaluate = async (_context: string, expression: string) => {
    if (expression === 'location.href + "\\u0000" + performance.timeOrigin') return 'https://example.test\u0000123';
    return Function('document', 'CSS', 'HTMLInputElement', 'ShadowRoot', 'Node', `return ${expression}`)(
      page,
      { escape: (value: string) => value },
      class HTMLInputElement {},
      class ShadowRoot {},
      { ELEMENT_NODE: 1 },
    );
  };

  await expect(semanticSnapshot(evaluate, { context: 'frame', documentId: 'https://example.test\u0000123' }, 'interactive', 100, 'input[type=checkbox]')).resolves.toMatchObject([
    { selector: '#terms', tag: 'input', role: 'checkbox' },
  ]);
});

test('resolves a number input by its implicit spinbutton role', async () => {
  const input = {
    id: 'amount',
    nodeType: 1,
    tagName: 'INPUT',
    innerText: '',
    textContent: '',
    parentElement: null,
    getAttribute: (attribute: string) => attribute === 'aria-label' ? 'Amount' : null,
    getClientRects: () => [{}],
    getRootNode: () => document,
    matches: (selector: string) => selector === 'input[type=number]',
  };
  const document = {
    getElementById: () => null,
    querySelectorAll: () => [input],
  };
  const evaluate = async (_context: string, expression: string) => {
    if (expression === 'location.href + "\\u0000" + performance.timeOrigin') return 'https://example.test\u0000123';
    return Function('document', 'CSS', 'HTMLInputElement', 'ShadowRoot', 'Node', `return ${expression}`)(
      document,
      { escape: (value: string) => value },
      class HTMLInputElement {},
      class ShadowRoot {},
      { ELEMENT_NODE: 1 },
    );
  };

  await expect(resolveLocator(evaluate, 'frame', { role: 'spinbutton', name: 'Amount' })).resolves.toMatchObject({
    selector: '#amount',
    identity: { tag: 'input', role: 'spinbutton', name: 'Amount' },
  });
});
