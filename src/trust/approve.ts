import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { BidiTransport } from '../bidi.ts';
import type { ActionClass, ApprovalConfig, ApprovalMethod } from './policy.ts';

/**
 * Asks a human to approve one action. Desktop approvers (notify-send, osascript, PowerShell) and a custom command
 * run outside the browser, so a page can't fake or click them; the in-tab overlay (`browser`) is weaker. A timeout,
 * a closed prompt, an error, or no available approver all mean deny.
 */
export type ApprovalRequest = {
  version: 1;
  site: string;
  url?: string;
  tabId?: string;
  /** Iframes the target elements live in; `site` is the strictest of these and the tab. */
  frames?: string[];
  action: string;
  class: ActionClass;
  reason: string;
  target?: { tag: string; type?: string; role: string | null; name: string | null; text: string; selector: string };
  form?: { action: string; method: string };
  timeoutMs: number;
};
export type ApprovalResult = { approved: boolean; approver: string; reason: string };
export type Approver = {
  name: string;
  available(): Promise<boolean>;
  /** Resolves true only on an explicit approval. Aborting the signal (timeout) must end the prompt. */
  ask(request: ApprovalRequest, signal: AbortSignal): Promise<boolean>;
};
export type RunResult = { code: number | null; stdout: string; stderr: string };
export type Runner = (command: string, args: string[], options?: { input?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal }) => Promise<RunResult>;

/** Spawns a program without a shell and collects its output. A missing program resolves with code null. */
export const runProgram: Runner = (command, args, options = {}) => {
  const { promise, resolve } = Promise.withResolvers<RunResult>();
  const child = spawn(command, args, { env: options.env ?? process.env, signal: options.signal, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  child.on('error', (error) => resolve({ code: null, stdout, stderr: stderr || error.message }));
  child.on('close', (code) => resolve({ code, stdout, stderr }));
  child.stdin.on('error', () => undefined);
  child.stdin.end(options.input ?? '');
  return promise;
};

/** The human-readable prompt every approver shows. */
export function promptText(request: ApprovalRequest): string {
  const target = request.target;
  const label = target ? [target.role ?? target.tag, target.name ? JSON.stringify(target.name) : undefined, target.text && target.text !== target.name ? `"${target.text}"` : undefined].filter(Boolean).join(' ') : undefined;
  return [
    `An agent wants to run ${request.action} (${request.class}).`,
    `Site: ${request.site}`,
    ...(request.tabId ? [`Tab: ${request.tabId}${request.url ? ` ${request.url}` : ''}`] : []),
    ...(request.frames ?? []).map((frame) => `Inside iframe: ${frame}`),
    ...(label ? [`Target: ${label}`] : []),
    ...(request.form ? [`Form: ${request.form.method.toUpperCase()} ${request.form.action}`] : []),
    `Why asked: ${request.reason}`,
  ].join('\n');
}

const NOTIFY_MINIMUM = [0, 7, 9];
/** Linux libnotify ≥ 0.7.9 (`--wait` with `--action`). The notification server must support actions. */
export function notifySendApprover(run: Runner = runProgram, platform = process.platform): Approver {
  return {
    name: 'notify-send',
    available: async () => {
      if (platform !== 'linux') return false;
      const version = /(\d+)\.(\d+)\.(\d+)/.exec((await run('notify-send', ['--version'])).stdout)?.slice(1).map(Number);
      if (!version) return false;
      for (const [index, part] of version.entries()) if (part !== NOTIFY_MINIMUM[index]) return part > NOTIFY_MINIMUM[index]!;
      return true;
    },
    ask: async (request, signal) => {
      // Notification bodies may be rendered as markup.
      const body = promptText(request).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const result = await run('notify-send', ['--app-name=foxpaw', '--urgency=critical', '--wait', `--expire-time=${request.timeoutMs}`, '--action=approve=Approve', '--action=deny=Deny', `foxpaw: approve ${request.class} action?`, body], { signal });
      return result.code === 0 && result.stdout.trim() === 'approve';
    },
  };
}

export function osascriptApprover(run: Runner = runProgram, platform = process.platform): Approver {
  return {
    name: 'osascript',
    available: async () => platform === 'darwin' && existsSync('/usr/bin/osascript'),
    ask: async (request, signal) => {
      // The text travels as an argument, never inside the script source.
      const script = ['on run argv', `display dialog (item 1 of argv) with title "foxpaw" buttons {"Deny", "Approve"} default button "Deny" cancel button "Deny" with icon caution giving up after ${Math.ceil(request.timeoutMs / 1000)}`, 'end run'];
      const result = await run('/usr/bin/osascript', [...script.flatMap((line) => ['-e', line]), promptText(request)], { signal });
      return result.code === 0 && /button returned:Approve/.test(result.stdout) && !/gave up:true/.test(result.stdout);
    },
  };
}

export function powershellApprover(run: Runner = runProgram, platform = process.platform): Approver {
  return {
    name: 'powershell',
    available: async () => platform === 'win32',
    ask: async (request, signal) => {
      // The text travels in an environment variable, never inside the script source.
      const script = "Add-Type -AssemblyName PresentationFramework; $r = [System.Windows.MessageBox]::Show($env:FOXPAW_PROMPT, 'foxpaw approval', 'YesNo', 'Warning', 'No'); if ($r -eq 'Yes') { exit 0 } else { exit 1 }";
      const result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { signal, env: { ...process.env, FOXPAW_PROMPT: promptText(request) } });
      return result.code === 0;
    },
  };
}

/** `approval.command`: receives the request as JSON on stdin; exit 0 approves. */
export function commandApprover(command: string[], run: Runner = runProgram): Approver {
  return {
    name: 'command',
    available: async () => true,
    ask: async (request, signal) => (await run(command[0]!, command.slice(1), { input: `${JSON.stringify(request)}\n`, signal })).code === 0,
  };
}

const OVERLAY_SANDBOX = 'foxpaw-approval';
/**
 * An overlay in the tab: a closed shadow root in a page-invisible sandbox, top layer, re-asserted every 200 ms, and
 * only trusted clicks (not before 600 ms, and only when the overlay is topmost at the click point) count. The page
 * still controls everything around it, so this is weaker than a desktop prompt.
 *
 * BiDi input (`input.performActions`) produces trusted events, so an agent could click Approve itself. While the
 * overlay is open the broker is paused (when nothing else paused it): every client's input, navigation, and script
 * commands are held, so only a person at the keyboard and mouse can answer it.
 */
export function browserApprover(bidi: ApprovalTransport, contextId: string | undefined): Approver {
  return {
    name: 'browser',
    available: async () => contextId !== undefined,
    ask: async (request, signal) => {
      const target = { context: contextId!, sandbox: OVERLAY_SANDBOX };
      let held = false;
      const release = async () => {
        if (!held) return;
        held = false;
        await bidi.request?.('resume').catch(() => undefined);
      };
      // Cancelling evaluates a script, which the pause would hold: release the hold first.
      const cancel = () => void release().then(() => bidi.command('script.evaluate', { expression: 'globalThis.__foxpawCancel?.()', target, awaitPromise: false })).catch(() => undefined);
      signal.addEventListener('abort', cancel, { once: true });
      try {
        const evaluation = bidi.command('script.evaluate', { expression: overlayScript(promptText(request)), target, awaitPromise: true }, request.timeoutMs + 5000);
        if (bidi.request) {
          const before = await bidi.request('pauseState');
          if (before.paused !== true) {
            // Marked first: an abort that lands while the pause is on its way must still release it.
            held = true;
            await bidi.request('pause', { owner: 'foxpaw approval prompt' });
          }
        }
        const result = await evaluation;
        const remote = result.result;
        const value = remote && typeof remote === 'object' && !Array.isArray(remote) && 'value' in remote ? remote.value : undefined;
        return result.type === 'success' && value === 'approve' && !signal.aborted;
      } finally {
        signal.removeEventListener('abort', cancel);
        await release();
      }
    },
  };
}
/** The tab's transport; `request` (the broker envelope) is there when a broker is in between, and pauses it. */
export type ApprovalTransport = Pick<BidiTransport, 'command'> & { request?(kind: string, payload?: Record<string, unknown>): Promise<Record<string, unknown>> };

function overlayScript(text: string): string {
  return `(async () => {
    const host = document.createElement('foxpaw-approval');
    const style = 'all: initial !important; position: fixed !important; inset: 0 !important; z-index: 2147483647 !important; display: flex !important; align-items: center !important; justify-content: center !important; background: rgba(0,0,0,.55) !important; margin: 0 !important; padding: 0 !important; border: 0 !important; width: 100vw !important; height: 100vh !important; max-width: none !important; max-height: none !important; visibility: visible !important; opacity: 1 !important; pointer-events: auto !important;';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = '<div role="dialog" aria-modal="true" style="font: 15px system-ui, sans-serif; color: #111; background: #fff; border: 3px solid #c00; border-radius: 10px; padding: 20px; max-width: 520px; box-shadow: 0 8px 30px rgba(0,0,0,.5)"><div style="font-weight: 700; margin-bottom: 10px">foxpaw: approve this action?</div><pre style="white-space: pre-wrap; font: 13px ui-monospace, monospace; margin: 0 0 16px"></pre><div style="display: flex; gap: 10px; justify-content: flex-end"><button data-v="deny" style="font: inherit; padding: 6px 16px">Deny</button><button data-v="approve" style="font: inherit; padding: 6px 16px; background: #c00; color: #fff; border: 0; border-radius: 4px">Approve</button></div></div>';
    root.querySelector('pre').textContent = ${JSON.stringify(text)};
    const shownAt = performance.now();
    return await new Promise((resolve) => {
      let timer;
      const finish = (value) => { clearInterval(timer); delete globalThis.__foxpawCancel; host.remove(); resolve(value); };
      globalThis.__foxpawCancel = () => finish('deny');
      const topmost = () => {
        const x = innerWidth / 2, y = innerHeight / 2;
        return document.elementFromPoint(x, y) === host;
      };
      const place = () => {
        if (host.getAttribute('style') !== style) host.setAttribute('style', style);
        if (host.parentNode !== document.documentElement || host.nextSibling) document.documentElement.append(host);
        if (typeof host.showPopover === 'function') {
          if (host.getAttribute('popover') !== 'manual') host.setAttribute('popover', 'manual');
          try { if (!host.matches(':popover-open') || !topmost()) { if (host.matches(':popover-open')) host.hidePopover(); host.showPopover(); } } catch {}
        }
      };
      place();
      timer = setInterval(place, 200);
      for (const button of root.querySelectorAll('button')) button.addEventListener('click', (event) => {
        if (!event.isTrusted || performance.now() - shownAt < 600) return;
        if (document.elementFromPoint(event.clientX, event.clientY) !== host) return;
        finish(button.dataset.v === 'approve' ? 'approve' : 'deny');
      });
    });
  })()`;
}

export type ApprovalDeps = {
  run?: Runner;
  platform?: NodeJS.Platform;
  /** The tab's BiDi transport and context, for `browser`. */
  page?: { bidi: ApprovalTransport; contextId?: string };
  /** Replaces the approver list entirely (tests). */
  approvers?: Approver[];
};

/** The approvers `approval.method` names, in order; `auto` is the command (if configured), then the desktop prompt. */
export function approversFor(config: ApprovalConfig, deps: ApprovalDeps = {}): Approver[] {
  if (deps.approvers) return deps.approvers;
  const run = deps.run ?? runProgram;
  const platform = deps.platform ?? process.platform;
  const build = (method: ApprovalMethod): Approver[] => {
    switch (method) {
      case 'auto': return [...(config.command ? [commandApprover(config.command, run)] : []), notifySendApprover(run, platform), osascriptApprover(run, platform), powershellApprover(run, platform)];
      case 'notify-send': return [notifySendApprover(run, platform)];
      case 'osascript': return [osascriptApprover(run, platform)];
      case 'powershell': return [powershellApprover(run, platform)];
      case 'command': return config.command ? [commandApprover(config.command, run)] : [];
      case 'browser': return deps.page ? [browserApprover(deps.page.bidi, deps.page.contextId)] : [];
    }
  };
  return config.method.flatMap(build);
}

/** Runs the first available approver. Only an explicit approval within the timeout approves. */
export async function requestApproval(request: ApprovalRequest, config: ApprovalConfig, deps: ApprovalDeps = {}): Promise<ApprovalResult> {
  const tried: string[] = [];
  for (const approver of approversFor(config, deps)) {
    tried.push(approver.name);
    if (!await approver.available().catch(() => false)) continue;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs);
    try {
      const timedOut = Promise.withResolvers<'timeout'>();
      controller.signal.addEventListener('abort', () => timedOut.resolve('timeout'), { once: true });
      const answer = await Promise.race([approver.ask(request, controller.signal).catch((error: unknown) => error instanceof Error ? error : new Error(String(error))), timedOut.promise]);
      if (answer === 'timeout') return { approved: false, approver: approver.name, reason: `no answer within ${Math.round(request.timeoutMs / 1000)} s` };
      if (answer instanceof Error) return { approved: false, approver: approver.name, reason: `the ${approver.name} approver failed: ${answer.message}` };
      return answer ? { approved: true, approver: approver.name, reason: `approved via ${approver.name}` } : { approved: false, approver: approver.name, reason: `denied via ${approver.name}` };
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
  return { approved: false, approver: 'none', reason: `no approver is available (tried: ${tried.join(', ') || 'none configured'})` };
}
