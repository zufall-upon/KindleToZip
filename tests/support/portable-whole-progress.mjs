// This harness connects only to the owned anonymous Portable server. It uses
// the packaged Playwright/Chromium and real public UI, delaying image transfer
// (not fabricating progress) so a multiple-image intermediate frame is testable.
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkLanguageFlow } from './language-flow.mjs';
const root = process.env.KTZ_REVIEW_BUNDLE;
process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(root, 'artifacts/browsers');
process.env.KTZ_CONTROLLER_PATH = path.join(root, 'controller/ktz-g02-controller.exe');
const { chromium } = await import(pathToFileURL(path.join(root, 'node_modules/playwright/index.mjs')));
const { startApplication } = await import(pathToFileURL(path.join(root, 'app/server.mjs')));
const { withPublicDisclosures } = await import(pathToFileURL(path.join(root, 'poc/browser/public-ui-controls.mjs')));
const running = await startApplication({ dataDir: path.join(process.env.KTZ_REVIEW_EVIDENCE, 'measured-companion-data') });
const browser = await chromium.launch({ headless: true });
let release;
try {
  const page = withPublicDisclosures(await browser.newPage({ viewport: { width: 1100, height: 850 } }));
  let requests = 0;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/api/image/*', async route => {
    if (++requests === 2) await gate;
    await route.continue();
  });
  await page.goto(running.url);
  const details = page.locator('[data-stage="setup"] details');
  await details.locator('summary').click();
  await page.locator('#recoverPath').fill(process.env.KTZ_REVIEW_JOB);
  await page.locator('#recover').click();
  await page.waitForFunction(() => document.querySelector('#operationDetail').textContent.includes('点検画像の表示枚数 1/') || document.querySelector('#state').textContent.includes('再開'));
  await page.locator('[data-stage-target="review"]').first().click();
  await page.waitForFunction(() => document.querySelector('#operationDetail').textContent.includes('点検画像の表示枚数 1/'));
  const measured = await page.evaluate(() => {
    const bar = document.querySelector('#operationBar');
    const detail = document.querySelector('#operationDetail').textContent;
    const [, done, total, remaining] = detail.match(/ (\d+)\/(\d+)・残り(\d+)：/);
    return { done: +done, total: +total, remaining: +remaining,
      percent: document.querySelector('#operationPercent').textContent,
      barValue: +bar.getAttribute('aria-valuenow'),
      fillPercent: document.querySelector('#operationFill').getBoundingClientRect().width / bar.clientWidth * 100,
      visible: bar.getBoundingClientRect().bottom <= innerHeight };
  });
  assert.ok(measured.total > 1);
  assert.equal(measured.done, 1);
  assert.equal(measured.remaining, measured.total - 1);
  const expected = Math.floor(100 / measured.total);
  assert.equal(measured.percent, `${expected}%`);
  assert.equal(measured.barValue, expected);
  assert.ok(Math.abs(measured.fillPercent - expected) < 0.5);
  assert.equal(measured.visible, true);
  await page.screenshot({ path: path.join(process.env.KTZ_REVIEW_EVIDENCE, 'portable-multiple-images-pending.png') });
  release();
  await page.waitForFunction(() => document.querySelector('#operationPercent').textContent === '100%');
  await page.locator('[data-stage-target="export"]').first().click();
  assert.notEqual(await page.locator('#operationPercent').textContent(), '100%');
  await page.locator('#cancelBackButton').click();
  await page.locator('#resetDialog').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#operationPercent').textContent(), '割合未確定');
  assert.equal(await page.locator('#operationBar').getAttribute('aria-valuenow'), null);
  assert.match(await page.locator('#operationDetail').textContent(), /総量未確定.*残り不明.*選択待ち/);
  await page.screenshot({ path: path.join(process.env.KTZ_REVIEW_EVIDENCE, 'portable-reset-decision-wait.png') });
  await page.locator('#resetCancel').click();
  await page.waitForFunction(() => !document.querySelector('#resetDialog').open && document.querySelector('#operationStatus').dataset.status !== 'pending');
  assert.equal(await page.locator('#operationStatus').getAttribute('data-status'), 'cancelled');
  const languages = await checkLanguageFlow(page, name => page.screenshot({ path: path.join(process.env.KTZ_REVIEW_EVIDENCE, name) }));
  console.log(JSON.stringify({ ...measured, languages, separateOwnedControl: true, packagedModulesAndBrowser: true, anonymousJobCopy: true, nextStepCleared: true,
    resetDecisionWait: { percentageUnknown: true, totalUnknown: true, remainingUnknown: true, cancelledWithoutReset: true } }));
} finally { release?.(); await browser.close(); await running.close(); }
