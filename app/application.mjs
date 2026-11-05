import { randomUUID, createHash } from 'node:crypto';
import { readFile, readdir, lstat, rm, realpath, statfs } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StoreClient, AppError } from './store-client.mjs';
import { Reader, sampleConfig } from './reader.mjs';
import { startFixture } from '../poc/browser/fixture-server.mjs';
import { sessionId, readSessionPreferences, saveSessionPreference, forgetSessionPreference } from './session-preference.mjs';
import { initialPresets, readPresets, savePresets } from './presets.mjs';
import { bookFilename } from './export-name.mjs';
import { chooseSaveDestination, saveDialogAvailable } from './save-dialog.mjs';
import { kindleRegion, kindleRegions } from './stores/kindle.mjs';
import { samePath, privateMetadata } from './private-path.mjs';
import { startOwnedSample, startOwnedPipeSample, startOwnedGuiSample } from './owned-sample.mjs';
import { portableLinuxSessionProtected, portableLinuxSessionCandidate, resolveExistingPortableLinuxSession } from './portable-linux-session.mjs';
import { portableLimitedAvailable, portableNormalAvailable } from './portable-linux-site.mjs';
import { startPortableKindleReader } from './portable-linux-reader.mjs';
import { portableLimitedClaimState, portableLimitedOriginClaimState, assertPortableLimitedSettings } from './portable-limited-claim.mjs';
import { readPortableStartupRecord } from './portable-limited-failure.mjs';
import { projectPortablePilotStop } from './portable-limited-pilot.mjs';
import { reservePortableArchive, bindPortableArchiveJob, bindPortableArchiveSession,
  portableArchiveAvailable, recordPortableArchiveCapture, releasePortableArchive, portableArchiveEditable } from './portable-postprocess-ticket.mjs';
import { isNormalCaptureBudget } from './expected-capture-budget.mjs';
import { markPortableNormalJob, bindPortableNormalJob, assertPortableNormalJob,
  readPortableNormalResult, beginPortableNormalResult, finishPortableNormalResult } from './portable-normal-job.mjs';
import { isPortableNormalGuard } from './portable-limited-session.mjs';

const defaultData = process.env.KTZ_USER_DATA_DIR || fileURLToPath(new URL('../artifacts/mvp-data/', import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// Conservative per-run safety ceilings, not a claim about total book size.
// Storage is checked on the actual job filesystem; an unavailable check fails
// closed. A stopped job retains its originals and existing checkpoint.
const normalRunMilliseconds = 2 * 60 * 60 * 1000;
const normalJobBytes = 2 * 1024 * 1024 * 1024;
const normalFreeBytes = 256 * 1024 * 1024;

function captureLimit(value = null) {
  if (value !== null && (!Number.isSafeInteger(value) || value < 1)) throw new AppError('invalid_capture_limit');
  return value;
}

export class Application {
  constructor({ dataDir = defaultData, sampleHeadless = true, ownedSampleHeaded = false, ownedSamplePipe = false, sampleFixture = 'reader', saveDialog = chooseSaveDestination, ownsSignals = false, portableArchiveTrial = false } = {}) {
    this.saveDialog = saveDialog;
    this.kindleRegion = 'jp';
    if (!['reader', 'image-review', 'layout', 'kindle-chrome', 'kindle-chrome-dynamic', 'kindle-chrome-hidden', 'kindle-chrome-recoverable', 'kindle-chrome-tabs', 'kindle-chrome-ambiguous'].includes(sampleFixture)) throw new AppError('invalid_sample_fixture');
    this.dataDir = path.resolve(dataDir);
    this.sampleHeadless = process.platform === 'linux' ? true : sampleHeadless;
    Object.defineProperty(this, 'ownedSampleHeaded', { value: process.platform === 'linux' && ownedSampleHeaded === true });
    Object.defineProperty(this, 'ownedSamplePipe', { value: process.platform === 'linux' && ownedSamplePipe === true });
    this.ownsSignals = ownsSignals;
    this.portableArchiveTrial = portableArchiveTrial === true;
    this.sampleFixture = sampleFixture;
    this.store = new StoreClient();
    this.state = 'Idle';
    this.reason = null;
    this.epoch = 0;
    this.bookGeneration = 0;
    this.commands = new Set();
    this.store.listeners.add(() => this.invalidate('store_disconnected'));
    this.store.errorListeners.add(error => this.observeStorageError(error));
  }

  observeStorageError(error) {
    if (!['storage_durability_uncertain', 'storage_reopen_required', 'output_path_changed', 'output_published_durability_uncertain',
      'output_published_manifest_update_failed', 'output_published_manifest_durability_uncertain'].includes(error.code)) return;
    if (!this.storageUncertain) this.storageUncertain = { code: error.code, destination: this.pendingExportDestination ?? null };
    this.invalidate(error.code);
    if (this.job) this.state = 'NeedsAttention';
  }

  async init() {
    try { await lstat(this.dataDir); }
    catch (e) {
      if (e.code !== 'ENOENT') throw new AppError('data_directory_unavailable');
      await this.store.call('create_session_directory', { path: this.dataDir });
    }
    await this.store.call('lock_data_directory', { path: this.dataDir });
    const preferences = await readSessionPreferences(this.dataDir);
    this.preferredKindleSession = preferences.session;
    this.savedTemporarySessions = new Set(preferences.savedTemporarySessions);
    this.presets = await readPresets(this.dataDir);
    return this;
  }

  invalidate(reason, { inspecting = false } = {}) {
    // Reader/Store invalidation cancels the loop before its catch runs. Retain
    // the first cause for this acquisition instead of reporting it as a user
    // cancellation (or losing it when shutdown clears the current UI reason).
    if (this.state === 'Capturing' && reason && !this.captureCancelReason) this.captureCancelReason = reason;
    this.epoch += 1;
    this.reader?.ownedSessionGuard?.singleRunBudget?.invalidate?.();
    this.previewImage = null;
    this.previewInfo = null;
    this.previewBook = null;
    this.previewNormalGuard = null;
    this.previewNormalBudget = null;
    this.previewApproved = false;
    this.approvedMaxCaptures = null;
    this.approvedNormalGuard = null;
    this.approvedNormalBudget = null;
    this.resumePlan = null;
    this.displayInspection = inspecting ? { status: 'checking' } : null;
    if (this.state === 'Capturing') this.state = 'NeedsAttention';
    else if (['Preview', 'Ready'].includes(this.state)) this.state = 'AuthPending';
    this.reason = reason;
  }

  async snapshot() {
    // A fixed stop display never queries the Reader or Store again, including
    // when either resource's close was unconfirmed. It grants no new command.
    if (this.portablePilotStop) return {
      portablePilotStop: this.portablePilotStop, state: this.state, job: this.job ?? null,
      operationRevision: this.epoch, bookGeneration: this.bookGeneration,
      busy: false, browserOpen: Boolean(this.reader), readerReleasePending: Boolean(this.readerReleasePending),
      previewReady: false, previewApproved: false, sessions: [],
    };
    const job = this.job;
    // A poll during close must not query an already closed Rust job. Retain
    // the last confirmed snapshot until close succeeds; a close failure keeps
    // the original job rather than publishing a fictional empty workspace.
    if (job && !this.closingJob && !this.store.failed) {
      const progress = await this.store.call('job_progress');
      if (this.job === job) job.manifest = progress.manifest;
    }
    const entries = await readdir(this.dataDir, { withFileTypes: true });
    const limited = job ? await this.isPortableLimitedJob() : false;
    const limitedSite = portableLimitedAvailable(this.dataDir);
    const editable = limited && await this.canPortableArchiveEdit();
    return {
      state: this.state, reason: this.reason, job: this.job ?? null, operationRevision: this.epoch, bookGeneration: this.bookGeneration,
      presets: this.presets,
      browserOpen: Boolean(this.reader), previewReady: Boolean(this.previewImage), previewApproved: this.previewApproved === true,
      approvedMaxCaptures: this.previewApproved ? this.approvedMaxCaptures : null,
      sessions: await Promise.all(entries.filter(e => e.isDirectory() && sessionId.test(e.name)).map(async e => ({
        id: e.name, saved: e.name.startsWith('saved-') || this.savedTemporarySessions.has(e.name),
        ...(await portableLinuxSessionProtected(path.join(this.dataDir, e.name)) ? { protectedLinuxSession: true } : {}),
        ...(await portableLinuxSessionCandidate(path.join(this.dataDir, e.name)) ? { portableLinuxCandidate: true } : {}),
      }))),
      preferredKindleSession: this.preferredKindleSession ?? null,
      portableKindlePrepared: this.portableKindlePrepared ?? null,
      portableLimitedAvailable: limitedSite && !limited && await portableArchiveAvailable(this.dataDir, job, this.portableArchiveTrial), portableLimitedJob: limited,
      portableNormalAvailable: portableNormalAvailable(this.dataDir) && !this.portableArchiveTrial && !limited,
      portableNormalReader: this.fixture?.normal === true,
      portableArchiveEditable: editable,
      portableArchiveClosing: Boolean(this.portableArchiveClosing),
      portableArchiveResult: this.portableArchiveResult ?? null,
      // Consumption belongs to the current job, including a failed zero-image attempt.
      portableLimitedConsumed: limited,
      portableLimitedStartup: limited ? this.portableStartupRecord?.jobId === job.manifest.job_id
        && this.portableStartupRecord.data === path.dirname(path.dirname(job.job_path))
        ? this.portableStartupRecord.snapshot() : await readPortableStartupRecord(path.dirname(path.dirname(job.job_path)), job.manifest.job_id) : null,
      kindleRegion: this.kindleRegion, kindleRegions,
      kindleSupported: process.platform !== 'linux',
      linuxOwnedSourceAvailable: process.platform === 'linux',
      ownedSampleHeaded: this.ownedSampleHeaded,
      ownedSamplePipe: this.ownedSamplePipe, finiteCaptureRequired: Boolean(this.reader?.ownedSessionGuard?.normal !== true &&
        (this.reader?.ownedPipe || this.reader?.ownedSessionGuard?.singleRunBudget)),
      portableNormalResult: job ? this.portableNormalResultUncertainJob === job.manifest.job_id
        ? { status: 'unknown', mode: null, limit: null, reason: null, stage: null, dispatch: null }
        : await readPortableNormalResult(this.dataDir, job) : null,
      saveDialogAvailable: this.saveDialog !== chooseSaveDestination || saveDialogAvailable(),
      pathCaseSensitive: process.platform !== 'win32',
      storageUncertain: this.storageUncertain ?? null,
      sample: Boolean(this.fixture) && !this.fixture.limited && !this.fixture.normal, config: this.reader?.sampleUrl ? sampleConfig : null,
      pickerStage: this.reader?.pickStage ?? null,
      browserId: this.reader?.id ?? null,
      readerTabs: this.reader?.tabs() ?? [],
      selectedReaderTab: this.reader?.selectedTabId() ?? null,
      readerTabRevision: this.reader?.tabRevision ?? 0,
      mappings: this.reader?.selections ?? {},
      mappingRevision: this.reader?.mappingRevision ?? 0,
      selectionFailure: this.reader?.selectionFailure ?? null,
      displayInspection: this.displayInspection ?? null,
      readerCandidateAvailable: Boolean(this.reader?.readerCandidate),
      pickingField: this.reader?.pickField ?? null,
      readerTabConfirmed: Boolean(this.reader?.explicitPage && this.reader.selectedTabId() === this.reader.pageLabels.get(this.reader.explicitPage)?.id),
      captureSettings: job?.manifest.capture_settings ?? { capture_scale: 1, page_output_mode: 'single_image', reading_direction: 'right_to_left', image_format: 'png', jpeg_quality: 85 },
      previewInfo: this.previewInfo ?? null,
      resumePlan: this.resumePlan ?? null,
      busy: Boolean(this.busy || this.loop || this.endingBook || this.destinationDialog),
      activeOperation: this.destinationDialog ? 'chooseDestination' : this.activeOperation ?? null,
      operationProgress: this.progress ?? null,
      endingBook: Boolean(this.endingBook),
      recoveryRequired: Boolean(this.quiescenceRequired),
      readerReleasePending: Boolean(this.readerReleasePending),
      lastFailure: this.lastFailure ?? null,
      suggestedDestination: this.job ? path.join(this.job.job_path, bookFilename(this.job.manifest.images.length
        ? this.job.manifest.images[0].book?.title : this.previewImage ? this.previewBook?.title : null)) : '',
    };
  }

  // Only completed, observable stages advance this value. No clock-based work
  // estimates, book labels or paths are included in the progress channel.
  beginProgress(action, key, total = 2, unit = '処理工程') {
    return this.progress = { id: randomUUID(), key: typeof key === 'string' && /^[a-f0-9-]{36}$/.test(key) ? key : null, action, done: 0, total, unit,
      status: 'pending', detail: '処理の応答待ち（完了工程だけを計測）' };
  }
  advanceProgress(progress, done, detail) {
    if (!progress || this.progress !== progress || progress.status !== 'pending') return;
    if (progress.total !== null) progress.done = Math.min(progress.total - 1, Math.max(progress.done, done));
    progress.detail = detail;
  }
  async trackOperation(action, callback, key) {
    const totals = { preview: 4, quickPreview: 4, openBrowser: 5, export: 3,
      resetImages: 3, chooseDestination: 3, finishBook: 6, pickAll: 5 };
    const progress = this.beginProgress(action, key, action === 'export' || action === 'start' ? null : totals[action] ?? 1);
    try {
      const result = await callback(progress);
      if (this.progress === progress) {
        progress.status = result?.chosenDestination === null ? 'cancelled' : 'success';
        if (progress.status === 'success') { progress.total ??= 1; progress.done = progress.total; }
        progress.detail = progress.status === 'success' ? '処理完了' : '選択を取り消しました';
      }
      return result;
    } catch (error) {
      if (this.progress === progress) {
        progress.status = ['cancelled', 'picker_cancelled'].includes(error.code) ? 'cancelled' : 'failure';
        progress.detail = progress.status === 'cancelled' ? '取消済み' : '失敗・進行を停止しました';
      }
      throw error;
    }
  }

  async exclusive(actionName, action, progressKey) {
    if (this.endingBook || this.quiescenceRequired || this.busy || this.loop || this.destinationDialog) {
      throw new AppError(this.quiescenceRequired ? 'safe_stop_incomplete' : 'operation_busy');
    }
    if (this.readerReleasePending && !['review', 'crop', 'resetCrop', 'detectCrop', 'applyAutoCrop', 'export', 'closeBrowser'].includes(actionName)) {
      throw new AppError('reader_release_incomplete');
    }
    this.busy = true;
    this.activeOperation = actionName;
    let result;
    try { result = await this.trackOperation(actionName, action, progressKey); }
    finally { this.busy = false; this.activeOperation = null; }
    if (result && typeof result === 'object') result.busy = Boolean(this.loop);
    return result;
  }

  async command(action, input = {}) {
    if (this.closed) throw new AppError('application_closed');
    if (this.portablePilotStop) throw new AppError('portable_limited_review_only');
    const inspecting = ['preview', 'quickPreview'].includes(action);
    // Report only completed inspection evidence, never infer login success
    // from a selected tab or from four non-empty selectors.
    if (!this.busy && ['preview', 'quickPreview', 'pick', 'pickAll', 'expandReader', 'selectReaderTab', 'closeBrowser'].includes(action)) {
      this.displayInspection = inspecting ? { status: 'checking' } : null;
    }
    const pending = this.dispatchCommand(action, input);
    this.commands.add(pending);
    try {
      const result = await pending;
      return { ...result, displayInspection: this.displayInspection ?? null };
    } catch (error) {
      if (inspecting && this.displayInspection?.status === 'checking' && error.code !== 'operation_busy') {
        this.reader?.ownedSessionGuard?.singleRunBudget?.fail();
        this.displayInspection = { status: 'failed', code: error.code ?? 'operation_failed', detail: error.detail ?? null,
          stage: ['auto_visibility_wait', 'preview_visibility_wait', 'reader_target_check'].includes(error.stage) ? error.stage : 'preview_inspection' };
      }
      throw error;
    }
    finally { this.commands.delete(pending); }
  }

  async enforcePortableLimitedCommand(action, input) {
    // The ticket's newly created job cannot enter a generic sample Reader or
    // reset/settings path before its unchanged limited claim has been created.
    if (this.job && this.portableArchiveJob === this.job.manifest.job_id && !await this.isPortableLimitedJob()) {
      const preparation = ['preparePortableKindle', 'openBrowser', 'closeBrowser', 'closeJob', 'finishBook'];
      if (!preparation.includes(action) || action === 'openBrowser' && input.mode !== 'kindle')
        throw new AppError('portable_postprocess_unavailable');
    }
    if (!['closeBrowser', 'closeJob', 'finishBook', 'stop', 'pause'].includes(action) && await this.isPortableLimitedJob()) {
      const allowed = ['selectReaderTab', 'preview', 'quickPreview', 'approve', 'start', 'closeBrowser', 'closeJob', 'finishBook', 'review', 'pause', 'stop', 'cancelBack', 'cancelPick'];
      const editing = ['review', 'crop', 'resetCrop', 'detectCrop', 'applyAutoCrop', 'setPageLayout', 'chooseDestination', 'export'].includes(action);
      const editable = editing && await this.canPortableArchiveEdit();
      if ((!allowed.includes(action) || action === 'review' && input.ids !== undefined) && !editable)
        throw new AppError('portable_limited_review_only');
      if (editable) {
        this.job = (await this.store.call('job_info')).snapshot;
        if (!await this.canPortableArchiveEdit()) throw new AppError('portable_postprocess_unavailable');
        for (const image of this.job.manifest.images) await this.image(image.capture_id, true);
      }
      if (['preview', 'quickPreview', 'approve', 'start'].includes(action)) {
        if (!this.reader?.ownedSessionGuard?.limited) throw new AppError('portable_limited_claim_consumed');
        assertPortableLimitedSettings(this.job);
      }
    }
  }

  async dispatchCommand(action, input) {
    if (this.portablePilotStop) throw new AppError('portable_limited_review_only');
    // Rust freezes the job after uncertain durability. Also prevent Node-owned
    // settings/session mutations and new browser or capture operations.
    if (this.storageUncertain && action !== 'closeBrowser') throw new AppError('storage_reopen_required');
    if (['cancelBack', 'finishBook', 'closeJob'].includes(action)) this.destinationDialog?.abort();
    if (action === 'chooseDestination') return this.chooseDestination(input);
    // Cancellation is observed locally before any queued Rust request.
    if (action === 'pause' || action === 'stop') return this.trackOperation(action, () => this.cancel(action), input.progressKey);
    if (action === 'cancelBack') return this.trackOperation(action, () => this.cancelBack(), input.progressKey);
    if (action === 'finishBook') return this.trackOperation(action, p => this.finishBook(p), input.progressKey);
    if (action === 'cancelPick') return this.trackOperation(action, async () => { this.selectionCancelEpoch = (this.selectionCancelEpoch ?? 0) + 1; await this.reader?.cancelPick(); return this.snapshot(); }, input.progressKey);
    return this.exclusive(action, async progress => {
      // Hold the Application exclusion while awaiting the durable claim check.
      // Otherwise a concurrently completed connect could arm a limited job
      // after a caller's stale "unused" result but before its export/settings.
      await this.enforcePortableLimitedCommand(action, input);
      if (this.portablePilotStop) throw new AppError('portable_limited_review_only');
      // Optional optimistic fence for the individual preparation controls. It
      // only narrows an existing action; ordinary public callers remain valid.
      const checkPreparationState = () => {
        if (input.ifState === undefined) return;
        const expected = input.ifState;
        if (!['create', 'preparePortableKindle', 'openBrowser'].includes(action) || !expected
            || Object.keys(expected).sort().join(',') !== 'epoch,generation,job'
            || expected.job !== (this.job?.manifest?.job_id ?? null)
            || expected.epoch !== this.epoch || expected.generation !== this.bookGeneration)
          throw new AppError('target_changed');
      };
      checkPreparationState();
      let lastExport = null;
      switch (action) {
        case 'setKindleRegion': {
          const region = kindleRegion(input.id);
          if (this.reader) throw new AppError('close_browser_first');
          if (this.kindleRegion !== region.id) {
            this.kindleRegion = region.id;
            this.portableKindlePrepared = null;
            this.invalidate('kindle_region_changed');
          }
          break;
        }
        case 'preparePortableKindle': {
          if (process.platform !== 'linux' || Object.keys(input).some(key => !['session', 'progressKey', 'language', 'ifState'].includes(key))
            || input.language !== undefined && !['ja', 'en', 'zh-CN'].includes(input.language)) throw new AppError('invalid_browser_mode');
          if (this.reader || !this.job) throw new AppError('browser_or_job_state');
          this.portableKindlePrepared = null;
          const selected = await this.resolvePortableKindle(input.session);
          checkPreparationState();
          if (this.portableArchiveJob === this.job.manifest.job_id) await bindPortableArchiveSession(this.dataDir, this.job, selected.id);
          this.portableKindlePrepared = selected.id;
          break;
        }
        case 'cancelReset': {
          if (this.resetConfirmation?.token === input.token) this.resetConfirmation = null;
          break;
        }
        case 'prepareReset': {
          if (!this.job || this.pending || this.readerReleasePending) throw new AppError('safe_stop_incomplete');
          const progress = await this.store.call('job_progress');
          this.job.manifest = progress.manifest;
          this.resetConfirmation = { token: randomUUID(), job: this.job, epoch: this.epoch,
            generation: this.bookGeneration, manifest: JSON.stringify(progress.manifest) };
          return { ...await this.snapshot(), resetToken: this.resetConfirmation.token };
        }
        case 'resetImages': {
          const confirmation = this.resetConfirmation;
          this.resetConfirmation = null;
          const current = await this.store.call('job_progress');
          if (input.confirmed !== true || !confirmation || input.token !== confirmation.token
            || confirmation.job !== this.job || confirmation.epoch !== this.epoch || confirmation.generation !== this.bookGeneration
            || confirmation.manifest !== JSON.stringify(current.manifest) || this.pending || this.readerReleasePending) throw new AppError('reset_confirmation_expired');
          this.bookGeneration += 1;
          this.invalidate(null);
          this.previewPosition = null;
          this.lastFailure = null;
          this.advanceProgress(progress, 1, '確認完了。取得画像と関連状態の整合リセット待ち');
          try { this.job = (await this.store.call('reset_images')).snapshot; }
          finally {
            // Even partial cleanup has a durable empty-manifest journal. Refresh
            // without reading pixels so missing old images never remain current.
            this.job.manifest = (await this.store.call('job_progress')).manifest;
            this.state = 'AuthPending';
          }
          break;
        }
        case 'addKindlePreset': {
          const preset = initialPresets().presets.find(p => p.id === 'kindle-reader-chrome');
          // Explicit opt-in for older saved lists; never replace a user's id,
          // definition, selection or in-progress mapping edit.
          if (!this.presets.presets.some(p => p.id === preset.id)) {
            this.presets = await savePresets(this.dataDir, { ...this.presets, presets: [...this.presets.presets, preset] });
          }
          break;
        }
        case 'savePreset': {
          const previous = this.presets;
          const preset = { id: input.id || randomUUID(), name: input.name, mode: input.mode, config: input.mode === 'selectors' ? input.config : null };
          const exists = previous.presets.some(p => p.id === preset.id);
          this.invalidate('preset_changed');
          this.reader?.invalidateOutputSettings();
          this.presets = await savePresets(this.dataDir, { version: 1, selected: preset.id,
            presets: exists ? previous.presets.map(p => p.id === preset.id ? preset : p) : [...previous.presets, preset] });
          break;
        }
        case 'selectPreset': {
          this.invalidate('preset_changed');
          this.reader?.invalidateOutputSettings();
          this.presets = await savePresets(this.dataDir, { ...this.presets, selected: input.id });
          break;
        }
        case 'create': {
          if (this.job) throw new AppError('close_job_first');
          const archiveTrial = this.portableArchiveTrial && portableLimitedAvailable(this.dataDir);
          if (archiveTrial) {
            if (input.baseDir && path.resolve(input.baseDir) !== this.dataDir) throw new AppError('portable_postprocess_unavailable');
            await reservePortableArchive(this.dataDir);
          }
          this.job = (await this.store.call('create_job', { base_dir: path.resolve(input.baseDir || this.dataDir) })).snapshot;
          if (archiveTrial) {
            this.portableArchiveJob = this.job.manifest.job_id;
            await bindPortableArchiveJob(this.dataDir, this.job);
          } else if (portableNormalAvailable(this.dataDir) && this.job.job_path === path.join(this.dataDir, 'jobs', this.job.manifest.job_id)) {
            await markPortableNormalJob(this.dataDir, this.job);
          }
          this.bookGeneration += 1;
          this.state = 'AuthPending';
          this.reason = null;
          this.lastFailure = null;
          this.readerReleasePending = false;
          this.quiescenceRequired = false;
          break;
        }
        case 'recover': {
          if (this.job) throw new AppError('close_job_first');
          this.job = (await this.store.call('open_job', { path: path.resolve(input.path) })).snapshot;
          this.bookGeneration += 1;
          this.state = 'ResumeCheck';
          this.lastFailure = null;
          this.readerReleasePending = false;
          this.quiescenceRequired = false;
          this.invalidate('manual_target_and_position_confirmation_required');
          break;
        }
        case 'closeJob': {
          if (this.reader) throw new AppError('close_browser_first');
          this.closingJob = true;
          try {
            await this.store.call('close_job');
            this.job = null;
            this.pending = false;
            this.bookGeneration += 1;
            this.state = 'Idle';
            this.invalidate(null);
          } finally { this.closingJob = false; }
          break;
        }
        case 'openBrowser': {
          if (!['sample', 'kindle', 'sample-headed', 'sample-owned-pipe', 'owned-fixture'].includes(input.mode)) throw new AppError('invalid_browser_mode');
          const portableKindle = process.platform === 'linux' && input.mode === 'kindle';
          if (portableKindle) {
            if (this.portableArchiveTrial && portableLimitedAvailable(this.dataDir) && this.portableArchiveJob !== this.job?.manifest.job_id)
              throw new AppError('portable_postprocess_unavailable');
            if (Object.keys(input).some(key => !['mode', 'session', 'progressKey', 'language', 'ifState'].includes(key))
              || input.language !== undefined && !['ja', 'en', 'zh-CN'].includes(input.language)) throw new AppError('invalid_browser_mode');
            if (this.reader || !this.job) throw new AppError('browser_or_job_state');
            if (this.readerLifecycle?.state === 'close_unconfirmed') throw new AppError('reader_release_incomplete');
            if (this.profile || this.fixture) throw new AppError('close_browser_first');
            // Preparation is not a reservation. Resolve the same explicit ID
            // again; the child independently takes the login owner's lock.
            const selected = await this.resolvePortableKindle(input.session);
            checkPreparationState();
            this.job = (await this.store.call('job_info')).snapshot;
            checkPreparationState();
            const normal = portableNormalAvailable(this.dataDir) && !this.portableArchiveTrial;
            if (!normal && !portableLimitedAvailable(this.dataDir)) throw new AppError('linux_kindle_permission_required');
            let normalJobCheck = null, capability;
            if (normal) {
              const jobId = this.job.manifest.job_id, jobPath = this.job.job_path, generation = this.bookGeneration;
              await bindPortableNormalJob(this.dataDir, this.job, selected.id);
              this.portableNormalSession = selected.id;
              normalJobCheck = async () => {
                if (this.bookGeneration !== generation || this.job?.manifest?.job_id !== jobId || this.job.job_path !== jobPath
                    || capability && this.fixture !== capability) throw new AppError('target_changed');
                const current = (await this.store.call('job_binding')).binding;
                if (current.manifest.job_id !== jobId || current.job_path !== jobPath) throw new AppError('target_changed');
                await assertPortableNormalJob(this.dataDir, current, selected.id);
              };
            }
            this.profile = selected.profile;
            this.profilePersistent = true;
            this.ownedPipeFixture = true;
            this.readerLifecycle = { profile: selected.profile, state: 'starting' };
            try {
              this.fixture = await startPortableKindleReader(selected, this.job, checkPreparationState, normalJobCheck);
              capability = this.fixture;
              this.reader = await Reader.open({ profile: selected.profile, ownedSession: this.fixture,
                regionId: this.kindleRegion, lifecycle: this.readerLifecycle, handleSignals: false,
                onChange: () => this.invalidate('browser_target_changed'), readGuard: null });
              this.assertNormalReaderBinding();
              await this.reader.setCaptureScale(this.job.manifest.capture_settings.capture_scale);
              this.reader.imageFormat = this.job.manifest.capture_settings.image_format;
              this.reader.jpegQuality = this.job.manifest.capture_settings.jpeg_quality;
              this.state = this.job.manifest.images.length ? 'ResumeCheck' : 'AuthPending';
              this.reason = null;
            } catch (error) {
              if (this.readerLifecycle.state === 'starting') {
                this.readerLifecycle.state = error.portableReaderNotStarted || error.portableReaderClosed
                  ? 'closed_confirmed' : 'close_unconfirmed';
                if (this.readerLifecycle.state === 'close_unconfirmed') this.readerLifecycle.failure = error;
              }
              let closeError;
              if (this.readerLifecycle.state === 'close_unconfirmed') this.readerReleasePending = true;
              else try { await this.closeBrowser(); } catch (failure) { closeError = failure; }
              const failure = new AppError('browser_open_failed');
              failure.cause = closeError ? new AggregateError([error, closeError], 'browser_open_and_close_failed', { cause: error }) : error;
              throw failure;
            }
            break;
          }
          const ownedHeaded = input.mode === 'sample-headed';
          const guiOwned = input.mode === 'owned-fixture';
          const ownedPipe = input.mode === 'sample-owned-pipe' || guiOwned;
          if (ownedHeaded && (!this.ownedSampleHeaded || input.keep || input.session || input.sampleFixture)) throw new AppError('invalid_browser_mode');
          if (ownedPipe && (process.platform !== 'linux' || !guiOwned && !this.ownedSamplePipe || Object.keys(input).some(key => !['mode', 'progressKey', 'language'].includes(key))
            || input.language !== undefined && !['ja', 'en', 'zh-CN'].includes(input.language))) throw new AppError('invalid_browser_mode');
          if (this.reader || !this.job) throw new AppError('browser_or_job_state');
          // Dispose only a previously confirmed-safe failed attempt before
          // assigning a new profile. An unknown attempt is never overwritten.
          if (this.readerLifecycle?.state === 'close_unconfirmed') throw new AppError('reader_release_incomplete');
          const sampleFixture = input.sampleFixture ?? this.sampleFixture;
          if (input.mode === 'sample' && !['reader', 'image-review', 'layout', 'kindle-chrome', 'kindle-chrome-dynamic', 'kindle-chrome-hidden', 'kindle-chrome-recoverable', 'kindle-chrome-tabs', 'kindle-chrome-ambiguous'].includes(sampleFixture)) throw new AppError('invalid_sample_fixture');
          // Reject a different owner's layout before closing or changing any
          // previous Application profile/fixture. Recheck at actual acquisition.
          if (typeof input.session === 'string' && sessionId.test(input.session)) {
            await this.ensureGenericSession(path.join(this.dataDir, input.session));
          }
          if (this.profile || this.fixture) {
            const retainProfile = typeof input.session === 'string' && sessionId.test(input.session)
              && this.profile && path.basename(this.profile) === input.session;
            await this.closeBrowser({ retainProfile });
          }
          const keep = input.keep === true || input.mode === 'kindle' && input.keep !== false;
          let selected = input.session;
          if (!selected && input.mode === 'kindle' && keep) {
            const sessions = (await this.snapshot()).sessions;
            selected = sessions.find(item => item.id === this.preferredKindleSession)?.id;
            if (!selected) {
              const saved = sessions.filter(item => item.saved);
              if (saved.length > 1) throw new AppError('select_saved_session');
              selected = saved[0]?.id;
            }
          }
          let profile;
          if (ownedPipe) {
            profile = null; // The detached owner alone creates the fresh profile.
          } else if (selected && selected !== 'new') {
            if (!sessionId.test(selected)) throw new AppError('invalid_session');
            profile = path.join(this.dataDir, selected);
            await this.ensureGenericSession(profile);
          } else {
            profile = path.join(this.dataDir, `${keep ? 'saved' : 'temporary'}-${randomUUID()}`);
            await this.store.call('create_session_directory', { path: profile });
          }
          this.profile = profile;
          this.ownedPipeFixture = ownedPipe;
          this.readerLifecycle = { profile, state: 'not_started' };
          this.advanceProgress(progress, 1, '専用領域を確認。設定の保存待ち');
          this.profilePersistent = Boolean(profile && (keep || path.basename(profile).startsWith('saved-') || this.savedTemporarySessions.has(path.basename(profile))));
          if (this.profilePersistent && (input.mode === 'kindle' || keep && path.basename(profile).startsWith('temporary-'))) {
            const id = path.basename(profile);
            const preferences = await saveSessionPreference(this.dataDir, id, { preferred: input.mode === 'kindle' });
            this.preferredKindleSession = preferences.session;
            this.savedTemporarySessions = new Set(preferences.savedTemporarySessions);
          }
          try {
            if (ownedPipe) { this.readerLifecycle.state = 'starting'; this.fixture = await (guiOwned ? startOwnedGuiSample() : startOwnedPipeSample()); }
            else if (ownedHeaded) this.fixture = await startOwnedSample();
            else if (input.mode === 'sample') this.fixture = await startFixture({ fixture: sampleFixture });
            this.advanceProgress(progress, 2, '設定・試料準備完了。ブラウザの起動と画面応答待ち');
            this.reader = await Reader.open({ profile, sampleUrl: this.fixture?.url, regionId: this.kindleRegion,
              ownedFixture: ownedHeaded ? this.fixture : undefined, ownedSession: ownedPipe ? this.fixture : undefined,
              lifecycle: this.readerLifecycle,
              preconfiguredSample: ['reader', 'image-review'].includes(sampleFixture), headless: input.mode === 'sample' && this.sampleHeadless,
              handleSignals: !this.ownsSignals,
              onChange: () => this.invalidate('browser_target_changed'),
              readGuard: ownedHeaded || ownedPipe || input.mode === 'sample' && this.sampleHeadless ? null : async () => {
                const { snapshot } = await this.store.call('snapshot');
                if (!snapshot.cursor_valid || snapshot.foreground === 0) throw new AppError('window_not_available');
              } });
            this.advanceProgress(progress, 3, 'ブラウザ応答を確認。画面密度の適用待ち');
            await this.reader.setCaptureScale(this.job.manifest.capture_settings.capture_scale);
            this.reader.imageFormat = this.job.manifest.capture_settings.image_format;
            this.reader.jpegQuality = this.job.manifest.capture_settings.jpeg_quality;
            this.state = this.job.manifest.images.length ? 'ResumeCheck' : 'AuthPending';
            this.reason = null;
          } catch (error) {
            if (ownedPipe && this.readerLifecycle.state === 'starting') { this.readerLifecycle.state = 'close_unconfirmed'; this.readerLifecycle.failure = error; }
            if (this.readerLifecycle.state === 'close_unconfirmed') this.readerReleasePending = true;
            const failure = new AppError('browser_open_failed');
            failure.cause = error;
            throw failure;
          }
          break;
        }
        case 'closeBrowser': await this.closeBrowser(); break;
        case 'selectReaderTab': {
          if (!this.reader) throw new AppError('open_browser_first');
          this.reader.selectTab(input.id);
          await this.reader.setCaptureScale(this.job.manifest.capture_settings.capture_scale);
          this.invalidate(null);
          this.state = 'AuthPending';
          break;
        }
        case 'setCaptureSettings': {
          if (!this.job) throw new AppError('job_required');
          const settings = {
            capture_scale: input.capture_scale,
            page_output_mode: input.page_output_mode,
            reading_direction: input.reading_direction,
            image_format: input.image_format ?? this.job.manifest.capture_settings.image_format ?? 'png',
            jpeg_quality: input.jpeg_quality ?? this.job.manifest.capture_settings.jpeg_quality ?? 85,
          };
          if (!Number.isInteger(settings.capture_scale) || ![1, 2].includes(settings.capture_scale)
            || !['single_image', 'split_spread'].includes(settings.page_output_mode)
            || !['right_to_left', 'left_to_right'].includes(settings.reading_direction)
            || !['png', 'jpeg'].includes(settings.image_format) || !Number.isInteger(settings.jpeg_quality)
            || settings.jpeg_quality < 1 || settings.jpeg_quality > 100) throw new AppError('invalid_capture_settings');
          if (this.reader && !this.reader.explicitPage) throw new AppError('select_reader_tab');
          const previous = this.job.manifest.capture_settings;
          this.invalidate('capture_settings_changed');
          if (this.reader) this.reader.invalidateOutputSettings();
          try {
            if (this.reader && previous.capture_scale !== settings.capture_scale) await this.reader.setCaptureScale(settings.capture_scale);
            const updated = await this.store.call('set_capture_settings', { capture_settings: settings });
            this.job = updated.snapshot;
            if (this.reader) { this.reader.imageFormat = settings.image_format; this.reader.jpegQuality = settings.jpeg_quality; }
          } catch (error) {
            if (this.reader && previous.capture_scale !== settings.capture_scale) await this.reader.setCaptureScale(previous.capture_scale).catch(() => {});
            throw error;
          }
          this.state = this.job.manifest.state === 'ready' ? 'AuthPending' : this.job.manifest.state === 'review' ? 'Review' : 'ResumeCheck';
          this.reason = 'capture_settings_changed';
          break;
        }
        case 'deleteSession': {
          if (this.reader) throw new AppError('close_browser_first');
          if (input.confirmed !== true || !/^(saved|temporary)-[a-f0-9-]{36}$/.test(input.id)) throw new AppError('session_delete_confirmation_required');
          const directory = path.join(this.dataDir, input.id);
          await this.ensureGenericSession(directory);
          await rm(directory, { recursive: true });
          const preferences = await forgetSessionPreference(this.dataDir, input.id);
          this.preferredKindleSession = preferences.session;
          this.savedTemporarySessions = new Set(preferences.savedTemporarySessions);
          break;
        }
        case 'preview': {
          console.log('KTZ_PREVIEW:requested');
          if (!this.reader) throw new AppError('open_browser_first');
          this.assertNormalReaderBinding();
          this.invalidate(null, { inspecting: true });
          await this.reader.ownedSessionGuard?.preparePreview?.();
          this.assertNormalReaderBinding();
          const normalGuard = this.reader.ownedSessionGuard?.normal === true ? this.reader.ownedSessionGuard : null;
          const normalBudget = normalGuard?.singleRunBudget;
          await this.reader.adoptVisibleReaderPage();
          this.advanceProgress(progress, 1, '対象タブ確認済み。表示の安定・画像取得待ち');
          const epoch = this.epoch;
          const preview = await this.reader.configure(input.config);
          this.advanceProgress(progress, 2, '表示検査・画像取得完了。レイアウト検査待ち');
          const layout = await this.inspectLayout(preview.png);
          if (this.epoch !== epoch) throw new AppError('cancelled');
          if (normalGuard && (this.reader.ownedSessionGuard !== normalGuard || normalGuard.singleRunBudget !== normalBudget
              || !isNormalCaptureBudget(normalBudget))) throw new AppError('target_changed');
          this.previewNormalGuard = normalGuard;
          this.previewNormalBudget = normalBudget ?? null;
          this.previewImage = preview.png;
          this.previewBook = preview.book;
          this.previewPosition = preview.position;
          this.resumePlan = this.planResume(preview);
          this.previewInfo = {
            position: preview.position, dimensions: preview.dimensions, cssDimensions: preview.cssDimensions,
            deviceScaleFactor: preview.deviceScaleFactor,
            recovery: preview.recovery,
            pageOutputMode: this.job.manifest.capture_settings.page_output_mode,
            readingDirection: this.job.manifest.capture_settings.reading_direction,
            imageFormat: this.job.manifest.capture_settings.image_format,
            layout,
          };
          this.state = 'Preview';
          this.displayInspection = { status: 'passed' };
          console.log('KTZ_PREVIEW:ready');
          break;
        }
        case 'quickPreview': {
          if (!this.reader) throw new AppError('open_browser_first');
          if (!this.reader.explicitPage) throw new AppError('select_reader_tab');
          this.assertNormalReaderBinding();
          this.invalidate(null, { inspecting: true });
          this.state = 'AuthPending';
          await this.reader.ownedSessionGuard?.preparePreview?.();
          this.assertNormalReaderBinding();
          const normalGuard = this.reader.ownedSessionGuard?.normal === true ? this.reader.ownedSessionGuard : null;
          const normalBudget = normalGuard?.singleRunBudget;
          const epoch = this.epoch;
          const preset = this.presets.presets.find(p => p.id === this.presets.selected);
          const mode = input.mode ?? preset.mode;
          const config = this.reader.ownedSessionGuard?.limited || this.reader.ownedSessionGuard?.normal || mode === 'visible'
            ? await this.reader.autoConfiguration() : input.config ?? preset.config;
          this.advanceProgress(progress, 1, '設定対象の確認完了。表示の安定・画像取得待ち');
          const preview = await this.reader.configure(config);
          this.advanceProgress(progress, 2, '表示検査・画像取得完了。レイアウト検査待ち');
          const layout = await this.inspectLayout(preview.png);
          if (this.epoch !== epoch) throw new AppError('cancelled');
          if (normalGuard && (this.reader.ownedSessionGuard !== normalGuard || normalGuard.singleRunBudget !== normalBudget
              || !isNormalCaptureBudget(normalBudget))) throw new AppError('target_changed');
          this.previewNormalGuard = normalGuard;
          this.previewNormalBudget = normalBudget ?? null;
          this.previewImage = preview.png;
          this.previewBook = preview.book;
          this.previewPosition = preview.position;
          this.resumePlan = this.planResume(preview);
          this.previewInfo = {
            position: preview.position, dimensions: preview.dimensions, cssDimensions: preview.cssDimensions,
            deviceScaleFactor: preview.deviceScaleFactor,
            recovery: preview.recovery,
            pageOutputMode: this.job.manifest.capture_settings.page_output_mode,
            readingDirection: this.job.manifest.capture_settings.reading_direction,
            imageFormat: this.job.manifest.capture_settings.image_format,
            layout,
          };
          this.state = 'Preview';
          this.displayInspection = { status: 'passed' };
          break;
        }
        case 'pick': {
          if (!this.reader) throw new AppError('open_browser_first');
          this.invalidate(null);
          this.state = 'AuthPending';
          const picked = await this.reader.pick(input.field, { language: input.language });
          return { ...await this.snapshot(), picked };
        }
        case 'expandReader': {
          if (!this.reader) throw new AppError('open_browser_first');
          this.invalidate(null);
          this.state = 'AuthPending';
          const picked = await this.reader.expandReader();
          return { ...await this.snapshot(), picked };
        }
        case 'pickAll': {
          if (!this.reader) throw new AppError('open_browser_first');
          this.invalidate(null);
          this.state = 'AuthPending';
          const fields = ['reader', 'identity', 'position', 'next'];
          const cancelEpoch = this.selectionCancelEpoch ?? 0;
          for (const [index, field] of fields.entries()) {
            if (cancelEpoch !== (this.selectionCancelEpoch ?? 0)) throw new AppError('picker_cancelled');
            await this.reader.pick(field, { step: `${index + 1} / ${fields.length} `, language: input.language });
            this.advanceProgress(progress, index + 1, '指定済み項目を計測。専用ブラウザ内の次の選択待ち');
          }
          break;
        }
        case 'approve': {
          this.assertNormalReaderBinding();
          const epoch = this.epoch;
          const normalGuard = this.reader?.ownedSessionGuard;
          const budget = normalGuard?.singleRunBudget;
          const normalOwned = normalGuard?.normal === true;
          if ((normalOwned || this.previewNormalGuard) && (normalGuard !== this.previewNormalGuard
              || budget !== this.previewNormalBudget || !isNormalCaptureBudget(budget))) {
            this.previewNormalBudget?.fail(); this.invalidate('target_changed'); throw new AppError('target_changed');
          }
          // A new GUI approval attempt replaces the old one, even if the new
          // request is invalid or unconfirmed. It cannot fall back to old consent.
          if (this.previewApproved && budget?.revokeApproval) {
            budget.revokeApproval(); this.previewApproved = false; this.approvedMaxCaptures = null;
            this.approvedNormalGuard = null; this.approvedNormalBudget = null; this.state = 'Preview';
          }
          if (!this.previewImage || input.confirmed !== true) throw new AppError('preview_confirmation_required');
          const maxCaptures = captureLimit(input.maxCaptures);
          if (!normalOwned && (this.reader?.ownedPipe || budget) && maxCaptures === null) throw new AppError('invalid_capture_limit');
          try { await this.reader.requireBound(); }
          catch (error) { this.reader.ownedSessionGuard?.singleRunBudget?.fail(); this.invalidate(error.code ?? 'target_changed'); throw error; }
          this.job = (await this.store.call('job_info')).snapshot;
          if (this.reader.ownedSessionGuard?.limited) assertPortableLimitedSettings(this.job);
          if (budget && !normalOwned && (this.job.manifest.images.length || this.job.manifest.state !== 'ready')) {
            budget.fail();
            throw new AppError('expected_capture_new_job_required');
          }
          // Normal owned runs may resume only from the exact durable last
          // original, never from a changed position or an uncertain dispatch.
          // A recovered upload/orphan or inconsistent job is not a checkpoint.
          if (normalOwned && (this.job.issues.length || this.job.orphan_files.length)) throw new AppError('resume_position_required');
          // Ready records the store transition, not consent for a later preview.
          // Retained images always need comparison against this preview again.
          if ((this.job.manifest.images.length || this.job.manifest.state !== 'ready') && input.resumeConfirmed !== true) throw new AppError('resume_confirmation_required');
          if (this.job.manifest.images.length && (!this.resumePlan || this.resumePlan.mode === 'blocked')) throw new AppError('resume_position_required');
          if (normalOwned && this.job.manifest.images.length && this.resumePlan?.mode !== 'advance') throw new AppError('resume_position_required');
          const owner = this.job.manifest.images.find(image => image.book)?.book;
          if (owner && owner.identity !== this.previewBook?.identity) throw new AppError('book_identity_changed');
          if (this.epoch !== epoch) throw new AppError('cancelled');
          if (normalOwned && (this.reader.ownedSessionGuard !== normalGuard || normalGuard.singleRunBudget !== budget)) throw new AppError('target_changed');
          if (normalOwned) budget.approve(maxCaptures, { resumeAdvance: this.resumePlan?.mode === 'advance' });
          try {
            if (this.job.manifest.state !== 'ready') {
              await this.store.call('resume_confirm', { last_capture_id: this.job.manifest.last_capture_id, target_confirmed: true });
            }
            if (this.epoch !== epoch) throw new AppError('cancelled');
            if (normalOwned && (this.reader.ownedSessionGuard !== normalGuard || normalGuard.singleRunBudget !== budget)) throw new AppError('target_changed');
            if (!normalOwned) budget?.approve(maxCaptures);
          } catch (error) { if (normalOwned) budget.fail(); throw error; }
          this.approvedNormalGuard = normalOwned ? normalGuard : null;
          this.approvedNormalBudget = normalOwned ? budget : null;
          this.approvedMaxCaptures = maxCaptures;
          this.previewApproved = true;
          this.state = 'Ready';
          break;
        }
        case 'start': {
          this.assertNormalReaderBinding();
          const epoch = this.epoch;
          if (this.state !== 'Ready' || !this.previewApproved || input.confirmed !== true) throw new AppError('explicit_start_required');
          // Omission inherits the approval; it must never remove a finite limit.
          const maxCaptures = this.approvedMaxCaptures;
          const budget = this.reader.ownedSessionGuard?.singleRunBudget;
          const refuseNormalChange = () => {
            this.approvedNormalBudget?.fail(); this.invalidate('target_changed'); throw new AppError('target_changed');
          };
          if ((this.approvedNormalGuard || this.reader.ownedSessionGuard?.normal === true)
              && (this.reader.ownedSessionGuard !== this.approvedNormalGuard || budget !== this.approvedNormalBudget
                || !isNormalCaptureBudget(budget))) refuseNormalChange();
          if (this.reader.ownedSessionGuard?.limited) {
            this.job = (await this.store.call('job_info')).snapshot;
            assertPortableLimitedSettings(this.job);
            if (this.job.manifest.images.length || this.job.manifest.state !== 'ready') throw new AppError('portable_limited_claim_consumed');
          }
          const revokeChangedLimit = () => {
            // The GUI budget is per explicit approval. A rejected change must
            // not leave that older approval usable by a later omitted limit.
            if (budget?.revokeApproval) {
              budget.revokeApproval(); this.previewApproved = false; this.approvedMaxCaptures = null;
              this.approvedNormalGuard = null; this.approvedNormalBudget = null; this.state = 'Preview';
            }
          };
          if (Object.hasOwn(input, 'maxCaptures')) {
            let requested;
            try { requested = captureLimit(input.maxCaptures); }
            catch (error) { revokeChangedLimit(); throw error; }
            if (requested !== maxCaptures) { revokeChangedLimit(); throw new AppError('capture_limit_changed'); }
          }
          try { await this.reader.requireBound(); }
          catch (error) { this.reader.ownedSessionGuard?.singleRunBudget?.fail(); this.invalidate(error.code ?? 'target_changed'); throw error; }
          const owner = this.job.manifest.images.find(image => image.book)?.book;
          if (owner && owner.identity !== this.reader.bound?.book?.identity) throw new AppError('book_identity_changed');
          if (this.epoch !== epoch) throw new AppError('cancelled');
          if (this.approvedNormalGuard && this.reader.ownedSessionGuard !== this.approvedNormalGuard) refuseNormalChange();
          if (this.reader.ownedSessionGuard?.normal === true) {
            if (this.reader.ownedSessionGuard !== this.approvedNormalGuard || budget !== this.approvedNormalBudget
                || !isNormalCaptureBudget(budget)) refuseNormalChange();
            this.job = (await this.store.call('job_info')).snapshot;
            if (this.job.issues.length || this.job.orphan_files.length
                || this.job.manifest.images.length && this.planResume({ png: this.previewImage, position: this.previewPosition }).mode !== 'advance')
              throw new AppError('resume_position_required');
            if (this.epoch !== epoch || this.reader.ownedSessionGuard !== this.approvedNormalGuard
                || this.reader.ownedSessionGuard.singleRunBudget !== budget) refuseNormalChange();
            budget.start(maxCaptures, { resumeAdvance: this.resumePlan?.mode === 'advance' });
          } else budget?.start(maxCaptures);
          let normalResultRun = null;
          try {
            if (this.fixture?.normal === true) {
              try { normalResultRun = await beginPortableNormalResult(this.dataDir, this.job, this.portableNormalSession, maxCaptures); }
              catch { this.portableNormalResultUncertainJob = this.job.manifest.job_id; throw new AppError('portable_normal_result_write_failed'); }
              if (this.epoch !== epoch) throw new AppError('cancelled');
            }
            await this.store.call('capture_start');
            if (this.epoch !== epoch) { await this.store.call('capture_pause'); throw new AppError('cancelled'); }
          } catch (error) { budget?.fail(); this.invalidate(error.code ?? 'capture_or_advance_failed'); throw error; }
          this.lastFailure = null;
          this.captureCancelReason = null;
          this.state = 'Capturing';
          this.reason = null;
          const acquisition = this.acquire(epoch, input.progressKey, this.resumePlan?.mode === 'advance', maxCaptures, normalResultRun);
          const tracked = acquisition.finally(() => { if (this.loop === tracked) this.loop = null; });
          this.loop = tracked;
          break;
        }
        case 'review': {
          if (!this.job) throw new AppError('job_required');
          // Limited review is inspection only, including recovered legacy jobs.
          // Even writing the same order would change their preserved manifest.
          if (await this.isPortableLimitedJob() && !await this.canPortableArchiveEdit()) {
            // Review ends the trial even if requested before its first preview.
            const budget = this.reader?.ownedSessionGuard?.singleRunBudget;
            if (budget?.snapshot().phase !== 'finished') budget?.fail();
          } else {
            const info = (await this.store.call('job_info')).snapshot;
            await this.store.call('set_review_order', { capture_ids: input.ids ?? info.manifest.selected_capture_ids });
          }
          this.state = 'Review';
          this.invalidate(null);
          break;
        }
        case 'crop': {
          await this.store.call('crop_image', { capture_id: input.id, x: input.x, y: input.y, width: input.width, height: input.height });
          break;
        }
        case 'detectCrop': {
          const { candidate } = await this.store.call('suggest_margin_crop', { capture_id: input.id });
          return { ...await this.snapshot(), autoCropCandidate: candidate };
        }
        case 'applyAutoCrop': {
          if (input.confirmed !== true) throw new AppError('preview_confirmation_required');
          await this.store.call('apply_margin_crop', { candidate: input.candidate });
          break;
        }
        case 'resetCrop': {
          await this.store.call('reset_crop', { capture_id: input.id });
          break;
        }
        case 'setPageLayout': {
          if (!['single_image', 'split_spread'].includes(input.mode) || !['left', 'right'].includes(input.firstPage)) throw new AppError('invalid_capture_settings');
          await this.store.call('set_page_layout', { capture_id: input.id, mode: input.mode, first_page: input.firstPage });
          break;
        }
        case 'export': {
          if (!this.job) throw new AppError('job_required');
          const destination = path.resolve(input.destination);
          this.pendingExportDestination = destination;
          try {
            if (typeof input.rangeConfirmed === 'boolean') await this.store.call('confirm_range', { confirmed: input.rangeConfirmed });
            progress.detail = '対象全体の原本照合・保存対象数の確認待ち（総量未確定）';
            lastExport = { ...(await this.store.call('export', { destination, format: input.format ?? 'zip' }, update => {
              if (this.progress !== progress || progress.status !== 'pending') return;
              progress.total = update.total;
              progress.done = update.done;
              progress.unit = '保存作業（原本照合＋出力準備＋書込み＋再読検証＋確定）';
              progress.detail = { inspect: '原本を1枚ずつ照合中', prepare: '保存する画像と順序を確認中',
                write: '画像をZIPへ書込み中', verify: 'ZIP内の画像を再読検証中', publish: '全体検証済み。非上書き公開・保存履歴の確定待ち' }[update.stage];
            })).export, destination };
          } finally { this.pendingExportDestination = null; }
          break;
        }
        default: throw new AppError('unknown_action');
      }
      this.advanceProgress(progress, progress.total - 1, '処理結果確認済み。保存状態の再取得待ち');
      return { ...await this.snapshot(), lastExport };
    }, input.progressKey);
  }

  async chooseDestination(input) {
    if (!this.job) throw new AppError('job_required');
    if (this.busy || this.loop || this.endingBook || this.quiescenceRequired || this.destinationDialog) throw new AppError('operation_busy');
    if (!['zip', 'cbz'].includes(input.format) || typeof input.destination !== 'string'
      || input.destination.length > 32760 || input.destination.includes('\0')) throw new AppError('invalid_destination');
    const generation = this.bookGeneration;
    const controller = new AbortController();
    this.destinationDialog = controller;
    const progress = this.beginProgress('chooseDestination', input.progressKey, null, '保存先選択');
    let destination;
    try {
      await this.enforcePortableLimitedCommand('chooseDestination', input);
      this.advanceProgress(progress, 1, '選択条件確認済み。保存先ダイアログの本人入力待ち（保存は開始しません）');
      destination = await this.saveDialog({ destination: path.resolve(input.destination || (await this.snapshot()).suggestedDestination), format: input.format, signal: controller.signal });
    } catch (error) {
      if (this.progress === progress) progress.status = controller.signal.aborted ? 'cancelled' : 'failure';
      if (controller.signal.aborted) throw new AppError('cancelled');
      throw error instanceof AppError ? error : new AppError('save_dialog_failed');
    } finally {
      if (this.destinationDialog === controller) this.destinationDialog = null;
    }
    if (controller.signal.aborted || this.closed || this.bookGeneration !== generation) throw new AppError('cancelled');
    this.advanceProgress(progress, 2, '選択応答を確認。現在ジョブの再照合待ち');
    const result = { ...await this.snapshot(), chosenDestination: destination ?? null };
    if (this.progress === progress) { progress.status = destination === null ? 'cancelled' : 'success'; if (destination !== null) { progress.total = 1; progress.done = 1; } }
    return result;
  }

  async isPortableLimitedJob() {
    if (process.platform !== 'linux' || !this.job) return false;
    if (await portableLimitedClaimState(this.dataDir, this.job.manifest.job_id) === 'this-job') return true;
    return await portableLimitedOriginClaimState(this.job, this.dataDir) === 'this-job';
  }

  async canPortableArchiveEdit() {
    return Boolean(this.job && portableLimitedAvailable(this.dataDir) && !this.reader && !this.fixture && !this.profile
      && !this.readerReleasePending && !this.quiescenceRequired && !this.storageUncertain
      && await portableArchiveEditable(this.dataDir, this.job));
  }

  assertNormalReaderBinding() {
    if (this.fixture?.normal === true && (!this.reader || this.reader.ownedSessionGuard?.normal !== true
        || !isPortableNormalGuard(this.fixture, this.reader, this.reader.ownedSessionGuard)
        || !isNormalCaptureBudget(this.reader.ownedSessionGuard.singleRunBudget))) {
      this.approvedNormalBudget?.fail();
      this.invalidate('target_changed');
      throw new AppError('target_changed');
    }
  }

  planResume(preview) {
    const manifest = this.job.manifest;
    if (!manifest.images.length) return null;
    const last = manifest.images.find(image => image.capture_id === manifest.last_capture_id);
    const checkpoint = manifest.checkpoint;
    const samePixels = last?.sha256 === createHash('sha256').update(preview.png).digest('hex');
    const samePosition = checkpoint?.capture_id === last?.capture_id && checkpoint.position === preview.position;
    let mode = 'capture';
    if (this.reader?.ownedSessionGuard?.normal === true) {
      mode = samePixels && samePosition && checkpoint?.dispatch === 'not_sent'
        && !last.blank_candidate && !last.duplicate_candidate ? 'advance' : 'blocked';
      return { mode, imageMatches: samePixels, lastCaptureId: last?.capture_id, lastPosition: checkpoint?.position ?? null,
        currentPosition: preview.position, dispatch: checkpoint?.dispatch ?? 'unknown' };
    }
    if (samePixels || samePosition) {
      mode = samePixels && samePosition && checkpoint.dispatch === 'not_sent'
        && !last.blank_candidate && !last.duplicate_candidate ? 'advance' : 'blocked';
    }
    return { mode, imageMatches: samePixels, lastCaptureId: last?.capture_id, lastPosition: checkpoint?.position ?? null,
      currentPosition: preview.position, dispatch: checkpoint?.dispatch ?? 'unknown' };
  }

  async acquire(epoch, progressKey, advanceFirst = false, maxCaptures = null, normalResultRun = null) {
    const job = this.job;
    const reader = this.reader;
    const budget = reader.ownedSessionGuard?.singleRunBudget;
    const generation = this.bookGeneration;
    let pendingCaptureId = null;
    let stage = 'capture';
    let advanceDispatch = 'not_sent';
    let failure = null;
    let committed = 0, limitReached = false, endReached = false;
    let stoppedReason = null;
    let resultWritten = false, resultWriteFailed = false;
    const normal = this.fixture?.normal === true;
    const startedAt = performance.now();
    let savedBytes = job.manifest.images.reduce((sum, image) => sum + image.bytes, 0);
    const ownsJob = () => this.job === job && this.reader === reader && this.bookGeneration === generation;
    const cancelled = () => !ownsJob() || this.epoch !== epoch || this.state !== 'Capturing';
    const resultStages = new Set(['capture', 'capture_begin', 'capture_upload', 'target_recheck_before_commit', 'capture_commit',
      'image_review', 'advance_preflight', 'advance_dispatch', 'advance_confirmation', 'advance_confirmed',
      'advance_bound_check', 'advance_next_check', 'advance_handle_check', 'advance_trial_check', 'advance_recheck',
      'capture_limit_stop', 'end_stop', 'resource_stop']);
    const resultReasons = new Set(['end_candidate', 'capture_limit_reached', 'capture_time_limit_reached',
      'capture_byte_limit_reached', 'capture_free_space_limit_reached', 'capture_storage_check_failed',
      'image_review_required', 'target_changed', 'browser_target_changed', 'store_disconnected', 'application_closed',
      'user_paused', 'user_stopped', 'interrupted']);
    const persistResult = async (reason, dispatch = advanceDispatch) => {
      if (!normalResultRun || resultWritten) return;
      try {
        await finishPortableNormalResult(this.dataDir, job, normalResultRun,
          resultReasons.has(reason) ? reason : 'capture_or_advance_failed',
          resultStages.has(stage) ? stage : 'unknown', ['not_sent', 'sent', 'unknown', 'confirmed'].includes(dispatch) ? dispatch : 'unknown');
        resultWritten = true;
      } catch { resultWriteFailed = true; this.portableNormalResultUncertainJob = job.manifest.job_id; throw new AppError('portable_normal_result_write_failed'); }
    };
    const progress = this.beginProgress('start', progressKey, null, '取得画像');
    const advance = async captureId => {
      await reader.advance(cancelled, async update => {
        stage = update.stage;
        advanceDispatch = update.status;
        if (update.status !== 'not_sent') await this.store.call('record_advance', {
          capture_id: captureId, dispatch: update.stage === 'advance_confirmed' ? 'confirmed' : update.status,
        });
      });
    };
    const stopInReview = async reason => {
      stage = reason === 'capture_limit_reached' ? 'capture_limit_stop' : reason === 'end_candidate' ? 'end_stop' : 'resource_stop';
      await this.store.call('capture_stop');
      if (cancelled()) return false;
      const info = (await this.store.call('job_info')).snapshot;
      if (cancelled()) return false;
      await this.store.call('set_review_order', { capture_ids: info.manifest.selected_capture_ids });
      if (cancelled()) return false;
      if (committed) budget?.finish();
      else budget?.fail(); // Resuming at an already reached end spends no new original.
      if (this.portableArchiveJob === job.manifest.job_id) {
        const current = (await this.store.call('job_info')).snapshot;
        const previewDigest = createHash('sha256').update(this.previewImage).digest('hex');
        await recordPortableArchiveCapture(this.dataDir, current, budget?.snapshot(), previewDigest);
        this.portableArchiveResult = { budget: budget.snapshot(), previewMatches: true };
      }
      await persistResult(reason, info.manifest.checkpoint?.dispatch ?? 'not_sent');
      if (cancelled()) return false;
      this.invalidate(reason);
      this.state = 'Review';
      limitReached = true;
      endReached = reason === 'end_candidate';
      stoppedReason = reason;
      return true;
    };
    const resourceStop = async (additional = 0) => {
      if (!normal) return false;
      this.assertNormalReaderBinding();
      let reason = performance.now() - startedAt >= normalRunMilliseconds ? 'capture_time_limit_reached'
        : !Number.isSafeInteger(savedBytes) || savedBytes < 0 || savedBytes + additional > normalJobBytes ? 'capture_byte_limit_reached' : null;
      if (!reason) {
        let free;
        try { const fs = await statfs(job.job_path, { bigint: true }); free = fs.bavail * fs.bsize; }
        catch { throw new AppError('capture_storage_check_failed'); }
        if (free < BigInt(normalFreeBytes + additional)) reason = 'capture_free_space_limit_reached';
      }
      if (!reason) return false;
      if (!committed) throw new AppError(reason);
      await stopInReview(reason);
      return true;
    };
    try {
      this.assertNormalReaderBinding();
      let firstPreview = null;
      if (budget) {
        if (advanceFirst && !reader.ownedSessionGuard?.normal || !this.previewImage || this.previewPosition !== reader.bound?.position
            || this.previewBook?.identity !== reader.bound?.book?.identity) throw new AppError('target_changed');
        if (!advanceFirst) firstPreview = Buffer.from(this.previewImage);
      }
      // Only the identical last image at its checkpoint with a durable
      // not-sent record may advance without saving it twice. Position labels
      // alone can collide across different, not-yet-captured images.
      if (advanceFirst && !cancelled()) {
        // An owned normal run has already taken the explicit preview under its
        // budget. Recheck the bound display without spending a second capture.
        const currentState = reader.ownedSessionGuard?.normal ? await reader.requireBound() : null;
        const current = reader.ownedSessionGuard?.normal ? this.previewImage : await reader.capture();
        await this.inspectLayout(current); // Preserve black/invalid PNG guards even without another commit.
        if (cancelled()) return;
        if (!this.previewImage || createHash('sha256').update(current).digest('hex') !== createHash('sha256').update(this.previewImage).digest('hex')) {
          throw new AppError('resume_position_required');
        }
        if (normal && (currentState.nextDisabled || await reader.ownedSessionGuard.atEnd?.(currentState))) {
          await stopInReview('end_candidate');
          return;
        }
        if (await resourceStop()) return;
        await advance(job.manifest.last_capture_id);
      }
      while (!cancelled()) {
        if (await resourceStop()) break;
        progress.detail = '総数・残数・割合は未確定。次の画像の取得待ち';
        stage = 'capture';
        let png;
        if (firstPreview) {
          await reader.requireBound();
          png = firstPreview;
          firstPreview = null;
        } else png = await reader.capture();
        if (await resourceStop(png.length)) break;
        this.advanceProgress(progress, 1, '現在画像の取得完了。原本の保存準備待ち');
        if (cancelled()) break;
        stage = 'capture_begin';
        const { capture_id } = await this.store.call('capture_begin');
        pendingCaptureId = capture_id;
        if (ownsJob()) this.pending = true;
        stage = 'capture_upload';
        for (let offset = 0; offset < png.length; offset += 32_768) {
          if (cancelled()) break;
          await this.store.call('capture_chunk', { capture_id, data_base64: png.subarray(offset, offset + 32_768).toString('base64') });
        }
        if (cancelled()) break;
        this.advanceProgress(progress, 2, '画像転送完了。確定前の対象照合待ち');
        stage = 'target_recheck_before_commit';
        if (reader.ownedSessionGuard?.limited) assertPortableLimitedSettings((await this.store.call('job_info')).snapshot);
        await reader.requireBound();
        if (cancelled()) break;
        this.advanceProgress(progress, 3, '対象照合完了。原本の確定待ち');
        stage = 'capture_commit';
        const { capture } = await this.store.call('capture_commit', { book: reader.bound?.book ?? null, position: reader.bound?.position });
        committed += 1;
        savedBytes += capture.bytes;
        if (this.progress === progress) progress.done += 1;
        pendingCaptureId = null;
        if (ownsJob()) this.pending = false;
        budget?.commit();
        if (cancelled()) break;
        this.advanceProgress(progress, 4, '原本確定済み。画像の安全点検待ち');
        stage = 'image_review';
        if (capture.blank_candidate || capture.duplicate_candidate) throw new AppError('image_review_required');
        if (maxCaptures !== null && committed >= maxCaptures) {
          // Stop at the last committed display. Leave its checkpoint not_sent
          // so explicit, re-approved resume can advance it without recapture.
          await stopInReview('capture_limit_reached');
          break;
        }
        if (budget) {
          const current = await reader.requireBound();
          if (current.nextDisabled || await reader.ownedSessionGuard.atEnd?.(current)) {
            await stopInReview('end_candidate');
            break;
          }
        }
        if (await resourceStop()) break;
        this.advanceProgress(progress, 5, '画像点検完了。安全な送り・位置変化の確認待ち（不明な送りは再送しません）');
        await advance(capture.capture_id);
        if (this.progress === progress && !cancelled()) progress.detail = '総数・残数・割合は未確定。次画像の準備待ち';
        // A cancellable yield prevents a fast fixture from starving UI controls.
        await sleep(200);
      }
    } catch (error) {
      budget?.fail();
      // A storage error observer invalidates the epoch before StoreClient
      // rejects. Preserve that failure rather than treating it as user cancel.
      if (ownsJob() && (!cancelled() || this.storageUncertain || this.captureCancelReason
          && !['user_paused', 'user_stopped', 'application_closed'].includes(this.captureCancelReason))) {
        const code = this.captureCancelReason || (error instanceof AppError ? error.code : 'capture_or_advance_failed');
        failure = { stage, code, detail: error instanceof AppError ? error.detail ?? null : null, advanceDispatch };
        this.invalidate(code);
      }
    } finally {
      if (budget && !limitReached) budget.fail();
      // Invalidation can be seen at a loop boundary without throwing at all.
      if (!failure && !limitReached && ownsJob() && this.captureCancelReason
          && !['user_paused', 'user_stopped', 'application_closed'].includes(this.captureCancelReason)) {
        failure = { stage, code: this.captureCancelReason, detail: null, advanceDispatch };
      }
      if (pendingCaptureId && ownsJob() && !this.storageUncertain && !reader.ownedSessionGuard?.limited) {
        await this.store.call('capture_abort').catch(() => { this.reason = 'pending_preserved_for_inspection'; });
        pendingCaptureId = null;
        this.pending = false;
      }
      if (ownsJob()) {
        const info = await this.store.call('job_info').catch(() => null);
        if (!this.storageUncertain && info?.snapshot.manifest.state === 'capturing') await this.store.call('capture_pause').catch(() => {});
        const progress = await this.store.call('job_progress').catch(() => null);
        if (progress?.manifest && ownsJob()) job.manifest = progress.manifest;
        if (normalResultRun && !resultWritten && !resultWriteFailed) {
          try { await persistResult(failure?.code ?? this.captureCancelReason ?? 'interrupted',
            job.manifest.checkpoint?.dispatch ?? advanceDispatch); }
          catch {
            failure = { stage: 'unknown', code: 'portable_normal_result_write_failed', detail: null, advanceDispatch: 'unknown' };
            this.reason = failure.code;
            this.state = 'NeedsAttention';
          }
        }
        if (failure && ownsJob()) {
          this.lastFailure = {
            ...failure,
            committedImages: this.job?.manifest?.images?.length ?? job.manifest.images.length,
          };
        }
        if (this.state === 'Capturing') this.state = 'NeedsAttention';
      }
      if (this.progress === progress) {
        progress.status = failure ? 'failure' : limitReached ? 'success' : 'cancelled';
        progress.detail = failure ? '安全停止。確定原本は保持しています' : limitReached
          ? endReached ? '終端候補で停止。全冊完了ではありません' : stoppedReason === 'capture_limit_reached'
            ? '承認した最大取得画面数で停止。全冊完了ではありません' : '時間または容量の安全境界で停止。全冊完了ではありません'
          : '取得を停止しました';
      }
      if (limitReached && this.portableArchiveJob === job.manifest.job_id && ownsJob() && !this.storageUncertain) {
        this.portableArchiveClosing = true;
        try { await this.closeBrowser(); this.state = 'Review'; this.reason = null; }
        catch {
          this.readerReleasePending = true; this.state = 'NeedsAttention';
          this.lastFailure = { stage: 'reader_close', code: 'reader_close_failed', committedImages: committed, advanceDispatch };
          if (this.progress === progress) { progress.status = 'failure'; progress.detail = 'Reader終了未確認。原本と記録を保全しています'; }
        }
        finally { this.portableArchiveClosing = false; }
      }
    }
  }

  async inspectLayout(png) {
    await this.store.call('layout_begin');
    for (let offset = 0; offset < png.length; offset += 32_768) {
      await this.store.call('layout_chunk', { data_base64: png.subarray(offset, offset + 32_768).toString('base64') });
    }
    return (await this.store.call('layout_result')).layout;
  }

  async cancel(action) {
    if (!this.job) throw new AppError('job_required');
    const wasCapturing = this.state === 'Capturing' || Boolean(this.loop);
    if (wasCapturing) this.captureCancelReason ??= action === 'pause' ? 'user_paused' : 'user_stopped';
    this.invalidate(null);
    this.selectionCancelEpoch = (this.selectionCancelEpoch ?? 0) + 1;
    if (this.reader?.pickField) await this.reader.cancelPick();
    if (await this.isPortableLimitedJob()) {
      const guard = this.reader?.ownedSessionGuard;
      // A recovered or already closed trial cannot be mutated by stop/pause.
      if (!guard?.limited) throw new AppError('portable_limited_claim_consumed');
      if (!wasCapturing) {
        // An explicit stop before/after capture ends the active budget without
        // writing a stopped/review state over an already preserved manifest.
        guard.singleRunBudget?.fail();
        this.state = action === 'pause' ? 'Paused' : 'Review';
        return this.snapshot();
      }
    }
    this.state = action === 'pause' ? 'Paused' : 'Review';
    await this.loop;
    const info = await this.store.call('job_info');
    if (action === 'stop' && ['ready', 'capturing', 'paused', 'needs_attention', 'interrupted'].includes(info.snapshot.manifest.state)) await this.store.call('capture_stop');
    if (action === 'stop') await this.store.call('set_review_order', { capture_ids: info.snapshot.manifest.selected_capture_ids });
    return this.snapshot();
  }

  async waitForOperations(operations, code) {
    if (!operations.length) return;
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new AppError(code)), 120_000);
    });
    try { await Promise.race([Promise.allSettled(operations), timeout]); }
    finally { clearTimeout(timer); }
  }

  async cancelBack() {
    if (this.endingBook || this.quiescenceRequired) throw new AppError(this.quiescenceRequired ? 'safe_stop_incomplete' : 'operation_busy');
    const capturing = this.state === 'Capturing' || Boolean(this.loop);
    const cancelable = ['preview', 'quickPreview', 'pick', 'pickAll', 'expandReader', 'selectReaderTab'].includes(this.activeOperation);
    if (this.busy && !cancelable) throw new AppError('operation_busy');
    const active = [...this.commands];
    this.invalidate(null);
    this.selectionCancelEpoch = (this.selectionCancelEpoch ?? 0) + 1;
    if (this.reader?.pickField) await this.reader.cancelPick();
    await this.waitForOperations(active, 'cancel_timeout');
    if (capturing || this.loop) return this.cancel('stop');
    return this.snapshot();
  }

  async finishBook(progress) {
    if (this.endingBook) throw new AppError('operation_busy');
    const active = [...this.commands];
    this.endingBook = true;
    this.invalidate('book_finish_requested');
    this.selectionCancelEpoch = (this.selectionCancelEpoch ?? 0) + 1;
    let writerQuiescent = !this.job;
    try {
      // Cancel an outstanding public picker before waiting for its command.
      // No new mutating command can enter while endingBook is true.
      if (this.reader?.pickField) await this.reader.cancelPick();
      this.advanceProgress(progress, 1, '指定操作の取消確認済み。実行中処理の静止待ち');
      await this.waitForOperations(active, 'safe_stop_timeout');
      this.advanceProgress(progress, 2, '操作応答の静止確認済み。画像書込み・送りの停止待ち');
      if (this.loop) await this.waitForOperations([this.loop], 'safe_stop_timeout');
      if (this.job) {
        // A stopped limited job is already immutable. Closing it must not
        // rewrite its manifest merely to move on to a different trial.
        if (this.loop || !await this.isPortableLimitedJob()) await this.cancel('stop');
        writerQuiescent = true;
      }
      this.advanceProgress(progress, 3, '画像書込み停止確認済み。専用ブラウザの通常終了待ち');
      if (this.reader || this.fixture || this.profile || this.readerReleasePending
          || this.readerLifecycle?.state === 'close_unconfirmed') await this.closeBrowser();
      this.advanceProgress(progress, 4, 'ブラウザ終了確認済み。ジョブを閉じる処理待ち（原本保持）');
      if (this.job) {
        writerQuiescent = false;
        this.closingJob = true;
        try {
          await this.store.call('close_job');
          this.job = null;
          this.bookGeneration += 1;
          writerQuiescent = true;
        } finally { this.closingJob = false; }
      }
      this.pending = false;
      this.previewPosition = null;
      this.displayInspection = null;
      this.state = 'Idle';
      this.reason = null;
      this.quiescenceRequired = false;
      this.readerReleasePending = false;
      this.invalidate(null);
      this.endingBook = false;
      this.advanceProgress(progress, 5, 'ジョブ終了確認済み。最終状態確認待ち');
      return this.snapshot();
    } catch (error) {
      // A confirmed-stopped writer and an independently failing browser close
      // are different resources. Keep export/review available only in the
      // former case; an unconfirmed writer still blocks all mutation.
      this.quiescenceRequired = !writerQuiescent;
      this.readerReleasePending = writerQuiescent && Boolean(this.reader || this.fixture || this.profile
        || this.readerReleasePending || this.readerLifecycle?.state === 'close_unconfirmed');
      this.state = this.job ? 'NeedsAttention' : 'Idle';
      this.reason = error.code ?? 'safe_stop_failed';
      this.endingBook = false;
      throw error;
    }
  }

  async ensureOwnedDirectory(directory) {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || !privateMetadata(info, true) || !samePath(await realpath(directory), directory)) throw new AppError('unsafe_directory');
  }

  async ensureGenericSession(directory) {
    await this.ensureOwnedDirectory(directory);
    if (await portableLinuxSessionProtected(directory)) throw new AppError('portable_login_session_protected');
  }

  async resolvePortableKindle(id) {
    // The separate Portable login entry currently opens the Japan store only.
    // Do not silently reuse that account for a different selected region.
    if (this.kindleRegion !== 'jp') throw new AppError('portable_kindle_region_unsupported');
    try { return await resolveExistingPortableLinuxSession(this.dataDir, id); }
    catch (error) {
      const code = ['select_saved_session', 'login_in_use_or_unknown'].includes(error.code) ? error.code : 'portable_session_unavailable';
      throw new AppError(code);
    }
  }

  async image(id, original = false, side = null) {
    if (!this.job) throw new AppError('job_required');
    const image = this.job.manifest.images.find(image => image.capture_id === id);
    if (!image) throw new AppError('image_not_found');
    let item;
    if (side !== null) {
      if (!['left', 'right'].includes(side) || !image.split) throw new AppError('split_not_available');
      item = image.split[side];
      const ext = image.image_format === 'jpeg' ? 'jpg' : 'png';
      if (item.path !== `rendered/${String(id).padStart(6, '0')}-v${image.split.version}-${side}.${ext}`) throw new AppError('unsafe_image');
    } else item = original || !image.crop ? image : image.crop;
    const filename = path.join(this.job.job_path, item.path);
    const info = await lstat(filename);
    if (!info.isFile() || info.isSymbolicLink() || !privateMetadata(info) || info.size > 32 * 1024 * 1024
      || !samePath(await realpath(filename), filename)) throw new AppError('unsafe_image');
    const png = await readFile(filename);
    if (createHash('sha256').update(png).digest('hex') !== item.sha256) throw new AppError('image_integrity_failed');
    return png;
  }

  holdPortablePilotStop(outcome) {
    if (this.portablePilotStopPromise) return this.portablePilotStopPromise;
    // Fence every public command synchronously before awaiting an in-flight
    // inspection. The consumed job and claim remain untouched.
    const result = projectPortablePilotStop(outcome);
    this.portablePilotStop = Object.freeze({ ...result, readerClose: 'pending' });
    this.reader?.ownedSessionGuard?.singleRunBudget?.fail();
    this.invalidate(null);
    const active = [...this.commands, ...(this.loop ? [this.loop] : [])];
    return this.portablePilotStopPromise = (async () => {
      let readerClose = 'unconfirmed';
      try {
        await this.waitForOperations(active, 'safe_stop_timeout');
        await this.closeBrowser(); // Existing normal close/join; unknown stays unknown.
        readerClose = 'confirmed';
      } catch { this.readerReleasePending = true; }
      this.portablePilotStop = Object.freeze({ ...result, readerClose });
      return this.portablePilotStop;
    })();
  }

  async closeBrowser({ retainProfile = false } = {}) {
    const archiveJob = this.job;
    const archiveRelease = archiveJob && this.portableArchiveJob === archiveJob.manifest.job_id
      && this.reader?.ownedSessionGuard?.singleRunBudget?.snapshot().phase === 'finished'
      && !this.lastFailure && !this.storageUncertain && !this.quiescenceRequired;
    this.invalidate(null);
    const errors = [];
    const lifecycle = this.readerLifecycle;
    const unconfirmed = error => {
      if (lifecycle) { lifecycle.state = 'close_unconfirmed'; lifecycle.failure ??= error; }
      this.readerReleasePending = true;
      const failure = new AppError('reader_close_failed');
      failure.cause = lifecycle?.failure ?? error;
      errors.push(failure);
    };
    if (lifecycle?.state === 'close_unconfirmed' || lifecycle?.state === 'starting'
      || lifecycle?.state === 'active' && !this.reader) {
      unconfirmed(lifecycle.failure);
    } else if (this.reader) {
      const reader = this.reader;
      try {
        if (lifecycle && reader.lifecycle !== lifecycle) throw new Error('reader_identity_changed');
        await reader.close();
        if (this.reader !== reader || this.readerLifecycle !== lifecycle) throw new Error('reader_identity_changed');
        if (lifecycle && lifecycle.state !== 'closed_confirmed') throw new Error('reader_close_unconfirmed');
        this.reader = null;
      } catch (error) { unconfirmed(error); }
    }
    // The fixture is independent of the browser/profile. Its normal close is
    // still attempted, but cannot turn an unknown browser into a success.
    if (this.fixture && !(this.ownedPipeFixture && errors.length)) {
      try { await this.fixture.close(); this.fixture = null; }
      catch (error) { errors.push(error); }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, 'browser_cleanup_failed', { cause: errors[0] });
    if (this.profile && !retainProfile && !this.profilePersistent && path.basename(this.profile).startsWith('temporary-')) {
      await this.ensureOwnedDirectory(this.profile);
      await rm(this.profile, { recursive: true });
    }
    this.profile = null;
    this.profilePersistent = false;
    this.portableNormalSession = null;
    this.readerLifecycle = null;
    this.ownedPipeFixture = false;
    this.readerReleasePending = false;
    this.state = this.job ? 'ResumeCheck' : 'Idle';
    if (archiveRelease && this.job === archiveJob) {
      this.job = (await this.store.call('job_info')).snapshot;
      for (const image of this.job.manifest.images) await this.image(image.capture_id, true);
      await releasePortableArchive(this.dataDir, this.job);
      this.portableArchiveReaderLifecycle = lifecycle;
      this.portableArchiveResult = { ...this.portableArchiveResult, readerClosed: true };
      this.portableArchiveJob = null;
    }
  }

  close() {
    if (this.closePromise) return this.closePromise;
    if (this.state === 'Capturing') this.captureCancelReason ??= 'application_closed';
    this.closed = true;
    this.invalidate(null);
    this.selectionCancelEpoch = (this.selectionCancelEpoch ?? 0) + 1;
    this.closePromise = (async () => {
      // UI commands can still own a browser that Reader.open has not returned
      // yet. Settle those commands before deleting its profile or closing Rust.
      this.destinationDialog?.abort();
      const errors = [];
      try { await this.reader?.cancelPick(); } catch (error) { errors.push(error); }
      await Promise.allSettled([...this.commands]);
      try { await this.loop; } catch (error) { errors.push(error); }
      await this.portablePilotStopPromise;
      try { await this.closeBrowser(); } catch (error) { errors.push(error); }
      try { await this.store.close(); } catch (error) { errors.push(error); }
      if (errors.length === 1) throw errors[0];
      if (errors.length) throw new AggregateError(errors, 'application_cleanup_failed', { cause: errors[0] });
    })();
    return this.closePromise;
  }
}
