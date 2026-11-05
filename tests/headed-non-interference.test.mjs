import './chromium-test-log-sink.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, readdir, mkdtemp, mkdir, lstat, rm } from 'node:fs/promises';
import path from 'node:path';
import { userInfo } from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { SampleProbe } from '../poc/browser/probe.mjs';
import { RustGuard, GuardedSample } from '../poc/browser/rust-guard.mjs';
import { readerContextOptions } from '../app/reader.mjs';
import { prepareLinuxLoginProfile, runLinuxLogin, snapLoginPreflight } from '../app/linux-login-core.mjs';
const { chromium } = await import('playwright');

if (process.platform === 'linux') test('Linux専用表示確認: 匿名Snapのtarget寿命と本人対象の曖昧さ', { timeout: 180_000 }, async t => {
  assert.ok(process.env.DISPLAY, '匿名Snapの有頭表示が必要');
  const home = userInfo().homedir;
  // The older anonymous-test parent may legitimately have been offloaded to a
  // symlink. Use a new canonical Snap-local parent; do not relax identity checks.
  const profileBase = path.join(home, 'snap/chromium/common/ktz-target-lifecycle-20261101-8f13e1b6/kindle-to-zip-inspect-tests');
  const traceBase = '/tmp/opencode/ktz-inspect-tests/lifecycle-20261101-8f13e1b6';
  for (const base of [profileBase, traceBase]) {
    await mkdir(base, { recursive: true, mode: 0o700 });
    const info = await lstat(base);
    assert.ok(info.isDirectory() && !info.isSymbolicLink() && info.uid === process.geteuid() && (info.mode & 0o7777) === 0o700);
  }
  const anonymous = await mkdtemp(path.join(profileBase, 'run-'));
  const anonymousIdentity = await lstat(anonymous);
  const traces = await mkdtemp(path.join(traceBase, 'run-'));
  const counts = { ready: 0, workerReady: 0, actions: 0, documents: 0 };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/ready') { counts.ready++; res.writeHead(204).end(); return; }
    if (url.pathname === '/worker-ready') { counts.workerReady++; res.writeHead(204).end(); return; }
    if (url.pathname === '/event') { counts.actions++; res.writeHead(204).end(); return; }
    if (url.pathname === '/favicon.ico') { res.writeHead(204).end(); return; }
    if (url.pathname === '/worker.js') {
      res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' })
        .end('self.addEventListener("install",event=>event.waitUntil(self.skipWaiting()));self.addEventListener("activate",event=>event.waitUntil(self.clients.claim()));');
      return;
    }
    counts.documents++;
    const reader = url.pathname === '/reader';
    const worker = url.searchParams.get('worker') === '1';
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(`<!doctype html><meta charset="utf-8">
      <title>FIXTURE_TARGET_TITLE</title><a id="fixture-open" href="/reader?fixture=FIXTURE_TARGET_QUERY" target="_blank" rel="noopener">匿名の本を開く</a>
      ${reader ? '<div style="width:640px;height:480px"><div><div><div><div><span id="readerChromeTitle">架空の本</span></div></div></div></div><input type="range" min="0" max="100" value="42"><button aria-label="次のページ">次</button><canvas width="600" height="300"></canvas></div>' : '<p>匿名の本棚相当</p>'}
      <p>FIXTURE_PRIVATE_BODY</p><script>
      for(const type of ['click','keydown','input','change','submit'])document.addEventListener(type,()=>fetch('/event'),true);
      fetch('/ready');
      ${worker ? "navigator.serviceWorker.register('/worker.js').then(()=>navigator.serviceWorker.ready).then(()=>fetch('/worker-ready'));" : ''}
      </script>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const entry = fileURLToPath(new URL('../app/linux-inspect.mjs', import.meta.url));
  const hook = new URL('./support/linux-inspect-fixture.mjs', import.meta.url).href;
  const env = { ...process.env, HOME: home, NODE_OPTIONS: `--import=${hook}` };
  for (const key of ['TMPDIR', 'TMP', 'TEMP', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'CHROME_LOG_FILE', 'CHROMIUM_FLAGS',
    'KTZ_INSPECT_TEST_EXTRA_PAGE', 'KTZ_INSPECT_TEST_CLOSE_DURING_CONFIRM']) delete env[key];
  const results = [];
  let closedCases = 0;
  // Remove only this new anonymous run, after every owned process closed and
  // every synthetic lock was absent. Never clean an unknown or real profile.
  t.after(async () => {
    if (closedCases !== 4) return;
    const current = await lstat(anonymous);
    assert.equal(current.dev, anonymousIdentity.dev); assert.equal(current.ino, anonymousIdentity.ino);
    assert.ok(current.isDirectory() && current.uid === process.geteuid() && (current.mode & 0o7777) === 0o700);
    await rm(anonymous, { recursive: true });
  });
  const waitFor = async predicate => {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (await predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.fail('匿名fixtureの段階が期限内に完了しなかった');
  };
  for (const [name, pathname, success] of [
    ['library-popup', '/kindle-library', false], ['opener-closed', '/kindle-library', true],
    ['two-readers', '/reader', false], ['single-worker', '/reader?worker=1', true],
  ]) await t.test(name, async st => {
    const caseHome = path.join(anonymous, name, 'home');
    await mkdir(path.join(caseHome, 'snap/chromium/common/chromium'), { recursive: true, mode: 0o700 });
    const owned = await prepareLinuxLoginProfile(path.join(caseHome, 'snap/chromium/common/kindle-to-zip-login'));
    const markerBefore = await readFile(owned.marker, 'utf8');
    const trace = path.join(traces, `${name}.jsonl`);
    const before = { ...counts };
    const child = spawn(process.execPath, [entry], { cwd: fileURLToPath(new URL('../', import.meta.url)),
      env: { ...env, KTZ_INSPECT_TEST_HOME: caseHome, KTZ_INSPECT_TEST_URL: `${origin}${pathname}`,
        KTZ_INSPECT_TEST_TRACE: trace, KTZ_INSPECT_TEST_LIFECYCLE: name }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const ended = new Promise((resolve, reject) => {
      child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal }));
    });
    let events = [];
    const refresh = async () => {
      try { events = (await readFile(trace, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    };
    st.after(async () => {
      child.stdin.end(); await ended; await refresh();
      if (!events.some(event => event.childClose?.code === 0 && event.childClose.signal === null)) return;
      await assert.rejects(lstat(owned.lock), { code: 'ENOENT' });
      await assert.rejects(lstat(path.join(owned.profile, 'SingletonLock')), { code: 'ENOENT' });
      assert.equal(await readFile(owned.marker, 'utf8'), markerBefore);
      closedCases++;
    });
    await waitFor(() => stdout.includes('確認ダイアログの') && counts.ready > before.ready
      && (name !== 'single-worker' || counts.workerReady > before.workerReady));
    child.stdin.write('prepare\n');
    await waitFor(async () => { await refresh(); return events.some(event => event.testOnly === 'lifecycle-ready'); });
    await waitFor(() => counts.ready >= before.ready + (name === 'single-worker' ? 1 : 2));
    assert.ok(!events.some(event => event.command), '匿名遷移の準備中は製品の問い合わせなし');
    const atConfirmation = { ...counts };
    child.stdin.end('confirm\n');
    assert.deepEqual(await ended, { code: success ? 0 : 1, signal: null }, stderr);
    await refresh();
    const snapshots = events.filter(event => event.lifecycle).map(event => event.lifecycle);
    assert.equal(snapshots[0].types.page, 1, '新規匿名profileは初期page一件');
    if (name === 'single-worker') assert.ok(snapshots[0].types.service_worker >= 1, '非pageの実targetが混在');
    else {
      assert.equal(snapshots[1].stage, 'opened'); assert.equal(snapshots[1].types.page, 2);
      assert.equal(snapshots[1].initialPresent, true, '元画面とpopupが併存');
    }
    if (name === 'opener-closed') {
      assert.equal(snapshots[2].stage, 'opener-closed'); assert.equal(snapshots[2].types.page, 1);
      assert.equal(snapshots[2].initialPresent, false, '匿名testの元画面だけを終了');
    }
    const commands = events.filter(event => event.command).map(event => event.command);
    if (!success) {
      assert.deepEqual(commands, ['Target.getTargets'], '複数候補ではattachもmetadata読取もtabcloseもしない');
      assert.doesNotMatch(stdout, /表示状態のみ|架空の本/);
      assert.deepEqual(JSON.parse(stderr.split('\n').find(line => line.startsWith('表示確認の診断: ')).slice('表示確認の診断: '.length)),
        { stage: 'target-selection', reason: 'multiple-page-targets' });
    } else {
      assert.deepEqual(commands, ['Target.getTargets', 'Target.attachToTarget', 'Page.createIsolatedWorld', 'Runtime.evaluate',
        'Runtime.evaluate', 'Target.getTargets', 'Target.detachFromTarget']);
      assert.equal(stderr, '');
      const value = JSON.parse(stdout.split('\n').find(line => line.startsWith('{"種別"')));
      assert.deepEqual(value, { 種別: '表示状態のみ', 書名: '架空の本', 位置: { value: 42, min: 0, max: 100 },
        領域: { width: 640, height: 480, visibleWidth: 640, visibleHeight: 480 } });
    }
    assert.equal(counts.documents, atConfirmation.documents, '製品の遷移・再読込みなし');
    assert.equal(counts.actions, atConfirmation.actions, '製品の入力操作なし');
    assert.ok(!events.some(event => event.unsafeTargetJsonParse || event.malformed));
    assert.doesNotMatch(stdout + stderr + JSON.stringify(events), /FIXTURE_PRIVATE_BODY|FIXTURE_TARGET_TITLE|FIXTURE_TARGET_QUERY/);
    results.push({ name, actualExit: success ? 0 : 1, snapshots, metadataCount: success ? 1 : 0, commands });
  });
  assert.equal(results.length, 4);
  await writeFile(path.join(traces, 'result.json'), JSON.stringify(results, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
});

if (process.platform === 'linux') test('Linux専用表示確認: 匿名Snapの実入口で一回だけ可視metadataを読み曖昧状態を拒否', { timeout: 180_000 }, async t => {
  assert.ok(process.env.DISPLAY, '実有頭表示が必要');
  const home = userInfo().homedir;
  const parent = path.join(home, 'snap/chromium/common/kindle-to-zip-inspect-tests');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await mkdir('/tmp/opencode/ktz-inspect-tests', { recursive: true, mode: 0o700 });
  const anonymous = await mkdtemp(path.join(parent, 'entry-'));
  const traces = await mkdtemp('/tmp/opencode/ktz-inspect-tests/entry-');
  const counts = { documents: 0, actions: 0 };
  let secondOrigin;
  const handler = (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/event') { counts.actions++; res.writeHead(204).end(); return; }
    if (url.pathname === '/favicon.ico') { res.writeHead(204).end(); return; }
    counts.documents++;
    const variant = url.searchParams.get('variant') ?? 'ok';
    if (variant === 'origin') {
      res.writeHead(302, { location: `${secondOrigin}/reader?variant=redirected&fixture=FIXTURE_TARGET_QUERY` }).end(); return;
    }
    const titleMarker = '<span id="readerChromeTitle">架空の本</span>';
    const title = variant === 'missing' ? '' : variant === 'wrapped' ? `<span>${titleMarker}</span>` : titleMarker;
    const duplicate = variant === 'duplicate' ? '<span id="readerChromeTitle">別の架空の本</span>' : '';
    const modal = variant === 'modal' ? '<div aria-modal="true" style="width:100px;height:50px">認証が必要な架空表示</div>' : '';
    const password = variant === 'password' ? '<input type="password" value="FIXTURE_PASSWORD">' : '';
    const clipping = variant === 'clipped' ? ' style="width:10px;overflow:hidden"' : '';
    const html = `<!doctype html><meta charset="utf-8"><title>FIXTURE_TARGET_TITLE &quot;quoted&quot; &#92; end</title>
      <div id="region" style="width:640px;height:480px"><div><div><div><div${clipping}>${title}${duplicate}</div></div></div></div>
      <input type="range" min="0" max="100" value="42"><button aria-label="次のページ">次</button>
      <canvas width="600" height="300"${variant === 'pixel' ? ' style="display:none"' : ''}></canvas>
      ${variant === 'pixel' ? '<img width="1" height="1" style="display:block;width:1px;height:1px" alt="">' : ''}</div>${modal}${password}
      <p>本文に見立てた非出力文字列 FIXTURE_PRIVATE_BODY</p>
      <script>
      for (const type of ['click','keydown','input','change','submit']) document.addEventListener(type, () => fetch('/event?type='+type), true);
      </script>`;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(html);
  };
  const server = http.createServer(handler), other = http.createServer(handler);
  await Promise.all([new Promise(resolve => server.listen(0, '127.0.0.1', resolve)), new Promise(resolve => other.listen(0, '127.0.0.1', resolve))]);
  t.after(async () => { await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => other.close(resolve))]); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  secondOrigin = `http://127.0.0.1:${other.address().port}`;
  const entry = fileURLToPath(new URL('../app/linux-inspect.mjs', import.meta.url));
  const hook = new URL('./support/linux-inspect-fixture.mjs', import.meta.url).href;
  const env = { ...process.env, HOME: home, NODE_OPTIONS: `--import=${hook}` };
  for (const key of ['TMPDIR', 'TMP', 'TEMP', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'CHROME_LOG_FILE', 'CHROMIUM_FLAGS']) delete env[key];
  const cases = [
    // The pre-existing Kindle preset counts DIV ancestors and requires a
    // visible surface of at least 16x16 CSS px (stores/kindle.mjs).
    ['ok', '/reader', true], ['wrapped', '/reader', true], ['pixel', '/reader', false],
    ['missing', '/reader', false], ['duplicate', '/reader', false],
    ['modal', '/reader', false], ['password', '/reader', false], ['clipped', '/reader', false], ['signin', '/ap/signin', false], ['library', '/kindle-library', false],
    ['origin', '/reader', false], ['targets', '/reader', false], ['cancel', '/reader', false], ['closed', '/reader', false],
  ];
  for (const [name, pathname, success] of cases) await t.test(name, async () => {
    const caseHome = path.join(anonymous, name, 'home');
    await mkdir(path.join(caseHome, 'snap/chromium/common/chromium'), { recursive: true, mode: 0o700 });
    const owned = await prepareLinuxLoginProfile(path.join(caseHome, 'snap/chromium/common/kindle-to-zip-login'));
    const markerBefore = await readFile(owned.marker, 'utf8');
    const trace = path.join(traces, `${name}.jsonl`);
    const documentsBefore = counts.documents;
    const child = spawn(process.execPath, [entry], { cwd: fileURLToPath(new URL('../', import.meta.url)),
      env: { ...env, KTZ_INSPECT_TEST_HOME: caseHome, KTZ_INSPECT_TEST_URL: `${origin}${pathname}?variant=${name}&fixture=FIXTURE_TARGET_QUERY`, KTZ_INSPECT_TEST_TRACE: trace,
        KTZ_INSPECT_TEST_EXTRA_PAGE: name === 'targets' ? '1' : '0', KTZ_INSPECT_TEST_CLOSE_DURING_CONFIRM: name === 'closed' ? '1' : '0' },
      stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', ready;
    const prompted = new Promise(resolve => { ready = resolve; });
    child.stdout.on('data', data => { stdout += data; if (stdout.includes('確認ダイアログの')) ready(); });
    child.stderr.on('data', data => { stderr += data; });
    const ended = new Promise((resolve, reject) => {
      child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal }));
    });
    await Promise.race([prompted, ended.then(result => { throw new Error(`prompt missing: ${JSON.stringify(result)} ${stderr}`); })]);
    for (let attempt = 0; attempt < 100 && counts.documents === documentsBefore; attempt++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(counts.documents > documentsBefore, '匿名試料のロードが必要');
    await new Promise(resolve => setTimeout(resolve, 300));
    let early = ''; try { early = await readFile(trace, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (name === 'targets') {
      for (let attempt = 0; attempt < 100 && !early.includes('extra-page-ready'); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 50));
        try { early = await readFile(trace, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      assert.match(early, /extra-page-ready/, '匿名ブラウザで二つ目のタブを用意');
    }
    assert.doesNotMatch(early, /"command"/, '本人の確認前には対象情報を問い合わせない');
    assert.match(early, /confirmationDialogOpened/, '固定の確認ダイアログ入口を通る');
    const before = { ...counts };
    if (name === 'cancel') child.stdin.end();
    else if (name === 'closed') child.stdin.end('\n'); // finish the test-only close signal transport
    else child.stdin.write('\n');
    const outcome = await ended;
    assert.deepEqual(outcome, { code: success ? 0 : 1, signal: null }, stderr);
    const events = (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const commands = events.filter(event => event.command).map(event => event.command);
    const permitted = new Set(['Target.getTargets', 'Target.attachToTarget', 'Page.createIsolatedWorld', 'Runtime.evaluate', 'Target.detachFromTarget']);
    assert.ok(commands.every(command => permitted.has(command)), commands.join(','));
    assert.equal(commands.filter(command => command === 'Target.getTargets').length, ['cancel', 'closed'].includes(name) ? 0 : success ? 2 : 1);
    assert.ok(events.some(event => event.testOnly === 'graceful-browser-close'));
    assert.ok(events.some(event => event.confirmationDialogClosed), '確認ダイアログ自身の終了もjoin');
    assert.ok(events.some(event => event.notificationDialogOpened) && events.some(event => event.notificationDialogClosed), '固定の終了案内も表示してjoin');
    if (name === 'closed') assert.ok(events.some(event => event.confirmationDialogClosed?.signal === 'SIGTERM'), 'browser通常終了時は所有した確認ダイアログだけを閉じる');
    assert.ok(!events.some(event => event.unsafeTargetJsonParse), '選択外を含むtargetのURL・titleをJSON parseしない');
    if (!['cancel', 'closed'].includes(name)) assert.ok(events.some(event => event.testOnly === 'target-sentinel-present'), '匿名target応答に試験用URL・titleが実在');
    assert.ok(events.some(event => event.childClose?.code === 0 && event.childClose.signal === null), '所有Snapの終了をjoin');
    if (name === 'targets') assert.equal(events.find(event => 'pageCount' in event)?.pageCount, 2, '複数ページの実拒否');
    assert.equal(counts.actions, before.actions, 'アプリによる操作・変更イベントなし');
    assert.equal(counts.documents, before.documents, '確認による遷移・再読込なし');
    assert.doesNotMatch(stdout + stderr, /FIXTURE_PRIVATE_BODY|FIXTURE_PASSWORD|FIXTURE_TARGET_TITLE|FIXTURE_TARGET_QUERY|認証が必要な架空表示|別の架空の本/);
    const profile = path.join(caseHome, 'snap/chromium/common/kindle-to-zip-login/owned/profile');
    assert.ok((await lstat(profile)).isDirectory());
    await assert.rejects(lstat(path.join(path.dirname(profile), 'in-use.lock')), { code: 'ENOENT' });
    assert.equal(await readFile(owned.marker, 'utf8'), markerBefore, '既存の匿名所有情報を再利用');
    assert.deepEqual(await readdir(path.join(anonymous, name)), ['home'], 'profile以外に画像や出力ファイルを作成しない');
    if (success) {
      assert.deepEqual(commands, ['Target.getTargets', 'Target.attachToTarget', 'Page.createIsolatedWorld', 'Runtime.evaluate', 'Runtime.evaluate', 'Target.getTargets', 'Target.detachFromTarget']);
      assert.deepEqual(events.filter(event => event.evaluation).map(event => event.evaluation), ['metadata', 'context-only'], 'metadataは一回だけ読む');
      assert.ok(events.some(event => event.resultAfterChildClose === true), '終了確認前にはmetadataを出力しない');
      assert.ok(events.findIndex(event => event.notificationDialogClosed) < events.findIndex(event => event.resultAfterChildClose), '案内ダイアログの終了前にもmetadataを出力しない');
      const line = stdout.split('\n').find(value => value.startsWith('{'));
      assert.deepEqual(JSON.parse(line), { 種別: '表示状態のみ', 書名: '架空の本', 位置: { value: 42, min: 0, max: 100 }, 領域: { width: 640, height: 480, visibleWidth: 640, visibleHeight: 480 } });
    } else assert.doesNotMatch(stdout, /表示状態のみ|架空の本/);
  });
});

async function loginProbes(home) {
  const root = path.join(home, 'snap/chromium/common/kindle-to-zip-login');
  const probes = path.join(root, 'probes');
  for (const directory of [root, probes]) {
    try { await mkdir(directory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = await lstat(directory);
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.geteuid() && (stat.mode & 0o7777) === 0o700);
  }
  return probes;
}

if (process.platform === 'linux') test('Linux専用ログイン: 匿名有頭Snapの暗号backend・再起動・独立Reader相当の保持', { timeout: 100_000 }, async t => {
  assert.ok(process.env.DISPLAY, '実有頭表示が必要');
  const home = userInfo().homedir;
  const root = await mkdtemp(path.join(await loginProbes(home), 'headed-'));
  // The shared test sink isolates HOME for other tests; restore the real session
  // only in the anonymous Snap children, without changing this process's HOME.
  const env = { ...process.env, HOME: home };
  for (const key of ['TMPDIR', 'TMP', 'TEMP', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'CHROME_LOG_FILE', 'CHROMIUM_FLAGS']) delete env[key];
  const server = http.createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<!doctype html><html lang="ja"><meta charset="utf-8"><title>匿名試料</title><style>body{font-family:sans-serif;margin:48px;color:#203047}p{font-size:20px}</style><h1>KindleToZip 匿名保存試料</h1><p>これはローカルの自作テスト画面です。</p></html>'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let readyResolve; const ready = new Promise(resolve => { readyResolve = resolve; });
  const launch = (exe, args) => spawn(exe, [...args.slice(0, -1), '--disable-background-networking', '--remote-debugging-port=0', args.at(-1)],
    { env, detached: true, stdio: 'ignore' });
  const run = () => runLinuxLogin({ root, url: 'about:blank', preflight: () => snapLoginPreflight(home, env), launch, onStarted: readyResolve });
  const outcome = run().then(() => ({ ok: true }), error => ({ error }));
  const started = await Promise.race([ready, outcome.then(result => { throw result.error ?? new Error('browser_exited_before_test'); })]);
  const profile = started.profile;
  await assert.rejects(run(), { code: 'login_in_use_or_unknown' });
  let port;
  for (let n = 0; n < 200; n++) {
    try { port = Number((await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); if (port) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(port, '匿名試料ブラウザの検査口が必要');
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  t.after(async () => {
    if (browser.isConnected()) {
      try { const session = await browser.newBrowserCDPSession(); await session.send('Browser.close'); } catch {}
    }
  });
  const context = browser.contexts()[0];
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto(origin);
  const screenshotDirectory = fileURLToPath(new URL('../artifacts/kindle-login/', import.meta.url));
  await mkdir(screenshotDirectory, { recursive: true, mode: 0o700 });
  await page.screenshot({ path: path.join(screenshotDirectory, 'anonymous-browser.png') });
  await page.evaluate(() => localStorage.setItem('ktz-fixture', 'anonymous-only'));
  await context.addCookies([{ name: 'ktz_anonymous', value: 'fixture-only', url: origin, expires: Math.floor(Date.now() / 1000) + 86400 }]);
  const cdp = await browser.newBrowserCDPSession();
  await cdp.send('Browser.close').catch(() => {});
  const firstResult = await outcome;
  assert.equal(firstResult.ok, true, firstResult.error?.code);
  // Read only the synthetic cookie's representation, not its contents. v11 is
  // Chromium Linux's keyring-backed encrypted value, unlike the basic v10 store.
  const python = `import sqlite3,sys\nc=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)\nr=c.execute("select length(value),hex(substr(encrypted_value,1,3)),length(encrypted_value) from cookies where name=?",('ktz_anonymous',)).fetchone()\nprint(*r)\n`;
  const representation = execFileSync('python3', ['-c', python, path.join(profile, 'Default', 'Cookies')], { encoding: 'utf8' }).trim().split(' ');
  assert.equal(representation[0], '0', '匿名cookieを平文欄に保存しない');
  assert.equal(representation[1], '763131', '実際の暗号化backendはv11');
  assert.ok(Number(representation[2]) > 3);
  // Independent Reader-like launch uses the same real Snap, profile and normal
  // keyring, not Playwright's default basic store or its no-sandbox switch.
  const reader = await chromium.launchPersistentContext(profile, { ...readerContextOptions({ headless: false }), env,
    executablePath: '/snap/bin/chromium', chromiumSandbox: true, ignoreDefaultArgs: ['--password-store=basic', '--use-mock-keychain'] });
  try {
    await reader.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const readerPage = reader.pages()[0] ?? await reader.newPage(); await readerPage.goto(origin);
    assert.equal(await readerPage.evaluate(() => localStorage.getItem('ktz-fixture')), 'anonymous-only');
    assert.ok((await reader.cookies(origin)).some(cookie => cookie.name === 'ktz_anonymous' && cookie.value === 'fixture-only'));
  } finally { await reader.close(); }
});

if (process.platform === 'linux') test('Linux専用ログイン: 実デスクトップ起動機構と固定先を匿名profileで2回確認', { timeout: 100_000 }, async t => {
  const home = userInfo().homedir;
  const fixture = await mkdtemp(path.join(await loginProbes(home), 'desktop-'));
  // On a failing test, close only the browser with this fixture's exact owned
  // PID/profile and CDP port; never delete its profile or an unknown lock.
  t.after(async () => {
    for (const run of ['first', 'second']) {
      try {
        const { pid } = JSON.parse(await readFile(path.join(fixture, `${run}-spawn.json`), 'utf8'));
        const { profile } = JSON.parse(await readFile(path.join(fixture, `${run}-target.json`), 'utf8'));
        assert.ok(profile.startsWith(`${fixture}/home/`));
        const proc = await lstat(`/proc/${pid}`);
        assert.equal(proc.uid, process.geteuid());
        const command = (await readFile(`/proc/${pid}/cmdline`)).toString();
        assert.ok(command.includes(`--user-data-dir=${profile}`));
        const port = Number((await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
        const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 2000 });
        const session = await browser.newBrowserCDPSession(); await session.send('Browser.close').catch(() => {});
      } catch { /* Missing, already exited, or ownership not proven: do not signal. */ }
    }
  });
  const fakeCommon = path.join(fixture, 'home/snap/chromium/common');
  await mkdir(path.join(fakeCommon, 'chromium'), { recursive: true, mode: 0o700 });
  const desktop = path.join(home, 'デスクトップ/KindleToZip-ログイン.desktop');
  const desktopText = await readFile(desktop, 'utf8');
  const project = fileURLToPath(new URL('../', import.meta.url));
  assert.ok(desktopText.includes(`Exec="/home/user/.local/bin/node" "${project}app/linux-login.mjs"`));
  assert.ok(desktopText.includes(`Path=${project.slice(0, -1)}`));
  assert.ok(desktopText.includes('Icon=/snap/chromium/current/chromium.png'));
  const hook = new URL('./support/linux-login-desktop-hook.mjs', import.meta.url).href;
  const env = { ...process.env, HOME: home, KTZ_GIO_FIXTURE: fixture, NODE_OPTIONS: `--import=${hook}` };
  for (const key of ['TMPDIR', 'TMP', 'TEMP', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'CHROME_LOG_FILE', 'CHROMIUM_FLAGS']) delete env[key];
  env.CHROMIUM_FLAGS = '--no-sandbox --password-store=basic'; // The real entry must not pass these through.
  let selectedProfile;
  for (const run of ['first', 'second']) {
    const launcher = spawn('/usr/bin/gio', ['launch', desktop], { env: { ...env, KTZ_GIO_RUN: run }, stdio: 'ignore' });
    const launcherResult = await new Promise((resolve, reject) => {
      launcher.once('error', reject); launcher.once('close', (code, signal) => resolve({ code, signal }));
    });
    assert.deepEqual(launcherResult, { code: 0, signal: null });
    let receipt;
    for (let n = 0; n < 400; n++) {
      try { receipt = JSON.parse(await readFile(path.join(fixture, `${run}-exit.json`), 'utf8')); break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.deepEqual(receipt, { code: 0 }, 'GIOからの実entry終了まで確認');
    const target = JSON.parse(await readFile(path.join(fixture, `${run}-target.json`), 'utf8'));
    assert.equal(target.target, 'https://read.amazon.co.jp/');
    assert.equal(target.flagsCleared, true, 'Snap wrapperへの任意フラグ注入を除去');
    assert.ok(target.profile.startsWith(`${fixture}/home/`), '本人用でなく匿名profileだけを利用');
    if (selectedProfile) assert.equal(target.profile, selectedProfile);
    selectedProfile = target.profile;
    assert.equal(JSON.parse(await readFile(path.join(fixture, `${run}-fixture.json`), 'utf8')).retained, run === 'second');
    await assert.rejects(lstat(path.join(path.dirname(selectedProfile), 'in-use.lock')), { code: 'ENOENT' });
  }
});

async function browserPid(browser) {
  const session = await browser.newBrowserCDPSession();
  try {
    const result = await session.send('SystemInfo.getProcessInfo');
    return result.processInfo.find(process => process.type === 'browser').id;
  } finally { await session.detach(); }
}

function sanitized(observation) {
  return Object.fromEntries(Object.entries(observation).filter(([key]) => !['initial', 'last'].includes(key)));
}

function assertNoInterference(observation) {
  assert.ok(observation.samples > 1);
  assert.equal(observation.missing_foreground_samples, 0, '前景を観測できない状態は合格にしない');
  assert.equal(observation.missing_cursor_samples, 0, 'カーソルを観測できない状態は合格にしない');
  assert.equal(observation.foreground_changes, 0, '測定中に前景変化を観測した');
  assert.equal(observation.cursor_changes, 0, '測定中にカーソル変化を観測した');
}

test('通常表示・覆った状態でRustと結合し、撮影と送りを別々に受動観測', { timeout: 90000 }, async t => {
  const guard = new RustGuard();
  t.after(() => guard.close());
  const sample = await SampleProbe.open({ headless: false });
  t.after(() => sample.close());
  const targetPid = await browserPid(sample.browser);
  const { window: target } = await guard.request({ kind: 'window_for_process', pid: targetPid });
  assert.ok(target && !target.minimized, '通常表示の試料ウィンドウが必要');
  const bridge = new GuardedSample(sample, guard);
  bridge.requireVisibleWindow(targetPid);
  await bridge.approveAndStart();

  // A second, owned visible browser provides a harmless cover window. No
  // bringToFront/OS input/focus APIs are used, including during setup.
  const coverBrowser = await chromium.launch({ headless: false, args: ['--window-position=20,20', '--window-size=1200,950'] });
  t.after(() => coverBrowser.close());
  const coverContext = await coverBrowser.newContext({ viewport: { width: 1100, height: 850 }, serviceWorkers: 'block', acceptDownloads: false });
  await coverContext.route('**/*', route => route.abort('blockedbyclient'));
  const coverPage = await coverContext.newPage();
  await coverPage.setContent('<!doctype html><html lang="ja"><meta charset="utf-8"><title>G02 自作の覆い試料</title><h1>別ウィンドウの自作入力試料</h1><textarea id="dummy"></textarea><button id="counter">試験</button><output id="count">0</output></html>');
  await coverPage.locator('#counter').evaluate(element => element.addEventListener('click', () => {
    const counter = document.querySelector('#count'); counter.textContent = String(Number(counter.textContent) + 1);
  }));
  const coverPid = await browserPid(coverBrowser);
  const { window: cover } = await guard.request({ kind: 'window_for_process', pid: coverPid });
  assert.ok(cover && !cover.minimized);
  const covered = cover.rect[0] <= target.rect[0] && cover.rect[1] <= target.rect[1]
    && cover.rect[2] >= target.rect[2] && cover.rect[3] >= target.rect[3];
  assert.ok(covered, `覆いの範囲不足 target=${target.rect} cover=${cover.rect}`);
  assert.equal((await guard.request({ kind: 'window_above', higher: cover.handle, lower: target.handle })).above, true,
    '実際のZ順で試料が覆われていない状態は合格にしない');
  // Browser opening is setup, not part of the non-interference measurement.
  await new Promise(resolve => setTimeout(resolve, 300));
  const captures = [];
  const advances = [];
  const positions = [];
  try {
    for (let i = 1; i <= 12; i += 1) {
      const initial = (await guard.request({ kind: 'snapshot' })).snapshot;
      assert.notEqual(initial.foreground, target.handle, '対象が前景のままでは背景検証にならない');
      await guard.request({ kind: 'observe_start' });
      const image = await bridge.capture();
      const captureObservation = (await guard.request({ kind: 'observe_stop' })).observation;
      captures.push(sanitized(captureObservation));
      assertNoInterference(captureObservation);
      assert.equal((await sample.read()).position, i, '撮影がページ位置を変えていない');
      positions.push(image.position);

      // Scoped DOM input into an owned dummy window, not physical OS input.
      // It cannot stand in for a human typing into an unrelated application.
      await coverPage.locator('#dummy').fill(`sample-${i}`);
      await coverPage.locator('#counter').click();
      const imagesBefore = sample.images.length;
      await guard.request({ kind: 'observe_start' });
      const result = await bridge.advance();
      const advanceObservation = (await guard.request({ kind: 'observe_stop' })).observation;
      advances.push(sanitized(advanceObservation));
      assertNoInterference(advanceObservation);
      assert.equal(sample.images.length, imagesBefore, '送りは撮影・保存しない');
      assert.equal(await coverPage.locator('#dummy').inputValue(), `sample-${i}`);
      assert.equal(await coverPage.locator('#count').textContent(), String(i));
      if (i < 12) assert.equal(result.position, i + 1);
      else assert.equal(result.endCandidate, true);
    }
    assert.deepEqual(positions, Array.from({ length: 12 }, (_, i) => i + 1));
    assert.equal(sample.state, 'NeedsAttention');
    assert.equal((await guard.request({ kind: 'state' })).state, 'NeedsAttention');
  } finally {
    // No HWND, PID, cursor coordinate, title or input content in the receipt.
    await writeFile(path.join(sample.directory, 'headed-receipt.json'), JSON.stringify({
      schemaVersion: 1, scope: 'self-authored-headed-only', browser: sample.browser.version(),
      rustNodeConnected: true, covered, captures, advances, positions,
      state: sample.state, reason: sample.reason,
      physicalHumanInput: 'not-tested', minimizeLockSleep: 'not-tested', kindle: 'not-tested',
      samplesArePeriodicNotEventComplete: true,
    }, null, 2) + '\n', { flag: 'wx' });
  }
});

test('通常表示：最小化で新規撮影・送りを止め、確定済み画像を保護', { timeout: 30000 }, async t => {
  const guard = new RustGuard();
  t.after(() => guard.close());
  const sample = await SampleProbe.open({ headless: false });
  t.after(() => sample.close());
  const pid = await browserPid(sample.browser);
  const bridge = new GuardedSample(sample, guard);
  bridge.requireVisibleWindow(pid);
  await bridge.approveAndStart();
  const first = await bridge.capture();
  const original = await readFile(path.join(sample.directory, first.file));
  const session = await sample.context.newCDPSession(sample.page);
  t.after(() => session.detach().catch(() => {}));
  const { windowId } = await session.send('Browser.getWindowForTarget');
  await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
  let window;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    ({ window } = await guard.request({ kind: 'window_for_process', pid }));
    if (window?.minimized) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(window?.minimized, true, '対象の専用ウィンドウだけを最小化したことが必要');
  await assert.rejects(bridge.capture(), error => error.code === 'window_not_available');
  await assert.rejects(bridge.advance());
  assert.equal(sample.captureRequests, 1);
  assert.equal(sample.advanceRequests, 0);
  assert.equal(sample.state, 'NeedsAttention');
  assert.equal((await guard.request({ kind: 'state' })).state, 'NeedsAttention');
  assert.deepEqual(await readFile(path.join(sample.directory, first.file)), original);
  assert.deepEqual(await readdir(sample.directory), [first.file]);
});

test('Rust結合経路：撮影中の停止を2秒以内に反映して未確定画像を保存しない', { timeout: 30000 }, async t => {
  const guard = new RustGuard();
  t.after(() => guard.close());
  const sample = await SampleProbe.open({ headless: false });
  t.after(() => sample.close());
  const bridge = new GuardedSample(sample, guard);
  bridge.requireVisibleWindow(await browserPid(sample.browser));
  await bridge.approveAndStart();
  const screenshot = sample.page.screenshot.bind(sample.page);
  let stoppedAt;
  sample.page.screenshot = async options => {
    stoppedAt = performance.now();
    await bridge.stop();
    return screenshot(options);
  };
  await assert.rejects(bridge.capture(), error => error.code === 'cancelled');
  assert.ok(performance.now() - stoppedAt < 2000);
  assert.equal(sample.state, 'Review');
  assert.equal((await guard.request({ kind: 'state' })).state, 'Review');
  assert.deepEqual(await readdir(sample.directory), []);
});
