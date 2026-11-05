// Fixed no-argument entry; never a general URL/profile/debug or capture CLI.
import { runExpectedPlaywrightController, playwrightObservationSucceeded } from './linux-playwright-resume-core.mjs';

if (process.platform !== 'linux' || process.argv.length !== 2) {
  console.log(JSON.stringify({ kind: 'reader-ui-observation', scope: 'restored-session', binding: 'expected-book-required',
    metadataCount: 0, reason: 'invalid-invocation', shutdown: 'not-started', lock: 'retained-or-unknown',
    owner: { exited: true, retained: false } }));
  process.exitCode = 1;
} else {
  process.umask(0o077);
  const value = await runExpectedPlaywrightController();
  console.log(JSON.stringify(value));
  process.exitCode = playwrightObservationSucceeded(value) ? 0 : 1;
}
