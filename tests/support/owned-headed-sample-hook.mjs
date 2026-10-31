// Test-only instrumentation in the real npm start process. The UI, Reader,
// HTTP server, browser and Rust controller are real; faults are labelled below.
import net from 'node:net';
import { writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { withPublicDisclosures } from '../../poc/browser/public-ui-controls.mjs';

if (process.platform === 'linux' && process.env.KTZ_SAMPLE_TEST_SOCKET && /(?:^|\/)app\/main\.mjs$/.test(process.argv[1] ?? '')) {
  const mode = process.env.KTZ_SAMPLE_TEST_MODE;
  const { Application } = await import('../../app/application.mjs');
  const { Reader } = await import('../../app/reader.mjs');
  const { chromium } = await import('playwright');
  const events = [], launches = []; let app, armed = false, sends = 0, screenshots = 0, committed = 0, injected = false;
  const command = Application.prototype.command;
  Application.prototype.command = function (...args) { app = this; return command.apply(this, args); };
  const acquire = Application.prototype.acquire;
  Application.prototype.acquire = async function (...args) {
    const call = this.store.call.bind(this.store);
    this.store.call = async (kind, input, ...rest) => {
      const result = await call(kind, input, ...rest);
      if (['capture_begin', 'capture_chunk', 'capture_commit', 'capture_abort', 'record_advance'].includes(kind)) events.push({ kind, dispatch: input?.dispatch });
      if (kind === 'capture_commit') committed++;
      if (kind === 'capture_chunk' && committed === 1 && !injected && ['target-book', 'target-page', 'target-node'].includes(mode)) {
        injected = true;
        await this.reader.page.evaluate(kind => {
          if (kind === 'target-book') document.querySelector('#reader').dataset.book = 'sample-b';
          else if (kind === 'target-page') document.querySelector('#next').click(); // Test-only own fixture change after capture.
          else { const canvas = document.querySelector('#sheet'); canvas.replaceWith(canvas.cloneNode(true)); }
        }, mode);
      }
      return result;
    };
    try { return await acquire.apply(this, args); } finally { this.store.call = call; }
  };
  const screenshot = Reader.prototype.screenshotVisibleClip;
  Reader.prototype.screenshotVisibleClip = function (...args) { screenshots++; return screenshot.apply(this, args); };
  const advance = Reader.prototype.advance;
  Reader.prototype.advance = async function (...args) {
    if (mode !== 'response-loss') return advance.apply(this, args);
    const mouse = this.page.mouse, click = mouse.click.bind(mouse);
    mouse.click = async (...point) => { sends++; await click(...point); throw new Error('injected_response_loss_after_send'); };
    try { return await advance.apply(this, args); } finally { mouse.click = click; }
  };
  if (mode === 'close-failure') {
    const close = Reader.prototype.close;
    Reader.prototype.close = async function () { await close.call(this); throw new Error('injected_close_failure_after_real_close'); };
  }
  const persistent = chromium.launchPersistentContext.bind(chromium);
  chromium.launchPersistentContext = async (...args) => {
    launches.push({ headless: args[1].headless, wayland: args[1].args?.includes('--ozone-platform=wayland') ?? false,
      emptyDisplay: args[1].env?.DISPLAY === '' });
    const context = await persistent(...args);
    const browser = context.browser(), create = browser.newBrowserCDPSession.bind(browser);
    browser.newBrowserCDPSession = async () => {
      const session = await create(), send = session.send.bind(session);
      session.send = async (method, params) => {
        if (armed && mode === 'state-failure' && method === 'Browser.getWindowBounds') throw new Error('injected_cdp_failure');
        const result = await send(method, params);
        if (armed && mode === 'minimized' && method === 'Browser.getWindowBounds') return { ...result, bounds: { ...result.bounds, windowState: 'minimized' } };
        if (armed && mode === 'window-mismatch' && method === 'Browser.getWindowForTarget') return { ...result, windowId: result.windowId + 1 };
        return result;
      };
      return session;
    };
    return context;
  };
  const launch = chromium.launch.bind(chromium);
  chromium.launch = async options => {
    const browser = await launch(options), newContext = browser.newContext.bind(browser);
    browser.newContext = async options => {
      const context = await newContext(options); let connected = false;
      context.on('page', page => page.on('domcontentloaded', async () => {
        if (connected || !page.url().startsWith('http://127.0.0.1:')) return;
        connected = true;
        const socket = net.createConnection(process.env.KTZ_SAMPLE_TEST_SOCKET);
        const send = value => socket.write(`${JSON.stringify(value)}\n`);
        const ui = withPublicDisclosures(page);
        const wait = async (predicate, label) => {
          const deadline = Date.now() + 35_000; let state;
          do { if (app) { state = await app.snapshot(); if (predicate(state)) return state; } await new Promise(resolve => setTimeout(resolve, 80)); } while (Date.now() < deadline);
          throw new Error(`timeout_${label}:${state?.state}:${state?.reason}`);
        };
        const api = (action, input = {}) => page.evaluate(async ({ action, input }) => {
          const response = await fetch('/api/command', { method: 'POST', headers: { Authorization: `Bearer ${sessionStorage.getItem('ktzLocalUiKey')}`,
            'Content-Type': 'application/json', Origin: location.origin }, body: JSON.stringify({ action, input }) });
          return { status: response.status, body: await response.json() };
        }, { action, input });
        let buffer = '';
        socket.on('data', chunk => {
          buffer += chunk;
          let end;
          while ((end = buffer.indexOf('\n')) >= 0) {
            const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
            if (message.action === 'close') { send({ event: 'closing' }); void page.close(); }
          }
        });
        try {
          await page.waitForFunction(() => document.querySelector('#state')?.textContent === '待機');
          await ui.locator('#create').click(); await wait(s => Boolean(s.job) && !s.busy, 'create');
          const invalid = [];
          for (const input of [{ mode: 'kindle' }, { mode: 'sample-headed', keep: true }, { mode: 'sample-headed', session: 'new' },
            { mode: 'sample-headed', sampleFixture: 'layout' }]) invalid.push(await api('openBrowser', input));
          if (mode === 'positive') {
            const normal = await api('openBrowser', { mode: 'sample', headless: false });
            if (normal.status !== 200) throw new Error(`normal_sample_failed:${normal.body.code}`);
            const closed = await api('closeBrowser');
            if (closed.status !== 200) throw new Error(`normal_sample_close_failed:${closed.body.code}`);
          }
          await ui.locator('#openOwnedSample').click();
          await wait(s => s.browserOpen && !s.busy, 'open');
          let noticeEn, noticeZh;
          if (mode === 'positive') {
            await page.locator('#language').selectOption('en'); noticeEn = await page.locator('#ownedSampleNotice').textContent();
            await page.locator('#language').selectOption('zh-CN'); noticeZh = await page.locator('#ownedSampleNotice').textContent();
            await page.locator('#language').selectOption('ja');
          }
          await ui.locator('#selectReaderTab').click();
          await wait(s => s.readerTabConfirmed && !s.busy, 'tab');
          await ui.locator('#quickPreview').click();
          const preview = await wait(s => s.previewReady && !s.busy, 'preview');
          const profile = app.profile;
          const previewCount = preview.job.manifest.images.length;
          const previewOriginals = (await readdir(path.join(preview.job.job_path, 'originals'))).length;
          const previewHash = createHash('sha256').update(app.previewImage).digest('hex');
          if (mode === 'positive') await writeFile(process.env.KTZ_SAMPLE_TEST_IMAGE, app.previewImage, { mode: 0o600 });
          const beforeStart = await api('start', { confirmed: true });
          await ui.locator('#previewConfirmed').check(); await ui.locator('#approve').click();
          const approved = await wait(s => s.previewApproved && !s.busy, 'approve');
          const approvedCount = approved.job.manifest.images.length;
          const approvedOriginals = (await readdir(path.join(approved.job.job_path, 'originals'))).length;
          const notice = await ui.locator('#ownedSampleNotice').textContent();
          if (['minimized', 'state-failure', 'window-mismatch'].includes(mode)) {
            const before = screenshots; armed = true;
            const denied = await api('start', { confirmed: true });
            const state = await app.snapshot();
            send({ event: 'result', mode, invalid, preview: previewCount, approved: approvedCount, previewOriginals, approvedOriginals,
              beforeStart: beforeStart.body.code, denied: denied.body.code, status: denied.status, screenshotBefore: before,
              screenshotAfter: screenshots, images: state.job.manifest.images.length, notice });
            return;
          }
          await ui.locator('#start').click();
          let stopped;
          if (mode === 'positive' || mode === 'close-failure') {
            await wait(s => s.job.manifest.images.length >= 2, 'two-images');
            await ui.locator('#pause').click();
            stopped = await wait(s => s.state === 'Paused' && !s.busy, 'pause');
          } else stopped = await wait(s => s.state === 'NeedsAttention' && !s.busy, 'fault-stop');
          await app.loop;
          const state = await app.snapshot();
          const original = await app.image(1, true);
          const originalHash = createHash('sha256').update(original).digest('hex');
          const again = await api('start', { confirmed: true });
          if (mode === 'positive') {
            await ui.locator('#order').fill('2,1'); await ui.locator('#saveOrder').click();
            await wait(s => s.job.manifest.selected_capture_ids.join(',') === '2,1' && !s.busy, 'order');
            for (const format of ['cbz', 'zip']) {
              await ui.locator('#format').selectOption(format);
              await ui.locator('#destination').fill(`${process.env.KTZ_SAMPLE_TEST_ROOT}/sample.${format}`);
              await ui.locator('#export').click();
              await wait(s => s.job.manifest.exports.length === (format === 'cbz' ? 1 : 2) && !s.busy, 'export');
            }
            const overwrite = await api('export', { destination: `${process.env.KTZ_SAMPLE_TEST_ROOT}/sample.cbz`, format: 'cbz' });
            const final = await app.snapshot();
            send({ event: 'result', mode, invalid, preview: previewCount, approved: approvedCount, previewOriginals, approvedOriginals,
              beforeStart: beforeStart.body.code, previewHash, again: again.body.code, notice, overwrite: overwrite.body.code,
              jobPath: final.job.job_path, manifest: final.job.manifest, originalHash, screenshots, launches, noticeEn, noticeZh, profile });
          } else if (mode === 'close-failure') {
            const failure = await api('closeBrowser');
            const after = await app.snapshot();
            send({ event: 'result', mode, close: failure.body.code, status: failure.status, profile: app.profile,
              releasePending: after.readerReleasePending, originalHash, jobPath: after.job.job_path });
          } else {
            await new Promise(resolve => setTimeout(resolve, 500));
            const after = await app.snapshot();
            const checkpoint = structuredClone(state.job.manifest.checkpoint);
            const retainedCount = state.job.manifest.images.length, afterCount = after.job.manifest.images.length;
            const review = await api('review', { ids: [1] });
            const exportPath = `${process.env.KTZ_SAMPLE_TEST_ROOT}/retained.zip`;
            const exported = await api('export', { destination: exportPath, format: 'zip' });
            send({ event: 'result', mode, invalid, preview: previewCount, approved: approvedCount, previewOriginals, approvedOriginals,
              beforeStart: beforeStart.body.code, again: again.body.code, reason: state.reason, failure: state.lastFailure,
              images: retainedCount, afterImages: afterCount, reviewStatus: review.status, exportStatus: exported.status, exportPath,
              pending: Boolean(app.pending), position: await app.reader.page.locator('#position').innerText(),
              checkpoint, sends, screenshots, events, jobPath: state.job.job_path, originalHash });
          }
        } catch (error) { send({ event: 'error', message: error.stack ?? String(error) }); }
      }));
      return context;
    };
    return browser;
  };
}
