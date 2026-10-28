import './chromium-test-log-sink.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { bookFilename } from '../app/export-name.mjs';
import { PNG } from 'pngjs';
import { startApplication } from '../app/server.mjs';
import { Application } from '../app/application.mjs';
import { openControlWindow as openWindow } from '../app/control-window.mjs';
import { withPublicDisclosures } from '../poc/browser/public-ui-controls.mjs';
import { checkLanguageFlow } from './support/language-flow.mjs';
import { checkCaptureResume } from './support/capture-resume-flow.mjs';
async function openControlWindow(...args) {
  const control = await openWindow(...args);
  return { ...control, page: withPublicDisclosures(control.page) };
}

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
test('再開判定は送信済み・不明の同位置を再送せず、旧作業の同一画像も重複取得しない', () => {
  const app = Object.create(Application.prototype);
  const png = Buffer.from('anonymous image');
  app.job = { manifest: { last_capture_id: 67, images: [{ capture_id: 67, sha256: hash(png) }],
    checkpoint: { capture_id: 67, position: '134', dispatch: 'not_sent' } } };
  assert.equal(app.planResume({ png, position: '134' }).mode, 'advance');
  for (const dispatch of ['unknown', 'sent', 'confirmed']) {
    app.job.manifest.checkpoint.dispatch = dispatch;
    assert.equal(app.planResume({ png, position: '134' }).mode, 'blocked');
    assert.equal(app.planResume({ png: Buffer.from('next image'), position: '136' }).mode, 'capture');
  }
  delete app.job.manifest.checkpoint;
  assert.equal(app.planResume({ png, position: '134' }).mode, 'blocked');
  assert.equal(app.planResume({ png: Buffer.from('next image'), position: '136' }).mode, 'capture');
});
test('136位置next not_uniqueから公開再開し重複なしで継続', async t => {
  await mkdir(path.resolve('artifacts/indicator-review'), { recursive: true });
  const directory = await mkdtemp(path.resolve('artifacts/indicator-review/resume-source-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await checkCaptureResume({ startApplication, openControlWindow, evidence: directory, nearBoundary: true });
});
function storedPngEntries(archive) {
  const entries = [];
  let offset = 0;
  while (offset + 30 <= archive.length && archive.readUInt32LE(offset) === 0x04034b50) {
    const size = archive.readUInt32LE(offset + 18);
    const start = offset + 30 + archive.readUInt16LE(offset + 26) + archive.readUInt16LE(offset + 28);
    const name = archive.subarray(offset + 30, offset + 30 + archive.readUInt16LE(offset + 26)).toString('utf8');
    entries.push({ name, bytes: archive.subarray(start, start + size) });
    offset = start + size;
  }
  assert.ok(entries.length > 0 && archive.readUInt32LE(offset) === 0x02014b50, 'ZIP has a central directory after stored PNG entries');
  return entries;
}

test('日英中の簡易切替: 公開選択・動的残数・隣接エラー・確認・入力と承認の保持', async t => {
  await mkdir(path.resolve('artifacts/indicator-review'), { recursive: true });
  const directory = await mkdtemp(path.resolve('artifacts/indicator-review/language-'));
  const r = await startApplication({ dataDir: path.join(directory, 'data'), sampleFixture: 'kindle-chrome-dynamic' });
  const control = await openControlWindow(r.url, { headless: true });
  const ui = control.page;
  t.after(async () => { await control.close(); await r.close(); await rm(directory, { recursive: true, force: true }); });
  await ui.waitForFunction(() => document.querySelector('#state').textContent === '待機');
  for (const [lang, idle] of [['en', 'Idle'], ['zh-CN', '待机'], ['ja', '待機']]) {
    await ui.locator('#language').selectOption(lang);
    assert.equal(await ui.locator('#state').textContent(), idle);
  }
  await ui.locator('#decisionButton').click();
  await ui.locator('#openSample').click();
  await ui.waitForFunction(() => document.querySelector('#readerTab').options.length > 1);
  await ui.locator('#readerTab').selectOption({ index: 1 });
  await ui.locator('#decisionButton').click();
  for (const lang of ['en', 'zh-CN']) {
    await ui.locator('#language').selectOption(lang);
    await ui.locator('#pickReader').click();
    await wait(r.app, s => s.pickingField === 'reader' && s.pickerStage === 'waiting_click');
    const hint = r.app.reader.page.frameLocator('[data-ktz-selection]').locator('#ktzPickHint');
    const text = await hint.textContent();
    assert.ok(text.includes(lang === 'en' ? 'Click inside' : '请点击'));
    // This isolated overlay captures its creation language; the next call uses
    // the current selection. Changing language must not restart the picker.
    await ui.locator('#language').selectOption('ja');
    assert.equal(await hint.textContent(), text);
    await ui.locator('#cancelPick').click();
    await wait(r.app, s => !s.pickingField && !s.busy);
  }
  await ui.locator('#preset').selectOption('kindle-reader-chrome');
  await ui.locator('#decisionButton').click();
  await ui.waitForFunction(() => !document.querySelector('#previewImage').hidden);
  await ui.locator('#previewConfirmed').check();
  await ui.locator('#decisionButton').click();
  await ui.waitForFunction(() => !document.querySelector('#start').disabled);
  for (const lang of ['en', 'zh-CN', 'ja']) {
    await ui.locator('#language').selectOption(lang);
    assert.equal(await ui.locator('#previewConfirmed').isChecked(), true);
    assert.equal(await ui.locator('#start').isEnabled(), true);
    assert.equal((await r.app.snapshot()).job.manifest.images.length, 0, 'switching language never starts capture');
  }
  await ui.locator('#decisionButton').click();
  await wait(r.app, s => s.state === 'NeedsAttention' && !s.busy);
  const snapshot = await r.app.snapshot();
  assert.ok(snapshot.job.manifest.images.length > 0);
  const manifest = JSON.stringify(snapshot.job.manifest);
  await ui.waitForFunction(() => document.querySelector('#reason').textContent.length > 0);
  for (const lang of ['en', 'zh-CN']) {
    await ui.locator('#language').selectOption(lang);
    assert.doesNotMatch(await ui.locator('#reason').textContent(), /[ぁ-んァ-ヶ]/);
    await ui.reload();
    await ui.waitForFunction(value => document.documentElement.lang === value && document.querySelector('#counts').textContent.length > 0, lang);
  }
  await ui.locator('#language').selectOption('ja');
  await checkLanguageFlow(ui);
  assert.equal(JSON.stringify((await r.app.snapshot()).job.manifest), manifest, 'language / cancelled reset must not edit the job');
});

test('3ボタン公開導線・処理インジケーター: 開始直後のpaint・失敗・取消・書名所有権・選択の非同期失効', async t => {
  assert.equal(bookFilename('日本語 第２巻:入門?. '), '日本語 第２巻_入門_.zip');
  assert.equal(bookFilename('CON.txt'), '_CON.txt.zip');
  assert.equal(bookFilename('... '), 'export.zip');
  assert.ok(bookFilename('😀'.repeat(200)).length <= 204);
  const evidence = path.resolve('artifacts/indicator-review');
  await mkdir(evidence, { recursive: true });
  const directory = await mkdtemp(path.join(evidence, 'anonymous-'));
  let dialogResolve, dialogReject, dialogRequest;
  const r = await startApplication({ dataDir: path.join(directory, 'data'), sampleFixture: 'layout', saveDialog: request => {
    dialogRequest = request;
    return new Promise((resolve, reject) => { dialogResolve = resolve; dialogReject = reject; request.signal.addEventListener('abort', () => resolve(null), { once: true }); });
  } });
  const control = await openControlWindow(r.url, { headless: true });
  const ui = control.page;
  let release;
  t.after(async () => { release?.(); dialogResolve?.(null); await ui.unrouteAll({ behavior: 'wait' }); await control.close(); await r.close(); await rm(directory, { recursive: true, force: true }); });
  const gate = new Promise(resolve => { release = resolve; });
  await ui.route('**/api/command', async route => {
    if (route.request().postDataJSON().action === 'create') await gate;
    await route.continue();
  });
  await ui.locator('#create').click();
  await ui.waitForFunction(() => document.querySelector('#operationStatus').dataset.status === 'pending');
  const assertProgress = async expected => {
    await ui.waitForFunction(value => document.querySelector('#operationPercent').textContent === `${value}%`, expected);
    const measured = await ui.locator('#operationBar').evaluate(el => ({
      numeric: Number(el.getAttribute('aria-valuenow')),
      width: document.querySelector('#operationFill').getBoundingClientRect().width / el.clientWidth * 100,
      visible: el.getBoundingClientRect().height >= 8 && el.getBoundingClientRect().bottom <= innerHeight,
    }));
    assert.equal(measured.numeric, expected);
    assert.ok(Math.abs(measured.width - expected) < 0.5);
    assert.equal(measured.visible, true);
  };
  await ui.waitForFunction(() => document.querySelector('#operationPercent').textContent === '割合未確定');
  assert.equal(await ui.locator('#operationBar').getAttribute('aria-valuenow'), null);
  await ui.screenshot({ path: path.join(evidence, 'anonymous-create-pending.png') });
  release();
  await wait(r.app, s => s.job && !s.busy);
  await ui.waitForFunction(() => document.querySelector('#operationStatus').dataset.status === 'success');
  await assertProgress(100);
  await ui.unrouteAll({ behavior: 'wait' });
  // The public helper creates its own job, so return through the public close entry.
  await ui.locator('#closeJob').click(); await wait(r.app, s => !s.job && !s.busy);
  let inspectRelease, inspectEntered;
  const inspectGate = new Promise(resolve => { inspectRelease = resolve; });
  const inspectSignal = new Promise(resolve => { inspectEntered = resolve; });
  t.after(() => inspectRelease());
  const originalCall = r.app.store.call.bind(r.app.store);
  let holdLayout = true;
  r.app.store.call = async (kind, ...args) => {
    if (kind === 'layout_result' && holdLayout) { inspectEntered(); await inspectGate; }
    return originalCall(kind, ...args);
  };
  const capturePromise = captureRepairSaveContext(ui, r.app, async () => {
    await r.app.reader.page.frameLocator('#readingFrame').locator('#readerChromeTitle').evaluate(el => { el.textContent = '匿名の日本語 第２巻:試料?'; });
  });
  await inspectSignal;
  await assertProgress(50);
  assert.match(await ui.locator('#operationDetail').textContent(), /処理工程 2\/4/);
  const beforeWait = await ui.evaluate(() => ({ scroll: scrollY, focus: document.activeElement.id }));
  await new Promise(resolve => setTimeout(resolve, 1200));
  await assertProgress(50);
  assert.deepEqual(await ui.evaluate(() => ({ scroll: scrollY, focus: document.activeElement.id })), beforeWait);
  await ui.screenshot({ path: path.join(evidence, 'anonymous-preview-measured-50.png') });
  holdLayout = false; inspectRelease();
  const captured = await capturePromise;
  assert.equal(path.basename(captured.suggestedDestination), '匿名の日本語 第２巻_試料_.zip');
  assert.equal(captured.job.manifest.images[0].book.title, '匿名の日本語 第２巻:試料?');
  await ui.locator('[data-stage-target="export"]').first().click();
  const initial = await ui.locator('#destination').inputValue();
  await ui.locator('#chooseDestination').click();
  await ui.waitForFunction(() => document.querySelector('#operationLabel').textContent.includes('ダイアログ'));
  await wait(r.app, s => s.activeOperation === 'chooseDestination');
  await ui.waitForFunction(() => document.querySelector('#operationPercent').textContent === '割合未確定');
  assert.match(await ui.locator('#operationDetail').textContent(), /総量未確定.*残り不明/);
  assert.equal(dialogRequest.destination, initial);
  assert.equal((await r.app.snapshot()).job.manifest.exports.length, 0, 'selection does not export');
  await assert.rejects(r.app.command('chooseDestination', { destination: initial, format: 'zip' }), e => e.code === 'operation_busy');
  dialogResolve(null);
  await ui.waitForFunction(() => document.querySelector('#operationStatus').dataset.status === 'cancelled');
  assert.notEqual(await ui.locator('#operationPercent').textContent(), '100%');
  assert.equal(await ui.locator('#destination').inputValue(), initial);
  await ui.locator('#chooseDestination').click();
  await wait(r.app, s => s.activeOperation === 'chooseDestination');
  dialogReject(new Error('anonymous-dialog-failure'));
  await ui.waitForFunction(() => document.querySelector('#operationStatus').dataset.status === 'failure');
  assert.notEqual(await ui.locator('#operationPercent').textContent(), '100%');
  assert.equal(await ui.locator('#destination').inputValue(), initial);
  assert.match(await ui.locator('#message').textContent(), /元の保存先/);
  await ui.locator('#chooseDestination').click();
  await wait(r.app, s => s.activeOperation === 'chooseDestination');
  assert.equal(await ui.locator('#reason').textContent(), '', 'old failure is not current pending result');
  await ui.screenshot({ path: path.join(evidence, 'anonymous-destination-pending.png') });
  const chosen = path.join(directory, '選択した保存先.zip');
  dialogResolve(chosen);
  await ui.waitForFunction(value => document.querySelector('#destination').value === value, chosen);
  await waitForPollRender(ui);
  assert.equal(await ui.locator('#destination').inputValue(), chosen);
  await ui.locator('#chooseDestination').click();
  await wait(r.app, s => s.activeOperation === 'chooseDestination');
  const staleResolve = dialogResolve;
  await ui.locator('#finishBookButton').click();
  staleResolve(path.join(directory, 'obsolete.zip'));
  await wait(r.app, s => !s.job && !s.busy);
  await ui.locator('#create').click(); await wait(r.app, s => s.job && !s.busy);
  assert.match(await ui.locator('#destination').inputValue(), /export\.zip$/);
  await ui.screenshot({ path: path.join(evidence, 'anonymous-next-job.png') });
});

test('保存先ドライバ: 従来型Windowsダイアログのファイル名欄で取消と非保存の選択ができる', async t => {
  const evidence = path.resolve('artifacts/indicator-review'); await mkdir(evidence, { recursive: true });
  const directory = await mkdtemp(path.join(evidence, 'legacy-dialog-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = await readFile('app/save-dialog.ps1', 'utf8');
  const declaration = '$dialog = [System.Windows.Forms.SaveFileDialog]::new()';
  assert.equal(source.split(declaration).length, 2);
  // Exercise the platform's older common-dialog control IDs without changing
  // the application's default dialog or replacing any native interaction.
  const script = path.join(directory, 'legacy-dialog.ps1');
  await writeFile(script, source.replace(declaration, `${declaration}\n$dialog.AutoUpgradeEnabled = $false`));
  for (const action of ['cancel', 'select']) await t.test(action, async t => {
    const host = spawn(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', script],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', errors = '';
    host.stdout.setEncoding('utf8'); host.stdout.on('data', chunk => { output += chunk; });
    host.stderr.setEncoding('utf8'); host.stderr.on('data', chunk => { errors += chunk; });
    const finished = new Promise((resolve, reject) => { host.once('error', reject); host.once('close', resolve); });
    t.after(async () => { if (host.exitCode === null) host.kill(); await finished; }); // Only this disposable test-owned host.
    const destination = path.join(directory, 'legacy-selected.zip');
    host.stdin.end(JSON.stringify({ destination: path.join(directory, 'legacy-initial.zip'), format: 'zip' }) + '\n');
    const { stdout } = await promisify(execFile)('pwsh', ['-NoProfile', '-File', 'scripts/drive-owned-save-dialog.ps1',
      // Allow the driver's 15s appearance + 8s readiness + 8s exit bounds,
      // plus cold Windows UIAutomation/PowerShell startup on hosted runners.
      '-OwnerPid', String(process.pid), '-Action', action, '-Destination', destination], { timeout: 45000, encoding: 'utf8' });
    const result = JSON.parse(stdout.trim());
    t.diagnostic(JSON.stringify({ action, nativeDialogTimingsMs: result.timingsMs }));
    // Windows may hide a known extension in the edit; the selected absolute
    // path below must still include exactly the requested .zip extension.
    assert.match(result.initialFilename, /^legacy-initial(?:\.zip)?$/);
    assert.equal(result.nativeWindowFound, true);
    assert.equal(result.osInputOrClipboardUsed, false);
    assert.equal(await finished, 0, errors);
    assert.equal(JSON.parse(output.trim()), action === 'select' ? destination : null);
    await assert.rejects(stat(destination), { code: 'ENOENT' }, '選択だけでZIPを作成しない');
  });
});

test('3ボタン公開導線・保存先ダイアログ: 実Windows表示・書名初期値・選択・取消・ZIP・再開後の所有名', async t => {
  const evidence = path.resolve('artifacts/indicator-review'); await mkdir(evidence, { recursive: true });
  const directory = await mkdtemp(path.join(evidence, 'native-anonymous-'));
  const r = await startApplication({ dataDir: path.join(directory, 'data'), sampleFixture: 'layout' });
  const control = await openControlWindow(r.url, { headless: true }); const ui = control.page;
  t.after(async () => { await control.close(); await r.close(); await rm(directory, { recursive: true, force: true }); });
  const captured = await captureRepairSaveContext(ui, r.app, async () => {
    await r.app.reader.page.frameLocator('#readingFrame').locator('#readerChromeTitle').evaluate(el => { el.textContent = '匿名保存試料 第１巻'; });
  });
  await ui.locator('[data-stage-target="export"]').first().click();
  const initial = await ui.locator('#destination').inputValue();
  const driver = async (action, destination, screenshot) => {
    const { stdout } = await promisify(execFile)('pwsh', ['-NoProfile', '-File', 'scripts/drive-owned-save-dialog.ps1', '-OwnerPid', String(process.pid), '-Action', action,
      ...(destination ? ['-Destination', destination] : []), ...(screenshot ? ['-Screenshot', path.join(evidence, screenshot)] : [])], { timeout: 45000, encoding: 'utf8' });
    const result = JSON.parse(stdout.trim());
    t.diagnostic(JSON.stringify({ action, nativeDialogTimingsMs: result.timingsMs }));
    return result;
  };
  await ui.locator('#chooseDestination').click();
  const cancelled = await driver('cancel', null, 'anonymous-native-dialog.png');
  assert.equal(path.basename(initial), '匿名保存試料 第１巻.zip');
  assert.match(cancelled.initialFilename, /^匿名保存試料 第１巻(?:\.zip)?$/);
  await ui.waitForFunction(() => document.querySelector('#operationStatus').dataset.status !== 'pending');
  assert.equal(await ui.locator('#operationStatus').getAttribute('data-status'), 'cancelled', await ui.locator('#message').textContent());
  await ui.waitForFunction(() => document.querySelector('#operationStatus').dataset.status === 'cancelled');
  assert.equal(await ui.locator('#destination').inputValue(), initial);
  const chosen = path.join(directory, '本人が選んだ匿名名.zip');
  const selectionResponse = ui.waitForResponse(response => response.url().endsWith('/api/command')
    && response.request().postDataJSON()?.action === 'chooseDestination', { timeout: 45000 });
  await ui.locator('#chooseDestination').click(); const selected = await driver('select', chosen);
  const selection = await (await selectionResponse).json();
  assert.equal(selection.chosenDestination, chosen, JSON.stringify(selection));
  await ui.waitForFunction(value => document.querySelector('#destination').value === value, chosen);
  assert.equal((await r.app.snapshot()).job.manifest.exports.length, 0);
  await saveRepairContextArchive(ui, r.app, 1);
  const archive = await readFile(chosen); assert.equal(storedPngEntries(archive).length, 1);
  await ui.screenshot({ path: path.join(evidence, 'anonymous-native-zip-success.png') });
  await assert.rejects(r.app.command('export', { destination: chosen, format: 'zip' }), e => e.code === 'output_exists');
  await closeRepairSaveContext(ui, r.app);
  await ui.locator('#recoverPath').fill(captured.job.job_path); await ui.locator('#recover').click();
  const recovered = await wait(r.app, s => s.job && !s.busy);
  assert.equal(recovered.browserOpen, false);
  assert.equal(path.basename(recovered.suggestedDestination), '匿名保存試料 第１巻.zip');
  await ui.locator('[data-stage-target="export"]').first().click();
  await ui.locator('#destination').fill(path.join(directory, 'reader-free.zip')); await saveRepairContextArchive(ui, r.app, 2);
  await writeFile(path.join(evidence, 'native-dialog-result.json'), JSON.stringify({ cancelled, selected, selectedOnlyDidNotExport: true, zipEntries: 1,
    existingOutputPreserved: hash(await readFile(chosen)) === hash(archive), readerFreeRecoveryExport: true }, null, 2));
});

test('3ボタン公開導線・保存先所有権: 同名の別フォルダを保存済みと誤認せず両方を非上書きで保存する', async t => {
  const directory = await mkdtemp(path.resolve('artifacts/mvp-tests/export-path-ownership-'));
  const r = await startApplication({ dataDir: path.join(directory, 'data'), sampleFixture: 'layout' });
  const control = await openControlWindow(r.url, { headless: true }); const ui = control.page;
  t.after(async () => { await control.close(); await r.close(); await rm(directory, { recursive: true, force: true }); });
  const captured = await captureRepairSaveContext(ui, r.app);
  const jobDestination = captured.suggestedDestination;
  const externalDirectory = path.join(directory, 'chosen-folder'); await mkdir(externalDirectory);
  const externalDestination = path.join(externalDirectory, path.basename(jobDestination));
  await ui.locator('[data-stage-target="export"]').first().click();
  await ui.locator('#destination').fill(externalDestination);
  await ui.locator('#decisionButton').click();
  await wait(r.app, s => s.job.manifest.exports.length === 1 && !s.busy);
  await ui.waitForFunction(() => document.querySelector('#exportResult').textContent.includes('保存先：'));
  const externalArchive = await readFile(externalDestination);
  await assert.rejects(stat(jobDestination), { code: 'ENOENT' });
  await ui.locator('#destination').fill(jobDestination);
  assert.equal(await ui.locator('#decisionButton').isDisabled(), false, '別フォルダの同名出力で、未使用の保存先を無効にしない');
  assert.doesNotMatch(await ui.locator('#exportHelp').textContent(), /既に検証済みの出力/);
  await ui.locator('#decisionButton').click();
  await wait(r.app, s => s.job.manifest.exports.length === 2 && !s.busy);
  await ui.waitForFunction(() => document.querySelector('#exportResult').textContent.includes('保存先：'));
  assert.equal(storedPngEntries(await readFile(jobDestination)).length, 1);
  assert.deepEqual(await readFile(externalDestination), externalArchive);
  await ui.reload(); await ui.waitForFunction(() => Boolean(document.querySelector('#destination').value));
  await ui.locator('[data-stage-target="export"]').first().click();
  await ui.locator('#destination').fill(externalDestination);
  assert.equal(await ui.locator('#decisionButton').isDisabled(), true, '再読込み後も確認済みの完全な保存先だけを保存済みと扱う');
  await assert.rejects(r.app.command('export', { destination: externalDestination, format: 'zip' }), e => e.code === 'output_exists');
  assert.deepEqual(await readFile(externalDestination), externalArchive);
});

test('リセット・取り直し: 公開確認の取消・残す・同意と世代拒否、再プレビュー・承認・明示開始・ZIP', async t => {
  const evidence = path.resolve('artifacts/indicator-review');
  await mkdir(evidence, { recursive: true });
  const directory = await mkdtemp(path.join(evidence, 'reset-anonymous-'));
  const r = await startApplication({ dataDir: path.join(directory, 'data'), sampleFixture: 'layout' });
  const control = await openControlWindow(r.url, { headless: true }); const ui = control.page;
  let release;
  t.after(async () => { release?.(); await ui.unrouteAll({ behavior: 'wait' }); await control.close(); await r.close(); await rm(directory, { recursive: true, force: true }); });
  const captured = await captureRepairSaveContext(ui, r.app);
  assert.equal(captured.lastFailure.code, 'advance_uncertain');
  const oldImages = captured.job.manifest.images;
  await ui.locator('[data-stage-target="export"]').first().click();
  const destination = path.join(directory, 'preserved.zip');
  await ui.locator('#destination').fill(destination);
  await saveRepairContextArchive(ui, r.app, 1);
  const archive = await readFile(destination);
  for (const choice of ['resetCancel', 'resetKeep']) {
    await ui.locator('#cancelBackButton').click();
    await ui.locator('#resetDialog').waitFor({ state: 'visible' });
    assert.equal(await ui.locator('#resetCancel').evaluate(el => document.activeElement === el), true);
    assert.match(await ui.locator('#resetScope').textContent(), /取得原本/);
    assert.equal(await ui.locator('#operationPercent').textContent(), '割合未確定');
    assert.equal(await ui.locator('#operationBar').getAttribute('aria-valuenow'), null);
    assert.match(await ui.locator('#operationDetail').textContent(), /総量未確定.*残り不明.*選択待ち/);
    await ui.screenshot({ path: path.join(evidence, `anonymous-${choice}.png`) });
    await ui.locator(`#${choice}`).click();
    await ui.waitForFunction(() => !document.querySelector('#resetDialog').open && document.querySelector('#operationStatus').dataset.status !== 'pending');
    assert.equal(await ui.locator('#operationStatus').getAttribute('data-status'), choice === 'resetCancel' ? 'cancelled' : 'success');
    if (choice === 'resetCancel') assert.match(await ui.locator('#message').textContent(), /戻る操作を取り消しました/);
    assert.deepEqual((await r.app.snapshot()).job.manifest.images, oldImages);
  }
  const stale = await r.app.command('prepareReset');
  r.app.invalidate(null);
  await assert.rejects(r.app.command('resetImages', { confirmed: true, token: stale.resetToken }), e => e.code === 'reset_confirmation_expired');
  r.app.quiescenceRequired = true;
  await assert.rejects(r.app.command('prepareReset'), e => e.code === 'safe_stop_incomplete');
  r.app.quiescenceRequired = false;
  await ui.locator('#cancelBackButton').click();
  await ui.locator('#resetDialog').waitFor({ state: 'visible' });
  const gate = new Promise(resolve => { release = resolve; });
  await ui.route('**/api/command', async route => { if (route.request().postDataJSON().action === 'resetImages') await gate; await route.continue(); });
  await ui.locator('#resetConfirm').click();
  await ui.waitForFunction(() => document.querySelector('#operationStatus').dataset.status === 'pending');
  assert.equal(await ui.locator('#operationBar').isVisible(), true);
  assert.equal(await ui.locator('#operationPercent').textContent(), '割合未確定');
  assert.equal(await ui.locator('#operationBar').getAttribute('aria-valuenow'), null);
  await ui.screenshot({ path: path.join(evidence, 'anonymous-reset-pending.png') });
  release();
  await wait(r.app, s => !s.busy && s.job.manifest.images.length === 0);
  await ui.waitForFunction(() => document.querySelector('#operationStatus').dataset.status !== 'pending');
  await ui.unrouteAll({ behavior: 'wait' });
  for (const image of oldImages) await assert.rejects(stat(path.join(captured.job.job_path, image.path)), { code: 'ENOENT' });
  assert.equal(hash(await readFile(destination)), hash(archive));
  assert.equal(await ui.locator('#destination').inputValue(), destination);
  await assert.rejects(r.app.command('start', { confirmed: true }), e => e.code === 'explicit_start_required');
  await ui.locator('#quickPreview').click();
  await ui.waitForFunction(() => !document.querySelector('#previewImage').hidden);
  assert.equal((await r.app.snapshot()).job.manifest.images.length, 0);
  await ui.locator('#previewConfirmed').check(); await ui.locator('#approve').click();
  await wait(r.app, s => s.state === 'Ready' && !s.busy);
  assert.equal((await r.app.snapshot()).job.manifest.images.length, 0);
  await ui.locator('#start').click();
  const retaken = await wait(r.app, s => s.state === 'NeedsAttention' && !s.busy);
  assert.ok(retaken.job.manifest.images[0].capture_id > oldImages.at(-1).capture_id);
  assert.equal(retaken.job.manifest.images[0].duplicate_candidate, false);
  await ui.locator('[data-stage-target="export"]').first().click();
  await ui.locator('#destination').fill(path.join(directory, 'retaken.zip'));
  await saveRepairContextArchive(ui, r.app, 2);
  await ui.screenshot({ path: path.join(evidence, 'anonymous-retaken-zip.png') });
});

test('3ボタン公開導線・全画像進捗: 取得は総量不明、ZIPは全画像の書込み・再読検証・確定まで集計する', async t => {
  const evidence = path.resolve('artifacts/indicator-review');
  await mkdir(evidence, { recursive: true });
  const directory = await mkdtemp(path.join(evidence, 'whole-step-'));
  const r = await startApplication({ dataDir: path.join(directory, 'data') });
  const control = await openControlWindow(r.url, { headless: true });
  const ui = control.page;
  let release;
  t.after(async () => { release?.(); await control.close(); await r.close(); await rm(directory, { recursive: true, force: true }); });
  const trace = [];
  const originalCall = r.app.store.call.bind(r.app.store);
  const gate = new Promise(resolve => { release = resolve; });
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  r.app.store.call = async (kind, payload, onProgress) => {
    const result = await originalCall(kind, payload, p => { trace.push(p); onProgress?.(p); });
    if (kind === 'export') { entered(); await gate; }
    return result;
  };
  await ui.locator('#create').click(); await ui.locator('#openSample').click();
  await ui.waitForFunction(() => document.querySelector('#readerTab').options.length > 1);
  await ui.locator('#readerTab').selectOption({ index: 1 }); await ui.locator('#selectReaderTab').click();
  await ui.waitForFunction(() => !document.querySelector('#quickPreview').disabled);
  await ui.locator('#quickPreview').click(); await ui.locator('#previewImage').waitFor({ state: 'visible' });
  await ui.locator('#previewConfirmed').check(); await ui.locator('#approve').click();
  await ui.waitForFunction(() => !document.querySelector('#start').disabled);
  await ui.locator('#start').click();
  await ui.waitForFunction(() => document.querySelector('#operationDetail').textContent.includes('処理済み1'));
  assert.equal(await ui.locator('#operationPercent').textContent(), '割合未確定');
  const captured = await wait(r.app, s => s.state === 'NeedsAttention' && !s.busy, 60_000);
  assert.ok(captured.job.manifest.images.length > 1);
  await ui.waitForFunction(() => document.querySelector('#operationStatus').dataset.status === 'failure');
  assert.equal(await ui.locator('#operationPercent').textContent(), '割合未確定', 'background thumbnail completion must not replace the acquisition result');
  await ui.locator('#decisionButton').click();
  await ui.waitForFunction(() => !document.querySelector('section[data-stage="review"]').hidden);
  await ui.locator('#decisionButton').click();
  await ui.waitForFunction(() => !document.querySelector('section[data-stage="export"]').hidden && document.querySelector('#operationStatus').dataset.status !== 'pending');
  assert.equal(await ui.locator('#operationStatus').getAttribute('data-status'), 'idle');
  assert.equal(await ui.locator('#operationPercent').textContent(), '割合未確定');
  assert.equal(await ui.locator('#operationBar').getAttribute('aria-valuenow'), null);
  assert.match(await ui.locator('#operationDetail').textContent(), /操作待ち/);
  assert.equal((await r.app.snapshot()).job.manifest.exports.length, 0);
  await ui.locator('#export').click(); await ready;
  const n = captured.job.manifest.selected_capture_ids.length;
  assert.equal(trace[1].done, 1);
  assert.equal(trace[1].total, 2 * n + 2);
  assert.ok(trace[1].done / trace[1].total < 1);
  assert.equal(trace.filter(p => p.stage === 'verify').length, n);
  assert.deepEqual(trace.at(-1), { done: 2 * n + 1, total: 2 * n + 2, stage: 'publish' });
  const expected = Math.floor(100 * (2 * n + 1) / (2 * n + 2));
  await ui.waitForFunction(p => document.querySelector('#operationPercent').textContent === `${p}%`, expected);
  assert.match(await ui.locator('#operationDetail').textContent(), new RegExp(`${2 * n + 1}/${2 * n + 2}・残り1`));
  assert.equal(await ui.locator('#operationBar').getAttribute('aria-valuenow'), String(expected));
  await ui.screenshot({ path: path.join(evidence, 'anonymous-whole-zip-before-result.png') });
  release();
  await ui.waitForFunction(() => document.querySelector('#operationPercent').textContent === '100%');
  await ui.locator('[data-stage-target="review"]').first().click();
  assert.notEqual(await ui.locator('#operationPercent').textContent(), '100%');
});

test('再プレビュー対象の切分け: 読書画面成功後のライブラリ参照を再指定せず診断し、同一本を連続再検査する', async t => {
  await mkdir('artifacts/mvp-tests', { recursive: true });
  const directory = await mkdtemp(path.resolve('artifacts/mvp-tests/repeat-target-'));
  const r = await startApplication({ dataDir: path.join(directory, 'data') });
  const control = await openControlWindow(r.url, { headless: true });
  t.after(async () => { await control.close(); await r.close(); await rm(directory, { recursive: true, force: true }); });
  const ui = control.page;
  await ui.locator('#create').click();
  await ui.locator('#sampleFixture').selectOption('kindle-chrome-tabs');
  await ui.locator('#openSample').click();
  await ui.waitForFunction(() => document.querySelector('#readerTab').options.length === 2);
  await ui.locator('#readerTab').selectOption({ index: 1 });
  await ui.locator('#selectReaderTab').click();
  await ui.locator('#preset').selectOption('kindle-reader-chrome');
  await wait(r.app, snapshot => snapshot.presets.selected === 'kindle-reader-chrome' && !snapshot.busy);
  const original = r.app.reader.page;
  await ui.locator('#quickPreview').click();
  await ui.locator('#previewImage').waitFor({ state: 'visible' });
  const presetsBefore = JSON.stringify((await r.app.snapshot()).presets);
  await ui.locator('#previewConfirmed').check(); await ui.locator('#approve').click();
  await wait(r.app, snapshot => snapshot.previewApproved && !snapshot.busy);
  const [reading] = await Promise.all([
    original.context().waitForEvent('page'), original.locator('#openSameBookTab').click(),
  ]);
  await reading.waitForLoadState('domcontentloaded');
  await wait(r.app, snapshot => !snapshot.previewApproved && !snapshot.previewReady);
  for (const button of ['quickPreview', 'preview']) {
    await ui.locator(`#${button}`).click();
    const failed = await wait(r.app, snapshot => snapshot.displayInspection?.status === 'failed' && !snapshot.busy);
    assert.equal(failed.displayInspection.code, 'reader_library_selected');
    assert.deepEqual(failed.displayInspection.detail, { field: 'reader', cause: 'library_selected' });
    assert.equal(failed.displayInspection.stage, 'reader_target_check');
    assert.equal(failed.previewApproved, false);
    assert.equal(r.app.previewImage, null);
    assert.equal(r.app.reader.page, original, 'a new tab never silently replaces an explicit target');
    await ui.waitForFunction(() => document.querySelector('#message').textContent.includes('4項目の再指定は不要'));
    assert.match(await ui.locator('#message').textContent(), /library_selected.*reader_target_check/s);
  }
  await ui.waitForFunction(() => document.querySelector('#readerTab').options.length === 3);
  await ui.locator('#readerTab').selectOption({ index: 2 }); await ui.locator('#selectReaderTab').click();
  await wait(r.app, snapshot => !snapshot.busy && snapshot.readerTabConfirmed);
  for (const button of ['quickPreview', 'quickPreview', 'preview']) {
    await ui.locator(`#${button}`).click();
    await wait(r.app, snapshot => !snapshot.busy && snapshot.previewReady && snapshot.displayInspection?.status === 'passed');
    await ui.locator('#previewImage').waitFor({ state: 'visible' });
    const png = PNG.sync.read(r.app.previewImage);
    assert.ok(png.width > 0 && png.height > 0);
    assert.ok(png.data.some((value, index) => index % 4 !== 3 && value !== png.data[0]));
    const snapshot = await r.app.snapshot();
    assert.equal(snapshot.previewApproved, false);
    assert.equal(snapshot.job.manifest.images.length, 0);
    assert.equal(JSON.stringify(snapshot.presets), presetsBefore, 'no saved preset reset or four-field edit');
    assert.equal(r.app.reader.page, reading);
    assert.equal(await reading.locator('#position').inputValue(), '7');
  }
  // The same library diagnosis must hold on the live route without reading
  // book labels or consulting service APIs. URL values never leave this test.
  const livePage = { url: () => 'https://read.amazon.co.jp/kindle-library' };
  const sampleUrl = r.app.reader.sampleUrl;
  try {
    r.app.reader.sampleUrl = null;
    await assert.rejects(r.app.reader.assertReaderDocument(livePage), error => error.code === 'reader_library_selected');
  } finally { r.app.reader.sampleUrl = sampleUrl; }
});

test('Kindleプリセットの可視証拠と一時非表示: 初回hidden・同一ノード・位置変更・置換を区別する', async t => {
  await mkdir('artifacts/mvp-tests', { recursive: true });
  const directory = await mkdtemp(path.resolve('artifacts/mvp-tests/preset-hidden-evidence-'));
  const r = await startApplication({ dataDir: path.join(directory, 'data') });
  const control = await openControlWindow(r.url, { headless: true });
  t.after(async () => { await control.close(); await r.close(); await rm(directory, { recursive: true, force: true }); });
  const ui = control.page;
  await ui.locator('#create').click();
  await ui.locator('#sampleFixture').selectOption('kindle-chrome-hidden');
  await ui.locator('#openSample').click();
  await ui.waitForFunction(() => document.querySelector('#readerTab').options.length > 1);
  await ui.locator('#readerTab').selectOption({ index: 1 }); await ui.locator('#selectReaderTab').click();
  await ui.waitForFunction(() => !document.querySelector('#quickPreview').disabled);
  await ui.locator('#preset').selectOption('kindle-reader-chrome');
  await wait(r.app, snapshot => snapshot.presets.selected === 'kindle-reader-chrome' && !snapshot.busy);
  const page = r.app.reader.page;

  const peer = await page.context().newPage();
  await peer.goto(page.url());
  await peer.locator('#revealChrome').click();
  await ui.waitForFunction(() => document.querySelector('#readerTab').options.length === 3);
  await ui.locator('#readerTab').selectOption({ index: 1 }); await ui.locator('#selectReaderTab').click();
  await ui.waitForFunction(() => !document.querySelector('#quickPreview').disabled);
  const selectedPage = r.app.reader.page;
  const configBefore = Object.fromEntries(await Promise.all(['identity', 'position', 'next', 'reader'].map(async field => [field, await ui.locator(`#${field}`).inputValue()])));
  const initialNodes = await page.evaluateHandle(() => [document.querySelector('#readerChromeTitle'), document.querySelector('#position'), document.querySelector('nav')]);
  for (const selector of ['#readerChromeTitle', '#position', 'nav']) assert.equal(await page.locator(selector).isVisible(), false);
  assert.equal(await page.locator('canvas').isVisible(), true);
  const hiddenStarted = performance.now();
  await ui.locator('#quickPreview').click();
  const firstHidden = await wait(r.app, snapshot => snapshot.displayInspection?.status === 'failed' && !snapshot.busy);
  assert.equal(firstHidden.displayInspection.code, 'reader_ui_unknown');
  assert.deepEqual(firstHidden.displayInspection.detail, { field: 'identity', cause: 'hidden' });
  assert.ok(performance.now() - hiddenStarted < 8000, 'persistent hidden has a bounded public failure, not an endless retry');
  assert.equal(firstHidden.job.manifest.images.length, 0, 'initial hidden is not evidence to capture');
  assert.equal(firstHidden.previewApproved, false);
  assert.equal(firstHidden.displayInspection.stage, 'preview_visibility_wait');
  assert.equal(firstHidden.previewReady, false);
  assert.equal(r.app.previewImage, null);
  assert.equal(await ui.locator('#previewImage').isVisible(), false);
  for (const [field, selector] of Object.entries(configBefore)) {
    assert.equal(r.app.reader.config[field], selector, 'all four configured selectors survive');
    assert.equal(await ui.locator(`#${field}`).inputValue(), selector);
  }
  for (const field of ['identity', 'position', 'next', 'reader']) assert.equal(await ui.locator(`#${field}Status`).textContent(), '指定済み');
  assert.equal(r.app.reader.page, selectedPage, 'a visible peer tab must not replace the selected hidden target');
  for (const selector of ['#readerChromeTitle', '#position', 'nav']) assert.equal(await page.locator(selector).isVisible(), false);
  // Independent, explicit fixture transition, not an inferred Kindle trigger.
  await page.locator('#revealChrome').click();
  assert.equal(await page.evaluate(nodes => nodes.every(node => node.isConnected && getComputedStyle(node).visibility === 'visible'), initialNodes), true);
  await initialNodes.dispose();
  await ui.locator('#quickPreview').click(); await ui.locator('#previewImage').waitFor({ state: 'visible' });
  const decoded = PNG.sync.read(r.app.previewImage);
  assert.ok(decoded.width > 0 && decoded.height > 0);
  assert.ok(decoded.data.some((value, index) => index % 4 !== 3 && value !== decoded.data[0]), 'preview contains nonuniform real PNG pixels');
  assert.equal((await r.app.snapshot()).job.manifest.images.length, 0);
  assert.equal((await r.app.snapshot()).previewApproved, false, 'a preset preview does not start acquisition');
  assert.equal(await page.locator('#position').inputValue(), '7', 'hidden inspection and explicit reveal do not turn a page');
  const originalPosition = await page.locator('#position').inputValue();
  await page.evaluate(() => {
    document.querySelector('#readerChromeTitle').style.visibility = 'hidden';
    document.querySelector('#position').style.visibility = 'hidden';
  });
  assert.equal((await r.app.reader.requireBound()).position, originalPosition, 'only current values from the same visibly inspected nodes survive temporary hiding');
  await page.locator('#position').evaluate((element, value) => { element.value = String(Number(value) + 1); }, originalPosition);
  await assert.rejects(r.app.reader.requireBound(), error => error.code === 'target_changed', 'a real position change invalidates the bound preview');
  await page.locator('#position').evaluate((element, value) => { element.value = value; }, originalPosition);
  await r.app.reader.requireBound();
  await page.locator('#position').evaluate(element => { element.replaceWith(element.cloneNode(true)); });
  await assert.rejects(r.app.reader.requireBound(), error => error.code === 'reader_ui_unknown'
    && error.detail.field === 'position' && error.detail.cause === 'hidden', 'a hidden replacement node never inherits old evidence');
  await page.evaluate(() => {
    document.querySelector('#readerChromeTitle').style.visibility = '';
    document.querySelector('#position').style.visibility = '';
  });
  await ui.locator('#quickPreview').click(); await ui.locator('#previewImage').waitFor({ state: 'visible' });
  assert.equal((await r.app.snapshot()).previewReady, true, 'a fresh visible preset inspection establishes new evidence');
  for (const selector of ['#readerChromeTitle', '#position', '#next']) {
    await ui.locator('#previewConfirmed').check(); await ui.locator('#approve').click();
    await wait(r.app, snapshot => snapshot.previewApproved && !snapshot.busy);
    await page.locator(selector).evaluate(element => { element.replaceWith(element.cloneNode(true)); });
    await ui.locator('#start').click();
    await wait(r.app, snapshot => !snapshot.busy);
    await ui.waitForFunction(() => document.querySelector('#message').textContent !== '処理中…');
    const replaced = await r.app.snapshot();
    assert.equal(replaced.job.manifest.images.length, 0, 'visible node replacement cannot start with old approval');
    assert.equal(replaced.previewApproved, false);
    await ui.locator('#quickPreview').click(); await ui.locator('#previewImage').waitFor({ state: 'visible' });
    assert.equal((await r.app.snapshot()).previewApproved, false, 'new visible evidence still requires a new approval');
  }
  await ui.locator('#previewConfirmed').check(); await ui.locator('#approve').click();
  await wait(r.app, snapshot => snapshot.previewApproved && !snapshot.busy);
  await ui.locator('#readerTab').selectOption({ index: 2 }); await ui.locator('#selectReaderTab').click();
  const switched = await wait(r.app, snapshot => !snapshot.busy && !snapshot.previewApproved && !snapshot.previewReady);
  assert.equal(switched.job.manifest.images.length, 0, 'switching to another target invalidates old approval without acquisition');
  assert.equal(r.app.reader.page, peer);
  await ui.locator('#quickPreview').click(); await ui.locator('#previewImage').waitFor({ state: 'visible' });
  assert.equal((await r.app.snapshot()).previewApproved, false, 'another target requires fresh inspection and approval');
  await ui.locator('#readerTab').selectOption({ index: 1 }); await ui.locator('#selectReaderTab').click();
  await ui.locator('#quickPreview').click(); await ui.locator('#previewImage').waitFor({ state: 'visible' });
  await ui.locator('#previewConfirmed').check(); await ui.locator('#approve').click();
  await wait(r.app, snapshot => snapshot.previewApproved && !snapshot.busy);
  await ui.locator('#start').click();
  const restarted = await wait(r.app, snapshot => snapshot.state === 'NeedsAttention' && !snapshot.busy && snapshot.lastFailure);
  assert.equal(restarted.job.manifest.images.length, 1, 'fresh preview, approval and explicit start permit the replaced visible node');
});

test('Kindle初回hiddenのページ内復帰候補: 公開試料の実観測復帰列とiframe安全境界を区別する', async t => {
  for (const surface of ['canvas', 'iframe']) await t.test(surface, async t => {
    await mkdir('artifacts/mvp-tests', { recursive: true });
    const directory = await mkdtemp(path.resolve('artifacts/mvp-tests/local-chrome-recovery-'));
    const r = await startApplication({ dataDir: path.join(directory, 'data') });
    const control = await openControlWindow(r.url, { headless: true });
    t.after(async () => { await control.close(); await r.close(); await rm(directory, { recursive: true, force: true }); });
    const ui = control.page;
    await ui.locator('#create').click();
    await ui.locator('#sampleFixture').selectOption('kindle-chrome-recoverable');
    await ui.locator('#openSample').click();
    await ui.waitForFunction(() => document.querySelector('#readerTab').options.length > 1);
    await ui.locator('#readerTab').selectOption({ index: 1 }); await ui.locator('#selectReaderTab').click();
    await ui.locator('#preset').selectOption('kindle-reader-chrome');
    await wait(r.app, snapshot => snapshot.presets.selected === 'kindle-reader-chrome' && !snapshot.busy);
    const page = r.app.reader.page;
    // The public fixture models the observed hidden -> DOM sequence -> visible
    // behavior. The iframe sibling below is a geometry/protocol safety check,
    // not a claim that Kindle's private markup was copied or fully inspected.
    await page.evaluate(surface => {
      let paint = document.querySelector('canvas');
      if (surface === 'iframe') {
        const frame = document.createElement('iframe');
        frame.style.cssText = `width:${paint.width}px;height:${paint.height}px;border:0;display:block`;
        frame.srcdoc = '<body style="margin:0;height:100vh;background:linear-gradient(90deg,white,lightblue)"></body>';
        paint.replaceWith(frame); paint = frame;
      }
    }, surface);
    const nodes = await page.evaluateHandle(() => [document.querySelector('#readerChromeTitle'), document.querySelector('#position'), document.querySelector('nav')]);
    for (const selector of ['#readerChromeTitle', '#position', 'nav']) assert.equal(await page.locator(selector).isVisible(), false);
    page.mouse.move = () => { throw new Error('initial recovery must not use the browser mouse API'); };
    await ui.locator('#quickPreview').click(); await ui.locator('#previewImage').waitFor({ state: 'visible' });
    const pixels = PNG.sync.read(r.app.previewImage);
    assert.ok(pixels.width > 0 && pixels.height > 0);
    assert.equal(await page.evaluate(() => window.chromeRecoveryCount), 1);
    assert.equal(await page.locator('#position').inputValue(), '7');
    const snapshot = await r.app.snapshot();
    assert.equal(snapshot.previewApproved, false);
    assert.equal(snapshot.job.manifest.images.length, 0);
    assert.deepEqual(snapshot.previewInfo.recovery, { initialHiddenField: 'identity', observation: 'dispatched' });
    assert.equal(await page.evaluate(nodes => nodes.every(node => node.isConnected && getComputedStyle(node).visibility === 'visible'), nodes), true);
    await nodes.dispose();
    if (surface === 'canvas') {
      // No invented Kindle auto-hide delay: the fixture's explicit control
      // supplies this independent transition; the real idle delay is unmeasured.
      await page.locator('#hideChrome').click();
      await ui.locator('#quickPreview').click();
      await ui.waitForFunction(() => document.querySelector('#operationStatus').dataset.status === 'success');
      await ui.locator('#previewImage').waitFor({ state: 'visible' });
      const repeated = await r.app.snapshot();
      assert.equal(repeated.previewApproved, false);
      assert.equal(repeated.job.manifest.images.length, 0);
      assert.deepEqual(repeated.previewInfo.recovery, { initialHiddenField: 'next', observation: 'dispatched' });
      assert.equal(await page.locator('#position').inputValue(), '7');
      await page.locator('#hideChrome').click();
      await ui.locator('#previewConfirmed').check(); await ui.locator('#approve').click();
      await wait(r.app, snapshot => !snapshot.busy && !snapshot.previewReady);
      assert.equal(await page.evaluate(() => window.chromeRecoveryCount), 2, 'approval cannot inherit the explicit-preview DOM recovery');
      assert.equal((await r.app.snapshot()).previewApproved, false);
      assert.equal((await r.app.snapshot()).job.manifest.images.length, 0);
      await ui.locator('#quickPreview').click(); await ui.locator('#previewImage').waitFor({ state: 'visible' });
      await ui.locator('#previewConfirmed').check(); await ui.locator('#approve').click();
      await wait(r.app, snapshot => snapshot.previewApproved && !snapshot.busy);
      await page.locator('#hideChrome').click();
      await ui.locator('#start').click();
      await wait(r.app, snapshot => !snapshot.busy && !snapshot.previewReady);
      assert.equal(await page.evaluate(() => window.chromeRecoveryCount), 3, 'explicit start cannot inherit DOM recovery either');
      assert.equal((await r.app.snapshot()).previewApproved, false);
      assert.equal((await r.app.snapshot()).job.manifest.images.length, 0);
    }
  });
});

test('動的Kindle試料の公開復帰: preset→hidden停止1枚→点検/ZIP→再承認/明示開始→同app次冊', async t => {
  await mkdir('artifacts/mvp-tests', { recursive: true });
  const directory = await mkdtemp(path.resolve('artifacts/mvp-tests/dynamic-resume-public-'));
  const dataDir = path.join(directory, 'data');
  const r = await startApplication({ dataDir });
  const control = await openControlWindow(r.url, { headless: true });
  t.after(async () => { await control.close(); await r.close(); await rm(directory, { recursive: true, force: true }); });
  const ui = control.page;
  const next = async () => {
    await ui.locator('#decisionButton').click();
    await ui.waitForFunction(() => document.querySelector('#message').textContent !== '処理中…');
  };
  const selectPresetPreview = async () => {
    await ui.locator('#preset').selectOption('kindle-reader-chrome');
    await wait(r.app, snapshot => snapshot.presets.selected === 'kindle-reader-chrome' && !snapshot.busy);
    await next();
    await ui.locator('#previewImage').waitFor({ state: 'visible' });
    assert.equal((await r.app.snapshot()).previewApproved, false);
    assert.equal((await r.app.snapshot()).job.manifest.images.length, 0);
  };

  await ui.locator('#create').click();
  const sampleDetails = ui.locator('[data-stage="browser"] details');
  if (!await sampleDetails.evaluate(element => element.open)) await sampleDetails.locator('summary').click();
  await ui.locator('#keep').check(); await ui.locator('#session').selectOption('new');
  await ui.locator('#sampleFixture').selectOption('kindle-chrome-dynamic');
  await ui.locator('#openSample').click();
  await ui.waitForFunction(() => document.querySelector('#readerTab').options.length > 1);
  await ui.locator('#readerTab').selectOption({ index: 1 }); await ui.locator('#selectReaderTab').click();
  await ui.waitForFunction(() => !document.querySelector('#quickPreview').disabled);
  await selectPresetPreview();
  const profilePath = r.app.profile;
  const profileId = path.basename(profilePath);
  assert.match(profileId, /^saved-[a-f0-9-]{36}$/);
  await r.app.reader.page.evaluate(() => { document.cookie = 'ktz_dynamic_recovery=retained; Max-Age=86400; SameSite=Lax'; });
  await ui.locator('#previewConfirmed').check(); await next();
  await wait(r.app, snapshot => snapshot.previewApproved && !snapshot.busy);
  await next();
  const stopped = await wait(r.app, snapshot => snapshot.state === 'NeedsAttention' && !snapshot.busy && snapshot.lastFailure);
  assert.equal(stopped.job.manifest.images.length, 1, 'the real visible next click changed position before a transient toolbar-hidden failure');
  assert.deepEqual({ stage: stopped.lastFailure.stage, code: stopped.lastFailure.code, detail: stopped.lastFailure.detail,
    committedImages: stopped.lastFailure.committedImages, advanceDispatch: stopped.lastFailure.advanceDispatch }, {
    stage: 'advance_confirmation', code: 'reader_ui_unknown', detail: { field: 'next', cause: 'hidden' },
    committedImages: 1, advanceDispatch: 'sent',
  });
  assert.equal(await r.app.reader.page.locator('#position').inputValue(), '8', 'the real sample reports the advanced position');
  await ui.waitForFunction(() => document.querySelector('#message').textContent.includes('確定1枚')
    && document.querySelector('#message').textContent.includes('送り後の位置・表示確認'));
  assert.doesNotMatch(await ui.locator('#message').textContent(), /取得は始めていません/);
  assert.doesNotMatch(await ui.locator('#nextAction').textContent(), /取得は始めていません/);
  assert.equal(await ui.locator('#decisionButton').isDisabled(), false, 'one recoverable read failure leaves inspection available');

  const firstOriginal = await r.app.image(1, true);
  await next();
  await wait(r.app, snapshot => snapshot.state === 'Review' && !snapshot.busy);
  await ui.waitForFunction(() => document.querySelectorAll('#images article').length === 1);
  await next();
  await next();
  const firstZipPath = await ui.locator('#destination').inputValue();
  await ui.waitForFunction(() => document.querySelector('#exportResult').textContent.includes('保存先：'));
  const firstZip = await readFile(firstZipPath);
  const firstEntries = storedPngEntries(firstZip);
  assert.equal(firstEntries.length, 1);
  assert.deepEqual([PNG.sync.read(firstEntries[0].bytes).width, PNG.sync.read(firstEntries[0].bytes).height], [1120, 720]);
  assert.equal(hash(firstEntries[0].bytes), hash(firstOriginal));

  await ui.locator('[data-stage-target="capture"]').first().click();
  await r.app.reader.page.locator('#next').evaluate(element => { element.style.visibility = 'hidden'; });
  await ui.locator('#quickPreview').click();
  await wait(r.app, snapshot => snapshot.displayInspection?.status === 'failed' && !snapshot.busy);
  await ui.waitForFunction(() => document.querySelector('#message').textContent !== '処理中…');
  assert.doesNotMatch(await ui.locator('#message').textContent(), /取得は始めていません/);
  assert.doesNotMatch(await ui.locator('#captureHelp').textContent(), /取得は始めていません/);
  assert.equal((await r.app.snapshot()).job.manifest.images.length, 1);
  await r.app.reader.page.locator('#next').evaluate(element => { element.style.visibility = ''; });
  await ui.locator('#quickPreview').click(); await ui.locator('#previewImage').waitFor({ state: 'visible' });
  assert.equal(await r.app.reader.page.locator('#position').inputValue(), '8', 'resume preview checks the current location, not the stale pre-advance position');
  assert.equal(await ui.locator('#resumeLabel').isVisible(), true);
  await ui.locator('#previewConfirmed').check(); await ui.locator('#resumeConfirmed').check();
  await ui.locator('#approve').click(); await wait(r.app, snapshot => snapshot.previewApproved && !snapshot.busy);
  assert.equal((await r.app.snapshot()).job.manifest.images.length, 1, 'resume confirmation does not capture by itself');
  await ui.locator('#start').click();
  await wait(r.app, snapshot => snapshot.state === 'Capturing' && snapshot.job.manifest.images.length >= 1);
  await wait(r.app, snapshot => snapshot.job.manifest.images.length >= 2, 25_000);
  await ui.locator('#cancelBackButton').click();
  await ui.locator('#resetDialog').waitFor({ state: 'visible' });
  await ui.locator('#resetKeep').click();
  await ui.waitForFunction(() => !document.querySelector('#resetDialog').open && document.querySelector('#operationStatus').dataset.status !== 'pending');
  const resumedStopped = await wait(r.app, snapshot => snapshot.state === 'Review' && !snapshot.busy && snapshot.job.manifest.images.length >= 2);
  const resumedOriginals = await Promise.all(resumedStopped.job.manifest.images.map(image => r.app.image(image.capture_id, true)));
  assert.deepEqual(resumedOriginals[0], firstOriginal, 'resume preserves the first committed original');
  await ui.locator('[data-stage-target="export"]').first().click();
  const resumedZipPath = path.join(directory, 'resumed-all-pages.zip');
  await ui.locator('#destination').fill(resumedZipPath);
  await ui.locator('#export').click();
  await ui.waitForFunction(() => document.querySelector('#exportResult').textContent.includes('保存先：'));
  const resumedZip = await readFile(resumedZipPath);
  const resumedEntries = storedPngEntries(resumedZip);
  assert.equal(resumedEntries.length, resumedOriginals.length);
  assert.deepEqual(resumedEntries.map(entry => hash(entry.bytes)), resumedOriginals.map(hash));
  for (const entry of resumedEntries) assert.ok(PNG.sync.read(entry.bytes).width > 0, 'every ZIP PNG is decoded again');
  assert.deepEqual(await readFile(firstZipPath), firstZip, 'the previous archive is not overwritten by resumed export');

  await ui.locator('#finishBookButton').click();
  await wait(r.app, snapshot => !snapshot.job && !snapshot.browserOpen && !snapshot.busy);
  assert.deepEqual(await readFile(firstZipPath), firstZip);
  assert.deepEqual(await readFile(path.join(stopped.job.job_path, 'originals/000001.png')), firstOriginal);
  assert.equal((await stat(profilePath)).isDirectory(), true, 'the explicitly saved profile survives book close');
  await next();
  const second = await wait(r.app, snapshot => Boolean(snapshot.job) && snapshot.job.job_path !== stopped.job.job_path && !snapshot.busy);
  const browserDetails = ui.locator('[data-stage="browser"] details');
  if (!await browserDetails.evaluate(element => element.open)) await browserDetails.locator('summary').click();
  await ui.locator('#keep').check(); await ui.locator('#session').selectOption(profileId);
  await ui.locator('#openSample').click();
  await ui.waitForFunction(() => document.querySelector('#readerTab').options.length > 1);
  await ui.locator('#readerTab').selectOption({ index: 1 }); await ui.locator('#selectReaderTab').click();
  await ui.waitForFunction(() => !document.querySelector('#quickPreview').disabled);
  assert.equal(r.app.profile, profilePath, 'the next book reuses the same dedicated profile');
  assert.match(await r.app.reader.page.evaluate(() => document.cookie), /ktz_dynamic_recovery=retained/);
  await selectPresetPreview();
  await ui.locator('#previewConfirmed').check(); await ui.locator('#approve').click();
  await wait(r.app, snapshot => snapshot.previewApproved && !snapshot.busy);
  assert.equal(second.job.manifest.images.length, 0, 'the next book preview is not an implicit start');
  await ui.locator('#start').click();
  const nextBook = await wait(r.app, snapshot => snapshot.job.job_path === second.job.job_path
    && snapshot.state === 'NeedsAttention' && !snapshot.busy && snapshot.lastFailure);
  assert.equal(nextBook.job.manifest.images.length, 1, 'the next book remains usable through the same public selection flow');
});
test('具体的Kindle初期定義: 公開選択だけで4項目・PNG・承認開始・安全停止ZIP、構造違いは拒否', async t => {
  await mkdir('artifacts/mvp-tests', { recursive: true });
  const directory = await mkdtemp(path.resolve('artifacts/mvp-tests/kindle-chrome-'));
  const r = await startApplication({ dataDir: path.join(directory, 'data'), sampleFixture: 'kindle-chrome' });
  const control = await openControlWindow(r.url, { headless: true });
  t.after(async () => { await control.close(); await r.close(); await rm(directory, { recursive: true, force: true }); });
  const ui = control.page;
  await ui.locator('#create').click(); await ui.locator('#openSample').click();
  await ui.waitForFunction(() => document.querySelector('#readerTab').options.length > 1);
  await ui.locator('#readerTab').selectOption({ index: 1 }); await ui.locator('#selectReaderTab').click();
  await ui.waitForFunction(() => !document.querySelector('#quickPreview').disabled);
  await ui.locator('#preset').selectOption('kindle-reader-chrome');
  await ui.waitForFunction(() => document.querySelector('#reader').value.includes('ancestor::div[5]'));
  const selected = (await r.app.snapshot()).presets.presets.find(p => p.id === 'kindle-reader-chrome');
  for (const field of ['frame', 'reader', 'identity', 'position', 'next']) assert.equal(await ui.locator(`#${field}`).inputValue(), selected.config[field]);
  await ui.locator('#quickPreview').click();
  await ui.waitForFunction(() => !document.querySelector('#previewImage').hidden);
  assert.deepEqual(await ui.locator('#previewImage').evaluate(img => [img.naturalWidth, img.naturalHeight]), [1120, 720]);
  assert.equal((await r.app.snapshot()).previewApproved, false);
  assert.equal((await r.app.snapshot()).job.manifest.images.length, 0);
  assert.equal(await ui.locator('#start').isDisabled(), true);
  await ui.locator('#previewConfirmed').check(); await ui.locator('#approve').click();
  await ui.waitForFunction(() => !document.querySelector('#start').disabled);
  await ui.locator('#start').click();
  const stopped = await wait(r.app, s => s.state === 'NeedsAttention' && !s.busy);
  assert.equal(stopped.job.manifest.images.length, 1);
  await ui.locator('[data-stage-target="export"]').first().click(); await ui.locator('#export').click();
  await ui.waitForFunction(() => document.querySelector('#exportResult').textContent.includes('保存先：'));
  const zipPath = await ui.locator('#destination').inputValue();
  const zip = await readFile(zipPath);
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  const offset = 30 + zip.readUInt16LE(26) + zip.readUInt16LE(28);
  const png = PNG.sync.read(zip.subarray(offset, offset + zip.readUInt32LE(18)));
  assert.deepEqual([png.width, png.height], [1120, 720]);
  await ui.locator('[data-stage-target="capture"]').first().click();
  await r.app.reader.page.locator('input[type=range]').evaluate(element => document.body.append(element));
  await Promise.all([ui.waitForResponse(response => response.url().endsWith('/api/command') && response.request().postDataJSON().action === 'quickPreview'), ui.locator('#quickPreview').click()]);
  const structureFailure = await wait(r.app, s => s.displayInspection?.status === 'failed' && !s.busy);
  assert.equal(structureFailure.displayInspection.detail.cause, 'kindle_chrome_structure_changed');
  await ui.waitForFunction(() => document.querySelector('#message').textContent.includes('タイトルの親枠'));
  assert.equal((await r.app.snapshot()).previewApproved, false);
  assert.equal(await ui.locator('#previewImage').isVisible(), false);
  assert.deepEqual(await readFile(zipPath), zip);
  await r.app.reader.page.locator('input[type=range]').evaluate(element => document.querySelector('#chromeSurface nav').append(element));
  await r.app.reader.page.locator('button[aria-label="次のページへ"]').evaluate(element => element.after(element.cloneNode(true)));
  await Promise.all([ui.waitForResponse(response => response.url().endsWith('/api/command') && response.request().postDataJSON().action === 'quickPreview'), ui.locator('#quickPreview').click()]);
  const duplicateFailure = await wait(r.app, s => s.displayInspection?.status === 'failed' && !s.busy);
  assert.equal(duplicateFailure.displayInspection.detail.cause, 'not_unique');
  assert.equal(duplicateFailure.displayInspection.detail.field, 'next');
});
test('Kindle初期定義の任意追加: 旧保存一覧・選択・編集中の4項目と同ID編集を上書きしない', async t => {
  await mkdir('artifacts/mvp-tests', { recursive: true });
  const directory = await mkdtemp(path.resolve('artifacts/mvp-tests/kindle-existing-'));
  const dataDir = path.join(directory, 'data'); await mkdir(dataDir);
  const old = { version: 1, selected: 'kindle-visible', presets: [{ id: 'kindle-visible', name: '以前からの設定', mode: 'visible', config: null }] };
  await writeFile(path.join(dataDir, 'reader-presets.json'), JSON.stringify(old));
  const r = await startApplication({ dataDir, sampleFixture: 'kindle-chrome' });
  const control = await openControlWindow(r.url, { headless: true });
  t.after(async () => { await control.close(); await r.close(); await rm(directory, { recursive: true, force: true }); });
  assert.deepEqual((await r.app.snapshot()).presets, old);
  const ui = control.page;
  await ui.locator('#create').click(); await ui.locator('#openSample').click();
  await ui.waitForFunction(() => document.querySelector('#readerTab').options.length > 1);
  await ui.locator('#readerTab').selectOption({ index: 1 }); await ui.locator('#selectReaderTab').click();
  await ui.waitForFunction(() => !document.querySelector('#quickPreview').disabled);
  await ui.locator('#presetEditor > summary').click();
  await ui.locator('#presetName').fill('未保存の編集');
  await ui.locator('#addKindlePreset').click();
  await ui.waitForFunction(() => document.querySelector('#preset').options.length === 2);
  assert.equal(await ui.locator('#presetName').inputValue(), '未保存の編集');
  assert.equal(await ui.locator('#preset').inputValue(), 'kindle-visible');
  assert.deepEqual((await r.app.snapshot()).presets.presets[0], old.presets[0]);
  await ui.locator('#preset').selectOption('kindle-reader-chrome');
  await ui.waitForFunction(() => document.querySelector('#reader').value.includes('ancestor::div[5]'));
  await ui.locator('#presetName').fill('本人の編集済み設定'); await ui.locator('#savePreset').click();
  await ui.waitForFunction(() => document.querySelector('#preset option:checked').textContent === '本人の編集済み設定');
  const edited = (await r.app.snapshot()).presets;
  await Promise.all([
    ui.waitForResponse(response => response.url().endsWith('/api/command') && response.request().postDataJSON().action === 'addKindlePreset'),
    ui.locator('#addKindlePreset').click(),
  ]);
  await wait(r.app, snapshot => !snapshot.busy);
  assert.deepEqual((await r.app.snapshot()).presets, edited);
  await control.close(); await r.close();
  const restarted = await startApplication({ dataDir, sampleFixture: 'kindle-chrome' });
  try { assert.deepEqual((await restarted.app.snapshot()).presets, edited); }
  finally { await restarted.close(); }
});
async function wait(app, predicate, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  do {
    const s = await app.snapshot();
    if (predicate(s)) return s;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  assert.fail('repair flow timed out');
}

// Observe an actual periodic render, rather than assuming one occurred during a
// fixed sleep. No application settings or success state are changed.
async function waitForPollRender(ui) {
  await ui.evaluate(() => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error('periodic UI render not observed')); }, 20_000);
    const observer = new MutationObserver(() => {
      observer.disconnect();
      clearTimeout(timer);
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
    observer.observe(document.querySelector('#nextAction'), { childList: true, subtree: true, characterData: true });
  }));
}
test('3ボタン公開導線: 同一app・同一profileでAを保存後にBを選択・承認・安全停止・ZIP保存する', async t => {
  await mkdir('artifacts/mvp-tests', { recursive: true });
  const directory = await mkdtemp(path.resolve('artifacts/mvp-tests/three-button-two-books-'));
  const r = await startApplication({ dataDir: path.join(directory, 'data'), sampleFixture: 'kindle-chrome' });
  const control = await openControlWindow(r.url, { headless: true });
  t.after(async () => { await control.close(); await r.close(); await rm(directory, { recursive: true, force: true }); });
  const ui = control.page;
  await ui.setViewportSize({ width: 390, height: 700 });
  await ui.waitForFunction(() => !document.querySelector('#decisionButton').disabled);
  assert.deepEqual(await ui.locator('.workflow-actions button').allTextContents(), ['決定・次へ', 'キャンセル・前へ', '終了・最初から']);
  const assertBarVisible = async () => {
    for (const [width, height] of [[390, 700], [1280, 650]]) {
      await ui.setViewportSize({ width, height });
      await ui.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      assert.ok(await ui.evaluate(() => document.documentElement.scrollHeight > innerHeight), 'workflow content remains scrollable');
      for (const id of ['decisionButton', 'cancelBackButton', 'finishBookButton']) {
        const result = await ui.locator(`#${id}`).evaluate(element => {
          const rect = element.getBoundingClientRect();
          return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right,
            hit: document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)?.id };
        });
        assert.ok(result.top >= 0 && result.bottom <= height && result.left >= 0 && result.right <= width,
          `${id} remains visible at ${width}x${height}: ${JSON.stringify(result)}`);
        assert.equal(result.hit, id, `${id} is not obscured at ${width}x${height}`);
      }
    }
    await ui.setViewportSize({ width: 390, height: 700 });
  };
  const next = async () => {
    await ui.locator('#decisionButton').click();
    await ui.waitForFunction(() => document.querySelector('#message').textContent !== '処理中…');
  };
  const chooseSampleAndPreset = async expectedProfile => {
    const details = ui.locator('[data-stage="browser"] details');
    if (!await details.evaluate(element => element.open)) await details.locator('summary').click();
    const session = expectedProfile ?? 'new';
    await ui.waitForFunction(id => [...document.querySelector('#session').options].some(option => option.value === id), session);
    await ui.locator('#keep').check();
    await ui.locator('#session').selectOption(session);
    await ui.locator('#openSample').click();
    await ui.waitForFunction(() => document.querySelector('#readerTab').options.length > 1);
    const target = await ui.locator('#readerTab').inputValue();
    if (!target) await ui.locator('#readerTab').selectOption({ index: 1 });
    await next();
    await wait(r.app, s => s.readerTabConfirmed && !s.busy);
    await ui.locator('#preset').selectOption('kindle-reader-chrome');
    await wait(r.app, s => s.presets.selected === 'kindle-reader-chrome' && !s.busy);
    await next();
    await ui.locator('#previewImage').waitFor({ state: 'visible' });
    const snapshot = await r.app.snapshot();
    const preset = snapshot.presets.presets.find(item => item.id === 'kindle-reader-chrome');
    for (const field of ['reader', 'identity', 'position', 'next']) assert.equal(await ui.locator(`#${field}`).inputValue(), preset.config[field]);
    assert.equal(snapshot.previewApproved, false);
    assert.equal(snapshot.job.manifest.images.length, 0);
    assert.equal(await ui.locator('#start').isDisabled(), true);
    await assertBarVisible();
  };
  await next();
  const first = await wait(r.app, s => Boolean(s.job) && !s.busy);
  const firstJobPath = first.job.job_path;
  await chooseSampleAndPreset();
  const profilePath = r.app.profile;
  const profileId = path.basename(profilePath);
  assert.match(profileId, /^saved-[a-f0-9-]{36}$/);
  await r.app.reader.page.evaluate(() => { document.cookie = 'ktz_two_book_profile=retained; Max-Age=86400; SameSite=Lax'; });
  await ui.locator('#previewConfirmed').check(); await next();
  assert.equal((await wait(r.app, s => s.previewApproved)).previewApproved, true);
  await next();
  const firstStopped = await wait(r.app, s => s.state === 'NeedsAttention' && !s.busy && s.job.manifest.images.length === 1);
  const firstOriginal = await r.app.image(1, true);
  await next(); // point the workflow at image inspection
  assert.equal(await ui.locator('[data-stage="review"]').isVisible(), true);
  await next(); // point the workflow at ZIP output
  assert.equal(await ui.locator('[data-stage="export"]').isVisible(), true);
  await next();
  await ui.waitForFunction(() => document.querySelector('#exportResult').textContent.includes('保存先：'));
  const firstZipPath = firstStopped.suggestedDestination;
  const firstZip = await readFile(firstZipPath);
  assert.equal(firstZip.readUInt32LE(0), 0x04034b50);
  assert.equal((await r.app.snapshot()).job.manifest.exports.length, 1);
  const firstOriginalHash = hash(firstOriginal);

  await ui.locator('#finishBookButton').click();
  const reset = await wait(r.app, s => !s.job && !s.browserOpen && !s.busy);
  assert.equal(reset.state, 'Idle');
  assert.deepEqual(await readFile(firstZipPath), firstZip);
  assert.equal(hash(await readFile(path.join(firstJobPath, 'originals/000001.png'))), firstOriginalHash);
  assert.equal((await stat(profilePath)).isDirectory(), true, 'ending a book retains its dedicated saved profile');
  assert.equal((await r.app.snapshot()).presets.selected, 'kindle-reader-chrome');
  await next();
  const second = await wait(r.app, s => Boolean(s.job) && s.job.job_path !== firstJobPath && !s.busy);
  const secondJobPath = second.job.job_path;
  assert.notEqual(second.job.manifest.job_id, firstStopped.job.manifest.job_id);
  await chooseSampleAndPreset(profileId);
  assert.equal(r.app.profile, profilePath, 'the next book reuses the exact dedicated Chromium profile');
  assert.match(await r.app.reader.page.evaluate(() => document.cookie), /ktz_two_book_profile=retained/);

  let advanceEntered;
  let releaseAdvance;
  const entered = new Promise(resolve => { advanceEntered = resolve; });
  const gate = new Promise(resolve => { releaseAdvance = resolve; });
  const originalAdvance = r.app.reader.advance.bind(r.app.reader);
  r.app.reader.advance = async cancelled => { advanceEntered(); await gate; return originalAdvance(cancelled); };
  await ui.locator('#previewConfirmed').check(); await next(); await next();
  await entered;
  assert.equal((await r.app.snapshot()).state, 'Capturing');
  await assert.rejects(r.app.command('prepareReset'), e => e.code === 'operation_busy');
  await ui.locator('#cancelBackButton').click();
  await ui.waitForFunction(() => document.querySelector('#cancelBackButton').disabled || document.querySelector('#state').textContent.includes('処理中'));
  assert.equal((await r.app.snapshot()).job.job_path, secondJobPath, 'no replacement job can open while the previous callback is pending');
  releaseAdvance();
  const secondStopped = await wait(r.app, s => s.state === 'Review' && !s.busy && s.job.manifest.images.length === 1);
  await ui.locator('#resetDialog').waitFor({ state: 'visible' });
  await ui.locator('#resetKeep').click();
  r.app.reader.advance = originalAdvance;
  assert.equal(secondStopped.job.job_path, secondJobPath);
  assert.equal(secondStopped.previewApproved, false);
  await next(); await next();
  await ui.waitForFunction(() => document.querySelector('#exportResult').textContent.includes('保存先：'));
  const secondZipPath = (await r.app.snapshot()).suggestedDestination;
  const secondZip = await readFile(secondZipPath);
  assert.equal(secondZip.readUInt32LE(0), 0x04034b50);
  assert.equal((await r.app.snapshot()).job.manifest.exports.length, 1);
  await assertBarVisible();
  await ui.reload();
  await ui.waitForFunction(() => document.querySelector('#state').textContent !== '接続中');
  assert.equal((await r.app.snapshot()).job.job_path, secondJobPath, 'UI reload does not reset or replace the active job');
  assert.equal(r.app.profile, profilePath);
  assert.deepEqual(await readFile(firstZipPath), firstZip, 'book B leaves the original A archive unchanged');
  assert.equal(hash(await readFile(path.join(firstJobPath, 'originals/000001.png'))), firstOriginalHash, 'book B leaves A originals unchanged');
});
test('Kindleプリセット表示候補: 非表示見出しを採らず可視titleと位置表示から手動指定なしで検査する', async t => {
  await mkdir('artifacts/mvp-tests', { recursive: true });
  const directory = await mkdtemp(path.resolve('artifacts/mvp-tests/preset-markers-'));
  const r = await startApplication({ dataDir: path.join(directory, 'data'), sampleFixture: 'layout' });
  const control = await openControlWindow(r.url, { headless: true });
  t.after(async () => { await control.close(); await r.close(); await rm(directory, { recursive: true, force: true }); });
  const ui = control.page;
  await ui.locator('#create').click(); await ui.locator('#openSample').click();
  await ui.waitForFunction(() => document.querySelector('#readerTab').options.length > 1);
  await ui.locator('#readerTab').selectOption({ index: 1 }); await ui.locator('#selectReaderTab').click();
  await ui.waitForFunction(() => !document.querySelector('#quickPreview').disabled);
  await r.app.reader.page.frameLocator('#readingFrame').locator('body').evaluate(body => {
    const hidden = document.createElement('h1'); hidden.hidden = true; hidden.textContent = 'hidden fixture heading'; body.append(hidden);
    const input = document.querySelector('#position');
    const label = document.createElement('div'); label.id = 'position'; label.textContent = '位置 7 / 12'; input.replaceWith(label);
    const title = document.querySelector('#readerChromeTitle');
    title.style.visibility = 'hidden';
    setTimeout(() => { title.style.visibility = ''; }, 700);
  });
  await ui.locator('#preset').selectOption('kindle-visible');
  await ui.locator('#quickPreview').click();
  await ui.waitForFunction(() => !document.querySelector('#previewImage').hidden);
  assert.equal(r.app.reader.config.identity, '#readerChromeTitle');
  assert.equal(r.app.reader.config.position, '#position');
  assert.equal((await r.app.snapshot()).previewApproved, false);
});
test('公開保存画面の遅延poll: 安全停止の反映で利用者のZIP画面を奪わない', async t => {
  await mkdir('artifacts/mvp-tests', { recursive: true });
  const directory = await mkdtemp(path.resolve('artifacts/mvp-tests/save-panel-'));
  const r = await startApplication({ dataDir: path.join(directory, 'data'), sampleFixture: 'layout' });
  const control = await openControlWindow(r.url, { headless: true });
  t.after(async () => { await control.close(); await r.close(); await rm(directory, { recursive: true, force: true }); });
  const ui = control.page;
  await ui.locator('#create').click(); await ui.locator('#openSample').click();
  await ui.waitForFunction(() => document.querySelector('#readerTab').options.length > 1);
  await ui.locator('#readerTab').selectOption({ index: 1 }); await ui.locator('#selectReaderTab').click();
  await ui.waitForFunction(() => !document.querySelector('#quickPreview').disabled);
  await ui.locator('#quickPreview').click(); await ui.waitForFunction(() => !document.querySelector('#previewImage').hidden);
  await ui.locator('#previewConfirmed').check(); await ui.locator('#approve').click();
  await ui.waitForFunction(() => !document.querySelector('#start').disabled);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await ui.route('**/api/state', async route => { await gate; const response = await route.fetch(); await route.fulfill({ response }); });
  try {
    await ui.locator('#start').click();
    await wait(r.app, s => s.state === 'NeedsAttention' && !s.busy);
    await ui.locator('[data-stage-target="export"]').first().click();
  } finally { release(); }
  await ui.unrouteAll({ behavior: 'wait' });
  await ui.waitForFunction(() => !document.querySelector('#export').disabled);
  assert.equal(await ui.locator('[data-stage="export"]').isVisible(), true);
  await ui.locator('#export').click();
  await ui.waitForFunction(() => document.querySelector('#exportResult').textContent.includes('保存先：'));
  assert.equal((await r.app.snapshot()).job.manifest.exports.length, 1);
});

test('Portable修復公開導線: プリセット・4/4失敗・安全停止ZIP・旧表紙splitの復帰', async t => {
  await mkdir('artifacts/mvp-tests', { recursive: true });
  const directory = await mkdtemp(path.resolve('artifacts/mvp-tests/repair-flow-'));
  const r = await startApplication({ dataDir: path.join(directory, 'data') });
  const control = await openControlWindow(r.url, { headless: true });
  t.after(async () => { await control.close(); await r.close(); await rm(directory, { recursive: true, force: true }); });
  const ui = control.page;
  await ui.locator('#create').click(); await ui.locator('#openSample').click();
  await ui.waitForFunction(() => document.querySelector('#readerTab').options.length > 1);
  await ui.locator('#readerTab').selectOption({ index: 1 }); await ui.locator('#selectReaderTab').click();
  await ui.waitForFunction(() => !document.querySelector('#quickPreview').disabled);
  await ui.locator('#pageOutputMode').selectOption('split_spread');
  await wait(r.app, s => !s.busy && s.captureSettings.page_output_mode === 'split_spread');
  await r.app.reader.page.locator('#stall').click();
  await r.app.reader.page.locator('#sheet').evaluate(canvas => {
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 600, 480);
    ctx.fillStyle = '#c75b38'; ctx.fillRect(160, 0, 280, 480);
    ctx.fillStyle = '#888'; ctx.fillRect(0, 220, 20, 40);
  });
  await ui.locator('#quickPreview').click();
  await ui.waitForFunction(() => !document.querySelector('#previewImage').hidden);
  assert.equal((await r.app.snapshot()).previewInfo.layout, 'single_page');
  await ui.locator('#previewConfirmed').check(); await ui.locator('#approve').click();
  await ui.waitForFunction(() => !document.querySelector('#start').disabled);
  await ui.locator('#start').click(); await wait(r.app, s => s.job.manifest.images.length >= 1);
  await ui.locator('#pause').click();
  const paused = await wait(r.app, s => !s.busy && s.state === 'Paused');
  const original = await r.app.image(1, true);
  assert.equal(paused.job.manifest.images[0].split, null);
  await ui.locator('#presetEditor > summary').click(); await ui.locator('#presetMode').selectOption('selectors');
  await ui.locator('#manualOptions > summary').click(); await ui.locator('#mappingDetails > summary').click();
  await ui.locator('#position').fill('#missing-position');
  await ui.locator('#quickPreview').click();
  await wait(r.app, s => s.displayInspection?.status === 'failed' && !s.busy);
  assert.equal(await ui.locator('#position').inputValue(), '#missing-position', 'poll must not overwrite the edit');
  assert.match(await ui.locator('#message').textContent(), /位置表示.*見つかりません/);
  assert.equal((await r.app.snapshot()).previewReady, false);
  assert.equal((await r.app.snapshot()).previewApproved, false);
  await ui.locator('[data-stage-target="export"]').first().click();
  assert.equal(await ui.locator('#format').inputValue(), 'zip');
  assert.equal(await ui.locator('#destination').inputValue(), paused.suggestedDestination);
  await ui.locator('#exportOptions > summary').click();
  await ui.locator('#format').selectOption('cbz'); assert.equal(await ui.locator('#destination').inputValue(), paused.suggestedDestination.replace(/\.zip$/, '.cbz'));
  await ui.locator('#format').selectOption('zip'); assert.equal(await ui.locator('#destination').inputValue(), paused.suggestedDestination);
  await ui.locator('#export').click();
  const exported = await wait(r.app, s => !s.busy && s.job.manifest.exports.length === 1);
  const destination = paused.suggestedDestination;
  const archive = await readFile(destination);
  const start = 30 + archive.readUInt16LE(26) + archive.readUInt16LE(28);
  const page = PNG.sync.read(archive.subarray(start, start + archive.readUInt32LE(18)));
  assert.deepEqual([page.width, page.height], [1200, 960]);
  assert.deepEqual([...page.data.subarray((480 * 1200 + 600) * 4, (480 * 1200 + 600) * 4 + 3)], [199, 91, 56]);
  assert.equal(exported.job.manifest.exports[0].range_confirmed, false);
  await ui.waitForFunction(() => document.querySelector('#exportResult').textContent.includes('保存先：'));
  assert.ok((await ui.locator('#exportResult').textContent()).includes(destination));
  await ui.locator('#export').click();
  await ui.waitForFunction(() => document.querySelector('#message').textContent.includes('既存'));
  assert.deepEqual(await readFile(destination), archive, 'existing ZIP is never overwritten');

  // An isolated legacy manifest, not injected live acquisition state. Restore
  // the old mechanical split representation to exercise the real open caller.
  await r.app.command('review');
  await r.app.command('crop', { id: 1, x: 200, y: 0, width: 800, height: 960 });
  const crop = (await r.app.snapshot()).job.manifest.images[0].crop;
  const croppedBytes = await r.app.image(1);
  await r.app.command('closeBrowser'); await r.app.command('closeJob');
  const manifestPath = path.join(paused.job.job_path, 'manifest.json');
  const m = JSON.parse(await readFile(manifestPath, 'utf8'));
  const image = m.images[0], png = PNG.sync.read(croppedBytes), halves = {}, version = m.next_render_version;
  for (const [side, x] of [['left', 0], ['right', 400]]) {
    const half = new PNG({ width: 400, height: 960 });
    PNG.bitblt(png, half, x, 0, 400, 960, 0, 0);
    const bytes = PNG.sync.write(half), relative = `rendered/000001-v${version}-${side}.png`;
    await writeFile(path.join(paused.job.job_path, relative), bytes, { flag: 'wx' });
    halves[side] = { path: relative, width: 400, height: 960, bytes: bytes.length, sha256: hash(bytes) };
  }
  image.split = { version, source_width: 800, source_height: 960, source_sha256: crop.sha256, boundary_x: 400, first_page: 'right', ...halves };
  delete image.page_layout; m.next_render_version = version + 1;
  await writeFile(manifestPath, JSON.stringify(m));
  await r.app.command('recover', { path: paused.job.job_path });
  const recovered = await r.app.snapshot();
  assert.equal(recovered.job.manifest.images[0].split, null);
  assert.deepEqual(recovered.job.manifest.images[0].crop, crop, 'user crop remains unchanged');
  assert.deepEqual(await r.app.image(1), croppedBytes);
  assert.deepEqual(recovered.job.manifest.selected_capture_ids, m.selected_capture_ids);
  assert.deepEqual(await r.app.image(1, true), original);
  assert.deepEqual(await readFile(destination), archive);
  const after = path.join(directory, 'after-recover.zip');
  await r.app.command('export', { destination: after, format: 'zip' });
  assert.equal((await r.app.snapshot()).job.manifest.exports.at(-1).entry_count, 1);
  for (const side of ['left', 'right']) assert.equal(hash(await readFile(path.join(paused.job.job_path, halves[side].path))), halves[side].sha256);
});

async function captureRepairSaveContext(ui, app, beforePreview) {
  await ui.locator('#create').click(); await ui.locator('#openSample').click();
  await ui.waitForFunction(() => document.querySelector('#readerTab').options.length > 1);
  await ui.locator('#readerTab').selectOption({ index: 1 }); await ui.locator('#selectReaderTab').click();
  await ui.waitForFunction(() => !document.querySelector('#quickPreview').disabled);
  await beforePreview?.();
  await ui.locator('#quickPreview').click(); await ui.waitForFunction(() => !document.querySelector('#previewImage').hidden);
  await ui.locator('#previewConfirmed').check(); await ui.locator('#approve').click();
  await ui.waitForFunction(() => !document.querySelector('#start').disabled);
  await ui.locator('#start').click();
  return wait(app, s => s.state === 'NeedsAttention' && !s.busy);
}
async function closeRepairSaveContext(ui, app) {
  if ((await app.snapshot()).browserOpen) {
    const destination = await ui.locator('#destination').inputValue();
    await ui.locator('[data-stage-target="browser"]').first().click();
    const browserDetails = ui.locator('[data-stage="browser"] details');
    if (!await browserDetails.evaluate(element => element.open)) await browserDetails.locator('summary').click();
    await ui.locator('#closeBrowser').click(); await wait(app, s => !s.browserOpen && !s.busy);
    assert.equal(await ui.locator('#destination').inputValue(), destination, '同じジョブのブラウザ終了では保存先編集を保持する');
  }
  await ui.locator('[data-stage-target="setup"]').first().click();
  const setupDetails = ui.locator('[data-stage="setup"] details');
  if (!await setupDetails.evaluate(element => element.open)) await setupDetails.locator('summary').click();
  await ui.locator('#closeJob').click(); await wait(app, s => !s.job && !s.busy);
}
async function saveRepairContextArchive(ui, app, count) {
  await ui.locator('#export').click();
  await wait(app, s => s.job.manifest.exports.length === count && !s.busy);
  await ui.waitForFunction(() => document.querySelector('#exportResult').textContent.includes('保存先：'));
}
test('案内追従: 案内変更は追従領域を見せ、pollと入力中の再描画はscroll/focusを奪わない', async t => {
  await mkdir('artifacts/mvp-tests', { recursive: true });
  const directory = await mkdtemp(path.resolve('artifacts/mvp-tests/guidance-scroll-'));
  const r = await startApplication({ dataDir: path.join(directory, 'data'), sampleFixture: 'layout' });
  const control = await openControlWindow(r.url, { headless: true });
  t.after(async () => { await control.close(); await r.close(); await rm(directory, { recursive: true, force: true }); });
  const ui = control.page;
  await ui.setViewportSize({ width: 320, height: 400 });
  await ui.waitForFunction(() => document.querySelector('#decisionButton').textContent === '決定・次へ');
  await ui.evaluate(() => {
    const context = document.querySelector('.workflow-context');
    const scroll = context.scrollTo.bind(context);
    window.guidanceScrollCalls = 0;
    context.scrollTo = (...args) => { window.guidanceScrollCalls++; return scroll(...args); };
  });
  await ui.locator('#create').click();
  await wait(r.app, snapshot => Boolean(snapshot.job) && !snapshot.busy);
  await ui.waitForFunction(() => {
    const context = document.querySelector('.workflow-context');
    return context.scrollTop > 0 && Math.abs(context.scrollHeight - context.clientHeight - context.scrollTop) < 0.5;
  });
  const guide = ui.locator('.workflow-context');
  const afterChange = await guide.evaluate(element => element.scrollTop);
  assert.ok(afterChange > 0, 'the changed main guidance is scrolled into the visible sticky context');
  assert.equal(await ui.locator('#message').evaluate(element => {
    const bounds = element.getBoundingClientRect();
    const context = element.closest('.workflow-context').getBoundingClientRect();
    return bounds.bottom <= context.bottom + 2 && bounds.top >= context.top && bounds.bottom <= innerHeight;
  }), true, 'the actual changed message is visible, not merely a nonzero scroll position');
  const callsAfterChange = await ui.evaluate(() => window.guidanceScrollCalls);
  assert.ok(callsAfterChange > 0);
  const pageScroll = await ui.evaluate(() => scrollY);
  await waitForPollRender(ui);
  assert.equal(await guide.evaluate(element => element.scrollTop), afterChange, 'unchanged poll does not repeat scrolling');
  assert.equal(await ui.evaluate(() => scrollY), pageScroll, 'the whole page does not move on an unchanged render');
  assert.equal(await ui.evaluate(() => window.guidanceScrollCalls), callsAfterChange, 'even redundant scrollTo calls are rejected');

  await ui.locator('[data-stage-target="setup"]').click();
  const setupDetails = ui.locator('[data-stage="setup"] details');
  if (!await setupDetails.evaluate(element => element.open)) await setupDetails.locator('summary').click();
  await ui.locator('#baseDir').focus();
  await ui.locator('#baseDir').fill('M:/anonymous-draft');
  const focusedBeforePoll = await ui.evaluate(() => document.activeElement.id);
  const scrollBeforePoll = await guide.evaluate(element => element.scrollTop);
  const callsBeforeInputPoll = await ui.evaluate(() => window.guidanceScrollCalls);
  await waitForPollRender(ui);
  assert.equal(await ui.evaluate(() => document.activeElement.id), focusedBeforePoll, 'poll keeps the focused input');
  assert.equal(await guide.evaluate(element => element.scrollTop), scrollBeforePoll, 'poll does not take the user away from an input');
  assert.equal(await ui.evaluate(() => window.guidanceScrollCalls), callsBeforeInputPoll);
});

test('点検画像待機分離: 遅い原本サムネイル中も公開ZIP保存は完了し、画像表示は後で復帰する', async t => {
  await mkdir('artifacts/mvp-tests', { recursive: true });
  const directory = await mkdtemp(path.resolve('artifacts/mvp-tests/image-wait-independent-'));
  const r = await startApplication({ dataDir: path.join(directory, 'data'), sampleFixture: 'layout' });
  const control = await openControlWindow(r.url, { headless: true });
  const ui = control.page;
  let release;
  let signal;
  const gate = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { signal = resolve; });
  t.after(async () => { release(); await ui.unrouteAll({ behavior: 'wait' }); await control.close(); await r.close(); await rm(directory, { recursive: true, force: true }); });
  await ui.route('**/api/image/**', async route => { signal(); await gate; const response = await route.fetch(); await route.fulfill({ response }); });
  const uiState = await captureRepairSaveContext(ui, r.app);
  await entered;
  assert.match(await ui.locator('#imageLoadStatus').textContent(), /読み込んでいます/);
  await ui.locator('[data-stage-target="export"]').first().click();
  await ui.waitForFunction(() => !document.querySelector('#export').disabled, null, { timeout: 5000 });
  const destination = path.join(directory, 'during-thumbnail-wait.zip');
  await ui.locator('#destination').fill(destination);
  await ui.locator('#export').click();
  const exported = await wait(r.app, snapshot => snapshot.job.manifest.exports.length === 1 && !snapshot.busy);
  assert.equal(exported.job.job_path, uiState.job.job_path);
  const archive = await readFile(destination);
  assert.equal(storedPngEntries(archive).length, 1, 'store-side ZIP verification runs while the inspection fetch is held');
  release();
  await ui.waitForFunction(() => document.querySelectorAll('#images article').length === 1);
  assert.equal((await r.app.snapshot()).job.manifest.images.length, 1);
});

test('ブラウザ終了だけの失敗: 原本点検/ZIPを続け、終了再入口で次へ進める', async t => {
  await mkdir('artifacts/mvp-tests', { recursive: true });
  const directory = await mkdtemp(path.resolve('artifacts/mvp-tests/reader-close-recovery-'));
  const r = await startApplication({ dataDir: path.join(directory, 'data'), sampleFixture: 'layout' });
  const control = await openControlWindow(r.url, { headless: true });
  t.after(async () => { await control.close(); await r.close(); await rm(directory, { recursive: true, force: true }); });
  const ui = control.page;
  const captured = await captureRepairSaveContext(ui, r.app);
  const original = await r.app.image(1, true);
  const reader = r.app.reader;
  const close = reader.close.bind(reader);
  let failOnce = true;
  reader.close = async () => { if (failOnce) { failOnce = false; throw new Error('fixture_reader_close_failed'); } return close(); };
  await ui.locator('#finishBookButton').click();
  const closeFailed = await wait(r.app, snapshot => snapshot.readerReleasePending && !snapshot.recoveryRequired && !snapshot.busy);
  assert.equal(closeFailed.job.job_path, captured.job.job_path);
  assert.equal(closeFailed.job.manifest.images.length, 1);
  await ui.locator('[data-stage-target="export"]').first().click();
  await ui.waitForFunction(() => !document.querySelector('#export').disabled);
  const zipPath = path.join(directory, 'reader-close-failed.zip');
  await ui.locator('#destination').fill(zipPath); await ui.locator('#export').click();
  await ui.waitForFunction(() => document.querySelector('#exportResult').textContent.includes('保存先：'));
  const zipBytes = await readFile(zipPath);
  assert.equal(storedPngEntries(zipBytes).length, 1);
  assert.deepEqual(await r.app.image(1, true), original);

  await ui.locator('#finishBookButton').click();
  const closed = await wait(r.app, snapshot => !snapshot.job && !snapshot.browserOpen && !snapshot.busy);
  assert.equal(closed.state, 'Idle', 'the safe-close entry point remains available for retry');
  assert.equal(closed.readerReleasePending, false);
  assert.deepEqual(await readFile(zipPath), zipBytes, 'the existing verified archive remains unchanged after retry');
  assert.deepEqual(await readFile(path.join(captured.job.job_path, 'originals/000001.png')), original, 'the confirmed original remains unchanged');
});
test('公開保存コンテキスト: 出力変更で成功を失効し別ジョブは自身のZIP先へ保存する', async t => {
  await mkdir('artifacts/mvp-tests', { recursive: true });
  const directory = await mkdtemp(path.resolve('artifacts/mvp-tests/save-context-'));
  const r = await startApplication({ dataDir: path.join(directory, 'data'), sampleFixture: 'layout' });
  const control = await openControlWindow(r.url, { headless: true });
  t.after(async () => { await control.close(); await r.close(); await rm(directory, { recursive: true, force: true }); });
  const ui = control.page;
  const first = await captureRepairSaveContext(ui, r.app);
  await ui.locator('[data-stage-target="export"]').first().click();
  await saveRepairContextArchive(ui, r.app, 1);
  const firstPath = first.suggestedDestination, firstArchive = await readFile(firstPath);
  await ui.locator('[data-stage-target="review"]').first().click(); await ui.locator('#review').click();
  await wait(r.app, s => s.state === 'Review' && !s.busy);
  await ui.locator('#cropId').fill('1'); await ui.locator('#cropWidth').fill('560'); await ui.locator('#cropHeight').fill('720');
  await ui.locator('#crop').click(); await wait(r.app, s => s.job.manifest.images[0].crop?.width === 560 && !s.busy);
  await ui.locator('[data-stage-target="export"]').first().click();
  assert.equal(await ui.locator('#exportResult').textContent(), '', 'クロップ後に以前の出力成功を表示しない');
  const custom = path.join(directory, 'chosen-first.cbz');
  await ui.locator('#exportOptions > summary').click();
  await ui.locator('#format').selectOption('cbz'); await ui.locator('#destination').fill(custom);
  await waitForPollRender(ui);
  assert.equal(await ui.locator('#destination').inputValue(), custom, 'pollは同じ作業の保存先編集を保持する');
  await saveRepairContextArchive(ui, r.app, 2);
  const customArchive = await readFile(custom);
  await closeRepairSaveContext(ui, r.app);
  const second = await captureRepairSaveContext(ui, r.app);
  await ui.locator('[data-stage-target="export"]').first().click();
  const secondPath = second.suggestedDestination;
  assert.equal(await ui.locator('#destination').inputValue(), secondPath, '新しい作業のフォルダを提案する');
  assert.equal(await ui.locator('#format').inputValue(), 'zip');
  assert.equal(await ui.locator('#exportResult').textContent(), '', '別ジョブの出力成功を表示しない');
  await saveRepairContextArchive(ui, r.app, 1);
  const secondArchive = await readFile(secondPath);
  const start = 30 + secondArchive.readUInt16LE(26) + secondArchive.readUInt16LE(28);
  const page = PNG.sync.read(secondArchive.subarray(start, start + secondArchive.readUInt32LE(18)));
  assert.deepEqual([page.width, page.height], [1120, 720]);
  assert.ok((await ui.locator('#exportResult').textContent()).includes(secondPath));
  assert.deepEqual(await readFile(firstPath), firstArchive);
  assert.deepEqual(await readFile(custom), customArchive);
});
test('公開保存コンテキスト: 任意の範囲確認を復元しpollの編集保護と別ジョブへの非継承を保つ', async t => {
  await mkdir('artifacts/mvp-tests', { recursive: true });
  const directory = await mkdtemp(path.resolve('artifacts/mvp-tests/save-range-context-'));
  const r = await startApplication({ dataDir: path.join(directory, 'data'), sampleFixture: 'layout' });
  const control = await openControlWindow(r.url, { headless: true });
  t.after(async () => { await control.close(); await r.close(); await rm(directory, { recursive: true, force: true }); });
  const ui = control.page;
  const first = await captureRepairSaveContext(ui, r.app);
  await ui.locator('[data-stage-target="export"]').first().click();
  await ui.locator('#exportOptions > summary').click(); await ui.locator('#rangeConfirmed').check();
  await waitForPollRender(ui);
  assert.equal(await ui.locator('#rangeConfirmed').isChecked(), true, 'pollは本人の明示ONを消さない');
  await saveRepairContextArchive(ui, r.app, 1);
  assert.equal((await r.app.snapshot()).job.manifest.exports[0].range_confirmed, true);
  await ui.reload(); await ui.waitForFunction(() => document.querySelector('#readerTab').options.length > 1);
  await ui.locator('[data-stage-target="export"]').first().click();
  assert.equal(await ui.locator('#rangeConfirmed').isChecked(), true, '確認済みの既存状態を復元する');
  await ui.locator('#destination').fill(path.join(directory, 'restored.zip'));
  await saveRepairContextArchive(ui, r.app, 2);
  assert.equal((await r.app.snapshot()).job.manifest.exports[1].range_confirmed, true, '通常保存で既存の確認を消さない');
  await ui.locator('#exportOptions > summary').click(); await ui.locator('#rangeConfirmed').uncheck();
  await waitForPollRender(ui);
  assert.equal(await ui.locator('#rangeConfirmed').isChecked(), false, 'pollは本人の明示OFFを戻さない');
  await ui.locator('#destination').fill(path.join(directory, 'unconfirmed.zip')); await saveRepairContextArchive(ui, r.app, 3);
  assert.equal((await r.app.snapshot()).job.manifest.exports[2].range_confirmed, false);
  await ui.locator('#rangeConfirmed').check();
  await ui.locator('#destination').fill(path.join(directory, 'confirmed-again.zip')); await saveRepairContextArchive(ui, r.app, 4);
  await closeRepairSaveContext(ui, r.app);
  await ui.locator('#recoverPath').fill(first.job.job_path); await ui.locator('#recover').click();
  await wait(r.app, s => s.job?.job_path === first.job.job_path && !s.busy);
  await ui.locator('[data-stage-target="export"]').first().click();
  assert.equal(await ui.locator('#rangeConfirmed').isChecked(), true, 'ジョブ復帰でも確認済み状態を復元する');
  await ui.locator('#destination').fill(path.join(directory, 'recovered.zip')); await saveRepairContextArchive(ui, r.app, 5);
  assert.equal((await r.app.snapshot()).job.manifest.exports[4].range_confirmed, true);
  await closeRepairSaveContext(ui, r.app);
  await captureRepairSaveContext(ui, r.app); await ui.locator('[data-stage-target="export"]').first().click();
  assert.equal(await ui.locator('#rangeConfirmed').isChecked(), false, '別ジョブの確認を引き継がない');
  await saveRepairContextArchive(ui, r.app, 1);
  const last = (await r.app.snapshot()).job.manifest;
  assert.equal(last.range_confirmed, false); assert.equal(last.exports[0].range_confirmed, false);
});


async function setupReviewCorrectionFlow(t) {
  await mkdir('artifacts/mvp-tests', { recursive: true });
  const directory = await mkdtemp(path.resolve('artifacts/mvp-tests/review-correction-'));
  const r = await startApplication({ dataDir: path.join(directory, 'data'), sampleFixture: 'kindle-chrome' });
  const control = await openControlWindow(r.url, { headless: true });
  t.after(async () => { await control.close(); await r.close(); await rm(directory, { recursive: true, force: true }); });
  const ui = control.page;
  await ui.locator('#create').click(); await ui.locator('#openSample').click();
  await ui.waitForFunction(() => document.querySelector('#readerTab').options.length > 1);
  await ui.locator('#readerTab').selectOption({ index: 1 }); await ui.locator('#selectReaderTab').click();
  await ui.waitForFunction(() => !document.querySelector('#quickPreview').disabled);
  await ui.locator('#preset').selectOption('kindle-reader-chrome');
  await wait(r.app, s => s.presets.selected === 'kindle-reader-chrome' && !s.busy);
  while (await ui.locator('details[open]:visible').count()) await ui.locator('details[open]:visible').first().locator(':scope > summary').click();
  return { r, ui };
}
test('独立レビュー補正: 通常主操作は追従3ボタンだけで無効理由も可視', async t => {
  const { ui } = await setupReviewCorrectionFlow(t);
  assert.deepEqual(await ui.locator('button:visible').allTextContents(), ['決定・次へ', 'キャンセル・前へ', '終了・最初から']);
  await ui.locator('#decisionButton').click(); await ui.locator('#previewImage').waitFor({ state: 'visible' });
  assert.equal(await ui.locator('#decisionButton').isDisabled(), true);
  assert.match(await ui.locator('#nextAction').textContent(), /チェック/);
});
test('独立レビュー補正: プレビューから前へ戻っても3ボタンだけで再確認・承認できる', async t => {
  const { r, ui } = await setupReviewCorrectionFlow(t);
  await ui.locator('#decisionButton').click(); await ui.locator('#previewImage').waitFor({ state: 'visible' });
  await ui.locator('#cancelBackButton').click();
  await ui.waitForFunction(() => !document.querySelector('[data-stage="browser"]').hidden);
  await ui.locator('#decisionButton').click();
  await ui.locator('[data-stage="capture"]').waitFor({ state: 'visible' });
  assert.equal(await ui.locator('[data-stage="capture"]').isVisible(), true);
  await ui.locator('#decisionButton').click(); await ui.locator('#previewImage').waitFor({ state: 'visible' });
  await ui.locator('#previewConfirmed').check(); await ui.locator('#decisionButton').click();
  await wait(r.app, s => s.previewApproved && !s.busy);
  assert.equal((await r.app.snapshot()).job.manifest.images.length, 0);
});
test('独立レビュー補正: 対象タブの選び直しでは旧本を承認・開始しない', async t => {
  const { r, ui } = await setupReviewCorrectionFlow(t);
  const second = await r.app.reader.context.newPage(); await second.goto(r.app.fixture.url);
  await ui.waitForFunction(() => document.querySelector('#readerTab').options.length === 3);
  await ui.locator('#readerTab').selectOption({ index: 1 }); await ui.locator('#selectReaderTab').click();
  await ui.waitForFunction(() => !document.querySelector('#quickPreview').disabled);
  await ui.locator('#decisionButton').click(); await ui.locator('#previewImage').waitFor({ state: 'visible' });
  const old = (await r.app.snapshot()).selectedReaderTab;
  await ui.locator('#readerTab').selectOption({ index: 2 });
  const draft = await ui.locator('#readerTab').inputValue(); assert.notEqual(draft, old);
  assert.equal(await ui.locator('#previewImage').isVisible(), false, '選び直した時点で旧プレビューを消す');
  await ui.locator('#decisionButton').click();
  await wait(r.app, s => s.selectedReaderTab === draft && !s.busy);
  assert.equal((await r.app.snapshot()).previewApproved, false);
  assert.equal((await r.app.snapshot()).job.manifest.images.length, 0);
  await ui.locator('#decisionButton').click(); await ui.locator('#previewImage').waitFor({ state: 'visible' });
  await ui.locator('#previewConfirmed').check(); await ui.locator('#decisionButton').click();
  assert.equal((await wait(r.app, s => s.previewApproved && !s.busy)).selectedReaderTab, draft);
});
test('分割描画の設定失効: 最後のPNG生成待ちで詳細指定を編集しても旧画像・承認を戻さない', async t => {
  for (const entry of ['normal', 'manual', 'individual']) await t.test(entry, async t => {
    const { r, ui } = await setupReviewCorrectionFlow(t);
    await ui.locator('#pageOutputMode').selectOption('split_spread');
    await wait(r.app, s => s.captureSettings.page_output_mode === 'split_spread' && !s.busy);
    if (entry === 'manual') await ui.locator('#manualOptions > summary').click();
    // Delay only the real second PNG encoder callback, not application state.
    await ui.evaluate(() => {
      const original = HTMLCanvasElement.prototype.toBlob;
      let calls = 0;
      HTMLCanvasElement.prototype.toBlob = function(callback, ...args) {
        const hold = ++calls === 2;
        return original.call(this, blob => {
          if (hold) window.releaseReviewSplitBlob = () => callback(blob);
          else callback(blob);
        }, ...args);
      };
      window.restoreReviewSplitBlob = () => { HTMLCanvasElement.prototype.toBlob = original; };
    });
    t.after(async () => {
      if (!ui.isClosed()) await ui.evaluate(() => { window.releaseReviewSplitBlob?.(); window.restoreReviewSplitBlob?.(); });
    });
    await ui.locator(entry === 'individual' ? '#quickPreview' : '#decisionButton').click();
    await ui.waitForFunction(() => Boolean(window.releaseReviewSplitBlob));
    if (!await ui.locator('#manualOptions').evaluate(element => element.open)) await ui.locator('#manualOptions > summary').click();
    await ui.locator('#mappingDetails > summary').click();
    const originalReader = await ui.locator('#reader').inputValue();
    await ui.locator('#reader').fill('#uninspected-reader-after-split');
    assert.equal(await ui.locator('#previewImage').isVisible(), false);
    await ui.evaluate(() => { window.releaseReviewSplitBlob(); window.restoreReviewSplitBlob(); });
    await ui.waitForFunction(() => document.querySelector('#message').textContent !== '処理中…');
    assert.equal(await ui.locator('#previewPages > figure').count(), 0, '編集前の片側画像も再追加しない');
    assert.equal(await ui.locator('#previewImage').getAttribute('src'), null);
    assert.equal(await ui.locator('#previewConfirmed').isDisabled(), true, '未検査の編集は旧プレビューで承認できない');
    assert.equal(await ui.locator('#start').isDisabled(), true);
    assert.doesNotMatch(await ui.locator('#message').textContent(), /プレビューを表示しました/);
    assert.equal((await r.app.snapshot()).previewApproved, false);
    assert.equal((await r.app.snapshot()).job.manifest.images.length, 0);
    // A fresh explicit inspection still works; cancellation must not strand UI.
    await ui.locator('#reader').fill(originalReader);
    await ui.locator('#decisionButton').click();
    await ui.waitForFunction(() => !document.querySelector('#approval').disabled);
    assert.equal(await ui.locator('#previewPages > figure').count(), 2);
    await ui.locator('#previewConfirmed').check(); await ui.locator('#decisionButton').click();
    await wait(r.app, s => s.previewApproved && !s.busy);
    assert.equal((await r.app.snapshot()).job.manifest.images.length, 0, '再承認でも明示開始は別操作');
  });
});
test('独立レビュー補正: 終了は一時profileを無断保存せず既存の保存指定は保持', async t => {
  const { r, ui } = await setupReviewCorrectionFlow(t);
  const temporary = r.app.profile;
  await ui.locator('#finishBookButton').click(); await wait(r.app, s => !s.job && !s.busy);
  await assert.rejects(stat(temporary), { code: 'ENOENT' });
  assert.deepEqual((await r.app.snapshot()).sessions, []);
  assert.equal((await r.app.snapshot()).preferredKindleSession, null);
  await ui.locator('#decisionButton').click(); await wait(r.app, s => Boolean(s.job) && !s.busy);
  await ui.locator('#keep').check(); await ui.locator('#session').selectOption('new');
  await ui.locator('#openSample').click(); await wait(r.app, s => s.browserOpen && !s.busy);
  const saved = r.app.profile;
  await ui.locator('#finishBookButton').click(); await wait(r.app, s => !s.job && !s.busy);
  assert.equal((await stat(saved)).isDirectory(), true);
  await ui.locator('#decisionButton').click(); await wait(r.app, s => Boolean(s.job) && !s.busy);
  await ui.locator('#keep').uncheck(); await ui.locator('#openSample').click();
  await wait(r.app, s => s.browserOpen && !s.busy);
  const off = r.app.profile;
  await ui.locator('#finishBookButton').click(); await wait(r.app, s => !s.job && !s.busy);
  await assert.rejects(stat(off), { code: 'ENOENT' });
  assert.deepEqual((await r.app.snapshot()).sessions, [{ id: path.basename(saved), saved: true }]);
});
test('独立レビュー補正: 終了・取消後の遅延PNG・旧command応答は成功や旧jobを復活させない', async t => {
  for (const ending of ['finish', 'cancel', 'target']) for (const delayed of ['png', 'command']) await t.test(`${ending}-${delayed}`, async t => {
    const { r, ui } = await setupReviewCorrectionFlow(t);
    let release, entered;
    const gate = new Promise(resolve => { release = resolve; });
    const holding = new Promise(resolve => { entered = resolve; });
    const pattern = delayed === 'png' ? '**/api/preview' : '**/api/command';
    await ui.route(pattern, async route => {
      if (delayed === 'command' && route.request().postDataJSON().action !== 'quickPreview') return route.continue();
      const response = await route.fetch(); entered(); await gate; await route.fulfill({ response });
    });
    t.after(() => release());
    await ui.locator('#decisionButton').click(); await holding;
    const previousJob = (await r.app.snapshot()).job.job_path;
    let expectedJob = previousJob;
    if (ending === 'finish') {
      await ui.locator('#finishBookButton').click(); await wait(r.app, s => !s.job && !s.busy);
      await ui.waitForFunction(() => !document.querySelector('[data-stage="setup"]').hidden);
      await ui.locator('#decisionButton').click();
      expectedJob = (await wait(r.app, s => Boolean(s.job) && !s.busy)).job.job_path;
      assert.notEqual(expectedJob, previousJob, '旧HTTP応答を待たず次の本を用意できる');
    } else if (ending === 'cancel') {
      await ui.locator('#cancelBackButton').click();
      await ui.waitForFunction(() => !document.querySelector('[data-stage="browser"]').hidden);
    } else {
      await r.app.reader.page.reload();
      await wait(r.app, s => !s.previewReady && !s.busy);
      await waitForPollRender(ui);
      // Pending HTTP/PNG work must not show an earlier failure as its current
      // result. The changed target still invalidates the retained preview.
      await ui.waitForFunction(() => document.querySelector('#previewImage').hidden);
      assert.equal(await ui.locator('#reason').textContent(), '');
    }
    release(); await ui.unrouteAll({ behavior: 'wait' }); await ui.waitForTimeout(100);
    assert.equal(await ui.locator('#previewImage').isVisible(), false);
    assert.equal(await ui.locator('#previewImage').getAttribute('src'), null);
    assert.equal(await ui.locator('#previewInfo').textContent(), '');
    assert.doesNotMatch(await ui.locator('#message').textContent(), /プレビューを表示|preview_required/);
    assert.equal(await ui.locator(`[data-stage="${ending === 'target' ? 'capture' : 'browser'}"]`).isVisible(), true);
    assert.equal((await r.app.snapshot()).job.job_path, expectedJob);
    assert.equal((await r.app.snapshot()).previewApproved, false);
  });
});
