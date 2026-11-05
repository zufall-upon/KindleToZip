// 配置物の新規ログイン分岐とReader相当pipeを、本人データと分離して検査する。
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, mkdtemp, readFile, lstat, rename, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { hashFile, verifyBundle } from '../../scripts/linux-distribution.mjs';
import { appFiles } from '../../scripts/linux-distribution.mjs';
import { ownedPipeTransport } from '../../app/linux-playwright-pipe.mjs';
import { closeOwnedInspectionBrowser } from '../../app/linux-inspect-resume-core.mjs';
import { runLinuxLogin, snapLoginPreflight } from '../../app/linux-login-core.mjs';
import { userInfo } from 'node:os';

export async function portableNewLoginFixture() {
  const bundle = '/home/user/KTZ-Portable';
  const receipt = await verifyBundle(bundle);
  for (const relative of [...appFiles, 'scripts/linux-bundle-launch.mjs', 'scripts/linux-distribution.mjs', 'docs/linux-login.ja.md', 'docs/ubuntu-portable.ja.md']) {
    assert.equal(await hashFile(path.join(bundle, relative)), await hashFile(new URL(`../../${relative}`, import.meta.url)));
  }
  const desktop = '/home/user/デスクトップ/KindleToZip-Ubuntu-Portable-ログイン.desktop';
  const text = await readFile(desktop, 'utf8');
  assert.match(text, /^Exec=\/home\/user\/KTZ-Portable\/start-linux-bundle\.sh --login$/m);
  assert.match(text, /^Path=\/home\/user\/KTZ-Portable$/m);
  assert.match(text, /^Name=KindleToZip Ubuntu Portable ログイン$/m);
  assert.ok((await lstat(desktop)).mode & 0o100);
  const { resolvePortableLinuxSession } = await import(pathToFileURL(path.join(bundle, 'app/portable-linux-session.mjs')));
  const base = '/home/user/KTZ-New-Login-Tests'; await mkdir(base, { recursive: true, mode: 0o700 });
  const fixture = await mkdtemp(path.join(base, 'run-'));
  let root = path.join(fixture, 'before'); await mkdir(root, { mode: 0o700 });
  const server = http.createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>Anonymous login fixture</title><p>No account or book.</p>'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const program = `import {runPortableLinuxLogin} from ${JSON.stringify(pathToFileURL(path.join(bundle, 'app/linux-portable-login.mjs')).href)};process.umask(0o077);await runPortableLinuxLogin(process.env.KTZ_NEW_LOGIN_FIXTURE);`;
    const observations = [];
    async function login() {
      const child = spawn(path.join(bundle, 'runtime/node'), ['--import', new URL('./portable-new-login-hook.mjs', import.meta.url).href, '--input-type=module', '-e', program], {
        env: { ...process.env, KTZ_NEW_LOGIN_FIXTURE: root, KTZ_NEW_LOGIN_ORIGIN: origin }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
      assert.deepEqual(await new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal }))), { code: 0, signal: null }, output);
      const observation = JSON.parse(await readFile(path.join(root, 'login-observation.json'), 'utf8'));
      assert.equal(observation.failed, undefined); assert.equal(observation.sandbox, true); assert.equal(observation.normalFlags, true);
      observations.push(observation);
      const selected = await resolvePortableLinuxSession(path.join(root, 'data/application'));
      await assert.rejects(lstat(path.join(selected.root, 'owned/in-use.lock')), { code: 'ENOENT' });
      return selected;
    }
    const first = await login(); assert.equal(observations[0].retained, false);
    const identity = await lstat(first.profile);
    const session = await readFile(path.join(root, 'data/application/kindle-session.json'));
    const old = root; root = path.join(fixture, 'after'); await rename(old, root);
    await assert.rejects(lstat(old), { code: 'ENOENT' });
    const second = await login(); assert.equal(observations[1].retained, true);
    assert.equal(second.id, first.id);
    assert.deepEqual([identity.dev, identity.ino], [(await lstat(second.profile)).dev, (await lstat(second.profile)).ino]);
    assert.deepEqual(await readFile(path.join(root, 'data/application/kindle-session.json')), session);
    // 同じ解決結果でReader同様のpipeを実際に開き、匿名値だけを読む。
    const { chromium } = await import('playwright');
    let readerRetained = false;
    await runLinuxLogin({ root: second.root, url: origin, preflight: () => snapLoginPreflight(userInfo().homedir),
      requireExistingProfile: true, requireAbsentSingleton: true, joinUnconfirmedStart: true,
      requiredArgs: ['--ozone-platform=wayland', '--remote-debugging-pipe'],
      launch(exe, args) {
        const env = { ...process.env, DISPLAY: '' }; delete env.CHROMIUM_FLAGS;
        const child = spawn(exe, [...args.slice(0, -1), '--ozone-platform=wayland', '--disable-background-networking', '--remote-debugging-pipe', args.at(-1)],
          { env, detached: true, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
        child.stdio[3].on('error', () => {}); child.stdio[4].on('error', () => {}); return child;
      },
      async onStarted(context) {
        let transport;
        try {
          await context.assertProcessStillOwned(); transport = ownedPipeTransport(context.child);
          const browser = await chromium.connectOverCDP(transport, { noDefaults: true, timeout: 10000 });
          const page = browser.contexts()[0].pages()[0]; await page.waitForURL(`${origin}/`);
          readerRetained = await page.evaluate(() => localStorage.getItem('ktz-new-login-anonymous') === 'fixture-only');
        } finally {
          transport?.close();
          await closeOwnedInspectionBrowser({ ...context, onUnknown: () => { throw new Error('anonymous_reader_close_unknown'); } });
        }
      },
    });
    assert.equal(readerRetained, true);
    await assert.rejects(lstat(path.join(second.root, 'owned/in-use.lock')), { code: 'ENOENT' });
    const result = { kind: 'portable-new-login-anonymous', fixture, desktopChecked: true, observations, sameRelativeId: true,
      sameFilesystemRename: true, readerPipeRetained: true, normalClose: true, authenticated: 'not-tested',
      receiptSha256: await hashFile(path.join(bundle, 'receipt.json')), appSourceSha256: receipt.appSourceSha256 };
    await mkdir('artifacts/ubuntu-portable/new-login', { recursive: true, mode: 0o700 });
    await writeFile(`artifacts/ubuntu-portable/new-login/${path.basename(fixture)}.json`, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    return result;
  } finally { await new Promise(resolve => server.close(resolve)); }
}
