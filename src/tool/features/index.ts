import type { ToolFeature } from '../core.ts';

/**
 * Features every host (oh-my-pi, MCP) runs, in order. `before` hooks run top to bottom, so refusals (policy, pause,
 * leases) come before features that record what ran (audit).
 */
export function defaultFeatures(): ToolFeature[] {
  return [];
}
