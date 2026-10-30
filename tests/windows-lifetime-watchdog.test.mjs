import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { boundedProcess, createWindowsBackend, createWindowsOwnerTracker } from '../scripts/windows-diagnostic-process.mjs';
import { commandForMode, runWindowsDiagnostic } from '../scripts/diagnose-windows-test-lifetime.mjs';
import { createLifetime } from './support/test-lifetime.mjs';

const tempBase = existsSync('/tmp/opencode') ? '/tmp/opencode' : tmpdir();
const birthNow = () => {
  const iso = new Date(Date.now() - 100).toISOString();
  return `${iso.slice(0, 19).replace(/[-:T]/g, '')}.${iso.slice(20, 23)}000Z`;
};
async function sandbox() {
  // Retain tiny, uniquely created fixtures; never delete inherited directories.
  return mkdtemp(path.join(tempBase, 'ktz-windows-lifetime-test-'));
}
function backendFor(child, override = {}) {
  const birth = birthNow();
  return {
    async query() {
      return child.exitCode === null && child.signalCode === null
        ? [{ pid: child.pid, parentPid: process.pid, creationDate: birth, name: 'node.exe' }] : [];
    },
    async stop(item) {
      assert.equal(item.pid, child.pid); assert.equal(item.creationDate, birth);
      return child.kill() ? 'terminated' : 'unconfirmed';
    },
    ...override,
  };
}
async function fixture(root, source, options = {}) {
  let output = '';
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const result = await runWindowsDiagnostic({ command: process.execPath, args: ['--input-type=module', '-e', source],
    env, tempBase: root, outerMs: 3000, warningMs: 500, snapshotMs: 800, idleMs: 1100,
    tickMs: 20, scanIntervalMs: 20, queryMs: 400, stopBudgetMs: 600, streamMs: 500,
    output: value => { output += value; }, backendFactory: child => backendFor(child), ...options });
  return { result, output };
}

test('Windows監視: 正常終了と元の失敗終了、専用event保持と既存dir非削除', async () => {
  const root = await sandbox(), inherited = path.join(root, 'ktz-test-Ab12Cd');
  await mkdir(inherited); await writeFile(path.join(inherited, 'keep'), 'inherited');
  const source = `import {appendFileSync} from 'node:fs';
    appendFileSync(process.env.KTZ_LIFETIME_EVENT_FILE,'KTZ_LIFETIME:'+JSON.stringify({pid:process.pid,test:'region fixture',boundary:'region.pendingPoll',event:'start',monotonicMs:performance.now()})+'\\n');
    setTimeout(()=>process.exit(0),220);`;
  const good = await fixture(root, source);
  assert.equal(good.result.outcome, 'passed'); assert.deepEqual(good.result.childExit, { code: 0, signal: null });
  assert.equal(good.result.remainingState, 'none-observed'); assert.deepEqual(good.result.forced, []);
  assert.ok(good.result.events.some(event => event.boundary === 'region.pendingPoll' && event.event === 'start'));
  assert.equal(good.result.processCoverage, 'sampled-descendants-only');
  assert.equal(good.result.eventDirectoryRetained, true);
  const bad = await fixture(root, 'setTimeout(()=>process.exit(7),220)');
  assert.equal(bad.result.outcome, 'failed'); assert.equal(bad.result.childExit.code, 7); assert.equal(bad.result.timeout, null);
  assert.equal(await readFile(path.join(inherited, 'keep'), 'utf8'), 'inherited');
  const directories = (await readdir(root)).filter(name => name.startsWith('ktz-windows-lifetime-'));
  assert.equal(directories.length, 2);
  assert.match(await readFile(path.join(root, directories[0], 'events'), 'utf8'), /region\.pendingPoll/);
});

test('Windows監視: heartbeatと重複TAPは非進捗、一度だけ警告・snapshotしidle失敗', async () => {
  const root = await sandbox();
  const source = `import {appendFileSync} from 'node:fs';
    setInterval(()=>{console.log('ok 1 - repeated');appendFileSync(process.env.KTZ_LIFETIME_EVENT_FILE,'KTZ_LIFETIME:'+JSON.stringify({pid:process.pid,test:'fixture',boundary:'heartbeat',event:'tick',monotonicMs:performance.now(),payload:'never-log-this-secret'})+'\\n');},25);`;
  const { result, output } = await fixture(root, source, { warningMs: 120, snapshotMs: 220, idleMs: 360 });
  assert.equal(result.outcome, 'timeout'); assert.equal(result.timeout, 'idle');
  assert.equal((output.match(/"event":"idle_warning"/g) || []).length, 1);
  assert.equal((output.match(/"event":"snapshot"/g) || []).length, 1);
  assert.equal(result.snapshot.pending, 'unknown'); assert.equal(result.snapshot.processCoverage, 'last-sample-only');
  assert.equal(output.includes('never-log-this-secret'), false);
  assert.ok(result.forced.some(item => item.method === 'verified_handle')); assert.equal(result.remainingState, 'none-observed');
});

test('Windows監視: 意味ある進捗が続いても外側期限は失敗', async () => {
  const root = await sandbox();
  const source = `import {appendFileSync} from 'node:fs'; let n=0;
    setInterval(()=>appendFileSync(process.env.KTZ_LIFETIME_EVENT_FILE,'KTZ_LIFETIME:'+JSON.stringify({pid:process.pid,test:'fixture',boundary:'region.step'+(++n),event:'start',monotonicMs:performance.now()})+'\\n'),25);`;
  const { result } = await fixture(root, source, { outerMs: 320, warningMs: 500, snapshotMs: 650, idleMs: 800 });
  assert.equal(result.outcome, 'timeout'); assert.equal(result.timeout, 'outer');
  assert.ok(result.events.length >= 2); assert.ok(result.forced.length); assert.equal(result.remainingState, 'none-observed');
});

test('Windows所有確認: PID開始時刻不一致は終了しない', async () => {
  const a = '20260101000000.000001Z', b = '20260101000001.000001Z';
  let rows = [{ pid: 41, parentPid: 7, creationDate: a, name: 'node.exe' }], calls = 0;
  const tracker = createWindowsOwnerTracker({ runnerPid: 41, supervisorPid: 7, backend: {
    query: async () => rows, stop: async () => { calls++; return 'terminated'; },
  } });
  const [root] = await tracker.scan();
  await assert.rejects(tracker.stop({ ...root, creationDate: b }), { code: 'identity_unconfirmed' });
  rows = [{ ...rows[0], creationDate: b }];
  await assert.rejects(tracker.scan(), { code: 'identity_changed' }); assert.equal(calls, 0);
});

test('Windows所有確認: 再parentされた既知子は保持し未確認の子孫は推測しない', async () => {
  const a = '20260101000000.000001Z', b = '20260101000001.000001Z', c = '20260101000002.000001Z';
  let rows = [{ pid: 41, parentPid: 7, creationDate: a, name: 'node.exe' },
    { pid: 42, parentPid: 41, creationDate: b, name: 'chrome.exe' }];
  const stopped = [];
  const tracker = createWindowsOwnerTracker({ runnerPid: 41, supervisorPid: 7, backend: {
    query: async () => rows, stop: async item => { stopped.push(item.pid); return 'terminated'; },
  } });
  assert.equal((await tracker.scan()).length, 2);
  rows = [{ pid: 42, parentPid: 99, creationDate: b, name: 'chrome.exe' }];
  const [child] = await tracker.scan();
  assert.equal(child.pid, 42); assert.equal(child.reparented, true); assert.equal(await tracker.stop(child), 'terminated');
  rows.push({ pid: 43, parentPid: 41, creationDate: c, name: 'node.exe' });
  await assert.rejects(tracker.scan(), { code: 'ancestry_unconfirmed' }); assert.deepEqual(stopped, [42]);
});

test('Windows監視: 所有子孫が終了不明なら成功や残存0にしない', async () => {
  const root = await sandbox(); let stopped = [];
  const { result } = await fixture(root, 'setInterval(()=>{},1000)', {
    warningMs: 120, snapshotMs: 220, idleMs: 360,
    backendFactory(child) {
      const base = backendFor(child), birth = birthNow();
      return { async query() { const rows = await base.query();
        if (rows.length) rows.push({ pid: 999999, parentPid: child.pid, creationDate: birth, name: 'node.exe' }); return rows; },
      async stop(item) { stopped.push(item.pid); return item.pid === 999999 ? 'unconfirmed' : base.stop(item); } };
    },
  });
  assert.equal(result.outcome, 'timeout'); assert.equal(result.collectionError, 'termination_unconfirmed');
  assert.equal(result.remainingState, 'unknown'); assert.ok(stopped.includes(999999));
  assert.ok(result.forced.some(item => item.method === 'direct_child_handle'));
});

test('Windows監視: CIM問合せtimeout自体とstream待ちも有界で不明を報告', async () => {
  const started = performance.now();
  await assert.rejects(boundedProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 150, closeMs: 400 }),
    error => ['monitor_command_timeout', 'monitor_helper_unconfirmed'].includes(error.code));
  assert.ok(performance.now() - started < 1800);
  const spawnFn = () => {
    const fake = new EventEmitter(); fake.stdout = new PassThrough(); fake.stderr = new PassThrough(); fake.kill = () => true;
    queueMicrotask(() => fake.emit('exit', 0, null)); return fake;
  };
  await assert.rejects(boundedProcess('unused', [], { timeoutMs: 200, closeMs: 50, spawnFn }), { code: 'monitor_streams_timeout' });
  const root = await sandbox(); let count = 0;
  const { result } = await fixture(root, 'setInterval(()=>{},1000)', { backendFactory(child) {
    const base = backendFor(child); return { ...base, async query() {
      if (++count > 1) throw Object.assign(new Error('private details must not be printed'), { code: 'monitor_command_timeout' });
      return base.query();
    } };
  } });
  assert.equal(result.outcome, 'failed'); assert.equal(result.collectionError, 'monitor_command_timeout');
  assert.equal(result.remainingState, 'unknown'); assert.ok(result.forced.some(item => item.method === 'direct_child_handle'));
});

test('Windows監視: spawn失敗と矛盾するTAPを成功にしない', async () => {
  const root = await sandbox();
  const missing = await runWindowsDiagnostic({ command: path.join(root, 'missing-executable'), args: [], tempBase: root,
    outerMs: 1000, warningMs: 300, snapshotMs: 500, idleMs: 700, tickMs: 20, scanIntervalMs: 20,
    queryMs: 200, stopBudgetMs: 300, streamMs: 300, output: () => {}, backendFactory: child => backendFor(child) });
  assert.equal(missing.outcome, 'failed'); assert.equal(missing.remainingState, 'unknown');
  assert.ok(missing.spawnError || missing.collectionError); assert.equal(missing.childExit, null);
  const source = `console.log('not ok 1 - do not expose https://fixture.invalid/private');
    console.log('# tests 1\\n# pass 1\\n# fail 0\\n# cancelled 0\\n# skipped 0'); setTimeout(()=>process.exit(0),220);`;
  const { result, output } = await fixture(root, source, { requireTap: true, full: true });
  assert.equal(result.outcome, 'failed'); assert.equal(result.collectionError, 'tap_summary_unconfirmed');
  assert.equal(result.childExit.code, 0); assert.equal(output.includes('fixture.invalid'), false);
});

test('Windows監視: callerが選んだtestの本文・after・終了とTAPを照合する', async () => {
  const root = await sandbox(), helper = new URL('./support/test-lifetime.mjs', import.meta.url).href;
  const source = `import nodeTest from 'node:test'; import {createLifetime} from ${JSON.stringify(helper)};
    const trace=createLifetime(); const test=trace.instrument(nodeTest);
    test('lifecycle fixture',async t=>{t.after(()=>{});await new Promise(r=>setTimeout(r,220));});`;
  const good = await fixture(root, source, { requireTap: true, expectedTests: ['lifecycle fixture'] });
  assert.equal(good.result.outcome, 'passed', JSON.stringify(good.result)); assert.equal(good.result.tap.pass, 1);
  assert.ok(good.result.events.some(event => event.boundary === 'after_hook.1' && event.event === 'end'));
  assert.ok(good.result.events.some(event => event.boundary === 'process_exit' && event.event === 'complete'));
  const missing = await fixture(root, source, { requireTap: true, expectedTests: ['different fixture'] });
  assert.equal(missing.result.outcome, 'failed'); assert.equal(missing.result.collectionError, 'test_lifecycle_unconfirmed');
  assert.equal(missing.result.childExit.code, 0);
});

test('Windows診断: 元test選択とfull npm入口、PowerShellのidentity照合を維持', async () => {
  const ui = 'Kindle地域公開UI: 言語と独立して選択し実際の開始URLへ渡し開いた間は変更しない';
  const boundary = 'Kindle地域境界: 同じ明示リストをタブ・picker・取得前後に使い別地域と認証・別本で止まる';
  const single = commandForMode('single'), near = commandForMode('near');
  const regex = spec => new RegExp(spec.args[2].slice('--test-name-pattern='.length));
  assert.ok(regex(single).test(ui)); assert.equal(regex(single).test(boundary), false);
  assert.ok(regex(near).test(ui)); assert.ok(regex(near).test(boundary)); assert.equal(regex(near).test('unrelated'), false);
  assert.deepEqual(single.expectedTests, [ui]); assert.deepEqual(near.expectedTests, [boundary, ui]);
  assert.equal(single.outerMs, 150000); assert.equal(near.outerMs, 150000);
  const full = commandForMode('full', { env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' } });
  assert.deepEqual(full.args, ['/d', '/s', '/c', 'npm.cmd test']); assert.equal(full.outerMs, 1200000);
  assert.deepEqual(full.expectedTests, [boundary, ui]);
  const scripts = []; const backend = createWindowsBackend({ systemRoot: 'C:\\Windows', async run(_cmd, args) {
    scripts.push(Buffer.from(args.at(-1), 'base64').toString('utf16le')); return scripts.length === 1 ? '[]' : 'terminated';
  } });
  assert.deepEqual(await backend.query(100), []);
  assert.equal(await backend.stop({ pid: 22, creationDate: '20260101000000.000001Z' }, 100), 'terminated');
  assert.match(scripts[0], /Get-CimInstance Win32_Process/); assert.doesNotMatch(scripts[0], /CommandLine|Environment/i);
  assert.ok(scripts[1].indexOf('$p.Handle') < scripts[1].indexOf('$p.StartTime'));
  assert.ok(scripts[1].indexOf('$p.StartTime') < scripts[1].indexOf('$p.Kill()'));
  await assert.rejects(backend.stop({ pid: 22, creationDate: "x';Stop-Process" }, 100), { code: 'identity_invalid' });
});

test('Windows診断: 設定の作成時捕捉と失敗・元promiseを保持', async () => {
  const root = await sandbox(), events = path.join(root, 'captured-events');
  const before = process.env.KTZ_TEST_LIFETIME_DIAGNOSTICS;
  try {
    process.env.KTZ_TEST_LIFETIME_DIAGNOSTICS = '0';
    const off = createLifetime(), p = Promise.resolve('same'), original = () => p;
    process.env.KTZ_TEST_LIFETIME_DIAGNOSTICS = '1';
    assert.equal(off.instrument(original), original); assert.equal(off.step({ name: 'fixture' }, 'x', original), p);
    const on = createLifetime({ eventFile: events });
    process.env.KTZ_TEST_LIFETIME_DIAGNOSTICS = '0';
    const marker = new Error('same');
    await assert.rejects(on.step({ name: 'fixture' }, 'region.pendingPoll', () => Promise.reject(marker)), error => error === marker);
    const text = await readFile(events, 'utf8');
    assert.match(text, /"boundary":"region.pendingPoll","event":"start"/);
    assert.match(text, /"boundary":"region.pendingPoll","event":"error"/);
  } finally {
    if (before === undefined) delete process.env.KTZ_TEST_LIFETIME_DIAGNOSTICS;
    else process.env.KTZ_TEST_LIFETIME_DIAGNOSTICS = before;
  }
});
