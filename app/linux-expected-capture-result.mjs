// Read-only validation of this one fixed result. Never prints an image, title,
// URL, credentials or page text. A failure is evidence of failure, not success.
import { constants } from 'node:fs';
import { open, lstat, readdir, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixedCapturePaths, fixedCorrectedCapturePaths } from './linux-expected-capture-paths.mjs';
import { projectCaptureStartupDiagnostic } from './expected-capture-diagnostic.mjs';

async function directory(name) {
  const s = await lstat(name);
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.geteuid() || (s.mode & 0o7777) !== 0o700
      || await realpath(name) !== name) throw new Error('unsafe_directory');
}
async function file(name, limit) {
  const h = await open(name, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const a = await h.stat(), b = await lstat(name);
    if (!a.isFile() || b.isSymbolicLink() || a.uid !== process.geteuid() || a.nlink !== 1
        || (a.mode & 0o7777) !== 0o600 || a.size > limit || await realpath(name) !== name
        || !['dev', 'ino', 'uid', 'mode', 'nlink'].every(k => a[k] === b[k])) throw new Error('unsafe_file');
    return await h.readFile();
  } finally { await h.close(); }
}
async function absent(name) {
  try { await lstat(name); return false; } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
}
function gone(pid, group = false) {
  if (!Number.isSafeInteger(pid) || pid < 2) return false;
  try { process.kill(group ? -pid : pid, 0); return false; }
  catch (error) { return error.code === 'ESRCH'; }
}
async function lockFree(name) {
  // Supply an already opened, checked inode: flock's filename form can create
  // a missing file, which a read-only validator must never do.
  const h = await open(name, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const a = await h.stat(), b = await lstat(name);
    if (!a.isFile() || b.isSymbolicLink() || a.uid !== process.geteuid() || a.nlink !== 1
        || (a.mode & 0o7777) !== 0o600 || await realpath(name) !== name
        || !['dev', 'ino', 'uid', 'mode', 'nlink'].every(k => a[k] === b[k])) throw new Error('unsafe_lock');
    const result = spawnSync('/usr/bin/flock', ['-n', '3'],
      { stdio: ['ignore', 'ignore', 'ignore', h.fd], timeout: 2000 });
    return !result.error && result.status === 0 && !result.signal;
  } finally { await h.close(); }
}

async function validate(p) {
  const result = JSON.parse(await file(p.result, 65536));
  await file(p.claim, 4096);
  if (result.version !== 1 || !['stopped', 'failed', 'interrupted'].includes(result.status)) throw new Error('invalid_result');
  const out = { valid: true, status: result.status, stage: result.stage, state: result.state,
    reason: result.reason, failure: result.failure, shutdown: result.shutdown, storeShutdown: result.storeShutdown, budget: result.budget,
    countsMayBeIncomplete: result.status === 'interrupted', confirmedSends: result.confirmedSends,
    jobPath: result.jobPath, preview: result.preview, images: [], checks: {} };
  // Older results have no field: never invent a finer reason retrospectively.
  if (Object.hasOwn(result, 'startupDiagnostic')) out.startupDiagnostic = result.startupDiagnostic === null ? null
    : projectCaptureStartupDiagnostic(result.startupDiagnostic);
  if (result.jobPath !== null) {
    const jobs = path.join(p.data, 'jobs');
    if (typeof result.jobPath !== 'string' || !/^[a-f0-9]{32}$/.test(path.basename(result.jobPath))
        || result.jobPath !== path.join(jobs, path.basename(result.jobPath))) throw new Error('invalid_job_path');
    for (const d of [jobs, result.jobPath, path.join(result.jobPath, 'originals'), path.join(result.jobPath, 'pending'), path.join(result.jobPath, 'rendered')]) await directory(d);
    const manifest = JSON.parse(await file(path.join(result.jobPath, 'manifest.json'), 2 * 1024 * 1024));
    if (manifest.job_id !== path.basename(result.jobPath) || !Array.isArray(manifest.images)
        || manifest.images.length > 2 || !Array.isArray(manifest.exports) || manifest.exports.length) throw new Error('invalid_manifest');
    const names = [];
    for (const image of manifest.images) {
      if (!Number.isSafeInteger(image.capture_id) || image.capture_id < 1 || image.path !== `originals/${String(image.capture_id).padStart(6, '0')}.png`
          || !/^[a-f0-9]{64}$/.test(image.sha256)) throw new Error('invalid_image_record');
      const bytes = await file(path.join(result.jobPath, image.path), 32 * 1024 * 1024);
      if (createHash('sha256').update(bytes).digest('hex') !== image.sha256 || bytes.length !== image.bytes
          || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
          || bytes.readUInt32BE(16) !== image.width || bytes.readUInt32BE(20) !== image.height) throw new Error('original_integrity_failed');
      names.push(path.basename(image.path));
      out.images.push({ width: image.width, height: image.height, sha256: image.sha256,
        blank: image.blank_candidate, duplicate: image.duplicate_candidate });
    }
    out.checks.originals = JSON.stringify((await readdir(path.join(result.jobPath, 'originals'))).sort()) === JSON.stringify(names.sort());
    out.checks.pendingEmpty = (await readdir(path.join(result.jobPath, 'pending'))).length === 0;
    out.checks.renderedEmpty = (await readdir(path.join(result.jobPath, 'rendered'))).length === 0;
    out.checks.exportsEmpty = true;
    out.checks.storeLocksFree = await lockFree(path.join(p.data, '.job.lock')) && await lockFree(path.join(result.jobPath, '.job.lock'));
    out.checkpoint = manifest.checkpoint ?? null;
    out.manifestState = manifest.state;
  }
  out.checks.ownerGone = gone(result.processes?.owner);
  out.checks.browserGone = gone(result.processes?.browser);
  out.checks.browserGroupGone = gone(result.processes?.browser, true);
  out.checks.browserLockAbsent = await absent(p.lock);
  const b = result.budget;
  const consistent = result.status === 'stopped' && result.shutdown === 'normal' && result.storeShutdown === 'normal' && result.state === 'Review'
    && ['end_candidate', 'capture_limit_reached'].includes(result.reason) && out.manifestState === 'review'
    && b?.phase === 'finished' && b.approved === 2 && Number.isSafeInteger(b.screenshots) && b.screenshots <= 2
    && Number.isSafeInteger(b.sends) && b.sends >= 0 && b.sends <= 1 && result.confirmedSends === b.sends
    && b.committed === out.images.length && b.committed >= 1 && b.screenshots >= b.committed
    && out.checkpoint?.dispatch === 'not_sent' && Object.values(out.checks).every(Boolean);
  out.success = Boolean(consistent);
  return out;
}

export const collectCorrectedCaptureResult = async () => validate(await fixedCorrectedCapturePaths());

if (process.argv[1] === fileURLToPath(import.meta.url)) {
if (process.platform !== 'linux' || process.argv.length !== 2) {
  console.error('invalid_invocation'); process.exitCode = 1;
} else {
  try { const result = await validate(await fixedCapturePaths()); console.log(JSON.stringify(result)); if (!result.success) process.exitCode = 1; }
  catch { console.error('result_validation_failed'); process.exitCode = 1; }
}
}
