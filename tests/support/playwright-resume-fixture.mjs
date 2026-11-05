// A fresh anonymous profile is selected, normally closed, then restored through
// the production entry. No authentication data or external site is accepted.
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdir, lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareLinuxLoginProfile, runLinuxLogin, snapLoginPreflight } from '../../app/linux-login-core.mjs';
import { closeOwnedInspectionBrowser } from '../../app/linux-inspect-resume-core.mjs';
import { expectedBook, otherAsin } from './expected-book-fixture.mjs';

const root = process.env.KTZ_PW_RESUME_ROOT, output = process.env.KTZ_PW_RESUME_OUTPUT, name = process.env.KTZ_PW_RESUME_CASE;
if (!root?.startsWith('/home/user/snap/chromium/common/ktz-playwright-inspect-test-088aa0b7/run-')
    || !output?.startsWith('/tmp/opencode/ktz-playwright-inspect-20261101-088aa0b7/run-')
    || !['single', 'delayed', 'multiple', 'marker-duplicate', 'frame', 'shadow', 'auth', 'nonkindle', 'document-change', 'node-change', 'same-document-book', 'delayed-book-change', 'delayed-node-change', 'unknown', 'locked',
      'hidden-chrome', 'hidden-blocked', 'hidden-auth', 'hidden-change', 'hidden-unchanged', 'position-clipped',
      'expected-match', 'expected-volume-mismatch', 'expected-title-mismatch', 'expected-redraw', 'expected-change',
      'expected-read-change', 'expected-document-change', 'expected-placeholder', 'expected-hidden', 'expected-clipped',
       'expected-unshared', 'expected-conflicting-asin', 'expected-unknown', 'expected-auth', 'expected-duplicate', 'expected-surface',
       'expected-route-change', 'expected-read-position-swap', 'expected-offscreen', 'expected-surface-clipped', 'expected-missing-config',
       'expected-nested-redraw', 'expected-nested-change', 'expected-read-character-change', 'expected-added-character-change',
       'expected-library-reader', 'expected-library-reader-slash', 'expected-library-query', 'expected-library-query-slash', 'expected-manga-slash'].includes(name)) throw new Error('anonymous_only');
process.umask(0o077);
const summary = { status: 'failed', name };
const home = path.join(root, 'home');
let server, peerServer, phase = 'setup', seedReady = 0, metadataReads = 0, inputEvents = 0, preparationEvents = 0, routeRequests = 0, invalidRouteRequest = false, resuming = false, restored = false;
let unscopedOldValueObservers = 0;
const inputDetails = [];
const isExpected = name.startsWith('expected-');
const title = `<span id="readerChromeTitle">${isExpected ? expectedBook.title : '匿名の保存済み本'}</span>`;
const reader = `<div style="width:640px;height:480px"><div><div><div><div>${title}</div></div></div></div>
  <input type="range" min="0" max="100" value="42"><button aria-label="次のページ">次</button><canvas width="600" height="300"></canvas></div>`;
const script = `<script>
  ${isExpected ? `const NativeObserver = window.MutationObserver;
    window.MutationObserver = class extends NativeObserver {
      observe(target, options) {
        if (options?.characterDataOldValue && !(target.nodeType === 1 && target.matches('#readerChromeTitle'))) fetch('/unscoped-old-value');
        return super.observe(target, options);
      }
    };` : ''}
  const bindTitle = () => { const t = document.querySelector('#readerChromeTitle'); if (!t) return;
    const get = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'innerText').get;
    Object.defineProperty(t, 'innerText', {get(){ fetch('/metadata-read');
       ${name === 'expected-read-change' ? "t.textContent='別の匿名本';t.textContent=" + JSON.stringify(expectedBook.title) + ';' : ''}
       ${name === 'expected-read-character-change' ? "t.firstChild.data='別の匿名本';t.firstChild.data=" + JSON.stringify(expectedBook.title) + ';' : ''}
      ${name === 'expected-read-position-swap' ? "document.querySelector('input[type=range]').remove();document.body.insertAdjacentHTML('beforeend','<input type=range value=19>');" : ''}
      return get.call(this); }}); };
  bindTitle(); for (const type of ['click','keydown','input','change','submit'])
    document.addEventListener(type, event => fetch('/input-event?kind='+type+'&trusted='+(event.isTrusted?'yes':'no')+'&range='+(event.target?.matches?.('input[type="range"]')?'yes':'no')), true);
  fetch('/seed-ready');
</script>`;
function pageHtml(pathname) {
  if (resuming && isExpected) {
    if (name === 'expected-auth') return `<!doctype html><input type="password" value="ANONYMOUS_PASSWORD">${script}`;
    if (name === 'expected-placeholder' && pathname === '/kindle-library') return `<!doctype html><div>匿名の本棚</div>${script}`;
    if (name === 'expected-title-mismatch') return `<!doctype html><style>body{margin:0}</style>${reader.replace(expectedBook.title, '匿名の保存済み本 第3巻')}${script}`;
    if (name === 'expected-duplicate') return `<!doctype html>${reader.replace(title, title + title)}${script}`;
    if (name === 'expected-surface') return `<!doctype html>${reader.replace('<canvas width="600" height="300"></canvas>', '')}${script}`;
    if (name === 'expected-surface-clipped') return `<!doctype html>${reader.replace('<canvas width="600" height="300"></canvas>', '<div style="width:0;height:0;overflow:hidden"><canvas width="600" height="300"></canvas></div>')}${script}`;
    if (name === 'expected-offscreen') return `<!doctype html><style>body{margin:0}button{position:absolute;left:5000px}</style>${reader}${script}`;
    if (name === 'expected-hidden') return `<!doctype html><style>body{margin:0}#readerChromeTitle{visibility:hidden}</style>${reader}${script}`;
    if (name === 'expected-clipped') return `<!doctype html><style>body{margin:0}</style>${reader.replace('<input type="range" min="0" max="100" value="42">',
      '<div style="width:8px;overflow:hidden"><input type="range" min="0" max="100" value="42"></div>')}${script}`;
    if (name === 'expected-unshared') return `<!doctype html><style>body{margin:0}</style>${reader.replace('<input type="range" min="0" max="100" value="42">', '')}<input type="range" min="0" max="100" value="42">${script}`;
    if (['expected-nested-redraw', 'expected-nested-change'].includes(name)) {
      const nested = reader.replace(title, '<span id="readerChromeTitle"><span>匿名の保存済み本 </span><span>第4巻</span></span>')
        .replace('<input type="range" min="0" max="100" value="42">', '');
      return `<!doctype html><style>body{margin:0}</style><div id="fixture">${nested}</div>${script}<script>
        setTimeout(() => {
          ${name === 'expected-nested-change' ? "document.querySelector('#readerChromeTitle span:last-child').firstChild.data='第3巻';" : ''}
          document.querySelector('#readerChromeTitle span:last-child').firstChild.data='第4巻';
          document.querySelector('#readerChromeTitle span:last-child').firstChild.replaceWith(document.createTextNode('第4巻'));
          document.querySelector('#fixture > div').insertAdjacentHTML('beforeend','<input type="range" min="0" max="100" value="42">');
        },1200)</script>`;
    }
    if (name === 'expected-added-character-change') return `<!doctype html><style>body{margin:0}</style><div id="fixture"></div>${script}<script>
      setTimeout(() => {
        document.querySelector('#fixture').innerHTML=${JSON.stringify(reader)};
        const t=document.querySelector('#readerChromeTitle');t.firstChild.data='別の匿名本';t.firstChild.data=${JSON.stringify(expectedBook.title)};bindTitle();
      },1200)</script>`;
    if (['expected-redraw', 'expected-change', 'expected-document-change', 'expected-route-change'].includes(name)) {
      const partial = reader.replace('<input type="range" min="0" max="100" value="42">', '');
      const action = name === 'expected-redraw' ? `document.querySelector('#fixture').innerHTML=${JSON.stringify(reader)};bindTitle()`
        : name === 'expected-document-change' ? `location.replace('/manga/${expectedBook.asin}?replacement=1')`
          : name === 'expected-route-change' ? `history.replaceState(null,'','/manga/${otherAsin}')`
          : `const t=document.querySelector('#readerChromeTitle');t.textContent='別の匿名本';t.textContent=${JSON.stringify(expectedBook.title)}`;
      return `<!doctype html><style>body{margin:0}</style><div id="fixture">${partial}</div>${script}<script>setTimeout(()=>{${action}},1200)</script>`;
    }
    return `<!doctype html><style>body{margin:0}</style>${reader}<p>ANONYMOUS_PRIVATE_BODY</p>${script}`;
  }
  if (!resuming || ['single', 'multiple', 'nonkindle', 'unknown', 'locked'].includes(name)) return `<!doctype html><style>body{margin:0}</style>${reader}<p>ANONYMOUS_PRIVATE_BODY</p>${script}`;
  if (name === 'auth') return `<!doctype html><input type="password" value="ANONYMOUS_PASSWORD">${script}`;
  if (name.startsWith('hidden-')) {
    const hiddenReader = reader.replace('<div style="width:640px;height:480px">', '<div id="known-region" class="hidden" style="width:640px;height:480px;position:relative">');
    return `<!doctype html><style>body{margin:0}#known-region canvas{position:absolute;inset:0;width:640px;height:480px}
      .hidden #readerChromeTitle,.hidden input,.hidden button{visibility:hidden}</style>${hiddenReader}
      ${name === 'hidden-auth' ? '<input type="password" value="ANONYMOUS_PASSWORD" style="position:absolute;top:30px">' : ''}
      ${name === 'hidden-blocked' ? '<button style="position:absolute;left:300px;top:0;width:50px;height:20px">操作しない</button>' : ''}
      <p>ANONYMOUS_PRIVATE_BODY</p>${script}<script>
      const region=document.querySelector('#known-region');
      for(const type of ['pointerover','pointermove','mouseover','mousemove']) region.addEventListener(type, event => {
        if(event.isTrusted)return;
        fetch('/prepare-event');
        if(type==='pointermove') {
          ${name === 'hidden-chrome' ? "region.classList.remove('hidden')" : name === 'hidden-change' ? "document.querySelector('#readerChromeTitle').textContent='別の匿名本'" : ''}
        }
      });</script>`;
  }
  if (name === 'frame') return `<!doctype html><iframe src="/frame-reader" width="900" height="700"></iframe>${script}`;
  if (name === 'shadow') return `<!doctype html><div id="host"></div>${script}
    <script>document.querySelector('#host').attachShadow({mode:'open'}).innerHTML=${JSON.stringify(reader)}</script>`;
  if (name === 'marker-duplicate') return `<!doctype html>${reader.replace(title, title + title)}${script}`;
  if (name === 'delayed') return `<!doctype html><style>body{margin:0}</style><div id="fixture"></div><p>ANONYMOUS_PRIVATE_BODY</p>${script}
    <script>setTimeout(() => {document.querySelector('#fixture').innerHTML=${JSON.stringify(reader)};bindTitle()}, 1200)</script>`;
  if (name === 'position-clipped') return `<!doctype html><style>body{margin:0}</style>${reader.replace('<input type="range" min="0" max="100" value="42">',
    '<div style="width:8px;overflow:hidden"><input type="range" min="0" max="100" value="42"></div>')}<p>ANONYMOUS_PRIVATE_BODY</p>${script}`;
  if (['delayed-book-change', 'delayed-node-change'].includes(name)) {
    // Start without markers, then add and change the first title in one task.
    // A polling-only binding sees only the final node and incorrectly succeeds.
    const change = name === 'delayed-book-change' ? "t.textContent='別の匿名本'" : 't.replaceWith(t.cloneNode(true))';
    return `<!doctype html><style>body{margin:0}</style><div id="fixture"></div><p>ANONYMOUS_PRIVATE_BODY</p>${script}
      <script>setTimeout(() => {document.querySelector('#fixture').innerHTML=${JSON.stringify(reader)};
        const t=document.querySelector('#readerChromeTitle');${change};bindTitle()}, 1200)</script>`;
  }
  const partial = reader.replace('<input type="range" min="0" max="100" value="42">', '');
  const action = name === 'document-change' ? "location.replace('/other')"
    : name === 'node-change' ? "const t=document.querySelector('#readerChromeTitle');t.replaceWith(t.cloneNode(true))"
      : "document.querySelector('#readerChromeTitle').textContent='別の匿名本';document.querySelector('#readerChromeTitle').textContent='匿名の保存済み本'";
  return `<!doctype html><style>body{margin:0}</style>${partial}<p>ANONYMOUS_PRIVATE_BODY</p>${script}<script>setTimeout(()=>{${action}},1200)</script>`;
}
const handler = (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1'), pathname = url.pathname;
  if (pathname === '/seed-ready') { if (!resuming) seedReady++; res.writeHead(204).end(); return; }
  if (pathname === '/metadata-read') { metadataReads++; res.writeHead(204).end(); return; }
  if (pathname === '/unscoped-old-value') { unscopedOldValueObservers++; res.writeHead(204).end(); return; }
  if (pathname === '/input-event') {
    inputEvents++;
    const kind = url.searchParams.get('kind'), trusted = url.searchParams.get('trusted'), range = url.searchParams.get('range');
    if (['click', 'keydown', 'input', 'change', 'submit'].includes(kind) && ['yes', 'no'].includes(trusted) && ['yes', 'no'].includes(range))
      inputDetails.push({ phase: resuming ? 'resume' : 'seed', kind, trusted, range });
    res.writeHead(204).end(); return;
  }
  if (pathname === '/prepare-event') { preparationEvents++; res.writeHead(204).end(); return; }
  if (pathname === '/favicon.ico') { res.writeHead(204).end(); return; }
  if (resuming && (pathname === '/selected' || pathname === '/ap/signin' || pathname === '/kindle-library' || pathname.startsWith('/kindle-library/') || pathname.startsWith('/manga/'))) restored = true;
  if (resuming && pathname === '/') {
    routeRequests++;
    if (url.searchParams.get('asin') !== expectedBook.asin || [...url.searchParams.keys()].join(',') !== 'asin') invalidRouteRequest = true;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    .end(pathname === '/frame-reader' || pathname === '/other' ? `<!doctype html>${reader}${script}` : pageHtml(pathname));
};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  assert.equal(await realpath(root), root);
  const realHome = userInfo().homedir, env = { ...process.env, HOME: realHome };
  for (const key of ['TMPDIR', 'TMP', 'TEMP', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'CHROME_LOG_FILE', 'CHROMIUM_FLAGS', 'DEBUG', 'PWDEBUG']) delete env[key];
  await snapLoginPreflight(realHome, env);
  await mkdir(path.join(home, 'snap/chromium/common/chromium'), { recursive: true, mode: 0o700 });
  if (isExpected && name !== 'expected-missing-config') {
    const directory = path.join(home, '.local/state/kindle-to-zip-inspection');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(path.join(directory, 'expected-book.json'), JSON.stringify(expectedBook) + '\n', { flag: 'wx', mode: 0o600 });
  }
  const owned = await prepareLinuxLoginProfile(path.join(home, 'snap/chromium/common/kindle-to-zip-login'));
  const marker = await readFile(owned.marker, 'utf8');
  server = http.createServer(handler); peerServer = http.createServer(handler);
  await Promise.all([new Promise(resolve => server.listen(0, '127.0.0.1', resolve)), new Promise(resolve => peerServer.listen(0, '127.0.0.1', resolve))]);
  const origin = `http://127.0.0.1:${server.address().port}`;
  const seedOrigin = name === 'nonkindle' ? `http://127.0.0.1:${peerServer.address().port}` : origin;
  phase = 'seed';
    const expectedPaths = {
      'expected-library-reader': `/kindle-library/manga-wr/${expectedBook.asin}`,
      'expected-library-reader-slash': `/kindle-library/manga-wr/${expectedBook.asin}/`,
      'expected-library-query': `/kindle-library?asin=${expectedBook.asin}`,
      'expected-library-query-slash': `/kindle-library/?asin=${expectedBook.asin}`,
      'expected-manga-slash': `/manga/${expectedBook.asin}/`,
    };
    const seedPath = expectedPaths[name] ?? (isExpected ? (name === 'expected-auth' ? '/ap/signin?anonymous' : name === 'expected-placeholder' ? '/kindle-library?anonymous'
      : `/manga/${name === 'expected-volume-mismatch' ? otherAsin : expectedBook.asin}?${name === 'expected-conflicting-asin' ? `asin=${otherAsin}&` : ''}anonymous=ANONYMOUS_URL_SECRET`)
    : `${name === 'auth' ? '/ap/signin' : '/selected'}?anonymous`);
  await runLinuxLogin({ root: owned.root, url: `${seedOrigin}${seedPath}`, preflight: () => snapLoginPreflight(realHome, env),
    requiredArgs: ['--remote-debugging-pipe'], requireExistingProfile: true, requireAbsentSingleton: true, joinUnconfirmedStart: true,
    launch(executable, args) {
      assert.equal(executable, '/snap/bin/chromium'); assert.ok(args.includes(`--user-data-dir=${owned.profile}`));
      const child = childProcess.spawn(executable, [...args.slice(0, -1), '--remote-debugging-pipe', args.at(-1)],
        { env, detached: true, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
      child.stdio[3].on('error', () => {}); child.stdio[4].on('error', () => {}); return child;
    },
    async onStarted(state) {
      for (let i = 0; i < 200 && seedReady < 1; i++) await pause(50);
      assert.ok(seedReady >= 1);
      if (name === 'multiple') {
        state.child.stdio[3].write(JSON.stringify({ id: 900001, method: 'Target.createTarget', params: { url: `${origin}/other?anonymous` } }) + '\0');
        for (let i = 0; i < 200 && seedReady < 2; i++) await pause(50);
        assert.ok(seedReady >= 2);
      }
      await closeOwnedInspectionBrowser({ ...state, onUnknown: () => { throw new Error('seed-close-unknown'); } });
    },
  });
  assert.equal(await readFile(owned.marker, 'utf8'), marker);
  await assert.rejects(lstat(owned.lock), { code: 'ENOENT' });
  if (name === 'locked') await writeFile(owned.lock, 'anonymous-foreign-lock\n', { flag: 'wx', mode: 0o600 });
  resuming = true; phase = 'resume';
  const trace = path.join(path.dirname(output), 'events.jsonl');
  const hook = new URL('./playwright-resume-hook.mjs', import.meta.url).href;
  const entry = fileURLToPath(new URL(isExpected ? '../../app/linux-playwright-expected.mjs' : '../../app/linux-playwright-resume.mjs', import.meta.url));
  const resumeStarted = performance.now();
  const child = childProcess.spawn(process.execPath, [entry], { cwd: fileURLToPath(new URL('../../', import.meta.url)),
    env: { ...env, NODE_OPTIONS: `--import=${hook}`, KTZ_PW_RESUME_HOME: home, KTZ_PW_RESUME_ORIGIN: origin,
      KTZ_PW_RESUME_TRACE: trace, KTZ_PW_RESUME_CASE: name }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  const ended = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
  summary.resumeElapsedMs = Math.round(performance.now() - resumeStarted);
  assert.equal(stderr, ''); assert.doesNotMatch(stdout, /ANONYMOUS_PRIVATE_BODY|ANONYMOUS_PASSWORD|ANONYMOUS_URL_SECRET|anonymous-foreign-lock|127\.0\.0\.1/);
  const value = JSON.parse(stdout);
  let events = [];
  try { events = (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  assert.ok(!events.some(event => event.forbidden || event.malformed || event.actualFlagsSafe === false));
  if (name === 'unknown' || name === 'expected-unknown') {
    assert.equal(value.shutdown, 'unknown'); assert.equal(value.owner.retained, true); assert.equal(value.owner.exited, false);
    assert.ok((await lstat(owned.lock)).isFile()); process.kill(value.owner.pid, 0);
    summary.unknownLockAndOwnerAlive = true;
    // The test's delayed *normal* close completes later; never kill the owner.
    for (let i = 0; i < 160; i++) {
      try { await lstat(owned.lock); } catch (error) { if (error.code === 'ENOENT') break; throw error; }
      await pause(50);
    }
    await assert.rejects(lstat(owned.lock), { code: 'ENOENT' });
  } else if (name === 'expected-missing-config') {
    assert.equal(value.shutdown, 'not-started'); assert.equal(value.reason, 'preflight-or-start');
    assert.equal(events.filter(event => event.launched).length, 0);
    await assert.rejects(lstat(owned.lock), { code: 'ENOENT' });
    await assert.rejects(lstat(path.join(owned.profile, 'SingletonLock')), { code: 'ENOENT' });
  } else if (name === 'locked') {
    assert.equal(await readFile(owned.lock, 'utf8'), 'anonymous-foreign-lock\n');
    assert.equal(events.filter(event => event.launched).length, 0); summary.foreignLockPreserved = true;
  } else {
    assert.equal(value.shutdown, 'normal'); assert.equal(value.lock, 'released');
    assert.equal(value.owner.exited, true); assert.equal(value.owner.retained, false);
    await assert.rejects(lstat(owned.lock), { code: 'ENOENT' });
    await assert.rejects(lstat(path.join(owned.profile, 'SingletonLock')), { code: 'ENOENT' });
  }
  assert.equal(await readFile(owned.marker, 'utf8'), marker);
  if (name !== 'locked' && name !== 'expected-missing-config') {
    assert.equal(events.filter(event => event.launched).length, 1);
    assert.equal(events.filter(event => event.closeRequested).length, 1);
    assert.ok(events.some(event => event.actualFlagsSafe === true));
  }
  summary.status = 'ok'; summary.actualExit = ended.code; summary.result = value; summary.restored = restored;
  summary.metadataReads = metadataReads; summary.metadataAttempts = events.filter(event => event.metadataAttempt).length;
  summary.preparationEvents = preparationEvents;
  summary.preparationAttempts = events.filter(event => event.preparationAttempt).length;
  summary.routeRequests = routeRequests;
  summary.invalidRouteRequest = invalidRouteRequest;
  summary.navigationAttempts = events.filter(event => event.navigationAttempt).length;
  summary.inputEvents = inputEvents; summary.inputDetails = inputDetails; summary.forbidden = events.some(event => event.forbidden);
  summary.unscopedOldValueObservers = unscopedOldValueObservers;
} catch { summary.failurePhase = phase; }
finally {
  if (server) await new Promise(resolve => server.close(resolve));
  if (peerServer) await new Promise(resolve => peerServer.close(resolve));
  await writeFile(output, JSON.stringify(summary) + '\n', { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ status: summary.status, phase: summary.failurePhase ?? 'complete' }));
  if (summary.status !== 'ok') process.exitCode = 1;
}
