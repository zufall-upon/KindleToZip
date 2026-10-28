import assert from 'node:assert/strict';
import { readFile, readdir, lstat, realpath } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

// Read-only validation of the already executed public-UI observations. Never
// opens a browser, reads a Cookie store, captures a page, or starts acquisition.
const started = performance.now();
const directory = 'artifacts/portable-repair';
const json = async name => JSON.parse(await readFile(`${directory}/${name}.json`, 'utf8'));
const [before, after, finalUi, restart, pixelsBefore, pixelsAfter, bookBefore, bookAfter] = await Promise.all([
  'live-before-restart', 'live-after-restart', 'live-final-ui', 'live-normal-restart',
  'live-pixels-before', 'live-pixels-after', 'live-book-before', 'live-book-after-preview',
].map(json));
const report = JSON.parse(await readFile('artifacts/releases/KindleToZip-Portable-0.1.0-c40da59a2c77-f304581e5364.json', 'utf8'));
assert.equal(report.executableSha256, 'f304581e5364114a77239bc7ddbe3b28372bcd55f114ad1faae926894862392f');
assert.equal(restart.executable, `_testenv/${report.executable}`);
assert.equal(restart.executableSha256, report.executableSha256);
const digest = createHash('sha256');
for await (const bytes of createReadStream(restart.executable)) digest.update(bytes);
assert.equal(digest.digest('hex'), report.executableSha256, 'Actual deployed EXE differs from the observed candidate');

for (const observation of [before, after, finalUi]) {
  assert.match(observation.message, /^プレビューを表示しました。/);
  assert.match(observation.previewInfo, /1100×850 CSS px → 元PNG 2200×1700 px（画面密度 2倍）。出力は表示範囲の1枚/);
  assert.equal(observation.startDisabled, true);
  assert.equal(observation.approvalDisabled, true);
  assert.equal(observation.imagesTitlesCredentialsCollected, false);
  assert.deepEqual(observation.mappingsReady, ['reader', 'identity', 'position', 'next'].map(field => ({ field, selected: true })));
}
assert.equal(before.action, 'Preview');
assert.equal(after.action, 'Preview');
assert.equal(finalUi.action, 'Inspect');
for (const field of ['normalWindowClose', 'oldLauncherExited', 'oldReaderExited', 'samePersistentProfile',
  'profileSurvivedNormalClose', 'existingJobsImagesOutputsUnchanged', 'sessionPreferencesUnchanged']) assert.equal(restart[field], true, field);
for (const field of ['loginPromptVisibleAfterRestart', 'passwordPromptVisibleAfterRestart', 'authenticationPerformed',
  'acquisitionStarted', 'pageAdvanced', 'rawProfileCredentialsOrBookDataEmitted']) assert.equal(restart[field], false, field);
assert.ok(restart.oldLauncherExitCode === null || restart.oldLauncherExitCode === 0);
assert.ok(Date.parse(before.observedAtUtc) < Date.parse(restart.observedAtUtc));
assert.ok(Date.parse(restart.observedAtUtc) < Date.parse(after.observedAtUtc));
assert.ok(Date.parse(after.observedAtUtc) < Date.parse(finalUi.observedAtUtc));
for (const pixels of [pixelsBefore, pixelsAfter]) {
  assert.equal(pixels.loaded, true);
  assert.deepEqual([pixels.width, pixels.height], [2200, 1700]);
  assert.equal(pixels.centralNonBlank, true);
  assert.equal(pixels.centralNotAllBlack, true);
  assert.equal(pixels.rawPixelsEmitted, false);
  assert.equal(pixels.titlesCredentialsCollected, false);
}
for (const book of [bookBefore, bookAfter]) {
  assert.equal(book.ready, true);
  assert.equal(book.titleVisible, true);
  assert.equal(book.positionVisible, true);
  assert.equal(book.rawTitlePositionUrlEmitted, false);
  assert.equal(book.credentialsRead, false);
  // Keep private opaque comparison values out of diagnostics, including errors.
  assert.ok(typeof book.bookPositionDigest === 'string' && /^[a-f0-9]{64}$/.test(book.bookPositionDigest));
}
assert.ok(bookBefore.bookPositionDigest === bookAfter.bookPositionDigest, 'Visible book/position changed across restart and preview');

let sourceFiles = 0;
async function compareRuntime(directory = 'app') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const source = `${directory}/${entry.name}`;
    if (entry.isDirectory()) await compareRuntime(source);
    else {
      assert.ok(entry.isFile());
      const runtime = `_testenv/runtime/0.1.0-${report.payloadSha256.slice(0, 12)}/${source}`;
      const info = await lstat(runtime);
      assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1);
      assert.equal(path.resolve(await realpath(runtime)).toLowerCase(), path.resolve(runtime).toLowerCase());
      assert.deepEqual(await readFile(runtime), await readFile(source), `Runtime differs from current app: ${source}`);
      sourceFiles += 1;
    }
  }
}
await compareRuntime();
console.log('実Portable公開UI: 実書籍プレビューが終了前後とも2200×1700 PNG・2倍・単画像で表示されました。');
console.log('同じ保存profile・同じ本と位置・再認証なし・原本/出力保持・承認/開始なしを照合しました。');
console.log(`実配置EXEと実測対象runtimeのapp ${sourceFiles}ファイルが現在ソースと一致。画像・書名・認証情報は出力していません。`);
console.log(`通常の操作画面を閉じた後のプロセス終了を観測。旧EXE exit code: ${restart.oldLauncherExitCode === null ? '未取得' : '0'}。`);
console.log(`読取専用照合: ${((performance.now() - started) / 1000).toFixed(3)}秒。実UI操作の再実行ではありません。`);
