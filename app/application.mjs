import { randomUUID, createHash } from 'node:crypto';
import { readFile, readdir, lstat, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StoreClient, AppError } from './store-client.mjs';
import { Reader, sampleConfig } from './reader.mjs';
import { startFixture } from '../poc/browser/fixture-server.mjs';
import { sessionId, readSessionPreferences, saveSessionPreference, forgetSessionPreference } from './session-preference.mjs';
import { initialPresets, readPresets, savePresets } from './presets.mjs';
import { bookFilename } from './export-name.mjs';
import { chooseSaveDestination } from './save-dialog.mjs';
import { kindleRegion, kindleRegions } from './stores/kindle.mjs';

const defaultData = process.env.KTZ_USER_DATA_DIR || fileURLToPath(new URL('../artifacts/mvp-data/', import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export class Application {
  constructor({ dataDir = defaultData, sampleHeadless = true, sampleFixture = 'reader', saveDialog = chooseSaveDestination } = {}) {
    this.saveDialog = saveDialog;
    this.kindleRegion = 'jp';
    if (!['reader', 'image-review', 'layout', 'kindle-chrome', 'kindle-chrome-dynamic', 'kindle-chrome-hidden', 'kindle-chrome-recoverable', 'kindle-chrome-tabs', 'kindle-chrome-ambiguous'].includes(sampleFixture)) throw new AppError('invalid_sample_fixture');
    this.dataDir = path.resolve(dataDir);
    this.sampleHeadless = sampleHeadless;
    this.sampleFixture = sampleFixture;
    this.store = new StoreClient();
    this.state = 'Idle';
    this.reason = null;
    this.epoch = 0;
    this.bookGeneration = 0;
    this.commands = new Set();
    this.store.listeners.add(() => this.invalidate('store_disconnected'));
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
    this.epoch += 1;
    this.previewImage = null;
    this.previewInfo = null;
    this.previewBook = null;
    this.previewApproved = false;
    this.resumePlan = null;
    this.displayInspection = inspecting ? { status: 'checking' } : null;
    if (this.state === 'Capturing') this.state = 'NeedsAttention';
    else if (['Preview', 'Ready'].includes(this.state)) this.state = 'AuthPending';
    this.reason = reason;
  }

  async snapshot() {
    const job = this.job;
    // A poll during close must not query an already closed Rust job. Retain
    // the last confirmed snapshot until close succeeds; a close failure keeps
    // the original job rather than publishing a fictional empty workspace.
    if (job && !this.closingJob && !this.store.failed) {
      const progress = await this.store.call('job_progress');
      if (this.job === job) job.manifest = progress.manifest;
    }
    const entries = await readdir(this.dataDir, { withFileTypes: true });
    return {
      state: this.state, reason: this.reason, job: this.job ?? null, operationRevision: this.epoch,
      presets: this.presets,
      browserOpen: Boolean(this.reader), previewReady: Boolean(this.previewImage), previewApproved: this.previewApproved === true,
      sessions: entries.filter(e => e.isDirectory() && sessionId.test(e.name)).map(e => ({ id: e.name, saved: e.name.startsWith('saved-') || this.savedTemporarySessions.has(e.name) })),
      preferredKindleSession: this.preferredKindleSession ?? null,
      kindleRegion: this.kindleRegion, kindleRegions,
      sample: Boolean(this.fixture), config: this.reader?.sampleUrl ? sampleConfig : null,
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
        this.displayInspection = { status: 'failed', code: error.code ?? 'operation_failed', detail: error.detail ?? null,
          stage: ['auto_visibility_wait', 'preview_visibility_wait', 'reader_target_check'].includes(error.stage) ? error.stage : 'preview_inspection' };
      }
      throw error;
    }
    finally { this.commands.delete(pending); }
  }

  async dispatchCommand(action, input) {
    if (['cancelBack', 'finishBook', 'closeJob'].includes(action)) this.destinationDialog?.abort();
    if (action === 'chooseDestination') return this.chooseDestination(input);
    // Cancellation is observed locally before any queued Rust request.
    if (action === 'pause' || action === 'stop') return this.trackOperation(action, () => this.cancel(action), input.progressKey);
    if (action === 'cancelBack') return this.trackOperation(action, () => this.cancelBack(), input.progressKey);
    if (action === 'finishBook') return this.trackOperation(action, p => this.finishBook(p), input.progressKey);
    if (action === 'cancelPick') return this.trackOperation(action, async () => { this.selectionCancelEpoch = (this.selectionCancelEpoch ?? 0) + 1; await this.reader?.cancelPick(); return this.snapshot(); }, input.progressKey);
    return this.exclusive(action, async progress => {
      let lastExport = null;
      switch (action) {
        case 'setKindleRegion': {
          const region = kindleRegion(input.id);
          if (this.reader) throw new AppError('close_browser_first');
          if (this.kindleRegion !== region.id) {
            this.kindleRegion = region.id;
            this.invalidate('kindle_region_changed');
          }
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
          this.job = (await this.store.call('create_job', { base_dir: path.resolve(input.baseDir || this.dataDir) })).snapshot;
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
            this.bookGeneration += 1;
            this.state = 'Idle';
            this.invalidate(null);
          } finally { this.closingJob = false; }
          break;
        }
        case 'openBrowser': {
          if (this.reader || !this.job) throw new AppError('browser_or_job_state');
          if (input.mode !== 'sample' && input.mode !== 'kindle') throw new AppError('invalid_browser_mode');
          const sampleFixture = input.sampleFixture ?? this.sampleFixture;
          if (input.mode === 'sample' && !['reader', 'image-review', 'layout', 'kindle-chrome', 'kindle-chrome-dynamic', 'kindle-chrome-hidden', 'kindle-chrome-recoverable', 'kindle-chrome-tabs', 'kindle-chrome-ambiguous'].includes(sampleFixture)) throw new AppError('invalid_sample_fixture');
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
          if (selected && selected !== 'new') {
            if (!sessionId.test(selected)) throw new AppError('invalid_session');
            profile = path.join(this.dataDir, selected);
            await this.ensureOwnedDirectory(profile);
          } else {
            profile = path.join(this.dataDir, `${keep ? 'saved' : 'temporary'}-${randomUUID()}`);
            await this.store.call('create_session_directory', { path: profile });
          }
          this.profile = profile;
          this.advanceProgress(progress, 1, '専用領域を確認。設定の保存待ち');
          this.profilePersistent = keep || path.basename(profile).startsWith('saved-') || this.savedTemporarySessions.has(path.basename(profile));
          if (this.profilePersistent && (input.mode === 'kindle' || keep && path.basename(profile).startsWith('temporary-'))) {
            const id = path.basename(profile);
            const preferences = await saveSessionPreference(this.dataDir, id, { preferred: input.mode === 'kindle' });
            this.preferredKindleSession = preferences.session;
            this.savedTemporarySessions = new Set(preferences.savedTemporarySessions);
          }
          try {
            if (input.mode === 'sample') this.fixture = await startFixture({ fixture: sampleFixture });
            this.advanceProgress(progress, 2, '設定・試料準備完了。ブラウザの起動と画面応答待ち');
            this.reader = await Reader.open({ profile, sampleUrl: this.fixture?.url, regionId: this.kindleRegion,
              preconfiguredSample: ['reader', 'image-review'].includes(sampleFixture), headless: input.mode === 'sample' && this.sampleHeadless,
              onChange: () => this.invalidate('browser_target_changed'),
              readGuard: input.mode === 'sample' && this.sampleHeadless ? null : async () => {
                const { snapshot } = await this.store.call('snapshot');
                if (!snapshot.cursor_valid || snapshot.foreground === 0) throw new AppError('window_not_available');
              } });
            this.advanceProgress(progress, 3, 'ブラウザ応答を確認。画面密度の適用待ち');
            await this.reader.setCaptureScale(this.job.manifest.capture_settings.capture_scale);
            this.reader.imageFormat = this.job.manifest.capture_settings.image_format;
            this.reader.jpegQuality = this.job.manifest.capture_settings.jpeg_quality;
            this.state = this.job.manifest.images.length ? 'ResumeCheck' : 'AuthPending';
            this.reason = null;
          } catch { throw new AppError('browser_open_failed'); }
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
          await this.ensureOwnedDirectory(directory);
          await rm(directory, { recursive: true });
          const preferences = await forgetSessionPreference(this.dataDir, input.id);
          this.preferredKindleSession = preferences.session;
          this.savedTemporarySessions = new Set(preferences.savedTemporarySessions);
          break;
        }
        case 'preview': {
          console.log('KTZ_PREVIEW:requested');
          if (!this.reader) throw new AppError('open_browser_first');
          this.invalidate(null, { inspecting: true });
          await this.reader.adoptVisibleReaderPage();
          this.advanceProgress(progress, 1, '対象タブ確認済み。表示の安定・画像取得待ち');
          const epoch = this.epoch;
          const preview = await this.reader.configure(input.config);
          this.advanceProgress(progress, 2, '表示検査・画像取得完了。レイアウト検査待ち');
          const layout = await this.inspectLayout(preview.png);
          if (this.epoch !== epoch) throw new AppError('cancelled');
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
          this.invalidate(null, { inspecting: true });
          this.state = 'AuthPending';
          const epoch = this.epoch;
          const preset = this.presets.presets.find(p => p.id === this.presets.selected);
          const mode = input.mode ?? preset.mode;
          const config = mode === 'visible' ? await this.reader.autoConfiguration() : input.config ?? preset.config;
          this.advanceProgress(progress, 1, '設定対象の確認完了。表示の安定・画像取得待ち');
          const preview = await this.reader.configure(config);
          this.advanceProgress(progress, 2, '表示検査・画像取得完了。レイアウト検査待ち');
          const layout = await this.inspectLayout(preview.png);
          if (this.epoch !== epoch) throw new AppError('cancelled');
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
          const epoch = this.epoch;
          if (!this.previewImage || input.confirmed !== true) throw new AppError('preview_confirmation_required');
          try { await this.reader.requireBound(); }
          catch (error) { this.invalidate(error.code ?? 'target_changed'); throw error; }
          this.job = (await this.store.call('job_info')).snapshot;
          // Ready records the store transition, not consent for a later preview.
          // Retained images always need comparison against this preview again.
          if ((this.job.manifest.images.length || this.job.manifest.state !== 'ready') && input.resumeConfirmed !== true) throw new AppError('resume_confirmation_required');
          if (this.job.manifest.images.length && (!this.resumePlan || this.resumePlan.mode === 'blocked')) throw new AppError('resume_position_required');
          const owner = this.job.manifest.images.find(image => image.book)?.book;
          if (owner && owner.identity !== this.previewBook?.identity) throw new AppError('book_identity_changed');
          if (this.job.manifest.state !== 'ready') {
            await this.store.call('resume_confirm', { last_capture_id: this.job.manifest.last_capture_id, target_confirmed: true });
          }
          if (this.epoch !== epoch) throw new AppError('cancelled');
          this.previewApproved = true;
          this.state = 'Ready';
          break;
        }
        case 'start': {
          const epoch = this.epoch;
          if (this.state !== 'Ready' || !this.previewApproved || input.confirmed !== true) throw new AppError('explicit_start_required');
          try { await this.reader.requireBound(); }
          catch (error) { this.invalidate(error.code ?? 'target_changed'); throw error; }
          const owner = this.job.manifest.images.find(image => image.book)?.book;
          if (owner && owner.identity !== this.reader.bound?.book?.identity) throw new AppError('book_identity_changed');
          if (this.epoch !== epoch) throw new AppError('cancelled');
          await this.store.call('capture_start');
          if (this.epoch !== epoch) { await this.store.call('capture_pause'); throw new AppError('cancelled'); }
          this.lastFailure = null;
          this.state = 'Capturing';
          this.reason = null;
          const acquisition = this.acquire(epoch, input.progressKey, this.resumePlan?.mode === 'advance');
          const tracked = acquisition.finally(() => { if (this.loop === tracked) this.loop = null; });
          this.loop = tracked;
          break;
        }
        case 'review': {
          if (!this.job) throw new AppError('job_required');
          const info = (await this.store.call('job_info')).snapshot;
          await this.store.call('set_review_order', { capture_ids: input.ids ?? info.manifest.selected_capture_ids });
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
          if (typeof input.rangeConfirmed === 'boolean') await this.store.call('confirm_range', { confirmed: input.rangeConfirmed });
          progress.detail = '対象全体の原本照合・保存対象数の確認待ち（総量未確定）';
          lastExport = { ...(await this.store.call('export', { destination, format: input.format ?? 'zip' }, update => {
            if (this.progress !== progress || progress.status !== 'pending') return;
            progress.total = update.total;
            progress.done = update.done;
            progress.unit = '保存作業（全画像の書込み＋再読検証＋全体検証＋確定）';
            progress.detail = { write: '画像をZIPへ書込み中', verify: 'ZIP内の画像を再読検証中', publish: '全体検証済み。非上書き公開・保存履歴の確定待ち' }[update.stage];
          })).export, destination };
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

  planResume(preview) {
    const manifest = this.job.manifest;
    if (!manifest.images.length) return null;
    const last = manifest.images.find(image => image.capture_id === manifest.last_capture_id);
    const checkpoint = manifest.checkpoint;
    const samePixels = last?.sha256 === createHash('sha256').update(preview.png).digest('hex');
    const samePosition = checkpoint?.capture_id === last?.capture_id && checkpoint.position === preview.position;
    let mode = 'capture';
    if (samePixels || samePosition) {
      mode = samePixels && samePosition && checkpoint.dispatch === 'not_sent'
        && !last.blank_candidate && !last.duplicate_candidate ? 'advance' : 'blocked';
    }
    return { mode, imageMatches: samePixels, lastCaptureId: last?.capture_id, lastPosition: checkpoint?.position ?? null,
      currentPosition: preview.position, dispatch: checkpoint?.dispatch ?? 'unknown' };
  }

  async acquire(epoch, progressKey, advanceFirst = false) {
    const job = this.job;
    const reader = this.reader;
    const generation = this.bookGeneration;
    let pendingCaptureId = null;
    let stage = 'capture';
    let advanceDispatch = 'not_sent';
    let failure = null;
    const ownsJob = () => this.job === job && this.reader === reader && this.bookGeneration === generation;
    const cancelled = () => !ownsJob() || this.epoch !== epoch || this.state !== 'Capturing';
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
    try {
      // Only the identical last image at its checkpoint with a durable
      // not-sent record may advance without saving it twice. Position labels
      // alone can collide across different, not-yet-captured images.
      if (advanceFirst && !cancelled()) {
        const current = await reader.capture();
        await this.inspectLayout(current); // Preserve black/invalid PNG guards even without another commit.
        if (cancelled()) return;
        if (!this.previewImage || createHash('sha256').update(current).digest('hex') !== createHash('sha256').update(this.previewImage).digest('hex')) {
          throw new AppError('resume_position_required');
        }
        await advance(job.manifest.last_capture_id);
      }
      while (!cancelled()) {
        progress.detail = '総数・残数・割合は未確定。次の画像の取得待ち';
        stage = 'capture';
        const png = await reader.capture();
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
        await reader.requireBound();
        if (cancelled()) break;
        this.advanceProgress(progress, 3, '対象照合完了。原本の確定待ち');
        stage = 'capture_commit';
        const { capture } = await this.store.call('capture_commit', { book: reader.bound?.book ?? null, position: reader.bound?.position });
        if (this.progress === progress) progress.done += 1;
        pendingCaptureId = null;
        if (ownsJob()) this.pending = false;
        if (cancelled()) break;
        this.advanceProgress(progress, 4, '原本確定済み。画像の安全点検待ち');
        stage = 'image_review';
        if (capture.blank_candidate || capture.duplicate_candidate) throw new AppError('image_review_required');
        this.advanceProgress(progress, 5, '画像点検完了。安全な送り・位置変化の確認待ち（不明な送りは再送しません）');
        await advance(capture.capture_id);
        if (this.progress === progress && !cancelled()) progress.detail = '総数・残数・割合は未確定。次画像の準備待ち';
        // A cancellable yield prevents a fast fixture from starving UI controls.
        await sleep(200);
      }
    } catch (error) {
      if (!cancelled() && ownsJob()) {
        const code = error instanceof AppError ? error.code : 'capture_or_advance_failed';
        failure = { stage, code, detail: error instanceof AppError ? error.detail ?? null : null, advanceDispatch };
        this.invalidate(code);
      }
    } finally {
      if (pendingCaptureId && ownsJob()) {
        await this.store.call('capture_abort').catch(() => { this.reason = 'pending_preserved_for_inspection'; });
        pendingCaptureId = null;
        this.pending = false;
      }
      if (ownsJob()) {
        const info = await this.store.call('job_info').catch(() => null);
        if (info?.snapshot.manifest.state === 'capturing') await this.store.call('capture_pause').catch(() => {});
        const progress = await this.store.call('job_progress').catch(() => null);
        if (progress?.manifest && ownsJob()) job.manifest = progress.manifest;
        if (failure && ownsJob()) {
          this.lastFailure = {
            ...failure,
            committedImages: this.job?.manifest?.images?.length ?? job.manifest.images.length,
          };
        }
        if (this.state === 'Capturing') this.state = 'NeedsAttention';
      }
      if (this.progress === progress) { progress.status = failure ? 'failure' : 'cancelled'; progress.detail = failure ? '安全停止。確定原本は保持しています' : '取得を停止しました'; }
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
    this.invalidate(null);
    this.selectionCancelEpoch = (this.selectionCancelEpoch ?? 0) + 1;
    if (this.reader?.pickField) await this.reader.cancelPick();
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
      if (this.job) { await this.cancel('stop'); writerQuiescent = true; }
      this.advanceProgress(progress, 3, '画像書込み停止確認済み。専用ブラウザの通常終了待ち');
      if (this.reader || this.fixture || this.profile) await this.closeBrowser();
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
      this.readerReleasePending = writerQuiescent && Boolean(this.reader || this.fixture || this.profile);
      this.state = this.job ? 'NeedsAttention' : 'Idle';
      this.reason = error.code ?? 'safe_stop_failed';
      this.endingBook = false;
      throw error;
    }
  }

  async ensureOwnedDirectory(directory) {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || path.resolve(await realpath(directory)).toLowerCase() !== path.resolve(directory).toLowerCase()) throw new AppError('unsafe_directory');
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
    if (!info.isFile() || info.isSymbolicLink() || info.size > 32 * 1024 * 1024
      || path.resolve(await realpath(filename)).toLowerCase() !== path.resolve(filename).toLowerCase()) throw new AppError('unsafe_image');
    const png = await readFile(filename);
    if (createHash('sha256').update(png).digest('hex') !== item.sha256) throw new AppError('image_integrity_failed');
    return png;
  }

  async closeBrowser() {
    this.invalidate(null);
    if (this.reader) {
      const reader = this.reader;
      try { await reader.close(); }
      catch { this.readerReleasePending = true; throw new AppError('reader_close_failed'); }
      if (this.reader === reader) this.reader = null;
      this.readerReleasePending = false;
    }
    if (this.fixture) { await this.fixture.close(); this.fixture = null; }
    if (this.profile && !this.profilePersistent && path.basename(this.profile).startsWith('temporary-')) {
      await this.ensureOwnedDirectory(this.profile);
      await rm(this.profile, { recursive: true });
    }
    this.profile = null;
    this.profilePersistent = false;
    this.readerReleasePending = false;
    this.state = this.job ? 'ResumeCheck' : 'Idle';
  }

  close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.invalidate(null);
    this.selectionCancelEpoch = (this.selectionCancelEpoch ?? 0) + 1;
    this.closePromise = (async () => {
      // UI commands can still own a browser that Reader.open has not returned
      // yet. Settle those commands before deleting its profile or closing Rust.
      this.destinationDialog?.abort();
      await this.reader?.cancelPick();
      await Promise.allSettled([...this.commands]);
      await this.loop;
      try { await this.closeBrowser(); }
      finally { await this.store.close(); }
    })();
    return this.closePromise;
  }
}
