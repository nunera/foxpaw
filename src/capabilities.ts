import { type BidiTransport, BidiFeatureUnavailableError, type JsonObject } from './bidi.ts';

export type BidiCapabilities = {
  browserUserContexts: boolean;
  emulation: boolean;
  networkInterception: boolean;
  storage: boolean;
  permissions: boolean;
};

export type CapabilityDiagnostics = Partial<Record<keyof BidiCapabilities, JsonObject>>;
export type DetectedCapabilities = BidiCapabilities & { diagnostics: CapabilityDiagnostics };

const probes: Record<keyof BidiCapabilities, { method: string; params: JsonObject }> = {
  // These probes validate command dispatch only. They deliberately use malformed-but-non-mutating
  // parameter sets, so a supported module returns an ordinary invalid-argument protocol error.
  browserUserContexts: { method: 'browser.createUserContext', params: { __probe: true } },
  emulation: { method: 'emulation.setViewport', params: { __probe: true } },
  networkInterception: { method: 'network.addIntercept', params: { phases: [], urlPatterns: [] } },
  storage: { method: 'storage.getCookies', params: { partition: { type: 'context', context: '__probe__' } } },
  permissions: { method: 'permissions.setPermission', params: { __probe: true } },
};

export async function detectCapabilities(client: BidiTransport): Promise<DetectedCapabilities> {
  const diagnostics: CapabilityDiagnostics = {};
  const outcomes: Array<readonly [string, boolean]> = [];
  for (const [feature, probe] of Object.entries(probes)) {
    try {
      await client.commandOptional(probe.method, probe.params);
      outcomes.push([feature, true]);
    } catch (error) {
      if (error instanceof BidiFeatureUnavailableError || (error instanceof Error && error.name === 'BidiFeatureUnavailableError')) {
        const data = error && typeof error === 'object' && 'data' in error && error.data && typeof error.data === 'object' ? error.data as JsonObject : {};
        diagnostics[feature as keyof BidiCapabilities] = data;
        outcomes.push([feature, false]);
      } else {
        outcomes.push([feature, true]);
      }
    }
  }
  return { ...Object.fromEntries(outcomes) as BidiCapabilities, diagnostics };
}
