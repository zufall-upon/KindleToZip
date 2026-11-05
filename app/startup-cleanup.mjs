import { lstat, realpath, rm } from 'node:fs/promises';
import path from 'node:path';

// Only a newly created Linux runtime directory is eligible for removal.
// Keep exact inode values: Number-valued stat fields can lose precision.
async function identity(directory) {
  const actual = await realpath(directory);
  const info = await lstat(directory, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== BigInt(process.geteuid())
    || (info.mode & 0o7777n) !== 0o700n) throw new Error('owned_temp_identity_invalid');
  return { actual, dev: info.dev, ino: info.ino, uid: info.uid, gid: info.gid, mode: info.mode };
}

export async function captureOwnedTemp(directory) {
  return { directory, ...await identity(directory) };
}

export async function removeOwnedTemp(owned, dataDirectory) {
  // A store reached through an alias must not be swept up with browser temp.
  if (dataDirectory !== undefined) {
    if (typeof dataDirectory !== 'string') throw new Error('store_identity_unknown');
    const store = await realpath(dataDirectory);
    const relative = path.relative(owned.actual, store);
    if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
      throw new Error('store_inside_owned_temp');
    }
  }
  const current = await identity(owned.directory);
  for (const key of ['actual', 'dev', 'ino', 'uid', 'gid', 'mode']) {
    if (current[key] !== owned[key]) throw new Error('owned_temp_identity_changed');
  }
  await rm(owned.directory, { recursive: true });
}
