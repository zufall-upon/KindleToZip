// Private storage and closed projection for the separately consented diagnostic.
// The capture claim/result and every existing job remain unrelated, read-only data.
import { constants } from 'node:fs';
import { open, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fixedCapturePaths } from './linux-expected-capture-paths.mjs';
import { projectCaptureStartupDiagnostic, safeCaptureCode } from './expected-capture-diagnostic.mjs';

export const diagnosticClaim = '{"version":1,"purpose":"single-expected-startup-diagnostic"}\n';
export async function fixedStartupDiagnosticPaths() {
  const capture = await fixedCapturePaths();
  return Object.freeze({ capture, state: capture.state,
    claim: path.join(capture.state, 'expected-startup-diagnostic-once.claim'),
    result: path.join(capture.state, 'expected-startup-diagnostic-once.result.json') });
}
export const exclusiveDiagnosticFile = filename => open(filename,
  constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
export async function syncDiagnosticDirectory(directory) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
export async function persistDiagnostic(handle, result) {
  const bytes = Buffer.from(JSON.stringify(projectStartupDiagnosticResult(result)) + '\n');
  await handle.truncate(0);
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset);
    if (!bytesWritten) throw new Error('diagnostic_write_failed');
    offset += bytesWritten;
  }
  await handle.sync();
}
const keys = (value, names) => value && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...names].sort().join(',');
export function initialTabClassification(outcome, diagnostic) {
  if (outcome === 'ready') return 'single';
  if (!diagnostic || ['connection', 'context'].includes(diagnostic.stage)) return 'unconfirmed';
  if (diagnostic.stage === 'page') return diagnostic.reason === 'initial_zero_pages' ? 'zero'
    : diagnostic.reason === 'multiple_pages' ? 'multiple' : 'unconfirmed';
  return 'single'; // These stages are reached only after the initial single-page check.
}
export function projectStartupDiagnosticResult(value) {
  if (!keys(value, ['version', 'purpose', 'phase', 'outcome', 'startupDiagnostic', 'initialTabs', 'failure', 'shutdown', 'processes', 'effects'])
    || value.version !== 1 || value.purpose !== 'single-expected-startup-diagnostic'
    || !['claimed', 'owner', 'reader', 'complete'].includes(value.phase)
    || !['interrupted', 'ready', 'refused'].includes(value.outcome)
    || !['not-started', 'normal', 'unknown'].includes(value.shutdown)) throw new Error('invalid_diagnostic_result');
  const diagnostic = value.startupDiagnostic === null ? null : projectCaptureStartupDiagnostic(value.startupDiagnostic);
  if (value.initialTabs !== initialTabClassification(value.outcome, diagnostic)
    || value.failure !== null && (typeof value.failure !== 'string' || safeCaptureCode({ code: value.failure }) !== value.failure)
    || !keys(value.effects, ['screenshots', 'savedImages', 'pageTurns', 'archives'])
    || !Object.values(value.effects).every(count => count === 0)) throw new Error('invalid_diagnostic_result');
  const p = value.processes;
  if (p !== null && (!keys(p, ['owner', 'browser']) || !Object.values(p).every(pid => Number.isSafeInteger(pid) && pid > 1))) throw new Error('invalid_diagnostic_result');
  if (value.outcome === 'ready' && (value.phase !== 'complete' || diagnostic !== null || value.failure !== null || p === null)
    || value.outcome === 'refused' && value.failure === null
    || value.shutdown === 'normal' && p === null
    || value.shutdown === 'not-started' && (p !== null || value.phase !== 'claimed')) throw new Error('invalid_diagnostic_result');
  return { version: 1, purpose: value.purpose, phase: value.phase, outcome: value.outcome,
    startupDiagnostic: diagnostic, initialTabs: value.initialTabs, failure: value.failure, shutdown: value.shutdown,
    processes: p === null ? null : { owner: p.owner, browser: p.browser },
    effects: { screenshots: 0, savedImages: 0, pageTurns: 0, archives: 0 } };
}
export async function readDiagnosticFile(filename, limit) {
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const a = await handle.stat(), b = await lstat(filename);
    if (!a.isFile() || !b.isFile() || b.isSymbolicLink() || a.uid !== process.geteuid() || a.nlink !== 1
      || (a.mode & 0o7777) !== 0o600 || a.size > limit || await realpath(filename) !== filename
      || !['dev', 'ino', 'uid', 'mode', 'nlink'].every(key => a[key] === b[key])) throw new Error('unsafe_diagnostic_file');
    return await handle.readFile('utf8');
  } finally { await handle.close(); }
}
