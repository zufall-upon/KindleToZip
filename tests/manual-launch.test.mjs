import './chromium-test-log-sink.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { openKindleForUser } from '../app/startup.mjs';
import { configureReaderNetwork, readerContextOptions } from '../app/reader.mjs';
import { controllerPath } from '../app/controller-path.mjs';
import { StoreClient } from '../app/store-client.mjs';
import { RustGuard, guardExecutable } from '../poc/browser/rust-guard.mjs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, rm, readdir, lstat } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { existsSync } from 'node:fs';
import { linuxStartupMessage } from '../app/startup-error.mjs';
import { chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { PNG } from 'pngjs';
const { chromium } = await import('playwright');

if (process.platform === 'linux') test('Linux起動診断: 公開npm startの不在・権限・排他・画面失敗を誤成功にしない', { timeout: 60_000 }, async t => {
  const project = fileURLToPath(new URL('../', import.meta.url));
  const fixture = await mkdtemp(path.join(tmpdir(), 'ktz-start-errors-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const run = (extra = {}) => spawnSync('npm', ['--prefix', project, 'start'], { cwd: fixture, encoding: 'utf8', timeout: 15_000,
    env: { ...process.env, KTZ_USER_DATA_DIR: path.join(fixture, 'data'), KTZ_TEMP_DIR: fixture, ...extra } });
  const failed = (result, message) => {
    assert.equal(result.status, 1, `${result.stdout} ${result.stderr}`);
    assert.match(result.stderr, message);
    assert.doesNotMatch(result.stdout, /MVPを起動しました|操作画面を.*開きました/);
  };
  failed(run({ KTZ_CONTROLLER_PATH: path.join(fixture, 'missing') }), /実行可能なRust controller/);
  await assert.rejects(lstat(path.join(fixture, 'data')), { code: 'ENOENT' });
  const unsafe = path.join(fixture, 'unsafe'); await mkdir(unsafe); await chmod(unsafe, 0o755);
  failed(run({ KTZ_TEMP_DIR: unsafe }), /専用領域の権限・所有者・種類/);
  assert.equal((await lstat(unsafe)).mode & 0o7777, 0o755, '既存の不正権限を修復しない');
  const { startApplication } = await import('../app/server.mjs');
  const primary = await startApplication({ dataDir: path.join(fixture, 'data') });
  try {
    failed(run(), /別の起動が使用中/);
    assert.equal((await primary.app.snapshot()).state, 'Idle', '先行起動の排他と状態を維持');
  } finally { await primary.close(); }
  failed(run({ DISPLAY: '', WAYLAND_DISPLAY: '' }), /操作画面用Chromiumの起動または読込み/);
  const wrapped = new Error('opaque', { cause: Object.assign(new Error(), { code: 'file_permissions_invalid' }) });
  assert.match(linuxStartupMessage(wrapped, 'storage'), /権限・所有者・種類/);
  assert.match(linuxStartupMessage(new Error('a long TMPDIR is not proof'), 'storage'), /原因は特定できていません/);
  assert.deepEqual((await readdir(fixture)).sort(), ['data', 'unsafe'], '所有一時領域を回収し、保存領域は残す');
});

test('controller解決: 明示指定とOS既定を共用し、起動時に不在を拒否する', async () => {
  assert.match(controllerPath({ platform: 'win32', env: {} }), /ktz-g02-controller\.exe$/);
  assert.match(controllerPath({ platform: 'linux', env: {} }), /ktz-g02-controller$/);
  const previous = process.env.KTZ_CONTROLLER_PATH;
  try {
    process.env.KTZ_CONTROLLER_PATH = guardExecutable;
    const store = new StoreClient();
    process.env.KTZ_CONTROLLER_PATH = path.join(path.dirname(guardExecutable), 'missing-controller-for-regression');
    try {
      assert.equal((await store.call('state')).state, 'Preview', '既存childは作成時の設定を保持する');
      assert.throws(() => new StoreClient(), { code: 'controller_not_found' });
      assert.throws(() => new RustGuard(), { code: 'controller_not_found' });
    } finally { await store.close(); }
    process.env.KTZ_CONTROLLER_PATH = guardExecutable;
    const guard = new RustGuard();
    try { assert.equal((await guard.request({ kind: 'state' })).state, 'Preview'); }
    finally { await guard.close(); }
  } finally {
    if (previous === undefined) delete process.env.KTZ_CONTROLLER_PATH; else process.env.KTZ_CONTROLLER_PATH = previous;
  }
});

if (process.platform === 'linux') test('Linux公開npm start: 実headed画面の操作と画面閉鎖・Ctrl+Cで所有資源を回収', { timeout: 90_000 }, async t => {
  assert.ok(process.env.DISPLAY, 'headed検査には明示的なX displayが必要');
  const project = fileURLToPath(new URL('../', import.meta.url));
  const socketRoot = await mkdtemp(path.join(existsSync('/tmp/opencode') ? '/tmp/opencode' : '/tmp', 'ktz-public-'));
  t.after(() => rm(socketRoot, { recursive: true, force: true }));
  const screenshot = fileURLToPath(new URL('../artifacts/linux-port/public-start.png', import.meta.url));
  const hook = new URL('./support/public-start-hook.mjs', import.meta.url).href;
  for (const mode of ['window', 'sigint']) await t.test(mode, async () => {
    const fixture = await mkdtemp(path.join(socketRoot, `${mode}-`));
    const temp = path.join(fixture, 't'); await mkdir(temp, { mode: 0o700 });
    const socketPath = path.join(fixture, 's');
    const server = net.createServer();
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    const connected = new Promise(resolve => server.once('connection', resolve));
    const env = { ...process.env, KTZ_USER_DATA_DIR: path.join(fixture, 'data'), KTZ_TEMP_DIR: temp,
      KTZ_PUBLIC_TEST_SOCKET: socketPath, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${hook}` };
    // The SIGINT case uses a real pseudo-terminal: byte 0x03 is Ctrl+C,
    // delivered by the terminal to its foreground process group.
    const quotedProject = `'${project.replaceAll("'", "'\\''")}'`;
    const executable = mode === 'sigint' ? 'script' : 'npm';
    const args = mode === 'sigint' ? ['-q', '-e', '-c', `npm --prefix ${quotedProject} start`, '/dev/null'] : ['--prefix', project, 'start'];
    const child = spawn(executable, args, { cwd: fixture, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', text => { output += text; }); child.stderr.on('data', text => { output += text; });
    const exited = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
    let socket;
    const deadline = ms => new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error(`public_start_timeout: ${output}`)), ms); timer.unref(); });
    try {
      socket = await Promise.race([connected, deadline(25_000)]);
      let buffer = ''; const events = []; const waiters = [];
      socket.on('data', chunk => {
        buffer += chunk; let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const value = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
          const waiter = waiters.shift(); if (waiter) waiter(value); else events.push(value);
        }
      });
      const receive = () => events.length ? Promise.resolve(events.shift()) : new Promise(resolve => waiters.push(resolve));
      const ready = await Promise.race([receive(), deadline(25_000)]);
      assert.equal(ready.event, 'ready', JSON.stringify(ready));
      assert.match(ready.title, /KindleToZip/);
      socket.write(`${JSON.stringify({ action: 'exercise', ...(mode === 'window' ? { screenshot } : {}) })}\n`);
      const exercised = await Promise.race([receive(), deadline(25_000)]);
      assert.equal(exercised.event, 'exercised', JSON.stringify(exercised));
      assert.equal(exercised.kindleDisabled, true);
      assert.match(exercised.notice, /Linux.*未対応/);
      assert.equal((await lstat(path.join(fixture, 'data'))).mode & 0o7777, 0o700);
      const owned = (await readdir(temp)).map(name => path.join(temp, name));
      assert.equal(owned.length, 1);
      assert.equal((await lstat(owned[0])).mode & 0o7777, 0o700);
      const processes = spawnSync('ps', ['-eo', 'pid=,ppid=,args='], { encoding: 'utf8' }).stdout.split('\n')
        .map(line => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)).filter(Boolean);
      // Playwright starts Chromium in its own process group: ancestry, not
      // npm's group id, determines which processes this particular run owns.
      const ownedPids = new Set([child.pid]);
      let count;
      do { count = ownedPids.size; for (const match of processes) if (ownedPids.has(Number(match[2]))) ownedPids.add(Number(match[1])); } while (ownedPids.size !== count);
      assert.ok(processes.some(match => ownedPids.has(Number(match[1])) && /ktz-g02-controller/.test(match[3])), 'owned Rust controller exists');
      assert.ok(processes.some(match => ownedPids.has(Number(match[1])) && /chrome-linux64\/chrome/.test(match[3])), 'owned headed Chromium exists');
      assert.ok(processes.some(match => ownedPids.has(Number(match[1])) && /chrome-headless-shell/.test(match[3])), 'owned sample Chromium exists');
      const profile = (await readdir(path.join(fixture, 'data'))).find(name => name.startsWith('temporary-'));
      assert.ok(profile, 'self-authored sample has a dedicated temporary profile');
      async function privateTree(directory) {
        for (const name of await readdir(directory)) {
          const filename = path.join(directory, name), info = await lstat(filename);
          if (info.isSymbolicLink()) continue; // Chromium singleton links are not followed.
          assert.equal(info.uid, process.geteuid());
          assert.equal(info.mode & 0o077, 0, `private browser object: ${filename}`);
          if (info.isDirectory()) await privateTree(filename);
        }
      }
      await privateTree(path.join(fixture, 'data', profile));
      if (mode === 'window') { socket.write('{"action":"close"}\n'); await Promise.race([receive(), deadline(5000)]); }
      else child.stdin.write('\x03');
      const result = await Promise.race([exited, deadline(25_000)]);
      assert.ok(mode === 'sigint' ? [0, 130].includes(result.code) : result.code === 0, `${JSON.stringify(result)} ${output}`);
      const limit = Date.now() + 10_000;
      let active;
      do {
        active = [...ownedPids].filter(pid => {
          const stat = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
          return Boolean(stat);
        });
        if (active.length) await new Promise(resolve => setTimeout(resolve, 50));
      } while (active.length && Date.now() < limit);
      assert.deepEqual(active, [], `owned processes remain active: ${active}`);
      await assert.rejects(fetch(ready.origin, { signal: AbortSignal.timeout(3000) }));
      assert.deepEqual(await readdir(temp), [], 'owned temporary browser runtime removed');
      if (mode === 'window') assert.ok((await lstat(screenshot)).size > 0);
    } finally {
      socket?.destroy(); server.close();
      if (child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} await exited; }
    }
  });
});

if (process.platform === 'linux') test('Linux公開CLI: Kindle開始と復帰はブラウザ・保存領域作成前に拒否', async t => {
  const project = fileURLToPath(new URL('../', import.meta.url));
  const fixture = await mkdtemp(path.join(tmpdir(), 'ktz-cli-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  for (const option of ['--kindle', '--resume-kindle']) {
    const data = path.join(fixture, option.slice(2));
    const run = spawnSync('npm', ['--prefix', project, 'start', '--', option], { cwd: fixture, encoding: 'utf8', timeout: 15_000,
      env: { ...process.env, KTZ_USER_DATA_DIR: data, KTZ_CONTROLLER_PATH: path.join(fixture, 'missing-controller') } });
    assert.equal(run.status, 1, `${option}: ${run.stderr}`);
    assert.match(run.stderr, /LinuxではKindleの起動・取得は未対応/);
    assert.doesNotMatch(run.stderr, /controller_not_found/);
    await assert.rejects(lstat(data), { code: 'ENOENT' });
  }
});

test('明示Kindle起動は保存・再利用の専用ブラウザだけを開き、プレビュー・取得・代理認証をしない', async () => {
  const calls = [];
  await openKindleForUser({ command: async (...args) => { calls.push(args); } });
  assert.deepEqual(calls, [['create'], ['openBrowser', { mode: 'kindle', keep: true }]]);
});

test('ジョブ作成失敗時に専用ブラウザ操作を続けない', async () => {
  const calls = [];
  await assert.rejects(openKindleForUser({ command: async kind => { calls.push(kind); throw new Error('test_failure'); } }), /test_failure/);
  assert.deepEqual(calls, ['create']);
});

test('明示復旧は候補が1つの一時専用領域だけを再利用し、取得を始めない', async () => {
  const calls = [];
  const session = 'temporary-00000000-0000-0000-0000-000000000000';
  await openKindleForUser({
    command: async (...args) => calls.push(args),
    snapshot: async () => ({ sessions: [{ id: session, saved: false }] }),
  }, { resumeTemporary: true });
  assert.deepEqual(calls, [['create'], ['openBrowser', { mode: 'kindle', keep: true, session }]]);
});

test('一時専用領域の復旧候補が複数なら勝手に選ばずブラウザを開かない', async () => {
  const calls = [];
  const sessions = ['00000000-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111'].map(id => ({ id: `temporary-${id}`, saved: false }));
  await assert.rejects(openKindleForUser({ command: async (...args) => calls.push(args), snapshot: async () => ({ sessions }) }, { resumeTemporary: true }), /choose_temporary_session_in_ui/);
  assert.deepEqual(calls, [['create']]);
});

test('実サービスの通常表示へ独自の通信遮断を入れず、自作試料のloopback制限は維持する', async () => {
  const routes = [];
  const context = { route: async (pattern, handler) => routes.push({ pattern, handler }) };
  await configureReaderNetwork(context, undefined);
  assert.deepEqual(routes, [], '実Kindleの描画・認証・CDN通信をアプリが推測で遮断しない');
  await configureReaderNetwork(context, 'http://127.0.0.1:12345/reader.html');
  assert.equal(routes.length, 1);
  assert.equal(routes[0].pattern, '**/*');
  const decisions = [];
  const route = url => ({ request: () => ({ url: () => url }), continue: () => decisions.push('continue'), abort: code => decisions.push(code) });
  await routes[0].handler(route('http://127.0.0.1:12345/reader.js'));
  await routes[0].handler(route('https://example.invalid/script.js'));
  await routes[0].handler(route('http://127.0.0.1:12346/reader.js'));
  assert.deepEqual(decisions, ['continue', 'blockedbyclient', 'blockedbyclient']);
});

test('描画用Service Worker: 実サービスの起動条件で通常の描画を妨げず試料の遮断は維持する', async t => {
  const root = fileURLToPath(new URL('../artifacts/mvp-tests/', import.meta.url));
  await mkdir(root, { recursive: true }); const directory = await mkdtemp(path.join(root, 'worker-render-'));
  let context, server;
  t.after(async () => {
    await context?.close();
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  server = http.createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.url === '/worker.js') return res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(`
      self.addEventListener('install', () => self.skipWaiting());
      self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
      self.addEventListener('fetch', event => {
        if (new URL(event.request.url).pathname === '/render-color') event.respondWith(new Response('#d23c1e'));
      });`);
    if (req.url === '/') return res.writeHead(200, { 'Content-Type': 'text/html' }).end(`<!doctype html><html><body style="margin:0"><canvas width="64" height="64" id="paint"></canvas><script type="module">
      const ctx = document.querySelector('#paint').getContext('2d'); ctx.fillStyle = 'black'; ctx.fillRect(0, 0, 64, 64);
      window.fixtureStatus = 'starting';
      try {
        await Promise.race([(async () => {
          await navigator.serviceWorker.register('/worker.js'); await navigator.serviceWorker.ready;
          if (!navigator.serviceWorker.controller) await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
          const color = await (await fetch('/render-color')).text(); if (color !== '#d23c1e') throw new Error('fixture_color');
          ctx.fillStyle = color; ctx.fillRect(0, 0, 64, 64);
        })(), new Promise((_, reject) => setTimeout(() => reject(new Error('fixture_timeout')), 2500))]);
        window.fixtureStatus = 'painted';
      } catch { window.fixtureStatus = 'blocked'; }
      </script></body></html>`);
    res.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  context = await chromium.launchPersistentContext(path.join(directory, 'profile'), readerContextOptions({ headless: true }));
  await configureReaderNetwork(context, `${origin}/`);
  const page = context.pages()[0]; await page.goto(origin);
  await page.waitForFunction(() => window.fixtureStatus !== 'starting', null, { timeout: 5000 });
  const status = await page.evaluate(() => window.fixtureStatus);
  const pixel = PNG.sync.read(await page.screenshot({ clip: { x: 4, y: 4, width: 2, height: 2 } })).data.subarray(0, 3);
  assert.equal(status, 'painted', `自作描画試料の状態=${status}、画素=${[...pixel].join('/')}`);
  assert.deepEqual([...pixel], [210, 60, 30]);
  assert.equal(readerContextOptions({ sampleUrl: `${origin}/` }).serviceWorkers, 'block', '自作試料の既存境界は維持する');
});
