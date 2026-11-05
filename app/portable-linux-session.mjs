// Portable login and a future Reader use this same relative session identity.
// The legacy, already-authenticated Linux login root is intentionally separate.
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { prepareLinuxLoginProfile } from './linux-login-core.mjs';
import { privateMetadata, samePath } from './private-path.mjs';
import { readSessionPreference, saveSessionPreference } from './session-preference.mjs';

const fail = code => Object.assign(new Error(code), { code });

// saved-* is only an opaque ID, not a profile-layout discriminator. The
// ordinary Application must not open/remove this owner's enclosing directory.
// Inspect entry metadata only; even a partial or linked owned entry is protected.
// Selection can expose a new root before owned exists, so retain that fence too.
export async function portableLinuxSessionProtected(directory) {
  if (process.platform !== 'linux') return false;
  for (const entry of [path.join(path.dirname(directory), 'portable-login-selection.lock'), path.join(directory, 'owned')]) {
    try { await lstat(entry); return true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return false;
}

// A selection lock fences *all* generic sessions, but it does not turn them
// all into Portable login candidates. This checks only the entry's existence.
export async function portableLinuxSessionCandidate(directory) {
  if (process.platform !== 'linux') return false;
  try { await lstat(path.join(directory, 'owned')); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

export async function ensurePortablePrivateDirectory(directory) {
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const info = await lstat(directory);
  if (info.isSymbolicLink() || !privateMetadata(info, true) || !samePath(await realpath(directory), directory)) {
    throw fail('unsafe_portable_session_directory');
  }
}

// Lock selection separately from browser ownership: after this returns all
// contenders resolve the same saved ID and runLinuxLogin takes the browser lock.
// A crash or ambiguous preparation retains the selection lock and any partial
// session. Neither an unmarked directory nor a copied owner marker is adopted.
export async function resolvePortableLinuxSession(dataDirectory) {
  await ensurePortablePrivateDirectory(dataDirectory);
  const lock = path.join(dataDirectory, 'portable-login-selection.lock');
  let handle;
  try { handle = await open(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw fail('login_in_use_or_unknown'); throw error; }
  let identity;
  try {
    await handle.writeFile(JSON.stringify({ version: 1, token: randomUUID() }) + '\n');
    await handle.sync(); identity = await handle.stat();
  } finally { await handle.close(); }

  let id = await readSessionPreference(dataDirectory);
  let state;
  if (id !== null) {
    if (!/^saved-[a-f0-9-]{36}$/.test(id)) throw fail('invalid_portable_login_session');
    state = await prepareLinuxLoginProfile(path.join(dataDirectory, id), { create: false });
  } else {
    id = `saved-${randomUUID()}`;
    const root = path.join(dataDirectory, id);
    await mkdir(root, { mode: 0o700 }); // exclusive: never adopt an existing root
    state = await prepareLinuxLoginProfile(root);
    await saveSessionPreference(dataDirectory, id);
  }
  const current = await lstat(lock);
  if (!privateMetadata(current) || ['dev', 'ino', 'uid', 'mode'].some(key => current[key] !== identity[key])) {
    throw fail('login_lock_changed');
  }
  await unlink(lock);
  return { id, root: state.root, profile: state.profile };
}

// Reader preparation is deliberately different from login's create-or-reuse
// operation: an explicit existing saved ID is required and nothing is created,
// selected as a preference, unlocked, or repaired. The browser owner must still
// take runLinuxLogin's exclusive lock when it actually starts; this metadata
// check is not a reservation and proves neither login nor permission to capture.
export async function resolveExistingPortableLinuxSession(dataDirectory, id) {
  if (process.platform !== 'linux' || typeof id !== 'string' || !/^saved-[a-f0-9-]{36}$/.test(id)) {
    throw fail('select_saved_session');
  }
  const selectionLock = path.join(dataDirectory, 'portable-login-selection.lock');
  const absent = async entry => {
    try { await lstat(entry); throw fail('login_in_use_or_unknown'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  };
  await absent(selectionLock);
  const state = await prepareLinuxLoginProfile(path.join(dataDirectory, id), { create: false });
  await absent(state.lock);
  // Only the lock entry is inspected, not Chromium's authentication data.
  await absent(path.join(state.profile, 'SingletonLock'));
  await absent(selectionLock);
  return { id, root: state.root, profile: state.profile };
}
