// Anonymous-only instrumentation: the real public app, owner, Snap, pipe,
// Reader and Rust store run unchanged. Faults are confined to the own fixture.
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { appendFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { withPublicDisclosures } from '../../poc/browser/public-ui-controls.mjs';

const root = process.env.KTZ_PIPE_TEST_ROOT, mode = process.env.KTZ_PIPE_TEST_MODE;
if (!root?.startsWith('/tmp/opencode/ktz-owned-reader-')) throw new Error('anonymous_only');
const trace = value => appendFileSync(path.join(root, 'trace.ndjson'), JSON.stringify(value) + '\n', { mode: 0o600 });
const ownerEntry = /(?:^|\/)app\/linux-owned-reader-owner\.mjs$/.test(process.argv[1] ?? '');
const mainEntry = /(?:^|\/)app\/main\.mjs$/.test(process.argv[1] ?? '');

if (ownerEntry) {
  const spawn = childProcess.spawn;
  childProcess.spawn = (executable, args, options) => {
    if (executable !== '/snap/bin/chromium' || !args.some(arg => /^--user-data-dir=\/home\/user\/snap\/chromium\/common\/kindle-to-zip-owned-sample\/run-[^/]+\/owned\/profile$/.test(arg))
      || !args.includes('--remote-debugging-pipe') || args.some(arg => ['--no-sandbox', '--disable-setuid-sandbox', '--password-store=basic'].includes(arg))) throw new Error('unsafe_fixture_launch');
    const child = spawn(executable, args, options);
    const profile = args.find(arg => arg.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
    trace({ event: 'spawn', owner: process.pid, pid: child.pid, profile,
      inputFd: child.stdio[3]._handle?.fd, outputFd: child.stdio[4]._handle?.fd });
    const write = child.stdio[3].write.bind(child.stdio[3]);
    child.stdio[3].write = (bytes, ...rest) => {
      if (bytes.toString() === '{"id":999999,"method":"Browser.close"}\0') {
        trace({ event: 'browser-close' });
        // Unknown means deliberately retaining the real browser/pipe/lock.
        if (mode === 'unknown') return true;
      }
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
  let app, sends = 0, screenshots = 0, injected = false, committed = 0;
  const events = [];
  const command = Application.prototype.command;
  Application.prototype.command = async function (...args) {
    app = this;
    try { return await command.apply(this, args); }
    catch (error) {
      if (args[0] === 'openBrowser' && args[1]?.mode === 'sample-owned-pipe') trace({ event: 'open-error', code: error.code, cause: error.cause?.code ?? error.cause?.message });
      throw error;
    }
  };
  const acquire = Application.prototype.acquire;
  Application.prototype.acquire = async function (...args) {
    const call = this.store.call.bind(this.store);
    this.store.call = async (kind, input, ...rest) => {
      const value = await call(kind, input, ...rest);
      if (['capture_begin', 'capture_commit', 'capture_abort', 'record_advance'].includes(kind)) events.push({ kind, dispatch: input?.dispatch });
      if (kind === 'capture_commit') committed++;
      if (kind === 'capture_chunk' && committed === 1 && !injected && ['book', 'position', 'document'].includes(mode)) {
        injected = true;
        if (mode === 'document') await this.reader.page.reload({ waitUntil: 'domcontentloaded' });
        else await this.reader.page.evaluate(kind => {
          if (kind === 'book') document.querySelector('#reader').dataset.book = 'sample-b';
          else document.querySelector('#next').click();
        }, mode);
      }
      return value;
    };
    try { return await acquire.apply(this, args); } finally { this.store.call = call; }
  };
  const screenshot = Reader.prototype.screenshotVisibleClip;
  Reader.prototype.screenshotVisibleClip = function (...args) { screenshots++; return screenshot.apply(this, args); };
  const advance = Reader.prototype.advance;
  Reader.prototype.advance = async function (...args) {
    const mouse = this.page.mouse, click = mouse.click.bind(mouse), page = this.page;
    mouse.click = async (...point) => {
      sends++; await click(...point);
      if (mode === 'response-loss') throw new Error('injected_response_loss');
      if (mode === 'wrong-transition') await page.evaluate(() => document.querySelector('#next').click());
    };
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
        const socket = net.createConnection(process.env.KTZ_PIPE_TEST_SOCKET);
        const send = value => socket.write(`${JSON.stringify(value)}\n`);
        const ui = withPublicDisclosures(page);
        let beforeOpenProgress;
        const wait = async (predicate, label) => {
          const deadline = Date.now() + 45_000; let state;
          do {
            if (app) {
              state = await app.snapshot();
              if (predicate(state)) return state;
              if (label === 'open' && state.operationProgress?.id !== beforeOpenProgress && state.operationProgress?.action === 'openBrowser' && state.operationProgress.status === 'failure') {
                throw new Error(`open_failed:${await page.locator('#message').textContent()}:${app.readerLifecycle?.failure?.message ?? ''}`);
              }
              if (label === 'preview' && state.displayInspection?.status === 'failed') throw new Error(`preview_failed:${state.displayInspection.code}:${state.displayInspection.detail?.cause ?? ''}`);
            }
            await new Promise(resolve => setTimeout(resolve, 80));
          } while (Date.now() < deadline);
          throw new Error(`timeout_${label}:${state?.state}:${state?.reason}`);
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
          await ui.locator('#create').click(); await wait(s => Boolean(s.job) && !s.busy, 'create');
          const invalid = [];
          for (const input of [{ mode: 'kindle' }, { mode: 'sample-owned-pipe', url: 'http://127.0.0.1:9/reader.html' },
            { mode: 'sample-owned-pipe', profile: '/tmp/profile' }, { mode: 'sample-owned-pipe', session: 'new' },
            { mode: 'sample-owned-pipe', keep: true }]) invalid.push(await api('openBrowser', input));
          beforeOpenProgress = app.progress?.id;
          await ui.locator('#openOwnedPipe').click();
          await wait(s => s.browserOpen && !s.busy, 'open');
          await ui.locator('#selectReaderTab').click(); await wait(s => s.readerTabConfirmed && !s.busy, 'tab');
          await ui.locator('#quickPreview').click(); const preview = await wait(s => s.previewReady && !s.busy, 'preview');
          if (mode === 'positive') {
            // A same-title redraw is not a different book. The session's
            // identity watch, rather than the original title node, is binding.
            await app.reader.page.evaluate(() => {
              const title = document.querySelector('h1'); title.replaceWith(title.cloneNode(true));
            });
          }
          const early = await api('start', { confirmed: true });
          const noLimit = await api('approve', { confirmed: true });
          await ui.locator('#previewConfirmed').check();
          const blankDisabled = await ui.locator('#approve').isDisabled();
          await ui.locator('#maxCaptures').fill('2');
          await ui.locator('#previewConfirmed').check();
          if (mode === 'positive') {
            await ui.locator('#approval').scrollIntoViewIfNeeded();
            await page.screenshot({ path: process.env.KTZ_PIPE_TEST_IMAGE });
          }
          await ui.locator('#approve').click(); const approved = await wait(s => s.previewApproved && !s.busy, 'approve');
          const changed = await api('start', { confirmed: true, maxCaptures: null });
          const start = await api('start', { confirmed: true }); // omitted inherits approval
          const stopped = await wait(s => !s.busy && ['Review', 'NeedsAttention'].includes(s.state), 'stop');
          await app.loop;
          const final = await app.snapshot();
          const result = { event: 'result', mode, invalid: invalid.map(item => [item.status, item.body.code]), early: early.body.code,
            noLimit: [noLimit.status, noLimit.body.code], blankDisabled, approvedMax: approved.approvedMaxCaptures,
            changed: changed.body.code, start: start.status, previewImages: preview.job.manifest.images.length,
            state: final.state, reason: final.reason, failure: final.lastFailure, manifest: final.job.manifest,
            position: await app.reader.page.locator('#position').innerText(), screenshots, sends, events,
            jobPath: final.job.job_path };
          if (mode === 'unknown') {
            const closed = await api('closeBrowser'); result.close = [closed.status, closed.body.code];
            result.releasePending = (await app.snapshot()).readerReleasePending;
          }
          if (mode === 'positive') {
            const screenshotsBefore = screenshots;
            await app.reader.page.evaluate(() => {
              const title = document.querySelector('h1');
              const original = title.textContent; title.textContent = '別の匿名本'; title.textContent = original;
            });
            const refused = await api('preview', { config: { frame: '', reader: '#sheet', next: '#next', identity: 'h1', position: '#position' } });
            result.identityStop = { status: refused.status, code: refused.body.code, screenshotsBefore,
              screenshotsAfter: screenshots, sends, images: (await app.snapshot()).job.manifest.images.length };
            // The next Reader uses the *current* mode, not the earlier pipe
            // setting. This checks legacy blank approval without starting it.
            const pipeClosed = await api('closeBrowser');
            const jobClosed = await api('closeJob');
            const created = await api('create');
            const normal = await api('openBrowser', { mode: 'sample' });
            const tab = normal.body.readerTabs?.[0]?.id;
            const selected = await api('selectReaderTab', { id: tab });
            const previewAgain = await api('preview', { config: { frame: '', reader: '#sheet', next: '#next', identity: 'h1', position: '#position' } });
            const blank = await api('approve', { confirmed: true });
            result.modeSwitch = { statuses: [pipeClosed.status, jobClosed.status, created.status, normal.status, selected.status, previewAgain.status, blank.status],
              finite: blank.body.finiteCaptureRequired, approved: blank.body.previewApproved, limit: blank.body.approvedMaxCaptures };
          }
          send(result);
        } catch (error) { send({ event: 'error', message: error.stack ?? String(error) }); }
      }));
      return context;
    };
    return browser;
  };
}
