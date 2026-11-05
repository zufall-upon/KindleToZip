import { startApplication } from './server.mjs';
import { openKindleForUser } from './startup.mjs';
import { openControlWindow } from './control-window.mjs';
import { lstat, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { privateMetadata, samePath } from './private-path.mjs';
import { linuxStartupMessage } from './startup-error.mjs';
import { captureOwnedTemp, removeOwnedTemp } from './startup-cleanup.mjs';
import { capturePortableReaderEnvironment } from './linux-owned-reader.mjs';

let running, controlWindow, controlStarting, starting, ownedTemp, ownedIdentity, shutdownPromise;
let startupStage = 'temporary', applicationState = 'not_created';
const controlLifecycle = { state: 'not_created' };
const safe = state => state === 'not_created' || state === 'closed_confirmed';
const guiSmoke = process.argv.includes('--distribution-gui-smoke');
const limitedPilot = process.argv.includes('--portable-limited-pilot');
let pilotReported = false;
let pilotOutcomeReported = false;
let pilotReaderLifecycle;
function reportPilot(value) { console.log(`KTZ_PILOT ${JSON.stringify(value)}`); }
function pilotShutdown(result, lifecycle) {
  return { stage: 'shutdown', code: result.errors.length || result.retained ? 'unconfirmed' : 'confirmed',
    control: controlLifecycle.state === 'closed_confirmed', application: applicationState === 'closed_confirmed',
    reader: lifecycle ? lifecycle.state === 'closed_confirmed' : null, temporaryRemoved: Boolean(ownedTemp && !result.retained) };
}

// A single shutdown is shared by startup failure, window close and signals.
// Trying close is not itself proof of termination; always attempt both closes.
function shutdown() {
  return shutdownPromise ??= (async () => {
    const errors = [];
    if (controlStarting || controlWindow) {
      let acquired = controlWindow;
      try {
        acquired ??= await controlStarting;
        await acquired.close();
        controlLifecycle.state = 'closed_confirmed';
      } catch (error) {
        // Acquisition itself updates lifecycle; an acquired control's close
        // failure must not be confused with a successful internal close.
        if (acquired) controlLifecycle.state = 'close_failed';
        errors.push(error);
      }
    }
    await starting?.catch(() => {});
    if (running) {
      try { await running.close(); applicationState = 'closed_confirmed'; }
      catch (error) { applicationState = 'close_failed'; errors.push(error); }
    }
    let retained = false;
    if (ownedTemp) {
      if (safe(controlLifecycle.state) && safe(applicationState) && ownedIdentity) {
        try {
          // A successful start always exposes its data directory. Unknown
          // storage identity must not be treated as outside the runtime.
          const dataDirectory = running ? running.app?.dataDir ?? null : undefined;
          await removeOwnedTemp(ownedIdentity, dataDirectory);
        } catch (error) { retained = true; errors.push(error); }
      } else retained = true;
    }
    return { errors, retained };
  })();
}

function reportRetained(result) {
  if (result.retained) console.error('安全確認ができなかったため専用一時領域を保持しました。');
}
try {
  if (limitedPilot) {
    const { validatePortableLimitedPilot } = await import('./portable-limited-pilot.mjs');
    validatePortableLimitedPilot();
  }
  if (guiSmoke) {
    // Validate before any storage/temp/browser operation, on every platform.
    const { validateGuiSmokeRun } = await import('./linux-gui-smoke.mjs');
    await validateGuiSmokeRun();
  }
  if (process.platform === 'linux') {
    process.umask(0o077);
    if (process.argv.includes('--sample-owned-pipe') && (process.argv.length !== 3 || process.argv[2] !== '--sample-owned-pipe')) {
      throw Object.assign(new Error('invalid_browser_mode'), { code: 'invalid_browser_mode' });
    }
    capturePortableReaderEnvironment();
    const base = process.env.KTZ_TEMP_DIR || tmpdir();
    if (process.env.KTZ_TEMP_DIR) {
      const info = await lstat(base);
      if (info.isSymbolicLink() || !privateMetadata(info, true) || !samePath(await realpath(base), base)) throw Object.assign(new Error('unsafe_temp_directory'), { code: 'unsafe_temp_directory' });
    }
    ownedTemp = await mkdtemp(path.join(base, 'ktz-'));
    ownedIdentity = await captureOwnedTemp(ownedTemp);
    // Restrict only this process and its owned browser children, not the user's environment.
    for (const key of ['KTZ_TEMP_DIR', 'TMPDIR', 'TMP', 'TEMP', 'HOME', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME']) process.env[key] = ownedTemp;
  }
  startupStage = 'storage';
  applicationState = 'ownership_unknown';
  running = await startApplication({ sampleHeadless: process.platform === 'linux',
    ownedSampleHeaded: process.platform === 'linux' && process.argv.includes('--sample-headed'),
    ownedSamplePipe: process.platform === 'linux' && process.argv.includes('--sample-owned-pipe'),
    portableArchiveTrial: limitedPilot, ownsSignals: process.platform === 'linux' });
  if (process.platform !== 'linux') console.log('KindleToZip ローカルMVPを起動しました。終了は Ctrl+C。');
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    if (limitedPilot && !pilotReported && !pilotOutcomeReported) reportPilot({ stage: 'stopped', code: 'user_stopped' });
    const lifecycle = running?.app?.readerLifecycle ?? running?.app?.portableArchiveReaderLifecycle ?? pilotReaderLifecycle;
    const result = await shutdown();
    if (limitedPilot && !pilotReported) { pilotReported = true; reportPilot(pilotShutdown(result, lifecycle)); }
    if (!limitedPilot) reportRetained(result);
    if (result.errors.length || result.retained) {
      if (!limitedPilot) console.error('終了を確認できませんでした。');
      process.exit(1);
    }
    process.exit(limitedPilot ? 1 : 0);
  };
  process.on('SIGINT', close);
  process.on('SIGTERM', close);
  startupStage = 'control';
  controlStarting = openControlWindow(running.url, { onClose: () => { void close(); }, handleSignals: process.platform !== 'linux', lifecycle: controlLifecycle });
  controlWindow = await controlStarting;
  if (!limitedPilot && process.platform === 'linux') console.log('KindleToZip ローカルMVPを起動しました。終了は Ctrl+C。');
  if (!limitedPilot) console.log('操作画面を拡張なしの専用ウィンドウで開きました。通常ブラウザは使用していません。');
  if (limitedPilot) {
    const { runPortableLimitedPilot } = await import('./portable-limited-pilot.mjs');
    const outcome = await runPortableLimitedPilot({ control: controlWindow, app: running.app, origin: running.origin, waiting: reportPilot });
    reportPilot(outcome);
    pilotOutcomeReported = true;
    pilotReaderLifecycle = running.app.readerLifecycle ?? running.app.portableArchiveReaderLifecycle;
    if (outcome.stage === 'stopped' && !closing) {
      const held = await running.app.holdPortablePilotStop(outcome);
      // Keep the existing control window/server, not the Kindle Reader. Only
      // native window close/signals can finish this immutable failed attempt.
      if (!closing) reportPilot({ stage: 'held', code: 'stopped', readerClose: held.readerClose });
      process.exitCode = 1;
    } else {
      const lifecycle = running.app.readerLifecycle ?? pilotReaderLifecycle;
      const closed = await shutdown();
      pilotReported = true;
      reportPilot(pilotShutdown(closed, lifecycle));
      if (outcome.code !== 'completed' || closed.errors.length || closed.retained) process.exitCode = 1;
      else process.exitCode = 0;
    }
  }
  if (guiSmoke) {
    const { runAnonymousGuiSmoke } = await import('./linux-gui-smoke.mjs');
    const result = await runAnonymousGuiSmoke({ page: controlWindow.page, app: running.app });
    const closed = await shutdown();
    reportRetained(closed);
    if (closed.errors.length || closed.retained) throw new Error('gui_smoke_shutdown_unconfirmed');
    result.shutdown = { control: controlLifecycle.state, application: applicationState, temporaryRemoved: true };
    await writeFile(result.resultPath, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    console.log(`KTZ_GUI_SMOKE_RESULT ${JSON.stringify(result)}`);
    process.exit(0);
  }
  if (!closing && process.platform === 'linux' && (process.argv.includes('--kindle') || process.argv.includes('--resume-kindle'))) {
    // Linux requires an explicit saved session (and, for recovery, an explicit
    // job) in the same ordinary GUI. A launch flag is never consent or a target.
    console.log('操作画面で作業と保存専用セッションを選択してください。接続・取得は開始していません。');
  } else if (!closing && (process.argv.includes('--kindle') || process.argv.includes('--resume-kindle'))) {
    console.log('専用Kindleブラウザを開いています。まだ撮影・取得は開始しません。');
    try {
      starting = openKindleForUser(running.app, { resumeTemporary: process.argv.includes('--resume-kindle') });
      await starting;
      console.log('専用ブラウザを開きました。ログイン・追加認証・1冊の選択は本人が行ってください。');
    } catch {
      console.error('専用ブラウザを開けませんでした。ローカル画面から再試行できます。取得は開始していません。');
    }
  }
} catch (error) {
  const result = await shutdown();
  if (!limitedPilot) reportRetained(result);
  if (limitedPilot) {
    reportPilot({ stage: 'stopped', code: error?.pilotCode === 'reader_lifecycle_unsupported' ? error.pilotCode : 'unclassified' });
    if (!pilotReported) { pilotReported = true; reportPilot(pilotShutdown(result, running?.app?.readerLifecycle)); }
  } else if (guiSmoke) {
    console.error(`匿名GUI検証失敗: ${String(error?.message ?? 'unknown').replace(/https?:\/\/\S+/g, '[owned-ui]').replace(/[a-f0-9]{64}/g, '[digest]')}`);
  } else if (error?.code === 'linux_kindle_unsupported') {
    console.error('LinuxではKindleの起動・取得は未対応です。自作試料のみ利用できます。');
  } else if (process.platform === 'linux') {
    console.error(linuxStartupMessage(error, startupStage));
  } else if (error?.code === 'controller_not_found') {
    console.error('実行可能なRust controllerが見つかりません。既存ビルドを確認してください。');
  } else if (process.env.KTZ_PORTABLE_ROOT) {
    if (error?.code === 'job_busy') {
      console.error('Portable版のデータは別の起動が使用中です。もう一方を終了してから再試行してください。データ保護のため同時起動はできません。');
    } else {
      console.error('Portable版の保存先を利用できません。EXEと付随フォルダを、書き込み可能な通常フォルダへ一緒に移して再起動してください。利用者プロファイルへ保存先を切り替えることはありません。');
    }
  } else {
    console.error('起動できません。Rustビルド、ブラウザの導入、データ領域の権限・別起動を確認してください。');
  }
  process.exitCode = 1;
}
