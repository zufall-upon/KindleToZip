import { startApplication } from './server.mjs';
import { openKindleForUser } from './startup.mjs';
import { openControlWindow } from './control-window.mjs';
import { lstat, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { privateMetadata, samePath } from './private-path.mjs';
import { linuxStartupMessage } from './startup-error.mjs';

let running, controlWindow, ownedTemp, startupStage = 'temporary';
try {
  if (process.platform === 'linux') {
    process.umask(0o077);
    if (process.argv.includes('--kindle') || process.argv.includes('--resume-kindle')) {
      throw Object.assign(new Error('linux_kindle_unsupported'), { code: 'linux_kindle_unsupported' });
    }
    const base = process.env.KTZ_TEMP_DIR || tmpdir();
    if (process.env.KTZ_TEMP_DIR) {
      const info = await lstat(base);
      if (info.isSymbolicLink() || !privateMetadata(info, true) || !samePath(await realpath(base), base)) throw Object.assign(new Error('unsafe_temp_directory'), { code: 'unsafe_temp_directory' });
    }
    ownedTemp = await mkdtemp(path.join(base, 'ktz-'));
    // Restrict only this process and its owned browser children, not the user's environment.
    for (const key of ['KTZ_TEMP_DIR', 'TMPDIR', 'TMP', 'TEMP', 'HOME', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME']) process.env[key] = ownedTemp;
  }
  startupStage = 'storage';
  running = await startApplication({ sampleHeadless: process.platform === 'linux', ownsSignals: process.platform === 'linux' });
  if (process.platform !== 'linux') console.log('KindleToZip ローカルMVPを起動しました。終了は Ctrl+C。');
  let closing = false, starting, controlStarting;
  const close = async () => {
    if (closing) return;
    closing = true;
    try {
      try { await (controlWindow ?? await controlStarting?.catch(() => null))?.close(); }
      finally { await starting?.catch(() => {}); await running.close(); }
      if (ownedTemp) await rm(ownedTemp, { recursive: true, force: true });
      process.exit(0);
    }
    catch { console.error('終了時の削除に失敗しました。専用一時セッションは次回画面で削除してください。'); process.exit(1); }
  };
  process.on('SIGINT', close);
  process.on('SIGTERM', close);
  startupStage = 'control';
  controlStarting = openControlWindow(running.url, { onClose: () => { void close(); }, handleSignals: process.platform !== 'linux' });
  controlWindow = await controlStarting;
  if (process.platform === 'linux') console.log('KindleToZip ローカルMVPを起動しました。終了は Ctrl+C。');
  console.log('操作画面を拡張なしの専用ウィンドウで開きました。通常ブラウザは使用していません。');
  if (!closing && (process.argv.includes('--kindle') || process.argv.includes('--resume-kindle'))) {
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
  await controlWindow?.close().catch(() => {});
  await running?.close().catch(() => {});
  if (ownedTemp) await rm(ownedTemp, { recursive: true, force: true }).catch(() => {});
  if (error?.code === 'linux_kindle_unsupported') {
    console.error('LinuxではKindleの起動・取得は未対応です。自作試料のみ利用できます。');
  } else if (process.platform === 'linux') {
    console.error(linuxStartupMessage(error, startupStage));
  } else if (error?.code === 'controller_not_found') {
    console.error(error.message);
  } else if (process.env.KTZ_PORTABLE_ROOT) {
    if (error?.code === 'job_busy') {
      console.error('Portable版のデータは別の起動が使用中です。もう一方を終了してから再試行してください。データ保護のため同時起動はできません。');
    } else {
      console.error(`Portable版の保存先を利用できません: ${process.env.KTZ_PORTABLE_ROOT}。EXEと付随フォルダを、書き込み可能な通常フォルダへ一緒に移して再起動してください。利用者プロファイルへ保存先を切り替えることはありません。`);
    }
  } else {
    console.error('起動できません。Rustビルド、ブラウザの導入、データ領域の権限・別起動を確認してください。');
  }
  process.exitCode = 1;
}
