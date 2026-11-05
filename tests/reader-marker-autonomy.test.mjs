import './chromium-test-log-sink.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, lstat, rm, realpath } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { observeBoundKindle } from '../app/linux-reader-probe.mjs';

test('限定観測: binding失効・未知probe・期限では別対象やmetadataに進まない', async t => {
  const value = { state: 'ok', title: '匿名の本', position: { value: 2, min: 0, max: 10 },
    region: { width: 640, height: 480, visibleWidth: 640, visibleHeight: 480 }, extra: 'not-projected' };
  await t.test('返すcontainerと位置・領域を維持し余分なfieldは捨てる', async () => {
    let reads = 0;
    const observed = await observeBoundKindle({ isCurrent: () => true, probe: () => ({ state: 'ready' }), read: () => { reads++; return value; } });
    assert.deepEqual(observed, { title: value.title, position: value.position, region: value.region });
    assert.equal(reads, 1);
  });
  await t.test('未bindingと同一target内失効', async () => {
    let reads = 0, checks = 0;
    await assert.rejects(observeBoundKindle({ isCurrent: () => false,
      probe: () => { throw new Error('must_not_probe'); }, read: () => { reads++; } }), { code: 'inspect_binding_changed' });
    await assert.rejects(observeBoundKindle({ isCurrent: () => ++checks < 2,
      probe: () => ({ state: 'ready' }), read: () => { reads++; } }), { code: 'inspect_binding_changed' });
    assert.equal(reads, 0);
  });
  await t.test('metadata読取後に失効しても結果を公開しない', async () => {
    let checks = 0;
    await assert.rejects(observeBoundKindle({ isCurrent: () => ++checks < 3,
      probe: () => ({ state: 'ready' }), read: () => value }), { code: 'inspect_binding_changed' });
  });
  await t.test('pending評価とhiddenの待機は有限で終える', async () => {
    for (const probe of [() => new Promise(() => {}), () => ({ state: 'unavailable', reason: 'reader-identity-hidden' })]) {
      let reads = 0;
      await assert.rejects(observeBoundKindle({ isCurrent: () => true, probe,
        read: () => { reads++; }, deadlineMs: 40, intervalMs: 10 }), { code: 'inspect_readiness_timeout', timedOut: true });
      assert.equal(reads, 0);
    }
  });
  await t.test('未知の理由・例外を反射しない', async () => {
    for (const probe of [() => ({ state: 'unavailable', reason: 'PRIVATE_BODY_ACCOUNT_URL' }), () => { throw new Error('PRIVATE_BODY_ACCOUNT_URL'); }]) {
      await assert.rejects(observeBoundKindle({ isCurrent: () => true, probe, read: () => value }), error => {
        assert.doesNotMatch(JSON.stringify(error) + error.message, /PRIVATE_BODY_ACCOUNT_URL/); return true;
      });
    }
  });
});

if (process.platform === 'linux' && process.env.KTZ_DESKTOP_TESTS === '1') test('Playwright匿名Snap: 既知UIの自動観測・対象失効・初期化読取の限界', { timeout: 120_000 }, async () => {
  const profileBase = '/home/user/snap/chromium/common/ktz-pw-probe-20261101-8f13e1b6';
  const outputBase = '/tmp/opencode/ktz-reader-probe-20261101-8f13e1b6';
  for (const base of [profileBase, outputBase]) {
    await mkdir(base, { recursive: true, mode: 0o700 });
    const info = await lstat(base);
    assert.ok(info.isDirectory() && !info.isSymbolicLink() && info.uid === process.geteuid() && (info.mode & 0o7777) === 0o700);
    assert.equal(await realpath(base), base);
  }
  const root = await mkdtemp(path.join(profileBase, 'run-'));
  const before = await lstat(root);
  const output = path.join(await mkdtemp(path.join(outputBase, 'run-')), 'result.json');
  const fixture = fileURLToPath(new URL('./support/playwright-reader-probe-fixture.mjs', import.meta.url));
  const run = spawnSync(process.execPath, [fixture], { cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8', timeout: 90000,
    env: { ...process.env, NODE_OPTIONS: '', DEBUG: '', PWDEBUG: '', KTZ_PW_PROBE_ROOT: root, KTZ_PW_PROBE_OUTPUT: output } });
  assert.equal(run.error, undefined);
  assert.doesNotMatch(run.stdout + run.stderr, /PW_FIXTURE_(?:URL|TITLE|CONSOLE|BODY)_SENTINEL|pw:protocol|Network\.requestWillBeSent/);
  const result = JSON.parse(await readFile(output, 'utf8'));
  // Keep the anonymous profile on every unknown exit/lock/identity condition.
  if (result.normalExit && result.groupGone && result.lockReleased) {
    const current = await lstat(root);
    assert.ok(current.isDirectory() && current.dev === before.dev && current.ino === before.ino && current.uid === before.uid && current.mode === before.mode);
    await rm(root, { recursive: true });
  }
  assert.equal(run.status, 0, JSON.stringify({ status: result.status, failurePhase: result.failurePhase }));
  assert.equal(result.status, 'ok'); assert.equal(result.cases.length, 13);
  assert.ok(Object.values(result.bootstrap).every(Boolean), 'アプリ側consumerなしでもframe/network/console等を内部取得する');
  assert.equal(result.sandboxAndKeyringFlagsPreserved, true);
  assert.equal(result.inspection.forbiddenCommand, false);
  assert.ok(result.cases.every(item => item.inputUnchanged));
});
