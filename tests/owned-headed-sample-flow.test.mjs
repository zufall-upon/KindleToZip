import './chromium-test-log-sink.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));
const hook = new URL('./support/owned-headed-sample-hook.mjs', import.meta.url).href;
const image = fileURLToPath(new URL('../artifacts/linux-port/next-stage/headed-product/preview-01.png', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const enabled = process.platform === 'linux' && Boolean(process.env.WAYLAND_DISPLAY);

function entries(bytes) {
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])); assert.notEqual(end, -1);
  const count = bytes.readUInt16LE(end + 10); let offset = bytes.readUInt32LE(end + 16); const result = [];
  for (let i = 0; i < count; i++) {
    assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
    const size = bytes.readUInt32LE(offset + 24), nameLength = bytes.readUInt16LE(offset + 28);
    const local = bytes.readUInt32LE(offset + 42), data = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    result.push({ name: bytes.subarray(offset + 46, offset + 46 + nameLength).toString('ascii'), bytes: bytes.subarray(data, data + size) });
    offset += 46 + nameLength + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
  }
  return result;
}

async function run(t, mode) {
  const root = await mkdtemp(path.join(existsSync('/tmp/opencode') ? '/tmp/opencode' : tmpdir(), 'ktz-headed-sample-'));
  const temp = path.join(root, 'temp'); await mkdir(temp, { mode: 0o700 });
  await mkdir(path.dirname(image), { recursive: true });
  const socketPath = path.join(root, 's'), server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  const connected = new Promise(resolve => server.once('connection', resolve));
  const child = spawn('npm', ['--prefix', project, 'start', '--', '--sample-headed'], {
    cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
      KTZ_USER_DATA_DIR: path.join(root, 'data'), KTZ_TEMP_DIR: temp, KTZ_SAMPLE_TEST_ROOT: root,
      KTZ_SAMPLE_TEST_IMAGE: image, KTZ_SAMPLE_TEST_MODE: mode, KTZ_SAMPLE_TEST_SOCKET: socketPath,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${hook}` },
  });
  let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  const exited = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  const timeout = ms => new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error(`timeout ${mode}: ${output}`)), ms); timer.unref(); });
  let socket, safe = false;
  t.after(async () => { socket?.destroy(); server.close(); if (safe) await rm(root, { recursive: true, force: true }); });
  try {
    socket = await Promise.race([connected, timeout(30_000)]);
    let buffer = ''; const queued = [], waiters = [];
    socket.on('data', chunk => {
      buffer += chunk; let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const value = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        const waiter = waiters.shift(); if (waiter) waiter(value); else queued.push(value);
      }
    });
    const receive = () => queued.length ? Promise.resolve(queued.shift()) : new Promise(resolve => waiters.push(resolve));
    const result = await Promise.race([receive(), timeout(70_000)]);
    assert.equal(result.event, 'result', `${result.message ?? ''}\n${output}`);
    if (mode !== 'close-failure') {
      assert.equal(result.preview, 0); assert.equal(result.approved, 0); assert.equal(result.beforeStart, 'explicit_start_required');
      assert.equal(result.previewOriginals, 0); assert.equal(result.approvedOriginals, 0);
      assert.deepEqual(result.invalid.map(item => [item.status, item.body.code]), [
        [400, 'linux_kindle_unsupported'], [400, 'invalid_browser_mode'], [400, 'invalid_browser_mode'], [400, 'invalid_browser_mode'],
      ]);
    }
    if (mode === 'positive') {
      assert.match(result.notice, /他アプリ・物理入力・OS画面全体/);
      assert.match(result.noticeEn, /other apps or physical input/); assert.match(result.noticeZh, /其他应用或物理输入/);
      assert.deepEqual(result.launches, [
        { headless: true, wayland: false, emptyDisplay: false },
        { headless: false, wayland: true, emptyDisplay: true },
      ], 'launch policy belongs to each actual open, not the last mode or an HTTP headless flag');
      assert.match(path.basename(result.profile), /^temporary-[a-f0-9-]{36}$/);
      assert.equal((await stat(result.profile)).mode & 0o7777, 0o700);
      assert.equal(result.again, 'explicit_start_required'); assert.equal(result.overwrite, 'output_exists');
      assert.equal(hash(await readFile(image)), result.previewHash);
      assert.ok(result.manifest.images.length >= 2);
      const original1 = await readFile(path.join(result.jobPath, result.manifest.images[0].path));
      const original2 = await readFile(path.join(result.jobPath, result.manifest.images[1].path));
      assert.equal(hash(original1), result.originalHash);
      assert.equal(hash(original1), result.manifest.images[0].sha256); assert.equal(hash(original2), result.manifest.images[1].sha256);
      for (const [index, format] of ['cbz', 'zip'].entries()) {
        const archive = await readFile(path.join(root, `sample.${format}`)), unpacked = entries(archive);
        assert.deepEqual(unpacked.map(item => item.name), ['000001.png', '000002.png']);
        assert.deepEqual(unpacked.map(item => hash(item.bytes)), [hash(original2), hash(original1)]);
        assert.equal(hash(archive), result.manifest.exports[index].sha256);
      }
      assert.equal(hash(await readFile(path.join(result.jobPath, result.manifest.images[0].path))), result.originalHash);
    } else if (mode === 'response-loss') {
      assert.equal(result.sends, 1); assert.equal(result.position, '2 / 12');
      assert.equal(result.reason, 'capture_or_advance_failed'); assert.equal(result.failure.advanceDispatch, 'unknown');
      assert.equal(result.checkpoint.dispatch, 'unknown'); assert.equal(result.images, 1); assert.equal(result.afterImages, 1);
      assert.equal(result.again, 'explicit_start_required'); assert.equal(result.screenshots, 2);
      assert.equal(result.events.filter(event => event.kind === 'record_advance' && event.dispatch === 'unknown').length, 1);
      assert.equal(hash(await readFile(path.join(result.jobPath, 'originals', '000001.png'))), result.originalHash);
    } else if (['target-book', 'target-page', 'target-node'].includes(mode)) {
      assert.equal(result.images, 1); assert.equal(result.afterImages, 1); assert.equal(result.pending, false);
      assert.equal(result.failure.stage, 'target_recheck_before_commit'); assert.equal(result.again, 'explicit_start_required');
      assert.equal(result.events.filter(event => event.kind === 'capture_commit').length, 1);
      assert.equal(result.events.filter(event => event.kind === 'capture_abort').length, 1);
      assert.equal(hash(await readFile(path.join(result.jobPath, 'originals', '000001.png'))), result.originalHash);
    } else if (mode === 'close-failure') {
      assert.equal(result.status, 400); assert.equal(result.close, 'reader_close_failed'); assert.equal(result.releasePending, true);
      assert.ok((await stat(result.profile)).isDirectory());
      assert.equal(hash(await readFile(path.join(result.jobPath, 'originals', '000001.png'))), result.originalHash);
    } else {
      assert.equal(result.status, 400); assert.equal(result.denied, 'window_not_available');
      assert.equal(result.screenshotBefore, result.screenshotAfter); assert.equal(result.images, 0);
    }
    if (['response-loss', 'target-book', 'target-page', 'target-node'].includes(mode)) {
      assert.equal(result.reviewStatus, 200); assert.equal(result.exportStatus, 200);
      const retained = entries(await readFile(result.exportPath));
      assert.deepEqual(retained.map(item => item.name), ['000001.png']);
      assert.equal(hash(retained[0].bytes), result.originalHash);
    }
    socket.write('{"action":"close"}\n');
    const closing = await Promise.race([receive(), timeout(5000)]); assert.equal(closing.event, 'closing');
    const exit = await Promise.race([exited, timeout(30_000)]);
    assert.equal(exit.signal, null); assert.equal(exit.code, mode === 'close-failure' ? 1 : 0, output);
    if (mode === 'close-failure') {
      assert.match(output, /安全確認ができなかったため専用一時領域を保持/);
      assert.ok((await readdir(temp)).some(name => name.startsWith('ktz-')));
      assert.ok((await stat(result.profile)).isDirectory());
      // Deliberately retain the reported unknown profile/runtime, even though
      // this injection threw only after the real context close resolved.
    } else {
      assert.deepEqual(await readdir(temp), []);
      if (mode === 'positive') await assert.rejects(stat(result.profile), { code: 'ENOENT' });
      safe = true;
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      // Only the exact process group created above; failed/unknown fixtures stay.
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
      await Promise.race([exited, timeout(15_000)]).catch(() => {});
    }
  }
}

test('Linux公開npm start: 専用有頭自作試料の製品縦断と限定故障', { skip: !enabled, timeout: 480_000 }, async t => {
  for (const mode of ['positive', 'response-loss', 'target-book', 'target-page', 'target-node', 'minimized', 'state-failure', 'window-mismatch', 'close-failure']) {
    await t.test(mode, { timeout: 90_000 }, sub => run(sub, mode));
  }
});

test('有頭自作認可: 任意loopback URLや偽fixtureオブジェクトでは起動権限を作れない', async () => {
  const { Reader } = await import('../app/reader.mjs');
  const fake = { url: 'http://127.0.0.1:12345/reader.html', close() {} };
  await assert.rejects(Reader.open({ profile: '/nonexistent-fixture-profile', ownedFixture: fake, sampleUrl: fake.url, headless: false }),
    { code: 'owned_sample_unavailable' });
});

test('有頭自作proxy: 拒否応答中のpeer resetで実processを落とさない', { skip: !enabled }, () => {
  const module = new URL('../app/owned-sample.mjs', import.meta.url).href;
  const script = `import net from 'node:net'; import {startOwnedSample,ownedSampleOptions} from ${JSON.stringify(module)};
    const fixture=await startOwnedSample(); const port=Number(new URL(ownedSampleOptions(fixture).proxy.server).port);
    for(let i=0;i<100;i++){const socket=net.connect(port,'127.0.0.1');socket.on('error',()=>{});
      socket.on('connect',()=>{socket.write(i%2 ? 'GET http://example.invalid/ HTTP/1.1\\r\\nHost: example.invalid\\r\\n\\r\\n' : 'CONNECT example.invalid:443 HTTP/1.1\\r\\nHost: example.invalid:443\\r\\n\\r\\n');socket.resetAndDestroy();});}
    await new Promise(resolve=>setTimeout(resolve,500)); await fixture.close(); console.log('RESET_PROBE_OK');`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(child.error, undefined); assert.equal(child.signal, null); assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /RESET_PROBE_OK/);
});
