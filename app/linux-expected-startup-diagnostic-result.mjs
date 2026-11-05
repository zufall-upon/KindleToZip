// Read-only collector. Validating a refusal never relabels the reader as ready,
// and never starts, closes, navigates or connects to any browser.
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { diagnosticClaim, fixedStartupDiagnosticPaths, readDiagnosticFile, projectStartupDiagnosticResult } from './expected-startup-diagnostic-state.mjs';

const gone = (pid, group = false) => {
  if (!Number.isSafeInteger(pid) || pid < 2) return false;
  try { process.kill(group ? -pid : pid, 0); return false; }
  catch (error) { return error.code === 'ESRCH'; }
};
const absent = async filename => {
  try { await lstat(filename); return false; }
  catch (error) { if (error.code === 'ENOENT') return true; throw error; }
};
async function validate() {
  const paths = await fixedStartupDiagnosticPaths();
  if (await readDiagnosticFile(paths.claim, 4096) !== diagnosticClaim) throw new Error('invalid_diagnostic_claim');
  const result = projectStartupDiagnosticResult(JSON.parse(await readDiagnosticFile(paths.result, 8192)));
  const checks = { ownerGone: gone(result.processes?.owner), browserGone: gone(result.processes?.browser),
    browserGroupGone: gone(result.processes?.browser, true), browserLockAbsent: await absent(paths.capture.lock),
    singletonAbsent: await absent(path.join(paths.capture.data, 'owned/profile/SingletonLock')) };
  if (result.shutdown === 'normal' && !Object.values(checks).every(Boolean)) throw new Error('diagnostic_shutdown_unconfirmed');
  return { valid: true, ...result, checks,
    diagnosticComplete: result.outcome !== 'interrupted' && result.shutdown === 'normal',
    readerReady: result.outcome === 'ready' };
}
if (process.platform !== 'linux' || process.argv.length !== 2) {
  console.error('invalid_invocation'); process.exitCode = 1;
} else {
  try { console.log(JSON.stringify(await validate())); }
  catch { console.error('diagnostic_result_validation_failed'); process.exitCode = 1; }
}
