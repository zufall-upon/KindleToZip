// Explicit packaged diagnostic only. All business transitions use the ordinary
// owned control page's visible controls, never Application.command or HTTP APIs.
import assert from 'node:assert/strict';
import { lstat, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { privateMetadata } from './private-path.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function validateGuiSmokeRun() {
  if (process.platform !== 'linux' || process.argv.length !== 3 || process.argv[2] !== '--distribution-gui-smoke'
      || process.env.KTZ_PORTABLE_ROOT !== root) throw new Error('invalid_gui_smoke_invocation');
  const data = process.env.KTZ_USER_DATA_DIR;
  if (typeof data !== 'string' || path.basename(data) !== 'application') throw new Error('invalid_gui_smoke_data');
  const run = path.dirname(data);
  if (path.dirname(run) !== path.join(root, 'data') || !/^gui-smoke-[a-zA-Z0-9]{6}$/.test(path.basename(run))
      || await realpath(run) !== run || !privateMetadata(await lstat(run), true)) throw new Error('invalid_gui_smoke_data');
  const marker = path.join(run, 'anonymous-gui.json'), info = await lstat(marker);
  if (!privateMetadata(info) || info.size > 256 || await realpath(marker) !== marker
      || await readFile(marker, 'utf8') !== JSON.stringify({ version: 1, kind: 'new-anonymous-gui-run' })
      || (await readdir(run)).join(',') !== 'anonymous-gui.json') throw new Error('gui_smoke_data_not_fresh');
  return run;
}

function entries(bytes) {
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])); assert.ok(end >= 0);
  const count = bytes.readUInt16LE(end + 10); let offset = bytes.readUInt32LE(end + 16);
  const found = [];
  for (let i = 0; i < count; i++) {
    assert.equal(bytes.readUInt32LE(offset), 0x02014b50); assert.equal(bytes.readUInt16LE(offset + 10), 0);
    const size = bytes.readUInt32LE(offset + 24), nameLength = bytes.readUInt16LE(offset + 28);
    const local = bytes.readUInt32LE(offset + 42); assert.equal(bytes.readUInt32LE(local), 0x04034b50);
    const data = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    found.push({ name: bytes.subarray(offset + 46, offset + 46 + nameLength).toString('ascii'), bytes: bytes.subarray(data, data + size) });
    offset += 46 + nameLength + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
  }
  return found;
}

export async function runAnonymousGuiSmoke({ page, app }) {
  const run = path.dirname(app.dataDir);
  assert.equal(app.dataDir, process.env.KTZ_USER_DATA_DIR);
  assert.equal(path.dirname(run), path.join(root, 'data'));
  const controlUrl = new URL(page.url());
  assert.equal(controlUrl.hostname, '127.0.0.1'); assert.equal(controlUrl.protocol, 'http:');
  // The ordinary UI intentionally removes its initial capability fragment
  // with history.replaceState after capturing it. Never restore or print it.
  assert.equal(controlUrl.pathname, '/');
  assert.ok(controlUrl.hash === '' || /^#[a-f0-9]{64}$/.test(controlUrl.hash));
  assert.equal((await app.snapshot()).kindleSupported, false);
  const wait = async (label, predicate, timeout = 40000) => {
    const end = Date.now() + timeout; let state;
    do { state = await app.snapshot(); if (predicate(state)) return state; await pause(100); } while (Date.now() < end);
    throw new Error(`gui_smoke_wait:${label}:${state.state}:${state.reason}`);
  };
  const click = selector => page.locator(selector).click({ timeout: 20000 });
  const type = async (selector, value) => {
    const input = page.locator(selector);
    await input.click(); await input.press('ControlOrMeta+A'); await input.pressSequentially(String(value));
    assert.equal(await input.inputValue(), String(value));
  };
  const stage = async name => {
    await page.locator('#stageTools > summary').click();
    await click(`[data-stage-target="${name}"]`);
  };
  page.setDefaultTimeout(20000);
  await page.waitForFunction(() => document.querySelector('#state')?.textContent === '待機');
  await click('#decisionButton'); await wait('new job', state => Boolean(state.job) && !state.busy);
  await page.locator('#captureSource').selectOption('owned-fixture');
  await click('#decisionButton');
  const opened = await wait('owned reader', state => state.browserOpen && state.readerTabs.length === 1 && !state.busy, 70000);
  assert.equal(opened.sample, true); assert.equal(opened.finiteCaptureRequired, true);
  await page.locator('#readerTab').selectOption({ index: 1 });
  await click('#decisionButton');
  await wait('selected', state => Boolean(state.selectedReaderTab) && !state.busy);
  await click('#decisionButton');
  const preview = await wait('preview', state => state.previewReady && !state.busy);
  assert.equal(preview.job.manifest.images.length, 0);
  const previewShot = path.join(run, 'preview.png'); await page.screenshot({ path: previewShot, scale: 'css', fullPage: true });
  await type('#maxCaptures', 2); await page.locator('#previewConfirmed').check();
  await click('#decisionButton');
  const approved = await wait('approved', state => state.previewApproved && !state.busy);
  assert.equal(approved.approvedMaxCaptures, 2); assert.equal(approved.job.manifest.images.length, 0);
  await click('#decisionButton');
  const stopped = await wait('two captures', state => state.state === 'Review' && !state.busy, 60000);
  assert.equal(stopped.reason, 'capture_limit_reached'); assert.equal(stopped.job.manifest.images.length, 2);
  const job = stopped.job.job_path, images = stopped.job.manifest.images, ids = images.map(image => image.capture_id);
  const jobFile = relative => {
    assert.equal(typeof relative, 'string'); assert.ok(relative && !path.isAbsolute(relative) && !relative.split('/').some(part => part === '..' || !part));
    return path.join(job, relative);
  };
  const originals = await Promise.all(images.map(image => readFile(jobFile(image.path))));
  const decoded = originals.map(bytes => PNG.sync.read(bytes));
  assert.notEqual(digest(originals[0]), digest(originals[1]));
  const pixel = (png, x, y) => [...png.data.subarray((y * png.width + x) * 4, (y * png.width + x) * 4 + 4)];
  // The real compositor's color conversion affects saturated colors more than
  // the background (observed red 22 -> 28 on the rule). This positional oracle
  // still rejects clipping/borders; crop/archive
  // checks below remain exact against the saved original bytes and pixels.
  const sourceColor = (actual, expected, label, tolerance = 2) => assert.ok(actual[3] === 255
    && actual.slice(0, 3).every((channel, i) => Math.abs(channel - expected[i]) <= tolerance), label);
  for (const png of decoded) {
    assert.equal(png.width, images[0].width); assert.equal(png.height, images[0].height);
    sourceColor(pixel(png, 0, 0), [250, 246, 233], 'top-left boundary marker');
    sourceColor(pixel(png, png.width - 1, png.height - 1), [250, 246, 233], 'bottom-right boundary marker');
    sourceColor(pixel(png, Math.round(png.width * 40 / 600), Math.round(png.height * 32 / 480)), [22, 60, 103], 'fixture top rule', 8);
  }
  await page.locator('#orderDetails > summary').click();
  await type('#order', [...ids].reverse().join(',')); await click('#saveOrder');
  await wait('order', state => state.job.manifest.selected_capture_ids.join(',') === [...ids].reverse().join(',') && !state.busy);
  const width = images[0].width - 2, height = images[0].height - 2;
  for (const [id, value] of [['cropId', ids[0]], ['cropX', 1], ['cropY', 1], ['cropWidth', width], ['cropHeight', height]]) await type(`#${id}`, value);
  await click('#crop');
  const cropped = await wait('crop', state => state.job.manifest.images[0].crop?.width === width && !state.busy);
  const cropBytes = await readFile(jobFile(cropped.job.manifest.images[0].crop.path)); const crop = PNG.sync.read(cropBytes);
  assert.deepEqual([crop.width, crop.height], [width, height]);
  for (let y = 0; y < height; y++) assert.deepEqual(crop.data.subarray(y * width * 4, (y + 1) * width * 4),
    decoded[0].data.subarray(((y + 1) * decoded[0].width + 1) * 4, ((y + 1) * decoded[0].width + 1 + width) * 4));
  const reviewShot = path.join(run, 'review.png'); await page.screenshot({ path: reviewShot, fullPage: true, scale: 'css' });
  await click('#decisionButton');
  const zip = path.join(job, 'anonymous-gui.zip'), cbz = path.join(job, 'anonymous-gui.cbz');
  await type('#destination', zip); await click('#decisionButton');
  await wait('zip', state => state.job.manifest.exports.length === 1 && !state.busy);
  await page.locator('#exportOptions > summary').click(); await page.locator('#format').selectOption('cbz');
  await type('#destination', cbz); await click('#decisionButton');
  await wait('cbz', state => state.job.manifest.exports.length === 2 && !state.busy);
  const archives = [];
  for (const destination of [zip, cbz]) {
    const bytes = await readFile(destination), found = entries(bytes);
    assert.deepEqual(found.map(entry => entry.name), ['000001.png', '000002.png']);
    assert.deepEqual(found.map(entry => entry.bytes), [originals[1], cropBytes]);
    archives.push({ file: path.relative(run, destination), sha256: digest(bytes), entries: found.length });
  }
  const collision = path.join(job, 'anonymous-existing.cbz');
  await writeFile(collision, 'anonymous-existing-output', { flag: 'wx', mode: 0o600 });
  await type('#destination', collision); await click('#decisionButton');
  await page.waitForFunction(() => document.querySelector('#message').textContent.includes('出力先に既存ファイルがあります'));
  assert.equal(await readFile(collision, 'utf8'), 'anonymous-existing-output');
  const final = await app.snapshot(); assert.equal(final.job.manifest.exports.length, 2);
  for (let i = 0; i < images.length; i++) assert.deepEqual(await readFile(jobFile(images[i].path)), originals[i]);
  // Close the owned Reader through the ordinary visible auxiliary control.
  await stage('browser');
  const readerLifecycle = app.readerLifecycle;
  await page.locator('[data-stage="browser"] > details > summary').click(); await click('#closeBrowser');
  await wait('reader normal close', state => !state.browserOpen && !state.busy, 25000);
  assert.equal(readerLifecycle.state, 'closed_confirmed');
  return { version: 1, kind: 'fixed-anonymous-packaged-gui', result: 'pass', run: path.relative(root, run),
    resultPath: path.join(run, 'result.json'), approvedCaptures: 2, imagesBeforeStart: 0, captured: 2,
    finiteStop: true, originalsUnchanged: true, cropPixels: true, boundaryMarkers: true,
    selectedOrder: [...ids].reverse(), archivePixelsAndOrder: true, nonOverwrite: true,
    readerNormalClose: true, screenshots: [path.relative(root, previewShot), path.relative(root, reviewShot)],
    originalSha256: originals.map(digest), archives };
}
