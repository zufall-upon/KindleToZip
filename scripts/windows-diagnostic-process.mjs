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
export function createWindowsOwnerTracker({ runnerPid, supervisorPid, backend, notBeforeMs = null }) {
  if (!validPid(runnerPid) || !validPid(supervisorPid)) throw failure('root_identity_invalid');
  const known = new Map();
  let latest = [], initialized = false;
  async function scan(timeoutMs = 5000) {
    const rows = await backend.query(timeoutMs);
    if (!Array.isArray(rows)) throw failure('metadata_invalid');
    const current = new Map();
    for (const row of rows) {
      if (!Number.isSafeInteger(row.pid) || row.pid < 0 || !Number.isSafeInteger(row.parentPid) || row.parentPid < 0 || current.has(row.pid)) throw failure('metadata_invalid');
      current.set(row.pid, row);
    }
    if (!initialized) {
      const root = current.get(runnerPid);
      if (!root || root.parentPid !== supervisorPid || !birthPattern.test(root.creationDate ?? '')) throw failure('root_identity_unconfirmed');
      if (notBeforeMs !== null) {
        const b = root.creationDate;
        const started = Date.parse(`${b.slice(0, 4)}-${b.slice(4, 6)}-${b.slice(6, 8)}T${b.slice(8, 10)}:${b.slice(10, 12)}:${b.slice(12, 14)}.${b.slice(15, 18)}Z`);
        if (!Number.isFinite(started) || started < notBeforeMs) throw failure('root_identity_unconfirmed');
      }
      known.set(root.pid, { ...root, role: 'runner', reparented: false }); initialized = true;
    }
    for (const [pid, previous] of known) {
      const currentRecord = current.get(pid);
      if (currentRecord && currentRecord.creationDate !== previous.creationDate) throw failure('identity_changed');
      if (currentRecord && currentRecord.parentPid !== previous.parentPid) previous.reparented = true;
    }
    let changed;
    do {
      changed = false;
      for (const row of rows) {
        if (known.has(row.pid) || !known.has(row.parentPid)) continue;
        const parent = known.get(row.parentPid), liveParent = current.get(row.parentPid);
        if (!liveParent || liveParent.creationDate !== parent.creationDate) throw failure('ancestry_unconfirmed');
        if (!birthPattern.test(row.creationDate ?? '') || row.creationDate < parent.creationDate) throw failure('identity_unconfirmed');
        known.set(row.pid, { ...row, role: role(row.name ?? '', false), reparented: false }); changed = true;
      }
    } while (changed);
    latest = [...known.values()].filter(item => current.has(item.pid)).map(item => {
      const row = current.get(item.pid);
      return { ...item, parentPid: row.parentPid };
    });
    return latest.map(publicRecord);
  }
  async function stop(record, timeoutMs = 5000) {
    const original = known.get(record.pid);
    if (!original || record.creationDate !== original.creationDate) throw failure('identity_unconfirmed');
    const answer = await backend.stop(original, timeoutMs);
    if (answer === 'identity_mismatch') throw failure('identity_changed');
    if (answer === 'unconfirmed') throw failure('termination_unconfirmed');
    return answer;
  }
  return { scan, stop, latest: () => latest.map(publicRecord), history: () => [...known.values()].map(publicRecord) };
}
