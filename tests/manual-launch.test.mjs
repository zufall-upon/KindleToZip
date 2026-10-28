import './chromium-test-log-sink.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { openKindleForUser } from '../app/startup.mjs';
import { configureReaderNetwork, readerContextOptions } from '../app/reader.mjs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { PNG } from 'pngjs';
const { chromium } = await import('playwright');

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
