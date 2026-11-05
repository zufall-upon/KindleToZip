// Anonymous-only Playwright proof. No authentication profile or live service is
// accepted. Protocol strings stay in this process; only fixed booleans escape.
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, readFile, readlink, realpath, open, unlink, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { inspectKindleDocument, observeBoundKindle } from '../../app/linux-reader-probe.mjs';
import { prepareLinuxLoginProfile, snapLoginPreflight } from '../../app/linux-login-core.mjs';

const root = process.env.KTZ_PW_PROBE_ROOT, output = process.env.KTZ_PW_PROBE_OUTPUT;
if (!root?.startsWith('/home/user/snap/chromium/common/ktz-pw-probe-20261101-8f13e1b6/run-')
    || !output?.startsWith('/tmp/opencode/ktz-reader-probe-20261101-8f13e1b6/run-')) throw new Error('anonymous_fixture_required');
process.umask(0o077);
let phase = 'preflight', owned, markerBefore, lockInfo, context, browserChild, childEnd;
const summary = { status: 'failed', cases: [], normalExit: false, groupGone: false, lockReleased: false,
  bootstrap: { frameTree: false, networkEnabled: false, logEnabled: false, autoAttach: false,
    parsedFixtureUrl: false, parsedFixtureConsole: false, parsedFixtureNetwork: false },
  inspection: { forbiddenCommand: false, inputEvents: 0 } };
let inspecting = false;
const nativeParse = JSON.parse, nativeSpawn = childProcess.spawn;
JSON.parse = (text, ...rest) => {
  if (typeof text === 'string' && !inspecting) {
    if (text.includes('PW_FIXTURE_URL_SENTINEL') && /"method":"(?:Page\.frameNavigated|Target\.targetInfoChanged|Network\.requestWillBeSent)"/.test(text)) summary.bootstrap.parsedFixtureUrl = true;
    if (text.includes('PW_FIXTURE_CONSOLE_SENTINEL') && text.includes('Runtime.consoleAPICalled')) summary.bootstrap.parsedFixtureConsole = true;
    if (text.includes('PW_FIXTURE_URL_SENTINEL') && text.includes('Network.requestWillBeSent')) summary.bootstrap.parsedFixtureNetwork = true;
  }
  return nativeParse(text, ...rest);
};
childProcess.spawn = (executable, args, options) => {
  if (executable !== '/snap/bin/chromium') return nativeSpawn(executable, args, options);
  assert.ok(owned && args.includes(`--user-data-dir=${owned.profile}`));
  assert.ok(args.includes('--remote-debugging-pipe') && !args.some(arg => arg.startsWith('--remote-debugging-port')));
  assert.ok(!args.some(arg => ['--no-sandbox', '--disable-setuid-sandbox', '--password-store=basic', '--use-mock-keychain'].includes(arg)));
  assert.equal(options.detached, true);
  const child = nativeSpawn(executable, args, options);
  browserChild = child;
  childEnd = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  const write = child.stdio[3].write.bind(child.stdio[3]);
  child.stdio[3].write = (data, ...rest) => {
    try {
      const message = nativeParse(data.toString().replace(/\0$/, ''));
      if (!inspecting) {
        if (message.method === 'Page.getFrameTree') summary.bootstrap.frameTree = true;
        if (message.method === 'Network.enable') summary.bootstrap.networkEnabled = true;
        if (message.method === 'Log.enable') summary.bootstrap.logEnabled = true;
        if (message.method === 'Target.setAutoAttach') summary.bootstrap.autoAttach = true;
      } else if (['Page.navigate', 'Target.closeTarget', 'Page.captureScreenshot', 'Page.startScreencast',
        'Network.getResponseBody', 'Network.getCookies', 'Storage.getCookies', 'Input.dispatchMouseEvent', 'Input.dispatchKeyEvent'].includes(message.method)) {
        summary.inspection.forbiddenCommand = true;
      }
    } catch { /* a protocol fragment is never printed or retained */ }
    return write(data, ...rest);
  };
  return child;
};

let origin, server;
const metadata = { title: '架空の本', position: { value: 42, min: 0, max: 100 },
  region: { width: 640, height: 480, visibleWidth: 640, visibleHeight: 480 } };
const readerHtml = () => `<!doctype html><meta charset="utf-8"><title>PW_FIXTURE_TITLE_SENTINEL</title>
  <style>body{margin:0}#region{width:640px;height:480px}</style>
  <div id="region"><div><div><div><div id="title-wrap"><span id="readerChromeTitle">架空の本</span></div></div></div></div>
  <input type="range" min="0" max="100" value="42"><button aria-label="次のページ">次</button><canvas width="600" height="300"></canvas></div>
  <p>PW_FIXTURE_BODY_SENTINEL</p><script>
  window.fixtureBinding='selected-a';window.titleReads=0;
  const title=document.querySelector('#readerChromeTitle'),get=Object.getOwnPropertyDescriptor(HTMLElement.prototype,'innerText').get;
  Object.defineProperty(title,'innerText',{get(){window.titleReads++;return get.call(this)}});
  for(const type of ['click','keydown','input','change','submit'])document.addEventListener(type,()=>fetch('/input-event'),true);
  console.log('PW_FIXTURE_CONSOLE_SENTINEL');fetch('/bootstrap?PW_FIXTURE_URL_SENTINEL');
  </script>`;
const waitGroupGone = async pid => {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { process.kill(-pid, 0); }
    catch (error) { return error.code === 'ESRCH'; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return false;
};

try {
  assert.equal(await realpath(root), root);
  const home = userInfo().homedir;
  const env = { ...process.env, HOME: home };
  for (const key of ['TMPDIR', 'TMP', 'TEMP', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'CHROME_LOG_FILE', 'CHROMIUM_FLAGS', 'DEBUG', 'PWDEBUG']) delete env[key];
  await snapLoginPreflight(home, env);
  owned = await prepareLinuxLoginProfile(root);
  markerBefore = await readFile(owned.marker, 'utf8');
  const lock = await open(owned.lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await lock.writeFile('anonymous-playwright-probe-only\n'); await lock.sync(); lockInfo = await lock.stat(); }
  finally { await lock.close(); }
  server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    if (pathname === '/input-event') { summary.inspection.inputEvents++; res.writeHead(204).end(); return; }
    if (pathname === '/bootstrap' || pathname === '/favicon.ico') { res.writeHead(204).end(); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      .end(pathname === '/frame-host' ? '<!doctype html><iframe id="known-reader-frame" src="/reader?PW_FIXTURE_URL_SENTINEL" width="900" height="700"></iframe>' : readerHtml());
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  phase = 'launch';
  const { chromium } = await import('playwright');
  context = await chromium.launchPersistentContext(owned.profile, { executablePath: '/snap/bin/chromium', headless: false,
    chromiumSandbox: true, ignoreDefaultArgs: ['--password-store=basic', '--use-mock-keychain'], env,
    viewport: { width: 1100, height: 850 }, acceptDownloads: false,
    handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false, timeout: 15000 });
  assert.ok(browserChild && childEnd);
  assert.equal(await readlink(`/proc/${browserChild.pid}/exe`), await realpath('/snap/chromium/current/usr/lib/chromium-browser/chrome'));
  const liveArgs = (await readFile(`/proc/${browserChild.pid}/cmdline`)).toString();
  assert.ok(liveArgs.includes(`--user-data-dir=${owned.profile}`));
  assert.ok(!/--no-sandbox|--disable-setuid-sandbox|--password-store=basic|--use-mock-keychain|--remote-debugging-port/.test(liveArgs));
  summary.sandboxAndKeyringFlagsPreserved = true;
  const bootstrap = await context.newPage();
  await bootstrap.goto(`${origin}/reader?PW_FIXTURE_URL_SENTINEL`);
  await bootstrap.waitForLoadState('networkidle');
  assert.ok(Object.values(summary.bootstrap).every(Boolean));
  await bootstrap.close();

  for (const [name, expectedReason] of [
    ['ready', null], ['delayed-visible', null], ['missing', 'reader-identity-missing'],
    ['duplicate', 'reader-identity-multiple'], ['hidden', 'reader-identity-hidden'],
    ['clipped', 'reader-identity-clipped'], ['position-missing', 'reader-position-missing'],
    ['next-missing', 'reader-next-missing'], ['peer-not-selected', null],
    ['selection-changed', 'binding-changed'], ['node-replaced', 'binding-changed'],
    ['frame-host', 'reader-identity-missing'], ['bound-known-frame', null],
  ]) {
    phase = name;
    const page = await context.newPage();
    await page.goto(`${origin}/${['frame-host', 'bound-known-frame'].includes(name) ? 'frame-host' : 'reader'}?PW_FIXTURE_URL_SENTINEL`);
    let frame = page.mainFrame(), peer;
    if (name === 'bound-known-frame') {
      const handle = await page.locator('#known-reader-frame').elementHandle();
      frame = await handle.contentFrame(); await handle.dispose();
      assert.ok(frame && frame.parentFrame() === page.mainFrame());
      await frame.waitForSelector('#readerChromeTitle');
    }
    if (name === 'missing') await frame.locator('#readerChromeTitle').evaluate(node => node.remove());
    if (name === 'duplicate') await frame.locator('#readerChromeTitle').evaluate(node => node.after(node.cloneNode(true)));
    if (['hidden', 'delayed-visible'].includes(name)) await frame.locator('#readerChromeTitle').evaluate(node => { node.style.visibility = 'hidden'; });
    if (name === 'clipped') await frame.locator('#title-wrap').evaluate(node => { node.style.width = '8px'; node.style.overflow = 'hidden'; });
    if (name === 'position-missing') await frame.locator('input[type="range"]').evaluate(node => node.remove());
    if (name === 'next-missing') await frame.locator('button').evaluate(node => node.remove());
    if (name === 'peer-not-selected') {
      peer = await context.newPage(); await peer.goto(`${origin}/reader?PW_FIXTURE_URL_SENTINEL`);
      await peer.evaluate(() => { window.fixtureBinding = 'different-book'; });
      await page.bringToFront(); // anonymous stand-in for the earlier explicit selection
    }
    // This token is supplied out-of-band by the synthetic selection fixture,
    // not inferred from a page's origin/order/visibility/title. No equivalent
    // token for the closed real session is claimed to exist.
    const token = name === 'frame-host' ? undefined : 'selected-a';
    const handles = {};
    for (const [field, selector] of Object.entries({ identity: '#readerChromeTitle', position: 'input[type="range"]', next: 'button[aria-label*="次"]' })) {
      handles[field] = await frame.locator(selector).count() === 1 ? await frame.locator(selector).elementHandle() : null;
    }
    const boundMainFrame = page.mainFrame();
    const isCurrent = async () => !page.isClosed() && !frame.isDetached() && page.mainFrame() === boundMainFrame
      && context.pages().includes(page) && await frame.evaluate(({ token, handles }) => {
        if (window.fixtureBinding !== token) return false;
        return Object.entries(handles).every(([field, node]) => !node || (node.isConnected
          && document.querySelector(field === 'identity' ? '#readerChromeTitle' : field === 'position' ? 'input[type="range"]' : 'button[aria-label*="次"]') === node));
      }, { token, handles });
    const preliminary = await frame.evaluate(inspectKindleDocument, { expectedOrigin: origin });
    if (name === 'clipped') {
      assert.equal(await frame.locator('#readerChromeTitle').isVisible(), true);
      assert.equal(preliminary.reason, expectedReason, 'Playwright可視だけでclipを許可しない');
    }
    if (name === 'frame-host') {
      assert.equal(preliminary.reason, expectedReason);
      const childFrame = await (await page.locator('#known-reader-frame').elementHandle()).contentFrame();
      assert.equal(await childFrame.locator('#readerChromeTitle').count(), 1, '既知fixture frame内に存在しても自動探索しない');
    }
    if (name === 'delayed-visible') await frame.evaluate(() => { setTimeout(() => { document.querySelector('#readerChromeTitle').style.visibility = ''; }, 120); });
    if (name === 'selection-changed') await frame.evaluate(() => { window.fixtureBinding = 'selected-b'; document.querySelector('#readerChromeTitle').textContent = '別の匿名本'; });
    if (name === 'node-replaced') await frame.locator('#readerChromeTitle').evaluate(node => node.replaceWith(node.cloneNode(true)));
    let probes = 0, reads = 0, value, reason;
    const inputBefore = summary.inspection.inputEvents;
    inspecting = true;
    try {
      value = await observeBoundKindle({ isCurrent,
        probe: () => { probes++; return frame.evaluate(inspectKindleDocument, { expectedOrigin: origin }); },
        read: () => { reads++; return frame.evaluate(inspectKindleDocument, { expectedOrigin: origin, metadata: true }); },
        deadlineMs: 450, intervalMs: 40 });
    } catch (error) { reason = error.reason; }
    finally { inspecting = false; }
    assert.equal(reason ?? null, expectedReason);
    assert.equal(reads, expectedReason ? 0 : 1);
    if (!expectedReason) assert.deepEqual(value, metadata);
    if (name === 'delayed-visible') assert.ok(probes > 1, '本人の再操作なしで同じbindingを待つ');
    assert.equal(summary.inspection.inputEvents, inputBefore);
    const titleReads = await frame.evaluate(() => window.titleReads ?? 0);
    assert.equal(titleReads, expectedReason ? 0 : 1, 'readinessは書名を読まずmetadataを一回だけ読む');
    summary.cases.push({ name, reason: reason ?? null, probes, metadataReads: reads, returnShapePreserved: !expectedReason,
      inputUnchanged: summary.inspection.inputEvents === inputBefore });
    for (const handle of Object.values(handles)) await handle?.dispose();
    await peer?.close(); await page.close();
  }
  assert.equal(summary.inspection.forbiddenCommand, false);
  phase = 'complete';
  summary.status = 'ok';
} catch {
  summary.failurePhase = phase; // fixed fixture name only; no raw exception
} finally {
  phase = 'join';
  if (context && browserChild && childEnd) {
    try {
      const cdp = await context.browser().newBrowserCDPSession();
      await cdp.send('Browser.close').catch(() => {});
      const ended = await childEnd;
      summary.normalExit = ended.code === 0 && ended.signal === null;
      summary.groupGone = summary.normalExit && await waitGroupGone(browserChild.pid);
      if (summary.groupGone) {
        await prepareLinuxLoginProfile(root, { create: false });
        assert.equal(await readFile(owned.marker, 'utf8'), markerBefore);
        const current = await lstat(owned.lock);
        assert.ok(['dev', 'ino', 'uid', 'mode'].every(key => current[key] === lockInfo[key]) && current.nlink === 1);
        await unlink(owned.lock);
        await assert.rejects(lstat(owned.lock), { code: 'ENOENT' });
        await assert.rejects(lstat(path.join(owned.profile, 'SingletonLock')), { code: 'ENOENT' });
        summary.lockReleased = true;
      }
    } catch { summary.status = 'failed'; summary.failurePhase = 'join'; }
  }
  if (server) await new Promise(resolve => server.close(resolve));
  if (!summary.normalExit || !summary.groupGone || !summary.lockReleased) summary.status = 'failed';
  childProcess.spawn = nativeSpawn; JSON.parse = nativeParse;
  await writeFile(output, JSON.stringify(summary) + '\n', { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ status: summary.status, phase: summary.failurePhase ?? 'complete' }));
  if (summary.status !== 'ok') process.exitCode = 1;
}
