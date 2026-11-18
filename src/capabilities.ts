import { type BidiTransport, BidiFeatureUnavailableError } from './bidi.ts';

export type DetectedCapabilities = {
  browserUserContexts: boolean;
  /** Short reason per unavailable feature; never a protocol stacktrace. */
  unavailable?: Partial<Record<'browserUserContexts', string>>;
};

// The probe must not change the user's profile: `browser.getUserContexts` only lists containers,
// whereas `browser.createUserContext` would create a persistent one even with odd parameters.
export async function detectCapabilities(client: BidiTransport): Promise<DetectedCapabilities> {
  try {
    await client.commandOptional('browser.getUserContexts');
    return { browserUserContexts: true };
  } catch (error) {
    const reason = error instanceof BidiFeatureUnavailableError || (error instanceof Error && error.name === 'BidiFeatureUnavailableError')
      ? 'browser.getUserContexts is not supported by this build'
      : `browser.getUserContexts failed: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`;
    return { browserUserContexts: false, unavailable: { browserUserContexts: reason } };
  }
}
