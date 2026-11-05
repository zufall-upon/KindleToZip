// No arbitrary source/profile/URL/command is accepted by this fixed entry.
// The agent must not invoke it against a person's data without individual consent.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ensurePortablePrivateDirectory } from './portable-linux-session.mjs';
import { linuxLoginRoot, runLinuxLogin, snapLoginPreflight } from './linux-login-core.mjs';
import { closeOwnedInspectionBrowser } from './linux-inspect-resume-core.mjs';
import { migrateLinuxLogin, rollbackLinuxLoginMigration, confirmLinuxLoginMigration } from './linux-profile-migration.mjs';

const execute = promisify(execFile);
const ownRoot = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');

export async function migrationToolPreflight() {
  // These already-installed GNU OS tools preserve/check opaque bytes and xattrs.
  // Missing/incompatible tools stop before accessing a profile; never install.
  for (const [file, pattern] of [['/usr/bin/cp', /GNU coreutils/], ['/usr/bin/tar', /GNU tar/]]) {
    const result = await execute(file, ['--version'], { env: { PATH: '/usr/bin:/bin', LANG: 'C' }, timeout: 5000, maxBuffer: 4096 });
    if (!pattern.test(result.stdout)) throw new Error('migration_tools_unavailable');
  }
}

export async function verifyFixedMigratedLogin(root) {
  const home = userInfo().homedir; let started = false;
  try {
    await runLinuxLogin({ root, url: 'https://read.amazon.co.jp/', preflight: () => snapLoginPreflight(home),
      requireExistingProfile: true, requireAbsentSingleton: true, joinUnconfirmedStart: true,
      requiredArgs: ['--ozone-platform=wayland', '--remote-debugging-pipe'],
      launch(executable, args) {
        const env = { ...process.env, DISPLAY: '' }; delete env.CHROMIUM_FLAGS;
        const child = spawn(executable, [...args.slice(0, -1), '--ozone-platform=wayland', '--remote-debugging-pipe', args.at(-1)],
          { env, detached: true, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
        child.stdio[3].on('error', () => {}); child.stdio[4].on('error', () => {}); child.stdio[4].resume();
        started = true; return child;
      },
      async onStarted(context) {
        await closeOwnedInspectionBrowser({ ...context, onUnknown: async () => { throw new Error('migration_target_shutdown_unknown'); } });
      },
    });
  } catch (error) {
    if (!started) throw error;
    // Do not drop a private pipe or reinterpret a late exit as normal. Retain
    // this owner and its locks; a separate explicit recovery is required.
    console.error('移行先の正常終了が未確認です。所有者と両profileを保全し、再試行しません。');
    setInterval(() => {}, 60000); await new Promise(() => {});
  }
}

export async function runFixedPortableMigration(root, action) {
  if (process.platform !== 'linux' || root !== ownRoot || process.env.KTZ_PORTABLE_ROOT !== root
      || !['--migrate-login', '--confirm-login-migration', '--rollback-login-migration'].includes(action)) throw new Error('invalid_migration_invocation');
  await migrationToolPreflight();
  const home = userInfo().homedir; await snapLoginPreflight(home);
  await ensurePortablePrivateDirectory(path.join(root, 'data'));
  await ensurePortablePrivateDirectory(path.join(root, 'data/application'));
  const options = { sourceRoot: linuxLoginRoot(home), dataDirectory: path.join(root, 'data/application'),
    shortcut: path.join(home, 'デスクトップ/KindleToZip-ログイン.desktop'), launcher: path.join(root, 'start-linux-bundle.sh') };
  if (action === '--migrate-login') {
    await migrateLinuxLogin(options);
    console.log('原本を保全して移行先を準備し、入口を切り替えました。まだ確定していません。明示的な正常起動確認またはrollbackが必要です。');
  } else if (action === '--confirm-login-migration') {
    await confirmLinuxLoginMigration(options, { verifyTarget: verifyFixedMigratedLogin });
    console.log('移行先の技術的な正常起動・終了を確認して確定しました。認証の有効性は自動判定していません。原本は保持しています。');
  } else {
    await rollbackLinuxLoginMigration(options);
    console.log('旧入口と相対設定へ明示的に復旧しました。旧原本・移行先・記録は保持しています。');
  }
}
