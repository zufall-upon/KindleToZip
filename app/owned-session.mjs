import { ownedPipeSession } from './owned-sample.mjs';
import { expectedCaptureSession } from './expected-capture-session.mjs';
import { portableLimitedSession } from './portable-limited-session.mjs';

// Private Reader boundary. A session supplies its own connection, lifetime,
// identity/paint guard and target-specific adapter, readiness, optional sample
// network policy, configuration and transition rules. The common Reader does
// not reinterpret a future official URL as an anonymous fixture URL.
// Only fixed owners mint capabilities; a URL/profile/matching object cannot.
// The expected-book single-run entry supplies consent separately from identity.
export function resolveOwnedSession(capability) {
  return portableLimitedSession(capability) ?? expectedCaptureSession(capability) ?? ownedPipeSession(capability);
}
