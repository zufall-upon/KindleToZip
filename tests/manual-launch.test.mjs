import './chromium-test-log-sink.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { openKindleForUser } from '../app/startup.mjs';
import { Reader, configureReaderNetwork, readerContextOptions } from '../app/reader.mjs';
import { startApplication } from '../app/server.mjs';
import { openControlWindow } from '../app/control-window.mjs';
import { controllerPath } from '../app/controller-path.mjs';
import { StoreClient } from '../app/store-client.mjs';
import { RustGuard, guardExecutable } from '../poc/browser/rust-guard.mjs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, rm, readdir, lstat, readFile, writeFile, rename, symlink, link, truncate, utimes, statfs, unlink } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { existsSync } from 'node:fs';
import { linuxStartupMessage } from '../app/startup-error.mjs';
import { chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { PNG } from 'pngjs';
import { EventEmitter } from 'node:events';
import { prepareLinuxLoginProfile, runLinuxLogin, snapLoginPreflight } from '../app/linux-login-core.mjs';
import { resolvePortableLinuxSession } from '../app/portable-linux-session.mjs';
import { copyVerifiedLinuxProfile } from '../app/linux-profile-copy.mjs';
import { migrateLinuxLogin, confirmLinuxLoginMigration, rollbackLinuxLoginMigration } from '../app/linux-profile-migration.mjs';
import { fingerprintLinuxProfile } from '../app/linux-profile-copy.mjs';
import { migrationToolPreflight, runFixedPortableMigration } from '../app/linux-portable-migration.mjs';
const { chromium } = await import('playwright');

if (process.platform === 'linux') test('Linux専用表示確認: 匿名pipe診断を実入口で固定分類し秘密を反映しない', { timeout: 30_000 }, async t => {
  const entry = fileURLToPath(new URL('../app/linux-inspect.mjs', import.meta.url));
  const hook = new URL('./support/linux-inspect-protocol-fixture.mjs', import.meta.url).href;
  const cases = [
    ['ok', null, null],
    ['cancel', 'confirmation', 'confirmation-cancelled'],
    ['dialog-unavailable', 'confirmation', 'confirmation-unavailable'],
    ['confirmation-exit-error', 'confirmation', 'confirmation-unavailable'],
    ['confirmation-display-error', 'confirmation', 'confirmation-unavailable'],
    ['confirmation-signal', 'confirmation', 'confirmation-unavailable'],
    ['browser-ended', 'confirmation', 'browser-ended-during-confirmation'],
    ['unknown-preflight', 'preflight-or-start', 'unclassified'],
    ['no-targets', 'target-selection', 'no-page-target'],
    ['multiple-targets', 'target-selection', 'multiple-page-targets'],
    ['invalid-targets', 'target-selection', 'invalid-result'],
    ['attach-error', 'target-attach', 'protocol-error'],
    ['world-invalid', 'isolated-world', 'invalid-result'],
    ['missing-marker', 'metadata', 'reader-identity-missing'],
    ['blocking-ui', 'metadata', 'blocking-ui'],
    ['wrong-origin', 'metadata', 'document-unavailable'],
    ['metadata-exception', 'metadata', 'metadata-exception'],
    ['metadata-missing', 'metadata', 'metadata-missing'],
    ['unknown-reason', 'metadata', 'metadata-missing'],
    ['pipe-closed', 'target-selection', 'pipe-closed'],
    ['pipe-error', 'target-selection', 'pipe-error'],
    ['malformed', 'target-selection', 'invalid-response'],
    ['null-response', 'target-selection', 'invalid-response'],
    ['oversized', 'target-selection', 'response-too-large'],
    ['timeout', 'target-selection', 'response-timeout'],
    ['document-changed', 'document-recheck', 'target-changed'],
    ['target-changed', 'target-recheck', 'target-changed'],
    ['detach-error', 'detach', 'protocol-error'],
    ['marker-and-detach-error', 'metadata', 'reader-identity-missing'],
    ['notification-unavailable', 'notification', 'notification-unavailable'],
    ['notification-exit-error', 'notification', 'notification-unavailable'],
    ['notification-display-error', 'notification', 'notification-unavailable'],
    ['notification-signal', 'notification', 'notification-unavailable'],
    ['notification-dismissed', null, null],
    ['notification-browser-ended', null, null],
    ['marker-and-notification-error', 'metadata', 'reader-identity-missing'],
    ['marker-and-notification-display-error', 'metadata', 'reader-identity-missing'],
    ['close-unconfirmed', 'browser-close', 'browser-close-unconfirmed'],
  ];
  for (const [mode, stage, reason] of cases) await t.test(mode, () => {
    const result = spawnSync(process.execPath, [entry], { encoding: 'utf8', timeout: 8000,
      env: { ...process.env, NODE_OPTIONS: `--import=${hook}`, KTZ_INSPECT_PROTOCOL_CASE: mode } });
    assert.equal(result.error, undefined); assert.equal(result.signal, null);
    assert.equal(result.status, stage ? 1 : 0, result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, /FIXTURE_PRIVATE|example\.invalid|synthetic-home|Error:|at file:/);
    const trace = JSON.parse(result.stdout.split('\n').find(line => line.startsWith('{"fixture"'))).fixture;
    if (mode === 'unknown-preflight') assert.deepEqual(trace.commands, []);
    else {
      assert.equal(trace.childClosed, true, '本人に相当する通常終了までjoin');
      assert.deepEqual(trace.dialogs, ['confirmation', 'notification']);
    }
    if (['cancel', 'dialog-unavailable', 'browser-ended', 'confirmation-exit-error', 'confirmation-display-error', 'confirmation-signal'].includes(mode)) assert.deepEqual(trace.commands, [], '確認不成立ではCDPを送らない');
    if (['browser-ended', 'notification-browser-ended'].includes(mode)) assert.ok(trace.dialogKills >= 1, 'browser終了後は所有dialogだけを閉じる');
    if (['missing-marker', 'blocking-ui', 'wrong-origin'].includes(mode)) assert.equal(trace.titleReads, 0, '拒否した画面の文字を読まない');
    if (stage) {
      assert.doesNotMatch(result.stdout, /表示状態のみ|架空の本/);
      const line = result.stderr.split('\n').find(value => value.startsWith('表示確認の診断: '));
      assert.deepEqual(JSON.parse(line.slice('表示確認の診断: '.length)), { stage, reason });
      assert.equal(result.stderr.trim().split('\n').length, 2, '固定案内とenum以外を出さない');
    } else {
      assert.equal(result.stderr, '');
      assert.deepEqual(trace.commands, ['Target.getTargets', 'Target.attachToTarget', 'Page.createIsolatedWorld',
        'Runtime.evaluate', 'Runtime.evaluate', 'Target.getTargets', 'Target.detachFromTarget']);
      const line = result.stdout.split('\n').find(value => value.startsWith('{"種別"'));
      assert.deepEqual(JSON.parse(line), { 種別: '表示状態のみ', 書名: '架空の本', 位置: { value: 42, min: 0, max: 100 },
        領域: { width: 640, height: 480, visibleWidth: 640, visibleHeight: 480 } });
    }
  });
});

if (process.platform === 'linux') test('Linux専用表示確認: 固定入口と所有・排他・終了不明の保護', { timeout: 30_000 }, async t => {
  const base = '/tmp/opencode/ktz-inspect-tests';
  await mkdir(base, { recursive: true, mode: 0o700 });
  const fixture = await mkdtemp(path.join(base, 'unit-'));
  const entry = fileURLToPath(new URL('../app/linux-inspect.mjs', import.meta.url));
  const inspectEntry = await readFile(entry, 'utf8');
  assert.match(inspectEntry, /spawn\('\/usr\/bin\/zenity'/);
  assert.doesNotMatch(inspectEntry, /process\.stdin|node:readline/, '端末の有無やstdin EOFを確認操作にしない');
  const login = await readFile(fileURLToPath(new URL('../app/linux-login.mjs', import.meta.url)), 'utf8');
  assert.match(login, /process\.argv\.length === 2/);
  assert.match(login, /https:\/\/read\.amazon\.co\.jp\//);
  assert.doesNotMatch(login, /linux-inspect|remote-debugging|connectOverCDP/);
  for (const arg of ['https://example.invalid/', '--user-data-dir=/tmp/other', '--remote-debugging-port=9222']) {
    const result = spawnSync(process.execPath, [entry, arg], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 1); assert.doesNotMatch(result.stdout, /確認ダイアログ|表示状態のみ/);
  }
  const mock = (name, overrides = {}) => {
    const child = new EventEmitter(); child.pid = 999999;
    let ready; const started = new Promise(resolve => { ready = resolve; });
    let launchReady; const launched = new Promise(resolve => { launchReady = resolve; });
    let launches = 0;
    const promise = runLinuxLogin({ root: path.join(fixture, name), url: 'about:blank', preflight: async () => {},
      launch: () => { launches++; launchReady(); return child; }, observe: async () => true, groupGone: async () => true,
      onStarted: ready, requireAbsentSingleton: true, joinUnconfirmedStart: true, ...overrides });
    return { child, started, launched, promise, get launches() { return launches; } };
  };
  await t.test('自分のlockを保持中は二重起動を拒否し通常終了でのみ解除', async () => {
    const first = mock('normal'); const started = await first.started;
    await started.assertStillOwned();
    await assert.rejects(mock('normal').promise, { code: 'login_in_use_or_unknown' });
    first.child.emit('close', 0, null); await first.promise;
    await assert.rejects(lstat(path.join(fixture, 'normal/owned/in-use.lock')), { code: 'ENOENT' });
    assert.ok((await lstat(started.profile)).isDirectory());
  });
  await t.test('Singletonが存在すれば接続も削除もせずlockを保持', async () => {
    const first = mock('singleton'); const started = await first.started;
    first.child.emit('close', 0, null); await first.promise;
    const singleton = path.join(started.profile, 'SingletonLock');
    await symlink('unknown-owner', singleton);
    const second = mock('singleton');
    await assert.rejects(second.promise, { code: 'login_in_use_or_unknown' });
    assert.equal(second.launches, 0);
    assert.ok((await lstat(singleton)).isSymbolicLink());
    assert.ok((await lstat(path.join(fixture, 'singleton/owned/in-use.lock'))).isFile());
  });
  await t.test('起動不明は子の終了を待ち、所有identity不一致もlockを保持', async () => {
    const partial = mock('partial', { observe: async () => false });
    await partial.launched;
    let settled = false; partial.promise.then(() => { settled = true; }, () => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 60)); assert.equal(settled, false);
    partial.child.emit('close', 0, null);
    await assert.rejects(partial.promise, { code: 'login_start_unconfirmed' });
    assert.ok((await lstat(path.join(fixture, 'partial/owned/in-use.lock'))).isFile());
    const thrown = mock('observe-error', { observe: async () => { throw new Error('anonymous_observation_error'); } });
    await thrown.launched;
    let thrownSettled = false; thrown.promise.then(() => { thrownSettled = true; }, () => { thrownSettled = true; });
    await new Promise(resolve => setTimeout(resolve, 60)); assert.equal(thrownSettled, false, '観測例外でも所有プロセスの終了を待つ');
    thrown.child.emit('close', 0, null);
    await assert.rejects(thrown.promise, { code: 'login_start_unconfirmed' });
    assert.ok((await lstat(path.join(fixture, 'observe-error/owned/in-use.lock'))).isFile());
    const changed = mock('changed'); const started = await changed.started;
    await chmod(started.profile, 0o755);
    await assert.rejects(started.assertStillOwned(), { code: 'unsafe_login_directory' });
    changed.child.emit('close', 0, null);
    await assert.rejects(changed.promise, { code: 'unsafe_login_directory' });
    assert.ok((await lstat(path.join(fixture, 'changed/owned/in-use.lock'))).isFile());
  });
  await t.test('既存profileがなければ新規作成も起動もしない', async () => {
    const missing = mock('missing', { requireExistingProfile: true });
    await assert.rejects(missing.promise, { code: 'ENOENT' });
    assert.equal(missing.launches, 0);
    await assert.rejects(lstat(path.join(fixture, 'missing')), { code: 'ENOENT' });
  });
  await t.test('子の終了だけではgroup終了不明を成功にしない', async () => {
    const unknown = mock('group-unknown', { groupGone: async () => false });
    await unknown.started;
    unknown.child.emit('close', 0, null);
    await assert.rejects(unknown.promise, { code: 'login_close_unconfirmed' });
    assert.ok((await lstat(path.join(fixture, 'group-unknown/owned/in-use.lock'))).isFile());
  });
});

if (process.platform === 'linux') test('Linux専用ログイン: 固定公開入口、排他、終了不明と所有不明を保護する', { timeout: 30_000 }, async t => {
  const base = await mkdtemp(path.join(existsSync('/tmp/opencode') ? '/tmp/opencode' : tmpdir(), 'ktz-login-regression-'));
  const entry = fileURLToPath(new URL('../app/linux-login.mjs', import.meta.url));
  const imports = [...(await readFile(entry, 'utf8')).matchAll(/^import\s.*?from\s+['"]([^'"]+)['"]/gm)].map(match => match[1]).sort();
  assert.deepEqual(imports, ['./linux-login-core.mjs', 'node:child_process', 'node:os'].sort(), '取得Application/Reader/controllerを読み込まない');
  for (const argument of ['--kindle', 'https://example.invalid/', '--user-data-dir=/tmp/other']) {
    const result = spawnSync(process.execPath, [entry, argument], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stdout, /開きました/);
  }
  await t.test('匿名initのsymlinkや通常ファイルがあると内容を読まず起動前に拒否', async () => {
    const home = path.join(base, 'fixture-home');
    await mkdir(path.join(home, 'snap/chromium/common/chromium'), { recursive: true, mode: 0o700 });
    const target = path.join(home, 'public-fixture'); await writeFile(target, 'not executable', { mode: 0o600 });
    const init = path.join(home, '.chromium-browser.init');
    await symlink(target, init);
    await assert.rejects(snapLoginPreflight(home), { code: 'snap_personal_init_exists' });
    await rename(init, `${init}-link`);
    await writeFile(init, 'anonymous regular fixture', { mode: 0o600 });
    await assert.rejects(snapLoginPreflight(home), { code: 'snap_personal_init_exists' });
    assert.equal(await readFile(target, 'utf8'), 'not executable');
  });
  const mock = (root, overrides = {}) => {
    const child = new EventEmitter(); child.pid = 123456;
    let startedResolve; const started = new Promise(resolve => { startedResolve = resolve; });
    const calls = [];
    const promise = runLinuxLogin({ root, url: 'about:blank', preflight: async () => calls.push('preflight'),
      launch: (executable, args) => { calls.push({ executable, args }); return child; },
      observe: async () => true, groupGone: async () => true, onStarted: value => startedResolve(value), ...overrides });
    return { child, started, promise, calls };
  };
  await t.test('正常終了と同一profile再利用', async () => {
    const root = path.join(base, 'normal');
    const first = mock(root);
    const { profile } = await first.started;
    assert.equal(first.calls[1].executable, '/snap/bin/chromium');
    assert.deepEqual(first.calls[1].args, [`--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank']);
    assert.equal((await lstat(profile)).mode & 0o7777, 0o700);
    const marker = path.join(root, 'owned', 'owner.json');
    const markerBefore = await readFile(marker, 'utf8');
    await assert.rejects(mock(root).promise, { code: 'login_in_use_or_unknown' });
    first.child.emit('close', 0, null); await first.promise;
    await assert.rejects(lstat(path.join(root, 'owned', 'in-use.lock')), { code: 'ENOENT' });
    const second = mock(root); assert.equal((await second.started).profile, profile);
    second.child.emit('close', 0, null); await second.promise;
    assert.equal(await readFile(marker, 'utf8'), markerBefore);
    assert.ok((await lstat(profile)).isDirectory(), 'profileを削除しない');
  });
  await t.test('起動途中と終了不明は排他を保持し次回拒否', async () => {
    for (const mode of ['partial', 'close-failure', 'group-unknown']) {
      const root = path.join(base, mode);
      const item = mock(root, mode === 'partial' ? { observe: async () => false }
        : mode === 'group-unknown' ? { groupGone: async () => false } : {});
      if (mode !== 'partial') { await item.started; item.child.emit('close', mode === 'close-failure' ? 1 : 0, null); }
      await assert.rejects(item.promise, { code: mode === 'partial' ? 'login_start_unconfirmed' : 'login_close_unconfirmed' });
      assert.ok((await lstat(path.join(root, 'owned', 'in-use.lock'))).isFile());
      assert.ok((await lstat(path.join(root, 'owned', 'profile'))).isDirectory());
      await assert.rejects(mock(root).promise, { code: 'login_in_use_or_unknown' });
    }
  });
  await t.test('所有情報とdirectory identityの変更は削除や修復をしない', async () => {
    const root = path.join(base, 'identity'); const item = mock(root);
    const { profile } = await item.started;
    await chmod(profile, 0o755);
    item.child.emit('close', 0, null);
    await assert.rejects(item.promise, { code: 'unsafe_login_directory' });
    assert.equal((await lstat(profile)).mode & 0o7777, 0o755);
    assert.ok((await lstat(path.join(root, 'owned', 'in-use.lock'))).isFile());
    const unmarked = path.join(base, 'unmarked');
    await mkdir(unmarked, { mode: 0o700 }); await mkdir(path.join(unmarked, 'owned'), { mode: 0o700 });
    await assert.rejects(mock(unmarked).promise, { code: 'ENOENT' });
    assert.deepEqual(await readdir(path.join(unmarked, 'owned')), []);
    const moved = path.join(base, 'moved'); const changing = mock(moved);
    const ownedProfile = (await changing.started).profile;
    await rename(ownedProfile, `${ownedProfile}-original`);
    await mkdir(ownedProfile, { mode: 0o700 });
    changing.child.emit('close', 0, null);
    await assert.rejects(changing.promise, { code: 'login_identity_changed' });
    assert.ok((await lstat(`${ownedProfile}-original`)).isDirectory());
    assert.ok((await lstat(path.join(moved, 'owned', 'in-use.lock'))).isFile());
    const cloned = path.join(base, 'cloned');
    await mkdir(path.join(cloned, 'owned', 'profile'), { recursive: true, mode: 0o700 });
    await writeFile(path.join(cloned, 'owned', 'owner.json'), await readFile(path.join(moved, 'owned', 'owner.json')), { mode: 0o600 });
    await assert.rejects(mock(cloned).promise, { code: 'unsafe_login_marker' });
    assert.ok((await lstat(path.join(cloned, 'owned', 'profile'))).isDirectory(), 'コピーされた所有情報を採用しない');
  });
});

if (process.platform === 'linux') test('Ubuntu Portable: 相対session移動と排他・終了不明・コピー拒否', { timeout: 30_000 }, async t => {
  const base = '/tmp/opencode/ktz-portable-implementation';
  await mkdir(base, { recursive: true, mode: 0o700 });
  const fixture = await mkdtemp(path.join(base, 'session-regression-'));
  const first = path.join(fixture, 'before'), moved = path.join(fixture, 'after');
  await mkdir(first, { mode: 0o700 }); await mkdir(path.join(first, 'data'), { mode: 0o700 });
  const data = path.join(first, 'data/application');
  const selected = await resolvePortableLinuxSession(data);
  assert.match(selected.id, /^saved-[a-f0-9-]{36}$/);
  const owner = async (root, options = {}) => {
    const child = new EventEmitter(); child.pid = 123456;
    let ready; const started = new Promise(resolve => { ready = resolve; });
    const promise = runLinuxLogin({ root, url: 'about:blank', preflight: async () => {},
      requireExistingProfile: true, requireAbsentSingleton: true, launch: () => child,
      observe: async () => true, groupGone: async () => true, onStarted: ready, ...options });
    return { child, started, promise };
  };
  await t.test('正常終了後に全folderをrenameし同じ相対IDとinodeを使う', async () => {
    const item = await owner(selected.root); assert.equal((await item.started).profile, selected.profile);
    const competing = await owner(selected.root);
    await assert.rejects(competing.promise, { code: 'login_in_use_or_unknown' });
    const before = await lstat(selected.profile);
    item.child.emit('close', 0, null); await item.promise;
    await rename(first, moved); await assert.rejects(lstat(first), { code: 'ENOENT' });
    const reader = await resolvePortableLinuxSession(path.join(moved, 'data/application'));
    assert.equal(reader.id, selected.id);
    const after = await lstat(reader.profile);
    assert.deepEqual([after.dev, after.ino], [before.dev, before.ino]);
    const again = await owner(reader.root); assert.equal((await again.started).profile, reader.profile);
    again.child.emit('close', 0, null); await again.promise;
  });
  await t.test('終了不明は所有lockとprofileを残し再起動を拒否', async () => {
    const unknownData = path.join(fixture, 'unknown');
    const session = await resolvePortableLinuxSession(unknownData);
    const item = await owner(session.root, { groupGone: async () => false });
    await item.started; item.child.emit('close', 0, null);
    await assert.rejects(item.promise, { code: 'login_close_unconfirmed' });
    assert.ok((await lstat(session.profile)).isDirectory());
    assert.ok((await lstat(path.join(session.root, 'owned/in-use.lock'))).isFile());
    const retry = await owner(session.root);
    await assert.rejects(retry.promise, { code: 'login_in_use_or_unknown' });
  });
  await t.test('コピーされたmarkerは再束縛・自動採用せず停止', async () => {
    const original = path.join(moved, 'data/application');
    const cloned = path.join(fixture, 'copied');
    await mkdir(path.join(cloned, selected.id, 'owned/profile'), { recursive: true, mode: 0o700 });
    await writeFile(path.join(cloned, selected.id, 'owned/owner.json'),
      await readFile(path.join(original, selected.id, 'owned/owner.json')), { mode: 0o600 });
    await writeFile(path.join(cloned, 'kindle-session.json'), await readFile(path.join(original, 'kindle-session.json')), { mode: 0o600 });
    await assert.rejects(resolvePortableLinuxSession(cloned), { code: 'unsafe_login_marker' });
    assert.ok((await lstat(path.join(cloned, selected.id, 'owned/profile'))).isDirectory());
    assert.ok((await lstat(path.join(cloned, 'portable-login-selection.lock'))).isFile());
    await assert.rejects(resolvePortableLinuxSession(cloned), { code: 'login_in_use_or_unknown' });
  });
});

if (process.platform === 'linux') test('Ubuntu Portable: 未公開copy primitiveは原本と属性を照合し不明領域を保持', { timeout: 30_000 }, async t => {
  const base = '/tmp/opencode/ktz-portable-implementation';
  await mkdir(base, { recursive: true, mode: 0o700 });
  const fixture = await mkdtemp(path.join(base, 'copy-primitive-'));
  async function sample(name) {
    const root = path.join(fixture, name);
    const state = await prepareLinuxLoginProfile(root);
    const file = path.join(state.profile, 'anonymous.dat');
    await writeFile(file, Buffer.from([0, 1, 2, 255, 10]), { mode: 0o640 });
    await chmod(file, 0o640); // fixture mode must not depend on the test runner's umask
    await utimes(file, 1700000000.125, 1700000000.125);
    await writeFile(state.lock, 'test-owned-lock', { flag: 'wx', mode: 0o600 });
    const identity = await lstat(state.lock);
    const assertOwnedAndLocked = async () => {
      const now = await prepareLinuxLoginProfile(root, { create: false });
      const lock = await lstat(state.lock);
      assert.deepEqual([now.profileInfo.dev, now.profileInfo.ino, lock.dev, lock.ino],
        [state.profileInfo.dev, state.profileInfo.ino, identity.dev, identity.ino]);
    };
    return { root, state, file, assertOwnedAndLocked };
  }
  await t.test('全byte・mode・mtime・xattrを新しいinodeへcopyし原本を残す', async () => {
    const s = await sample('successful');
    const xattr = spawnSync('/usr/bin/python3', ['-c', 'import os,sys; os.setxattr(sys.argv[1], b"user.ktz_fixture", b"anonymous")', s.file]);
    assert.equal(xattr.status, 0);
    const staging = path.join(fixture, 'stage-success');
    const result = await copyVerifiedLinuxProfile({ source: s.state.profile, staging, assertOwnedAndLocked: s.assertOwnedAndLocked });
    const copied = path.join(result.destination, 'anonymous.dat');
    const [originalStat, copiedStat] = await Promise.all([lstat(s.file, { bigint: true }), lstat(copied, { bigint: true })]);
    assert.notDeepEqual([originalStat.dev, originalStat.ino], [copiedStat.dev, copiedStat.ino]);
    assert.equal(originalStat.mode, copiedStat.mode); assert.equal(originalStat.mtimeNs, copiedStat.mtimeNs);
    assert.deepEqual(await readFile(copied), await readFile(s.file));
    const attr = spawnSync('/usr/bin/python3', ['-c', 'import os,sys; sys.stdout.buffer.write(os.getxattr(sys.argv[1], b"user.ktz_fixture"))', copied]);
    assert.equal(attr.status, 0); assert.equal(attr.stdout.toString(), 'anonymous');
    await writeFile(copied, 'changed only on copy');
    assert.deepEqual(await readFile(s.file), Buffer.from([0, 1, 2, 255, 10]));
    assert.equal(result.entries, 2); assert.equal(result.bytes, 5);
  });
  await t.test('宛先衝突・link・容量不足は既存領域を採用しない', async () => {
    const s = await sample('refusals');
    const collision = path.join(fixture, 'stage-collision');
    await mkdir(collision, { mode: 0o700 });
    await writeFile(path.join(collision, 'unknown'), 'preserve', { mode: 0o600 });
    await assert.rejects(copyVerifiedLinuxProfile({ source: s.state.profile, staging: collision, assertOwnedAndLocked: s.assertOwnedAndLocked }), { code: 'EEXIST' });
    assert.equal(await readFile(path.join(collision, 'unknown'), 'utf8'), 'preserve');
    await symlink('anonymous.dat', path.join(s.state.profile, 'link'));
    await assert.rejects(copyVerifiedLinuxProfile({ source: s.state.profile, staging: path.join(fixture, 'stage-link'), assertOwnedAndLocked: s.assertOwnedAndLocked }), { code: 'unsafe_profile_entry' });
    const hard = await sample('hardlink');
    await link(hard.file, path.join(hard.state.profile, 'hardlink'));
    await assert.rejects(copyVerifiedLinuxProfile({ source: hard.state.profile, staging: path.join(fixture, 'stage-hardlink'), assertOwnedAndLocked: hard.assertOwnedAndLocked }), { code: 'unsafe_profile_entry' });
    const large = await sample('space');
    const disk = await statfs(fixture, { bigint: true });
    const tooLarge = disk.bavail * disk.bsize + 1n;
    assert.ok(tooLarge <= BigInt(Number.MAX_SAFE_INTEGER));
    await truncate(large.file, Number(tooLarge)); // sparse anonymous file: no large write
    await assert.rejects(copyVerifiedLinuxProfile({ source: large.state.profile, staging: path.join(fixture, 'stage-space'), assertOwnedAndLocked: large.assertOwnedAndLocked }), { code: 'profile_insufficient_space' });
    await assert.rejects(lstat(path.join(fixture, 'stage-space')), { code: 'ENOENT' });
  });
  await t.test('原本競合・copy破損・属性変更・中断は失敗しstagingを保持', async () => {
    for (const mode of ['source', 'bytes', 'mode', 'xattr', 'lock-lost', 'interrupted']) {
      const s = await sample(`fault-${mode}`);
      const staging = path.join(fixture, `stage-${mode}`);
      const error = mode === 'source' ? 'profile_source_changed' : mode === 'interrupted' ? 'fixture_interrupted'
        : mode === 'lock-lost' ? 'fixture_lock_changed' : 'profile_copy_mismatch';
      let lockLost = false;
      await assert.rejects(copyVerifiedLinuxProfile({ source: s.state.profile, staging,
        assertOwnedAndLocked: async () => {
          await s.assertOwnedAndLocked();
          if (lockLost) throw Object.assign(new Error('fixture_lock_changed'), { code: 'fixture_lock_changed' });
        },
        afterCopy: async ({ destination }) => {
          if (mode === 'source') await writeFile(s.file, 'concurrent fixture change');
          if (mode === 'bytes') await writeFile(path.join(destination, 'anonymous.dat'), 'bad bytes');
          if (mode === 'mode') await chmod(path.join(destination, 'anonymous.dat'), 0o600);
          if (mode === 'xattr') {
            const result = spawnSync('/usr/bin/python3', ['-c', 'import os,sys; os.setxattr(sys.argv[1], b"user.ktz_fixture", b"changed")', path.join(destination, 'anonymous.dat')]);
            assert.equal(result.status, 0);
          }
          if (mode === 'lock-lost') lockLost = true;
          if (mode === 'interrupted') throw Object.assign(new Error('fixture_interrupted'), { code: 'fixture_interrupted' });
        } }), { code: error });
      assert.ok((await lstat(staging)).isDirectory());
      assert.ok((await lstat(s.state.lock)).isFile());
      if (mode !== 'source') assert.deepEqual(await readFile(s.file), Buffer.from([0, 1, 2, 255, 10]));
      await assert.rejects(lstat(path.join(fixture, 'kindle-session.json')), { code: 'ENOENT' });
    }
  });
});

if (process.platform === 'linux') test('Ubuntu Portable: 匿名移行transactionは原本保持・限定登録・入口切替・rollbackを統合', { timeout: 60000 }, async t => {
  const base = '/tmp/opencode/ktz-portable-migration'; await mkdir(base, { recursive: true, mode: 0o700 });
  async function fixture() {
    const run = await mkdtemp(path.join(base, 'transaction-'));
    const sourceRoot = path.join(run, 'old'), dataDirectory = path.join(run, 'data');
    await mkdir(dataDirectory, { mode: 0o700 });
    const state = await prepareLinuxLoginProfile(sourceRoot);
    await writeFile(path.join(state.profile, 'anonymous.dat'), 'anonymous source', { mode: 0o600 });
    const shortcut = path.join(run, 'login.desktop'), launcher = path.join(run, 'start.sh');
    const oldShortcut = Buffer.from('[Desktop Entry]\nType=Application\nName=Anonymous\nExec=/anonymous/legacy\nPath=/anonymous\n');
    await writeFile(shortcut, oldShortcut, { mode: 0o700 });
    await writeFile(launcher, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    return { sourceRoot, dataDirectory, shortcut, launcher, state, oldShortcut };
  }
  const options = f => ({ sourceRoot: f.sourceRoot, dataDirectory: f.dataDirectory, shortcut: f.shortcut, launcher: f.launcher });
  await t.test('copy後だけ登録し、別inodeを限定再束縛して確定・旧入口へrollbackできる', async () => {
    const f = await fixture(); const original = await fingerprintLinuxProfile(f.state.profile);
    const result = await migrateLinuxLogin(options(f));
    assert.equal(result.phase, 'pending-confirmation');
    const selected = await resolvePortableLinuxSession(f.dataDirectory);
    assert.equal(selected.id, result.session);
    assert.notEqual((await lstat(selected.profile)).ino, (await lstat(f.state.profile)).ino);
    assert.deepEqual(await fingerprintLinuxProfile(f.state.profile), original);
    assert.equal(await readFile(path.join(selected.profile, 'anonymous.dat'), 'utf8'), 'anonymous source');
    assert.match(await readFile(f.shortcut, 'utf8'), /--login/);
    assert.equal((await lstat(f.shortcut)).mode & 0o777, (await lstat(f.launcher)).mode & 0o777);
    await assert.rejects(runLinuxLogin({ root: f.sourceRoot, url: 'about:blank', preflight: async () => {}, requireExistingProfile: true }), { code: 'login_in_use_or_unknown' });
    let verified = false;
    assert.equal((await confirmLinuxLoginMigration(options(f), { verifyTarget: async root => { assert.equal(root, selected.root); verified = true; } })).phase, 'confirmed');
    assert.equal(verified, true); await assert.rejects(lstat(f.state.lock), { code: 'ENOENT' });
    assert.equal((await rollbackLinuxLoginMigration(options(f))).phase, 'rolled-back');
    assert.deepEqual(await readFile(f.shortcut), f.oldShortcut);
    await assert.rejects(lstat(path.join(f.dataDirectory, 'kindle-session.json')), { code: 'ENOENT' });
    assert.deepEqual(await fingerprintLinuxProfile(f.state.profile), original);
    assert.ok((await lstat(selected.profile)).isDirectory(), '復旧はcopyを削除しない');
  });
  await t.test('copy・登録・shortcut途中失敗は選択を遮断し明示rollbackで旧状態へ戻る', async () => {
    for (const point of ['copy', 'destination-created', 'before-owner-marker', 'registration', 'shortcut']) {
      const f = await fixture(); const original = await fingerprintLinuxProfile(f.state.profile);
      await assert.rejects(migrateLinuxLogin(options(f), { checkpoint: async name => { if (name === point) throw Object.assign(new Error('fixture_interrupted'), { code: 'fixture_interrupted' }); } }), { code: 'fixture_interrupted' });
      await assert.rejects(resolvePortableLinuxSession(f.dataDirectory), { code: 'login_in_use_or_unknown' });
      assert.deepEqual(await readFile(f.shortcut), f.oldShortcut);
      assert.deepEqual(await fingerprintLinuxProfile(f.state.profile), original);
      await rollbackLinuxLoginMigration(options(f));
      await assert.rejects(lstat(f.state.lock), { code: 'ENOENT' });
      await assert.rejects(lstat(path.join(f.dataDirectory, 'portable-login-selection.lock')), { code: 'ENOENT' });
      await assert.rejects(lstat(path.join(f.dataDirectory, 'kindle-session.json')), { code: 'ENOENT' });
      assert.deepEqual(await readFile(f.shortcut), f.oldShortcut);
    }
  });
  await t.test('source競合・同内容lock置換・宛先衝突では盲目的な復旧/上書きをしない', async () => {
    for (const mode of ['source', 'lock', 'collision', 'copy-after-verify']) {
      const f = await fixture();
      await assert.rejects(migrateLinuxLogin(options(f), { checkpoint: async name => {
        if (name !== 'before-publish') return;
        if (mode === 'source') await writeFile(path.join(f.state.profile, 'anonymous.dat'), 'concurrent write');
        if (mode === 'lock') { const bytes = await readFile(f.state.lock); await rename(f.state.lock, `${f.state.lock}.original`); await writeFile(f.state.lock, bytes, { mode: 0o600 }); }
        if (mode === 'collision') { const ledger = JSON.parse(await readFile(path.join(f.dataDirectory, 'portable-login-migration.json'), 'utf8')); await mkdir(ledger.destination, { mode: 0o700 }); }
        if (mode === 'copy-after-verify') { const ledger = JSON.parse(await readFile(path.join(f.dataDirectory, 'portable-login-migration.json'), 'utf8')); await writeFile(path.join(ledger.stage, 'owned/profile/anonymous.dat'), 'late copy corruption'); }
      } }));
      assert.deepEqual(await readFile(f.shortcut), f.oldShortcut);
      if (['source', 'lock'].includes(mode)) await assert.rejects(rollbackLinuxLoginMigration(options(f)));
      else {
        const ledger = JSON.parse(await readFile(path.join(f.dataDirectory, 'portable-login-migration.json'), 'utf8'));
        await rollbackLinuxLoginMigration(options(f));
        assert.ok((await lstat(mode === 'collision' ? ledger.destination : ledger.stage)).isDirectory());
      }
      await assert.rejects(lstat(path.join(f.dataDirectory, 'kindle-session.json')), { code: 'ENOENT' });
      if (['source', 'lock'].includes(mode)) assert.ok((await lstat(f.state.lock)).isFile());
    }
  });
  await t.test('確認の終了不明は未確定のままoriginal lockを保持する', async () => {
    const f = await fixture(); const migrated = await migrateLinuxLogin(options(f));
    await assert.rejects(confirmLinuxLoginMigration(options(f), { verifyTarget: async () => { throw new Error('fixture_shutdown_unknown'); } }), /fixture_shutdown_unknown/);
    const ledger = JSON.parse(await readFile(path.join(f.dataDirectory, 'portable-login-migration.json'), 'utf8'));
    assert.equal(ledger.phase, 'pending-confirmation'); assert.ok((await lstat(f.state.lock)).isFile());
    await writeFile(path.join(f.dataDirectory, migrated.session, 'owned/in-use.lock'), 'unknown owner', { mode: 0o600 });
    await assert.rejects(rollbackLinuxLoginMigration(options(f)));
    assert.ok((await lstat(f.state.lock)).isFile());
  });
  await t.test('未知owner markerは上書きせず排他と原本を保持する', async () => {
    for (const kind of ['file', 'symlink']) {
      const f = await fixture(); const original = await fingerprintLinuxProfile(f.state.profile);
      const unknownBytes = Buffer.from('anonymous unknown owner marker');
      const unknownTarget = path.join(f.sourceRoot, 'anonymous-unknown-marker');
      await writeFile(unknownTarget, unknownBytes, { flag: 'wx', mode: 0o600 });
      let marker;
      await assert.rejects(migrateLinuxLogin(options(f), { checkpoint: async name => {
        if (name !== 'before-owner-marker') return;
        const ledger = JSON.parse(await readFile(path.join(f.dataDirectory, 'portable-login-migration.json'), 'utf8'));
        marker = path.join(ledger.destination, 'owned/owner.json');
        if (kind === 'file') await writeFile(marker, unknownBytes, { flag: 'wx', mode: 0o600 });
        else await symlink(unknownTarget, marker);
      } }), { code: 'EEXIST' });
      assert.equal((await lstat(marker)).isSymbolicLink(), kind === 'symlink');
      assert.deepEqual(await readFile(marker), unknownBytes);
      assert.deepEqual(await readFile(unknownTarget), unknownBytes);
      assert.deepEqual(await readFile(f.shortcut), f.oldShortcut);
      assert.deepEqual(await fingerprintLinuxProfile(f.state.profile), original);
      assert.ok((await lstat(f.state.lock)).isFile());
      await assert.rejects(resolvePortableLinuxSession(f.dataDirectory), { code: 'login_in_use_or_unknown' });
      await assert.rejects(lstat(path.join(f.dataDirectory, 'kindle-session.json')), { code: 'ENOENT' });
      await rollbackLinuxLoginMigration(options(f));
      assert.deepEqual(await readFile(marker), unknownBytes, '明示復旧も未知markerを変更しない');
    }
  });
  await t.test('既存設定の復元はbyte一致、不在化の競合は拒否する', async () => {
    const retainedId = 'temporary-10000000-0000-0000-0000-000000000000';
    const oldPreferences = Buffer.from(`{\n  "version": 2, "session": null, "savedTemporarySessions": ["${retainedId}"]\n}\n`);
    for (const changed of [false, true]) {
      const f = await fixture(); const preferences = path.join(f.dataDirectory, 'kindle-session.json');
      await writeFile(preferences, oldPreferences, { flag: 'wx', mode: 0o600 });
      const original = await fingerprintLinuxProfile(f.state.profile);
      const migrated = await migrateLinuxLogin(options(f));
      if (changed) {
        const switchedShortcut = await readFile(f.shortcut);
        await unlink(preferences); // anonymous competing removal, not our restoration
        await assert.rejects(rollbackLinuxLoginMigration(options(f)), { code: 'migration_publication_changed' });
        await assert.rejects(lstat(preferences), { code: 'ENOENT' });
        assert.deepEqual(await readFile(f.shortcut), switchedShortcut);
        assert.ok((await lstat(f.state.lock)).isFile());
        assert.ok((await lstat(path.join(f.dataDirectory, 'portable-login-selection.lock'))).isFile());
        assert.ok((await lstat(path.join(f.dataDirectory, migrated.session, 'owned/in-use.lock'))).isFile());
      } else {
        await rollbackLinuxLoginMigration(options(f));
        assert.deepEqual(await readFile(preferences), oldPreferences);
        assert.deepEqual(await readFile(f.shortcut), f.oldShortcut);
      }
      assert.deepEqual(await fingerprintLinuxProfile(f.state.profile), original);
    }
  });
  await t.test('固定入口は別root/追加任意pathを実profileに触れる前に拒否する', async () => {
    await migrationToolPreflight();
    await assert.rejects(runFixedPortableMigration('/not-the-installed-bundle', '--migrate-login'), /invalid_migration_invocation/);
  });
});

if (process.platform === 'linux' && process.env.KTZ_DESKTOP_TESTS === '1') test('Ubuntu Portable: 匿名移行transactionを配置core・通常Snap・GIO入口と復旧で実証', { timeout: 120000 }, async t => {
  const { profileMigrationIntegration } = await import('./support/profile-migration-integration.mjs');
  t.diagnostic(JSON.stringify(await profileMigrationIntegration()));
});

if (process.platform === 'linux' && process.env.KTZ_DESKTOP_TESTS === '1') test('Ubuntu Portable: 新規ログイン分岐は匿名保存・移動後もReaderと同じprofileを使う', { timeout: 100_000 }, async t => {
  const { portableNewLoginFixture } = await import('./support/portable-new-login-fixture.mjs');
  t.diagnostic(JSON.stringify(await portableNewLoginFixture()));
});

if (process.platform === 'linux') test('Ubuntu Portable: 別入口の所有profileは公開GUIの汎用再利用・削除から保護する', { timeout: 30_000 }, async t => {
  const base = '/tmp/opencode/ktz-portable-implementation';
  await mkdir(base, { recursive: true, mode: 0o700 });
  for (const mode of ['active', 'closed', 'unknown']) await t.test(mode, async t => {
    const fixture = await mkdtemp(path.join(base, 'protected-session-'));
    const running = await startApplication({ dataDir: path.join(fixture, 'data') });
    const selected = await resolvePortableLinuxSession(running.app.dataDir);
    const anonymous = path.join(selected.profile, 'anonymous-marker');
    await writeFile(anonymous, 'anonymous profile only', { mode: 0o600 });
    const child = new EventEmitter(); child.pid = 999999;
    let ready;
    const started = new Promise(resolve => { ready = resolve; });
    const owner = runLinuxLogin({ root: selected.root, url: 'about:blank', preflight: async () => {},
      launch: () => child, observe: async () => true, groupGone: async () => mode !== 'unknown',
      requireExistingProfile: true, requireAbsentSingleton: true, onStarted: ready });
    owner.catch(() => {});
    t.after(async () => {
      if (mode === 'active') child.emit('close', 0, null);
      await owner.catch(() => {});
      await running.close();
      await rm(fixture, { recursive: true }); // only this anonymous fixture and mock owner
    });
    await started;
    if (mode !== 'active') {
      child.emit('close', 0, null);
      if (mode === 'unknown') await assert.rejects(owner, { code: 'login_close_unconfirmed' });
      else await owner;
    }
    const request = async (action, input = {}) => {
      const response = await fetch(`${running.origin}/api/command`, { method: 'POST', headers: {
        Authorization: `Bearer ${running.token}`, Origin: running.origin, 'Content-Type': 'application/json',
      }, body: JSON.stringify({ action, input }) });
      return { status: response.status, body: await response.json() };
    };
    const files = [anonymous, path.join(selected.root, 'owned/owner.json'), path.join(running.app.dataDir, 'kindle-session.json'),
      ...(mode === 'closed' ? [] : [path.join(selected.root, 'owned/in-use.lock')])];
    const before = await Promise.all(files.map(file => readFile(file)));
    // Established public convention: a rejected command is HTTP 400 with a
    // fixed code; an explicit ordinary session deletion remains HTTP 200.
    assert.deepEqual(await request('deleteSession', { id: selected.id, confirmed: true }), {
      status: 400, body: { code: 'portable_login_session_protected' },
    });
    const snapshot = await running.app.snapshot();
    assert.equal(snapshot.browserOpen, false, 'the login owner is not Application.reader');
    assert.equal(snapshot.sessions.find(item => item.id === selected.id).protectedLinuxSession, true);
    if (mode === 'active') {
      const control = await openControlWindow(running.url, { headless: true });
      try {
        await control.page.waitForFunction(() => document.querySelector('#sessions')?.textContent.includes('別入口で管理中'));
        assert.equal(await control.page.locator('#sessions button').count(), 0);
        assert.equal(await control.page.locator(`#session option[value="${selected.id}"]`).count(), 0);
      } finally { await control.close(); }
    }
    assert.equal((await request('create')).status, 200);
    const prepare = await request('preparePortableKindle', { session: selected.id });
    let openedProfile;
    t.mock.method(Reader, 'open', async options => {
      openedProfile = options.profile;
      throw new Error('anonymous generic reader seam'); // never launch a browser in this regression
    });
    if (mode === 'closed') {
      assert.equal(prepare.status, 200);
      assert.equal(prepare.body.portableKindlePrepared, selected.id);
      assert.equal(prepare.body.portableReaderHold, undefined);
      const entries = await readdir(running.app.dataDir);
      const ownedEntries = await readdir(path.join(selected.root, 'owned'));
      const jobBefore = JSON.stringify((await running.app.snapshot()).job.manifest);
      assert.deepEqual(await request('openBrowser', { mode: 'kindle', session: selected.id }), {
        status: 400, body: { code: 'browser_open_failed' },
      });
      assert.equal(openedProfile, undefined);
      const held = await running.app.snapshot();
      assert.equal(held.browserOpen, false);
      assert.equal(held.readerReleasePending, false);
      assert.equal(held.portableLimitedJob, false);
      assert.equal(JSON.stringify(held.job.manifest), jobBefore);
      assert.deepEqual(await readdir(running.app.dataDir), entries, 'claimや起動記録を作らない');
      assert.deepEqual(await readdir(path.join(selected.root, 'owned')), ownedEntries, '選択した所有情報を変更しない');

      assert.equal(held.portableLimitedAvailable, false, '選択Portable以外では許可しない');
    } else {
      assert.deepEqual(prepare, { status: 400, body: { code: 'login_in_use_or_unknown' } });
      assert.deepEqual(await request('openBrowser', { mode: 'kindle', session: selected.id }), {
        status: 400, body: { code: 'login_in_use_or_unknown' },
      });
    }
    assert.deepEqual(await request('openBrowser', { mode: 'sample', session: selected.id }), {
      status: 400, body: { code: 'portable_login_session_protected' },
    });
    assert.equal(openedProfile, undefined);
    assert.equal(running.app.profile == null, true);
    assert.equal(running.app.fixture == null, true);
    assert.deepEqual(await Promise.all(files.map(file => readFile(file))), before, 'profile, owner, lock and preferences are unchanged');

    // A regular saved profile still reaches its established Reader path and
    // remains explicitly deletable; do not ban every saved-* name on Linux.
    const ordinaryId = 'saved-00000000-0000-0000-0000-000000000000';
    const ordinary = path.join(running.app.dataDir, ordinaryId);
    await running.app.store.call('create_session_directory', { path: ordinary });
    assert.equal((await request('openBrowser', { mode: 'sample', session: ordinaryId })).body.code, 'browser_open_failed');
    assert.equal(openedProfile, ordinary);
    assert.equal((await request('closeBrowser')).status, 200);
    assert.equal((await request('deleteSession', { id: ordinaryId, confirmed: true })).status, 200);
    await assert.rejects(lstat(ordinary), { code: 'ENOENT' });
    assert.deepEqual(await Promise.all(files.map(file => readFile(file))), before);
    if (mode === 'closed') {
      // The selection lock fences partial roots, and an incomplete owned entry
      // stays protected even without a completed owner marker or live browser.
      await running.app.store.call('create_session_directory', { path: ordinary });
      const selection = path.join(running.app.dataDir, 'portable-login-selection.lock');
      await writeFile(selection, 'anonymous partial selection', { mode: 0o600 });
      assert.equal((await request('deleteSession', { id: ordinaryId, confirmed: true })).body.code, 'portable_login_session_protected');
      assert.ok((await lstat(ordinary)).isDirectory());
      await rm(selection); // this test's mock selection only
      await mkdir(path.join(ordinary, 'owned'), { mode: 0o700 });
      assert.deepEqual(await request('deleteSession', { id: ordinaryId, confirmed: true }), {
        status: 400, body: { code: 'portable_login_session_protected' },
      });
      assert.deepEqual(await readdir(path.join(ordinary, 'owned')), []);
    }
  });
});

if (process.platform === 'linux') test('共通経路復帰: 旧window分岐は公開コマンドを横取りせず新試行も起動しない', async t => {
  const base = '/tmp/opencode/ktz-portable-implementation';
  await mkdir(base, { recursive: true, mode: 0o700 });
  const fixture = await mkdtemp(path.join(base, 'common-path-'));
  const running = await startApplication({ dataDir: path.join(fixture, 'data') });
  t.after(async () => { await running.close(); await rm(fixture, { recursive: true }); });
  await running.app.command('create');
  let intercepted = false;
  running.app.windowTrial = { snapshot() { intercepted = true; }, command() { intercepted = true; } };
  assert.equal(Object.hasOwn(await running.app.snapshot(), 'windowTrial'), false);
  const response = await fetch(`${running.origin}/api/command`, { method: 'POST', headers: {
    Authorization: `Bearer ${running.token}`, Origin: running.origin, 'Content-Type': 'application/json',
  }, body: JSON.stringify({ action: 'windowPreview', input: {} }) });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { code: 'unknown_action' });
  const normal = await running.app.command('setKindleRegion', { id: 'jp' });
  assert.equal(normal.kindleRegion, 'jp');
  assert.equal(normal.job.manifest.images.length, 0);
  assert.equal(intercepted, false);
  // The abandoned development-only entry is not part of the public source.
  assert.equal(existsSync('scripts/window-stream-once.mjs'), false);
});

if (process.platform === 'linux') test('Linux起動診断: 公開npm startの不在・権限・排他・画面失敗を誤成功にしない', { timeout: 60_000 }, async t => {
  const project = fileURLToPath(new URL('../', import.meta.url));
  const fixture = await mkdtemp(path.join(tmpdir(), 'ktz-start-errors-'));
  // A real launch rejection does not prove its partial process has exited.
  // Keep this fixture if the product deliberately retained an unknown runtime.
  t.after(async () => {
    if (!(await readdir(fixture)).some(name => name.startsWith('ktz-'))) await rm(fixture, { recursive: true, force: true });
  });
  const run = (extra = {}) => spawnSync('npm', ['--prefix', project, 'start'], { cwd: fixture, encoding: 'utf8', timeout: 15_000,
    env: { ...process.env, KTZ_USER_DATA_DIR: path.join(fixture, 'data'), KTZ_TEMP_DIR: fixture, ...extra } });
  const failed = (result, message) => {
    assert.equal(result.status, 1, `${result.stdout} ${result.stderr}`);
    assert.match(result.stderr, message);
    assert.doesNotMatch(result.stdout, /MVPを起動しました|操作画面を.*開きました/);
  };
  failed(run({ KTZ_CONTROLLER_PATH: path.join(fixture, 'missing') }), /実行可能なRust controller/);
  await assert.rejects(lstat(path.join(fixture, 'data')), { code: 'ENOENT' });
  const unsafe = path.join(fixture, 'unsafe'); await mkdir(unsafe); await chmod(unsafe, 0o755);
  failed(run({ KTZ_TEMP_DIR: unsafe }), /専用領域の権限・所有者・種類/);
  assert.equal((await lstat(unsafe)).mode & 0o7777, 0o755, '既存の不正権限を修復しない');
  const { startApplication } = await import('../app/server.mjs');
  const primary = await startApplication({ dataDir: path.join(fixture, 'data') });
  try {
    failed(run(), /別の起動が使用中/);
    assert.equal((await primary.app.snapshot()).state, 'Idle', '先行起動の排他と状態を維持');
  } finally { await primary.close(); }
  failed(run({ DISPLAY: '', WAYLAND_DISPLAY: '' }), /操作画面用Chromiumの起動または読込み/);
  const wrapped = new Error('opaque', { cause: Object.assign(new Error(), { code: 'file_permissions_invalid' }) });
  assert.match(linuxStartupMessage(wrapped, 'storage'), /権限・所有者・種類/);
  assert.match(linuxStartupMessage(new Error('a long TMPDIR is not proof'), 'storage'), /原因は特定できていません/);
  const entries = await readdir(fixture);
  assert.deepEqual(entries.filter(name => !name.startsWith('ktz-')).sort(), ['data', 'unsafe'], '保存領域と既存親内容を保持');
  assert.equal(entries.filter(name => name.startsWith('ktz-')).length, 3, 'Application取得失敗2件とlaunch拒否の終了不明を保持');
});

if (process.platform === 'linux') test('Linux公開npm start: 所有終了と一時領域identityを確認してから削除', { timeout: 60_000 }, async t => {
  const project = fileURLToPath(new URL('../', import.meta.url));
  const hook = new URL('./support/startup-cleanup-hook.mjs', import.meta.url).href;
  const root = await mkdtemp(path.join(existsSync('/tmp/opencode') ? '/tmp/opencode' : tmpdir(), 'ktz-startup-regression-'));
  // All Chromium launches are synthetic. Remove test files only after the
  // child and its real controller are observed to have closed.
  let cleanupSafe = true;
  t.after(() => cleanupSafe ? rm(root, { recursive: true, force: true }) : undefined);
  for (const [mode, expectedExit, ownedCount] of [
    ['normal', 0, 0], ['init-close-ok', 1, 0], ['init-close-fail', 1, 1],
    ['control-close-fail', 1, 1], ['app-close-fail', 1, 1],
    ['launch-reject', 1, 1], ['app-start-fail', 1, 1], ['replace-identity', 1, 2],
  ]) await t.test(mode, async () => {
    const fixture = path.join(root, mode), temp = path.join(fixture, 'temp'), data = path.join(fixture, 'data');
    await mkdir(fixture, { mode: 0o700 }); await mkdir(temp, { mode: 0o700 }); await mkdir(data, { mode: 0o700 });
    const parentMarker = path.join(temp, 'parent-marker'), storeMarker = path.join(data, 'store-marker');
    await writeFile(parentMarker, 'parent original', { mode: 0o600 });
    await writeFile(storeMarker, 'store original', { mode: 0o600 });
    const parentBefore = await lstat(temp, { bigint: true }), storeBefore = await lstat(storeMarker, { bigint: true });
    const log = path.join(fixture, 'events.jsonl');
    cleanupSafe = false;
    const child = spawnSync('npm', ['--prefix', project, 'start'], { cwd: fixture, encoding: 'utf8', timeout: 15_000,
      env: { ...process.env, KTZ_USER_DATA_DIR: data, KTZ_TEMP_DIR: temp, KTZ_CLEANUP_TEST_MODE: mode,
        KTZ_CLEANUP_TEST_LOG: log, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${hook}` } });
    assert.equal(child.error, undefined); assert.equal(child.signal, null);
    assert.equal(child.status, expectedExit, `${mode}: ${child.stdout} ${child.stderr}`);
    assert.doesNotMatch(child.stdout + child.stderr, /PRIVATE_PATH_TOKEN_SECRET/);
    assert.doesNotMatch(child.stdout + child.stderr, /ktz-startup-regression-/);
    const events = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const names = events.map(event => event.event);
    assert.ok(names.includes('application.close.end'), '実controllerを含むApplication closeを試行し完了');
    cleanupSafe = true;
    if (mode !== 'app-start-fail') assert.equal(events.find(event => event.event === 'launch').exists, true);
    if (!['app-start-fail', 'launch-reject'].includes(mode)) {
      assert.equal(names.filter(name => name === 'control.close').length, 1);
      assert.ok(names.indexOf('control.close') < names.indexOf('application.close.start'));
    }
    if (ownedCount) assert.match(child.stderr, /安全確認ができなかったため専用一時領域を保持/);
    else assert.doesNotMatch(child.stderr, /専用一時領域を保持/);
    const entries = await readdir(temp);
    assert.equal(entries.filter(name => name.startsWith('ktz-')).length, ownedCount);
    assert.equal(await readFile(parentMarker, 'utf8'), 'parent original');
    assert.equal(await readFile(storeMarker, 'utf8'), 'store original');
    const parentAfter = await lstat(temp, { bigint: true }), storeAfter = await lstat(storeMarker, { bigint: true });
    for (const field of ['dev', 'ino', 'uid', 'gid', 'mode']) {
      assert.equal(parentAfter[field], parentBefore[field], `parent ${field}`);
      assert.equal(storeAfter[field], storeBefore[field], `store ${field}`);
    }
    if (mode === 'replace-identity') {
      const replacement = entries.find(name => name.startsWith('ktz-') && !name.endsWith('-original'));
      assert.equal(await readFile(path.join(temp, replacement, 'replacement'), 'utf8'), 'do not delete');
    }
  });
});

if (process.platform === 'linux') test('Linux公開npm start: Reader部分生成の終了不明をHTTPから終了コードと所有tempまで伝える', { timeout: 60_000 }, async t => {
  const project = fileURLToPath(new URL('../', import.meta.url));
  const hook = new URL('./support/reader-startup-cleanup-hook.mjs', import.meta.url).href;
  const root = await mkdtemp(path.join(existsSync('/tmp/opencode') ? '/tmp/opencode' : tmpdir(), 'ktz-startup-reader-'));
  // The hooks start no Chromium. Remove fixtures only after the real controller
  // has closed and the child exited; otherwise keep the evidence.
  let cleanupSafe = true;
  t.after(() => cleanupSafe ? rm(root, { recursive: true, force: true }) : undefined);
  for (const mode of ['close-ok', 'close-reject', 'launch-reject']) await t.test(mode, async () => {
    const fixture = path.join(root, mode), temp = path.join(fixture, 'temp'), data = path.join(fixture, 'data');
    await mkdir(fixture, { mode: 0o700 }); await mkdir(temp, { mode: 0o700 }); await mkdir(data, { mode: 0o700 });
    const original = path.join(data, 'original-marker'), marker = path.join(temp, 'parent-marker');
    await writeFile(original, 'do not overwrite', { mode: 0o600 });
    await writeFile(marker, 'parent intact', { mode: 0o600 });
    const before = await lstat(original, { bigint: true }), log = path.join(fixture, 'events.jsonl');
    cleanupSafe = false;
    const child = spawnSync('npm', ['--prefix', project, 'start'], { cwd: fixture, encoding: 'utf8', timeout: 15_000,
      env: { ...process.env, KTZ_USER_DATA_DIR: data, KTZ_TEMP_DIR: temp, KTZ_READER_TEST_MODE: mode,
        KTZ_READER_TEST_LOG: log, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${hook}` } });
    assert.equal(child.error, undefined); assert.equal(child.signal, null);
    assert.equal(child.status, mode === 'close-ok' ? 0 : 1, `${mode}: ${child.stdout} ${child.stderr}`);
    assert.doesNotMatch(child.stdout + child.stderr, /PRIVATE_PATH_TOKEN_SECRET|ktz-startup-reader-/);
    const events = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const commands = events.find(event => event.event === 'commands');
    assert.deepEqual(commands, { event: 'commands', createStatus: 200, openStatus: 400,
      openCode: 'browser_open_failed', profileExists: true, readerReturned: false });
    const close = events.find(event => event.event.startsWith('application.close.'));
    assert.equal(close.event, mode === 'close-ok' ? 'application.close.resolved' : 'application.close.rejected');
    assert.equal(close.storeClosed, true);
    assert.equal(close.profileExists, mode !== 'close-ok');
    assert.equal(events.filter(event => event.event === 'reader.close').length, mode === 'launch-reject' ? 0 : 1);
    assert.equal(events.find(event => event.event === 'exit').ownedExists, mode !== 'close-ok');
    assert.equal((await readdir(temp)).filter(name => name.startsWith('ktz-')).length, mode === 'close-ok' ? 0 : 1);
    if (mode !== 'close-ok') assert.match(child.stderr, /安全確認ができなかったため専用一時領域を保持/);
    assert.equal(await readFile(original, 'utf8'), 'do not overwrite');
    assert.equal(await readFile(marker, 'utf8'), 'parent intact');
    const after = await lstat(original, { bigint: true });
    for (const field of ['dev', 'ino', 'uid', 'gid', 'mode']) assert.equal(after[field], before[field]);
    const lock = new StoreClient();
    try { await lock.call('lock_data_directory', { path: data }); }
    finally { await lock.close(); }
    cleanupSafe = true;
  });
});

test('controller解決: 明示指定とOS既定を共用し、起動時に不在を拒否する', async () => {
  assert.match(controllerPath({ platform: 'win32', env: {} }), /ktz-g02-controller\.exe$/);
  assert.match(controllerPath({ platform: 'linux', env: {} }), /ktz-g02-controller$/);
  const previous = process.env.KTZ_CONTROLLER_PATH;
  try {
    process.env.KTZ_CONTROLLER_PATH = guardExecutable;
    const store = new StoreClient();
    process.env.KTZ_CONTROLLER_PATH = path.join(path.dirname(guardExecutable), 'missing-controller-for-regression');
    try {
      assert.equal((await store.call('state')).state, 'Preview', '既存childは作成時の設定を保持する');
      assert.throws(() => new StoreClient(), { code: 'controller_not_found' });
      assert.throws(() => new RustGuard(), { code: 'controller_not_found' });
    } finally { await store.close(); }
    process.env.KTZ_CONTROLLER_PATH = guardExecutable;
    const guard = new RustGuard();
    try { assert.equal((await guard.request({ kind: 'state' })).state, 'Preview'); }
    finally { await guard.close(); }
  } finally {
    if (previous === undefined) delete process.env.KTZ_CONTROLLER_PATH; else process.env.KTZ_CONTROLLER_PATH = previous;
  }
});

if (process.platform === 'linux') test('Linux公開npm start: 実headed画面の操作と画面閉鎖・Ctrl+Cで所有資源を回収', { timeout: 90_000 }, async t => {
  assert.ok(process.env.DISPLAY, 'headed検査には明示的なX displayが必要');
  const project = fileURLToPath(new URL('../', import.meta.url));
  const socketRoot = await mkdtemp(path.join(existsSync('/tmp/opencode') ? '/tmp/opencode' : '/tmp', 'ktz-public-'));
  let unconfirmedRuns = 0;
  t.after(() => unconfirmedRuns === 0 ? rm(socketRoot, { recursive: true, force: true }) : undefined);
  const screenshot = path.join(socketRoot, 'public-start.png');
  const hook = new URL('./support/public-start-hook.mjs', import.meta.url).href;
  for (const mode of ['window', 'sigint']) await t.test(mode, async () => {
    const fixture = await mkdtemp(path.join(socketRoot, `${mode}-`));
    const temp = path.join(fixture, 't'); await mkdir(temp, { mode: 0o700 });
    const socketPath = path.join(fixture, 's');
    const server = net.createServer();
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    const connected = new Promise(resolve => server.once('connection', resolve));
    const env = { ...process.env, KTZ_USER_DATA_DIR: path.join(fixture, 'data'), KTZ_TEMP_DIR: temp,
      KTZ_PUBLIC_TEST_SOCKET: socketPath, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${hook}` };
    // The SIGINT case uses a real pseudo-terminal: byte 0x03 is Ctrl+C,
    // delivered by the terminal to its foreground process group.
    const quotedProject = `'${project.replaceAll("'", "'\\''")}'`;
    const executable = mode === 'sigint' ? 'script' : 'npm';
    const args = mode === 'sigint' ? ['-q', '-e', '-c', `npm --prefix ${quotedProject} start`, '/dev/null'] : ['--prefix', project, 'start'];
    unconfirmedRuns++;
    const child = spawn(executable, args, { cwd: fixture, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', text => { output += text; }); child.stderr.on('data', text => { output += text; });
    const exited = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
    let socket;
    const deadline = ms => new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error(`public_start_timeout: ${output}`)), ms); timer.unref(); });
    try {
      socket = await Promise.race([connected, deadline(25_000)]);
      let buffer = ''; const events = []; const waiters = [];
      socket.on('data', chunk => {
        buffer += chunk; let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const value = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
          const waiter = waiters.shift(); if (waiter) waiter(value); else events.push(value);
        }
      });
      const receive = () => events.length ? Promise.resolve(events.shift()) : new Promise(resolve => waiters.push(resolve));
      const ready = await Promise.race([receive(), deadline(25_000)]);
      assert.equal(ready.event, 'ready', JSON.stringify(ready));
      assert.match(ready.title, /KindleToZip/);
      socket.write(`${JSON.stringify({ action: 'exercise', ...(mode === 'window' ? { screenshot } : {}) })}\n`);
      const exercised = await Promise.race([receive(), deadline(25_000)]);
      assert.equal(exercised.event, 'exercised', JSON.stringify(exercised));
      assert.equal(exercised.kindleDisabled, true);
      assert.match(exercised.notice, /実Kindle.*許可まで停止/);
      assert.equal((await lstat(path.join(fixture, 'data'))).mode & 0o7777, 0o700);
      const owned = (await readdir(temp)).map(name => path.join(temp, name));
      assert.equal(owned.length, 1);
      assert.equal((await lstat(owned[0])).mode & 0o7777, 0o700);
      const processes = spawnSync('ps', ['-eo', 'pid=,ppid=,args='], { encoding: 'utf8' }).stdout.split('\n')
        .map(line => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)).filter(Boolean);
      // Playwright starts Chromium in its own process group: ancestry, not
      // npm's group id, determines which processes this particular run owns.
      const ownedPids = new Set([child.pid]);
      let count;
      do { count = ownedPids.size; for (const match of processes) if (ownedPids.has(Number(match[2]))) ownedPids.add(Number(match[1])); } while (ownedPids.size !== count);
      assert.ok(processes.some(match => ownedPids.has(Number(match[1])) && /ktz-g02-controller/.test(match[3])), 'owned Rust controller exists');
      assert.ok(processes.some(match => ownedPids.has(Number(match[1])) && /chrome-linux64\/chrome/.test(match[3])), 'owned headed Chromium exists');
      assert.ok(processes.some(match => ownedPids.has(Number(match[1])) && /chrome-headless-shell/.test(match[3])), 'owned sample Chromium exists');
      const profile = (await readdir(path.join(fixture, 'data'))).find(name => name.startsWith('temporary-'));
      assert.ok(profile, 'self-authored sample has a dedicated temporary profile');
      async function privateTree(directory) {
        for (const name of await readdir(directory)) {
          const filename = path.join(directory, name), info = await lstat(filename);
          if (info.isSymbolicLink()) continue; // Chromium singleton links are not followed.
          assert.equal(info.uid, process.geteuid());
          assert.equal(info.mode & 0o077, 0, `private browser object: ${filename}`);
          if (info.isDirectory()) await privateTree(filename);
        }
      }
      await privateTree(path.join(fixture, 'data', profile));
      if (mode === 'window') { socket.write('{"action":"close"}\n'); await Promise.race([receive(), deadline(5000)]); }
      else child.stdin.write('\x03');
      const result = await Promise.race([exited, deadline(25_000)]);
      assert.ok(mode === 'sigint' ? [0, 130].includes(result.code) : result.code === 0, `${JSON.stringify(result)} ${output}`);
      const limit = Date.now() + 10_000;
      let active;
      do {
        active = [...ownedPids].filter(pid => {
          const stat = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
          return Boolean(stat);
        });
        if (active.length) await new Promise(resolve => setTimeout(resolve, 50));
      } while (active.length && Date.now() < limit);
      assert.deepEqual(active, [], `owned processes remain active: ${active}`);
      await assert.rejects(fetch(ready.origin, { signal: AbortSignal.timeout(3000) }));
      assert.deepEqual(await readdir(temp), [], 'owned temporary browser runtime removed');
      if (mode === 'window') assert.ok((await lstat(screenshot)).size > 0);
      unconfirmedRuns--;
    } finally {
      socket?.destroy(); server.close();
      if (child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} await exited; }
    }
  });
});

if (process.platform === 'linux' && process.env.KTZ_DESKTOP_TESTS === '1') test('Linux公開CLI: Kindle開始と復帰は画面を開くだけで作業・Reader・取得を自動開始しない', { timeout: 120_000 }, async t => {
  const { runPilotFixture } = await import('./support/portable-limited-pilot-fixture.mjs');
  for (const mode of ['cli-kindle', 'cli-resume']) await t.test(mode, async sub => {
    const result = await runPilotFixture(sub, mode);
    assert.deepEqual(result.terminal, { code: 0, signal: null });
    assert.deepEqual(result.user, { created: false, images: 0, browser: false });
    assert.equal(result.standardJobs, 0); assert.equal(result.lock, false); assert.equal(result.retainedTemp, false);
  });
});

test('明示Kindle起動は保存・再利用の専用ブラウザだけを開き、プレビュー・取得・代理認証をしない', async () => {
  const calls = [];
  await openKindleForUser({ command: async (...args) => { calls.push(args); } });
  assert.deepEqual(calls, [['create'], ['openBrowser', { mode: 'kindle', keep: true }]]);
});

test('最小OS adapter: 限定入口が利用可能な場合は旧未対応表示を隠し一般Kindle入口は閉じたまま', async () => {
  const source = await readFile(new URL('../app/ui/ui.mjs', import.meta.url), 'utf8');
  const start = source.indexOf("  $('openKindle').disabled = ");
  const end = source.indexOf("  $('workflowNotice').textContent = ", start);
  assert.ok(start >= 0 && end > start);
  const render = new Function('$', 's', 'errors', source.slice(start, end));
  const controls = { openKindle: {}, kindleUnsupported: {} };
  const state = { job: {}, kindleSupported: false, portableLimitedAvailable: true };
  render(id => controls[id], state, {});
  assert.equal(controls.openKindle.disabled, true, '別の一般Kindle入口は有効にしない');
  assert.equal(controls.kindleUnsupported.hidden, true, '許可済み限定入口を未対応と誤表示しない');
  render(id => controls[id], { ...state, portableLimitedAvailable: false }, {});
  assert.equal(controls.kindleUnsupported.hidden, false, '選択Portable以外への許可は増やさない');
  render(id => controls[id], { ...state, portableLimitedAvailable: false, portableNormalAvailable: true }, {});
  assert.equal(controls.kindleUnsupported.hidden, true, '通常入口も古い未対応表示と混同しない');
});

test('ジョブ作成失敗時に専用ブラウザ操作を続けない', async () => {
  const calls = [];
  await assert.rejects(openKindleForUser({ command: async kind => { calls.push(kind); throw new Error('test_failure'); } }), /test_failure/);
  assert.deepEqual(calls, ['create']);
});

test('明示復旧は候補が1つの一時専用領域だけを再利用し、取得を始めない', async () => {
  const calls = [];
  const session = 'temporary-00000000-0000-0000-0000-000000000000';
  await openKindleForUser({
    command: async (...args) => calls.push(args),
    snapshot: async () => ({ sessions: [{ id: session, saved: false }] }),
  }, { resumeTemporary: true });
  assert.deepEqual(calls, [['create'], ['openBrowser', { mode: 'kindle', keep: true, session }]]);
});

test('一時専用領域の復旧候補が複数なら勝手に選ばずブラウザを開かない', async () => {
  const calls = [];
  const sessions = ['00000000-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111'].map(id => ({ id: `temporary-${id}`, saved: false }));
  await assert.rejects(openKindleForUser({ command: async (...args) => calls.push(args), snapshot: async () => ({ sessions }) }, { resumeTemporary: true }), /choose_temporary_session_in_ui/);
  assert.deepEqual(calls, [['create']]);
});

test('実サービスの通常表示へ独自の通信遮断を入れず、自作試料のloopback制限は維持する', async () => {
  const routes = [];
  const context = { route: async (pattern, handler) => routes.push({ pattern, handler }) };
  await configureReaderNetwork(context, undefined);
  assert.deepEqual(routes, [], '実Kindleの描画・認証・CDN通信をアプリが推測で遮断しない');
  await configureReaderNetwork(context, 'http://127.0.0.1:12345/reader.html');
  assert.equal(routes.length, 1);
  assert.equal(routes[0].pattern, '**/*');
  const decisions = [];
  const route = url => ({ request: () => ({ url: () => url }), continue: () => decisions.push('continue'), abort: code => decisions.push(code) });
  await routes[0].handler(route('http://127.0.0.1:12345/reader.js'));
  await routes[0].handler(route('https://example.invalid/script.js'));
  await routes[0].handler(route('http://127.0.0.1:12346/reader.js'));
  assert.deepEqual(decisions, ['continue', 'blockedbyclient', 'blockedbyclient']);
});

test('描画用Service Worker: 実サービスの起動条件で通常の描画を妨げず試料の遮断は維持する', async t => {
  const root = fileURLToPath(new URL('../artifacts/mvp-tests/', import.meta.url));
  await mkdir(root, { recursive: true }); const directory = await mkdtemp(path.join(root, 'worker-render-'));
  let context, server;
  t.after(async () => {
    await context?.close();
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  server = http.createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.url === '/worker.js') return res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(`
      self.addEventListener('install', () => self.skipWaiting());
      self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
      self.addEventListener('fetch', event => {
        if (new URL(event.request.url).pathname === '/render-color') event.respondWith(new Response('#d23c1e'));
      });`);
    if (req.url === '/') return res.writeHead(200, { 'Content-Type': 'text/html' }).end(`<!doctype html><html><body style="margin:0"><canvas width="64" height="64" id="paint"></canvas><script type="module">
      const ctx = document.querySelector('#paint').getContext('2d'); ctx.fillStyle = 'black'; ctx.fillRect(0, 0, 64, 64);
      window.fixtureStatus = 'starting';
      try {
        await Promise.race([(async () => {
          await navigator.serviceWorker.register('/worker.js'); await navigator.serviceWorker.ready;
          if (!navigator.serviceWorker.controller) await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
          const color = await (await fetch('/render-color')).text(); if (color !== '#d23c1e') throw new Error('fixture_color');
          ctx.fillStyle = color; ctx.fillRect(0, 0, 64, 64);
        })(), new Promise((_, reject) => setTimeout(() => reject(new Error('fixture_timeout')), 2500))]);
        window.fixtureStatus = 'painted';
      } catch { window.fixtureStatus = 'blocked'; }
      </script></body></html>`);
    res.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  context = await chromium.launchPersistentContext(path.join(directory, 'profile'), readerContextOptions({ headless: true }));
  await configureReaderNetwork(context, `${origin}/`);
  const page = context.pages()[0]; await page.goto(origin);
  await page.waitForFunction(() => window.fixtureStatus !== 'starting', null, { timeout: 5000 });
  const status = await page.evaluate(() => window.fixtureStatus);
  const pixel = PNG.sync.read(await page.screenshot({ clip: { x: 4, y: 4, width: 2, height: 2 } })).data.subarray(0, 3);
  assert.equal(status, 'painted', `自作描画試料の状態=${status}、画素=${[...pixel].join('/')}`);
  assert.deepEqual([...pixel], [210, 60, 30]);
  assert.equal(readerContextOptions({ sampleUrl: `${origin}/` }).serviceWorkers, 'block', '自作試料の既存境界は維持する');
});
