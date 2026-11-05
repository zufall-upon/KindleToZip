import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import fs from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runDiagnostic } from '../scripts/diagnose-test-lifetime.mjs';
import { createOwnerTracker, createRuntimeCleanup, removeOwnedFixtures } from '../scripts/diagnostic-runtime.mjs';
import { createLifetime } from './support/test-lifetime.mjs';

const tempBase = existsSync('/tmp/opencode') ? '/tmp/opencode' : tmpdir();
async function sandbox(t) {
  const root = await mkdtemp(path.join(tempBase, 'ktz-lifetime-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function supervised(root, source, options = {}) {
  let output = '';
  const result = await runDiagnostic({ command: process.execPath, args: ['--input-type=module', '-e', source],
    outerMs: 3000, warningMs: 150, snapshotMs: 250, idleMs: 500, graceMs: 500, tickMs: 30,
    fixtureRoot: root, tempBase, output: text => { output += text; }, ...options });
  return { result, output };
}

test('監視: 正常終了と元の失敗終了を区別する', async t => {
  const root = await sandbox(t);
  const success = await supervised(root, 'process.exit(0)');
  assert.equal(success.result.outcome, 'passed'); assert.deepEqual(success.result.childExit, { code: 0, signal: null });
  assert.deepEqual(success.result.forced, []); assert.deepEqual(success.result.remainingProcesses, []);
  const failure = await supervised(root, 'process.exit(7)');
  assert.equal(failure.result.outcome, 'failed'); assert.equal(failure.result.childExit.code, 7);
  assert.equal(failure.result.timeout, null);
});

test('監視: heartbeatは進捗ではなく警告後に一回snapshotしidleで失敗する', async t => {
  const root = await sandbox(t);
  const source = `import {appendFileSync} from 'node:fs';
    setInterval(()=>{ console.log('ok 1 - repeated'); appendFileSync(process.env.KTZ_LIFETIME_EVENT_FILE,'KTZ_LIFETIME:'+JSON.stringify({pid:process.pid,test:'fixture',boundary:'heartbeat',event:'tick',monotonicMs:performance.now()})+'\\n'); },30);`;
  const { result, output } = await supervised(root, source);
  assert.equal(result.outcome, 'timeout'); assert.equal(result.timeout, 'idle');
  assert.ok(result.elapsedMs < 2500); assert.equal((output.match(/"event":"idle_warning"/g) || []).length, 1);
  assert.equal((output.match(/"event":"snapshot"/g) || []).length, 1);
  assert.ok(result.forced.some(item => item.signal === 'SIGTERM')); assert.deepEqual(result.remainingProcesses, []);
});

test('監視: IPCは種別だけsnapshotしTERMを無視する所有子だけKILLする', async t => {
  const root = await sandbox(t), helper = new URL('./support/test-lifetime.mjs', import.meta.url).href;
  const source = `import {createLifetime} from ${JSON.stringify(helper)};
    const trace=createLifetime(); const t={name:'fixture'};
    trace.trackStore(t,{pending:{kind:'capture_commit',payload:'never-log-this-secret'}});
    trace.emit(t,'test','begin'); process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);`;
  const { result, output } = await supervised(root, source, { graceMs: 200 });
  assert.equal(result.outcome, 'timeout'); assert.equal(result.timeout, 'idle');
  assert.deepEqual(result.snapshot.ipc[0].pending, [{ kind: 'capture_commit', elapsedMs: null }]);
  assert.equal(result.snapshot.ipc[0].cleanupStarted, false);
  assert.ok(result.forced.some(item => item.signal === 'SIGTERM'));
  assert.ok(result.forced.some(item => item.signal === 'SIGKILL'));
  assert.equal(output.includes('never-log-this-secret'), false); assert.deepEqual(result.remainingProcesses, []);
});

test('監視: 古いlistener PIDと異なるstarttimeにはsnapshot signalを送らない', async t => {
  const root = await sandbox(t);
  const source = `import {appendFileSync} from 'node:fs';
    appendFileSync(process.env.KTZ_LIFETIME_EVENT_FILE,'KTZ_LIFETIME:'+JSON.stringify({pid:process.pid,test:'process',boundary:'snapshot_listener',event:'ready',starttime:'0',monotonicMs:performance.now()})+'\\n');
    setInterval(()=>{},1000);`;
  const { result } = await supervised(root, source);
  assert.equal(result.outcome, 'timeout'); assert.equal(result.timeout, 'idle');
  assert.equal(result.childExit.signal, 'SIGTERM');
  assert.deepEqual(result.snapshot.ipc, []); assert.deepEqual(result.remainingProcesses, []);
});

test('監視: 正常終了後の所有子を回収して成功に丸めない', async t => {
  const root = await sandbox(t);
  const source = `import {spawn} from 'node:child_process';
    const p=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'}); p.unref(); setTimeout(()=>process.exit(0),250);`;
  const { result } = await supervised(root, source, { warningMs: 600, snapshotMs: 900, idleMs: 1300 });
  assert.deepEqual(result.childExit, { code: 0, signal: null }); assert.equal(result.outcome, 'failed');
  assert.ok(result.forced.some(item => item.reason === 'residual-after-exit' && item.signal === 'SIGTERM'));
  assert.deepEqual(result.remainingProcesses, []);
});

test('所有確認: 継承runtimeとinode変更fixtureを削除しない', async t => {
  const root = await sandbox(t), inherited = path.join(root, 'ktz-test-Ab12Cd');
  const cleanup = await createRuntimeCleanup({ bases: [root], inherited });
  await mkdir(inherited, { mode: 0o700 }); await writeFile(path.join(inherited, 'keep'), 'inherited');
  assert.equal(await cleanup.observe(inherited), false); await cleanup.cleanup(() => assert.fail('inherited removed'));
  assert.equal(await readFile(path.join(inherited, 'keep'), 'utf8'), 'inherited');
  const fixture = path.join(root, 'workflow-Ab12Cd'); await mkdir(fixture, { mode: 0o700 });
  const { lstat } = await import('node:fs/promises'); const original = await lstat(fixture, { bigint: true });
  await rename(fixture, path.join(root, 'original')); await mkdir(fixture, { mode: 0o700 });
  await writeFile(path.join(fixture, 'keep'), 'replacement');
  await assert.rejects(removeOwnedFixtures(root, new Set(), new Map([['workflow-Ab12Cd', { dev: String(original.dev), ino: String(original.ino) }]]), () => assert.fail()), { code: 'fixture_identity_changed' });
  assert.equal(await readFile(path.join(fixture, 'keep'), 'utf8'), 'replacement');
});

test('所有確認: runtime照合中の消失だけを無視し置換と他のIO失敗は拒否する', async t => {
  const root = await sandbox(t);
  await t.test('lstat後の正常消失', async sub => {
    const cleanup = await createRuntimeCleanup({ bases: [root] });
    const runtime = await mkdtemp(path.join(root, 'ktz-test-'));
    const originalRealpath = fs.promises.realpath;
    sub.mock.method(fs.promises, 'realpath', async (...args) => {
      if (args[0] === runtime) await rm(runtime, { recursive: true });
      return originalRealpath(...args);
    });
    syncBuiltinESMExports();
    sub.after(() => { sub.mock.restoreAll(); syncBuiltinESMExports(); });
    assert.equal(await cleanup.observe(runtime), false);
    assert.deepEqual(cleanup.paths(), []);
    await cleanup.cleanup(() => assert.fail('removed runtime registered'));
  });
  await t.test('他のIO失敗', async sub => {
    const cleanup = await createRuntimeCleanup({ bases: [root] });
    const runtime = await mkdtemp(path.join(root, 'ktz-test-'));
    const originalRealpath = fs.promises.realpath;
    sub.mock.method(fs.promises, 'realpath', async (...args) => {
      if (args[0] === runtime) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return originalRealpath(...args);
    });
    syncBuiltinESMExports();
    sub.after(() => { sub.mock.restoreAll(); syncBuiltinESMExports(); });
    await assert.rejects(cleanup.observe(runtime), { code: 'EACCES' });
    assert.deepEqual(cleanup.paths(), []);
  });
  await t.test('登録後のinode置換', async () => {
    const cleanup = await createRuntimeCleanup({ bases: [root] });
    const runtime = await mkdtemp(path.join(root, 'ktz-test-'));
    assert.equal(await cleanup.observe(runtime), true);
    await rename(runtime, path.join(root, 'original-runtime'));
    await mkdir(runtime, { mode: 0o700 }); await writeFile(path.join(runtime, 'keep'), 'replacement');
    await assert.rejects(cleanup.observe(runtime), { code: 'runtime_identity_changed' });
    await assert.rejects(cleanup.cleanup(() => assert.fail('replacement removed')), { code: 'runtime_identity_changed' });
    assert.equal(await readFile(path.join(runtime, 'keep'), 'utf8'), 'replacement');
  });
});

test('所有確認: 別TMPDIR内に作成された所有runtimeのみtimeout後に回収する', async t => {
  const root = await sandbox(t), base = path.join(root, 'inherited-base');
  await mkdir(base, { mode: 0o700 }); await writeFile(path.join(base, 'keep'), 'inherited');
  const source = `import {mkdtempSync} from 'node:fs'; import {spawn} from 'node:child_process'; import path from 'node:path';
    const runtime=mkdtempSync(path.join(process.env.TMPDIR,'ktz-test-'));
    spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{env:{...process.env,TMPDIR:runtime},stdio:'ignore'});
    setInterval(()=>{},1000);`;
  const { result } = await supervised(root, source, { env: { ...process.env, TMPDIR: base } });
  assert.equal(result.outcome, 'timeout'); assert.equal(await readFile(path.join(base, 'keep'), 'utf8'), 'inherited');
  assert.ok(result.forced.some(item => /^ktz-test-/.test(item.runtime ?? '')));
  const { readdir } = await import('node:fs/promises'); assert.deepEqual(await readdir(base), ['keep']);
  assert.deepEqual(result.remainingProcesses, []);
});

test('所有確認: PID starttime不一致はsignalしない', async t => {
  const token = randomUUID(), child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'],
    { env: { ...process.env, KTZ_TEST_DIAGNOSTIC_OWNER: token }, stdio: 'ignore' });
  const exited = new Promise(resolve => child.once('exit', resolve));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await exited; });
  const owner = createOwnerTracker(token);
  const record = (await owner.scan()).find(item => item.pid === child.pid);
  assert.ok(record); assert.equal(await owner.signal({ ...record, starttime: `${record.starttime}0` }, 'SIGTERM'), false);
  assert.equal(child.exitCode, null); assert.equal(child.signalCode, null);
  assert.equal(await owner.signal(record, 'SIGTERM'), true); await exited;
});

test('診断off: 元promiseと同期例外を保ち設定は作成時に捕捉する', () => {
  const trace = createLifetime({ enabled: false }), sentinel = Promise.resolve('same');
  const fake = () => sentinel, t = { name: 'fixture' }, error = new Error('same');
  assert.equal(trace.instrument(fake), fake); assert.equal(trace.step(t, 'await', () => sentinel), sentinel);
  assert.throws(() => trace.step(t, 'await', () => { throw error; }), caught => caught === error);
  const before = process.env.KTZ_TEST_LIFETIME_DIAGNOSTICS;
  try { process.env.KTZ_TEST_LIFETIME_DIAGNOSTICS = '1'; assert.equal(trace.step(t, 'await', () => sentinel), sentinel); }
  finally { if (before === undefined) delete process.env.KTZ_TEST_LIFETIME_DIAGNOSTICS; else process.env.KTZ_TEST_LIFETIME_DIAGNOSTICS = before; }
});

test('診断on: 子test・本文・明示after・test終了・process終了を別々に記録する', async t => {
  const root = await sandbox(t);
  const helper = new URL('./support/test-lifetime.mjs', import.meta.url).href;
  const source = `import nodeTest from 'node:test'; import {createLifetime} from ${JSON.stringify(helper)};
    const trace=createLifetime(); process.env.KTZ_TEST_LIFETIME_DIAGNOSTICS='0'; const test=trace.instrument(nodeTest);
    test('parent',async t=>{t.after(()=>{}); await t.test('child',async sub=>{sub.after(()=>{});});});`;
  const { result } = await supervised(root, source, { warningMs: 1000, snapshotMs: 1500, idleMs: 2000 });
  assert.equal(result.outcome, 'passed');
  for (const name of ['parent', 'child']) for (const [boundary, event] of [['test', 'begin'], ['test_body', 'complete'], ['after_hook.1', 'start'], ['after_hook.1', 'end'], ['test', 'end']]) {
    assert.ok(result.events.some(e => e.test === name && e.boundary === boundary && e.event === event), `${name}:${boundary}:${event}`);
  }
  assert.ok(result.events.some(e => e.boundary === 'process_exit' && e.event === 'complete'));
  const parent = result.events.filter(e => e.test === 'parent');
  assert.ok(parent.findIndex(e => e.boundary === 'test_body') < parent.findIndex(e => e.boundary === 'after_hook.1'));
});
