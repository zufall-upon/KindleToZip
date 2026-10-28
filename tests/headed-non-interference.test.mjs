import './chromium-test-log-sink.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { SampleProbe } from '../poc/browser/probe.mjs';
import { RustGuard, GuardedSample } from '../poc/browser/rust-guard.mjs';
const { chromium } = await import('playwright');

async function browserPid(browser) {
  const session = await browser.newBrowserCDPSession();
  try {
    const result = await session.send('SystemInfo.getProcessInfo');
    return result.processInfo.find(process => process.type === 'browser').id;
  } finally { await session.detach(); }
}

function sanitized(observation) {
  return Object.fromEntries(Object.entries(observation).filter(([key]) => !['initial', 'last'].includes(key)));
}

function assertNoInterference(observation) {
  assert.ok(observation.samples > 1);
  assert.equal(observation.missing_foreground_samples, 0, '前景を観測できない状態は合格にしない');
  assert.equal(observation.missing_cursor_samples, 0, 'カーソルを観測できない状態は合格にしない');
  assert.equal(observation.foreground_changes, 0, '測定中に前景変化を観測した');
  assert.equal(observation.cursor_changes, 0, '測定中にカーソル変化を観測した');
}

test('通常表示・覆った状態でRustと結合し、撮影と送りを別々に受動観測', { timeout: 90000 }, async t => {
  const guard = new RustGuard();
  t.after(() => guard.close());
  const sample = await SampleProbe.open({ headless: false });
  t.after(() => sample.close());
  const targetPid = await browserPid(sample.browser);
  const { window: target } = await guard.request({ kind: 'window_for_process', pid: targetPid });
  assert.ok(target && !target.minimized, '通常表示の試料ウィンドウが必要');
  const bridge = new GuardedSample(sample, guard);
  bridge.requireVisibleWindow(targetPid);
  await bridge.approveAndStart();

  // A second, owned visible browser provides a harmless cover window. No
  // bringToFront/OS input/focus APIs are used, including during setup.
  const coverBrowser = await chromium.launch({ headless: false, args: ['--window-position=20,20', '--window-size=1200,950'] });
  t.after(() => coverBrowser.close());
  const coverContext = await coverBrowser.newContext({ viewport: { width: 1100, height: 850 }, serviceWorkers: 'block', acceptDownloads: false });
  await coverContext.route('**/*', route => route.abort('blockedbyclient'));
  const coverPage = await coverContext.newPage();
  await coverPage.setContent('<!doctype html><html lang="ja"><meta charset="utf-8"><title>G02 自作の覆い試料</title><h1>別ウィンドウの自作入力試料</h1><textarea id="dummy"></textarea><button id="counter">試験</button><output id="count">0</output></html>');
  await coverPage.locator('#counter').evaluate(element => element.addEventListener('click', () => {
    const counter = document.querySelector('#count'); counter.textContent = String(Number(counter.textContent) + 1);
  }));
  const coverPid = await browserPid(coverBrowser);
  const { window: cover } = await guard.request({ kind: 'window_for_process', pid: coverPid });
  assert.ok(cover && !cover.minimized);
  const covered = cover.rect[0] <= target.rect[0] && cover.rect[1] <= target.rect[1]
    && cover.rect[2] >= target.rect[2] && cover.rect[3] >= target.rect[3];
  assert.ok(covered, `覆いの範囲不足 target=${target.rect} cover=${cover.rect}`);
  assert.equal((await guard.request({ kind: 'window_above', higher: cover.handle, lower: target.handle })).above, true,
    '実際のZ順で試料が覆われていない状態は合格にしない');
  // Browser opening is setup, not part of the non-interference measurement.
  await new Promise(resolve => setTimeout(resolve, 300));
  const captures = [];
  const advances = [];
  const positions = [];
  try {
    for (let i = 1; i <= 12; i += 1) {
      const initial = (await guard.request({ kind: 'snapshot' })).snapshot;
      assert.notEqual(initial.foreground, target.handle, '対象が前景のままでは背景検証にならない');
      await guard.request({ kind: 'observe_start' });
      const image = await bridge.capture();
      const captureObservation = (await guard.request({ kind: 'observe_stop' })).observation;
      captures.push(sanitized(captureObservation));
      assertNoInterference(captureObservation);
      assert.equal((await sample.read()).position, i, '撮影がページ位置を変えていない');
      positions.push(image.position);

      // Scoped DOM input into an owned dummy window, not physical OS input.
      // It cannot stand in for a human typing into an unrelated application.
      await coverPage.locator('#dummy').fill(`sample-${i}`);
      await coverPage.locator('#counter').click();
      const imagesBefore = sample.images.length;
      await guard.request({ kind: 'observe_start' });
      const result = await bridge.advance();
      const advanceObservation = (await guard.request({ kind: 'observe_stop' })).observation;
      advances.push(sanitized(advanceObservation));
      assertNoInterference(advanceObservation);
      assert.equal(sample.images.length, imagesBefore, '送りは撮影・保存しない');
      assert.equal(await coverPage.locator('#dummy').inputValue(), `sample-${i}`);
      assert.equal(await coverPage.locator('#count').textContent(), String(i));
      if (i < 12) assert.equal(result.position, i + 1);
      else assert.equal(result.endCandidate, true);
    }
    assert.deepEqual(positions, Array.from({ length: 12 }, (_, i) => i + 1));
    assert.equal(sample.state, 'NeedsAttention');
    assert.equal((await guard.request({ kind: 'state' })).state, 'NeedsAttention');
  } finally {
    // No HWND, PID, cursor coordinate, title or input content in the receipt.
    await writeFile(path.join(sample.directory, 'headed-receipt.json'), JSON.stringify({
      schemaVersion: 1, scope: 'self-authored-headed-only', browser: sample.browser.version(),
      rustNodeConnected: true, covered, captures, advances, positions,
      state: sample.state, reason: sample.reason,
      physicalHumanInput: 'not-tested', minimizeLockSleep: 'not-tested', kindle: 'not-tested',
      samplesArePeriodicNotEventComplete: true,
    }, null, 2) + '\n', { flag: 'wx' });
  }
});

test('通常表示：最小化で新規撮影・送りを止め、確定済み画像を保護', { timeout: 30000 }, async t => {
  const guard = new RustGuard();
  t.after(() => guard.close());
  const sample = await SampleProbe.open({ headless: false });
  t.after(() => sample.close());
  const pid = await browserPid(sample.browser);
  const bridge = new GuardedSample(sample, guard);
  bridge.requireVisibleWindow(pid);
  await bridge.approveAndStart();
  const first = await bridge.capture();
  const original = await readFile(path.join(sample.directory, first.file));
  const session = await sample.context.newCDPSession(sample.page);
  t.after(() => session.detach().catch(() => {}));
  const { windowId } = await session.send('Browser.getWindowForTarget');
  await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
  let window;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    ({ window } = await guard.request({ kind: 'window_for_process', pid }));
    if (window?.minimized) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(window?.minimized, true, '対象の専用ウィンドウだけを最小化したことが必要');
  await assert.rejects(bridge.capture(), error => error.code === 'window_not_available');
  await assert.rejects(bridge.advance());
  assert.equal(sample.captureRequests, 1);
  assert.equal(sample.advanceRequests, 0);
  assert.equal(sample.state, 'NeedsAttention');
  assert.equal((await guard.request({ kind: 'state' })).state, 'NeedsAttention');
  assert.deepEqual(await readFile(path.join(sample.directory, first.file)), original);
  assert.deepEqual(await readdir(sample.directory), [first.file]);
});

test('Rust結合経路：撮影中の停止を2秒以内に反映して未確定画像を保存しない', { timeout: 30000 }, async t => {
  const guard = new RustGuard();
  t.after(() => guard.close());
  const sample = await SampleProbe.open({ headless: false });
  t.after(() => sample.close());
  const bridge = new GuardedSample(sample, guard);
  bridge.requireVisibleWindow(await browserPid(sample.browser));
  await bridge.approveAndStart();
  const screenshot = sample.page.screenshot.bind(sample.page);
  let stoppedAt;
  sample.page.screenshot = async options => {
    stoppedAt = performance.now();
    await bridge.stop();
    return screenshot(options);
  };
  await assert.rejects(bridge.capture(), error => error.code === 'cancelled');
  assert.ok(performance.now() - stoppedAt < 2000);
  assert.equal(sample.state, 'Review');
  assert.equal((await guard.request({ kind: 'state' })).state, 'Review');
  assert.deepEqual(await readdir(sample.directory), []);
});
