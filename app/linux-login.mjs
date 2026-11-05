// This entry opens only the official Japanese Kindle website. It does not load
// the acquisition Application, Reader, controller, or their HTTP interface.
import { userInfo } from 'node:os';
import { spawn } from 'node:child_process';
import { linuxLoginRoot, runLinuxLogin, snapLoginPreflight } from './linux-login-core.mjs';

const validInvocation = process.platform === 'linux' && process.argv.length === 2;
try {
  if (!validInvocation) throw Object.assign(new Error(), { code: 'invalid_login_invocation' });
  process.umask(0o077);
  const home = userInfo().homedir;
  const root = linuxLoginRoot(home);
  await runLinuxLogin({ root, url: 'https://read.amazon.co.jp/', preflight: () => snapLoginPreflight(home),
    requireExistingProfile: true, requireAbsentSingleton: true, requiredArgs: ['--ozone-platform=wayland'],
    onStarted: () => console.log('専用ログイン画面を開きました。ログインはご本人が行ってください。選書・取得は不要です。終了はブラウザの全ウィンドウを閉じてください。') });
} catch (error) {
  let message;
  if (error?.code === 'login_in_use_or_unknown') {
    message = '専用ログイン領域は使用中か終了状態が不明です。削除せず、先に安全を確認してください。';
  } else if (['login_start_unconfirmed', 'login_close_unconfirmed'].includes(error?.code)) {
    message = 'ブラウザの起動または終了を確認できません。専用領域と排他情報を保持しました。';
  } else {
    message = '安全な専用ログインを開始できません。設定・権限・専用領域の状態を確認してください。';
  }
  console.error(message);
  if (validInvocation) {
    // Desktop entries have no terminal. Use the already installed system dialog
    // when available; failing to display it must not conceal the failure code.
    const dialog = spawn('/usr/bin/zenity', ['--error', '--title=KindleToZip 専用ログイン', `--text=${message}`], { detached: true, stdio: 'ignore' });
    dialog.on('error', () => {}); dialog.unref();
  }
  process.exitCode = 1;
}
