// Relocate only the fixed installation/site to an isolated anonymous fixture.
import childProcess from 'node:child_process';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { withPublicDisclosures } from '../../poc/browser/public-ui-controls.mjs';
const root = process.env.KTZ_LIMITED_TEST_ROOT, origin = process.env.KTZ_LIMITED_TEST_ORIGIN;
const startOrigin = process.env.KTZ_LIMITED_TEST_START_ORIGIN ?? origin;
if (!/^\/home\/user\/KTZRC\/refusal-20261103\/limited-[A-Za-z0-9]+$/.test(root ?? '') || !/^http:\/\/127\.0\.0\.1:\d+$/.test(origin ?? '')
    || !/^http:\/\/127\.0\.0\.1:\d+$/.test(startOrigin ?? '')) throw new Error('anonymous_only');
const trace = value => fs.appendFileSync(path.join(root, 'trace.ndjson'), `${JSON.stringify(value)}\n`, { mode: 0o600 });
registerHooks({ load(url, context, next) {
  const result = next(url, context);
  if (!url.includes('/app/')) return result;
  let source = result.source.toString();
  if (url.endsWith('/portable-linux-site.mjs')) source = source.replace("const selectedBundle = '/home/user/KTZ-Portable';", `const selectedBundle = ${JSON.stringify(root)};`)
    .replace("const ownRoot = fileURLToPath(new URL('../', import.meta.url)).replace(/\\/$/, '');", `const ownRoot = ${JSON.stringify(root)};`)
    .replace('await consumePortableArchiveCapture(path.dirname(selected.root), job, selected.id);', '/* anonymous legacy read-only grant */');
  // These established fixtures exercise historic v2/read-only guards, not the
  // new archive permission. Its actual boundary has a separate public case.
  if (url.endsWith('/application.mjs')) source = source.replace('limitedSite && !limited && await portableArchiveAvailable(this.dataDir, job, this.portableArchiveTrial)', 'limitedSite && !limited')
    .replace("if (this.portableArchiveTrial && portableLimitedAvailable(this.dataDir) && this.portableArchiveJob !== this.job?.manifest.job_id)\n              throw new AppError('portable_postprocess_unavailable');", '/* anonymous legacy read-only grant, no archive ticket */')
    .replace('const normal = portableNormalAvailable(this.dataDir) && !this.portableArchiveTrial;', 'const normal = false; // historic anonymous limited fixture');
  if (url.endsWith('/portable-reader-site.mjs')) source = source.replace("'--remote-debugging-pipe'", "'--remote-debugging-pipe', '--disable-background-networking', '--disable-quic', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'");
  if (url.endsWith('/portable-limited-session.mjs') || url.endsWith('/stores/kindle.mjs')) source = source.replaceAll('https://read.amazon.co.jp', origin);
  if (url.endsWith('/portable-limited-session.mjs')) {
    if (source.split("value.protocol === 'https:'").length !== 2) throw new Error('anonymous_injection_missing');
    source = source.replace("value.protocol === 'https:'", "value.protocol === 'http:'");
  }
  if (url.endsWith('/portable-limited-session.mjs') && process.env.KTZ_LIMITED_TEST_MODE?.startsWith('wait-')) {
    if (process.env.KTZ_LIMITED_TEST_MODE === 'wait-owner-unknown') {
      const needle = 'await owner.assertOwned();\n      checkInitial();';
      if (!source.includes(needle)) throw new Error('anonymous_injection_missing');
      source = source.replace(needle, "await owner.assertOwned(); throw new AppError('owned_pipe_unconfirmed');\n      checkInitial();");
    }
  }
  // Exercise the public failed-connect lifecycle without a real Amazon request.
  // This controlled cause is not a claim about the user's unrecorded failure.
  if (url.endsWith('/portable-limited-session.mjs') && process.env.KTZ_LIMITED_TEST_MODE === 'connection-failure')
    source = source.replace('async ready(page) {', "async ready(page) { throw new AppError('target_changed');");
  if (url.endsWith('/portable-limited-session.mjs') && process.env.KTZ_LIMITED_TEST_MODE === 'init-ready') {
    const needle = 'async ready(page) {';
    if (!source.includes(needle)) throw new Error('anonymous_injection_missing');
    source = source.replace(needle, `${needle} throw Object.assign(new Error('anonymous-secret https://anonymous.invalid/credential'), { name: 'TimeoutError' });`);
  }
  if (url.endsWith('/portable-limited-session.mjs') && process.env.KTZ_LIMITED_TEST_MODE === 'init-bind') {
    const needle = 'async bind(reader) {';
    if (!source.includes(needle)) throw new Error('anonymous_injection_missing');
    source = source.replace(needle, `${needle} throw Object.assign(new Error('anonymous-secret https://anonymous.invalid/credential'), { code: 'target_changed' });`);
  }
  if (url.endsWith('/reader.mjs')) {
    const injections = {
      'init-page': ['const pages = context.pages();\n        if (pages.length !== 1 || pages[0] !== ownedPage || ownedPage.isClosed()) {',
        'const pages = context.pages().slice(0, 0);\n        if (pages.length !== 1 || pages[0] !== ownedPage || ownedPage.isClosed()) {'],
      'init-viewport-read': ['const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));',
        "const viewport = await page.evaluate(() => { throw new Error('anonymous-secret https://anonymous.invalid/credential'); });"],
      'init-viewport-apply': ['await page.setViewportSize(viewport);',
        "page.setViewportSize = async () => { throw Object.assign(new Error('anonymous-secret https://anonymous.invalid/credential'), { code: 'target_changed' }); };\n        await page.setViewportSize(viewport);"],
    };
    const injection = injections[process.env.KTZ_LIMITED_TEST_MODE];
    if (injection) {
      const [needle, replacement] = injection;
      if (!source.includes(needle)) throw new Error('anonymous_injection_missing');
      source = source.replace(needle, replacement);
    }
  }
  if (url.endsWith('/portable-limited-failure.mjs') && process.env.KTZ_LIMITED_TEST_MODE === 'record-error')
    source = source.replace('async function writeRecord(file, value) {', "async function writeRecord(file, value) { if (file.endsWith('/pending.json')) throw new Error('anonymous_record_write_failure');");
  return { ...result, source };
} });
if (/\/app\/linux-owned-reader-owner\.mjs$/.test(process.argv[1] ?? '')) {
  const spawn = childProcess.spawn;
  childProcess.spawn = (executable, args, options) => {
    const profile = path.join(root, 'data/application', process.argv[3], 'owned/profile');
    if (executable !== '/snap/bin/chromium' || args.at(-1) !== 'about:blank' || !args.includes(`--user-data-dir=${profile}`) || !args.includes('--remote-debugging-pipe') || !args.includes('--ozone-platform=wayland')
        || args.some(arg => ['--no-sandbox', '--disable-setuid-sandbox', '--password-store=basic'].includes(arg)) || !fs.lstatSync(path.join(path.dirname(profile), 'in-use.lock')).isFile()) throw new Error('unsafe_fixture_launch');
    if (process.env.KTZ_LIMITED_TEST_MODE === 'browser-failure') {
      trace({ event: 'launch-refused', owner: process.pid });
      throw Object.assign(new Error('anonymous-secret https://anonymous.invalid/credential'), { code: 'ENOENT' });
    }
    const child = spawn(executable, args, options); trace({ event: 'owner', owner: process.pid, browser: child.pid }); return child;
  }; syncBuiltinESMExports();
}
if (/\/app\/main\.mjs$/.test(process.argv[1] ?? '')) {
  const fork = childProcess.fork;
  childProcess.fork = (file, args, options) => file.endsWith('/app/linux-owned-reader-owner.mjs') ? fork(file, args, { ...options, execArgv: [`--import=${import.meta.url}`] }) : fork(file, args, options);
  syncBuiltinESMExports();
  const { Application } = await import('../../app/application.mjs');
  const { Reader } = await import('../../app/reader.mjs');
  const { resolvePortableLinuxSession } = await import('../../app/portable-linux-session.mjs');
  const { chromium } = await import('playwright');
  const { AppError } = await import('../../app/store-client.mjs');
  const { readPortableStartupRecord } = await import('../../app/portable-limited-failure.mjs');
  const actualWait = process.env.KTZ_LIMITED_TEST_MODE?.startsWith('wait-');
  let attached, waitTrace, releaseReady, readyGateClosing = false, startupOrder;
  if (process.env.KTZ_LIMITED_TEST_MODE === 'positive') {
    const connect = chromium.connectOverCDP.bind(chromium);
    chromium.connectOverCDP = async (...args) => {
      const browser = await connect(...args), contexts = browser.contexts();
      if (contexts.length !== 1 || contexts[0].pages().length !== 1) throw new Error('anonymous_initial_page_count');
      const page = contexts[0].pages()[0], goto = page.goto.bind(page);
      startupOrder = { initialBlank: page.url() === 'about:blank', navigations: 0, fixedNavigation: true, commitOnly: true };
      page.goto = async (target, options) => {
        startupOrder.navigations++;
        startupOrder.fixedNavigation &&= target === `${origin}/`;
        startupOrder.commitOnly &&= options?.waitUntil === 'commit' && options?.timeout === 30_000;
        return goto(target, options);
      };
      return browser;
    };
  }
  if (actualWait) {
    globalThis.__limitedReadyGate = async page => {
      if (page !== attached?.library) throw new Error('anonymous_initial_page_changed');
      waitTrace = { started: performance.now(), initialUrlMatches: new URL(page.url()).origin === origin, gate: 'held' };
      if (!readyGateClosing) await new Promise(resolve => { releaseReady = resolve; });
      waitTrace.gate = 'released'; waitTrace.releasedAt = performance.now();
    };
    // Return the verified empty page immediately: the product must claim that
    // same blank page before its fixed goto can begin. Hold only that goto's
    // commit result, never connectOverCDP or the entry to ready().
    const connect = chromium.connectOverCDP.bind(chromium);
    chromium.connectOverCDP = async (...args) => {
      const browser = await connect(...args);
      if (browser.contexts().length !== 1 || browser.contexts()[0].pages().length !== 1) throw new Error('anonymous_initial_page_count');
      const library = browser.contexts()[0].pages()[0], goto = library.goto.bind(library);
      if (library.url() !== 'about:blank') throw new Error('anonymous_initial_page_not_blank');
      attached = { browser, library };
      startupOrder = { initialBlank: true, navigations: 0, fixedNavigation: true, commitOnly: true };
      const beforeCommit = ['wait-blank', 'wait-blank-timeout', 'wait-close', 'wait-disconnect', 'wait-origin'].includes(process.env.KTZ_LIMITED_TEST_MODE);
      library.goto = async (target, options) => {
        if (startupOrder.navigations) return goto(target, options); // Later explicit anonymous user navigation is not the product startup gate.
        startupOrder.navigations++;
        startupOrder.fixedNavigation &&= target === `${origin}/`;
        startupOrder.commitOnly &&= options?.waitUntil === 'commit' && options?.timeout === 30_000;
        if (beforeCommit) await globalThis.__limitedReadyGate(library);
        // A failed setup/timeout releases our gate only for cleanup, not a new
        // navigation after the product has already closed its original page.
        if (readyGateClosing || library.isClosed() || !browser.isConnected()) throw new AppError('target_changed');
        const response = await goto(target, options);
        if (!beforeCommit) await globalThis.__limitedReadyGate(library);
        return response;
      };
      return browser;
    };
  }
  if (process.env.KTZ_LIMITED_TEST_MODE === 'pipe-failure') chromium.connectOverCDP = async () => {
    throw Object.assign(new Error('anonymous-secret https://anonymous.invalid/credential'), { name: 'TimeoutError', code: 'anonymous-secret' });
  };
  let app, screenshots = 0, sends = 0, lastCommandError, controlPage, scalePendingUi;
  if (process.env.KTZ_LIMITED_TEST_MODE === 'scale-failure') Reader.prototype.setCaptureScale = async () => {
    // Reader.open has returned, but openBrowser still owns scale application
    // and startup-record completion. Observe a real polling snapshot here.
    await controlPage.waitForFunction(() => document.querySelector('#readerTab').options.length > 1);
    const pending = await app.snapshot();
    scalePendingUi = { busy: pending.busy, browserOpen: pending.browserOpen, activeOperation: pending.activeOperation,
      record: pending.portableLimitedStartup.record, session: await controlPage.locator('#portableKindleStatus').textContent(),
      guidance: await controlPage.locator('#captureHelp').textContent(), message: await controlPage.locator('#message').textContent() };
    await controlPage.screenshot({ path: path.join(process.env.KTZ_LIMITED_TEST_EVIDENCE, 'scale-pending-ui.png') });
    throw new AppError('capture_scale_unavailable');
  };
  const command = Application.prototype.command;
  Application.prototype.command = async function (...args) {
    app = this;
    try { return await command.apply(this, args); }
    catch (error) {
      lastCommandError = { code: error.code, cause: error.cause?.code };
      const describe = e => e ? { message: e.message, code: e.code, errors: e.errors?.map(describe), cause: describe(e.cause) } : null;
      trace({ event: 'command-error', action: args[0], error: describe(error) }); throw error;
    }
  };
  const screenshot = Reader.prototype.screenshotVisibleClip;
  Reader.prototype.screenshotVisibleClip = function (...args) { screenshots++; return screenshot.apply(this, args); };
  const advance = Reader.prototype.advance;
  Reader.prototype.advance = async function (...args) {
    const click = this.page.mouse.click.bind(this.page.mouse);
    this.page.mouse.click = async (...point) => {
      sends++; const result = await click(...point);
      if (process.env.KTZ_LIMITED_TEST_MODE === 'turn-reply-lost') throw new AppError('advance_uncertain');
      return result;
    };
    try { return await advance.apply(this, args); } finally { this.page.mouse.click = click; }
  };
  const launch = chromium.launch.bind(chromium);
  chromium.launch = async options => {
    const browser = await launch(options), newContext = browser.newContext.bind(browser);
    browser.newContext = async options => {
      const context = await newContext(options); let connected = false;
      context.on('page', page => page.on('domcontentloaded', async () => {
        if (connected || !page.url().startsWith('http://127.0.0.1:')) return;
        connected = true; controlPage = page; const ui = withPublicDisclosures(page);
        const wait = async (predicate, timeoutMs = 15_000) => {
          const until = Date.now() + timeoutMs; let state;
          do { if (app) { state = await app.snapshot(); if (predicate(state)) return state; } await new Promise(resolve => setTimeout(resolve, 80)); } while (Date.now() < until);
          throw new Error(`anonymous_timeout:${state?.state}:${state?.reason}:${await page.locator('#message').textContent()}`);
        };
        const api = (action, input = {}) => page.evaluate(async ({ action, input }) => {
          const response = await fetch('/api/command', { method: 'POST', headers: { Authorization: `Bearer ${sessionStorage.getItem('ktzLocalUiKey')}`, 'Content-Type': 'application/json', Origin: location.origin }, body: JSON.stringify({ action, input }) });
          const body = await response.json(); return { status: response.status, code: body.code };
        }, { action, input });
        try {
          const mode = process.env.KTZ_LIMITED_TEST_MODE, positive = ['positive', 'separate-tab', 'legacy-stop'].includes(mode);
          await page.waitForFunction(() => document.querySelector('#state')?.textContent === '待機');
          await page.locator('#decisionButton').click(); await wait(s => s.job && !s.busy);
          let presetBefore;
          if (mode === 'positive') {
            await api('savePreset', { id: 'anonymous-existing', name: '匿名の既存カスタム設定', mode: 'selectors',
              config: { frame: '', reader: '#old-region', identity: '#old-title', position: '#old-position', next: '#old-next' } });
            presetBefore = fs.readFileSync(path.join(app.dataDir, 'reader-presets.json'), 'utf8');
          }
          const selected = await resolvePortableLinuxSession(app.dataDir), before = fs.statSync(selected.profile);
          await page.waitForFunction(id => [...document.querySelector('#portableKindleSession').options].some(o => o.value === id), selected.id);
          await page.locator('#captureSource').selectOption('kindle'); await page.locator('#portableKindleSession').selectOption(selected.id);
          await page.locator('#decisionButton').click(); await wait(s => s.portableKindlePrepared === selected.id && !s.busy);
          await page.locator('#portableKindleSelection').scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(process.env.KTZ_LIMITED_TEST_EVIDENCE, 'source.png') });
          let legacy;
          if (['legacy-stop', 'legacy-init'].includes(mode)) {
            // Reproduce the real old fixed format, including an absent cause;
            // neither the old claim nor the old job is rewritten for retry.
            const job = app.job, claimFile = path.join(app.dataDir, 'portable-reader-limited-20261102.claim');
            fs.writeFileSync(claimFile, JSON.stringify({ version: 1, job: job.manifest.job_id, session: selected.id }) + '\n', { flag: 'wx', mode: 0o600 });
            legacy = { job, claimFile, claimBytes: fs.readFileSync(claimFile), manifestBytes: fs.readFileSync(path.join(job.job_path, 'manifest.json')) };
            if (mode === 'legacy-init') {
              const dir = path.join(app.dataDir, 'portable-reader-startup', job.manifest.job_id);
              fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
              const start = path.join(dir, 'start.json'), resultFile = path.join(dir, 'result.json');
              fs.writeFileSync(start, JSON.stringify({ version: 1, kind: 'portable-limited-startup' }) + '\n', { flag: 'wx', mode: 0o600 });
              fs.writeFileSync(resultFile, JSON.stringify({ version: 1, lastReached: 'pipe_attached', pipe: 'attached', outcome: 'failed',
                failure: { stage: 'reader_initialize', code: 'operation_timeout' } }) + '\n', { flag: 'wx', mode: 0o600 });
              const startBefore = fs.readFileSync(start), resultBefore = fs.readFileSync(resultFile);
              await page.waitForFunction(() => document.querySelector('#nextAction')?.textContent.includes('初期化境界：未記録'));
              const stopped = await wait(s => s.portableLimitedStartup?.record === 'complete' && !s.busy);
              await page.locator('#portableKindleSelection').scrollIntoViewIfNeeded();
              await page.screenshot({ path: path.join(process.env.KTZ_LIMITED_TEST_EVIDENCE, 'stopped.png') });
              const result = { event: 'result', mode, claimJob: job.manifest.job_id, startup: stopped.portableLimitedStartup,
                diskStartup: await readPortableStartupRecord(app.dataDir, job.manifest.job_id), screenshots, sends,
                images: stopped.job.manifest.images.length, browserOpen: stopped.browserOpen,
                guidance: await page.locator('#nextAction').textContent(), message: await page.locator('#message').textContent(),
                retry: await api('openBrowser', { mode: 'kindle', session: selected.id }) };
              result.unchanged = startBefore.equals(fs.readFileSync(start)) && resultBefore.equals(fs.readFileSync(resultFile))
                && legacy.claimBytes.equals(fs.readFileSync(claimFile)) && legacy.manifestBytes.equals(fs.readFileSync(path.join(job.job_path, 'manifest.json')));
              trace(result); console.log(`KTZ_LIMITED_RESULT:${JSON.stringify(result)}`); return;
            }
            await page.waitForFunction(() => document.querySelector('#state').textContent.includes('限定試験停止'));
          } else await page.locator('#decisionButton').click();
          if (actualWait) {
            const pending = await wait(s => s.busy && !s.browserOpen && s.portableLimitedStartup?.initialization?.started === 'pipe_ready'
              && s.portableLimitedStartup?.initialization?.completed === 'page_identity' && attached && waitTrace?.gate === 'held');
            const { library, browser } = attached;
             const claimFile = path.join(app.dataDir, `portable-reader-limited-${pending.job.manifest.job_id}.claim`);
             const claimBytes = fs.readFileSync(claimFile);
             if (mode === 'wait-setup-failure') throw new Error('anonymous_setup_failure');
             const loadState = async (target, state, timeout = 700) => {
              try { await target.waitForLoadState(state, { timeout }); return 'resolved'; }
              catch (error) { if (error.name !== 'TimeoutError') throw error; return error.name; }
            };
            // Check the same initial page, not the popup, after a fixed interval.
            await new Promise(resolve => setTimeout(resolve, 1200));
             const fixed = { initialOriginMatches: new URL(library.url()).origin === origin,
               initialBlank: library.url() === 'about:blank',
               initialLibrary: ['/', '/kindle-library'].includes(new URL(library.url()).pathname),
               mainState: await library.evaluate(() => document.readyState),
               mainDcl: library.url() === 'about:blank' ? 'not-requested' : await loadState(library, 'domcontentloaded'),
               pageCount: library.context().pages().length,
              stillWaiting: waitTrace.gate === 'held', elapsedMs: performance.now() - waitTrace.started,
              busy: (await app.snapshot()).busy, browserOpen: Boolean(app.reader),
              initialization: app.portableStartupRecord.snapshot().initialization };
            if (mode === 'wait-child-frame') {
              const frame = library.frames().find(item => item !== library.mainFrame() && item.url().endsWith('/held-frame'));
              if (!frame) throw new Error('anonymous_child_frame_missing');
              fixed.childState = await frame.evaluate(() => document.readyState);
            }
            await page.waitForFunction(() => document.querySelector('#portableKindleStatus').textContent.includes('準備中'));
            const pendingUi = { session: await page.locator('#portableKindleStatus').textContent(),
              guidance: await page.locator('#captureHelp').textContent(), message: await page.locator('#message').textContent(),
              state: await page.locator('#state').textContent(), nextDisabled: await page.locator('#decisionButton').isDisabled() };
            await page.locator('#portableKindleSelection').scrollIntoViewIfNeeded();
            await page.screenshot({ path: path.join(process.env.KTZ_LIMITED_TEST_EVIDENCE, 'pending-ui.png') });
            // Playwright's screenshot waits for document.fonts.ready, which is
            // intentionally pending on this unfinished document. CDP captures
            // its already visible anonymous surface without releasing the wait.
            const visual = await library.context().newCDPSession(library);
            try {
              const image = await visual.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
              fs.writeFileSync(path.join(process.env.KTZ_LIMITED_TEST_EVIDENCE, 'pending-library.png'), Buffer.from(image.data, 'base64'), { flag: 'wx', mode: 0o600 });
            } finally { await visual.detach(); }
             let blankPending;
             if (['wait-blank', 'wait-blank-timeout', 'wait-close', 'wait-disconnect'].includes(mode)) {
               const value = await app.snapshot();
               blankPending = { busy: value.busy, browserOpen: value.browserOpen, initialBlank: library.url() === 'about:blank',
                 images: value.job.manifest.images.length, screenshots, sends };
               if (mode === 'wait-close') {
                 const closed = library.waitForEvent('close', { timeout: 5000 });
                 // Closing the sole tab may make the owner close its transport
                 // before page.close's protocol reply. Observe the close event,
                 // not that reply, then independently verify the owner join.
                 void library.close().catch(() => {});
                 await closed;
               }
               if (mode === 'wait-disconnect') await browser.close();
             }
             if (mode !== 'wait-blank-timeout') releaseReady();
             const stopped = await wait(s => !s.busy, 40_000);
             const elapsedMs = performance.now() - (waitTrace.releasedAt ?? waitTrace.started);
             if (mode === 'wait-blank-timeout') releaseReady();
             const startup = stopped.portableLimitedStartup, diskStartup = await readPortableStartupRecord(app.dataDir, stopped.job.manifest.job_id);
             const success = ['wait-main-dcl', 'wait-child-frame', 'wait-blank', 'wait-post-close', 'wait-post-origin'].includes(mode);
             let afterRelease, flow, readyUi, postReady, readerPage, readerAfterReady;
             if (success) {
               await page.waitForFunction(() => document.querySelector('#portableKindleStatus').textContent.includes('準備が完了'));
               readyUi = await page.locator('#portableKindleStatus').textContent();
               await page.screenshot({ path: path.join(process.env.KTZ_LIMITED_TEST_EVIDENCE, 'ready-ui.png') });
               // Only the user's post-ready choice may create another tab. It
               // must not satisfy readiness by replacing the original blank.
               const popup = library.waitForEvent('popup', { timeout: 10_000 });
               await library.locator('#chooseAnonymous').click({ noWaitAfter: true });
               readerPage = await popup;
               await readerPage.waitForLoadState('domcontentloaded', { timeout: 10_000 });
               await readerPage.locator('canvas').waitFor({ state: 'visible' });
               const rendered = await readerPage.locator('canvas').evaluate(canvas => {
                 const box = canvas.getBoundingClientRect(), ctx = canvas.getContext('2d');
                 const first = [...ctx.getImageData(1, 1, 1, 1).data], mark = [...ctx.getImageData(40, 100, 1, 1).data];
                 return { visible: box.width > 0 && box.height > 0, painted: first.some((value, index) => value !== mark[index]) };
               });
               readerAfterReady = { originMatches: new URL(readerPage.url()).origin === origin,
                 separatePage: readerPage !== library && readerPage.context() === library.context(),
                 pageCount: library.context().pages().length, sameInitialPage: app.reader.page === library,
                 autoSelected: Boolean(app.reader.explicitPage), rendered };
               await readerPage.screenshot({ path: path.join(process.env.KTZ_LIMITED_TEST_EVIDENCE, 'pending-reader.png') });
            } else {
              await page.waitForFunction(() => document.querySelector('#portableKindleStatus').textContent.includes('試行は停止'));
              await page.screenshot({ path: path.join(process.env.KTZ_LIMITED_TEST_EVIDENCE, 'failed-ui.png') });
            }
            if (mode === 'wait-child-frame') {
              const response = await fetch(`${origin}/release-main`), released = await response.json();
              const frame = library.frames().find(item => item !== library.mainFrame() && item.url().endsWith('/held-frame'));
              afterRelease = { released: released.count, mainState: await library.evaluate(() => document.readyState),
                mainDcl: await loadState(library, 'domcontentloaded'), mainLoad: await loadState(library, 'load'),
                childState: await frame.evaluate(() => document.readyState),
                sameInitialPage: app.reader.page === library, autoSelected: Boolean(app.reader.explicitPage),
                readerStillVisible: await readerPage.locator('canvas').isVisible(), startup };
            }
            if (mode === 'wait-main-dcl') {
              const count = () => ({ screenshots, sends, images: app.job.manifest.images.length,
                originals: fs.readdirSync(path.join(stopped.job.job_path, 'originals')).length });
              const beforeChoice = count(), autoSelected = Boolean(app.reader.explicitPage);
              await page.waitForFunction(() => document.querySelector('#readerTab').options.length === 3);
              await ui.locator('#readerTab').selectOption(await page.locator('#readerTab option').last().getAttribute('value'));
              await ui.locator('#selectReaderTab').click(); await wait(s => s.readerTabConfirmed && !s.busy);
              await ui.locator('#quickPreview').click(); await wait(s => s.previewReady && !s.busy);
              const previewHash = createHash('sha256').update(app.previewImage).digest('hex'), afterPreview = count();
              await ui.locator('#maxCaptures').fill('2'); await ui.locator('#previewConfirmed').check();
              await ui.locator('#approve').click(); await wait(s => s.previewApproved && !s.busy);
              const afterApproval = count();
              await ui.locator('#start').click();
              const review = await wait(s => s.state === 'Review' && !s.busy, 30_000);
              await page.locator('#counts').scrollIntoViewIfNeeded();
              await page.screenshot({ path: path.join(process.env.KTZ_LIMITED_TEST_EVIDENCE, 'review.png') });
              flow = { autoSelected, beforeChoice, afterPreview, afterApproval, state: review.state, reason: review.reason,
                afterStart: count(), exports: review.job.manifest.exports.length,
                firstMatches: review.job.manifest.images[0]?.sha256 === previewHash,
                initialDcl: await loadState(library, 'domcontentloaded'), dispatch: review.job.manifest.checkpoint?.dispatch ?? null };
            }
            if (['wait-post-close', 'wait-post-origin'].includes(mode)) {
              if (mode === 'wait-post-close') await library.close();
              else {
                await library.goto(`${process.env.KTZ_LIMITED_TEST_OTHER_ORIGIN}/kindle-library`, { waitUntil: 'commit' });
                await library.goto(`${origin}/kindle-library`, { waitUntil: 'commit' });
              }
              const selectedTab = app.reader.tabs().find(tab => app.reader.pageLabels.get(readerPage).id === tab.id);
              const select = await api('selectReaderTab', { id: selectedTab.id });
              const preview = await api('quickPreview');
              postReady = { select, preview, screenshots, sends, images: app.job.manifest.images.length,
                originalPngs: fs.readdirSync(path.join(stopped.job.job_path, 'originals')).length };
            }
            const waitResult = { initiallyMatches: waitTrace.initialUrlMatches,
              outcome: startup?.outcome === 'ready' && stopped.browserOpen ? 'ready' : 'failed', elapsedMs };
            const firstOpen = lastCommandError;
            if (success) await api('closeBrowser');
            const retry = await api('openBrowser', { mode: 'kindle', session: selected.id });
            const current = await app.snapshot(), originals = path.join(stopped.job.job_path, 'originals');
             const result = { event: 'result', mode, claimJob: stopped.job.manifest.job_id, fixed, startupOrder, readerAfterReady, pendingUi, readyUi, blankPending, afterRelease, flow, postReady, waitResult,
              firstOpen, startup, diskStartup, retry, claimUnchanged: claimBytes.equals(fs.readFileSync(claimFile)),
              images: current.job.manifest.images.length, exports: current.job.manifest.exports.length, screenshots, sends,
              originalPngs: fs.existsSync(originals) ? fs.readdirSync(originals).filter(name => /\.png$/i.test(name)).length : 0,
              browserOpen: current.browserOpen, releasePending: current.readerReleasePending,
              ownerBrowserDisconnected: !browser.isConnected() };
            trace(result); console.log(`KTZ_LIMITED_RESULT:${JSON.stringify(result)}`); return;
          }
          if (['connection-failure', 'pipe-failure', 'browser-failure', 'record-error', 'scale-failure',
            'init-page', 'init-ready', 'init-viewport-read', 'init-viewport-apply', 'init-bind'].includes(mode)) {
            await page.waitForFunction(() => document.querySelector('#operationStatus').dataset.status === 'failure'
              && document.querySelector('#operationStatus').getAttribute('aria-busy') === 'false');
            const stopped = await wait(s => !s.busy), firstOpen = lastCommandError;
            const claimFile = path.join(app.dataDir, `portable-reader-limited-${stopped.job.manifest.job_id}.claim`);
            const claimHash = createHash('sha256').update(fs.readFileSync(claimFile)).digest('hex');
            await page.locator('#portableKindleSelection').scrollIntoViewIfNeeded();
            await page.screenshot({ path: path.join(process.env.KTZ_LIMITED_TEST_EVIDENCE, 'stopped.png') });
            const result = { event: 'result', mode, firstOpen, claimJob: stopped.job.manifest.job_id, screenshots, sends, images: stopped.job.manifest.images.length,
              exports: stopped.job.manifest.exports.length, limited: stopped.portableLimitedJob,
              consumed: stopped.portableLimitedConsumed, available: stopped.portableLimitedAvailable,
              browserOpen: stopped.browserOpen, releasePending: stopped.readerReleasePending,
              label: await page.locator('#state').textContent(), nextDisabled: await page.locator('#decisionButton').isDisabled(),
              guidance: await page.locator('#nextAction').textContent(), sessionStatus: await page.locator('#portableKindleStatus').textContent(), message: await page.locator('#message').textContent(),
              startup: stopped.portableLimitedStartup, diskStartup: await readPortableStartupRecord(app.dataDir, stopped.job.manifest.job_id), scalePendingUi };
            const recordFile = path.join(app.dataDir, 'portable-reader-startup', stopped.job.manifest.job_id, 'result.json');
            const recordBefore = fs.existsSync(recordFile) ? fs.readFileSync(recordFile, 'utf8') : null;
            result.retry = await api('openBrowser', { mode: 'kindle', session: selected.id });
            result.forbidden = [];
            for (const [action, input] of [['export', { destination: path.join(root, 'forbidden.zip') }], ['setCaptureSettings', { image_format: 'jpeg' }]]) result.forbidden.push(await api(action, input));
            result.startupUnchanged = JSON.stringify(stopped.portableLimitedStartup) === JSON.stringify((await app.snapshot()).portableLimitedStartup)
              && recordBefore === (fs.existsSync(recordFile) ? fs.readFileSync(recordFile, 'utf8') : null);
            result.recordSecretAbsent = recordBefore === null || !/anonymous-secret|credential|https?:|profile|stack|message/.test(recordBefore);
            if (mode === 'browser-failure') {
              const manifestBefore = fs.readFileSync(path.join(stopped.job.job_path, 'manifest.json'));
              result.newTrialDisabled = await page.locator('#newLimitedTrialButton').isDisabled();
              result.finishAttempt = await api('finishBook');
              result.newJobAttempt = await api('create', { baseDir: app.dataDir });
              result.stillReleasePending = (await app.snapshot()).readerReleasePending;
              result.oldManifestUnchanged = manifestBefore.equals(fs.readFileSync(path.join(stopped.job.job_path, 'manifest.json')));
              result.claimUnchanged = claimHash === createHash('sha256').update(fs.readFileSync(claimFile)).digest('hex');
              trace(result); console.log(`KTZ_LIMITED_RESULT:${JSON.stringify(result)}`); return;
            }
            await api('closeBrowser'); await api('closeJob'); await api('recover', { path: stopped.job.job_path });
            result.reuse = await api('openBrowser', { mode: 'kindle', session: selected.id });
            result.claimUnchanged = claimHash === createHash('sha256').update(fs.readFileSync(claimFile)).digest('hex');
            trace(result); console.log(`KTZ_LIMITED_RESULT:${JSON.stringify(result)}`); return;
          }
          if (legacy) {
            const stopped = await wait(s => s.portableLimitedJob && !s.busy);
            legacy.startup = stopped.portableLimitedStartup;
            legacy.guidance = await page.locator('#nextAction').textContent();
            legacy.message = await page.locator('#message').textContent();
            legacy.percent = await page.locator('#operationPercent').textContent();
            legacy.operationLabel = await page.locator('#operationLabel').textContent();
            legacy.retry = await api('openBrowser', { mode: 'kindle', session: selected.id });
            legacy.edit = await api('setCaptureSettings', { image_format: 'jpeg' });
            legacy.stop = await api('stop'); legacy.pause = await api('pause');
            legacy.newTrialEnabled = await page.locator('#newLimitedTrialButton').isEnabled();
            await page.locator('#portableKindleSelection').scrollIntoViewIfNeeded();
            await page.screenshot({ path: path.join(process.env.KTZ_LIMITED_TEST_EVIDENCE, 'stopped.png') });
            await ui.locator('#newLimitedTrialButton').click();
            const fresh = await wait(s => s.job && s.job.manifest.job_id !== legacy.job.manifest.job_id && !s.busy);
            legacy.newJob = fresh.job.manifest.job_id;
            legacy.claimUnchanged = legacy.claimBytes.equals(fs.readFileSync(legacy.claimFile));
            legacy.manifestUnchanged = legacy.manifestBytes.equals(fs.readFileSync(path.join(legacy.job.job_path, 'manifest.json')));
            legacy.available = fresh.portableLimitedAvailable;
            legacy.claimBeforeConnect = fs.existsSync(path.join(app.dataDir, `portable-reader-limited-${legacy.newJob}.claim`));
            await page.locator('#decisionButton').click();
          }
          await wait(s => s.browserOpen && !s.busy);
          const beforeChoice = { screenshots, sends, images: app.job.manifest.images.length }, blocked = [];
          if (mode === 'no-selection') {
            const preview = await api('quickPreview');
            const result = { event: 'result', mode, claimJob: app.job.manifest.job_id, beforeChoice, preview, screenshots, sends, images: app.job.manifest.images.length };
            result.reviewBeforePreview = await api('review');
            result.selectAfterReview = await api('selectReaderTab', { id: app.reader.tabs()[0].id });
            result.previewAfterReview = await api('quickPreview');
            result.afterReview = { screenshots, sends, images: app.job.manifest.images.length };
            const jobPath = app.job.job_path;
            await api('closeBrowser'); await api('closeJob'); await api('recover', { path: jobPath });
            result.reuse = await api('openBrowser', { mode: 'kindle', session: selected.id });
            trace(result); console.log(`KTZ_LIMITED_RESULT:${JSON.stringify(result)}`); return;
          }
          for (const [action, input] of [['export', { destination: path.join(root, 'forbidden.zip') }], ['setCaptureSettings', { image_format: 'jpeg' }], ['openBrowser', { mode: 'owned-fixture' }]]) blocked.push(await api(action, input));
          const library = app.reader.page;
          await library.locator('#chooseAnonymous').click();
          const count = ['positive', 'legacy-stop'].includes(mode) ? 2 : 3;
          if (['positive', 'legacy-stop'].includes(mode)) await library.waitForURL(`${origin}/kindle-library/manga-wr/B000TEST04`);
          await page.waitForFunction(count => document.querySelector('#readerTab').options.length === count, count);
          const autoSelected = Boolean(app.reader.explicitPage);
          await ui.locator('#readerTab').selectOption(await page.locator('#readerTab option').last().getAttribute('value'));
          await ui.locator('#selectReaderTab').click(); await wait(s => s.readerTabConfirmed && !s.busy);
          if (mode === 'separate-tab') {
            // Before preview a closed target can be explicitly reselected from
            // this same owner. It must not consume another claim/owner or shot.
            const oldId = app.reader.selectedTabId();
            await app.reader.page.close(); await library.locator('#chooseAnonymous').click();
            await page.waitForFunction(oldId => {
              const options = [...document.querySelector('#readerTab').options];
              return options.length === 3 && !options.some(o => o.value === oldId);
            }, oldId);
            await ui.locator('#readerTab').selectOption(await page.locator('#readerTab option').last().getAttribute('value'));
            await ui.locator('#selectReaderTab').click(); await wait(s => s.readerTabConfirmed && !s.busy);
          }
          await page.locator('#readerTab').scrollIntoViewIfNeeded();
          await page.screenshot({ path: path.join(process.env.KTZ_LIMITED_TEST_EVIDENCE, 'selection.png') });
          await ui.locator('#quickPreview').click(); await wait(s => s.previewReady && !s.busy);
          const previewHash = createHash('sha256').update(app.previewImage).digest('hex'), beforeStart = { screenshots, sends, images: app.job.manifest.images.length };
          const early = await api('start', { confirmed: true });
          await ui.locator('#maxCaptures').fill('2'); await ui.locator('#previewConfirmed').check(); await ui.locator('#approve').click(); await wait(s => s.previewApproved && !s.busy);
          await ui.locator('#approval').scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(process.env.KTZ_LIMITED_TEST_EVIDENCE, 'approval.png') });
          if (mode === 'target-change') await app.reader.page.evaluate(() => { const n = document.querySelector('#readerChromeTitle'), prior = n.textContent; n.textContent = '別の匿名本'; n.textContent = prior; });
          if (mode === 'extra-tab') { const extra = await app.reader.context.newPage(); await extra.goto(`${origin}/kindle-library`); }
          if (mode === 'target-close') await app.reader.page.close();
          if (mode === 'document-reload') await app.reader.page.reload({ waitUntil: 'domcontentloaded' });
          if (mode === 'route-change') await app.reader.page.evaluate(() => { const old = location.href; history.replaceState(null, '', '?asin=B000TEST03'); history.replaceState(null, '', old); });
           if (mode === 'position-change') await app.reader.page.evaluate(() => { const node = document.querySelector('#position'), old = node.value; node.value = '9'; node.dispatchEvent(new Event('input', { bubbles: true })); node.value = old; });
           if (mode === 'position-turn-restore') {
             await app.reader.page.locator('#next').click();
             await app.reader.page.locator('button[aria-label="前のページへ"]').click();
           }
          if (mode === 'cancel') await api('cancelBack');
          if (mode === 'save-error') { const call = app.store.call.bind(app.store); app.store.call = async (kind, ...args) => { if (kind === 'capture_begin') throw new AppError('anonymous_save_error'); return call(kind, ...args); }; }
          const start = await api('start', { confirmed: true, maxCaptures: 2 });
          const duplicateStart = await api('start', { confirmed: true, maxCaptures: 2 });
          const stopped = await wait(s => !s.busy);
          if (positive) await page.locator('#counts').scrollIntoViewIfNeeded();
          await page.screenshot({ path: path.join(process.env.KTZ_LIMITED_TEST_EVIDENCE, positive ? 'review.png' : 'stopped.png') });
          const postBlocked = [];
          for (const [action, input] of [['export', { destination: path.join(root, 'forbidden.cbz'), format: 'cbz' }], ['setPageLayout', { mode: 'split_spread', firstPage: 'right', id: 1 }], ['openBrowser', { mode: 'kindle', session: selected.id }]]) postBlocked.push(await api(action, input));
          const after = fs.statSync(selected.profile);
           const result = { event: 'result', mode, claimJob: stopped.job.manifest.job_id, beforeChoice, beforeStart, autoSelected, early, start, duplicateStart, blocked, postBlocked, state: stopped.state, reason: stopped.reason, images: stopped.job.manifest.images.length, screenshots, sends, exports: stopped.job.manifest.exports.length,
             dispatch: stopped.job.manifest.checkpoint?.dispatch ?? null, readerPages: app.reader.context.pages().length,
             startup: stopped.portableLimitedStartup, diskStartup: await readPortableStartupRecord(app.dataDir, stopped.job.manifest.job_id),
             presetPreserved: mode === 'positive' ? presetBefore === fs.readFileSync(path.join(app.dataDir, 'reader-presets.json'), 'utf8') : null, startupOrder,
             firstMatches: stopped.job.manifest.images.length ? stopped.job.manifest.images[0].sha256 === previewHash : null, profileUnchanged: before.dev === after.dev && before.ino === after.ino, disabledNext: await page.locator('#decisionButton').isDisabled(), savedReviewAction: await page.locator('#decisionButton').textContent() };
          result.repeatPreview = await api('quickPreview'); result.afterRepeat = { screenshots, sends };
           if (mode === 'positive') {
             // A completed version-2 attempt has actual originals and a live
             // owner. Exercise the same visible new-trial action, not just the
             // old fixed-claim/zero-image path above.
             const claimFile = path.join(app.dataDir, `portable-reader-limited-${stopped.job.manifest.job_id}.claim`);
               const startupFile = path.join(app.dataDir, 'portable-reader-startup', stopped.job.manifest.job_id, 'result.json');
               // 共通adapterは新しいstartup recorderを作らない。記録なしを成功記録に捏造せず、
               // 実在する旧記録だけを保全対象へ含める。
               const paths = [claimFile, path.join(stopped.job.job_path, 'manifest.json'),
                 ...(fs.existsSync(startupFile) ? [startupFile] : []),
                 ...stopped.job.manifest.images.map(image => path.join(stopped.job.job_path, image.path))];
               result.startupFilePresent = fs.existsSync(startupFile);
              const bytes = paths.map(file => fs.readFileSync(file));
              await page.waitForFunction(() => {
                const button = document.querySelector('#newLimitedTrialButton');
                return button && !button.hidden && !button.disabled;
              });
              result.nextTrialEnabled = await page.locator('#newLimitedTrialButton').isEnabled();
              await ui.locator('#newLimitedTrialButton').click();
             const fresh = await wait(s => s.job && s.job.manifest.job_id !== stopped.job.manifest.job_id && !s.busy);
             result.nextTrial = { empty: fresh.job.manifest.images.length === 0, browserOpen: fresh.browserOpen,
               available: fresh.portableLimitedAvailable, claimExists: fs.existsSync(path.join(app.dataDir, `portable-reader-limited-${fresh.job.manifest.job_id}.claim`)),
               originalsAndRecordsUnchanged: paths.every((file, index) => bytes[index].equals(fs.readFileSync(file))), screenshots, sends };
             await api('closeJob'); await api('recover', { path: stopped.job.job_path });
           } else { await api('closeBrowser'); await api('closeJob'); await api('recover', { path: stopped.job.job_path }); }
           result.recoveredExport = await api('export', { destination: path.join(root, 'forbidden-recovered.zip') });
           await api('closeJob');
           if (['positive', 'legacy-stop'].includes(mode)) {
             const primaryApp = app;
             const { startApplication } = await import('../../app/server.mjs');
             const other = await startApplication({ dataDir: path.join(root, 'other-application') });
             try {
               const request = async (action, input = {}) => {
                 const response = await fetch(`${other.origin}/api/command`, { method: 'POST', headers: {
                   Authorization: `Bearer ${other.token}`, 'Content-Type': 'application/json', Origin: other.origin,
                 }, body: JSON.stringify({ action, input }) });
                 return { status: response.status, body: await response.json() };
               };
                const recovered = await request('recover', { path: stopped.job.job_path });
               result.otherDataRecover = recovered.status; result.otherDataLimited = recovered.body.portableLimitedJob;
               const before = JSON.stringify((await other.app.store.call('job_info')).snapshot.manifest);
               result.otherDataBlocked = [];
               for (const [action, input] of [
                 ['crop', { id: 1, x: 0, y: 0, width: 100, height: 100 }],
                 ['setPageLayout', { id: 1, mode: 'split_spread', firstPage: 'right' }],
                 ['review', { ids: [2, 1] }],
                 ['export', { destination: path.join(root, 'forbidden-other.zip'), format: 'zip', rangeConfirmed: true }],
                 ['export', { destination: path.join(root, 'forbidden-other.cbz'), format: 'cbz', rangeConfirmed: true }],
               ]) {
                 const response = await request(action, input);
                 result.otherDataBlocked.push({ status: response.status, code: response.body.code });
               }
                result.otherDataUnchanged = before === JSON.stringify((await other.app.store.call('job_info')).snapshot.manifest);
                if (legacy) {
                  await request('closeJob');
                  const old = await request('recover', { path: legacy.job.job_path });
                  legacy.otherDataRecover = old.status; legacy.otherDataLimited = old.body.portableLimitedJob;
                  legacy.otherDataExport = await request('export', { destination: path.join(root, 'forbidden-legacy.zip') });
                  legacy.otherDataExport = { status: legacy.otherDataExport.status, code: legacy.otherDataExport.body.code };
                  const oldManifest = fs.readFileSync(path.join(legacy.job.job_path, 'manifest.json'));
                  legacy.otherDataReview = (await request('review')).status;
                  legacy.otherDataReviewUnchanged = oldManifest.equals(fs.readFileSync(path.join(legacy.job.job_path, 'manifest.json')));
                }
              } finally { await other.close(); app = primaryApp; }
            }
           await api('recover', { path: stopped.job.job_path });
           result.reuse = await api('openBrowser', { mode: 'kindle', session: selected.id }); result.files = fs.readdirSync(stopped.job.job_path);
           if (legacy) {
             legacy.claimUnchanged &&= legacy.claimBytes.equals(fs.readFileSync(legacy.claimFile));
             legacy.manifestUnchanged &&= legacy.manifestBytes.equals(fs.readFileSync(path.join(legacy.job.job_path, 'manifest.json')));
             legacy.startupUnchanged = JSON.stringify(legacy.startup) === JSON.stringify(await readPortableStartupRecord(app.dataDir, legacy.job.manifest.job_id));
             result.legacy = { startup: legacy.startup, guidance: legacy.guidance, message: legacy.message, percent: legacy.percent,
               operationLabel: legacy.operationLabel, retry: legacy.retry, edit: legacy.edit, newTrialEnabled: legacy.newTrialEnabled,
               stop: legacy.stop, pause: legacy.pause,
               newJob: legacy.newJob, claimUnchanged: legacy.claimUnchanged, manifestUnchanged: legacy.manifestUnchanged,
               available: legacy.available, claimBeforeConnect: legacy.claimBeforeConnect, startupUnchanged: legacy.startupUnchanged,
               otherDataRecover: legacy.otherDataRecover, otherDataLimited: legacy.otherDataLimited, otherDataExport: legacy.otherDataExport,
               otherDataReview: legacy.otherDataReview, otherDataReviewUnchanged: legacy.otherDataReviewUnchanged };
           }
          trace(result); console.log(`KTZ_LIMITED_RESULT:${JSON.stringify(result)}`);
        } catch (error) { trace({ event: 'error', message: String(error.stack ?? error) }); console.error(`KTZ_LIMITED_ERROR:${error.stack ?? error}`); }
        finally {
          // A fixture setup error must not leave a product command held by our
          // test-only gate while main's normal shutdown waits for that command.
          readyGateClosing = true;
          releaseReady?.();
          await page.close();
        }
      })); return context;
    }; return browser;
  };
}
