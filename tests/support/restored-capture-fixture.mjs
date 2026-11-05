import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, lstat } from 'node:fs/promises';
import { writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';
import { runLinuxLogin, prepareLinuxLoginProfile, snapLoginPreflight } from '../../app/linux-login-core.mjs';
import { closeOwnedInspectionBrowser } from '../../app/linux-inspect-resume-core.mjs';

const project = fileURLToPath(new URL('../../', import.meta.url));
const base = '/home/user/snap/chromium/common/kindle-to-zip-owned-sample/restored-capture-fixtures-v1';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function restoredCapture(t, mode = 'normal', operation = 'capture') {
  assert.ok(process.env.WAYLAND_DISPLAY);
  await mkdir(base, { mode: 0o700, recursive: true });
  const home = await mkdtemp(path.join(base, 'case-'));
  const state = path.join(home, '.local/state/kindle-to-zip-inspection');
  const data = path.join(home, 'snap/chromium/common/kindle-to-zip-login');
  await mkdir(state, { mode: 0o700, recursive: true });
  await mkdir(path.join(home, 'snap/chromium/common/chromium'), { mode: 0o700, recursive: true });
  await writeFile(path.join(state, 'expected-book.json'), JSON.stringify({ version: 1, asin: 'B000TEST04', title: '匿名の自作試料タイトル', aliases: [] }), { mode: 0o600, flag: 'wx' });
  const prior = ['diagnostic', 'corrected'].includes(operation) ? {
    'expected-capture-once.claim': 'previous-consumed-capture\n',
    'expected-capture-once.result.json': '{"previous":"failed"}\n',
    ...(operation === 'corrected' ? {
      'expected-startup-diagnostic-once.claim': 'previous-consumed-diagnostic\n',
      'expected-startup-diagnostic-once.result.json': '{"previous":"refused"}\n',
    } : {}),
  } : {};
  for (const [filename, bytes] of Object.entries(prior)) await writeFile(path.join(state, filename), bytes, { mode: 0o600, flag: 'wx' });
  const owned = await prepareLinuxLoginProfile(data);
  const html = await readFile(new URL('../../poc/fixtures/reader-kindle-chrome.html', import.meta.url), 'utf8');
  const css = await readFile(new URL('../../poc/fixtures/reader-kindle-chrome.css', import.meta.url));
  const js = await readFile(new URL('../../poc/fixtures/reader-kindle-chrome.js', import.meta.url), 'utf8');
  let resuming = false, loaded = 0, restored = 0;
  const server = http.createServer((req, res) => {
    const route = new URL(req.url, 'http://127.0.0.1').pathname;
    if (route === '/ready') { if (!resuming) loaded++; res.writeHead(204).end(); }
    else if (/^\/kindle-library\/manga-wr\/B000TEST0[34]$/.test(route)) {
      if (resuming) restored++;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
        .end(resuming && mode === 'wrong-title' ? html.replace('匿名の自作試料タイトル', '別の匿名本')
          : mode === 'end' ? html.replace('max="12" value="7"', 'max="12" value="12"') : html);
    } else if (route === '/reader-kindle-chrome.css') res.writeHead(200, { 'Content-Type': 'text/css' }).end(css);
    else if (route === '/reader-kindle-chrome.js') res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(`${js}\nfetch('/ready');next.addEventListener('click',()=>{if(Number(position.value)<Number(position.max)){position.value=String(Number(position.value)+1);paint(Number(position.value));}});`);
    else res.writeHead(404).end();
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const env = { ...process.env };
  for (const key of ['NODE_OPTIONS', 'CHROMIUM_FLAGS', 'DEBUG', 'PWDEBUG']) delete env[key];
  let seedBrowser;
  await runLinuxLogin({ root: data, url: `${origin}/kindle-library/manga-wr/B000TEST04`,
    preflight: () => snapLoginPreflight(userInfo().homedir), requireExistingProfile: true,
    requireAbsentSingleton: true, joinUnconfirmedStart: true,
    requiredArgs: ['--remote-debugging-pipe', '--ozone-platform=wayland'],
    launch(executable, args) {
      seedBrowser = spawn(executable, [...args.slice(0, -1), '--remote-debugging-pipe', '--ozone-platform=wayland',
        '--disable-background-networking', '--disable-quic', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', args.at(-1)], {
        env: { ...env, DISPLAY: '' }, detached: true, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
      });
      seedBrowser.stdio[3].on('error', () => {}); seedBrowser.stdio[4].on('error', () => {});
      return seedBrowser;
    },
    async onStarted(context) {
      for (let i = 0; i < 160 && loaded < 1; i++) await pause(50);
      assert.ok(loaded >= 1, 'seedは実ブラウザ自身で匿名読書画面を開く');
      if (mode === 'multiple') {
        context.child.stdio[3].write(JSON.stringify({ id: 900001, method: 'Target.createTarget', params: { url: `${origin}/kindle-library/manga-wr/B000TEST03` } }) + '\0');
        for (let i = 0; i < 160 && loaded < 2; i++) await pause(50);
        assert.ok(loaded >= 2);
      }
      await closeOwnedInspectionBrowser({ ...context, onUnknown: () => { throw new Error('seed_close_unknown'); } });
    },
  });
  assert.throws(() => process.kill(-seedBrowser.pid, 0), { code: 'ESRCH' });
  await assert.rejects(lstat(owned.lock), { code: 'ENOENT' });
  await assert.rejects(lstat(path.join(owned.profile, 'SingletonLock')), { code: 'ENOENT' });
  resuming = true;
  const preload = new URL('./restored-capture-hook.mjs', import.meta.url).href;
  const stem = operation === 'diagnostic' ? 'linux-expected-startup-diagnostic'
    : operation === 'corrected' ? 'linux-expected-capture-corrected' : 'linux-expected-capture';
  const entry = fileURLToPath(new URL(`../../app/${stem}.mjs`, import.meta.url));
  const collector = fileURLToPath(new URL(`../../app/${stem}-result.mjs`, import.meta.url));
  async function run(file) {
    const child = spawn(process.execPath, [file], { cwd: project, env: { ...env, NODE_OPTIONS: `--import=${preload}`,
      KTZ_RESTORED_CAPTURE_HOME: home, KTZ_RESTORED_CAPTURE_ORIGIN: origin, KTZ_RESTORED_CAPTURE_MODE: mode }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
    const terminal = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
    return { ...terminal, stdout, stderr };
  }
  const first = await run(entry);
  const resultFilename = operation === 'diagnostic' ? 'expected-startup-diagnostic-once.result.json'
    : operation === 'corrected' ? 'expected-capture-corrected-590122c0.result.json' : 'expected-capture-once.result.json';
  const stored = JSON.parse(await readFile(path.join(state, resultFilename), 'utf8'));
  const checked = await run(collector);
  const report = JSON.parse(checked.stdout);
  const events = (await readFile(path.join(home, 'events.ndjson'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  t.diagnostic(JSON.stringify({ mode, exit: first.code, stage: stored.stage ?? stored.phase, failure: stored.failure, diagnostic: stored.startupDiagnostic,
    restoredRequests: restored, images: report.images?.length ?? 0 }));
  return { home, state, first, checked, stored, report, events, restored, run, entry, collector, prior, data, owned };
}
