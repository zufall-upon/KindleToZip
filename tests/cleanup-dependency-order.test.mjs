import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createControlFirstCleanup } from './support/owned-control-cleanup.mjs';

test('所有cleanup: control完了→application完了→fixture削除を直列に待つ', async () => {
  const order = []; let releaseControl, releaseRunning;
  const control = new Promise(resolve => { releaseControl = resolve; });
  const running = new Promise(resolve => { releaseRunning = resolve; });
  const cleanup = createControlFirstCleanup({
    closeControl: async () => { order.push('control.start'); await control; order.push('control.end'); },
    closeRunning: async () => { order.push('running.start'); await running; order.push('running.end'); },
    removeFixture: async () => { order.push('remove'); },
  });
  const first = cleanup(); assert.equal(cleanup(), first); assert.deepEqual(order, ['control.start']);
  releaseControl(); await control; await Promise.resolve();
  assert.deepEqual(order, ['control.start', 'control.end', 'running.start']);
  releaseRunning(); await first;
  assert.deepEqual(order, ['control.start', 'control.end', 'running.start', 'running.end', 'remove']);
});

test('所有cleanup: 各終了失敗を保持し不確実なfixtureを削除しない', async t => {
  for (const failed of ['control', 'running', 'remove']) await t.test(failed, async () => {
    const error = new Error(failed), calls = [];
    const operation = name => async () => { calls.push(name); if (name === failed) throw error; };
    const cleanup = createControlFirstCleanup({ closeControl: operation('control'), closeRunning: operation('running'), removeFixture: operation('remove') });
    await assert.rejects(cleanup(), value => value === error);
    await assert.rejects(cleanup(), value => value === error);
    assert.deepEqual(calls, failed === 'remove' ? ['control', 'running', 'remove'] : ['control', 'running']);
  });
});

test('所有cleanup: 本文と複数終了エラーのidentityを同時に保持する', async () => {
  const body = new Error('body'), control = new Error('control'), running = new Error('running'); let removed = false;
  const cleanup = createControlFirstCleanup({ closeControl: async () => { throw control; }, closeRunning: async () => { throw running; },
    removeFixture: async () => { removed = true; }, bodyFailure: () => ({ error: body }) });
  await assert.rejects(cleanup(), error => {
    assert.ok(error instanceof AggregateError); assert.deepEqual(error.errors, [body, control, running]);
    assert.equal(error.cause, body); return true;
  });
  assert.equal(removed, false);
});

test('所有cleanup: 本文assert失敗もcontrol生成前失敗もnative FAILと正当cleanupを維持', () => {
  const helper = new URL('./support/owned-control-cleanup.mjs', import.meta.url).href;
  for (const [created, failClose] of [[true, false], [false, false], [true, true]]) {
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    const source = `import test from 'node:test';import assert from 'node:assert/strict';
      import {createControlFirstCleanup} from ${JSON.stringify(helper)};
      const calls=[];let bodyFailure;const closeError=new Error('close-marker');
      process.once('exit',()=>console.log('CLEANUP_ORDER:'+JSON.stringify(calls)));
      test('body-fails',async t=>{const cleanup=createControlFirstCleanup({
        closeControl:async()=>{if(${created}){calls.push('control');if(${failClose})throw closeError;}},
        closeRunning:async()=>{calls.push('running');},removeFixture:async()=>{calls.push('remove');},bodyFailure:()=>bodyFailure});
        t.after(async()=>{try{await cleanup();}catch(e){console.log('BOTH_ERRORS:'+JSON.stringify({body:e.cause===bodyFailure.error,close:e.errors.includes(closeError)}));throw e;}});
        try{assert.fail('body-marker');}catch(error){bodyFailure={error};throw error;}});`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', env, timeout: 5000 });
    assert.equal(child.error, undefined); assert.equal(child.signal, null); assert.equal(child.status, 1);
    assert.match(child.stdout, /# fail 1/); assert.match(child.stdout, /body-marker/);
    const line = child.stdout.split('\n').find(line => line.startsWith('CLEANUP_ORDER:'));
    assert.deepEqual(JSON.parse(line.slice('CLEANUP_ORDER:'.length)), failClose ? ['control', 'running'] : created ? ['control', 'running', 'remove'] : ['running', 'remove']);
    if (failClose) assert.match(child.stdout, /BOTH_ERRORS:\{"body":true,"close":true\}/);
  }
});

test('実control caller: 再closeは同promiseであり拒否も同じまま', async () => {
  const { chromium } = await import('playwright');
  const { openControlWindow } = await import('../app/control-window.mjs');
  const before = Object.getOwnPropertyDescriptor(chromium, 'launch');
  try {
    for (const reject of [false, true]) {
      let finish, calls = 0;
      const closePromise = new Promise((resolve, fail) => { finish = reject ? fail : resolve; });
      const page = { on() {}, once() {}, async goto() {} };
      const context = { async route() {}, async newPage() { return page; } };
      const browser = { async newContext() { return context; }, close() { calls++; return closePromise; } };
      Object.defineProperty(chromium, 'launch', { value: async () => browser, configurable: true, writable: true });
      const control = await openControlWindow(`http://127.0.0.1:4321/#${'a'.repeat(64)}`, { headless: true });
      const first = control.close(); assert.equal(control.close(), first); assert.equal(first, closePromise); assert.equal(calls, 1);
      const error = new Error('close-rejection'); finish(reject ? error : undefined);
      if (reject) await assert.rejects(first, value => value === error); else await first;
      assert.equal(control.close(), first); assert.equal(calls, 1);
    }
  } finally { if (before) Object.defineProperty(chromium, 'launch', before); else delete chromium.launch; }
});

test('実control caller: 初期化途中のclose失敗を未生成の正常終了とせずfixtureを保持する', async () => {
  const { chromium } = await import('playwright');
  const { openControlWindow } = await import('../app/control-window.mjs');
  const before = Object.getOwnPropertyDescriptor(chromium, 'launch');
  const initializationError = new Error('control-initialization-marker'), closeError = new Error('partial-close-marker');
  const calls = []; let control, controlFailure, bodyFailure, missingCloseCalls = 0;
  try {
    const page = { on() {}, async goto() { calls.push('goto'); throw initializationError; } };
    const context = { async route() {}, async newPage() { return page; } };
    const browser = { async newContext() { return context; }, async close() { calls.push('browser.close'); throw closeError; } };
    Object.defineProperty(chromium, 'launch', { value: async () => browser, configurable: true, writable: true });
    const cleanup = createControlFirstCleanup({
      closeControl: () => { missingCloseCalls++; return control ? control.close() : undefined; },
      closeRunning: async () => { calls.push('running.close'); },
      removeFixture: async () => { calls.push('fixture.remove'); },
      controlFailure: () => controlFailure, bodyFailure: () => bodyFailure,
    });
    try { control = await openControlWindow(`http://127.0.0.1:4321/#${'a'.repeat(64)}`, { headless: true }); }
    catch (error) { controlFailure = { error }; bodyFailure = { error }; }
    assert.equal(control, undefined);
    assert.ok(bodyFailure.error instanceof AggregateError);
    assert.equal(bodyFailure.error.cause, initializationError);
    assert.deepEqual(bodyFailure.error.errors, [initializationError, closeError]);
    await assert.rejects(cleanup(), error => error === bodyFailure.error);
    await assert.rejects(cleanup(), error => error === bodyFailure.error);
    assert.equal(missingCloseCalls, 0);
    assert.deepEqual(calls, ['goto', 'browser.close', 'running.close']);
  } finally { if (before) Object.defineProperty(chromium, 'launch', before); else delete chromium.launch; }
});

test('実control caller: 起動前・部分生成・終了確認を区別し元errorを保つ', async () => {
  const { chromium } = await import('playwright');
  const { openControlWindow } = await import('../app/control-window.mjs');
  const before = Object.getOwnPropertyDescriptor(chromium, 'launch');
  const url = `http://127.0.0.1:4321/#${'a'.repeat(64)}`;
  const init = new Error('initialization'), close = new Error('close'), launch = new Error('launch');
  let calls = 0;
  try {
    const lifecycle = { state: 'not_created' };
    Object.defineProperty(chromium, 'launch', { configurable: true, writable: true, value: async () => { calls++; throw launch; } });
    await assert.rejects(openControlWindow('https://example.invalid/', { lifecycle }), /invalid_control_url/);
    assert.equal(lifecycle.state, 'not_created'); assert.equal(calls, 0);
    await assert.rejects(openControlWindow(url, { lifecycle }), error => error === launch);
    assert.equal(lifecycle.state, 'ownership_unknown'); assert.equal(calls, 1);
    for (const reject of [false, true]) {
      lifecycle.state = 'not_created'; let closed = 0;
      chromium.launch = async () => ({ async newContext() { throw init; }, async close() { closed++; if (reject) throw close; } });
      await assert.rejects(openControlWindow(url, { lifecycle }), error => {
        if (!reject) return error === init;
        assert.ok(error instanceof AggregateError); assert.equal(error.cause, init);
        assert.deepEqual(error.errors, [init, close]); return true;
      });
      assert.equal(lifecycle.state, reject ? 'close_failed' : 'closed_confirmed');
      assert.equal(closed, 1);
    }
  } finally { if (before) Object.defineProperty(chromium, 'launch', before); else delete chromium.launch; }
});

test('実Reader caller: launch前・launch拒否・部分生成の終了結果と両errorを個体ごとに保持', async () => {
  const { chromium } = await import('playwright');
  const { Reader } = await import('../app/reader.mjs');
  const before = Object.getOwnPropertyDescriptor(chromium, 'launchPersistentContext');
  const init = new Error('initialization'), close = new Error('close'), launch = new Error('launch');
  let calls = 0;
  try {
    Object.defineProperty(chromium, 'launchPersistentContext', { configurable: true, writable: true, value: async () => { calls++; throw launch; } });
    const notStarted = { profile: 'test-profile-before', state: 'not_started' };
    await assert.rejects(Reader.open({ profile: notStarted.profile, regionId: 'invalid', lifecycle: notStarted }), { code: 'invalid_kindle_region' });
    assert.equal(notStarted.state, 'not_started'); assert.equal(calls, 0);
    const unknown = { profile: 'test-profile-launch', state: 'not_started' };
    await assert.rejects(Reader.open({ profile: unknown.profile, lifecycle: unknown }), error => error === launch);
    assert.equal(unknown.state, 'close_unconfirmed'); assert.equal(unknown.failure, launch); assert.equal(calls, 1);
    for (const reject of [false, true]) {
      const lifecycle = { profile: `test-profile-${reject}`, state: 'not_started' }; let closed = 0;
      chromium.launchPersistentContext = async () => ({ async route() { throw init; }, async close() { closed++; if (reject) throw close; } });
      await assert.rejects(Reader.open({ profile: lifecycle.profile, sampleUrl: 'http://127.0.0.1:1/', lifecycle }), error => {
        if (!reject) return error === init;
        assert.ok(error instanceof AggregateError); assert.equal(error.cause, init);
        assert.deepEqual(error.errors, [init, close]); assert.equal(lifecycle.failure, error); return true;
      });
      assert.equal(lifecycle.state, reject ? 'close_unconfirmed' : 'closed_confirmed'); assert.equal(closed, 1);
    }
    const lifecycle = { state: 'active' }; let closed = 0;
    const context = { pages: () => [], on() {}, async close() { closed++; throw close; } };
    const reader = new Reader(context, {}, undefined, undefined, false, undefined, lifecycle);
    const first = reader.close(); assert.equal(reader.close(), first);
    await assert.rejects(first, error => error === close);
    await assert.rejects(reader.close(), error => error === close);
    assert.equal(lifecycle.state, 'close_unconfirmed'); assert.equal(closed, 1);
    let release, started;
    const waiting = new Promise(resolve => { started = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const raceLifecycle = { state: 'active' };
    const delayed = new Reader({ pages: () => [], on() {}, async close() { started(); await gate; } },
      {}, undefined, undefined, false, undefined, raceLifecycle);
    const pending = delayed.close(); await waiting;
    raceLifecycle.state = 'close_unconfirmed'; raceLifecycle.failure = close;
    release(); await assert.rejects(pending, error => error === close);
    assert.equal(raceLifecycle.state, 'close_unconfirmed');
  } finally { if (before) Object.defineProperty(chromium, 'launchPersistentContext', before); else delete chromium.launchPersistentContext; }
});

test('実Application caller: Reader未返却の終了不明は再open・削除・finishBookを拒否しlockだけ解放', async t => {
  const { chromium } = await import('playwright');
  const { startApplication } = await import('../app/server.mjs');
  const { StoreClient } = await import('../app/store-client.mjs');
  const before = Object.getOwnPropertyDescriptor(chromium, 'launchPersistentContext');
  const root = await mkdtemp(path.join(existsSync('/tmp/opencode') ? '/tmp/opencode' : tmpdir(), 'ktz-startup-reader-app-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  try {
    for (const mode of ['close-reject', 'launch-reject']) await t.test(mode, async () => {
      const data = path.join(root, mode), initialization = new Error('initialization'), close = new Error('close');
      const running = await startApplication({ dataDir: data });
      let closed = false, calls = 0, closeJob = 0;
      const storeCall = running.app.store.call.bind(running.app.store);
      running.app.store.call = (...args) => { if (args[0] === 'close_job') closeJob++; return storeCall(...args); };
      try {
        await running.app.command('create');
        Object.defineProperty(chromium, 'launchPersistentContext', { configurable: true, writable: true, value: async () => {
          calls++;
          if (mode === 'launch-reject') throw initialization;
          return { async route() { throw initialization; }, async close() { throw close; } };
        } });
        await assert.rejects(running.app.command('openBrowser', { mode: 'sample' }), error => {
          assert.equal(error.code, 'browser_open_failed');
          if (mode === 'launch-reject') assert.equal(error.cause, initialization);
          else { assert.ok(error.cause instanceof AggregateError); assert.deepEqual(error.cause.errors, [initialization, close]); }
          return true;
        });
        const app = running.app, profile = app.profile, lifecycle = app.readerLifecycle, job = app.job;
        assert.equal(app.reader, undefined); assert.equal(lifecycle.profile, profile); assert.equal(lifecycle.state, 'close_unconfirmed');
        assert.equal((await app.snapshot()).readerReleasePending, true);
        const original = path.join(data, 'original-marker'), profileMarker = path.join(profile, 'profile-marker');
        await writeFile(original, 'original', { mode: 0o600 }); await writeFile(profileMarker, 'profile', { mode: 0o600 });
        const other = new StoreClient();
        try { await assert.rejects(other.call('lock_data_directory', { path: data }), /job_busy/); }
        finally { await other.close(); }
        await assert.rejects(app.command('openBrowser', { mode: 'sample', session: path.basename(profile) }), { code: 'reader_release_incomplete' });
        await assert.rejects(app.command('deleteSession', { id: path.basename(profile), confirmed: true }), { code: 'reader_release_incomplete' });
        await assert.rejects(app.command('closeBrowser'), { code: 'reader_close_failed' });
        await assert.rejects(app.command('finishBook'), { code: 'reader_close_failed' });
        assert.equal(app.job, job); assert.equal(closeJob, 0); assert.equal(app.profile, profile);
        assert.equal(app.readerLifecycle, lifecycle); assert.equal(lifecycle.state, 'close_unconfirmed'); assert.equal(calls, 1);
        let foreignClosed = 0;
        app.reader = { lifecycle: { state: 'active' }, async close() { foreignClosed++; } };
        await assert.rejects(app.closeBrowser(), { code: 'reader_close_failed' });
        assert.equal(foreignClosed, 0); assert.equal(app.readerLifecycle, lifecycle);
        app.reader = null;
        const storeError = new Error('store-close'), closeStore = app.store.close.bind(app.store);
        if (mode === 'close-reject') app.store.close = async () => { await closeStore(); throw storeError; };
        const checkClose = error => {
          if (mode === 'launch-reject') return error.code === 'reader_close_failed';
          assert.ok(error instanceof AggregateError); assert.equal(error.errors[0].code, 'reader_close_failed');
          assert.equal(error.errors[1], storeError); return true;
        };
        await assert.rejects(running.close(), checkClose); closed = true;
        await assert.rejects(running.close(), checkClose);
        assert.equal(app.store.closed, true); assert.equal(await readFile(original, 'utf8'), 'original');
        assert.equal(await readFile(profileMarker, 'utf8'), 'profile');
        await assert.rejects(fetch(running.origin, { signal: AbortSignal.timeout(2000) }));
        const next = new StoreClient();
        try { await next.call('lock_data_directory', { path: data }); }
        finally { await next.close(); }
      } finally {
        if (!closed) await running.close().catch(() => {});
      }
    });
  } finally { if (before) Object.defineProperty(chromium, 'launchPersistentContext', before); else delete chromium.launchPersistentContext; }
});

test('実Application caller: 初期化失敗でも対象close確認後は同じ公開操作を再試行できる', async t => {
  const { chromium } = await import('playwright');
  const { startApplication } = await import('../app/server.mjs');
  const before = Object.getOwnPropertyDescriptor(chromium, 'launchPersistentContext');
  const root = await mkdtemp(path.join(existsSync('/tmp/opencode') ? '/tmp/opencode' : tmpdir(), 'ktz-startup-reader-retry-'));
  const running = await startApplication({ dataDir: path.join(root, 'data') });
  t.after(async () => { await running.close(); await rm(root, { recursive: true, force: true }); });
  try {
    await running.app.command('create');
    const init = new Error('initialization'); let closes = 0;
    Object.defineProperty(chromium, 'launchPersistentContext', { configurable: true, writable: true,
      value: async () => ({ async route() { throw init; }, async close() { closes++; } }) });
    await assert.rejects(running.app.command('openBrowser', { mode: 'sample' }), error => error.code === 'browser_open_failed' && error.cause === init);
    const oldProfile = running.app.profile;
    assert.equal(running.app.readerLifecycle.state, 'closed_confirmed'); assert.equal(closes, 1);
    await writeFile(path.join(oldProfile, 'retained-marker'), 'retry', { mode: 0o600 });
    let deviceScaleFactor, currentUrl;
    const page = { on() {}, setDefaultTimeout() {}, async goto(url) { currentUrl = url; }, url: () => currentUrl, isClosed: () => false,
      viewportSize: () => ({ width: 1100, height: 850 }), async evaluate() { return deviceScaleFactor; } };
    chromium.launchPersistentContext = async () => ({ async route() {}, pages: () => [page], on() {},
      async newCDPSession() { return { async send(_method, settings) { deviceScaleFactor = settings.deviceScaleFactor; }, async detach() {} }; },
      async close() { closes++; } });
    await running.app.command('openBrowser', { mode: 'sample', session: path.basename(oldProfile) });
    assert.equal(running.app.profile, oldProfile);
    assert.equal(await readFile(path.join(oldProfile, 'retained-marker'), 'utf8'), 'retry');
    const profile = running.app.profile;
    await running.app.command('closeBrowser');
    await assert.rejects(lstat(profile), { code: 'ENOENT' });
    assert.equal(running.app.reader, null); assert.equal(closes, 2);
    await running.app.command('openBrowser', { mode: 'sample' });
    const nextProfile = running.app.profile;
    assert.notEqual(nextProfile, oldProfile);
    await running.app.command('closeBrowser');
    await assert.rejects(lstat(nextProfile), { code: 'ENOENT' });
    assert.equal(closes, 3);
  } finally { if (before) Object.defineProperty(chromium, 'launchPersistentContext', before); else delete chromium.launchPersistentContext; }
});

test('実server caller: app.close拒否後もHTTP closeを試み両errorを保持する', async t => {
  const { startApplication } = await import('../app/server.mjs');
  const root = await mkdtemp(path.join(existsSync('/tmp/opencode') ? '/tmp/opencode' : tmpdir(), 'ktz-startup-http-'));
  const running = await startApplication({ dataDir: path.join(root, 'data') });
  t.after(() => rm(root, { recursive: true, force: true }));
  const appError = new Error('application-close'), serverError = new Error('http-close');
  const appClose = running.app.close.bind(running.app), serverClose = http.Server.prototype.close;
  let calls = 0;
  running.app.close = async () => { await appClose(); throw appError; };
  http.Server.prototype.close = function (callback) { calls++; return serverClose.call(this, () => callback(serverError)); };
  try {
    const first = running.close(); assert.equal(running.close(), first);
    await assert.rejects(first, error => {
      assert.ok(error instanceof AggregateError); assert.equal(error.cause, appError);
      assert.deepEqual(error.errors, [appError, serverError]); return true;
    });
    assert.equal(calls, 1); assert.equal(running.app.store.closed, true);
    await assert.rejects(fetch(running.origin, { signal: AbortSignal.timeout(2000) }));
  } finally { http.Server.prototype.close = serverClose; }
});

if (process.platform === 'linux') test('所有temp: 内部storeと差替えsymlinkは削除しない', async () => {
  const { captureOwnedTemp, removeOwnedTemp } = await import('../app/startup-cleanup.mjs');
  const root = await mkdtemp(path.join(existsSync('/tmp/opencode') ? '/tmp/opencode' : tmpdir(), 'ktz-startup-identity-'));
  try {
    const owned = path.join(root, 'owned'), store = path.join(owned, 'store'), outside = path.join(root, 'outside');
    await mkdir(owned, { mode: 0o700 }); await mkdir(store, { mode: 0o700 }); await mkdir(outside, { mode: 0o700 });
    await writeFile(path.join(store, 'original'), 'store', { mode: 0o600 });
    await writeFile(path.join(outside, 'original'), 'outside', { mode: 0o600 });
    const captured = await captureOwnedTemp(owned);
    await assert.rejects(removeOwnedTemp(captured, store), /store_inside_owned_temp/);
    assert.equal(await readFile(path.join(store, 'original'), 'utf8'), 'store');
    await rename(owned, `${owned}-original`); await symlink(outside, owned);
    await assert.rejects(removeOwnedTemp(captured, outside));
    assert.equal(await readFile(path.join(outside, 'original'), 'utf8'), 'outside');
    assert.equal(await readFile(path.join(`${owned}-original`, 'store', 'original'), 'utf8'), 'store');
  } finally { await rm(root, { recursive: true, force: true }); }
});
