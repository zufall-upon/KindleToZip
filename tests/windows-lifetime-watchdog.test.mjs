import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { boundedProcess, createWindowsBackend, createWindowsOwnerTracker } from '../scripts/windows-diagnostic-process.mjs';
import { commandForMode, runWindowsDiagnostic } from '../scripts/diagnose-windows-test-lifetime.mjs';
import { createLifetime } from './support/test-lifetime.mjs';
import { observeControlWindow } from './support/control-lifetime.mjs';

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
  const eventFiles = await Promise.all(directories.map(name => readFile(path.join(root, name, 'events'), 'utf8')));
  assert.equal(eventFiles.filter(text => /region\.pendingPoll/.test(text)).length, 1);
  assert.equal(eventFiles.filter(text => text === '').length, 1);
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

test('Windows所有履歴: activeとretiredの証拠を混同しない', async t => {
  const a = '20260101000000.000001Z', b = '20260101000001.000001Z', c = '20260101000002.000001Z';
  const root = { pid: 41, parentPid: 7, creationDate: a, name: 'cmd.exe' };
  const child = { pid: 42, parentPid: 41, creationDate: b, name: 'chrome.exe' };
  function model(initial = [root, child], stopResult = 'terminated') {
    let rows = initial, queryError;
    const stops = [], decisions = [];
    const tracker = createWindowsOwnerTracker({ runnerPid: 41, supervisorPid: 7,
      onDecision: item => decisions.push(item), backend: {
        async query() { if (queryError) throw queryError; return rows; },
        async stop(item) { stops.push(item); return stopResult; },
      } });
    return { tracker, stops, decisions, setRows(value) { rows = value; }, failQuery(value) { queryError = value; } };
  }
  await t.test('A 同PID同開始時刻を継続して確認する', async () => {
    const m = model(); const first = await m.tracker.scan();
    assert.deepEqual(await m.tracker.scan(), first);
    assert.equal(await m.tracker.stop(first[1]), 'terminated'); assert.equal(m.stops.length, 1);
  });
  await t.test('B 消失を確認した子PIDの無関係な再利用に所有権を渡さない', async () => {
    const m = model(); const [, old] = await m.tracker.scan();
    m.setRows([root]); assert.equal((await m.tracker.scan()).length, 1);
    m.setRows([root, { ...child, parentPid: 99, creationDate: c }]);
    assert.deepEqual((await m.tracker.scan()).map(p => p.pid), [41]);
    await assert.rejects(m.tracker.stop(old), { code: 'identity_unconfirmed' }); assert.equal(m.stops.length, 0);
    assert.equal(m.tracker.history().length, 2);
    assert.ok(m.decisions.some(d => d.decision === 'new_unowned' && d.absenceObserved && d.parentIdentityMatched === false));
  });
  await t.test('C 再利用された子PIDは現owned親からの新しい証拠だけで採用する', async () => {
    const m = model(); const [, old] = await m.tracker.scan();
    m.setRows([root]); await m.tracker.scan();
    m.setRows([root, { ...child, creationDate: c }]);
    const next = (await m.tracker.scan()).find(p => p.pid === 42);
    assert.equal(next.creationDate, c); assert.equal(m.tracker.history().length, 3);
    await assert.rejects(m.tracker.stop(old), { code: 'identity_unconfirmed' });
    assert.equal(await m.tracker.stop(next), 'terminated'); assert.equal(m.stops[0].creationDate, c);
    assert.ok(m.decisions.some(d => d.decision === 'new_owned' && d.absenceObserved && d.parentIdentityMatched === true));
  });
  await t.test('D 消失未観測の開始時刻変化は拒否し古いactiveからも停止しない', async () => {
    const m = model(); const [, old] = await m.tracker.scan();
    m.setRows([root, { ...child, creationDate: c }]);
    await assert.rejects(m.tracker.scan(), { code: 'identity_changed' });
    await assert.rejects(m.tracker.stop(old), { code: 'identity_unconfirmed' }); assert.equal(m.stops.length, 0);
    assert.ok(m.decisions.some(d => d.kind === 'active_changed' && !d.absenceObserved && d.decision === 'reject'));
  });
  await t.test('E rootは消失確認後でも同PID別個体として採用しない', async () => {
    const m = model([root]); const [old] = await m.tracker.scan();
    m.setRows([]); assert.deepEqual(await m.tracker.scan(), []);
    m.setRows([{ ...root, creationDate: c }]);
    await assert.rejects(m.tracker.scan(), { code: 'identity_changed' });
    await assert.rejects(m.tracker.stop(old), { code: 'identity_unconfirmed' }); assert.equal(m.stops.length, 0);
    assert.equal(m.tracker.history().length, 1);
  });
  await t.test('F 親が終了した既知同個体の再parentは所有を維持する', async () => {
    const m = model(); await m.tracker.scan();
    m.setRows([{ ...child, parentPid: 99 }]);
    const [owned] = await m.tracker.scan(); assert.equal(owned.pid, 42); assert.equal(owned.reparented, true);
    assert.equal(await m.tracker.stop(owned), 'terminated'); assert.equal(m.stops[0].creationDate, b);
  });
  await t.test('G 終了した親の未知子は推測で採用も停止もしない', async () => {
    const m = model([root]); const [old] = await m.tracker.scan();
    m.setRows([child]); await assert.rejects(m.tracker.scan(), { code: 'ancestry_unconfirmed' });
    await assert.rejects(m.tracker.stop(old), { code: 'identity_unconfirmed' }); assert.equal(m.stops.length, 0);
  });
  await t.test('H scan後stop直前のPID再利用は既存handle照合の拒否を伝播する', async () => {
    const m = model([root, child], 'identity_mismatch'); const [, old] = await m.tracker.scan();
    await assert.rejects(m.tracker.stop(old), { code: 'identity_changed' });
    await assert.rejects(m.tracker.stop(old), { code: 'identity_unconfirmed' }); assert.equal(m.stops.length, 1);
    assert.ok(m.decisions.some(d => d.decision === 'reject' && d.stopAttempted));
  });
  await t.test('CIM失敗は不在とせず以前のactiveによるstopを拒否する', async () => {
    const m = model(); const [, old] = await m.tracker.scan();
    m.failQuery(Object.assign(new Error('private-error-not-a-log'), { code: 'monitor_command_timeout' }));
    await assert.rejects(m.tracker.scan(), { code: 'monitor_command_timeout' });
    await assert.rejects(m.tracker.stop(old), { code: 'identity_unconfirmed' });
    assert.equal(m.stops.length, 0); assert.equal(m.tracker.history().length, 2);
    assert.equal(m.decisions.some(d => d.decision === 'retire'), false);
  });
  await t.test('不完全metadataは不在とせず以前のactiveによるstopを拒否する', async () => {
    const m = model(); const [, old] = await m.tracker.scan();
    m.setRows([root, { pid: 42 }]); await assert.rejects(m.tracker.scan(), { code: 'metadata_invalid' });
    await assert.rejects(m.tracker.stop(old), { code: 'identity_unconfirmed' });
    assert.equal(m.stops.length, 0); assert.equal(m.decisions.some(d => d.decision === 'retire'), false);
  });
});

test('Windows新子の開始時刻: 識別不能と現親の所有証拠なしを分ける', async t => {
  const a = '20260101000000.000001Z', b = '20260101000001.000001Z';
  const c = '20260101000002.000001Z', d = '20260101000003.000001Z';
  const root = { pid: 41, parentPid: 7, creationDate: a, name: 'cmd.exe' };
  const child = { pid: 42, parentPid: 41, creationDate: b, name: 'node.exe' };
  function model() {
    let rows = [root]; const decisions = [], stopped = [];
    const tracker = createWindowsOwnerTracker({ runnerPid: 41, supervisorPid: 7,
      onDecision: record => decisions.push(record), backend: {
        query: async () => rows, stop: async record => { stopped.push(record); return 'terminated'; },
      } });
    return { tracker, decisions, stopped, setRows(value) { rows = value; } };
  }
  for (const [creationDate, kind] of [[null, 'child_birth_missing'], ['private-invalid-date', 'child_birth_invalid'],
    ['20261301000000.000001Z', 'child_birth_invalid']]) {
    await t.test(kind, async () => {
      const m = model(); const [owned] = await m.tracker.scan(); m.setRows([root, { ...child, creationDate }]);
      await assert.rejects(m.tracker.scan(), { code: 'identity_unconfirmed' });
      await assert.rejects(m.tracker.stop(owned), { code: 'identity_unconfirmed' });
      await assert.rejects(m.tracker.stop({ ...child, creationDate }), { code: 'identity_unconfirmed' });
      assert.equal(m.stopped.length, 0); assert.equal(m.tracker.history().length, 1);
      assert.ok(m.decisions.some(e => e.kind === kind && e.decision === 'reject' && !e.stopAttempted));
      assert.equal(JSON.stringify(m.decisions).includes('private-invalid-date'), false);
    });
  }
  await t.test('正常な子は現親の証拠で所有に追加する', async () => {
    const m = model(); m.setRows([root, child]);
    const [, owned] = await m.tracker.scan(); assert.equal(owned.creationDate, b);
    assert.equal(await m.tracker.stop(owned), 'terminated'); assert.equal(m.stopped.length, 1);
  });
  await t.test('現親より古い正常個体は所有へ追加せず停止しない', async () => {
    const m = model(), older = { ...child, creationDate: '20251231235959.000001Z' };
    m.setRows([root, older]); assert.deepEqual((await m.tracker.scan()).map(e => e.pid), [41]);
    await assert.rejects(m.tracker.stop(older), { code: 'identity_unconfirmed' }); assert.equal(m.stopped.length, 0);
    assert.equal(m.tracker.history().length, 1);
    assert.ok(m.decisions.some(e => e.kind === 'child_birth_before_parent' && e.decision === 'new_unowned' && !e.stopAttempted));
    m.setRows([older]); assert.deepEqual(await m.tracker.scan(), []);
    assert.deepEqual(await m.tracker.scan(), []);
    await assert.rejects(m.tracker.stop(older), { code: 'identity_unconfirmed' });
    // Exclusion follows the dated individual, never the PID alone.
    for (const creationDate of [b, null]) {
      m.setRows([{ ...older, creationDate }]);
      await assert.rejects(m.tracker.scan(), { code: 'ancestry_unconfirmed' });
    }
    assert.equal(m.stopped.length, 0);
  });
  await t.test('過去owned親からの未知子かもしれない個体を残存なしにしない', async () => {
    const m = model(); m.setRows([root, child]); await m.tracker.scan();
    m.setRows([root]); await m.tracker.scan();
    const replacement = { ...child, creationDate: d };
    m.setRows([root, replacement]); await m.tracker.scan();
    const unknown = { pid: 43, parentPid: 42, creationDate: c, name: 'chrome.exe' };
    m.setRows([root, replacement, unknown]); await assert.rejects(m.tracker.scan(), { code: 'ancestry_unconfirmed' });
    await assert.rejects(m.tracker.stop(unknown), { code: 'identity_unconfirmed' });
    await assert.rejects(m.tracker.stop(replacement), { code: 'identity_unconfirmed' }); assert.equal(m.stopped.length, 0);
    assert.equal(m.tracker.history().some(e => e.pid === 43), false);
    assert.ok(m.decisions.some(e => e.kind === 'child_birth_before_parent' && e.decision === 'reject' && !e.stopAttempted));
    m.setRows([root, unknown]); await assert.rejects(m.tracker.scan(), { code: 'ancestry_unconfirmed' });
    await assert.rejects(m.tracker.stop(unknown), { code: 'identity_unconfirmed' }); assert.equal(m.stopped.length, 0);
    // An unowned replacement at the parent PID is not evidence that a child
    // born during the historical owned parent's lifetime is unrelated.
    const other = model(); other.setRows([root, child]); await other.tracker.scan();
    other.setRows([root]); await other.tracker.scan();
    other.setRows([root, { ...replacement, parentPid: 99 }, unknown]);
    await assert.rejects(other.tracker.scan(), { code: 'ancestry_unconfirmed' });
    await assert.rejects(other.tracker.stop(unknown), { code: 'identity_unconfirmed' }); assert.equal(other.stopped.length, 0);
  });
});

test('Windows新子の開始時刻: collectorも非対象と識別不能を区別する', async t => {
  await t.test('現親より古い個体はrunner終了後も非採用で正常終了する', async () => {
    const root = await sandbox(); let stops = 0;
    try {
      const { result, output } = await fixture(root, 'setTimeout(()=>process.exit(0),220)', {
        backendFactory(child) {
          const base = backendFor(child);
          return { async query() { return [...await base.query(), {
            pid: 999996, parentPid: child.pid, creationDate: '20000101000000.000001Z', name: 'private-older-name',
          }]; }, async stop(record) { stops++; return base.stop(record); } };
        },
      });
      assert.equal(result.outcome, 'passed'); assert.deepEqual(result.childExit, { code: 0, signal: null });
      assert.equal(result.testOutcome, 'passed'); assert.equal(result.collectionOutcome, 'complete');
      assert.equal(result.cleanupOutcome, 'none-observed'); assert.equal(result.collectionError, null);
      assert.deepEqual(result.remainingProcesses, []); assert.deepEqual(result.forced, []);
      assert.deepEqual(result.terminationAttempts, []); assert.equal(stops, 0);
      assert.equal(result.observedProcesses.length, 1);
      const metadata = output.split('\n').filter(line => line.startsWith('KTZ_OWNERSHIP:'));
      assert.ok(metadata.some(line => line.includes('child_birth_before_parent') && line.includes('new_unowned')));
      for (const line of metadata) assert.doesNotMatch(line, /999996|20000101|private-older-name|CreationDate|"pid"/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  for (const [creationDate, kind] of [[null, 'child_birth_missing'], ['private-invalid-date', 'child_birth_invalid']]) {
    await t.test(kind, async () => {
      const root = await sandbox(); let childStops = 0;
      const { result, output } = await fixture(root, 'setInterval(()=>{},1000)', {
        backendFactory(child) {
          const base = backendFor(child);
          return { ...base, async query() { const rows = await base.query();
            if (rows.length) rows.push({ pid: 999997, parentPid: child.pid, creationDate, name: 'private-child-name' }); return rows; },
          async stop(record) { childStops++; return base.stop(record); } };
        },
      });
      assert.equal(result.outcome, 'failed'); assert.equal(result.collectionError, 'identity_unconfirmed');
      assert.equal(result.collectionOutcome, 'incomplete'); assert.equal(result.cleanupOutcome, 'unknown');
      assert.equal(result.remainingState, 'unknown'); assert.equal(childStops, 0);
      const metadata = output.split('\n').filter(line => line.startsWith('KTZ_OWNERSHIP:'));
      assert.ok(metadata.some(line => line.includes(kind) && line.includes('"decision":"reject"')));
      for (const line of metadata) assert.doesNotMatch(line, /999997|private-invalid-date|private-child-name|CreationDate|"pid"/);
    });
  }
});

test('Windows所有判定: 公開ログは固定分類だけでPIDと開始時刻を出さない', async () => {
  const directory = await sandbox(); let queries = 0;
  const { result, output } = await fixture(directory, 'setTimeout(()=>process.exit(0),220)', {
    backendFactory(child) {
      const base = backendFor(child);
      return { ...base, async query() {
        const rows = await base.query(); queries++;
        if (queries === 1) rows.push({ pid: 999998, parentPid: child.pid, creationDate: rows[0].creationDate, name: 'chrome.exe' });
        else if (queries >= 3) rows.push({ pid: 999998, parentPid: 99, creationDate: '99990101000000.000001Z', name: 'private-unowned-name' });
        return rows;
      } };
    },
  });
  assert.equal(result.outcome, 'passed'); assert.equal(result.cleanupOutcome, 'none-observed');
  const metadata = output.split('\n').filter(line => line.startsWith('KTZ_OWNERSHIP:'));
  assert.ok(metadata.some(line => line.includes('"decision":"new_unowned"')));
  for (const line of metadata) {
    assert.doesNotMatch(line, /999998|99990101|creationDate|private-unowned-name|"pid"/);
    assert.deepEqual(Object.keys(JSON.parse(line.slice('KTZ_OWNERSHIP:'.length))).sort(),
      ['role', 'kind', 'decision', 'absenceObserved', 'parentIdentityMatched', 'stopAttempted'].sort());
  }
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

test('Windows監視: CIM問合せtimeout自体とstream待ちも有界で不明を報告', async t => {
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

  await t.test('補助の終了未確認でもprocess参照を解放する', async () => {
    let child, originalKill, unrefs = 0;
    try {
      await assert.rejects(boundedProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
        timeoutMs: 100, closeMs: 60, spawnFn(command, args, options) {
          child = spawn(command, args, options);
          originalKill = child.kill.bind(child);
          const originalUnref = child.unref.bind(child);
          child.kill = () => false; // Portable fixture for an unconfirmed termination.
          child.unref = () => { unrefs++; return originalUnref(); };
          return child;
        },
      }), { code: 'monitor_helper_unconfirmed' });
      assert.equal(child.exitCode, null); assert.equal(child.signalCode, null);
      assert.equal(child.stdout.destroyed, true); assert.equal(child.stderr.destroyed, true);
      assert.equal(unrefs, 1);
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.ref(); const exited = new Promise(resolve => child.once('exit', resolve));
        originalKill('SIGKILL'); await exited;
      }
    }
  });
  await t.test('runnerの終了未確認でも非成功と残存不明を保ちprocess参照を解放する', async () => {
    let child, originalKill, unrefs = 0;
    try {
      const { result } = await fixture(root, 'setInterval(()=>{},1000)', { streamMs: 60, backendFactory(p) {
        child = p; originalKill = child.kill.bind(child);
        const originalUnref = child.unref.bind(child);
        child.kill = () => false;
        child.unref = () => { unrefs++; return originalUnref(); };
        return { async query() { throw Object.assign(new Error('fixture'), { code: 'monitor_command_timeout' }); } };
      } });
      assert.equal(result.outcome, 'failed'); assert.equal(result.collectionError, 'monitor_command_timeout');
      assert.equal(result.remainingState, 'unknown'); assert.equal(result.childExit, null);
      assert.deepEqual(result.forced, []);
      assert.deepEqual(result.terminationAttempts, [{ pid: child.pid, reason: 'monitor_failure', status: 'unknown' }]);
      assert.equal(child.stdout.destroyed, true); assert.equal(child.stderr.destroyed, true);
      assert.equal(unrefs, 1);
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.ref(); const exited = new Promise(resolve => child.once('exit', resolve));
        originalKill('SIGKILL'); await exited;
      }
    }
  });
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
  assert.equal(good.result.testOutcome, 'passed'); assert.equal(good.result.collectionOutcome, 'complete');
  assert.equal(good.result.cleanupOutcome, 'none-observed');
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
    const fake = { launch: original }, descriptor = Object.getOwnPropertyDescriptor(fake, 'launch');
    assert.equal(observeControlWindow(off, 'fixture', fake, () => fake.launch()), p);
    assert.deepEqual(Object.getOwnPropertyDescriptor(fake, 'launch'), descriptor);
    const on = createLifetime({ eventFile: events });
    process.env.KTZ_TEST_LIFETIME_DIAGNOSTICS = '0';
    assert.equal(await observeControlWindow(on, 'fixture', fake, () => fake.launch()), 'same');
    assert.deepEqual(Object.getOwnPropertyDescriptor(fake, 'launch'), descriptor);
    const marker = new Error('same');
    await assert.rejects(on.step({ name: 'fixture' }, 'region.pendingPoll', () => Promise.reject(marker)), error => error === marker);
    const text = await readFile(events, 'utf8');
    assert.match(text, /"boundary":"region.pendingPoll","event":"start"/);
    assert.match(text, /"boundary":"region.pendingPoll","event":"error"/);
    assert.match(text, /"boundary":"control.browser_launch","event":"end"/);
  } finally {
    if (before === undefined) delete process.env.KTZ_TEST_LIFETIME_DIAGNOSTICS;
    else process.env.KTZ_TEST_LIFETIME_DIAGNOSTICS = before;
  }
});

test('診断分類: 同期・非同期・getter・出力失敗でも元の結果と例外を維持し秘密を記録しない', async () => {
  const root = await sandbox(), file = path.join(root, 'classification-events');
  const trace = createLifetime({ enabled: true, eventFile: file });
  const { errors: playwrightErrors } = await import('playwright');
  const value = { retained: true }, timeout = new playwrightErrors.TimeoutError('private-path-token');
  const os = Object.assign(new Error('private-url-token'), { code: 'EACCES' });
  const unknownCode = Object.assign(new Error('private-message'), { name: 'private_name', code: 'private_token_profile' });
  let getters = 0;
  const unknown = Object.create(null);
  for (const key of ['name', 'code', 'message', 'stack', 'cause']) Object.defineProperty(unknown, key, {
    get() { getters++; throw new Error('getter must not run'); },
  });
  assert.equal(trace.step('fixture', 'region.control', () => value), value);
  assert.throws(() => trace.step('fixture', 'region.control', () => { throw timeout; }), error => error === timeout);
  await assert.rejects(trace.step('fixture', 'region.control', () => Promise.reject(os)), error => error === os);
  await assert.rejects(trace.step('fixture', 'region.control', () => Promise.reject(unknownCode)), error => error === unknownCode);
  await assert.rejects(trace.step('fixture', 'region.control', () => Promise.reject(unknown)), error => error === unknown);
  const hostile = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('private'); }, getPrototypeOf() { throw new Error('private'); } });
  assert.throws(() => trace.step('fixture', 'region.control', () => { throw hostile; }), error => error === hostile);
  assert.equal(getters, 0);
  const text = await readFile(file, 'utf8');
  const errors = text.split('\n').filter(Boolean).map(line => JSON.parse(line.slice('KTZ_LIFETIME:'.length))).filter(item => item.event === 'error');
  assert.deepEqual(errors.map(({ errorClass, errorCode }) => [errorClass, errorCode]), [
    ['timeout', 'unknown'], ['os', 'EACCES'], ['unknown', 'unknown'], ['unknown', 'unknown'], ['unknown', 'unknown'],
  ]);
  assert.ok(errors.every(item => Number.isFinite(item.elapsedMs) && item.elapsedMs >= 0));
  assert.doesNotMatch(text, /private|getter must not run|message|stack|cause/);
  // Force a real event-channel error after creation; even the start event must
  // not stop invocation. Restore the channel for the process exit listener.
  await rename(file, `${file}.saved`); await mkdir(file);
  try {
    let called = false;
    assert.equal(trace.step('fixture', 'region.control', () => { called = true; return value; }), value);
    assert.equal(called, true);
    assert.throws(() => trace.step('fixture', 'region.control', () => { throw timeout; }), error => error === timeout);
    await assert.rejects(trace.step('fixture', 'region.control', () => Promise.reject(os)), error => error === os);
  } finally { await rename(file, `${file}.directory`); await rename(`${file}.saved`, file); }
});

test('実public control caller: 操作境界と例外、呼出し設定、同時実行の分離とdescriptor復元', async () => {
  const { chromium } = await import('playwright');
  const { openControlWindow } = await import('../app/control-window.mjs');
  const root = await sandbox(), file = path.join(root, 'control-events');
  const trace = createLifetime({ enabled: true, eventFile: file });
  const off = createLifetime({ enabled: false });
  const url = `http://127.0.0.1:4321/#${'a'.repeat(64)}`;
  const originalOwn = Object.getOwnPropertyDescriptor(chromium, 'launch');
  const installFake = fn => Object.defineProperty(chromium, 'launch', { value: fn, configurable: true, writable: true });
  const restoreChromium = () => originalOwn ? Object.defineProperty(chromium, 'launch', originalOwn) : delete chromium.launch;
  const promise = Promise.resolve('unchanged');
  assert.equal(observeControlWindow(off, 'fixture', chromium, () => promise), promise);
  const phases = [
    ['launch', 'control.browser_launch'], ['context', 'control.context_create'],
    ['route', 'control.route_register'], ['page', 'control.page_create'], ['goto', 'control.page_goto'],
  ];
  function objects(failureAt, failure, closeFailure) {
    const calls = [], descriptors = [];
    const run = (kind, receiver, expected, args, answer) => {
      assert.equal(receiver, expected); calls.push({ kind, args });
      if (kind === failureAt) {
        if (kind === 'context') throw failure; // Synchronous throw also preserves identity.
        return Promise.reject(failure);
      }
      if (kind === 'close' && closeFailure) return Promise.reject(closeFailure);
      return Promise.resolve(answer);
    };
    const page = {
      goto(...args) { return run('goto', this, page, args); },
      on(...args) { assert.equal(this, page); calls.push({ kind: 'on', args }); },
      once(...args) { assert.equal(this, page); calls.push({ kind: 'once', args }); },
    };
    const context = {
      route(...args) { return run('route', this, context, args); },
      newPage(...args) { return run('page', this, context, args, page); },
    };
    const browser = {
      newContext(...args) { return run('context', this, browser, args, context); },
      close(...args) { return run('close', this, browser, args); },
    };
    for (const object of [browser, context, page]) descriptors.push([object, Object.getOwnPropertyDescriptors(object)]);
    function launch(...args) { return run('launch', this, chromium, args, browser); }
    return { calls, descriptors, launch, browser, context, page };
  }
  try {
    for (const [failed, boundary] of phases) {
      const marker = Object.assign(new Error('private-marker'), { code: 'ENOENT' });
      const mock = objects(failed, marker); installFake(mock.launch);
      const fakeDescriptor = Object.getOwnPropertyDescriptor(chromium, 'launch');
      await assert.rejects(observeControlWindow(trace, 'fixture', chromium,
        () => openControlWindow(url, { headless: true })), error => error === marker);
      assert.deepEqual(Object.getOwnPropertyDescriptor(chromium, 'launch'), fakeDescriptor);
      for (const [object, before] of mock.descriptors) assert.deepEqual(Object.getOwnPropertyDescriptors(object), before);
      const kinds = mock.calls.map(call => call.kind);
      assert.deepEqual(kinds.filter(kind => ['launch', 'context', 'route', 'page', 'goto'].includes(kind)),
        phases.slice(0, phases.findIndex(([name]) => name === failed) + 1).map(([name]) => name));
      assert.equal(kinds.includes('close'), failed !== 'launch');
      const emitted = (await readFile(file, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line.slice('KTZ_LIFETIME:'.length)));
      assert.ok(emitted.some(event => event.boundary === boundary && event.event === 'error' && event.errorCode === 'ENOENT'));
      if (failed !== 'launch') assert.ok(emitted.some(event => event.boundary === 'control.browser_close' && event.event === 'end'));
      assert.deepEqual(mock.calls[0].args, [{ headless: true }]);
      if (mock.calls.some(call => call.kind === 'context')) assert.deepEqual(mock.calls.find(call => call.kind === 'context').args,
        [{ viewport: { width: 1100, height: 850 }, colorScheme: 'light', acceptDownloads: false, serviceWorkers: 'block' }]);
      if (mock.calls.some(call => call.kind === 'route')) {
        const [pattern, handler] = mock.calls.find(call => call.kind === 'route').args;
        assert.equal(pattern, '**/*'); assert.equal(typeof handler, 'function');
        let outcome;
        handler({ request: () => ({ url: () => 'http://127.0.0.1:4321/allowed' }), continue: () => { outcome = 'continue'; } });
        assert.equal(outcome, 'continue');
        handler({ request: () => ({ url: () => 'https://other.invalid/' }), abort: code => { outcome = code; } });
        assert.equal(outcome, 'blockedbyclient');
      }
      if (mock.calls.some(call => call.kind === 'goto')) assert.deepEqual(mock.calls.find(call => call.kind === 'goto').args,
        [url, { waitUntil: 'domcontentloaded', timeout: 20_000 }]);
    }
    const marker = new Error('private close'), navigation = new Error('private navigation');
    const mock = objects('goto', navigation, marker); installFake(mock.launch);
    await assert.rejects(observeControlWindow(trace, 'fixture', chromium,
      () => openControlWindow(url, { headless: true })), error => {
      assert.ok(error instanceof AggregateError); assert.equal(error.cause, navigation);
      assert.deepEqual(error.errors, [navigation, marker]); return true;
    });
    for (const [object, before] of mock.descriptors) assert.deepEqual(Object.getOwnPropertyDescriptors(object), before);

    // An explicit off call nested in an on scope must not inherit its token.
    const quiet = objects(), resumed = objects(); let current = quiet;
    installFake(function (...args) { return Reflect.apply(current.launch, this, args); });
    const nestedDescriptor = Object.getOwnPropertyDescriptor(chromium, 'launch');
    const beforeNested = await readFile(file, 'utf8');
    await observeControlWindow(trace, 'enabled outer', chromium, async () => {
      const control = await observeControlWindow(off, 'disabled public caller', chromium,
        () => openControlWindow(url, { headless: true }));
      assert.equal(control.browser, quiet.browser);
      assert.equal((await readFile(file, 'utf8')).length, beforeNested.length);
      for (const [object, before] of quiet.descriptors) assert.deepEqual(Object.getOwnPropertyDescriptors(object), before);
      await control.close();
      assert.equal((await readFile(file, 'utf8')).length, beforeNested.length);
      current = resumed;
      const observed = await openControlWindow(url, { headless: true });
      assert.equal(observed.browser, resumed.browser);
      await observed.close();
    });
    assert.deepEqual(Object.getOwnPropertyDescriptor(chromium, 'launch'), nestedDescriptor);
    for (const [object, before] of resumed.descriptors) assert.deepEqual(Object.getOwnPropertyDescriptors(object), before);
    const nestedEvents = (await readFile(file, 'utf8')).slice(beforeNested.length).trim().split('\n')
      .map(line => JSON.parse(line.slice('KTZ_LIFETIME:'.length)));
    assert.ok(nestedEvents.every(event => event.test === 'enabled outer'));
    for (const boundary of [...phases.map(([, boundary]) => boundary), 'control.browser_close']) {
      assert.ok(nestedEvents.some(event => event.boundary === boundary && event.event === 'start'));
      assert.ok(nestedEvents.some(event => event.boundary === boundary && event.event === 'end'));
    }

    const launchOptions = { headless: true }, offPromise = Promise.resolve('unchanged');
    installFake(function (...args) {
      assert.equal(this, chromium); assert.deepEqual(args, [launchOptions]); return offPromise;
    });
    const beforeOff = await readFile(file, 'utf8');
    await observeControlWindow(trace, 'enabled outer', chromium, () => {
      const result = observeControlWindow(off, 'disabled promise', chromium, () => chromium.launch(launchOptions));
      assert.equal(result, offPromise);
      assert.throws(() => observeControlWindow(off, 'disabled throw', chromium, () => { throw marker; }), error => error === marker);
      return result;
    });
    assert.equal(await readFile(file, 'utf8'), beforeOff);

    // The same observer in use does not intercept an unrelated async context.
    const good = objects(), concurrent = objects(); let release, controlLaunches = 0;
    const gate = new Promise(resolve => { release = resolve; });
    const unrelatedPromise = Promise.resolve('unrelated');
    installFake(function (options) {
      assert.equal(this, chromium);
      if (options.unrelated) return unrelatedPromise;
      if (++controlLaunches === 1) return gate.then(() => Reflect.apply(good.launch, this, [options]));
      return Reflect.apply(concurrent.launch, this, [options]);
    });
    const descriptor = Object.getOwnPropertyDescriptor(chromium, 'launch');
    const controlPromise = observeControlWindow(trace, 'fixture', chromium, () => openControlWindow(url, { headless: true }));
    const beforeOther = await readFile(file, 'utf8');
    assert.equal(chromium.launch({ unrelated: true }), unrelatedPromise);
    const otherControl = await observeControlWindow(trace, 'concurrent fixture', chromium,
      () => openControlWindow(url, { headless: true }));
    assert.equal(otherControl.browser, concurrent.browser);
    for (const [object, before] of concurrent.descriptors) assert.deepEqual(Object.getOwnPropertyDescriptors(object), before);
    await otherControl.close();
    assert.equal(await readFile(file, 'utf8'), beforeOther);
    release(); const control = await controlPromise;
    assert.equal(control.browser, good.browser); assert.equal(control.context, good.context); assert.equal(control.page, good.page);
    assert.deepEqual(Object.getOwnPropertyDescriptor(chromium, 'launch'), descriptor);
    for (const [object, before] of good.descriptors) assert.deepEqual(Object.getOwnPropertyDescriptors(object), before);
    await trace.step('fixture', 'control.browser_close', () => control.close());
    const text = await readFile(file, 'utf8');
    assert.match(text, /"boundary":"control.browser_close","event":"error"/);
    assert.doesNotMatch(text, /private|127\.0\.0\.1|other\.invalid|aaaaaaa/);
  } finally { restoreChromium(); }
});

test('Windows収集: 整合したTAP失敗は収集完了、欠落・矛盾・CIM不明は区別する', async () => {
  const root = await sandbox(), helper = new URL('./support/test-lifetime.mjs', import.meta.url).href;
  const observer = new URL('./support/control-lifetime.mjs', import.meta.url).href;
  const product = new URL('../app/control-window.mjs', import.meta.url).href;
  const failureSource = `import nodeTest from 'node:test'; import {chromium} from 'playwright';
    import {createLifetime} from ${JSON.stringify(helper)}; import {observeControlWindow} from ${JSON.stringify(observer)};
    import {openControlWindow} from ${JSON.stringify(product)};
    const trace=createLifetime(),test=trace.instrument(nodeTest);
    test('fixture fail',async t=>{t.after(()=>{});await new Promise(r=>setTimeout(r,220));
      const before=Object.getOwnPropertyDescriptor(chromium,'launch');
      Object.defineProperty(chromium,'launch',{configurable:true,writable:true,value:()=>Promise.reject(Object.assign(new Error('secret-message'),{code:'EACCES'}))});
      try {await trace.step(t,'region.control',()=>observeControlWindow(trace,t,chromium,
        ()=>openControlWindow('http://127.0.0.1:4321/#'+'a'.repeat(64),{headless:true})));}
      finally {if(before)Object.defineProperty(chromium,'launch',before);else delete chromium.launch;}});`;
  const bad = await fixture(root, failureSource, { requireTap: true, expectedTests: ['fixture fail'] });
  assert.equal(bad.result.outcome, 'failed'); assert.equal(bad.result.testOutcome, 'failed');
  assert.equal(bad.result.collectionOutcome, 'complete'); assert.equal(bad.result.collectionError, null);
  assert.equal(bad.result.cleanupOutcome, 'none-observed'); assert.deepEqual(bad.result.childExit, { code: 1, signal: null });
  assert.ok(bad.result.events.some(event => event.boundary === 'after_hook.1' && event.event === 'end'));
  for (const boundary of ['region.control', 'control.browser_launch']) {
    assert.ok(bad.result.events.some(event => event.boundary === boundary && event.event === 'error'
      && event.errorClass === 'os' && event.errorCode === 'EACCES' && Number.isFinite(event.elapsedMs)));
    assert.match(bad.output, new RegExp(`"boundary":"${boundary.replace('.', '\\.')}","event":"error"`));
  }
  assert.equal(bad.result.events.some(event => event.boundary === 'control.browser_close'), false);
  assert.doesNotMatch(bad.output, /secret-message/);

  const summary = `console.log('ok 1 - private');console.log('# tests 1\\n# pass 1\\n# fail 0\\n# cancelled 0\\n# skipped 0');`;
  const exitMismatch = await fixture(root, `${summary}setTimeout(()=>process.exit(7),220)`, { requireTap: true });
  assert.equal(exitMismatch.result.outcome, 'failed'); assert.equal(exitMismatch.result.testOutcome, 'unknown');
  assert.equal(exitMismatch.result.collectionOutcome, 'incomplete'); assert.equal(exitMismatch.result.collectionError, 'tap_summary_unconfirmed');
  assert.equal(exitMismatch.result.cleanupOutcome, 'none-observed');
  const missing = await fixture(root, `console.log('ok 1 - private');console.log('# tests 1\\n# pass 1\\n# fail 0');setTimeout(()=>{},220)`, { requireTap: true });
  assert.equal(missing.result.collectionOutcome, 'incomplete'); assert.equal(missing.result.collectionError, 'tap_summary_unconfirmed');
  assert.equal(missing.result.cleanupOutcome, 'none-observed');
  const missingResult = await fixture(root, `console.log('# tests 1\\n# pass 1\\n# fail 0\\n# cancelled 0\\n# skipped 0');setTimeout(()=>{},220)`, { requireTap: true });
  assert.equal(missingResult.result.collectionOutcome, 'incomplete'); assert.equal(missingResult.result.collectionError, 'tap_summary_unconfirmed');
  const bodyMismatchSource = `import {appendFileSync} from 'node:fs';
    for(const [test,boundary,event] of [['fixture conflict','test','begin'],['fixture conflict','test_body','error'],
      ['fixture conflict','test','end'],['process','process_exit','complete']])
      appendFileSync(process.env.KTZ_LIFETIME_EVENT_FILE,'KTZ_LIFETIME:'+JSON.stringify({pid:process.pid,test,boundary,event,monotonicMs:performance.now()})+'\\n');
    ${summary}setTimeout(()=>{},220)`;
  const bodyMismatch = await fixture(root, bodyMismatchSource, { requireTap: true, expectedTests: ['fixture conflict'] });
  assert.equal(bodyMismatch.result.testOutcome, 'unknown'); assert.equal(bodyMismatch.result.outcome, 'failed');
  assert.equal(bodyMismatch.result.collectionError, 'test_lifecycle_unconfirmed');
  assert.equal(bodyMismatch.result.collectionOutcome, 'incomplete');
  const corrupt = await fixture(root, `import {appendFileSync} from 'node:fs';appendFileSync(process.env.KTZ_LIFETIME_EVENT_FILE,'corrupt-private\\n');setTimeout(()=>{},220)`);
  assert.equal(corrupt.result.collectionOutcome, 'incomplete'); assert.equal(corrupt.result.collectionError, 'invalid_lifetime_event');
  // Depending on when the corrupt line is noticed, the final ownership scan
  // may or may not already have completed; never infer it from the error.
  assert.ok(['unknown', 'none-observed'].includes(corrupt.result.cleanupOutcome));
  assert.doesNotMatch(corrupt.output, /corrupt-private/);
  const badCode = await fixture(root, `import {appendFileSync} from 'node:fs';
    appendFileSync(process.env.KTZ_LIFETIME_EVENT_FILE,'KTZ_LIFETIME:'+JSON.stringify({pid:process.pid,test:'fixture',
      boundary:'region.control',event:'error',monotonicMs:performance.now(),errorClass:'os',errorCode:'secret_profile',message:'secret_message'})+'\\n');
    setTimeout(()=>{},220)`);
  assert.equal(badCode.result.collectionError, 'invalid_lifetime_event'); assert.equal(badCode.result.collectionOutcome, 'incomplete');
  assert.doesNotMatch(badCode.output, /secret_profile|secret_message/);
  const unseen = await fixture(root, 'setInterval(()=>{},1000)', { backendFactory() {
    return { async query() { throw Object.assign(new Error('private'), { code: 'monitor_command_timeout' }); } };
  } });
  assert.equal(unseen.result.collectionOutcome, 'incomplete'); assert.equal(unseen.result.cleanupOutcome, 'unknown');
  assert.equal(unseen.result.remainingState, 'unknown'); assert.equal(unseen.result.remainingProcesses.length, 0);
  assert.equal(unseen.result.outcome, 'failed');
  let afterExitQueries = 0;
  const finalUnknown = await fixture(root, 'setTimeout(()=>process.exit(0),220)', { backendFactory(child) {
    const base = backendFor(child);
    return { ...base, async query() {
      if (child.exitCode !== null) {
        if (++afterExitQueries === 1) return []; // Empty sample, not the final confirmation.
        throw Object.assign(new Error('private'), { code: 'monitor_command_timeout' });
      }
      return base.query();
    } };
  } });
  assert.ok(afterExitQueries >= 2); assert.equal(finalUnknown.result.collectionError, 'monitor_command_timeout');
  assert.equal(finalUnknown.result.remainingProcesses.length, 0); assert.equal(finalUnknown.result.cleanupOutcome, 'unknown');
  assert.equal(finalUnknown.result.collectionOutcome, 'incomplete'); assert.equal(finalUnknown.result.outcome, 'failed');
});
