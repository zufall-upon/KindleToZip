// Internal building block only: there is deliberately no CLI or publication
// operation here. The caller must hold and recheck the existing login-owner
// lock throughout. A failed copy remains in its uniquely named staging area.
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, statfs } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { privateMetadata, samePath } from './private-path.mjs';

const fail = code => Object.assign(new Error(code), { code });
const decoder = new TextDecoder('utf-8', { fatal: true });
const environment = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' };
const metadata = info => [info.dev, info.ino, info.uid, info.gid, info.mode, info.nlink,
  info.size, info.mtimeNs, info.ctimeNs].map(String);

async function inventory(root) {
  const result = [];
  let device;
  async function visit(file, relative) {
    const info = await lstat(file, { bigint: true });
    if (device === undefined) device = info.dev;
    if (info.dev !== device || info.uid !== BigInt(process.geteuid()) || info.isSymbolicLink()
        || !(info.isDirectory() || info.isFile()) || (info.isFile() && info.nlink !== 1n)) {
      throw fail('unsafe_profile_entry');
    }
    if (result.length >= 1_000_000) throw fail('profile_too_many_entries');
    result.push({ relative, directory: info.isDirectory(), metadata: metadata(info) });
    if (info.isDirectory()) {
      const names = await readdir(file, { encoding: 'buffer' });
      const decoded = names.map(name => {
        let value;
        try { value = decoder.decode(name); } catch { throw fail('unsafe_profile_filename'); }
        if (!Buffer.from(value).equals(name)) throw fail('unsafe_profile_filename');
        return value;
      }).sort();
      for (const name of decoded) await visit(path.join(file, name), relative ? `${relative}/${name}` : name);
    }
  }
  await visit(root, '');
  if (!result[0].directory) throw fail('unsafe_profile_entry');
  return result;
}

// GNU tar provides a deterministic byte stream containing every file byte,
// type, mode, numeric owner/group, nanosecond mtime, ACL and xattrs. atime is
// changed by reading and ctime cannot be restored on a copy; the source's
// ctime and identity are instead checked independently by inventory(). The
// archive and its digest never leave this process or appear in diagnostics.
async function archiveDigest(directory) {
  const child = spawn('/usr/bin/tar', ['--sort=name', '--format=posix',
    '--pax-option=delete=atime,delete=ctime', '--numeric-owner', '--xattrs',
    '--xattrs-include=*', '--acls', '-C', directory, '-cf', '-', '.'],
  { env: environment, stdio: ['ignore', 'pipe', 'ignore'] });
  const hash = createHash('sha256');
  let streamError = false;
  child.stdout.on('data', chunk => hash.update(chunk));
  child.stdout.on('error', () => { streamError = true; });
  const outcome = await new Promise(resolve => {
    child.once('error', () => resolve(false));
    child.once('close', (code, signal) => resolve(code === 0 && signal === null));
  });
  if (!outcome || streamError) throw fail('profile_archive_failed');
  return hash.digest('hex');
}

// Private verification oracle for the migration transaction. Its values never
// appear in normal login diagnostics and no profile format is interpreted.
export async function fingerprintLinuxProfile(directory, { capacityDirectory } = {}) {
  const before = await inventory(directory);
  if (capacityDirectory) {
    const bytes = before.reduce((total, entry) => total + (entry.directory ? 0n : BigInt(entry.metadata[6])), 0n);
    const space = await statfs(capacityDirectory, { bigint: true });
    if (space.bavail * space.bsize < bytes + bytes / 10n + 64n * 1024n * 1024n) throw fail('profile_insufficient_space');
  }
  const digest = await archiveDigest(directory);
  if (!unchanged(before, await inventory(directory))) throw fail('profile_source_changed');
  return { inventory: before, digest };
}

async function copyTree(source, destination) {
  // Explicit xattr preservation makes GNU cp report failures instead of the
  // silent best-effort xattr behavior of -a. Never preserve hardlinks or use
  // reflinks; links and special files are rejected by both inventories.
  const child = spawn('/usr/bin/cp', ['-R', '-P', '--preserve=mode,timestamps,xattr',
    '--reflink=never', '--', source, destination],
  { env: environment, stdio: 'ignore' });
  const outcome = await new Promise(resolve => {
    child.once('error', () => resolve(false));
    child.once('close', (code, signal) => resolve(code === 0 && signal === null));
  });
  if (!outcome) throw fail('profile_copy_failed');
}

async function syncTree(root, entries) {
  // Sync files before their containing directories. Opening with NOFOLLOW also
  // avoids syncing a substituted leaf. Any error retains the staging area.
  for (const entry of [...entries].reverse()) {
    const file = entry.relative ? path.join(root, entry.relative) : root;
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW
      | (entry.directory ? constants.O_DIRECTORY : 0));
    try { await handle.sync(); } finally { await handle.close(); }
  }
}

function unchanged(before, after) {
  return JSON.stringify(before) === JSON.stringify(after);
}

// This primitive does not establish ownership, claim a lock, change a marker,
// register a session or switch a shortcut. Until a transaction supplies those
// steps, it must not be used with a person's existing profile.
export async function copyVerifiedLinuxProfile({ source, staging, assertOwnedAndLocked, afterCopy = async () => {} }) {
  if (process.platform !== 'linux' || typeof assertOwnedAndLocked !== 'function') throw fail('invalid_profile_copy');
  if (!path.isAbsolute(source) || !path.isAbsolute(staging) || !samePath(await realpath(source), source)) throw fail('unsafe_profile_path');
  const parent = path.dirname(staging);
  const parentInfo = await lstat(parent);
  if (!privateMetadata(parentInfo, true) || !samePath(await realpath(parent), parent)) throw fail('unsafe_profile_staging_parent');
  const relative = path.relative(source, staging);
  const reverse = path.relative(staging, source);
  if (!relative || !reverse || !relative.startsWith('..' + path.sep) || !reverse.startsWith('..' + path.sep)) {
    throw fail('overlapping_profile_copy');
  }
  await assertOwnedAndLocked();
  const before = await inventory(source);
  const sourceSize = before.reduce((total, entry) => total + (entry.directory ? 0n : BigInt(entry.metadata[6])), 0n);
  if (sourceSize > BigInt(Number.MAX_SAFE_INTEGER)) throw fail('profile_too_large');
  const space = await statfs(parent, { bigint: true });
  // Reserve metadata/transaction headroom in addition to the logical bytes.
  if (space.bavail * space.bsize < sourceSize + sourceSize / 10n + 64n * 1024n * 1024n) throw fail('profile_insufficient_space');
  const sourceDigest = await archiveDigest(source);
  if (!unchanged(before, await inventory(source))) throw fail('profile_source_changed');
  await assertOwnedAndLocked();
  await mkdir(staging, { mode: 0o700 }); // exclusive: never adopt unknown staging
  const destination = path.join(staging, 'profile');
  await copyTree(source, destination);
  await afterCopy({ source, destination }); // internal anonymous fault injection only
  const copied = await inventory(destination);
  const originalInodes = new Set(before.map(entry => `${entry.metadata[0]}:${entry.metadata[1]}`));
  if (copied.some(entry => originalInodes.has(`${entry.metadata[0]}:${entry.metadata[1]}`))) throw fail('profile_shared_inode');
  await syncTree(destination, copied);
  const copyDigest = await archiveDigest(destination);
  if (!unchanged(copied, await inventory(destination))) throw fail('profile_copy_changed');
  await assertOwnedAndLocked();
  const finalDigest = await archiveDigest(source);
  if (!unchanged(before, await inventory(source)) || sourceDigest !== finalDigest) throw fail('profile_source_changed');
  if (sourceDigest !== copyDigest) throw fail('profile_copy_mismatch');
  await assertOwnedAndLocked();
  const directory = await open(staging, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await directory.sync(); } finally { await directory.close(); }
  return { destination, entries: copied.length, bytes: Number(sourceSize) };
}
