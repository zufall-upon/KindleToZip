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
  const wait = async (predicate, timeout = 30_000) => {
    const deadline = Date.now() + timeout;
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
    // Deterministic anonymous page mutation after the real confirmed turn,
    // before capture of the next position. No errors, captures or sends are
    // stubbed; only the fixture's public state-control button is pressed.
    const reader = running.app.reader;
    const realAdvance = reader.advance.bind(reader);
    reader.advance = async (...args) => {
      await realAdvance(...args);
      if (await reader.page.locator('#position').inputValue() === '136') await reader.page.locator('#addDuplicate').click();
    };
    if (nearBoundary) await running.app.reader.page.locator('#startNearBoundary').click();
    await ui.locator('#preset').selectOption('kindle-reader-chrome');
    await wait(s => s.presets.selected === 'kindle-reader-chrome' && !s.busy);
    await next(); await ui.locator('#previewImage').waitFor({ state: 'visible' });
    await ui.locator('#previewConfirmed').check(); await next(); await next();
    const stopped = await wait(s => s.state === 'NeedsAttention' && !s.busy && s.lastFailure, 240_000);
    console.log('KTZ_RESUME:ambiguous-stop');
    const count = nearBoundary ? 3 : 67;
    assert.equal(stopped.job.manifest.images.length, count);
    assert.equal(stopped.lastFailure.detail?.field, 'next', JSON.stringify(stopped.lastFailure));
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
    assert.equal(await ui.locator('#resumeImage').evaluate(image => {
      const bounds = image.getBoundingClientRect(), parent = image.parentElement.getBoundingClientRect();
      return bounds.left >= parent.left && bounds.right <= parent.right && document.documentElement.scrollWidth <= innerWidth;
    }), true, '最後の原本も比較枠と画面幅からはみ出さない');
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
    // A resume approval makes the durable job ready, not every later preview
    // approved. Reinspection must require a fresh comparison of retained pages.
    assert.equal((await running.app.snapshot()).job.manifest.state, 'ready');
    await ui.locator('#quickPreview').click();
    await ui.waitForFunction(() => document.querySelector('#message').textContent !== '処理中…');
    await ui.locator('#previewImage').waitFor({ state: 'visible' });
    assert.equal(await ui.locator('#resumeLabel').isVisible(), true, '再開承認後の再プレビューでも照合チェックを表示する');
    assert.equal(await ui.locator('#resumeConfirmed').isChecked(), false);
    await ui.locator('#previewConfirmed').check();
    assert.equal(await ui.locator('#decisionButton').isDisabled(), true, '現在のプレビューの再開位置照合前には再承認できない');
    await assert.rejects(running.app.command('approve', { confirmed: true }), error => error.code === 'resume_confirmation_required');
    assert.equal((await running.app.snapshot()).previewApproved, false);
    assert.equal((await running.app.snapshot()).job.manifest.images.length, count);
    assert.equal(await readerPage.evaluate(() => window.anonymousTurns), count);
    await ui.locator('#resumeConfirmed').check(); await next();
    assert.equal((await running.app.snapshot()).previewApproved, true);
    assert.equal((await running.app.snapshot()).job.manifest.images.length, count, '再照合・再承認だけでも取得しない');
    assert.equal(await readerPage.evaluate(() => window.anonymousTurns), count, '再照合後も別の明示開始まで送らない');
    await next();
    const continued = await wait(s => s.state === 'NeedsAttention' && !s.busy && s.reason === 'end_candidate');
    console.log('KTZ_RESUME:continued');
    assert.equal(continued.job.manifest.images.length, count + 4, '136を超えて142まで同じ作業で保存');
    assert.deepEqual(continued.job.manifest.images.slice(0, count).map(image => image.sha256), originals);
    assert.equal(continued.job.manifest.images.some(image => image.duplicate_candidate), false);
    assert.equal(await readerPage.evaluate(() => window.anonymousTurns), count + 3, '欠落も二重送りもない');
    assert.ok(continued.job.manifest.images.every(image => image.book?.identity === continued.job.manifest.images[0].book.identity));

    // Extending the fixture changes the next-control pixels inside the
    // captured region. The position alone must not authorize skipping it.
    await next(); await ui.locator('#resumeCapture').click();
    await readerPage.locator('#extendSample').click();
    await next(); await ui.locator('#previewImage').waitFor({ state: 'visible' });
    await wait(s => s.resumePlan?.mode === 'blocked' && !s.busy);
    await assert.rejects(running.app.command('approve', { confirmed: true, resumeConfirmed: true }), error => error.code === 'resume_position_required');
    await assert.rejects(running.app.command('start', { confirmed: true }), error => error.code === 'explicit_start_required');
    assert.equal((await running.app.snapshot()).job.manifest.images.length, count + 4);
    assert.equal(await readerPage.evaluate(() => window.anonymousTurns), count + 3);
    // Only the anonymous fixture is manually moved to its uncaptured next
    // image; a fresh preview and separate approval/start are still required.
    await readerPage.locator('#next').click();
    await ui.locator('#quickPreview').click();
    await wait(s => s.resumePlan?.mode === 'capture' && !s.busy);
    console.log('KTZ_RESUME:last-preview');
    await ui.locator('#previewConfirmed').check(); await ui.locator('#resumeConfirmed').check(); await next();
    assert.equal((await running.app.snapshot()).job.manifest.images.length, count + 4);
    await next();
    const final = await wait(s => s.state === 'NeedsAttention' && !s.busy && s.reason === 'end_candidate');
    assert.equal(final.job.manifest.images.length, count + 6);
    assert.equal(await readerPage.evaluate(() => window.anonymousTurns), count + 5);
    assert.equal(final.job.manifest.images.some(image => image.duplicate_candidate), false);
    return { stoppedCount: count, stoppedPosition: '136', failure: stopped.lastFailure, continuedCount: count + 4, finalCount: count + 6,
      turns: count + 5, retainedOriginals: true, noDuplicateOrMissing: true, freshResumeConfirmation: true, samePositionDifferentPixelsBlocked: true,
      languages: ['ja', 'en', 'zh-CN'], elapsedSeconds: (Date.now() - began) / 1000 };
  } finally { await control.close(); await running.close(); }
}
