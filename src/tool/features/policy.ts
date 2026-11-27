import type { Environment } from '../../config.ts';
import { requestApproval, type ApprovalDeps, type ApprovalRequest } from '../../trust/approve.ts';
import { allowedEverywhere, classifyCall, decide, loadPolicy, possibleClasses, stricter, type ActionClass, type Decision } from '../../trust/policy.ts';
import type { ActionCall, ToolFeature } from '../core.ts';

export type PolicyFeatureOptions = { env?: Environment; approval?: Omit<ApprovalDeps, 'page'> };

const refusal = (call: ActionCall, policy: { decision: Decision; reason: string; class?: ActionClass; site?: string; rule?: string }, tabId?: string) => new Error(JSON.stringify({
  ...(tabId ?? call.params.tabId ? { tabId: tabId ?? call.params.tabId } : {}),
  action: call.action,
  actionPerformed: false,
  error: `foxpaw policy refused this action: ${policy.reason}`,
  policy,
  note: 'Nothing reached the page. Do not retry or work around this; tell the user what you wanted to do and why.',
}));

/**
 * Per-site allow/ask/deny for read, write, and irreversible actions (`policy` settings key, docs/policy.md).
 * The settings file is read on every call, so edits apply at once; an invalid file refuses everything.
 */
export function policyFeature(options: PolicyFeatureOptions = {}): ToolFeature {
  return {
    name: 'policy',
    description: [
      'Policy: the user decides per site which actions run, need their approval, or are refused. Irreversible actions (submit_form, `commit`, clicking or pressing Enter on submit/pay/delete/send/… controls or inside POST forms) ask the user by default and block until they answer. A refusal has `actionPerformed: false` and `policy: {decision, reason}`: nothing ran; do not retry or work around it.',
    ],
    async before(call, runtime) {
      const loaded = loadPolicy(options.env);
      if (!loaded.ok) throw refusal(call, { decision: 'deny', reason: `the policy configuration is invalid, so every action is refused. ${loaded.reason}` });
      const { policy } = loaded;
      if (possibleClasses(call.action).every((actionClass) => allowedEverywhere(policy, actionClass))) return;
      const classified = await classifyCall(call, runtime);
      const ruling = classified.urls.length
        ? classified.urls.map((url) => decide(policy, classified.actionClass, url)).reduce(stricter)
        : decide(policy, classified.actionClass);
      if (ruling.decision === 'allow') return;
      const details = (decision: Decision, reason: string) => ({ decision, reason, class: classified.actionClass, ...(ruling.site ? { site: ruling.site } : {}), rule: ruling.rule });
      if (ruling.decision === 'deny') throw refusal(call, details('deny', `${classified.actionClass} actions are denied on ${ruling.site ?? 'this site'} by ${ruling.rule} (${classified.why})`), classified.tabId);
      const target = classified.target;
      const request: ApprovalRequest = {
        version: 1,
        site: ruling.site ?? 'no site',
        ...(classified.urls[0] ? { url: classified.urls[0] } : {}),
        ...(classified.tabId ? { tabId: classified.tabId } : {}),
        ...(classified.frames ? { frames: classified.frames } : {}),
        action: call.action,
        class: classified.actionClass,
        reason: `${classified.why}; ${ruling.rule} says ask`,
        ...(target ? { target: { tag: target.tag, ...(target.type ? { type: target.type } : {}), role: target.role, name: target.name, text: target.text, selector: target.selector } } : {}),
        ...(target?.form ? { form: target.form } : {}),
        timeoutMs: policy.approval.timeoutMs,
      };
      const answer = await requestApproval(request, policy.approval, { ...options.approval, page: { bidi: runtime.browser.bidi, ...(classified.contextId ? { contextId: classified.contextId } : {}) } });
      if (!answer.approved) throw refusal(call, details('ask', `the user did not approve: ${answer.reason}`), classified.tabId);
    },
  };
}
