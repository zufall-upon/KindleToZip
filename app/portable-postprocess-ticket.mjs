// One fixed consent, separate from the unchanged finite capture claim.
// This module never starts a Reader. Its immutable stages cannot be reset or
// reassigned after a partial write, failed capture, or interrupted shutdown.
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { privateMetadata } from './private-path.mjs';
import { assertPortableLimitedClaimBinding } from './portable-limited-claim.mjs';
import { AppError } from './store-client.mjs';

// This separately authorized additional attempt does not reopen the consumed
// 931f5e50 ticket. The grant is fixed in source, never supplied by a caller.
const grant = 'mission-89045e6e-275b-4d3d-8ac0-6141b6c9f20f';
const name = 'portable-finite-archive-89045e6e.ticket';
const scope = 'finite-preview-1-displays-2-turn-1-nondestructive-local-archive';
const fail = () => { throw new AppError('portable_postprocess_unavailable'); };
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const identity = s => ({ dev: String(s.dev), ino: String(s.ino), uid: s.uid });
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const idValid = id => typeof id === 'string' && /^[a-f0-9]{32}$/.test(id);
const sessionValid = id => typeof id === 'string' && /^saved-[a-f0-9-]{36}$/.test(id);
const active = new Map(); // A restart can recover editing, never capture authority.
async function directory(file) {
  if (process.platform !== 'linux' || !path.isAbsolute(file) || path.resolve(file) !== file) fail();
  const s = await lstat(file);
  if (s.isSymbolicLink() || !privateMetadata(s, true) || await realpath(file) !== file) fail();
  return identity(s);
}
async function sync(file) {
  const h = await open(file, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await h.sync(); } finally { await h.close(); }
}
async function area(data) {
  const base = await directory(data), file = path.join(data, name), ticket = await directory(file);
  return { base, file, ticket };
}
async function unchanged(data, a) {
  if (!equal(a.base, await directory(data)) || !equal(a.ticket, await directory(a.file))) fail();
}
async function read(data, a, stage) {
  await unchanged(data, a);
  let h;
  try { h = await open(path.join(a.file, stage), constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (e) { if (e.code === 'ENOENT') return null; fail(); }
  try {
    const s = await h.stat();
    if (!privateMetadata(s) || s.size < 1 || s.size > 16384) fail();
    const value = JSON.parse(await h.readFile('utf8')), current = await lstat(path.join(a.file, stage));
    if (!equal(identity(s), identity(current)) || !privateMetadata(current) || current.isSymbolicLink()) fail();
    await unchanged(data, a);
    return value;
  } catch { fail(); } finally { await h.close(); }
}
async function write(data, a, stage, value) {
  await unchanged(data, a);
  let h;
  try { h = await open(path.join(a.file, stage), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch { fail(); }
  try {
    await h.writeFile(`${JSON.stringify(value)}\n`); await h.sync();
    const s = await h.stat(), current = await lstat(path.join(a.file, stage));
    if (!privateMetadata(s) || !privateMetadata(current) || !equal(identity(s), identity(current))) fail();
    await unchanged(data, a); await sync(a.file);
  } finally { await h.close(); }
}
async function reserved(data) {
  const a = await area(data), value = await read(data, a, 'reservation.json');
  if (!equal(value, { version: 1, grant, scope, data: a.base, ticket: a.ticket })) fail();
  return a;
}
async function bound(data, job) {
  const a = await reserved(data), id = job?.manifest?.job_id;
  if (!idValid(id) || job.job_path !== path.join(data, 'jobs', id)) fail();
  const value = await read(data, a, 'job.json');
  if (!equal(value, { job: id, directory: await directory(job.job_path) })) fail();
  return { ...a, job: value };
}
async function selected(data, job) {
  const a = await bound(data, job), value = await read(data, a, 'session.json');
  if (!sessionValid(value?.session)) fail();
  const root = path.join(data, value.session);
  const expected = { job: a.job, session: value.session, root: await directory(root),
    owned: await directory(path.join(root, 'owned')), profile: await directory(path.join(root, 'owned/profile')) };
  if (!equal(value, expected)) fail();
  return { ...a, session: value, key: digest(value) };
}
export async function reservePortableArchive(data) {
  const base = await directory(data), file = path.join(data, name);
  // The directory itself consumes the fixed permission, even if no stage file
  // can be completed. No error path removes it or tries a second job.
  try { await mkdir(file, { mode: 0o700 }); } catch { fail(); }
  const a = { base, file, ticket: await directory(file) };
  await sync(data);
  await write(data, a, 'reservation.json', { version: 1, grant, scope, data: base, ticket: a.ticket });
  active.set(data, { ticket: a.ticket, job: null });
}
export async function bindPortableArchiveJob(data, job) {
  const a = await reserved(data), id = job?.manifest?.job_id;
  if (!idValid(id) || job.job_path !== path.join(data, 'jobs', id) || job.manifest.state !== 'ready'
    || job.manifest.images.length || job.manifest.exports.length || job.issues.length || job.orphan_files.length) fail();
  await write(data, a, 'job.json', { job: id, directory: await directory(job.job_path) });
  const current = active.get(data);
  if (!current || !equal(current.ticket, a.ticket) || current.job !== null) fail();
  current.job = id;
}
export async function bindPortableArchiveSession(data, job, session) {
  const a = await bound(data, job);
  if (!sessionValid(session)) fail();
  const root = path.join(data, session), value = { job: a.job, session, root: await directory(root),
    owned: await directory(path.join(root, 'owned')), profile: await directory(path.join(root, 'owned/profile')) };
  const previous = await read(data, a, 'session.json');
  if (previous) { if (!equal(previous, value)) fail(); }
  else await write(data, a, 'session.json', value);
}
export async function assertPortableArchiveCapture(data, job, session) {
  const a = await selected(data, job);
  const current = active.get(data);
  if (!current || current.job !== job.manifest.job_id || !equal(current.ticket, a.ticket)
    || a.session.session !== session || await read(data, a, 'launch.json')
    || await read(data, a, 'capture.json') || await read(data, a, 'released.json')) fail();
}
export async function consumePortableArchiveCapture(data, job, session) {
  await assertPortableArchiveCapture(data, job, session);
  const a = await selected(data, job);
  await write(data, a, 'launch.json', { key: a.key, consumed: true });
  active.delete(data);
}
export async function portableArchiveAvailable(data, job, reservable = false) {
  try {
    try { await lstat(path.join(data, name)); }
    catch (e) { if (e.code === 'ENOENT') return reservable && !job; throw e; }
    if (!job) return false;
    const a = await bound(data, job);
    const current = active.get(data);
    return current?.job === job.manifest.job_id && equal(current.ticket, a.ticket)
      && !await read(data, a, 'launch.json') && !await read(data, a, 'capture.json') && !await read(data, a, 'released.json');
  } catch { return false; }
}
const originals = job => job.manifest.images.map(i => ({ capture_id: i.capture_id, path: i.path,
  sha256: i.sha256, bytes: i.bytes, width: i.width, height: i.height, image_format: i.image_format }));
async function claim(data, job, a) {
  if (!equal(await read(data, a, 'launch.json'), { key: a.key, consumed: true })) fail();
  await assertPortableLimitedClaimBinding(data, job.manifest.job_id, a.session.session);
}
export async function recordPortableArchiveCapture(data, job, budget, previewDigest) {
  const a = await selected(data, job); await claim(data, job, a);
  const images = originals(job), count = images.length;
  if (job.manifest.state !== 'review' || job.issues.length || job.orphan_files.length
    || ![1, 2].includes(count) || budget?.phase !== 'finished' || ![1, 2].includes(budget.approved)
    || count > budget.approved || budget.committed !== count || budget.screenshots !== count
    || budget.sends !== count - 1 || previewDigest !== images[0].sha256
    || images.some((i, index) => i.capture_id !== index + 1 || i.path !== `originals/${String(index + 1).padStart(6, '0')}.png`
      || i.image_format !== 'png' || !/^[a-f0-9]{64}$/.test(i.sha256))) fail();
  await write(data, a, 'capture.json', { key: a.key, budget, previewMatches: true, originals: images });
}
async function captured(data, job) {
  const a = await selected(data, job); await claim(data, job, a);
  const value = await read(data, a, 'capture.json');
  if (!value || value.key !== a.key || value.previewMatches !== true || !equal(value.originals, originals(job))
    || value.budget?.phase !== 'finished' || ![1, 2].includes(value.originals.length)
    || value.budget.committed !== value.originals.length || value.budget.screenshots !== value.originals.length
    || value.budget.sends !== value.originals.length - 1 || ![1, 2].includes(value.budget.approved)
    || value.originals.length > value.budget.approved || job.issues.length || job.orphan_files.length) fail();
  return { ...a, capture: value };
}
export async function releasePortableArchive(data, job) {
  const a = await captured(data, job);
  // Normal owner close has already joined the processes. Independently require
  // its documented ownership lock to be absent; never read auth/profile files.
  try { await lstat(path.join(data, a.session.session, 'owned/in-use.lock')); fail(); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  await write(data, a, 'released.json', { key: a.key, capture: digest(a.capture), closed: true });
}
export async function portableArchiveEditable(data, job) {
  try {
    const a = await captured(data, job), value = await read(data, a, 'released.json');
    try { await lstat(path.join(data, a.session.session, 'owned/in-use.lock')); return false; }
    catch (e) { if (e.code !== 'ENOENT') return false; }
    return equal(value, { key: a.key, capture: digest(a.capture), closed: true });
  } catch { return false; }
}
