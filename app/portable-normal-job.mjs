// An identity marker for jobs created by the normal Portable application.  It
// is not capture consent: selection, the owned Reader, preview and approval
// remain separate.  In particular, an old unmarked/limited job is never
// upgraded merely because it is opened in a newer application.
import { constants } from 'node:fs';
import { lstat, open, realpath, readdir, link, unlink } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from './store-client.mjs';
import { privateMetadata } from './private-path.mjs';
import { portableLimitedClaimState, portableLimitedOriginClaimState } from './portable-limited-claim.mjs';

const fail = () => { throw new AppError('portable_normal_job_unavailable'); };
const identity = value => ({ dev: String(value.dev), ino: String(value.ino), uid: value.uid });
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid;

async function directory(name) {
  const info = await lstat(name);
  if (info.isSymbolicLink() || !privateMetadata(info, true) || await realpath(name) !== name) fail();
  return identity(info);
}

async function context(data, job) {
  const id = job?.manifest?.job_id;
  if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)
      || job.job_path !== path.join(data, 'jobs', id)) fail();
  if (await portableLimitedClaimState(data, id) !== 'unused'
      || await portableLimitedOriginClaimState(job, data) !== 'unused') fail();
  return { version: 1, job: id, data: await directory(data), directory: await directory(job.job_path) };
}

function name(data, id, suffix) { return path.join(data, `portable-normal-${id}.${suffix}`); }
async function readRecord(file) {
  let handle;
  try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if (error.code === 'ENOENT') return null; fail(); }
  try {
    const info = await handle.stat(), current = await lstat(file);
    if (!privateMetadata(info) || current.isSymbolicLink() || info.dev !== current.dev || info.ino !== current.ino
        || info.size < 1 || info.size > 2048) fail();
    return JSON.parse(await handle.readFile('utf8'));
  } catch { fail(); }
  finally { await handle.close(); }
}
async function writeRecord(file, value) {
  let handle;
  try { handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch { fail(); }
  try { await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync(); }
  catch { fail(); }
  finally { await handle.close(); }
  // A crash or unconfirmed directory sync must not make the marker authority.
  const parent = await open(path.dirname(file), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await parent.sync(); } finally { await parent.close(); }
}
function matching(actual, expected) {
  return actual?.version === 1 && actual.job === expected.job && same(actual.data ?? {}, expected.data)
    && same(actual.directory ?? {}, expected.directory);
}

export async function markPortableNormalJob(data, job) {
  const value = await context(data, job);
  if (job.manifest.state !== 'ready' || job.manifest.images.length || job.manifest.exports.length
      || job.manifest.last_capture_id !== null || job.manifest.checkpoint != null || job.issues.length || job.orphan_files.length) fail();
  await writeRecord(name(data, value.job, 'job'), value);
}

// The session association is made once for a new, empty normal job. Recovery
// only reads it; a recovered historic job or an already populated sample cannot
// acquire it. It never grants a new screenshot or a page turn by itself.
export async function bindPortableNormalJob(data, job, session) {
  const value = await context(data, job);
  if (!/^saved-[a-f0-9-]{36}$/.test(session ?? '') || !matching(await readRecord(name(data, value.job, 'job')), value)) fail();
  const file = name(data, value.job, 'session');
  let record = await readRecord(file);
  if (!record) {
    if (job.manifest.state !== 'ready' || job.manifest.images.length || job.manifest.exports.length
        || job.manifest.last_capture_id !== null || job.manifest.checkpoint != null || job.issues.length || job.orphan_files.length) fail();
    await writeRecord(file, { ...value, session });
    record = await readRecord(file);
  }
  if (!matching(record, value) || record.session !== session) fail();
}

export async function assertPortableNormalJob(data, job, session) {
  const value = await context(data, job);
  if (!matching(await readRecord(name(data, value.job, 'job')), value)) fail();
  const record = await readRecord(name(data, value.job, 'session'));
  if (!matching(record, value) || record.session !== session) fail();
}

// Append-only, per-run records are observations, never capture authority. They
// live next to the existing normal-job identity, not in the Rust job root.
// A missing terminal record, partial write or old job remains unknown.
const reasons = new Set(['end_candidate', 'capture_limit_reached', 'capture_time_limit_reached',
  'capture_byte_limit_reached', 'capture_free_space_limit_reached', 'capture_storage_check_failed',
  'image_review_required', 'target_changed', 'browser_target_changed', 'store_disconnected', 'application_closed',
  'capture_or_advance_failed', 'user_paused', 'user_stopped', 'interrupted']);
const stages = new Set(['capture', 'capture_begin', 'capture_upload', 'target_recheck_before_commit', 'capture_commit',
  'image_review', 'advance_preflight', 'advance_dispatch', 'advance_confirmation', 'advance_confirmed',
  'advance_bound_check', 'advance_next_check', 'advance_handle_check', 'advance_trial_check', 'advance_recheck',
  'capture_limit_stop', 'end_stop', 'resource_stop', 'unknown']);
const dispatches = new Set(['not_sent', 'sent', 'unknown', 'confirmed']);
const exactKeys = (record, keys) => record && Object.keys(record).sort().join(',') === [...keys].sort().join(',');
const resultPrefix = id => `portable-normal-${id}.result-`;
const validLimit = limit => limit === null || Number.isSafeInteger(limit) && limit > 0;
const beginKeys = ['version', 'job', 'data', 'directory', 'session', 'sequence', 'limit'];
const endKeys = [...beginKeys, 'reason', 'stage', 'dispatch'];

async function resultFiles(data, id) {
  const prefix = resultPrefix(id);
  return (await readdir(data)).filter(entry => entry.startsWith(prefix)).sort();
}
async function writeResultRecord(file, value) {
  // Publish only after the complete data and its directory entry are durable.
  // A visible pending file makes an interrupted or failed transaction unknown;
  // it is never silently removed on an error.
  const pending = `${file}.pending`;
  const parent = await open(path.dirname(file), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const checkParent = async () => {
      if (!same(identity(await parent.stat()), value.data) || !same(await directory(path.dirname(file)), value.data)) fail();
    };
    await checkParent();
    await writeRecord(pending, value);
    await checkParent();
    await link(pending, file); // Exclusive: never overwrite a prior observation.
    await parent.sync();
    await checkParent();
    await unlink(pending);
    await parent.sync();
    await checkParent();
  } finally { await parent.close(); }
}
async function resultBinding(data, job) {
  const value = await context(data, job);
  if (!matching(await readRecord(name(data, value.job, 'job')), value)) fail();
  const bound = await readRecord(name(data, value.job, 'session'));
  if (!matching(bound, value) || !/^saved-[a-f0-9-]{36}$/.test(bound.session ?? '')) fail();
  return { ...value, session: bound.session };
}
const resultFile = (data, id, sequence, suffix) => path.join(data, `${resultPrefix(id)}${String(sequence).padStart(12, '0')}.${suffix}`);
function matchesResult(record, binding, sequence, terminal = false) {
  return exactKeys(record, terminal ? endKeys : beginKeys) && matching(record, binding)
    && record.session === binding.session && record.sequence === sequence && validLimit(record.limit)
    && (!terminal || reasons.has(record.reason) && stages.has(record.stage) && dispatches.has(record.dispatch));
}

async function latestResult(data, job) {
  const id = job?.manifest?.job_id;
  if (!/^[a-f0-9]{32}$/.test(id ?? '')) return null;
  const files = await resultFiles(data, id);
  if (!files.length) return null;
  const binding = await resultBinding(data, job), prefix = resultPrefix(id), sequences = new Set();
  for (const file of files) {
    const match = /^(\d{12})\.(start|stop)$/.exec(file.slice(prefix.length));
    if (!match || Number(match[1]) < 1 || !Number.isSafeInteger(Number(match[1]))) fail();
    sequences.add(Number(match[1]));
  }
  const ordered = [...sequences].sort((a, b) => a - b);
  let latest;
  for (const [index, sequence] of ordered.entries()) {
    if (sequence !== index + 1) fail();
    const begin = await readRecord(resultFile(data, id, sequence, 'start'));
    if (!matchesResult(begin, binding, sequence)) fail();
    const end = await readRecord(resultFile(data, id, sequence, 'stop'));
    if (end && (!matchesResult(end, binding, sequence, true) || end.limit !== begin.limit) || !end && index !== ordered.length - 1) fail();
    latest = { binding, sequence, begin, end };
  }
  return latest;
}

export async function readPortableNormalResult(data, job) {
  try {
    const result = await latestResult(data, job);
    if (!result) return null;
    return { status: result.end ? 'stopped' : 'unknown', mode: result.begin.limit === null ? 'auto' : 'manual',
      limit: result.begin.limit, reason: result.end?.reason ?? null, stage: result.end?.stage ?? null,
      dispatch: result.end?.dispatch ?? null };
  } catch { return { status: 'unknown', mode: null, limit: null, reason: null, stage: null, dispatch: null }; }
}

export async function beginPortableNormalResult(data, job, session, limit) {
  if (!validLimit(limit)) fail();
  const previous = await latestResult(data, job);
  if (previous && !previous.end) fail();
  const binding = await resultBinding(data, job);
  if (binding.session !== session) fail();
  const sequence = (previous?.sequence ?? 0) + 1;
  if (sequence > 999999999999) fail();
  const begin = { ...binding, sequence, limit };
  await writeResultRecord(resultFile(data, binding.job, sequence, 'start'), begin);
  return Object.freeze(begin);
}

export async function finishPortableNormalResult(data, job, begin, reason, stage, dispatch) {
  const binding = await resultBinding(data, job);
  if (!matchesResult(begin, binding, begin?.sequence) || !reasons.has(reason) || !stages.has(stage) || !dispatches.has(dispatch)) fail();
  const latest = await latestResult(data, job);
  if (!latest || latest.sequence !== begin.sequence || latest.end || latest.begin.limit !== begin.limit) fail();
  await writeResultRecord(resultFile(data, binding.job, begin.sequence, 'stop'), { ...begin, reason, stage, dispatch });
}
