import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

// 保存済みの実EXE試験を再実行せず、対象現物・現在の内包コードとの対応を確認する。
const started = performance.now();
const [reportPath, smokePath, windowPath] = process.argv.slice(2);
const headlessOnly = windowPath === '--headless-only';
assert.ok(reportPath && smokePath && windowPath,
  'ビルド報告・スモーク結果・通常画面結果JSONまたは--headless-onlyを指定してください');
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const [report, smoke] = await Promise.all([reportPath, smokePath].map(json));
const windowResult = headlessOnly ? null : await json(windowPath);
const repairUi = windowResult?.publicEntrypoint === 'Portable EXE / app/main.mjs / UIAutomation InvokePattern';
const executable = report.executablePath;
assert.equal(report.portable, true);
assert.equal(path.basename(executable), report.executable);
assert.equal((await stat(executable)).size, report.executableBytes);
async function hash(file, start, end) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file, start === undefined ? {} : { start, end })) digest.update(chunk);
  return digest.digest('hex');
}
assert.equal(await hash(executable), report.executableSha256, 'EXE SHA-256');
for (const result of headlessOnly || repairUi ? [smoke] : [smoke, windowResult]) {
  assert.equal(result.executable, executable, '試験対象EXE');
  assert.equal(result.executableSha256, report.executableSha256, '試験対象hash');
  assert.equal(result.exitCode, 0);
  assert.equal(result.developerPathToolsAvailable, false);
  assert.equal(result.cleanWindowsTested, false);
  assert.equal(result.runtimeAndTempCurrentUserOnly, true);
}
assert.equal(report.cleanWindowsTested, false);
assert.equal(smoke.firstLaunch.result, 'pass');
assert.equal(smoke.firstLaunch.capturedImages, 2);
assert.deepEqual(smoke.firstLaunch.pngDimensions, [1200, 960]);
assert.deepEqual(smoke.firstLaunch.selectedCaptureIds, [2, 1]);
assert.equal(smoke.firstLaunch.relativeManifestPaths, true);
assert.equal(smoke.firstLaunch.temporaryReaderProfileRemoved, true);
assert.deepEqual(smoke.firstLaunch.portableDirectories, ['runtime', 'data', 'temp']);
assert.equal(smoke.wholeFolderMove.oldTreeAbsentOnRestart, true);
const resumed = smoke.wholeFolderMove.resumed;
assert.equal(resumed.result, 'pass');
assert.equal(resumed.jobId, smoke.firstLaunch.jobId);
assert.equal(resumed.savedProfileId, smoke.firstLaunch.savedProfileId);
assert.equal(resumed.capturedImagesReused, 2);
assert.deepEqual(resumed.persistedOrder, [2, 1]);
assert.deepEqual(resumed.settingsReused, {
  capture_scale: 2, page_output_mode: 'split_spread', reading_direction: 'right_to_left',
});
assert.equal(resumed.savedProfileCookieReused, true);
assert.equal(resumed.relativeManifestPaths, true);
assert.equal(resumed.automaticResumeOrCapture, false);
assert.equal(resumed.developerPathToolsAvailable, false);
for (const result of [smoke.firstLaunch, resumed]) {
  assert.equal(result.zipEntries, 4);
  assert.equal(result.cbzEntries, 4);
}
assert.match(smoke.exclusiveDataLock, /job_busy/);
assert.match(smoke.writeDenied, /ACL denial rejected launch with Japanese move-the-folder guidance/);
assert.equal(smoke.existingExplicitSharedGrantsRemovedOnReuse, true);
assert.deepEqual(smoke.intermediateRuntimeJunctionsRejected, ['node', 'app', 'node_modules/playwright-core/lib']);
assert.equal(smoke.redirectPathsUnused, true);
if (headlessOnly) {
  assert.equal(smoke.firstLaunch.headlessOnly, true, '通常画面試験への読み替えをしない');
  assert.deepEqual(smoke.firstLaunch.publicPreviews.map(({ publicFlow, ...preview }) => preview), ['kindle-preset', 'automatic', 'picker'].map(mode => ({
    mode, dimensions: [1120, 720], approved: false, capturedImages: 0,
  })), '実EXE公開UIの自動判別と通常pickerの両方で承認前プレビューを確認する');
  assert.deepEqual(smoke.firstLaunch.publicPreviews[0].publicFlow, { presetSelected: true, approved: true, explicitlyStarted: true,
    safetyStopped: true, zipReopened: true, entryDimensions: [1120, 720] }, '公開プリセットから本人承認相当・明示開始・安全停止・ZIP保存までの同梱実測');
} else if (repairUi) {
  assert.equal(windowResult.executable, `_testenv/${report.executable}`);
  assert.equal(windowResult.executableSha256, report.executableSha256);
  assert.equal(await hash(windowResult.executable), report.executableSha256, '実配置EXEのhash');
  for (const field of ['sameProfileAfterNormalRestart', 'originalJobsOutputsAndExecutablesUnchanged', 'sampleIsNotActualAmazonVerification']) {
    assert.equal(windowResult[field], true, field);
  }
  for (const field of ['acquisitionStarted', 'pageAdvanced', 'authenticationPerformed', 'imagesTitlesAndCredentialsCollected']) {
    assert.equal(windowResult[field], false, field);
  }
  assert.match(windowResult.samplePublicUiPreview, /600×480 CSS px → 元PNG 1200×960 px（画面密度 2倍）。出力は表示範囲の1枚/);
  assert.deepEqual(windowResult.actualAmazon, [1, 2].map(pass => ({
    pass, normalLaunch: true, persistentProfile: true, amazonLogin: 'required', realReaderPreview: 'blocked-authentication',
  })), '本人認証待ちの実測を保存し、実Kindle成功には読み替えない');
  console.log('過去の実Portable公開UI観測: profile/試料プレビュー一致。当時はblocked-authentication。本人操作後の実本結果は別記録で照合します。');
} else {
  for (const field of ['copiedIntoPortableTestTree', 'normalWindowClose',
  'redirectedLegacyAndProfilePathsUnused', 'controlWindowTempObservedBelowPortableTree',
  'controlWindowTempRemovedAfterClose', 'controlWindowCacheStayedBelowPortableTree', 'sharedParentAclFixture']) {
    assert.equal(windowResult[field], true, field);
  }
  assert.deepEqual(windowResult.arguments, []);
  assert.equal(windowResult.bookJobCreated, false);
  assert.equal(windowResult.readerSessionOpened, false);
}

const file = await open(executable, 'r');
try {
  async function bytes(offset, length) {
    const buffer = Buffer.alloc(length);
    let received = 0;
    while (received < length) {
      const result = await file.read(buffer, received, length - received, offset + received);
      assert.ok(result.bytesRead > 0, 'EXE内包データの途中終了');
      received += result.bytesRead;
    }
    return buffer;
  }
  const footer = await bytes(report.executableBytes - 56, 56);
  assert.equal(footer.subarray(0, 8).toString('ascii'), 'KTZEND01');
  const stubLength = Number(footer.readBigUInt64LE(8));
  const payloadLength = Number(footer.readBigUInt64LE(16));
  assert.equal(stubLength, report.launcherStubBytes);
  assert.equal(payloadLength, report.payloadBytes);
  assert.equal(stubLength + payloadLength + 56, report.executableBytes);
  assert.equal(footer.subarray(24).toString('hex'), report.payloadSha256);
  assert.equal(await hash(executable, stubLength, stubLength + payloadLength - 1), report.payloadSha256);
  assert.equal(await hash(executable, 0, stubLength - 1),
    await hash('artifacts/toolchains/launcher-target/release/kindle-to-zip-launcher.exe'), 'launcher開発出力');

  const sources = new Map();
  async function addDirectory(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = `${directory}/${entry.name}`;
      if (relative === 'poc/fixtures/RIGHTS.md') continue;
      if (entry.isDirectory()) await addDirectory(relative);
      else {
        assert.equal(entry.isFile(), true, `通常ファイルのみ: ${relative}`);
        sources.set(relative, relative);
      }
    }
  }
  await addDirectory('app');
  for (const relative of ['poc/browser/fixture-server.mjs', 'poc/fixtures/reader.html',
    'poc/fixtures/reader.css', 'poc/fixtures/reader.js', 'poc/launcher/smoke.mjs']) sources.set(relative, relative);
  if (headlessOnly) {
    sources.set('poc/browser/public-ui-controls.mjs', 'poc/browser/public-ui-controls.mjs');
    await addDirectory('poc/fixtures');
    assert.deepEqual([...smoke.sourceMatched].sort(), [...sources.keys()].sort(), '実EXE試験で照合したapp/全試料/runnerの集合');
  }
  sources.set('controller/ktz-g02-controller.exe', 'artifacts/rust-target/release/ktz-g02-controller.exe');
  const expectedCount = sources.size;
  const header = await bytes(stubLength, 12);
  assert.equal(header.subarray(0, 8).toString('ascii'), 'KTZBNDL1');
  let offset = stubLength + 12;
  const seen = new Set();
  for (let i = 0; i < header.readUInt32LE(8); i += 1) {
    const metadata = await bytes(offset, 10);
    const nameLength = metadata.readUInt16LE(0);
    const length = Number(metadata.readBigUInt64LE(2));
    assert.ok(nameLength > 0 && nameLength <= 4096);
    assert.ok(Number.isSafeInteger(length) && length >= 0);
    const name = (await bytes(offset + 10, nameLength)).toString('utf8');
    assert.ok(!seen.has(name), `内包パス重複: ${name}`);
    seen.add(name);
    offset += 10 + nameLength;
    assert.ok(offset + length <= stubLength + payloadLength, 'payload境界');
    if (sources.has(name)) {
      assert.deepEqual(await bytes(offset, length), await readFile(sources.get(name)), `内包コード不一致: ${name}`);
      sources.delete(name);
    } else assert.ok(!name.startsWith('app/'), `現ソースにないapp内包ファイル: ${name}`);
    offset += length;
  }
  assert.equal(offset, stubLength + payloadLength);
  assert.equal(sources.size, 0, `内包漏れ: ${[...sources.keys()].join(', ')}`);
  console.log(`保存済みPortable EXE・payload・現在の内包コード${expectedCount}件・launcher・${headlessOnly ? 'headless実EXE試験' : '実EXE試験2件'}を照合しました。`);
} finally {
  await file.close();
}
console.log(`EXE: ${executable}\nSHA-256: ${report.executableSha256}`);
console.log(`今回の照合: ${((performance.now() - started) / 1000).toFixed(3)}秒。実EXE試験の再実行ではありません。`);
