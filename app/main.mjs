import { startApplication } from './server.mjs';
import { openKindleForUser } from './startup.mjs';
import { openControlWindow } from './control-window.mjs';

let running, controlWindow;
try {
  running = await startApplication({ sampleHeadless: false });
  console.log('KindleToZip ローカルMVPを起動しました。終了は Ctrl+C。');
  let closing = false, starting;
  const close = async () => {
    if (closing) return;
    closing = true;
    try {
      try { await controlWindow?.close(); }
      finally { await starting?.catch(() => {}); await running.close(); }
      process.exit(0);
    }
    catch { console.error('終了時の削除に失敗しました。専用一時セッションは次回画面で削除してください。'); process.exit(1); }
  };
  process.on('SIGINT', close);
  process.on('SIGTERM', close);
  controlWindow = await openControlWindow(running.url, { onClose: () => { void close(); } });
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
  if (process.env.KTZ_PORTABLE_ROOT) {
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
