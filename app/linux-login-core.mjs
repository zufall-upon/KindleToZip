// Internal implementation of the Linux login-only entry. The entry point supplies
// fixed values; the injectable operations here are for anonymous regression tests.
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, readlink, realpath, unlink } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { privateMetadata, samePath } from './private-path.mjs';

const execFileAsync = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const fail = code => Object.assign(new Error(code), { code });
const launcherDigest = 'fd5dec09e3f53f1bf0c5cd52eafc39de8bff954bd2b4aeae1850faa0cc97e166';
const snapDigest = '86da2ec3750c34a1e9e5068c3cc119f8bbe86d009fe27f381c0ff1bf063fb19f';

// The existing authenticated shortcut and its legacy Reader owners remain on
// this identity. Portable login uses a distinct relative saved session instead.
export const linuxLoginRoot = home => path.join(home, 'snap/chromium/common/kindle-to-zip-login');

async function checkedDirectory(directory, privateDir = true) {
  const info = await lstat(directory, { bigint: false });
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.geteuid()
      || (privateDir && !privateMetadata(info, true)) || !samePath(await realpath(directory), directory)) {
    throw fail('unsafe_login_directory');
  }
  return info;
}

function sameIdentity(a, b) {
  return ['dev', 'ino', 'uid', 'mode'].every(key => a[key] === b[key]);
}

async function readMarker(filename) {
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!privateMetadata(info) || info.size > 1024) throw fail('unsafe_login_marker');
    const value = JSON.parse(await handle.readFile('utf8'));
    if (value?.application !== 'KindleToZip Linux login' || value?.version !== 1
        || !/^[0-9a-f-]{36}$/.test(value?.id ?? '')) throw fail('unsafe_login_marker');
    return { info, value };
  } finally { await handle.close(); }
}

async function createPrivateFile(filename, data) {
  const handle = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(data); await handle.sync(); return await handle.stat(); }
  finally { await handle.close(); }
}

// Also used by local setup to create the empty owned profile without launching
// Chromium or contacting the service.
export async function prepareLinuxLoginProfile(root, { create = true } = {}) {
  // Never adopt an existing unmarked profile, repair permissions, or remove a
  // partially created directory. A crash during creation remains fail-closed.
  await checkedDirectory(path.dirname(root), false);
  if (create) {
    try { await mkdir(root, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const rootInfo = await checkedDirectory(root);
  const owned = path.join(root, 'owned');
  let created = false;
  if (create) {
    try { await mkdir(owned, { mode: 0o700 }); created = true; } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const ownedInfo = await checkedDirectory(owned);
  const marker = path.join(owned, 'owner.json');
  const profile = path.join(owned, 'profile');
  if (created) {
    await mkdir(profile, { mode: 0o700 });
    const info = await checkedDirectory(profile);
    const identity = entry => [String(entry.dev), String(entry.ino)];
    await createPrivateFile(marker, JSON.stringify({ application: 'KindleToZip Linux login', version: 1, id: randomUUID(),
      root: identity(rootInfo), owned: identity(ownedInfo), profile: identity(info) }) + '\n');
  }
  const markerInfo = await readMarker(marker);
  const profileInfo = await checkedDirectory(profile);
  for (const [name, info] of [['root', rootInfo], ['owned', ownedInfo], ['profile', profileInfo]]) {
    const identity = markerInfo.value[name];
    if (!Array.isArray(identity) || identity.length !== 2 || identity[0] !== String(info.dev) || identity[1] !== String(info.ino)) {
      throw fail('unsafe_login_marker');
    }
  }
  return { root, rootInfo, owned, ownedInfo, marker, markerInfo, profile, profileInfo, lock: path.join(owned, 'in-use.lock') };
}

async function checkIdentity(state) {
  if (!sameIdentity(state.rootInfo, await checkedDirectory(state.root))
      || !sameIdentity(state.ownedInfo, await checkedDirectory(state.owned))
      || !sameIdentity(state.profileInfo, await checkedDirectory(state.profile))) throw fail('login_identity_changed');
  const marker = await readMarker(state.marker);
  if (!sameIdentity(state.markerInfo.info, marker.info)
      || JSON.stringify(marker.value) !== JSON.stringify(state.markerInfo.value)) throw fail('login_identity_changed');
}

async function removeOurLock(state, identity, beforeRelease) {
  await checkIdentity(state);
  const current = await lstat(state.lock);
  if (!privateMetadata(current) || !sameIdentity(identity, current)) throw fail('login_lock_changed');
  await beforeRelease();
  // A supervisor may have waited for an explicit release acknowledgement.
  // Recheck identity after that wait rather than unlinking a replacement.
  await checkIdentity(state);
  const final = await lstat(state.lock);
  if (!privateMetadata(final) || !sameIdentity(identity, final)) throw fail('login_lock_changed');
  await unlink(state.lock);
}

export async function snapLoginPreflight(home, env = process.env) {
  // The Snap wrapper migrates an older Snap-owned profile if this directory is
  // absent. Inspect only the directory metadata, never its contents.
  await checkedDirectory(path.join(home, 'snap/chromium/common/chromium'), false);
  // A disconnected personal-files plug denies ordinary hidden files, but an
  // init symlink can resolve to a location granted by the home plug. Inspect
  // only its directory entry, never its contents; reject every existing type.
  try {
    await lstat(path.join(home, '.chromium-browser.init'));
    throw fail('snap_personal_init_exists');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  // Reject unsafe personal paths before inspecting the Snap installation. This
  // metadata-only guard is also testable on Linux without an installed Snap.
  // This wrapper was examined with the two personal-files paths disconnected.
  // Fail closed after a Snap change until that examination can be repeated.
  for (const [file, expected] of [
    ['/snap/chromium/current/bin/chromium.launcher', launcherDigest],
    ['/snap/chromium/current/meta/snap.yaml', snapDigest],
  ]) {
    const actual = createHash('sha256').update(await readFile(file)).digest('hex');
    if (actual !== expected) throw fail('snap_changed');
  }
  const command = 'snapctl is-connected password-manager-service && ! snapctl is-connected chromium-config && snapctl is-connected browser-sandbox && v=$(snapctl get daemon) && { [ -z "$v" ] || [ "$v" = false ]; }';
  await execFileAsync('/usr/bin/snap', ['run', '--shell', 'chromium', '-c', command], { env, timeout: 15000, maxBuffer: 4096 });
}

async function verifyStarted(child, profile, closed, requiredArgs = []) {
  const executable = await realpath('/snap/chromium/current/usr/lib/chromium-browser/chrome');
  for (let i = 0; i < 200; i++) {
    if (closed.done) return false;
    try {
      const exe = await readlink(`/proc/${child.pid}/exe`);
      let args = (await readFile(`/proc/${child.pid}/cmdline`)).toString().split('\0').filter(Boolean);
      if (exe === executable) {
        // Chromium may rewrite its process title into one space-separated
        // argument after exec. Do not guess boundaries for paths with spaces.
        if (args.length === 1 && args[0].includes(' ')) {
          if (/\s/.test(profile)) return false;
          args = args[0].split(/ +/);
        }
        if (args.some(arg => ['--no-sandbox', '--disable-setuid-sandbox', '--password-store=basic'].includes(arg))) return false;
        if (args.filter(arg => arg.startsWith('--user-data-dir=')).length === 1
            && args.includes(`--user-data-dir=${profile}`)
            && requiredArgs.every(required => args.filter(arg => arg === required).length === 1)) return true;
      }
    } catch { /* The owned process may still be traversing the Snap command chain. */ }
    await sleep(50);
  }
  return false;
}

async function groupExited(pid) {
  for (let i = 0; i < 100; i++) {
    try { process.kill(-pid, 0); }
    catch (error) { if (error.code === 'ESRCH') return true; return false; }
    await sleep(50);
  }
  return false;
}

function launchBrowser(executable, args) {
  // Use the existing native Wayland route, not the failed X11 direct route.
  // No sandbox or keyring override: Chromium keeps its normal protections.
  const env = { ...process.env, DISPLAY: '' };
  // The Snap wrapper otherwise accepts arbitrary extra flags from this variable.
  delete env.CHROMIUM_FLAGS;
  return spawn(executable, [...args.slice(0, -1), '--ozone-platform=wayland', args.at(-1)], { env, detached: true, stdio: 'ignore' });
}

// Not a public CLI. Tests substitute an anonymous root/URL and owned process
// operations; app/linux-login.mjs never reads these values from argv or env.
export async function runLinuxLogin({ root, url, preflight, launch = launchBrowser,
  observe = verifyStarted, groupGone = groupExited, onStarted = () => {},
  beforeRelease = () => {},
  requiredArgs = [], requireAbsentSingleton = false, joinUnconfirmedStart = false, requireExistingProfile = false,
  resumeSession = false }) {
  if (![false, 'settings', 'last-session'].includes(resumeSession) || (resumeSession && !requireExistingProfile)) throw fail('invalid_login_start_mode');
  await preflight();
  const state = await prepareLinuxLoginProfile(root, { create: !requireExistingProfile });
  let lockIdentity;
  try { lockIdentity = await createPrivateFile(state.lock, JSON.stringify({ version: 1, token: randomUUID() }) + '\n'); }
  catch (error) { if (error.code === 'EEXIST') throw fail('login_in_use_or_unknown'); throw error; }
  // From this point onward, every ambiguous failure retains the lock and the
  // profile. In particular, Snap's early exit is not proof of browser exit.
  await checkIdentity(state);
  if (requireAbsentSingleton) {
    try {
      await lstat(path.join(state.profile, 'SingletonLock'));
      throw fail('login_in_use_or_unknown');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  // The opt-in resume route adds no URL and never reads/rewrites session files.
  // The login-only and legacy manual routes retain their original start URL.
  const resumeArgs = resumeSession === 'last-session' ? ['--restore-last-session'] : [];
  const child = launch('/snap/bin/chromium', [`--user-data-dir=${state.profile}`, '--no-first-run', '--no-default-browser-check',
    ...(resumeSession ? resumeArgs : [url])]);
  const closed = { done: false };
  const ended = new Promise(resolve => {
    child.once('error', error => { closed.done = true; resolve({ error }); });
    child.once('close', (code, signal) => { closed.done = true; resolve({ code, signal }); });
  });
  let observed;
  try { observed = await observe(child, state.profile, closed, [...requiredArgs, ...resumeArgs]); }
  catch (error) {
    if (!joinUnconfirmedStart) throw error;
    await ended;
    throw fail('login_start_unconfirmed');
  }
  if (!observed) {
    if (joinUnconfirmedStart) await ended;
    throw fail('login_start_unconfirmed');
  }
  const assertStillOwned = async () => {
    await checkIdentity(state);
    const current = await lstat(state.lock);
    if (!privateMetadata(current) || !sameIdentity(lockIdentity, current)) throw fail('login_lock_changed');
    if (closed.done) throw fail('login_close_unconfirmed');
  };
  const assertProcessStillOwned = async () => {
    await assertStillOwned();
    if (!await observe(child, state.profile, closed, [...requiredArgs, ...resumeArgs])) throw fail('login_start_unconfirmed');
    await assertStillOwned();
  };
  await onStarted({ profile: state.profile, child, closed, ended, assertStillOwned, assertProcessStillOwned });
  const outcome = await ended;
  if (outcome.error || outcome.code !== 0 || outcome.signal || !await groupGone(child.pid)) throw fail('login_close_unconfirmed');
  // A supervising owner may have received an unknown/retain request while the
  // process group was being joined. Do not remove its lock before it checks.
  await removeOurLock(state, lockIdentity, beforeRelease);
}
