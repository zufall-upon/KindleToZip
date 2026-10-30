// Test-only Windows process metadata. Never discover ownership by name or PID
// alone. Commands below use only standard PowerShell/CIM and Node child_process.
import { spawn } from 'node:child_process';
import path from 'node:path';

const failure = code => Object.assign(new Error(code), { code });
const birthPattern = /^\d{14}\.\d{6}Z$/;
const validPid = pid => Number.isSafeInteger(pid) && pid > 0;

// Also bounds the PowerShell process and its inherited streams. The only kill
// here is on the ChildProcess handle for the helper that *we* directly spawned.
export function boundedProcess(command, args, { timeoutMs = 5000, closeMs = 1000,
  maxBytes = 4 * 1024 * 1024, spawnFn = spawn } = {}) {
  return new Promise((resolve, reject) => {
    let child, timer, closeTimer, finished = false, exited = false, problem = null, text = '', size = 0;
    const finish = (error, result) => {
      if (finished) return;
      finished = true; clearTimeout(timer); clearTimeout(closeTimer);
      if (error) {
        child?.stdout?.destroy(); child?.stderr?.destroy();
        // An unconfirmed helper must not keep the diagnostic CLI alive after
        // its finite wait. Releasing the reference is not proof of exit.
        if (!exited) child?.unref();
        reject(failure(error));
      }
      else resolve(result);
    };
    const abort = code => {
      if (finished || problem) return;
      problem = code;
      if (!exited) {
        try { child.kill(); } catch { /* Report unconfirmed below. */ }
      }
      closeTimer = setTimeout(() => finish(exited ? code : 'monitor_helper_unconfirmed'), closeMs);
    };
    try { child = spawnFn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); }
    catch { finish('monitor_spawn_failed'); return; }
    child.on('error', () => finish('monitor_spawn_failed'));
    child.on('exit', (code, signal) => {
      exited = true;
      if (problem) return;
      if (code !== 0 || signal) { finish('monitor_command_failed'); return; }
      clearTimeout(timer);
      closeTimer = setTimeout(() => finish('monitor_streams_timeout'), closeMs);
    });
    child.on('close', (code, signal) => {
      if (problem) finish(problem);
      else if (code !== 0 || signal) finish('monitor_command_failed');
      else finish(null, text);
    });
    child.stdout?.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) abort('monitor_output_limit');
      else text += chunk.toString('utf8');
    });
    // Never log PowerShell's stderr: it may contain command arguments or paths.
    child.stderr?.on('data', () => {});
    timer = setTimeout(() => abort('monitor_command_timeout'), timeoutMs);
  });
}

const queryScript = String.raw`
$ErrorActionPreference = 'Stop'
$items = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,Name | ForEach-Object {
  $birth = $null
  if ($null -ne $_.CreationDate) { $birth = $_.CreationDate.ToUniversalTime().ToString('yyyyMMddHHmmss.ffffff') + 'Z' }
  @{ pid = [int]$_.ProcessId; parentPid = [int]$_.ParentProcessId; creationDate = $birth; name = [string]$_.Name }
})
ConvertTo-Json -InputObject $items -Depth 3 -Compress
`;

// Process.Handle opens and caches a Windows process handle before StartTime is
// checked; Kill() is then invoked on the same Process object/handle. Thus PID
// reuse between the check and Kill cannot redirect it to a different process.
// There is deliberately no taskkill /T, global scan-kill, argv or env query.
function stopScript(record) {
  if (!validPid(record.pid) || !birthPattern.test(record.creationDate)) throw failure('identity_invalid');
  return String.raw`
$ErrorActionPreference = 'Stop'
try { $p = Get-Process -Id ${record.pid} -ErrorAction Stop } catch { Write-Output 'unconfirmed'; exit 0 }
try {
  $handle = $p.Handle
  $birth = $p.StartTime.ToUniversalTime().ToString('yyyyMMddHHmmss.ffffff') + 'Z'
  if ($birth -ne '${record.creationDate}') { Write-Output 'identity_mismatch'; exit 0 }
  $p.Kill()
  Write-Output 'terminated'
} catch { Write-Output 'unconfirmed' } finally { $p.Dispose() }
`;
}

export function createWindowsBackend({ systemRoot = process.env.SystemRoot, run = boundedProcess } = {}) {
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) throw failure('system_root_unavailable');
  const powershell = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const execute = (script, timeoutMs) => run(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')], { timeoutMs });
  return {
    async query(timeoutMs) {
      const text = await execute(queryScript, timeoutMs);
      try { const parsed = JSON.parse(text); if (!Array.isArray(parsed)) throw new Error(); return parsed; }
      catch { throw failure('metadata_invalid'); }
    },
    async stop(record, timeoutMs) {
      const answer = (await execute(stopScript(record), timeoutMs)).trim();
      if (!['absent', 'identity_mismatch', 'terminated', 'unconfirmed'].includes(answer)) throw failure('termination_invalid');
      return answer;
    },
  };
}

const role = (name, runner) => runner ? 'runner' : /^(?:chrome|chromium|msedge)(?:\.exe)?$/i.test(name) ? 'browser'
  : /^node(?:\.exe)?$/i.test(name) ? 'node' : /^cmd(?:\.exe)?$/i.test(name) ? 'command' : 'other';
const publicRecord = item => ({ pid: item.pid, parentPid: item.parentPid, creationDate: item.creationDate,
  role: item.role, reparented: item.reparented });

// A child is admitted only while its already-admitted parent is present with
// the same creation time, and only if its creation is no earlier than the
// parent's. Known children stay known across reparenting, but a new child of an
// absent/reused parent is never guessed into the tree.
export function createWindowsOwnerTracker({ runnerPid, supervisorPid, backend, notBeforeMs = null, onDecision = () => {} }) {
  if (!validPid(runnerPid) || !validPid(supervisorPid)) throw failure('root_identity_invalid');
  const history = new Map(), lastByPid = new Map(), absences = new Set(), decisions = new Set();
  const key = item => `${item.pid}:${item.creationDate}`;
  const validBirth = value => typeof value === 'string' && birthPattern.test(value);
  let active = new Map(), validScan = false, rootIdentity = null, rootRetired = false;
  function decision(kind, action, previous, observed, parentIdentityMatched = 'unknown', stopAttempted = false) {
    const record = { role: (previous ?? observed)?.pid === runnerPid ? 'root' : 'child', kind, decision: action,
      pid: (previous ?? observed)?.pid ?? runnerPid,
      previousCreationDate: validBirth(previous?.creationDate) ? previous.creationDate : 'unknown',
      observedCreationDate: validBirth(observed?.creationDate) ? observed.creationDate : 'unknown',
      absenceObserved: previous ? absences.has(key(previous)) : false, parentIdentityMatched, stopAttempted };
    const id = JSON.stringify(record);
    if (decisions.has(id)) return;
    decisions.add(id);
    try { onDecision(record); } catch { /* Observation cannot widen stop permissions. */ }
  }
  async function scan(timeoutMs = 5000) {
    // An unsuccessful or incomplete scan never authorizes a later stop based
    // solely on the previous sample. Publish a new active set atomically.
    validScan = false;
    const rows = await backend.query(timeoutMs);
    if (!Array.isArray(rows)) { decision('metadata_invalid', 'reject'); throw failure('metadata_invalid'); }
    const current = new Map();
    for (const row of rows) {
      if (!row || !Number.isSafeInteger(row.pid) || row.pid < 0 || !Number.isSafeInteger(row.parentPid) || row.parentPid < 0 || current.has(row.pid)) {
        decision('metadata_invalid', 'reject'); throw failure('metadata_invalid');
      }
      current.set(row.pid, row);
    }
    if (!rootIdentity) {
      const root = current.get(runnerPid);
      if (!root || root.parentPid !== supervisorPid || !validBirth(root.creationDate)) throw failure('root_identity_unconfirmed');
      if (notBeforeMs !== null) {
        const b = root.creationDate;
        const started = Date.parse(`${b.slice(0, 4)}-${b.slice(4, 6)}-${b.slice(6, 8)}T${b.slice(8, 10)}:${b.slice(10, 12)}:${b.slice(12, 14)}.${b.slice(15, 18)}Z`);
        if (!Number.isFinite(started) || started < notBeforeMs) throw failure('root_identity_unconfirmed');
      }
      // Pin the directly spawned individual, even if a later field in this
      // first sample is invalid. Never initialize a replacement root by PID.
      rootIdentity = { ...root, role: 'runner', reparented: false };
    }
    const rootNow = current.get(runnerPid);
    if (rootNow && rootNow.creationDate !== rootIdentity.creationDate) {
      decision('active_changed', 'reject', rootIdentity, rootNow); throw failure('identity_changed');
    }
    if (rootNow && rootRetired) {
      decision('active_changed', 'reject', rootIdentity, rootNow); throw failure('root_identity_unconfirmed');
    }
    const next = new Map();
    if (rootNow && !history.has(key(rootIdentity))) next.set(runnerPid, rootIdentity);
    for (const [pid, previous] of active) {
      const currentRecord = current.get(pid);
      if (!currentRecord) continue;
      if (!validBirth(currentRecord.creationDate)) {
        decision('metadata_invalid', 'reject', previous, currentRecord); throw failure('metadata_invalid');
      }
      if (currentRecord.creationDate !== previous.creationDate) {
        // No valid absence has been seen for this active individual.
        decision('active_changed', 'reject', previous, currentRecord); throw failure('identity_changed');
      }
      next.set(pid, { ...previous, parentPid: currentRecord.parentPid,
        reparented: previous.reparented || currentRecord.parentPid !== previous.parentPid });
    }
    let changed;
    do {
      changed = false;
      for (const row of rows) {
        if (row.pid === runnerPid || next.has(row.pid) || !next.has(row.parentPid)) continue;
        const parent = next.get(row.parentPid), liveParent = current.get(row.parentPid);
        if (!liveParent || liveParent.creationDate !== parent.creationDate) {
          decision('parent_changed', 'reject', parent, liveParent, false); throw failure('ancestry_unconfirmed');
        }
        if (!validBirth(row.creationDate) || row.creationDate < parent.creationDate) {
          decision('metadata_invalid', 'reject', null, row, true); throw failure('identity_unconfirmed');
        }
        next.set(row.pid, { ...row, role: role(row.name ?? '', false), reparented: false }); changed = true;
      }
    } while (changed);
    // Preserve known same-individual children across parent exit/reparenting,
    // but never infer an unknown orphan's ownership from a historical PPID.
    for (const row of rows) if (!next.has(row.pid) && (lastByPid.has(row.parentPid) || row.parentPid === runnerPid)
      && !current.has(row.parentPid)) {
      decision('parent_changed', 'reject', null, row, false); throw failure('ancestry_unconfirmed');
    }
    for (const item of active.values()) if (!next.has(item.pid)) {
      absences.add(key(item)); decision('retired_pid_reused', 'retire', item, null);
    }
    for (const row of rows) {
      const previous = history.get(lastByPid.get(row.pid));
      if (previous && previous.creationDate !== row.creationDate && absences.has(key(previous))) {
        decision('retired_pid_reused', next.has(row.pid) ? 'new_owned' : 'new_unowned', previous, row, next.has(row.parentPid));
      }
    }
    for (const item of next.values()) { history.set(key(item), item); lastByPid.set(item.pid, key(item)); }
    if (!rootNow) rootRetired = true;
    active = next; validScan = true;
    return [...active.values()].map(publicRecord);
  }
  async function stop(record, timeoutMs = 5000) {
    const original = active.get(record.pid);
    if (!validScan || !original || record.creationDate !== original.creationDate) throw failure('identity_unconfirmed');
    let answer;
    try { answer = await backend.stop(original, timeoutMs); }
    catch (error) { validScan = false; throw error; }
    if (answer === 'identity_mismatch') {
      validScan = false; decision('active_changed', 'reject', original, null, 'unknown', true); throw failure('identity_changed');
    }
    if (answer === 'unconfirmed') { validScan = false; throw failure('termination_unconfirmed'); }
    return answer;
  }
  return { scan, stop, latest: () => [...active.values()].map(publicRecord), history: () => [...history.values()].map(publicRecord) };
}
