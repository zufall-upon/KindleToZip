import './chromium-test-log-sink.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, cp } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const project = fileURLToPath(new URL('../', import.meta.url));
await mkdir(path.join(project, 'artifacts/mvp-tests'), { recursive: true });
const root = await mkdtemp(path.join(project, 'artifacts/mvp-tests/finite-archive-'));
// Relocate only the already fixed installation seam, as the existing Portable
// fixtures do. No Reader, live site, personal profile or real claim is used.
registerHooks({ load(url, context, next) {
  const result = next(url, context);
  if (!url.endsWith('/app/portable-linux-site.mjs')) return result;
  return { ...result, source: result.source.toString()
    .replace("const selectedBundle = '/home/user/KTZ-Portable';", `const selectedBundle = ${JSON.stringify(root)};`)
    .replace(/const ownRoot = fileURLToPath\([^\n]+/, `const ownRoot = ${JSON.stringify(root)};`) };
} });
process.env.KTZ_PORTABLE_ROOT = root;
process.umask(0o077);
const { startApplication } = await import('../app/server.mjs');
const { resolvePortableLinuxSession } = await import('../app/portable-linux-session.mjs');
const { claimPortableLimitedRun } = await import('../app/portable-limited-claim.mjs');
const { createPortableLimitedCaptureBudget } = await import('../app/expected-capture-budget.mjs');
const ticket = await import('../app/portable-postprocess-ticket.mjs');
const ticketName = 'portable-finite-archive-89045e6e.ticket';
const previousTicketName = 'portable-finite-archive-931f5e50.ticket';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const data = path.join(root, 'data/application');
await mkdir(path.join(root, 'data'), { mode: 0o700 });

function png(index) {
  const image = new PNG({ width: 80, height: 120 });
  for (let y = 0; y < 120; y++) for (let x = 0; x < 80; x++) {
    const i = (y * 80 + x) * 4;
    image.data[i] = (x * (index + 1) + y) % 255;
    image.data[i + 1] = (y * 3 + index * 70) % 255; image.data[i + 2] = x * 3; image.data[i + 3] = 255;
  }
  return PNG.sync.write(image);
}
async function save(store, bytes) {
  const { capture_id } = await store.call('capture_begin');
  await store.call('capture_chunk', { capture_id, data_base64: bytes.toString('base64') });
  await store.call('capture_commit');
}
function entries(bytes) {
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])); assert.notEqual(end, -1);
  let offset = bytes.readUInt32LE(end + 16); const result = [];
  for (let i = 0; i < bytes.readUInt16LE(end + 10); i++) {
    assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
    const local = bytes.readUInt32LE(offset + 42), size = bytes.readUInt32LE(offset + 24);
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    result.push(bytes.subarray(start, start + size));
    offset += 46 + bytes.readUInt16LE(offset + 28) + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
  }
  return result;
}

test('有限archive権限: 単回消費・正常停止だけの編集・原本保持と公開出力・復帰後再取得拒否', { skip: process.platform !== 'linux' }, async t => {
  let running = await startApplication({ dataDir: data, portableArchiveTrial: true });
  t.after(async () => { await running.close(); });
  const app = running.app, bytes = [png(0), png(1)];
  // The consumed permission remains present; the additional fixed grant must
  // neither reuse nor rewrite it, including after a restart.
  const previousTicket = path.join(data, previousTicketName);
  await mkdir(previousTicket, { mode: 0o700 });
  const previousBytes = Buffer.from(JSON.stringify({ grant: 'mission-931f5e50-e3f2-4f91-be32-3f1d88e4bbcd', consumed: true }));
  await writeFile(path.join(previousTicket, 'launch.json'), previousBytes, { flag: 'wx', mode: 0o600 });
  await app.command('create'); const job = app.job, id = job.manifest.job_id;
  const reservation = JSON.parse(await readFile(path.join(data, ticketName, 'reservation.json')));
  assert.equal(reservation.grant, 'mission-89045e6e-275b-4d3d-8ac0-6141b6c9f20f');
  const selected = await resolvePortableLinuxSession(data);
  for (const [action, input] of [['openBrowser', { mode: 'sample' }], ['setCaptureSettings', { image_format: 'jpeg' }], ['prepareReset', {}]])
    await assert.rejects(app.command(action, input), { code: 'portable_postprocess_unavailable' });
  const concurrent = await Promise.allSettled([ticket.reservePortableArchive(data), ticket.reservePortableArchive(data)]);
  assert.equal(concurrent.every(v => v.status === 'rejected'), true);
  await app.command('preparePortableKindle', { session: selected.id });
  await assert.rejects(ticket.assertPortableArchiveCapture(data, job, 'saved-00000000-0000-0000-0000-000000000001'));
  await ticket.consumePortableArchiveCapture(data, job, selected.id);
  await assert.rejects(ticket.consumePortableArchiveCapture(data, job, selected.id));
  await claimPortableLimitedRun(data, selected, job);
  const claim = path.join(data, `portable-reader-limited-${id}.claim`), claimBytes = await readFile(claim);
  await app.store.call('capture_start');
  const budget = createPortableLimitedCaptureBudget();
  budget.beginPreview(); await budget.screenshot('preview', async () => bytes[0]);
  assert.throws(() => budget.approve(3), { code: 'expected_capture_budget_exhausted' });
  budget.approve(2); budget.start(2);
  await save(app.store, bytes[0]); budget.commit();
  await budget.advance(async () => true); budget.confirmAdvance();
  await budget.screenshot('capture', async () => bytes[1]); await save(app.store, bytes[1]); budget.commit();
  await assert.rejects(budget.advance(async () => assert.fail('2回目の送りは禁止')), { code: 'expected_capture_budget_exhausted' });
  budget.finish(); await app.store.call('capture_stop');
  await app.store.call('set_review_order', { capture_ids: [1, 2] });
  app.job = (await app.store.call('job_info')).snapshot;
  assert.equal(await app.canPortableArchiveEdit(), false, 'PNGだけでは編集権限を作らない');
  await assert.rejects(app.command('crop', { id: 1, x: 0, y: 0, width: 40, height: 60 }), { code: 'portable_limited_review_only' });
  await assert.rejects(ticket.recordPortableArchiveCapture(data, app.job, { ...budget.snapshot(), phase: 'failed' }, digest(bytes[0])));
  await ticket.recordPortableArchiveCapture(data, app.job, budget.snapshot(), digest(bytes[0]));
  assert.equal(await app.canPortableArchiveEdit(), false, '正常取得だけでもReader終了前は拒否');
  await ticket.releasePortableArchive(data, app.job);
  app.readerReleasePending = true;
  assert.equal(await app.canPortableArchiveEdit(), false, '終了不明は解禁しない');
  await assert.rejects(app.command('export', { destination: path.join(root, 'forbidden.zip') }), { code: 'portable_limited_review_only' });
  app.readerReleasePending = false;
  assert.equal(await app.canPortableArchiveEdit(), true);
  await app.command('review', { ids: [2, 1] });
  await app.command('crop', { id: 1, x: 10, y: 12, width: 60, height: 96 });
  const outputs = [await app.image(2), await app.image(1)];
  for (const format of ['zip', 'cbz']) {
    const destination = path.join(root, `anonymous.${format}`);
    await app.command('export', { destination, format });
    assert.deepEqual(entries(await readFile(destination)), outputs, `${format}の順序・派生bytesが一致`);
  }
  for (const [action, input] of [['openBrowser', { mode: 'kindle', session: selected.id }], ['start', { confirmed: true }], ['prepareReset', {}]])
    await assert.rejects(app.command(action, input), { code: action === 'start' ? 'portable_limited_claim_consumed' : 'portable_limited_review_only' });
  assert.deepEqual(await readFile(claim), claimBytes);
  assert.deepEqual(await readFile(path.join(previousTicket, 'launch.json')), previousBytes);
  assert.deepEqual(await Promise.all([1, 2].map(id => app.image(id, true))), bytes);
  await running.close();
  running = await startApplication({ dataDir: data, portableArchiveTrial: true });
  await assert.rejects(running.app.command('create'), { code: 'portable_postprocess_unavailable' });
  assert.deepEqual(await readdir(path.join(data, 'jobs')), [id], '再起動後も2件目を作らない');
  assert.deepEqual((await readdir(data)).filter(n => n.endsWith('.ticket')).sort(), [ticketName, previousTicketName].sort());
  assert.deepEqual(await readFile(path.join(previousTicket, 'launch.json')), previousBytes);
  await running.app.command('recover', { path: job.job_path });
  assert.equal((await running.app.snapshot()).portableArchiveEditable, true, '正常終了済みは編集だけ復帰可');
  // Reuse the same anonymous limited/editable job for the public save caller.
  // The editing helper rejected export with image_review_required; a failed
  // response must not look like a completed archive or cause duplicate writes.
  const { openControlWindow } = await import('../app/control-window.mjs');
  const control = await openControlWindow(running.url, { headless: true });
  try {
    const page = control.page;
    await page.waitForFunction(() => document.body.dataset.limited === 'true'
      && document.querySelector('#images article img')?.naturalWidth > 0
      && document.querySelector('#decisionButton').dataset.action === 'inspect'
      && !document.querySelector('#decisionButton').disabled);
    assert.equal((await running.app.snapshot()).portableArchiveEditable, true);
    const languageManifest = JSON.stringify((await running.app.snapshot()).job.manifest);
    for (const [language, notice, source] of [
      ['en', /Reconnection and recapture are unavailable\. This is not a complete-book result\./, /Preview is allowed once; changes or errors stop the trial without retrying\./],
      ['zh-CN', /不能重新连接或获取。这不表示全书完成。/, /仅允许预览一次，发生变化或异常时将停止而不重试。/],
      ['ja', /再接続・再取得はできません。全冊完了ではありません。/, /プレビューは1回だけで、変更・異常時は再試行せず停止します。/],
    ]) {
      await page.locator('#language').selectOption(language);
      assert.match(await page.locator('#limitedReviewNotice').textContent(), notice);
      assert.match(await page.locator('#sourceIdentity').textContent(), source);
      assert.equal(await page.locator('#resumeCapture').isDisabled(), true, '翻訳で再取得を解禁しない');
      assert.equal(await page.locator('#finishBookButton').isVisible(), false, '翻訳で限定jobの終了導線を変えない');
    }
    assert.equal(JSON.stringify((await running.app.snapshot()).job.manifest), languageManifest, '翻訳は有限jobの保存状態を変更しない');
    assert.deepEqual(await readFile(claim), claimBytes, '翻訳は消費済みclaimを変更しない');
    await page.locator('#decisionButton').click();
    await page.waitForFunction(() => document.querySelector('#decisionButton').dataset.action === 'export'
      && !document.querySelector('#decisionButton').disabled);
    const destination = path.join(root, 'ui-anonymous.zip');
    await page.locator('#destination').fill(destination);
    let release, entered, settled, requests = 0;
    const held = new Promise(resolve => { release = resolve; });
    const enteredExport = new Promise(resolve => { entered = resolve; });
    const settledExport = new Promise(resolve => { settled = resolve; });
    const rejectExport = async route => {
      if (route.request().postDataJSON()?.action !== 'export') return route.continue();
      requests += 1; entered(); await held;
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
      assert.equal(requests, 1, '限定jobでも待機中の連打で追加要求しない');
    } finally {
      release(); if (requests) await settledExport;
      await page.unroute('**/api/command', rejectExport);
    }
    await page.waitForFunction(() => document.querySelector('#operationStatus').dataset.status === 'failure'
      && !document.querySelector('#decisionButton').disabled);
    assert.match(await page.locator('#message').textContent(), /画像点検してください/);
    assert.equal(await page.locator('#exportResult').textContent(), '');
    assert.equal((await running.app.snapshot()).job.manifest.exports.length, 2);
    await assert.rejects(readFile(destination), { code: 'ENOENT' });
    await page.locator('#decisionButton').click();
    await page.waitForFunction(destination => document.querySelector('#exportResult').dataset.destination === destination
      && document.querySelector('#operationStatus').dataset.status === 'success'
      && document.querySelector('#operationStatus').getAttribute('aria-busy') === 'false'
      && document.querySelector('#decisionButton').disabled, destination);
    assert.match(await page.locator('#exportResult').textContent(), /保存・再読検証済み/);
    const firstArchive = await readFile(destination);
    assert.deepEqual(entries(firstArchive), outputs, '限定jobの公開UI出力も採用順と派生bytesに一致');
    assert.equal((await running.app.snapshot()).job.manifest.exports.length, 3);
    assert.equal(await page.locator('[data-stage="export"]').isVisible(), true, '保存結果は画面内に表示する');
    await page.locator('#exportOptions > summary').click();
    await page.locator('#export').click();
    await page.waitForFunction(() => document.querySelector('#operationStatus').dataset.status === 'failure'
      && document.querySelector('#message').textContent.includes('既存ファイル'));
    assert.deepEqual(await readFile(destination), firstArchive, '限定jobでも同名出力を上書きしない');
    assert.equal((await running.app.snapshot()).job.manifest.exports.length, 3);
    const secondDestination = path.join(root, 'ui-anonymous-again.zip');
    await page.locator('#destination').fill(secondDestination);
    await page.waitForFunction(() => !document.querySelector('#decisionButton').disabled);
    await page.locator('#decisionButton').click();
    await page.waitForFunction(destination => document.querySelector('#exportResult').dataset.destination === destination
      && document.querySelector('#operationStatus').dataset.status === 'success'
      && document.querySelector('#operationStatus').getAttribute('aria-busy') === 'false'
      && document.querySelector('#decisionButton').disabled, secondDestination);
    assert.deepEqual(entries(await readFile(secondDestination)), outputs);
    assert.equal((await running.app.snapshot()).job.manifest.exports.length, 4, '限定jobでも別名での明示再保存は可能');
    assert.deepEqual(await readFile(claim), claimBytes);
    assert.deepEqual(await Promise.all([1, 2].map(id => running.app.image(id, true))), bytes);
  } finally { await control.close(); }
  await assert.rejects(running.app.command('openBrowser', { mode: 'kindle', session: selected.id }), { code: 'portable_limited_review_only' });
  const recoveredJob = running.app.job;
  await running.app.command('closeJob');
  // 別dataで同じ保存jobを開いても、元claimの読取制限とticketのdata identityを維持。
  const other = await startApplication({ dataDir: path.join(root, 'other') });
  try {
    await other.app.command('recover', { path: job.job_path });
    assert.equal((await other.app.snapshot()).portableLimitedJob, true);
    assert.equal((await other.app.snapshot()).portableArchiveEditable, false);
    await assert.rejects(other.app.command('crop', { id: 1, x: 0, y: 0, width: 40, height: 60 }), { code: 'portable_limited_review_only' });
    await cp(path.join(data, ticketName), path.join(other.app.dataDir, ticketName), { recursive: true, errorOnExist: true, force: false });
    assert.equal(await ticket.portableArchiveEditable(other.app.dataDir, recoveredJob), false, 'コピーしたticketにも権限はない');
  } finally { await other.close(); }
  // A newly created normal job records identity, not capture permission. Its
  // association survives closing/reopening that same job, but a different
  // saved session cannot borrow it. The historical ticket and claim stay intact.
  await running.close();
  running = await startApplication({ dataDir: data });
  await running.app.command('create');
  const normalJob = running.app.job;
  const normal = await import('../app/portable-normal-job.mjs');
  await normal.bindPortableNormalJob(data, normalJob, selected.id);
  await running.app.command('closeJob');
  await running.app.command('recover', { path: normalJob.job_path });
  await normal.assertPortableNormalJob(data, running.app.job, selected.id);
  await assert.rejects(normal.assertPortableNormalJob(data, running.app.job, 'saved-00000000-0000-0000-0000-000000000001'), { code: 'portable_normal_job_unavailable' });
  assert.deepEqual(await readFile(claim), claimBytes);
  assert.deepEqual(await readFile(path.join(previousTicket, 'launch.json')), previousBytes);
});

test('有限archive権限: 未完了予約・途中失敗・旧claimに後付け解禁しない', { skip: process.platform !== 'linux' }, async () => {
  const incomplete = path.join(root, 'incomplete'); await mkdir(incomplete, { mode: 0o700 });
  const ticketDir = path.join(incomplete, ticketName); await mkdir(ticketDir, { mode: 0o700 });
  await writeFile(path.join(ticketDir, 'reservation.json'), '{', { flag: 'wx', mode: 0o600 });
  await assert.rejects(ticket.reservePortableArchive(incomplete), { code: 'portable_postprocess_unavailable' });
  assert.equal(await ticket.portableArchiveAvailable(incomplete, null, true), false);
  const failed = path.join(root, 'failed'); await mkdir(failed, { mode: 0o700 });
  await ticket.reservePortableArchive(failed);
  await assert.rejects(ticket.reservePortableArchive(failed), { code: 'portable_postprocess_unavailable' });
  assert.equal(await ticket.portableArchiveEditable(failed, {}), false);
  const legacy = await startApplication({ dataDir: path.join(root, 'legacy') });
  try {
    await legacy.app.command('create'); const old = legacy.app.job;
    const selected = await resolvePortableLinuxSession(legacy.app.dataDir);
    await claimPortableLimitedRun(legacy.app.dataDir, selected, old);
    const normal = await import('../app/portable-normal-job.mjs');
    await assert.rejects(normal.markPortableNormalJob(legacy.app.dataDir, old), { code: 'portable_normal_job_unavailable' });
    await assert.rejects(normal.bindPortableNormalJob(legacy.app.dataDir, old, selected.id), { code: 'portable_normal_job_unavailable' });
    await assert.rejects(normal.assertPortableNormalJob(legacy.app.dataDir, old, selected.id), { code: 'portable_normal_job_unavailable' });
    assert.equal(await ticket.portableArchiveEditable(legacy.app.dataDir, old), false);
    await assert.rejects(legacy.app.command('export', { destination: path.join(root, 'old.zip') }), { code: 'portable_limited_review_only' });
  } finally { await legacy.close(); }
});
