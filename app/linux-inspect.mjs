// Separate from the login-only shortcut and from all acquisition interfaces.
// No URL, profile, debugging, or general command is accepted from the caller.
import { userInfo } from 'node:os';
import { spawn } from 'node:child_process';
import { linuxLoginRoot, snapLoginPreflight } from './linux-login-core.mjs';
import { runLinuxInspect, inspectFailureDiagnostic } from './linux-inspect-core.mjs';

// All callers below supply fixed local text. Never pass page metadata or a
// caller-supplied executable. The owned dialog is joined even on cancellation.
async function ownedDialog(ended, args) {
  const dialog = spawn('/usr/bin/zenity', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let closed = false, spawnError = false, browserEnded = false;
  let diagnosticPresent = false, diagnosticError = false;
  // Zenity can exit 1 both for cancellation and for a display/startup failure.
  // Drain stderr without decoding or retaining its potentially private bytes.
  dialog.stderr.on('data', () => { diagnosticPresent = true; });
  dialog.stderr.once('error', () => { diagnosticError = true; });
  const joined = new Promise(resolve => {
    dialog.once('error', () => { spawnError = true; });
    dialog.once('close', (code, signal) => { closed = true; resolve({ code, signal }); });
  });
  ended.then(() => { browserEnded = true; if (!closed) { try { dialog.kill('SIGTERM'); } catch { /* retain the join */ } } });
  const outcome = await joined;
  const unavailable = spawnError || diagnosticError || Boolean(outcome.signal)
    || ![0, 1].includes(outcome.code) || (outcome.code === 1 && diagnosticPresent);
  return { ...outcome, spawnError, browserEnded, unavailable };
}

const validInvocation = process.platform === 'linux' && process.argv.length === 2;
try {
  if (!validInvocation) throw Object.assign(new Error(), { code: 'invalid_inspect_invocation' });
  process.umask(0o077);
  const home = userInfo().homedir;
  const root = linuxLoginRoot(home);
  const url = 'https://read.amazon.co.jp/';
  const result = await runLinuxInspect({ root, url, expectedOrigin: new URL(url).origin,
    preflight: () => snapLoginPreflight(home),
    confirm: async ended => {
      console.log('専用画面でご本人が対象本を開いた後、確認ダイアログの「表示状態だけを確認」を押してください。取得・ページ送りは行いません。');
      // A fixed local dialog works without terminal stdin. No page-derived text
      // or user-supplied command is passed to it. Closing the browser cancels
      // only this owned dialog; the application never signals the browser.
      const outcome = await ownedDialog(ended, ['--question', '--title=KindleToZip 表示状態の確認',
        '--text=専用ブラウザで対象の本を一冊開いてから、表示状態だけを確認してください。取得・保存・ページ送りは行いません。',
        '--ok-label=表示状態だけを確認', '--cancel-label=確認せず終了']);
      const code = outcome.spawnError ? 'inspect_confirmation_unavailable'
        : outcome.browserEnded ? 'inspect_confirmation_browser_ended'
          : outcome.unavailable ? 'inspect_confirmation_unavailable'
            : outcome.code === 1 ? 'inspect_confirmation_cancelled' : null;
      if (code) throw Object.assign(new Error(code), { code });
    },
    notify: async (ok, ended) => {
      const message = ok
        ? '一回の表示確認を終えました。専用ブラウザを通常終了してください。終了確認後に結果を表示します。'
        : '表示確認を中止しました。専用ブラウザを通常終了してください。';
      console.log(message);
      const outcome = await ownedDialog(ended, ['--info', '--title=KindleToZip 表示状態の確認', `--text=${message}`, '--ok-label=閉じる']);
      // A normal dismissal is allowed, including our own dialog's termination
      // when the person has already closed the browser. Other failures are not.
      if (outcome.spawnError || (!outcome.browserEnded && outcome.unavailable)) throw new Error('notification_unavailable');
    },
  });
  console.log(JSON.stringify({ 種別: '表示状態のみ', 書名: result.title, 位置: result.position, 領域: result.region }));
} catch (error) {
  const message = error?.code === 'login_in_use_or_unknown'
    ? '専用領域は使用中か状態不明です。削除・再生成せず保留してください。'
    : '表示確認は成立しませんでした。専用領域や不明な排他情報は削除せず、安全を確認してください。';
  console.error(message);
  console.error(`表示確認の診断: ${JSON.stringify(inspectFailureDiagnostic(error))}`);
  process.exitCode = 1;
}
