// Explicit migration/rollback transaction. Public callers supply fixed paths;
// injectable paths and fault boundaries below are internal anonymous-test seams.
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { prepareLinuxLoginProfile } from './linux-login-core.mjs';
import { privateMetadata } from './private-path.mjs';
import { readSessionPreferences } from './session-preference.mjs';
import { copyVerifiedLinuxProfile, fingerprintLinuxProfile } from './linux-profile-copy.mjs';

const fail = code => Object.assign(new Error(code), { code });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const stamp = info => [info.dev, info.ino, info.uid, info.gid, info.mode].map(String);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const ledgerPath = data => path.join(data, 'portable-login-migration.json');
const selectionPath = data => path.join(data, 'portable-login-selection.lock');
const prefPath = data => path.join(data, 'kindle-session.json');

async function absent(file) {
  try { await lstat(file); throw fail('migration_destination_exists'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
async function directory(file) {
  const info = await lstat(file);
  if (!privateMetadata(info, true) || await realpath(file) !== file) throw fail('unsafe_migration_directory');
  return stamp(info);
}
async function readRegular(file, { optional = false, shortcut = false } = {}) {
  let handle;
  try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.geteuid() || info.size > 1024 * 1024
        || (shortcut ? Boolean(info.mode & 0o002) : !privateMetadata(info)) || await realpath(file) !== file) throw fail('unsafe_migration_file');
    const bytes = await handle.readFile();
    const end = await handle.stat();
    if (!eq(stamp(info), stamp(end)) || info.size !== end.size || info.mtimeMs !== end.mtimeMs || info.ctimeMs !== end.ctimeMs) throw fail('migration_file_changed');
    if (!eq(stamp(info), stamp(await lstat(file)))) throw fail('migration_file_changed');
    return { bytes, sha256: sha(bytes), identity: stamp(info), mode: info.mode & 0o777 };
  } finally { await handle.close(); }
}
async function syncDirectory(file) {
  const handle = await open(file, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function publish(file, bytes, mode = 0o600) {
  const staged = `${file}.migration-${randomUUID()}`;
  const handle = await open(staged, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try { await handle.chmod(mode); await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await rename(staged, file); await syncDirectory(path.dirname(file));
}
async function createPrivate(file, bytes) {
  const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.chmod(0o600); await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
  await syncDirectory(path.dirname(file));
}
async function exclusive(file, id) {
  await createPrivate(file, JSON.stringify({ version: 1, migration: id }));
  return stamp(await lstat(file));
}
async function ourLock(file, id, expected) {
  const value = await readRegular(file);
  if (!expected || !eq(value.identity, expected) || value.bytes.toString() !== JSON.stringify({ version: 1, migration: id })) throw fail('migration_lock_changed');
  return value;
}
async function release(file, id, expected) { await ourLock(file, id, expected); await unlink(file); await syncDirectory(path.dirname(file)); }
async function fingerprint(directory, capacityDirectory) {
  const value = await fingerprintLinuxProfile(directory, { capacityDirectory });
  return { digest: value.digest, inventorySha256: sha(Buffer.from(JSON.stringify(value.inventory))) };
}
async function sourceStamp(root) {
  const state = await prepareLinuxLoginProfile(root, { create: false });
  for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    try { await lstat(path.join(state.profile, name)); throw fail('migration_browser_in_use_or_unknown'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return { root: stamp(state.rootInfo), owned: stamp(state.ownedInfo), profile: stamp(state.profileInfo),
    marker: sha(await readFile(state.marker)) };
}
async function saveLedger(data, ledger) { await publish(ledgerPath(data), Buffer.from(JSON.stringify(ledger))); }
async function checkedPaths({ sourceRoot, dataDirectory, shortcut, launcher }) {
  for (const value of [sourceRoot, dataDirectory, shortcut, launcher]) {
    if (typeof value !== 'string' || !path.isAbsolute(value) || path.resolve(value) !== value || /[\r\n\0]/.test(value)) throw fail('invalid_migration_path');
  }
  await directory(dataDirectory);
  if (sourceRoot === dataDirectory || sourceRoot.startsWith(`${dataDirectory}/`) || dataDirectory.startsWith(`${sourceRoot}/`)) throw fail('overlapping_migration');
  const launch = await readRegular(launcher, { shortcut: true });
  if (!(launch.mode & 0o111)) throw fail('migration_launcher_not_executable');
}
function newShortcut(bytes, launcher) {
  const text = bytes.toString('utf8');
  if (text.split(/\r?\n/).filter(line => line.startsWith('Exec=')).length !== 1
      || text.split(/\r?\n/).filter(line => line.startsWith('Path=')).length !== 1
      || !text.includes('[Desktop Entry]') || /^\[Desktop Action /m.test(text)) throw fail('unsupported_login_shortcut');
  const escaped = launcher.replaceAll('%', '%%').replace(/[\\"`$]/g, '\\$&');
  return Buffer.from(text.replace(/^Exec=.*$/m, `Exec="${escaped}" --login`).replace(/^Path=.*$/m, `Path=${path.dirname(launcher)}`));
}

export async function migrateLinuxLogin(options, { checkpoint = async () => {} } = {}) {
  await checkedPaths(options);
  const { sourceRoot, dataDirectory: data, shortcut, launcher } = options;
  await absent(ledgerPath(data));
  const source = await sourceStamp(sourceRoot);
  const oldShortcut = await readRegular(shortcut, { shortcut: true });
  const oldPreference = await readRegular(prefPath(data), { optional: true });
  const preferences = await readSessionPreferences(data);
  if (preferences.session !== null) throw fail('migration_target_has_preferred_session');
  const id = randomUUID(), session = `saved-${randomUUID()}`;
  const stage = path.join(data, `migration-staging-${id}`), destination = path.join(data, session);
  await absent(stage); await absent(destination);
  const updatedShortcut = newShortcut(oldShortcut.bytes, launcher);
  const updatedPreference = Buffer.from(JSON.stringify({ version: 2, session, savedTemporarySessions: preferences.savedTemporarySessions }));
  const ledger = { version: 1, id, session, sourceRoot, data, shortcut, launcher, source, dataIdentity: await directory(data),
    stage, destination, phase: 'prepared', oldShortcut: oldShortcut.bytes.toString('base64'), shortcutMode: oldShortcut.mode,
    oldPreference: oldPreference?.bytes.toString('base64') ?? null, oldPreferenceSha: oldPreference?.sha256 ?? null,
    newShortcut: updatedShortcut.toString('base64'), newPreference: updatedPreference.toString('base64') };
  // The journal is exclusively created before any lock or publication; a crash
  // leaves a recoverable named transaction, never an automatically adopted copy.
  const journal = await open(ledgerPath(data), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await journal.writeFile(JSON.stringify(ledger)); await journal.sync(); } finally { await journal.close(); }
  await syncDirectory(data);
  const sourceLock = path.join(sourceRoot, 'owned/in-use.lock');
  let sourceClaimed = false, selectionClaimed = false;
  try {
    ledger.selectionIdentity = await exclusive(selectionPath(data), id); selectionClaimed = true;
    await saveLedger(data, ledger);
    ledger.sourceLockIdentity = await exclusive(sourceLock, id); sourceClaimed = true;
    ledger.phase = 'locked'; await saveLedger(data, ledger);
    const assertOwnedAndLocked = async () => {
      if (!eq(await directory(data), ledger.dataIdentity) || !eq(await sourceStamp(sourceRoot), source)) throw fail('migration_identity_changed');
      await ourLock(selectionPath(data), id, ledger.selectionIdentity); await ourLock(sourceLock, id, ledger.sourceLockIdentity);
    };
    await assertOwnedAndLocked();
    ledger.sourceFingerprint = await fingerprint(path.join(sourceRoot, 'owned/profile'), data);
    await saveLedger(data, ledger);
    await mkdir(stage, { mode: 0o700 });
    const copied = await copyVerifiedLinuxProfile({ source: path.join(sourceRoot, 'owned/profile'),
      staging: path.join(stage, 'transfer'), assertOwnedAndLocked,
      afterCopy: context => checkpoint('copy', context) });
    await mkdir(path.join(stage, 'owned'), { mode: 0o700 });
    await rename(copied.destination, path.join(stage, 'owned/profile'));
    ledger.stageIdentity = await directory(stage);
    ledger.phase = 'copy-verified'; await saveLedger(data, ledger);
    await checkpoint('before-publish'); await assertOwnedAndLocked();
    await unchangedSource(ledger);
    if ((await fingerprint(path.join(stage, 'owned/profile'))).digest !== ledger.sourceFingerprint.digest) throw fail('profile_copy_mismatch');
    // mkdir is exclusive; unlike rename, it cannot replace an unexpectedly
    // created empty directory. Only our verified owned subtree is transferred.
    await mkdir(destination, { mode: 0o700 });
    ledger.destinationIdentity = await directory(destination);
    ledger.phase = 'destination-created'; await saveLedger(data, ledger);
    await checkpoint('destination-created');
    await absent(path.join(destination, 'owned'));
    await rename(path.join(stage, 'owned'), path.join(destination, 'owned'));
    if ((await fingerprint(path.join(destination, 'owned/profile'))).digest !== ledger.sourceFingerprint.digest) throw fail('profile_copy_mismatch');
    await checkpoint('before-owner-marker');
    const identity = async directory => { const info = await lstat(directory); return [String(info.dev), String(info.ino)]; };
    // A fresh marker is minted only by this verified, locked transaction. The
    // old marker is never copied, edited or accepted as rebinding authority.
    // Unlike publication updates, creation must not replace any unknown entry.
    await createPrivate(path.join(destination, 'owned/owner.json'), Buffer.from(JSON.stringify({ application: 'KindleToZip Linux login', version: 1,
      id: randomUUID(), root: await identity(destination), owned: await identity(path.join(destination, 'owned')),
      profile: await identity(path.join(destination, 'owned/profile')) })));
    await prepareLinuxLoginProfile(destination, { create: false }); await syncDirectory(data);
    ledger.phase = 'profile-published'; await saveLedger(data, ledger);
    await checkpoint('registration'); await assertOwnedAndLocked(); await unchangedSource(ledger);
    const currentPref = await readRegular(prefPath(data), { optional: true });
    if ((currentPref?.sha256 ?? null) !== ledger.oldPreferenceSha) throw fail('migration_preferences_changed');
    await publish(prefPath(data), updatedPreference);
    ledger.phase = 'registered'; await saveLedger(data, ledger);
    await checkpoint('shortcut'); await assertOwnedAndLocked(); await unchangedSource(ledger);
    const currentShortcut = await readRegular(shortcut, { shortcut: true });
    if (currentShortcut.sha256 !== oldShortcut.sha256 || !eq(currentShortcut.identity, oldShortcut.identity)) throw fail('migration_shortcut_changed');
    // The durable private journal is the byte-exact shortcut/preference backup.
    await publish(shortcut, updatedShortcut, oldShortcut.mode);
    await assertOwnedAndLocked(); await unchangedSource(ledger);
    ledger.phase = 'pending-confirmation'; await saveLedger(data, ledger);
    await release(selectionPath(data), id, ledger.selectionIdentity);
    return { session, phase: ledger.phase, copiedEntries: copied.entries, copiedBytes: copied.bytes };
  } catch (error) {
    // Preserve exact phase, staged data and our locks. Never erase a competing
    // owner's lock; explicit rollback validates each resource before restoring.
    ledger.failure = /^[a-z0-9_]+$/.test(error.code ?? '') ? error.code : 'migration_interrupted';
    ledger.sourceClaimed = sourceClaimed; ledger.selectionClaimed = selectionClaimed;
    await saveLedger(data, ledger).catch(() => {});
    throw error;
  }
}

async function loadTransaction(options) {
  await checkedPaths(options);
  const raw = await readRegular(ledgerPath(options.dataDirectory));
  const ledger = JSON.parse(raw.bytes.toString());
  if (ledger.version !== 1 || !/^[a-f0-9-]{36}$/.test(ledger.id) || !/^saved-[a-f0-9-]{36}$/.test(ledger.session)
      || ledger.sourceRoot !== options.sourceRoot || ledger.data !== options.dataDirectory || ledger.shortcut !== options.shortcut
      || ledger.launcher !== options.launcher || ledger.destination !== path.join(ledger.data, ledger.session)
      || ledger.stage !== path.join(ledger.data, `migration-staging-${ledger.id}`)
      || !eq(await directory(ledger.data), ledger.dataIdentity) || !eq(await sourceStamp(ledger.sourceRoot), ledger.source)) throw fail('migration_journal_changed');
  return ledger;
}
async function unchangedSource(ledger) {
  if (ledger.sourceFingerprint && !eq(await fingerprint(path.join(ledger.sourceRoot, 'owned/profile')), ledger.sourceFingerprint)) throw fail('migration_source_changed');
}
async function destinationIdle(ledger) {
  try { await lstat(ledger.destination); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  // A collision before our exclusive mkdir is not our profile. Rollback may
  // restore the still-unpublished old entry, but never inspect/adopt/delete it.
  if (!ledger.destinationIdentity && ['prepared', 'locked', 'copy-verified'].includes(ledger.phase)) return false;
  const actual = await directory(ledger.destination);
  if (!ledger.destinationIdentity || !eq(actual, ledger.destinationIdentity)) throw fail('migration_destination_changed');
  if (ledger.phase === 'destination-created' || ledger.destinationIncomplete === true) {
    // Recovery of our journalled, incomplete destination must not turn it into
    // a generic saved session. Keep an owned metadata fence, never initialize
    // or adopt a browser profile and never mint a marker on rollback.
    const owned = path.join(ledger.destination, 'owned');
    if (!ledger.destinationIncomplete) { ledger.destinationIncomplete = true; await saveLedger(ledger.data, ledger); }
    try { await lstat(owned); }
    catch (error) { if (error.code !== 'ENOENT') throw error; await mkdir(owned, { mode: 0o700 }); }
    await directory(owned);
    for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
      try { await lstat(path.join(owned, 'profile', name)); throw fail('migration_browser_in_use_or_unknown'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const lock = path.join(owned, 'in-use.lock');
    try { await lstat(lock); await ourLock(lock, ledger.id, ledger.targetLockIdentity); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return true;
  }
  await sourceStamp(ledger.destination); // rejects active Chromium singletons
  const lock = path.join(ledger.destination, 'owned/in-use.lock');
  try { await lstat(lock); await ourLock(lock, ledger.id, ledger.targetLockIdentity); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return true;
}
async function takeSelection(ledger) {
  try {
    ledger.selectionIdentity = await exclusive(selectionPath(ledger.data), ledger.id);
    await saveLedger(ledger.data, ledger);
  } catch (error) { if (error.code !== 'EEXIST') throw error; await ourLock(selectionPath(ledger.data), ledger.id, ledger.selectionIdentity); }
}
async function takeTarget(ledger) {
  const file = path.join(ledger.destination, 'owned/in-use.lock');
  try {
    ledger.targetLockIdentity = await exclusive(file, ledger.id); await saveLedger(ledger.data, ledger);
  } catch (error) { if (error.code !== 'EEXIST') throw error; await ourLock(file, ledger.id, ledger.targetLockIdentity); }
  return file;
}

export async function confirmLinuxLoginMigration(options, { verifyTarget } = {}) {
  const ledger = await loadTransaction(options);
  if (ledger.phase !== 'pending-confirmation' || ledger.failure || typeof verifyTarget !== 'function') throw fail('migration_not_pending');
  await ourLock(path.join(ledger.sourceRoot, 'owned/in-use.lock'), ledger.id, ledger.sourceLockIdentity);
  // The fixed public caller supplies a normal, bounded browser start/close.
  // Unknown verification never releases the original or changes the journal.
  if (!await destinationIdle(ledger)) throw fail('migration_destination_missing');
  await verifyTarget(ledger.destination);
  await takeSelection(ledger);
  if (!await destinationIdle(ledger)) throw fail('migration_destination_missing');
  const targetLock = await takeTarget(ledger);
  await unchangedSource(ledger);
  if ((await readRegular(prefPath(ledger.data))).bytes.toString('base64') !== ledger.newPreference
      || (await readRegular(ledger.shortcut, { shortcut: true })).bytes.toString('base64') !== ledger.newShortcut) throw fail('migration_publication_changed');
  ledger.phase = 'confirmed'; await saveLedger(ledger.data, ledger);
  await release(path.join(ledger.sourceRoot, 'owned/in-use.lock'), ledger.id, ledger.sourceLockIdentity);
  await release(targetLock, ledger.id, ledger.targetLockIdentity);
  await release(selectionPath(ledger.data), ledger.id, ledger.selectionIdentity);
  return { session: ledger.session, phase: ledger.phase };
}

export async function rollbackLinuxLoginMigration(options) {
  const ledger = await loadTransaction(options);
  const sourceLock = path.join(ledger.sourceRoot, 'owned/in-use.lock');
  try { await ourLock(sourceLock, ledger.id, ledger.sourceLockIdentity); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    ledger.sourceLockIdentity = await exclusive(sourceLock, ledger.id); await saveLedger(ledger.data, ledger);
  }
  await takeSelection(ledger);
  await unchangedSource(ledger);
  const hasDestination = await destinationIdle(ledger);
  const targetLock = hasDestination ? await takeTarget(ledger) : null;
  const currentPref = await readRegular(prefPath(ledger.data), { optional: true });
  const currentShortcut = await readRegular(ledger.shortcut, { shortcut: true });
  if (![ledger.oldPreference, ledger.newPreference].includes(currentPref?.bytes.toString('base64') ?? null)
      || ![ledger.oldShortcut, ledger.newShortcut].includes(currentShortcut.bytes.toString('base64'))) throw fail('migration_publication_changed');
  await publish(ledger.shortcut, Buffer.from(ledger.oldShortcut, 'base64'), ledger.shortcutMode);
  if (ledger.oldPreference !== null) await publish(prefPath(ledger.data), Buffer.from(ledger.oldPreference, 'base64'));
  else if (currentPref) { await unlink(prefPath(ledger.data)); await syncDirectory(ledger.data); }
  ledger.phase = 'rolled-back'; await saveLedger(ledger.data, ledger);
  if (targetLock) await release(targetLock, ledger.id, ledger.targetLockIdentity);
  await release(sourceLock, ledger.id, ledger.sourceLockIdentity); await release(selectionPath(ledger.data), ledger.id, ledger.selectionIdentity);
  // The copied profile and failed staging remain private and guarded; recovery
  // never recursively deletes a profile, receipt, or unknown resource.
  return { phase: ledger.phase, originalRetained: true, copyRetained: true };
}
