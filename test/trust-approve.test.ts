import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approversFor, notifySendApprover, promptText, requestApproval, type ApprovalRequest, type Runner } from '../src/trust/approve.ts';
import { parsePolicy, type ApprovalConfig } from '../src/trust/policy.ts';

const request: ApprovalRequest = {
  version: 1, site: 'https://shop.example', url: 'https://shop.example/cart', tabId: 'tab_2', action: 'click', class: 'irreversible',
  reason: '"Pay" matches "pay"; default says ask', target: { tag: 'button', role: 'button', name: 'Pay', text: 'Pay', selector: '#pay' },
  form: { action: 'https://shop.example/pay', method: 'post' }, timeoutMs: 5000,
};
const approval = (raw: unknown): ApprovalConfig => {
  const loaded = parsePolicy({ approval: raw });
  if (!loaded.ok) throw new Error(loaded.reason);
  return loaded.policy.approval;
};

test('the prompt names the site, class, action, target, and form', () => {
  const text = promptText(request);
  for (const part of ['https://shop.example', 'irreversible', 'click', '"Pay"', 'POST https://shop.example/pay']) expect(text).toContain(part);
});

test('a custom command receives the JSON request on stdin and approves only with exit 0', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'foxpaw-approve-'));
  const script = join(dir, 'approver.sh');
  const received = join(dir, 'request.json');
  writeFileSync(script, `#!/bin/sh\ncat > ${JSON.stringify(received)}\nexit "$1"\n`, { mode: 0o755 });
  const approved = await requestApproval(request, approval({ method: 'command', command: [script, '0'] }));
  expect(approved).toEqual({ approved: true, approver: 'command', reason: 'approved via command' });
  expect(JSON.parse(readFileSync(received, 'utf8'))).toEqual(request);
  expect((await requestApproval(request, approval({ method: 'command', command: [script, '1'] }))).approved).toBe(false);
  // A command that can't start is a denial, not an approval.
  expect((await requestApproval(request, approval({ method: 'command', command: join(dir, 'missing') }))).approved).toBe(false);
});

test('a command that outlives the timeout is killed and denied', async () => {
  const started = Date.now();
  const result = await requestApproval({ ...request, timeoutMs: 200 }, approval({ method: 'command', command: ['sh', '-c', 'sleep 10; exit 0'] }));
  expect(result.approved).toBe(false);
  expect(result.reason).toContain('no answer within');
  expect(Date.now() - started).toBeLessThan(3000);
});

test('notify-send is used only from libnotify 0.7.9 and approves only on the approve action', async () => {
  const runner = (version: string, answer: string): Runner => async (_command, args) => args[0] === '--version' ? { code: 0, stdout: `notify-send ${version}\n`, stderr: '' } : { code: 0, stdout: `${answer}\n`, stderr: '' };
  expect(await notifySendApprover(runner('0.7.8', 'approve'), 'linux').available()).toBe(false);
  expect(await notifySendApprover(runner('0.7.9', 'approve'), 'linux').available()).toBe(true);
  expect(await notifySendApprover(runner('0.8.3', 'approve'), 'linux').available()).toBe(true);
  expect(await notifySendApprover(runner('0.8.3', 'approve'), 'darwin').available()).toBe(false);
  const signal = new AbortController().signal;
  expect(await notifySendApprover(runner('0.8.3', 'approve'), 'linux').ask(request, signal)).toBe(true);
  expect(await notifySendApprover(runner('0.8.3', 'deny'), 'linux').ask(request, signal)).toBe(false);
  // Closing the notification prints nothing.
  expect(await notifySendApprover(runner('0.8.3', ''), 'linux').ask(request, signal)).toBe(false);
});

test('auto tries the configured command first, then the desktop prompt for the platform; none available denies', async () => {
  expect(approversFor(approval({ command: ['true'] }), { platform: 'linux' }).map((approver) => approver.name)).toEqual(['command', 'notify-send', 'osascript', 'powershell']);
  expect(approversFor(approval({ method: ['browser', 'notify-send'] })).map((approver) => approver.name)).toEqual(['notify-send']);
  const nothing: Runner = async () => ({ code: null, stdout: '', stderr: 'not found' });
  const result = await requestApproval(request, approval({}), { run: nothing, platform: 'linux' });
  expect(result).toMatchObject({ approved: false, approver: 'none' });
  expect(result.reason).toContain('notify-send');
});
