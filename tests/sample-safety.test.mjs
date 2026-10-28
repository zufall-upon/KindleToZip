import './chromium-test-log-sink.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { PNG } from 'pngjs';
import { SampleProbe } from '../poc/browser/probe.mjs';

const digest = data => createHash('sha256').update(data).digest('hex');
async function withProbe(t, ready = true) {
  const probe = await SampleProbe.open();
  t.after(() => probe.close());
  if (ready) {
    await probe.preview();
    probe.approvePreview(true);
    await probe.start(true);
  }
  return probe;
}
async function fails(promise, code) {
  await assert.rejects(promise, error => error.code === code);
}

test('プレビューは保存せず、承認と明示開始の両方が必要', async t => {
  const p = await withProbe(t, false);
  await fails(p.capture(), 'wrong_state');
  assert.throws(() => p.approvePreview(true), { code: 'confirmation_required' });
  const preview = await p.preview();
  assert.equal(PNG.sync.read(preview.png).width, 600);
  assert.deepEqual(await readdir(p.directory), []);
  assert.throws(() => p.approvePreview(false), { code: 'confirmation_required' });
  p.approvePreview(true);
  await fails(p.capture(), 'wrong_state');
  await fails(p.start(false), 'wrong_state');
  await p.start(true);
  assert.equal(p.state, 'Capturing');
});

test('撮影単独：位置を変えずPNG寸法・ハッシュが一致する', async t => {
  const p = await withProbe(t);
  const before = await p.read();
  const image = await p.capture();
  assert.equal((await p.read()).position, before.position);
  assert.equal(p.advanceRequests, 0);
  const bytes = await readFile(path.join(p.directory, image.file));
  assert.equal(digest(bytes), image.sha256);
  const png = PNG.sync.read(bytes, { checkCRC: true });
  assert.deepEqual([png.width, png.height], [600, 480]);
});

test('送り単独：確定済み画面から1回だけ進み、画像を作らない', async t => {
  const p = await withProbe(t);
  await p.capture();
  const beforeFiles = await readdir(p.directory);
  const captures = p.captureRequests;
  await p.advance();
  assert.equal((await p.read()).position, 2);
  assert.equal(p.advanceRequests, 1);
  assert.equal(p.captureRequests, captures);
  assert.deepEqual(await readdir(p.directory), beforeFiles);
});

test('未確定なら送らず、失敗を確認待ちにする', async t => {
  const p = await withProbe(t);
  await fails(p.advance(), 'capture_required');
  assert.equal(p.advanceRequests, 0);
  assert.equal(p.state, 'NeedsAttention');
});

for (const [control, code] of [['logout', 'auth_required'], ['other-book', 'target_changed'], ['overlay', 'target_changed']]) {
  test(`${control}：新規保存・送りを止め、既存画像は保つ`, async t => {
    const p = await withProbe(t);
    const image = await p.capture();
    const original = await readFile(path.join(p.directory, image.file));
    await p.page.locator(`#${control}`).click();
    await fails(p.capture(), code);
    assert.equal(p.state, 'NeedsAttention');
    await fails(p.advance(), 'wrong_state');
    assert.deepEqual(await readFile(path.join(p.directory, image.file)), original);
    assert.equal(p.images.length, 1);
    assert.equal(p.advanceRequests, 0);
  });
}

test('撮影途中の対象変更：PNGを永続化しない', async t => {
  const p = await withProbe(t);
  const screenshot = p.page.screenshot.bind(p.page);
  p.page.screenshot = async options => {
    const data = await screenshot(options);
    await p.page.locator('#logout').click();
    return data;
  };
  await fails(p.capture(), 'auth_required');
  assert.equal(p.images.length, 0);
  assert.deepEqual(await readdir(p.directory), []);
});

test('無変化の送りは終端成功にせず、送り直さない', async t => {
  const p = await withProbe(t);
  await p.capture();
  await p.page.locator('#stall').click();
  await fails(p.advance(), 'advance_uncertain');
  assert.equal(p.state, 'NeedsAttention');
  assert.equal(p.reason, 'advance_uncertain');
  await fails(p.advance(), 'wrong_state');
  assert.equal(p.advanceRequests, 1);
  assert.equal(p.images.length, 1);
});

test('白紙候補と同一候補は削除せず、人の確認待ち', async t => {
  const p = await withProbe(t);
  const first = await p.capture();
  await p.page.locator('#duplicate').click();
  await p.advance();
  const second = await p.capture();
  assert.equal(first.sha256, second.sha256);
  assert.deepEqual(second.flags, ['duplicate_candidate']);
  assert.equal(p.state, 'NeedsAttention');
  assert.equal((await readdir(p.directory)).length, 2);

  const blank = await withProbe(t);
  await blank.page.locator('#blank').click();
  const image = await blank.capture();
  assert.deepEqual(image.flags, ['blank_candidate']);
  assert.equal(blank.state, 'NeedsAttention');
  assert.equal((await readdir(blank.directory)).length, 1);
});

test('黒画面・撮影例外を成功扱いせず、送りも保存もしない', async t => {
  const black = await withProbe(t);
  await black.page.locator('#black').click();
  await fails(black.capture(), 'capture_rejected');
  assert.equal(black.state, 'NeedsAttention');
  assert.deepEqual(await readdir(black.directory), []);

  const failure = await withProbe(t);
  failure.page.screenshot = async () => { throw new Error('secret-test-DO-NOT-LOG'); };
  await fails(failure.capture(), 'operation_failed');
  assert.equal(failure.reason, 'operation_failed');
  assert.equal(failure.advanceRequests, 0);
  assert.equal(JSON.stringify(failure.receipt()).includes('secret-test'), false);
});

test('一時停止・停止で新規操作を拒否し、復帰に位置確認と明示開始が必要', async t => {
  const p = await withProbe(t);
  await p.capture();
  p.pause();
  await fails(p.capture(), 'wrong_state');
  await fails(p.advance(), 'wrong_state');
  await p.confirmResume(true);
  assert.equal(p.state, 'Ready');
  await fails(p.capture(), 'wrong_state');
  await p.start(true);
  await p.advance();
  p.stop();
  await fails(p.capture(), 'wrong_state');
  await fails(p.advance(), 'wrong_state');
  assert.equal(p.images.length, 1);
});

test('停止中の位置変化は自動復帰しない', async t => {
  const p = await withProbe(t);
  await p.capture();
  p.pause();
  await p.page.locator('#next').click();
  await fails(p.confirmResume(true), 'target_changed');
  assert.equal(p.state, 'NeedsAttention');
});

test('撮影中の停止は未確定画像を保存せず、並列操作も拒否', async t => {
  const p = await withProbe(t);
  const screenshot = p.page.screenshot.bind(p.page);
  p.page.screenshot = async options => {
    await fails(p.advance(), 'busy');
    p.stop();
    return screenshot(options);
  };
  await fails(p.capture(), 'cancelled');
  assert.equal(p.state, 'Review');
  assert.deepEqual(await readdir(p.directory), []);
});

for (const [operation, expectedState] of [['stop', 'Review'], ['pause', 'Paused']]) {
  test(`書込み完了待ちの${operation}：未確定画像を加えず既存画像を保つ`, async t => {
    const p = await withProbe(t);
    const first = await p.capture();
    const original = await readFile(path.join(p.directory, first.file));
    await p.advance();
    const pending = path.join(p.directory, '000002.png');
    const originalWrite = fs.promises.writeFile;
    let interrupted = false;
    t.mock.method(fs.promises, 'writeFile', async (...args) => {
      const result = await originalWrite(...args);
      if (args[0] === pending) {
        assert.equal(p.images.length, 1);
        p[operation]();
        interrupted = true;
      }
      return result;
    });
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });

    await fails(p.capture(), 'cancelled');
    assert.equal(interrupted, true);
    assert.equal(p.state, expectedState);
    assert.deepEqual(p.images, [first]);
    assert.equal(p.lastCapturedPosition, 1);
    assert.deepEqual(await readdir(p.directory), [first.file]);
    assert.deepEqual(await readFile(path.join(p.directory, first.file)), original);
    if (operation === 'pause') {
      await p.confirmResume(true);
      await p.start(true);
      await fails(p.advance(), 'capture_required');
    } else {
      await fails(p.advance(), 'wrong_state');
    }
    assert.equal(p.advanceRequests, 1);
  });
}

test('別タブ・表示条件変更を検出する', async t => {
  const tab = await withProbe(t);
  await tab.context.newPage();
  assert.equal(tab.state, 'NeedsAttention');
  await fails(tab.capture(), 'wrong_state');

  const resized = await withProbe(t);
  await resized.page.setViewportSize({ width: 1100, height: 800 });
  await fails(resized.capture(), 'target_changed');
  assert.equal(resized.images.length, 0);
});

test('外部へのページ要求を遮断する（外部へ接続しない）', async t => {
  const p = await withProbe(t, false);
  let failureCode;
  p.page.on('requestfailed', request => {
    if (request.url() === 'https://example.invalid/') failureCode = request.failure()?.errorText;
  });
  await assert.rejects(p.page.goto('https://example.invalid/'));
  assert.equal(failureCode, 'net::ERR_BLOCKED_BY_CLIENT');
});

test('画像名競合時は上書きせず、既存ファイルを保護する', async t => {
  const p = await withProbe(t);
  const existing = path.join(p.directory, '000001.png');
  await writeFile(existing, 'existing-output', { flag: 'wx' });
  await fails(p.capture(), 'operation_failed');
  assert.equal(await readFile(existing, 'utf8'), 'existing-output');
  assert.equal(p.images.length, 0);
  assert.equal(p.advanceRequests, 0);
});

test('公開PoCコマンド：12画面が順番どおり、終端は未確認の候補', () => {
  const run = spawnSync(process.execPath, ['--import', new URL('./chromium-test-log-sink.mjs', import.meta.url).href, 'poc/browser/demo.mjs'], { encoding: 'utf8', timeout: 45000 });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /終端は候補/);
  const receipt = JSON.parse(run.stdout.trim().split(/\r?\n/).at(-1));
  assert.deepEqual(receipt.images.map(image => image.position), Array.from({ length: 12 }, (_, i) => i + 1));
  assert.equal(new Set(receipt.images.map(image => image.sha256)).size, 12);
  assert.equal(receipt.captureRequests, 12);
  assert.equal(receipt.advanceRequests, 11);
  assert.equal(receipt.state, 'NeedsAttention');
  assert.equal(receipt.reason, 'end_candidate');
  assert.equal(receipt.kindle, 'not-tested');
  assert.equal(receipt.windowsNonInterference, 'not-tested');
});
