// Resume diagnostic only. No arbitrary profile, URL, command or metadata mode
// is exposed by either entry point. A separate owner keeps unknown pipes alive.
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runLinuxLogin } from './linux-login-core.mjs';
import { launchLinuxInspectBrowser, observeLinuxUiProbe, inspectFailureDiagnostic, projectInspectDiagnostic } from './linux-inspect-core.mjs';
import { projectKindleUiProbe } from './linux-reader-probe.mjs';

const notRun = () => ({ state: 'not-run' });
const result = (probe, shutdown, diagnostic) => ({ kind: 'reader-ui-probe', scope: 'diagnostic-only', binding: 'unverified',
  metadataCount: 0, probe, shutdown, lock: shutdown === 'normal' ? 'released' : 'retained-or-unknown',
  ...(diagnostic ? { diagnostic } : {}) });

export function projectResumeResult(value) {
  if (value?.kind !== 'reader-ui-probe' || value.scope !== 'diagnostic-only' || value.binding !== 'unverified'
      || value.metadataCount !== 0 || !['normal', 'unknown', 'not-started'].includes(value.shutdown)
      || value.lock !== (value.shutdown === 'normal' ? 'released' : 'retained-or-unknown')) throw new Error('invalid_resume_result');
  return result(value.probe?.state === 'not-run' ? notRun() : projectKindleUiProbe(value.probe), value.shutdown,
    value.diagnostic ? projectInspectDiagnostic(value.diagnostic) : undefined);
}

export const resumeDiagnosticSucceeded = value => value?.shutdown === 'normal' && value.lock === 'released'
  && value.metadataCount === 0 && value.probe?.state === 'ready' && !value.diagnostic
  && value.owner?.exited === true && value.owner.retained === false;

const keepUnknownOwnership = () => {
  // Deliberate passive guardian, not a retry/poll/kill loop. Without this owner
  // returning a finite unknown result would close its private browser pipe.
  setInterval(() => {}, 60_000);
  return new Promise(() => {});
};

// Request normal browser shutdown only after checking process/profile/lock.
// A response is not termination proof; the caller still joins the real group.
export async function closeOwnedInspectionBrowser({ child, closed, ended, assertProcessStillOwned, timeoutMs = 3000, onUnknown }) {
  if (closed.done) return;
  await assertProcessStillOwned();
  if (!child.stdio?.[3]?.writable || child.stdio[3].destroyed) {
    await onUnknown();
    await ended;
    return;
  }
  let timer;
  const timeout = new Promise(resolve => { timer = setTimeout(() => resolve('unknown'), timeoutMs); });
  try {
    // No reply is decoded. Browser.close has no useful page data, and only the
    // independently joined process/group terminal can establish normal close.
    child.stdio[3].write('{"id":999999,"method":"Browser.close"}\0', () => {});
    if (await Promise.race([ended.then(() => 'ended'), timeout]) === 'unknown') {
      await onUnknown();
      await ended; // this owner, not its returning controller, retains the pipe
    }
  } finally { clearTimeout(timer); }
}

// Internal test seam. The real owner supplies fixed home/origin and no URL.
export async function runResumeOwner({ root, expectedOrigin, preflight, resumeSession = 'last-session', notify,
  login = runLinuxLogin, launch = launchLinuxInspectBrowser, observe = observeLinuxUiProbe, closeTimeoutMs = 3000,
  holdUnknown = keepUnknownOwnership }) {
  let probe = notRun(), diagnostic, started = false, published = false;
  const publish = value => {
    if (published) return;
    published = true; notify(projectResumeResult(value));
  };
  try {
    await login({ root, preflight, resumeSession, requiredArgs: ['--remote-debugging-pipe'],
      requireAbsentSingleton: true, joinUnconfirmedStart: true, requireExistingProfile: true,
      launch: (executable, args) => { const child = launch(executable, args); started = true; return child; },
      async onStarted(context) {
        try {
          await context.assertStillOwned();
          probe = await observe(context.child, expectedOrigin);
          await context.assertStillOwned();
        } catch (error) { diagnostic = inspectFailureDiagnostic(error); }
        try {
          await closeOwnedInspectionBrowser({ ...context, timeoutMs: closeTimeoutMs,
            onUnknown: () => publish(result(probe, 'unknown', { stage: 'browser-close', reason: 'normal-close-unconfirmed' })) });
        } catch {
          publish(result(probe, 'unknown', { stage: 'browser-close', reason: 'normal-close-unconfirmed' }));
          await holdUnknown();
        }
      },
    });
    // runLinuxLogin established normal exit, group exit, unchanged identity and
    // removal of only its own lock. An earlier unknown report stays unknown.
    publish(result(probe, 'normal', diagnostic));
  } catch (error) {
    publish(result(probe, started ? 'unknown' : 'not-started', inspectFailureDiagnostic(error)));
    if (started) await holdUnknown();
  }
}

const startOwner = () => {
  const env = { ...process.env };
  delete env.NODE_OPTIONS; delete env.CHROMIUM_FLAGS; delete env.DEBUG; delete env.PWDEBUG;
  return fork(fileURLToPath(new URL('./linux-inspect-resume-owner.mjs', import.meta.url)), [], {
    execPath: process.execPath, execArgv: [], detached: true, env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
};

export async function runResumeController({ createOwner = startOwner, timeoutMs = 60000 } = {}) {
  let owner;
  try { owner = createOwner(); }
  catch { return { ...result(notRun(), 'not-started', { stage: 'supervision', reason: 'owner-protocol-unavailable' }), owner: { exited: true, retained: false } }; }
  return new Promise(resolve => {
    let readyPid = Number.isSafeInteger(owner.pid) && owner.pid > 0 ? owner.pid : undefined;
    let received, settled = false;
    const finish = (value, exited) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      owner.removeAllListeners('message');
      if (!exited) {
        // Disconnect only controller IPC, never the owner's browser pipe.
        try { if (owner.connected) owner.disconnect(); } catch { /* keep owner */ }
        owner.unref();
      }
      resolve({ ...value, owner: { ...(readyPid ? { pid: readyPid } : {}), exited, retained: !exited } });
    };
    const unknown = reason => finish(result(received?.probe ?? notRun(), 'unknown', { stage: 'supervision', reason }), false);
    const timer = setTimeout(() => unknown('owner-result-timeout'), timeoutMs);
    owner.on('message', message => {
      if (message?.event === 'owner-ready' && Number.isSafeInteger(message.pid) && message.pid > 0) {
        if (readyPid && readyPid !== message.pid) unknown('owner-protocol-unavailable');
        else readyPid = message.pid;
        return;
      }
      if (message?.event !== 'result') return;
      try { received = projectResumeResult(message.result); }
      catch { unknown('owner-protocol-unavailable'); return; }
      if (received.shutdown === 'unknown') finish(received, false);
    });
    owner.once('error', () => unknown('owner-protocol-unavailable'));
    owner.once('close', (code, signal) => {
      if (code !== 0 || signal) {
        finish(result(received?.probe ?? notRun(), 'unknown', { stage: 'supervision', reason: 'owner-exit-unconfirmed' }), true);
      } else finish(received ?? result(notRun(), 'unknown', { stage: 'supervision', reason: 'owner-exited-without-result' }), true);
    });
  });
}
