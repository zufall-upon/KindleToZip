// Fixed, in-process preparation of one new Portable job. No external control
// endpoint, Reader-page automation, or approval/start action is provided here.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { lstat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { privateMetadata } from './private-path.mjs';
import { portableInitialRejectionReasons, portableInitialOriginKinds } from './portable-limited-failure.mjs';
import { captureStartupDiagnostic } from './expected-capture-diagnostic.mjs';

const installed = '/home/user/KTZ-Portable';
const ownRoot = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
const entered = new WeakSet();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const refuse = code => { throw Object.assign(new Error('pilot_refused'), { pilotCode: code }); };
const stages = new Set(['owner_start', 'owner_check', 'browser_launch', 'owner_verify', 'pipe_attach',
  'reader_initialize', 'capture_scale', 'record_start', 'record_finish', 'unclassified']);
const codes = new Set(['target_changed', 'operation_timeout', 'window_not_available', 'capture_scale_unavailable',
  'owned_pipe_unconfirmed', 'owned_pipe_release_unconfirmed', 'login_in_use_or_unknown', 'login_identity_changed',
  'login_lock_changed', 'login_start_unconfirmed', 'login_close_unconfirmed', 'unsafe_login_directory',
  'unsafe_login_marker', 'snap_personal_init_exists', 'snap_changed', 'portable_session_unavailable',
  'record_failed', 'ENOENT', 'EACCES', 'unclassified']);
const pilotCodes = new Set(['invalid_invocation', 'duplicate', 'session_ambiguous', 'old_job', 'state_changed',
  'control_changed', 'operation_failed', 'operation_timeout', 'owner_unknown', 'stopped', 'unclassified']);
// Application, Reader and Store already use these codes. Never pass through an
// arbitrary error code, detail, message or snapshot from the private session.
const stopCodes = new Set(['target_changed', 'browser_target_changed', 'auth_or_target_changed', 'auth_or_overlay_detected',
  'reader_ui_unknown', 'reader_library_selected', 'reader_auto_ambiguous', 'reader_configuration_required',
  'display_or_position_unknown', 'display_unstable', 'window_not_available', 'capture_scale_unavailable',
  'capture_failed', 'capture_dimensions_mismatch', 'capture_resolution_exceeds_limit', 'capture_png_invalid',
  'capture_jpeg_invalid', 'black_image', 'invalid_png', 'png_too_large', 'image_review_required', 'image_integrity_failed',
  'advance_uncertain', 'advance_geometry_changed', 'advance_obscured', 'capture_or_advance_failed',
  'capture_pending', 'capture_id_exhausted', 'capture_not_started', 'capture_id_mismatch', 'capture_pending_closed',
  'capture_format_mismatch', 'capture_conflict', 'capture_commit_failed', 'capture_in_progress',
  'store_disconnected', 'store_unavailable', 'store_rejected', 'storage_durability_uncertain', 'storage_reopen_required',
  'storage_unsupported', 'output_path_changed', 'output_published_durability_uncertain',
  'output_published_manifest_update_failed', 'output_published_manifest_durability_uncertain',
  'expected_capture_budget_exhausted', 'expected_capture_new_job_required', 'expected_reader_not_ready',
  'portable_limited_claim_consumed', 'portable_limited_claim_unknown', 'portable_limited_path_invalid',
  'portable_limited_record_failed', 'portable_limited_settings_invalid', 'portable_limited_review_only', 'portable_postprocess_unavailable',
  'select_reader_tab', 'preview_confirmation_required', 'explicit_start_required', 'invalid_capture_limit',
  'capture_limit_changed', 'invalid_capture_settings', 'resume_position_required', 'end_candidate', 'job_inconsistent',
  'book_identity_changed', 'cancelled', 'operation_failed', 'safe_stop_incomplete',
  'reader_release_incomplete', 'reader_close_failed', 'browser_open_failed']);
const stopStages = new Set(['capture', 'capture_begin', 'capture_upload', 'target_recheck_before_commit', 'capture_commit',
  'image_review', 'capture_limit_stop', 'end_stop', 'advance_preflight', 'advance_dispatch', 'advance_confirmation',
  'advance_confirmed', 'auto_visibility_wait', 'preview_visibility_wait', 'reader_target_check', 'preview_inspection']);
const actions = new Set(['create', 'preparePortableKindle', 'openBrowser', 'selectReaderTab', 'preview', 'quickPreview',
  'approve', 'start', 'pause', 'stop', 'review', 'closeBrowser', 'finishBook', 'crop', 'resetCrop', 'detectCrop', 'applyAutoCrop', 'setPageLayout', 'chooseDestination', 'export']);
const statuses = new Set(['pending', 'success', 'failure', 'cancelled']);
const states = new Set(['Idle', 'AuthPending', 'Preview', 'Ready', 'Capturing', 'NeedsAttention', 'Paused', 'ResumeCheck', 'Review']);
const targetCauses = new Set(['owner_binding_changed', 'initial_already_bound', 'guard_already_bound',
  'initial_invalid', 'initial_page_missing', 'page_closed', 'context_changed', 'browser_disconnected', 'origin_mismatch', 'unclassified',
  'selected_page_changed', 'generation_changed', 'page_set_changed', 'document_changed', 'target_identity_changed',
  'window_identity_changed', 'configuration_changed', 'preview_selection_unavailable', 'expected_identity_changed',
  'identity_not_bound', 'identity_check_unavailable', 'position_changed', 'display_shape_changed', 'position_transition_changed']);
const closed = (set, value) => value == null ? 'unknown' : set.has(value) ? value : 'unclassified';

// A stopped pilot may keep only this closed result on the local control UI.
// Never copy the job, error, raw snapshot or browser data into the stop result.
export function projectPortablePilotStop(outcome) {
  const stop = outcome?.stop, code = closed(stopCodes, stop?.observedCode);
  return { code, stage: closed(stopStages, stop?.observedStage),
    ...(code === 'target_changed' && targetCauses.has(stop?.observedCause) ? { cause: stop.observedCause } : {}),
    images: Number.isSafeInteger(outcome?.images) && outcome.images >= 0 && outcome.images <= 2 ? outcome.images : null,
    sends: Number.isSafeInteger(outcome?.sends) && outcome.sends >= 0 && outcome.sends <= 1 ? outcome.sends : null };
}

function observedFailure(s) {
  // Preserve the more specific failure even when a later generic reason is
  // present. A present but unknown code must not become a different cause.
  const [source, failure] = s.lastFailure ? ['last_failure', s.lastFailure]
    : s.displayInspection?.status === 'failed' ? ['display_inspection', s.displayInspection]
    : s.storageUncertain ? ['storage_uncertain', s.storageUncertain]
    : s.reason != null ? ['reason', { code: s.reason }] : ['unknown', null];
  const cause = failure?.code === 'target_changed' && targetCauses.has(failure?.detail?.cause) ? failure.detail.cause : null;
  const identity = cause === 'expected_identity_changed' ? captureStartupDiagnostic({ startupDiagnostic: failure.detail.identity }) : null;
  return { source, code: closed(stopCodes, failure?.code), stage: closed(stopStages, failure?.stage),
    ...(cause ? { cause } : {}), ...(identity ? { identity } : {}) };
}

export function validatePortableLimitedPilot() {
  if (process.platform !== 'linux' || process.argv.length !== 3 || process.argv[2] !== '--portable-limited-pilot'
      || ownRoot !== installed || process.env.KTZ_PORTABLE_ROOT !== installed
      || process.env.KTZ_USER_DATA_DIR !== path.join(installed, 'data/application')) refuse('invalid_invocation');
  // The selected bundle now uses the reviewed owned OS adapter. Preparation
  // still stops before the user's book/tab/preview approval and separate start.
}

function startup(value) {
  if (!value || value.outcome !== 'failed') return null;
  return {
    stage: stages.has(value.failure?.stage) ? value.failure.stage : 'unclassified',
    code: codes.has(value.failure?.code) ? value.failure.code : 'unclassified',
    initialRejection: portableInitialRejectionReasons.includes(value.initialRejection) ? value.initialRejection : null,
    ...(value.initialRejection === 'origin_mismatch' && portableInitialOriginKinds.includes(value.initialOrigin?.kind)
      && typeof value.initialOrigin?.reachedExpectedOrigin === 'boolean'
      ? { initialOrigin: { kind: value.initialOrigin.kind, reachedExpectedOrigin: value.initialOrigin.reachedExpectedOrigin } } : {}),
  };
}

// Snapshot values needed for internal comparisons are projected immediately;
// neither a raw snapshot nor an exception ever crosses the reporting boundary.
async function observation(app) {
  const s = await app.snapshot();
  const candidates = s.sessions.filter(v => v.saved && v.portableLinuxCandidate && /^saved-[a-f0-9-]{36}$/.test(v.id));
  const budget = app.reader?.ownedSessionGuard?.singleRunBudget?.snapshot() ?? s.portableArchiveResult?.budget;
  return {
    job: Boolean(s.job), id: s.job?.manifest?.job_id ?? null, jobPath: s.job?.job_path ?? null,
    generation: app.bookGeneration, epoch: s.operationRevision,
    sessions: candidates.map(v => v.id), prepared: s.portableKindlePrepared, available: s.portableLimitedAvailable,
    limited: s.portableLimitedJob, busy: s.busy, browser: s.browserOpen, releasePending: s.readerReleasePending,
    recovery: s.recoveryRequired, storage: Boolean(s.storageUncertain), selected: s.readerTabConfirmed,
    preview: s.previewReady, approved: s.previewApproved, state: s.state,
    failed: Boolean(s.lastFailure || s.displayInspection?.status === 'failed'), failure: observedFailure(s),
    startup: startup(s.portableLimitedStartup),
    images: s.job?.manifest?.images?.length ?? 0, exports: s.job?.manifest?.exports?.length ?? 0,
    png: s.job ? s.job.manifest.images.every(image => image.image_format === 'png' && /^originals\/[0-9]{6,}\.png$/.test(image.path)) : true,
    archiveReady: s.portableArchiveEditable === true,
    archiveClosing: s.portableArchiveClosing === true,
    firstDigest: s.job?.manifest?.images?.[0]?.sha256 ?? null,
    previewDigest: app.previewImage ? createHash('sha256').update(app.previewImage).digest('hex') : null,
    progress: { id: typeof s.operationProgress?.id === 'string' && /^[a-f0-9-]{36}$/.test(s.operationProgress.id)
      ? s.operationProgress.id : null,
      action: closed(actions, s.operationProgress?.action), status: closed(statuses, s.operationProgress?.status) },
    budget: budget ? { phase: budget.phase, screenshots: budget.screenshots, sends: budget.sends,
      committed: budget.committed, approved: budget.approved } : null,
  };
}

// Compare only locally. No pixels, titles, paths or archive names leave this
// verifier. The Store remains responsible for non-overwrite publication/CRC.
async function verifyLocalArchive(app) {
  const job = app.job, manifest = job.manifest, record = manifest.exports.at(-1);
  if (!record || !['zip', 'cbz'].includes(record.format) || !record.destination) refuse('state_changed');
  const edited = manifest.images.some(i => i.crop || i.split)
    || JSON.stringify(manifest.selected_capture_ids) !== JSON.stringify(manifest.images.map(i => i.capture_id));
  if (!edited) refuse('state_changed');
  const expected = [];
  for (const id of manifest.selected_capture_ids) {
    const image = manifest.images.find(i => i.capture_id === id);
    if (!image) refuse('state_changed');
    if (image.split) {
      const first = image.split.first_page;
      for (const side of [first, first === 'left' ? 'right' : 'left']) expected.push(await app.image(id, false, side));
    } else expected.push(await app.image(id));
  }
  for (const image of manifest.images) await app.image(image.capture_id, true);
  const h = await open(record.destination, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = await h.stat(), current = await lstat(record.destination);
    if (!privateMetadata(s) || !privateMetadata(current) || s.ino !== current.ino || s.dev !== current.dev
      || s.size !== record.bytes || s.size > 128 * 1024 * 1024) refuse('state_changed');
    const bytes = await h.readFile();
    if (createHash('sha256').update(bytes).digest('hex') !== record.sha256) refuse('state_changed');
    const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (end < 0 || bytes.readUInt16LE(end + 10) !== expected.length || record.entry_count !== expected.length) refuse('state_changed');
    let offset = bytes.readUInt32LE(end + 16);
    for (const [index, image] of expected.entries()) {
      if (bytes.readUInt32LE(offset) !== 0x02014b50 || bytes.readUInt16LE(offset + 10) !== 0) refuse('state_changed');
      const local = bytes.readUInt32LE(offset + 42), size = bytes.readUInt32LE(offset + 24);
      if (bytes.readUInt32LE(local) !== 0x04034b50) refuse('state_changed');
      const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
      const name = bytes.subarray(offset + 46, offset + 46 + bytes.readUInt16LE(offset + 28)).toString('ascii');
      if (name !== `${String(index + 1).padStart(6, '0')}.png` || !bytes.subarray(start, start + size).equals(image)) refuse('state_changed');
      offset += 46 + bytes.readUInt16LE(offset + 28) + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
    }
    return { edited: true, entries: expected.length, format: record.format, originalsMatch: true, orderMatches: true, archiveMatches: true };
  } finally { await h.close(); }
}

export async function runPortableLimitedPilot({ control, app, origin, waiting }) {
  if (!control?.page || !app || entered.has(app) || entered.has(control.page)) refuse('duplicate');
  entered.add(app); entered.add(control.page); // A failed pilot cannot be retried on the same owner.
  const archiveTrial = app.portableArchiveTrial === true;
  const { page, context, browser } = control;
  let pin, id, jobPath, generation, session, last, previewDigest, reader, readerLifecycle, readerContext, guard, budget, stopped;
  const stop = (trigger, value, code) => { stopped = { trigger, value }; refuse(code); };
  const inspectControl = async () => {
    if (page.isClosed() || page.context() !== context || context.browser() !== browser || !browser.isConnected()
        || context.pages().length !== 1 || context.pages()[0] !== page) refuse('control_changed');
    let url;
    try { url = new URL(page.url()); } catch { refuse('control_changed'); }
    if (url.origin !== origin || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/' || url.search)
      refuse('control_changed');
    if (pin && !await pin.evaluate(value => value === document)) refuse('control_changed');
  };
  const current = async () => {
    await inspectControl();
    const value = await observation(app); last = value;
    if (!previewDigest && value.previewDigest) previewDigest = value.previewDigest;
    if (id && (!value.job || value.id !== id || value.jobPath !== jobPath || value.generation !== generation)) refuse('state_changed');
    if (reader) {
      const closing = value.archiveClosing && budget.snapshot().phase === 'finished'
        && (app.reader === reader || !app.reader) && (app.readerLifecycle === readerLifecycle || !app.readerLifecycle);
      const released = !app.reader && readerLifecycle.state === 'closed_confirmed' && budget.snapshot().phase === 'finished'
        && !value.releasePending && !value.recovery && !value.storage;
      if (!closing && !released && (app.reader !== reader || app.readerLifecycle !== readerLifecycle || reader.context !== readerContext
        || !readerContext.browser()?.isConnected() || reader.ownedSessionGuard !== guard || guard.singleRunBudget !== budget)) refuse('owner_unknown');
    }
    return value;
  };
  const ui = async value => {
    const view = await page.evaluate(() => ({ job: document.body.dataset.preparationJob,
      epoch: document.body.dataset.preparationEpoch, generation: document.body.dataset.preparationGeneration, stage: document.body.dataset.preparationStage,
      revision: document.querySelector('#create')?.dataset.preparationRevision,
      source: document.querySelector('#captureSource')?.value, session: document.querySelector('#portableKindleSession')?.value,
      baseEmpty: document.querySelector('#baseDir')?.value === '' }));
    if (view.job !== (value.id ?? '') || view.epoch !== String(value.epoch) || view.generation !== String(value.generation)
        || !/^\d+$/.test(view.revision ?? '')) return null;
    return view;
  };
  const wait = async (predicate, timeout = 30_000, action) => {
    const until = Date.now() + timeout;
    do {
      const value = await current();
      if (predicate(value)) return value;
      if (action && !value.busy && value.progress.action === action && value.progress.status === 'failure')
        stop('operation_failure', value, 'state_changed');
      await pause(100);
    } while (Date.now() < until);
    refuse('operation_timeout');
  };
  const readyUi = async (value, expectedStage) => {
    const until = Date.now() + 15_000;
    do {
      const now = await current();
      if (now.job !== value.job || now.id !== value.id || now.jobPath !== value.jobPath
          || now.epoch !== value.epoch || now.generation !== value.generation || now.busy) refuse('state_changed');
      const view = await ui(now);
      if (view?.stage === expectedStage) return view;
      await pause(100);
    } while (Date.now() < until);
    refuse('operation_timeout');
  };
  const click = async (id, view) => {
    await inspectControl();
    try { await page.locator(`#${id}[data-preparation-revision="${view.revision}"]`).click({ timeout: 5_000 }); }
    catch { refuse('state_changed'); }
  };
  try {
    await inspectControl();
    pin = await page.evaluateHandle(() => document);
    let value = await current();
    if (value.job || value.generation !== 0) refuse('old_job');
    if (value.busy || value.releasePending || value.recovery || value.storage || !value.available) refuse('state_changed');
    if (value.sessions.length !== 1) refuse('session_ambiguous');
    session = value.sessions[0];
    let view = await readyUi(value, 'setup');
    if (!view.baseEmpty) refuse('state_changed');
    await page.locator('#setupOptions > summary').click({ timeout: 5_000 });
    view = await readyUi(value, 'setup');
    await click('create', view);
    value = await wait(v => Boolean(v.job) && !v.busy, 30_000, 'create');
    if (value.generation !== 1 || !/^[a-f0-9]{32}$/.test(value.id ?? '')
        || value.jobPath !== path.join(app.dataDir, 'jobs', value.id)
        || value.images || value.exports || value.limited || !value.available) refuse('state_changed');
    id = value.id; jobPath = value.jobPath; generation = value.generation;
    view = await readyUi(value, 'browser');
    if (value.sessions.length !== 1 || value.sessions[0] !== session) refuse('session_ambiguous');
    await page.locator(`#captureSource[data-preparation-revision="${view.revision}"]`).selectOption('kindle', { timeout: 5_000 });
    value = await current(); view = await readyUi(value, 'browser');
    if (view.source !== 'kindle' || value.sessions.length !== 1 || value.sessions[0] !== session) refuse('state_changed');
    await page.locator(`#portableKindleSession[data-preparation-revision="${view.revision}"]`).selectOption(session, { timeout: 5_000 });
    value = await current(); view = await readyUi(value, 'browser');
    if (view.session !== session || value.prepared || value.sessions.length !== 1 || value.sessions[0] !== session) refuse('state_changed');
    await page.locator('#portablePreparationOptions > summary').click({ timeout: 5_000 });
    view = await readyUi(value, 'browser');
    await click('preparePortableSession', view);
    value = await wait(v => v.prepared === session && !v.busy, 30_000, 'preparePortableKindle');
    view = await readyUi(value, 'browser');
    if (view.source !== 'kindle' || view.session !== session || value.sessions.length !== 1 || value.sessions[0] !== session
        || value.images || value.exports || value.limited || !value.available) refuse('state_changed');
    await click('openPreparedPortable', view);
    value = await wait(v => !v.busy && (v.browser || v.startup || v.releasePending), 90_000, 'openBrowser');
    if (!value.browser || value.startup || value.releasePending || !value.limited || !app.reader?.ownedSessionGuard?.limited) {
      if (value.releasePending) stop('reader_release_pending', value, 'owner_unknown');
      stop('startup_failure', value, 'stopped');
    }
    reader = app.reader; readerLifecycle = app.readerLifecycle; readerContext = reader.context;
    guard = reader.ownedSessionGuard; budget = guard.singleRunBudget;
    if (value.selected || value.preview || value.approved || value.images || value.exports || value.budget?.phase !== 'preview') refuse('state_changed');
    waiting?.({ stage: 'waiting', code: 'user_action_required', images: 0, sends: 0, sameJob: true });
    // Observations do not move the workflow. In particular there is no timer
    // which approves, starts, chooses a tab, or finishes the user's wait.
    let postprocess = false;
    for (;;) {
      value = await current();
      if (value.releasePending || value.recovery || value.storage) stop(value.releasePending ? 'reader_release_pending'
        : value.recovery ? 'recovery_required' : 'storage_uncertain', value, 'owner_unknown');
      if (!value.browser && !value.archiveReady && !value.busy || value.failed || value.budget?.phase === 'failed') stop(!value.browser ? 'browser_closed'
        : value.failed ? 'application_failure' : 'budget_failed', value, 'stopped');
      if (value.images > 2 || value.exports && !value.archiveReady || value.budget?.sends > 1 || !value.png) refuse('state_changed');
      if (!value.busy && value.state === 'Review' && value.budget?.phase === 'finished' && (!archiveTrial || value.archiveReady)) {
        if (value.images < 1 || value.images !== value.budget.committed || value.images !== value.budget.screenshots
            || value.budget.sends !== value.images - 1 || ![1, 2].includes(value.budget.approved)
            || value.images > value.budget.approved) refuse('state_changed');
        if (!archiveTrial) return { stage: 'review', code: 'completed', images: value.images, sends: value.budget.sends,
          sameJob: true, sameReader: true, png: value.png, exports: value.exports, initialRejection: null,
          previewMatches: previewDigest && value.firstDigest ? previewDigest === value.firstDigest : null };
        if (!postprocess) {
          postprocess = true;
          waiting?.({ stage: 'postprocess', code: 'user_action_required', images: value.images, sends: value.budget.sends,
            readerClosed: true, previewMatches: previewDigest === value.firstDigest });
        }
        if (value.exports) {
          const archive = await verifyLocalArchive(app);
          return { stage: 'archive', code: 'completed', images: value.images, sends: value.budget.sends,
            sameJob: true, sameReader: true, png: value.png, exports: value.exports, initialRejection: null,
            previewMatches: previewDigest && value.firstDigest ? previewDigest === value.firstDigest : null, ...archive };
        }
      }
      if (postprocess && !value.busy && value.progress.action === 'export' && value.progress.status === 'failure') stop('operation_failure', value, 'operation_failed');
      await pause(200);
    }
  } catch (error) {
    // Even the failed snapshot is not logged. Preserve the first durable
    // startup classification, not a later UI error or shutdown exception.
    let refreshed;
    try { refreshed = await observation(app); last = refreshed; } catch { /* unknown remains unknown */ }
    const sameJob = value => Boolean(id && value?.job && value.id === id && value.jobPath === jobPath && value.generation === generation);
    // The triggering observation wins. An asynchronous budget failure can be
    // visible just before its same action publishes a failure reason; use the
    // immediate later snapshot only when job and operation identity match.
    let observed = stopped?.value ?? (sameJob(refreshed) ? refreshed : null);
    let observedAt = stopped ? 'trigger' : observed ? 'after_trigger' : 'unknown';
    if (stopped?.trigger === 'budget_failed' && observed.failure.source === 'unknown' && sameJob(observed) && sameJob(refreshed)
        && ['preview', 'quickPreview', 'approve', 'start'].includes(observed.progress.action)
        && observed.progress.status === 'pending' && observed.progress.id !== null && refreshed.progress.id === observed.progress.id
        && refreshed.progress.action === observed.progress.action
        && refreshed.progress.status === 'failure' && refreshed.failure.source !== 'unknown') {
      observed = refreshed; observedAt = 'after_trigger';
    }
    const failure = observed?.failure ?? { source: 'unknown', code: 'unknown', stage: 'unknown' };
    return { stage: 'stopped', code: pilotCodes.has(error?.pilotCode) ? error.pilotCode : 'unclassified',
      startup: last?.startup ?? null, images: last?.images ?? 0, sends: last?.budget?.sends ?? 0,
      sameJob: sameJob(last), stop: { trigger: stopped?.trigger ?? (pilotCodes.has(error?.pilotCode) ? 'pilot_refusal' : 'exception'),
        observedAt, observedSource: failure.source, observedCode: failure.code, observedStage: failure.stage,
        ...(failure.cause ? { observedCause: failure.cause } : {}), ...(failure.identity ? { identityDiagnostic: failure.identity } : {}),
        state: closed(states, observed?.state), action: observed?.progress.action ?? 'unknown',
        actionStatus: observed?.progress.status ?? 'unknown' } };
  } finally { await pin?.dispose().catch(() => {}); }
}
