import './chromium-test-log-sink.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { SampleProbe } from '../poc/browser/probe.mjs';
import { RustGuard, GuardedSample, guardExecutable } from '../poc/browser/rust-guard.mjs';

test('Rust実行ファイルとの版付きIPCで明示開始と安全停止を実行', async t => {
  const guard = new RustGuard();
  t.after(() => guard.close());
  await assert.rejects(guard.transition('ExplicitStart'), /rust_request_rejected/);
  assert.equal(await guard.transition('ApprovePreview'), 'Ready');
  await assert.rejects(guard.requireCapturing(), /not_authorized/);
  assert.equal(await guard.transition('ExplicitStart'), 'Capturing');
  await guard.requireCapturing();
  assert.equal(await guard.transition('EndCandidate'), 'NeedsAttention');
  await assert.rejects(guard.requireCapturing(), /not_authorized/);
});

test('Win32の受動観測をRustで実行し、開始から停止まで採取', async t => {
  const guard = new RustGuard();
  t.after(() => guard.close());
  await guard.request({ kind: 'observe_start' });
  await new Promise(resolve => setTimeout(resolve, 80));
  const { observation } = await guard.request({ kind: 'observe_stop' });
  assert.ok(observation.samples >= 2);
  assert.ok(observation.elapsed_ms >= 50);
  assert.equal(typeof observation.initial.cursor_valid, 'boolean');
  assert.equal(typeof observation.last.foreground_pid, 'number');
});

test('Rust子が消失したら許可を再利用せず閉じられる', async t => {
  const guard = new RustGuard();
  t.after(() => guard.close());
  await guard.transition('ApprovePreview');
  await guard.transition('ExplicitStart');
  guard.child.kill();
  await guard.exited;
  await assert.rejects(guard.requireCapturing(), /unavailable/);
});

test('要求IDの再利用を拒否し、それ以降の操作を実行しない', () => {
  const input = [
    { version: 1, id: 1, command: { kind: 'state' } },
    { version: 1, id: 1, command: { kind: 'transition', event: 'ApprovePreview' } },
    { version: 1, id: 2, command: { kind: 'state' } },
  ].map(request => JSON.stringify(request) + '\n').join('');
  const run = spawnSync(guardExecutable, [], { input, encoding: 'utf8', timeout: 3000, windowsHide: true });
  assert.equal(run.status, 0, run.stderr);
  const responses = run.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.equal(responses.length, 2);
  assert.equal(responses[0].payload.state, 'Preview');
  assert.equal(responses[1].code, 'protocol_mismatch');
});

for (const [name, input, expected] of [
  ['未知コマンド', JSON.stringify({ version: 1, id: 1, command: { kind: 'run_shell' } }) + '\n', 'invalid_request'],
  ['余分な入力欄', JSON.stringify({ version: 1, id: 1, command: { kind: 'state', secret: 'DO-NOT-ECHO' } }) + '\n', 'invalid_request'],
  ['未知版', JSON.stringify({ version: 2, id: 1, command: { kind: 'state' } }) + '\n', 'protocol_mismatch'],
  ['上限超過', 'x'.repeat(65_537) + '\n', 'invalid_frame'],
]) {
  test(`Rust IPCは${name}を拒否し生入力を返さない`, () => {
    const run = spawnSync(guardExecutable, [], { input, encoding: 'utf8', timeout: 3000, windowsHide: true });
    assert.equal(run.status, 0, run.stderr);
    const message = JSON.parse(run.stdout);
    assert.equal(message.ok, false);
    assert.equal(message.code, expected);
    assert.equal(run.stdout.includes('DO-NOT-ECHO'), false);
  });
}

for (const [control, expectedState] of [['stop', 'Review'], ['pause', 'Paused']]) {
  test(`Rust結合：撮影許可の照会中の${control}を失わない`, async t => {
    const guard = new RustGuard();
    t.after(() => guard.close());
    const sample = await SampleProbe.open();
    t.after(() => sample.close());
    const bridge = new GuardedSample(sample, guard);
    await bridge.approveAndStart();

    const capture = bridge.capture();
    await Promise.all([
      assert.rejects(capture, error => error.code === 'cancelled'),
      bridge[control](),
    ]);
    assert.equal(sample.state, expectedState);
    assert.equal((await guard.request({ kind: 'state' })).state, expectedState);
    assert.equal(sample.captureRequests, 0);
    assert.equal(sample.advanceRequests, 0);
    assert.deepEqual(await readdir(sample.directory), []);
    await assert.rejects(bridge.capture(), error => error.code === 'wrong_state');
    await assert.rejects(bridge.advance(), error => error.code === 'wrong_state');
    assert.equal(sample.state, expectedState);
    assert.equal((await guard.request({ kind: 'state' })).state, expectedState);
  });

  test(`Rust結合：送りのreadGuard照会中の${control}を失わない`, async t => {
    const guard = new RustGuard();
    t.after(() => guard.close());
    const sample = await SampleProbe.open();
    t.after(() => sample.close());
    const bridge = new GuardedSample(sample, guard);
    await bridge.approveAndStart();
    const first = await bridge.capture();
    const original = await readFile(path.join(sample.directory, first.file));
    let controlResult;
    sample.readGuard = async () => {
      const snapshot = guard.request({ kind: 'snapshot' });
      if (!controlResult) {
        controlResult = bridge[control]();
        // Keep a handler attached while the interrupted operation settles.
        controlResult.catch(() => {});
      }
      await snapshot;
    };

    await assert.rejects(bridge.advance(), error => error.code === 'cancelled');
    assert.ok(controlResult);
    await controlResult;
    assert.equal(sample.state, expectedState);
    assert.equal((await guard.request({ kind: 'state' })).state, expectedState);
    assert.equal(sample.advanceRequests, 0);
    assert.deepEqual(sample.images, [first]);
    assert.deepEqual(await readdir(sample.directory), [first.file]);
    assert.deepEqual(await readFile(path.join(sample.directory, first.file)), original);
  });
}

for (const [control, expectedState] of [[null, 'NeedsAttention'], ['stop', 'Review'], ['pause', 'Paused']]) {
  test(`Rust結合：書込み待ちの子消失で未確定画像を破棄し${expectedState}を保持`, async t => {
    const guard = new RustGuard();
    t.after(() => guard.close());
    const sample = await SampleProbe.open();
    t.after(() => sample.close());
    const bridge = new GuardedSample(sample, guard);
    await bridge.approveAndStart();
    const first = await bridge.capture();
    const original = await readFile(path.join(sample.directory, first.file));
    await bridge.advance();
    const pending = path.join(sample.directory, '000002.png');
    const originalWrite = fs.promises.writeFile;
    let interrupted = false;
    t.mock.method(fs.promises, 'writeFile', async (...args) => {
      const result = await originalWrite(...args);
      if (args[0] === pending) {
        interrupted = true;
        if (control) await bridge[control]();
        guard.child.kill();
        await guard.exited;
      }
      return result;
    });
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });

    await assert.rejects(bridge.capture(), error => error.code === 'cancelled');
    assert.equal(interrupted, true);
    assert.equal(guard.failed, true);
    assert.equal(sample.state, expectedState);
    assert.deepEqual(sample.images, [first]);
    assert.equal(sample.lastCapturedPosition, 1);
    assert.deepEqual(await readdir(sample.directory), [first.file]);
    assert.deepEqual(await readFile(path.join(sample.directory, first.file)), original);
    await assert.rejects(guard.requireCapturing(), /unavailable/);
  });
}
