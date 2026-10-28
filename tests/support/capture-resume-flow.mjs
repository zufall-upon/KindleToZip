import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

// Anonymous public selection and real capture/turn operations only. The caller
// supplies either source modules or the hash-verified Portable runtime modules.
export async function checkCaptureResume({ startApplication, openControlWindow, evidence, nearBoundary = false }) {
  const began = Date.now();
  const running = await startApplication({ dataDir: path.join(evidence, 'resume-data') });
  const control = await openControlWindow(running.url, { headless: true });
  const ui = control.page;
  const wait = async predicate => {
    const deadline = Date.now() + 240_000;
    do { const s = await running.app.snapshot(); if (predicate(s)) return s; await new Promise(resolve => setTimeout(resolve, 100)); } while (Date.now() < deadline);
    const s = await running.app.snapshot();
    throw new Error(`匿名途中再開の状態待ちが期限超過: ${JSON.stringify({ state: s.state, reason: s.reason, plan: s.resumePlan, count: s.job?.manifest.images.length })}`);
  };
  const next = async () => {
    await ui.locator('#decisionButton').click();
    await ui.waitForFunction(() => document.querySelector('#message').textContent !== '処理中…');
  };
  try {
    await next();
    await ui.locator('#sampleFixture').selectOption('kindle-chrome-ambiguous');
    await ui.locator('#openSample').click();
    await ui.waitForFunction(() => document.querySelector('#readerTab').options.length > 1);
    await ui.locator('#readerTab').selectOption({ index: 1 }); await next();
    if (nearBoundary) await running.app.reader.page.locator('#startNearBoundary').click();
    await ui.locator('#preset').selectOption('kindle-reader-chrome');
    await wait(s => s.presets.selected === 'kindle-reader-chrome' && !s.busy);
    await next(); await ui.locator('#previewImage').waitFor({ state: 'visible' });
    await ui.locator('#previewConfirmed').check(); await next(); await next();
    const stopped = await wait(s => s.state === 'NeedsAttention' && !s.busy && s.lastFailure);
    console.log('KTZ_RESUME:ambiguous-stop');
    const count = nearBoundary ? 3 : 67;
    assert.equal(stopped.job.manifest.images.length, count);
    assert.equal(stopped.lastFailure.detail.field, 'next');
    assert.equal(stopped.lastFailure.detail.cause, 'not_unique');
    assert.equal(stopped.lastFailure.advanceDispatch, 'sent');
    assert.equal(stopped.lastFailure.stage, 'capture');
    assert.equal(stopped.job.manifest.checkpoint.position, '134');
    assert.equal(stopped.job.manifest.checkpoint.dispatch, 'confirmed');
    const readerPage = running.app.reader.page;
    assert.equal(await readerPage.locator('#position').inputValue(), '136');
    assert.equal(await readerPage.evaluate(() => window.anonymousTurns), count);
    const originals = stopped.job.manifest.images.map(image => image.sha256);
    await next(); await ui.locator('#resumeCapture').click();
    await readerPage.locator('#hideDuplicate').click();
    await next(); await ui.locator('#previewImage').waitFor({ state: 'visible' });
    await wait(s => s.resumePlan?.mode === 'capture' && !s.busy);
    console.log('KTZ_RESUME:next-preview');
    await ui.locator('#resumeImage').waitFor({ state: 'visible' });
    assert.equal(hash(await running.app.image(count, true)), originals.at(-1));
    assert.equal(await ui.locator('#approve').isDisabled(), true);
    for (const [language, expected] of [['en', 'Last committed image and resume position'], ['zh-CN', '最后确定图像与继续位置'], ['ja', '最後の確定画像と再開位置']]) {
      await ui.locator('#language').selectOption(language);
      await ui.getByText(expected, { exact: true }).waitFor();
      await ui.screenshot({ path: path.join(evidence, `resume-${language}.png`), fullPage: true });
    }
    await ui.locator('#previewConfirmed').check(); await ui.locator('#resumeConfirmed').check(); await next();
    assert.equal((await running.app.snapshot()).job.manifest.images.length, count, '承認だけでは再開しない');
    assert.equal(await readerPage.evaluate(() => window.anonymousTurns), count, '送信済みの送りを再送しない');
    await next();
    const continued = await wait(s => s.state === 'NeedsAttention' && !s.busy && s.reason === 'end_candidate');
    console.log('KTZ_RESUME:continued');
    assert.equal(continued.job.manifest.images.length, count + 4, '136を超えて142まで同じ作業で保存');
    assert.deepEqual(continued.job.manifest.images.slice(0, count).map(image => image.sha256), originals);
    assert.equal(continued.job.manifest.images.some(image => image.duplicate_candidate), false);
    assert.equal(await readerPage.evaluate(() => window.anonymousTurns), count + 3, '欠落も二重送りもない');
    assert.ok(continued.job.manifest.images.every(image => image.book?.identity === continued.job.manifest.images[0].book.identity));

    // Last original is still current, and its terminal preflight never sent.
    // Adding anonymous pages allows a separately approved advance-first resume.
    await next(); await ui.locator('#resumeCapture').click();
    await readerPage.locator('#extendSample').click();
    await next(); await ui.locator('#previewImage').waitFor({ state: 'visible' });
    await wait(s => s.resumePlan?.mode === 'advance' && !s.busy);
    console.log('KTZ_RESUME:last-preview');
    await ui.locator('#previewConfirmed').check(); await ui.locator('#resumeConfirmed').check(); await next();
    assert.equal((await running.app.snapshot()).job.manifest.images.length, count + 4);
    await next();
    const final = await wait(s => s.state === 'NeedsAttention' && !s.busy && s.reason === 'end_candidate');
    assert.equal(final.job.manifest.images.length, count + 6);
    assert.equal(await readerPage.evaluate(() => window.anonymousTurns), count + 5);
    assert.equal(final.job.manifest.images.some(image => image.duplicate_candidate), false);
    return { stoppedCount: count, stoppedPosition: '136', failure: stopped.lastFailure, continuedCount: count + 4, finalCount: count + 6,
      turns: count + 5, retainedOriginals: true, noDuplicateOrMissing: true, languages: ['ja', 'en', 'zh-CN'], elapsedSeconds: (Date.now() - began) / 1000 };
  } finally { await control.close(); await running.close(); }
}
