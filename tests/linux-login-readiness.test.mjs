// No real website, acquisition entry, authentication store, or screenshot.
import test from 'node:test';
import assert from 'node:assert/strict';
import { userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, readFile, lstat, writeFile, realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { linuxLoginRoot, prepareLinuxLoginProfile, runLinuxLogin, snapLoginPreflight } from '../app/linux-login-core.mjs';
import { ownedPipeTransport } from '../app/linux-playwright-pipe.mjs';

const home = userInfo().homedir;
const desktop = path.join(home, 'デスクトップ/KindleToZip-ログイン.desktop');
const base = path.join(home, 'snap/chromium/common/ktz-login-readiness-20261102');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitJson(file, timeout = 30_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    try { return JSON.parse(await readFile(file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await sleep(50);
  }
  throw new Error(`匿名試験の終了待ち時間超過: ${path.basename(file)}`);
}
async function metadata(file) {
  try { const s = await lstat(file); return [s.dev, s.ino, s.mode, s.size, s.mtimeMs]; }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

test('ログイン準備: 固定profile定義と取得を含まないデスクトップ入口', async () => {
  const project = fileURLToPath(new URL('../', import.meta.url));
  const text = await readFile(desktop, 'utf8');
  const exec = /^Exec="([^"\n]+)" "([^"\n]+)"$/m.exec(text);
  assert.ok(exec, '引用符付きの固定Nodeと入口だけ');
  assert.equal(await realpath(exec[1]), await realpath(process.execPath));
  assert.equal(exec[2], `${project}app/linux-login.mjs`);
  assert.ok(text.includes(`Path=${project.slice(0, -1)}`));
  assert.match(text, /Name=KindleToZip ログイン用ブラウザ/);
  assert.match(text, /Icon=\/snap\/chromium\/current\/chromium.png/);
  assert.ok((await lstat(desktop)).mode & 0o100, '実デスクトップ入口は実行可能');
  const login = await readFile(new URL('../app/linux-login.mjs', import.meta.url), 'utf8');
  assert.match(login, /requireExistingProfile: true, requireAbsentSingleton: true/);
  assert.doesNotMatch(login, /^import[^\n]*(?:remote-debugging|reader|application|controller)/m);
  for (const name of ['linux-login', 'linux-inspect', 'linux-inspect-resume-owner', 'linux-playwright-resume-owner',
    'linux-playwright-expected-owner', 'linux-expected-reader-owner', 'linux-expected-capture-paths']) {
    const source = await readFile(new URL(`../app/${name}.mjs`, import.meta.url), 'utf8');
    assert.match(source, /linuxLoginRoot\(home\)/, name);
    assert.doesNotMatch(source, /snap\/chromium\/common\/kindle-to-zip-login/, name);
  }
  // Reads only our owner marker and directory metadata, never browser data.
  const existing = await prepareLinuxLoginProfile(linuxLoginRoot(home), { create: false });
  assert.equal(existing.profile, path.join(linuxLoginRoot(home), 'owned/profile'));
});

test('ログイン準備: 実GIO起動・匿名永続化・同時拒否・同じprofileのReader相当pipe', { timeout: 100_000 }, async t => {
  assert.ok(process.env.WAYLAND_DISPLAY, '既存のWaylandセッションが必要');
  await snapLoginPreflight(home);
  const actualRoot = linuxLoginRoot(home);
  const protectedEntries = ['owned', 'owned/profile', 'owned/owner.json', 'owned/in-use.lock', 'owned/profile/SingletonLock'];
  const before = await Promise.all(protectedEntries.map(p => metadata(path.join(actualRoot, p))));
  await mkdir(base, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const fixture = await mkdtemp(path.join(base, 'run-'));
  const fakeHome = path.join(fixture, 'home');
  await mkdir(path.join(fakeHome, 'snap/chromium/common/chromium'), { recursive: true, mode: 0o700 });
  const owned = await prepareLinuxLoginProfile(linuxLoginRoot(fakeHome));
  const server = http.createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    .end('<!doctype html><meta charset="utf-8"><title>匿名保存試験</title><h1>KindleToZip 匿名保存試験</h1><p>ログインも本の取得も行いません。</p>'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const hook = new URL('./support/linux-login-readiness-hook.mjs', import.meta.url).href;
  const env = { ...process.env, HOME: home, NODE_OPTIONS: `--import=${hook}`,
    KTZ_READINESS_FIXTURE: fixture, KTZ_READINESS_ORIGIN: origin,
    CHROMIUM_FLAGS: '--no-sandbox --password-store=basic' };
  delete env.DEBUG; delete env.PWDEBUG;
  async function launchDesktop(run) {
    const child = spawn('/usr/bin/gio', ['launch', desktop], { env: { ...env, KTZ_READINESS_RUN: run }, stdio: 'ignore' });
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal }));
    });
    assert.deepEqual(result, { code: 0, signal: null }, 'GIOの起動結果');
  }
  await launchDesktop('first');
  let first;
  try {
    first = await waitJson(path.join(fixture, 'first-ready.json'));
    await launchDesktop('busy');
    assert.deepEqual(await waitJson(path.join(fixture, 'busy-exit.json')), { code: 1 });
    assert.match(await waitJson(path.join(fixture, 'busy-message.json')), /使用中か終了状態が不明/);
    await assert.rejects(lstat(path.join(fixture, 'busy-launch.json')), { code: 'ENOENT' });
  } finally {
    await writeFile(path.join(fixture, 'release-first'), '', { flag: 'wx', mode: 0o600 });
    assert.deepEqual(await waitJson(path.join(fixture, 'first-exit.json')), { code: 0 });
  }
  function checkSandbox(value) {
    assert.match(value.sandboxStatus, /Seccomp-BPF sandbox\s+Yes/);
    assert.match(value.sandboxStatus, /PID namespaces\s+Yes/);
    assert.match(value.sandboxStatus, /Network namespaces\s+Yes/);
    assert.match(value.sandboxStatus, /You are adequately sandboxed/);
  }
  assert.equal(first.retained, false);
  checkSandbox(first);
  await assert.rejects(lstat(owned.lock), { code: 'ENOENT' });
  await launchDesktop('second');
  assert.deepEqual(await waitJson(path.join(fixture, 'second-exit.json')), { code: 0 });
  const second = await waitJson(path.join(fixture, 'second-ready.json'));
  assert.equal(second.retained, true);
  checkSandbox(second);
  for (const run of ['first', 'second']) {
    assert.deepEqual(await waitJson(path.join(fixture, `${run}-launch.json`)), {
      target: 'https://read.amazon.co.jp/', profile: owned.profile, flagsCleared: true, wayland: true, unsafeArgs: false,
    });
    await assert.rejects(lstat(path.join(fixture, `${run}-failure.json`)), { code: 'ENOENT' });
  }
  // Same owner contract/pipe as the future Reader, but only this fixture root
  // and local document; never execute a real Reader or consumed permission.
  const { chromium } = await import('playwright');
  await runLinuxLogin({ root: linuxLoginRoot(fakeHome), requireExistingProfile: true, requireAbsentSingleton: true,
    url: origin, preflight: () => snapLoginPreflight(home), requiredArgs: ['--ozone-platform=wayland', '--remote-debugging-pipe'],
    launch(exe, args) {
      const childEnv = { ...process.env, HOME: home, DISPLAY: '' };
      delete childEnv.CHROMIUM_FLAGS;
      const child = spawn(exe, [...args.slice(0, -1), '--ozone-platform=wayland', '--disable-background-networking', '--remote-debugging-pipe', args.at(-1)],
        { env: childEnv, detached: true, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
      child.stdio[3].on('error', () => {}); child.stdio[4].on('error', () => {});
      return child;
    },
    async onStarted({ child, assertProcessStillOwned }) {
      await assertProcessStillOwned();
      const browser = await chromium.connectOverCDP(ownedPipeTransport(child), { noDefaults: true, timeout: 10_000 });
      try {
        const page = browser.contexts()[0].pages()[0];
        await page.waitForURL(`${origin}/`);
        assert.equal(await page.evaluate(() => localStorage.getItem('ktz-anonymous-persistence')), 'fixture-only');
      } finally {
        const session = await browser.newBrowserCDPSession(); await session.send('Browser.close').catch(() => {});
      }
    },
  });
  await assert.rejects(lstat(owned.lock), { code: 'ENOENT' });
  assert.deepEqual(await Promise.all(protectedEntries.map(p => metadata(path.join(actualRoot, p)))), before,
    '本人用の専用領域・所有情報・排他metadataは変更しない');
  console.log('匿名のみ: GIO 2回・二重起動拒否・Wayland・namespace/seccomp sandbox・localStorage保持・Reader相当pipe・正常終了を確認。本人認証は未検証。');
});
