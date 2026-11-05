import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { userInfo } from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, lstat } from 'node:fs/promises';
import http from 'node:http';
import { probeLoginUi, projectAuthProbe, projectAuthResult, observeAuthUi, runAuthOwner, collectAuthResult, launchAuthBrowser, libraryUrl } from '../app/linux-auth-reuse-core.mjs';
import { linuxLoginRoot, prepareLinuxLoginProfile, runLinuxLogin, snapLoginPreflight } from '../app/linux-login-core.mjs';
import { closeOwnedInspectionBrowser } from '../app/linux-inspect-resume-core.mjs';
import { ownedPipeTransport } from '../app/linux-playwright-pipe.mjs';

const blank = () => ({ state: 'unknown', basis: 'positive-ui-unestablished', library: true, reauth: false, modal: false, signout: false });
const positive = () => ({ ...blank(), state: 'authenticated_ui', basis: 'visible-signout-on-library', signout: true });
const negative = () => ({ ...blank(), state: 'reauth_required', basis: 'visible-auth-input', library: false, reauth: true });
const result = (probe = blank(), shutdown = 'normal') => ({ version: 1, kind: 'linux-login-reuse', scope: 'library-ui-only',
  profile: 'existing-dedicated', connection: 'reader-pipe', probe, shutdown, lock: shutdown === 'normal' ? 'released' : 'retained-or-unknown' });

test('認証UI述語: 可視の肯定・再認証・不明を分け、秘密文字列や入力値を読まない', () => {
  function evaluate({ signout = false, reauth = false, modal = false, hidden = false, external = false, book = false } = {}) {
    const element = { isConnected: true, nodeType: 1, parentElement: null,
      getClientRects: () => [{ width: 50, height: 20, left: 1, top: 1, right: 51, bottom: 21 }] };
    for (const key of ['value', 'textContent', 'innerText', 'innerHTML']) Object.defineProperty(element, key, { get() { throw new Error('secret_read'); } });
    return JSON.parse(JSON.stringify(runInNewContext(`(${probeLoginUi.toString()})()`, {
      location: { origin: external ? 'https://example.invalid' : 'https://read.amazon.co.jp', pathname: book ? '/kindle-library/manga-wr/private' : '/kindle-library' },
      document: { querySelectorAll(selector) {
        if (selector.startsWith('input[')) return reauth ? [element] : [];
        if (selector.startsWith('[aria-modal')) return modal ? [element] : [];
        if (selector.startsWith('button[aria-label')) return signout ? [element] : [];
        throw new Error('unbounded_selector');
      } }, getComputedStyle: () => ({ display: hidden ? 'none' : 'block', visibility: 'visible', opacity: '1' }), innerWidth: 800, innerHeight: 600,
    })));
  }
  assert.deepEqual(evaluate({ signout: true }), positive(), '空の本棚でも可視の明示signoutが必要');
  assert.equal(evaluate({ reauth: true }).state, 'reauth_required');
  for (const setup of [{}, { signout: true, hidden: true }, { signout: true, external: true }, { signout: true, book: true }, { signout: true, modal: true }, { signout: true, reauth: true }]) {
    assert.equal(evaluate(setup).state, 'unknown', JSON.stringify(setup));
  }
});

test('認証結果projector: 閉じたenum/booleanだけを保持し不整合な成功を拒否', () => {
  assert.deepEqual(projectAuthProbe({ ...positive(), secret: 'FIXTURE_PRIVATE' }), positive());
  assert.deepEqual(projectAuthResult({ ...result(), secret: 'FIXTURE_PRIVATE' }), result());
  assert.throws(() => projectAuthProbe({ ...positive(), signout: false }), /invalid_auth_probe/);
  assert.throws(() => projectAuthProbe({ ...positive(), library: 'private' }), /invalid_auth_probe/);
  assert.throws(() => projectAuthResult({ ...result(positive()), connection: 'unconfirmed' }), /invalid_auth_result/);
  assert.throws(() => projectAuthResult({ ...result(), lock: 'retained-or-unknown' }), /invalid_auth_result/);
});

test('非秘密observer: 初期pageの復元を拒否し、観測失敗後の暫定肯定を採用しない', async () => {
  async function observe(sequence, { initial = false } = {}) {
    const child = { stdio: [null, null, null, new PassThrough(), new PassThrough()] };
    let page, calls = 0, navigated = false;
    const context = { pages: () => initial || page ? [page ?? {}] : [], on() {}, async newPage() {
      page = { isClosed: () => false, async goto(url) { assert.equal(url, libraryUrl); navigated = true; }, async evaluate(fn) {
        assert.equal(fn, probeLoginUi); const value = sequence[Math.min(calls++, sequence.length - 1)];
        if (value instanceof Error) throw value; return value;
      } }; return page;
    } };
    const value = await observeAuthUi(child, { deadlineMs: 700,
      connect: async () => ({ contexts: () => [context] }) });
    child.stdio[3].destroy(); child.stdio[4].destroy();
    return { value, navigated };
  }
  assert.equal((await observe([positive()])).value.probe.state, 'authenticated_ui');
  assert.equal((await observe([negative()])).value.probe.state, 'reauth_required');
  assert.equal((await observe([blank()])).value.probe.state, 'unknown');
  const failed = await observe([positive(), new Error('PRIVATE_URL_AND_TOKEN')]);
  assert.equal(failed.value.probe.state, 'unknown');
  assert.doesNotMatch(JSON.stringify(failed), /PRIVATE_URL|TOKEN/);
  const initial = await observe([positive()], { initial: true });
  assert.equal(initial.navigated, false);
  assert.equal(initial.value.probe.basis, 'unexpected-initial-pages');
});

test('所有lifecycle: 正常終了だけ成功、終了不明/retain後にnormalへ反転しない', async () => {
  async function run(mode) {
    const events = [], notices = [];
    let retained = false;
    const execution = runAuthOwner({ root: '/anonymous-fixture', preflight: async () => {},
      notify: value => notices.push(value), retained: () => retained,
      launch: () => new EventEmitter(), observe: async () => { if (mode === 'retain') retained = true; return { connected: true, probe: positive() }; },
      close: async options => { events.push('close'); if (mode === 'unknown') await options.onUnknown(); },
      holdUnknown: async () => { events.push('hold'); throw new Error('fixture_held'); },
      login: async options => {
        assert.equal(options.resumeSession, 'settings');
        assert.equal(options.requireExistingProfile, true); assert.equal(options.requireAbsentSingleton, true);
        assert.deepEqual(options.requiredArgs, ['--ozone-platform=wayland', '--no-startup-window', '--remote-debugging-pipe']);
        options.launch('/snap/bin/chromium', []);
        await options.onStarted({ child: {}, assertProcessStillOwned: async () => {} });
        await options.beforeRelease(); events.push('released');
      },
    });
    if (mode === 'normal') await execution; else await assert.rejects(execution, /fixture_held/);
    return { events, notices };
  }
  const normal = await run('normal');
  assert.deepEqual(normal.events, ['close', 'released']);
  assert.equal(normal.notices[0].shutdown, 'normal');
  for (const mode of ['unknown', 'retain']) {
    const held = await run(mode);
    assert.equal(held.notices.length, 1);
    assert.equal(held.notices[0].shutdown, 'unknown');
    assert.equal(held.notices[0].lock, 'retained-or-unknown');
    assert.ok(!held.events.includes('released'));
  }
});

test('controller: unknownはsticky、所有者の正常終端まで結果を成功化しない', async () => {
  function fakeOwner() { const owner = new EventEmitter(); owner.connected = true; owner.sent = []; owner.send = message => owner.sent.push(message); owner.unref = () => {}; owner.channel = { unref() {} }; return owner; }
  const owner = fakeOwner();
  const collected = collectAuthResult({ createOwner: () => owner, timeoutMs: 100 });
  owner.emit('message', { event: 'release-ready' });
  owner.emit('message', { event: 'result', result: result() });
  owner.emit('close', 0, null);
  assert.deepEqual((await collected).owner, { exited: true, retained: false });
  assert.deepEqual(owner.sent, [{ event: 'release' }]);
  const unknownOwner = fakeOwner();
  const unknown = collectAuthResult({ createOwner: () => unknownOwner, timeoutMs: 100 });
  unknownOwner.emit('message', { event: 'result', result: result(blank(), 'unknown') });
  unknownOwner.emit('close', 0, null);
  assert.equal((await unknown).shutdown, 'unknown');
  assert.deepEqual(unknownOwner.sent, [{ event: 'retain' }]);
});

test('固定CLIは追加URL/profile指定や単独owner起動を拒否', () => {
  for (const argument of ['https://example.invalid/', '--owner', '--profile=/tmp/other']) {
    const run = spawnSync(process.execPath, [new URL('../app/linux-auth-reuse.mjs', import.meta.url).pathname, argument], { encoding: 'utf8', timeout: 3000 });
    assert.equal(run.status, 1); assert.doesNotMatch(run.stdout, /同profile認証UI確認/);
  }
});

if (process.env.KTZ_DESKTOP_TESTS === '1') test('匿名Snap: no-startup-windowで既存tab復元を抑止し所有pipeから安全終了', { timeout: 40_000 }, async t => {
  const home = userInfo().homedir;
  await snapLoginPreflight(home);
  const base = path.join(home, 'snap/chromium/common/ktz-auth-reuse-20261102');
  await mkdir(base, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const root = await mkdtemp(path.join(base, 'run-'));
  const owned = await prepareLinuxLoginProfile(root);
  const server = http.createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>Anonymous tab placeholder</title><p>Self-authored; no book or login.</p>'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { chromium } = await import('playwright');
  for (const mode of ['settings', 'last-session']) {
    await runLinuxLogin({ root, preflight: () => snapLoginPreflight(home), resumeSession: mode,
      requireExistingProfile: true, requireAbsentSingleton: true, launch: launchAuthBrowser,
      requiredArgs: ['--ozone-platform=wayland', '--no-startup-window', '--remote-debugging-pipe'],
      async onStarted(context) {
        let transport;
        try {
          await context.assertProcessStillOwned();
          transport = ownedPipeTransport(context.child);
          const browser = await chromium.connectOverCDP(transport, { noDefaults: true, timeout: 8000 });
          assert.equal(browser.contexts().length, 1);
          assert.equal(browser.contexts()[0].pages().length, 0, `初期tabなし: ${mode}`);
          const page = await browser.contexts()[0].newPage();
          await page.goto(`http://127.0.0.1:${server.address().port}/tab-placeholder`);
        } finally {
          transport?.close();
          await closeOwnedInspectionBrowser({ ...context, onUnknown: () => { throw new Error('anonymous_close_unknown'); } });
        }
      },
    });
    await assert.rejects(lstat(owned.lock), { code: 'ENOENT' });
  }
});
