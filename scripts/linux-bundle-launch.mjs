import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { lstat, mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { verifyBundle } from './linux-distribution.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
try {
  if (process.platform !== 'linux' || process.arch !== 'x64' || ![0, 1].includes(process.argv.length - 2)
      || process.argv.length === 3 && !['--kindle', '--resume-kindle', '--self-check', '--headless-self-check', '--login', '--anonymous-profile-check', '--distribution-gui-smoke', '--portable-limited-pilot'].includes(process.argv[2])) throw new Error('invalid_invocation');
  if (process.argv[2] === '--portable-limited-pilot' && root !== '/home/user/KTZ-Portable') throw new Error('invalid_invocation');
  await verifyBundle(root);
  // Chromium's profile/Singleton socket must fit Linux sockaddr_un. Reject
  // before launch rather than repeatedly starting a partial long-path browser.
  if (Buffer.byteLength(path.join(root, 'temp/ktz-XXXXXX/playwright_chromiumdev_profile-XXXXXX/SingletonSocket')) >= 108) {
    throw new Error('portable_path_too_long: ホーム内の短い非隠しフォルダーへ一式を配置してください');
  }
  const data = path.join(root, 'data');
  try { await mkdir(data, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const info = await lstat(data);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077)
      || await realpath(data) !== data) throw new Error('unsafe_data_directory');
  process.env.KTZ_USER_DATA_DIR = path.join(data, 'application');
  const temp = path.join(root, 'temp');
  try { await mkdir(temp, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const tempInfo = await lstat(temp);
  if (!tempInfo.isDirectory() || tempInfo.isSymbolicLink() || tempInfo.uid !== process.getuid() || (tempInfo.mode & 0o077)
      || await realpath(temp) !== temp) throw new Error('unsafe_temp_directory');
  process.env.KTZ_TEMP_DIR = temp;
  process.env.KTZ_PORTABLE_ROOT = root;
  process.env.KTZ_CONTROLLER_PATH = path.join(root, 'runtime/controller');
  process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(root, 'artifacts/browsers');
  if (['--self-check', '--headless-self-check'].includes(process.argv[2])) {
    const { selfCheck } = await import('./linux-bundle-self-check.mjs');
    await selfCheck(data, { headless: process.argv[2] === '--headless-self-check' });
  } else if (['--login', '--anonymous-profile-check'].includes(process.argv[2])) {
    const { runPortableLinuxLogin } = await import('../app/linux-portable-login.mjs');
    await runPortableLinuxLogin(root, { anonymous: process.argv[2] === '--anonymous-profile-check' });
  } else {
    const main = path.join(root, 'app/main.mjs');
    const smoke = process.argv[2] === '--distribution-gui-smoke';
    const pilot = process.argv[2] === '--portable-limited-pilot';
    const normalArgument = ['--kindle', '--resume-kindle'].includes(process.argv[2]) ? process.argv[2] : null;
    if (smoke) {
      const isolated = await mkdtemp(path.join(data, 'gui-smoke-'));
      await writeFile(path.join(isolated, 'anonymous-gui.json'), JSON.stringify({ version: 1, kind: 'new-anonymous-gui-run' }), { flag: 'wx', mode: 0o600 });
      process.env.KTZ_USER_DATA_DIR = path.join(isolated, 'application');
    }
    process.argv = [process.execPath, main, ...(smoke ? ['--distribution-gui-smoke'] : pilot ? ['--portable-limited-pilot'] : normalArgument ? [normalArgument] : [])];
    await import(pathToFileURL(main).href);
  }
} catch (error) {
  if (process.argv.includes('--portable-limited-pilot')) console.error('KTZ_PILOT {"stage":"launcher","code":"unclassified"}');
  else console.error(`Linuxバンドルを開始できません: ${error?.code ?? error?.message ?? 'unknown'}`);
  process.exitCode = 1;
}
