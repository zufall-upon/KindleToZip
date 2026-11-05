// Fixed diagnostic entry: no confirmation dialog, selection, or metadata mode.
import { runResumeController, resumeDiagnosticSucceeded } from './linux-inspect-resume-core.mjs';

if (process.platform !== 'linux' || process.argv.length !== 2) {
  console.log(JSON.stringify({ kind: 'reader-ui-probe', scope: 'diagnostic-only', binding: 'unverified', metadataCount: 0,
    probe: { state: 'not-run' }, shutdown: 'not-started', lock: 'retained-or-unknown',
    diagnostic: { stage: 'entry', reason: 'invalid-invocation' }, owner: { exited: true, retained: false } }));
  process.exitCode = 1;
} else {
  process.umask(0o077);
  const value = await runResumeController();
  console.log(JSON.stringify(value));
  process.exitCode = resumeDiagnosticSucceeded(value) ? 0 : 1;
}
