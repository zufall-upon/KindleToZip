// A private child owns both the fresh profile and the fixture. No caller data is
// sent to it: in particular this is not a URL, profile, or CDP endpoint API.
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ownedPipeTransport } from './linux-playwright-pipe.mjs';
import { anonymousExpectedBook } from './owned-sample-identity.mjs';
import { portableStartupFailure } from './portable-limited-failure.mjs';

const fail = (release = false) => Object.assign(new Error(release ? 'owned_pipe_release_unconfirmed' : 'owned_pipe_unconfirmed'), {
  code: release ? 'owned_pipe_release_unconfirmed' : 'owned_pipe_unconfirmed',
});
const readerEnvironmentKeys = Object.freeze(['HOME', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'TMPDIR', 'TMP', 'TEMP']);
let portableLaunchEnvironment = null;

// Called once by the ordinary main entry before its control/Application temp
// isolation. No caller values, environment override names, or snapshot output.
export function capturePortableReaderEnvironment() {
  if (portableLaunchEnvironment !== null) throw fail();
  const captured = Object.create(null);
  for (const key of readerEnvironmentKeys) {
    if (Object.hasOwn(process.env, key)) captured[key] = process.env[key];
  }
  portableLaunchEnvironment = Object.freeze(captured);
}
export function assertPortableReaderEnvironment() {
  if (portableLaunchEnvironment === null) throw fail();
}

export async function startLinuxOwnedReader({ selected, expectedReader = false, usePortableEnvironment = false } = {}) {
  if (process.platform !== 'linux' || !process.env.WAYLAND_DISPLAY) throw fail();
  const env = { ...process.env };
  if (usePortableEnvironment !== false) {
    if (usePortableEnvironment !== true || !selected || expectedReader !== true) throw fail();
    assertPortableReaderEnvironment();
    for (const key of readerEnvironmentKeys) {
      if (Object.hasOwn(portableLaunchEnvironment, key)) env[key] = portableLaunchEnvironment[key];
      else delete env[key];
    }
  }
  for (const key of ['NODE_OPTIONS', 'CHROMIUM_FLAGS', 'DEBUG', 'PWDEBUG']) delete env[key];
  // The directory is derived from the already resolved application selection,
  // never from an HTTP field. The child independently resolves the opaque ID.
  if (selected) env.KTZ_PORTABLE_READER_DATA = path.dirname(selected.root);
  else delete env.KTZ_PORTABLE_READER_DATA;
  const child = fork(fileURLToPath(new URL('./linux-owned-reader-owner.mjs', import.meta.url)),
    selected ? ['--portable-session', selected.id] : [], {
    execPath: process.execPath, execArgv: [], detached: true, env,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc', 'pipe', 'pipe'],
  });
  return superviseLinuxOwnedReader(child, { expectedReader });
}

const managedOwners = new WeakSet();
export const isManagedLinuxReader = owner => managedOwners.has(owner);

// Internal supervision seam for an already-created owned child, not a public
// URL/profile/endpoint or an alternate production launcher.
export async function superviseLinuxOwnedReader(child, { startupTimeoutMs = 60_000, closeTimeoutMs = 12_000, expectedReader = false } = {}) {
  const input = child.stdio[4], output = child.stdio[5];
  input.on('error', () => {}); output.on('error', () => {});
  let result, exited, closePromise, startupTimer, startupExpired = false, closeTimer, closeExpired = false, closing = false;
  let releaseReady = false, releaseAuthorized = false, retained = false;
  let startupFailure;
  const waiters = new Set();
  const checks = new Map(); let checkId = 0;
  const wake = () => { for (const waiter of waiters) waiter(); waiters.clear(); };
  const changed = () => new Promise(resolve => waiters.add(resolve));
  child.on('message', message => {
    // A timeout/unknown is sticky, even if the owner later reports normal.
    if (retained) return;
    if (message?.event === 'checked' && Number.isSafeInteger(message.id)) {
      const check = checks.get(message.id);
      if (check && result?.state === 'ready' && !closing) { checks.delete(message.id); check(); }
      return;
    }
    if (message?.event === 'ready' && expectedReader && message.kind === 'fixed-expected-reader'
        && Number.isSafeInteger(message.browserPid) && message.browserPid > 1 && !result) {
      result = { state: 'ready', browserPid: message.browserPid };
    } else if (message?.event === 'ready' && !expectedReader && typeof message.url === 'string'
      && /^http:\/\/127\.0\.0\.1:[0-9]+\/reader\.html\?asin=[A-Z0-9]{10}$/.test(message.url)
      && new URL(message.url).searchParams.get('asin') === anonymousExpectedBook.asin && !result) {
      result = { state: 'ready', url: message.url };
    } else if (message?.event === 'release-ready') {
      // The user may have closed the browser before this controller's close.
      // Remember that same owner's confirmation without releasing early.
      releaseReady = true;
      authorizeRelease();
    } else if (message?.event === 'normal') result = { state: 'normal' };
    else if (message?.event === 'unknown' || message?.event === 'not-started') {
      startupFailure ??= portableStartupFailure({ portableStartupDiagnostic: message.startupFailure }, 'owner_start');
      result = { state: message.event };
    }
    wake();
  });
  child.once('error', () => { result = { state: 'unknown' }; wake(); });
  child.once('exit', (code, signal) => { exited = { code, signal }; wake(); });
  child.once('disconnect', () => {
    if (!exited && result?.state !== 'normal') { result = { state: 'unknown' }; wake(); }
  });
  function authorizeRelease() {
    if (!releaseReady || !closing || closeExpired || releaseAuthorized || retained || exited || result?.state !== 'ready') return;
    // Browser/group exit is confirmed by the owner, but lock removal is not.
    // Keep the original close deadline through authorization and final exit.
    // A timeout after this point cannot promise that the lock is still held.
    releaseAuthorized = true;
    const failed = () => { result = { state: 'unknown' }; retain(); wake(); };
    try { if (child.connected) child.send({ event: 'release' }, error => { if (error) failed(); }); else failed(); }
    catch { failed(); }
  }
  function retain() {
    if (retained) return;
    retained = true;
    // A controller timeout is not an ordinary parent disconnect. Tell the
    // owner to retain its resources before closing this IPC channel.
    try {
      if (child.connected) child.send({ event: 'retain' }, () => { try { if (child.connected) child.disconnect(); } catch {} });
    } catch { try { if (child.connected) child.disconnect(); } catch {} }
    // A stalled IPC callback must not keep this caller alive indefinitely.
    child.unref(); child.channel?.unref(); input.unref?.(); output.unref?.();
  }
  const startupDeadline = new Promise(resolve => { startupTimer = setTimeout(() => { startupExpired = true; resolve(); }, startupTimeoutMs); });
  while (!result && !exited && !startupExpired) await Promise.race([changed(), startupDeadline]);
  clearTimeout(startupTimer);
  if (result?.state !== 'ready' || exited) {
    retain();
    throw Object.assign(fail(), { portableStartupDiagnostic: startupFailure ?? portableStartupFailure(null, 'owner_start') });
  }
  const transport = ownedPipeTransport({ stdio: [null, null, null, input, output] });
  const owner = {
    url: result.url, transport,
    ...(expectedReader ? { processIds: { owner: child.pid, browser: result.browserPid } } : {}),
    retain() { retain(); transport.close(); },
    async assertOwned() {
      if (retained || closing || exited || result?.state !== 'ready') throw fail();
      const id = ++checkId;
      let timer;
      try {
        await new Promise((resolve, reject) => {
          checks.set(id, resolve);
          timer = setTimeout(() => { checks.delete(id); retain(); reject(fail()); }, 2500);
          try { child.send({ event: 'check', id }, error => { if (error) { checks.delete(id); retain(); reject(fail()); } }); }
          catch { checks.delete(id); retain(); reject(fail()); }
        });
        if (retained || closing || exited || result?.state !== 'ready') throw fail();
      } finally { clearTimeout(timer); }
    },
    close() {
      return closePromise ??= (async () => {
        // Disconnect Playwright's reader before the owner switches the *same*
        // browser output from relay to drain. An earlier retain may already
        // have stopped that relay: disconnect the client even then so later
        // Reader cleanup cannot wait for replies from an unknown owner.
        // This never destroys the owner's pipe or authorizes lock release.
        transport.close();
        if (retained) throw fail(releaseAuthorized);
        closing = true;
        const deadline = new Promise(resolve => { closeTimer = setTimeout(() => { closeExpired = true; resolve(); }, closeTimeoutMs); });
        try { if (child.connected) child.send({ event: 'close' }, () => {}); } catch {}
        authorizeRelease();
        try {
          while (!exited && result?.state !== 'unknown' && !closeExpired) await Promise.race([changed(), deadline]);
          if (closeExpired || result?.state !== 'normal' || !exited || exited.code !== 0 || exited.signal) { retain(); throw fail(releaseAuthorized); }
        } finally { clearTimeout(closeTimer); }
      })();
    },
  };
  managedOwners.add(owner);
  return Object.freeze(owner);
}
