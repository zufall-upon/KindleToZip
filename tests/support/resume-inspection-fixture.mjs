import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdir, lstat, readFile, writeFile, realpath } from 'node:fs/promises';
import { userInfo } from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareLinuxLoginProfile, snapLoginPreflight, runLinuxLogin } from '../../app/linux-login-core.mjs';
import { closeOwnedInspectionBrowser } from '../../app/linux-inspect-resume-core.mjs';

const root = process.env.KTZ_RESUME_ROOT, output = process.env.KTZ_RESUME_OUTPUT;
const name = process.env.KTZ_RESUME_CASE, recipe = process.env.KTZ_RESUME_RECIPE ?? 'actual';
if (!root?.startsWith('/home/user/snap/chromium/common/ktz-resume-probe-20261101-8f13e1b6/run-')
    || !output?.startsWith('/tmp/opencode/ktz-resume-probe-20261101-8f13e1b6/run-')
    || !['single', 'other', 'multiple', 'nonkindle', 'auth', 'frame', 'clipped', 'delayed', 'document-change'].includes(name)
    || !['settings', 'last-session', 'actual'].includes(recipe)) throw new Error('anonymous_resume_fixture_required');
process.umask(0o077);
let phase = 'setup', owned, markerBefore, server, peerServer;
let seedNormal = false;
const summary = { status: 'failed', name, recipe, metadataCount: 0 };
const home = path.join(root, 'home');
const requests = [];
let resuming = false;
let seedReady = 0;
const reader = `<div style="width:640px;height:480px"><div><div><div><div${name === 'clipped' ? ' style="width:8px;overflow:hidden"' : ''}><span id="readerChromeTitle">匿名の保存済み本</span></div></div></div></div>
  <input type="range" min="0" max="100" value="42"><button aria-label="次のページ">次</button><canvas width="600" height="300"></canvas></div>`;
const html = `<!doctype html><meta charset="utf-8"><title>RESUME_FIXTURE_SENTINEL</title><style>body{margin:0}</style>
  ${reader}<p>RESUME_FIXTURE_PRIVATE_BODY</p><script>fetch('/seed-ready')</script>`;
const delayedHtml = `<!doctype html><meta charset="utf-8"><title>RESUME_FIXTURE_SENTINEL</title><style>body{margin:0}</style>
  <div id="fixture"></div><p>RESUME_FIXTURE_PRIVATE_BODY</p>
  <script>setTimeout(() => { document.querySelector('#fixture').innerHTML = ${JSON.stringify(reader)}; }, 1800)</script>`;
const changedHtml = `<!doctype html><meta charset="utf-8"><title>RESUME_FIXTURE_SENTINEL</title>
  <p>RESUME_FIXTURE_PRIVATE_BODY</p><script>setTimeout(() => location.replace('/other'), 1600)</script>`;
const handler = (req, res) => {
  const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
  if (pathname === '/seed-ready') { if (!resuming) seedReady++; res.writeHead(204).end(); return; }
  if (pathname === '/favicon.ico') { res.writeHead(204).end(); return; }
  const kind = ['/selected', '/other', '/ap/signin', '/frame-host', '/frame-reader'].includes(pathname) ? pathname.slice(1) : 'unknown';
  if (resuming) requests.push(kind);
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(pathname === '/ap/signin'
    ? '<!doctype html><input type="password" value="RESUME_FIXTURE_PASSWORD"><script>fetch("/seed-ready")</script>'
    : pathname === '/frame-host' ? '<!doctype html><iframe src="/frame-reader?RESUME_FIXTURE_SENTINEL" width="900" height="700"></iframe><script>fetch("/seed-ready")</script>'
    : name === 'delayed' && resuming && pathname === '/selected' ? delayedHtml
    : name === 'document-change' && resuming && pathname === '/selected' ? changedHtml : html);
};
const waitSeed = async count => {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (seedReady >= count) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('seed_load_unconfirmed');
};
const nativeSpawn = childProcess.spawn;
try {
  assert.equal(await realpath(root), root);
  const realHome = userInfo().homedir, env = { ...process.env, HOME: realHome };
  for (const key of ['TMPDIR', 'TMP', 'TEMP', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'CHROME_LOG_FILE', 'CHROMIUM_FLAGS', 'DEBUG', 'PWDEBUG']) delete env[key];
  await snapLoginPreflight(realHome, env);
  await mkdir(path.join(home, 'snap/chromium/common/chromium'), { recursive: true, mode: 0o700 });
  owned = await prepareLinuxLoginProfile(path.join(home, 'snap/chromium/common/kindle-to-zip-login'));
  markerBefore = await readFile(owned.marker, 'utf8');
  server = http.createServer(handler); peerServer = http.createServer(handler);
  await Promise.all([new Promise(resolve => server.listen(0, '127.0.0.1', resolve)), new Promise(resolve => peerServer.listen(0, '127.0.0.1', resolve))]);
  const origin = `http://127.0.0.1:${server.address().port}`, otherOrigin = `http://127.0.0.1:${peerServer.address().port}`;
  phase = 'seed';
  const pathname = name === 'auth' ? '/ap/signin' : name === 'frame' ? '/frame-host' : name === 'other' ? '/other' : '/selected';
  const launchSeed = (executable, args) => {
    assert.equal(executable, '/snap/bin/chromium');
    assert.ok(args.includes(`--user-data-dir=${owned.profile}`));
    const child = nativeSpawn(executable, [...args.slice(0, -1), '--remote-debugging-pipe', args.at(-1)], {
      env, detached: true, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
    });
    child.stdio[3].on('error', () => {}); child.stdio[4].on('error', () => {});
    return child;
  };
  await runLinuxLogin({ root: owned.root, url: `${name === 'nonkindle' ? otherOrigin : origin}${pathname}?RESUME_FIXTURE_SENTINEL`,
    preflight: () => snapLoginPreflight(realHome, env), launch: launchSeed, requiredArgs: ['--remote-debugging-pipe'],
    requireExistingProfile: true, requireAbsentSingleton: true, joinUnconfirmedStart: true,
    onStarted: async state => {
      await waitSeed(1);
      if (name === 'multiple') {
        // Known anonymous second choice, not a product target-selection action.
        state.child.stdio[3].write(JSON.stringify({ id: 900001, method: 'Target.createTarget', params: { url: `${origin}/other?RESUME_FIXTURE_SENTINEL` } }) + '\0');
        await waitSeed(2);
      }
      await closeOwnedInspectionBrowser({ ...state, onUnknown: () => { throw new Error('seed_close_unknown'); } });
    } });
  seedNormal = true;
  await prepareLinuxLoginProfile(owned.root, { create: false });
  assert.equal(await readFile(owned.marker, 'utf8'), markerBefore);
  await assert.rejects(lstat(owned.lock), { code: 'ENOENT' });
  resuming = true;
  phase = 'resume';
  const trace = path.join(path.dirname(output), 'commands.jsonl');
  const hook = new URL('./resume-inspection-hook.mjs', import.meta.url).href;
  const entry = fileURLToPath(new URL('../../app/linux-inspect-resume.mjs', import.meta.url));
  // The HTTP fixture must keep serving while the real entry runs. This is a
  // joined child, not a second browser launch or a background completion claim.
  const child = childProcess.spawn(process.execPath, [entry], { cwd: fileURLToPath(new URL('../../', import.meta.url)),
    env: { ...env, NODE_OPTIONS: `--import=${hook}`, KTZ_RESUME_TEST_HOME: home, KTZ_RESUME_TEST_ORIGIN: origin,
      KTZ_RESUME_TEST_TRACE: trace, KTZ_RESUME_TEST_RECIPE: recipe }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  const ended = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
  assert.equal(stderr, ''); assert.doesNotMatch(stdout, /RESUME_FIXTURE|PRIVATE_BODY|PASSWORD/);
  const value = JSON.parse(stdout);
  assert.equal(value.metadataCount, 0); assert.equal(value.binding, 'unverified');
  assert.equal(value.shutdown, 'normal'); assert.equal(value.lock, 'released');
  assert.equal(value.owner.exited, true); assert.equal(value.owner.retained, false);
  const events = (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.ok(!events.some(event => event.unsafeTargetParse || event.malformedCommand || event.command === 'unexpected' || event.mode === 'unexpected'));
  assert.equal(events.filter(event => event.launch).length, 1);
  assert.equal(events.find(event => event.launch).launch.addedUrl, false);
  assert.equal(events.filter(event => event.command === 'Browser.close').length, 1);
  await prepareLinuxLoginProfile(owned.root, { create: false });
  assert.equal(await readFile(owned.marker, 'utf8'), markerBefore);
  await assert.rejects(lstat(owned.lock), { code: 'ENOENT' });
  await assert.rejects(lstat(path.join(owned.profile, 'SingletonLock')), { code: 'ENOENT' });
  summary.status = 'ok';
  summary.actualExit = ended.code; summary.result = value; summary.events = events;
  summary.browserRestoredSeed = requests.includes(pathname.slice(1));
  summary.lockReleased = true; summary.profilePreserved = true; summary.seedNormalExit = true;
} catch { summary.failurePhase = phase; }
finally {
  if (server) await new Promise(resolve => server.close(resolve));
  if (peerServer) await new Promise(resolve => peerServer.close(resolve));
  await writeFile(output, JSON.stringify(summary) + '\n', { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ status: summary.status, phase: summary.failurePhase ?? 'complete' }));
  if (summary.status !== 'ok') process.exitCode = 1;
}
