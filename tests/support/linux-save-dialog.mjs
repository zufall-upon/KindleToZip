import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { open, readFile, mkdir, mkdtemp, lstat, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { linuxSaveDestination } from '../../app/save-dialog.mjs';

const receiptPath = fileURLToPath(new URL('../../artifacts/linux-port/ux/native-result.json', import.meta.url));
const inputs = ['app/save-dialog.mjs', 'app/application.mjs', 'tests/portable-repair-flow.test.mjs',
  'tests/support/linux-save-dialog.mjs', 'tests/support/drive-owned-zenity.py'];
const fingerprints = async () => Object.fromEntries(await Promise.all(inputs.map(async file =>
  [file, createHash('sha256').update(await readFile(file)).digest('hex')])));
const failure = code => Object.assign(new Error(code), { code });

function messages(child) {
  let buffer = ''; const queued = [], waiting = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const value = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
      const waiter = waiting.shift(); if (waiter) waiter(value); else queued.push(value);
    }
  });
  return () => queued.length ? Promise.resolve(queued.shift()) : new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(failure('native_driver_timeout')), 35_000);
    waiting.push(value => { clearTimeout(timer); resolve(value); });
  });
}

export async function checkNativeSaveDialog({ startApplication, openControlWindow, capture, save, entries }) {
  await mkdir(path.dirname(receiptPath), { recursive: true });
  // wx: this run-once attempt never silently replaces earlier failure evidence.
  const receipt = await open(receiptPath, 'wx', 0o600);
  const result = { version: 1, startedAt: new Date().toISOString(), source: await fingerprints(),
    status: 'running', attempts: [], visualEvidence: 'not-obtained', screenshotRoute: 'AccessDenied-respected',
    environment: { GTK_A11Y: 'atspi (Zenity child only)', backendOverride: false, sharedHostKilled: false },
    selectionOnlyNoWrite: false, zipAndCbz: false, existingOutputPreserved: false };
  let directory, r, control;
  try {
    const base = '/tmp/opencode/ktz-linux-ux-native';
    await mkdir(base, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const info = await lstat(base);
    assert.ok(info.isDirectory() && !info.isSymbolicLink() && info.uid === process.geteuid() && (info.mode & 0o7777) === 0o700);
    assert.equal(await realpath(base), base);
    directory = await mkdtemp(path.join(base, 'run-'));
    r = await startApplication({ dataDir: path.join(directory, 'data'), sampleFixture: 'layout' });
    control = await openControlWindow(r.url, { headless: true });
    const ui = control.page;
    await capture(ui, r.app);
    await ui.locator('[data-stage-target="export"]').first().click();

    async function attempt(action, format) {
      const record = { action, format, actionPerformed: false, disappeared: false, disappearanceObserved: false, childClosed: false };
      result.attempts.push(record);
      const driver = spawn('python3', ['-B', fileURLToPath(new URL('./drive-owned-zenity.py', import.meta.url))],
        { stdio: ['pipe', 'pipe', 'ignore'] });
      const receive = messages(driver);
      driver.stdin.on('error', () => {});
      const driverExit = new Promise(resolve => driver.once('close', resolve));
      let pending, child, childExit;
      try {
        const ready = await receive();
        if (ready.event !== 'ready') throw failure(ready.code ?? 'native_driver_not_ready');
        await ui.locator('#format').selectOption(format);
        const initial = path.join(directory, `anonymous-initial.${format}`);
        const chosen = path.join(directory, `anonymous-selected.${format}`);
        await ui.locator('#destination').fill(initial);
        const before = (await r.app.snapshot()).job.manifest.exports.length;
        r.app.saveDialog = input => linuxSaveDestination(input, (executable, args, options) => {
          child = spawn(executable, args, { ...options, env: { ...process.env, GTK_A11Y: 'atspi' } });
          childExit = new Promise(resolve => child.once('close', (code, signal) => {
            Object.assign(record, { childClosed: true, childExit: code, childSignal: signal }); resolve();
          }));
          driver.stdin.write(JSON.stringify({ action, title: args[2].slice('--title='.length), initial,
            chosen, pid: child.pid, parentPid: process.pid }) + '\n');
          return child;
        });
        await ui.waitForFunction(() => !document.querySelector('#chooseDestination').disabled);
        const response = ui.waitForResponse(response => response.url().endsWith('/api/command')
          && response.request().postDataJSON()?.action === 'chooseDestination');
        await ui.locator('#chooseDestination').click();
        pending = response.then(async response => {
          const value = await response.json();
          if (value.code) throw failure(value.code);
          return value;
        });
        // Handle early command rejection even while the driver is discovering the chooser.
        pending.catch(() => {});
        const acted = await receive(); Object.assign(record, acted); delete record.event;
        if (acted.event !== 'acted') throw failure(acted.code ?? 'native_action_missing');
        const value = await pending;
        await childExit;
        driver.stdin.write('{"event":"settled"}\n');
        const finished = await receive(); Object.assign(record, finished); delete record.event;
        assert.equal(finished.event, 'finished');
        record.disappearanceObserved = true;
        assert.equal(finished.disappeared, true);
        assert.equal(await driverExit, 0);
        assert.equal(value.chosenDestination, action === 'select' ? chosen : null);
        await ui.waitForFunction(expected => document.querySelector('#destination').value === expected,
          action === 'select' ? chosen : initial);
        assert.equal((await r.app.snapshot()).job.manifest.exports.length, before);
        await assert.rejects(lstat(chosen), { code: 'ENOENT' });
        await assert.rejects(lstat(initial), { code: 'ENOENT' });
        record.applicationVerified = true;
        return action === 'select' ? chosen : initial;
      } catch (error) {
        record.code = error.code ?? 'native_assertion_failed';
        r.app.destinationDialog?.abort();
        await childExit;
        await pending?.catch(() => {});
        if (record.appearedAfterStart && driver.exitCode === null && driver.stdin.writable) {
          driver.stdin.write('{"event":"settled"}\n');
          try {
            const cleanup = await receive();
            if (cleanup.event === 'cleanup') { record.disappeared = cleanup.disappeared; record.disappearanceObserved = true; }
          } catch { /* 消失を未観測のまま記録し、native失敗を成功へ変更しない。 */ }
        }
        throw error;
      } finally {
        driver.stdin.end();
        if (driver.exitCode === null) driver.kill(); // Only our disposable AT-SPI observer, not the portal.
        await driverExit;
        if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await childExit; }
      }
    }

    const chosen = await attempt('select', 'zip');
    result.selectionOnlyNoWrite = true;
    await save(ui, r.app, 1);
    const original = await readFile(chosen), inode = (await lstat(chosen)).ino;
    assert.equal(entries(original).length, 1);
    await assert.rejects(r.app.command('export', { destination: chosen, format: 'zip' }), { code: 'output_exists' });
    assert.deepEqual(await readFile(chosen), original); assert.equal((await lstat(chosen)).ino, inode);
    result.existingOutputPreserved = true;
    await attempt('cancel', 'cbz');
    const cbz = path.join(directory, 'anonymous-explicit.cbz');
    await ui.locator('#destination').fill(cbz); await save(ui, r.app, 2);
    assert.equal(entries(await readFile(cbz)).length, 1);
    result.zipAndCbz = true; result.status = 'passed';
  } catch (error) {
    result.status = 'failed'; result.code = error.code ?? 'native_test_failed';
    throw error;
  } finally {
    try { await control?.close(); await r?.close(); if (directory) await rm(directory, { recursive: true, force: true }); }
    finally {
      result.endedAt = new Date().toISOString();
      await receipt.writeFile(JSON.stringify(result, null, 2) + '\n'); await receipt.close();
      console.log(`KTZ_NATIVE_RESULT:${result.status}:${result.code ?? 'functional-only;visual-unverified'}`);
    }
  }
}

export async function verifyNativeResult() {
  const result = JSON.parse(await readFile(receiptPath, 'utf8'));
  assert.equal(result.version, 1);
  assert.ok(['passed', 'failed'].includes(result.status), '実行未完了を収集成功にしない');
  assert.deepEqual(result.source, await fingerprints(), 'native試行の入力が変更されていない');
  assert.equal(result.visualEvidence, 'not-obtained');
  assert.equal(result.screenshotRoute, 'AccessDenied-respected');
  assert.equal(result.environment.backendOverride, false);
  assert.equal(result.environment.sharedHostKilled, false);
  assert.ok(result.startedAt && Date.parse(result.endedAt) >= Date.parse(result.startedAt));
  assert.ok(result.attempts.length >= 1 && result.attempts.length <= 2);
  assert.equal(result.attempts[0].action, 'select');
  for (const attempt of result.attempts) {
    if (attempt.title) assert.match(attempt.title, /^KindleToZip (ZIP|CBZ) [a-f0-9]{8}$/);
    if (attempt.applicationVerified) assert.equal(attempt.actionPerformed, true);
    if (attempt.appearedAfterStart) assert.equal(attempt.childClosed, true);
  }
  if (result.status === 'passed') {
    assert.equal(result.attempts.length, 2);
    assert.deepEqual(result.attempts.map(attempt => attempt.action), ['select', 'cancel']);
    assert.ok(result.attempts.every(attempt => attempt.actionPerformed && attempt.applicationVerified && attempt.disappearanceObserved && attempt.disappeared));
    assert.equal(result.selectionOnlyNoWrite, true); assert.equal(result.zipAndCbz, true); assert.equal(result.existingOutputPreserved, true);
  } else assert.match(result.code, /^[a-z_]+$/);
  console.log(JSON.stringify({ result: 'native-attempt-collected', functionalOutcome: result.status,
    code: result.code ?? null, visualEvidence: result.visualEvidence, attempts: result.attempts.length }));
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === '--verify-result') await verifyNativeResult();
