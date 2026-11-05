import './chromium-test-log-sink.mjs';
import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, lstat, stat, chmod, writeFile, link as hardlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startApplication } from '../app/server.mjs';
import { StoreClient, AppError } from '../app/store-client.mjs';
import { Reader, sampleConfig } from '../app/reader.mjs';
import { createStoreAdapter } from '../app/stores/index.mjs';
import { kindleRegions } from '../app/stores/kindle.mjs';
import { openControlWindow as openWindow } from '../app/control-window.mjs';
import { withPublicDisclosures } from '../poc/browser/public-ui-controls.mjs';
async function openControlWindow(...args) {
  const control = await openWindow(...args);
  return { ...control, page: withPublicDisclosures(control.page) };
}
import { PNG } from 'pngjs';
import { startFixture } from '../poc/browser/fixture-server.mjs';
import { readSessionPreference, saveSessionPreference } from '../app/session-preference.mjs';
import { createLifetime } from './support/test-lifetime.mjs';
import { observeControlWindow } from './support/control-lifetime.mjs';
import { createControlFirstCleanup } from './support/owned-control-cleanup.mjs';
import { createJpegCleanupObservation } from './support/jpeg-cleanup-observation.mjs';
const trace = createLifetime();
const test = trace.instrument(nodeTest);
const { chromium } = await import('playwright');
const root = fileURLToPath(new URL('../artifacts/mvp-tests/', import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// 明示opt-inの試験寿命診断。URL・画像・profile・例外messageは記録しない。
const lifetimeNames = new Set([
  'MVP親領域選択候補失効: クリックしたDOMノードの置換後は古い候補を広げない',
  'MVP親領域選択画面遷移: 対象フレームの再読込で保存候補を破棄する',
  'MVP次へ表示: 本人指定した公式ボタンをページ内hoverで表示し、隠れたままなら送らない',
]);
const lifetimeEnabled = process.env.KTZ_TEST_LIFETIME_DIAGNOSTICS === '1';
const lifetimes = new WeakMap();
function lifetime(t, boundary, event, extra = {}) {
  if (!lifetimeEnabled || !lifetimeNames.has(t.name)) return;
  console.log(`KTZ_LIFETIME:${JSON.stringify({ pid: process.pid, test: t.name, boundary, event, monotonicMs: performance.now(), ...extra })}`);
}
function lifetimeStep(t, boundary, operation) {
  if (!lifetimeEnabled || !lifetimeNames.has(t.name)) return operation();
  return (async () => {
    lifetime(t, boundary, 'start');
    try {
      const value = await operation();
      lifetime(t, boundary, 'end');
      const state = lifetimes.get(t);
      if (state?.pending.delete(boundary) && !state.pending.size) lifetime(t, 'teardown', 'complete');
      return value;
    } catch (error) {
      lifetime(t, boundary, 'error', { code: /^[A-Za-z0-9_]+$/.test(error?.code ?? '') ? error.code : 'operation_failed' });
      throw error;
    }
  })();
}
function lifetimeBrowserCleanup(t, browser) {
  lifetimes.get(t)?.pending.add('browser.close');
  t.after(() => lifetimeStep(t, 'browser.close', () => browser.close()));
}
if (lifetimeEnabled) process.once('exit', code => console.log(`KTZ_LIFETIME:${JSON.stringify({ pid: process.pid,
  test: 'process', boundary: 'process_exit', event: 'complete', exitCode: code, monotonicMs: performance.now() })}`));

// Match the existing local-store archive oracle against the public UI outputs.
function readStoredEntries(bytes) {
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.notEqual(end, -1);
  const count = bytes.readUInt16LE(end + 10);
  let offset = bytes.readUInt32LE(end + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
    const size = bytes.readUInt32LE(offset + 24), nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30), commentLength = bytes.readUInt16LE(offset + 32);
    const local = bytes.readUInt32LE(offset + 42);
    assert.equal(bytes.readUInt32LE(local), 0x04034b50);
    const data = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    entries.push({ name: bytes.subarray(offset + 46, offset + 46 + nameLength).toString('ascii'), bytes: bytes.subarray(data, data + size) });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function setup(t, { sampleFixture = 'reader', sampleHeadless, controlFirst } = {}) {
  if (lifetimeEnabled && lifetimeNames.has(t.name)) lifetimes.set(t, { pending: new Set(['running.close', 'fixture.remove']) });
  lifetime(t, 'test', 'begin');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, 'workflow-'));
  lifetime(t, 'fixture', 'created', { fixture: path.basename(directory) });
  if (trace.enabled) {
    const info = await lstat(directory, { bigint: true });
    trace.emit(t, 'owned_fixture', 'created', { fixture: path.basename(directory), dev: String(info.dev), ino: String(info.ino) });
  }
  const running = await lifetimeStep(t, 'application.start', () => startApplication({ dataDir: path.join(directory, 'data'), sampleFixture,
    ...(sampleHeadless === undefined ? {} : { sampleHeadless }) }));
  trace.trackStore(t, running.app.store);
  const jpegObservation = controlFirst?.jpegObservation;
  jpegObservation?.attach(running);
  const teardownStep = (boundary, operation) => controlFirst
    ? trace.step(t, `teardown.${boundary}`, operation) : operation();
  if (trace.enabled && controlFirst) {
    const close = running.app.close;
    running.app.close = function (...args) {
      return trace.step(t, 'teardown.app.close', () => close.apply(this, args));
    };
  }
  const closeRunning = () => teardownStep('running.close', () => lifetimeStep(t, 'running.close', () =>
    jpegObservation ? jpegObservation.closeRunning(running) : running.close()));
  const removeFixture = () => teardownStep('fixture.remove', () => lifetimeStep(t, 'fixture.remove', () => {
    const remove = () => rm(directory, { recursive: true, force: true });
    return jpegObservation ? jpegObservation.removeFixture({ running, control: controlFirst.control(),
      controlAttempted: controlFirst.controlAttempted(), remove }) : remove();
  }));
  if (controlFirst) t.after(createControlFirstCleanup({
    closeControl: () => {
      const control = controlFirst.control();
      return control ? teardownStep('control.close', () => jpegObservation
        ? jpegObservation.step('control.close', () => control.close()) : control.close()) : undefined;
    }, closeRunning, removeFixture, bodyFailure: controlFirst.bodyFailure, controlFailure: controlFirst.controlFailure,
  }));
  else t.after(async () => { await closeRunning(); await removeFixture(); });
  const request = async (action, input = {}) => {
    const response = await fetch(`${running.origin}/api/command`, { method: 'POST', headers: {
      Authorization: `Bearer ${running.token}`, 'Content-Type': 'application/json', Origin: running.origin,
    }, body: JSON.stringify({ action, input }) });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    return result;
  };
  return { ...running, directory, request };
}

async function waitFor(app, predicate, timeout = 25_000, diagnostic) {
  const deadline = Date.now() + timeout;
  let snapshot;
  do {
    snapshot = diagnostic ? await lifetimeStep(diagnostic.t, `${diagnostic.phase}.snapshot`, () => app.snapshot()) : await app.snapshot();
    if (predicate(snapshot)) return snapshot;
    await sleep(100);
  } while (Date.now() < deadline);
  assert.fail(`待機期限超過：${snapshot.state}/${snapshot.reason}`);
}

async function selectVisibleReaderTab(ui, index = 1) {
  await ui.waitForFunction(() => document.querySelector('#readerTab').options.length > 1);
  const select = ui.locator('#readerTab');
  const value = await select.inputValue();
  if (!value) await select.selectOption({ index });
  await ui.locator('#selectReaderTab').click();
  await ui.waitForFunction(() => document.querySelector('#quickPreview').disabled === false);
}

async function openManualOptions(ui) {
  const details = ui.locator('#manualOptions');
  if (!await details.evaluate(element => element.open)) await ui.locator('#manualOptions > summary').click();
}

async function openSampleThroughPublicUi(ui) {
  await ui.waitForFunction(() => document.querySelector('#state').textContent === '待機');
  await ui.locator('#create').click();
  await ui.waitForFunction(expected => document.querySelector('#state').textContent === expected,
    process.platform === 'linux' ? '取得元選択待ち' : '手動ログイン・1冊選択待ち');
  await ui.locator('#openSample').click();
  await selectVisibleReaderTab(ui);
}

async function waitForPublicPreview(ui) {
  await ui.waitForFunction(() => !document.querySelector('#previewImage').hidden
    || document.querySelector('#message').textContent !== '処理中…', null, { timeout: 20_000 });
  assert.equal(await ui.locator('#previewImage').isVisible(), true, `public preview failed: ${await ui.locator('#message').textContent()}`);
}

async function imagePixel(ui, bytes, x, y) {
  return ui.evaluate(async ({ base64, x, y }) => {
    const data = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([data]));
    const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext('2d'); context.drawImage(bitmap, 0, 0); bitmap.close();
    return [...context.getImageData(x, y, 1, 1).data].slice(0, 3);
  }, { base64: bytes.toString('base64'), x, y });
}

if (process.platform === 'linux') {
  test('Linux自作試料: 呼出側のheaded指定でも試料はheadlessに固定する', async t => {
    const r = await setup(t, { sampleHeadless: false });
    const launch = chromium.launchPersistentContext.bind(chromium);
    let observed;
    chromium.launchPersistentContext = (directory, options) => { observed = options.headless; return launch(directory, options); };
    try {
      await r.request('create'); await r.request('openBrowser', { mode: 'sample' });
      assert.equal(observed, true);
      assert.equal((await r.app.snapshot()).job.manifest.images.length, 0);
    } finally { chromium.launchPersistentContext = launch; }
  });
  test('Linux設定領域: 不正な既存modeとhardlinkを変更せず起動拒否する', async t => {
    await t.test('mode', async sub => {
      const r = await setup(sub); await r.close();
      const file = path.join(r.app.dataDir, 'reader-presets.json');
      await writeFile(file, '{"version":1}', { mode: 0o600 }); await chmod(file, 0o644);
      const before = await lstat(file), content = await readFile(file);
      await assert.rejects(startApplication({ dataDir: r.app.dataDir }), { code: 'unsafe_presets' });
      const after = await lstat(file);
      assert.equal(after.mode & 0o7777, 0o644); assert.equal(after.ino, before.ino); assert.deepEqual(await readFile(file), content);
    });
    await t.test('hardlink', async sub => {
      const r = await setup(sub); await r.close();
      const file = path.join(r.app.dataDir, 'kindle-session.json');
      await writeFile(file, '{}', { mode: 0o600 }); await hardlink(file, path.join(r.app.dataDir, 'linked-fixture'));
      const before = await lstat(file), content = await readFile(file);
      await assert.rejects(startApplication({ dataDir: r.app.dataDir }), { code: 'unsafe_session_preferences' });
      const after = await lstat(file);
      assert.equal(after.nlink, 2); assert.equal(after.ino, before.ino); assert.deepEqual(await readFile(file), content);
    });
  });

  test('Linux公開UI: 保存同期不明と公開済み未記録を区別し再出力せず安全停止する', async t => {
    for (const [code, expected] of [
      ['output_published_durability_uncertain', /公開済みの可能性.*永続性は未確認/],
      ['output_published_manifest_update_failed', /出力済み.*保存履歴の記録に失敗/],
      ['output_published_manifest_durability_uncertain', /出力済み.*保存履歴の永続性は未確認/],
      ['output_path_changed', /出力先の経路が変化/],
    ]) await t.test(code, async sub => {
      let control, controlFailure, bodyFailure;
      const r = await setup(sub, { controlFirst: {
        control: () => control, controlFailure: () => controlFailure, bodyFailure: () => bodyFailure,
      } });
      try {
        await r.request('create');
        try { control = await openControlWindow(r.url, { headless: true }); }
        catch (error) { controlFailure = { error }; throw error; }
        const destination = path.join(r.directory, 'known.zip');
        const call = r.app.store.call.bind(r.app.store);
        r.app.store.call = (kind, ...args) => {
          if (kind !== 'export') return call(kind, ...args);
          const error = new AppError(code);
          for (const listener of r.app.store.errorListeners) listener(error);
          return Promise.reject(error);
        };
        await assert.rejects(r.app.command('export', { destination, format: 'zip' }), { code });
        await control.page.waitForFunction(() => !document.querySelector('#storageUncertain').hidden);
        const warning = await control.page.locator('#storageUncertain').textContent();
        assert.match(warning, expected); assert.ok(warning.includes(destination)); assert.match(warning, /再起動/);
        assert.deepEqual((await r.app.snapshot()).storageUncertain, { code, destination });
        for (const action of ['start', 'export', 'savePreset', 'closeJob']) {
          await assert.rejects(r.app.command(action, { destination, format: 'zip' }), { code: 'storage_reopen_required' });
        }
        await assert.rejects(lstat(destination), { code: 'ENOENT' });
        assert.equal(await control.page.locator('#decisionButton').isDisabled(), true);
      } catch (error) { bodyFailure = { error }; throw error; }
    });
  });

  test('Linux公開取得: controller切断時に未確定画像もページ送りも進めない', async t => {
    const r = await setup(t);
    await r.request('create'); await r.request('openBrowser', { mode: 'sample' });
    await r.request('preview', { config: sampleConfig }); await r.request('approve', { confirmed: true });
    const jobPath = (await r.app.snapshot()).job.job_path;
    const call = r.app.store.call.bind(r.app.store);
    let entered, release;
    const atCommit = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    r.app.store.call = async (kind, ...args) => {
      if (kind === 'capture_commit') { entered(); await gate; }
      return call(kind, ...args);
    };
    await r.request('start', { confirmed: true });
    await atCommit;
    r.app.store.child.kill(); await r.app.store.exited; release();
    await r.app.loop;
    const state = await r.app.snapshot();
    assert.equal(state.state, 'NeedsAttention');
    assert.equal(state.job.manifest.images.length, 0);
    assert.deepEqual(await readdir(path.join(jobPath, 'originals')), []);
    assert.equal(await r.app.reader.page.locator('#position').innerText(), '1 / 12');
    await assert.rejects(r.app.command('start', { confirmed: true }), /explicit_start_required/);
  });
}

// All HTTPS-looking pages below are local, self-authored responses. Never fall
// through to Amazon, authentication endpoints, CDNs or another service.
async function routeAnonymousRegions(context) {
  const resources = new Map(await Promise.all(['reader.html', 'reader.css', 'reader.js'].map(async name =>
    [name, await readFile(new URL(`../poc/fixtures/${name}`, import.meta.url))])));
  await context.route('**/*', route => {
    const name = new URL(route.request().url()).pathname.split('/').at(-1);
    const resource = resources.has(name) ? name : 'reader.html';
    return route.fulfill({ status: 200, contentType: resource.endsWith('.js') ? 'text/javascript' : resource.endsWith('.css') ? 'text/css' : 'text/html', body: resources.get(resource) });
  });
}

test('Kindle地域境界: 同じ明示リストをタブ・picker・取得前後に使い別地域と認証・別本で止まる', async t => {
  assert.throws(() => createStoreAdapter({ regionId: 'cn' }), /invalid_kindle_region/);
  for (const storeId of ['bookwalker', 'ebookjapan', 'cmoa']) assert.throws(() => createStoreAdapter({ storeId }), /unsupported_store/);
  for (const region of kindleRegions) await t.test(region.id, async () => {
    const adapter = createStoreAdapter({ regionId: region.id });
    const origin = new URL(region.startUrl).origin;
    assert.equal(adapter.acceptsUrl(`${origin}/?asin=fictional`), true);
    for (const other of kindleRegions.filter(item => item.id !== region.id)) assert.equal(adapter.acceptsUrl(other.startUrl), false);
    for (const url of [origin.replace('https:', 'http:'), `${origin}:444/`, `${origin}.evil.test/`,
      `${origin.replace('https://', 'https://user:pass@')}/`, 'https://www.amazon.com/',
      'https://read.amazon.com.cn/', 'https://read.amazon.com@evil.test/', 'https://read-amazon.com/',
      'https://read.amazon.com./', 'file:///reader.html', 'not a URL']) assert.equal(adapter.acceptsUrl(url), false, url);
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1100, height: 850 }, serviceWorkers: 'block' });
    await routeAnonymousRegions(context);
    const page = await context.newPage(); await page.goto(adapter.startUrl);
    const reader = new Reader(context, page, undefined, undefined, false, adapter);
    try {
      assert.equal(reader.tabs().length, 1);
      reader.selectTab(reader.tabs()[0].id);
      const picking = reader.pick('position');
      await page.waitForFunction(() => Boolean(window.__ktzPicker));
      const box = await page.locator('#position').boundingBox();
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await picking;
      const preview = await reader.configure(sampleConfig);
      assert.deepEqual(preview.dimensions, [600, 480]);
      assert.equal(preview.position, '1 / 12');
      assert.equal(preview.book.identity, createHash('sha256').update(JSON.stringify([origin, preview.book.title])).digest('hex'), 'existing identity contract is unchanged');
      assert.deepEqual(await reader.capture(), preview.png);
      await reader.advance(() => false);
      assert.equal((await reader.read()).position, '2 / 12');
      await page.evaluate(() => { const input = document.createElement('input'); input.type = 'password'; input.id = 'auth'; document.body.prepend(input); });
      await assert.rejects(reader.capture(), /auth_or_overlay_detected/);
      await page.locator('#auth').evaluate(node => node.remove());
      await page.locator('h1').evaluate(node => { node.textContent = '別の自作試料'; });
      await assert.rejects(reader.capture(), /target_changed/);
      await reader.configure(sampleConfig);
      // Navigation in the screenshot interval must not yield accepted bytes.
      const screenshot = reader.screenshotWithoutSelectedNavigation.bind(reader);
      reader.screenshotWithoutSelectedNavigation = async before => {
        const bytes = await screenshot(before);
        await page.goto(kindleRegions.find(item => item.id !== region.id).startUrl);
        return bytes;
      };
      await assert.rejects(reader.capture(), /auth_or_target_changed|target_changed/);
      assert.equal(reader.tabs().length, 0, 'the previously selected page is excluded after cross-region navigation');
      await assert.rejects(reader.pick('position'), /select_reader_tab/);
      await assert.rejects(reader.advance(() => false), /auth_or_target_changed|target_changed/);
      await page.goto(`${origin}/kindle-library`);
      await assert.rejects(reader.configure(sampleConfig), /reader_library_selected/);
      await page.goto('https://www.amazon.com/ap/signin');
      assert.equal(reader.tabs().length, 0, 'official authentication is not a reading target');
      await assert.rejects(reader.capture(), /auth_or_target_changed|target_changed/);
    } finally { await reader.close(); await browser.close(); }
  });
});

test(process.platform === 'linux' ? 'Kindle地域公開UI: 保存sessionの準備と安全停止による副作用前拒否' : 'Kindle地域公開UI: 言語と独立して選択し実際の開始URLへ渡し開いた間は変更しない', async t => {
  const r = await trace.step(t, 'region.setup', () => setup(t));
  const control = await trace.step(t, 'region.control', () => observeControlWindow(trace, t, chromium,
    () => openControlWindow(r.url, { headless: true })));
  t.after(() => trace.step(t, 'control.browser_close', () => control.close()));
  const ui = control.page;
  await trace.step(t, 'region.options', () => ui.waitForFunction(() => document.querySelector('#kindleRegion').options.length === 3));
  assert.deepEqual(await ui.locator('#kindleRegion option').evaluateAll(options => options.map(option => option.value)), ['jp', 'us', 'uk']);
  trace.emit(t, 'region.options_assert', 'complete');
  // A poll already in flight may finish during run()'s initial paint. The
  // selected region belongs to the change event, not that older snapshot.
  let holdPoll;
  const pendingPoll = new Promise(resolve => { holdPoll = resolve; });
  const interceptPoll = route => { trace.emit(t, 'region.intercept', 'called'); return holdPoll(route); };
  await trace.step(t, 'region.route', () => ui.route('**/api/state', interceptPoll));
  const oldPoll = await trace.step(t, 'region.pendingPoll', () => pendingPoll);
  const oldSnapshot = await r.app.snapshot();
  await ui.evaluate(() => {
    const select = document.querySelector('#kindleRegion');
    select.value = 'us';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await trace.step(t, 'region.fulfill', () => oldPoll.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(oldSnapshot) }));
  await ui.unroute('**/api/state', interceptPoll);
  await ui.waitForFunction(() => !document.querySelector('#kindleRegion').disabled);
  assert.equal(r.app.kindleRegion, 'us', 'a prior polling response must not replace the user-selected region');
  await waitFor(r.app, s => s.kindleRegion === 'us' && !s.busy);
  for (const [language, label] of [['en', 'United States'], ['zh-CN', '美国'], ['ja', '米国']]) {
    await ui.locator('#language').selectOption(language);
    assert.equal(await ui.locator('#kindleRegion').inputValue(), 'us');
    assert.equal(await ui.locator('#kindleRegion option:checked').textContent(), label);
    assert.equal(await ui.locator('#kindleStartUrl').textContent(), 'https://read.amazon.com/');
  }
  await assert.rejects(r.app.command('setKindleRegion', { id: 'cn' }), /invalid_kindle_region/);
  if (process.platform === 'linux') {
    const { resolvePortableLinuxSession } = await import('../app/portable-linux-session.mjs');
    const selected = await resolvePortableLinuxSession(r.app.dataDir);
    const { prepareLinuxLoginProfile } = await import('../app/linux-login-core.mjs');
    const secondId = 'saved-00000000-0000-0000-0000-000000000000';
    await prepareLinuxLoginProfile(path.join(r.app.dataDir, secondId));
    const regionState = await r.app.command('setKindleRegion', { id: 'jp' });
    // The public preparation control fences stale UI snapshots. Wait for the
    // region change to reach that same control before asking it to create.
    await ui.waitForFunction(({ epoch, generation }) => document.body.dataset.preparationEpoch === String(epoch)
      && document.body.dataset.preparationGeneration === String(generation),
    { epoch: regionState.operationRevision, generation: regionState.bookGeneration });
    await ui.locator('#create').click();
    await waitFor(r.app, s => Boolean(s.job) && !s.busy);
    await ui.waitForFunction(() => document.querySelector('#kindleUnsupported').hidden === false);
    assert.equal(await ui.locator('#openKindle').isDisabled(), true);
    assert.equal(await ui.locator('#captureSource').inputValue(), '', '匿名sourceは明示的に選ぶ');
    assert.equal(await ui.locator('#decisionButton').isDisabled(), true, '未選択では自動起動しない');
    assert.equal((await r.app.snapshot()).linuxOwnedSourceAvailable, true);
    await ui.locator('#captureSource').selectOption('kindle');
    await ui.waitForFunction(id => [...document.querySelector('#portableKindleSession').options].some(option => option.value === id), selected.id);
    assert.equal(await ui.locator('#decisionButton').isDisabled(), true, '保存sessionの明示選択が必要');
    await ui.locator('#portableKindleSession').selectOption(selected.id);
    await ui.waitForFunction(() => !document.querySelector('#decisionButton').disabled);
    await ui.locator('#decisionButton').click();
    await ui.waitForFunction(() => document.querySelector('#portableKindleStatus').textContent.includes('実Kindle接続・取得は未許可'));
    assert.equal(await ui.locator('#decisionButton').isDisabled(), true, 'ソース直起動では接続準備まで');
    assert.equal(await ui.locator('#openPreparedPortable').isDisabled(), true);
    await r.app.command('preparePortableKindle', { session: selected.id });
    assert.equal(r.app.reader, undefined, '準備はReaderを作成しない');
    await ui.locator('#portableKindleSession').selectOption(secondId);
    await r.app.command('preparePortableKindle', { session: secondId });
    await ui.locator('#portableKindleSession').selectOption(selected.id);
    await r.app.command('preparePortableKindle', { session: selected.id });
    assert.equal(await ui.locator('#decisionButton').isDisabled(), true);
    const before = (await r.app.snapshot()).sessions;
    const response = await fetch(`${r.origin}/api/command`, { method: 'POST', headers: {
      Authorization: `Bearer ${r.token}`, 'Content-Type': 'application/json', Origin: r.origin,
    }, body: JSON.stringify({ action: 'openBrowser', input: { mode: 'kindle', session: selected.id } }) });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'linux_kindle_permission_required');
    await assert.rejects(r.app.command('openBrowser', { mode: 'kindle', session: selected.id }), { code: 'linux_kindle_permission_required' });
    await assert.rejects(r.app.command('openBrowser', { mode: 'kindle' }), { code: 'select_saved_session' });
    for (const extra of [{ url: 'http://127.0.0.1:9/' }, { profile: '/tmp/not-allowed' }, { keep: true }]) {
      await assert.rejects(r.app.command('openBrowser', { mode: 'kindle', session: selected.id, ...extra }), { code: 'invalid_browser_mode' });
    }
    assert.deepEqual((await r.app.snapshot()).sessions, before);
    assert.equal(r.app.reader, undefined);
    // The unsupported entrypoint cannot be followed by a successful preview,
    // acquisition or a new archive from this still-empty job. This does not
    // revoke review/export of originals saved by a legitimate earlier workflow.
    const unchanged = (await r.app.snapshot()).job.manifest;
    const rejected = async (action, input, code) => {
      const denied = await fetch(`${r.origin}/api/command`, { method: 'POST', headers: {
        Authorization: `Bearer ${r.token}`, 'Content-Type': 'application/json', Origin: r.origin,
      }, body: JSON.stringify({ action, input }) });
      assert.equal(denied.status, 400);
      assert.equal((await denied.json()).code, code);
    };
    await rejected('preview', { config: sampleConfig }, 'open_browser_first');
    await rejected('approve', { confirmed: true }, 'preview_confirmation_required');
    await rejected('start', { confirmed: true }, 'explicit_start_required');
    for (const format of ['zip', 'cbz']) {
      const destination = path.join(r.directory, `unsupported-reader.${format}`);
      await rejected('export', { destination, format }, 'empty_selection');
      await assert.rejects(lstat(destination), { code: 'ENOENT' });
    }
    const deniedState = await r.app.snapshot();
    assert.equal(deniedState.previewReady, false); assert.equal(deniedState.previewApproved, false);
    assert.deepEqual(deniedState.job.manifest.images, unchanged.images);
    assert.deepEqual(deniedState.job.manifest.exports, unchanged.exports);
    assert.deepEqual(deniedState.sessions, before);
    assert.equal(r.app.reader, undefined, '読書pageが存在せずページ送りも開始しない');
    trace.emit(t, 'region.assertions', 'complete');
    return;
  }
  const launch = chromium.launchPersistentContext.bind(chromium);
  chromium.launchPersistentContext = async (profile, options) => {
    const context = await launch(profile, { ...options, headless: true, serviceWorkers: 'block' });
    await routeAnonymousRegions(context);
    return context;
  };
  try {
    await ui.locator('#create').click();
    await ui.waitForFunction(() => !document.querySelector('#openKindle').disabled);
    await ui.locator('#openKindle').click();
    await waitFor(r.app, s => s.browserOpen && !s.busy);
    assert.equal(r.app.reader.page.url(), 'https://read.amazon.com/');
    assert.equal(r.app.reader.adapter.regionId, 'us');
    assert.equal(await ui.locator('#kindleRegion').isDisabled(), true);
    await assert.rejects(r.app.command('setKindleRegion', { id: 'uk' }), /close_browser_first/);
    assert.equal(r.app.reader.adapter.regionId, 'us');
    await ui.locator('#closeBrowser').click();
    await ui.waitForFunction(() => !document.querySelector('#kindleRegion').disabled);
    await ui.locator('#kindleRegion').selectOption('uk');
    await waitFor(r.app, s => s.kindleRegion === 'uk' && !s.busy);
    assert.equal((await r.app.snapshot()).previewApproved, false);
    assert.equal((await r.app.snapshot()).job.manifest.images.length, 0);
    trace.emit(t, 'region.assertions', 'complete');
  } finally { chromium.launchPersistentContext = launch; }
});

test('MVP自動判別: h1なし・数値range・大きなiframe描画面と逆向きiconでも公開UIからプレビューする', async t => {
  const r = await setup(t, { sampleFixture: 'layout' });
  const control = await openControlWindow(r.url, { headless: true }); t.after(() => control.close());
  const ui = control.page;
  await openSampleThroughPublicUi(ui);
  for (const field of ['reader', 'identity', 'position', 'next']) assert.equal(await ui.locator(`#${field}`).inputValue(), '', `${field}はCSS入力なしで開始する`);
  const page = r.app.reader.page;
  assert.equal(await page.frameLocator('#readingFrame').locator('h1').count(), 0, 'fixture has no h1');
  assert.equal(await page.frameLocator('#readingFrame').locator('#readerChromeTitle').isVisible(), true);
  await ui.locator('#quickPreview').click();
  await waitForPublicPreview(ui);

  const snapshot = await r.app.snapshot();
  assert.equal(snapshot.previewReady, true);
  assert.equal(snapshot.previewApproved, false);
  assert.equal(snapshot.job.manifest.images.length, 0, 'preview does not start capture');
  assert.equal(await ui.locator('#start').isDisabled(), true);
  assert.deepEqual(snapshot.previewInfo.cssDimensions, [560, 360], 'the iframe viewport clips the larger canvas');
  assert.deepEqual(snapshot.previewInfo.dimensions, [1120, 720], 'visible viewport retains the configured 2x capture scale');
  assert.deepEqual(await ui.locator('#previewImage').evaluate(image => [image.naturalWidth, image.naturalHeight]), [1120, 720]);
  assert.match(await ui.locator('#previewInfo').textContent(), /560×360 CSS px.*1120×720 px/);
  assert.equal(r.app.reader.config.reader, '#readingFrame', 'one large painting surface is represented by its visible frame viewport');
  assert.equal(r.app.reader.config.identity, '#readerChromeTitle', 'visible title-shaped marker works without h1');
  assert.equal(r.app.reader.config.position, '#position', 'numeric range value is the selected position marker');
  assert.equal(r.app.reader.config.next, '#next', 'ARIA next meaning wins over its left-pointing RTL icon');
  for (const field of ['identity', 'position', 'next']) assert.equal(r.app.reader.config.frames[field], '#readingFrame');
  assert.equal(r.app.reader.bound.position, '7');
  const preview = PNG.sync.read(r.app.previewImage);
  const toolbarPixel = (45 * 2 * preview.width + 545 * 2) * 4;
  assert.deepEqual([...preview.data.subarray(toolbarPixel, toolbarPixel + 3)], [242, 187, 69], 'visible toolbar remains in the user-reviewed preview');
  await t.test('プリセットの追加・編集・選択を公開UIで保存し再起動で保つ', async () => {
    await ui.locator('#previewConfirmed').check(); await ui.locator('#approve').click();
    await ui.waitForFunction(() => !document.querySelector('#start').disabled);
    await ui.locator('#presetEditor > summary').click();
    await ui.locator('#presetName').fill('自分のKindle設定');
    await ui.locator('#addPreset').click();
    await ui.waitForFunction(() => document.querySelector('#preset').options.length === 3);
    assert.equal((await r.app.snapshot()).previewApproved, false);
    assert.equal((await r.app.snapshot()).displayInspection, null);
    const added = await ui.locator('#preset').inputValue();
    await ui.locator('#presetName').fill('保存済みの編集');
    await ui.locator('#presetMode').selectOption('selectors');
    await ui.locator('#savePreset').click();
    await ui.waitForFunction(() => document.querySelector('#preset option:checked').textContent === '保存済みの編集');
    await ui.locator('#preset').selectOption('kindle-visible');
    await waitFor(r.app, s => s.presets.selected === 'kindle-visible');
    await ui.locator('#preset').selectOption(added);
    await waitFor(r.app, s => s.presets.selected === added);
    assert.equal(await ui.locator('#reader').inputValue(), '#readingFrame', '保存済みの詳細指定を再選択で編集欄へ戻す');
    await ui.locator('#quickPreview').click(); await waitForPublicPreview(ui);
    assert.equal((await r.app.snapshot()).job.manifest.images.length, 0);
    const persisted = JSON.parse(await readFile(path.join(r.directory, 'data/reader-presets.json'), 'utf8'));
    await control.close(); await r.close();
    const restarted = await startApplication({ dataDir: path.join(r.directory, 'data'), sampleFixture: 'layout' });
    try { assert.deepEqual((await restarted.app.snapshot()).presets, persisted, '再起動時に初期定義を押し付けない'); }
    finally { await restarted.close(); }
  });
});

test('MVP自動判別曖昧候補: 複数の公式next意味を案内し候補を勝手に採用しない', async t => {
  const r = await setup(t, { sampleFixture: 'layout' });
  const control = await openControlWindow(r.url, { headless: true }); t.after(() => control.close());
  const ui = control.page;
  await openSampleThroughPublicUi(ui);
  await r.app.reader.page.frameLocator('#readingFrame').locator('body').evaluate(body => {
    const duplicate = document.createElement('button');
    duplicate.setAttribute('aria-label', '次のページへ');
    duplicate.textContent = '←';
    duplicate.style.cssText = 'position:fixed;left:300px;top:260px;width:60px;height:36px';
    body.append(duplicate);
  });
  await ui.locator('#quickPreview').click();
  await ui.waitForFunction(() => document.querySelector('#message').textContent !== '処理中…', null, { timeout: 20_000 });
  assert.match(await ui.locator('#message').textContent(), /複数の候補があります/, `ambiguity was not reported: ${await ui.locator('#message').textContent()}`);
  assert.match(await ui.locator('#message').textContent(), /次へボタン.*複数の候補/);
  assert.equal((await r.app.snapshot()).previewReady, false);
  assert.deepEqual((await r.app.snapshot()).mappings, {}, 'no partial configuration is published');
  assert.equal(r.app.reader.config, null, 'no ambiguous next control is silently bound');
  assert.equal((await r.app.snapshot()).job.manifest.images.length, 0);
  await openManualOptions(ui);
  const page = r.app.reader.page;
  for (const [field, selector] of [['identity', '#readerChromeTitle'], ['position', '#position'], ['next', '#next'], ['reader', '#pageSurface']]) {
    await ui.locator(`#pick${field[0].toUpperCase()}${field.slice(1)}`).click();
    await waitFor(r.app, snapshot => snapshot.pickingField === field && snapshot.pickerStage === 'waiting_click');
    const box = field === 'reader' ? await page.locator('#readingFrame').boundingBox()
      : await page.frameLocator('#readingFrame').locator(selector).boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    if (field === 'reader') {
      await ui.waitForFunction(() => !document.querySelector('#expandReader').disabled);
      await ui.locator('#expandReader').click();
    }
    await ui.waitForFunction(name => document.querySelector(`#${name}Status`).textContent === '指定済み', field);
  }
  assert.match(await ui.locator('#nextAction').textContent(), /決定・次へ.*指定した4項目/, '自動判別の曖昧さを明示指定で解消したら、同じ自動判別へ戻さない');
  await ui.locator('#preview').click();
  await waitForPublicPreview(ui);
  assert.equal(r.app.reader.config.next, '#next', '本人が選んだnextを使い、曖昧な自動候補へ戻さない');
  assert.equal(await page.frameLocator('#readingFrame').locator('button[aria-label="次のページへ"]').count(), 2);
  assert.equal((await r.app.snapshot()).previewApproved, false);
  assert.equal((await r.app.snapshot()).job.manifest.images.length, 0);
});

test('MVP読書領域: 通常pickerで遮蔽されたcanvasから親枠を選び公開UIプレビューする', async t => {
  const r = await setup(t, { sampleFixture: 'layout' });
  const control = await openControlWindow(r.url, { headless: true }); t.after(() => control.close());
  const ui = control.page;
  await openSampleThroughPublicUi(ui);
  await openManualOptions(ui);
  const page = r.app.reader.page;

  for (const [field, button, selector] of [
    ['identity', '#pickIdentity', '#readerChromeTitle'],
    ['position', '#pickPosition', '#position'],
    ['next', '#pickNext', '#next'],
  ]) {
    await ui.locator(button).click();
    await waitFor(r.app, snapshot => snapshot.pickingField === field && snapshot.pickerStage === 'waiting_click');
    const box = await page.frameLocator('#readingFrame').locator(selector).boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await ui.waitForFunction(name => document.querySelector(`#${name}Status`).textContent === '指定済み', field);
  }
  assert.equal(await ui.locator('#reader').inputValue(), '', 'reported failure: only the reader remains unspecified');
  assert.equal(await ui.locator('#preview').isDisabled(), true);
  await ui.locator('#pickReader').click();
  await waitFor(r.app, snapshot => snapshot.pickingField === 'reader' && snapshot.pickerStage === 'waiting_click');
  const frameBox = await page.locator('#readingFrame').boundingBox();
  await page.mouse.click(frameBox.x + 280, frameBox.y + 180);
  await waitFor(r.app, snapshot => snapshot.readerCandidateAvailable);
  await ui.waitForFunction(() => document.querySelector('#readerStatus').textContent.includes('要選び直し'));
  assert.equal(await ui.locator('#reader').inputValue(), '', 'occluded child surface is not silently accepted');
  assert.equal(await ui.locator('#expandReader').isEnabled(), true);
  assert.equal(await ui.locator('#preview').isDisabled(), true);
  assert.match(await ui.locator('#state').textContent(), /検査失敗/);
  assert.match(await ui.locator('#mappingStatus').textContent(), /未指定：読書領域/);
  assert.match(await ui.locator('#preview').getAttribute('title'), /最寄りの表示枠/);
  await ui.locator('#expandReader').click();
  await ui.waitForFunction(() => document.querySelector('#message').textContent !== '処理中…');
  assert.equal((await r.app.snapshot()).selectionFailure, null, JSON.stringify((await r.app.snapshot()).selectionFailure));
  assert.equal(await ui.locator('#reader').inputValue(), '#pageSurface >> xpath=../../..');
  assert.equal(r.app.reader.selections.reader.frame, '#readingFrame');
  await ui.locator('#preview').click();
  await waitForPublicPreview(ui);
  assert.deepEqual(await ui.locator('#previewImage').evaluate(image => [image.naturalWidth, image.naturalHeight]), [1120, 720]);
  assert.equal(await ui.locator('#position').inputValue(), '#position');
  assert.equal(await page.frameLocator('#readingFrame').locator('#position').inputValue(), '7', 'picker clicks do not change the sample reader position');
  assert.equal((await r.app.snapshot()).previewApproved, false);
  assert.equal((await r.app.snapshot()).job.manifest.images.length, 0);
  assert.equal(await ui.locator('#approve').isDisabled(), true);
  assert.equal(await ui.locator('#start').isDisabled(), true);
  assert.equal((await r.app.snapshot()).displayInspection.status, 'passed');
  assert.equal(await ui.locator('#state').textContent(), 'プレビュー確認待ち');
  // Negative boundary: there is no rendered ancestor before the document root.
  // This mutation is not used for the successful public selection above.
  await page.frameLocator('#readingFrame').locator('#readerSurface').evaluate(element => { element.style.display = 'contents'; });
  await ui.locator('#pickReader').click();
  await waitFor(r.app, snapshot => snapshot.pickerStage === 'waiting_click' && snapshot.pickingField === 'reader');
  await page.mouse.click(frameBox.x + 280, frameBox.y + 180);
  await ui.waitForFunction(() => !document.querySelector('#expandReader').disabled);
  await ui.locator('#expandReader').click();
  await ui.waitForFunction(() => document.querySelector('#message').textContent.includes('安全に選べる親の表示枠がありません')
    && document.querySelector('#expandReader').disabled && !document.querySelector('#quickPreview').disabled);
  assert.equal((await r.app.snapshot()).readerCandidateAvailable, false, 'document root is not adopted and repeated expansion is unavailable');
  assert.equal(await ui.locator('#expandReader').isDisabled(), true);
  assert.equal(await ui.locator('#preview').isDisabled(), true);
  for (const field of ['identity', 'position', 'next']) assert.notEqual(await ui.locator(`#${field}`).inputValue(), '');
  assert.match(await ui.locator('#nextAction').textContent(), /別の見える位置から選び直し/);
});

test('ローカル画面再読込: 接続キーをURLへ残さず同じタブの操作を維持する', async t => {
  const r = await setup(t);
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = withPublicDisclosures(await browser.newPage());
  await page.goto(r.url);
  await page.waitForFunction(() => document.querySelector('#state').textContent === '待機');
  assert.equal(new URL(page.url()).hash, '');
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#state').textContent === '待機', null, { timeout: 2000 });
  await page.locator('#create').click();
  await page.waitForFunction(expected => document.querySelector('#state').textContent === expected,
    process.platform === 'linux' ? '取得元選択待ち' : '手動ログイン・1冊選択待ち', { timeout: 2000 });
  assert.equal((await r.app.snapshot()).job.manifest.images.length, 0);
});

test('MVPプレビュー認証UI: 非表示のmodalとpasswordは誤拒否せず可視なら保存前に拒否する', async t => {
  const r = await setup(t);
  await r.request('create');
  await r.request('openBrowser', { mode: 'sample' });
  for (const [kind, mode] of [['modal', 'hidden'], ['password', 'hidden'], ['modal', 'transparent'], ['password', 'offscreen']]) await t.test(`${kind}:${mode}`, async () => {
    await r.app.reader.page.evaluate(({ kind, mode }) => {
      const parent = document.createElement('div');
      parent.id = 'hidden-auth-fixture';
      if (mode === 'hidden') parent.hidden = true;
      else if (mode === 'transparent') parent.style.opacity = '0';
      else parent.style.cssText = 'position:fixed;left:-5000px;top:0;width:200px;height:50px';
      const child = document.createElement(kind === 'password' ? 'input' : 'div');
      if (kind === 'password') child.type = 'password';
      else { child.setAttribute('aria-modal', 'true'); child.textContent = '自作認証UI試料'; }
      parent.append(child); document.body.append(parent);
    }, { kind, mode });
    try {
      await r.request('preview', { config: sampleConfig });
      assert.equal((await r.app.snapshot()).previewReady, true);
      await r.app.reader.page.locator('#hidden-auth-fixture').evaluate(el => { el.hidden = false; el.style.cssText = ''; });
      await assert.rejects(r.app.command('preview', { config: sampleConfig }), /auth_or_overlay_detected/);
      assert.equal((await r.app.snapshot()).previewReady, false);
      assert.equal((await r.app.snapshot()).job.manifest.images.length, 0);
    } finally { await r.app.reader.page.locator('#hidden-auth-fixture').evaluate(el => el.remove()); }
  });
});

test('MVP可視マーカー: 本人が選んだ同一ノードの自動非表示だけ許容し置換や未指定は拒否する', async t => {
  const r = await setup(t);
  await r.request('create');
  await r.request('openBrowser', { mode: 'sample' });
  const page = r.app.reader.page;
  for (const field of ['identity', 'position']) await t.test(field, async () => {
    const marker = page.locator(sampleConfig[field]);
    // Each case starts without visible-node evidence from the preceding preview.
    await marker.evaluate(el => { el.replaceWith(el.cloneNode(true)); });
    await marker.evaluate(el => { el.style.visibility = 'hidden'; });
    await assert.rejects(r.app.command('preview', { config: sampleConfig }), error => {
      assert.equal(error.code, 'reader_ui_unknown'); assert.deepEqual(error.detail, { field, cause: 'hidden' }); return true;
    });
    await marker.evaluate(el => { el.style.visibility = 'visible'; });
    const box = await marker.boundingBox();
    const picking = r.app.command('pick', { field });
    await page.waitForFunction(() => Boolean(window.__ktzPicker));
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await picking;
    await marker.evaluate(el => { el.style.visibility = 'hidden'; });
    await r.request('preview', { config: sampleConfig });
    assert.equal(r.app.reader.bound.position, '1 / 12', '位置の文字列契約を保ち、以前の値で置換しない');
    assert.equal((await r.app.snapshot()).previewReady, true);
    const originalText = await marker.textContent();
    await marker.evaluate((el, field) => { el.textContent = field === 'identity' ? '自作別対象' : '2 / 12'; }, field);
    await assert.rejects(r.app.reader.requireBound(), /target_changed/, '非表示中でも現在の識別・位置の変化を検出する');
    await marker.evaluate((el, text) => { el.textContent = text; }, originalText);
    await marker.evaluate(el => { el.replaceWith(el.cloneNode(true)); });
    await assert.rejects(r.app.command('preview', { config: sampleConfig }), error => {
      assert.equal(error.code, 'reader_ui_unknown'); assert.deepEqual(error.detail, { field, cause: 'hidden' }); return true;
    });
    await marker.evaluate(el => { el.style.visibility = 'visible'; });
    assert.equal((await r.app.snapshot()).job.manifest.images.length, 0);
  });
});

test('MVP読書領域: 非操作画像の親要素hitは許容し不透明な別要素の遮蔽は拒否する', async t => {
  const r = await setup(t);
  await r.request('create');
  await r.request('openBrowser', { mode: 'sample' });
  const page = r.app.reader.page;
  await page.locator('#sheet').evaluate(el => { el.style.pointerEvents = 'none'; });
  await r.request('preview', { config: sampleConfig });
  assert.equal((await r.app.snapshot()).previewReady, true);
  await page.locator('#sheet').evaluate(el => {
    const r = el.getBoundingClientRect();
    const cover = document.createElement('div'); cover.id = 'opaque-cover';
    cover.style.cssText = `position:fixed;left:${r.x}px;top:${r.y}px;width:${r.width}px;height:${r.height}px;background:black;z-index:10000`;
    document.body.append(cover);
  });
  await assert.rejects(r.app.command('preview', { config: sampleConfig }), /auth_or_overlay_detected/);
  assert.equal((await r.app.snapshot()).previewReady, false);
  assert.equal((await r.app.snapshot()).job.manifest.images.length, 0);
});

test('MVPフレーム可視範囲: 大きな描画面は見えている枠内だけプレビューし親の遮蔽は拒否する', async t => {
  const r = await setup(t);
  await r.request('create');
  await r.request('openBrowser', { mode: 'sample' });
  const page = r.app.reader.page;
  await page.evaluate(() => {
    const frame = document.createElement('iframe'); frame.id = 'large-reader-frame';
    frame.style.cssText = 'position:fixed;left:200px;top:100px;width:160px;height:180px;border:0';
    frame.srcdoc = '<!doctype html><html><body><canvas id="large-sheet" width="300" height="300"></canvas></body></html>';
    document.body.append(frame);
  });
  await page.frameLocator('#large-reader-frame').locator('#large-sheet').evaluate(canvas => {
    document.documentElement.style.cssText = 'width:100%;height:100%;overflow:hidden';
    document.body.style.cssText = 'margin:0;width:100%;height:100%;overflow:hidden';
    canvas.style.display = 'block';
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#d23c1e'; ctx.fillRect(0, 0, 300, 300);
  });
  const config = { ...sampleConfig, reader: '#large-sheet', frames: { reader: '#large-reader-frame' } };
  await r.request('preview', { config });
  const decoded = PNG.sync.read(r.app.previewImage);
  assert.deepEqual([decoded.width, decoded.height], [320, 360], 'CSSで見える範囲だけを2倍のPNG画素で取得し、不可視部分や親フレームの外を含めない');
  await page.frameLocator('#large-reader-frame').locator('#large-sheet').evaluate(canvas => {
    document.documentElement.style.cssText = 'overflow:visible';
    document.body.style.cssText = 'margin:0;overflow:hidden';
    canvas.style.cssText = 'position:fixed;left:0;top:0;display:block';
  });
  await r.request('preview', { config });
  assert.deepEqual([r.app.previewImage.readUInt32BE(16), r.app.previewImage.readUInt32BE(20)], [320, 360], 'bodyのoverflowがviewportへ伝播する固定描画でも高DPI画素数を保つ');
  await page.locator('#large-reader-frame').evaluate(frame => {
    const box = frame.getBoundingClientRect(); const cover = document.createElement('div');
    cover.style.cssText = `position:fixed;left:${box.x}px;top:${box.y}px;width:${box.width}px;height:${box.height}px;background:black;z-index:10000`;
    document.body.append(cover);
  });
  await assert.rejects(r.app.command('preview', { config }), /auth_or_overlay_detected/);
  assert.equal((await r.app.snapshot()).job.manifest.images.length, 0);
});

test('MVP親領域選択: 公開UIで親枠へ変更してもframeと明示プレビューを保ち認証UIは拒否する', async t => {
  const r = await setup(t);
  await r.request('create'); await r.request('openBrowser', { mode: 'sample' });
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const ui = withPublicDisclosures(await browser.newPage()); await ui.goto(r.url);
  await ui.waitForFunction(() => document.querySelector('#reader').value === '#sheet');
  await selectVisibleReaderTab(ui); await openManualOptions(ui);
  const page = r.app.reader.page;
  await page.evaluate(() => {
    const frame = document.createElement('iframe'); frame.id = 'parent-reader-frame';
    frame.style.cssText = 'position:fixed;left:200px;top:100px;width:340px;height:180px;border:0';
    frame.srcdoc = '<!doctype html><html><body><div id="paint-parent"><canvas id="child-sheet" width="300" height="120"></canvas></div></body></html>';
    document.body.append(frame);
  });
  const canvas = page.frameLocator('#parent-reader-frame').locator('#child-sheet');
  await canvas.evaluate(el => {
    el.style.display = 'block'; el.parentElement.style.cssText = 'width:300px;height:120px';
    const ctx = el.getContext('2d'); ctx.fillStyle = '#d23c1e'; ctx.fillRect(0, 0, 300, 120);
  });
  await ui.locator('#pickReader').click();
  await page.waitForFunction(() => Boolean(window.__ktzPicker));
  const box = await canvas.boundingBox(); await page.mouse.click(box.x + 30, box.y + 30);
  await ui.waitForFunction(() => document.querySelector('#reader').value === '#child-sheet');
  await ui.locator('#mappingDetails > summary').click();
  await ui.locator('#identity').fill('h1');
  await ui.locator('#position').fill('#position');
  await ui.locator('#next').fill('#next');
  await ui.locator('#parentReader').click();
  await ui.locator('#previewImage').waitFor({ state: 'visible' });
  assert.equal(r.app.reader.config.frames.reader, '#parent-reader-frame');
  assert.equal(r.app.reader.config.reader, '#child-sheet >> xpath=..');
  assert.equal(await ui.locator('#reader').inputValue(), '#child-sheet >> xpath=..', '周期表示で明示設定を初期値へ戻さない');
  assert.deepEqual([r.app.previewImage.readUInt32BE(16), r.app.previewImage.readUInt32BE(20)], [600, 240]);
  assert.equal(await ui.locator('#previewConfirmed').isChecked(), false);
  assert.equal((await r.app.snapshot()).job.manifest.images.length, 0);
  await page.frameLocator('#parent-reader-frame').locator('#paint-parent').evaluate(el => {
    const modal = document.createElement('div'); modal.setAttribute('aria-modal', 'true'); modal.textContent = '自作認証試料'; el.append(modal);
  });
  await ui.locator('#preview').click();
  await ui.waitForFunction(() => document.querySelector('#message').textContent.includes('ログイン画面や別の表示'));
  assert.match(await ui.locator('#message').textContent(), /reader_modal/);
  assert.equal((await r.app.snapshot()).previewReady, false);
  assert.equal((await r.app.snapshot()).job.manifest.images.length, 0);
});

test('MVP親領域選択失敗回復: 遮蔽された可視クリック候補を通常UIで1段広げ他の指定を保ってプレビューする', async t => {
  const r = await setup(t);
  await r.request('create'); await r.request('openBrowser', { mode: 'sample' });
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const ui = withPublicDisclosures(await browser.newPage()); await ui.goto(r.url);
  await selectVisibleReaderTab(ui); await openManualOptions(ui);
  const page = r.app.reader.page;
  await page.locator('#sheet').evaluate(canvas => {
    const wrapper = document.createElement('div'); wrapper.id = 'reader-parent-wrap';
    wrapper.style.cssText = 'position:fixed;left:300px;top:90px;width:700px;height:600px';
    canvas.style.cssText = 'position:absolute;left:50px;top:50px';
    canvas.parentElement.replaceChild(wrapper, canvas); wrapper.append(canvas);
    const noBox = document.createElement('div'); noBox.id = 'reader-contents-wrap'; noBox.style.display = 'contents';
    canvas.replaceWith(noBox); noBox.append(canvas);
    const rect = canvas.getBoundingClientRect();
    const toolbar = document.createElement('div'); toolbar.id = 'reader-toolbar-fixture';
    toolbar.style.cssText = `position:fixed;left:${rect.x + rect.width * .1}px;top:${rect.y + rect.height * .1}px;width:5px;height:5px;background:transparent;z-index:10000`;
    document.body.append(toolbar);
  });

  const fields = [
    ['identity', '#pickIdentity', '#identityStatus'],
    ['position', '#pickPosition', '#positionStatus'],
    ['next', '#pickNext', '#nextStatus'],
  ];
  for (const [field, button, status] of fields) {
    await ui.locator(button).click();
    await waitFor(r.app, snapshot => snapshot.pickingField === field && snapshot.pickerStage === 'waiting_click');
    const box = await page.locator(sampleConfig[field]).boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await ui.waitForFunction(selector => document.querySelector(selector).textContent === '指定済み', status);
  }
  await ui.locator('#pickReader').click();
  await waitFor(r.app, snapshot => snapshot.pickingField === 'reader' && snapshot.pickerStage === 'waiting_click');
  const sheet = await page.locator('#sheet').boundingBox();
  await page.mouse.click(sheet.x + sheet.width / 2, sheet.y + sheet.height / 2);
  await waitFor(r.app, snapshot => snapshot.readerCandidateAvailable);
  await ui.waitForFunction(() => document.querySelector('#readerStatus').textContent.includes('要選び直し'));
  assert.equal(await ui.locator('#reader').inputValue(), '');
  assert.equal(await ui.locator('#identityStatus').textContent(), '指定済み');
  assert.equal(await ui.locator('#positionStatus').textContent(), '指定済み');
  assert.equal(await ui.locator('#nextStatus').textContent(), '指定済み');
  assert.equal((await r.app.snapshot()).readerCandidateAvailable, true);
  assert.equal(await ui.locator('#preview').isDisabled(), true);
  assert.equal(await ui.locator('#expandReader').isEnabled(), true);

  await ui.locator('#expandReader').click();
  await ui.waitForFunction(() => document.querySelector('#reader').value === '#sheet >> xpath=../..');
  assert.equal(await page.locator('#sheet >> xpath=../..').getAttribute('id'), 'reader-parent-wrap', 'display:contentsを飛ばし最寄りの表示枠だけ採用する');
  assert.equal(await ui.locator('#identity').inputValue(), 'html > body > h1');
  assert.equal(await ui.locator('#position').inputValue(), '#position');
  assert.equal(await ui.locator('#next').inputValue(), '#next');
  assert.equal((await r.app.snapshot()).readerCandidateAvailable, false);
  assert.equal(await ui.locator('#previewImage').isVisible(), false, '候補拡張だけではプレビューに進まない');
  assert.equal(await ui.locator('#previewConfirmed').isChecked(), false);
  await ui.locator('#preview').click();
  await ui.locator('#previewImage').waitFor({ state: 'visible' });
  assert.deepEqual(await ui.locator('#previewImage').evaluate(image => [image.naturalWidth, image.naturalHeight]), [1400, 1200]);
  assert.match(await ui.locator('#previewInfo').textContent(), /700×600 CSS px.*元PNG 1400×1200 px/);
  assert.equal(await ui.locator('#previewConfirmed').isChecked(), false);
  assert.equal(await ui.locator('#approve').isDisabled(), true);
  assert.equal((await r.app.snapshot()).job.manifest.images.length, 0, 'プレビューしても取得・保存を開始しない');
});

test('MVP親領域選択候補失効: クリックしたDOMノードの置換後は古い候補を広げない', async t => {
  const r = await setup(t);
  await r.request('create'); await r.request('openBrowser', { mode: 'sample' });
  const browser = await lifetimeStep(t, 'browser.launch', () => chromium.launch({ headless: true })); lifetimeBrowserCleanup(t, browser);
  const ui = withPublicDisclosures(await browser.newPage()); await ui.goto(r.url);
  await selectVisibleReaderTab(ui); await openManualOptions(ui);
  const page = r.app.reader.page;
  await page.locator('#sheet').evaluate(canvas => {
    const rect = canvas.getBoundingClientRect();
    const cover = document.createElement('div'); cover.id = 'reader-hit-cover';
    cover.style.cssText = `position:fixed;left:${rect.x + rect.width * .1}px;top:${rect.y + rect.height * .1}px;width:5px;height:5px;background:transparent;z-index:10000`;
    document.body.append(cover);
  });
  await lifetimeStep(t, 'picker.open', () => ui.locator('#pickReader').click());
  await lifetimeStep(t, 'picker.wait', () => waitFor(r.app, snapshot => snapshot.pickingField === 'reader' && snapshot.pickerStage === 'waiting_click', undefined, { t, phase: 'picker' }));
  const box = await page.locator('#sheet').boundingBox();
  await lifetimeStep(t, 'picker.click', () => page.mouse.click(box.x + box.width / 2, box.y + box.height / 2));
  await lifetimeStep(t, 'candidate.wait', () => waitFor(r.app, snapshot => snapshot.readerCandidateAvailable, undefined, { t, phase: 'candidate' }));
  assert.equal((await r.app.snapshot()).readerCandidateAvailable, true);
  await page.locator('#sheet').evaluate(canvas => canvas.replaceWith(canvas.cloneNode(true)));
  await ui.locator('#expandReader').click();
  await ui.waitForFunction(() => document.querySelector('#message').textContent.includes('選んだ領域または対象画面が変わりました'));
  assert.equal((await r.app.snapshot()).readerCandidateAvailable, false);
  assert.equal(await ui.locator('#reader').inputValue(), '');
  assert.equal(await ui.locator('#expandReader').isDisabled(), true);
  assert.equal(await ui.locator('#preview').isDisabled(), true);
  assert.equal((await r.app.snapshot()).job.manifest.images.length, 0);
  lifetime(t, 'test_body', 'complete');
});

test('MVP親領域選択画面遷移: 対象フレームの再読込で保存候補を破棄する', async t => {
  const r = await setup(t);
  await lifetimeStep(t, 'job.create', () => r.request('create'));
  await lifetimeStep(t, 'reader.open', () => r.request('openBrowser', { mode: 'sample' }));
  const browser = await lifetimeStep(t, 'browser.launch', () => chromium.launch({ headless: true })); lifetimeBrowserCleanup(t, browser);
  const ui = withPublicDisclosures(await browser.newPage()); await lifetimeStep(t, 'control.load', () => ui.goto(r.url));
  await lifetimeStep(t, 'reader.select', () => selectVisibleReaderTab(ui));
  await lifetimeStep(t, 'manual.open', () => openManualOptions(ui));
  const page = r.app.reader.page;
  await page.locator('#sheet').evaluate(canvas => {
    const rect = canvas.getBoundingClientRect();
    const cover = document.createElement('div'); cover.id = 'reader-hit-cover';
    cover.style.cssText = `position:fixed;left:${rect.x + rect.width * .1}px;top:${rect.y + rect.height * .1}px;width:5px;height:5px;background:transparent;z-index:10000`;
    document.body.append(cover);
  });
  await lifetimeStep(t, 'picker.open', () => ui.locator('#pickReader').click());
  await lifetimeStep(t, 'picker.wait', () => waitFor(r.app, snapshot => snapshot.pickingField === 'reader' && snapshot.pickerStage === 'waiting_click', undefined, { t, phase: 'picker' }));
  const box = await page.locator('#sheet').boundingBox();
  await lifetimeStep(t, 'picker.click', () => page.mouse.click(box.x + box.width / 2, box.y + box.height / 2));
  await lifetimeStep(t, 'candidate.wait', () => waitFor(r.app, snapshot => snapshot.readerCandidateAvailable, undefined, { t, phase: 'candidate' }));
  await lifetimeStep(t, 'page.reload', () => page.reload());
  await lifetimeStep(t, 'dom.visible', () => page.locator('#sheet').waitFor({ state: 'visible' }));
  await lifetimeStep(t, 'candidate.invalidate', () => waitFor(r.app, snapshot => !snapshot.readerCandidateAvailable && snapshot.pickingField === null, undefined, { t, phase: 'invalidate' }));
  await lifetimeStep(t, 'invalidate.ui', () => ui.waitForFunction(() => document.querySelector('#expandReader').disabled));
  assert.equal(await ui.locator('#expandReader').isDisabled(), true);
  assert.equal(await ui.locator('#reader').inputValue(), '');
  assert.equal((await r.app.snapshot()).job.manifest.images.length, 0);
  lifetime(t, 'test_body', 'complete');
});

test('MVP次へ表示: 本人指定した公式ボタンをページ内hoverで表示し、隠れたままなら送らない', async t => {
  const r = await setup(t);
  await r.request('create');
  await r.request('openBrowser', { mode: 'sample' });
  const page = r.app.reader.page;
  const next = page.locator('#next');
  const box = await next.boundingBox();
  const picking = r.app.command('pick', { field: 'next' });
  await page.waitForFunction(() => Boolean(window.__ktzPicker));
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await picking;
  await next.evaluate(el => {
    el.style.visibility = 'hidden';
    document.addEventListener('mousemove', () => { el.style.visibility = 'visible'; }, { once: true });
  });
  await r.request('preview', { config: sampleConfig });
  assert.equal(await page.locator('#position').innerText(), '1 / 12');
  await next.evaluate(el => { el.style.visibility = 'hidden'; });
  await assert.rejects(r.app.command('preview', { config: sampleConfig }), error => {
    assert.equal(error.code, 'reader_ui_unknown'); assert.deepEqual(error.detail, { field: 'next', cause: 'hidden' }); return true;
  });
  assert.equal(await page.locator('#position').innerText(), '1 / 12');
  assert.equal((await r.app.snapshot()).job.manifest.images.length, 0);
  lifetime(t, 'test_body', 'complete');
});

test('MVP読書タブ: 本棚を残して公開UIで対象を選び、4項目指定と承認破棄・取得中の固定を保つ', async t => {
  const r = await setup(t);
  await r.request('create');
  await r.request('openBrowser', { mode: 'sample' });
  const library = r.app.reader.page;
  const book = await r.app.reader.context.newPage();
  await book.goto(r.app.reader.sampleUrl);
  // Both tabs stay visible, reproducing the reported library + book layout.
  for (const page of [library, book]) await page.evaluate(() => Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }));
  await assert.rejects(r.app.command('pick', { field: 'reader' }), /select_reader_tab/);
  const tabs = (await r.app.snapshot()).readerTabs;
  assert.deepEqual(tabs.map(tab => tab.label), ['専用タブ 1', '専用タブ 2']);
  assert.deepEqual(Object.keys(tabs[0]).sort(), ['id', 'label'], '書名・URL・閲覧内容を一覧へ収集しない');
  assert.deepEqual((await r.app.snapshot()).readerTabs, tabs, '周期表示でもIDとラベルは固定');
  const control = await openControlWindow(r.url, { headless: true }); t.after(() => control.close());
  const ui = control.page;
  await ui.waitForFunction(() => document.querySelector('#readerTab').options.length === 3);
  assert.equal(await ui.locator('#pickAll').isDisabled(), true);
  await ui.locator('#readerTab').selectOption(tabs[1].id);
  await ui.locator('#selectReaderTab').click();
  await ui.waitForFunction(() => document.querySelector('#pickAll').disabled === false);
  await openManualOptions(ui);
  assert.deepEqual((await r.app.snapshot()).mappings, {});
  assert.equal(r.app.reader.page, book);
  assert.equal(library.isClosed(), false, '本棚を閉じる回避策を要求しない');
  await ui.locator('#pickAll').click();
  for (const field of ['reader', 'identity', 'position', 'next']) {
    await waitFor(r.app, s => s.pickingField === field && s.pickerStage === 'waiting_click');
    const box = await book.locator(sampleConfig[field]).boundingBox();
    await book.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  }
  await ui.locator('#previewImage').waitFor({ state: 'visible' });
  assert.equal(await book.locator('#position').innerText(), '1 / 12', '指定操作はページを送らない');
  assert.equal(await library.locator('[data-ktz-selection]').count(), 0, '非選択の本棚には指定面を作らない');
  await ui.locator('#previewConfirmed').check(); await ui.locator('#approve').click();
  await ui.waitForFunction(() => document.querySelector('#start').disabled === false);
  await ui.locator('#readerTab').selectOption(tabs[0].id); await ui.locator('#selectReaderTab').click();
  await ui.waitForFunction(() => document.querySelector('#previewImage').hidden && !document.querySelector('#previewConfirmed').checked);
  await waitFor(r.app, s => s.selectedReaderTab === tabs[0].id && !s.busy);
  const changed = await r.app.snapshot();
  assert.equal(changed.previewApproved, false); assert.equal(changed.previewReady, false);
  assert.deepEqual(changed.mappings, {}); assert.equal(await ui.locator('#start').isDisabled(), true);
  await waitFor(r.app, s => s.selectedReaderTab === tabs[0].id && !s.busy);
  await assert.rejects(r.app.command('start', { confirmed: true }), /explicit_start_required/);
  await ui.locator('#readerTab').selectOption(tabs[1].id); await ui.locator('#selectReaderTab').click();
  await waitFor(r.app, s => s.selectedReaderTab === tabs[1].id && !s.busy);
  await r.request('preview', { config: sampleConfig });
  await r.request('approve', { confirmed: true });
  await r.request('start', { confirmed: true });
  await waitFor(r.app, s => s.job.manifest.images.length >= 1);
  await assert.rejects(r.app.command('selectReaderTab', { id: tabs[0].id }), /operation_busy/);
  assert.equal(r.app.reader.page, book, '取得中は本人からの切替要求も拒否する');
  await r.app.reader.context.newPage();
  await r.app.loop;
  const stopped = await r.app.snapshot();
  assert.equal(stopped.state, 'NeedsAttention');
  assert.equal(stopped.reason, 'browser_target_changed');
  assert.equal(r.app.reader.page, book, '取得中に新しいタブへ勝手に結び直さない');
  const count = stopped.job.manifest.images.length;
  const original = createHash('sha256').update(await r.app.image(1, true)).digest('hex');
  await sleep(250);
  assert.equal((await r.app.snapshot()).job.manifest.images.length, count);
  await book.close();
  await assert.rejects(r.app.command('pick', { field: 'reader' }), /select_reader_tab/, '選択タブが閉じても残る本棚へ自動切替しない');
  await assert.rejects(r.app.command('selectReaderTab', { id: tabs[1].id }), /invalid_reader_tab/);
  assert.equal(createHash('sha256').update(await r.app.image(1, true)).digest('hex'), original, '対象喪失後も確定原本を保持');
  assert.equal((await r.app.snapshot()).job.manifest.range_confirmed, false);
});

test('MVP可視指定: 案内を表示しiframe内も選べて、元のクリックを実行しない', async t => {
  const r = await setup(t);
  await r.request('create');
  await r.request('openBrowser', { mode: 'sample' });
  const page = r.app.reader.page;
  await page.evaluate(() => {
    document.documentElement.style.colorScheme = 'dark';
    const canvas = document.querySelector('#sheet');
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#d23c1e'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    const frame = document.createElement('iframe');
    frame.id = 'pickframe';
    frame.style.cssText = 'position:absolute;left:50px;top:100px;width:400px;height:200px;border:2px solid black';
    frame.srcdoc = '<!doctype html><button id="next2" data-clicks="0">次の画面</button>';
    document.body.append(frame);
  });
  const button = page.frameLocator('#pickframe').locator('#next2');
  await button.evaluate(el => el.addEventListener('click', () => { el.dataset.clicks = String(Number(el.dataset.clicks) + 1); }));
  // A reader's pre-existing top-document capture handler must not swallow the
  // app's selection gesture, nor receive it as a reading action.
  await page.evaluate(() => window.addEventListener('click', e => {
    if (e.target.closest?.('[data-ktz-selection]')) e.stopImmediatePropagation();
  }, true));
  const sheetBox = await page.locator('#sheet').boundingBox();
  const sampleClip = { x: sheetBox.x + sheetBox.width - 24, y: sheetBox.y + 24, width: 8, height: 8 };
  const originalPixel = PNG.sync.read(await page.screenshot({ clip: sampleClip })).data.subarray(0, 3);
  const picking = r.app.command('pick', { field: 'next' });
  await page.locator('[data-ktz-selection]').waitFor({ state: 'visible' });
  await page.waitForFunction(() => Boolean(window.__ktzPicker));
  const selectedPixel = PNG.sync.read(await page.screenshot({ clip: sampleClip })).data.subarray(0, 3);
  for (let channel = 0; channel < 3; channel += 1) assert.ok(Math.abs(selectedPixel[channel] - originalPixel[channel]) <= 20, '選択面が自作ページを黒や白の不透明面で覆わない');
  const box = await button.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const timeout = setTimeout(() => { void page.evaluate(() => window.__ktzPicker?.()).catch(() => {}); }, 1000);
  try { assert.deepEqual((await picking).picked, { field: 'next', selector: '#next2', frame: '#pickframe' }); }
  finally { clearTimeout(timeout); }
  assert.equal(await button.getAttribute('data-clicks'), '0');
  assert.equal(await page.locator('[data-ktz-selection]').count(), 0);
  const cancelling = assert.rejects(r.app.command('pick', { field: 'reader' }), /picker_cancelled/);
  await page.locator('[data-ktz-selection]').waitFor({ state: 'visible' });
  await page.waitForFunction(() => Boolean(window.__ktzPicker));
  await page.keyboard.press('Escape');
  await cancelling;
  assert.equal(await page.locator('[data-ktz-selection]').count(), 0);
  assert.equal((await r.app.snapshot()).job.manifest.images.length, 0);
});

test('MVP手順ガイド: 明るい画面・無効条件の説明・連続指定・古い承認破棄・接続復帰・取消', async t => {
  const r = await setup(t);
  const control = await openControlWindow(r.url, { headless: true }); t.after(() => control.close());
  const ui = control.page; await ui.emulateMedia({ colorScheme: 'dark' });
  await ui.waitForFunction(() => document.querySelector('#state').textContent === '待機');
  assert.equal(await ui.evaluate(() => getComputedStyle(document.documentElement).colorScheme), 'light');
  const pixel = PNG.sync.read(await ui.screenshot({ clip: { x: 2, y: 2, width: 2, height: 2 } })).data;
  assert.ok(pixel[0] > 220 && pixel[1] > 220 && pixel[2] > 220, 'OSがdarkでも自作UIを黒い背景にしない');
  await ui.locator('.steps [data-stage-target="capture"]').click();
  assert.match(await ui.locator('#captureHelp').textContent(), /決定・次へ.*新しい1冊/);
  assert.equal(await ui.locator('#pickAll').isDisabled(), true);
  assert.equal(await ui.locator('#previewImage').isVisible(), false);
  assert.equal(await ui.locator('#previewImage').getAttribute('src'), null);
  await ui.locator('.steps [data-stage-target="setup"]').click();
  await ui.locator('#create').click();
  await ui.locator('#openSample').click();
  await ui.waitForFunction(() => document.querySelector('#readerTab').options.length > 1);
  await selectVisibleReaderTab(ui); await openManualOptions(ui);
  await ui.waitForFunction(() => !document.querySelector('#pickAll').disabled);
  for (const id of ['pickReader', 'pickIdentity', 'pickPosition', 'pickNext']) assert.equal(await ui.locator(`#${id}`).isEnabled(), true);
  const reader = r.app.reader.page;
  await ui.locator('#pickAll').click();
  for (const [index, selector] of ['#sheet', 'h1', '#position', '#next'].entries()) {
    await reader.frameLocator('[data-ktz-selection]').locator('#ktzPickHint[data-ready="true"]').filter({ hasText: `${index + 1} / 4` }).waitFor();
    const box = await reader.locator(selector).boundingBox();
    await reader.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  }
  await ui.locator('#previewImage').waitFor({ state: 'visible' });
  await ui.waitForFunction(() => !document.querySelector('#previewConfirmed').disabled && !document.querySelector('#approval').disabled);
  assert.equal(await reader.locator('#position').innerText(), '1 / 12', '4回の指定クリックを公式操作へ渡さない');
  assert.equal((await r.app.snapshot()).job.manifest.images.length, 0);
  await ui.locator('#previewConfirmed').check(); await ui.locator('#approve').click();
  await ui.waitForFunction(() => !document.querySelector('#start').disabled);
  assert.equal((await r.app.snapshot()).job.manifest.images.length, 0, '指定も承認も取得開始ではない');
  await ui.locator('#mappingDetails > summary').click();
  await ui.locator('#reader').fill('#sheet ');
  assert.equal(await ui.locator('#previewImage').isVisible(), false);
  assert.equal(await ui.locator('#previewConfirmed').isChecked(), false);
  assert.equal(await ui.locator('#start').isDisabled(), true);
  assert.match(await ui.locator('#state').textContent(), /表示検査待ち/, 'ローカル指定変更でも古い承認済み表示を残さない');
  await ui.reload();
  await ui.waitForFunction(() => document.querySelector('#reader').value === '#sheet');
  assert.equal(await ui.locator('#start').isDisabled(), true, '再読込後に古い承認だけで開始できない');
  await ui.route('**/api/**', route => route.abort());
  await ui.waitForFunction(() => !document.querySelector('#reconnect').hidden);
  assert.match(await ui.locator('#captureHelp').textContent(), /接続が切れ/);
  assert.equal(await ui.locator('#pickAll').isDisabled(), true);
  await ui.unroute('**/api/**'); await ui.locator('#reconnect').click();
  await ui.waitForFunction(() => !document.querySelector('#pickAll').disabled);
  await openManualOptions(ui);
  await ui.locator('#pickAll').click();
  await reader.waitForFunction(() => Boolean(window.__ktzPicker));
  await ui.locator('#cancelPick').click();
  await reader.locator('[data-ktz-selection]').waitFor({ state: 'detached' });
  await ui.waitForFunction(() => !document.querySelector('#pickAll').disabled);
  assert.equal((await r.app.snapshot()).job.manifest.images.length, 0);
  await ui.locator('#pickAll').click();
  await reader.waitForFunction(() => Boolean(window.__ktzPicker));
  await ui.locator('#stop').click();
  const stopped = await waitFor(r.app, s => s.state === 'Review' && !s.busy);
  assert.equal(stopped.pickingField, null, '停止後に連続指定を次の項目へ進めない');
  assert.equal(await reader.locator('[data-ktz-selection]').count(), 0);
  assert.equal(stopped.job.manifest.images.length, 0);
});

test('MVP操作ウィンドウ: 公開起動で使う専用UIは明るくloopbackに限定し終了を通知する', async t => {
  const r = await setup(t);
  let closed = 0;
  const control = await openControlWindow(r.url, { headless: true, onClose: () => { closed += 1; } });
  t.after(() => control.close());
  await control.page.waitForFunction(() => document.querySelector('#state').textContent === '待機');
  assert.equal(control.context.pages().length, 1);
  assert.equal(await control.page.evaluate(() => matchMedia('(prefers-color-scheme: light)').matches), true);
  assert.equal(await control.page.locator('#create').isEnabled(), true);
  let foreignHits = 0;
  const foreign = http.createServer((_, res) => { foreignHits += 1; res.end('自作・別origin試料'); });
  await new Promise(resolve => foreign.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => foreign.close(resolve)));
  const other = await control.context.newPage();
  await assert.rejects(other.goto(`http://127.0.0.1:${foreign.address().port}/`));
  assert.equal(foreignHits, 0, '操作画面専用contextから別originへ通信しない');
  await other.close();
  await control.page.close(); await control.close();
  assert.equal(closed, 1);
  assert.equal(control.browser.isConnected(), false);
  await assert.rejects(openControlWindow('https://example.invalid/'), /invalid_control_url/);
});

test('MVP操作ウィンドウ終了競合: UI経由の起動・指定準備・取得を終了まで所有する', async t => {
  for (const mode of ['opening', 'picking', 'capturing']) await t.test(mode, async t => {
    let release = () => {}, heldReader, control, shutdown;
    const originalOpen = Reader.open;
    t.after(async () => {
      release(); Reader.open = originalOpen;
      await heldReader?.close(); await control?.close();
    });
    const r = await setup(t);
    let signalEntered;
    const entered = new Promise(resolve => { signalEntered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    control = await openControlWindow(r.url, { headless: true, onClose: () => {
      // Same ownership order as main: close the control browser, then the app.
      shutdown = (async () => { try { await control.close(); } finally { await r.close(); } })();
      void shutdown.catch(() => {});
    } });
    const ui = control.page;
    await ui.waitForFunction(() => document.querySelector('#state').textContent === '待機');
    await ui.locator('#create').click();
    if (mode === 'opening') Reader.open = async options => {
      heldReader = await originalOpen.call(Reader, options);
      signalEntered(); await gate; return heldReader;
    };
    await ui.locator('#openSample').click();
    let originalPath, original;
    if (mode === 'opening') await entered;
    else {
      await selectVisibleReaderTab(ui);
      await ui.waitForFunction(() => !document.querySelector('#pickAll').disabled);
      heldReader = r.app.reader;
      if (mode === 'picking') {
        await openManualOptions(ui);
        const adopt = heldReader.adoptVisibleReaderPage.bind(heldReader);
        heldReader.adoptVisibleReaderPage = async () => { await adopt(); signalEntered(); await gate; };
        await ui.locator('#pickAll').click(); await entered;
      } else {
        await ui.locator('#quickPreview').click(); await ui.locator('#previewImage').waitFor({ state: 'visible' });
        await ui.locator('#previewConfirmed').check(); await ui.locator('#approve').click();
        await ui.waitForFunction(() => !document.querySelector('#start').disabled);
        await ui.locator('#start').click();
        const captured = await waitFor(r.app, s => s.job.manifest.images.length >= 1);
        originalPath = path.join(captured.job.job_path, captured.job.manifest.images[0].path);
        original = await readFile(originalPath);
      }
    }
    const profile = r.app.profile;
    await ui.close();
    for (let i = 0; !r.app.closed && i < 100; i += 1) await sleep(10);
    assert.equal(r.app.closed, true);
    try {
      if (mode !== 'capturing') {
        const outcome = await Promise.race([shutdown.then(() => 'closed', error => error.code), sleep(100).then(() => 'pending')]);
        assert.equal(outcome, 'pending', '進行中の公開コマンドより先に終了・削除しない');
        const repeat = r.app.close();
        assert.equal(repeat, r.app.close(), '二重終了でも同じ後処理を待つ');
        assert.equal(await Promise.race([repeat.then(() => 'closed'), sleep(50).then(() => 'pending')]), 'pending');
      }
      await assert.rejects(r.app.command('create'), /application_closed/, '終了開始後は新規操作を受け付けない');
    } finally { release(); }
    await shutdown;
    await r.app.close(); // A repeated close waits for the same completed cleanup.
    assert.equal(r.app.reader, null);
    assert.equal(r.app.fixture, null);
    assert.equal(heldReader.page.isClosed(), true);
    assert.equal(r.app.store.closed, true);
    await assert.rejects(lstat(profile), { code: 'ENOENT' }, '一時プロファイルを通常終了時に削除する');
    if (originalPath) assert.deepEqual(await readFile(originalPath), original, '確定原本は終了で削除しない');
  });
});

test('MVP指定時検証: 空の位置指定はその場で止め、他の指定を保持して当該項目だけ選び直せる', async t => {
  const r = await setup(t);
  await r.request('create'); await r.request('openBrowser', { mode: 'sample' });
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const ui = withPublicDisclosures(await browser.newPage()); await ui.goto(r.url);
  await selectVisibleReaderTab(ui); await openManualOptions(ui);
  await ui.waitForFunction(() => !document.querySelector('#pickAll').disabled);
  const reader = r.app.reader.page;
  await reader.evaluate(() => {
    const empty = document.createElement('div'); empty.id = 'empty-position';
    empty.style.cssText = 'position:fixed;left:800px;top:650px;width:100px;height:40px;background:#ddd'; document.body.append(empty);
  });
  await ui.locator('#pickAll').click();
  for (const [index, selector] of ['#sheet', 'h1', '#empty-position'].entries()) {
    await reader.frameLocator('[data-ktz-selection]').locator('#ktzPickHint[data-ready="true"]').filter({ hasText: `${index + 1} / 4` }).waitFor();
    const box = await reader.locator(selector).boundingBox(); await reader.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  }
  await ui.waitForFunction(() => document.querySelector('#positionStatus').textContent.includes('要選び直し'));
  assert.equal(await ui.locator('#readerStatus').textContent(), '指定済み');
  assert.equal(await ui.locator('#identityStatus').textContent(), '指定済み');
  assert.equal(await ui.locator('#position').inputValue(), '');
  assert.equal(await ui.locator('#preview').isDisabled(), true);
  assert.equal(await ui.locator('#previewImage').isVisible(), false);
  await ui.locator('#pickPosition').click(); await reader.waitForFunction(() => Boolean(window.__ktzPicker));
  const box = await reader.locator('#position').boundingBox(); await reader.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await ui.waitForFunction(() => document.querySelector('#positionStatus').textContent === '指定済み');
  await ui.locator('#pickNext').click(); await reader.waitForFunction(() => Boolean(window.__ktzPicker));
  const nextBox = await reader.locator('#next').boundingBox(); await reader.mouse.click(nextBox.x + nextBox.width / 2, nextBox.y + nextBox.height / 2);
  await ui.waitForFunction(() => document.querySelector('#nextStatus').textContent === '指定済み');
  await ui.locator('#preview').click(); await ui.locator('#previewImage').waitFor({ state: 'visible' });
  assert.equal((await r.app.snapshot()).job.manifest.images.length, 0);
});

test('MVP位置入力欄: 表示中の現在値を文字列で照合し自動非表示でも変化を検出する', async t => {
  const r = await setup(t); await r.request('create'); await r.request('openBrowser', { mode: 'sample' });
  const page = r.app.reader.page;
  for (const type of ['text', 'number', 'range']) await t.test(type, async () => {
    await page.locator('#position').evaluate((old, type) => {
      const input = document.createElement('input'); input.id = 'position'; input.type = type; input.value = '1';
      input.style.cssText = 'position:fixed;left:800px;top:650px;width:120px'; old.replaceWith(input);
    }, type);
    const picking = r.app.command('pick', { field: 'position' });
    await page.waitForFunction(() => Boolean(window.__ktzPicker));
    const box = await page.locator('#position').boundingBox(); await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2); await picking;
    await r.request('preview', { config: sampleConfig });
    assert.equal(r.app.reader.bound.position, '1');
    await page.locator('#position').evaluate(el => { el.style.visibility = 'hidden'; });
    await r.app.reader.requireBound();
    await page.locator('#position').evaluate(el => { el.value = '2'; });
    await assert.rejects(r.app.reader.requireBound(), /target_changed/);
  });
  await page.locator('#position').evaluate(el => { el.type = 'password'; el.style.visibility = 'visible'; });
  await assert.rejects(r.app.command('preview', { config: sampleConfig }), error => error.code === 'display_or_position_unknown' && error.detail.cause === 'label_empty');
  assert.equal((await r.app.snapshot()).job.manifest.images.length, 0);
});

if (process.platform === 'linux') test('保存済みReview案内: 限定jobの読取停止と通常jobの編集・保存を混同しない', async t => {
  for (const limited of [true, false]) await t.test(limited ? '限定job' : '通常job', async t => {
    // 既存Storeの匿名保存画像だけを用意する。Reader・取得browserは開かない。
    const r = await setup(t);
    const job = (await r.app.store.call('create_job', { base_dir: r.app.dataDir })).snapshot;
    const claim = path.join(r.app.dataDir, `portable-reader-limited-${job.manifest.job_id}.claim`);
    if (limited) await writeFile(claim, `${JSON.stringify({ version: 2, job: job.manifest.job_id,
      session: 'saved-00000000-0000-0000-0000-000000000001', consumed: true,
      scope: 'preview-1-displays-2-turn-1-png-review' })}\n`, { flag: 'wx', mode: 0o600 });
    const image = new PNG({ width: 80, height: 120 });
    for (let i = 0; i < image.data.length; i += 4) {
      image.data[i] = 80; image.data[i + 1] = 150; image.data[i + 2] = i % 251; image.data[i + 3] = 255;
    }
    await r.app.store.call('capture_start'); await r.app.store.call('capture_begin');
    await r.app.store.call('capture_chunk', { capture_id: 1, data_base64: PNG.sync.write(image).toString('base64') });
    await r.app.store.call('capture_commit'); await r.app.store.call('capture_pause'); await r.app.store.call('close_job');
    const preserved = [path.join(job.job_path, 'originals/000001.png'),
      ...(limited ? [path.join(job.job_path, 'manifest.json'), claim] : [])];
    const before = await Promise.all(preserved.map(file => readFile(file)));
    const control = await openControlWindow(r.url, { headless: true });
    t.after(() => control.close());
    const page = control.page;
    await page.waitForFunction(() => document.querySelector('#state').textContent === '待機');
    assert.equal(await page.locator('#recover').isVisible(), true, '保存済み作業の入口は補助設定を開かず見つかる');
    assert.equal(await page.locator('#recoverPath').evaluate(element => element.closest('details')), null);
    await page.locator('#recoverPath').fill(job.job_path); await page.locator('#recover').click();
    await page.waitForFunction(() => {
      const image = document.querySelector('#images article img');
      return image?.complete && image.naturalWidth === 80;
    });
    assert.equal((await r.app.snapshot()).portableLimitedJob, limited);
    if (limited) {
      assert.equal(await page.locator('#decisionButton').textContent(), '保存済み画像を確認');
      assert.equal(await page.locator('#decisionButton').isEnabled(), true);
      assert.equal(await page.locator('.workflow-actions #newLimitedTrialButton').count(), 0);
      assert.equal(await page.locator('#newLimitedTrialButton').isVisible(), false, '停止画面の主要操作に新試行を出さない');
    }
    const guidance = limited ? /読取専用.*再開・再取得・編集・ZIP\/CBZ保存はできません/ : /採用画像1枚を保存できます/;
    assert.match(await page.locator('#exportHelp').textContent(), guidance);
    await page.locator('#stageTools > summary').click();
    await page.locator('#stageTools [data-stage-target="setup"]').click();
    await page.waitForFunction(() => document.querySelector('#decisionButton').dataset.action === 'inspect'
      && !document.querySelector('#decisionButton').disabled);
    assert.match(await page.locator('#nextAction').textContent(), limited ? guidance : /確定画像を点検します/);
    await page.locator('#decisionButton').click();
    await page.waitForFunction(() => !document.querySelector('[data-stage="review"]').hidden);
    assert.equal((await r.app.snapshot()).state, 'Review');
    assert.equal(await page.locator('#decisionButton').isEnabled(), true);
    assert.match(await page.locator('#nextAction').textContent(), limited ? guidance : /ZIP保存へ進みます/);
    if (limited) {
      await page.locator('#decisionButton').click();
      assert.equal((await r.app.snapshot()).state, 'Review', 'もう一度確認しても保存工程へ進まない');
    }
    await page.locator('#stageTools [data-stage-target="export"]').click();
    assert.equal(await page.locator('#decisionButton').isEnabled(), true);
    assert.equal(await page.locator('#export').isDisabled(), limited, '補助の保存画面でも限定jobの実出力は封じる');
    assert.match(await page.locator('#nextAction').textContent(), guidance);
    assert.equal(await page.getByText('停止・プレビュー失敗後も、保存済みの採用画像をZIPにできます。', { exact: true }).isVisible(), !limited,
      '通常job用の保存可能説明を限定jobには表示しない');
    if (!limited) {
      // Exercise the main save caller with the same rejection used by the
      // editing helper, then let the real Application/Store handle retries.
      const destination = path.join(r.directory, 'saved-review.zip');
      await page.locator('#destination').fill(destination);
      let release, entered, settled, exportsRequested = 0;
      const held = new Promise(resolve => { release = resolve; });
      const enteredExport = new Promise(resolve => { entered = resolve; });
      const settledExport = new Promise(resolve => { settled = resolve; });
      const rejectExport = async route => {
        if (route.request().postDataJSON()?.action !== 'export') return route.continue();
        exportsRequested += 1; entered(); await held;
        try { await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ code: 'image_review_required' }) }); }
        finally { settled(); }
      };
      await page.route('**/api/command', rejectExport);
      try {
        const request = page.waitForRequest(req => req.url().endsWith('/api/command') && req.postDataJSON()?.action === 'export', { timeout: 10_000 });
        await page.locator('#decisionButton').click(); await request; await enteredExport;
        await page.waitForFunction(() => document.querySelector('#operationStatus').getAttribute('aria-busy') === 'true'
          && document.querySelector('#decisionButton').disabled && document.querySelector('#export').disabled);
        await page.evaluate(() => { document.querySelector('#decisionButton').click(); document.querySelector('#export').click(); });
        assert.equal(exportsRequested, 1, '保存処理中の連打は追加要求を送らない');
      } finally {
        release(); if (exportsRequested) await settledExport;
        await page.unroute('**/api/command', rejectExport);
      }
      await page.waitForFunction(() => document.querySelector('#operationStatus').dataset.status === 'failure'
        && !document.querySelector('#decisionButton').disabled);
      assert.match(await page.locator('#message').textContent(), /画像点検してください/);
      assert.equal(await page.locator('#exportResult').textContent(), '');
      assert.equal((await r.app.snapshot()).job.manifest.exports.length, 0);
      await assert.rejects(readFile(destination), { code: 'ENOENT' });

      await page.locator('#decisionButton').click();
      await page.waitForFunction(() => document.querySelector('#exportResult').textContent.includes('保存・再読検証済み')
        && document.querySelector('#operationStatus').dataset.status === 'success'
        && document.querySelector('#operationStatus').getAttribute('aria-busy') === 'false'
        && document.querySelector('#decisionButton').disabled);
      const firstArchive = await readFile(destination), firstEntries = readStoredEntries(firstArchive);
      assert.deepEqual(firstEntries.map(entry => entry.name), ['000001.png']);
      assert.deepEqual(firstEntries[0].bytes, await r.app.image(1));
      assert.equal((await r.app.snapshot()).job.manifest.exports.length, 1);
      assert.equal(await page.locator('[data-stage="export"]').isVisible(), true, '保存完了は同じ画面の結果表示で知らせる');

      await page.locator('#exportOptions > summary').click();
      await page.locator('#export').click();
      await page.waitForFunction(() => document.querySelector('#operationStatus').dataset.status === 'failure'
        && document.querySelector('#message').textContent.includes('既存ファイル'));
      assert.deepEqual(await readFile(destination), firstArchive, '同名への再保存は上書きしない');
      assert.equal((await r.app.snapshot()).job.manifest.exports.length, 1);
      const secondDestination = path.join(r.directory, 'saved-review-again.zip');
      await page.locator('#destination').fill(secondDestination);
      await page.waitForFunction(() => !document.querySelector('#decisionButton').disabled);
      await page.locator('#decisionButton').click();
      await page.waitForFunction(destination => document.querySelector('#exportResult').dataset.destination === destination
        && document.querySelector('#operationStatus').dataset.status === 'success'
        && document.querySelector('#operationStatus').getAttribute('aria-busy') === 'false'
        && document.querySelector('#decisionButton').disabled, secondDestination);
      const secondEntries = readStoredEntries(await readFile(secondDestination));
      assert.deepEqual(secondEntries.map(entry => entry.name), ['000001.png']);
      assert.deepEqual(secondEntries[0].bytes, await r.app.image(1));
      assert.equal((await r.app.snapshot()).job.manifest.exports.length, 2, '別名での明示的な再保存は可能');
    }
    if (limited) {
      for (const [action, input] of [['export', { destination: path.join(r.directory, 'forbidden.zip') }],
        ['crop', { id: 1, x: 0, y: 0, width: 40, height: 60 }],
        ['review', { ids: [] }]]) {
        const response = await fetch(`${r.origin}/api/command`, { method: 'POST', headers: {
          Authorization: `Bearer ${r.token}`, 'Content-Type': 'application/json', Origin: r.origin,
        }, body: JSON.stringify({ action, input }) });
        assert.equal(response.status, 400);
        assert.equal((await response.json()).code, 'portable_limited_review_only');
      }
      // 既存jobを持つクライアントで終了未確認を投影する。closeは送らず保全する。
      r.app.readerReleasePending = true;
      try {
        await page.waitForFunction(() => document.querySelector('#cancelBackButton').disabled
          && document.querySelector('#nextAction').textContent.includes('ブラウザ資源の終了は未確認'));
        assert.equal(await page.locator('#decisionButton').isEnabled(), true, '終了未確認でも原本の読取確認だけは残す');
      } finally { r.app.readerReleasePending = false; }
      await page.waitForFunction(() => !document.querySelector('#cancelBackButton').disabled);
      for (const [language, copy, label] of [['en', /read-only.*ZIP\/CBZ export are unavailable/, 'Inspect saved images'],
        ['zh-CN', /只读.*不能继续、重新获取、编辑或导出 ZIP\/CBZ/, '检查已保存的图像']]) {
        await page.locator('#language').selectOption(language);
        assert.match(await page.locator('#nextAction').textContent(), copy);
        assert.match(await page.locator('#exportHelp').textContent(), copy);
        assert.equal(await page.locator('#decisionButton').isEnabled(), true);
        assert.equal(await page.locator('#decisionButton').textContent(), label);
      }
      await page.locator('#language').selectOption('ja');
      await page.locator('#decisionButton').click();
      await page.locator('#images article').getByRole('button', { name: '原本を点検', exact: true }).click();
      await page.locator('#inspectImage').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#inspectImage').evaluate(image => image.naturalWidth), 80);
      const evidence = await mkdtemp(path.join(root, 'readonly-review-ui-'));
      await page.locator('.workflow-bar').screenshot({ path: path.join(evidence, 'limited-saved-review.png') });
      assert.equal(await page.locator('#cancelBackButton').textContent(), '作業を閉じる（原本保持）');
      await page.locator('#cancelBackButton').click();
      await page.waitForFunction(() => !document.querySelector('#recover').disabled);
      assert.equal(await page.locator('#inspectImage').getAttribute('src'), null, 'closeで原本URLを解放する');
      for (const id of ['cropId', 'cropX', 'cropY', 'cropWidth', 'cropHeight'])
        assert.equal(await page.locator(`#${id}`).inputValue(), '', `closeで${id}の一時状態を解除する`);
      assert.equal((await r.app.snapshot()).job, null, '非変更closeは空ジョブを自動作成しない');
      assert.equal(await page.locator('#decisionButton').textContent(), '決定・次へ');
      await page.locator('#recoverPath').fill('');
      await page.locator('[data-stage="setup"]').screenshot({ path: path.join(evidence, 'saved-workspace-entry.png') });
      t.diagnostic(`匿名の読取専用案内画像（私有画像・パスなし）: ${evidence}`);
      // 同一app・同一controlの限定→通常切替で、以前のdisabledが残らないことを検査。
      const normal = (await r.app.store.call('create_job', { base_dir: r.app.dataDir })).snapshot;
      await r.app.store.call('capture_start'); await r.app.store.call('capture_begin');
      await r.app.store.call('capture_chunk', { capture_id: 1, data_base64: PNG.sync.write(image).toString('base64') });
      await r.app.store.call('capture_commit'); await r.app.store.call('capture_pause'); await r.app.store.call('close_job');
      const normalOriginal = await readFile(path.join(normal.job_path, 'originals/000001.png'));
      await page.locator('#recoverPath').fill(normal.job_path); await page.locator('#recover').click();
      await page.waitForFunction(() => document.body.dataset.limited === 'false' && !document.querySelector('#decisionButton').disabled);
      assert.equal(await page.locator('#inspectImage').isVisible(), false,
        '別jobのReviewへ切り替えたとき、前jobで開いた原本点検画像を表示しない');
      await page.locator('#decisionButton').click();
      await page.waitForFunction(() => !document.querySelector('#crop').disabled);
      for (const id of ['restoreOrder', 'detectCrop', 'crop', 'resetCrop', 'applyAutoCrop'])
        assert.equal(await page.locator(`#${id}`).isEnabled(), true, `同じ画面で通常jobの${id}を復帰`);
      await page.locator('#images article').getByRole('button', { name: '原本を点検・クロップ', exact: true }).click();
      await page.locator('#inspectImage').waitFor({ state: 'visible' });
      await page.waitForFunction(() => !document.querySelector('#crop').disabled);
      await page.locator('#cropWidth').fill('40'); await page.locator('#cropHeight').fill('60');
      await page.locator('#crop').click();
      await waitFor(r.app, s => s.job.manifest.images[0].crop?.width === 40 && !s.busy);
      await page.waitForFunction(() => !document.querySelector('#inspectImage').hidden
        && document.querySelector('#inspectImage').naturalWidth === 40
        && document.querySelector('#inspectCaption').textContent === '適用後のクロップ結果');
      assert.deepEqual(await readFile(path.join(normal.job_path, 'originals/000001.png')), normalOriginal,
        '復帰した明示cropは通常jobの派生画像だけを変更');
    }
    assert.deepEqual(await Promise.all(preserved.map(file => readFile(file))), before);
    if (!limited) assert.equal((await r.app.snapshot()).job.manifest.exports.length, 2);
    assert.equal(r.app.reader, undefined);
  });
});

test('保存済みReview案内: 通常jobの切替・入力保持と旧画像応答の失効', { timeout: 60_000 }, async t => {
  const r = await setup(t);
  const jobs = [];
  for (let jobIndex = 0; jobIndex < 2; jobIndex++) {
    const job = (await r.app.store.call('create_job', { base_dir: r.app.dataDir })).snapshot;
    await r.app.store.call('capture_start');
    for (const [width, height] of [[80, 120], [64, 96]]) {
      const image = new PNG({ width, height });
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4, edge = x < 12 || y < 12 || x >= width - 12 || y >= height - 12;
        image.data[i] = edge ? 255 : 60 + jobIndex * 100; image.data[i + 1] = edge ? 255 : 120;
        image.data[i + 2] = edge ? 255 : 180; image.data[i + 3] = 255;
      }
      const begun = await r.app.store.call('capture_begin');
      await r.app.store.call('capture_chunk', { capture_id: begun.capture_id, data_base64: PNG.sync.write(image).toString('base64') });
      await r.app.store.call('capture_commit');
    }
    await r.app.store.call('capture_pause'); await r.app.store.call('close_job'); jobs.push(job);
  }
  const files = jobs.flatMap(job => ['manifest.json', 'originals/000001.png', 'originals/000002.png'].map(name => path.join(job.job_path, name)));
  const before = await Promise.all(files.map(file => readFile(file)));
  const control = await openControlWindow(r.url, { headless: true }); t.after(() => control.close());
  const ui = control.page;
  const recover = async job => {
    await r.request('recover', { path: job.job_path });
    await ui.waitForFunction(id => document.body.dataset.preparationJob === id, job.manifest.job_id);
    await ui.locator('#images article[data-capture-id="2"]').waitFor();
  };
  const close = async () => {
    await r.request('closeJob');
    await ui.waitForFunction(() => document.body.dataset.preparationJob === '');
    assert.equal(await ui.locator('#inspectImage').getAttribute('src'), null);
    assert.equal(await ui.locator('#cropId').inputValue(), '');
  };
  const inspect = async id => {
    await ui.locator(`#images article[data-capture-id="${id}"] .limited-inspect`).click();
    await ui.waitForFunction(width => {
      const image = document.querySelector('#inspectImage');
      return !image.hidden && image.naturalWidth === width;
    }, id === 1 ? 80 : 64);
  };
  await recover(jobs[0]); await inspect(1);
  await ui.locator('#cropX').fill('7'); await ui.locator('#cropWidth').fill('55');
  await r.request('review'); // 同jobのsnapshotを更新しても下書きを失わない。
  await ui.locator('#language').selectOption('en'); await ui.locator('#language').selectOption('ja');
  await ui.locator('#stageTools > summary').click();
  await ui.locator('#stageTools [data-stage-target="export"]').click();
  await ui.locator('#stageTools [data-stage-target="review"]').click();
  assert.equal(await ui.locator('#cropX').inputValue(), '7');
  assert.equal(await ui.locator('#cropWidth').inputValue(), '55');
  assert.equal(await ui.locator('#inspectImage').isVisible(), true);
  await inspect(2);
  assert.equal(await ui.locator('#cropX').inputValue(), '0');
  assert.equal(await ui.locator('#cropWidth').inputValue(), '64', '別画像はその画像の初期寸法を使う');
  await r.request('crop', { id: 1, x: 3, y: 4, width: 50, height: 70 });
  await ui.waitForFunction(() => document.querySelector('#images article[data-capture-id="1"]')?.textContent.includes('クロップあり'));
  await inspect(1);
  assert.equal(await ui.locator('#cropX').inputValue(), '3');
  assert.equal(await ui.locator('#cropWidth').inputValue(), '50', '再選択は既存cropの値を使う');
  await r.request('resetCrop', { id: 1 });
  // 明示編集を元に戻した後のmanifestを、以降の読取操作の不変基準とする。
  let baseline = await Promise.all(files.map(file => readFile(file)));
  await close(); await recover(jobs[1]);
  assert.equal(await ui.locator('#inspectImage').isVisible(), false, '通常job同士でも旧原本を表示しない');
  await inspect(1); await close(); await recover(jobs[0]);

  // 既存公開画像APIの応答を保持し、close→B→Aの後に古いAを返す。
  let releaseResponse, responseHeld;
  const released = new Promise(resolve => { releaseResponse = resolve; });
  const held = new Promise(resolve => { responseHeld = resolve; });
  const routeImage = async route => {
    const response = await route.fetch(); responseHeld(); await released; await route.fulfill({ response });
  };
  await ui.route('**/api/image/1?original=1', routeImage, { times: 1 });
  try {
    await ui.locator('#images article[data-capture-id="1"] .limited-inspect').click(); await held;
    await close(); await recover(jobs[1]); await close(); await recover(jobs[0]); await inspect(2);
  } finally { releaseResponse(); }
  await ui.waitForFunction(() => document.querySelector('#message').textContent.includes('以前の検査結果'));
  assert.equal(await ui.locator('#inspectImage').evaluate(image => image.naturalWidth), 64);
  assert.equal(await ui.locator('#inspectImage').isVisible(), true, '旧応答は現在の画像を隠さない');
  assert.equal(await ui.locator('#cropId').inputValue(), '2');

  // decode済みだが反映前の派生画像も、同じAに戻っただけでは再採用しない。
  await ui.evaluate(() => {
    const image = document.querySelector('#inspectImage'), decode = image.decode.bind(image);
    image.decode = async () => {
      image.decode = decode;
      await decode(); window.inspectionDecodeHeld = true;
      await new Promise(resolve => { window.releaseInspectionDecode = resolve; });
    };
  });
  await ui.locator('#cropWidth').fill('40'); await ui.locator('#cropHeight').fill('60');
  await ui.locator('#crop').click();
  await ui.waitForFunction(() => window.inspectionDecodeHeld === true);
  baseline = await Promise.all(files.map(file => readFile(file)));
  await close(); await recover(jobs[1]); await close(); await recover(jobs[0]); await inspect(1);
  await ui.evaluate(() => window.releaseInspectionDecode());
  await ui.waitForFunction(() => document.querySelector('#message').textContent.includes('以前の検査結果'));
  assert.equal(await ui.locator('#inspectImage').isVisible(), true);
  assert.equal(await ui.locator('#inspectImage').evaluate(image => image.naturalWidth), 80);
  assert.equal(await ui.locator('#inspectCaption').textContent(), '原本');
  assert.equal(await ui.locator('#cropWidth').inputValue(), '80');

  // 遅延したcrop候補も別job・別画像の候補や寸法として復活させない。
  let releaseCandidate, candidateHeld;
  const candidateReleased = new Promise(resolve => { releaseCandidate = resolve; });
  const candidateReady = new Promise(resolve => { candidateHeld = resolve; });
  const routeCandidate = async route => {
    if (route.request().postDataJSON().action !== 'detectCrop') return route.continue();
    const response = await route.fetch(); candidateHeld(); await candidateReleased; await route.fulfill({ response });
  };
  await ui.route('**/api/command', routeCandidate);
  try {
    await ui.locator('#detectCrop').click(); await candidateReady;
    await close(); await recover(jobs[1]); await close(); await recover(jobs[0]); await inspect(1);
  } finally { releaseCandidate(); }
  await ui.waitForFunction(() => document.querySelector('#message').textContent.includes('以前の検査結果'));
  await ui.unroute('**/api/command', routeCandidate);
  assert.equal(await ui.locator('#autoCropFigure').isVisible(), false);
  assert.equal(await ui.locator('#autoCropBounds').textContent(), '');
  assert.equal(await ui.locator('#cropId').inputValue(), '1');
  assert.equal(await ui.locator('#cropWidth').inputValue(), '80');
  assert.deepEqual(await Promise.all(files.map(file => readFile(file))), baseline);
  assert.deepEqual(await Promise.all(files.filter(file => file.endsWith('.png')).map(file => readFile(file))),
    before.filter((_, index) => files[index].endsWith('.png')), '明示cropも原本を変更しない');
  const evidence = await mkdtemp(path.join(root, 'workspace-switch-ui-'));
  await ui.locator('[data-stage="review"]').screenshot({ path: path.join(evidence, 'current-job-original.png') });
  await close(); await recover(jobs[1]);
  await ui.locator('[data-stage="review"]').screenshot({ path: path.join(evidence, 'switched-job-unselected.png') });
  t.diagnostic(`匿名のjob切替後UI（固定試料のみ、私有画像・パスなし）: ${evidence}`);
});

test('停止確定境界: 保存中は編集を拒否し完了後の採用順を上書きしない', { timeout: 30_000 }, async t => {
  const evidence = await mkdtemp(path.join(root, 'stop-review-ui-'));
  t.diagnostic(`匿名の停止確定・採用順UI: ${evidence}`);
  for (const boundary of ['capture_stop', 'set_review_order']) await t.test(boundary, async t => {
    let control;
    const r = await setup(t, { controlFirst: { control: () => control } });
    await r.request('create');
    await r.app.store.call('capture_start');
    const image = new PNG({ width: 8, height: 8 }); image.data.fill(180);
    for (let i = 0; i < 3; i++) {
      const begun = await r.app.store.call('capture_begin');
      await r.app.store.call('capture_chunk', { capture_id: begun.capture_id, data_base64: PNG.sync.write(image).toString('base64') });
      await r.app.store.call('capture_commit');
    }
    await r.app.store.call('capture_pause');
    r.app.state = 'Paused';
    control = await openControlWindow(r.url, { headless: true });
    const page = control.page;
    let entered, release;
    const reached = new Promise(resolve => { entered = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    const call = r.app.store.call.bind(r.app.store);
    r.app.store.call = async (kind, input) => {
      if (kind === boundary) { entered(); await held; }
      return call(kind, input);
    };
    const stopping = r.request('stop');
    try {
      await reached;
      const during = await r.app.snapshot();
      assert.equal(during.busy, true, '停止の保存確定までbusyを維持する');
      for (const action of ['review', 'crop', 'export', 'resetImages', 'closeJob', 'chooseDestination', 'stop', 'pause']) {
        await assert.rejects(r.app.command(action, { ids: [2, 1] }), { code: 'operation_busy' }, action);
      }
      await page.waitForFunction(() => document.querySelector('#operationStatus').getAttribute('aria-busy') === 'true');
      assert.equal(await page.locator('#decisionButton').isDisabled(), true);
      if (boundary === 'capture_stop') await page.screenshot({ path: path.join(evidence, 'stop-pending.png') });
      assert.deepEqual(during.job.manifest.selected_capture_ids, [1, 2, 3]);
    } finally { release(); await stopping; r.app.store.call = call; }
    assert.equal((await r.app.snapshot()).busy, false);
    await page.locator('#orderDetails > summary').click();
    await page.locator('#order').fill('2,1');
    await page.locator('#saveOrder').click();
    const reviewed = await waitFor(r.app, s => !s.busy && s.job.manifest.selected_capture_ids.join(',') === '2,1');
    assert.deepEqual(reviewed.job.manifest.excluded_capture_ids, [3]);
    assert.equal(reviewed.job.manifest.images.length, 3);
    for (const item of reviewed.job.manifest.images) assert.deepEqual(await r.app.image(item.capture_id, true), PNG.sync.write(image));
    if (boundary === 'capture_stop') await page.screenshot({ path: path.join(evidence, 'review-saved.png') });
    // An edit accepted first owns the boundary too; stop cannot retain an old
    // selection while that edit's durable write is still pending.
    let editing;
    const editReached = new Promise(resolve => { editing = resolve; });
    let finishEdit;
    const editHeld = new Promise(resolve => { finishEdit = resolve; });
    r.app.store.call = async (kind, input) => {
      if (kind === 'set_review_order') { editing(); await editHeld; }
      return call(kind, input);
    };
    const edit = r.request('review', { ids: [1, 2] });
    try {
      await editReached;
      await assert.rejects(r.app.command('stop'), { code: 'operation_busy' });
    } finally { finishEdit(); await edit; r.app.store.call = call; }
    assert.deepEqual((await r.app.snapshot()).job.manifest.selected_capture_ids, [1, 2]);
  });
  await t.test('停止保存失敗は未確定を保持し安全終了で回復する', async t => {
    const r = await setup(t); await r.request('create');
    const call = r.app.store.call.bind(r.app.store);
    r.app.store.call = (kind, input) => {
      if (kind === 'capture_stop') throw new Error('fixture_stop_unconfirmed');
      return call(kind, input);
    };
    await assert.rejects(r.app.command('stop'), /fixture_stop_unconfirmed/);
    r.app.store.call = call;
    const failed = await r.app.snapshot();
    assert.equal(failed.busy, false);
    assert.equal(failed.recoveryRequired, true);
    assert.equal(failed.state, 'NeedsAttention');
    await assert.rejects(r.app.command('review', { ids: [] }), { code: 'safe_stop_incomplete' });
    await r.request('finishBook');
    assert.equal((await r.app.snapshot()).recoveryRequired, false);
  });
});

test('公開MVP画面: 試料プレビュー・明示開始・一時停止/復帰・点検順序・クロップ・ZIP/CBZ・中断データ再表示', async t => {
  const r = await setup(t);
  const control = await openControlWindow(r.url, { headless: true });
  t.after(() => control.close());
  const page = control.page;
  const foreign = [];
  page.on('request', req => { if (new URL(req.url()).origin !== r.origin && !req.url().startsWith('blob:')) foreign.push(req.url()); });
  await page.waitForFunction(() => document.querySelector('#state').textContent === '待機');
  await page.locator('#create').click();
  await page.locator('#openSample').waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.querySelector('#openSample').disabled);
  await page.locator('#openSample').click();
  await page.waitForFunction(() => document.querySelector('#reader').value === '#sheet');
  await selectVisibleReaderTab(page);
  await page.locator('#quickPreview').click();
  await page.locator('#previewImage').waitFor({ state: 'visible' });
  assert.equal(await r.app.reader.page.locator('#position').innerText(), '1 / 12');
  assert.equal((await r.app.snapshot()).job.manifest.images.length, 0, 'プレビューはディスクの作業画像を作らない');
  assert.deepEqual(await readdir(path.join((await r.app.snapshot()).job.job_path, 'originals')), []);
  await assert.rejects(r.app.command('start', { confirmed: true }), /explicit_start_required/);
  await page.locator('#previewConfirmed').check();
  await page.locator('#approve').click();
  await page.waitForFunction(() => !document.querySelector('#start').disabled);
  assert.equal((await r.app.snapshot()).job.manifest.images.length, 0, '承認だけでは取得しない');
  assert.deepEqual(await readdir(path.join((await r.app.snapshot()).job.job_path, 'originals')), []);
  await page.locator('#start').click();
  await waitFor(r.app, s => s.job.manifest.images.length >= 2);
  await page.waitForFunction(() => document.querySelector('#state').textContent === '取得中');
  await page.locator('#pause').click();
  const paused = await waitFor(r.app, s => s.state === 'Paused' && !s.busy);
  assert.equal(paused.state, 'Paused');
  await page.waitForFunction(() => document.querySelector('#state').textContent === '一時停止');
  const count = paused.job.manifest.images.length;
  await sleep(300);
  assert.equal((await r.app.snapshot()).job.manifest.images.length, count);
  await assert.rejects(r.app.command('start', { confirmed: true }), /explicit_start_required/);
  // Model the user's manual position alignment. No implicit automatic navigation
  // is part of the application's resume path.
  const current = Number(await r.app.reader.page.locator('#reader').getAttribute('data-position'));
  if (current === count) await r.app.reader.page.locator('#next').click();
  await page.locator('#quickPreview').click();
  await page.locator('#previewImage').waitFor({ state: 'visible' });
  await assert.rejects(r.app.command('approve', { confirmed: true }), /resume_confirmation_required/);
  await page.locator('#previewConfirmed').check();
  await page.locator('#resumeConfirmed').check();
  await page.locator('#approve').click();
  await page.waitForFunction(() => !document.querySelector('#start').disabled);
  await page.locator('#start').click();
  await waitFor(r.app, s => s.job.manifest.images.length > count);
  await page.locator('#stop').click();
  const stopped = await waitFor(r.app, s => s.state === 'Review' && !s.busy);
  const jobPath = stopped.job.job_path;
  assert.equal(stopped.state, 'Review');
  const original = await readFile(path.join(jobPath, 'originals', '000001.png'));
  await page.locator('#orderDetails > summary').click();
  await page.locator('#order').fill('2,1');
  await page.locator('#saveOrder').click();
  await waitFor(r.app, s => s.job.manifest.selected_capture_ids.join(',') === '2,1');
  await page.locator('[data-capture-id="2"]').getByRole('button', { name: '後へ', exact: true }).click();
  await waitFor(r.app, s => s.job.manifest.selected_capture_ids.join(',') === '1,2');
  await page.locator('[data-capture-id="2"]').getByRole('button', { name: '前へ', exact: true }).click();
  await waitFor(r.app, s => s.job.manifest.selected_capture_ids.join(',') === '2,1');
  await page.locator('#cropId').fill('1');
  await page.locator('#cropWidth').fill('300');
  await page.locator('#cropHeight').fill('200');
  await page.locator('#crop').click();
  await waitFor(r.app, s => s.job.manifest.images[0].crop?.width === 300);
  await page.locator('#inspectImage').waitFor({ state: 'visible' });
  const png = PNG.sync.read(await r.app.image(1));
  assert.deepEqual([png.width, png.height], [300, 200]);
  const destination = path.join(r.directory, 'free.cbz');
  await page.locator('#decisionButton').click();
  await page.locator('#exportOptions > summary').click();
  await page.locator('#format').selectOption('cbz');
  await page.locator('#destination').fill(destination);
  await page.locator('#warningsAccepted').check();
  await page.locator('#export').click();
  await page.waitForFunction(() => document.querySelector('#exportResult').textContent.includes('保存先：'));
  const output = await readFile(destination);
  assert.equal(output.readUInt32LE(0), 0x04034b50);
  const info = await r.app.snapshot();
  const expectedImages = [await r.app.image(2), await r.app.image(1)];
  const verifyEntries = archive => {
    const entries = readStoredEntries(archive);
    assert.deepEqual(entries.map(entry => entry.name), ['000001.png', '000002.png']);
    assert.equal(entries.length, expectedImages.length);
    entries.forEach((entry, index) => {
      assert.deepEqual(entry.bytes, expectedImages[index], `image ${index + 1} bytes/order`);
      assert.equal(createHash('sha256').update(entry.bytes).digest('hex'), createHash('sha256').update(expectedImages[index]).digest('hex'));
      assert.ok(PNG.sync.read(entry.bytes).width > 0);
    });
  };
  verifyEntries(output);
  assert.equal(info.job.manifest.exports[0].entry_count, 2);
  assert.equal(info.job.manifest.exports[0].range_confirmed, false);
  assert.equal(info.job.manifest.exports[0].sha256, createHash('sha256').update(output).digest('hex'));
  const zipDestination = path.join(r.directory, 'free.zip');
  await page.locator('#format').selectOption('zip');
  await page.locator('#destination').fill(zipDestination);
  await page.locator('#export').click();
  const zipInfo = await waitFor(r.app, s => s.job.manifest.exports.length === 2 && !s.busy);
  const zipOutput = await readFile(zipDestination);
  verifyEntries(zipOutput);
  assert.equal(zipOutput.readUInt32LE(0), 0x04034b50);
  assert.equal(zipInfo.job.manifest.exports[1].entry_count, 2);
  assert.equal(zipInfo.job.manifest.exports[1].sha256, createHash('sha256').update(zipOutput).digest('hex'));
  const existing = await stat(destination);
  await assert.rejects(r.app.command('export', { destination, format: 'cbz', warningsAccepted: true }), /output_exists/);
  assert.equal((await stat(destination)).ino, existing.ino);
  assert.deepEqual(await readFile(destination), output);
  assert.deepEqual(await readFile(path.join(jobPath, 'originals', '000001.png')), original);
  assert.deepEqual(foreign, []);
  await page.locator('.steps [data-stage-target="browser"]').click();
  await page.locator('[data-stage="browser"] > details > summary').click();
  await page.locator('#closeBrowser').click();
  await waitFor(r.app, s => !s.browserOpen && !s.busy);
  assert.equal((await r.app.snapshot()).sessions.length, 0, '一時プロファイルを通常終了時に削除');
  await page.locator('.steps [data-stage-target="setup"]').click();
  await page.locator('[data-stage="setup"] details > summary').click();
  const call = r.app.store.call.bind(r.app.store);
  r.app.store.call = async (kind, input) => {
    if (kind === 'close_job') throw new Error('fixture_close_failed');
    return call(kind, input);
  };
  await assert.rejects(r.app.command('closeJob'), /fixture_close_failed/);
  assert.equal((await r.app.snapshot()).job.job_path, jobPath, '終了失敗なら既存ジョブを保持する');
  let signalClosed, releaseClose;
  const closed = new Promise(resolve => { signalClosed = resolve; });
  const closing = new Promise(resolve => { releaseClose = resolve; });
  r.app.store.call = async (kind, input) => {
    const result = await call(kind, input);
    if (kind === 'close_job') { signalClosed(); await closing; }
    return result;
  };
  await page.locator('#closeJob').click();
  await closed;
  try {
    const duringClose = await r.app.snapshot();
    assert.equal(duringClose.job.job_path, jobPath, 'Rust終了とUI反映の間も進捗照会で失敗しない');
  } finally { releaseClose(); }
  await waitFor(r.app, s => !s.job && !s.busy);
  r.app.store.call = call;
  await page.locator('#recoverPath').fill(jobPath);
  await page.locator('#recover').click();
  const reopened = await waitFor(r.app, s => s.state === 'ResumeCheck' && !s.busy);
  assert.equal(reopened.state, 'ResumeCheck');
  assert.equal(reopened.job.manifest.images.length, stopped.job.manifest.images.length);
  assert.deepEqual(reopened.job.manifest.selected_capture_ids, [2, 1]);
  assert.equal(reopened.job.manifest.images[0].crop.width, 300);
});

test('Ubuntu通常取得: 正の有限予算は承認時の上限・復帰方式を固定し不明な送りを再送しない', async () => {
  const { createNormalCaptureBudget, isNormalCaptureBudget } = await import('../app/expected-capture-budget.mjs');
  const { createGuiCaptureBudget, createExpectedCaptureBudget } = await import('../app/expected-capture-budget.mjs');
  const { appFiles } = await import('../scripts/linux-distribution.mjs');
  assert.ok(appFiles.includes('app/expected-capture-budget.mjs'), '通常budgetを含む既存moduleも固定bundle入力に入る');
  assert.ok(appFiles.includes('app/portable-normal-job.mjs'), '通常job identityも固定bundle入力に入る');
  const budget = createNormalCaptureBudget();
  assert.equal(isNormalCaptureBudget(budget), true);
  assert.equal(isNormalCaptureBudget(createGuiCaptureBudget()), false);
  assert.equal(isNormalCaptureBudget(createExpectedCaptureBudget()), false);
  await budget.screenshot('preview', async () => 'preview');
  for (const limit of [0, -1, 1.5, '3']) {
    assert.throws(() => budget.approve(limit, { resumeAdvance: false }), { code: 'expected_capture_budget_exhausted' });
  }
  budget.approve(3, { resumeAdvance: false });
  assert.throws(() => budget.start(4, { resumeAdvance: false }), { code: 'expected_capture_budget_exhausted' });
  assert.throws(() => budget.start(3, { resumeAdvance: true }), { code: 'expected_capture_budget_exhausted' });
  budget.start(3, { resumeAdvance: false });
  budget.commit();
  await budget.advance(async () => 'sent'); budget.confirmAdvance();
  await budget.screenshot('capture', async () => 'second'); budget.commit();
  await budget.advance(async () => 'sent'); budget.confirmAdvance();
  await budget.screenshot('capture', async () => 'third'); budget.commit();
  let unexpected = 0;
  await assert.rejects(budget.advance(async () => { unexpected++; }), { code: 'expected_capture_budget_exhausted' });
  budget.finish();
  assert.equal(unexpected, 0);
  assert.deepEqual(budget.snapshot(), { phase: 'finished', screenshots: 3, sends: 2, committed: 3, approved: 3, resumeAdvance: false });

  const resumed = createNormalCaptureBudget();
  await resumed.screenshot('preview', async () => 'last-original');
  resumed.approve(1, { resumeAdvance: true }); resumed.start(1, { resumeAdvance: true });
  assert.throws(() => resumed.commit(), { code: 'expected_capture_budget_exhausted' });
  await resumed.advance(async () => 'sent'); resumed.confirmAdvance();
  await resumed.screenshot('capture', async () => 'new-original'); resumed.commit(); resumed.finish();
  assert.deepEqual(resumed.snapshot(), { phase: 'finished', screenshots: 2, sends: 1, committed: 1, approved: 1, resumeAdvance: true });

  const lost = createNormalCaptureBudget();
  await lost.screenshot('preview', async () => 'preview');
  lost.approve(2, { resumeAdvance: false }); lost.start(2, { resumeAdvance: false }); lost.commit();
  await assert.rejects(lost.advance(async () => { throw new Error('anonymous_response_loss'); }), /anonymous_response_loss/);
  await assert.rejects(lost.advance(async () => { unexpected++; }), { code: 'expected_capture_budget_exhausted' });
  assert.equal(unexpected, 0); assert.equal(lost.snapshot().phase, 'failed');

  const automatic = createNormalCaptureBudget();
  await automatic.screenshot('preview', async () => 'preview');
  automatic.approve(null, { resumeAdvance: false });
  assert.throws(() => automatic.start(3, { resumeAdvance: false }), { code: 'expected_capture_budget_exhausted' });
  automatic.start(null, { resumeAdvance: false });
  automatic.commit();
  for (let i = 0; i < 2; i++) {
    await automatic.advance(async () => 'sent'); automatic.confirmAdvance();
    await automatic.screenshot('capture', async () => 'next'); automatic.commit();
  }
  automatic.finish();
  assert.deepEqual(automatic.snapshot(), { phase: 'finished', screenshots: 3, sends: 2, committed: 3, approved: null, resumeAdvance: false });

  const autoResume = createNormalCaptureBudget();
  await autoResume.screenshot('preview', async () => 'last-original');
  autoResume.approve(null, { resumeAdvance: true }); autoResume.start(null, { resumeAdvance: true });
  await autoResume.advance(async () => 'sent'); autoResume.confirmAdvance();
  await autoResume.screenshot('capture', async () => 'new-original'); autoResume.commit(); autoResume.finish();
  assert.equal(autoResume.snapshot().committed, 1);
});

// Portable job records use Linux-only claim identity and directory durability.
// Shared capture-budget/API regressions below remain registered on both OSes.
if (process.platform === 'linux') test('Ubuntu通常取得: 停止記録は通常jobに結び付き途中・旧限定・異常を不明として保全する', async t => {
  const { markPortableNormalJob, bindPortableNormalJob, readPortableNormalResult,
    beginPortableNormalResult, finishPortableNormalResult } = await import('../app/portable-normal-job.mjs');
  const session = 'saved-00000000-0000-0000-0000-000000000001';
  await t.test('通常jobと中断途中', async sub => {
    const r = await setup(sub); await r.request('create');
    const job = r.app.job, data = r.app.dataDir, id = job.manifest.job_id;
    assert.equal(await readPortableNormalResult(data, job), null, '旧記録なしから理由を後付けしない');
    await markPortableNormalJob(data, job); await bindPortableNormalJob(data, job, session);
    const first = await beginPortableNormalResult(data, job, session, null);
    assert.deepEqual(await readPortableNormalResult(data, job), { status: 'unknown', mode: 'auto', limit: null, reason: null, stage: null, dispatch: null });
    await assert.rejects(beginPortableNormalResult(data, job, session, 3), { code: 'portable_normal_job_unavailable' });
    await finishPortableNormalResult(data, job, first, 'end_candidate', 'end_stop', 'not_sent');
    const old = path.join(data, `portable-normal-${id}.result-000000000001.stop`), oldBytes = await readFile(old);
    assert.deepEqual(await readPortableNormalResult(data, job), { status: 'stopped', mode: 'auto', limit: null, reason: 'end_candidate', stage: 'end_stop', dispatch: 'not_sent' });
    const second = await beginPortableNormalResult(data, job, session, 2);
    await finishPortableNormalResult(data, job, second, 'capture_limit_reached', 'capture_limit_stop', 'not_sent');
    assert.deepEqual(await readPortableNormalResult(data, job), { status: 'stopped', mode: 'manual', limit: 2, reason: 'capture_limit_reached', stage: 'capture_limit_stop', dispatch: 'not_sent' });
    assert.deepEqual(await readFile(old), oldBytes, '先行結果を上書きしない');
    const pending = path.join(data, `portable-normal-${id}.result-000000000003.start.pending`);
    await writeFile(pending, 'incomplete', { flag: 'wx', mode: 0o600 });
    assert.deepEqual(await readPortableNormalResult(data, job), { status: 'unknown', mode: null, limit: null, reason: null, stage: null, dispatch: null });
    await assert.rejects(beginPortableNormalResult(data, job, session, null), { code: 'portable_normal_job_unavailable' });
    assert.equal(await readFile(pending, 'utf8'), 'incomplete'); assert.deepEqual(await readFile(old), oldBytes);
  });
  await t.test('旧限定claimを通常記録へ昇格しない', async sub => {
    const r = await setup(sub); await r.request('create');
    const job = r.app.job, data = r.app.dataDir, id = job.manifest.job_id;
    const claim = path.join(data, `portable-reader-limited-${id}.claim`);
    const record = JSON.stringify({ version: 2, job: id, session, scope: 'preview-1-displays-2-turn-1-png-review', consumed: true });
    await writeFile(claim, record, { flag: 'wx', mode: 0o600 });
    await assert.rejects(markPortableNormalJob(data, job), { code: 'portable_normal_job_unavailable' });
    await assert.rejects(beginPortableNormalResult(data, job, session, null), { code: 'portable_normal_job_unavailable' });
    assert.equal(await readPortableNormalResult(data, job), null);
    assert.equal(await readFile(claim, 'utf8'), record);
    assert.equal((await readdir(data)).some(file => file.startsWith(`portable-normal-${id}.`)), false);
  });
});

test('Ubuntu通常取得: 共通APIの通常budget基盤は確定位置だけ復帰し原本と出力を保持', { timeout: 90000 }, async t => {
  const { createNormalCaptureBudget } = await import('../app/expected-capture-budget.mjs');
  const r = await setup(t);
  await r.request('create');
  // Anonymous test-only guard on the existing sample. This verifies the shared
  // Application/Reader contract, not the still-unconnected Linux site/owner.
  const open = Reader.open;
  Reader.open = async options => {
    const reader = await open.call(Reader, options);
    let budget = createNormalCaptureBudget();
    reader.ownedSessionGuard = { normal: true, get singleRunBudget() { return budget; },
      async preparePreview() { budget = createNormalCaptureBudget(); },
      validateConfig() {}, validateTransition() {}, async assertIdentity() {}, async observe() { return 'anonymous'; }, async dispose() {} };
    return reader;
  };
  try { await r.request('openBrowser', { mode: 'sample' }); }
  finally { Reader.open = open; }
  await r.request('preview', { config: sampleConfig });
  await r.request('approve', { confirmed: true, maxCaptures: 1 });
  const approvedGuard = r.app.reader.ownedSessionGuard;
  r.app.reader.ownedSessionGuard = { ...approvedGuard };
  await assert.rejects(r.app.command('start', { confirmed: true }), { code: 'target_changed' });
  assert.equal((await r.app.snapshot()).job.manifest.images.length, 0);
  assert.equal((await r.app.snapshot()).previewApproved, false);
  r.app.reader.ownedSessionGuard = approvedGuard;
  await assert.rejects(r.app.command('start', { confirmed: true }), { code: 'explicit_start_required' });
  await r.request('preview', { config: sampleConfig });
  await r.request('approve', { confirmed: true, maxCaptures: 1 });
  await r.request('start', { confirmed: true });
  let stopped = await waitFor(r.app, s => s.state === 'Review' && !s.busy);
  assert.equal(stopped.reason, 'capture_limit_reached');
  assert.equal(stopped.job.manifest.checkpoint.dispatch, 'not_sent');
  assert.equal(stopped.job.manifest.range_confirmed, false);
  const original = await r.app.image(1, true);
  await r.request('preview', { config: sampleConfig });
  assert.equal((await r.app.snapshot()).resumePlan.mode, 'advance');
  await assert.rejects(r.app.command('approve', { confirmed: true, maxCaptures: 4 }), { code: 'resume_confirmation_required' });
  const pending = path.join(stopped.job.job_path, 'pending', '999999.upload');
  await writeFile(pending, 'anonymous incomplete upload', { flag: 'wx', mode: 0o600 });
  const beforeRefusal = (await r.app.snapshot()).job.manifest;
  await assert.rejects(r.app.command('approve', { confirmed: true, resumeConfirmed: true, maxCaptures: 4 }), { code: 'resume_position_required' });
  assert.deepEqual((await r.app.snapshot()).job.manifest, beforeRefusal);
  assert.deepEqual(await readFile(pending, 'utf8'), 'anonymous incomplete upload');
  await rm(pending); // This test created this anonymous file, and its owner is still live.
  await r.request('approve', { confirmed: true, resumeConfirmed: true, maxCaptures: 4 });
  let sends = 0;
  const reader = r.app.reader, click = reader.page.mouse.click.bind(reader.page.mouse);
  reader.page.mouse.click = async (...args) => {
    await click(...args); sends++;
    if (sends === 2) await reader.page.locator('#next').evaluate(node => { node.disabled = true; });
  };
  await r.request('start', { confirmed: true });
  stopped = await waitFor(r.app, s => ['Review', 'NeedsAttention'].includes(s.state) && !s.busy);
  assert.equal(stopped.state, 'Review', JSON.stringify(stopped.lastFailure));
  assert.equal(stopped.reason, 'end_candidate');
  assert.equal(stopped.job.manifest.images.length, 3); assert.equal(sends, 2);
  assert.equal(stopped.job.manifest.range_confirmed, false);
  assert.equal(stopped.job.manifest.images.some(image => image.duplicate_candidate), false);
  assert.deepEqual(await r.app.image(1, true), original);
  await r.request('review', { ids: [3, 1] });
  await r.request('crop', { id: 1, x: 0, y: 0, width: 300, height: 200 });
  const expected = [await r.app.image(3), await r.app.image(1)];
  for (const format of ['zip', 'cbz']) {
    const destination = path.join(r.directory, `normal-foundation.${format}`);
    await r.request('export', { destination, format, rangeConfirmed: false });
    assert.deepEqual(readStoredEntries(await readFile(destination)).map(item => item.bytes), expected);
  }
  assert.deepEqual(await r.app.image(1, true), original);
  assert.equal((await r.app.snapshot()).job.manifest.exports.every(item => item.range_confirmed === false), true);
});

test('Ubuntu通常取得: 共通APIの通常budget基盤は送り応答不明を別位置でも復帰させない', { timeout: 45000 }, async t => {
  const { createNormalCaptureBudget } = await import('../app/expected-capture-budget.mjs');
  const r = await setup(t);
  await r.request('create');
  const open = Reader.open;
  Reader.open = async options => {
    const reader = await open.call(Reader, options);
    let budget = createNormalCaptureBudget();
    reader.ownedSessionGuard = { normal: true, get singleRunBudget() { return budget; },
      async preparePreview() { budget = createNormalCaptureBudget(); }, validateConfig() {}, validateTransition() {},
      async assertIdentity() {}, async observe() { return 'anonymous'; }, async dispose() {} };
    return reader;
  };
  try { await r.request('openBrowser', { mode: 'sample' }); }
  finally { Reader.open = open; }
  await r.request('preview', { config: sampleConfig });
  await r.request('approve', { confirmed: true, maxCaptures: 3 });
  const reader = r.app.reader, click = reader.page.mouse.click.bind(reader.page.mouse);
  let sends = 0;
  reader.page.mouse.click = async (...args) => { sends++; await click(...args); throw new Error('anonymous_response_loss'); };
  await r.request('start', { confirmed: true });
  const stopped = await waitFor(r.app, s => s.state === 'NeedsAttention' && !s.busy);
  assert.equal(stopped.job.manifest.images.length, 1);
  assert.equal(stopped.job.manifest.checkpoint.dispatch, 'unknown');
  assert.equal(sends, 1);
  const original = await r.app.image(1, true);
  await r.request('preview', { config: sampleConfig });
  const before = await r.app.snapshot();
  assert.equal(before.resumePlan.mode, 'blocked');
  assert.notEqual(before.resumePlan.currentPosition, before.resumePlan.lastPosition);
  await assert.rejects(r.app.command('approve', { confirmed: true, resumeConfirmed: true, maxCaptures: 2 }), { code: 'resume_position_required' });
  assert.deepEqual((await r.app.snapshot()).job.manifest, before.job.manifest);
  assert.deepEqual(await r.app.image(1, true), original);
  assert.equal(sends, 1);
});

test('MVP有限取得: 単回予算は撮影・送りの応答不明を消費し再実行しない', async () => {
  const { createExpectedCaptureBudget } = await import('../app/expected-capture-budget.mjs');
  for (const failure of ['preview', 'advance', 'capture']) {
    const budget = createExpectedCaptureBudget(); let calls = 0;
    const success = async () => { calls++; return 'ok'; };
    const lost = async () => { calls++; throw new Error('anonymous_response_loss'); };
    if (failure === 'preview') {
      await assert.rejects(budget.screenshot('preview', lost), /anonymous_response_loss/);
    } else {
      assert.equal(await budget.screenshot('preview', success), 'ok');
      budget.approve(2);
      budget.start(2);
      budget.commit();
      if (failure === 'advance') await assert.rejects(budget.advance(lost), /anonymous_response_loss/);
      else {
        await budget.advance(success);
        budget.confirmAdvance();
        await assert.rejects(budget.screenshot('capture', lost), /anonymous_response_loss/);
      }
    }
    const count = calls;
    await assert.rejects(budget.screenshot('preview', success), { code: 'expected_capture_budget_exhausted' });
    await assert.rejects(budget.screenshot('capture', success), { code: 'expected_capture_budget_exhausted' });
    await assert.rejects(budget.advance(success), { code: 'expected_capture_budget_exhausted' });
    assert.equal(calls, count);
    assert.equal(budget.snapshot().phase, 'failed');
    assert.ok(budget.snapshot().screenshots <= 2);
    assert.ok(budget.snapshot().sends <= 1);
  }
  const budget = createExpectedCaptureBudget();
  let release;
  const pending = budget.screenshot('preview', () => new Promise(resolve => { release = resolve; }));
  assert.equal(budget.snapshot().phase, 'previewing');
  await assert.rejects(budget.screenshot('preview', async () => 'second'), { code: 'expected_capture_budget_exhausted' });
  budget.fail();
  release('late');
  await assert.rejects(pending, { code: 'expected_capture_budget_exhausted' });
  assert.equal(budget.snapshot().phase, 'failed');
  assert.equal(budget.snapshot().screenshots, 1);
  const confirmation = createExpectedCaptureBudget();
  await confirmation.screenshot('preview', async () => 'first');
  confirmation.approve(2); confirmation.start(2); confirmation.commit();
  await confirmation.advance(async () => 'sent');
  await assert.rejects(confirmation.screenshot('capture', async () => 'too early'), { code: 'expected_capture_budget_exhausted' });
  confirmation.confirmAdvance();
  assert.equal(await confirmation.screenshot('capture', async () => 'second'), 'second');
  confirmation.commit(); confirmation.finish();
  assert.deepEqual(confirmation.snapshot(), { phase: 'finished', screenshots: 2, sends: 1, committed: 2, approved: 2 });
});

test('MVP有限取得: 匿名公開APIの単回予算はpreviewを原本に再利用し終端・異常で停止', { timeout: 90_000 }, async t => {
  const { bindExpectedIdentity } = await import('../app/expected-identity.mjs');
  const { createExpectedCaptureBudget } = await import('../app/expected-capture-budget.mjs');
  const { anonymousExpectedBook, anonymousExpectedRoute } = await import('../app/owned-sample-identity.mjs');
  for (const mode of ['normal', 'terminal', 'response-loss', 'before-commit-change', 'before-preview-error']) await t.test(mode, async t => {
    const r = await setup(t);
    await r.request('create');
    const open = Reader.open;
    Reader.open = async options => {
      const url = `${options.sampleUrl}?asin=${anonymousExpectedBook.asin}`;
      const reader = await open.call(Reader, { ...options, sampleUrl: url });
      const identity = await bindExpectedIdentity(reader, new URL(url).origin, anonymousExpectedBook, anonymousExpectedRoute, 'h1');
      reader.ownedSessionGuard = { ...identity, singleRunBudget: createExpectedCaptureBudget(), allowsIdentityRedraw: true,
        validateConfig() {}, validateTransition() {}, async observe() { await identity.assertIdentity(); return 'anonymous-paint'; } };
      return reader;
    };
    try { await r.request('openBrowser', { mode: 'sample' }); }
    finally { Reader.open = open; }
    const reader = r.app.reader, budget = reader.ownedSessionGuard.singleRunBudget;
    let screenshots = 0, sends = 0, aborts = 0;
    const send = reader.scaleSession.send.bind(reader.scaleSession);
    reader.scaleSession.send = (method, ...args) => { if (method === 'Page.captureScreenshot') screenshots++; return send(method, ...args); };
    const click = reader.page.mouse.click.bind(reader.page.mouse);
    reader.page.mouse.click = async (...args) => {
      sends++;
      const result = await click(...args);
      if (mode === 'response-loss') throw new Error('anonymous_response_loss');
      return result;
    };
    if (mode === 'before-preview-error') {
      await assert.rejects(r.app.command('preview', { config: {} }), { code: 'reader_configuration_required' });
      assert.equal(budget.snapshot().phase, 'failed');
      await assert.rejects(r.app.command('preview', { config: sampleConfig }), { code: 'expected_capture_budget_exhausted' });
      assert.equal(screenshots, 0); assert.equal(sends, 0);
      return;
    }
    if (mode === 'terminal') await reader.page.locator('#next').evaluate(node => { node.disabled = true; });
    await r.request('preview', { config: sampleConfig });
    const previewHash = createHash('sha256').update(r.app.previewImage).digest('hex');
    assert.equal(screenshots, 1);
    await assert.rejects(r.app.command('start', { confirmed: true }), { code: 'explicit_start_required' });
    await assert.rejects(r.app.command('approve', { confirmed: true }), { code: 'invalid_capture_limit' });
    await assert.rejects(r.app.command('approve', { confirmed: true, maxCaptures: 3 }), { code: 'expected_capture_budget_exhausted' });
    // Same contents are not a new book, even when the title element redraws.
    if (mode === 'normal') await reader.page.locator('h1').evaluate(node => node.replaceWith(node.cloneNode(true)));
    await r.request('approve', { confirmed: true, maxCaptures: 2 });
    await assert.rejects(r.app.command('start', { confirmed: true, maxCaptures: 1 }), { code: 'capture_limit_changed' });
    if (mode === 'before-commit-change') {
      let injected = false;
      const call = r.app.store.call.bind(r.app.store);
      r.app.store.call = async (kind, input, ...args) => {
        const result = await call(kind, input, ...args);
        if (kind === 'capture_abort') aborts++;
        if (kind === 'capture_chunk' && !injected) {
          injected = true;
          await reader.page.evaluate(() => {
            const title = document.querySelector('h1'), old = title.textContent;
            title.textContent = '別の匿名本'; title.textContent = old;
          });
        }
        return result;
      };
    }
    await r.request('start', { confirmed: true });
    await waitFor(r.app, s => !s.busy && ['Review', 'NeedsAttention'].includes(s.state));
    await r.app.loop;
    const result = await r.app.snapshot();
    const images = result.job.manifest.images;
    const expectedImages = mode === 'normal' ? 2 : mode === 'before-commit-change' ? 0 : 1;
    assert.equal(images.length, expectedImages);
    assert.equal(screenshots, mode === 'normal' ? 2 : 1);
    assert.equal(sends, ['normal', 'response-loss'].includes(mode) ? 1 : 0);
    assert.deepEqual(result.job.manifest.exports, []);
    if (expectedImages) assert.equal(createHash('sha256').update(await r.app.image(1, true)).digest('hex'), previewHash);
    for (const item of images) {
      const bytes = await r.app.image(item.capture_id, true);
      const decoded = PNG.sync.read(bytes);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), item.sha256);
      assert.deepEqual([decoded.width, decoded.height], [item.width, item.height]);
    }
    if (images.length === 2) assert.notEqual(images[0].sha256, images[1].sha256);
    if (mode === 'normal' || mode === 'terminal') {
      assert.equal(result.state, 'Review');
      assert.equal(result.reason, mode === 'normal' ? 'capture_limit_reached' : 'end_candidate');
      assert.equal(result.job.manifest.checkpoint.dispatch, 'not_sent');
      assert.equal(budget.snapshot().phase, 'finished');
      if (mode === 'terminal') assert.match(result.operationProgress.detail, /終端候補/);
    } else {
      assert.equal(result.state, 'NeedsAttention');
      assert.equal(budget.snapshot().phase, 'failed');
      if (mode === 'response-loss') assert.equal(result.job.manifest.checkpoint.dispatch, 'unknown');
      else { assert.equal(result.lastFailure.stage, 'target_recheck_before_commit'); assert.equal(aborts, 1); }
    }
    assert.equal(budget.snapshot().screenshots, screenshots);
    assert.equal(budget.snapshot().sends, sends);
    await assert.rejects(r.app.command('start', { confirmed: true }), { code: 'explicit_start_required' });
  });
});

test('MVP有限取得: 単回予算では既存ジョブを再開せず原本と状態を保持', async t => {
  const { createExpectedCaptureBudget } = await import('../app/expected-capture-budget.mjs');
  const r = await setup(t);
  await r.request('create'); await r.request('openBrowser', { mode: 'sample' });
  await r.request('preview', { config: sampleConfig });
  await r.request('approve', { confirmed: true, maxCaptures: 1 });
  await r.request('start', { confirmed: true });
  await waitFor(r.app, state => state.state === 'Review' && !state.busy);
  const original = await r.app.image(1, true), prior = (await r.app.snapshot()).job.manifest;
  const budget = createExpectedCaptureBudget();
  r.app.reader.ownedSessionGuard = { singleRunBudget: budget, validateConfig() {}, validateTransition() {},
    async assertIdentity() {}, async observe() { return 'anonymous-paint'; }, async dispose() {} };
  await r.request('preview', { config: sampleConfig });
  await assert.rejects(r.app.command('approve', { confirmed: true, resumeConfirmed: true, maxCaptures: 2 }),
    { code: 'expected_capture_new_job_required' });
  assert.equal(budget.snapshot().phase, 'failed');
  assert.deepEqual((await r.app.snapshot()).job.manifest, prior);
  assert.deepEqual(await r.app.image(1, true), original);
});

test('MVP有限取得: 期待本sessionの一時変更は原本確定前にabortし送りを止める', async t => {
  const { bindExpectedIdentity } = await import('../app/expected-identity.mjs');
  const { anonymousExpectedBook, anonymousExpectedRoute } = await import('../app/owned-sample-identity.mjs');
  const r = await setup(t);
  await r.request('create');
  // Anonymous headless control fixture only: the actual public Snap path is
  // independently tested in the owned-session suite. No capability is minted.
  const open = Reader.open;
  Reader.open = async options => {
    const url = `${options.sampleUrl}?asin=${anonymousExpectedBook.asin}`;
    const reader = await open.call(Reader, { ...options, sampleUrl: url });
    const identity = await bindExpectedIdentity(reader, new URL(url).origin, anonymousExpectedBook, anonymousExpectedRoute, 'h1');
    reader.ownedSessionGuard = { ...identity, allowsIdentityRedraw: true, validateConfig() {}, validateTransition() {},
      async observe() { await identity.assertIdentity(); return 'anonymous-paint'; } };
    return reader;
  };
  try { await r.request('openBrowser', { mode: 'sample' }); }
  finally { Reader.open = open; }
  await r.request('preview', { config: sampleConfig });
  await r.request('approve', { confirmed: true, maxCaptures: 1 });
  let injected = false, commits = 0, aborts = 0, sends = 0;
  const reader = r.app.reader, advance = reader.advance.bind(reader);
  reader.advance = (...args) => { sends++; return advance(...args); };
  const call = r.app.store.call.bind(r.app.store);
  r.app.store.call = async (kind, input, ...args) => {
    const result = await call(kind, input, ...args);
    if (kind === 'capture_commit') commits++;
    if (kind === 'capture_abort') aborts++;
    if (kind === 'capture_chunk' && !injected) {
      injected = true;
      await reader.page.evaluate(() => {
        const title = document.querySelector('h1'), old = title.textContent;
        title.textContent = '別の匿名本'; title.textContent = old;
      });
    }
    return result;
  };
  await r.request('start', { confirmed: true });
  await waitFor(r.app, s => s.state === 'NeedsAttention' && !s.busy);
  await r.app.loop;
  const result = await r.app.snapshot();
  assert.equal(injected, true); assert.equal(result.reason, 'target_changed');
  assert.equal(result.lastFailure.stage, 'target_recheck_before_commit');
  assert.equal(result.job.manifest.images.length, 0); assert.equal(commits, 0);
  assert.equal(aborts, 1); assert.equal(sends, 0); assert.equal(result.previewApproved, false);
});

test('MVP有限取得: 承認上限を省略で外せず、不正値・拡大・解除を副作用前に拒否する', async t => {
  const r = await setup(t);
  await r.request('create'); await r.request('openBrowser', { mode: 'sample' });
  await r.request('preview', { config: sampleConfig });
  let captures = 0, advances = 0;
  const capture = r.app.reader.capture.bind(r.app.reader), advance = r.app.reader.advance.bind(r.app.reader);
  r.app.reader.capture = (...args) => { captures++; return capture(...args); };
  r.app.reader.advance = (...args) => { advances++; return advance(...args); };
  const invalid = [0, -1, 1.5, '2', false, {}, Number.MAX_SAFE_INTEGER + 1];
  for (const maxCaptures of invalid) {
    await assert.rejects(r.app.command('approve', { confirmed: true, maxCaptures }), { code: 'invalid_capture_limit' });
  }
  await r.request('approve', { confirmed: true, maxCaptures: 2 });
  for (const maxCaptures of invalid) {
    await assert.rejects(r.app.command('start', { confirmed: true, maxCaptures }), { code: 'invalid_capture_limit' });
  }
  for (const maxCaptures of [1, 3, null]) {
    await assert.rejects(r.app.command('start', { confirmed: true, maxCaptures }), { code: 'capture_limit_changed' });
  }
  const ready = await r.app.snapshot();
  assert.equal(ready.state, 'Ready'); assert.equal(ready.approvedMaxCaptures, 2);
  assert.equal(ready.job.manifest.state, 'ready'); assert.equal(ready.job.manifest.images.length, 0);
  assert.equal(captures, 0); assert.equal(advances, 0);
  await r.request('start', { confirmed: true }); // omission inherits the approved two-display cap
  await waitFor(r.app, s => s.state === 'Review' && !s.busy);
  const ended = await r.app.snapshot();
  assert.equal(ended.reason, 'capture_limit_reached');
  assert.equal(ended.job.manifest.state, 'review');
  assert.equal(ended.job.manifest.images.length, 2);
  assert.equal(captures, 2); assert.equal(advances, 1);
  assert.equal(await r.app.reader.page.locator('#position').innerText(), '2 / 12');
  assert.equal(ended.job.manifest.checkpoint.dispatch, 'not_sent');
  assert.equal(ended.previewApproved, false); assert.equal(ended.previewReady, false);
  assert.equal(ended.job.manifest.range_confirmed, false); assert.deepEqual(ended.job.manifest.exports, []);
  assert.equal(ended.operationProgress.status, 'success');
  assert.match(ended.operationProgress.detail, /全冊完了ではありません/);
});

test('MVP有限取得: 分割は加算せず、再照合送りと既存原本を新規上限に数えない', async t => {
  const r = await setup(t);
  await r.request('create'); await r.request('openBrowser', { mode: 'sample' });
  await r.request('selectReaderTab', { id: (await r.app.snapshot()).readerTabs[0].id });
  await r.request('setCaptureSettings', { capture_scale: 1, page_output_mode: 'split_spread', reading_direction: 'right_to_left', image_format: 'png', jpeg_quality: 85 });
  let advances = 0;
  const advance = r.app.reader.advance.bind(r.app.reader);
  r.app.reader.advance = (...args) => { advances++; return advance(...args); };
  await r.request('preview', { config: sampleConfig });
  await r.request('approve', { confirmed: true, maxCaptures: 1 });
  await r.request('start', { confirmed: true, maxCaptures: 1 });
  await waitFor(r.app, s => s.state === 'Review' && !s.busy);
  const first = await r.app.snapshot(), original = await r.app.image(1, true);
  assert.equal(first.job.manifest.images.length, 1); assert.equal(advances, 0);
  assert.ok(first.job.manifest.images[0].split?.left); assert.ok(first.job.manifest.images[0].split?.right);
  await assert.rejects(r.app.command('start', { confirmed: true }), { code: 'explicit_start_required' });
  await r.request('preview', { config: sampleConfig });
  assert.equal((await r.app.snapshot()).resumePlan.mode, 'advance');
  await assert.rejects(r.app.command('approve', { confirmed: true, maxCaptures: 1 }), { code: 'resume_confirmation_required' });
  await r.request('approve', { confirmed: true, resumeConfirmed: true, maxCaptures: 1 });
  await r.request('start', { confirmed: true });
  await waitFor(r.app, s => s.state === 'Review' && !s.busy);
  const resumed = await r.app.snapshot();
  assert.equal(resumed.reason, 'capture_limit_reached');
  assert.equal(resumed.job.manifest.images.length, 2); assert.equal(advances, 1);
  assert.equal(resumed.job.manifest.images.some(image => image.duplicate_candidate), false);
  assert.equal(resumed.job.manifest.checkpoint.capture_id, 2);
  assert.equal(resumed.job.manifest.checkpoint.dispatch, 'not_sent');
  assert.deepEqual(await r.app.image(1, true), original);
  assert.equal(resumed.job.manifest.range_confirmed, false); assert.deepEqual(resumed.job.manifest.exports, []);
});

test('MVP有限取得: 合成白紙の実Rust判定と停止保存失敗を上限到達より優先する', async t => {
  for (const mode of ['blank', 'stop-failed', 'review-failed']) await t.test(mode, async t => {
    const r = await setup(t);
    await r.request('create'); await r.request('openBrowser', { mode: 'sample' });
    await r.request('preview', { config: sampleConfig });
    await r.request('approve', { confirmed: true, maxCaptures: 1 });
    if (mode === 'blank') {
      // Test the real commit classification/stop priority, not browser white
      // rendering. The former #blank screenshot included a fractional-clip
      // border row; the separate Linux匿名白紙 test exercises real rendering.
      // Replace pixels only, never the Rust classification result.
      const [width, height] = r.app.reader.bound.dimensions;
      const white = new PNG({ width, height }); white.data.fill(255);
      const bytes = PNG.sync.write(white);
      r.app.reader.capture = async () => bytes;
    }
    let advances = 0;
    r.app.reader.advance = async () => { advances++; throw new Error('unexpected_advance'); };
    const call = r.app.store.call.bind(r.app.store);
    r.app.store.call = (kind, ...args) => {
      if (mode === 'stop-failed' && kind === 'capture_stop' || mode === 'review-failed' && kind === 'set_review_order') {
        const error = new AppError('storage_durability_uncertain');
        // StoreClient notifies observers before rejecting. This invalidates
        // approval and freezes storage, but is a failure, not user cancellation.
        for (const listener of r.app.store.errorListeners) listener(error);
        return Promise.reject(error);
      }
      return call(kind, ...args);
    };
    await r.request('start', { confirmed: true });
    await waitFor(r.app, s => s.state === 'NeedsAttention' && !s.busy);
    r.app.store.call = call;
    const stopped = await r.app.snapshot();
    assert.equal(stopped.reason, mode === 'blank' ? 'image_review_required' : 'storage_durability_uncertain');
    assert.equal(stopped.job.manifest.images.length, 1); assert.equal(advances, 0);
    if (mode === 'blank') assert.equal(stopped.job.manifest.images[0].blank_candidate, true);
    assert.equal(stopped.job.manifest.checkpoint.dispatch, 'not_sent');
    assert.equal(stopped.operationProgress.status, 'failure');
    assert.equal(stopped.lastFailure.stage, mode === 'blank' ? 'image_review' : 'capture_limit_stop');
    if (mode !== 'blank') {
      assert.equal(stopped.lastFailure.code, 'storage_durability_uncertain');
      assert.equal(stopped.lastFailure.committedImages, 1);
      assert.equal(stopped.storageUncertain.code, 'storage_durability_uncertain');
      assert.equal(stopped.previewApproved, false); assert.equal(stopped.previewReady, false);
      const original = await r.app.image(1, true);
      for (const action of ['approve', 'start', 'review', 'export']) {
        await assert.rejects(r.app.command(action, { confirmed: true, maxCaptures: 1 }), { code: 'storage_reopen_required' });
      }
      assert.deepEqual(await r.app.image(1, true), original);
      assert.equal((await r.app.snapshot()).job.manifest.images.length, 1);
      assert.equal(advances, 0);
    }
  });
});

test('MVP有限取得: 公開UIの上限変更は再承認を要求し、別開始後1画面で送りなし停止', async t => {
  const r = await setup(t);
  const control = await openControlWindow(r.url, { headless: true }); t.after(() => control.close());
  const ui = control.page;
  await openSampleThroughPublicUi(ui);
  await ui.locator('#quickPreview').click(); await waitForPublicPreview(ui);
  await ui.locator('#maxCaptures').fill('2');
  await ui.locator('#previewConfirmed').check(); await ui.locator('#decisionButton').click();
  await ui.waitForFunction(() => document.querySelector('#decisionButton').dataset.action === 'start' && !document.querySelector('#decisionButton').disabled);
  assert.equal((await r.app.snapshot()).approvedMaxCaptures, 2);
  await ui.locator('#maxCaptures').fill('1');
  assert.equal(await ui.locator('#previewConfirmed').isChecked(), false);
  assert.equal(await ui.locator('#start').isDisabled(), true);
  assert.equal(await ui.locator('#decisionButton').getAttribute('data-action'), 'approve');
  await ui.locator('#previewConfirmed').check(); await ui.locator('#decisionButton').click();
  await ui.waitForFunction(() => document.querySelector('#decisionButton').dataset.action === 'start' && !document.querySelector('#decisionButton').disabled);
  assert.equal((await r.app.snapshot()).approvedMaxCaptures, 1);
  assert.equal((await r.app.snapshot()).job.manifest.images.length, 0);
  for (const [language, label] of [['en', 'Maximum new captures'], ['zh-CN', '本次最多获取画面数']]) {
    await ui.locator('#language').selectOption(language);
    assert.match(await ui.locator('label:has(#maxCaptures)').textContent(), new RegExp(label));
    assert.equal(await ui.locator('#maxCaptures').inputValue(), '1');
    assert.equal((await r.app.snapshot()).approvedMaxCaptures, 1);
  }
  await ui.locator('#language').selectOption('ja');
  await ui.locator('#approval').screenshot({ path: path.join(root, 'capture-limit-approval.png') });
  let advances = 0;
  r.app.reader.advance = async () => { advances++; throw new Error('unexpected_advance'); };
  await ui.locator('#decisionButton').click();
  await waitFor(r.app, s => s.state === 'Review' && !s.busy);
  await ui.waitForFunction(() => document.querySelector('#reason').textContent.includes('最大取得画面数'));
  assert.match(await ui.locator('#reason').textContent(), /全冊完了ではありません/);
  assert.equal((await r.app.snapshot()).job.manifest.images.length, 1); assert.equal(advances, 0);
  assert.equal((await r.app.snapshot()).kindleSupported, process.platform !== 'linux');
});

test('MVP取得: 12画面後は終端候補で停止し全範囲成功と混同しない', async t => {
  const r = await setup(t);
  await r.request('create');
  await r.request('openBrowser', { mode: 'sample' });
  await r.request('preview', { config: sampleConfig });
  await r.request('approve', { confirmed: true });
  await r.request('start', { confirmed: true });
  // This covers all 12 real captures/commits/guarded turns, not one UI action.
  const ended = await waitFor(r.app, s => s.state === 'NeedsAttention', 60_000);
  assert.equal(ended.reason, 'end_candidate');
  assert.equal(ended.job.manifest.images.length, 12);
  assert.equal(ended.job.manifest.range_confirmed, false);
  assert.equal(ended.job.manifest.exports.length, 0);
});

test('MVP安全停止: 認証・別本・オーバーレイ・黒画像・無変化送りで未完了停止', async t => {
  const r = await setup(t);
  for (const button of ['#logout', '#other-book', '#overlay', '#black', '#stall']) {
    await t.test(button, async () => {
      await r.request('create');
      await r.request('openBrowser', { mode: 'sample' });
      await r.request('preview', { config: sampleConfig });
      await r.request('approve', { confirmed: true });
      await r.app.reader.page.locator(button).click();
      if (button === '#stall') {
        await r.request('start', { confirmed: true });
        const ended = await waitFor(r.app, s => s.state === 'NeedsAttention');
        assert.equal(ended.reason, 'advance_uncertain');
        assert.equal(ended.job.manifest.images.length, 1);
      } else if (button === '#black') {
        await r.request('start', { confirmed: true });
        const ended = await waitFor(r.app, s => s.state === 'NeedsAttention');
        await r.app.loop;
        assert.equal(ended.job.manifest.images.length, 0);
        assert.equal(ended.reason, 'black_image');
      } else {
        await assert.rejects(r.app.command('start', { confirmed: true }));
        assert.equal((await r.app.snapshot()).job.manifest.images.length, 0);
      }
      assert.equal((await r.app.snapshot()).job.manifest.range_confirmed, false);
      // NeedsAttention is published before the acquisition finally block has
      // finished its Rust requests. Settle it before starting fixture cleanup.
      await r.app.loop;
      await r.request('closeBrowser');
      await r.request('closeJob');
    });
  }
  await t.test('確定画像のある再開でも黒画像停止を未取得と誤案内しない', async () => {
    await r.request('create'); await r.request('openBrowser', { mode: 'sample' });
    await r.app.reader.page.locator('#stall').click();
    await r.request('preview', { config: sampleConfig }); await r.request('approve', { confirmed: true });
    await r.request('start', { confirmed: true }); await waitFor(r.app, s => s.job.manifest.images.length === 1);
    await r.request('pause');
    const original = await r.app.image(1, true);
    await r.request('preview', { config: sampleConfig });
    await r.request('approve', { confirmed: true, resumeConfirmed: true });
    await r.app.reader.page.locator('#black').click();
    const control = await openControlWindow(r.url, { headless: true });
    try {
      await r.request('start', { confirmed: true });
      const stopped = await waitFor(r.app, s => s.state === 'NeedsAttention' && !s.busy);
      assert.equal(stopped.reason, 'black_image'); assert.equal(stopped.job.manifest.images.length, 1);
      assert.deepEqual(await r.app.image(1, true), original, '黒い次画像を拒否しても以前の確定画像を保つ');
      await control.page.waitForFunction(() => document.querySelector('#state').textContent === '安全停止・確認が必要');
      assert.doesNotMatch(await control.page.locator('#reason').textContent(), /始めていません|プレビューを停止/);
      assert.match(await control.page.locator('#message').textContent(), /黒.*保存.*専用ブラウザ.*ページ画像.*確認/);
      assert.match(await control.page.locator('#nextAction').textContent(), /専用ブラウザ.*ページ画像.*確認/);
    } finally { await control.close(); }
    await r.request('closeBrowser'); await r.request('closeJob');
  });
});

test('ローカルUI境界: 認証・Origin・Host拒否、データ排他とリンク削除拒否', async t => {
  const r = await setup(t);
  assert.equal((await fetch(`${r.origin}/api/state`)).status, 403);
  assert.equal((await fetch(`${r.origin}/api/state`, { headers: { Authorization: `Bearer ${r.token}`, Origin: 'https://example.com' } })).status, 403);
  // Undici rewrites Host; use native HTTP to exercise the actual wire header.
  const wrongHost = await new Promise((resolve, reject) => {
    const req = http.get(`${r.origin}/api/state`, { headers: { Authorization: `Bearer ${r.token}`, Host: 'attacker.invalid' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
  });
  assert.equal(wrongHost, 403);
  const other = new StoreClient();
  try { await assert.rejects(other.call('lock_data_directory', { path: r.app.dataDir }), /job_busy/); }
  finally { await other.close(); }
  const target = path.join(r.directory, 'unrelated');
  await mkdir(target);
  const id = 'saved-00000000-0000-0000-0000-000000000000';
  const link = path.join(r.app.dataDir, id);
  await symlink(target, link, 'junction');
  await assert.rejects(r.app.command('deleteSession', { id, confirmed: true }), /unsafe_directory/);
  await rm(link);
  assert.equal((await lstat(target)).isDirectory(), true, '削除拒否でリンク先を保護する');
  const unrelated = path.join(r.directory, 'unrelated-setting.json');
  const bytes = '{"version":1,"session":"saved-00000000-0000-0000-0000-000000000000"}';
  await writeFile(unrelated, bytes);
  await hardlink(unrelated, path.join(r.app.dataDir, 'kindle-session.json'));
  await assert.rejects(readSessionPreference(r.app.dataDir), /unsafe_session_preferences/);
  await assert.rejects(saveSessionPreference(r.app.dataDir, id), /unsafe_session_preferences/);
  assert.equal(await readFile(unrelated, 'utf8'), bytes, '選択記録がhardlinkでも外部ファイルを変更しない');
});

test('専用セッション: 明示保存・再利用・明示削除と一時領域を分離', async t => {
  const r = await setup(t);
  await r.request('create');
  await r.request('openBrowser', { mode: 'sample', keep: true });
  const first = (await r.app.snapshot()).sessions;
  assert.equal(first.length, 1);
  assert.equal(first[0].saved, true);
  await assert.rejects(r.app.command('deleteSession', { id: first[0].id, confirmed: true }), /close_browser_first/);
  await r.request('closeBrowser');
  assert.deepEqual((await r.app.snapshot()).sessions, first);
  await r.request('openBrowser', { mode: 'sample', session: first[0].id });
  assert.deepEqual((await r.app.snapshot()).sessions, first);
  await r.request('closeBrowser');
  await assert.rejects(r.app.command('deleteSession', { id: first[0].id, confirmed: false }), /session_delete_confirmation_required/);
  await r.request('deleteSession', { id: first[0].id, confirmed: true });
  assert.deepEqual((await r.app.snapshot()).sessions, []);
  await r.request('openBrowser', { mode: 'sample' });
  const temporary = (await r.app.snapshot()).sessions[0];
  assert.equal(temporary.saved, false);
  // Model a browser/process interruption without inspecting or copying cookies.
  // The orphaned profile is selected explicitly on the public reopen operation.
  await r.app.reader.close(); r.app.reader = null;
  await r.app.fixture.close(); r.app.fixture = null;
  r.app.profile = null;
  await r.request('openBrowser', { mode: 'sample', session: temporary.id });
  assert.deepEqual((await r.app.snapshot()).sessions, [temporary]);
  await r.request('closeBrowser');
  assert.deepEqual((await r.app.snapshot()).sessions, []);
});

test(process.platform === 'linux' ? '専用セッション既定: Linuxでは公開Kindle入口を拒否する' : '専用セッション既定: 公開Kindle入口と通常再起動で同じ領域を再利用し、一時利用は分離する', async t => {
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, 'session-restart-'));
  const r = await startApplication({ dataDir: path.join(directory, 'data') });
  const fixture = await startFixture();
  let restarted, control;
  // Exercise the real public Kindle command/session policy with self-authored
  // content only. This is not evidence of a live Amazon authenticated session.
  const open = Reader.open;
  Reader.open = options => open.call(Reader, { ...options, sampleUrl: fixture.url, headless: true, readGuard: null });
  t.after(async () => {
    await control?.close(); await restarted?.close(); await r.close();
    Reader.open = open;
    await fixture.close(); await rm(directory, { recursive: true, force: true });
  });
  control = await openControlWindow(r.url, { headless: true });
  const ui = control.page;
  await ui.locator('#create').click();
  // click/既定チェック/恒常的なLinux無効表示はcreate応答の完了条件ではない。
  await waitFor(r.app, snapshot => snapshot.job && !snapshot.busy);
  await ui.locator('[data-stage="browser"] > details > summary').click();
  assert.equal(await ui.locator('#keep').isChecked(), true);
  if (process.platform === 'linux') {
    assert.equal(await ui.locator('#openKindle').isDisabled(), true);
    await assert.rejects(r.app.command('openBrowser', { mode: 'kindle' }), { code: 'select_saved_session' });
    assert.deepEqual((await r.app.snapshot()).sessions, []);
    assert.equal(r.app.reader, undefined);
    return;
  }
  await ui.locator('#openKindle').click();
  await waitFor(r.app, s => s.browserOpen && !s.busy);
  const first = r.app.profile;
  assert.match(path.basename(first), /^saved-/);
  await r.app.reader.context.addCookies([{ name: 'local-session-fixture', value: 'retained', url: fixture.url, expires: Math.floor(Date.now() / 1000) + 3600 }]);
  await selectVisibleReaderTab(ui);
  await ui.locator('#quickPreview').click(); await ui.locator('#previewImage').waitFor({ state: 'visible' });
  assert.equal(await ui.locator('#start').isDisabled(), true);
  await ui.locator('[data-stage-target="browser"]').click();
  await ui.locator('#closeBrowser').click();
  await waitFor(r.app, s => !s.browserOpen && !s.busy);
  await ui.locator('#session').selectOption(path.basename(first));
  await ui.locator('#openKindle').click();
  await waitFor(r.app, s => s.browserOpen && !s.busy);
  assert.equal(r.app.profile, first, '明示した既存保存領域は再利用できる');
  await ui.locator('[data-stage-target="browser"]').click();
  await ui.locator('#closeBrowser').click();
  await waitFor(r.app, s => !s.browserOpen && !s.busy);
  await ui.locator('#keep').uncheck();
  await ui.locator('#openKindle').click();
  await waitFor(r.app, s => s.browserOpen && !s.busy);
  const uiTemporary = r.app.profile;
  assert.notEqual(uiTemporary, first, '保存OFFは残存する既存選択に関係なく新しい一時領域を使う');
  assert.match(path.basename(uiTemporary), /^temporary-/);
  assert.equal((await r.app.reader.context.cookies(fixture.url)).some(cookie => cookie.name === 'local-session-fixture'), false);
  await ui.locator('[data-stage-target="browser"]').click();
  assert.equal(await ui.locator('#session').isDisabled(), true);
  await ui.locator('#closeBrowser').click();
  await waitFor(r.app, s => !s.browserOpen && !s.busy);
  await assert.rejects(lstat(uiTemporary), { code: 'ENOENT' });
  assert.equal((await r.app.snapshot()).preferredKindleSession, path.basename(first));
  await ui.locator('#keep').check();
  assert.equal(await ui.locator('#session').isEnabled(), true);
  await r.close();
  assert.equal((await lstat(first)).isDirectory(), true, '通常終了で専用領域を消さない');
  restarted = await startApplication({ dataDir: r.app.dataDir });
  await restarted.app.command('create');
  await restarted.app.command('openBrowser', { mode: 'kindle' });
  assert.equal(restarted.app.profile, first, '新しいjob/アプリでも前回のprofileを使う');
  assert.equal((await restarted.app.reader.context.cookies(fixture.url)).find(cookie => cookie.name === 'local-session-fixture')?.value, 'retained');
  await restarted.app.command('closeBrowser');
  await restarted.app.command('openBrowser', { mode: 'kindle', keep: false });
  const temporary = restarted.app.profile;
  assert.notEqual(temporary, first);
  assert.match(path.basename(temporary), /^temporary-/);
  assert.equal((await restarted.app.reader.context.cookies(fixture.url)).some(cookie => cookie.name === 'local-session-fixture'), false);
  await restarted.app.command('closeBrowser');
  await assert.rejects(lstat(temporary), { code: 'ENOENT' });
  await restarted.app.command('openBrowser', { mode: 'kindle' });
  assert.equal(restarted.app.profile, first, '一時利用で前回保存先を置換しない');
  await restarted.app.command('closeBrowser');
  await restarted.app.command('openBrowser', { mode: 'kindle', session: 'new' });
  assert.notEqual(restarted.app.profile, first, '新規作成は明示選択できる');
  assert.equal((await lstat(first)).isDirectory(), true);
  assert.equal((await restarted.app.snapshot()).job.manifest.images.length, 0);
  await restarted.app.command('closeBrowser');
  await rm(path.join(r.app.dataDir, 'kindle-session.json'));
  restarted.app.preferredKindleSession = null;
  await assert.rejects(restarted.app.command('openBrowser', { mode: 'kindle' }), /select_saved_session/, '旧保存領域が複数なら勝手に選ばない');
  await restarted.app.command('openBrowser', { mode: 'kindle', session: path.basename(first) });
  assert.equal(restarted.app.profile, first);
});

test(process.platform === 'linux' ? '専用セッション保存寿命: 旧temporaryの保存指定を自作試料で保持する' : '専用セッション保存寿命: 旧temporaryの保存指定を領域切替・再起動後も保持する', async t => {
  const r = await setup(t);
  await r.request('create');
  await r.request('openBrowser', { mode: 'sample' });
  const retained = path.basename(r.app.profile);
  await r.app.reader.close(); r.app.reader = null;
  await r.app.fixture.close(); r.app.fixture = null;
  r.app.profile = null;
  await r.close();
  // The pre-correction v1 pointer already meant that this old temporary path
  // was explicitly retained. Migration must not copy or rename its contents.
  await writeFile(path.join(r.app.dataDir, 'kindle-session.json'), JSON.stringify({ version: 1, session: retained }));
  const fixture = await startFixture();
  const open = Reader.open;
  let restarted, again;
  Reader.open = options => open.call(Reader, { ...options, sampleUrl: fixture.url, headless: true, readGuard: null });
  t.after(async () => {
    await again?.close(); await restarted?.close();
    Reader.open = open;
    await fixture.close();
  });
  restarted = await startApplication({ dataDir: r.app.dataDir });
  await restarted.app.command('create');
  if (process.platform === 'linux') {
    assert.equal((await restarted.app.snapshot()).preferredKindleSession, retained);
    await assert.rejects(restarted.app.command('openBrowser', { mode: 'kindle' }), { code: 'select_saved_session' });
    await restarted.app.command('openBrowser', { mode: 'sample', session: retained });
    assert.equal(path.basename(restarted.app.profile), retained);
    await restarted.app.command('closeBrowser');
    assert.equal((await lstat(path.join(r.app.dataDir, retained))).isDirectory(), true);
    return;
  }
  await restarted.app.command('openBrowser', { mode: 'kindle' });
  assert.equal(path.basename(restarted.app.profile), retained, 'version:1の旧保存指定を同じパスで再利用する');
  await restarted.app.reader.context.addCookies([{ name: 'retained-temporary-fixture', value: 'retained', url: fixture.url, expires: Math.floor(Date.now() / 1000) + 3600 }]);
  await restarted.app.command('closeBrowser');
  await restarted.app.command('openBrowser', { mode: 'kindle', session: 'new' });
  const second = path.basename(restarted.app.profile);
  await restarted.app.command('closeBrowser');
  assert.equal((await restarted.app.snapshot()).sessions.find(item => item.id === retained)?.saved, true, '別領域を選んでも以前の保存指定を忘れない');
  await restarted.close();
  again = await startApplication({ dataDir: r.app.dataDir });
  await again.app.command('create');
  assert.equal((await again.app.snapshot()).sessions.find(item => item.id === retained)?.saved, true, '保存指定は前回選択とは別に永続化する');
  await again.app.command('openBrowser', { mode: 'sample', session: retained });
  assert.equal((await again.app.reader.context.cookies(fixture.url)).find(cookie => cookie.name === 'retained-temporary-fixture')?.value, 'retained');
  await again.app.command('closeBrowser');
  assert.equal((await lstat(path.join(r.app.dataDir, retained))).isDirectory(), true, '既存savedと同様に再利用時のkeep省略で削除しない');
  await again.app.command('deleteSession', { id: second, confirmed: true });
  assert.equal((await again.app.snapshot()).preferredKindleSession, null);
  assert.equal((await again.app.snapshot()).sessions.find(item => item.id === retained)?.saved, true, '前回選択の削除で別の保存指定を消さない');
  await again.app.command('openBrowser', { mode: 'kindle' });
  assert.equal(path.basename(again.app.profile), retained, '残る保存領域を再利用できる');
  await again.app.command('closeBrowser');
  await again.app.command('deleteSession', { id: retained, confirmed: true });
  assert.deepEqual((await again.app.snapshot()).sessions, []);
});

test('MVPプレビュー復帰: 遅延pollで完成画像を消さず、撮影の無応答・失敗後も再試行できる', async t => {
  const r = await setup(t);
  const control = await openControlWindow(r.url, { headless: true }); t.after(() => control.close());
  const ui = control.page;
  await ui.locator('#create').click(); await ui.locator('#openSample').click();
  await selectVisibleReaderTab(ui);
  let release, entered;
  const holding = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  await ui.route('**/api/state', async route => {
    const response = await route.fetch();
    entered(); await gate;
    await route.fulfill({ response });
  });
  await holding;
  await ui.locator('#quickPreview').click();
  await ui.locator('#previewImage').waitFor({ state: 'visible' });
  release(); await ui.unrouteAll({ behavior: 'wait' });
  await sleep(1200);
  assert.equal(await ui.locator('#previewImage').isVisible(), true, '古いpreviewReady=falseの応答で完成画像を消さない');
  const session = r.app.reader.scaleSession;
  const send = session.send.bind(session);
  for (const failure of ['unresponsive', 'rejected']) {
    session.send = (method, ...args) => method === 'Page.captureScreenshot'
      ? failure === 'unresponsive' ? new Promise(() => {}) : Promise.reject(new Error('local CDP failure'))
      : send(method, ...args);
    await ui.locator('#quickPreview').click();
    await ui.waitForFunction(() => document.querySelector('#message').textContent.includes('表示領域を画像にできませんでした')
      && !document.querySelector('#quickPreview').disabled, null, { timeout: 10_000 });
    assert.equal(await ui.locator('#previewImage').isVisible(), false);
    assert.equal(await ui.locator('#start').isDisabled(), true);
    assert.equal((await r.app.snapshot()).displayInspection.status, 'failed');
    assert.match(await ui.locator('#state').textContent(), /プレビュー検査失敗/);
    assert.match(await ui.locator('#nextAction').textContent(), /もう一度プレビュー/);
  }
  session.send = send;
  await ui.locator('#quickPreview').click(); await ui.locator('#previewImage').waitFor({ state: 'visible' });
  assert.equal((await r.app.snapshot()).job.manifest.images.length, 0);
});

test('MVPプレビュー復帰: 対象再読込で成功表示と承認を失効させ現在の指定の再検査へ案内する', async t => {
  for (const phase of ['Preview', 'Ready']) await t.test(phase, async t => {
    const r = await setup(t, { sampleFixture: 'layout' });
    const control = await openControlWindow(r.url, { headless: true }); t.after(() => control.close());
    const ui = control.page;
    await openSampleThroughPublicUi(ui);
    await ui.locator('#quickPreview').click(); await waitForPublicPreview(ui);
    if (phase === 'Ready') {
      await ui.locator('#previewConfirmed').check(); await ui.locator('#approve').click();
      await ui.waitForFunction(() => !document.querySelector('#start').disabled);
    }
    assert.equal((await r.app.snapshot()).state, phase);
    if (phase === 'Preview') await r.app.reader.page.reload();
    else await r.app.reader.page.locator('#readingFrame').evaluate(frame => { frame.src = frame.src; });
    await waitFor(r.app, snapshot => !snapshot.previewReady && !snapshot.previewApproved);
    await ui.waitForFunction(() => document.querySelector('#previewImage').hidden);
    assert.doesNotMatch(await ui.locator('#state').textContent(), /プレビュー確認待ち|承認済み/, '失効した成功状態を上部に残さない');
    assert.equal((await r.app.snapshot()).displayInspection, null, '過去のpassedを現在の検査結果として残さない');
    assert.match(await ui.locator('#state').textContent(), /表示検査待ち/);
    assert.match(await ui.locator('#reason').textContent(), /対象.*変わり/);
    assert.match(await ui.locator('#nextAction').textContent(), /決定・次へ.*指定した4項目/);
    assert.equal(await ui.locator('#previewConfirmed').isChecked(), false);
    assert.equal(await ui.locator('#approve').isDisabled(), true);
    assert.equal(await ui.locator('#start').isDisabled(), true);
    await openManualOptions(ui);
    await ui.locator('#preview').click(); await waitForPublicPreview(ui);
    assert.equal((await r.app.snapshot()).previewApproved, false);
    assert.equal((await r.app.snapshot()).job.manifest.images.length, 0);
  });
});

test('MVP停止競合: 撮影待ちの一時停止で未確定画像と送りを発生させず、復帰後の認証変化でも確定しない', async t => {
  const r = await setup(t);
  await r.request('create');
  await r.request('openBrowser', { mode: 'sample' });
  await r.request('preview', { config: sampleConfig });
  await r.request('approve', { confirmed: true });
  const capture = r.app.reader.capture.bind(r.app.reader);
  let release;
  let entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  r.app.reader.capture = async () => { const png = await capture(); entered(); await gate; return png; };
  await r.request('start', { confirmed: true });
  await started;
  const pause = r.request('pause');
  await sleep(50);
  release();
  await pause;
  assert.equal((await r.app.snapshot()).job.manifest.images.length, 0);
  assert.equal(await r.app.reader.page.locator('#position').innerText(), '1 / 12');
  await r.request('preview', { config: sampleConfig });
  await r.request('approve', { confirmed: true, resumeConfirmed: true });
  r.app.reader.capture = async () => { const png = await capture(); await r.app.reader.page.locator('#logout').click(); return png; };
  await r.request('start', { confirmed: true });
  await waitFor(r.app, s => s.state === 'NeedsAttention');
  await r.app.loop;
  const ended = await r.app.snapshot();
  assert.equal(ended.job.manifest.images.length, 0);
  assert.equal(ended.reason, 'auth_or_target_changed');
  assert.equal(await r.app.reader.page.locator('#position').innerText(), '1 / 12');
});

test('MVP送り待機競合: クリック可能待ちの取消・対象変更で遅延送りせず確定原本を保つ', async t => {
  for (const interruption of ['pause', 'pause-position-collision', 'stop', 'other-book', 'logout']) {
    await t.test(interruption, async t => {
      const r = await setup(t);
      await r.request('create');
      await r.request('openBrowser', { mode: 'sample' });
      await r.request('preview', { config: sampleConfig });
      await r.request('approve', { confirmed: true });
      const page = r.app.reader.page;
      await page.locator('#next').evaluate(element => {
        const rect = element.getBoundingClientRect();
        const cover = document.createElement('div');
        cover.id = 'mvp-advance-wait-cover';
        Object.assign(cover.style, {
          position: 'fixed', left: `${rect.x}px`, top: `${rect.y}px`,
          width: `${rect.width}px`, height: `${rect.height}px`, zIndex: '9999', background: 'red',
        });
        document.body.append(cover);
        window.mvpAdvanceClicks = 0;
        element.addEventListener('click', () => { window.mvpAdvanceClicks += 1; });
      });
      let entered;
      const advancing = new Promise(resolve => { entered = resolve; });
      const advance = r.app.reader.advance.bind(r.app.reader);
      r.app.reader.advance = async (...args) => { entered(); return advance(...args); };
      await r.request('start', { confirmed: true });
      await advancing;
      const committed = await r.app.snapshot();
      assert.equal(committed.job.manifest.images.length, 1);
      const originalPath = path.join(committed.job.job_path, 'originals', '000001.png');
      const original = await readFile(originalPath);
      // Let the normal pointer action reach its actionability wait. Only the
      // next button is covered; the bound reader and position remain visible.
      await sleep(450);
      let cancellation;
      if (interruption.startsWith('pause') || interruption === 'stop') {
        cancellation = r.request(interruption.startsWith('pause') ? 'pause' : 'stop');
        await waitFor(r.app, s => s.state === (interruption.startsWith('pause') ? 'Paused' : 'Review'));
      } else {
        await page.locator(`#${interruption}`).click();
      }
      await page.locator('#mvp-advance-wait-cover').evaluate(element => element.remove());
      if (cancellation) await cancellation;
      else await waitFor(r.app, s => s.state === 'NeedsAttention');
      await r.app.loop;
      assert.equal(await page.evaluate(() => window.mvpAdvanceClicks), 0, '待機中の失効後には次へを送らない');
      assert.equal(await page.locator('#position').innerText(), '1 / 12');
      const ended = await r.app.snapshot();
      assert.equal(ended.job.manifest.images.length, 1);
      assert.equal(ended.job.manifest.range_confirmed, false);
      assert.equal(ended.job.manifest.exports.length, 0);
      assert.deepEqual(await readFile(originalPath), original);
      if (interruption === 'pause-position-collision') {
        // A percentage-like position can remain identical across distinct
        // images. Move the anonymous reader to image 2 but retain its label.
        await page.locator('#next').click();
        await page.locator('#position').evaluate(element => { element.textContent = '1 / 12'; });
        await r.request('preview', { config: sampleConfig });
        const preview = await r.app.snapshot();
        assert.equal(preview.resumePlan.imageMatches, false);
        assert.equal(preview.resumePlan.currentPosition, preview.resumePlan.lastPosition);
        assert.equal(preview.resumePlan.dispatch, 'not_sent');
        assert.equal(preview.resumePlan.mode, 'blocked');
        await assert.rejects(r.app.command('approve', { confirmed: true, resumeConfirmed: true }), /resume_position_required/);
        await assert.rejects(r.app.command('start', { confirmed: true }), /explicit_start_required/);
        assert.equal(await page.evaluate(() => window.mvpAdvanceClicks), 1, '承認・明示開始を試みても未取得画像2を飛ばさない');
        assert.equal((await r.app.snapshot()).job.manifest.images.length, 1);
        assert.deepEqual(await readFile(originalPath), original);
      }
      if (interruption === 'pause') {
        await r.request('preview', { config: sampleConfig });
        await r.request('approve', { confirmed: true, resumeConfirmed: true });
        await r.request('start', { confirmed: true });
        await waitFor(r.app, s => s.state === 'NeedsAttention', 60_000);
        await r.app.loop;
        const resumed = await r.app.snapshot();
        assert.equal(resumed.reason, 'end_candidate', '本人の照合・明示再開後は未送信の1回だけを送り、同じ位置を保存し直さない');
        assert.equal(resumed.job.manifest.images.length, 12);
        assert.equal(resumed.job.manifest.images.some(image => image.duplicate_candidate), false);
        assert.deepEqual(await readFile(originalPath), original);
      }
    });
  }
});

test('MVP直下iframe送り: 通常送りを維持し座標取得中の要素・frame移動では別操作を送らない', async t => {
  for (const mode of ['stable', 'button-moved', 'frame-moved']) {
    await t.test(mode, async t => {
      const r = await setup(t);
      await r.request('create');
      await r.request('openBrowser', { mode: 'sample' });
      const reader = r.app.reader, page = reader.page;
      await page.evaluate(() => {
        window.mvpIframeWrongClicks = 0;
        const frame = document.createElement('iframe');
        frame.id = 'mvp-advance-frame';
        Object.assign(frame.style, { position: 'absolute', left: '200px', top: '700px', width: '300px', height: '80px', border: '0' });
        frame.srcdoc = '<button id="next">次へ</button><button id="other">別操作</button>';
        document.body.append(frame);
      });
      const frame = page.frameLocator('#mvp-advance-frame');
      await frame.locator('#next').evaluate(element => {
        Object.assign(element.style, { position: 'absolute', left: '5px', top: '5px', width: '90px', height: '35px' });
        element.addEventListener('click', () => parent.document.querySelector('#next').click());
      });
      await frame.locator('#other').evaluate(element => {
        Object.assign(element.style, { position: 'absolute', left: '130px', top: '5px', width: '90px', height: '35px' });
        element.addEventListener('click', () => { parent.mvpIframeWrongClicks += 1; });
      });
      await r.request('preview', { config: { ...sampleConfig, frames: { next: '#mvp-advance-frame' } } });
      await r.request('approve', { confirmed: true });
      if (mode !== 'stable') {
        // Model a layout update immediately after the browser returns the
        // main-frame coordinates, rather than relying on timer timing.
        const bound = reader.requireBound.bind(reader);
        const advance = reader.advance.bind(reader);
        let advancing = false;
        reader.advance = async (...args) => {
          advancing = true;
          try { return await advance(...args); }
          finally { advancing = false; }
        };
        let moved = false;
        reader.requireBound = async () => {
          const snapshot = await bound();
          // Capture also queries navigation geometry to suppress eligible
          // overlays. Inject this race only into the actual send operation.
          if (!advancing) return snapshot;
          const get = snapshot.next.elementHandle.bind(snapshot.next);
          snapshot.next.elementHandle = async () => {
            const handle = await get();
            const box = handle.boundingBox.bind(handle);
            handle.boundingBox = async () => {
              const result = await box();
              if (!moved) {
                moved = true;
                if (mode === 'button-moved') await handle.evaluate(element => {
                  element.style.left = '130px';
                  document.querySelector('#other').style.left = '5px';
                });
                else await page.locator('#mvp-advance-frame').evaluate(element => { element.style.left = '75px'; });
              }
              return result;
            };
            return handle;
          };
          return snapshot;
        };
      }
      await r.request('start', { confirmed: true });
      if (mode === 'stable') {
        await page.waitForFunction(() => document.querySelector('#position').textContent === '2 / 12', null, { timeout: 10_000 });
        await r.request('pause');
      } else {
        await waitFor(r.app, s => s.state === 'NeedsAttention');
        await r.app.loop;
        assert.equal(await page.evaluate(() => window.mvpIframeWrongClicks), 0);
        assert.equal((await r.app.snapshot()).reason, 'advance_geometry_changed');
        assert.equal(await page.locator('#position').innerText(), '1 / 12');
      }
      assert.equal(await page.evaluate(() => window.mvpIframeWrongClicks), 0);
      const ended = await r.app.snapshot();
      assert.equal(ended.job.manifest.images.length, 1);
      assert.equal(ended.job.manifest.range_confirmed, false);
      const image = ended.job.manifest.images[0];
      assert.equal(createHash('sha256').update(await readFile(path.join(ended.job.job_path, image.path))).digest('hex'), image.sha256);
    });
  }
});

test('MVP高解像度: 2倍描画を実測し1倍切替で古い承認を破棄して設定を保存する', async t => {
  const r = await setup(t);
  const control = await openControlWindow(r.url, { headless: true }); t.after(() => control.close());
  const ui = control.page;
  await ui.locator('#create').click(); await ui.locator('#openSample').click();
  await selectVisibleReaderTab(ui);
  await ui.locator('#quickPreview').click();
  await ui.locator('#previewImage').waitFor({ state: 'visible' });
  let snapshot = await r.app.snapshot();
  assert.deepEqual(snapshot.previewInfo.cssDimensions, [600, 480]);
  assert.deepEqual(snapshot.previewInfo.dimensions, [1200, 960]);
  assert.equal(snapshot.previewInfo.deviceScaleFactor, 2);
  assert.equal(await r.app.reader.page.evaluate(() => devicePixelRatio), 2, 'CSS表示範囲を補間せず2倍の描画面で取得する');
  assert.deepEqual([r.app.previewImage.readUInt32BE(16), r.app.previewImage.readUInt32BE(20)], [1200, 960]);

  await ui.locator('#previewConfirmed').check(); await ui.locator('#approve').click();
  await ui.waitForFunction(() => !document.querySelector('#start').disabled);
  await ui.locator('#captureScale').selectOption('1');
  await waitFor(r.app, s => s.job.manifest.capture_settings.capture_scale === 1);
  await ui.waitForFunction(() => document.querySelector('#previewImage').hidden && !document.querySelector('#previewConfirmed').checked);
  snapshot = await r.app.snapshot();
  assert.equal(snapshot.previewApproved, false, '倍率変更で以前の承認を無効化する');
  assert.equal(await ui.locator('#start').isDisabled(), true);

  await ui.locator('#quickPreview').click(); await ui.locator('#previewImage').waitFor({ state: 'visible' });
  snapshot = await r.app.snapshot();
  assert.deepEqual(snapshot.previewInfo.dimensions, [600, 480], '1倍設定はCSS画素と同じPNG画素数');
  await ui.locator('#captureScale').selectOption('2');
  await waitFor(r.app, s => s.job.manifest.capture_settings.capture_scale === 2);
  await ui.locator('#quickPreview').click(); await ui.locator('#previewImage').waitFor({ state: 'visible' });
  snapshot = await r.app.snapshot();
  assert.deepEqual(snapshot.previewInfo.dimensions, [1200, 960]);
  await ui.locator('#previewConfirmed').check(); await ui.locator('#approve').click();
  await ui.waitForFunction(() => !document.querySelector('#start').disabled);
  await ui.locator('#start').click();
  const captured = await waitFor(r.app, s => s.job.manifest.images.length >= 1);
  await ui.locator('#pause').click();
  const paused = await waitFor(r.app, s => s.state === 'Paused' && !s.busy);
  const image = captured.job.manifest.images[0];
  assert.equal(image.capture_scale, 2);
  assert.deepEqual([image.width, image.height], [1200, 960]);
  const source = await r.app.image(image.capture_id, true);
  assert.deepEqual([source.readUInt32BE(16), source.readUInt32BE(20)], [1200, 960]);
  await sleep(250);
  assert.equal((await r.app.snapshot()).job.manifest.images.length, paused.job.manifest.images.length, '停止後に確定枚数を勝手に増やさない');
});

test('MVP高解像度: スクロール後も選択した可視範囲の画素を1倍・2倍で保存する', async t => {
  // Each scale is a separate acquisition, not a resume at the same position
  // with different pixels/dimensions (which must remain safely blocked).
  for (const scale of [1, 2]) await t.test(`${scale}倍`, async t => {
    const r = await setup(t);
    await r.request('create'); await r.request('openBrowser', { mode: 'sample' });
    const page = r.app.reader.page;
    await r.request('selectReaderTab', { id: (await r.app.snapshot()).readerTabs[0].id });
    await page.evaluate(() => {
      document.body.style.cssText = 'margin:0;width:2000px;height:2000px';
      document.querySelector('h1').style.cssText = 'position:fixed;left:700px;top:0';
      document.querySelector('#reader').style.cssText = 'position:absolute;left:140px;top:250px;width:600px;height:480px;border:0';
      document.querySelector('nav').style.cssText = 'position:fixed;left:700px;top:80px';
      document.querySelector('fieldset').style.cssText = 'position:fixed;left:700px;top:200px;width:300px';
      window.scrollTo(100, 150);
    });
    await page.locator('#stall').click();
    await r.request('setCaptureSettings', { capture_scale: scale, page_output_mode: 'single_image', reading_direction: 'right_to_left' });
    await page.locator('#sheet').evaluate(canvas => {
      const dpr = devicePixelRatio;
      canvas.width = 600 * dpr; canvas.height = 480 * dpr;
      canvas.style.width = '600px'; canvas.style.height = '480px';
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      for (const [x, y, color] of [[0, 0, '#e61e28'], [300, 0, '#143cdc'], [0, 240, '#19b43c'], [300, 240, '#d2a01e']]) {
        ctx.fillStyle = color; ctx.fillRect(x, y, 300, 240);
      }
    });
    assert.deepEqual(await page.evaluate(() => [scrollX, scrollY]), [100, 150]);
    await r.request('preview', { config: sampleConfig });
    const expected = [[230, 30, 40], [20, 60, 220], [25, 180, 60], [210, 160, 30]];
    const assertVisiblePixels = bytes => {
      const image = PNG.sync.read(bytes);
      assert.deepEqual([image.width, image.height], [600 * scale, 480 * scale]);
      for (const [point, [x, y]] of [[150, 120], [450, 120], [150, 360], [450, 360]].entries()) {
        const offset = (y * scale * image.width + x * scale) * 4;
        assert.deepEqual([...image.data.subarray(offset, offset + 3)], expected[point], '表示外の文書座標ではなく、現在見えている読書領域を取得する');
      }
    };
    assertVisiblePixels(r.app.previewImage);
    await r.request('approve', { confirmed: true });
    await r.request('start', { confirmed: true });
    const captured = await waitFor(r.app, s => s.job.manifest.images.length === 1);
    await r.request('pause');
    assertVisiblePixels(await r.app.image(captured.job.manifest.images[0].capture_id, true));
  });
});

test('MVP画像軽量化: 匿名の片側表紙とボタン重なりを公開選択して取得する', { timeout: 40_000 }, async t => {
  let control, controlFailure;
  // Close the polling HTTP caller before the server, as the public launcher
  // does. Independent after hooks run in registration order, not reverse order.
  const r = await setup(t, { controlFirst: { control: () => control, controlFailure: () => controlFailure } });
  try { control = await openControlWindow(r.url, { headless: true }); }
  catch (error) { controlFailure = { error }; throw error; }
  const ui = control.page;
  await ui.locator('#create').click();
  await ui.locator('#sampleFixture').selectOption('image-review');
  await ui.locator('#openSample').click(); await selectVisibleReaderTab(ui);
  await ui.locator('#pageOutputMode').selectOption('split_spread');
  await waitFor(r.app, s => s.captureSettings.page_output_mode === 'split_spread' && !s.busy);
  const evidenceDir = fileURLToPath(new URL('../artifacts/image-review-evidence/', import.meta.url));
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(path.join(evidenceDir, 'cover.png'), await r.app.reader.screenshotVisibleClip(await r.app.reader.page.locator('#sheet').boundingBox()));
  await ui.locator('#quickPreview').click(); await waitForPublicPreview(ui);
  assert.equal((await r.app.snapshot()).previewInfo.layout, 'single_page');
  const coverWithButton = await r.app.reader.screenshotVisibleClip((await r.app.reader.requireBound()).clip);
  assert.ok((await imagePixel(ui, coverWithButton, 1150, 440))[0] > 180);
  assert.ok((await imagePixel(ui, r.app.previewImage, 1150, 440))[0] < 60);
  await ui.locator('#previewConfirmed').check(); await ui.locator('#approve').click();
  await ui.waitForFunction(() => !document.querySelector('#start').disabled);
  await ui.locator('#start').click();
  await waitFor(r.app, s => s.job.manifest.images.length === 2 && !s.busy);
  await writeFile(path.join(evidenceDir, 'page.png'), await r.app.reader.screenshotVisibleClip((await r.app.reader.read()).clip));
  const pageWithButton = await r.app.reader.screenshotVisibleClip((await r.app.reader.read()).clip);
  assert.ok((await imagePixel(ui, pageWithButton, 270, 450))[0] > (await imagePixel(ui, await r.app.image(2, true), 270, 450))[0] + 70);
  assert.equal((await r.app.reader.page.locator('#reader').getAttribute('data-position')), '2');
  assert.equal((await r.app.snapshot()).job.manifest.images[0].split, null);
  await ui.locator('#stop').click(); await waitFor(r.app, s => s.state === 'Review' && !s.busy);
});

test('JPEG匿名試料: 片側表紙と次のページを実取得する', { timeout: 40_000 }, async t => {
  const r = await setup(t);
  const control = await openControlWindow(r.url, { headless: true }); t.after(() => control.close());
  const ui = control.page;
  await ui.locator('#create').click(); await ui.locator('#sampleFixture').selectOption('image-review');
  await ui.locator('#openSample').click(); await selectVisibleReaderTab(ui);
  await ui.locator('#pageOutputMode').selectOption('split_spread');
  await waitFor(r.app, s => s.captureSettings.page_output_mode === 'split_spread' && !s.busy);
  await ui.locator('#imageFormat').selectOption('jpeg');
  await waitFor(r.app, s => s.captureSettings.image_format === 'jpeg' && !s.busy);
  await ui.locator('#quickPreview').click(); await waitForPublicPreview(ui);
  assert.equal((await r.app.snapshot()).previewInfo.layout, 'single_page');
  const coverWithButton = await r.app.reader.screenshotVisibleClip((await r.app.reader.requireBound()).clip);
  assert.ok((await imagePixel(ui, coverWithButton, 1150, 440))[0] > 180);
  assert.ok((await imagePixel(ui, r.app.previewImage, 1150, 440))[0] < 60);
  await ui.locator('#previewConfirmed').check(); await ui.locator('#approve').click();
  await ui.waitForFunction(() => !document.querySelector('#start').disabled);
  await ui.locator('#start').click();
  const captured = await waitFor(r.app, s => s.job.manifest.images.length === 2 && !s.busy);
  assert.deepEqual(captured.job.manifest.images.map(image => image.image_format), ['jpeg', 'jpeg']);
  assert.equal(captured.job.manifest.images[0].split, null);
  assert.equal((await r.app.image(1, true)).subarray(0, 2).toString('hex'), 'ffd8');
  const pageWithButton = await r.app.reader.screenshotVisibleClip((await r.app.reader.read()).clip);
  assert.ok((await imagePixel(ui, pageWithButton, 270, 450))[0] > (await imagePixel(ui, await r.app.image(2, true), 270, 450))[0] + 70);
  await ui.locator('#stop').click(); await waitFor(r.app, s => s.state === 'Review' && !s.busy);
});

test('自動余白: 公開点検で原本と比較し取消・適用・原寸復帰する', { timeout: 100_000 }, async t => {
  for (const imageFormat of ['png', 'jpeg']) await t.test(imageFormat, async t => {
    const r = await setup(t);
    const control = await openControlWindow(r.url, { headless: true }); t.after(() => control.close());
    const ui = control.page;
    await ui.locator('#create').click(); await ui.locator('#sampleFixture').selectOption('image-review');
    await ui.locator('#openSample').click(); await selectVisibleReaderTab(ui);
    await ui.locator('#pageOutputMode').selectOption('split_spread');
    await waitFor(r.app, s => s.captureSettings.page_output_mode === 'split_spread' && !s.busy);
    if (imageFormat === 'jpeg') {
      await ui.locator('#imageFormat').selectOption('jpeg');
      await waitFor(r.app, s => s.captureSettings.image_format === 'jpeg' && !s.busy);
      await ui.locator('#jpegQuality').fill('35'); await ui.locator('#jpegQuality').dispatchEvent('change');
      await waitFor(r.app, s => s.captureSettings.jpeg_quality === 35 && !s.busy);
    }
    await ui.locator('#quickPreview').click(); await waitForPublicPreview(ui);
    await ui.locator('#previewConfirmed').check(); await ui.locator('#approve').click();
    await ui.waitForFunction(() => !document.querySelector('#start').disabled);
    await ui.locator('#start').click(); await waitFor(r.app, s => s.job.manifest.images.length === 2 && !s.busy);
    await ui.locator('#stop').click(); await waitFor(r.app, s => s.state === 'Review' && !s.busy);
    const original = await r.app.image(2, true);
    await ui.locator('#images article[data-capture-id="2"] select').selectOption('single');
    await waitFor(r.app, s => s.job.manifest.images[1].split === null && s.job.manifest.images[1].layout_override === true && !s.busy);
    await ui.locator('#cropId').fill('2');
    for (const [name, value] of [['cropX', 10], ['cropY', 10], ['cropWidth', 1000], ['cropHeight', 900]]) await ui.locator(`#${name}`).fill(String(value));
    await ui.locator('#crop').click();
    await waitFor(r.app, s => s.job.manifest.images[1].crop?.width === 1000 && !s.busy);
    await ui.locator('#detectCrop').click(); await ui.locator('#autoCropFigure').waitFor({ state: 'visible' });
    const versionBeforeReset = (await r.app.snapshot()).job.manifest.next_render_version;
    await r.request('resetCrop', { id: 2 });
    assert.equal((await r.app.snapshot()).job.manifest.next_render_version, versionBeforeReset);
    await ui.locator('#autoCropActions').waitFor({ state: 'hidden' });
    await ui.locator('#images article[data-capture-id="2"] select').selectOption('left');
    await waitFor(r.app, s => s.job.manifest.images[1].split?.first_page === 'left' && !s.busy);
    await ui.locator('#cropId').fill('2');
    for (const [name, value] of [['cropX', 10], ['cropY', 10], ['cropWidth', 1000], ['cropHeight', 900]]) await ui.locator(`#${name}`).fill(String(value));
    await ui.locator('#crop').click();
    let saved = await waitFor(r.app, s => s.job.manifest.images[1].crop?.width === 1000 && !s.busy);
    if (imageFormat === 'jpeg') {
      assert.equal(saved.job.manifest.images[1].jpeg_quality, 35);
      await r.request('setCaptureSettings', { ...saved.captureSettings, image_format: 'png', jpeg_quality: 90 });
      saved = await r.app.snapshot();
    }
    const manual = structuredClone(saved.job.manifest);
    await ui.locator('#detectCrop').click();
    await ui.waitForFunction(() => !document.querySelector('#autoCropFigure').hidden || document.querySelector('#operationStatus').dataset.status === 'failure' || document.querySelector('#autoCropStatus').textContent.includes('見つかりません'));
    assert.equal(await ui.locator('#autoCropFigure').isVisible(), true,
      `検出状態: ${await ui.locator('#autoCropStatus').textContent()} / ${await ui.locator('#message').textContent()}`);
    assert.deepEqual((await r.app.snapshot()).job.manifest, manual, '候補表示だけでは手動クロップや出力順を変更しない');
    assert.equal(await ui.locator('#autoCropPreview').evaluate(canvas => canvas.width > 0 && canvas.height > 0), true);
    await ui.locator('#cancelAutoCrop').click(); await ui.locator('#autoCropFigure').waitFor({ state: 'hidden' });
    assert.deepEqual((await r.app.snapshot()).job.manifest, manual);
    await ui.locator('#detectCrop').click(); await ui.locator('#autoCropFigure').waitFor({ state: 'visible' });
    await ui.locator('#cropId').fill('1');
    assert.equal(await ui.locator('#autoCropActions').isHidden(), true, '画像切替で候補を破棄');
    await ui.locator('#cropId').fill('2'); await ui.locator('#detectCrop').click();
    await ui.locator('#autoCropFigure').waitFor({ state: 'visible' });
    await ui.locator('#language').selectOption('en'); assert.match(await ui.locator('#applyAutoCrop').textContent(), /Apply candidate/);
    await ui.locator('#language').selectOption('zh-CN'); assert.match(await ui.locator('#applyAutoCrop').textContent(), /应用候选/);
    await ui.locator('#language').selectOption('ja');
    await ui.locator('#applyAutoCrop').click();
    saved = await waitFor(r.app, s => s.job.manifest.images[1].crop?.width !== 1000 && !s.busy);
    const edited = saved.job.manifest.images[1];
    assert.ok(edited.crop.x <= 244 && edited.crop.y + edited.crop.height > 928, '端近くの細い線・孤立した番号を保持');
    assert.equal(edited.split.first_page, 'left');
    assert.deepEqual(saved.job.manifest.selected_capture_ids, manual.selected_capture_ids);
    assert.deepEqual(await r.app.image(2, true), original);
    if (imageFormat === 'jpeg') {
      const derived = await r.app.image(2);
      await r.request('crop', { id: 2, x: edited.crop.x, y: edited.crop.y, width: edited.crop.width, height: edited.crop.height });
      assert.deepEqual(await r.app.image(2), derived, '自動・手動の派生には現在設定ではなく取得時JPEG画質を使う');
    }
    const expected = [await r.app.image(1), await r.app.image(2, false, 'left'), await r.app.image(2, false, 'right')];
    await ui.locator('#decisionButton').click(); await ui.locator('#exportOptions > summary').click();
    for (const [index, format] of ['zip', 'cbz'].entries()) {
      const destination = path.join(r.directory, `auto-margin.${format}`);
      await ui.locator('#format').selectOption(format); await ui.locator('#destination').fill(destination);
      await ui.locator('#export').click(); await waitFor(r.app, s => s.job.manifest.exports.length === index + 1 && !s.busy);
      const archive = await readFile(destination), entries = [];
      for (let offset = 0; archive.readUInt32LE(offset) === 0x04034b50;) {
        const size = archive.readUInt32LE(offset + 18), n = archive.readUInt16LE(offset + 26);
        const start = offset + 30 + n + archive.readUInt16LE(offset + 28);
        entries.push({ name: archive.subarray(offset + 30, offset + 30 + n).toString(), bytes: archive.subarray(start, start + size) });
        offset = start + size;
      }
      const extension = imageFormat === 'jpeg' ? 'jpg' : 'png';
      assert.deepEqual(entries.map(entry => entry.name), [1, 2, 3].map(n => `${String(n).padStart(6, '0')}.${extension}`));
      assert.deepEqual(entries.map(entry => entry.bytes), expected, '取得順・左→右順と派生画像bytes');
      for (const [x, y] of [[244, 130], [588, 920]]) {
        const source = await imagePixel(ui, original, x, y);
        const output = await imagePixel(ui, entries[1].bytes, x - edited.crop.x, y - edited.crop.y);
        assert.ok(source.every((value, channel) => Math.abs(value - output[channel]) <= (imageFormat === 'png' ? 0 : 70)), '枠・番号の画素を出力で確認');
      }
    }
    await ui.locator('[data-stage-target="review"]').first().click();
    await ui.locator('#resetCrop').click();
    saved = await waitFor(r.app, s => s.job.manifest.images[1].crop === null && !s.busy);
    assert.equal(saved.job.manifest.images[1].split.first_page, 'left');
    assert.deepEqual(await r.app.image(2, true), original);
  });
});

test('JPEG cleanup観測: 出力設定と注入した失敗を保持する', async t => {
  await t.test('出力先は観測の生成時に取得し、内容は境界とeventだけ', async () => {
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(path.join(root, 'jpeg-observation-'));
    const eventFile = path.join(directory, 'events.jsonl');
    const previous = process.env.KTZ_JPEG_CLEANUP_EVENTS;
    try {
      delete process.env.KTZ_JPEG_CLEANUP_EVENTS;
      const disabled = createJpegCleanupObservation();
      process.env.KTZ_JPEG_CLEANUP_EVENTS = eventFile;
      const enabled = createJpegCleanupObservation();
      disabled.bodyError();
      await assert.rejects(lstat(eventFile), { code: 'ENOENT' });
      delete process.env.KTZ_JPEG_CLEANUP_EVENTS;
      enabled.bodyComplete();
      assert.deepEqual((await readFile(eventFile, 'utf8')).trim().split('\n').map(JSON.parse),
        [{ boundary: 'body', event: 'complete' }]);
      if (process.platform !== 'win32') assert.equal((await stat(eventFile)).mode & 0o077, 0);
    } finally {
      if (previous === undefined) delete process.env.KTZ_JPEG_CLEANUP_EVENTS;
      else process.env.KTZ_JPEG_CLEANUP_EVENTS = previous;
      await rm(directory, { recursive: true, force: true });
    }
  });
  await t.test('注入したcontrolとstoreの失敗もHTTP終了と元errorを保持', async () => {
    const server = http.createServer();
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const originalHttpClose = http.Server.prototype.close;
    const body = new Error('body'), control = new Error('control'), store = new Error('store');
    const observation = createJpegCleanupObservation({ eventFile: null });
    const app = { store: { async close() { throw store; } }, closeBrowser() {},
      async close() { await this.store.close(); } };
    const running = { app, origin: `http://127.0.0.1:${server.address().port}`,
      async close() {
        let failure;
        try { await app.close(); } catch (error) { failure = error; }
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        if (failure) throw failure;
      } };
    observation.attach(running);
    let removed = false;
    const cleanup = createControlFirstCleanup({
      closeControl: () => observation.step('control.close', () => { throw control; }),
      closeRunning: () => observation.closeRunning(running),
      removeFixture: () => { removed = true; }, bodyFailure: () => ({ error: body }),
    });
    try {
      await assert.rejects(cleanup(), error => error instanceof AggregateError && error.cause === body
        && error.errors[0] === body && error.errors[1] === control && error.errors[2] === store);
      assert.equal(removed, false);
      assert.equal(server.listening, false);
      assert.equal(http.Server.prototype.close, originalHttpClose);
      assert.deepEqual(observation.events(), [
        ['control.close', 'start'], ['control.close', 'error'], ['running.close', 'start'],
        ['app.close', 'start'], ['store.close', 'start'], ['store.close', 'error'], ['app.close', 'error'],
        ['http.close', 'start'], ['http.close', 'end'], ['running.close', 'error'],
      ].map(([boundary, event]) => ({ boundary, event })));
    } finally {
      if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});

test('JPEG画像軽量化: 公開設定で実取得し画質・原本・クロップとZIP/CBZを再読する', { timeout: 60_000 }, async t => {
  let control, controlFailure, bodyFailure, controlAttempted = false;
  const jpegObservation = createJpegCleanupObservation();
  const r = await setup(t, { controlFirst: {
    control: () => control, controlFailure: () => controlFailure, bodyFailure: () => bodyFailure,
    controlAttempted: () => controlAttempted, jpegObservation,
  } });
  try {
  controlAttempted = true;
  try { control = await openControlWindow(r.url, { headless: true }); }
  catch (error) { controlFailure = { error }; throw error; }
  const ui = control.page;
  await openSampleThroughPublicUi(ui);
  await ui.locator('#pageOutputMode').selectOption('split_spread');
  await waitFor(r.app, s => s.job.manifest.capture_settings.page_output_mode === 'split_spread' && !s.busy);
  await ui.locator('#imageFormat').selectOption('jpeg');
  await waitFor(r.app, s => s.job.manifest.capture_settings.image_format === 'jpeg' && !s.busy);
  await r.app.reader.page.locator('#stall').click();
  await r.app.reader.page.locator('#sheet').evaluate(canvas => {
    const ctx = canvas.getContext('2d'), pixels = ctx.createImageData(canvas.width, canvas.height);
    let seed = 12345;
    for (let i = 0; i < pixels.data.length; i += 4) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      pixels.data[i] = seed >>> 24; pixels.data[i + 1] = seed >>> 16 & 255;
      pixels.data[i + 2] = seed >>> 8 & 255; pixels.data[i + 3] = 255;
    }
    ctx.putImageData(pixels, 0, 0);
  });
  await ui.locator('#jpegQuality').fill('35'); await ui.locator('#jpegQuality').dispatchEvent('change');
  await waitFor(r.app, s => s.job.manifest.capture_settings.jpeg_quality === 35 && !s.busy);
  await ui.locator('#quickPreview').click(); await waitForPublicPreview(ui);
  const small = Buffer.from(r.app.previewImage);
  assert.equal(small.subarray(0, 2).toString('hex'), 'ffd8', 'CDP取得そのものがJPEG');
  await ui.locator('#jpegQuality').fill('90'); await ui.locator('#jpegQuality').dispatchEvent('change');
  await waitFor(r.app, s => s.job.manifest.capture_settings.jpeg_quality === 90 && !s.busy);
  await ui.locator('#quickPreview').click(); await waitForPublicPreview(ui);
  assert.ok(r.app.previewImage.length > small.length, '同じ試料で品質90は35より大きい');
  await ui.locator('#jpegQuality').fill('35'); await ui.locator('#jpegQuality').dispatchEvent('change');
  await waitFor(r.app, s => s.job.manifest.capture_settings.jpeg_quality === 35 && !s.busy);
  await ui.locator('#quickPreview').click(); await waitForPublicPreview(ui);
  const response = await fetch(`${r.origin}/api/preview`, { headers: { Authorization: `Bearer ${r.token}` } });
  assert.equal(response.headers.get('content-type'), 'image/jpeg');
  await ui.locator('#previewConfirmed').check(); await ui.locator('#approve').click();
  await ui.waitForFunction(() => !document.querySelector('#start').disabled);
  await ui.locator('#start').click(); await waitFor(r.app, s => s.job.manifest.images.length === 1);
  await ui.locator('#stop').click();
  let snapshot = await waitFor(r.app, s => s.state === 'Review' && s.job.manifest.state === 'review' && !s.busy);
  const item = snapshot.job.manifest.images[0], original = await r.app.image(item.capture_id, true);
  assert.equal(item.image_format, 'jpeg'); assert.equal(item.jpeg_quality, 35);
  assert.match(item.path, /\.jpg$/); assert.equal(original.subarray(0, 2).toString('hex'), 'ffd8');
  assert.equal(createHash('sha256').update(original).digest('hex'), item.sha256);
  assert.equal(item.split.first_page, 'right');
  const originalRight = await r.app.image(item.capture_id, false, 'right');
  const settings = snapshot.job.manifest.capture_settings;
  await r.request('crop', { id: item.capture_id, x: 10, y: 10, width: 1001, height: 800 });
  const firstCrop = await r.app.image(item.capture_id);
  await r.request('setCaptureSettings', { ...settings, image_format: 'png', jpeg_quality: 90 });
  await r.request('crop', { id: item.capture_id, x: 10, y: 10, width: 1001, height: 800 });
  assert.deepEqual(await r.app.image(item.capture_id), firstCrop, '現在の設定変更は取得済みJPEGの派生結果を変えない');
  snapshot = await r.app.snapshot();
  const cropped = snapshot.job.manifest.images[0];
  assert.equal(cropped.jpeg_quality, 35, '派生画像に使用する画質は取得時の値');
  assert.deepEqual([cropped.crop.width, cropped.crop.height, cropped.split.left.width, cropped.split.right.width], [1001, 800, 500, 501]);
  assert.match(cropped.crop.path, /\.jpg$/); assert.match(cropped.split.right.path, /\.jpg$/);
  assert.deepEqual(await r.app.image(item.capture_id, true), original);
  await ui.locator('#decisionButton').click(); await ui.locator('#exportOptions > summary').click();
  for (const [index, format] of ['zip', 'cbz'].entries()) {
    const destination = path.join(r.directory, `jpeg-test.${format}`);
    await ui.locator('#format').selectOption(format); await ui.locator('#destination').fill(destination);
    await ui.locator('#export').click(); await waitFor(r.app, s => s.job.manifest.exports.length === index + 1 && !s.busy);
    const archive = await readFile(destination), entries = [];
    for (let offset = 0; archive.readUInt32LE(offset) === 0x04034b50;) {
      const size = archive.readUInt32LE(offset + 18), n = archive.readUInt16LE(offset + 26);
      const start = offset + 30 + n + archive.readUInt16LE(offset + 28);
      entries.push({ name: archive.subarray(offset + 30, offset + 30 + n).toString(), bytes: archive.subarray(start, start + size) });
      offset = start + size;
    }
    assert.deepEqual(entries.map(entry => entry.name), ['000001.jpg', '000002.jpg']);
    for (const [i, entry] of entries.entries()) {
      assert.equal(entry.bytes.subarray(0, 2).toString('hex'), 'ffd8');
      const dimensions = await ui.evaluate(async base64 => {
        const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
        const size = [bitmap.width, bitmap.height]; bitmap.close(); return size;
      }, entry.bytes.toString('base64'));
      assert.deepEqual(dimensions, [i === 0 ? 501 : 500, 800]);
    }
  }
  await r.request('resetCrop', { id: item.capture_id });
  assert.equal((await r.app.snapshot()).job.manifest.images[0].crop, null);
  assert.deepEqual(await r.app.image(item.capture_id, true), original);
  assert.deepEqual(await r.app.image(item.capture_id, false, 'right'), originalRight, '復元・再分割は取得時の画質を使う');
  await ui.locator('#language').selectOption('en');
  assert.match(await ui.locator('#imageFormat').locator('..').textContent(), /Capture image format/);
  await ui.locator('#language').selectOption('zh-CN');
  assert.match(await ui.locator('#imageFormat').locator('..').textContent(), /获取图像格式/);
  assert.equal((await r.app.snapshot()).job.manifest.images[0].jpeg_quality, 35);
  await ui.locator('#language').selectOption('ja');
  const jobPath = (await r.app.snapshot()).job.job_path;
  await ui.locator('[data-stage-target="browser"]').first().click();
  await ui.locator('[data-stage="browser"] > details > summary').click();
  await ui.locator('#closeBrowser').click(); await waitFor(r.app, s => !s.browserOpen && !s.busy);
  await ui.locator('[data-stage-target="setup"]').first().click();
  await ui.locator('[data-stage="setup"] details > summary').click();
  await ui.locator('#closeJob').click(); await waitFor(r.app, s => !s.job && !s.busy);
  await ui.locator('#recoverPath').fill(jobPath); await ui.locator('#recover').click();
  const reopened = await waitFor(r.app, s => s.job?.job_path === jobPath && !s.busy);
  assert.equal(reopened.job.manifest.capture_settings.image_format, 'png');
  assert.equal(reopened.job.manifest.capture_settings.jpeg_quality, 90);
  assert.equal(reopened.job.manifest.images[0].image_format, 'jpeg');
  assert.equal(reopened.job.manifest.images[0].jpeg_quality, 35);
  assert.deepEqual(reopened.job.issues, []);
  assert.deepEqual(await r.app.image(item.capture_id, true), original);
  assert.deepEqual(await r.app.image(item.capture_id, false, 'right'), originalRight);
  jpegObservation.bodyComplete();
  } catch (error) { jpegObservation.bodyError(); bodyFailure = { error }; throw error; }
});

test('MVP単ページ: 片側表紙を保持し点検で左右順を明示修正して復帰する', { timeout: 40_000 }, async t => {
  const r = await setup(t);
  const control = await openControlWindow(r.url, { headless: true }); t.after(() => control.close());
  const ui = control.page;
  await openSampleThroughPublicUi(ui);
  await ui.locator('#pageOutputMode').selectOption('split_spread');
  await waitFor(r.app, s => s.job.manifest.capture_settings.page_output_mode === 'split_spread' && !s.busy);
  await r.app.reader.page.locator('#stall').click();
  await r.app.reader.page.locator('#sheet').evaluate(canvas => {
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 600, 480);
    ctx.fillStyle = '#c75b38'; ctx.fillRect(0, 48, 280, 402);
    ctx.fillStyle = '#f5f5f5'; ctx.fillRect(0, 0, 600, 48); ctx.fillRect(0, 450, 600, 30);
    ctx.fillRect(570, 210, 30, 60);
  });
  await ui.locator('#quickPreview').click(); await waitForPublicPreview(ui);
  assert.equal((await r.app.snapshot()).previewInfo.layout, 'single_page');
  await ui.locator('#previewConfirmed').check(); await ui.locator('#approve').click();
  await ui.waitForFunction(() => !document.querySelector('#start').disabled);
  await ui.locator('#start').click(); await waitFor(r.app, s => s.job.manifest.images.length === 1);
  await ui.locator('#stop').click();
  let saved = await waitFor(r.app, s => s.state === 'Review' && !s.busy);
  const jobPath = saved.job.job_path, original = await r.app.image(1, true);
  assert.equal(saved.job.manifest.images[0].split, null);
  const layout = ui.locator('#images article[data-capture-id="1"] select');
  await layout.selectOption('left');
  saved = await waitFor(r.app, s => s.job.manifest.images[0].split?.first_page === 'left' && !s.busy);
  assert.equal(saved.job.manifest.images[0].layout_override, true);
  assert.deepEqual(await r.app.image(1, true), original);
  await ui.locator('[data-stage-target="browser"]').first().click();
  await ui.locator('[data-stage="browser"] > details > summary').click();
  await ui.locator('#closeBrowser').click();
  await waitFor(r.app, s => !s.browserOpen && !s.busy);
  await ui.locator('[data-stage-target="setup"]').first().click();
  await ui.locator('[data-stage="setup"] details > summary').click();
  await ui.locator('#closeJob').click(); await waitFor(r.app, s => !s.job && !s.busy);
  await ui.locator('#recoverPath').fill(jobPath); await ui.locator('#recover').click();
  await waitFor(r.app, s => s.job?.job_path === jobPath && !s.busy);
  saved = await r.app.snapshot();
  assert.equal(saved.job.manifest.images[0].split.first_page, 'left', '本人の指定は復帰時に自動判定で消さない');
  assert.deepEqual(await r.app.image(1, true), original);
  await r.request('review');
  await r.request('setPageLayout', { id: 1, mode: 'single_image', firstPage: 'right' });
  assert.equal((await r.app.snapshot()).job.manifest.images[0].split, null);
  assert.deepEqual(await r.app.image(1, true), original);
});

test('MVP写り込み: 選択済み次へだけ撮影中に隠し失敗後も戻して送る', { timeout: 40_000 }, async t => {
  const r = await setup(t);
  await r.request('create'); await r.request('openBrowser', { mode: 'sample' });
  const page = r.app.reader.page;
  await page.locator('#next').evaluate(button => {
    const reader = document.querySelector('#reader');
    reader.style.position = 'relative'; reader.append(button);
    button.style.cssText = 'position:absolute;left:0;top:205px;width:45px;height:60px;background:white;visibility:visible!important;z-index:2';
  });
  const before = await page.locator('#next').getAttribute('style');
  await r.request('preview', { config: sampleConfig });
  const preview = PNG.sync.read(r.app.previewImage);
  const clip = r.app.reader.bound.dimensions;
  assert.deepEqual([preview.width, preview.height], clip);
  const raw = PNG.sync.read(await r.app.reader.screenshotVisibleClip((await r.app.reader.requireBound()).clip));
  const x = 20 * r.app.reader.captureScale, y = 230 * r.app.reader.captureScale;
  const pixel = image => [...image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 3)];
  assert.notDeepEqual(pixel(preview), pixel(raw), '撮影中だけ選択ボタン下の試料画素が見える');
  assert.equal(await page.locator('#next').getAttribute('style'), before);
  const screenshot = r.app.reader.screenshotVisibleClip;
  r.app.reader.screenshotVisibleClip = async () => { throw new Error('injected screenshot failure'); };
  await assert.rejects(r.app.reader.capture());
  r.app.reader.screenshotVisibleClip = screenshot;
  assert.equal(await page.locator('#next').getAttribute('style'), before, '例外でも元のpriorityを復元');
  await r.request('approve', { confirmed: true }); await r.request('start', { confirmed: true });
  await waitFor(r.app, s => s.job.manifest.images.length >= 2);
  await r.request('pause');
  assert.ok(Number(await page.locator('#reader').getAttribute('data-position')) >= 2, '復元後は通常のページ送りができる');
});

test('MVP単ページ判定境界: 灰色余白の表紙と上下余白付き2ページを公開UIから保存・クロップ・出力する', async t => {
  for (const spread of [false, true]) await t.test(spread ? '上下余白付きの実2ページ' : '均一灰色余白の縦長表紙', async t => {
    const r = await setup(t);
    const control = await openControlWindow(r.url, { headless: true }); t.after(() => control.close());
    const ui = control.page;
    await openSampleThroughPublicUi(ui);
    await ui.locator('#pageOutputMode').selectOption('split_spread');
    await waitFor(r.app, s => s.job.manifest.capture_settings.page_output_mode === 'split_spread' && !s.busy);
    await r.app.reader.page.locator('#stall').click();
    await r.app.reader.page.locator('#sheet').evaluate((canvas, spread) => {
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = spread ? '#000' : '#202020'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#c75b38';
      if (spread) {
        ctx.fillRect(120, 100, 180, 280);
        ctx.fillStyle = '#3264ab'; ctx.fillRect(300, 100, 180, 280);
      } else {
        ctx.fillRect(160, 0, 280, 480);
        // Observed failure structure: an isolated navigation decoration at
        // the outer edge used to destroy an otherwise symmetric gutter.
        ctx.fillStyle = '#888'; ctx.fillRect(0, 220, 20, 40);
      }
    }, spread);
    await ui.locator('#quickPreview').click(); await waitForPublicPreview(ui);
    await ui.waitForFunction(() => document.querySelector('#message').textContent.includes('プレビューを表示しました'));
    assert.equal((await r.app.snapshot()).previewInfo.layout, spread ? 'spread' : 'single_page');
    assert.equal(await ui.locator('#previewPages figure').count(), spread ? 2 : 0);
    await ui.locator('#previewConfirmed').check(); await ui.locator('#approve').click();
    await ui.waitForFunction(() => !document.querySelector('#start').disabled);
    await ui.locator('#start').click(); await waitFor(r.app, s => s.job.manifest.images.length === 1);
    await ui.locator('#pause').click(); await waitFor(r.app, s => s.state === 'Paused' && !s.busy);
    const captured = (await r.app.snapshot()).job.manifest.images[0];
    assert.equal(Boolean(captured.split), spread, 'プレビューとRust保存のページ単位を一致させる');
    assert.equal(captured.page_layout, spread ? 'split_spread' : 'single_image');
    const original = await r.app.image(1, true);
    const safetyDetails = ui.locator('#safetyActions');
    if (!await safetyDetails.evaluate(element => element.open)) await safetyDetails.locator('summary').click();
    await ui.locator('#stop').click(); await waitFor(r.app, s => s.state === 'Review' && !s.busy);
    const crop = spread ? [240, 200, 720, 560] : [320, 0, 560, 960];
    await ui.locator('#cropId').fill('1');
    for (const [index, id] of ['cropX', 'cropY', 'cropWidth', 'cropHeight'].entries()) await ui.locator(`#${id}`).fill(String(crop[index]));
    await ui.locator('#crop').click();
    await waitFor(r.app, s => s.job.manifest.images[0].crop?.width === crop[2] && !s.busy);
    assert.equal(Boolean((await r.app.snapshot()).job.manifest.images[0].split), spread, 'クロップでも取得時のページ単位を保つ');
    await ui.locator('#decisionButton').click();
    await ui.locator('#exportOptions > summary').click();
    await ui.locator('#warningsAccepted').check();
    for (const [index, format] of ['cbz', 'zip'].entries()) {
      const destination = path.join(r.directory, `layout-boundary.${format}`);
      await ui.locator('#format').selectOption(format); await ui.locator('#destination').fill(destination);
      await ui.locator('#export').click();
      const exported = await waitFor(r.app, s => s.job.manifest.exports.length === index + 1 && !s.busy);
      assert.equal(exported.job.manifest.exports[index].entry_count, spread ? 2 : 1);
      const archive = await readFile(destination), pages = [];
      for (let offset = 0; archive.readUInt32LE(offset) === 0x04034b50;) {
        const size = archive.readUInt32LE(offset + 18);
        const start = offset + 30 + archive.readUInt16LE(offset + 26) + archive.readUInt16LE(offset + 28);
        pages.push(PNG.sync.read(archive.subarray(start, start + size))); offset = start + size;
      }
      assert.deepEqual(pages.map(p => [p.width, p.height]), spread ? [[360, 560], [360, 560]] : [[560, 960]]);
      const expected = spread ? [[50, 100, 171], [199, 91, 56]] : [[199, 91, 56]];
      for (const [index, page] of pages.entries()) {
        const center = (Math.floor(page.height / 2) * page.width + Math.floor(page.width / 2)) * 4;
        assert.deepEqual([...page.data.subarray(center, center + 3)], expected[index], 'ZIP/CBZ内のページ画素と右→左順を確認する');
      }
    }
    assert.deepEqual(await r.app.image(1, true), original, '判定・クロップ・出力は原本を変更しない');
  });
});

test('MVP単ページ: 見開きプレビューの左右順・奇数幅契約・ZIP/CBZの2ページ出力を確かめる', async t => {
  const r = await setup(t);
  const control = await openControlWindow(r.url, { headless: true }); t.after(() => control.close());
  const ui = control.page;
  await ui.locator('#create').click(); await ui.locator('#openSample').click();
  await selectVisibleReaderTab(ui);
  await ui.locator('#pageOutputMode').selectOption('split_spread');
  await waitFor(r.app, s => s.job.manifest.capture_settings.page_output_mode === 'split_spread');
  await ui.locator('#readingDirection').selectOption('right_to_left');
  await waitFor(r.app, s => s.job.manifest.capture_settings.reading_direction === 'right_to_left');
  await t.test('中央の縦長表紙は2枚設定でも1枚', async () => {
    await r.app.reader.page.locator('#sheet').evaluate(canvas => {
      const ctx = canvas.getContext('2d');
      window.savedSpread = ctx.getImageData(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#c75b38'; ctx.fillRect(160, 0, 280, 480);
    });
    await ui.locator('#quickPreview').click(); await waitForPublicPreview(ui);
    await ui.waitForFunction(() => document.querySelector('#message').textContent.includes('プレビューを表示しました'));
    assert.equal(await ui.locator('#previewPages figure').count(), 0, '表紙の左右半片を生成しない');
    assert.match(await ui.locator('#previewInfo').textContent(), /単ページ.*1枚/);
    await ui.locator('#previewConfirmed').check(); await ui.locator('#approve').click();
    await ui.waitForFunction(() => !document.querySelector('#start').disabled);
    await ui.locator('#start').click();
    await waitFor(r.app, s => s.job.manifest.images.length >= 1);
    await ui.locator('#pause').click();
    await waitFor(r.app, s => s.state === 'Paused' && !s.busy);
    const saved = (await r.app.snapshot()).job.manifest.images[0];
    assert.equal(saved.split, null, 'Rust確定画像でも表紙を分割しない');
    assert.deepEqual([saved.width, saved.height], [1200, 960]);
    // Align the reader to the next unsaved position before replacing the
    // cover fixture. Same-position/different-pixels must not authorize resume.
    const count = (await r.app.snapshot()).job.manifest.images.length;
    if (Number(await r.app.reader.page.locator('#reader').getAttribute('data-position')) === count) await r.app.reader.page.locator('#next').click();
    await r.app.reader.page.locator('#sheet').evaluate(canvas => canvas.getContext('2d').putImageData(window.savedSpread, 0, 0));
  });
  await ui.locator('#quickPreview').click(); await ui.locator('#previewImage').waitFor({ state: 'visible' });
  assert.match(await ui.locator('#previewInfo').textContent(), /分割境界 x=600 px/);
  assert.deepEqual(await ui.locator('#previewPages figcaption').allTextContents(), ['1枚目：右ページ 600×960 px', '2枚目：左ページ 600×960 px']);
  assert.deepEqual([r.app.previewImage.readUInt32BE(16), r.app.previewImage.readUInt32BE(20)], [1200, 960], 'プレビューは出力元PNGの画素寸法');

  await ui.locator('#readingDirection').selectOption('left_to_right');
  await waitFor(r.app, s => s.job.manifest.capture_settings.reading_direction === 'left_to_right');
  await ui.locator('#quickPreview').click(); await ui.locator('#previewImage').waitFor({ state: 'visible' });
  await ui.waitForFunction(() => document.querySelector('#previewInfo').textContent.includes('左→右')
    && [...document.querySelectorAll('#previewPages figcaption')].map(node => node.textContent).join('|')
      === '1枚目：左ページ 600×960 px|2枚目：右ページ 600×960 px');
  assert.deepEqual(await ui.locator('#previewPages figcaption').allTextContents(), ['1枚目：左ページ 600×960 px', '2枚目：右ページ 600×960 px']);
  assert.match(await ui.locator('#previewInfo').textContent(), /左→右/);
  await ui.locator('#previewConfirmed').check(); await ui.locator('#resumeConfirmed').check(); await ui.locator('#approve').click();
  await ui.waitForFunction(() => !document.querySelector('#start').disabled);
  await ui.locator('#start').click();
  await waitFor(r.app, s => s.job.manifest.images.length >= 2);
  await ui.locator('#stop').click();
  const stopped = await waitFor(r.app, s => s.state === 'Review' && !s.busy);
  const savedJobPath = stopped.job.job_path;
  await ui.locator('[data-stage-target="browser"]').first().click();
  await ui.locator('[data-stage="browser"] > details > summary').click();
  await ui.locator('#closeBrowser').click();
  await waitFor(r.app, s => !s.browserOpen && !s.busy);
  await ui.locator('[data-stage-target="setup"]').first().click();
  await ui.locator('[data-stage="setup"] details > summary').click();
  await ui.locator('#closeJob').click();
  await waitFor(r.app, s => !s.job && !s.busy);
  await ui.locator('#recoverPath').fill(savedJobPath); await ui.locator('#recover').click();
  await waitFor(r.app, s => s.job?.job_path === savedJobPath && !s.busy);
  assert.equal((await r.app.snapshot()).job.manifest.images[0].split, null, '公開UIの復帰でも画像ごとの単ページ判定を維持');
  await ui.locator('[data-stage-target="review"]').first().click(); await ui.locator('#review').click();
  await waitFor(r.app, s => s.state === 'Review' && !s.busy);
  const item = stopped.job.manifest.images[1];
  assert.equal(item.split.first_page, 'left');
  assert.equal(item.split.boundary_x, Math.floor(item.width / 2));
  assert.deepEqual([item.width, item.height, item.split.left.width, item.split.right.width], [1200, 960, 600, 600]);
  const original = await r.app.image(item.capture_id, true);
  for (const side of ['left', 'right']) {
    const page = PNG.sync.read(await r.app.image(item.capture_id, false, side));
    assert.deepEqual([page.width, page.height], [600, 960]);
  }
  assert.deepEqual(await r.app.image(item.capture_id, true), original, 'ページ分割後も原本を保持する');
  const coverOriginal = await r.app.image(1, true);
  await ui.locator('#cropId').fill('1'); await ui.locator('#cropX').fill('320'); await ui.locator('#cropY').fill('0');
  await ui.locator('#cropWidth').fill('560'); await ui.locator('#cropHeight').fill('960'); await ui.locator('#crop').click();
  await ui.waitForFunction(() => document.querySelector('#message').textContent !== '処理中…');
  assert.equal((await r.app.snapshot()).job.manifest.images[0].crop?.width, 560, await ui.locator('#message').textContent());
  await waitFor(r.app, s => s.job.manifest.images[0].crop?.width === 560);
  assert.equal((await r.app.snapshot()).job.manifest.images[0].split, null, '表紙クロップ後も単ページ');
  assert.deepEqual(await r.app.image(1, true), coverOriginal, 'クロップは原本を変更しない');

  await ui.locator('#decisionButton').click();
  const cbzPath = path.join(r.directory, 'spread.cbz');
  await ui.locator('#exportOptions > summary').click();
  await ui.locator('#format').selectOption('cbz');
  await ui.locator('#destination').fill(cbzPath);
  await ui.locator('#export').click();
  const cbzSnapshot = await waitFor(r.app, s => s.job.manifest.exports.length === 1);
  const cbz = await readFile(cbzPath);
  assert.equal(cbz.readUInt32LE(0), 0x04034b50);
  assert.equal(cbzSnapshot.job.manifest.exports[0].entry_count, 3);
  await ui.locator('#format').selectOption('zip');
  const zipPath = path.join(r.directory, 'spread.zip');
  await ui.locator('#destination').fill(zipPath); await ui.locator('#export').click();
  const zipSnapshot = await waitFor(r.app, s => s.job.manifest.exports.length === 2);
  const zip = await readFile(zipPath);
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  assert.equal(zipSnapshot.job.manifest.exports[1].entry_count, 3);
  for (const archive of [cbz, zip]) {
    const pages = [];
    for (let offset = 0; archive.readUInt32LE(offset) === 0x04034b50;) {
      assert.equal(archive.readUInt16LE(offset + 8), 0, '保存式ZIP');
      const size = archive.readUInt32LE(offset + 18);
      const start = offset + 30 + archive.readUInt16LE(offset + 26) + archive.readUInt16LE(offset + 28);
      pages.push(PNG.sync.read(archive.subarray(start, start + size)));
      offset = start + size;
    }
    assert.deepEqual(pages.map(p => [p.width, p.height]), [[560, 960], [600, 960], [600, 960]]);
    const center = (480 * pages[0].width + 280) * 4;
    assert.deepEqual([...pages[0].data.subarray(center, center + 3)], [199, 91, 56], '表紙中央画素をZIP/CBZから再読');
  }
});

test('MVPかんたん開始: 一意な自作画面は1操作でプレビューし複数候補は取得せず項目を案内する', async t => {
  const r = await setup(t);
  const control = await openControlWindow(r.url, { headless: true }); t.after(() => control.close());
  const ui = control.page;
  await ui.locator('#create').click(); await ui.locator('#openSample').click();
  await selectVisibleReaderTab(ui);
  assert.match(await ui.locator('#nextAction').textContent(), /決定・次へ.*プレビュー/);
  await ui.locator('#quickPreview').click(); await ui.locator('#previewImage').waitFor({ state: 'visible' });
  assert.equal((await r.app.snapshot()).job.manifest.images.length, 0, '自動プレビューだけでは取得しない');
  assert.equal(await ui.locator('#start').isDisabled(), true);
  await t.test('黒画像の失敗理由と次の確認操作を現在の表示領域に案内する', async () => {
    await ui.locator('#previewConfirmed').check(); await ui.locator('#approve').click();
    await ui.waitForFunction(() => !document.querySelector('#start').disabled);
    await r.app.reader.page.locator('#sheet').evaluate(canvas => {
      const ctx = canvas.getContext('2d'); window.beforeBlackPreview = ctx.getImageData(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    });
    try {
      await ui.locator('#quickPreview').click();
      await ui.waitForFunction(() => document.querySelector('#state').textContent.includes('プレビュー検査失敗'));
      const snapshot = await r.app.snapshot();
      assert.equal(snapshot.displayInspection.code, 'black_image');
      assert.equal(snapshot.previewReady, false); assert.equal(snapshot.previewApproved, false);
      assert.equal(snapshot.job.manifest.images.length, 0);
      assert.equal(await ui.locator('#start').isDisabled(), true);
      assert.match(await ui.locator('#message').textContent(), /黒.*専用ブラウザ.*ページ画像.*確認/);
      assert.match(await ui.locator('#nextAction').textContent(), /専用ブラウザ.*ページ画像.*確認/);
      assert.equal(await ui.locator('#message').evaluate(el => {
        const box = el.getBoundingClientRect(); return box.top >= 0 && box.bottom <= innerHeight;
      }), true, '画面最上部へ戻らなくても理由と次操作を読める');
    } finally {
      await r.app.reader.page.locator('#sheet').evaluate(canvas => canvas.getContext('2d').putImageData(window.beforeBlackPreview, 0, 0));
    }
  });
  await t.test('4項目指定後も固定描画は非包含overflow親で消えない', async () => {
    await r.app.reader.page.locator('#sheet').evaluate(canvas => {
      const box = canvas.getBoundingClientRect();
      const wrapper = document.createElement('div'); wrapper.id = 'non-containing-overflow';
      wrapper.style.cssText = 'width:0;height:0;overflow:hidden';
      canvas.before(wrapper); wrapper.append(canvas);
      canvas.style.cssText = `position:fixed;left:${box.x}px;top:${box.y}px;width:600px;height:480px`;
    });
    await openManualOptions(ui);
    assert.match(await ui.locator('#mappingStatus').textContent(), /4 \/ 4/);
    await ui.locator('#preview').click(); await waitForPublicPreview(ui);
    await ui.waitForFunction(() => document.querySelector('#message').textContent.includes('プレビューを表示しました'));
    assert.deepEqual((await r.app.snapshot()).previewInfo.dimensions, [1200, 960]);
    await r.app.reader.page.locator('#non-containing-overflow').evaluate(wrapper => { wrapper.style.transform = 'translate(0px)'; });
    await ui.locator('#preview').click();
    await ui.waitForFunction(() => document.querySelector('#message').textContent.includes('empty_visible_bounds'));
    assert.equal((await r.app.snapshot()).previewReady, false, '固定包含ブロックの実クリップは引き続き拒否');
    await r.app.reader.page.locator('#sheet').evaluate(canvas => {
      const wrapper = canvas.parentElement; wrapper.before(canvas); wrapper.remove();
      canvas.style.cssText = 'width:600px;height:480px';
    });
  });
  await r.app.reader.page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.id = 'second-visible-reader';
    canvas.width = 200; canvas.height = 120;
    canvas.style.cssText = 'position:fixed;left:800px;top:650px;width:200px;height:120px';
    document.body.append(canvas);
  });
  await ui.locator('#quickPreview').click();
  await ui.waitForFunction(() => document.querySelector('#message').textContent.includes('読書領域'));
  const message = await ui.locator('#message').textContent();
  assert.match(message, /読書領域/);
  assert.match(message, /複数の候補/);
  assert.match(message, /取得は始めていません/);
  assert.equal(await ui.locator('#previewImage').isVisible(), false);
  assert.equal(await ui.locator('#start').isDisabled(), true);
  assert.equal((await r.app.snapshot()).job.manifest.images.length, 0);
  await openManualOptions(ui);
  assert.equal(await ui.locator('#pickAll').isEnabled(), true, '一意でない場合に詳細指定へ復帰できる');
});
