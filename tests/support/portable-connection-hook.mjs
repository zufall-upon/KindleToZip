// Instrument the ordinary GUI only in this anonymous test process. The sole
// substituted boundary is only the site/consent policy. The product owner and
// its selected relative profile resolution, lock and pipe execute unchanged.
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { withPublicDisclosures } from '../../poc/browser/public-ui-controls.mjs';

const root = process.env.KTZ_PORTABLE_CONNECTION_ROOT;
const base = '/home/user/KTZRC';
if (!root?.startsWith(`${base}/portable-connection-`) || path.dirname(root) !== base) throw new Error('anonymous_only');
const trace = value => fs.appendFileSync(path.join(root, 'trace.ndjson'), `${JSON.stringify(value)}\n`, { mode: 0o600 });
const ownerEntry = /(?:^|\/)app\/linux-owned-reader-owner\.mjs$/.test(process.argv[1] ?? '');
const mainEntry = /(?:^|\/)app\/main\.mjs$/.test(process.argv[1] ?? '');

if (ownerEntry || mainEntry) registerHooks({ resolve(specifier, context, next) {
  if (specifier === './portable-linux-site.mjs' && /\/app\/(?:portable-linux-reader|linux-owned-reader-owner)\.mjs$/.test(new URL(context.parentURL ?? import.meta.url).pathname)) {
    return { url: new URL('./portable-connection-gate-fixture.mjs', import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
} });

if (ownerEntry) {
  const spawn = childProcess.spawn;
  childProcess.spawn = (executable, args, options) => {
    const id = process.argv[3];
    const profile = path.join(root, 'data', id, 'owned/profile');
    if (executable !== '/snap/bin/chromium' || !args.includes(`--user-data-dir=${profile}`)
      || !args.includes('--remote-debugging-pipe') || !args.includes('--ozone-platform=wayland')
      || args.some(arg => ['--no-sandbox', '--disable-setuid-sandbox', '--password-store=basic'].includes(arg))) throw new Error('unsafe_fixture_launch');
    if (!fs.lstatSync(path.join(root, 'data', id, 'owned/in-use.lock')).isFile()) throw new Error('owner_lock_missing');
    const child = spawn(executable, args, options);
    trace({ event: 'spawn', owner: process.pid, browser: child.pid, profile, lockHeld: true });
    return child;
  };
  syncBuiltinESMExports();
}

if (mainEntry) {
  const fork = childProcess.fork;
  childProcess.fork = (file, args, options) => file.endsWith('/app/linux-owned-reader-owner.mjs')
    ? fork(file, args, { ...options, execArgv: [`--import=${import.meta.url}`] }) : fork(file, args, options);
  syncBuiltinESMExports();
  const { Application } = await import('../../app/application.mjs');
  const { Reader } = await import('../../app/reader.mjs');
  const { resolvePortableLinuxSession } = await import('../../app/portable-linux-session.mjs');
  const { chromium } = await import('playwright');
  let app, screenshots = 0, sends = 0;
  const command = Application.prototype.command;
  Application.prototype.command = async function (...args) { app = this; return command.apply(this, args); };
  const screenshot = Reader.prototype.screenshotVisibleClip;
  Reader.prototype.screenshotVisibleClip = function (...args) { screenshots++; return screenshot.apply(this, args); };
  const advance = Reader.prototype.advance;
  Reader.prototype.advance = async function (...args) {
    const click = this.page.mouse.click.bind(this.page.mouse);
    this.page.mouse.click = async (...point) => { sends++; return click(...point); };
    try { return await advance.apply(this, args); } finally { this.page.mouse.click = click; }
  };
  const launch = chromium.launch.bind(chromium);
  chromium.launch = async options => {
    let browser;
    try { browser = await launch(options); }
    catch (error) { trace({ event: 'control-launch-failed', error: String(error?.message ?? error) }); throw error; }
    const newContext = browser.newContext.bind(browser);
    browser.newContext = async options => {
      const context = await newContext(options); let connected = false;
      context.on('page', page => page.on('domcontentloaded', async () => {
        if (connected || !page.url().startsWith('http://127.0.0.1:')) return;
        connected = true;
        const socket = net.createConnection(process.env.KTZ_PORTABLE_CONNECTION_SOCKET);
        const send = value => socket.write(`${JSON.stringify(value)}\n`);
        const ui = withPublicDisclosures(page);
        const wait = async (predicate, label) => {
          const deadline = Date.now() + 40_000; let state;
          do {
            if (app) { state = await app.snapshot(); if (predicate(state)) return state; }
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
          await page.locator('#decisionButton').click();
          await wait(s => Boolean(s.job) && !s.busy, 'create');
          // The login resolver creates exactly this run's empty owner/identity.
          const selected = await resolvePortableLinuxSession(app.dataDir);
          const identity = await fs.promises.lstat(selected.profile);
          await page.waitForFunction(id => [...document.querySelector('#portableKindleSession').options].some(option => option.value === id), selected.id);
          await page.locator('#captureSource').selectOption('kindle');
          await page.locator('#portableKindleSession').selectOption(selected.id);
          await page.waitForFunction(() => !document.querySelector('#decisionButton').disabled);
          await page.locator('#decisionButton').click();
          await wait(s => s.portableKindlePrepared === selected.id && !s.busy, 'prepare');
          await page.waitForFunction(() => document.querySelector('#portableKindleStatus').textContent.includes('未許可'));
          await page.locator('#portableKindleSelection').scrollIntoViewIfNeeded();
          await page.screenshot({ path: path.join(process.env.KTZ_PORTABLE_CONNECTION_EVIDENCE, 'source.png') });
          const preOpen = { screenshots, sends, images: (await app.snapshot()).job.manifest.images.length, reader: Boolean(app.reader) };
          await page.waitForFunction(() => !document.querySelector('#decisionButton').disabled);
          await page.locator('#decisionButton').click();
          const opened = await wait(s => s.browserOpen && !s.busy, 'open');
          // The real selected-profile owner is live. A concurrent login must
          // fail on its lock before a second browser can be launched.
          const { runLinuxLogin } = await import('../../app/linux-login-core.mjs');
          let concurrentLaunch = false, concurrentCode;
          try {
            await runLinuxLogin({ root: selected.root, url: 'about:blank', preflight: async () => {},
              requireExistingProfile: true, requireAbsentSingleton: true,
              launch() { concurrentLaunch = true; throw new Error('unexpected_concurrent_launch'); } });
          } catch (error) { concurrentCode = error.code; }
          await page.waitForFunction(() => ['captureStage', 'selectReaderTab'].includes(document.querySelector('#decisionButton').dataset.action)
            && !document.querySelector('#decisionButton').disabled);
          if (await page.locator('#decisionButton').getAttribute('data-action') === 'captureStage') await page.locator('#decisionButton').click();
          await page.waitForFunction(() => document.querySelector('#decisionButton').dataset.action === 'selectReaderTab' && !document.querySelector('#decisionButton').disabled);
          await page.locator('#decisionButton').click(); await wait(s => s.readerTabConfirmed && !s.busy, 'tab');
          await page.waitForFunction(() => document.querySelector('#decisionButton').dataset.action === 'preview' && !document.querySelector('#decisionButton').disabled);
          await page.locator('#decisionButton').click(); await wait(s => s.previewReady && !s.busy, 'preview');
          const early = await api('start', { confirmed: true });
          await ui.locator('#maxCaptures').fill('2'); await ui.locator('#previewConfirmed').check();
          await ui.locator('#approve').click(); const firstApproval = await wait(s => s.previewApproved && !s.busy, 'approve');
          const approvalEffects = { screenshots, sends, images: firstApproval.job.manifest.images.length };
          // Exercise real target-position invalidation on this self-authored page.
          await app.reader.page.evaluate(() => document.querySelector('#next').click());
          const stale = await api('start', { confirmed: true, maxCaptures: 2 });
          const invalidated = await app.snapshot();
          // A target mismatch irreversibly fails this owner's budget. Join it
          // normally, then explicitly reconnect the same selected session.
          const firstClose = await api('closeBrowser');
          await page.waitForFunction(() => document.querySelector('#decisionButton').dataset.action === 'openBrowser'
            && !document.querySelector('#decisionButton').disabled);
          await page.locator('#decisionButton').click();
          await wait(s => s.browserOpen && !s.busy, 'reopen');
          await page.waitForFunction(() => ['captureStage', 'selectReaderTab'].includes(document.querySelector('#decisionButton').dataset.action)
            && !document.querySelector('#decisionButton').disabled);
          if (await page.locator('#decisionButton').getAttribute('data-action') === 'captureStage') await page.locator('#decisionButton').click();
          await page.waitForFunction(() => document.querySelector('#decisionButton').dataset.action === 'selectReaderTab' && !document.querySelector('#decisionButton').disabled);
          await page.locator('#decisionButton').click(); await wait(s => s.readerTabConfirmed && !s.busy, 'new-tab');
          await ui.locator('#quickPreview').click(); await wait(s => s.previewReady && !s.busy, 'new-preview');
          await ui.locator('#maxCaptures').fill('2'); await ui.locator('#previewConfirmed').check();
          await ui.locator('#approve').click(); const approved = await wait(s => s.previewApproved && !s.busy, 'new-approve');
          const secondApprovalImages = approved.job.manifest.images.length;
          await ui.locator('#approval').scrollIntoViewIfNeeded();
          await page.screenshot({ path: path.join(process.env.KTZ_PORTABLE_CONNECTION_EVIDENCE, 'approval.png') });
          await ui.locator('#start').click(); const stopped = await wait(s => s.state === 'Review' && !s.busy, 'review');
          await page.locator('#counts').scrollIntoViewIfNeeded();
          await page.screenshot({ path: path.join(process.env.KTZ_PORTABLE_CONNECTION_EVIDENCE, 'review.png') });
          const endIdentity = await fs.promises.lstat(selected.profile);
          send({ event: 'result', id: selected.id, profile: selected.profile,
            sameIdentity: identity.dev === endIdentity.dev && identity.ino === endIdentity.ino,
            preOpen, opened: opened.browserOpen, concurrentLogin: { code: concurrentCode, launched: concurrentLaunch }, early: early.body.code, approvalEffects,
            stale: [stale.status, stale.body.code], firstClose: firstClose.status, invalidated: { preview: invalidated.previewReady, approved: invalidated.previewApproved },
            secondApprovalImages, state: stopped.state, reason: stopped.reason,
            images: stopped.job.manifest.images.length, dispatch: stopped.job.manifest.checkpoint.dispatch, screenshots, sends });
        } catch (error) { send({ event: 'error', message: error.stack ?? String(error) }); void page.close(); }
      }));
      return context;
    };
    return browser;
  };
}
