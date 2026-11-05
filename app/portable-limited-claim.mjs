// A durable consumption record, not an authorisation or a Reader capability.
// Callers must independently enforce the selected Portable, owner, job and
// user-consent boundaries before using it. No book, title or image is recorded.
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { privateMetadata } from './private-path.mjs';
import { AppError } from './store-client.mjs';

// This is intentionally different from both historic expected-book claims.
const claimName = 'portable-reader-limited-20261102.claim';
const attemptClaimName = id => `portable-reader-limited-${id}.claim`;
const attemptScope = 'preview-1-displays-2-turn-1-png-review';
const fail = code => { throw new AppError(code); };
const sameFile = (a, b) => ['dev', 'ino', 'uid', 'mode', 'nlink'].every(key => a[key] === b[key]);

async function privateDirectory(directory) {
  if (process.platform !== 'linux' || typeof directory !== 'string' || !path.isAbsolute(directory)
      || path.resolve(directory) !== directory) fail('portable_limited_path_invalid');
  const info = await lstat(directory);
  if (info.isSymbolicLink() || !privateMetadata(info, true) || await realpath(directory) !== directory) {
    fail('portable_limited_path_invalid');
  }
  return info;
}

function validateLegacyRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === 'job,session,version'
    && value.version === 1 && typeof value.job === 'string' && /^[a-f0-9]{32}$/.test(value.job)
    && typeof value.session === 'string' && /^saved-[a-f0-9-]{36}$/.test(value.session);
}

function validateAttemptRecord(value, jobId) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === 'consumed,job,scope,session,version'
    && value.version === 2 && value.job === jobId && value.consumed === true && value.scope === attemptScope
    && typeof value.session === 'string' && /^saved-[a-f0-9-]{36}$/.test(value.session);
}

async function readRecord(dataDirectory, filename, validate) {
  const name = path.join(dataDirectory, filename);
  let handle;
  try {
    handle = await open(name, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    fail('portable_limited_claim_unknown');
  }
  try {
    const opened = await handle.stat();
    if (!privateMetadata(opened) || opened.size < 1 || opened.size > 1024) fail('portable_limited_claim_unknown');
    const value = JSON.parse(await handle.readFile('utf8'));
    const current = await lstat(name);
    if (current.isSymbolicLink() || !sameFile(opened, current) || !validate(value)) fail('portable_limited_claim_unknown');
    return value;
  } catch (error) {
    if (error instanceof AppError) throw error;
    fail('portable_limited_claim_unknown');
  } finally { await handle.close(); }
}

// Inspect only this claim's own metadata and bounded record. An incomplete,
// replaced or malformed record is unknown, not an available new permission.
export async function portableLimitedClaimState(dataDirectory, jobId) {
  await privateDirectory(dataDirectory);
  if (typeof jobId !== 'string' || !/^[a-f0-9]{32}$/.test(jobId)) fail('portable_limited_job_invalid');
  const legacy = await readRecord(dataDirectory, claimName, validateLegacyRecord);
  const attempt = await readRecord(dataDirectory, attemptClaimName(jobId), value => validateAttemptRecord(value, jobId));
  if (legacy?.job === jobId && attempt) fail('portable_limited_claim_unknown');
  return legacy?.job === jobId || attempt ? 'this-job' : 'unused';
}

// Bind the active capability to the exact new claim/session/job again at use.
// This reads only our bounded consumption record, never authentication files.
export async function assertPortableLimitedClaimBinding(dataDirectory, jobId, sessionId) {
  await privateDirectory(dataDirectory);
  if (typeof jobId !== 'string' || !/^[a-f0-9]{32}$/.test(jobId)) fail('portable_limited_claim_unknown');
  const legacy = await readRecord(dataDirectory, claimName, validateLegacyRecord);
  const value = await readRecord(dataDirectory, attemptClaimName(jobId), record => validateAttemptRecord(record, jobId));
  if (legacy?.job === jobId || !value || value.session !== sessionId) fail('portable_limited_claim_unknown');
}

// Public recovery accepts jobs outside the current Application data directory.
// An intact one-shot job keeps the restriction from its own standard jobs/<id>
// location; choosing a different Application data directory is not new consent.
// Ordinary relocated jobs need not have a private enclosing data directory, so
// inspect only the claim entry's existence before applying the strict reader.
export async function portableLimitedOriginClaimState(job, currentDirectory) {
  const id = job?.manifest?.job_id, jobPath = job?.job_path;
  if (typeof jobPath !== 'string' || !path.isAbsolute(jobPath) || typeof id !== 'string'
      || !/^[a-f0-9]{32}$/.test(id)) return 'unused';
  const directory = path.dirname(path.dirname(jobPath));
  if (directory === currentDirectory || jobPath !== path.join(directory, 'jobs', id)) return 'unused';
  let found = false;
  for (const name of [claimName, attemptClaimName(id)]) {
    try { await lstat(path.join(directory, name)); found = true; }
    catch (error) { if (error.code !== 'ENOENT') fail('portable_limited_claim_unknown'); }
  }
  if (!found) return 'unused';
  return portableLimitedClaimState(directory, id);
}

// Must be called on the current store snapshot at each use, not just on the
// snapshot which happened to create the claim. The claim itself does not lock
// or freeze mutable capture settings.
export function assertPortableLimitedSettings(job) {
  const settings = job?.manifest?.capture_settings;
  if (settings?.image_format !== 'png' || settings?.page_output_mode !== 'single_image') fail('portable_limited_settings_invalid');
}

// The exclusive record is created before any browser/capture operation. It is
// never removed, including on write/fsync errors or an interrupted process.
// No caller may interpret successful creation alone as permission to capture.
export async function claimPortableLimitedRun(dataDirectory, selected, job) {
  const dataInfo = await privateDirectory(dataDirectory);
  const id = job?.manifest?.job_id;
  if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id) || job.job_path !== path.join(dataDirectory, 'jobs', id)
      || job.manifest.state !== 'ready' || !Array.isArray(job.manifest.images) || job.manifest.images.length
      || !Array.isArray(job.manifest.exports) || job.manifest.exports.length
      || job.manifest.next_capture_id !== 1 || job.manifest.next_render_version !== 1
       || job.manifest.last_capture_id !== null || job.manifest.checkpoint != null
      || !Array.isArray(job.orphan_files) || job.orphan_files.length
      || !Array.isArray(job.issues) || job.issues.length) fail('portable_limited_job_invalid');
  if (!selected || typeof selected.id !== 'string' || !/^saved-[a-f0-9-]{36}$/.test(selected.id)
      || selected.root !== path.join(dataDirectory, selected.id)
      || selected.profile !== path.join(selected.root, 'owned/profile')) fail('select_saved_session');
  assertPortableLimitedSettings(job);
  await privateDirectory(path.join(dataDirectory, 'jobs'));
  await privateDirectory(job.job_path);
  await privateDirectory(selected.root);
  await privateDirectory(path.join(selected.root, 'owned'));
  await privateDirectory(selected.profile);
  // A legacy record is immutable and still consumes its own job, but must not
  // consume a distinct new job. An unreadable legacy record remains unknown.
  const legacy = await readRecord(dataDirectory, claimName, validateLegacyRecord);
  if (legacy?.job === id) fail('portable_limited_claim_consumed');
  const name = path.join(dataDirectory, attemptClaimName(id));
  let handle;
  try {
    handle = await open(name, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') fail('portable_limited_claim_consumed');
    fail('portable_limited_claim_unknown');
  }
  try {
    await handle.writeFile(`${JSON.stringify({ version: 2, job: id, session: selected.id, scope: attemptScope, consumed: true })}\n`);
    await handle.sync();
    const written = await handle.stat(), current = await lstat(name), parent = await lstat(dataDirectory);
    if (!privateMetadata(written) || current.isSymbolicLink() || !sameFile(written, current)
        || !sameFile(dataInfo, parent)) fail('portable_limited_claim_unknown');
    const directory = await open(dataDirectory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      if (!sameFile(dataInfo, await directory.stat())) fail('portable_limited_claim_unknown');
      await directory.sync();
    } finally { await directory.close(); }
  } catch (error) {
    if (error instanceof AppError) throw error;
    fail('portable_limited_claim_unknown');
  } finally { await handle.close(); }
}
