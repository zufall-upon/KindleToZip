// Fixed one-attempt login-reuse observation. No arbitrary URL/profile/debug CLI.
import { userInfo } from 'node:os';
import { mkdir, lstat, realpath, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { linuxLoginRoot, snapLoginPreflight } from './linux-login-core.mjs';
import { runAuthOwner, collectAuthResult } from './linux-auth-reuse-core.mjs';

process.umask(0o077);
if (process.platform === 'linux' && process.argv.length === 3 && process.argv[2] === '--owner' && process.send) {
  let retained = false, waitingRelease = false, released = false, wakeRelease;
  process.on('message', message => {
    if (!message || Object.keys(message).length !== 1) return;
    if (message.event === 'retain') { retained = true; wakeRelease?.(); }
    if (message.event === 'release' && waitingRelease) { released = true; wakeRelease?.(); }
  });
  process.once('disconnect', () => { retained = true; wakeRelease?.(); });
  const home = userInfo().homedir;
  await runAuthOwner({ root: linuxLoginRoot(home), preflight: () => snapLoginPreflight(home), retained: () => retained,
    release: async () => {
      waitingRelease = true;
      const permission = new Promise(resolve => { wakeRelease = resolve; });
      try { process.send({ event: 'release-ready' }, () => {}); } catch { retained = true; }
      if (retained || !process.connected) wakeRelease();
      await permission;
      if (!released) retained = true;
      waitingRelease = false;
    },
    notify: result => { try { process.send({ event: 'result', result }, () => {}); } catch {} } });
  if (process.connected) process.disconnect();
} else if (process.platform === 'linux' && process.argv.length === 2) {
  let output;
  try {
    const directory = fileURLToPath(new URL('../artifacts/login-reuse-20261102', import.meta.url));
    await mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.geteuid() || (info.mode & 0o7777) !== 0o700 || await realpath(directory) !== directory) throw new Error('unsafe_result_directory');
    // Also serves as an irreversible dispatch marker. Never repeat an attempt
    // after interruption or overwrite an earlier collected observation.
    output = await open(`${directory}/observation.json`, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await output.writeFile('{"version":1,"status":"dispatched"}\n'); await output.sync();
    const result = await collectAuthResult();
    const bytes = Buffer.from(JSON.stringify(result, null, 2) + '\n');
    await output.write(bytes, 0, bytes.length, 0); await output.truncate(bytes.length); await output.sync();
    console.log(`同profile認証UI確認: ${result.probe.state} / 終了: ${result.shutdown} / 排他: ${result.lock}`);
    process.exitCode = result.shutdown === 'normal' && result.owner.exited && !result.owner.retained ? 0 : 1;
  } catch {
    console.error('確認を開始または収集できませんでした。既存の結果・専用領域は保持し、自動再試行しません。');
    process.exitCode = 1;
  } finally { await output?.close(); }
} else {
  console.error('固定の確認入口だけを使用してください。');
  process.exitCode = 1;
}
