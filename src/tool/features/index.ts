import type { ToolFeature } from '../core.ts';
import type { Host } from '../../audit/log.ts';
import { auditFeature } from './audit.ts';
import { policyFeature } from './policy.ts';
import { secretsFeature } from './secrets.ts';
import { downloadsFeature } from './downloads.ts';
import { marksFeature } from './marks.ts';
import { PageHandles } from './page-model.ts';
import { snapshotFeature } from './snapshot.ts';
import { pauseFeature } from './pause.ts';
import { leasesFeature } from './leases.ts';
import { spacesFeature } from './spaces.ts';

export type FeatureOptions = { /** Which program runs the tool, for the audit log. */ host?: Host };

/**
 * Features every host (oh-my-pi, MCP) runs, in order. `before` hooks run top to bottom, so refusals (policy, pause,
 * leases) come before features that record what ran (audit).
 */
export function defaultFeatures(options: FeatureOptions = {}): ToolFeature[] {
  // Snapshot and marks hand out the same handles for the same elements.
  const handles = new PageHandles();
  return [
    // 1. pause (human loop): waits out (or reports) the user's pause before anything else runs.
    pauseFeature(),
    // 2. leases (human loop): takes the tab for this session, refusing tabs another agent holds.
    leasesFeature({ host: options.host }),
    // 3. secrets (trust): fill_secret, secret-mode refusals, redaction of every later result. Before policy, so a
    //    call secret mode refuses never prompts the user first.
    secretsFeature(),
    // 4. policy (trust): refuses or asks before anything reaches the page.
    policyFeature(),
    // 5. spaces (human loop): `open` puts this session's tabs in a container of their own, when enabled.
    spacesFeature(),
    // 6. snapshot, marks, downloads (agent UX): token-cheap reading, numbered screenshots, tracked downloads.
    snapshotFeature(handles),
    marksFeature(handles),
    downloadsFeature(),
    // 7. audit: last, records what actually happened (and what the features above refused).
    auditFeature({ host: options.host }),
  ];
}
