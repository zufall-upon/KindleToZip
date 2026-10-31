import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOwnerTracker, createRuntimeCleanup, removeOwnedFixtures } from './diagnostic-runtime.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const now = () => performance.now();
const publicProcess = (item, runner, workers) => ({ pid: item.pid, ppid: item.ppid, starttime: item.starttime,
  role: item.pid === runner ? 'runner' : workers.get(item.pid) === item.starttime ? 'test-worker' : item.role });

// The command is fixed by the CLI below. Injection of a command/short limits is
// exported solely for the synthetic regression fixtures, not exposed by CLI.
export async function runDiagnostic({ command, args, cwd = root, env = process.env,
  outerMs, warningMs = 90_000, snapshotMs = 120_000, idleMs = 180_000,
  graceMs = 5_000, tickMs = 250, fixtureRoot = path.join(root, 'artifacts/mvp-tests'),
  tempBase = existsSync('/tmp/opencode') ? '/tmp/opencode' : tmpdir(), output = text => process.stdout.write(text) }) {
  if (process.platform !== 'linux') throw new Error('linux_only');
  if (!(0 < warningMs && warningMs < snapshotMs && snapshotMs < idleMs && outerMs > 0)) throw new Error('invalid_limits');
  const token = randomUUID(), owner = createOwnerTracker(token);
  // chromium-test-log-sink uses /tmp/opencode when present, otherwise the
  // inherited OS tmpdir. A custom TMPDIR is a base, never itself owned.
  const runtimeBases = [...new Set(['/tmp/opencode', '/tmp', ...(env.TMPDIR && path.isAbsolute(env.TMPDIR) ? [env.TMPDIR] : [])])];
  const runtime = await createRuntimeCleanup({ bases: runtimeBases, inherited: env.TMPDIR });
  await mkdir(fixtureRoot, { recursive: true, mode: 0o700 });
  const initialNames = new Set(await readdir(fixtureRoot));
  const directory = await mkdtemp(path.join(tempBase, 'ktz-lifetime-'));
  const directoryInfo = await lstat(directory, { bigint: true });
  const eventFile = path.join(directory, 'events');
  const file = await open(eventFile, 'wx', 0o600); await file.close();
  const began = now();
  let lastProgress = began, offset = 0, eventRemainder = '', tapRemainder = '', lastBoundary = null;
  let snapshot = null, warned = false, timeout = null, childExit = null, spawnError = null;
  let captured = [], owned = [], processHistory = new Map();
  const workers = new Map(), fixtures = new Map(), unique = new Set(), tapSeen = new Set(), forced = [], ipc = [];
  const emit = value => output(`KTZ_WATCHDOG:${JSON.stringify(value)}\n`);
  const child = spawn(command, args, { cwd, env: { ...env, KTZ_TEST_DIAGNOSTIC_OWNER: token,
    KTZ_TEST_LIFETIME_DIAGNOSTICS: '1', KTZ_LIFETIME_EVENT_FILE: eventFile }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.once('error', error => { spawnError = error.code || 'spawn_failed'; });
  child.once('exit', (code, signal) => { childExit = { code, signal }; });
  let closeDone = false;
  child.once('close', () => { closeDone = true; });
  const onOutput = chunk => {
    const text = chunk.toString('utf8'); output(text); tapRemainder += text;
    for (let end; (end = tapRemainder.indexOf('\n')) >= 0;) {
      const line = tapRemainder.slice(0, end); tapRemainder = tapRemainder.slice(end + 1);
      if (/^\s*(?:not )?ok \d+\s*-/.test(line) && !tapSeen.has(line)) {
        tapSeen.add(line); lastProgress = now(); lastBoundary = { boundary: 'tap', event: 'result' };
      }
    }
    if (tapRemainder.length > 128 * 1024) tapRemainder = tapRemainder.slice(-1024);
  };
  child.stdout.on('data', onOutput); child.stderr.on('data', onOutput);
  async function drain() {
    const bytes = await readFile(eventFile);
    eventRemainder += bytes.subarray(offset).toString('utf8'); offset = bytes.length;
    for (let end; (end = eventRemainder.indexOf('\n')) >= 0;) {
      const line = eventRemainder.slice(0, end); eventRemainder = eventRemainder.slice(end + 1);
      if (!line.startsWith('KTZ_LIFETIME:')) continue;
      let event;
      try { event = JSON.parse(line.slice('KTZ_LIFETIME:'.length)); } catch { throw new Error('invalid_lifetime_event'); }
      if (!Number.isInteger(event.pid) || typeof event.test !== 'string' || typeof event.boundary !== 'string'
        || typeof event.event !== 'string' || !Number.isFinite(event.monotonicMs)) throw new Error('invalid_lifetime_event');
      const clean = { pid: event.pid, test: event.test, boundary: event.boundary, event: event.event, monotonicMs: event.monotonicMs };
      if (event.boundary === 'snapshot_listener' && event.event === 'ready' && /^\d+$/.test(event.starttime ?? '')) workers.set(event.pid, event.starttime);
      if (event.boundary === 'ipc_snapshot') {
        ipc.push({ pid: event.pid, pending: Array.isArray(event.pending) ? event.pending.filter(p => typeof p.kind === 'string'
          && /^[a-z_]{1,40}$/.test(p.kind)).map(p => ({ kind: p.kind, elapsedMs: null })) : [], cleanupStarted: event.cleanupStarted === true });
      }
      if (event.boundary === 'owned_fixture' && event.event === 'created') {
        if (!/^workflow-[A-Za-z0-9]{6}$/.test(event.fixture ?? '') || !/^\d+$/.test(event.dev ?? '') || !/^\d+$/.test(event.ino ?? '')) throw new Error('invalid_fixture_identity');
        const previous = fixtures.get(event.fixture);
        if (previous && (previous.dev !== event.dev || previous.ino !== event.ino)) throw new Error('fixture_identity_changed');
        fixtures.set(event.fixture, { dev: event.dev, ino: event.ino });
      }
      captured.push(clean); output(`KTZ_LIFETIME:${JSON.stringify(clean)}\n`);
      const meaningful = event.boundary === 'test' || event.boundary === 'test_body' || event.boundary.startsWith('after_hook.')
        || event.boundary.startsWith('region.');
      const key = `${event.pid}:${event.test}:${event.boundary}:${event.event}`;
      if (meaningful && !unique.has(key)) { unique.add(key); lastProgress = now(); lastBoundary = clean; }
    }
    if (eventRemainder.length > 128 * 1024) throw new Error('lifetime_event_limit');
  }
  async function scan() {
    owned = await owner.scan();
    for (const item of owned) {
      processHistory.set(`${item.pid}:${item.starttime}`, publicProcess(item, child.pid, workers));
      if (item.temp) await runtime.observe(item.temp);
    }
  }
  async function signalAll(signalName, reason) {
    await scan();
    for (const item of owned) if (await owner.signal(item, signalName)) forced.push({ pid: item.pid, signal: signalName, reason });
  }
  async function stopOwned(reason) {
    await signalAll('SIGTERM', reason);
    const until = now() + graceMs;
    do { await pause(Math.min(100, graceMs)); await scan(); } while (owned.length && now() < until);
    if (owned.length) {
      await signalAll('SIGKILL', `${reason}-after-term`);
      const end = now() + graceMs;
      do { await pause(Math.min(100, graceMs)); await scan(); } while (owned.length && now() < end);
    }
  }
  let collectionError = null, safeToRemoveEventDirectory = false;
  try {
    while (!childExit && !spawnError) {
      await drain(); await scan();
      const elapsed = now() - began, idle = now() - lastProgress;
      if (!warned && idle >= warningMs) { warned = true; emit({ event: 'idle_warning', idleMs: Math.round(idle) }); }
      if (!snapshot && idle >= snapshotMs) {
        // Only workers that announced a registered listener, with a matching
        // owned PID/starttime, receive this request. No process-wide dump.
        for (const item of owned) if (workers.get(item.pid) === item.starttime) await owner.signal(item, 'SIGUSR2');
        await pause(Math.min(200, tickMs)); await drain(); await scan();
        snapshot = { event: 'snapshot', idleMs: Math.round(now() - lastProgress), lastBoundary,
          processes: owned.map(item => publicProcess(item, child.pid, workers)), ipc: [...ipc],
          cleanupStarted: ipc.length ? ipc.some(item => item.cleanupStarted) : null,
          ipcCoverage: ipc.length ? 'tracked-stores-in-responders-only; elapsed-unknown' : 'unavailable' };
        emit(snapshot);
      }
      if (elapsed >= outerMs || now() - lastProgress >= idleMs) {
        timeout = elapsed >= outerMs ? 'outer' : 'idle';
        emit({ event: 'timeout', reason: timeout });
        await stopOwned(`timeout-${timeout}`); break;
      }
      await pause(tickMs);
    }
    await drain(); await scan();
    if (owned.length) await stopOwned('residual-after-exit');
    const closeUntil = now() + graceMs;
    while (!closeDone && now() < closeUntil) await pause(Math.min(100, graceMs));
    if (!closeDone) { child.stdout.destroy(); child.stderr.destroy(); collectionError = 'streams_not_closed'; }
    await drain(); await scan();
    if (owned.length) collectionError = 'owned_processes_remain';
    else {
      safeToRemoveEventDirectory = true;
      await removeOwnedFixtures(fixtureRoot, initialNames, fixtures, name => forced.push({ fixture: name, reason: 'residual-fixture' }));
      await runtime.cleanup(fileName => forced.push({ runtime: path.basename(fileName), reason: 'residual-runtime' }));
    }
  } catch (error) {
    collectionError = /^[a-z_]+$/.test(error.code ?? '') ? error.code : 'collection_failed';
    try { await stopOwned('collection-error'); safeToRemoveEventDirectory = owned.length === 0; }
    catch { collectionError = 'cleanup_failed'; }
    child.stdout.destroy(); child.stderr.destroy();
  } finally {
    const info = await lstat(directory, { bigint: true }).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (safeToRemoveEventDirectory && info && info.isDirectory() && !info.isSymbolicLink() && info.uid === BigInt(process.geteuid())
      && info.dev === directoryInfo.dev && info.ino === directoryInfo.ino && await realpath(directory) === directory) await rm(directory, { recursive: true });
    else if (safeToRemoveEventDirectory && info) collectionError = 'event_directory_identity_changed';
  }
  const outcome = timeout ? 'timeout' : spawnError || collectionError || !childExit || childExit.code !== 0 || childExit.signal || forced.length ? 'failed' : 'passed';
  const result = { outcome, timeout, childExit, spawnError, collectionError, elapsedMs: Math.round(now() - began),
    forced, remainingProcesses: owned.map(item => publicProcess(item, child.pid, workers)),
    observedProcesses: [...processHistory.values()], snapshot, events: captured };
  emit({ event: 'result', outcome, timeout, childExit, spawnError, collectionError, forced: forced.length, remaining: result.remainingProcesses.length, elapsedMs: result.elapsedMs });
  return result;
}

async function main() {
  const mode = process.argv[2];
  const name = '^Kindle地域公開UI: Linuxでは実Kindle起動を拒否する$';
  let command, args, outerMs;
  if (mode === 'single') {
    command = 'xvfb-run'; args = ['-a', process.execPath, '--test', '--test-concurrency=1', `--test-name-pattern=${name}`, 'tests/mvp-workflow.test.mjs']; outerMs = 150_000;
  } else if (mode === 'full') {
    command = 'xvfb-run'; args = ['-a', 'npm', 'test']; outerMs = 1_200_000;
  } else throw new Error('expected_single_or_full');
  const result = await runDiagnostic({ command, args, outerMs });
  process.exitCode = result.outcome === 'passed' ? 0 : result.timeout ? 124 : result.childExit?.code || 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
