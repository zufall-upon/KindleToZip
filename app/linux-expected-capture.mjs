// One fixed, separately consented run. A permanent exclusive claim precedes
// all browser work. This entry is not a general CLI or an authorisation UI.
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Application } from './application.mjs';
import { Reader } from './reader.mjs';
import { startExpectedCaptureSession } from './expected-capture-session.mjs';
import { kindleChromeConfig } from './stores/kindle.mjs';
import { fixedCapturePaths, fixedCorrectedCapturePaths } from './linux-expected-capture-paths.mjs';
import { safeCaptureCode as safeCode, captureStartupDiagnostic } from './expected-capture-diagnostic.mjs';

const exclusive = name => open(name, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
const persist = async (handle, value) => {
  const bytes = Buffer.from(JSON.stringify(value) + '\n');
  await handle.truncate(0); await handle.write(bytes, 0, bytes.length, 0); await handle.sync();
};

async function run(paths, purpose = 'single-expected-capture') {
  // Never delete a claim, even after an error or an interrupted write. An
  // existing result also prevents starting, and is never overwritten.
  const claim = await exclusive(paths.claim);
  try { await claim.writeFile(JSON.stringify({ version: 1, purpose }) + '\n'); await claim.sync(); }
  finally { await claim.close(); }
  const directory = await open(paths.state, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await directory.sync(); } finally { await directory.close(); }
  const output = await exclusive(paths.result);
  const result = { version: 1, status: 'interrupted', stage: 'claimed', shutdown: 'not-started', storeShutdown: 'not-started',
    jobPath: null, budget: null, confirmedSends: 0, preview: null, state: null, reason: null, failure: null, processes: null, startupDiagnostic: null };
  let app, capability, budget, timedOut = false;
  const bounded = async (action, milliseconds) => {
    let timer;
    try { return await Promise.race([Promise.resolve().then(action), new Promise((_, reject) => {
      timer = setTimeout(() => { timedOut = true; reject(Object.assign(new Error('operation_timeout'), { code: 'operation_timeout' })); }, milliseconds);
    })]); } finally { clearTimeout(timer); }
  };
  try {
    await persist(output, result);
    const stateDirectory = await open(paths.state, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await stateDirectory.sync(); } finally { await stateDirectory.close(); }
    result.stage = 'storage';
    app = new Application({ dataDir: paths.data, ownsSignals: true });
    await bounded(() => app.init(), 130_000);
    const call = app.store.call.bind(app.store);
    app.store.call = async (kind, input, ...rest) => {
      const value = await call(kind, input, ...rest);
      if (kind === 'record_advance' && input?.dispatch === 'confirmed') result.confirmedSends += 1;
      return value;
    };
    await bounded(() => app.command('create'), 130_000);
    result.jobPath = app.job.job_path;
    // Establish the exact new job before launching the browser. It is always
    // retained, even if opening or preview fails.
    await persist(output, result);
    result.stage = 'browser';
    app.readerLifecycle = { profile: null, state: 'starting' };
    capability = await bounded(() => startExpectedCaptureSession(paths), 65_000);
    result.processes = capability.processIds;
    await persist(output, result);
    app.reader = await bounded(() => Reader.open({ ownedSession: capability, lifecycle: app.readerLifecycle,
      handleSignals: false, onChange: () => app.invalidate('browser_target_changed') }), 40_000);
    budget = app.reader.ownedSessionGuard.singleRunBudget;
    const tabs = app.reader.tabs();
    if (tabs.length !== 1) throw Object.assign(new Error('target_changed'), { code: 'target_changed' });
    app.reader.selectTab(tabs[0].id);
    await bounded(() => app.reader.setCaptureScale(app.job.manifest.capture_settings.capture_scale), 10_000);
    app.reader.imageFormat = app.job.manifest.capture_settings.image_format;
    app.reader.jpegQuality = app.job.manifest.capture_settings.jpeg_quality;
    result.stage = 'preview';
    const preview = await bounded(() => app.command('preview', { config: kindleChromeConfig }), 30_000);
    result.preview = { position: preview.previewInfo.position, dimensions: preview.previewInfo.dimensions,
      cssDimensions: preview.previewInfo.cssDimensions, layout: preview.previewInfo.layout };
    result.budget = budget.snapshot();
    await persist(output, result);
    result.stage = 'approve';
    // The user's one-time permission is the input to both distinct product
    // transitions; identity alone is not consent. Preview pixels are reused.
    await bounded(() => app.command('approve', { confirmed: true, maxCaptures: 2 }), 30_000);
    result.stage = 'start';
    await bounded(() => app.command('start', { confirmed: true }), 30_000);
    await bounded(() => app.loop, 130_000);
    const stopped = await bounded(() => app.snapshot(), 130_000);
    result.state = stopped.state; result.reason = safeCode({ code: stopped.reason });
    result.failure = stopped.lastFailure ? { stage: stopped.lastFailure.stage, code: safeCode(stopped.lastFailure),
      advanceDispatch: stopped.lastFailure.advanceDispatch, committedImages: stopped.lastFailure.committedImages } : null;
    result.status = stopped.state === 'Review' && ['capture_limit_reached', 'end_candidate'].includes(stopped.reason)
      ? 'stopped' : 'failed';
    result.stage = 'stopped';
  } catch (error) {
    budget?.fail();
    if (timedOut) {
      app?.invalidate('operation_timeout');
      capability?.retain();
      if (app?.readerLifecycle) { app.readerLifecycle.state = 'close_unconfirmed'; app.readerLifecycle.failure = error; }
    }
    result.status = 'failed'; result.failure = { stage: result.stage, code: safeCode(error) };
    result.startupDiagnostic = captureStartupDiagnostic(error);
    if (app?.job && !timedOut) {
      try { const stopped = await bounded(() => app.snapshot(), 130_000); result.state = stopped.state; result.reason = stopped.reason === null ? null : safeCode({ code: stopped.reason }); }
      catch { /* An unconfirmed store stays unconfirmed. */ }
    }
  } finally {
    if (budget) result.budget = budget.snapshot();
    if (app) {
      try {
        await bounded(() => app.close(), 130_000);
        result.shutdown = capability ? 'normal' : 'not-started';
        result.storeShutdown = !app.store.failed && app.store.child.exitCode === 0 && app.store.child.signalCode === null ? 'normal' : 'unknown';
        if (result.storeShutdown !== 'normal') result.status = 'failed';
      }
      catch { capability?.retain(); result.shutdown = 'unknown'; result.status = 'failed'; }
    }
    try { await persist(output, result); } finally { await output.close(); }
  }
  return result.status === 'stopped' && result.shutdown === 'normal' && result.storeShutdown === 'normal';
}

// Only this fixed alternative is exported, not an arbitrary paths/run API.
export const runCorrectedCaptureOnce = async () => run(await fixedCorrectedCapturePaths(), 'single-expected-corrected-capture');

if (process.argv[1] === fileURLToPath(import.meta.url)) {
if (process.platform !== 'linux' || process.argv.length !== 2) {
  console.error('invalid_invocation'); process.exitCode = 1;
} else {
  process.umask(0o077);
  // This fixed entry does not inherit the general application's controller
  // override; only the project's already-built local controller may write.
  delete process.env.KTZ_CONTROLLER_PATH;
  try { if (!await run(await fixedCapturePaths())) process.exitCode = 1; }
  catch (error) { console.error(safeCode(error)); process.exitCode = 1; }
}
}
