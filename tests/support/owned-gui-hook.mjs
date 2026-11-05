// Anonymous-only observation around the unmodified public npm start, real
// control window, real fixed owner/Snap and Rust store. No real profile/claim.
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { withPublicDisclosures } from '../../poc/browser/public-ui-controls.mjs';

const root = process.env.KTZ_GUI_TEST_ROOT;
if (!root?.startsWith('/tmp/opencode/ktz-linux-gui-98eefa8d-')) throw new Error('anonymous_only');
const trace = value => fs.appendFileSync(path.join(root, 'trace.ndjson'), JSON.stringify(value) + '\n', { mode: 0o600 });
const ownerEntry = /(?:^|\/)app\/linux-owned-reader-owner\.mjs$/.test(process.argv[1] ?? '');
const mainEntry = /(?:^|\/)app\/main\.mjs$/.test(process.argv[1] ?? '');

if (ownerEntry) {
  // Test isolation changes only the fresh random fixture root prefix; the real
  // owner still chooses and creates its own profile and maintains its lock.
  const mkdtemp = fs.promises.mkdtemp;
  fs.promises.mkdtemp = (prefix, ...args) => {
    const base = '/home/user/snap/chromium/common/kindle-to-zip-owned-sample/';
    if (prefix !== `${base}run-`) throw new Error('unexpected_owner_directory');
    return mkdtemp(`${base}gui-98eefa8d-`, ...args);
  };
  const spawn = childProcess.spawn;
  childProcess.spawn = (executable, args, options) => {
    if (executable !== '/snap/bin/chromium'
      || !args.some(arg => /^--user-data-dir=\/home\/user\/snap\/chromium\/common\/kindle-to-zip-owned-sample\/gui-98eefa8d-[^/]+\/owned\/profile$/.test(arg))
      || !args.includes('--remote-debugging-pipe')
      || args.some(arg => ['--no-sandbox', '--disable-setuid-sandbox', '--password-store=basic'].includes(arg))) throw new Error('unsafe_fixture_launch');
    const child = spawn(executable, args, options);
    const profile = args.find(arg => arg.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
    trace({ event: 'spawn', owner: process.pid, browser: child.pid, profile });
    const write = child.stdio[3].write.bind(child.stdio[3]);
    child.stdio[3].write = (bytes, ...rest) => {
      if (bytes.toString() === '{"id":999999,"method":"Browser.close"}\0') trace({ event: 'browser-close', owner: process.pid });
      return write(bytes, ...rest);
    };
    return child;
  };
  syncBuiltinESMExports();
}

if (mainEntry) {
  const fork = childProcess.fork;
  childProcess.fork = (file, args, options) => {
    if (file.endsWith('/app/linux-owned-reader-owner.mjs')) {
      const child = fork(file, args, { ...options, execArgv: [`--import=${import.meta.url}`] });
      trace({ event: 'owner', pid: child.pid });
      return child;
    }
    return fork(file, args, options);
  };
  syncBuiltinESMExports();
  const { Application } = await import('../../app/application.mjs');
  const { Reader } = await import('../../app/reader.mjs');
  const { chromium } = await import('playwright');
  let app, screenshots = 0, sends = 0, injectBeforeCommit = false;
  const events = [];
  const connect = chromium.connectOverCDP.bind(chromium);
  chromium.connectOverCDP = async (...args) => {
    const browser = await connect(...args);
    const page = browser.contexts()[0].pages()[0];
    await page.waitForURL(url => url.pathname === '/reader.html' && url.searchParams.get('asin') === 'B000KTZ001', { waitUntil: 'domcontentloaded' });
    // Instrument only the generated sample page, before the product binds its
    // guard. Screenshot previews use CDP and are counted separately below.
    await page.evaluate(() => {
      window.__ktzTestPixelReads = 0;
      const original = CanvasRenderingContext2D.prototype.getImageData;
      CanvasRenderingContext2D.prototype.getImageData = function (...args) {
        window.__ktzTestPixelReads++; return original.apply(this, args);
      };
    });
    return browser;
  };
  const command = Application.prototype.command;
  Application.prototype.command = async function (...args) { app = this; return command.apply(this, args); };
  const acquire = Application.prototype.acquire;
  Application.prototype.acquire = async function (...args) {
    const call = this.store.call.bind(this.store);
    this.store.call = async (kind, input, ...rest) => {
      const result = await call(kind, input, ...rest);
      if (['capture_begin', 'capture_commit', 'capture_abort', 'record_advance'].includes(kind)) events.push({ kind, dispatch: input?.dispatch });
      if (kind === 'capture_chunk' && injectBeforeCommit) {
        injectBeforeCommit = false;
        await this.reader.page.evaluate(() => { document.querySelector('h1').textContent = '別の匿名試料'; });
      }
      return result;
    };
    try { return await acquire.apply(this, args); } finally { this.store.call = call; }
  };
  const screenshot = Reader.prototype.screenshotVisibleClip;
  Reader.prototype.screenshotVisibleClip = function (...args) { screenshots++; return screenshot.apply(this, args); };
  const advance = Reader.prototype.advance;
  Reader.prototype.advance = async function (...args) {
    const mouse = this.page.mouse, click = mouse.click.bind(mouse);
    mouse.click = async (...point) => { sends++; return click(...point); };
    try { return await advance.apply(this, args); } finally { mouse.click = click; }
  };
  const launch = chromium.launch.bind(chromium);
  chromium.launch = async options => {
    const browser = await launch(options), newContext = browser.newContext.bind(browser);
    browser.newContext = async options => {
      const context = await newContext(options); let connected = false;
      context.on('page', page => page.on('domcontentloaded', async () => {
        if (connected || !page.url().startsWith('http://127.0.0.1:')) return;
        connected = true;
        const socket = net.createConnection(process.env.KTZ_GUI_TEST_SOCKET);
        const send = value => socket.write(`${JSON.stringify(value)}\n`);
        const ui = withPublicDisclosures(page);
        let beforeOpenProgress;
        const wait = async (predicate, label) => {
          const deadline = Date.now() + 45_000; let state;
          do {
            if (app) {
              state = await app.snapshot();
              if (predicate(state)) return state;
              if (state.operationProgress?.status === 'failure'
                && (label === 'open' && state.operationProgress.action === 'openBrowser' && state.operationProgress.id !== beforeOpenProgress
                  || label === 'preview' && ['preview', 'quickPreview'].includes(state.operationProgress.action))) {
                throw new Error(`${label}_failed:${state.reason}:${await page.locator('#message').textContent()}:${app.readerLifecycle?.failure?.message ?? ''}`);
              }
            }
            await new Promise(resolve => setTimeout(resolve, 80));
          } while (Date.now() < deadline);
          throw new Error(`timeout_${label}:${state?.state}:${state?.reason}:${await page.locator('#message').textContent()}`);
        };
        const api = (action, input = {}) => page.evaluate(async ({ action, input }) => {
          const response = await fetch('/api/command', { method: 'POST', headers: { Authorization: `Bearer ${sessionStorage.getItem('ktzLocalUiKey')}`,
            'Content-Type': 'application/json', Origin: location.origin }, body: JSON.stringify({ action, input }) });
          return { status: response.status, body: await response.json() };
        }, { action, input });
        let buffer = '';
        socket.on('data', chunk => {
          buffer += chunk; let end;
          while ((end = buffer.indexOf('\n')) >= 0) {
            const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
            if (message.action === 'close') { send({ event: 'closing' }); void page.close(); }
          }
        });
        try {
          await page.waitForFunction(() => document.querySelector('#state')?.textContent === '待機');
          await page.locator('#decisionButton').click(); await wait(s => Boolean(s.job) && !s.busy, 'create');
          await page.waitForFunction(() => !document.querySelector('#linuxSource').hidden);
          const sourceRequired = await page.locator('#decisionButton').isDisabled();
          await page.locator('#language').selectOption('en');
          const english = await page.locator('#captureSource option[value="owned-fixture"]').textContent();
          await page.locator('#language').selectOption('zh-CN');
          const chinese = await page.locator('#captureSource option[value="owned-fixture"]').textContent();
          await page.locator('#language').selectOption('ja');
          await page.locator('#captureSource').selectOption('owned-fixture');
          const sourceState = await page.locator('#state').textContent();
          const trafficNotice = await page.locator('#trafficNotice').textContent();
          await page.locator('#captureSource').scrollIntoViewIfNeeded();
          await page.screenshot({ path: path.join(process.env.KTZ_GUI_TEST_EVIDENCE, 'source.png') });
          const invalid = [];
          for (const input of [{ mode: 'kindle' }, { mode: 'owned-fixture', url: 'http://127.0.0.1:9/' },
            { mode: 'owned-fixture', profile: '/tmp/profile' }, { mode: 'owned-fixture', session: 'new' },
            { mode: 'owned-fixture', identity: { asin: 'B000KTZ001' } }, { mode: 'owned-fixture', cdp: 'http://127.0.0.1:9/' },
            { mode: 'sample-owned-pipe' }, { mode: 'sample-headed' }]) {
            invalid.push(await api('openBrowser', input));
          }
          beforeOpenProgress = app.progress?.id;
          await page.locator('#decisionButton').click();
          const opened = await wait(s => s.browserOpen && !s.busy, 'open');
          const beforePreview = { screenshots, sends, images: opened.job.manifest.images.length,
            canvasReads: await app.reader.page.evaluate(() => window.__ktzTestPixelReads) };
          await page.waitForFunction(() => ['captureStage', 'selectReaderTab'].includes(document.querySelector('#decisionButton').dataset.action)
            && !document.querySelector('#decisionButton').disabled);
          if (await page.locator('#decisionButton').getAttribute('data-action') === 'captureStage') await page.locator('#decisionButton').click();
          await page.waitForFunction(() => document.querySelector('#decisionButton').dataset.action === 'selectReaderTab' && !document.querySelector('#decisionButton').disabled);
          await page.locator('#decisionButton').click();
          await wait(s => s.readerTabConfirmed && !s.busy, 'tab');
          await page.waitForFunction(() => document.querySelector('#decisionButton').dataset.action === 'preview' && !document.querySelector('#decisionButton').disabled);
          await page.locator('#decisionButton').click();
          const preview = await wait(s => s.previewReady && !s.busy, 'preview');
          const canvasReadsAfterPreview = await app.reader.page.evaluate(() => window.__ktzTestPixelReads);
          const early = await api('start', { confirmed: true });
          const noLimit = await api('approve', { confirmed: true });
          await page.locator('#maxCaptures').fill('2'); await page.locator('#previewConfirmed').check();
          await page.waitForFunction(() => document.querySelector('#decisionButton').dataset.action === 'approve' && !document.querySelector('#decisionButton').disabled);
          await page.locator('#decisionButton').click();
          const approved = await wait(s => s.previewApproved && !s.busy, 'approve');
          const canvasReadsAtApproval = await app.reader.page.evaluate(() => window.__ktzTestPixelReads);
          const approvalEffects = { screenshots, sends, images: approved.job.manifest.images.length };
          // After approval, the same anonymous page with unchanged identity but
          // different paint must not pass the bound-image check. Restore only
          // this test-owned canvas before continuing the ordinary GUI route.
          await app.reader.page.evaluate(() => {
            const canvas = document.querySelector('#sheet'), context = canvas.getContext('2d');
            window.__ktzTestSavedPaint = context.getImageData(0, 0, canvas.width, canvas.height);
            context.fillStyle = '#f05'; context.fillRect(0, 0, canvas.width, canvas.height);
          });
          let changedPaint = 'unexpected_success';
          try { await app.reader.requireBound(); } catch (error) { changedPaint = error.code; }
          await app.reader.page.evaluate(() => {
            document.querySelector('#sheet').getContext('2d').putImageData(window.__ktzTestSavedPaint, 0, 0);
            delete window.__ktzTestSavedPaint;
          });
          const restoredPaint = Boolean(await app.reader.requireBound());
          await page.locator('#maxCaptures').fill('1'); await page.locator('#maxCaptures').fill('2');
          await page.locator('#previewConfirmed').check();
          const revertRequiresApproval = await page.locator('#decisionButton').getAttribute('data-action');
          await page.locator('#decisionButton').click();
          await page.waitForFunction(() => document.querySelector('#decisionButton').dataset.action === 'start' && !document.querySelector('#decisionButton').disabled);
          const invalidReapproval = await api('approve', { confirmed: true });
          const afterInvalidReapproval = await api('start', { confirmed: true });
          const freshApproval = await api('approve', { confirmed: true, maxCaptures: 2 });
          const changedLimit = await api('start', { confirmed: true, maxCaptures: 1 });
          const afterChangedLimit = await api('start', { confirmed: true });
          const changedSettings = await api('setCaptureSettings', { ...approved.captureSettings, reading_direction: 'left_to_right' });
          const staleStart = await api('start', { confirmed: true });
          await wait(s => !s.previewReady && !s.previewApproved && !s.busy, 'invalidated');
          await ui.locator('#quickPreview').click(); await wait(s => s.previewReady && !s.busy, 'preview');
          await ui.locator('#maxCaptures').fill('2'); await ui.locator('#previewConfirmed').check();
          await ui.locator('#approve').click(); await wait(s => s.previewApproved && !s.busy, 'approve-again');
          await ui.locator('#approval').scrollIntoViewIfNeeded();
          await page.screenshot({ path: path.join(process.env.KTZ_GUI_TEST_EVIDENCE, 'approval.png') });
          await ui.locator('#start').click();
          const stopped = await wait(s => s.state === 'Review' && !s.busy, 'stop');
          const first = stopped.job.manifest.images[0];
          const original = await app.image(first.capture_id, true);
          fs.writeFileSync(path.join(process.env.KTZ_GUI_TEST_EVIDENCE, 'original.png'), original, { mode: 0o600 });
          for (const [id, value] of Object.entries({ cropId: first.capture_id, cropX: 5, cropY: 5, cropWidth: first.width - 10, cropHeight: first.height - 10 })) {
            await ui.locator(`#${id}`).fill(String(value));
          }
          await ui.locator('#crop').click();
          const cropped = await wait(s => Boolean(s.job.manifest.images[0].crop) && !s.busy, 'crop');
          await page.waitForFunction(() => document.querySelector('#inspectCaption').textContent === '適用後のクロップ結果'
            && !document.querySelector('#inspectImage').hidden);
          const edited = await app.image(first.capture_id);
          const originalAfterEdit = await app.image(first.capture_id, true);
          fs.writeFileSync(path.join(process.env.KTZ_GUI_TEST_EVIDENCE, 'edited.png'), edited, { mode: 0o600 });
          await page.locator('#inspectImage').scrollIntoViewIfNeeded();
          await page.screenshot({ path: path.join(process.env.KTZ_GUI_TEST_EVIDENCE, 'review.png') });
          await ui.locator('#destination').fill(path.join(root, 'anonymous.zip'));
          await ui.locator('#export').click();
          const saved = await wait(s => s.job.manifest.exports.length === 1 && !s.busy, 'export');
          const beforeInvalidRegion = screenshots;
          const invalidRegion = await api('preview', { config: { frame: '', reader: '#reader', next: '#next', identity: 'h1', position: '#position' } });
          const firstResult = { sourceRequired, sourceState, trafficNotice, english, chinese, invalid: invalid.map(x => [x.status, x.body.code]), beforePreview,
            previewImages: preview.job.manifest.images.length, canvasReadsAfterPreview, canvasReadsAtApproval, approvalEffects,
            changedPaint, restoredPaint, early: early.body.code, noLimit: [noLimit.status, noLimit.body.code],
            approvedLimit: approved.approvedMaxCaptures, revertRequiresApproval,
            invalidReapproval: [invalidReapproval.status, invalidReapproval.body.code], afterInvalidReapproval: afterInvalidReapproval.body.code,
            freshApproval: freshApproval.status, changedLimit: changedLimit.body.code, afterChangedLimit: afterChangedLimit.body.code,
            settingsStatus: changedSettings.status, staleStart: staleStart.body.code,
            state: stopped.state, reason: stopped.reason, manifest: stopped.job.manifest, sends, screenshots,
            crop: Boolean(cropped.job.manifest.images[0].crop), exports: saved.job.manifest.exports.length, originalIntact: original.equals(originalAfterEdit),
            originalBytes: original.length, editedBytes: edited.length,
            invalidRegion: [invalidRegion.status, invalidRegion.body.code], beforeInvalidRegion, afterInvalidRegion: screenshots };
          const finished = await api('finishBook');
          const second = await api('create');
          const inherited = await api('start', { confirmed: true });
          const fakeSession = await api('openBrowser', { mode: 'owned-fixture', session: 'saved-00000000-0000-0000-0000-000000000000' });
          const secondOpen = await api('openBrowser', { mode: 'owned-fixture' });
          const selected = await api('selectReaderTab', { id: secondOpen.body.readerTabs?.[0]?.id });
          const secondPreview = await api('preview', { config: { frame: '', reader: '#sheet', next: '#next', identity: 'h1', position: '#position' } });
          const secondApprove = await api('approve', { confirmed: true, maxCaptures: 1 });
          injectBeforeCommit = true;
          const secondStart = await api('start', { confirmed: true });
          const failed = await wait(s => s.state === 'NeedsAttention' && !s.busy, 'changed-identity');
          const secondResult = { statuses: [finished.status, second.status, secondOpen.status, selected.status, secondPreview.status, secondApprove.status, secondStart.status],
            inherited: inherited.body.code, fakeSession: fakeSession.body.code, state: failed.state, reason: failed.reason,
            failure: failed.lastFailure, images: failed.job.manifest.images.length, sends, events };
          const closed = await api('closeBrowser');
          const closeJob = await api('closeJob');
          const third = await api('create');
          const ordinary = await api('openBrowser', { mode: 'sample' });
          const tab = await api('selectReaderTab', { id: ordinary.body.readerTabs?.[0]?.id });
          const ordinaryPreview = await api('preview', { config: { frame: '', reader: '#sheet', next: '#next', identity: 'h1', position: '#position' } });
          const ordinaryApproval = await api('approve', { confirmed: true });
          const switched = { statuses: [closed.status, closeJob.status, third.status, ordinary.status, tab.status, ordinaryPreview.status, ordinaryApproval.status],
            finite: ordinaryApproval.body.finiteCaptureRequired, approved: ordinaryApproval.body.previewApproved, limit: ordinaryApproval.body.approvedMaxCaptures };
          send({ event: 'result', first: firstResult, second: secondResult, switched });
        } catch (error) { send({ event: 'error', message: error.stack ?? String(error) }); }
      }));
      return context;
    };
    return browser;
  };
}
