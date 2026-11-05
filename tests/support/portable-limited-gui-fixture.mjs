import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, lstat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export async function runPortableLimitedGui(t, mode) {
  const project = fileURLToPath(new URL('../../', import.meta.url));
  // Isolate this candidate's generated inputs from preserved, unknown old runs.
  const anonymousBase = '/home/user/KTZRC/refusal-20261103';
  const tempBase = '/tmp/opencode/ktz-refusal-20261103';
  await mkdir(anonymousBase, { recursive: true, mode: 0o700 });
  await mkdir(tempBase, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(`${anonymousBase}/limited-`), temp = await mkdtemp(`${tempBase}/gui-`);
  await mkdir(path.join(root, 'data'), { mode: 0o700 });
  const evidenceBase = path.join(project, 'artifacts/ubuntu-portable/reader-limited/refusal-20261103');
  await mkdir(evidenceBase, { recursive: true, mode: 0o700 });
  const evidence = await mkdtemp(path.join(evidenceBase, `anonymous-${mode}-`));
  const html = await readFile(new URL('../../poc/fixtures/reader-kindle-chrome.html', import.meta.url));
  const css = await readFile(new URL('../../poc/fixtures/reader-kindle-chrome.css', import.meta.url));
  const js = await readFile(new URL('../../poc/fixtures/reader-kindle-chrome.js', import.meta.url), 'utf8');
  const actualWait = mode.startsWith('wait-'), heldMain = new Set();
  let origin;
  const handler = (req, res) => {
    const route = new URL(req.url, 'http://127.0.0.1').pathname; res.setHeader('Cache-Control', 'no-store');
    if (mode === 'wait-origin' && route === '/' && req.headers.host === new URL(origin).host) {
      res.writeHead(302, { Location: `http://127.0.0.1:${other.address().port}/kindle-library` }).end(); return;
    }
    if (route === '/' || route === '/kindle-library') {
      const target = actualWait ? `${origin}/kindle-library/manga-wr/B000TEST04` : '/kindle-library/manga-wr/B000TEST04';
      const pending = ['wait-main-dcl', 'wait-child-frame'].includes(mode)
        ? `${mode === 'wait-child-frame' ? '<iframe src="/held-frame" title="匿名の未完了子フレーム"></iframe>' : ''}<script src="/held-main.js"></script>` : '';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(`<!doctype html><title>匿名の本棚</title><h1>匿名の本棚</h1><a id="chooseAnonymous" ${!['positive', 'legacy-stop'].includes(mode) ? 'target="_blank"' : ''} href="${target}">匿名本を選ぶ</a>${pending}`);
    }
    else if (route === '/kindle-library/manga-wr/B000TEST04') res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html);
    else if (route === '/reader-kindle-chrome.css') res.writeHead(200, { 'Content-Type': 'text/css' }).end(css);
    // Ordinary page controls update the visible range value, without inventing
    // a slider input event. Both manual navigation and the app use this UI.
    else if (route === '/reader-kindle-chrome.js') res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(`${js}\nnext.addEventListener('click',()=>{position.value=String(Number(position.value)+1);paint(Number(position.value));});document.querySelector('button[aria-label="前のページへ"]').addEventListener('click',()=>{position.value=String(Number(position.value)-1);paint(Number(position.value));});`);
    else if (actualWait && route === '/held-main.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.flushHeaders(); heldMain.add(res);
      res.on('close', () => heldMain.delete(res));
    } else if (mode === 'wait-child-frame' && route === '/held-frame') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.write('<!doctype html><title>匿名の未完了子フレーム</title><p>読み込み待ち</p>');
    } else if (mode === 'wait-child-frame' && route === '/release-main') {
      const count = heldMain.size;
      for (const response of heldMain) response.end('/* anonymous resource released */');
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ count }));
    }
    else res.writeHead(404).end();
  };
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  const other = ['wait-origin', 'wait-post-origin'].includes(mode) ? http.createServer(handler) : null;
  if (other) await new Promise(resolve => other.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const instance of [server, other].filter(Boolean)) {
      instance.closeAllConnections(); await new Promise(resolve => instance.close(resolve));
    }
  });
  const hook = new URL('./portable-limited-gui-hook.mjs', import.meta.url).href;
  const child = spawn('npm', ['--prefix', project, 'start'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, KTZ_USER_DATA_DIR: path.join(root, 'data/application'), KTZ_TEMP_DIR: temp, KTZ_PORTABLE_ROOT: root,
    KTZ_LIMITED_TEST_ROOT: root, KTZ_LIMITED_TEST_MODE: mode, KTZ_LIMITED_TEST_ORIGIN: origin,
    KTZ_LIMITED_TEST_START_ORIGIN: mode === 'wait-origin' ? `http://127.0.0.1:${other.address().port}` : origin,
    KTZ_LIMITED_TEST_OTHER_ORIGIN: other ? `http://127.0.0.1:${other.address().port}` : origin,
    KTZ_LIMITED_TEST_EVIDENCE: evidence, NODE_OPTIONS: `--import=${hook}` } });
  let output = ''; child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
  const terminal = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
  assert.deepEqual(terminal, { code: mode === 'browser-failure' ? 1 : 0, signal: null }, output);
  const events = (await readFile(path.join(root, 'trace.ndjson'), 'utf8')).trim().split('\n').map(JSON.parse), owners = events.filter(e => e.event === 'owner');
  assert.equal(owners.length, ['browser-failure', 'legacy-init'].includes(mode) ? 0 : 1);
  for (const owner of owners) { assert.throws(() => process.kill(owner.owner, 0), { code: 'ESRCH' }); assert.throws(() => process.kill(-owner.browser, 0), { code: 'ESRCH' }); }
  const line = output.split('\n').find(line => line.startsWith('KTZ_LIMITED_RESULT:'));
  if (mode === 'wait-setup-failure') {
    assert.equal(line, undefined, '匿名準備の失敗を通常の試験結果へ読み替えない');
    assert.ok(events.some(e => e.event === 'error' && e.message.startsWith('Error: anonymous_setup_failure\n')), output);
    const claims = (await readdir(path.join(root, 'data/application'))).filter(name => /^portable-reader-limited-[a-f0-9]{32}\.claim$/.test(name));
    assert.equal(claims.length, 1);
    const claim = JSON.parse(await readFile(path.join(root, 'data/application', claims[0]), 'utf8'));
    await assert.rejects(lstat(path.join(root, 'data/application', claim.session, 'owned/in-use.lock')), { code: 'ENOENT' });
    assert.deepEqual(await readdir(temp), []);
    const manifest = JSON.parse(await readFile(path.join(root, 'data/application/jobs', claim.job, 'manifest.json'), 'utf8'));
    assert.deepEqual(manifest.images, []); assert.deepEqual(manifest.exports, []);
    return { setupFailureRecorded: true, ownerJoined: true, temporaryRemoved: true, images: 0, exports: 0 };
  }
  assert.ok(line, output);
  const result = JSON.parse(line.slice('KTZ_LIMITED_RESULT:'.length));
  const claimName = mode === 'legacy-init' ? 'portable-reader-limited-20261102.claim' : `portable-reader-limited-${result.claimJob}.claim`;
  const claim = JSON.parse(await readFile(path.join(root, 'data/application', claimName), 'utf8'));
  if (mode === 'browser-failure') {
    assert.equal((await lstat(path.join(root, 'data/application', claim.session, 'owned/in-use.lock'))).isFile(), true, '起動失敗の不明lockは保全');
    const refused = events.filter(e => e.event === 'launch-refused'); assert.equal(refused.length, 1);
    assert.throws(() => process.kill(refused[0].owner, 0), { code: 'ESRCH' });
    // A subsequent Application with a fresh job still sees the preserved
    // owner lock before consuming that job's claim or launching another owner.
    const { startApplication } = await import('../../app/server.mjs');
    const next = await startApplication({ dataDir: path.join(root, 'data/application') });
    try {
      const request = async (action, input = {}) => {
        const response = await fetch(`${next.origin}/api/command`, { method: 'POST', headers: {
          Authorization: `Bearer ${next.token}`, 'Content-Type': 'application/json', Origin: next.origin,
        }, body: JSON.stringify({ action, input }) });
        return { status: response.status, body: await response.json() };
      };
      const created = await request('create');
      assert.equal(created.status, 200);
      const id = created.body.job.manifest.job_id;
      const prepare = await request('preparePortableKindle', { session: claim.session });
      const connect = await request('openBrowser', { mode: 'kindle', session: claim.session });
      result.afterRestart = { prepare: { status: prepare.status, code: prepare.body.code },
        connect: { status: connect.status, code: connect.body.code },
        newClaimExists: await lstat(path.join(root, 'data/application', `portable-reader-limited-${id}.claim`)).then(() => true, error => {
          if (error.code !== 'ENOENT') throw error; return false;
        }),
        oldLockExists: (await lstat(path.join(root, 'data/application', claim.session, 'owned/in-use.lock'))).isFile() };
    } finally { await next.close(); }
  } else {
    await assert.rejects(lstat(path.join(root, 'data/application', claim.session, 'owned/in-use.lock')), { code: 'ENOENT' });
    assert.deepEqual(await readdir(temp), [], '匿名ownerと一時領域の通常終了を確認する');
  }
  if (actualWait) {
    for (const name of ['pending-ui.png', 'pending-library.png', ...(result.readerAfterReady ? ['pending-reader.png'] : [])])
      assert.ok((await lstat(path.join(evidence, name))).size > 0, `匿名画像 ${name}`);
    t.diagnostic(`匿名実待機: ${JSON.stringify({ fixed: result.fixed, wait: result.waitResult, afterRelease: result.afterRelease,
      startup: result.startup, originals: result.originalPngs, screenshots: result.screenshots, sends: result.sends,
      claimUnchanged: result.claimUnchanged, ownerBrowserDisconnected: result.ownerBrowserDisconnected })}`);
  }
  t.diagnostic(`匿名限定GUI: ${evidence}; 実Kindle・本人許可は未使用`); return result;
}
