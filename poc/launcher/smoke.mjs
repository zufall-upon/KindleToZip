import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { startApplication } from '../../app/server.mjs';
import { openControlWindow as openWindow } from '../../app/control-window.mjs';
import { withPublicDisclosures } from '../browser/public-ui-controls.mjs';
async function openControlWindow(...args) {
  const control = await openWindow(...args);
  return { ...control, page: withPublicDisclosures(control.page) };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const bundle = JSON.parse(await readFile(new URL('../../bundle-info.json', import.meta.url), 'utf8'));
const require = (condition, message) => { if (!condition) throw new Error(message); };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const dimensions = bytes => {
  require(bytes.length >= 24 && bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a', 'fixture_png_header');
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
};
function readStoredPngEntries(archive) {
  const entries = [];
  let offset = 0;
  while (offset + 30 <= archive.length && archive.readUInt32LE(offset) === 0x04034b50) {
    require(archive.readUInt16LE(offset + 6) === 0 && archive.readUInt16LE(offset + 8) === 0,
      'portable_zip_entries_are_unencrypted_and_stored');
    const compressedSize = archive.readUInt32LE(offset + 18);
    const uncompressedSize = archive.readUInt32LE(offset + 22);
    require(compressedSize === uncompressedSize, 'portable_zip_entry_size_matches');
    const nameLength = archive.readUInt16LE(offset + 26);
    const extraLength = archive.readUInt16LE(offset + 28);
    const start = offset + 30 + nameLength + extraLength;
    const end = start + compressedSize;
    require(end <= archive.length, 'portable_zip_entry_is_complete');
    const name = archive.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    const bytes = archive.subarray(start, end);
    entries.push({ name, bytes });
    offset = end;
  }
  require(entries.length > 0 && offset + 4 <= archive.length && archive.readUInt32LE(offset) === 0x02014b50,
    'portable_zip_contains_verified_png_entries');
  return entries;
}

function portablePaths() {
  assert.equal(process.versions.node, bundle.nodeVersion, 'bundled_node_version');
  assert.equal(bundle.playwrightVersion, '1.64.1', 'bundled_playwright_version');
  assert.equal(bundle.chromiumRevision, '1248', 'bundled_chromium_revision');
  const root = path.resolve(process.env.KTZ_PORTABLE_ROOT ?? '');
  const data = path.resolve(process.env.KTZ_USER_DATA_DIR ?? '');
  const runtime = path.resolve(process.env.KTZ_RUNTIME_DIR ?? '');
  const temp = path.resolve(process.env.KTZ_TEMP_DIR ?? '');
  assert.ok(root && data && runtime && temp, 'portable_paths_must_be_injected_by_launcher');
  assert.equal(data, path.join(root, 'data'), 'portable_data_is_adjacent_to_exe');
  assert.equal(temp, path.join(root, 'temp'), 'portable_temp_is_adjacent_to_exe');
  assert.equal(path.dirname(runtime), path.join(root, 'runtime'), 'portable_runtime_is_adjacent_to_exe');
  assert.equal(path.resolve(process.cwd()), runtime, 'runtime_working_directory_is_inside_portable_tree');
  assert.equal(process.env.KTZ_PORTABLE_HOME, undefined, 'legacy_portable_home_is_not_inherited');
  assert.equal(process.env.TEMP, temp, 'windows_TEMP_is_portable');
  assert.equal(process.env.TMP, temp, 'windows_TMP_is_portable');
  assert.equal(process.env.TMPDIR, temp, 'TMPDIR_is_portable');
  assert.equal(path.resolve(process.env.LOCALAPPDATA ?? ''), temp, 'LOCALAPPDATA_cache_path_is_portable');
  assert.equal(path.resolve(process.env.APPDATA ?? ''), temp, 'APPDATA_cache_path_is_portable');
  assert.equal(path.resolve(process.env.HOME ?? ''), temp, 'HOME_cache_path_is_portable');
  assert.equal(path.resolve(process.env.USERPROFILE ?? ''), temp, 'USERPROFILE_cache_path_is_portable');
  for (const key of ['XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME']) {
    assert.equal(path.resolve(process.env[key] ?? ''), temp, `${key}_is_portable`);
  }
  assert.equal(path.resolve(process.env.PLAYWRIGHT_BROWSERS_PATH ?? ''), path.join(runtime, 'artifacts/browsers'));
  const unavailableDevTools = (process.env.PATH ?? '').split(path.delimiter).every(directory =>
    !['node.exe', 'rustc.exe', 'cargo.exe'].some(file => {
      try { return existsSync(path.join(directory, file)); }
      catch { return false; }
    }));
  assert.equal(unavailableDevTools, true, 'developer_runtimes_must_not_be_available_on_PATH');
  return { root, data, runtime, temp };
}

function assertRelativeManifest(manifest) {
  for (const image of manifest.images) {
    assert.equal(path.isAbsolute(image.path), false, 'original_image_path_is_relative');
    if (image.crop) assert.equal(path.isAbsolute(image.crop.path), false, 'crop_path_is_relative');
    if (image.split) {
      assert.equal(path.isAbsolute(image.split.left.path), false, 'left_split_path_is_relative');
      assert.equal(path.isAbsolute(image.split.right.path), false, 'right_split_path_is_relative');
    }
  }
  for (const item of manifest.exports) {
    assert.equal(typeof item.file_name, 'string', 'exports_store_file_name_only');
    assert.equal(path.isAbsolute(item.file_name), false, 'export_file_name_is_not_absolute');
    assert.equal(/[\\/]/.test(item.file_name), false, 'export_file_name_has_no_path_components');
  }
}

async function openFixture(app, options = {}) {
  await app.command('openBrowser', { mode: 'sample', ...options });
  const opened = await app.snapshot();
  require(opened.readerTabs.length === 1, 'sample_tab_count');
  await app.command('selectReaderTab', { id: opened.readerTabs[0].id });
  return opened;
}

// Exercise the bundled public UI, not a preconfigured sample or injected CSS.
// Both browsers are headless and all reader content is self-authored loopback.
async function publicRepeatTargetPreview() {
  const running = await startApplication({ sampleHeadless: true });
  let control;
  try {
    control = await openControlWindow(running.url, { headless: true });
    const ui = control.page;
    await ui.locator('#create').click();
    await ui.locator('#sampleFixture').selectOption('kindle-chrome-tabs');
    await ui.locator('#openSample').click();
    await ui.waitForFunction(() => document.querySelector('#readerTab').options.length === 2);
    await ui.locator('#readerTab').selectOption({ index: 1 }); await ui.locator('#selectReaderTab').click();
    await ui.locator('#preset').selectOption('kindle-reader-chrome');
    await ui.waitForFunction(() => !document.querySelector('#quickPreview').disabled && document.querySelector('#reader').value.includes('readerChromeTitle'));
    const original = running.app.reader.page;
    await ui.locator('#quickPreview').click(); await ui.locator('#previewImage').waitFor({ state: 'visible' });
    const [reading] = await Promise.all([original.context().waitForEvent('page'), original.locator('#openSameBookTab').click()]);
    await reading.waitForLoadState('domcontentloaded');
    await ui.locator('#quickPreview').click();
    await ui.waitForFunction(() => document.querySelector('#message').textContent.includes('library_selected'));
    const failed = await running.app.snapshot();
    assert.equal(failed.displayInspection.code, 'reader_library_selected');
    assert.equal(failed.displayInspection.stage, 'reader_target_check');
    assert.equal(failed.previewReady, false);
    assert.equal(running.app.reader.page, original);
    await ui.waitForFunction(() => document.querySelector('#readerTab').options.length === 3);
    await ui.locator('#readerTab').selectOption({ index: 2 }); await ui.locator('#selectReaderTab').click();
    const previews = [];
    for (const button of ['quickPreview', 'quickPreview', 'preview']) {
      await ui.locator(`#${button}`).click(); await ui.locator('#previewImage').waitFor({ state: 'visible' });
      const snapshot = await running.app.snapshot();
      assert.equal(snapshot.previewReady, true);
      assert.equal(snapshot.previewApproved, false);
      assert.equal(snapshot.job.manifest.images.length, 0);
      await ui.waitForFunction(() => document.querySelector('#previewInfo').textContent.includes('中央画素：非単色'));
      assert.equal(running.app.reader.page, reading);
      previews.push(dimensions(running.app.previewImage));
    }
    assert.equal(await reading.locator('#position').inputValue(), '7');
    return { result: 'pass', diagnosis: 'reader_library_selected', previews, images: 0, approval: false };
  } finally { await control?.close(); await running.close(); }
}

async function publicLayoutPreview() {
  const results = [];
  for (const mode of ['kindle-preset', 'automatic', 'picker']) {
    const running = await startApplication({ sampleHeadless: true, sampleFixture: mode === 'kindle-preset' ? 'kindle-chrome' : 'layout' });
    let control;
    try {
      control = await openControlWindow(running.url, { headless: true });
      const ui = control.page;
      await ui.waitForFunction(() => document.querySelector('#state').textContent === '待機');
       await ui.locator('#create').click();
       if (mode === 'kindle-preset') await ui.locator('#sampleFixture').selectOption('kindle-chrome-hidden');
       await ui.locator('#openSample').click();
      await ui.waitForFunction(() => document.querySelector('#readerTab').options.length > 1);
      await ui.locator('#readerTab').selectOption({ index: 1 });
      await ui.locator('#selectReaderTab').click();
      await ui.waitForFunction(() => !document.querySelector('#quickPreview').disabled);
       if (mode === 'kindle-preset') {
         await ui.locator('#preset').selectOption('kindle-reader-chrome');
         await ui.waitForFunction(() => document.querySelector('#reader').value.includes('ancestor::div[5]'));
         assert.equal(await ui.locator('#identity').inputValue(), '#readerChromeTitle');
         assert.equal(await ui.locator('#position').inputValue(), 'input[type="range"]');
          assert.equal(await ui.locator('#next').inputValue(), 'button[aria-label*="次"], button[aria-label*="next" i]');
           const readerPage = running.app.reader.page;
           const peer = await readerPage.context().newPage();
           await peer.goto(readerPage.url());
           await peer.locator('#revealChrome').click();
           await ui.waitForFunction(() => document.querySelector('#readerTab').options.length === 3);
           await ui.locator('#readerTab').selectOption({ index: 1 }); await ui.locator('#selectReaderTab').click();
           await ui.waitForFunction(() => !document.querySelector('#quickPreview').disabled);
           const configured = Object.fromEntries(await Promise.all(['identity', 'position', 'next', 'reader'].map(async field => [field, await ui.locator(`#${field}`).inputValue()])));
           const nodes = await readerPage.evaluateHandle(() => [document.querySelector('#readerChromeTitle'), document.querySelector('#position'), document.querySelector('nav')]);
           for (const selector of ['#readerChromeTitle', '#position', 'nav']) assert.equal(await readerPage.locator(selector).isVisible(), false);
           assert.equal(await readerPage.locator('canvas').isVisible(), true);
           const started = Date.now();
           await ui.locator('#quickPreview').click();
           await ui.waitForFunction(() => document.querySelector('#message').textContent.includes('本の識別表示') && document.querySelector('#message').textContent !== '処理中…');
           const failed = await running.app.snapshot();
           assert.ok(Date.now() - started < 8000);
           assert.deepEqual(failed.displayInspection.detail, { field: 'identity', cause: 'hidden' });
           assert.equal(failed.displayInspection.stage, 'preview_visibility_wait');
           assert.equal(failed.previewApproved, false);
           assert.equal(failed.previewReady, false);
           assert.equal(failed.job.manifest.images.length, 0);
           assert.equal(running.app.previewImage, null);
           assert.equal(await ui.locator('#previewImage').isVisible(), false);
           for (const [field, selector] of Object.entries(configured)) {
             assert.equal(running.app.reader.config[field], selector);
             assert.equal(await ui.locator(`#${field}`).inputValue(), selector);
           }
           for (const field of ['identity', 'position', 'next', 'reader']) assert.equal(await ui.locator(`#${field}Status`).textContent(), '指定済み');
           assert.equal(running.app.reader.page, readerPage);
           for (const selector of ['#readerChromeTitle', '#position', 'nav']) assert.equal(await readerPage.locator(selector).isVisible(), false);
           await readerPage.locator('#revealChrome').click();
           assert.equal(await readerPage.evaluate(nodes => nodes.every(node => node.isConnected && getComputedStyle(node).visibility === 'visible'), nodes), true);
           await nodes.dispose(); await peer.close();
           results.push({ mode: 'kindle-initial-hidden', field: 'identity', cause: 'hidden', stage: failed.displayInspection.stage,
             elapsedMs: Date.now() - started, approved: false, capturedImages: 0, png: false, configuredFields: 4, tabs: 2,
             recovery: 'explicit-fixture-only-same-nodes' });
           await ui.locator('#quickPreview').click();
       } else if (mode === 'automatic') {
         await ui.locator('#preset').selectOption('kindle-visible');
         await ui.waitForFunction(() => document.querySelector('#presetMode').value === 'visible');
        await ui.locator('#presetEditor > summary').click();
        await ui.locator('#presetName').fill('配布試験のKindleプリセット');
        await ui.locator('#addPreset').click();
        await ui.waitForFunction(() => document.querySelector('#preset option:checked').textContent === '配布試験のKindleプリセット');
        const selectedPreset = await ui.locator('#preset').inputValue();
        await ui.locator('#preset').selectOption('kindle-visible');
        await ui.waitForFunction(() => document.querySelector('#presetName').value.includes('Kindle —'));
        await ui.locator('#preset').selectOption(selectedPreset);
        await ui.waitForFunction(() => document.querySelector('#presetName').value === '配布試験のKindleプリセット');
        assert.equal((await running.app.snapshot()).previewApproved, false);
        await ui.locator('#quickPreview').click();
      } else {
        await ui.locator('#manualOptions > summary').click();
        const page = running.app.reader.page;
        for (const [field, selector] of [['identity', '#readerChromeTitle'], ['position', '#position'], ['next', '#next'], ['reader', '#pageSurface']]) {
          await ui.locator(`#pick${field[0].toUpperCase()}${field.slice(1)}`).click();
          const deadline = Date.now() + 10_000;
          while ((await running.app.snapshot()).pickerStage !== 'waiting_click') {
            require(Date.now() < deadline, 'bundled_picker_wait_timeout');
            await sleep(25);
          }
          const box = field === 'reader' ? await page.locator('#readingFrame').boundingBox()
            : await page.frameLocator('#readingFrame').locator(selector).boundingBox();
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
          if (field === 'reader') {
            await ui.waitForFunction(() => !document.querySelector('#expandReader').disabled);
            assert.equal(await ui.locator('#preview').isDisabled(), true);
            await ui.locator('#expandReader').click();
          }
          await ui.waitForFunction(name => document.querySelector(`#${name}Status`).textContent === '指定済み', field);
          if (field === 'next') {
            assert.equal(await ui.locator('#reader').inputValue(), '');
            assert.equal(await ui.locator('#preview').isDisabled(), true);
          }
        }
        assert.equal(await ui.locator('#reader').inputValue(), '#pageSurface >> xpath=../../..', 'bundled_non_rendered_wrappers_skipped');
        assert.equal((await running.app.snapshot()).selectionFailure, null);
        assert.match(await ui.locator('#nextAction').textContent(), /決定・次へ.*指定した4項目/);
        await ui.locator('#preview').click();
      }
       try {
         await ui.waitForFunction(() => !document.querySelector('#previewImage').hidden, null, { timeout: 20_000 });
       } catch (error) {
         // Only fixed fixture identifiers/selectors, never real page content.
         const snapshot = await running.app.snapshot();
         console.log('KTZ_PUBLIC_FIXTURE_FAILURE:' + JSON.stringify({ mode, fixture: running.app.sampleFixture,
           config: running.app.reader.config, inspection: snapshot.displayInspection,
           titleCount: await running.app.reader.page.locator('#readerChromeTitle').count() }));
         throw error;
       }
      assert.deepEqual(await ui.locator('#previewImage').evaluate(image => [image.naturalWidth, image.naturalHeight]), [1120, 720]);
      assert.equal(await ui.locator('#start').isDisabled(), true);
      if (mode === 'picker') {
        await ui.locator('#previewConfirmed').check(); await ui.locator('#approve').click();
        await ui.waitForFunction(() => !document.querySelector('#start').disabled);
        await running.app.reader.page.locator('#readingFrame').evaluate(frame => { frame.src = frame.src; });
        await ui.waitForFunction(() => document.querySelector('#previewImage').hidden && document.querySelector('#start').disabled);
        assert.equal((await running.app.snapshot()).displayInspection, null);
        assert.match(await ui.locator('#state').textContent(), /表示検査待ち/);
        assert.match(await ui.locator('#nextAction').textContent(), /決定・次へ.*指定した4項目/);
        assert.equal(await ui.locator('#previewConfirmed').isChecked(), false);
        await ui.locator('#preview').click();
        await ui.waitForFunction(() => !document.querySelector('#previewImage').hidden);
        assert.deepEqual(await ui.locator('#previewImage').evaluate(image => [image.naturalWidth, image.naturalHeight]), [1120, 720]);
      }
      const snapshot = await running.app.snapshot();
      assert.equal(snapshot.previewApproved, false);
      assert.equal(snapshot.job.manifest.images.length, 0);
      results.push({ mode, dimensions: [1120, 720], approved: false, capturedImages: 0 });
       if (mode === 'automatic' || mode === 'kindle-preset') {
        await ui.locator('#previewConfirmed').check(); await ui.locator('#approve').click();
        await ui.waitForFunction(() => !document.querySelector('#start').disabled);
        await ui.locator('#start').click();
        const deadline = Date.now() + 20_000;
        while (!(await running.app.snapshot()).job.manifest.images.length) {
          require(Date.now() < deadline, 'public_ui_capture_timeout'); await sleep(50);
        }
        // The fictional layout deliberately has a stationary next button;
        // wait for its safety stop, not an injected acquisition state.
        while ((await running.app.snapshot()).busy) {
          require(Date.now() < deadline, 'public_ui_safety_stop_timeout'); await sleep(50);
        }
        const stopped = await running.app.snapshot();
        assert.equal(stopped.state, 'NeedsAttention');
        await ui.locator('[data-stage-target="export"]').first().click();
        assert.equal(await ui.locator('#format').inputValue(), 'zip');
        const destination = await ui.locator('#destination').inputValue();
        assert.equal(destination, path.join(stopped.job.job_path, '匿名の自作試料タイトル.zip'), 'bundled_public_export_uses_the_selected_book_name');
        await ui.locator('#export').click();
        await ui.waitForFunction(() => document.querySelector('#exportResult').textContent.includes('保存先：'));
        const zip = await readFile(destination);
        const offset = 30 + zip.readUInt16LE(26) + zip.readUInt16LE(28);
        const bytes = zip.subarray(offset, offset + zip.readUInt32LE(18));
        assert.equal(zip.readUInt32LE(0), 0x04034b50);
        assert.deepEqual(dimensions(bytes), [1120, 720]);
        assert.ok((await ui.locator('#exportResult').textContent()).includes(destination));
        results.at(-1).publicFlow = { presetSelected: true, approved: true, explicitlyStarted: true,
          safetyStopped: true, zipReopened: true, entryDimensions: [1120, 720] };
      }
    } finally { await control?.close(); await running.close(); }
  }
  return results;
}

async function publicTwoBookFlow() {
  const running = await startApplication({ sampleHeadless: true });
  let control;
  let ui;
  let releaseDelayedAdvance;
  const wait = async predicate => {
    const deadline = Date.now() + 30_000;
    let snapshot;
    while (Date.now() < deadline) {
      snapshot = await running.app.snapshot();
      if (predicate(snapshot)) return snapshot;
      await sleep(40);
    }
    throw new Error(`public_two_book_timeout:${snapshot?.state}:${snapshot?.reason}`);
  };
  const next = async () => {
    await control.page.locator('#decisionButton').click();
    await control.page.waitForFunction(() => document.querySelector('#message').textContent !== '処理中…');
  };
  const selectFixtureAndPreset = async profileId => {
    const ui = control.page;
    const details = ui.locator('[data-stage="browser"] details');
    if (!await details.evaluate(element => element.open)) await details.locator('summary').click();
    const session = profileId ?? 'new';
    await ui.waitForFunction(id => [...document.querySelector('#session').options].some(option => option.value === id), session);
    await ui.locator('#keep').check();
    await ui.locator('#session').selectOption(session);
    await ui.locator('#sampleFixture').selectOption('kindle-chrome-dynamic');
    await ui.locator('#openSample').click();
    await ui.waitForFunction(() => document.querySelector('#readerTab').options.length > 1);
    if (!await ui.locator('#readerTab').inputValue()) await ui.locator('#readerTab').selectOption({ index: 1 });
    await next();
    await wait(snapshot => snapshot.readerTabConfirmed && !snapshot.busy);
    await ui.locator('#preset').selectOption('kindle-reader-chrome');
    await wait(snapshot => snapshot.presets.selected === 'kindle-reader-chrome' && !snapshot.busy);
    await next();
    await ui.locator('#previewImage').waitFor({ state: 'visible' });
    const selected = (await running.app.snapshot()).presets.presets.find(preset => preset.id === 'kindle-reader-chrome');
    for (const field of ['reader', 'identity', 'position', 'next']) assert.equal(await ui.locator(`#${field}`).inputValue(), selected.config[field]);
    assert.equal((await running.app.snapshot()).previewApproved, false);
  };
  const assertWorkflowBarVisible = async () => {
    for (const [width, height] of [[390, 700], [1280, 650]]) {
      await ui.setViewportSize({ width, height });
      await ui.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      const metrics = await ui.evaluate(() => ({ scrollHeight: document.documentElement.scrollHeight, height: innerHeight }));
      require(metrics.scrollHeight > metrics.height, `workflow_page_is_scrollable:${width}x${height}`);
      const controls = await ui.locator('.workflow-actions button').evaluateAll(buttons => buttons.map(element => {
        const rect = element.getBoundingClientRect();
        return { id: element.id, text: element.textContent.trim(), top: rect.top, bottom: rect.bottom,
          left: rect.left, right: rect.right, hit: document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)?.id };
      }));
      assert.deepEqual(controls.map(button => button.text), ['決定・次へ', 'キャンセル・前へ', '終了・最初から']);
      for (const button of controls) {
        assert.ok(button.top >= 0 && button.bottom <= height && button.left >= 0 && button.right <= width,
          `visible_workflow_bar:${width}x${height}:${button.id}`);
        assert.equal(button.hit, button.id, `unobscured_workflow_button:${button.id}`);
      }
    }
    await ui.setViewportSize({ width: 390, height: 700 });
  };
  try {
    control = await openControlWindow(running.url, { headless: true });
    ui = control.page;
    await ui.setViewportSize({ width: 390, height: 700 });
    await next();
    const first = await wait(snapshot => Boolean(snapshot.job) && !snapshot.busy);
    const firstPath = first.job.job_path;
    await selectFixtureAndPreset();
    assert.deepEqual(await ui.locator('button:visible').allTextContents(), ['決定・次へ', 'キャンセル・前へ', '終了・最初から']);
    assert.equal(await ui.locator('#decisionButton').isDisabled(), true);
    assert.match(await ui.locator('#nextAction').textContent(), /チェック/);
    await ui.locator('#cancelBackButton').click();
    await ui.waitForFunction(() => !document.querySelector('[data-stage="browser"]').hidden);
    await next();
    assert.equal(await ui.locator('[data-stage="capture"]').isVisible(), true);
    await next(); await ui.locator('#previewImage').waitFor({ state: 'visible' });
    await assertWorkflowBarVisible();
    const profile = running.app.profile;
    const profileId = path.basename(profile);
    require(/^saved-[a-f0-9-]{36}$/.test(profileId), 'two_book_profile_is_persistent');
    await running.app.reader.page.evaluate(() => { document.cookie = 'ktz_packaged_two_book=retained; Max-Age=86400; SameSite=Lax'; });
    await ui.locator('#previewConfirmed').check(); await next();
    await wait(snapshot => snapshot.previewApproved);
    await next();
    const firstStopped = await wait(snapshot => snapshot.state === 'NeedsAttention' && !snapshot.busy && snapshot.job.manifest.images.length === 1);
    assert.equal(firstStopped.lastFailure.stage, 'advance_confirmation');
    assert.equal(firstStopped.lastFailure.advanceDispatch, 'sent');
    assert.deepEqual(firstStopped.lastFailure.detail, { field: 'next', cause: 'hidden' });
    await ui.waitForFunction(() => document.querySelector('#message').textContent.includes('確定1枚'));
    assert.doesNotMatch(await ui.locator('#message').textContent(), /取得は始めていません/);
    assert.doesNotMatch(await ui.locator('#nextAction').textContent(), /取得は始めていません/);
    assert.equal(await running.app.reader.page.locator('#position').inputValue(), '8');
    const firstOriginal = await running.app.image(1, true);
    await next(); await next(); await next();
    await ui.waitForFunction(() => document.querySelector('#exportResult').textContent.includes('保存先：'));
    const firstZipPath = await ui.locator('#destination').inputValue();
    assert.equal(firstZipPath, path.join(firstPath, '匿名の自作試料タイトル.zip'));
    const firstZip = await readFile(firstZipPath);
    const firstExport = await wait(snapshot => snapshot.job.manifest.exports.length === 1 && !snapshot.busy);
    const firstPngEntries = readStoredPngEntries(firstZip);
    assert.equal(firstPngEntries.length, firstExport.job.manifest.exports[0].entry_count);
    assert.equal(firstPngEntries.length, firstStopped.job.manifest.selected_capture_ids.length);
    assert.deepEqual(firstPngEntries.map(({ bytes }) => dimensions(bytes)), [[1120, 720]]);
    assert.deepEqual(firstPngEntries.map(({ bytes }) => digest(bytes)), [digest(firstOriginal)]);
    const firstOriginalHash = digest(firstOriginal);
    await ui.locator('[data-stage-target="capture"]').click();
    await ui.locator('#quickPreview').click();
    await ui.locator('#previewImage').waitFor({ state: 'visible' });
    await ui.locator('#previewConfirmed').check();
    await ui.locator('#resumeConfirmed').check();
    await ui.locator('#approve').click();
    await wait(snapshot => snapshot.previewApproved && !snapshot.busy);
    assert.equal((await running.app.snapshot()).job.manifest.images.length, 1);
    await ui.locator('#start').click();
    await wait(snapshot => snapshot.job.manifest.images.length >= 2);
    await ui.locator('#cancelBackButton').click();
    await ui.locator('#resetDialog').waitFor({ state: 'visible' });
    await ui.locator('#resetKeep').click();
    await ui.waitForFunction(() => !document.querySelector('#resetDialog').open && document.querySelector('#operationStatus').dataset.status !== 'pending');
    const resumed = await wait(snapshot => snapshot.state === 'Review' && !snapshot.busy);
    assert.deepEqual(await running.app.image(1, true), firstOriginal);
    await ui.locator('[data-stage-target="export"]').click();
    const resumedZipPath = path.join(firstPath, 'resumed.zip');
    await ui.locator('#destination').fill(resumedZipPath);
    await ui.locator('#export').click();
    await ui.waitForFunction(() => document.querySelector('#exportResult').textContent.includes('保存先：'));
    const resumedEntries = readStoredPngEntries(await readFile(resumedZipPath));
    assert.equal(resumedEntries.length, resumed.job.manifest.selected_capture_ids.length);
    for (const [index, entry] of resumedEntries.entries()) {
      assert.ok(dimensions(entry.bytes)[0] > 0);
      assert.equal(digest(entry.bytes), digest(await running.app.image(resumed.job.manifest.selected_capture_ids[index], true)));
    }
    await ui.locator('#finishBookButton').click();
    await wait(snapshot => !snapshot.job && !snapshot.browserOpen && !snapshot.busy);
    assert.deepEqual(await readFile(firstZipPath), firstZip, 'first_book_archive_retained');
    assert.equal(digest(await readFile(path.join(firstPath, 'originals/000001.png'))), firstOriginalHash, 'first_book_original_retained');
    assert.equal((await stat(profile)).isDirectory(), true, 'saved_browser_profile_retained');

    await next();
    const second = await wait(snapshot => Boolean(snapshot.job) && snapshot.job.job_path !== firstPath && !snapshot.busy);
    const secondPath = second.job.job_path;
    assert.notEqual(second.job.manifest.job_id, firstStopped.job.manifest.job_id);
    await selectFixtureAndPreset(profileId);
    assert.equal(running.app.profile, profile, 'same_profile_reused_in_same_application');
    assert.match(await running.app.reader.page.evaluate(() => document.cookie), /ktz_packaged_two_book=retained/);
    let advanceEntered;
    const entered = new Promise(resolve => { advanceEntered = resolve; });
    const gate = new Promise(resolve => { releaseDelayedAdvance = resolve; });
    const reader = running.app.reader;
    const advance = reader.advance.bind(reader);
    reader.advance = async cancelled => { advanceEntered(); await gate; return advance(cancelled); };
    await ui.locator('#previewConfirmed').check(); await next();
    await wait(snapshot => snapshot.previewApproved);
    await next();
    await entered;
    await ui.locator('#cancelBackButton').click();
    await wait(snapshot => !snapshot.previewReady && snapshot.busy);
    assert.equal((await running.app.snapshot()).job.job_path, secondPath, 'pending_cancel_retains_second_job');
    await assert.rejects(running.app.command('create'), /operation_busy/);
    await assert.rejects(running.app.command('export', { destination: path.join(secondPath, 'must-not-exist.zip') }), /operation_busy/);
    releaseDelayedAdvance();
    const secondStopped = await wait(snapshot => snapshot.state === 'Review' && !snapshot.busy && snapshot.job.manifest.images.length === 1);
    await ui.locator('#resetDialog').waitFor({ state: 'visible' });
    await ui.locator('#resetKeep').click();
    await ui.waitForFunction(() => !document.querySelector('#resetDialog').open && document.querySelector('#operationStatus').dataset.status !== 'pending');
    reader.advance = advance;
    assert.equal(secondStopped.previewApproved, false);
    await ui.waitForFunction(() => !document.querySelector('#decisionButton').disabled);
    await next(); await next();
    await ui.waitForFunction(() => document.querySelector('#exportResult').textContent.includes('保存先：'));
    const secondZipPath = await ui.locator('#destination').inputValue();
    assert.equal(secondZipPath, path.join(secondPath, '匿名の自作試料タイトル.zip'));
    assert.notEqual(secondZipPath, firstZipPath, 'book_named_defaults_are_owned_by_distinct_jobs');
    const secondZip = await readFile(secondZipPath);
    const secondExport = await wait(snapshot => snapshot.job.manifest.exports.length === 1 && !snapshot.busy);
    const secondPngEntries = readStoredPngEntries(secondZip);
    assert.equal(secondPngEntries.length, secondExport.job.manifest.exports[0].entry_count);
    assert.equal(secondPngEntries.length, secondStopped.job.manifest.selected_capture_ids.length);
    assert.deepEqual(secondPngEntries.map(({ bytes }) => dimensions(bytes)), [[1120, 720]]);
    assert.deepEqual(secondPngEntries.map(({ bytes }) => digest(bytes)), [digest(await running.app.image(1, true))]);
    assert.deepEqual(await readFile(firstZipPath), firstZip, 'second_book_does_not_change_first_archive');
    assert.equal(digest(await readFile(path.join(firstPath, 'originals/000001.png'))), firstOriginalHash, 'second_book_does_not_change_first_original');

    await assertWorkflowBarVisible();
    await ui.reload();
    await ui.waitForFunction(() => document.querySelector('#state').textContent !== '接続中');
    assert.equal((await running.app.snapshot()).job.job_path, secondPath, 'reload_keeps_second_book');
    assert.equal(running.app.profile, profile);
    return { sameApplicationProcess: true, sameProfile: true, firstJobId: firstStopped.job.manifest.job_id,
      secondJobId: second.job.manifest.job_id, firstZipEntries: firstPngEntries.length,
      secondZipEntries: secondPngEntries.length, delayedPriorOperationSafelyCancelled: true,
      profileCookieReused: true, firstArchiveRetained: true, firstOriginalRetained: true,
      allZipPngsReopened: true, narrowStickyButtonsVisible: true, wideStickyButtonsVisible: true,
      reloadKeepsSecondBook: true, dynamicHiddenFailureStage: firstStopped.lastFailure.stage,
      reviewResumeZipEntries: resumedEntries.length };
  } finally { releaseDelayedAdvance?.(); await control?.close(); await running.close(); }
}

async function createAndCapture(paths) {
  const running = await startApplication({ sampleHeadless: true });
  try {
    await running.app.command('create');
    await running.app.command('setCaptureSettings', {
      capture_scale: 2, page_output_mode: 'split_spread', reading_direction: 'right_to_left',
    });
    const initial = await openFixture(running.app);
    const temporaryProfile = running.app.profile;
    await running.app.command('quickPreview');
    const preview = await running.app.snapshot();
    assert.deepEqual(preview.previewInfo.cssDimensions, [600, 480]);
    assert.deepEqual(preview.previewInfo.dimensions, [1200, 960]);
    assert.equal(preview.previewInfo.deviceScaleFactor, 2);
    assert.equal(preview.previewInfo.pageOutputMode, 'split_spread');
    assert.equal(preview.previewInfo.readingDirection, 'right_to_left');
    assert.deepEqual(dimensions(running.app.previewImage), [1200, 960]);
    await running.app.command('approve', { confirmed: true });
    await running.app.command('start', { confirmed: true });

    const deadline = Date.now() + 45_000;
    let captured;
    while (Date.now() < deadline) {
      captured = await running.app.snapshot();
      if (captured.job.manifest.images.length >= 2) break;
      if (captured.state === 'NeedsAttention') throw new Error(`fixture_capture_stopped:${captured.reason}`);
      await sleep(40);
    }
    require(captured?.job.manifest.images.length >= 2, 'fixture_capture_two_images_timeout');
    await running.app.command('stop');
    const stopped = await running.app.snapshot();
    assert.equal(stopped.state, 'Review');
    const originalJobPath = stopped.job.job_path;
    const jobId = path.basename(originalJobPath);
    assert.equal(path.resolve(originalJobPath), path.join(paths.data, 'jobs', jobId));
    assert.equal(stopped.job.manifest.capture_settings.capture_scale, 2);
    assert.equal(stopped.job.manifest.capture_settings.page_output_mode, 'split_spread');
    assert.equal(stopped.job.manifest.capture_settings.reading_direction, 'right_to_left');
    assertRelativeManifest(stopped.job.manifest);

    const capturedIds = stopped.job.manifest.images.map(image => image.capture_id);
    const image = stopped.job.manifest.images[0];
    assert.equal(image.capture_scale, 2);
    assert.deepEqual([image.width, image.height], [1200, 960]);
    assert.equal(image.split.first_page, 'right');
    assert.equal(image.split.boundary_x, 600);
    const original = await readFile(path.join(originalJobPath, image.path));
    assert.equal(digest(original), image.sha256);
    assert.deepEqual(dimensions(original), [1200, 960]);
    for (const side of ['right', 'left']) {
      const rendered = await running.app.image(image.capture_id, false, side);
      assert.deepEqual(dimensions(rendered), [600, 960]);
    }

    await running.app.command('crop', { id: image.capture_id, x: 0, y: 0, width: 600, height: 960 });
    const cropped = (await running.app.snapshot()).job.manifest.images.find(item => item.capture_id === image.capture_id);
    assert.deepEqual([cropped.crop.width, cropped.crop.height], [600, 960]);
    assert.deepEqual(dimensions(await running.app.image(image.capture_id)), [600, 960]);
    assert.deepEqual(dimensions(await running.app.image(image.capture_id, true)), [1200, 960], 'crop_keeps_original');
    assert.deepEqual(dimensions(await running.app.image(image.capture_id, false, 'right')), [300, 960]);
    await running.app.command('review', { ids: [...capturedIds].reverse() });
    const reviewed = await running.app.snapshot();
    assert.deepEqual(reviewed.job.manifest.selected_capture_ids, [...capturedIds].reverse(), 'selected_image_order_is_persisted');

    const cbzPath = path.join(originalJobPath, 'portable-before-move.cbz');
    const zipPath = path.join(originalJobPath, 'portable-before-move.zip');
    const cbz = await running.app.command('export', { destination: cbzPath, format: 'cbz', warningsAccepted: true });
    const zip = await running.app.command('export', { destination: zipPath, format: 'zip', warningsAccepted: true });
    assert.equal(cbz.lastExport.entry_count, 4);
    assert.equal(zip.lastExport.entry_count, 4);
    for (const output of [cbzPath, zipPath]) assert.equal((await readFile(output)).readUInt32LE(0), 0x04034b50);
    const afterExport = await running.app.snapshot();
    assertRelativeManifest(afterExport.job.manifest);

    await running.app.command('closeBrowser');
    await assert.rejects(lstat(temporaryProfile), { code: 'ENOENT' }, 'temporary_reader_profile_is_deleted');
    assert.equal((await running.app.snapshot()).sessions.some(session => !session.saved), false, 'no_temporary_reader_session_remains');

    await openFixture(running.app, { keep: true });
    const savedProfile = running.app.profile;
    const profileId = path.basename(savedProfile);
    assert.match(profileId, /^saved-[a-f0-9-]{36}$/);
    const cookie = await running.app.reader.page.evaluate(() => {
      document.cookie = 'ktz_portable_sample=fixture-state; Max-Age=86400; SameSite=Lax';
      return document.cookie;
    });
    assert.match(cookie, /(?:^|;\s*)ktz_portable_sample=fixture-state(?:;|$)/, 'harmless_sample_cookie_created_with_explicit_saved_profile');
    await running.app.command('closeBrowser');
    assert.equal((await lstat(savedProfile)).isDirectory(), true, 'saved_profile_is_retained');
    await openFixture(running.app, { session: profileId });
    const sameLocationCookie = await running.app.reader.page.evaluate(() => document.cookie);
    assert.match(sameLocationCookie, /(?:^|;\s*)ktz_portable_sample=fixture-state(?:;|$)/, 'saved_browser_profile_reopens_before_move');
    await running.app.command('closeBrowser');

    const final = await running.app.snapshot();
    return {
      result: 'pass', phase: 'created', packageVersion: bundle.appVersion, nodeVersion: process.versions.node,
      controllerVersion: bundle.controllerVersion, playwrightVersion: bundle.playwrightVersion,
      chromiumRevision: bundle.chromiumRevision, cssDimensions: preview.previewInfo.cssDimensions,
      pngDimensions: [image.width, image.height], splitBoundary: image.split.boundary_x,
      splitFirstPage: image.split.first_page, splitPageDimensions: [image.split.right.width, image.split.left.width, image.split.left.height],
      capturedImages: final.job.manifest.images.length, capturedIds,
      selectedCaptureIds: final.job.manifest.selected_capture_ids,
      cropDimensions: [cropped.crop.width, cropped.crop.height],
      cbzEntries: cbz.lastExport.entry_count, zipEntries: zip.lastExport.entry_count,
      exportedFiles: [cbz.lastExport.file_name, zip.lastExport.file_name],
      jobId, savedProfileId: profileId,
      jobPathAtCreation: originalJobPath,
      relativeManifestPaths: true, developerPathToolsAvailable: false,
      temporaryReaderProfileRemoved: true, savedHarmlessSampleProfile: true,
    };
  } finally {
    await running.close();
  }
}

async function recoverAfterMove(paths, jobId, profileId) {
  const running = await startApplication({ sampleHeadless: true });
  try {
    const jobPath = path.join(paths.data, 'jobs', jobId);
    await running.app.command('recover', { path: jobPath });
    let snapshot = await running.app.snapshot();
    assert.equal(snapshot.state, 'ResumeCheck');
    assert.equal(path.resolve(snapshot.job.job_path), jobPath, 'recovered_snapshot_uses_the_moved_absolute_job_path');
    assert.ok(snapshot.job.job_path.startsWith(paths.root + path.sep), 'recovered_job_is_inside_the_current_exe_tree');
    assert.equal(snapshot.job.manifest.state, 'review');
    assert.equal(snapshot.job.manifest.images.length, 2);
    assert.equal(snapshot.job.manifest.capture_settings.capture_scale, 2);
    assert.equal(snapshot.job.manifest.capture_settings.page_output_mode, 'split_spread');
    assert.equal(snapshot.job.manifest.capture_settings.reading_direction, 'right_to_left');
    assert.deepEqual(snapshot.job.manifest.selected_capture_ids, [2, 1], 'saved_review_order_reopens');
    assertRelativeManifest(snapshot.job.manifest);

    const first = snapshot.job.manifest.images.find(image => image.capture_id === 1);
    const second = snapshot.job.manifest.images.find(image => image.capture_id === 2);
    assert.deepEqual(dimensions(await running.app.image(first.capture_id, true)), [1200, 960]);
    assert.deepEqual(dimensions(await running.app.image(first.capture_id)), [600, 960]);
    assert.deepEqual(dimensions(await running.app.image(first.capture_id, false, 'right')), [300, 960]);
    assert.deepEqual(dimensions(await running.app.image(first.capture_id, false, 'left')), [300, 960]);
    for (const record of snapshot.job.manifest.exports) {
      const bytes = await readFile(path.join(jobPath, record.file_name));
      assert.equal(bytes.length, record.bytes);
      assert.equal(digest(bytes), record.sha256);
      assert.equal(bytes.readUInt32LE(0), 0x04034b50);
    }
    assert.equal(snapshot.job.manifest.exports.length, 2, 'pre_move_archives_are_still_registered');

    await openFixture(running.app, { session: profileId });
    const cookie = await running.app.reader.page.evaluate(() => document.cookie);
    assert.match(cookie, /(?:^|;\s*)ktz_portable_sample=fixture-state(?:;|$)/, 'saved_browser_profile_reopens_after_move');
    await running.app.command('closeBrowser');
    assert.equal((await running.app.snapshot()).sessions.some(session => session.id === profileId && session.saved), true);

    // Recovered jobs are deliberately not resumed or captured automatically.
    // The saved sample is already in review state; review keeps the selected
    // order explicit before applying another non-destructive crop and exports.
    await running.app.command('review', { ids: snapshot.job.manifest.selected_capture_ids });
    await running.app.command('crop', { id: second.capture_id, x: 0, y: 0, width: 800, height: 960 });
    snapshot = await running.app.snapshot();
    assert.deepEqual(dimensions(await running.app.image(second.capture_id)), [800, 960]);
    assert.deepEqual(dimensions(await running.app.image(second.capture_id, true)), [1200, 960]);
    assert.deepEqual(snapshot.job.manifest.selected_capture_ids, [2, 1]);
    const cbzPath = path.join(jobPath, 'portable-after-move.cbz');
    const zipPath = path.join(jobPath, 'portable-after-move.zip');
    const cbz = await running.app.command('export', { destination: cbzPath, format: 'cbz', warningsAccepted: true });
    const zip = await running.app.command('export', { destination: zipPath, format: 'zip', warningsAccepted: true });
    assert.equal(cbz.lastExport.entry_count, 4);
    assert.equal(zip.lastExport.entry_count, 4);
    assert.equal((await readFile(cbzPath)).readUInt32LE(0), 0x04034b50);
    assert.equal((await readFile(zipPath)).readUInt32LE(0), 0x04034b50);
    assertRelativeManifest((await running.app.snapshot()).job.manifest);
    return {
      result: 'pass', phase: 'resumed-after-move', jobId, savedProfileId: profileId,
      jobPathAfterMove: jobPath, recoveredState: 'ResumeCheck',
      capturedImagesReused: snapshot.job.manifest.images.length,
      persistedOrder: snapshot.job.manifest.selected_capture_ids,
      settingsReused: snapshot.job.manifest.capture_settings,
      savedProfileCookieReused: true, movedCropWidth: 800,
      cbzEntries: cbz.lastExport.entry_count, zipEntries: zip.lastExport.entry_count,
      exportedFiles: [cbz.lastExport.file_name, zip.lastExport.file_name],
      automaticResumeOrCapture: false, relativeManifestPaths: true,
    };
  } finally {
    await running.close();
  }
}

if (process.argv[2] === '--distribution-lock-hold') {
  const paths = portablePaths();
  const running = await startApplication({ sampleHeadless: true });
  console.log(`KTZ_LOCK_READY:${paths.data}`);
  process.stdin.resume();
  await new Promise(resolve => process.stdin.once('data', resolve));
  process.stdin.pause();
  process.stdin.destroy();
  await running.close();
  console.log('KTZ_LOCK_RELEASED');
} else if (process.argv[2] === '--distribution-lock-probe') {
  portablePaths();
  try {
    const running = await startApplication({ sampleHeadless: true });
    await running.close();
    throw new Error('portable_data_directory_lock_was_not_exclusive');
  } catch (error) {
    if (error?.code !== 'job_busy') throw error;
    console.log('KTZ_LOCK_PROBE_RESULT:job_busy');
  }
} else if (process.argv[2] === '--distribution-resume-smoke') {
  const paths = portablePaths();
  const [, , , jobId, profileId] = process.argv;
  require(/^[a-z0-9-]+$/.test(jobId ?? ''), 'resume_job_id_required');
  require(/^saved-[a-f0-9-]{36}$/.test(profileId ?? ''), 'saved_profile_id_required');
  const result = await recoverAfterMove(paths, jobId, profileId);
  console.log(`KTZ_SMOKE_RESULT:${JSON.stringify({ ...result, developerPathToolsAvailable: false })}`);
} else if (process.argv[2] === '--distribution-smoke') {
  const paths = portablePaths();
  const result = await createAndCapture(paths);
  const publicPreviews = await publicLayoutPreview();
  const publicTwoBookFlowResult = await publicTwoBookFlow();
  const publicRepeatTarget = await publicRepeatTargetPreview();
  console.log(`KTZ_SMOKE_RESULT:${JSON.stringify({ ...result, publicPreviews, publicTwoBookFlow: publicTwoBookFlowResult, publicRepeatTarget,
    headlessOnly: true, portableDirectories: ['runtime', 'data', 'temp'], developerPathToolsAvailable: false })}`);
} else {
  throw new Error('distribution_smoke_mode_required');
}
