// Fixed restored-session observation. The old diagnostic-only entry is kept
// separate; neither entry accepts a URL/profile/selector from its caller.
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runLinuxLogin } from './linux-login-core.mjs';
import { launchLinuxInspectBrowser, inspectFailureDiagnostic } from './linux-inspect-core.mjs';
import { closeOwnedInspectionBrowser } from './linux-inspect-resume-core.mjs';
import { observeRestoredWithPlaywright, projectMetadata, projectUiDiagnostics } from './linux-playwright-observe.mjs';
import { readerMarkerReasons } from './linux-reader-probe.mjs';

const reasons = new Set(['context-ambiguous', 'multiple-page-targets', 'multiple-markers', 'target-changed',
  'readiness-timeout', 'probe-unavailable', 'invalid-metadata', 'document-unavailable', 'blocking-ui',
  'reader-region', 'reader-direction', 'reader-surface', 'reader-title', 'reader-position', 'reader-dimensions',
  'owner-result-timeout', 'owner-protocol-unavailable', 'owner-exit-unconfirmed', 'owner-exited-without-result',
  'normal-close-unconfirmed', 'invalid-invocation', 'preflight-or-start', 'ownership-in-use-or-unknown',
  'book-mismatch', 'title-mismatch', ...readerMarkerReasons]);
const preparations = new Set(['dispatched', 'refused', 'interrupted']);
const makeResult = (observation, reason, shutdown, detail, preparation, diagnostics, binding = 'continuity-unverified') => ({ kind: 'reader-ui-observation', scope: 'restored-session',
  binding, metadataCount: observation ? 1 : 0, ...(observation ? { observation } : { reason }),
  ...(reason === 'readiness-timeout' && readerMarkerReasons.includes(detail) ? { detail } : {}),
  ...(preparations.has(preparation) ? { preparation } : {}),
  ...(diagnostics ? { diagnostics: projectUiDiagnostics(diagnostics) } : {}),
  shutdown, lock: shutdown === 'normal' ? 'released' : 'retained-or-unknown' });

export function projectPlaywrightResult(value) {
  if (value?.kind !== 'reader-ui-observation' || value.scope !== 'restored-session' || !['continuity-unverified', 'expected-book-required'].includes(value.binding)
      || !['normal', 'unknown', 'not-started'].includes(value.shutdown)
       || value.lock !== (value.shutdown === 'normal' ? 'released' : 'retained-or-unknown')) throw new Error('invalid_observation');
  if (value.preparation !== undefined && !preparations.has(value.preparation)) throw new Error('invalid_observation');
  const diagnostics = value.diagnostics === undefined ? undefined : projectUiDiagnostics(value.diagnostics);
  if (value.metadataCount === 1 && value.shutdown === 'normal' && !value.reason)
    return makeResult(projectMetadata({ state: 'ok', ...value.observation }, { expected: value.binding === 'expected-book-required' }), undefined, value.shutdown, undefined, value.preparation, diagnostics, value.binding);
  if (value.metadataCount !== 0 || !reasons.has(value.reason) || value.observation) throw new Error('invalid_observation');
  if (value.detail && (value.reason !== 'readiness-timeout' || !readerMarkerReasons.includes(value.detail))) throw new Error('invalid_observation');
  return makeResult(undefined, value.reason, value.shutdown, value.detail, value.preparation, diagnostics, value.binding);
}
export const playwrightObservationSucceeded = value => value?.shutdown === 'normal' && value.lock === 'released'
  && value.metadataCount === 1 && value.owner?.exited === true && value.owner.retained === false;

const holdUnknown = () => { setInterval(() => {}, 60000); return new Promise(() => {}); };
export async function runPlaywrightOwner({ root, expectedOrigin, preflight, notify, login = runLinuxLogin,
  launch = launchLinuxInspectBrowser, observe = observeRestoredWithPlaywright, closeTimeoutMs = 3000, hold = holdUnknown,
  expectedMode = false, expectedBook }) {
  let observation, reason = 'preflight-or-start', detail, preparation, diagnostics, started = false, published = false;
  const binding = expectedMode ? 'expected-book-required' : 'continuity-unverified';
  const result = (observation, reason, shutdown, detail, preparation, diagnostics) => makeResult(observation, reason, shutdown, detail, preparation, diagnostics, binding);
  const publish = result => { if (!published) { published = true; notify(projectPlaywrightResult(result)); } };
  try {
    await login({ root, preflight: async () => { if (expectedMode && !expectedBook) throw new Error('expected_book_unavailable'); await preflight(); }, resumeSession: 'last-session', requiredArgs: ['--remote-debugging-pipe'],
      requireAbsentSingleton: true, joinUnconfirmedStart: true, requireExistingProfile: true,
      launch: (executable, args) => { const child = launch(executable, args); started = true; return child; },
      async onStarted(context) {
        try {
          await context.assertStillOwned();
          observation = await observe(context.child, expectedOrigin, {
            ...(expectedMode ? { expectedBook } : {}),
            onPreparation: value => { if (preparations.has(value)) preparation = value; },
            onDiagnostic: value => { diagnostics = { ...diagnostics, ...projectUiDiagnostics(value) }; },
          });
          await context.assertStillOwned();
        } catch (error) { observation = undefined; reason = reasons.has(error?.reason) ? error.reason : 'probe-unavailable'; detail = error?.detail; }
        try {
          await closeOwnedInspectionBrowser({ ...context, timeoutMs: closeTimeoutMs,
            onUnknown: () => publish(result(undefined, 'normal-close-unconfirmed', 'unknown', undefined, preparation, diagnostics)) });
        } catch {
          publish(result(undefined, 'normal-close-unconfirmed', 'unknown', undefined, preparation, diagnostics));
          await hold();
        }
      },
    });
    publish(result(observation, reason, 'normal', detail, preparation, diagnostics));
  } catch (error) {
    // The existing helper's ownership rejection is deliberately not repaired.
    const diagnostic = inspectFailureDiagnostic(error);
    reason = diagnostic.reason === 'ownership-in-use-or-unknown' ? diagnostic.reason : 'preflight-or-start';
    publish(result(undefined, reason, started ? 'unknown' : 'not-started'));
    if (started) await hold();
  }
}

function startOwner(filename = './linux-playwright-resume-owner.mjs') {
  const env = { ...process.env };
  delete env.NODE_OPTIONS; delete env.CHROMIUM_FLAGS; delete env.DEBUG; delete env.PWDEBUG;
  return fork(fileURLToPath(new URL(filename, import.meta.url)), [], {
    execPath: process.execPath, execArgv: [], detached: true, env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
}
export function runExpectedPlaywrightController() {
  return runPlaywrightController({ createOwner: () => startOwner('./linux-playwright-expected-owner.mjs') });
}
export async function runPlaywrightController({ createOwner = startOwner, timeoutMs = 60000 } = {}) {
  let owner;
  try { owner = createOwner(); }
  catch { return { ...makeResult(undefined, 'owner-protocol-unavailable', 'not-started'), owner: { exited: true, retained: false } }; }
  return new Promise(resolve => {
    let pid = Number.isSafeInteger(owner.pid) && owner.pid > 0 ? owner.pid : undefined, received, settled = false;
    const finish = (value, exited) => {
      if (settled) return;
      settled = true; clearTimeout(timer); owner.removeAllListeners('message');
      if (!exited) { try { if (owner.connected) owner.disconnect(); } catch {} owner.unref(); }
      resolve({ ...value, owner: { ...(pid ? { pid } : {}), exited, retained: !exited } });
    };
    const unknown = reason => finish(makeResult(undefined, reason, 'unknown'), false);
    const timer = setTimeout(() => unknown('owner-result-timeout'), timeoutMs);
    owner.on('message', message => {
      if (message?.event === 'owner-ready' && Number.isSafeInteger(message.pid) && message.pid > 0) {
        if (pid && pid !== message.pid) unknown('owner-protocol-unavailable'); else pid = message.pid;
      } else if (message?.event === 'result') {
        try { received = projectPlaywrightResult(message.result); } catch { unknown('owner-protocol-unavailable'); return; }
        if (received.shutdown === 'unknown') finish(received, false);
      }
    });
    owner.once('error', () => unknown('owner-protocol-unavailable'));
    owner.once('close', (code, signal) => {
      if (code !== 0 || signal) finish(makeResult(undefined, 'owner-exit-unconfirmed', 'unknown'), true);
      else finish(received ?? makeResult(undefined, 'owner-exited-without-result', 'unknown'), true);
    });
  });
}
