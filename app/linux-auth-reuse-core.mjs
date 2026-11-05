// Authentication UI observation only. No Reader, acquisition, credentials,
// storage APIs, tracing, screenshots, or page turns are used here.
import { spawn, fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runLinuxLogin } from './linux-login-core.mjs';
import { closeOwnedInspectionBrowser } from './linux-inspect-resume-core.mjs';
import { ownedPipeTransport } from './linux-playwright-pipe.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const libraryUrl = 'https://read.amazon.co.jp/kindle-library';

// Serialized into the one newly created top-level document. Only fixed
// structural/visibility predicates leave it; no text, input values, or URLs do.
export function probeLoginUi() {
  const visible = element => {
    if (!element?.isConnected) return false;
    for (let node = element; node?.nodeType === 1; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility) || Number(style.opacity) === 0) return false;
    }
    return [...element.getClientRects()].some(rect => rect.width > 0 && rect.height > 0
      && rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight);
  };
  const any = selector => [...document.querySelectorAll(selector)].some(visible);
  const library = location.origin === 'https://read.amazon.co.jp' && /^\/kindle-library\/?$/.test(location.pathname);
  const officialAuthOrigin = ['https://read.amazon.co.jp', 'https://www.amazon.co.jp', 'https://amazon.co.jp'].includes(location.origin);
  const reauth = officialAuthOrigin && any('input[type="password"], input[name="email"], input[name="otpCode"], input[autocomplete="one-time-code"]');
  const modal = any('[aria-modal="true"], dialog[open]');
  // An explicit, visible sign-out control is positive UI evidence. Hidden
  // menu templates and a library route alone are deliberately insufficient.
  const signout = library && any('button[aria-label="ログアウト"], a[aria-label="ログアウト"], [role="button"][aria-label="ログアウト"], button[aria-label="サインアウト"], a[aria-label="サインアウト"], [role="button"][aria-label="サインアウト"], button[aria-label="Sign out"], a[aria-label="Sign out"], [role="button"][aria-label="Sign out"]');
  const flags = { library, reauth, modal, signout };
  if (reauth && !signout) return { state: 'reauth_required', basis: 'visible-auth-input', ...flags };
  if (library && signout && !reauth && !modal) return { state: 'authenticated_ui', basis: 'visible-signout-on-library', ...flags };
  return { state: 'unknown', basis: reauth && signout ? 'conflicting-ui' : modal ? 'blocking-ui' : 'positive-ui-unestablished', ...flags };
}

const states = new Set(['authenticated_ui', 'reauth_required', 'unknown']);
const bases = new Set(['visible-auth-input', 'visible-signout-on-library', 'conflicting-ui', 'blocking-ui',
  'positive-ui-unestablished', 'not-observed', 'pipe-or-document-unavailable', 'unexpected-initial-pages']);
const emptyProbe = () => ({ state: 'unknown', basis: 'not-observed', library: false, reauth: false, modal: false, signout: false });
export function projectAuthProbe(value) {
  if (!states.has(value?.state) || !bases.has(value?.basis)
      || !['library', 'reauth', 'modal', 'signout'].every(key => typeof value[key] === 'boolean')) throw new Error('invalid_auth_probe');
  if (value.state === 'authenticated_ui' && !(value.basis === 'visible-signout-on-library' && value.library && value.signout && !value.reauth && !value.modal)) throw new Error('invalid_auth_probe');
  if (value.state === 'reauth_required' && !(value.basis === 'visible-auth-input' && value.reauth && !value.signout)) throw new Error('invalid_auth_probe');
  return { state: value.state, basis: value.basis, library: value.library, reauth: value.reauth, modal: value.modal, signout: value.signout };
}

export async function observeAuthUi(child, { connect, deadlineMs = 25_000 } = {}) {
  const transport = ownedPipeTransport(child);
  let connected = false, probe = emptyProbe();
  const until = performance.now() + deadlineMs;
  async function bounded(action) {
    let timer;
    const remaining = until - performance.now();
    if (remaining <= 0) throw new Error('observation_deadline');
    try { return await Promise.race([Promise.resolve().then(action), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('observation_deadline')), remaining);
    })]); } finally { clearTimeout(timer); }
  }
  try {
    const chromium = connect ? null : (await bounded(() => import('playwright'))).chromium;
    const browser = await bounded(() => connect ? connect(transport) : chromium.connectOverCDP(transport, { noDefaults: true, timeout: Math.max(1, until - performance.now()) }));
    connected = true;
    const contexts = browser.contexts();
    if (contexts.length !== 1 || contexts[0].pages().length !== 0) {
      return { connected, probe: { ...probe, basis: 'unexpected-initial-pages' } };
    }
    const context = contexts[0];
    let changed = false, page;
    context.on('page', candidate => { if (page && candidate !== page) changed = true; });
    page = await bounded(() => context.newPage());
    await bounded(() => page.goto(libraryUrl, { waitUntil: 'domcontentloaded', timeout: Math.max(1, until - performance.now()) }));
    let previous;
    while (performance.now() < until) {
      if (changed || page.isClosed() || context.pages().length !== 1 || context.pages()[0] !== page) throw new Error('page_changed');
      probe = projectAuthProbe(await bounded(() => page.evaluate(probeLoginUi)));
      if (changed || page.isClosed() || context.pages().length !== 1 || context.pages()[0] !== page) throw new Error('page_changed');
      if (probe.state !== 'unknown' && JSON.stringify(probe) === previous) return { connected, probe };
      previous = JSON.stringify(probe);
      await bounded(() => sleep(250));
    }
  } catch {
    // Exceptions may contain private frame URLs. Never retain or print them.
    // A transient positive followed by failure is not a stable observation.
    if (probe.state !== 'unknown' || probe.basis === 'not-observed') probe = { ...emptyProbe(), basis: 'pipe-or-document-unavailable' };
  } finally { transport.close(); }
  return { connected, probe: projectAuthProbe(probe) };
}

export function launchAuthBrowser(executable, args) {
  const env = { ...process.env, DISPLAY: '' };
  for (const key of ['CHROMIUM_FLAGS', 'NODE_OPTIONS', 'DEBUG', 'PWDEBUG']) delete env[key];
  const child = spawn(executable, [...args, '--ozone-platform=wayland', '--no-startup-window', '--remote-debugging-pipe'], {
    env, detached: true, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
  });
  child.stdio[3].on('error', () => {}); child.stdio[4].on('error', () => {});
  child.stdio[4].resume();
  return child;
}

const makeResult = (probe = emptyProbe(), connected = false, shutdown = 'not-started') => ({ version: 1,
  kind: 'linux-login-reuse', scope: 'library-ui-only', profile: 'existing-dedicated', connection: connected ? 'reader-pipe' : 'unconfirmed',
  probe: projectAuthProbe(probe), shutdown, lock: shutdown === 'normal' ? 'released' : 'retained-or-unknown' });
export function projectAuthResult(value) {
  if (value?.version !== 1 || value.kind !== 'linux-login-reuse' || value.scope !== 'library-ui-only' || value.profile !== 'existing-dedicated'
      || !['reader-pipe', 'unconfirmed'].includes(value.connection) || !['not-started', 'normal', 'unknown'].includes(value.shutdown)
      || value.lock !== (value.shutdown === 'normal' ? 'released' : 'retained-or-unknown')) throw new Error('invalid_auth_result');
  if (value.probe?.state !== 'unknown' && value.connection !== 'reader-pipe') throw new Error('invalid_auth_result');
  return makeResult(value.probe, value.connection === 'reader-pipe', value.shutdown);
}
const hold = () => { setInterval(() => {}, 60_000); return new Promise(() => {}); };

export async function runAuthOwner({ root, preflight, notify, login = runLinuxLogin,
  launch = launchAuthBrowser, observe = observeAuthUi, close = closeOwnedInspectionBrowser, holdUnknown = hold,
  retained = () => false, release = async () => {} }) {
  let started = false, sticky = false, published = false, probe = emptyProbe(), connected = false;
  const publish = shutdown => { if (!published) { published = true; notify(makeResult(probe, connected, shutdown)); } };
  try {
    await login({ root, preflight, resumeSession: 'settings', requireExistingProfile: true, requireAbsentSingleton: true,
      requiredArgs: ['--ozone-platform=wayland', '--no-startup-window', '--remote-debugging-pipe'],
      launch: (exe, args) => { const child = launch(exe, args); started = true; return child; },
      beforeRelease: async () => {
        if (!sticky && !retained()) await release();
        if (sticky || retained()) { sticky = true; publish('unknown'); await holdUnknown(); throw new Error('retained'); }
      },
      async onStarted(context) {
        try {
          await context.assertProcessStillOwned();
          if (retained()) throw new Error('retained');
          const observed = await observe(context.child);
          connected = observed.connected === true; probe = projectAuthProbe(observed.probe);
        } catch { probe = { ...emptyProbe(), basis: 'pipe-or-document-unavailable' }; }
        if (retained()) { sticky = true; publish('unknown'); await holdUnknown(); throw new Error('retained'); }
        try {
          await close({ ...context, onUnknown: () => { sticky = true; publish('unknown'); } });
          if (sticky || retained()) { sticky = true; publish('unknown'); await holdUnknown(); throw new Error('retained'); }
        } catch { sticky = true; publish('unknown'); await holdUnknown(); throw new Error('retained'); }
      },
    });
    if (!sticky) publish('normal');
  } catch { publish(started ? 'unknown' : 'not-started'); if (started) await holdUnknown(); }
}

export function startAuthOwner() {
  const env = { ...process.env };
  for (const key of ['NODE_OPTIONS', 'CHROMIUM_FLAGS', 'DEBUG', 'PWDEBUG']) delete env[key];
  return fork(fileURLToPath(new URL('./linux-auth-reuse.mjs', import.meta.url)), ['--owner'], {
    execPath: process.execPath, execArgv: [], env, detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
}
export function collectAuthResult({ createOwner = startAuthOwner, timeoutMs = 50_000 } = {}) {
  return new Promise(resolve => {
    let owner, received, settled = false, releaseAuthorized = false;
    const finish = (value, exited) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (!exited) {
        try { if (!releaseAuthorized && owner?.connected) owner.send({ event: 'retain' }, () => {}); } catch {}
        owner?.unref(); owner?.channel?.unref();
      }
      resolve({ ...value, owner: { exited, retained: !exited } });
    };
    let timer = setTimeout(() => finish(makeResult(received?.probe, received?.connection === 'reader-pipe', 'unknown'), false), timeoutMs);
    try { owner = createOwner(); }
    catch { finish(makeResult(), true); return; }
    owner.on('message', message => {
      if (settled) return;
      if (message?.event === 'release-ready' && !releaseAuthorized) {
        // The actual browser and group are already joined. Cancel the deadline
        // that can request retention before authorizing the owner's unlock.
        clearTimeout(timer); releaseAuthorized = true;
        try { owner.send({ event: 'release' }, () => {}); }
        catch { finish(makeResult(undefined, false, 'unknown'), false); return; }
        timer = setTimeout(() => finish(makeResult(received?.probe, received?.connection === 'reader-pipe', 'unknown'), false), 5000);
        return;
      }
      if (message?.event !== 'result') return;
      try { received = projectAuthResult(message.result); }
      catch { finish(makeResult(undefined, false, 'unknown'), false); return; }
      if (received.shutdown === 'unknown') finish(received, false);
    });
    owner.once('error', () => finish(makeResult(undefined, false, 'unknown'), false));
    owner.once('close', (code, signal) => {
      const good = code === 0 && !signal && received && (received.shutdown !== 'normal' || releaseAuthorized);
      finish(good ? received : makeResult(undefined, false, 'unknown'), true);
    });
  });
}
