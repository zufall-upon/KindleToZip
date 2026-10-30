// Windows CI diagnostic only. It does not modify tests or their success rules.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, open, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWindowsBackend, createWindowsOwnerTracker } from './windows-diagnostic-process.mjs';
import { isDiagnosticErrorCode } from '../tests/support/test-lifetime.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const now = () => performance.now();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const collectionCodes = new Set(['event_read_timeout', 'event_file_invalid', 'invalid_lifetime_event',
  'lifetime_event_limit', 'root_identity_unconfirmed', 'owned_processes_remain', 'spawn_unconfirmed',
  'spawn_failed', 'streams_not_closed', 'incomplete_lifetime_event', 'tap_summary_unconfirmed',
  'test_lifecycle_unconfirmed', 'monitor_spawn_failed', 'monitor_helper_unconfirmed',
  'monitor_streams_timeout', 'monitor_command_failed', 'monitor_output_limit', 'monitor_command_timeout',
  'system_root_unavailable', 'metadata_invalid', 'termination_invalid', 'root_identity_invalid',
  'identity_invalid', 'identity_changed', 'identity_unconfirmed', 'ancestry_unconfirmed', 'termination_unconfirmed']);
function codeOf(error) {
  try { const code = Object.getOwnPropertyDescriptor(error, 'code')?.value; return collectionCodes.has(code) ? code : 'collection_failed'; }
  catch { return 'collection_failed'; }
}
const failure = code => Object.assign(new Error(code), { code });
const uiName = 'Kindle地域公開UI: 言語と独立して選択し実際の開始URLへ渡し開いた間は変更しない';
const boundaryName = 'Kindle地域境界: 同じ明示リストをタブ・picker・取得前後に使い別地域と認証・別本で止まる';
const escapeRegex = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// CLI selections are fixed, not caller-provided shell text. The full phase is
// the original npm test; cmd.exe is necessary for npm.cmd on Windows.
export function commandForMode(mode, { executable = process.execPath, env = process.env } = {}) {
  if (mode === 'single' || mode === 'near') {
    const pattern = mode === 'single' ? `^${escapeRegex(uiName)}$`
      : `^(?:${escapeRegex(boundaryName)}|${escapeRegex(uiName)})$`;
    return { command: executable, args: ['--test', '--test-concurrency=1', `--test-name-pattern=${pattern}`,
      'tests/mvp-workflow.test.mjs'], outerMs: 150_000, expectedTests: mode === 'single' ? [uiName] : [boundaryName, uiName] };
  }
  if (mode === 'full') {
    const command = env.ComSpec || (env.SystemRoot && path.win32.join(env.SystemRoot, 'System32', 'cmd.exe'));
    if (!command || !path.win32.isAbsolute(command)) throw failure('comspec_unavailable');
    return { command, args: ['/d', '/s', '/c', 'npm.cmd test'], outerMs: 1_200_000, expectedTests: [boundaryName, uiName] };
  }
  throw failure('expected_single_near_or_full');
}

function safeTestName(value, known) {
  if (typeof value !== 'string') throw failure('invalid_lifetime_event');
  // Only names fixed by the selected recipe may be printed.
  return known.has(value) ? value : '[other]';
}
const boundaries = new Set(['test', 'test_body', 'owned_fixture', 'snapshot_listener', 'process_exit', 'ipc_snapshot',
  'region.setup', 'region.control', 'region.options', 'region.options_assert', 'region.route', 'region.pendingPoll',
  'region.intercept', 'region.fulfill', 'region.assertions', 'control.browser_launch', 'control.context_create',
  'control.route_register', 'control.page_create', 'control.page_goto', 'control.browser_close', 'heartbeat']);
const events = new Set(['begin', 'start', 'end', 'error', 'complete', 'called', 'created', 'captured', 'ready', 'unavailable', 'tick']);
function bounded(promise, ms, code) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(failure(code)), ms); })])
    .finally(() => clearTimeout(timer));
}

// Injected commands/backends and short limits are solely for fixture tests;
// the CLI exposes neither arbitrary commands nor a kill target.
export async function runWindowsDiagnostic({ command, args, cwd = root, env = process.env, outerMs,
  warningMs = 90_000, snapshotMs = 120_000, idleMs = 180_000, tickMs = 250,
  scanIntervalMs = 1000, queryMs = 5000, stopBudgetMs = 20_000, streamMs = 2500, tempBase = tmpdir(),
  output = text => process.stdout.write(text), backendFactory, requireTap = false, full = false, expectedTests = [] }) {
  if (process.platform !== 'win32' && !backendFactory) throw failure('windows_only');
  if (!(0 < warningMs && warningMs < snapshotMs && snapshotMs < idleMs && outerMs > 0
    && tickMs > 0 && scanIntervalMs > 0 && queryMs > 0 && stopBudgetMs > 0 && streamMs > 0)) throw failure('invalid_limits');
  // A unique run directory, not a shared file. No fixture, profile, inherited
  // temp directory, or event directory is deleted by this supervisor.
  const directory = await mkdtemp(path.join(tempBase, 'ktz-windows-lifetime-'));
  const eventFile = path.join(directory, 'events');
  const fd = await open(eventFile, 'wx', 0o600); await fd.close();
  const began = now();
  let lastProgress = began, lastBoundary = null, offset = 0, eventRemainder = '';
  let childExit = null, spawnError = null, closeDone = false, collectionError = null, timeout = null;
  let warned = false, snapshot = null, tracker = null, pendingDrain = null, identityEstablished = false, tapFailure = false;
  let tapResults = 0, tapDuplicateSummary = false, testOutcome = 'unknown';
  const knownTests = new Set(['process', ...expectedTests]);
  const captured = [], unique = new Set(), tapSeen = new Set(), forced = [], terminationAttempts = [], tap = {};
  const emit = value => output(`KTZ_WATCHDOG:${JSON.stringify(value)}\n`);
  const mark = value => { lastProgress = now(); lastBoundary = value; };
  const spawnedAfter = Date.now() - 1000; // CIM is microsecond precision; allow clock conversion jitter.
  const child = spawn(command, args, { cwd, env: { ...env, KTZ_TEST_LIFETIME_DIAGNOSTICS: '1',
    KTZ_LIFETIME_EVENT_FILE: eventFile }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  child.on('error', error => {
    try { const code = Object.getOwnPropertyDescriptor(error, 'code')?.value; spawnError = isDiagnosticErrorCode(code) ? code : 'spawn_failed'; }
    catch { spawnError = 'spawn_failed'; }
  });
  child.on('exit', (code, signal) => { childExit = { code, signal }; });
  child.on('close', () => { closeDone = true; });
  const onOutput = () => {
    let remainder = '';
    return chunk => {
      remainder += chunk.toString('utf8');
      for (let end; (end = remainder.indexOf('\n')) >= 0;) {
        const line = remainder.slice(0, end).replace(/\r$/, ''); remainder = remainder.slice(end + 1);
        const result = line.match(/^\s*(not )?ok (\d+)(?:\s*-.*)?$/);
        if (result) {
          tapResults++;
          if (result[1]) tapFailure = true;
          const key = createHash('sha256').update(line).digest('hex');
          if (!tapSeen.has(key)) {
            tapSeen.add(key); mark({ boundary: 'tap', event: 'result' });
            output(`KTZ_TAP:${JSON.stringify({ result: result[1] ? 'not ok' : 'ok', number: Number(result[2]) })}\n`);
          }
        }
        const summary = line.match(/^#\s*(tests|suites|pass|fail|cancelled|skipped|todo)\s+(\d+)\s*$/);
        if (summary) {
          if (Object.hasOwn(tap, summary[1])) tapDuplicateSummary = true;
          tap[summary[1]] = Number(summary[2]);
          output(`KTZ_TAP:${JSON.stringify({ summary: summary[1], count: tap[summary[1]] })}\n`);
        }
      }
      if (remainder.length > 128 * 1024) { remainder = ''; collectionError ||= 'stream_line_limit'; }
    };
  };
  child.stdout?.on('data', onOutput()); child.stderr?.on('data', onOutput());
  async function drain() {
    if (pendingDrain) return pendingDrain;
    pendingDrain = (async () => {
      const bytes = await bounded(readFile(eventFile), queryMs, 'event_read_timeout');
      if (bytes.length < offset || bytes.length > 16 * 1024 * 1024) throw failure('event_file_invalid');
      eventRemainder += bytes.subarray(offset).toString('utf8'); offset = bytes.length;
      for (let end; (end = eventRemainder.indexOf('\n')) >= 0;) {
        const line = eventRemainder.slice(0, end); eventRemainder = eventRemainder.slice(end + 1);
        if (!line.startsWith('KTZ_LIFETIME:')) throw failure('invalid_lifetime_event');
        let event;
        try { event = JSON.parse(line.slice('KTZ_LIFETIME:'.length)); } catch { throw failure('invalid_lifetime_event'); }
        if (!Number.isSafeInteger(event.pid) || event.pid <= 0 || !Number.isFinite(event.monotonicMs)
          || !/^[A-Za-z_0-9.]{1,80}$/.test(event.boundary ?? '') || !/^[a-z_]{1,40}$/.test(event.event ?? '')) throw failure('invalid_lifetime_event');
        const clean = { pid: event.pid, test: safeTestName(event.test, knownTests),
          boundary: boundaries.has(event.boundary) || /^after_hook\.[0-9]{1,6}$/.test(event.boundary) ? event.boundary : 'other',
          event: events.has(event.event) ? event.event : 'other', monotonicMs: event.monotonicMs };
        if (event.elapsedMs !== undefined) {
          if (!Number.isFinite(event.elapsedMs) || event.elapsedMs < 0) throw failure('invalid_lifetime_event');
          clean.elapsedMs = event.elapsedMs;
        }
        if (event.errorClass !== undefined || event.errorCode !== undefined) {
          if (event.event !== 'error' || !['timeout', 'os', 'unknown'].includes(event.errorClass)
            || !(event.errorCode === 'unknown' || isDiagnosticErrorCode(event.errorCode))
            || (event.errorClass === 'os' && event.errorCode === 'unknown')
            || (event.errorClass === 'unknown' && event.errorCode !== 'unknown')) throw failure('invalid_lifetime_event');
          clean.errorClass = event.errorClass; clean.errorCode = event.errorCode;
        }
        captured.push(clean); output(`KTZ_LIFETIME:${JSON.stringify(clean)}\n`);
        const meaningful = event.boundary === 'test' || event.boundary === 'test_body'
          || event.boundary.startsWith('after_hook.') || event.boundary.startsWith('region.')
          || clean.boundary.startsWith('control.');
        // Keep different non-selected tests distinct for progress accounting,
        // without printing their names in the diagnostic stream.
        const key = `${event.pid}:${event.test}:${event.boundary}:${event.event}`;
        if (meaningful && !unique.has(key)) { unique.add(key); mark(clean); }
      }
      if (eventRemainder.length > 128 * 1024) throw failure('lifetime_event_limit');
    })().finally(() => { pendingDrain = null; });
    return pendingDrain;
  }
  // Deadline checks and file polling continue while a bounded CIM query runs.
  const timer = setInterval(() => {
    drain().catch(error => { collectionError ||= codeOf(error); });
    if (childExit || spawnError || timeout) return;
    const idle = now() - lastProgress, elapsed = now() - began;
    if (!warned && idle >= warningMs) { warned = true; emit({ event: 'idle_warning', idleMs: Math.round(idle), lastBoundary }); }
    if (!snapshot && idle >= snapshotMs) {
      snapshot = { event: 'snapshot', idleMs: Math.round(idle), lastBoundary,
        processes: tracker?.latest() ?? [], processCoverage: 'last-sample-only', pending: 'unknown' };
      emit(snapshot);
    }
    if (elapsed >= outerMs || idle >= idleMs) {
      timeout = elapsed >= outerMs ? 'outer' : 'idle'; emit({ event: 'timeout', reason: timeout });
    }
  }, tickMs);

  let remainingState = 'unknown', remainingProcesses = [];
  async function scan(budget = queryMs) {
    const records = await tracker.scan(budget);
    if (!identityEstablished && childExit) throw failure('root_identity_unconfirmed');
    identityEstablished = true; return records;
  }
  async function stopObserved(reason) {
    const end = now() + stopBudgetMs;
    let active = await scan(Math.min(queryMs, stopBudgetMs));
    while (active.length && now() < end) {
      // Descendants before the directly spawned runner; only admitted records.
      const byPid = new Map(active.map(item => [item.pid, item]));
      const depth = item => { let n = 0, current = item; const seen = new Set();
        while (byPid.has(current.parentPid) && !seen.has(current.pid)) { seen.add(current.pid); current = byPid.get(current.parentPid); n++; } return n; };
      active.sort((a, b) => depth(b) - depth(a));
      for (const item of active) {
        const budget = Math.min(queryMs, end - now());
        if (budget <= 0) break;
        const attempt = { pid: item.pid, reason, status: 'unknown' }; terminationAttempts.push(attempt);
        const answer = await tracker.stop(item, budget);
        attempt.status = answer === 'terminated' ? 'confirmed-call' : 'absent';
        if (answer === 'terminated') forced.push({ pid: item.pid, method: 'verified_handle', reason });
      }
      if (now() >= end) break;
      await pause(Math.min(100, end - now()));
      const budget = Math.min(queryMs, end - now());
      if (budget <= 0) break;
      active = await scan(budget);
    }
    remainingProcesses = active;
    if (active.length) throw failure('owned_processes_remain');
  }
  try {
    if (!child.pid) {
      await bounded(new Promise(resolve => child.once('error', resolve)), streamMs, 'spawn_unconfirmed');
      throw failure('spawn_failed');
    }
    const backend = backendFactory ? backendFactory(child) : createWindowsBackend();
    tracker = createWindowsOwnerTracker({ runnerPid: child.pid, supervisorPid: process.pid, backend, notBeforeMs: spawnedAfter });
    while (!childExit && !spawnError && !timeout && !collectionError) {
      await drain(); await scan();
      if (!childExit && !spawnError && !timeout && !collectionError) await pause(scanIntervalMs);
    }
    await drain();
    if (timeout) await stopObserved(`timeout-${timeout}`);
    else {
      const active = await scan();
      if (active.length) await stopObserved('residual-after-exit');
    }
    const until = now() + streamMs;
    while (!closeDone && now() < until) await pause(Math.min(50, Math.max(1, until - now())));
    if (!closeDone) throw failure('streams_not_closed');
    await drain(); remainingProcesses = await scan();
    if (remainingProcesses.length) throw failure('owned_processes_remain');
    remainingState = 'none-observed';
    if (eventRemainder.length) throw failure('incomplete_lifetime_event');
    if (requireTap) {
      const keys = ['tests', 'pass', 'fail', 'cancelled', 'skipped'];
      const validCounts = keys.every(key => Number.isSafeInteger(tap[key]) && tap[key] >= 0)
        && ['suites', 'todo'].every(key => tap[key] === undefined || Number.isSafeInteger(tap[key]) && tap[key] >= 0);
      const failed = (tap.fail ?? 0) + (tap.cancelled ?? 0) > 0;
      if (!validCounts || tapDuplicateSummary || !(tap.tests > 0) || (!failed && !(tap.pass > 0))
        || tap.tests !== tap.pass + tap.fail + tap.cancelled + tap.skipped + (tap.todo ?? 0)
        || tapResults !== tap.tests + (tap.suites ?? 0) || tapFailure !== failed
        || (full && tap.skipped !== 0) || !childExit || childExit.signal || childExit.code !== (failed ? 1 : 0)) {
        throw failure('tap_summary_unconfirmed');
      }
      testOutcome = failed ? 'failed' : 'passed';
    } else if (childExit && !childExit.signal) testOutcome = childExit.code === 0 ? 'passed' : 'failed';
    for (const name of expectedTests) {
      const begin = captured.find(event => event.test === name && event.boundary === 'test' && event.event === 'begin');
      const body = begin && captured.find(event => event.pid === begin.pid && event.test === name && event.boundary === 'test_body'
        && (event.event === 'complete' || event.event === 'error'));
      if (testOutcome === 'passed' && body?.event === 'error') {
        testOutcome = 'unknown'; throw failure('test_lifecycle_unconfirmed');
      }
      if (!begin || !body
        || !captured.some(event => event.pid === begin.pid && event.test === name && event.boundary === 'test' && event.event === 'end')
        || !captured.some(event => event.pid === begin.pid && event.boundary === 'process_exit' && event.event === 'complete')) throw failure('test_lifecycle_unconfirmed');
    }
  } catch (error) {
    collectionError ||= codeOf(error);
    remainingProcesses = tracker?.latest() ?? [];
    // A failed metadata query must not be converted into an empty tree. The
    // ChildProcess handle is nevertheless safe for the direct runner itself.
    if (!childExit && child.pid) {
      const attempt = { pid: child.pid, reason: 'monitor_failure', status: 'unknown' }; terminationAttempts.push(attempt);
      try {
        if (child.kill()) { attempt.status = 'confirmed-call'; forced.push({ pid: child.pid, method: 'direct_child_handle', reason: 'monitor_failure' }); }
      } catch { /* unknown */ }
    }
  } finally {
    clearInterval(timer);
    const until = now() + streamMs;
    while (!closeDone && now() < until) await pause(Math.min(50, Math.max(1, until - now())));
    if (!closeDone) {
      child.stdout?.destroy(); child.stderr?.destroy();
      // The bounded supervisor must itself be able to exit even when the
      // directly owned runner's termination remains unconfirmed.
      if (!childExit) child.unref();
      collectionError ||= 'streams_not_closed'; remainingState = 'unknown';
    }
    try { await drain(); } catch (error) { collectionError ||= codeOf(error); }
  }
  const collectionOutcome = collectionError || timeout || spawnError || !childExit ? 'incomplete' : 'complete';
  const cleanupOutcome = remainingState;
  const outcome = timeout ? 'timeout' : spawnError || collectionError || !childExit || childExit.code !== 0
    || childExit.signal || forced.length || remainingState !== 'none-observed' ? 'failed' : 'passed';
  const result = { outcome, testOutcome, collectionOutcome, cleanupOutcome, timeout, childExit, spawnError, collectionError, forced, terminationAttempts, remainingState, remainingProcesses,
    observedProcesses: tracker?.history() ?? [], snapshot, events: captured, tap, eventDirectoryRetained: true,
    processCoverage: 'sampled-descendants-only', elapsedMs: Math.round(now() - began) };
  emit({ event: 'result', outcome, testOutcome, collectionOutcome, cleanupOutcome, timeout, childExit, spawnError, collectionError, forced: forced.length,
    terminationAttempts, remainingState, lastSampleCount: remainingProcesses.length,
    processCoverage: result.processCoverage, elapsedMs: result.elapsedMs });
  return result;
}

async function main() {
  if (process.platform !== 'win32') throw failure('windows_only');
  const mode = process.argv[2], options = commandForMode(mode);
  const result = await runWindowsDiagnostic({ ...options, requireTap: true, full: mode === 'full' });
  process.exitCode = result.outcome === 'passed' ? 0 : result.timeout ? 124 : result.childExit?.code || 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
