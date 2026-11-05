// Fixed, local startup result for one newly claimed Portable job. No messages,
// stacks, URLs, profile paths, book labels or credentials enter this format.
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, link, unlink } from 'node:fs/promises';
import path from 'node:path';
import { privateMetadata } from './private-path.mjs';
import { assertPortableLimitedClaimBinding } from './portable-limited-claim.mjs';
import { AppError } from './store-client.mjs';
import { projectStartupConnectionObservation } from './portable-startup-observation.mjs';

const stages = new Set(['owner_start', 'owner_check', 'browser_launch', 'owner_verify',
  'pipe_attach', 'reader_initialize', 'capture_scale', 'record_start', 'record_finish', 'unclassified']);
const reached = new Set(['claim_consumed', 'owner_ready', 'pipe_attached', 'reader_initialized', 'ready', 'unknown']);
const codes = new Set(['target_changed', 'operation_timeout', 'window_not_available', 'capture_scale_unavailable',
  'owned_pipe_unconfirmed', 'owned_pipe_release_unconfirmed', 'login_in_use_or_unknown',
  'login_identity_changed', 'login_lock_changed', 'login_start_unconfirmed', 'login_close_unconfirmed',
  'unsafe_login_directory', 'unsafe_login_marker', 'snap_personal_init_exists', 'snap_changed',
  'portable_session_unavailable', 'record_failed', 'ENOENT', 'EACCES', 'unclassified']);
const initializationSteps = Object.freeze(['page_identity', 'pipe_ready', 'viewport_read', 'viewport_apply', 'pipe_bind']);
export const portableInitialRejectionReasons = Object.freeze(['initial_invalid', 'page_closed', 'context_changed',
  'browser_disconnected', 'initial_page_missing', 'origin_mismatch', 'known_auth_pending', 'unclassified']);
export const portableInitialOriginKinds = Object.freeze(['uncommitted', 'blank', 'browser_internal',
  'other_https', 'other_http', 'other_scheme', 'invalid', 'unknown']);
const rejectionReasons = new Set(portableInitialRejectionReasons);
function initialOriginValue(value) {
  if (!value || Object.keys(value).sort().join(',') !== 'kind,reachedExpectedOrigin'
      || !portableInitialOriginKinds.includes(value.kind) || typeof value.reachedExpectedOrigin !== 'boolean') throw new Error('invalid_startup_record');
  return { kind: value.kind, reachedExpectedOrigin: value.reachedExpectedOrigin };
}
function initializationValue(value) {
  if (!value || Object.keys(value).sort().join(',') !== 'completed,started'
      || value.started !== null && !initializationSteps.includes(value.started)
      || value.completed !== null && !initializationSteps.includes(value.completed)) throw new Error('invalid_startup_record');
  const started = initializationSteps.indexOf(value.started), completed = initializationSteps.indexOf(value.completed);
  if (!(started === completed || started === completed + 1)) throw new Error('invalid_startup_record');
  return { started: value.started, completed: value.completed };
}
export function portableStartupFailure(error, stage = 'unclassified') {
  const value = error?.portableStartupDiagnostic;
  if (value && Object.keys(value).sort().join(',') === 'code,stage'
      && stages.has(value.stage) && codes.has(value.code)) return { stage: value.stage, code: value.code };
  return { stage: stages.has(stage) ? stage : 'unclassified',
    code: codes.has(error?.code) ? error.code : error?.name === 'TimeoutError' ? 'operation_timeout' : 'unclassified' };
}
const empty = record => ({ record, lastReached: 'unknown', pipe: 'unknown', outcome: 'unknown', failure: null });
const same = (a, b) => ['dev', 'ino', 'uid', 'mode'].every(k => a[k] === b[k]);
function locations(data, jobId) {
  if (process.platform !== 'linux' || typeof data !== 'string' || !path.isAbsolute(data)
      || path.resolve(data) !== data || !/^[a-f0-9]{32}$/.test(jobId ?? '')) throw new AppError('portable_limited_record_failed');
  return [data, path.join(data, 'portable-reader-startup'), path.join(data, 'portable-reader-startup', jobId)];
}
async function directory(file) {
  const s = await lstat(file);
  if (s.isSymbolicLink() || !privateMetadata(s, true) || await realpath(file) !== file) throw new AppError('portable_limited_record_failed');
  return s;
}
async function exists(file) {
  try { await lstat(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}
async function readJson(file) {
  const h = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = await h.stat();
    if (!privateMetadata(s) || s.size > 1024) throw new AppError('portable_limited_record_failed');
    const value = JSON.parse(await h.readFile('utf8'));
    const current = await lstat(file);
    if (!same(s, current) || s.ino !== current.ino || current.nlink !== 1 || current.isSymbolicLink()) throw new AppError('portable_limited_record_failed');
    return value;
  } finally { await h.close(); }
}
function resultValue(v) {
  const keys = v && Object.keys(v).sort().join(',');
  const observedKeys = ['connectionObservation', 'failure', 'initialization', 'lastReached', 'outcome', 'pipe', 'version',
    ...(v?.initialRejection !== undefined ? ['initialRejection'] : []), ...(v?.initialOrigin !== undefined ? ['initialOrigin'] : [])].sort().join(',');
  if (!v || !(v.version === 1 && keys === 'failure,lastReached,outcome,pipe,version'
      || v.version === 2 && keys === 'failure,initialization,lastReached,outcome,pipe,version'
      || v.version === 3 && keys === 'failure,initialRejection,initialization,lastReached,outcome,pipe,version'
        && v.outcome === 'failed' && rejectionReasons.has(v.initialRejection)
      || v.version === 4 && keys === 'failure,initialOrigin,initialRejection,initialization,lastReached,outcome,pipe,version'
        && v.outcome === 'failed' && v.initialRejection === 'origin_mismatch'
      || [5, 6].includes(v.version) && keys === observedKeys
        && (v.version === 6) === Object.hasOwn(v.connectionObservation ?? {}, 'pre_playwright_10s')
        && (v.initialRejection === undefined || v.outcome === 'failed' && rejectionReasons.has(v.initialRejection))
        && (v.initialOrigin === undefined || v.initialRejection === 'origin_mismatch'))
      || !reached.has(v.lastReached) || !['unknown', 'attached'].includes(v.pipe) || !['ready', 'failed'].includes(v.outcome)) throw new Error('invalid_startup_record');
  if (v.outcome === 'ready' ? v.failure !== null || v.lastReached !== 'ready' || v.pipe !== 'attached'
    : !v.failure || Object.keys(v.failure).sort().join(',') !== 'code,stage'
      || !stages.has(v.failure.stage) || !codes.has(v.failure.code)) throw new Error('invalid_startup_record');
  return { record: 'complete', lastReached: v.lastReached, pipe: v.pipe, outcome: v.outcome,
    failure: v.failure ? { stage: v.failure.stage, code: v.failure.code } : null,
    ...(v.version >= 2 ? { initialization: initializationValue(v.initialization) } : {}),
    ...(v.initialRejection !== undefined ? { initialRejection: v.initialRejection } : {}),
    ...(v.initialOrigin !== undefined ? { initialOrigin: initialOriginValue(v.initialOrigin) } : {}),
    ...(v.version >= 5 ? { connectionObservation: projectStartupConnectionObservation(v.connectionObservation) } : {}) };
}
export async function readPortableStartupRecord(data, jobId) {
  try {
    const dirs = locations(data, jobId);
    for (const dir of dirs) { if (!await exists(dir)) return empty('not-recorded'); await directory(dir); }
    const dir = dirs.at(-1);
    if (await exists(path.join(dir, 'pending.json'))) return empty('incomplete');
    const start = await readJson(path.join(dir, 'start.json'));
    if (JSON.stringify(start) !== '{"version":1,"kind":"portable-limited-startup"}') return empty('incomplete');
    if (!await exists(path.join(dir, 'result.json'))) return empty('incomplete');
    return resultValue(await readJson(path.join(dir, 'result.json')));
  } catch { return empty('incomplete'); }
}

export function portableStartupRecorder(data, jobId, sessionId) {
  const dirs = locations(data, jobId), dir = dirs.at(-1);
  let state = { ...empty('incomplete'), lastReached: 'claim_consumed', initialization: { started: null, completed: null } }, terminal = false, identities;
  const check = async () => {
    await assertPortableLimitedClaimBinding(data, jobId, sessionId);
    for (let i = 0; i < dirs.length; i++) if (!same(identities[i], await directory(dirs[i]))) throw new AppError('portable_limited_record_failed');
  };
  async function writeRecord(file, value) {
    await check();
    const h = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await h.writeFile(`${JSON.stringify(value)}\n`); await h.sync();
      if (!privateMetadata(await h.stat())) throw new AppError('portable_limited_record_failed');
    } finally { await h.close(); }
    await check();
  }
  async function syncDir() {
    const h = await open(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { if (!same(identities.at(-1), await h.stat())) throw new AppError('portable_limited_record_failed'); await h.sync(); }
    finally { await h.close(); }
    await check();
  }
  async function finish(outcome, failure) {
    if (terminal) return;
    terminal = true;
    state = { ...state, record: 'incomplete', outcome, failure };
    const value = { version: state.connectionObservation?.pre_playwright_10s ? 6 : state.connectionObservation ? 5 : state.initialOrigin ? 4 : state.initialRejection ? 3 : 2, lastReached: state.lastReached, pipe: state.pipe, outcome, failure,
      initialization: state.initialization, ...(state.initialRejection ? { initialRejection: state.initialRejection } : {}),
      ...(state.initialOrigin ? { initialOrigin: state.initialOrigin } : {}),
      ...(state.connectionObservation ? { connectionObservation: state.connectionObservation } : {}) };
    try {
      resultValue(value); // Never publish an inconsistent new diagnostic record.
      await writeRecord(path.join(dir, 'pending.json'), value);
      await link(path.join(dir, 'pending.json'), path.join(dir, 'result.json'));
      await syncDir(); // Failed publication retains pending => never read as complete.
      await unlink(path.join(dir, 'pending.json'));
      state.record = 'complete';
      // The final result was synced before pending removal. A crash may restore
      // pending (conservative incomplete), never promote an unsynced result.
    } catch { state.record = 'incomplete'; }
  }
  return Object.freeze({ jobId, data,
    snapshot: () => ({ ...state, failure: state.failure ? { ...state.failure } : null, initialization: { ...state.initialization },
      ...(state.initialOrigin ? { initialOrigin: { ...state.initialOrigin } } : {}),
      ...(state.connectionObservation ? { connectionObservation: projectStartupConnectionObservation(state.connectionObservation) } : {}) }),
    connectionObservation(value) {
      if (terminal || state.record !== 'pending' || state.connectionObservation?.post_playwright) return;
      try {
        const projected = projectStartupConnectionObservation(value);
        if (state.connectionObservation?.pre_playwright && JSON.stringify(state.connectionObservation.pre_playwright) !== JSON.stringify(projected.pre_playwright)) return;
        if (state.connectionObservation?.pre_playwright_10s && JSON.stringify(state.connectionObservation.pre_playwright_10s) !== JSON.stringify(projected.pre_playwright_10s)) return;
        state.connectionObservation = projected;
      } catch { /* No unvalidated diagnostic data may enter a durable record. */ }
    },
    reached(value) {
      if (terminal || !reached.has(value)) return;
      state.lastReached = value;
      if (['pipe_attached', 'reader_initialized', 'ready'].includes(value)) state.pipe = 'attached';
    },
    readerInitialization(step, phase) {
      if (terminal || state.record !== 'pending') return;
      const index = initializationSteps.indexOf(step), { started, completed } = state.initialization;
      if (index < 0) return;
      if (phase === 'start' && started === completed && index === initializationSteps.indexOf(completed) + 1)
        state.initialization = { started: step, completed };
      else if (phase === 'complete' && started === step && index === initializationSteps.indexOf(completed) + 1)
        state.initialization = { started, completed: step };
    },
    initialRejection(reason, origin) {
      if (terminal || state.record !== 'pending' || state.initialRejection || !rejectionReasons.has(reason)) return;
      state.initialRejection = reason;
      // Optional closed observation only. Bad observers never alter refusal.
      if (reason === 'origin_mismatch' && origin) {
        try { state.initialOrigin = initialOriginValue(origin); } catch { /* omit unknown data */ }
      }
    },
    async begin() {
      try {
        await assertPortableLimitedClaimBinding(data, jobId, sessionId);
        await directory(data);
        try { await mkdir(dirs[1], { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
        await directory(dirs[1]);
        await mkdir(dir, { mode: 0o700 }); // Existing/partial attempt is never reused.
        identities = await Promise.all(dirs.map(directory));
        for (let i = 0; i < dirs.length; i++) {
          const h = await open(dirs[i], constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
          try { if (!same(identities[i], await h.stat())) throw new AppError('portable_limited_record_failed'); await h.sync(); }
          finally { await h.close(); }
        }
        await writeRecord(path.join(dir, 'start.json'), { version: 1, kind: 'portable-limited-startup' });
        await syncDir();
        state.record = 'pending';
      } catch {
        terminal = true; state.failure = { stage: 'record_start', code: 'record_failed' }; state.outcome = 'failed';
        throw new AppError('portable_limited_record_failed');
      }
    },
    async failed(error, stage) { await finish('failed', portableStartupFailure(error, stage)); },
    async ready() {
      if (terminal) return;
      state.lastReached = 'ready';
      await finish('ready', null);
      if (state.record !== 'complete') {
        state.outcome = 'failed'; state.failure = { stage: 'record_finish', code: 'record_failed' };
        throw new AppError('portable_limited_record_failed');
      }
    },
  });
}
