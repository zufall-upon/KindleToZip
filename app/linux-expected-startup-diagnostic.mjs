// Fixed one-shot diagnostic, not a capture CLI. Never creates an Application,
// job, preview or consent transition, and never selects/navigates a book.
import { captureStartupDiagnostic, safeCaptureCode } from './expected-capture-diagnostic.mjs';
import { diagnosticClaim, fixedStartupDiagnosticPaths, exclusiveDiagnosticFile,
  syncDiagnosticDirectory, persistDiagnostic, initialTabClassification } from './expected-startup-diagnostic-state.mjs';

async function run() {
  const paths = await fixedStartupDiagnosticPaths();
  const claim = await exclusiveDiagnosticFile(paths.claim);
  try { await claim.writeFile(diagnosticClaim); await claim.sync(); } finally { await claim.close(); }
  await syncDiagnosticDirectory(paths.state);
  const output = await exclusiveDiagnosticFile(paths.result);
  const result = { version: 1, purpose: 'single-expected-startup-diagnostic', phase: 'claimed', outcome: 'interrupted',
    startupDiagnostic: null, initialTabs: 'unconfirmed', failure: null, shutdown: 'not-started', processes: null,
    effects: { screenshots: 0, savedImages: 0, pageTurns: 0, archives: 0 } };
  let capability;
  const lifecycle = { state: 'not_started' };
  try {
    await persistDiagnostic(output, result);
    await syncDiagnosticDirectory(paths.state);
    // Disable dependency debug logging before loading the browser library.
    for (const key of ['DEBUG', 'PWDEBUG', 'CHROMIUM_FLAGS', 'NODE_OPTIONS']) delete process.env[key];
    const { Reader } = await import('./reader.mjs');
    const { startExpectedCaptureSession } = await import('./expected-capture-session.mjs');
    result.phase = 'owner'; result.shutdown = 'unknown';
    await persistDiagnostic(output, result);
    capability = await startExpectedCaptureSession(paths.capture);
    result.processes = capability.processIds;
    result.phase = 'reader';
    await persistDiagnostic(output, result);
    let timer;
    try {
      // Includes the existing connection, readiness and failed-open close bounds.
      // A stalled evaluation is stopped by disconnecting this same owner's pipe.
      await Promise.race([Reader.open({ ownedSession: capability, handleSignals: false, lifecycle }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('operation_timeout'),
          { code: 'operation_timeout' })), 55_000); })]);
    } finally { clearTimeout(timer); }
    result.outcome = 'ready'; result.phase = 'complete'; result.initialTabs = 'single';
  } catch (error) {
    result.outcome = 'refused'; result.failure = safeCaptureCode(error);
    result.startupDiagnostic = captureStartupDiagnostic(error);
    result.initialTabs = initialTabClassification(result.outcome, result.startupDiagnostic);
  } finally {
    if (capability) {
      if (lifecycle.state === 'close_unconfirmed') result.shutdown = 'unknown';
      else {
        // The owner memoizes its one bounded close. A failed Reader.open may
        // already have joined that exact attempt; it is never restarted.
        try { await capability.close(); result.shutdown = 'normal'; }
        catch { result.shutdown = 'unknown'; }
      }
    }
    try { await persistDiagnostic(output, result); } finally { await output.close(); }
  }
  return result.outcome === 'ready' && result.shutdown === 'normal';
}
if (process.platform !== 'linux' || process.argv.length !== 2) {
  console.error('invalid_invocation'); process.exitCode = 1;
} else {
  process.umask(0o077);
  try { if (!await run()) process.exitCode = 1; }
  catch { console.error('startup_diagnostic_failed'); process.exitCode = 1; }
}
