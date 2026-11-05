import './chromium-test-log-sink.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fork, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { projectStartupConnectionObservation } from '../app/portable-startup-observation.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const hook = new URL('./support/owned-headed-sample-hook.mjs', import.meta.url).href;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
// Native Snap/Wayland fixtures require the documented prepared desktop.
// Pure owner, permission and lifecycle regressions below also run on hosted CI.
const enabled = process.platform === 'linux' && process.env.KTZ_DESKTOP_TESTS === '1' && Boolean(process.env.WAYLAND_DISPLAY);
if (enabled) test('Ubuntu送り前診断: 対象照合とtrial失敗は原本とnot_sentを保ち固定段階を記録', { timeout: 90_000 }, async t => {
  const { runPilotFixture } = await import('./support/portable-limited-pilot-fixture.mjs');
  for (const [mode, stage] of [['normal-preflight-bound', 'advance_bound_check'], ['normal-preflight-trial', 'advance_trial_check']]) {
    await t.test(mode, async sub => {
      const result = await runPilotFixture(sub, mode);
      assert.deepEqual(result.terminal, { code: 0, signal: null }, JSON.stringify(result));
      assert.equal(result.user?.completed, true, JSON.stringify(result.user));
      assert.deepEqual(result.user.first, { state: 'NeedsAttention', reason: 'capture_or_advance_failed', images: 1, dispatch: 'not_sent', range: false });
      assert.deepEqual(result.user.stopResult, { status: 'stopped', mode: 'manual', limit: 2,
        reason: 'capture_or_advance_failed', stage, dispatch: 'not_sent' });
      assert.deepEqual(result.user.preflight, { clicks: 0, originalUnchanged: true, phase: 'failed' });
      assert.equal(result.user.readerClosed, true); assert.equal(result.lock, false); assert.equal(result.retainedTemp, false);
    });
  }
});
if (enabled) test('Ubuntu入力伝搬: 公開kindle入口の162指定は1へ縮まず3画面の終端まで進む', { timeout: 90_000 }, async t => {
  const { runPilotFixture } = await import('./support/portable-limited-pilot-fixture.mjs');
  const result = await runPilotFixture(t, 'normal-count162');
  assert.deepEqual(result.terminal, { code: 0, signal: null }, JSON.stringify(result));
  assert.equal(result.user?.completed, true, JSON.stringify(result.user));
  assert.deepEqual(result.user.approval, { input: '162', application: 162, budget: 162 });
  assert.deepEqual(result.user.first, { state: 'Review', reason: 'end_candidate', images: 3, dispatch: 'not_sent', range: false });
  assert.deepEqual(result.user.end, { state: 'Review', reason: 'end_candidate', images: 3, range: false, sameGuard: true });
  assert.deepEqual(result.user.archives, { zip: true, cbz: true });
  assert.equal(result.user.originalUnchanged, true);
  assert.equal(result.user.readerClosed, true); assert.equal(result.user.noTrialMarkers, true);
  assert.equal(result.lock, false); assert.equal(result.retainedTemp, false);
  // This is an anonymous three-display boundary test, not 162 real captures,
  // a reproduction of the user's private stop, or an automatic-mode assertion.
});
if (enabled) test('Ubuntu自動取得: 空欄承認から3画面終端・編集ZIPと再起動後の停止結果を確認', { timeout: 150_000 }, async t => {
  const { runPilotFixture } = await import('./support/portable-limited-pilot-fixture.mjs');
  const result = await runPilotFixture(t, 'normal-auto');
  assert.deepEqual(result.restart.first, { code: 0, signal: null });
  assert.equal(result.restart.distinctProcesses, true);
  const first = result.restart.originalRun;
  assert.deepEqual(first.approval, { input: '', application: null, budget: null });
  assert.equal(first.changedLimitRevoked, true);
  assert.match(first.approvedUi, /承認済み：自動取得。開始は別操作/);
  assert.deepEqual(first.first, { state: 'Review', reason: 'end_candidate', images: 3, dispatch: 'not_sent', range: false });
  assert.deepEqual(first.end, { state: 'Review', reason: 'end_candidate', images: 3, range: false, sameGuard: true });
  assert.deepEqual(first.stopResult, { status: 'stopped', mode: 'auto', limit: null, reason: 'end_candidate', stage: 'end_stop', dispatch: 'not_sent' });
  assert.deepEqual(first.archives, { zip: true, cbz: true });
  assert.equal(first.originalUnchanged, true); assert.equal(first.recordPrivacy, true); assert.equal(first.readerClosed, true);
  assert.deepEqual(result.terminal, { code: 0, signal: null });
  assert.equal(result.user.completed, true, JSON.stringify(result.user));
  assert.deepEqual(result.user.recovered.result, first.stopResult);
  assert.equal(result.user.recovered.images, 3); assert.equal(result.user.recovered.range, false);
  assert.match(result.user.recovered.ui, /自動取得/); assert.match(result.user.recovered.ui, /終端候補/);
  assert.equal(result.lock, false); assert.equal(result.retainedTemp, false);
});
if (enabled) test('Ubuntu自動取得: 停止記録の書込失敗は成功表示せず原本と不明状態を保持', { timeout: 90_000 }, async t => {
  const { runPilotFixture } = await import('./support/portable-limited-pilot-fixture.mjs');
  const result = await runPilotFixture(t, 'normal-result-write-fail');
  assert.deepEqual(result.terminal, { code: 0, signal: null }, JSON.stringify(result));
  assert.equal(result.user?.completed, true, JSON.stringify(result.user));
  assert.deepEqual(result.restart.first, { code: 0, signal: null }); assert.equal(result.restart.distinctProcesses, true);
  const first = result.restart.originalRun;
  assert.equal(first.first.state, 'NeedsAttention');
  assert.equal(first.first.reason, 'portable_normal_result_write_failed');
  assert.equal(first.first.range, false);
  assert.equal(first.recordFailure.failure, 'portable_normal_result_write_failed');
  assert.equal(first.recordFailure.result.status, 'unknown');
  assert.equal(first.recordFailure.result.mode, null);
  assert.equal(first.recordFailure.originalUnchanged, true);
  assert.equal(result.user.recovered.result.status, 'unknown');
  assert.equal(result.user.recovered.result.reason, null);
  assert.match(result.user.recovered.ui, /停止結果は未記録または不明/);
  assert.equal(first.readerClosed, true); assert.equal(result.lock, false); assert.equal(result.retainedTemp, false);
});
if (enabled) test('Ubuntu通常取得: 正式Portable公開入口と同じowner・guardで上限・確定復帰・終端・編集ZIPを検査', { timeout: 150_000 }, async t => {
  const { runPilotFixture } = await import('./support/portable-limited-pilot-fixture.mjs');
  const result = await runPilotFixture(t, 'normal-full');
  assert.deepEqual(result.terminal, { code: 0, signal: null }, JSON.stringify(result));
  assert.equal(result.user?.completed, true, JSON.stringify(result.user));
  assert.deepEqual(result.user.forged, { status: 400, code: 'invalid_browser_mode' });
  assert.deepEqual(result.user.preview, { images: 0, budget: 'previewed' });
  assert.deepEqual(result.user.targetRefusal, { status: 400, code: 'target_changed', images: 0 });
  assert.equal(result.user.targetRefusalRecordAbsent, true);
  assert.deepEqual(result.user.guardRefusal, { status: 400, code: 'target_changed', images: 0 });
  assert.deepEqual(result.user.first, { state: 'Review', reason: 'capture_limit_reached', images: 2, dispatch: 'not_sent', range: false });
  assert.equal(result.user.resume, 'advance');
  assert.deepEqual(result.user.end, { state: 'Review', reason: 'end_candidate', images: 3, range: false, sameGuard: true });
  assert.deepEqual(result.user.archives, { zip: true, cbz: true });
  assert.equal(result.user.originalUnchanged, true); assert.equal(result.user.readerClosed, true); assert.equal(result.user.noTrialMarkers, true);
  assert.equal(result.lock, false); assert.equal(result.retainedTemp, false);
});

if (enabled) test('Ubuntu通常取得: 正式Portable公開入口は空き容量の不足で確定原本を保持して停止', { timeout: 150_000 }, async t => {
  const { runPilotFixture } = await import('./support/portable-limited-pilot-fixture.mjs');
  const result = await runPilotFixture(t, 'normal-resource');
  assert.deepEqual(result.terminal, { code: 0, signal: null }, JSON.stringify(result));
  assert.equal(result.user?.completed, true, JSON.stringify(result.user));
  assert.deepEqual(result.user.first, { state: 'Review', reason: 'capture_free_space_limit_reached', images: 1, dispatch: 'not_sent', range: false });
  assert.deepEqual(result.user.stopResult, { status: 'stopped', mode: 'manual', limit: 2, reason: 'capture_free_space_limit_reached', stage: 'resource_stop', dispatch: 'not_sent' });
  assert.equal(result.user.originalUnchanged, true); assert.equal(result.user.readerClosed, true); assert.equal(result.user.noTrialMarkers, true);
  assert.equal(result.lock, false); assert.equal(result.retainedTemp, false);
});

if (enabled) test('Ubuntu通常取得: 正式Portable公開入口の送り応答不明は再送・復帰しない', { timeout: 150_000 }, async t => {
  const { runPilotFixture } = await import('./support/portable-limited-pilot-fixture.mjs');
  const result = await runPilotFixture(t, 'normal-unknown');
  assert.deepEqual(result.terminal, { code: 0, signal: null }, JSON.stringify(result));
  assert.equal(result.user?.completed, true, JSON.stringify(result.user));
  assert.deepEqual(result.user.first, { state: 'NeedsAttention', reason: 'capture_or_advance_failed', images: 1, dispatch: 'unknown', range: false });
  assert.deepEqual(result.user.stopResult, { status: 'stopped', mode: 'manual', limit: 3, reason: 'capture_or_advance_failed', stage: 'advance_dispatch', dispatch: 'unknown' });
  assert.deepEqual(result.user.unknown, { plan: 'blocked', status: 400, code: 'resume_position_required', originalUnchanged: true });
  assert.equal(result.user.readerClosed, true); assert.equal(result.user.noTrialMarkers, true); assert.equal(result.lock, false); assert.equal(result.retainedTemp, false);
});

if (enabled) test('Ubuntu通常取得: 正式Portable公開入口は時間と原本byteの境界で停止する', { timeout: 150_000 }, async t => {
  const { runPilotFixture } = await import('./support/portable-limited-pilot-fixture.mjs');
  for (const mode of ['normal-time', 'normal-bytes']) await t.test(mode, async sub => {
    const result = await runPilotFixture(sub, mode);
    assert.deepEqual(result.terminal, { code: 0, signal: null }, JSON.stringify(result));
    assert.equal(result.user?.completed, true, JSON.stringify(result.user));
    if (mode === 'normal-time') {
      assert.deepEqual(result.user.first, { state: 'Review', reason: 'capture_time_limit_reached', images: 1, dispatch: 'not_sent', range: false });
      assert.deepEqual(result.user.stopResult, { status: 'stopped', mode: 'manual', limit: 2, reason: 'capture_time_limit_reached', stage: 'resource_stop', dispatch: 'not_sent' });
      assert.equal(result.user.originalUnchanged, true);
    } else {
      assert.deepEqual(result.user.first, { state: 'NeedsAttention', reason: 'capture_byte_limit_reached', images: 0, range: false });
      assert.deepEqual(result.user.stopResult, { status: 'stopped', mode: 'manual', limit: 2, reason: 'capture_byte_limit_reached', stage: 'capture', dispatch: 'not_sent' });
      assert.equal(result.user.originalAbsent, true);
    }
    assert.equal(result.user.readerClosed, true); assert.equal(result.user.noTrialMarkers, true);
    assert.equal(result.lock, false); assert.equal(result.retainedTemp, false);
  });
});

if (enabled) test('Ubuntu通常取得: 正式Portable公開入口を正常終了し別CLIで確定位置から重複なく復帰する', { timeout: 150_000 }, async t => {
  const { runPilotFixture } = await import('./support/portable-limited-pilot-fixture.mjs');
  const result = await runPilotFixture(t, 'normal-restart');
  assert.deepEqual(result.restart.first, { code: 0, signal: null });
  assert.equal(result.restart.distinctProcesses, true);
  assert.deepEqual(result.restart.originalRun.first, { state: 'Review', reason: 'capture_limit_reached', images: 2, dispatch: 'not_sent', range: false });
  assert.deepEqual(result.terminal, { code: 0, signal: null }, JSON.stringify(result));
  assert.equal(result.user?.completed, true, JSON.stringify(result.user));
  assert.equal(result.user.resume, 'advance');
  assert.deepEqual(result.user.end, { state: 'Review', reason: 'end_candidate', images: 3, range: false, sameGuard: true });
  assert.equal(result.user.restartOriginalsUnchanged, true);
  assert.deepEqual(result.user.archives, { zip: true, cbz: true });
  assert.equal(result.user.noTrialMarkers, true); assert.equal(result.user.readerClosed, true);
  assert.equal(result.lock, false); assert.equal(result.retainedTemp, false);
});

if (enabled) test('有限archive公開導線: 既存動的匿名Readerの本人gate・有限停止・正常終了から共通cropとCBZへ', { timeout: 150_000 }, async t => {
  const { runPilotFixture } = await import('./support/portable-limited-pilot-fixture.mjs');
  const result = await runPilotFixture(t, 'archive-positive');
  assert.deepEqual(result.terminal, { code: 0, signal: null }, JSON.stringify(result));
  const archive = result.reports.find(r => r.stage === 'archive');
  assert.deepEqual(archive, { stage: 'archive', code: 'completed', images: 2, sends: 1, sameJob: true, sameReader: true,
    png: true, exports: 1, initialRejection: null, previewMatches: true, edited: true, entries: 2, format: 'cbz',
    originalsMatch: true, orderMatches: true, archiveMatches: true });
  assert.deepEqual(result.user.waiting, { selected: false, preview: false, approved: false, images: 0, sends: 0 });
  assert.deepEqual(result.user.beforeStart, { approved: true, images: 0, sends: 0 });
  assert.equal(result.user.controller, path.resolve(process.env.KTZ_CONTROLLER_PATH || path.join(project, 'artifacts/rust-target/debug/ktz-g02-controller')));
  assert.equal(result.user.editable, true); assert.equal(result.user.readerClosed, true);
  assert.deepEqual(result.user.saved, { exports: 1, order: [2, 1], crop: true, originalBytes: true, claimBytes: true, readerClosed: true });
  assert.equal(result.lock, false); assert.equal(result.retainedTemp, false);
  assert.equal(result.standardJobs, 1); assert.equal(result.outsideJobs, 0);
});
if (enabled) test('保存PNG点検driver: 所有検出と検出失敗時の通常closeを同じCLIで回収', { timeout: 150_000 }, async t => {
  const { runPilotFixture } = await import('./support/portable-limited-pilot-fixture.mjs');
  for (const mode of ['saved-review-positive', 'saved-review-window-missing']) await t.test(mode, async sub => {
    const result = await runPilotFixture(sub, mode), c = result.control;
    assert.deepEqual(c.cli.terminal, { exit: 0, signal: null, spawnError: false });
    assert.equal(c.cli.closeRequested, true, '画面検出失敗でも同じ所有CLIのSIGINT正常終了を回収');
    assert.ok(c.cli.identity.pid > 1 && c.cli.identity.birth && c.cli.identity.exe && c.cli.identity.cwd);
    assert.ok(c.helper.identity.pid > 1 && c.helper.identity.birth);
    assert.equal(c.helper.mode, 'same-cli-process');
    assert.equal(c.helper.identity.pid, c.cli.identity.pid, 'observerはCLI同process、別helperの終了を捏造しない');
    assert.equal(c.helper.taskJoined, true);
    assert.equal(c.helper.terminal.signal, null); assert.equal(c.helper.terminal.spawnError, false);
    assert.deepEqual(result.before, result.after, 'manifest/消費claim/保存PNGはbyte不変');
    assert.equal(result.tempEntries, 0);
    assert.deepEqual(result.journalEvents[0], { phase: 'before', hashes: result.before });
    assert.ok(result.journalEvents.findIndex(e => e.phase === 'cli_spawned') > 0, '事前hashはspawn identityより先に永続化');
    assert.deepEqual(result.journalEvents.find(e => e.phase === 'cli_terminal').terminal, c.cli.terminal);
    assert.deepEqual(result.journalEvents.find(e => e.phase === 'helper_terminal').terminal, c.helper.terminal);
    if (mode === 'saved-review-positive') {
      assert.equal(c.helper.terminal.exit, 0, JSON.stringify(c.gui));
      assert.equal(c.gui.ownedWindow, true, JSON.stringify(c.gui)); assert.equal(c.gui.recover, true, JSON.stringify(c.gui));
      assert.equal(c.gui.oneDecodedCard, true, JSON.stringify(c.gui)); assert.equal(c.gui.review, true, JSON.stringify(c.gui));
      assert.deepEqual(result.witness, { actions: ['recover', 'review'], state: 'Review', images: 1,
        manifestState: 'paused', exports: 0, browserOpen: false, limited: true });
    } else {
      assert.equal(c.helper.terminal.exit, 0); assert.equal(c.gui.failure, 'fixture_window_missing');
      assert.equal(c.gui.ownedWindow, false); assert.equal(c.gui.recover, false); assert.equal(c.gui.review, false);
      assert.equal(result.witness, null, '検出不成立時はpublic commandを一切送らない');
    }
  });
});
const pipeHook = new URL('./support/owned-pipe-sample-hook.mjs', import.meta.url).href;
// Keep all established startup assertions exact; validate the newly optional
// closed observation separately rather than discarding unknown extra fields.
function startupBase(value) {
  const { connectionObservation, ...base } = value;
  if (connectionObservation !== undefined) assert.deepEqual(connectionObservation, projectStartupConnectionObservation(connectionObservation));
  return base;
}

test('Portable限定: wait補助はblank接合を返しcommit境界だけを待つ', async () => {
  const source = await readFile(new URL('./support/portable-limited-gui-hook.mjs', import.meta.url), 'utf8');
  const marker = '  if (actualWait) {';
  const start = source.indexOf(marker) + marker.length;
  const end = source.indexOf("  if (process.env.KTZ_LIMITED_TEST_MODE === 'pipe-failure')", start);
  assert.ok(start >= marker.length && end > start);
  const body = source.slice(start, end).replace(/\s*}\s*$/, '');
  for (const mode of ['wait-main-dcl', 'wait-blank']) {
    let url = 'about:blank', navigations = 0;
    const library = { url: () => url, isClosed: () => false,
      waitForURL: () => { throw new Error('接合中に旧入口を待ってはいけない'); },
      goto: async target => { navigations++; url = target; } };
    const browser = { contexts: () => [{ pages: () => [library] }], isConnected: () => true };
    const fixture = new Function('chromium', 'origin', 'mode', 'AppError', `
      const process = { env: { KTZ_LIMITED_TEST_MODE: mode } }, globalThis = {};
      let attached, waitTrace, releaseReady, readyGateClosing = false, startupOrder;
      ${body}
      return { connect: () => chromium.connectOverCDP(), release: () => releaseReady?.(),
        trace: () => waitTrace, order: () => startupOrder };
    `)({ connectOverCDP: async () => browser }, 'http://127.0.0.1:1234', mode, Error);
    assert.equal(await fixture.connect(), browser, 'blankのまま接合を返す');
    assert.equal(navigations, 0);
    const pending = library.goto('http://127.0.0.1:1234/', { waitUntil: 'commit', timeout: 30_000 });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(fixture.trace().gate, 'held');
    assert.equal(navigations, mode === 'wait-blank' ? 0 : 1);
    fixture.release(); await pending;
    assert.equal(navigations, 1);
    assert.deepEqual(fixture.order(), { initialBlank: true, navigations: 1, fixedNavigation: true, commitOnly: true });
    await library.goto('http://127.0.0.1:1235/explicit-user-navigation', { waitUntil: 'commit' });
    assert.equal(navigations, 2, '到達後逸脱の明示操作を再びstartup gateへ留めない');
    assert.equal(fixture.order().navigations, 1);
  }
});

// The direct readiness tests still enter through the same fixed, one-use
// pre/post attachment checks as Reader.open. Only synthetic target IDs cross it.
async function attachPortableInitial(pipe, child, browser, context, page) {
  const info = () => ({ type: 'page', targetId: 'anonymous-target', browserContextId: 'anonymous-context', url: 'about:blank' });
  let pending = '';
  child.stdio[4].on('data', bytes => {
    pending += bytes.toString(); let end;
    while ((end = pending.indexOf('\0')) !== -1) {
      const request = JSON.parse(pending.slice(0, end)); pending = pending.slice(end + 1);
      assert.equal(request.method, 'Target.getTargets');
      queueMicrotask(() => child.stdio[5].write(`${JSON.stringify({ id: request.id, result: { targetInfos: [info()] } })}\0`));
    }
  });
  context.newCDPSession = async () => ({ send: async () => ({ targetInfo: info() }), detach: async () => {} });
  await pipe.beforeAttach(); await pipe.afterAttach(browser);
  assert.equal(context.pages()[0], page);
}

if (process.platform === 'linux') test('最小OS adapter: 公開Applicationから所有pipeと共通Readerへ接続し正常終了・不明保全・本人gateを維持', { timeout: 20_000 }, async t => {
  // Existing synthetic IPC/page fixture only: no browser process or service is
  // launched. Relocate the fixed bundle policy in this isolated test process.
  const base = '/tmp/opencode/ktz-refusal-20261103';
  await mkdir(base, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(path.join(base, 'fixture-'));
  t.after(() => rm(root, { recursive: true }));
  const script = `
    import assert from 'node:assert/strict';
    import path from 'node:path';
    import { mkdir, lstat, readFile } from 'node:fs/promises';
    import { EventEmitter } from 'node:events';
    import childProcess from 'node:child_process';
    import { registerHooks, syncBuiltinESMExports } from 'node:module';
    const root = process.env.KTZ_MINIMAL_ADAPTER_ROOT;
    registerHooks({ load(url, context, next) {
      const result = next(url, context);
      if (url.endsWith('/app/application.mjs')) return { ...result, source: result.source.toString().replace(
        'const normal = portableNormalAvailable(this.dataDir) && !this.portableArchiveTrial;',
        'const normal = false; // synthetic historic limited fixture') };
      if (!url.endsWith('/app/portable-linux-site.mjs')) return result;
      let source = result.source.toString();
      const selected = "const selectedBundle = '/home/user/KTZ-Portable';";
      const own = source.split('\\n').find(line => line.startsWith('const ownRoot = '));
      assert.ok(source.includes(selected) && source.includes(own));
      source = source.replace(selected, 'const selectedBundle = ' + JSON.stringify(root) + ';')
        .replace(own, 'const ownRoot = ' + JSON.stringify(root) + ';')
        .replace('await consumePortableArchiveCapture(path.dirname(selected.root), job, selected.id);', '/* synthetic historic limited grant */');
      return { ...result, source };
    } });
    const { ControlOwner } = await import('./tests/support/owned-pipe-control-fixture.mjs');
    const { capturePortableReaderEnvironment } = await import('./app/linux-owned-reader.mjs');
    const keys = ['HOME', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'TMPDIR', 'TMP', 'TEMP'];
    for (const key of keys) process.env[key] = 'launch-' + key;
    delete process.env.XDG_DATA_HOME; process.env.TMP = '';
    const captured = Object.fromEntries(keys.filter(key => Object.hasOwn(process.env, key)).map(key => [key, process.env[key]]));
    capturePortableReaderEnvironment();
    for (const key of keys) process.env[key] = 'control-' + key;
    process.env.WAYLAND_DISPLAY = 'fixture-wayland'; process.env.KTZ_PORTABLE_ROOT = root;
    const owners = [], forks = [], connects = []; let mode = 'normal', page, browser;
    childProcess.fork = (file, args, options) => {
      assert.ok(file.endsWith('/app/linux-owned-reader-owner.mjs'));
      assert.equal(args[0], '--portable-session'); assert.equal(args.length, 2);
      assert.equal(args[1], selected.id);
      assert.deepEqual(options.execArgv, []); assert.equal(options.detached, true);
      for (const key of keys) {
        assert.equal(Object.hasOwn(options.env, key), Object.hasOwn(captured, key));
        if (Object.hasOwn(captured, key)) assert.equal(options.env[key], captured[key]);
        assert.equal(process.env[key], 'control-' + key);
      }
      assert.equal(options.env.KTZ_PORTABLE_READER_DATA, path.join(root, 'data/application'));
      assert.equal(options.env.KTZ_FIXTURE_CURRENT, mode);
      const child = new ControlOwner('normal'); child.pid = 10001; owners.push(child); forks.push(args);
      const send = child.send.bind(child);
      child.send = (message, callback) => {
        if (message.event === 'check') {
          child.sent.push('check'); queueMicrotask(() => child.emit('message', { event: 'checked', id: message.id })); callback?.(); return;
        }
        if (mode === 'unknown' && message.event === 'close') {
          child.sent.push('close'); child.emit('message', { event: 'unknown' }); callback?.(); return;
        }
        return send(message, callback);
      };
      let buffered = '';
      child.stdio[4].on('data', bytes => {
        buffered += bytes.toString(); let end;
        while ((end = buffered.indexOf('\\0')) !== -1) {
          const request = JSON.parse(buffered.slice(0, end)); buffered = buffered.slice(end + 1);
          assert.equal(request.method, 'Target.getTargets');
          queueMicrotask(() => child.stdio[5].write(JSON.stringify({ id: request.id, result: { targetInfos: [{
            type: 'page', targetId: 'fixture-target', browserContextId: 'fixture-context', url: 'about:blank' }] } }) + '\\0'));
        }
      });
      queueMicrotask(() => child.emit('message', { event: 'ready', kind: 'fixed-expected-reader', browserPid: 10002 }));
      return child;
    };
    syncBuiltinESMExports();
    const { chromium } = await import('playwright');
    chromium.launchPersistentContext = async () => { throw new Error('persistent_launcher_must_not_run'); };
    chromium.connectOverCDP = async (transport, options) => {
      assert.equal(options.noDefaults, true); assert.equal(options.timeout, 30000); assert.ok(transport);
      assert.equal(typeof transport.kill, 'undefined');
      connects.push(transport);
      const context = new EventEmitter(); browser = new EventEmitter(); page = new EventEmitter();
      let url = 'about:blank', viewport = null, scale = 1;
      Object.assign(page, { context: () => context, isClosed: () => false, mainFrame: () => page, url: () => url,
        setDefaultTimeout() {}, viewportSize: () => viewport, setViewportSize: async value => { viewport = value; },
        evaluate: async fn => {
          const source = String(fn);
          if (source.includes('innerWidth') && source.includes('innerHeight')) return { width: 1100, height: 850 };
          if (source.includes('devicePixelRatio')) return mode === 'scale-error' ? scale + 1 : scale;
          throw new Error('unexpected_document_read');
        },
        goto: async (target, options) => {
          assert.equal(target, 'https://read.amazon.co.jp/');
          assert.deepEqual(options, { waitUntil: 'commit', timeout: 30000 });
          url = mode === 'auth' ? 'https://www.amazon.co.jp/' : target; page.emit('framenavigated', page);
        },
        fixtureNavigate: value => { url = value; page.emit('framenavigated', page); },
      });
      Object.assign(context, { browser: () => browser, pages: () => [page], newCDPSession: async () => ({
        send: async (method, params) => {
          if (method === 'Target.getTargetInfo') return { targetInfo: { type: 'page', targetId: 'fixture-target', browserContextId: 'fixture-context', url: 'about:blank' } };
          assert.equal(method, 'Emulation.setDeviceMetricsOverride'); scale = params.deviceScaleFactor; return {};
        }, detach: async () => {},
      }) });
      Object.assign(browser, { isConnected: () => true, contexts: () => [context] });
      return browser;
    };
    const data = path.join(root, 'data/application'); await mkdir(data, { recursive: true, mode: 0o700 });
    const { startApplication } = await import('./app/server.mjs');
    const { Reader } = await import('./app/reader.mjs');
    const { resolvePortableLinuxSession } = await import('./app/portable-linux-session.mjs');
    const running = await startApplication({ dataDir: data }), app = running.app;
    const command = app.command.bind(app); let commandError;
    app.command = async (...args) => { try { return await command(...args); } catch (error) { commandError = error; throw error; } };
    const selected = await resolvePortableLinuxSession(data);
    const request = async (action, input = {}) => {
      const response = await fetch(running.origin + '/api/command', { method: 'POST', headers: {
        Authorization: 'Bearer ' + running.token, Origin: running.origin, 'Content-Type': 'application/json',
      }, body: JSON.stringify({ action, input }) });
      return { status: response.status, body: await response.json() };
    };
    const jobs = new Set();
    try {
      process.env.WAYLAND_DISPLAY = '';
      assert.equal((await request('create')).status, 200);
      const noDisplayJob = app.job.manifest.job_id;
      assert.deepEqual(await request('openBrowser', { mode: 'kindle', session: selected.id }), { status: 400, body: { code: 'browser_open_failed' } });
      assert.equal(commandError.cause.code, 'owned_pipe_unconfirmed');
      assert.equal(app.readerReleasePending, false); assert.equal(owners.length, 0);
      await assert.rejects(lstat(path.join(data, 'portable-reader-limited-' + noDisplayJob + '.claim')), { code: 'ENOENT' });
      assert.equal((await request('closeJob')).status, 200);
      process.env.WAYLAND_DISPLAY = 'fixture-wayland';
      for (mode of ['normal', 'auth', 'scale-error', 'unknown']) {
        process.env.KTZ_FIXTURE_CURRENT = mode;
        assert.equal((await request('create')).status, 200);
        assert.equal((await request('preparePortableKindle', { session: selected.id })).status, 200);
        const job = app.job.manifest.job_id;
        assert.equal(jobs.has(job), false); jobs.add(job);
        const opened = await request('openBrowser', { mode: 'kindle', session: selected.id });
        assert.ok((await lstat(path.join(data, 'portable-reader-limited-' + job + '.claim'))).isFile());
        assert.deepEqual(JSON.parse(await readFile(path.join(data, 'portable-reader-limited-' + job + '.claim'), 'utf8')),
          { version: 2, job, session: selected.id, scope: 'preview-1-displays-2-turn-1-png-review', consumed: true });
        const owner = owners.at(-1);
        if (mode === 'scale-error') {
          assert.deepEqual(opened, { status: 400, body: { code: 'browser_open_failed' } });
          assert.equal(app.readerReleasePending, false); assert.equal(app.reader, null);
          assert.equal(owner.sent.filter(item => item === 'close').length, 1);
          assert.equal(owner.sent.filter(item => item === 'release').length, 1);
        } else {
          assert.equal(opened.status, 200, mode + ':' + String(commandError?.cause?.stack ?? commandError)); assert.ok(app.reader instanceof Reader);
          assert.equal(opened.body.browserOpen, true); assert.equal(opened.body.portableLimitedJob, true);
          assert.equal(opened.body.portableReaderHold, undefined); assert.equal(app.reader.explicitPage, undefined);
          assert.equal(app.reader.readGuard, null); assert.equal(app.reader.ownedSessionGuard.limited, true);
          assert.deepEqual(await request('start', { confirmed: true }), { status: 400, body: { code: 'explicit_start_required' } });
          assert.deepEqual(await request('approve', { confirmed: true, maxCaptures: 2 }), { status: 400, body: { code: 'preview_confirmation_required' } });
          assert.deepEqual(await request('export', { destination: path.join(root, 'forbidden.zip') }), { status: 400, body: { code: 'portable_limited_review_only' } });
          assert.deepEqual(await request('setCaptureSettings', { image_format: 'jpeg' }), { status: 400, body: { code: 'portable_limited_review_only' } });
          if (mode === 'auth') {
            page.fixtureNavigate('https://read.amazon.co.jp/');
            const tab = app.reader.tabs()[0]; assert.ok(tab);
            assert.equal((await request('selectReaderTab', { id: tab.id })).status, 200);
            page.fixtureNavigate('https://unknown.invalid/'); page.fixtureNavigate('https://read.amazon.co.jp/');
            assert.deepEqual(await request('quickPreview'), { status: 400, body: { code: 'target_changed' } });
          } else if (mode === 'normal') {
            assert.deepEqual(await request('quickPreview'), { status: 400, body: { code: 'select_reader_tab' } });
          }
          if (mode !== 'unknown') assert.equal(app.reader.ownedSessionGuard.singleRunBudget.snapshot().phase, 'failed');
          assert.equal(app.job.manifest.images.length, 0); assert.equal(app.job.manifest.exports.length, 0);
          const closed = await request('closeBrowser');
          if (mode === 'unknown') {
            assert.deepEqual(closed, { status: 400, body: { code: 'reader_close_failed' } });
            assert.equal(app.readerReleasePending, true); assert.equal(app.readerLifecycle.state, 'close_unconfirmed');
            assert.ok(owner.sent.includes('retain')); assert.equal(owner.sent.includes('release'), false);
            assert.deepEqual(await request('openBrowser', { mode: 'kindle', session: selected.id }), { status: 400, body: { code: 'reader_release_incomplete' } });
          } else {
            assert.equal(closed.status, 200); assert.equal(app.readerReleasePending, false);
            assert.equal(owner.sent.filter(item => item === 'close').length, 1);
            assert.equal(owner.sent.filter(item => item === 'release').length, 1);
            assert.equal(owner.sent.includes('retain'), false);
          }
        }
        if (mode !== 'unknown') {
          assert.deepEqual(await request('openBrowser', { mode: 'kindle', session: selected.id }), { status: 400, body: { code: 'portable_limited_review_only' } });
          assert.equal((await request('closeJob')).status, 200);
        }
      }
      assert.equal(forks.length, 4); assert.equal(connects.length, 4);
      assert.equal((await lstat(selected.profile)).isDirectory(), true);
      await assert.rejects(lstat(path.join(data, 'portable-reader-startup')), { code: 'ENOENT' });
    } finally { await running.close().catch(() => {}); for (const owner of owners) owner.dispose(); }
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: project, env: { ...process.env, KTZ_MINIMAL_ADAPTER_ROOT: root }, encoding: 'utf8', timeout: 15_000,
  });
  assert.equal(result.error, undefined); assert.equal(result.signal, null);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

if (process.platform === 'linux') test('最小OS adapter: Reader子環境は起動時7キーだけを復元し親と匿名ownerの隔離を維持', async t => {
  for (const [variant, originalTmp] of [
    { TMPDIR: 'fixture-launch-tmpdir', TMP: '', TEMP: 'fixture-launch-temp' },
    {},
  ].entries()) await t.test(variant === 0 ? '元値と空文字' : '標準TMP未設定', async () => {
  const childProcess = (await import('node:child_process')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const { ControlOwner } = await import('./support/owned-pipe-control-fixture.mjs');
  // Isolate this one process-lifetime snapshot from other tests' module state.
  const api = await import(`../app/linux-owned-reader.mjs?reader-environment-test-${variant}`);
  const restoredKeys = ['HOME', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'TMPDIR', 'TMP', 'TEMP'];
  const keys = [...restoredKeys, 'WAYLAND_DISPLAY', 'KTZ_TEMP_DIR'];
  const before = new Map(keys.map(key => [key, Object.hasOwn(process.env, key) ? process.env[key] : undefined]));
  const originalFork = childProcess.fork, calls = [], owners = [], children = [];
  const selected = { id: 'saved-01234567-89ab-cdef-0123-456789abcdef', root: '/fixture/application/saved-01234567-89ab-cdef-0123-456789abcdef' };
  try {
    process.env.WAYLAND_DISPLAY = 'fixture-wayland'; process.env.KTZ_TEMP_DIR = 'fixture-owned-temp';
    childProcess.fork = (file, args, options) => {
      calls.push({ file, args, options });
      const child = new ControlOwner('normal'); children.push(child);
      if (args.length) queueMicrotask(() => child.emit('message', { event: 'ready', kind: 'fixed-expected-reader', browserPid: 12345 }));
      return child;
    };
    syncBuiltinESMExports();
    await assert.rejects(api.startLinuxOwnedReader({ selected, expectedReader: true, usePortableEnvironment: true }), { code: 'owned_pipe_unconfirmed' });
    assert.equal(calls.length, 0, 'snapshotなしではforkしない');
    process.env.HOME = 'fixture-launch-home'; delete process.env.XDG_CACHE_HOME;
    process.env.XDG_CONFIG_HOME = 'fixture-launch-config'; delete process.env.XDG_DATA_HOME;
    for (const key of ['TMPDIR', 'TMP', 'TEMP']) {
      if (Object.hasOwn(originalTmp, key)) process.env[key] = originalTmp[key];
      else delete process.env[key];
    }
    api.capturePortableReaderEnvironment();
    for (const key of restoredKeys) process.env[key] = 'fixture-control-temp';
    assert.throws(() => api.capturePortableReaderEnvironment(), { code: 'owned_pipe_unconfirmed' });
    owners.push(await api.startLinuxOwnedReader({ selected, expectedReader: true, usePortableEnvironment: true }));
    const env = calls[0].options.env;
    assert.equal(env.HOME === 'fixture-launch-home' && env.XDG_CONFIG_HOME === 'fixture-launch-config', true, '設定済み値は内部一致');
    assert.equal(!Object.hasOwn(env, 'XDG_CACHE_HOME') && !Object.hasOwn(env, 'XDG_DATA_HOME'), true, '元の未設定は削除状態');
    for (const key of ['TMPDIR', 'TMP', 'TEMP']) assert.equal(env[key] === originalTmp[key]
      && Object.hasOwn(env, key) === Object.hasOwn(originalTmp, key), true, '標準TMPの存在/元値/空文字を内部一致');
    assert.equal(env.KTZ_TEMP_DIR === 'fixture-owned-temp', true, '管理tempは変更しない');
    const normal = { ...process.env }; delete normal.NODE_OPTIONS; delete normal.CHROMIUM_FLAGS; delete normal.DEBUG; delete normal.PWDEBUG;
    normal.KTZ_PORTABLE_READER_DATA = path.dirname(selected.root);
    for (const key of new Set([...Object.keys(normal), ...Object.keys(env)])) {
      if (!restoredKeys.includes(key)) assert.equal(env[key] === normal[key] && Object.hasOwn(env, key) === Object.hasOwn(normal, key), true, '7キー以外は従前どおり');
    }
    assert.equal(restoredKeys.every(key => process.env[key] === 'fixture-control-temp'), true, '親/Applicationはtempのまま');
    owners.push(await api.startLinuxOwnedReader());
    assert.equal(restoredKeys.every(key => calls[1].options.env[key] === 'fixture-control-temp'), true, '匿名ownerには復元しない');
    await assert.rejects(api.startLinuxOwnedReader({ usePortableEnvironment: true }), { code: 'owned_pipe_unconfirmed' });
    await assert.rejects(api.startLinuxOwnedReader({ selected, expectedReader: true, usePortableEnvironment: { HOME: 'fixture-forged' } }), { code: 'owned_pipe_unconfirmed' });
    assert.equal(calls.length, 2, '任意復元objectや匿名指定を拒否');
    const main = await readFile(new URL('../app/main.mjs', import.meta.url), 'utf8');
    const capture = main.indexOf('    capturePortableReaderEnvironment();');
    const isolate = main.indexOf("for (const key of ['KTZ_TEMP_DIR'");
    assert.equal(capture >= 0 && capture < isolate && isolate < main.indexOf('running = await startApplication('), true, '通常mainは隔離前にcapture');
    assert.equal(main.includes('enablePortableStartupTimeControl'), false, '比較済み時間対照は次の通常入口/pilotで自動反復しない');
    const control = await readFile(new URL('../app/control-window.mjs', import.meta.url), 'utf8');
    assert.equal(control.includes('HOME: tempDirectory') && control.includes('XDG_CACHE_HOME: tempDirectory') && control.includes('XDG_CONFIG_HOME: tempDirectory') && control.includes('XDG_DATA_HOME: tempDirectory'), true, 'control明示tempは不変');
    assert.equal(['TMPDIR', 'TMP', 'TEMP'].every(key => control.includes(`${key}: tempDirectory`)), true, 'control標準TMP隔離は不変');
    const caller = await readFile(new URL('../app/portable-linux-reader.mjs', import.meta.url), 'utf8');
    assert.equal(caller.indexOf('assertPortableReaderEnvironment();') >= 0
      && caller.indexOf('assertPortableReaderEnvironment();') < caller.indexOf('await claimPortableLimitedRun(')
      && caller.includes("usePortableEnvironment: ['portable-limited', 'portable-normal'].includes(authorization)"), true, '実Readerだけ、claim前に検証');
    const owner = await readFile(new URL('../app/linux-owned-reader-owner.mjs', import.meta.url), 'utf8');
    assert.equal(owner.includes("const env = { ...process.env, DISPLAY: '' };") && owner.includes('env, detached: true'), true, 'Snapまで同envを継承');
    for (const owner of owners) await owner.close();
    assert.equal(children.every(child => child.sent.filter(event => event === 'release').length === 1
      && child.sent.includes('close') && !child.sent.includes('retain')), true, '復元の有無とも既存の正常close/joinを維持');
  } finally {
    for (const owner of owners) await owner.close();
    for (const child of children) child.dispose();
    childProcess.fork = originalFork; syncBuiltinESMExports();
    for (const [key, value] of before) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
  });
});

if (process.platform === 'linux') test('Portable限定: 接合段階を公開Readerで一度だけ観測し取得gateと正常joinを維持', async t => {
  const { chromium } = await import('playwright');
  const { Reader } = await import('../app/reader.mjs');
  const { ControlOwner } = await import('./support/owned-pipe-control-fixture.mjs');
  const { superviseLinuxOwnedReader } = await import('../app/linux-owned-reader.mjs');
  const { portableReaderCapability } = await import('../app/portable-limited-session.mjs');
  const { claimPortableLimitedRun } = await import('../app/portable-limited-claim.mjs');
  const { portableStartupRecorder, readPortableStartupRecord } = await import('../app/portable-limited-failure.mjs');
  const { projectStartupConnectionObservation, startupOriginKind } = await import('../app/portable-startup-observation.mjs');
  assert.equal(startupOriginKind('https://read.amazon.co.jp/private?secret') === 'reader_origin'
    && startupOriginKind('https://private@read.amazon.co.jp/') === 'other'
    && startupOriginKind('https://read.amazon.co.jp.evil.invalid/') === 'other_https', true);
  assert.throws(() => projectStartupConnectionObservation({ pre_playwright: { singlePage: 'reader_origin', url: 'private-secret' } }));
  await mkdir('/tmp/opencode/ktz-refusal-20261103', { recursive: true, mode: 0o700 });
  const root = await mkdtemp('/tmp/opencode/ktz-refusal-20261103/stages-');
  t.after(() => rm(root, { recursive: true }));
  const id = '0123456789abcdef0123456789abcdef', sessionId = 'saved-01234567-89ab-cdef-0123-456789abcdef';
  for (const mode of ['ready', 'delay', 'pre-not-blank', 'pre-many', 'pre-error', 'post-other-id', 'post-other-context', 'post-url-not-blank', 'post-error', 'multiple-contexts', 'page-replaced', 'owner-unconfirmed', 'goto-failure', 'close-unknown']) await t.test(mode, async () => {
    const data = path.join(root, mode), jobPath = path.join(data, 'jobs', id), selected = { id: sessionId, root: path.join(data, sessionId) };
    selected.profile = path.join(selected.root, 'owned/profile');
    await mkdir(jobPath, { recursive: true, mode: 0o700 }); await mkdir(selected.profile, { recursive: true, mode: 0o700 });
    const manifest = { job_id: id, state: 'ready', images: [], exports: [], next_capture_id: 1, next_render_version: 1,
      last_capture_id: null, checkpoint: null, capture_settings: { image_format: 'png', page_output_mode: 'single_image' } };
    await claimPortableLimitedRun(data, selected, { job_path: jobPath, orphan_files: [], issues: [], manifest });
    const recorder = portableStartupRecorder(data, id, sessionId); await recorder.begin();
    const child = new ControlOwner(mode === 'close-unknown' ? 'normal-without-exit' : 'normal'), originalSend = child.send.bind(child), commands = [];
    let checks = 0;
    child.send = (message, callback) => {
      if (message.event !== 'check') return originalSend(message, callback);
      child.sent.push('check'); commands.push('check');
      if (++checks === 4 && mode === 'owner-unconfirmed') { callback?.(new Error('anonymous_owner_failure')); return; }
      queueMicrotask(() => child.emit('message', { event: 'checked', id: message.id })); callback?.();
    };
    const info = (url, targetId = 'private-target') => ({ type: 'page', targetId, browserContextId: 'private-context', url, title: 'private-title' });
    let pending = '';
    child.stdio[4].on('data', bytes => {
      pending += bytes.toString(); let end;
      while ((end = pending.indexOf('\0')) !== -1) {
        const message = JSON.parse(pending.slice(0, end)); pending = pending.slice(end + 1); commands.push(message.method);
        assert.equal(message.method === 'Target.getTargets' && message.id === -1, true);
        const targets = [info(mode === 'pre-not-blank' ? 'https://read.amazon.co.jp/' : 'about:blank')];
        if (mode === 'pre-many') targets.push(info('about:blank', 'private-other-target'));
        const response = mode === 'pre-error' ? { id: -1, error: { message: 'private-secret' } } : { id: -1, result: { targetInfos: targets } };
        queueMicrotask(() => child.stdio[5].write(`${JSON.stringify(response)}\0`));
      }
    });
    queueMicrotask(() => child.emit('message', { event: 'ready', kind: 'fixed-expected-reader', browserPid: 12345 }));
    const owner = await superviseLinuxOwnedReader(child, { expectedReader: true, startupTimeoutMs: 100, closeTimeoutMs: 100 });
    const capability = portableReaderCapability(owner, { dataDirectory: data, jobId: id, sessionId }, recorder);
    const browser = new EventEmitter(), context = new EventEmitter(), page = new EventEmitter(), other = new EventEmitter();
    let evaluated = 0, connected = 0, url = 'about:blank', releaseNavigation;
    let pages = [page]; const navigations = [];
    Object.assign(page, { context: () => context, isClosed: () => false, mainFrame: () => page,
      url: () => url,
      goto: async (target, options) => {
        navigations.push({ target, options }); commands.push('goto');
        if (['goto-failure', 'close-unknown'].includes(mode)) throw new Error('anonymous_navigation_failure');
        if (mode === 'delay') await new Promise(resolve => { releaseNavigation = resolve; });
        url = 'https://read.amazon.co.jp/'; page.emit('framenavigated', page);
      },
      setDefaultTimeout: () => {}, evaluate: async () => { evaluated++; return { width: 100, height: 100 }; }, setViewportSize: async () => {} });
    Object.assign(other, { context: () => context, isClosed: () => false, url: () => 'about:blank' });
    Object.assign(context, { browser: () => browser, pages: () => pages, newCDPSession: async () => ({
      send: async method => { commands.push(method); assert.equal(method, 'Target.getTargetInfo');
        if (mode === 'post-error') throw new Error('private-secret https://private.invalid/credential');
        if (mode === 'page-replaced') { pages = [other]; context.emit('page', other); }
        const value = info(page.url(), mode === 'post-other-id' ? 'private-other-target' : 'private-target');
        if (mode === 'post-other-context') value.browserContextId = 'private-other-context';
        if (mode === 'post-url-not-blank') value.url = 'https://read.amazon.co.jp/';
        return { targetInfo: value }; },
      detach: async () => { commands.push('detach'); },
    }) });
    Object.assign(browser, { isConnected: () => true, contexts: () => mode === 'multiple-contexts' ? [context, {}] : [context] });
    const connect = chromium.connectOverCDP;
    chromium.connectOverCDP = async (transport, options) => {
      connected++; assert.equal(transport === owner.transport && options.noDefaults === true, true);
      transport.onmessage = () => {}; transport.onclose = () => {};
      return browser;
    };
    let reader; const lifecycle = { state: 'not_started' };
    try {
      let failure;
      const operation = Reader.open({ ownedSession: capability, headless: false, handleSignals: false, lifecycle }).then(value => { reader = value; }, error => { failure = error; });
      if (mode === 'delay') {
        while (!releaseNavigation) await new Promise(resolve => setImmediate(resolve));
        assert.equal(url, 'about:blank'); assert.equal(evaluated, 0); assert.equal(Boolean(reader), false);
        releaseNavigation();
      }
      await operation;
      assert.equal(commands.filter(method => method === 'Target.getTargets').length, 1);
      assert.equal(connected, ['pre-error', 'pre-not-blank', 'pre-many'].includes(mode) ? 0 : 1);
      const canNavigate = ['ready', 'delay', 'goto-failure', 'close-unknown'].includes(mode);
      assert.equal(navigations.length, canNavigate ? 1 : 0, '所有・接合・同一page確認が先');
      if (canNavigate) {
        assert.deepEqual(navigations[0], { target: 'https://read.amazon.co.jp/', options: { waitUntil: 'commit', timeout: 30_000 } });
        assert.ok(commands.indexOf('Target.getTargets') < commands.indexOf('Target.getTargetInfo'));
        assert.ok(commands.indexOf('detach') < commands.indexOf('goto'));
        assert.ok(commands.slice(0, commands.indexOf('goto')).filter(item => item === 'check').length >= 4);
      }
      if (['ready', 'delay'].includes(mode)) {
        assert.equal(Boolean(reader) && evaluated === 1, true);
        const budget = reader.ownedSessionGuard.singleRunBudget.snapshot();
        assert.equal(budget.phase === 'preview' && budget.screenshots === 0 && budget.sends === 0 && !budget.approved, true);
        await recorder.ready(); await reader.close();
      } else {
        assert.equal(Boolean(failure), true); assert.equal(evaluated, 0);
        if (['pre-not-blank', 'pre-many', 'post-other-id', 'post-other-context', 'post-url-not-blank', 'multiple-contexts', 'page-replaced'].includes(mode)) assert.equal(failure.code, 'target_changed');
        if (['pre-error', 'post-error'].includes(mode)) assert.equal(failure.code, 'owned_pipe_unconfirmed');
      }
      const result = await readPortableStartupRecord(data, id), observed = result.connectionObservation;
      assert.equal(result.record, 'complete');
      if (mode === 'pre-error') assert.equal(observed, undefined);
      else {
        assert.equal(observed.pre_playwright.singlePage, mode === 'pre-many' ? 'unknown' : mode === 'pre-not-blank' ? 'reader_origin' : 'blank');
        if (['pre-not-blank', 'pre-many', 'post-error'].includes(mode)) assert.equal(observed.post_playwright, undefined);
        else assert.equal(observed.samePage, mode === 'multiple-contexts' || mode === 'page-replaced' ? 'unknown' : !['post-other-id', 'post-other-context'].includes(mode));
        const copy = recorder.snapshot(); copy.connectionObservation.pre_playwright.singlePage = 'other';
        assert.equal(recorder.snapshot().connectionObservation.pre_playwright.singlePage, observed.pre_playwright.singlePage);
        assert.equal(JSON.parse(await readFile(path.join(data, 'portable-reader-startup', id, 'result.json'), 'utf8')).version, 5);
      }
      const file = path.join(data, 'portable-reader-startup', id, 'result.json'), frozen = await readFile(file, 'utf8');
      recorder.initialRejection('initial_invalid'); recorder.connectionObservation({ pre_playwright: { singlePage: 'other' } });
      await recorder.failed({ code: 'target_changed' }, 'reader_initialize');
      assert.equal(await readFile(file, 'utf8'), frozen, '後続操作は結果と先着拒否を変えない');
      assert.equal(/private-|https?:|url|title|targetId|browserContextId|message|stack/.test(frozen), false, '閉じた分類だけを永続化');
      assert.equal(child.sent.filter(value => value === 'close').length, mode === 'owner-unconfirmed' ? 0 : 1);
      assert.equal(child.sent.filter(value => value === 'release').length, mode === 'owner-unconfirmed' ? 0 : 1);
      assert.equal(child.sent.includes('retain'), ['close-unknown', 'owner-unconfirmed'].includes(mode), '終了不明はretain');
      assert.equal(lifecycle.state, ['close-unknown', 'owner-unconfirmed'].includes(mode) ? 'close_unconfirmed' : 'closed_confirmed');
      assert.equal(manifest.images.length === 0 && manifest.exports.length === 0, true);
    } finally { chromium.connectOverCDP = connect; await capability.close().catch(() => {}); child.dispose(); }
  });
});

if (process.platform === 'linux') test('Portable限定: 10秒対照は未接合の認証遷移で公開Readerを正常joinし旧v5も保持', async t => {
  const { chromium } = await import('playwright');
  const { Reader } = await import('../app/reader.mjs');
  const { ControlOwner } = await import('./support/owned-pipe-control-fixture.mjs');
  const { superviseLinuxOwnedReader } = await import('../app/linux-owned-reader.mjs');
  const { portableReaderCapability } = await import('../app/portable-limited-session.mjs');
  const { claimPortableLimitedRun } = await import('../app/portable-limited-claim.mjs');
  const { portableStartupRecorder, readPortableStartupRecord } = await import('../app/portable-limited-failure.mjs');
  const { enablePortableStartupTimeControl } = await import('../app/portable-startup-observation.mjs');
  await mkdir('/tmp/opencode/ktz-refusal-20261103', { recursive: true, mode: 0o700 });
  const root = await mkdtemp('/tmp/opencode/ktz-refusal-20261103/time-'); t.after(() => rm(root, { recursive: true }));
  const id = '0123456789abcdef0123456789abcdef', sessionId = 'saved-01234567-89ab-cdef-0123-456789abcdef';
  async function setup(name) {
    const data = path.join(root, name), jobPath = path.join(data, 'jobs', id), selected = { id: sessionId, root: path.join(data, sessionId) };
    selected.profile = path.join(selected.root, 'owned/profile');
    await mkdir(jobPath, { recursive: true, mode: 0o700 }); await mkdir(selected.profile, { recursive: true, mode: 0o700 });
    await claimPortableLimitedRun(data, selected, { job_path: jobPath, orphan_files: [], issues: [], manifest: {
      job_id: id, state: 'ready', images: [], exports: [], next_capture_id: 1, next_render_version: 1, last_capture_id: null, checkpoint: null,
      capture_settings: { image_format: 'png', page_output_mode: 'single_image' } } });
    const recorder = portableStartupRecorder(data, id, sessionId); await recorder.begin();
    return { data, recorder, file: path.join(data, 'portable-reader-startup', id, 'result.json') };
  }
  const current = await setup('current'), child = new ControlOwner('normal'), requests = [];
  const send = child.send.bind(child);
  child.send = (message, callback) => {
    if (message.event !== 'check') return send(message, callback);
    queueMicrotask(() => child.emit('message', { event: 'checked', id: message.id })); callback?.();
  };
  child.stdio[4].on('data', bytes => {
    const request = JSON.parse(bytes.toString().slice(0, -1)); requests.push(request.method);
    const targetInfos = [{ type: 'page', targetId: 'private-target', browserContextId: 'private-context', title: 'private-title',
      url: requests.length === 1 ? 'about:blank' : 'https://www.amazon.co.jp/private-secret' }];
    queueMicrotask(() => child.stdio[5].write(JSON.stringify({ id: request.id, result: { targetInfos } }) + '\0'));
  });
  queueMicrotask(() => child.emit('message', { event: 'ready', kind: 'fixed-expected-reader', browserPid: 12345 }));
  const owner = await superviseLinuxOwnedReader(child, { expectedReader: true, startupTimeoutMs: 100, closeTimeoutMs: 100 });
  enablePortableStartupTimeControl();
  assert.throws(() => enablePortableStartupTimeControl(), { code: 'owned_pipe_unconfirmed' });
  const capability = portableReaderCapability(owner, { dataDirectory: current.data, jobId: id, sessionId }, current.recorder);
  const connect = chromium.connectOverCDP; let connects = 0;
  chromium.connectOverCDP = async () => { connects++; throw new Error('must_not_attach'); };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const operation = assert.rejects(Reader.open({ ownedSession: capability, handleSignals: false }), { code: 'target_changed' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests.length, 1); t.mock.timers.tick(9999); assert.equal(requests.length, 1);
    t.mock.timers.tick(1); await operation;
    assert.equal(connects, 0, '認証側へ移っていれば接合/30秒待機を強行しない');
    assert.deepEqual(requests, ['Target.getTargets', 'Target.getTargets']);
    const result = await readPortableStartupRecord(current.data, id);
    assert.equal(result.record, 'complete'); assert.equal(result.initialRejection, 'known_auth_pending');
    assert.deepEqual(result.failure, { stage: 'pipe_attach', code: 'target_changed' });
    assert.deepEqual(result.connectionObservation, { pre_playwright: { singlePage: 'blank' },
      pre_playwright_10s: { singlePage: 'known_auth_origin', samePage: true, complete: true } });
    const frozen = await readFile(current.file, 'utf8'); assert.equal(JSON.parse(frozen).version, 6);
    assert.equal(/private-|https?:|url|title|targetId|browserContextId|message|stack/.test(frozen), false);
    current.recorder.connectionObservation({ pre_playwright: { singlePage: 'other' } }); current.recorder.initialRejection('initial_invalid');
    await current.recorder.failed({ code: 'owned_pipe_unconfirmed' }, 'pipe_attach');
    assert.equal(await readFile(current.file, 'utf8'), frozen);
    assert.equal(child.sent.filter(value => value === 'close').length, 1); assert.equal(child.sent.filter(value => value === 'release').length, 1);
  } finally { t.mock.timers.reset(); chromium.connectOverCDP = connect; await capability.close(); child.dispose(); }
  const legacy = await setup('v5');
  const bytes = JSON.stringify({ version: 5, lastReached: 'pipe_attached', pipe: 'attached', outcome: 'failed',
    failure: { stage: 'reader_initialize', code: 'operation_timeout' }, initialization: { started: 'pipe_ready', completed: 'page_identity' },
    initialRejection: 'known_auth_pending', connectionObservation: { pre_playwright: { singlePage: 'reader_origin' },
      post_playwright: { singlePage: 'known_auth_origin', ownedContext: true, readerCandidates: '0' }, samePage: true } });
  await writeFile(legacy.file, bytes, { flag: 'wx', mode: 0o600 });
  const old = await readPortableStartupRecord(legacy.data, id);
  assert.equal(old.record, 'complete'); assert.equal(old.connectionObservation.samePage, true);
  assert.equal(await readFile(legacy.file, 'utf8'), bytes, 'v5は埋戻しも書換えもしない');
  const main = await readFile(new URL('../app/main.mjs', import.meta.url), 'utf8');
  const validate = main.indexOf('    validatePortableLimitedPilot();');
  assert.equal(validate >= 0 && !main.includes('enablePortableStartupTimeControl'), true, '内部の明示対照seamは残すが通常/pilot入口の自動armは退役');
});

test('Portable限定: 10秒対照のReader継続・個体変更・複数/未知origin中止は閉分類だけを残す', async t => {
  const { PassThrough } = await import('node:stream');
  const { ownedPipeTransport } = await import('../app/linux-playwright-pipe.mjs');
  for (const mode of ['reader-stays', 'page-changes', 'multiple', 'other-origin']) await t.test(mode, async sub => {
    const api = await import(`../app/portable-startup-observation.mjs?time-control-${mode}`);
    api.enablePortableStartupTimeControl();
    const input = new PassThrough(), output = new PassThrough(), snapshots = [], rejections = [], requests = [];
    const transport = ownedPipeTransport({ stdio: [null, null, null, input, output] });
    const info = { type: 'page', targetId: 'private-target', browserContextId: 'private-context', title: 'private-title', url: 'about:blank' };
    input.on('data', bytes => {
      const request = JSON.parse(bytes.toString().slice(0, -1)); requests.push(request.method);
      let targetInfos = [info];
      if (request.id === -2) {
        targetInfos = [{ ...info, url: 'https://read.amazon.co.jp/private-secret' }];
        if (mode === 'page-changes') targetInfos = [{ ...targetInfos[0], targetId: 'private-other' }];
        if (mode === 'multiple') targetInfos = [targetInfos[0], { ...targetInfos[0], targetId: 'private-other' }];
        if (mode === 'other-origin') targetInfos = [{ ...info, url: 'https://private.invalid/private-secret' }];
      }
      queueMicrotask(() => output.write(JSON.stringify({ id: request.id, result: { targetInfos } }) + '\0'));
    });
    const hooks = api.portableStartupObservation({ transport, assertOwned: async () => {} }, {
      connectionObservation: value => snapshots.push(api.projectStartupConnectionObservation(value)), initialRejection: value => rejections.push(value),
    });
    sub.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      let failure;
      const pending = hooks.beforeAttach().catch(error => { failure = error; });
      await new Promise(resolve => setImmediate(resolve)); sub.mock.timers.tick(10_000); await pending;
      assert.equal(requests.length, 2);
      if (mode === 'reader-stays') {
        assert.equal(failure, undefined);
        const page = new EventEmitter(), context = new EventEmitter(), browser = new EventEmitter();
        Object.assign(page, { isClosed: () => false, context: () => context, url: () => 'https://read.amazon.co.jp/private-secret', mainFrame: () => page });
        Object.assign(context, { browser: () => browser, pages: () => [page], newCDPSession: async () => ({ send: async method => {
          requests.push(method); assert.equal(method, 'Target.getTargetInfo'); return { targetInfo: { ...info, url: page.url() } }; }, detach: async () => {} }) });
        Object.assign(browser, { isConnected: () => true, contexts: () => [context] });
        await assert.rejects(hooks.afterAttach(browser), { code: 'target_changed' });
        assert.equal(snapshots.at(-1).post_playwright.readerCandidates, '1'); assert.equal(snapshots.at(-1).samePage, true);
      } else { assert.equal(failure?.code, 'target_changed'); assert.deepEqual(rejections, ['initial_invalid']); }
      const observed = snapshots.at(-1);
      assert.equal(observed.pre_playwright_10s.complete, true);
      assert.equal(observed.pre_playwright_10s.samePage, mode === 'multiple' ? 'unknown' : mode !== 'page-changes');
      assert.equal(/private-|https?:|url|title|targetId|browserContextId/.test(JSON.stringify(observed)), false);
    } finally { sub.mock.timers.reset(); transport.close(); input.end(); output.end(); }
  });
});

if (enabled) test('限定GUI pilot: 固定入口・本人待ち・拒否と正常終了', { timeout: 360_000 }, async t => {
  const { runPilotFixture } = await import('./support/portable-limited-pilot-fixture.mjs');
  for (const mode of ['positive', 'ambiguous', 'race', 'stage-race', 'base-dir-race', 'pending-base-dir-return', 'origin', 'owner-unknown', 'close-unknown']) await t.test(mode, async sub => {
    const result = await runPilotFixture(sub, mode);
    const outcome = result.reports.find(value => value.stage === 'review' || value.stage === 'stopped');
    const shutdown = result.reports.find(value => value.stage === 'shutdown');
    assert.ok(outcome, `fixed outcome missing (${mode})`); assert.ok(shutdown, `shutdown missing (${mode})`);
    assert.equal(result.terminal.signal, null);
    if (mode === 'positive' || mode === 'close-unknown') {
      assert.deepEqual(result.user?.waiting, { selected: false, preview: false, approved: false, images: 0, sends: 0 });
      assert.deepEqual(result.user?.beforeStart, { approved: true, images: 0, sends: 0 });
      assert.deepEqual(result.user?.review, { images: 2, exports: 0, sends: 1 });
      assert.equal(result.reports.filter(value => value.stage === 'waiting').length, 1);
      assert.equal(outcome.stage, 'review'); assert.equal(outcome.images, 2); assert.equal(outcome.sends, 1);
      assert.equal(outcome.png, true); assert.equal(outcome.exports, 0); assert.equal(outcome.sameJob, true); assert.equal(outcome.sameReader, true);
      assert.equal(outcome.previewMatches, true);
      assert.equal(result.lock, false);
    } else {
      assert.equal(outcome.stage, 'stopped'); assert.equal(outcome.images, 0); assert.equal(outcome.sends, 0);
      assert.equal(result.reports.some(value => value.stage === 'waiting'), false);
    }
    if (mode === 'ambiguous') assert.equal(outcome.code, 'session_ambiguous');
    if (['race', 'stage-race', 'base-dir-race', 'pending-base-dir-return'].includes(mode)) assert.equal(outcome.code, 'state_changed');
    if (mode === 'base-dir-race' || mode === 'pending-base-dir-return') {
      assert.equal(result.outsideJobs, 0, '準備の失効後は標準保存先の外へジョブを作成しない');
      assert.equal(result.standardJobs, 0, '入力が元に戻っても失効した準備操作を実行しない');
      assert.equal(result.lock, false);
    }
    if (mode === 'origin') {
      assert.deepEqual(outcome.startup, { stage: 'reader_initialize', code: 'target_changed', initialRejection: 'origin_mismatch',
        initialOrigin: { kind: 'other_http', reachedExpectedOrigin: false } });
      assert.equal(result.lock, false); assert.equal(result.durableMatches, true);
    }
    if (mode === 'owner-unknown') { assert.equal(result.lock, true); assert.equal(shutdown.code, 'unconfirmed'); assert.equal(result.retainedTemp, true); }
    else if (mode === 'close-unknown') { assert.equal(shutdown.code, 'unconfirmed'); assert.equal(result.retainedTemp, true); }
    else { assert.equal(shutdown.code, 'confirmed'); assert.equal(result.retainedTemp, false); }
    assert.equal(result.terminal.code, mode === 'positive' ? 0 : 1);
    assert.equal(result.recordSecretAbsent, true);
  });
  await t.test('normal-launch', async sub => {
    const result = await runPilotFixture(sub, 'normal');
    assert.deepEqual(result.terminal, { code: 0, signal: null });
    assert.deepEqual(result.user, { created: true, images: 0, browser: false });
    assert.deepEqual(result.reports, []); assert.equal(result.lock, false); assert.equal(result.retainedTemp, false);
  });
});

test('限定GUI pilot: 旧jobと同じownerの二重実行を拒否', async () => {
  const { runPortableLimitedPilot } = await import('../app/portable-limited-pilot.mjs');
  const browser = { isConnected: () => true }, page = { isClosed: () => false, url: () => 'http://127.0.0.1:1234/',
    evaluateHandle: async () => ({ evaluate: async () => true, dispose: async () => {} }) };
  const context = { browser: () => browser, pages: () => [page] }; page.context = () => context;
  const job = { manifest: { job_id: '0123456789abcdef0123456789abcdef', images: [], exports: [] } };
  const app = { job, bookGeneration: 1, snapshot: async () => ({ job, operationRevision: 0, sessions: [] }) };
  const control = { page, context, browser };
  const first = await runPortableLimitedPilot({ app, control, origin: 'http://127.0.0.1:1234' });
  assert.equal(first.code, 'old_job'); assert.equal(first.images, 0);
  await assert.rejects(runPortableLimitedPilot({ app, control, origin: 'http://127.0.0.1:1234' }), error => error.pilotCode === 'duplicate');

  const nextPage = { ...page }, nextContext = { browser: () => browser, pages: () => [nextPage] };
  nextPage.context = () => nextContext;
  let enteredSnapshot, releaseSnapshot;
  const entered = new Promise(resolve => { enteredSnapshot = resolve; });
  const held = new Promise(resolve => { releaseSnapshot = resolve; });
  const concurrent = { job, bookGeneration: 1, snapshot: async () => {
    enteredSnapshot(); await held; return { job, operationRevision: 0, sessions: [] };
  } };
  const nextControl = { page: nextPage, context: nextContext, browser };
  const pending = runPortableLimitedPilot({ app: concurrent, control: nextControl, origin: 'http://127.0.0.1:1234' });
  await entered;
  await assert.rejects(runPortableLimitedPilot({ app: concurrent, control: nextControl, origin: 'http://127.0.0.1:1234' }), error => error.pilotCode === 'duplicate');
  releaseSnapshot(); assert.equal((await pending).code, 'old_job');
});

// In-memory control and Application snapshots only: no browser, profile, job
// files, or approval/start actions are created by this pilot fixture.
async function stoppedPilotFixture(onWaiting, { laterSnapshot, snapshotError = false } = {}) {
  const { runPortableLimitedPilot } = await import('../app/portable-limited-pilot.mjs');
  const id = '0123456789abcdef0123456789abcdef', session = 'saved-01234567-89ab-cdef-0123-456789abcdef';
  const state = { job: null, source: '', session: '', prepared: null, limited: false, browser: false,
    selected: false, preview: false, approved: false, phase: 'preview', screenshots: 0, sends: 0, committed: 0,
    approvedCount: null, state: 'AuthPending', reason: null, lastFailure: null, displayInspection: null,
    progress: { action: 'openBrowser', status: 'success' }, releasePending: false, recovery: false, storage: null };
  let waiting = false, snapshotsAfterWaiting = 0;
  const browser = { isConnected: () => true }, context = { browser: () => browser, pages: () => [page] };
  const budget = { snapshot: () => ({ phase: state.phase, screenshots: state.screenshots, sends: state.sends,
    committed: state.committed, approved: state.approvedCount }) };
  const guard = { limited: true, singleRunBudget: budget };
  const app = { dataDir: '/fixture/data', bookGeneration: 0, readerLifecycle: {}, reader: null, previewImage: null,
    snapshot: async () => {
      if (waiting && snapshotError) throw Object.assign(new Error('PRIVATE_SENTINEL https://private.invalid/'), { code: 'target_changed' });
      const s = { job: state.job, operationRevision: 0, sessions: [{ id: session, saved: true, portableLinuxCandidate: true }],
        portableKindlePrepared: state.prepared, portableLimitedAvailable: true, portableLimitedJob: state.limited,
        busy: false, browserOpen: state.browser, readerReleasePending: state.releasePending, recoveryRequired: state.recovery,
        storageUncertain: state.storage, readerTabConfirmed: state.selected, previewReady: state.preview,
        previewApproved: state.approved, state: state.state, reason: state.reason, lastFailure: state.lastFailure,
        displayInspection: state.displayInspection, operationProgress: state.progress,
        privateSnapshot: 'PRIVATE_SENTINEL https://private.invalid/' };
      if (waiting && ++snapshotsAfterWaiting > 1 && laterSnapshot) return laterSnapshot(s);
      return s;
    } };
  const page = { isClosed: () => Boolean(state.controlClosed), context: () => context, url: () => 'http://127.0.0.1:1234/',
    evaluateHandle: async () => ({ evaluate: async () => true, dispose: async () => {} }),
    evaluate: async () => ({ job: state.job?.manifest.job_id ?? '', epoch: '0', generation: String(app.bookGeneration),
      stage: state.job ? 'browser' : 'setup', revision: '1', source: state.source, session: state.session, baseEmpty: true }),
    locator: selector => ({
      click: async () => {
        if (selector.startsWith('#create[')) {
          state.job = { job_path: path.join(app.dataDir, 'jobs', id), manifest: { job_id: id, images: [], exports: [] } };
          app.bookGeneration = 1;
        } else if (selector.startsWith('#preparePortableSession[')) state.prepared = session;
        else if (selector.startsWith('#openPreparedPortable[')) {
          state.browser = true; state.limited = true;
          app.reader = { context, ownedSessionGuard: guard };
        } else assert.ok(['#setupOptions > summary', '#portablePreparationOptions > summary'].includes(selector), selector);
      },
      selectOption: async value => {
        if (selector.startsWith('#captureSource[')) state.source = value;
        else if (selector.startsWith('#portableKindleSession[')) state.session = value;
        else assert.fail(selector);
      },
    }) };
  const outcome = await runPortableLimitedPilot({ app, control: { page, context, browser }, origin: 'http://127.0.0.1:1234',
    waiting: value => { assert.deepEqual(value, { stage: 'waiting', code: 'user_action_required', images: 0, sends: 0, sameJob: true });
      waiting = true; onWaiting(state, app); } });
  return outcome;
}

if (process.platform === 'linux') test('対象変更理由: 明示した別タブを公開quickPreviewへ渡し既存停止と固定causeだけを保持', async t => {
  const { Reader } = await import('../app/reader.mjs');
  const { Application } = await import('../app/application.mjs');
  const { AppError } = await import('../app/store-client.mjs');
  const { ControlOwner } = await import('./support/owned-pipe-control-fixture.mjs');
  const { superviseLinuxOwnedReader } = await import('../app/linux-owned-reader.mjs');
  const { portableReaderCapability, portableLimitedSession } = await import('../app/portable-limited-session.mjs');
  const { claimPortableLimitedRun } = await import('../app/portable-limited-claim.mjs');
  assert.equal(portableLimitedSession(Object.freeze({ limited: true })), undefined);
  assert.throws(() => portableReaderCapability({ processIds: {}, transport: {} }, {}), { code: 'target_changed' },
    '似たobjectや呼出し引数から所有capabilityは作れない');
  const base = '/tmp/opencode/ktz-refusal-20261103';
  await mkdir(base, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(`${base}/target-reason-`); t.after(() => rm(root, { recursive: true }));
  const id = '0123456789abcdef0123456789abcdef', sessionId = 'saved-01234567-89ab-cdef-0123-456789abcdef';
  const secret = 'PRIVATE_SENTINEL https://private.invalid/';
  for (const [mode, cause, code = 'target_changed'] of [['generation', 'generation_changed'], ['document', 'document_changed'],
    ['identity', 'expected_identity_changed'], ['unknown-detail', null], ['unchanged', null],
    ['companion-navigation', 'initial_invalid'], ['companion-origin-return', 'initial_invalid'],
    ['companion-close', 'page_closed'], ['companion-add-remove', 'generation_changed'],
    ['companion-pin-gap', 'initial_invalid'], ['companion-extra', 'preview_selection_unavailable'],
    ['companion-target', 'preview_selection_unavailable'], ['companion-context', 'owner_binding_changed'],
    ['companion-unselected', null, 'select_reader_tab']]) await t.test(mode, async () => {
    const companion = mode.startsWith('companion-');
    const data = path.join(root, mode), jobPath = path.join(data, 'jobs', id);
    const selected = { id: sessionId, root: path.join(data, sessionId) }; selected.profile = path.join(selected.root, 'owned/profile');
    await mkdir(jobPath, { recursive: true, mode: 0o700 }); await mkdir(selected.profile, { recursive: true, mode: 0o700 });
    const manifest = { job_id: id, state: 'ready', images: [], exports: [], next_capture_id: 1, next_render_version: 1,
      last_capture_id: null, checkpoint: null, capture_settings: { image_format: 'png', page_output_mode: 'single_image', capture_scale: 1 } };
    const job = { job_path: jobPath, orphan_files: [], issues: [], manifest };
    await claimPortableLimitedRun(data, selected, job);
    const browser = new EventEmitter(), context = new EventEmitter(), initial = new EventEmitter(), page = new EventEmitter();
    let initialUrl = 'about:blank', selectedUrl = 'https://read.amazon.co.jp/manga/B000KTZ001';
    let pages = [initial], reader, armed = false, injected = false, configured = 0, handles = 0, positionUnavailable = false;
    Object.assign(initial, { context: () => context, isClosed: () => false, mainFrame: () => initial, url: () => initialUrl,
      setDefaultTimeout: () => {}, goto: async () => { initialUrl = companion ? 'https://www.amazon.co.jp/' : 'https://read.amazon.co.jp/'; initial.emit('framenavigated', initial); } });
    Object.assign(page, { context: () => context, isClosed: () => false, mainFrame: () => page,
      url: () => selectedUrl, setDefaultTimeout: () => {},
      evaluate: async (_fn, options) => options?.metadata
        ? { state: 'ok', position: { min: 1, max: 2, value: 1 }, region: { x: 0, y: 0, width: 100, height: 100 } }
        : { asin: 'B000KTZ001', title: '匿名の本', aliases: [] },
      evaluateHandle: async value => {
        if (typeof value === 'string') return { evaluate: async fn => fn({ current: () => mode === 'identity' ? 'changed' : 'current', dispose() {} }), dispose: async () => {} };
        if (++handles === 1) return { evaluate: async () => mode !== 'document', dispose: async () => {} };
        return { evaluate: async fn => { if (positionUnavailable) throw new Error(secret); return fn({ current: () => true, dispose() {} }); }, dispose: async () => {} };
      } });
    Object.assign(context, { pages: () => pages, browser: () => browser, newCDPSession: async targetPage => {
      const cdp = new EventEmitter();
      return Object.assign(cdp, { detach: async () => {}, send: async method => {
        if (armed && targetPage === page && method === 'Target.getTargetInfo' && !injected) {
          injected = true;
          if (mode === 'generation') reader.changed();
          if (mode === 'unknown-detail') throw new AppError('target_changed', { cause: secret, identity: secret });
          if (['companion-navigation', 'companion-origin-return'].includes(mode)) {
            const before = initialUrl;
            initialUrl = mode === 'companion-navigation' ? 'https://www.amazon.co.jp/changed' : 'https://read.amazon.co.jp/';
            initial.emit('framenavigated', initial); initialUrl = before; initial.emit('framenavigated', initial);
          }
          if (mode === 'companion-close') initial.emit('close');
          if (mode === 'companion-context') reader.context = {};
          if (mode === 'companion-add-remove') {
            const extra = Object.assign(new EventEmitter(), { setDefaultTimeout() {} });
            pages = [initial, page, extra]; context.emit('page', extra); pages = [initial, page];
          }
        }
        return method === 'Target.getTargetInfo' ? { targetInfo: { type: 'page', targetId: targetPage === initial ? 'fixture-initial' : 'fixture-selected',
          browserContextId: 'fixture-context', url: targetPage.url() } } : {};
      } });
    } });
    Object.assign(browser, { contexts: () => [context], isConnected: () => true, newBrowserCDPSession: async () => ({ detach: async () => {},
      send: async method => method === 'Browser.getWindowForTarget' ? { windowId: 1 } : { bounds: { windowState: 'normal' } } }) });
    const child = new ControlOwner('normal'), send = child.send.bind(child);
    child.send = (message, callback) => {
      if (message.event !== 'check') return send(message, callback);
      if (armed && mode === 'companion-pin-gap' && !injected) {
        injected = true; initial.emit('framenavigated', initial);
      }
      queueMicrotask(() => child.emit('message', { event: 'checked', id: message.id })); callback?.();
    };
    queueMicrotask(() => child.emit('message', { event: 'ready', kind: 'fixed-expected-reader', browserPid: 12345 }));
    const owner = await superviseLinuxOwnedReader(child, { expectedReader: true, startupTimeoutMs: 100, closeTimeoutMs: 100 });
    const capability = portableReaderCapability(owner, { dataDirectory: data, jobId: id, sessionId });
    const pipe = portableLimitedSession(capability);
    try {
      const newCDPSession = context.newCDPSession;
      await attachPortableInitial(pipe, child, browser, context, initial); await pipe.ready(initial);
      context.newCDPSession = newCDPSession; // The startup-only fixture wrapper omits later Page events.
      reader = new Reader(context, initial, null, () => {}, false);
      reader.ownedSessionGuard = await pipe.bind(reader);
      pages = [initial, page]; context.emit('page', page);
      if (mode === 'companion-extra') {
        const extra = Object.assign(new EventEmitter(), { url: () => 'https://www.amazon.co.jp/', context: () => context,
          isClosed: () => false, setDefaultTimeout() {} });
        pages = [initial, page, extra]; context.emit('page', extra);
      }
      reader.setCaptureScale = async () => 1;
      reader.configure = async () => { configured++; return { png: await reader.ownedSessionGuard.singleRunBudget.screenshot('preview', async () => Buffer.from('fixture')),
        book: {}, position: '1', dimensions: {}, cssDimensions: {} }; };
      const app = Object.create(Application.prototype);
      Object.assign(app, { job, reader, state: 'AuthPending', epoch: 0, bookGeneration: 1, commands: new Set(),
        presets: { selected: 'fixture', presets: [{ id: 'fixture', mode: 'visible' }] },
        isPortableLimitedJob: async () => true, snapshot: async () => ({}), inspectLayout: async () => ({}), planResume: () => null });
      const tab = reader.tabs().find(item => item.id !== reader.pageLabels.get(initial).id);
      if (companion) await assert.rejects(app.command('selectReaderTab', { id: reader.pageLabels.get(initial).id }), { code: 'invalid_reader_tab' },
        '非取得companionは本人指定APIからも候補に採用できない');
      if (mode !== 'companion-unselected') {
        await app.command('selectReaderTab', { id: tab.id });
        assert.equal(reader.explicitPage, page); assert.equal(reader.page, page);
      }
      if (mode === 'companion-target') selectedUrl = 'https://www.amazon.co.jp/auth-required';
      armed = true;
      if (mode === 'unchanged') {
        await app.command('quickPreview');
        assert.equal(configured, 1); assert.equal(app.state, 'Preview'); assert.equal(app.previewApproved, false);
        assert.equal(reader.ownedSessionGuard.singleRunBudget.snapshot().screenshots, 1);
        // A still-raiseable dependency error keeps the old target_changed
        // fallback; neither its message nor arbitrary detail is reported.
        positionUnavailable = true;
        await assert.rejects(reader.ownedSessionGuard.assertIdentity(), { code: 'target_changed', detail: { cause: 'identity_check_unavailable' } });
      } else {
        await assert.rejects(app.command('quickPreview'), { code });
        assert.equal(configured, 0); assert.equal(app.state, 'AuthPending');
        assert.equal(app.displayInspection.code, code); assert.equal(app.displayInspection.stage, 'preview_inspection');
        assert.equal(reader.ownedSessionGuard.singleRunBudget.snapshot().phase, 'failed');
        assert.equal(reader.ownedSessionGuard.singleRunBudget.snapshot().screenshots, 0);
        const projected = await stoppedPilotFixture(state => Object.assign(state, { phase: 'failed',
          displayInspection: app.displayInspection, progress: { action: 'quickPreview', status: 'failure' } }));
        assert.equal(projected.stop.observedCause, cause ?? undefined);
        assert.equal(projected.stop.observedCode, code); assert.equal(projected.images, 0); assert.equal(projected.sends, 0);
        if (mode === 'identity') assert.deepEqual(projected.stop.identityDiagnostic, { stage: 'identity', reason: 'identity_changed' });
        assert.doesNotMatch(JSON.stringify(projected), /PRIVATE_SENTINEL|https?:|fixture-selected|匿名の本|B000KTZ001/);
        await assert.rejects(reader.ownedSessionGuard.preparePreview(), { code: 'expected_capture_budget_exhausted' });
      }
      assert.equal(reader.ownedSessionGuard.singleRunBudget.snapshot().sends, 0);
      assert.deepEqual(manifest.images, []); assert.deepEqual(manifest.exports, []);
    } finally { await reader?.ownedSessionGuard?.dispose(); await capability.close(); child.dispose(); }
    assert.equal(child.sent.filter(value => value === 'close').length, 1); assert.equal(child.sent.filter(value => value === 'release').length, 1);
  });
});

if (enabled) test('対象変更理由: 所有初期bootstrapは非取得のまま明示Readerをpreview・別開始で有限Reviewへ通す', { timeout: 50_000 }, async t => {
  const { runPilotFixture } = await import('./support/portable-limited-pilot-fixture.mjs');
  const result = await runPilotFixture(t, 'blue-bootstrap-companion'), user = result.user;
  assert.deepEqual(result.terminal, { code: 0, signal: null });
  assert.ok(user, '新しい匿名準備条件を実GUIで通す');
  assert.deepEqual(user.preparation, { selected: true, selectedMember: true, selectedClosed: false,
    candidateCount: 1, selectedAccepted: true, initialAcceptedAsTarget: false,
    initialIsRelocatedBootstrap: true, selectedPublicRoute: true });
  assert.equal(user.selected.pages, 2, '任意foreignの3番目tabではなく初期bootstrapと選択Readerの2tab');
  assert.equal(user.selected.scale, user.selected.requestedScale);
  assert.ok(user.scaleChecks.some(value => value.explicit && value.sameExplicit && value.samePage && value.member
    && value.pages === 2 && value.scale === user.selected.requestedScale), '共通の非同期setCaptureScale後も明示選択を保持');
  assert.deepEqual(user.preview, { ready: true, approved: false, images: 0,
    budget: { phase: 'previewed', screenshots: 1, sends: 0, committed: 0, approved: null } });
  assert.deepEqual(user.beforeStart, { approved: true, images: 0,
    budget: { phase: 'approved', screenshots: 1, sends: 0, committed: 0, approved: 2 } });
  assert.deepEqual(user.review, { state: 'Review', images: 2, exports: 0,
    budget: { phase: 'finished', screenshots: 2, sends: 1, committed: 2, approved: 2 },
    firstMatches: true, pngs: 2, pngOnly: true, firstBytesMatch: true, companionStillNonTarget: true });
  assert.deepEqual(user.screenshotTargets, [true, true], '撮影は常に明示Readerだけ');
  assert.equal(result.reports.find(value => value.stage === 'review').code, 'completed');
  assert.equal(user.claimUnchanged, true);
  assert.equal(result.standardJobs, 1); assert.equal(result.outsideJobs, 0);
  assert.equal(result.retainedTemp, false); assert.equal(result.lock, false);
  assert.equal(result.evidence, undefined, '停止画面の再画像生成はしない');
  // Anonymous role separation proves neither background authentication safety
  // nor the cause or success of the private Kindle attempt.
});

test('対象変更理由: pilotは既知causeだけを投影し未知detailと偽のidentity分類を破棄', async () => {
  for (const detail of [{ cause: 'PRIVATE_SENTINEL', identity: 'PRIVATE_SENTINEL' },
    { cause: 'expected_identity_changed', identity: { stage: 'identity', reason: 'identity_changed', url: 'PRIVATE_SENTINEL' } }]) {
    const result = await stoppedPilotFixture(state => Object.assign(state, { phase: 'failed', displayInspection: {
      status: 'failed', code: 'target_changed', stage: 'preview_inspection', detail }, progress: { action: 'quickPreview', status: 'failure' } }));
    assert.equal(result.stop.identityDiagnostic, undefined);
    assert.equal(result.stop.observedCause, detail.cause === 'expected_identity_changed' ? detail.cause : undefined);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SENTINEL|url|detail/);
  }
});

test('停止理由引継ぎ: 固定停止は進行中commandを静止してReaderだけ終了し全commandを拒否', async () => {
  const { Application } = await import('../app/application.mjs');
  for (const unconfirmed of [false, true]) {
    let release, closes = 0, budgetFailures = 0;
    const active = new Promise(resolve => { release = resolve; }), lifecycle = { state: 'active' };
    const reader = { lifecycle, ownedSessionGuard: { singleRunBudget: { fail: () => budgetFailures++ } },
      cancelPick: async () => {},
      close: async () => { closes++; if (unconfirmed) throw new Error('PRIVATE_SENTINEL'); lifecycle.state = 'closed_confirmed'; },
      tabs: () => { throw new Error('must_not_query_reader'); } };
    const app = Object.create(Application.prototype), job = { manifest: { job_id: '0123456789abcdef0123456789abcdef', images: [], exports: [] } };
    Object.assign(app, { reader, readerLifecycle: lifecycle, job, commands: new Set([active]), epoch: 0, bookGeneration: 1,
      state: 'AuthPending', store: { close: async () => {}, call: () => { throw new Error('must_not_query_store'); } } });
    const outcome = { stage: 'stopped', images: 0, sends: 0, stop: { observedCode: 'target_changed',
      observedStage: 'preview_inspection', observedCause: 'preview_selection_unavailable', private: 'PRIVATE_SENTINEL' }, message: 'PRIVATE_SENTINEL' };
    const pending = app.holdPortablePilotStop(outcome);
    assert.equal(app.holdPortablePilotStop(outcome), pending);
    assert.equal(closes, 0); assert.equal(budgetFailures, 1);
    assert.equal((await app.snapshot()).portablePilotStop.readerClose, 'pending');
    for (const action of ['quickPreview', 'preview', 'selectReaderTab', 'approve', 'start', 'openBrowser', 'create', 'recover', 'finishBook', 'closeJob', 'export']) {
      await assert.rejects(app.command(action, {}), { code: 'portable_limited_review_only' });
    }
    release(); await pending;
    const result = await app.snapshot();
    assert.equal(result.portablePilotStop.readerClose, unconfirmed ? 'unconfirmed' : 'confirmed');
    assert.equal(result.browserOpen, unconfirmed); assert.equal(result.readerReleasePending, unconfirmed);
    assert.equal(result.job, job); assert.equal(closes, 1);
    assert.doesNotMatch(JSON.stringify(result.portablePilotStop), /PRIVATE_SENTINEL|private|message/);
    if (unconfirmed) await assert.rejects(app.close(), { code: 'reader_close_failed' });
    else await app.close();
    assert.equal(closes, 1, 'window-closeは未確認Readerを再接続/close再試行しない');
  }
});

test('停止理由引継ぎ: 先行所有タイムアウト後も固定停止からCDPを切断し最終終了を未確認で返す', { timeout: 8_000 }, async () => {
  const { Application } = await import('../app/application.mjs');
  const { Reader } = await import('../app/reader.mjs');
  const { superviseLinuxOwnedReader } = await import('../app/linux-owned-reader.mjs');
  const { ControlOwner, connectOwnedPipeControlSession } = await import('./support/owned-pipe-control-fixture.mjs');
  const child = new ControlOwner('normal');
  const owner = await superviseLinuxOwnedReader(child, { startupTimeoutMs: 100, closeTimeoutMs: 40 });
  let shutting, timer, disconnected = false, storeCloses = 0;
  try {
    const { session, methods } = await connectOwnedPipeControlSession(child, owner);
    const onclose = owner.transport.onclose;
    owner.transport.onclose = () => { disconnected = true; onclose?.(); };
    // The real supervisor times out its synthetic owner's unanswered check.
    // No browser/profile/process is created or terminated by this fixture.
    await assert.rejects(owner.assertOwned(), { code: 'owned_pipe_unconfirmed' });
    assert.ok(child.sent.includes('retain'));
    const context = new EventEmitter(); context.pages = () => [];
    const lifecycle = { state: 'active' };
    // The existing CDP fixture deliberately never answers detach. Reader's
    // public cancelPick cleanup can finish only after the client disconnects.
    const page = { evaluate: () => session.detach() };
    const reader = new Reader(context, page, owner.url, () => {}, false, undefined, lifecycle);
    reader.ownedPipe = owner;
    const app = Object.create(Application.prototype), job = { manifest: { images: [], exports: [] } };
    Object.assign(app, { reader, readerLifecycle: lifecycle, job, commands: new Set(), epoch: 0, bookGeneration: 1,
      state: 'AuthPending', store: { close: async () => { storeCloses++; }, call: () => { throw new Error('must_not_query_store'); } } });
    const held = await app.holdPortablePilotStop({ stage: 'stopped', images: 0, sends: 0, stop: { observedCode: 'target_changed' } });
    assert.equal(held.readerClose, 'unconfirmed');
    assert.equal(lifecycle.state, 'close_unconfirmed');
    shutting = app.close().then(() => ({ confirmed: true }), error => ({ error }));
    const terminal = await Promise.race([shutting,
      new Promise(resolve => { timer = setTimeout(() => resolve({ pending: true }), 150); })]);
    assert.equal(terminal.pending, undefined, '先行retain後もwindow-closeのCDP後片付けを無限待ちしない');
    assert.equal(terminal.error?.code, 'reader_close_failed');
    assert.equal(disconnected, true);
    assert.equal(storeCloses, 1);
    assert.equal(child.sent.includes('release'), false, 'unknown ownerのlock解放を認可しない');
    assert.equal(child.sent.includes('close'), false, '先行retain後にbrowser closeを再送しない');
    assert.equal(child.stdio[4].destroyed || child.stdio[5].destroyed, false, 'ownerのpipeは破壊しない');
    assert.equal(methods.includes('Target.detachFromTarget'), false, '切断済みCDPへ新しい後片付け要求を送らない');
    child.emit('message', { event: 'normal' }); child.emit('exit', 0, null);
    await assert.rejects(owner.close(), { code: 'owned_pipe_unconfirmed' });
    assert.equal((await app.snapshot()).portablePilotStop.readerClose, 'unconfirmed', '遅延正常で未確認を成功に変えない');
  } finally {
    clearTimeout(timer);
    owner.transport.close(); // Release only the synthetic client, including on the pre-fix regression.
    await shutting;
    child.dispose();
  }
});

if (enabled) test('停止理由引継ぎ: 実青ボタン・実表示密度・別タブと固定停止画面を公開pilotで検証', { timeout: 150_000 }, async t => {
  const { runPilotFixture } = await import('./support/portable-limited-pilot-fixture.mjs');
  for (const mode of ['blue-preview', 'blue-foreign', 'blue-close-unknown']) await t.test(mode, async sub => {
    const r = await runPilotFixture(sub, mode), user = r.user;
    assert.deepEqual(r.terminal, { code: 1, signal: null });
    assert.ok(user, '匿名GUI操作結果が必要');
    assert.deepEqual(user.waiting, { selected: false, preview: false, approved: false, images: 0, sends: 0 });
    assert.equal(user.selected.explicit && user.selected.page, true); assert.equal(user.selected.pages, 2);
    assert.ok([1, 2].includes(user.selected.requestedScale)); assert.equal(user.selected.scale, user.selected.requestedScale);
    assert.ok(user.selected.viewport.width >= 16 && user.selected.viewport.height >= 16);
    assert.ok(user.scaleChecks.some(check => check.explicit && check.sameExplicit && check.samePage && check.member && check.pages === 2 && check.scale === user.selected.requestedScale),
      'selectReaderTab内の実setCaptureScale後も対象とpage所属を保持');
    assert.equal(user.controlAlive && user.readerDisconnected && user.disabled && user.recordsUnchanged, true);
    assert.equal(user.fixed.readerClose, mode === 'blue-close-unknown' ? 'unconfirmed' : 'confirmed');
    assert.equal(user.fixed.images, 0); assert.equal(user.fixed.sends, 0);
    if (mode === 'blue-preview') assert.deepEqual(user.preview, { ready: true, approved: false, images: 0 });
    else {
      assert.equal(user.fixed.code, 'target_changed'); assert.equal(user.fixed.cause, 'preview_selection_unavailable');
      assert.equal(user.preview, undefined, '未知originを含む集合はプレビュー前の既存guardで拒否');
    }
    for (const blocked of user.forbidden) assert.deepEqual(blocked, { status: 400, code: 'portable_limited_review_only' });
    assert.match(user.text, /再操作は不要/); assert.match(user.text, mode === 'blue-close-unknown' ? /終了は未確認/ : /正常終了を確認/);
    assert.equal(r.reports.filter(v => v.stage === 'stopped').length, 1, 'window-closeで停止結果を二重報告しない');
    assert.equal(r.reports.filter(v => v.stage === 'held').length, 1);
    assert.equal(r.reports.find(v => v.stage === 'shutdown').code, mode === 'blue-close-unknown' ? 'unconfirmed' : 'confirmed');
    assert.equal(r.reports.find(v => v.stage === 'shutdown').reader, mode !== 'blue-close-unknown');
    assert.equal(r.retainedTemp, mode === 'blue-close-unknown');
    assert.equal(r.standardJobs, 1); assert.equal(r.outsideJobs, 0);
  });
});

test('停止理由引継ぎ: 実callerの承認・別開始の対象照合失敗を予算と共に閉分類で報告', async () => {
  const { Application } = await import('../app/application.mjs');
  const { AppError } = await import('../app/store-client.mjs');
  const { createPortableLimitedCaptureBudget } = await import('../app/expected-capture-budget.mjs');
  for (const action of ['approve', 'start']) {
    const budget = createPortableLimitedCaptureBudget();
    budget.beginPreview(); await budget.screenshot('preview', async () => Buffer.from('fixture'));
    if (action === 'start') budget.approve(2);
    const manifest = { state: 'ready', images: [], exports: [], capture_settings: { image_format: 'png', page_output_mode: 'single_image' } };
    const job = { manifest }, calls = [];
    const app = Object.create(Application.prototype);
    Object.assign(app, { job, state: action === 'start' ? 'Ready' : 'Preview', epoch: 0, bookGeneration: 1,
      previewImage: Buffer.from('fixture'), previewApproved: action === 'start', approvedMaxCaptures: 2,
      commands: new Set(), isPortableLimitedJob: async () => true, snapshot: async () => ({}),
      reader: { ownedSessionGuard: { limited: true, singleRunBudget: budget }, requireBound: async () => { throw new AppError('target_changed'); } },
      store: { call: async kind => { calls.push(kind); if (kind === 'job_info') return { snapshot: job }; throw new Error('unexpected_store'); } } });
    await assert.rejects(app.command(action, { confirmed: true, maxCaptures: 2 }), { code: 'target_changed' });
    assert.equal(app.reason, 'target_changed'); assert.equal(app.state, 'AuthPending');
    assert.equal(budget.snapshot().phase, 'failed'); assert.equal(manifest.images.length, 0);
    assert.deepEqual(calls, action === 'start' ? ['job_info'] : [], 'capture_start・保存・送りに進まない');
    const result = await stoppedPilotFixture(state => Object.assign(state, { phase: budget.snapshot().phase,
      state: app.state, reason: app.reason, progress: { action: app.progress.action, status: app.progress.status } }));
    assert.deepEqual(result.stop, { trigger: 'budget_failed', observedAt: 'trigger', observedSource: 'reason', observedCode: 'target_changed',
      observedStage: 'unknown', state: 'AuthPending', action, actionStatus: 'failure' });
    assert.equal(result.code, 'stopped'); assert.equal(result.images, 0); assert.equal(result.sends, 0); assert.equal(result.sameJob, true);
  }
});

test('停止理由引継ぎ: 判定時の優先順位・未知・例外・成功neighborを保全', async () => {
  const secret = 'PRIVATE_SENTINEL https://private.invalid/';
  const first = await stoppedPilotFixture(state => Object.assign(state, {
    phase: 'failed', state: 'NeedsAttention', reason: 'browser_target_changed', progress: { action: 'start', status: 'failure' },
    lastFailure: { code: 'target_changed', stage: 'target_recheck_before_commit', detail: secret, stack: secret },
    displayInspection: { status: 'failed', code: 'reader_ui_unknown', stage: 'preview_inspection', detail: secret },
  }), { laterSnapshot: s => ({ ...s, lastFailure: { code: 'capture_failed', stage: 'capture' } }) });
  assert.deepEqual(first.stop, { trigger: 'application_failure', observedAt: 'trigger', observedSource: 'last_failure', observedCode: 'target_changed',
    observedStage: 'target_recheck_before_commit', state: 'NeedsAttention', action: 'start', actionStatus: 'failure' });

  const inspection = await stoppedPilotFixture(state => Object.assign(state, { phase: 'failed',
    displayInspection: { status: 'failed', code: 'reader_ui_unknown', stage: 'preview_visibility_wait', detail: secret },
    progress: { action: 'quickPreview', status: 'failure' } }));
  assert.deepEqual(inspection.stop, { trigger: 'application_failure', observedAt: 'trigger', observedSource: 'display_inspection', observedCode: 'reader_ui_unknown',
    observedStage: 'preview_visibility_wait', state: 'AuthPending', action: 'quickPreview', actionStatus: 'failure' });

  const unknown = await stoppedPilotFixture(state => Object.assign(state, { phase: 'failed', state: secret,
    lastFailure: { code: secret, stage: secret, detail: secret }, progress: { id: secret, action: secret, status: secret } }));
  assert.deepEqual(unknown.stop, { trigger: 'application_failure', observedAt: 'trigger', observedSource: 'last_failure', observedCode: 'unclassified',
    observedStage: 'unclassified', state: 'unclassified', action: 'unclassified', actionStatus: 'unclassified' });

  const budget = await stoppedPilotFixture(state => Object.assign(state, { phase: 'failed', state: 'Ready',
    progress: { action: 'start', status: 'pending' } }));
  assert.deepEqual(budget.stop, { trigger: 'budget_failed', observedAt: 'trigger', observedSource: 'unknown', observedCode: 'unknown',
    observedStage: 'unknown', state: 'Ready', action: 'start', actionStatus: 'pending' });

  const progressId = '01234567-89ab-cdef-0123-456789abcdef';
  const pending = state => Object.assign(state, { phase: 'failed', state: 'Ready', progress: { id: progressId, action: 'start', status: 'pending' } });
  const settled = await stoppedPilotFixture(pending, { laterSnapshot: s => ({ ...s, state: 'AuthPending', reason: 'target_changed',
    operationProgress: { id: progressId, action: 'start', status: 'failure' } }) });
  assert.deepEqual(settled.stop, { trigger: 'budget_failed', observedAt: 'after_trigger', observedSource: 'reason',
    observedCode: 'target_changed', observedStage: 'unknown', state: 'AuthPending', action: 'start', actionStatus: 'failure' });
  const unrelated = await stoppedPilotFixture(pending, { laterSnapshot: s => ({ ...s, reason: 'target_changed',
    operationProgress: { id: '11234567-89ab-cdef-0123-456789abcdef', action: 'start', status: 'failure' } }) });
  assert.equal(unrelated.stop.observedAt, 'trigger'); assert.equal(unrelated.stop.observedCode, 'unknown');

  const owner = await stoppedPilotFixture(state => Object.assign(state, { releasePending: true, storage: { code: 'storage_durability_uncertain' },
    lastFailure: { code: 'capture_commit_failed', stage: 'capture_commit', detail: secret } }));
  assert.equal(owner.code, 'owner_unknown'); assert.equal(owner.stop.trigger, 'reader_release_pending');
  assert.equal(owner.stop.observedSource, 'last_failure'); assert.equal(owner.stop.observedCode, 'capture_commit_failed');

  const exception = await stoppedPilotFixture(() => {}, { snapshotError: true });
  assert.equal(exception.code, 'unclassified'); assert.deepEqual(exception.stop, { trigger: 'exception', observedAt: 'unknown', observedSource: 'unknown',
    observedCode: 'unknown', observedStage: 'unknown', state: 'unknown', action: 'unknown', actionStatus: 'unknown' });

  const control = await stoppedPilotFixture(state => Object.assign(state, { controlClosed: true,
    lastFailure: { code: 'target_changed', stage: 'capture', detail: secret } }));
  assert.equal(control.code, 'control_changed'); assert.equal(control.stop.trigger, 'pilot_refusal');
  assert.equal(control.stop.observedCode, 'target_changed', '観測された失敗でpilot自身の拒否を置き換えない');

  const success = await stoppedPilotFixture((state, app) => {
    const image = Buffer.from('fixture-image'); app.previewImage = image;
    state.job.manifest.images.push({ path: 'originals/000001.png', image_format: 'png', sha256: hash(image) });
    Object.assign(state, { state: 'Review', phase: 'finished', screenshots: 1, committed: 1, approvedCount: 1 });
  });
  assert.deepEqual(success, { stage: 'review', code: 'completed', images: 1, sends: 0, sameJob: true, sameReader: true,
    png: true, exports: 0, initialRejection: null, previewMatches: true });
  for (const result of [first, inspection, unknown, budget, settled, unrelated, owner, exception, control, success]) {
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SENTINEL|https?:|detail|stack/);
  }
});

test('最小OS adapter pilot: 選択bundleだけ準備を許可し本人gateを代行しない', async () => {
  const { runInNewContext } = await import('node:vm');
  const source = await readFile(new URL('../app/portable-limited-pilot.mjs', import.meta.url), 'utf8');
  const body = /export function validatePortableLimitedPilot\(\) \{([\s\S]*?)\n\}/.exec(source)?.[1];
  assert.ok(body);
  const installed = '/home/user/KTZ-Portable';
  const validate = (change = {}) => runInNewContext(`(function () {${body}\n})()`, {
    installed, ownRoot: installed,
    process: { platform: 'linux', argv: ['node', 'main', '--portable-limited-pilot'],
      env: { KTZ_PORTABLE_ROOT: installed, KTZ_USER_DATA_DIR: `${installed}/data/application` } },
    path, refuse: code => { throw Object.assign(new Error(code), { pilotCode: code }); }, ...change,
  });
  assert.doesNotThrow(() => validate());
  assert.throws(() => validate({ ownRoot: '/other-bundle' }), { pilotCode: 'invalid_invocation' });
  for (const argv of [['node', 'main'], ['node', 'main', '--portable-limited-pilot', 'extra']]) {
    assert.throws(() => validate({ process: { platform: 'linux', argv, env: {} } }), { pilotCode: 'invalid_invocation' });
  }
  assert.throws(() => validate({ process: { platform: 'linux', argv: ['node', 'main', '--portable-limited-pilot'],
    env: { KTZ_PORTABLE_ROOT: installed, KTZ_USER_DATA_DIR: '/other-data' } } }), { pilotCode: 'invalid_invocation' });
  assert.doesNotMatch(source, /app\.command\(|\bfetch\(|connectOverCDP|#previewConfirmed|#approve|#start|#readerTab/);
});

if (process.platform === 'linux') test('限定GUI pilot: 同梱と固定引数・ソース直起動拒否', async () => {
  const { appFiles } = await import('../scripts/linux-distribution.mjs');
  assert.ok(appFiles.includes('app/portable-limited-pilot.mjs'));
  const shell = await readFile(new URL('../scripts/start-linux-bundle.sh', import.meta.url), 'utf8');
  assert.match(shell, /1:--portable-limited-pilot/);
  const implementation = await readFile(new URL('../app/portable-limited-pilot.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(implementation, /app\.command\(|\bfetch\(|connectOverCDP|#previewConfirmed|#approve|#start|#readerTab/);
  const env = { ...process.env }; delete env.KTZ_PORTABLE_ROOT; delete env.KTZ_USER_DATA_DIR;
  for (const args of [['--portable-limited-pilot'], ['--portable-limited-pilot', 'unexpected']]) {
    const result = spawnSync(process.execPath, ['app/main.mjs', ...args], { cwd: project, env, encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 1); assert.equal(result.signal, null);
    assert.match(result.stdout, /KTZ_PILOT \{"stage":"stopped","code":"unclassified"\}/);
    assert.doesNotMatch(result.stdout + result.stderr, /\bError:|\n\s+at\s|https?:\/\//);
  }
  const invalid = spawnSync('/bin/sh', ['scripts/start-linux-bundle.sh', '--portable-limited-pilot', 'unexpected'],
    { cwd: project, encoding: 'utf8', timeout: 10_000 });
  assert.equal(invalid.status, 1); assert.match(invalid.stderr, /許可されない引数/);
});

if (enabled) test('撮影なし起動診断: URLなし匿名復元で成立・不一致・複数拒否と単回終了を検証', { timeout: 150_000 }, async t => {
  const { restoredCapture } = await import('./support/restored-capture-fixture.mjs');
  for (const mode of ['normal', 'wrong-title', 'multiple']) await t.test(mode, async sub => {
    const value = await restoredCapture(sub, mode, 'diagnostic');
    assert.equal(value.first.signal, null); assert.equal(value.first.code, mode === 'normal' ? 0 : 1);
    assert.equal(value.first.stdout, ''); assert.equal(value.first.stderr, '');
    assert.equal(value.checked.code, 0); assert.equal(value.checked.stderr, '');
    assert.equal(value.report.valid, true); assert.equal(value.report.diagnosticComplete, true);
    assert.equal(value.report.readerReady, mode === 'normal'); assert.equal(value.report.shutdown, 'normal');
    assert.ok(Object.values(value.report.checks).every(Boolean));
    assert.deepEqual(value.report.effects, { screenshots: 0, savedImages: 0, pageTurns: 0, archives: 0 });
    assert.equal(value.report.outcome, mode === 'normal' ? 'ready' : 'refused');
    if (mode === 'normal') {
      assert.equal(value.report.initialTabs, 'single'); assert.equal(value.report.startupDiagnostic, null);
    } else if (mode === 'wrong-title') {
      assert.equal(value.report.initialTabs, 'single');
      assert.deepEqual(value.report.startupDiagnostic, { stage: 'identity', reason: 'title_mismatch' });
    } else {
      assert.ok([{ stage: 'page', reason: 'multiple_pages' }, { stage: 'route', reason: 'route_mismatch' }]
        .some(expected => JSON.stringify(expected) === JSON.stringify(value.report.startupDiagnostic)));
      assert.equal(value.report.initialTabs, value.report.startupDiagnostic.stage === 'page' ? 'multiple' : 'single');
    }
    assert.deepEqual(value.events.find(event => event.event === 'launch'), { event: 'launch', restore: true, addedUrl: false });
    assert.equal(value.events.filter(event => event.event === 'launch').length, 1);
    assert.equal(value.events.filter(event => event.event === 'close').length, 1);
    assert.equal(value.events.some(event => ['screenshot', 'unexpected_navigation', 'unexpected_input', 'malformed_protocol'].includes(event.event)), false);
    assert.equal(existsSync(path.join(value.data, 'jobs')), false, '診断は取得jobを作らない');
    for (const [filename, bytes] of Object.entries(value.prior)) assert.equal(await readFile(path.join(value.state, filename), 'utf8'), bytes);
    const filename = path.join(value.state, 'expected-startup-diagnostic-once.result.json');
    const original = await readFile(filename), claim = await readFile(path.join(value.state, 'expected-startup-diagnostic-once.claim'));
    const events = await readFile(path.join(value.home, 'events.ndjson'));
    const again = await value.run(value.entry);
    assert.equal(again.code, 1); assert.equal(again.stdout, ''); assert.equal(again.stderr.trim(), 'startup_diagnostic_failed');
    assert.deepEqual(await readFile(filename), original);
    assert.deepEqual(await readFile(path.join(value.state, 'expected-startup-diagnostic-once.claim')), claim);
    assert.deepEqual(await readFile(path.join(value.home, 'events.ndjson')), events, '再拒否で新ownerを作らない');
    if (mode === 'normal') {
      try {
        for (const patch of [{ startupDiagnostic: { stage: 'identity', reason: 'PRIVATE_DIAGNOSTIC_SENTINEL' } },
          { failure: 'PRIVATE_DIAGNOSTIC_SENTINEL' }, { title: 'PRIVATE_DIAGNOSTIC_SENTINEL' },
          { effects: { ...value.stored.effects, screenshots: 1 } }]) {
          await writeFile(filename, JSON.stringify({ ...value.stored, ...patch }));
          const rejected = await value.run(value.collector);
          assert.equal(rejected.code, 1); assert.equal(rejected.stdout, '');
          assert.equal(rejected.stderr.trim(), 'diagnostic_result_validation_failed');
        }
      } finally { await writeFile(filename, original); }
    }
  });
});

test('撮影なし起動診断: 閉じた結果と途中状態・unknownを混同せず永続化する', async t => {
  const { projectStartupDiagnosticResult: projectResult, initialTabClassification, persistDiagnostic, exclusiveDiagnosticFile } = await import('../app/expected-startup-diagnostic-state.mjs');
  const value = { version: 1, purpose: 'single-expected-startup-diagnostic', phase: 'claimed', outcome: 'interrupted',
    startupDiagnostic: null, initialTabs: 'unconfirmed', failure: null, shutdown: 'not-started', processes: null,
    effects: { screenshots: 0, savedImages: 0, pageTurns: 0, archives: 0 } };
  assert.deepEqual(projectResult(value), value);
  assert.equal(initialTabClassification('refused', { stage: 'page', reason: 'initial_zero_pages' }), 'zero');
  assert.equal(initialTabClassification('refused', { stage: 'context', reason: 'no_context' }), 'unconfirmed');
  const unknown = { ...value, phase: 'reader', outcome: 'refused', failure: 'operation_timeout', shutdown: 'unknown', processes: { owner: 123, browser: 124 } };
  assert.equal(projectResult(unknown).shutdown, 'unknown');
  for (const changed of [{ ...value, arbitrary: 'private' }, { ...value, shutdown: 'normal' },
    { ...unknown, startupDiagnostic: { stage: 'context', reason: 'private' } },
    { ...unknown, processes: { owner: 123, browser: 124, account: 'private' } }]) assert.throws(() => projectResult(changed));
  // The shared tmpfs may have a per-user quota despite reporting free space.
  // This tiny fixture stays beside the already-authorised anonymous profiles.
  const base = tmpdir();
  await mkdir(base, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(path.join(base, 'diagnostic-write-'));
  t.after(() => rm(directory, { recursive: true }));
  const filename = path.join(directory, 'result.json');
  const handle = await exclusiveDiagnosticFile(filename);
  try { await persistDiagnostic(handle, unknown); await persistDiagnostic(handle, value); }
  finally { await handle.close(); }
  assert.deepEqual(JSON.parse(await readFile(filename, 'utf8')), value, '位置指定の上書きでNULや旧末尾を残さない');
  await assert.rejects(exclusiveDiagnosticFile(filename), { code: 'EEXIST' });
  if (process.platform === 'linux') assert.equal((await stat(filename)).mode & 0o777, 0o600);
});

test('撮影なし起動診断: 初期確認後のタブ消失・差替え・複数化は作成せず同ownerで拒否する', () => {
  // Synthetic connection objects only. Run the public Reader.open in an isolated
  // process so the private session/library substitutes cannot affect other tests.
  const script = `
    import assert from 'node:assert/strict';
    import { registerHooks } from 'node:module';
    registerHooks({
      resolve(specifier, context, next) {
        if (specifier === 'playwright') return { url: 'test:startup-diagnostic-playwright', shortCircuit: true };
        return next(specifier, context);
      },
      load(url, context, next) {
        if (url === 'test:startup-diagnostic-playwright') return { format: 'module',
          source: 'export const chromium = globalThis.__startupDiagnosticChromium;', shortCircuit: true };
        if (url.endsWith('/app/owned-session.mjs')) return { format: 'module',
          source: 'export const resolveOwnedSession = () => globalThis.__startupDiagnosticPipe;', shortCircuit: true };
        return next(url, context);
      },
    });
    const chromium = globalThis.__startupDiagnosticChromium = {};
    const { Reader } = await import('./app/reader.mjs');
    for (const mode of ['zero', 'replacement', 'multiple', 'non-owned']) {
      const initial = { isClosed: () => false }, other = { isClosed: () => false };
      let pages = mode === 'non-owned' ? [] : [initial], creations = 0, closes = 0;
      const context = {
        pages() {
          const snapshot = pages;
          queueMicrotask(() => { pages = mode === 'multiple' ? [initial, other] : mode === 'replacement' ? [other] : []; });
          return snapshot;
        },
        async newPage() { creations++; throw new Error('anonymous_new_page_attempt'); },
        async close() { closes++; },
      };
      globalThis.__startupDiagnosticPipe = { startupDiagnostics: true, transport: {}, close: async () => { closes++; } };
      chromium.connectOverCDP = async () => ({ contexts: () => [context] });
      chromium.launchPersistentContext = async () => context;
      const lifecycle = {};
      const opening = Reader.open({ ...(mode === 'non-owned' ? { profile: 'anonymous' } : { ownedSession: {} }), handleSignals: false, lifecycle });
      if (mode === 'non-owned') {
        await assert.rejects(opening, /anonymous_new_page_attempt/);
        assert.equal(creations, 1, '通常の非所有Readerは空contextから作成できる');
      } else {
        await assert.rejects(opening, error => error.code === 'target_changed'
          && JSON.stringify(error.startupDiagnostic) === JSON.stringify({ stage: 'page', reason: mode === 'multiple' ? 'multiple_pages' : 'target_replaced' }));
        assert.equal(creations, 0, '所有診断は消えた復元タブを作り直さない');
      }
      assert.equal(closes, 1);
      assert.equal(lifecycle.state, 'closed_confirmed');
    }
  `;
  const env = { ...process.env };
  for (const key of ['NODE_OPTIONS', 'DEBUG', 'PWDEBUG']) delete env[key];
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: project, env, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.error, undefined); assert.equal(result.signal, null);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
});

if (enabled) test('Linux修正版単回取得: 旧記録を保持し終端で一枚保存して再入を拒否する', { timeout: 120_000 }, async t => {
  for (const stem of ['linux-expected-capture-corrected', 'linux-expected-capture-corrected-result', 'linux-expected-capture', 'linux-expected-capture-result']) {
    const entry = fileURLToPath(new URL(`../app/${stem}.mjs`, import.meta.url));
    const invalid = spawnSync(process.execPath, [entry, '--profile=/tmp/not-allowed'], { encoding: 'utf8', timeout: 5000 });
    assert.equal(invalid.status, 1); assert.equal(invalid.stdout, ''); assert.match(invalid.stderr, /invalid_invocation/);
  }
  const { restoredCapture } = await import('./support/restored-capture-fixture.mjs');
  const value = await restoredCapture(t, 'end', 'corrected');
  assert.equal(value.first.code, 0); assert.equal(value.first.signal, null);
  assert.equal(value.first.stdout, 'KTZ_PREVIEW:requested\nKTZ_PREVIEW:ready\n'); assert.equal(value.first.stderr, '');
  assert.equal(value.checked.code, 0); assert.equal(value.report.success, true);
  assert.equal(value.report.reason, 'end_candidate'); assert.equal(value.report.images.length, 1);
  assert.equal(value.report.budget.screenshots, 1); assert.equal(value.report.budget.sends, 0);
  assert.equal(value.report.confirmedSends, 0); assert.ok(Object.values(value.report.checks).every(Boolean));
  assert.deepEqual(value.events.find(event => event.event === 'launch'), { event: 'launch', restore: true, addedUrl: false });
  assert.equal(value.events.filter(event => event.event === 'screenshot').length, 1);
  assert.equal(value.events.some(event => ['unexpected_navigation', 'unexpected_input', 'malformed_protocol'].includes(event.event)), false);
  const filename = path.join(value.state, 'expected-capture-corrected-590122c0.result.json');
  const claimName = path.join(value.state, 'expected-capture-corrected-590122c0.claim');
  const before = await readFile(filename), claim = await readFile(claimName);
  const eventsBefore = await readFile(path.join(value.home, 'events.ndjson'));
  const again = await value.run(value.entry);
  assert.equal(again.code, 1); assert.deepEqual(await readFile(filename), before);
  assert.deepEqual(await readFile(claimName), claim);
  assert.deepEqual(await readFile(path.join(value.home, 'events.ndjson')), eventsBefore);
  for (const [name, bytes] of Object.entries(value.prior)) assert.equal(await readFile(path.join(value.state, name), 'utf8'), bytes);
  // Collection success and capture success are intentionally separate. Exercise
  // this projection using only this anonymous result, without another browser.
  try {
    await writeFile(filename, JSON.stringify({ ...value.stored, status: 'failed' }));
    const failed = await value.run(value.collector);
    assert.equal(failed.code, 0); assert.equal(JSON.parse(failed.stdout).success, false);
    await writeFile(filename, '{');
    const invalid = await value.run(value.collector);
    assert.equal(invalid.code, 1); assert.equal(invalid.stdout, '');
  } finally { await writeFile(filename, before); }
});

if (enabled) test('Linux通常復元取得: URLなし正常復元を同じ固定CLIで取得する', { timeout: 120_000 }, async t => {
  const { restoredCapture } = await import('./support/restored-capture-fixture.mjs');
  const value = await restoredCapture(t);
  assert.equal(value.first.signal, null); assert.equal(value.first.code, 0);
  assert.equal(value.report.success, true); assert.equal(value.report.images.length, 2);
  assert.equal(value.report.budget.screenshots, 2); assert.equal(value.report.budget.sends, 1);
  assert.ok(value.restored >= 1);
  assert.deepEqual(value.events.find(event => event.event === 'launch'), { event: 'launch', restore: true, addedUrl: false });
  assert.equal(value.events.filter(event => event.event === 'screenshot').length, 2);
  assert.equal(value.events.filter(event => event.event === 'close').length, 1);
  assert.equal(value.events.some(event => ['unexpected_navigation', 'malformed_protocol'].includes(event.event)), false);
  assert.equal(value.report.startupDiagnostic, null);
  // Public collector compatibility: an old result remains unclassified; an
  // arbitrary new diagnostic can never be reflected into its output.
  const filename = path.join(value.state, 'expected-capture-once.result.json');
  const original = await readFile(filename);
  try {
    const legacy = { ...value.stored }; delete legacy.startupDiagnostic;
    await writeFile(filename, JSON.stringify(legacy), { mode: 0o600 });
    const old = await value.run(fileURLToPath(new URL('../app/linux-expected-capture-result.mjs', import.meta.url)));
    assert.equal(old.code, 0); assert.equal(Object.hasOwn(JSON.parse(old.stdout), 'startupDiagnostic'), false);
    await writeFile(filename, JSON.stringify({ ...value.stored, startupDiagnostic: { stage: 'identity', reason: 'PRIVATE_DIAGNOSTIC_SENTINEL' } }), { mode: 0o600 });
    const rejected = await value.run(fileURLToPath(new URL('../app/linux-expected-capture-result.mjs', import.meta.url)));
    assert.equal(rejected.code, 1); assert.equal(rejected.stdout, ''); assert.equal(rejected.stderr.trim(), 'result_validation_failed');
  } finally { await writeFile(filename, original); }
});

if (enabled) test('Linux通常復元取得: 既存復元の不一致・複数・確定後document交換を停止し細分類する', { timeout: 180_000 }, async t => {
  const { restoredCapture } = await import('./support/restored-capture-fixture.mjs');
  for (const mode of ['wrong-title', 'multiple', 'document']) await t.test(mode, async sub => {
    const value = await restoredCapture(sub, mode);
    assert.equal(value.first.code, 1); assert.equal(value.report.success, false);
    assert.equal(value.report.failure.code, 'target_changed');
    if (mode === 'multiple') {
      // Restoration can expose the active wrong book before its sibling page.
      // Reject that known mismatch immediately, not by waiting for two pages
      // merely to manufacture a later/more specific classification.
      assert.ok([{ stage: 'page', reason: 'multiple_pages' }, { stage: 'route', reason: 'route_mismatch' }]
        .some(expected => JSON.stringify(expected) === JSON.stringify(value.report.startupDiagnostic)));
    } else assert.deepEqual(value.report.startupDiagnostic, mode === 'wrong-title'
      ? { stage: 'identity', reason: 'title_mismatch' } : { stage: 'identity', reason: 'document_changed' });
    assert.equal(value.report.images.length, 0); assert.equal(value.report.confirmedSends, 0);
    assert.ok(Object.values(value.report.checks).every(Boolean));
    assert.equal(value.events.filter(event => event.event === 'screenshot').length, mode === 'document' ? 1 : 0);
    assert.deepEqual(value.events.find(event => event.event === 'launch'), { event: 'launch', restore: true, addedUrl: false });
    assert.ok(value.restored >= 1);
    const filename = path.join(value.state, 'expected-capture-once.result.json');
    const before = await readFile(filename), claim = await readFile(path.join(value.state, 'expected-capture-once.claim'));
    const countBefore = (await readFile(path.join(value.home, 'events.ndjson'), 'utf8')).trim();
    const again = await value.run(value.entry);
    assert.equal(again.code, 1); assert.deepEqual(await readFile(filename), before);
    assert.deepEqual(await readFile(path.join(value.state, 'expected-capture-once.claim')), claim);
    assert.equal((await readFile(path.join(value.home, 'events.ndjson'), 'utf8')).trim(), countBefore, 'claim再拒否は新owner・撮影・送りを起こさない');
  });
});

test('Linux通常復元取得: 初期context/page不成立は別pageを作らず閉じた診断へ射影する', async () => {
  const { singleCaptureContext, captureStartupDiagnostic, projectCaptureStartupDiagnostic } = await import('../app/expected-capture-diagnostic.mjs');
  const page = {}, context = pages => ({ pages: () => pages });
  for (const [contexts, expected] of [[[], { stage: 'context', reason: 'no_context' }],
    [[context([])], { stage: 'page', reason: 'initial_zero_pages' }],
    [[context([page, {}])], { stage: 'page', reason: 'multiple_pages' }],
    [[context([page]), context([page])], { stage: 'context', reason: 'multiple_contexts' }]]) {
    assert.throws(() => singleCaptureContext({ contexts: () => contexts }), error => error.code === 'target_changed'
      && JSON.stringify(captureStartupDiagnostic(error)) === JSON.stringify(expected));
  }
  const only = context([page]); assert.strictEqual(singleCaptureContext({ contexts: () => [only] }), only);
  assert.equal(captureStartupDiagnostic({ code: 'target_changed' }), null, '旧失敗から細分類を推測しない');
  assert.throws(() => projectCaptureStartupDiagnostic({ stage: 'page', reason: 'title_mismatch' }));
  assert.throws(() => projectCaptureStartupDiagnostic({ stage: 'identity', reason: 'identity_changed', title: 'private' }));
});

if (process.platform === 'linux') test('Linux通常復元取得の登録境界: Windowsでは純粋診断だけを実行する', () => {
  const env = { ...process.env };
  delete env.NODE_OPTIONS; delete env.NODE_TEST_CONTEXT;
  const script = `
    // Initialise the existing Linux log sink before simulating registration on
    // Windows, without copying browser binaries or launching any browser.
    await import('./tests/chromium-test-log-sink.mjs');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    delete process.env.WAYLAND_DISPLAY;
    await import('./tests/owned-headed-sample-flow.test.mjs');
  `;
  const result = spawnSync(process.execPath, ['--test-name-pattern=^Linux通常復元取得:', '--input-type=module', '-e', script], {
    cwd: project, env, encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(result.error, undefined); assert.equal(result.signal, null);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /初期context\/page不成立/);
  assert.match(result.stdout, /# tests 1\b/);
  assert.doesNotMatch(result.stdout, /URLなし正常復元|既存復元の不一致/);
});

test('Linux期待本session: 固定単回CLIの診断は依存例外の任意codeを反映しない', async () => {
  const { safeCaptureCode } = await import('../app/expected-capture-diagnostic.mjs');
  assert.equal(safeCaptureCode({ code: 'operation_timeout' }), 'operation_timeout');
  assert.equal(safeCaptureCode({ code: 'account_private_identifier', message: 'not for output' }), 'operation_failed');
  assert.equal(safeCaptureCode({ code: 'token\nvalue' }), 'operation_failed');
});

if (process.platform === 'linux') test('Linux期待本session: 期限超過の保持は後続closeで通常終了に変えない', async () => {
  const { ControlOwner } = await import('./support/owned-pipe-control-fixture.mjs');
  const { superviseLinuxOwnedReader } = await import('../app/linux-owned-reader.mjs');
  const owner = new ControlOwner('normal');
  try {
    const pipe = await superviseLinuxOwnedReader(owner, { closeTimeoutMs: 40 });
    pipe.retain();
    await assert.rejects(pipe.close(), { code: 'owned_pipe_unconfirmed' });
    assert.equal(owner.sent.filter(value => value === 'retain').length, 1);
    assert.equal(owner.sent.filter(value => value === 'close').length, 0);
    assert.equal(owner.unreferenced, true);
  } finally { owner.dispose(); }
});

if (enabled) test('Linux期待本session: 固定単回CLIは入力を受けず匿名経路を非上書きで検証', { timeout: 360_000 }, async t => {
  assert.ok(process.env.WAYLAND_DISPLAY, '実Snap/Waylandが必要です');
  const { prepareLinuxLoginProfile } = await import('../app/linux-login-core.mjs');
  const entry = fileURLToPath(new URL('../app/linux-expected-capture.mjs', import.meta.url));
  const collector = fileURLToPath(new URL('../app/linux-expected-capture-result.mjs', import.meta.url));
  const preload = new URL('./support/expected-capture-cli-hook.mjs', import.meta.url).href;
  // Keep this check's generated profiles separate from earlier, retained
  // unknown owners; neither inspect nor fingerprint those unrelated sessions.
  const base = '/home/user/snap/chromium/common/kindle-to-zip-owned-sample/capture-cli-fixtures-v1';
  await mkdir(base, { mode: 0o700, recursive: true });
  const title = '匿名の自作試料タイトル';
  const html = await readFile(new URL('../poc/fixtures/reader-kindle-chrome.html', import.meta.url), 'utf8');
  const css = await readFile(new URL('../poc/fixtures/reader-kindle-chrome.css', import.meta.url));
  const js = await readFile(new URL('../poc/fixtures/reader-kindle-chrome.js', import.meta.url), 'utf8');
  for (const argument of ['--url=http://127.0.0.1:9/', '--profile=/tmp/profile', '--position=1', '--token=x']) {
    const invalid = spawnSync(process.execPath, [entry, argument], { encoding: 'utf8', timeout: 5000 });
    assert.equal(invalid.status, 1); assert.match(invalid.stderr, /invalid_invocation/);
  }
  const successful = ['positive', 'end', 'changed-identity', 'delayed-title', 'delayed-position'];
  for (const mode of ['positive', 'end', 'wrong-book', 'document', 'before-commit', 'changed-identity',
    'delayed-title', 'delayed-position', 'delayed-title-change', 'never-ready']) await t.test(mode, { timeout: 65_000 }, async () => {
    const home = await mkdtemp(path.join(base, 'capture-'));
    const state = path.join(home, '.local/state/kindle-to-zip-inspection');
    const common = path.join(home, 'snap/chromium/common');
    await mkdir(state, { recursive: true, mode: 0o700 });
    await mkdir(path.join(common, 'chromium'), { recursive: true, mode: 0o700 });
    const data = path.join(common, 'kindle-to-zip-login');
    await prepareLinuxLoginProfile(data);
    await mkdir(path.join(data, 'jobs'), { mode: 0o700 });
    await writeFile(path.join(data, 'jobs', 'existing-marker'), 'anonymous-original', { flag: 'wx', mode: 0o600 });
    await writeFile(path.join(state, 'expected-book.json'), JSON.stringify({ version: 1, asin: 'B000TEST04', title, aliases: [] }), { mode: 0o600, flag: 'wx' });
    const server = http.createServer((req, res) => {
      const route = new URL(req.url, 'http://127.0.0.1').pathname;
      if (/^\/kindle-library\/manga-wr\/B000TEST0[34]$/.test(route)) {
        const body = mode === 'end' ? html.replace('max="12" value="7"', 'max="12" value="12"') : html;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(body);
      } else if (route === '/reader-kindle-chrome.css') res.writeHead(200, { 'Content-Type': 'text/css' }).end(css);
      else if (route === '/reader-kindle-chrome.js') {
        const preparation = mode === 'delayed-title' ? `const expectedTitle=identity.textContent;identity.textContent='';setTimeout(()=>{identity.textContent=expectedTitle;},1600);`
          : ['delayed-position', 'delayed-title-change', 'never-ready'].includes(mode)
            ? `position.remove();${mode === 'never-ready' ? '' : 'setTimeout(()=>next.before(position),1600);'}${mode === 'delayed-title-change' ? "setTimeout(()=>{const old=identity.textContent;identity.textContent='別の匿名本';identity.textContent=old;},700);" : ''}` : '';
        res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(`${js}\nnext.addEventListener('click',()=>{if(Number(position.value)<Number(position.max)){position.value=String(Number(position.value)+1);paint(Number(position.value));}});\n${preparation}`);
      }
      else res.writeHead(404).end();
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const url = `http://127.0.0.1:${server.address().port}/kindle-library/manga-wr/${mode === 'wrong-book' ? 'B000TEST03' : 'B000TEST04'}`;
    const env = { ...process.env, KTZ_EXPECTED_TEST_HOME: home, KTZ_EXPECTED_TEST_URL: url, KTZ_EXPECTED_TEST_MODE: mode,
      NODE_OPTIONS: `--import=${preload}` };
    async function run(file) {
      const child = spawn(process.execPath, [file], { env, cwd: project, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
      let timer;
      try { return await Promise.race([
        new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr })); }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('fixture_process_timeout')), 55_000); timer.unref(); }),
      ]); } finally { clearTimeout(timer); }
    }
    try {
      const first = await run(entry);
      assert.equal(first.signal, null); assert.equal(first.code, successful.includes(mode) ? 0 : 1, `${first.stdout}\n${first.stderr}`);
      const stored = JSON.parse(await readFile(path.join(state, 'expected-capture-once.result.json'), 'utf8'));
      const original = await readFile(path.join(state, 'expected-capture-once.result.json'));
      const again = await run(entry);
      assert.equal(again.code, 1); assert.deepEqual(await readFile(path.join(state, 'expected-capture-once.result.json')), original);
      const checked = await run(collector);
      assert.equal(checked.code, successful.includes(mode) ? 0 : 1, `${checked.stdout}\n${checked.stderr}`);
      const report = JSON.parse(checked.stdout);
      assert.equal(report.shutdown, 'normal'); assert.equal(report.checks.ownerGone, true);
      assert.equal(report.checks.browserGroupGone, true); assert.equal(report.checks.browserLockAbsent, true);
      assert.equal(report.checks.pendingEmpty, true); assert.equal(report.checks.exportsEmpty, true);
      assert.equal(await readFile(path.join(data, 'jobs', 'existing-marker'), 'utf8'), 'anonymous-original');
      if (successful.includes(mode)) {
        const count = mode === 'end' ? 1 : 2;
        assert.equal(report.success, true); assert.equal(report.reason, mode === 'end' ? 'end_candidate' : 'capture_limit_reached');
        assert.equal(report.images.length, count); assert.equal(report.budget.screenshots, count);
        assert.equal(report.budget.sends, count - 1); assert.equal(report.confirmedSends, count - 1);
        assert.equal(report.budget.committed, count);
        const manifest = JSON.parse(await readFile(path.join(report.jobPath, 'manifest.json'), 'utf8'));
        for (const [index, image] of manifest.images.entries()) {
          assert.equal(hash(await readFile(path.join(report.jobPath, image.path))), image.sha256);
          assert.equal(report.images[index].sha256, image.sha256);
        }
        const events = (await readFile(path.join(home, 'trace.ndjson'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
        assert.deepEqual(events.find(event => event.event === 'approval'), { event: 'approval', early: 'explicit_start_required',
          changed: 'capture_limit_changed', approved: 2, originals: 0, previewHash: report.images[0].sha256 });
           if (mode === 'positive') {
             assert.deepEqual(r.startupOrder, { initialBlank: true, navigations: 1, fixedNavigation: true, commitOnly: true });
          // Hold the actual fixture data lock in a separate process: the
          // collector must reject it, rather than accidentally locking a
          // same-named file in its own working directory.
          const holder = spawn('/usr/bin/flock', ['-n', path.join(data, '.job.lock'), process.execPath,
            '--input-type=module', '-e', `process.stdout.write('ready\\n'); process.stdin.resume(); process.stdin.once('end',()=>process.exit(0));`],
          { stdio: ['pipe', 'pipe', 'ignore'] });
          const exit = new Promise(resolve => holder.once('close', (code, signal) => resolve({ code, signal })));
          try {
            await Promise.race([new Promise(resolve => holder.stdout.once('data', resolve)), exit.then(() => { throw new Error('lock_holder_failed'); })]);
            const locked = await run(collector);
            assert.equal(locked.code, 1); assert.equal(JSON.parse(locked.stdout).checks.storeLocksFree, false);
          } finally {
            holder.stdin.end();
            assert.deepEqual(await exit, { code: 0, signal: null });
          }
          const released = await run(collector);
          assert.equal(released.code, 0); assert.equal(JSON.parse(released.stdout).checks.storeLocksFree, true);
        }
       } else {
         assert.equal(report.success, false); assert.equal(report.images.length, 0);
         assert.ok(!stored.budget || stored.budget.screenshots <= 1);
         if (mode === 'before-commit') assert.equal(stored.failure?.stage, 'target_recheck_before_commit');
        if (['delayed-title-change', 'never-ready'].includes(mode)) {
          assert.equal(stored.budget, null); assert.equal(stored.confirmedSends, 0);
          assert.equal(stored.failure?.code, mode === 'never-ready' ? 'expected_reader_not_ready' : 'target_changed');
        }
       }
    } finally { await new Promise(resolve => server.close(resolve)); }
  });
});

if (process.platform === 'linux') test('Linux所有pipe制御: 解放認可後も有限で失敗し遅延正常・再closeで成功へ変えない', async t => {
  const { ControlOwner } = await import('./support/owned-pipe-control-fixture.mjs');
  const { superviseLinuxOwnedReader } = await import('../app/linux-owned-reader.mjs');
  for (const mode of ['before-release', 'release-stall', 'lost-callback', 'send-error', 'disconnect', 'exit-only', 'normal-without-exit', 'normal']) {
    await t.test(mode, { timeout: 2000 }, async () => {
      const owner = new ControlOwner(mode);
      try {
        const pipe = await superviseLinuxOwnedReader(owner, { startupTimeoutMs: 1000, closeTimeoutMs: 40 });
        const started = performance.now(), closing = pipe.close();
        assert.strictEqual(pipe.close(), closing);
        if (mode === 'normal') await closing;
        else {
          const code = mode === 'before-release' ? 'owned_pipe_unconfirmed' : 'owned_pipe_release_unconfirmed';
          await assert.rejects(closing, { code });
          assert.ok(performance.now() - started < 1000, 'IPCのcallback/終端欠落でも有限に返す');
          assert.equal(owner.unreferenced, true); assert.equal(owner.channelUnreferenced, true);
          owner.emit('message', { event: 'normal' }); owner.emit('exit', 0, null);
          await assert.rejects(pipe.close(), { code });
          assert.equal(owner.stdio[4].destroyed, false); assert.equal(owner.stdio[5].destroyed, false);
        }
        assert.equal(owner.sent.filter(value => value === 'close').length, 1);
        assert.equal(owner.sent.filter(value => value === 'release').length, mode === 'before-release' ? 0 : 1);
        assert.equal(owner.sent.filter(value => value === 'retain').length, mode === 'normal' || mode === 'disconnect' ? 0 : 1);
      } finally { owner.dispose(); }
    });
  }
});

if (process.platform === 'linux') test('Linux所有pipe制御: close前の解放準備を保持し一回だけ認可、先行unknownは解除しない', async t => {
  const { ControlOwner } = await import('./support/owned-pipe-control-fixture.mjs');
  const { superviseLinuxOwnedReader } = await import('../app/linux-owned-reader.mjs');
  for (const mode of ['early-normal', 'early-release-stall', 'early-unknown']) await t.test(mode, async () => {
    const owner = new ControlOwner(mode);
    try {
      const pipe = await superviseLinuxOwnedReader(owner, { closeTimeoutMs: 40 });
      owner.emit('message', { event: 'release-ready' });
      owner.emit('message', { event: 'release-ready' });
      assert.deepEqual(owner.sent, [], '本人のclose前にはlock解放を認可しない');
      if (mode === 'early-unknown') owner.emit('message', { event: 'unknown' });
      const closing = pipe.close();
      assert.strictEqual(pipe.close(), closing);
      if (mode === 'early-normal') await closing;
      else {
        const code = mode === 'early-unknown' ? 'owned_pipe_unconfirmed' : 'owned_pipe_release_unconfirmed';
        await assert.rejects(closing, { code });
        owner.emit('message', { event: 'normal' }); owner.emit('exit', 0, null);
        await assert.rejects(pipe.close(), { code });
      }
      assert.equal(owner.sent.filter(value => value === 'close').length, 1);
      assert.equal(owner.sent.filter(value => value === 'release').length, mode === 'early-unknown' ? 0 : 1);
    } finally { owner.dispose(); }
  });
});

if (process.platform === 'linux') test('Linux所有pipe制御: Readerは応答不能CDPの後片付けより先に有限の所有終了へ進む', async t => {
  const { ControlOwner, connectOwnedPipeControlSession } = await import('./support/owned-pipe-control-fixture.mjs');
  const { superviseLinuxOwnedReader } = await import('../app/linux-owned-reader.mjs');
  const { Reader } = await import('../app/reader.mjs');
  for (const mode of ['normal', 'lost-callback']) await t.test(mode, async () => {
    const owner = new ControlOwner(mode);
    const pipe = await superviseLinuxOwnedReader(owner, { closeTimeoutMs: 40 });
    let closing, timer;
    try {
      const { session, methods } = await connectOwnedPipeControlSession(owner, pipe);
      const context = new EventEmitter(); context.pages = () => [];
      const lifecycle = { state: 'active' };
      const reader = new Reader(context, {}, pipe.url, () => {}, true, undefined, lifecycle);
      reader.ownedPipe = pipe;
      reader.ownedSampleGuard = { dispose: () => session.detach().catch(() => {}) };
      closing = reader.close();
      assert.strictEqual(reader.close(), closing);
      const outcome = await Promise.race([closing.then(() => ({ closed: true }), error => ({ error })),
        new Promise(resolve => { timer = setTimeout(() => resolve({ pending: true }), 300); })]);
      assert.equal(outcome.pending, undefined, 'CDP detach応答欠落でもpipe終了期限を開始する');
      if (mode === 'normal') { assert.equal(outcome.closed, true); assert.equal(lifecycle.state, 'closed_confirmed'); }
      else {
        assert.equal(outcome.error?.code, 'owned_pipe_release_unconfirmed');
        assert.equal(lifecycle.state, 'close_unconfirmed'); assert.equal(lifecycle.failure, outcome.error);
        await assert.rejects(reader.close(), error => error === outcome.error);
      }
      assert.equal(methods.includes('Target.detachFromTarget'), false, '切断済みCDPへ終了待ちを送らない');
      assert.equal(owner.sent.filter(value => value === 'close').length, 1);
    } finally {
      clearTimeout(timer);
      // Release only synthetic objects, including on the pre-fix regression.
      await pipe.close().catch(() => {});
      await closing?.catch(() => {});
      owner.dispose();
    }
  });
});

if (process.platform === 'linux') test('Linux所有pipe制御: 公開npm startで解放不明がHTTP失敗・再利用拒否・temp保持・終了1へ伝播', { timeout: 20_000 }, async t => {
  const root = await mkdtemp(path.join(project, 'artifacts/mvp-tests/pipe-control-'));
  const temp = path.join(root, 'temp'), data = path.join(root, 'data');
  await mkdir(temp, { mode: 0o700 }); await mkdir(data, { mode: 0o700 });
  const marker = path.join(data, 'retained-original-marker'); await writeFile(marker, 'anonymous-original', { mode: 0o600 });
  const hook = new URL('./support/owned-pipe-control-hook.mjs', import.meta.url).href;
  const child = spawnSync('npm', ['--prefix', project, 'start', '--', '--sample-owned-pipe'], {
    cwd: root, encoding: 'utf8', timeout: 15_000, env: { ...process.env,
      KTZ_USER_DATA_DIR: data, KTZ_TEMP_DIR: temp, KTZ_PIPE_CONTROL_ROOT: root,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${hook}` },
  });
  assert.equal(child.error, undefined); assert.equal(child.signal, null); assert.equal(child.status, 1);
  const events = (await readFile(path.join(root, 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(events.find(item => item.event === 'propagation'), { event: 'propagation', statuses: [400, 400],
    code: 'reader_close_failed', cause: 'owned_pipe_release_unconfirmed', sameFailure: true, releasePending: true,
    retainedReader: true, fixtureClosed: false, denied: 'reader_release_incomplete', closeSends: 1 });
  assert.deepEqual(events.find(item => item.event === 'app-close'), { event: 'app-close', success: false, storeClosed: true });
  assert.deepEqual(events.find(item => item.event === 'exit'), { event: 'exit', code: 1, ownedExists: true });
  assert.match(child.stderr, /安全確認ができなかったため専用一時領域を保持/);
  assert.equal((await readdir(temp)).filter(name => name.startsWith('ktz-')).length, 1);
  assert.equal(await readFile(marker, 'utf8'), 'anonymous-original');
  // Only fake browser/owner objects existed here. The real Rust child exited;
  // no actual unknown browser resource is being removed by this fixture cleanup.
  t.after(() => rm(root, { recursive: true, force: true }));
});

async function pipeTrace(root) {
  return (await readFile(path.join(root, 'trace.ndjson'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
}

if (process.platform === 'linux') test('Linux期待本session監視fixture: 同一文書URL正規化は初期待機中と確立後も照合を維持する', { timeout: 30_000 }, async t => {
  const { chromium } = await import('playwright');
  const { startFixture } = await import('../poc/browser/fixture-server.mjs');
  const { bindExpectedIdentity } = await import('../app/expected-identity.mjs');
  const { expectedRoute } = await import('../app/linux-playwright-expected-observe.mjs');
  const { anonymousExpectedBook: book } = await import('../app/owned-sample-identity.mjs');
  const fixture = await startFixture(), browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await fixture.close(); });
  for (const phase of ['initial', 'established']) await t.test(phase, async sub => {
    const context = await browser.newContext();
    sub.after(() => context.close());
    const page = await context.newPage();
    await page.goto(fixture.url);
    await page.evaluate(asin => history.replaceState(null, '', `/?asin=${asin}`), book.asin);
    let navigations = 0;
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations++; });
    const normalize = () => page.evaluate(asin => {
      history.pushState(null, '', `/kindle-library/manga-wr/${asin}`);
      history.replaceState(null, '', `/kindle-library/manga-wr/${asin}/?asin=${asin}`);
    }, book.asin);
    if (phase === 'initial') {
      await page.evaluate(() => { globalThis.savedAnonymousTitle = document.querySelector('h1'); savedAnonymousTitle.remove(); });
      const evaluateHandle = page.evaluateHandle.bind(page);
      page.evaluateHandle = async (...args) => {
        const watch = await evaluateHandle(...args), evaluate = watch.evaluate.bind(watch);
        let normalized = false;
        watch.evaluate = async (...args) => {
          const state = await evaluate(...args);
          if (state === 'waiting' && !normalized) {
            normalized = true;
            await normalize();
            await page.evaluate(() => document.body.prepend(savedAnonymousTitle));
          }
          return state;
        };
        return watch;
      };
    }
    const identity = await bindExpectedIdentity({ context, page }, new URL(fixture.url).origin,
      book, expectedRoute, 'h1', 2500, phase === 'initial' ? { initialDeadline: Date.now() + 2500 } : {});
    sub.after(() => identity.dispose());
    if (phase === 'established') await normalize();
    await identity.assertIdentity();
    assert.ok(navigations >= 2, '実Playwrightは同一documentのHistory API更新でもframenavigatedを通知する');
    // A same-document allowance must not permit a transient different book.
    await page.evaluate(asin => {
      const original = location.href;
      history.replaceState(null, '', `/kindle-library/manga-wr/${asin}`);
      history.replaceState(null, '', original);
    }, 'B000KTZ002');
    await assert.rejects(identity.assertIdentity(), { code: 'target_changed' });
    await assert.rejects(identity.assertIdentity(), { code: 'target_changed' });
  });
  for (const phase of ['initial', 'established']) await t.test(`真の文書交換-${phase}`, async sub => {
    const context = await browser.newContext(), page = await context.newPage();
    sub.after(() => context.close());
    await page.goto(`${fixture.url}?asin=${book.asin}`);
    const { anonymousExpectedRoute } = await import('../app/owned-sample-identity.mjs');
    if (phase === 'initial') {
      await page.locator('h1').evaluate(node => node.remove());
      const evaluateHandle = page.evaluateHandle.bind(page);
      page.evaluateHandle = async (...args) => {
        const watch = await evaluateHandle(...args), evaluate = watch.evaluate.bind(watch);
        let exchanged = false;
        watch.evaluate = async (...args) => {
          const state = await evaluate(...args);
          if (state === 'waiting' && !exchanged) { exchanged = true; await page.reload(); }
          return state;
        };
        return watch;
      };
    }
    const bind = () => bindExpectedIdentity({ context, page }, new URL(fixture.url).origin,
      book, anonymousExpectedRoute, 'h1', 2500, phase === 'initial' ? { initialDeadline: Date.now() + 2500 } : {});
    const documentChanged = error => error.code === 'target_changed'
      && error.startupDiagnostic?.stage === 'identity' && error.startupDiagnostic.reason === 'document_changed';
    if (phase === 'initial') await assert.rejects(bind(), documentChanged);
    else {
      const identity = await bind(); sub.after(() => identity.dispose());
      await page.reload();
      await assert.rejects(identity.assertIdentity(), documentChanged);
      await assert.rejects(identity.assertIdentity(), documentChanged);
    }
  });
  await t.test('文書監視sessionの準備中に交換された文書を採用しない', async sub => {
    const context = await browser.newContext(), page = await context.newPage();
    sub.after(() => context.close());
    await page.goto(`${fixture.url}?asin=${book.asin}`);
    const attach = context.newCDPSession.bind(context);
    context.newCDPSession = async (...args) => {
      const session = await attach(...args);
      await page.reload(); // Same URL/book, but the pinned watch belongs to the old document.
      return session;
    };
    const { anonymousExpectedRoute } = await import('../app/owned-sample-identity.mjs');
    await assert.rejects(bindExpectedIdentity({ context, page }, new URL(fixture.url).origin,
      book, anonymousExpectedRoute, 'h1'), { code: 'target_changed' });
  });
});

if (process.platform === 'linux') test('Linux期待本session監視fixture: 観測値・失効とReader副作用の境界', { timeout: 90_000 }, async t => {
  const { Reader, sampleConfig } = await import('../app/reader.mjs');
  const { startFixture } = await import('../poc/browser/fixture-server.mjs');
  const { bindExpectedIdentity } = await import('../app/expected-identity.mjs');
  const { anonymousExpectedBook, anonymousExpectedRoute } = await import('../app/owned-sample-identity.mjs');
  async function setup(sub, asin = anonymousExpectedBook.asin) {
    const root = await mkdtemp('/tmp/opencode/ktz-test-expected-session-');
    const fixture = await startFixture();
    let reader;
    sub.after(async () => { await reader?.close(); await fixture.close(); await rm(root, { recursive: true, force: true }); });
    const url = `${fixture.url}?asin=${asin}`;
    reader = await Reader.open({ profile: path.join(root, 'profile'), sampleUrl: url, headless: true, handleSignals: false });
    reader.selectTab(reader.tabs()[0].id);
    let screenshots = 0, sends = 0;
    const screenshot = reader.screenshotVisibleClip.bind(reader);
    reader.screenshotVisibleClip = (...args) => { screenshots++; return screenshot(...args); };
    const click = reader.page.mouse.click.bind(reader.page.mouse);
    reader.page.mouse.click = (...args) => { sends++; return click(...args); };
    const bind = async () => {
      const identity = await bindExpectedIdentity(reader, new URL(url).origin, anonymousExpectedBook, anonymousExpectedRoute, 'h1');
      // Test-only adapter: use the exact production identity binding with a real
      // anonymous headless Reader; it does not mint a session capability.
      reader.ownedSessionGuard = { ...identity, allowsIdentityRedraw: true, validateConfig() {}, validateTransition() {},
        async observe() { await identity.assertIdentity(); return 'anonymous-paint'; } };
    };
    return { reader, bind, counts: () => ({ screenshots, sends }) };
  }
  const changeTitle = page => page.evaluate(() => {
    const title = document.querySelector('h1'), old = title.textContent;
    title.textContent = '別の匿名本'; title.textContent = old;
  });
  await t.test('偽capabilityは接続前に拒否', async () => {
    await assert.rejects(Reader.open({ ownedSession: { url: 'http://127.0.0.1:9/reader.html', transport: {}, close() {} } }),
      { code: 'owned_sample_unavailable' });
  });
  await t.test('初期照合失敗は応答不能なwatch後片付けを待たず返す', async () => {
    const page = new EventEmitter();
    let calls = 0;
    const watch = { evaluate: () => ++calls === 1 ? Promise.resolve('changed') : new Promise(() => {}),
      dispose: async () => {} };
    page.mainFrame = () => frame; page.isClosed = () => false; page.evaluateHandle = async () => watch;
    const session = new EventEmitter(); session.send = async () => {}; session.detach = async () => {};
    const frame = {}, context = { pages: () => [page], browser: () => ({ isConnected: () => true }), newCDPSession: async () => session };
    const reader = { page, context };
    let timer;
    try {
      const result = await Promise.race([
        bindExpectedIdentity(reader, 'http://127.0.0.1:9', anonymousExpectedBook, anonymousExpectedRoute, 'h1')
          .then(() => 'accepted', error => error.code),
        new Promise(resolve => { timer = setTimeout(() => resolve('pending'), 250); }),
      ]);
      assert.equal(result, 'target_changed'); assert.equal(calls, 2);
    } finally { clearTimeout(timer); }
  });
  await t.test('応答不能な照合も有限に失効する', async () => {
    const page = new EventEmitter(), frame = {};
    const watch = { evaluate: () => new Promise(() => {}), dispose: async () => {} };
    page.mainFrame = () => frame; page.isClosed = () => false; page.evaluateHandle = async () => watch;
    const session = new EventEmitter(); session.send = async () => {}; session.detach = async () => {};
    const context = { pages: () => [page], browser: () => ({ isConnected: () => true }), newCDPSession: async () => session };
    const started = performance.now();
    await assert.rejects(bindExpectedIdentity({ page, context }, 'http://127.0.0.1:9', anonymousExpectedBook,
      anonymousExpectedRoute, 'h1', 30), { code: 'target_changed' });
    assert.ok(performance.now() - started < 500);
  });
  for (const mode of ['enable-stall', 'late-session']) await t.test(`文書監視sessionの期限超過は後片付けを待たず失効-${mode}`, async () => {
    const page = new EventEmitter(), frame = {};
    page.mainFrame = () => frame; page.isClosed = () => false;
    let detachCalls = 0, resolveSession, currentCalls = 0;
    page.evaluateHandle = async () => ({
      evaluate: async callback => callback({ dispose() {}, current() { currentCalls++; return 'current'; } }),
      dispose: async () => {},
    });
    const session = new EventEmitter();
    session.send = () => new Promise(() => {});
    session.detach = () => { detachCalls++; return new Promise(() => {}); };
    const context = { pages: () => [page], browser: () => ({ isConnected: () => true }),
      newCDPSession: () => mode === 'late-session' ? new Promise(resolve => { resolveSession = resolve; }) : Promise.resolve(session) };
    const started = performance.now();
    await assert.rejects(bindExpectedIdentity({ page, context }, 'http://127.0.0.1:9', anonymousExpectedBook,
      anonymousExpectedRoute, 'h1', 30), error => error.code === 'target_changed' && error.startupDiagnostic.reason === 'identity_unavailable');
    assert.ok(performance.now() - started < 500);
    resolveSession?.(session);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(detachCalls, 1); assert.equal(session.listenerCount('Page.frameNavigated'), 0);
    assert.equal(currentCalls, 0, '監視sessionの準備が成立する前に照合を確立しない');
  });
  for (const mode of ['same-title-other-asin', 'wrong-title']) await t.test(mode, async sub => {
    const value = await setup(sub, mode === 'same-title-other-asin' ? 'B000KTZ002' : undefined);
    if (mode === 'wrong-title') await value.reader.page.locator('h1').evaluate(node => { node.textContent = '別の匿名本'; });
    await assert.rejects(value.bind(), { code: 'target_changed' });
    assert.deepEqual(value.counts(), { screenshots: 0, sends: 0 });
  });
  await t.test('同内容再描画は許し一時的な別本は復元後も撮影させない', async sub => {
    const { reader, bind, counts } = await setup(sub); await bind();
    const detected = await reader.autoConfiguration();
    assert.deepEqual(detected, { ...sampleConfig, frames: {} }, '公開quickPreviewの自動検出を試料契約が受け付ける');
    await reader.configure(detected);
    await reader.page.locator('h1').evaluate(node => node.replaceWith(node.cloneNode(true)));
    await reader.requireBound();
    await changeTitle(reader.page);
    const before = counts();
    await assert.rejects(reader.capture(), { code: 'target_changed' });
    await assert.rejects(reader.requireBound(), { code: 'target_changed' });
    assert.deepEqual(counts(), before);
  });
  await t.test('撮影中の変更は画像を返さず確定前照合も失効', async sub => {
    const { reader, bind, counts } = await setup(sub); await bind(); await reader.configure(sampleConfig);
    const capture = reader.screenshotWithoutSelectedNavigation.bind(reader);
    reader.screenshotWithoutSelectedNavigation = async (...args) => {
      const image = await capture(...args); await changeTitle(reader.page); return image;
    };
    await assert.rejects(reader.capture(), { code: 'target_changed' });
    await assert.rejects(reader.requireBound(), { code: 'target_changed' });
    assert.deepEqual(counts(), { screenshots: 2, sends: 0 });
  });
  await t.test('撮影直前の変更ではCDPへ撮影を送らない', async sub => {
    const { reader, bind, counts } = await setup(sub); await bind(); await reader.configure(sampleConfig);
    let dispatched = 0;
    const send = reader.scaleSession.send.bind(reader.scaleSession);
    reader.scaleSession.send = (method, ...args) => { if (method === 'Page.captureScreenshot') dispatched++; return send(method, ...args); };
    const screenshot = reader.screenshotVisibleClip.bind(reader);
    reader.screenshotVisibleClip = async (...args) => { await changeTitle(reader.page); return screenshot(...args); };
    await assert.rejects(reader.capture(), { code: 'target_changed' });
    assert.equal(dispatched, 0); assert.equal(counts().sends, 0);
  });
  await t.test('送り直前の変更では入力を送らない', async sub => {
    const { reader, bind, counts } = await setup(sub); await bind(); await reader.configure(sampleConfig);
    await assert.rejects(reader.advance(() => false, async update => {
      if (update.stage === 'advance_dispatch') await changeTitle(reader.page);
    }), { code: 'target_changed' });
    assert.deepEqual(counts(), { screenshots: 1, sends: 0 });
  });
  await t.test('送り直前のidentity照合中に取消されたら入力を送らない', { timeout: 5000 }, async sub => {
    const { reader, bind, counts } = await setup(sub); await bind(); await reader.configure(sampleConfig);
    const identity = reader.ownedSessionGuard.assertIdentity.bind(reader.ownedSessionGuard);
    let phase = false, checks = 0, cancelled = false, reached, release;
    const waiting = new Promise(resolve => { reached = resolve; });
    const blocked = new Promise(resolve => { release = resolve; });
    reader.ownedSessionGuard.assertIdentity = async () => {
      await identity();
      // Two end-of-read checks occur in requireBound, then the final check.
      if (phase && ++checks === 3) { reached(); await blocked; }
    };
    const advancing = reader.advance(() => cancelled, async update => { if (update.stage === 'advance_dispatch') phase = true; });
    await waiting; cancelled = true; release();
    await assert.rejects(advancing, { code: 'cancelled' });
    assert.equal(counts().sends, 0);
  });
  await t.test('送り直後の変更は復元されても次の撮影を止める', async sub => {
    const { reader, bind, counts } = await setup(sub); await bind(); await reader.configure(sampleConfig);
    const click = reader.page.mouse.click.bind(reader.page.mouse);
    reader.page.mouse.click = async (...args) => { await click(...args); await changeTitle(reader.page); };
    const journal = [];
    await assert.rejects(reader.advance(() => false, async update => journal.push(update)), { code: 'target_changed' });
    assert.equal(counts().sends, 1); assert.equal(counts().screenshots, 1);
    assert.equal(journal.at(-1).status, 'unknown');
    await assert.rejects(reader.capture(), { code: 'advance_uncertain' });
    assert.deepEqual(counts(), { screenshots: 1, sends: 1 });
  });
  for (const mode of ['route-restore', 'document']) await t.test(mode, async sub => {
    const { reader, bind, counts } = await setup(sub); await bind(); await reader.configure(sampleConfig);
    if (mode === 'document') await reader.page.reload({ waitUntil: 'domcontentloaded' });
    else await reader.page.evaluate(() => {
      const original = location.href;
      history.replaceState(null, '', '?asin=B000KTZ002'); history.replaceState(null, '', original);
    });
    await assert.rejects(reader.capture(), { code: 'target_changed' });
    assert.deepEqual(counts(), { screenshots: 1, sends: 0 });
  });
});

if (process.platform === 'linux') {
  test('Portable限定: 非Linuxの通常ジョブは専用claim検査に巻き込まれない', async t => {
    const root = await mkdtemp('/tmp/opencode/ktzrc-platform-');
    t.after(() => rm(root, { recursive: true }));
    // Keep the controller native; only exercise the public Application policy
    // as Windows in an isolated process, without launching a browser.
    const script = `
      import assert from 'node:assert/strict';
      import { startApplication } from './app/server.mjs';
      const running = await startApplication({ dataDir: process.argv[1] });
      const platform = Object.getOwnPropertyDescriptor(process, 'platform');
      const request = async (action, input = {}) => {
        const response = await fetch(running.origin + '/api/command', { method: 'POST', headers: {
          Authorization: 'Bearer ' + running.token, 'Content-Type': 'application/json', Origin: running.origin,
        }, body: JSON.stringify({ action, input }) });
        const body = await response.json();
        assert.equal(response.status, 200, JSON.stringify(body));
        return body;
      };
      try {
        Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
        const created = await request('create');
        assert.equal(created.portableLimitedJob, false);
        const response = await fetch(running.origin + '/api/state', { headers: { Authorization: 'Bearer ' + running.token } });
        assert.equal(response.status, 200);
        assert.equal((await response.json()).job.manifest.job_id, created.job.manifest.job_id);
        assert.equal((await request('setKindleRegion', { id: 'us' })).kindleRegion, 'us');
        await request('closeJob');
        assert.equal((await request('recover', { path: created.job.job_path })).portableLimitedJob, false);
        await request('closeJob');
      } finally {
        Object.defineProperty(process, 'platform', platform);
        await running.close();
      }
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, path.join(root, 'data')], {
      cwd: project, env: { ...process.env }, encoding: 'utf8', timeout: 15_000,
    });
    assert.equal(result.error, undefined); assert.equal(result.signal, null);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });

  test('最小OS adapter: 選書中とプレビュー後を区別する単回予算', async () => {
    const { createPortableLimitedCaptureBudget } = await import('../app/expected-capture-budget.mjs');
    const budget = createPortableLimitedCaptureBudget();
    let screenshots = 0, sends = 0;
    budget.invalidate(); // 本人がまだ本・開始位置を選んでいる段階
    assert.throws(() => budget.start(2), { code: 'expected_capture_budget_exhausted' });
    await assert.rejects(budget.screenshot('preview', async () => { screenshots++; }), { code: 'expected_capture_budget_exhausted' });
    budget.beginPreview();
    const preview = await budget.screenshot('preview', async () => { screenshots++; return 'anonymous-preview'; });
    assert.throws(() => budget.approve(3), { code: 'expected_capture_budget_exhausted' });
    budget.approve(2); budget.start(2);
    assert.equal(preview, 'anonymous-preview'); // 最初の確定に既存プレビューを渡す側の会計
    budget.commit();
    await budget.advance(async () => { sends++; }); budget.confirmAdvance();
    await budget.screenshot('capture', async () => { screenshots++; return 'anonymous-second'; });
    budget.commit(); budget.finish();
    await assert.rejects(budget.screenshot('capture', async () => { screenshots++; }), { code: 'expected_capture_budget_exhausted' });
    await assert.rejects(budget.advance(async () => { sends++; }), { code: 'expected_capture_budget_exhausted' });
    assert.deepEqual({ screenshots, sends }, { screenshots: 2, sends: 1 });

    const invalidated = createPortableLimitedCaptureBudget();
    invalidated.beginPreview();
    await invalidated.screenshot('preview', async () => 'anonymous');
    invalidated.invalidate();
    assert.throws(() => invalidated.approve(1), { code: 'expected_capture_budget_exhausted' });
    await assert.rejects(invalidated.screenshot('preview', async () => { screenshots++; }), { code: 'expected_capture_budget_exhausted' });
    assert.equal(invalidated.snapshot().phase, 'failed');
    const changedLimit = createPortableLimitedCaptureBudget();
    changedLimit.beginPreview();
    await changedLimit.screenshot('preview', async () => 'anonymous'); changedLimit.approve(2);
    changedLimit.revokeApproval();
    assert.throws(() => changedLimit.start(2), { code: 'expected_capture_budget_exhausted' });
    const duringPreview = createPortableLimitedCaptureBudget();
    duringPreview.beginPreview(); duringPreview.invalidate();
    await assert.rejects(duringPreview.screenshot('preview', async () => { screenshots++; }), { code: 'expected_capture_budget_exhausted' });
    assert.equal(screenshots, 2, '明示プレビュー開始後の対象変更は撮影前でも失効する');
  });

  test('最小OS adapter: 有限プレビュー承認と別開始後に最初の表示を再利用しReviewで停止', async () => {
    const { Application } = await import('../app/application.mjs');
    const { createPortableLimitedCaptureBudget } = await import('../app/expected-capture-budget.mjs');
    const budget = createPortableLimitedCaptureBudget(), preview = Buffer.from('fixture-preview'), second = Buffer.from('fixture-second');
    let screenshots = 0, sends = 0, upload = [];
    budget.beginPreview();
    await budget.screenshot('preview', async () => { screenshots++; return preview; });
    const manifest = { job_id: '0123456789abcdef0123456789abcdef', state: 'ready', images: [], exports: [], selected_capture_ids: [],
      capture_settings: { image_format: 'png', page_output_mode: 'single_image' } };
    const job = { manifest }, saved = [];
    const app = Object.create(Application.prototype);
    Object.assign(app, { job, state: 'Preview', epoch: 0, bookGeneration: 1, commands: new Set(),
      previewImage: preview, previewBook: { identity: 'fixture-book' }, previewPosition: '1',
      isPortableLimitedJob: async () => true, snapshot: async () => ({ state: app.state, previewApproved: app.previewApproved }) });
    app.reader = { bound: { position: '1', book: { identity: 'fixture-book' } },
      ownedSessionGuard: { limited: true, singleRunBudget: budget, atEnd: () => false },
      requireBound: async () => ({ nextDisabled: false }),
      capture: () => budget.screenshot('capture', async () => { screenshots++; return second; }),
      advance: async (_cancelled, dispatch) => {
        await dispatch({ stage: 'advance_dispatch', status: 'unknown' });
        await budget.advance(async () => { sends++; });
        await dispatch({ stage: 'advance_confirmed', status: 'sent' });
        budget.confirmAdvance();
      },
    };
    app.store = { call: async (kind, input = {}) => {
      if (kind === 'job_info') return { snapshot: job };
      if (kind === 'job_progress') return { manifest };
      if (kind === 'capture_start') { manifest.state = 'capturing'; return {}; }
      if (kind === 'capture_begin') { upload = []; return { capture_id: saved.length + 1 }; }
      if (kind === 'capture_chunk') { upload.push(Buffer.from(input.data_base64, 'base64')); return {}; }
      if (kind === 'capture_commit') {
        saved.push(Buffer.concat(upload));
        const capture = { capture_id: saved.length, blank_candidate: false, duplicate_candidate: false };
        manifest.images.push(capture); manifest.selected_capture_ids.push(capture.capture_id);
        return { capture };
      }
      if (kind === 'capture_stop') { manifest.state = 'review'; return {}; }
      if (['record_advance', 'set_review_order'].includes(kind)) return {};
      throw new Error('unexpected_store_command:' + kind);
    } };
    await assert.rejects(app.command('start', { confirmed: true }), { code: 'explicit_start_required' });
    await assert.rejects(app.command('approve', { confirmed: true, maxCaptures: 3 }), { code: 'expected_capture_budget_exhausted' });
    await app.command('approve', { confirmed: true, maxCaptures: 2 });
    assert.equal(app.state, 'Ready'); assert.equal(saved.length, 0);
    await assert.rejects(app.command('start', { confirmed: false }), { code: 'explicit_start_required' });
    await app.command('start', { confirmed: true, maxCaptures: 2 });
    await app.loop;
    assert.equal(app.state, 'Review'); assert.equal(app.reason, 'capture_limit_reached');
    assert.deepEqual(saved, [preview, second]); assert.equal(screenshots, 2); assert.equal(sends, 1);
    assert.equal(manifest.exports.length, 0); assert.equal(budget.snapshot().phase, 'finished');
  });

  test('Portable限定: 匿名領域の新規ジョブに単回claimを永続化し中断や競合を再許可しない', async () => {
    const { claimPortableLimitedRun, portableLimitedClaimState, assertPortableLimitedClaimBinding, assertPortableLimitedSettings } = await import('../app/portable-limited-claim.mjs');
    const root = await mkdtemp('/tmp/opencode/ktzrc-claim-');
    const id = '0123456789abcdef0123456789abcdef', otherId = 'abcdef0123456789abcdef0123456789';
    const session = 'saved-01234567-89ab-cdef-0123-456789abcdef';
    const setup = async name => {
      const data = path.join(root, name), jobPath = path.join(data, 'jobs', id), sessionRoot = path.join(data, session);
      await mkdir(jobPath, { recursive: true, mode: 0o700 });
      await mkdir(path.join(sessionRoot, 'owned/profile'), { recursive: true, mode: 0o700 });
      const selected = { id: session, root: sessionRoot, profile: path.join(sessionRoot, 'owned/profile') };
      const job = { job_path: jobPath, orphan_files: [], issues: [], manifest: { job_id: id, state: 'ready', images: [], exports: [],
        next_capture_id: 1, next_render_version: 1, last_capture_id: null, checkpoint: null,
        capture_settings: { image_format: 'png', page_output_mode: 'single_image' } } };
      return { data, selected, job };
    };
    const one = await setup('one');
    const old = path.join(one.data, 'expected-capture-once.claim');
    await writeFile(old, 'older-consumed-grant', { flag: 'wx', mode: 0o600 });
    const legacy = path.join(one.data, 'portable-reader-limited-20261102.claim');
    const legacyBytes = JSON.stringify({ version: 1, job: otherId, session }) + '\n';
    await writeFile(legacy, legacyBytes, { flag: 'wx', mode: 0o600 });
    const claim = path.join(one.data, `portable-reader-limited-${id}.claim`);
    assert.equal(await portableLimitedClaimState(one.data, id), 'unused');
    const jpeg = structuredClone(one.job); jpeg.manifest.capture_settings.image_format = 'jpeg';
    await assert.rejects(claimPortableLimitedRun(one.data, one.selected, jpeg), { code: 'portable_limited_settings_invalid' });
    const oldJob = structuredClone(one.job); oldJob.manifest.next_capture_id = 2;
    await assert.rejects(claimPortableLimitedRun(one.data, one.selected, oldJob), { code: 'portable_limited_job_invalid' });
    assert.equal(existsSync(claim), false, '条件不一致ならclaim作成前に停止');
    const wrongJob = { ...one.job, job_path: path.join(root, 'outside') };
    await assert.rejects(claimPortableLimitedRun(one.data, one.selected, wrongJob), { code: 'portable_limited_job_invalid' });
    await claimPortableLimitedRun(one.data, one.selected, one.job);
    assertPortableLimitedSettings(one.job);
    const later = structuredClone(one.job); later.manifest.capture_settings.image_format = 'jpeg';
    assert.throws(() => assertPortableLimitedSettings(later), { code: 'portable_limited_settings_invalid' },
      '作成時のPNG設定で、その後のJPEG利用を許可しない');
    assert.equal(await portableLimitedClaimState(one.data, id), 'this-job');
    assert.equal(await portableLimitedClaimState(one.data, otherId), 'this-job');
    await assertPortableLimitedClaimBinding(one.data, id, session);
    await assert.rejects(assertPortableLimitedClaimBinding(one.data, id, 'saved-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'), { code: 'portable_limited_claim_unknown' });
    await assert.rejects(claimPortableLimitedRun(one.data, one.selected, one.job), { code: 'portable_limited_claim_consumed' });
    assert.equal(await readFile(old, 'utf8'), 'older-consumed-grant');
    assert.deepEqual(JSON.parse(await readFile(claim, 'utf8')), { version: 2, job: id, session,
      scope: 'preview-1-displays-2-turn-1-png-review', consumed: true });
    assert.equal(await readFile(legacy, 'utf8'), legacyBytes, '旧claimを上書きしない');

    const legacyJob = await setup('legacy-job');
    await writeFile(path.join(legacyJob.data, 'portable-reader-limited-20261102.claim'), JSON.stringify({ version: 1, job: id, session }), { flag: 'wx', mode: 0o600 });
    assert.equal(await portableLimitedClaimState(legacyJob.data, id), 'this-job');
    await assert.rejects(claimPortableLimitedRun(legacyJob.data, legacyJob.selected, legacyJob.job), { code: 'portable_limited_claim_consumed' });
    assert.equal(existsSync(path.join(legacyJob.data, `portable-reader-limited-${id}.claim`)), false);

    const interrupted = await setup('interrupted');
    const partial = path.join(interrupted.data, `portable-reader-limited-${id}.claim`);
    await writeFile(partial, '', { flag: 'wx', mode: 0o600 });
    await assert.rejects(portableLimitedClaimState(interrupted.data, id), { code: 'portable_limited_claim_unknown' });
    await assert.rejects(claimPortableLimitedRun(interrupted.data, interrupted.selected, interrupted.job), { code: 'portable_limited_claim_consumed' });
    assert.equal((await stat(partial)).size, 0, '中断claimを消去・補修しない');

    const linked = await setup('linked');
    const linkedClaim = path.join(linked.data, `portable-reader-limited-${id}.claim`);
    await symlink(old, linkedClaim);
    await assert.rejects(portableLimitedClaimState(linked.data, id), { code: 'portable_limited_claim_unknown' });
    await assert.rejects(claimPortableLimitedRun(linked.data, linked.selected, linked.job), { code: 'portable_limited_claim_consumed' });
    assert.equal(await readFile(old, 'utf8'), 'older-consumed-grant', 'リンク先を触らない');

    const oldInterrupted = await setup('legacy-interrupted');
    const oldPartial = path.join(oldInterrupted.data, 'portable-reader-limited-20261102.claim');
    await writeFile(oldPartial, '', { flag: 'wx', mode: 0o600 });
    await assert.rejects(portableLimitedClaimState(oldInterrupted.data, id), { code: 'portable_limited_claim_unknown' });
    await assert.rejects(claimPortableLimitedRun(oldInterrupted.data, oldInterrupted.selected, oldInterrupted.job), { code: 'portable_limited_claim_unknown' });
    assert.equal((await stat(oldPartial)).size, 0);
    assert.equal(existsSync(path.join(oldInterrupted.data, `portable-reader-limited-${id}.claim`)), false);

    const wrongScope = await setup('wrong-scope');
    const wrongScopeClaim = path.join(wrongScope.data, `portable-reader-limited-${id}.claim`);
    const wrongScopeBytes = JSON.stringify({ version: 2, job: id, session, scope: 'unbounded', consumed: true });
    await writeFile(wrongScopeClaim, wrongScopeBytes, { flag: 'wx', mode: 0o600 });
    await assert.rejects(portableLimitedClaimState(wrongScope.data, id), { code: 'portable_limited_claim_unknown' });
    await assert.rejects(assertPortableLimitedClaimBinding(wrongScope.data, id, session), { code: 'portable_limited_claim_unknown' });
    await assert.rejects(claimPortableLimitedRun(wrongScope.data, wrongScope.selected, wrongScope.job), { code: 'portable_limited_claim_consumed' });
    assert.equal(await readFile(wrongScopeClaim, 'utf8'), wrongScopeBytes);

    const racing = await setup('racing');
    const results = await Promise.allSettled([claimPortableLimitedRun(racing.data, racing.selected, racing.job),
      claimPortableLimitedRun(racing.data, racing.selected, racing.job)]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.find(result => result.status === 'rejected').reason.code, 'portable_limited_claim_consumed');
    assert.equal(await portableLimitedClaimState(racing.data, id), 'this-job');
  });

  test('Portable限定: 非同期claim照合の間も公開commandの排他を保持する', async () => {
    const { Application } = await import('../app/application.mjs');
    const app = Object.create(Application.prototype);
    let entered, release;
    const checking = new Promise(resolve => { entered = resolve; }), checked = new Promise(resolve => { release = resolve; });
    app.isPortableLimitedJob = async () => { entered(); await checked; return true; };
    const exporting = app.dispatchCommand('export', {});
    await checking;
    assert.equal(app.busy, true);
    await assert.rejects(app.dispatchCommand('create', {}), { code: 'operation_busy' });
    release(); await assert.rejects(exporting, { code: 'portable_limited_review_only' });
    assert.equal(app.busy, false);
  });

  if (enabled) test('Portable限定: 通常GUIの接続失敗は消費済み停止を表示し再接続へ誘導しない', { timeout: 80_000 }, async t => {
    const { runPortableLimitedGui } = await import('./support/portable-limited-gui-fixture.mjs');
    const r = await runPortableLimitedGui(t, 'connection-failure');
    assert.deepEqual(r.firstOpen, { code: 'browser_open_failed', cause: 'target_changed' });
    assert.equal(r.images, 0); assert.equal(r.exports, 0); assert.equal(r.screenshots, 0); assert.equal(r.sends, 0);
    assert.equal(r.limited, true); assert.equal(r.consumed, true); assert.equal(r.available, false);
    assert.equal(r.browserOpen, false); assert.equal(r.releasePending, false);
    assert.equal(r.nextDisabled, true); assert.match(r.label, /限定試験停止/);
    assert.match(r.guidance, /消費済み/); assert.match(r.guidance, /再接続/);
    assert.doesNotMatch(r.guidance + r.sessionStatus, /未許可/);
    for (const value of [r.retry, ...r.forbidden]) assert.deepEqual(value, { status: 400, code: 'portable_limited_review_only' });
    assert.deepEqual(r.reuse, { status: 400, code: 'portable_limited_review_only' });
    assert.equal(r.claimUnchanged, true);
    assert.deepEqual(startupBase(r.startup), { record: 'complete', lastReached: 'pipe_attached', pipe: 'attached', outcome: 'failed',
      failure: { stage: 'reader_initialize', code: 'target_changed' }, initialization: { started: 'pipe_ready', completed: 'page_identity' } });
    assert.deepEqual(r.diskStartup, r.startup); assert.equal(r.startupUnchanged, true); assert.equal(r.recordSecretAbsent, true);
    assert.match(r.sessionStatus, /専用Reader準備失敗/); assert.match(r.guidance, /開始 Reader準備待ち \/ 完了 ページ個体検査/);
  });

  test('Portable限定: 初回準備拒否 個別判定・event先着・観測例外でも従前拒否と正常joinを維持', async t => {
    const { ControlOwner } = await import('./support/owned-pipe-control-fixture.mjs');
    const { superviseLinuxOwnedReader } = await import('../app/linux-owned-reader.mjs');
    const { portableReaderCapability, portableLimitedSession } = await import('../app/portable-limited-session.mjs');
    const { portableStartupRecorder, readPortableStartupRecord } = await import('../app/portable-limited-failure.mjs');
    const { claimPortableLimitedRun } = await import('../app/portable-limited-claim.mjs');
    await mkdir('/tmp/opencode/ktz-refusal-20261103', { recursive: true, mode: 0o700 });
    const root = await mkdtemp('/tmp/opencode/ktz-refusal-20261103/unit-');
    t.after(() => rm(root, { recursive: true }));
    const id = '0123456789abcdef0123456789abcdef', session = 'saved-01234567-89ab-cdef-0123-456789abcdef';
    const cases = [
      ['origin-direct', 'origin_mismatch'], ['page-direct', 'page_closed'],
      ['origin-http', 'origin_mismatch'],
      ['origin-uncommitted', 'origin_mismatch'], ['origin-internal', 'origin_mismatch'], ['origin-blank-after', 'origin_mismatch'],
      ['context-identity', 'context_changed'], ['context-set', 'context_changed'],
      ['browser-direct', 'browser_disconnected'], ['page-set', 'initial_page_missing'],
      ['navigation-first', 'origin_mismatch'], ['page-event-first', 'page_closed'],
      ['browser-event-first', 'browser_disconnected'], ['navigation-exception', 'unclassified'],
      ['observer-exception', 'origin_mismatch'], ['normal-navigation-and-cleanup', null],
    ];
    for (const [mode, expected] of cases) await t.test(mode, async () => {
      const data = path.join(root, mode), jobPath = path.join(data, 'jobs', id), selected = { id: session, root: path.join(data, session) };
      selected.profile = path.join(selected.root, 'owned/profile');
      await mkdir(jobPath, { recursive: true, mode: 0o700 }); await mkdir(selected.profile, { recursive: true, mode: 0o700 });
      await claimPortableLimitedRun(data, selected, { job_path: jobPath, orphan_files: [], issues: [], manifest: {
        job_id: id, state: 'ready', images: [], exports: [], next_capture_id: 1, next_render_version: 1,
        last_capture_id: null, checkpoint: null, capture_settings: { image_format: 'png', page_output_mode: 'single_image' } } });
      const recorder = portableStartupRecorder(data, id, session);
      await recorder.begin(); recorder.reached('pipe_attached');
      recorder.readerInitialization('page_identity', 'start'); recorder.readerInitialization('page_identity', 'complete');
      recorder.readerInitialization('pipe_ready', 'start');
      const state = { url: 'about:blank', closed: false, connected: true };
      const page = new EventEmitter(), browser = new EventEmitter(), frame = {}, otherContext = {};
      const context = new EventEmitter();
      Object.assign(context, { browser: () => browser, pages: () => state.missing ? [] : [page] });
      Object.assign(page, { isClosed: () => state.closed, context: () => state.otherContext ? otherContext : context,
        mainFrame: () => frame, url: () => { if (state.throwUrl) throw new Error('private-secret https://private.invalid/cookie'); return state.url; },
        goto: async () => {
          if (mode === 'navigation-exception') { state.throwUrl = true; page.emit('framenavigated', frame); state.throwUrl = false; }
          state.url = 'https://read.amazon.co.jp/kindle-library'; page.emit('framenavigated', frame);
          if (mode === 'origin-blank-after') { state.url = 'about:blank'; page.emit('framenavigated', frame); }
          if (mode === 'navigation-first') {
            state.url = 'https://anonymous.invalid/private-secret'; page.emit('framenavigated', frame);
            state.url = 'https://read.amazon.co.jp/kindle-library'; page.emit('framenavigated', frame);
            state.closed = true; page.emit('close'); browser.emit('disconnected');
          }
        } });
      Object.assign(browser, { isConnected: () => state.connected, contexts: () => state.otherSet ? [otherContext] : [context] });
      let firstCheck = true, armed = false;
      const child = new ControlOwner('normal'), originalSend = child.send.bind(child);
      child.send = (message, callback) => {
        if (message.event === 'check') {
          child.sent.push('check');
          if (armed && firstCheck) {
            firstCheck = false;
            if (['origin-direct', 'observer-exception'].includes(mode)) state.url = 'https://anonymous.invalid/private-secret';
            if (mode === 'origin-http') state.url = 'http://anonymous.invalid/private-secret';
            if (mode === 'origin-uncommitted') state.url = '';
            if (mode === 'origin-internal') state.url = 'chrome-error://chromewebdata/';
            if (mode === 'page-direct') state.closed = true;
            if (mode === 'context-identity') state.otherContext = true;
            if (mode === 'context-set') state.otherSet = true;
            if (mode === 'browser-direct') state.connected = false;
            if (mode === 'page-set') state.missing = true;
            if (mode === 'page-event-first') { page.emit('close'); browser.emit('disconnected'); }
            if (mode === 'browser-event-first') { browser.emit('disconnected'); page.emit('close'); }
          }
          queueMicrotask(() => child.emit('message', { event: 'checked', id: message.id })); callback?.(); return;
        }
        if (message.event === 'close') { page.emit('close'); browser.emit('disconnected'); }
        return originalSend(message, callback);
      };
      queueMicrotask(() => child.emit('message', { event: 'ready', kind: 'fixed-expected-reader', browserPid: 12345 }));
      let capability;
      try {
        const owner = await superviseLinuxOwnedReader(child, { expectedReader: true, startupTimeoutMs: 100, closeTimeoutMs: 100 });
        const observer = mode === 'observer-exception' ? { initialRejection(reason) {
          recorder.initialRejection(reason); throw new Error('private-secret observer');
        } } : recorder;
        capability = portableReaderCapability(owner, { dataDirectory: data, jobId: id, sessionId: session }, observer);
        const pipe = portableLimitedSession(capability);
        await attachPortableInitial(pipe, child, browser, context, page); armed = true;
        if (expected) {
          let refusal;
          await assert.rejects(pipe.ready(page), error => { refusal = error; return error.code === 'target_changed'; });
          assert.equal(recorder.snapshot().initialRejection, expected);
          // A later invalid check/loss/cleanup cannot replace the first fact.
          recorder.initialRejection('initial_invalid'); recorder.initialRejection('private-secret');
          await recorder.failed(refusal, 'reader_initialize');
          const recordPath = path.join(data, 'portable-reader-startup', id, 'result.json');
          const before = await readFile(recordPath, 'utf8');
          const expectedOrigin = expected === 'origin_mismatch' && mode !== 'observer-exception' ? {
            kind: mode === 'origin-uncommitted' ? 'uncommitted' : mode === 'origin-internal' ? 'browser_internal'
              : mode === 'origin-blank-after' ? 'blank' : mode === 'origin-http' ? 'other_http' : 'other_https',
            reachedExpectedOrigin: ['navigation-first', 'origin-blank-after'].includes(mode),
          } : undefined;
          assert.equal(JSON.parse(before).version, mode === 'observer-exception' ? (expectedOrigin ? 4 : 3) : 5);
          await capability.close();
          assert.equal(await readFile(recordPath, 'utf8'), before);
          const result = await readPortableStartupRecord(data, id);
          assert.equal(result.initialRejection, expected);
          assert.deepEqual(result.initialOrigin, expectedOrigin);
          assert.deepEqual(result.failure, { stage: 'reader_initialize', code: 'target_changed' });
          assert.doesNotMatch(before, /https?:|private-secret|cookie|message|stack/);
        } else {
          await pipe.ready(page);
          await capability.close(); // Emits loss events while the recorder is pending.
          assert.equal(recorder.snapshot().initialRejection, undefined, '正規cleanupを初回障害にしない');
          recorder.readerInitialization('pipe_ready', 'complete');
          await recorder.ready();
          const result = await readPortableStartupRecord(data, id);
          assert.equal(result.outcome, 'ready'); assert.equal(result.initialRejection, undefined);
        }
        assert.equal(child.sent.filter(event => event === 'close').length, 1);
        assert.equal(child.sent.filter(event => event === 'release').length, 1);
      } finally { await capability?.close(); child.dispose(); }
    });
    // The production pilot projects the optional observation, never adjacent
    // raw URL/error fields. No GUI/browser is launched for this assertion.
    const { runPortableLimitedPilot } = await import('../app/portable-limited-pilot.mjs');
    const secret = 'private-secret https://private.invalid/cookie';
    for (const kind of ['browser_internal', 'other_http', null]) {
      const page = { isClosed: () => false, url: () => 'http://127.0.0.1:12345/', context: () => context,
        evaluateHandle: async () => ({ evaluate: async () => true, dispose: async () => {} }) };
      const browser = { isConnected: () => true }, context = { browser: () => browser, pages: () => [page] };
      const app = { bookGeneration: 0, snapshot: async () => ({ sessions: [], job: null, operationRevision: 0,
        portableLimitedStartup: { outcome: 'failed', failure: { stage: 'reader_initialize', code: 'target_changed', message: secret },
          initialRejection: 'origin_mismatch', ...(kind ? { initialOrigin: { kind, reachedExpectedOrigin: false, url: secret } } : {}) } }) };
      const projected = await runPortableLimitedPilot({ control: { page, context, browser }, app, origin: 'http://127.0.0.1:12345' });
      assert.deepEqual(projected.startup, { stage: 'reader_initialize', code: 'target_changed', initialRejection: 'origin_mismatch',
        ...(kind ? { initialOrigin: { kind, reachedExpectedOrigin: false } } : {}) });
      assert.equal(/private-secret|https:|cookie|message|url/.test(JSON.stringify(projected)), false);
    }
  });

  test('最小OS adapter: 通常goto後に認証待機を追加せず対象固定と取得gateを維持', async t => {
    const { startPortableReaderSite } = await import('../app/portable-reader-site.mjs');
    const fixed = await startPortableReaderSite();
    assert.equal(fixed.url, 'about:blank'); assert.equal(fixed.expectedReader, true);
    const { ControlOwner } = await import('./support/owned-pipe-control-fixture.mjs');
    const { superviseLinuxOwnedReader } = await import('../app/linux-owned-reader.mjs');
    const { portableReaderCapability, portableLimitedSession } = await import('../app/portable-limited-session.mjs');
    const { portableStartupRecorder, readPortableStartupRecord } = await import('../app/portable-limited-failure.mjs');
    const { claimPortableLimitedRun } = await import('../app/portable-limited-claim.mjs');
    const base = '/tmp/opencode/ktz-refusal-20261103';
    await mkdir(base, { recursive: true, mode: 0o700 });
    const root = await mkdtemp(`${base}/bootstrap-`);
    t.after(() => rm(root, { recursive: true }));
    const id = '0123456789abcdef0123456789abcdef', session = 'saved-01234567-89ab-cdef-0123-456789abcdef';
    for (const mode of ['direct', 'blank-delay', 'auth-www', 'auth-root', 'unknown', 'credential', 'auth-after-ready', 'blank-after-ready', 'page-lost', 'context-lost', 'browser-lost', 'extra-page', 'premature']) await t.test(mode, async sub => {
      const data = path.join(root, mode), jobPath = path.join(data, 'jobs', id);
      const selected = { id: session, root: path.join(data, session) }; selected.profile = path.join(selected.root, 'owned/profile');
      await mkdir(jobPath, { recursive: true, mode: 0o700 }); await mkdir(selected.profile, { recursive: true, mode: 0o700 });
      const job = { job_path: jobPath, orphan_files: [], issues: [], manifest: { job_id: id, state: 'ready', images: [], exports: [],
        next_capture_id: 1, next_render_version: 1, last_capture_id: null, checkpoint: null,
        capture_settings: { image_format: 'png', page_output_mode: 'single_image' } } };
      await claimPortableLimitedRun(data, selected, job);
      const recorder = portableStartupRecorder(data, id, session); await recorder.begin(); recorder.reached('pipe_attached');
      recorder.readerInitialization('page_identity', 'start'); recorder.readerInitialization('page_identity', 'complete'); recorder.readerInitialization('pipe_ready', 'start');
      const state = { url: 'about:blank', closed: false, connected: true, contextLost: false };
      const page = new EventEmitter(), browser = new EventEmitter(), frame = {}, otherContext = {};
      const context = new EventEmitter(); let pages = [page];
      Object.assign(context, { browser: () => browser, pages: () => pages });
      let evaluated = 0, navCount = 0, releaseCommit;
      Object.assign(page, { isClosed: () => state.closed, context: () => state.contextLost ? otherContext : context,
        mainFrame: () => frame, url: () => state.url, evaluate: () => { evaluated++; throw new Error('bootstrap_must_not_read_dom'); },
        goto: async (target, options) => {
          navCount++; assert.equal(target, 'https://read.amazon.co.jp/');
          assert.deepEqual(options, { waitUntil: 'commit', timeout: 30_000 });
          if (mode === 'blank-delay') await new Promise(resolve => { releaseCommit = resolve; });
          {
            state.url = ['direct', 'blank-delay', 'auth-after-ready', 'blank-after-ready', 'page-lost', 'context-lost', 'browser-lost', 'extra-page'].includes(mode) ? 'https://read.amazon.co.jp/'
              : mode === 'unknown' ? 'https://unknown.invalid/private-secret' : mode === 'credential' ? 'https://private-secret@www.amazon.co.jp/'
                : mode === 'auth-root' ? 'https://amazon.co.jp/' : 'https://www.amazon.co.jp/';
            page.emit('framenavigated', frame);
            if (mode === 'page-lost') { state.closed = true; page.emit('close'); }
            if (mode === 'context-lost') { state.contextLost = true; page.emit('framenavigated', frame); }
            if (mode === 'browser-lost') { state.connected = false; browser.emit('disconnected'); }
            if (mode === 'extra-page') { pages = [page, {}]; context.emit('page', pages[1]); pages = [page]; }
          }
        } });
      Object.assign(browser, { isConnected: () => state.connected, contexts: () => [context] });
      const child = new ControlOwner('normal'), originalSend = child.send.bind(child);
      child.send = (message, callback) => {
        if (message.event === 'check') { child.sent.push('check'); queueMicrotask(() => child.emit('message', { event: 'checked', id: message.id })); callback?.(); return; }
        return originalSend(message, callback);
      };
      queueMicrotask(() => child.emit('message', { event: 'ready', kind: 'fixed-expected-reader', browserPid: 12345 }));
      let capability;
      try {
        const owner = await superviseLinuxOwnedReader(child, { expectedReader: true, startupTimeoutMs: 100, closeTimeoutMs: 100 });
        capability = portableReaderCapability(owner, { dataDirectory: data, jobId: id, sessionId: session }, recorder);
        const pipe = portableLimitedSession(capability);
        await attachPortableInitial(pipe, child, browser, context, page);
        if (mode === 'premature') { state.url = 'https://www.amazon.co.jp/'; page.emit('framenavigated', frame); state.url = 'about:blank'; }
        sub.mock.timers.enable({ apis: ['setTimeout'] });
        let settled = false;
        const pending = pipe.ready(page).then(() => { settled = true; return null; }, error => { settled = true; return error; });
        await new Promise(resolve => setImmediate(resolve));
        if (mode === 'blank-delay') {
          assert.equal(settled, false, '通常gotoのcommit前には接続を完了しない');
          assert.equal(evaluated, 0); releaseCommit();
        }
        if (['auth-www', 'auth-root'].includes(mode)) assert.equal(settled, true, '公式goto後に独自待機を加えない');
        const error = await pending;
        assert.equal(navCount, mode === 'premature' ? 0 : 1);
        if (['direct', 'blank-delay', 'auth-www', 'auth-root', 'auth-after-ready', 'blank-after-ready'].includes(mode)) {
          assert.equal(error, null);
          if (['auth-after-ready', 'blank-after-ready'].includes(mode)) {
            state.url = mode === 'blank-after-ready' ? 'about:blank' : 'https://www.amazon.co.jp/'; page.emit('framenavigated', frame);
            state.url = 'https://read.amazon.co.jp/'; page.emit('framenavigated', frame);
            await assert.rejects(pipe.bind({ context }), { code: 'target_changed' });
            assert.equal(recorder.snapshot().initialRejection, 'origin_mismatch');
          } else {
            const guard = await pipe.bind({ context });
            const budget = guard.singleRunBudget.snapshot();
            assert.equal(budget.screenshots, 0); assert.equal(budget.sends, 0); assert.equal(budget.committed, 0);
            assert.equal(budget.phase, 'preview');
          }
        } else {
          assert.equal(Boolean(error), true);
          assert.equal(error.code, 'target_changed');
          const expected = mode === 'premature' ? undefined : mode === 'page-lost' ? 'page_closed'
            : mode === 'context-lost' ? 'context_changed' : mode === 'browser-lost' ? 'browser_disconnected'
              : mode === 'extra-page' ? 'initial_invalid' : 'origin_mismatch';
          assert.equal(recorder.snapshot().initialRejection, expected);
          await recorder.failed(error, 'reader_initialize');
          const durable = await readPortableStartupRecord(data, id); assert.equal(durable.initialRejection, expected);
          assert.equal(durable.record, 'complete'); assert.doesNotMatch(JSON.stringify(durable), /https?:|private-secret|unknown.invalid/);
        }
        assert.equal(evaluated, 0, 'bootstrapとbindは認証DOMや本を読まない'); assert.deepEqual(job.manifest.images, []); assert.deepEqual(job.manifest.exports, []);
      } finally { sub.mock.timers.reset(); await capability?.close(); child.dispose(); }
      assert.equal(child.sent.filter(v => v === 'close').length, 1); assert.equal(child.sent.filter(v => v === 'release').length, 1);
    });
  });

  // These are real product waits, not the separate init-ready injected-error
  // check below. The fixed sample alone controls the page and delayed resource.
  if (enabled) for (const mode of ['wait-main-dcl', 'wait-origin', 'wait-child-frame']) test(`Portable限定: 実準備待機 ${mode}`, { timeout: 80_000 }, async t => {
    const { runPortableLimitedGui } = await import('./support/portable-limited-gui-fixture.mjs');
    const r = await runPortableLimitedGui(t, mode), fixed = r.fixed;
    assert.equal(fixed.initialOriginMatches, mode !== 'wait-origin');
    assert.equal(fixed.initialLibrary, mode !== 'wait-origin');
    assert.equal(fixed.initialBlank, mode === 'wait-origin');
    assert.deepEqual(r.startupOrder, { initialBlank: true, navigations: 1, fixedNavigation: true, commitOnly: true });
    assert.equal(fixed.mainState, mode === 'wait-origin' ? 'complete' : 'loading');
    assert.equal(fixed.mainDcl, mode === 'wait-origin' ? 'not-requested' : 'TimeoutError');
    assert.equal(fixed.pageCount, 1, '準備中は同じinitial pageだけ');
    if (mode !== 'wait-origin') assert.deepEqual(r.readerAfterReady, { originMatches: true, separatePage: true, pageCount: 2,
      sameInitialPage: true, autoSelected: false, rendered: { visible: true, painted: true } });
    else assert.equal(r.readerAfterReady, undefined, '未知origin拒否後は別tabを作成しない');
    assert.equal(fixed.stillWaiting, true); assert.ok(fixed.elapsedMs >= 1200);
    assert.equal(fixed.busy, true); assert.equal(fixed.browserOpen, false);
    assert.deepEqual(fixed.initialization, { started: 'pipe_ready', completed: 'page_identity' });
    assert.equal(r.waitResult.initiallyMatches, mode !== 'wait-origin');
    assert.match(r.pendingUi.session, /準備中/); assert.match(r.pendingUi.guidance, /準備中/);
    assert.doesNotMatch(Object.values(r.pendingUi).join(' '), /この試行は停止|原因不明|準備が完了/);
    assert.equal(r.pendingUi.nextDisabled, true);
    assert.equal(r.exports, 0); assert.equal(r.claimUnchanged, true);
    assert.equal(r.browserOpen, false); assert.equal(r.releasePending, false); assert.equal(r.ownerBrowserDisconnected, true);
    assert.deepEqual(r.retry, { status: 400, code: 'portable_limited_review_only' });
    assert.deepEqual(r.diskStartup, r.startup);
    if (mode === 'wait-main-dcl') {
      assert.equal(r.waitResult.outcome, 'ready'); assert.ok(r.waitResult.elapsedMs < 30_000);
      assert.match(r.readyUi, /準備が完了/); assert.match(r.readyUi, /まだ確認していません/);
      assert.deepEqual(r.flow.beforeChoice, { screenshots: 0, sends: 0, images: 0, originals: 0 });
      assert.equal(r.flow.autoSelected, false);
      assert.deepEqual(r.flow.afterPreview, { screenshots: 1, sends: 0, images: 0, originals: 0 });
      assert.deepEqual(r.flow.afterApproval, r.flow.afterPreview);
      assert.deepEqual(r.flow.afterStart, { screenshots: 2, sends: 1, images: 2, originals: 2 });
      assert.equal(r.flow.state, 'Review'); assert.equal(r.flow.reason, 'capture_limit_reached');
      assert.equal(r.flow.firstMatches, true); assert.equal(r.flow.exports, 0); assert.equal(r.flow.dispatch, 'not_sent');
      assert.equal(r.flow.initialDcl, 'TimeoutError', '取得後まで本棚のDCLを解放しない');
      assert.equal(r.images, 2); assert.equal(r.originalPngs, 2); assert.equal(r.screenshots, 2); assert.equal(r.sends, 1);
    } else {
      assert.equal(r.images, 0); assert.equal(r.originalPngs, 0); assert.equal(r.screenshots, 0); assert.equal(r.sends, 0);
    }
    if (mode === 'wait-child-frame') {
      assert.equal(fixed.childState, 'loading');
      assert.equal(r.waitResult.outcome, 'ready'); assert.ok(r.waitResult.elapsedMs < 30_000);
      assert.equal(r.afterRelease.released, 1); assert.equal(r.afterRelease.mainState, 'interactive');
      assert.equal(r.afterRelease.mainDcl, 'resolved'); assert.equal(r.afterRelease.mainLoad, 'TimeoutError');
      assert.equal(r.afterRelease.childState, 'loading');
      assert.equal(r.afterRelease.sameInitialPage, true); assert.equal(r.afterRelease.autoSelected, false);
      assert.equal(r.afterRelease.readerStillVisible, true);
      assert.deepEqual(startupBase(r.startup), { record: 'complete', lastReached: 'ready', pipe: 'attached', outcome: 'ready', failure: null,
        initialization: { started: 'pipe_bind', completed: 'pipe_bind' } });
      assert.deepEqual(r.afterRelease.startup, r.startup);
    } else if (mode === 'wait-origin') {
      assert.equal(r.waitResult.outcome, 'failed'); assert.ok(r.waitResult.elapsedMs < 30_000);
      assert.deepEqual(r.firstOpen, { code: 'browser_open_failed', cause: 'target_changed' });
      assert.deepEqual(startupBase(r.startup), { record: 'complete', lastReached: 'pipe_attached', pipe: 'attached', outcome: 'failed',
        failure: { stage: 'reader_initialize', code: 'target_changed' }, initialization: { started: 'pipe_ready', completed: 'page_identity' },
        initialRejection: 'origin_mismatch', initialOrigin: { kind: 'other_http', reachedExpectedOrigin: false } });
    } else {
      assert.deepEqual(startupBase(r.startup), { record: 'complete', lastReached: 'ready', pipe: 'attached', outcome: 'ready', failure: null,
        initialization: { started: 'pipe_bind', completed: 'pipe_bind' } });
    }
  });

  if (enabled) test('Portable限定: 準備到達 匿名準備失敗でも試験gateを解放し正常joinする', { timeout: 80_000 }, async t => {
    const { runPortableLimitedGui } = await import('./support/portable-limited-gui-fixture.mjs');
    const r = await runPortableLimitedGui(t, 'wait-setup-failure');
    assert.deepEqual(r, { setupFailureRecorded: true, ownerJoined: true, temporaryRemoved: true, images: 0, exports: 0 });
  });

  if (enabled) for (const mode of ['wait-blank', 'wait-blank-timeout', 'wait-close', 'wait-disconnect', 'wait-owner-unknown', 'wait-post-close', 'wait-post-origin']) test(`Portable限定: 準備到達 ${mode}`, { timeout: 80_000 }, async t => {
    const { runPortableLimitedGui } = await import('./support/portable-limited-gui-fixture.mjs');
    const r = await runPortableLimitedGui(t, mode);
    if (['wait-blank', 'wait-blank-timeout', 'wait-close', 'wait-disconnect'].includes(mode))
      assert.deepEqual(r.blankPending, { busy: true, browserOpen: false, initialBlank: true, images: 0, screenshots: 0, sends: 0 });
    assert.equal(r.fixed.pageCount, 1, '準備中の別tabで初期pageを代替しない');
    assert.deepEqual(r.startupOrder, { initialBlank: true, navigations: 1, fixedNavigation: true, commitOnly: true });
    assert.equal(r.claimUnchanged, true); assert.equal(r.images, 0); assert.equal(r.originalPngs, 0);
    assert.equal(r.screenshots, 0); assert.equal(r.sends, 0); assert.equal(r.exports, 0);
    assert.equal(r.browserOpen, false); assert.equal(r.ownerBrowserDisconnected, true);
    assert.deepEqual(r.retry, { status: 400, code: 'portable_limited_review_only' });
    if (['wait-blank', 'wait-post-close', 'wait-post-origin'].includes(mode)) {
      assert.equal(r.waitResult.outcome, 'ready'); assert.equal(r.startup.outcome, 'ready');
      assert.match(r.readyUi, /準備が完了/);
      assert.deepEqual(r.readerAfterReady, { originMatches: true, separatePage: true, pageCount: 2,
        sameInitialPage: true, autoSelected: false, rendered: { visible: true, painted: true } });
      if (mode.startsWith('wait-post-')) assert.deepEqual(r.postReady, { select: { status: 200 },
        preview: { status: 400, code: 'target_changed' }, screenshots: 0, sends: 0, images: 0, originalPngs: 0 });
    } else {
      assert.equal(r.waitResult.outcome, 'failed'); assert.equal(r.startup.outcome, 'failed');
      assert.equal(r.readerAfterReady, undefined, '準備失敗後に別tabを作成しない');
      assert.equal(r.startup.failure.stage, 'reader_initialize');
      assert.notEqual(r.startup.lastReached, 'ready');
      assert.equal(r.startup.failure.code, mode === 'wait-blank-timeout' ? 'operation_timeout'
        : mode === 'wait-owner-unknown' ? 'owned_pipe_unconfirmed' : 'target_changed');
      if (mode === 'wait-blank-timeout') assert.ok(r.waitResult.elapsedMs >= 29_000 && r.waitResult.elapsedMs < 40_000);
    }
    assert.deepEqual(r.diskStartup, r.startup);
  });

  if (enabled) for (const [mode, started, completed, label, previous] of [
    ['init-page', 'page_identity', null, 'ページ個体検査', '未記録'],
    ['init-ready', 'pipe_ready', 'page_identity', 'Reader準備待ち', 'ページ個体検査'],
    ['init-viewport-read', 'viewport_read', 'pipe_ready', '表示領域取得', 'Reader準備待ち'],
    ['init-viewport-apply', 'viewport_apply', 'viewport_read', '表示領域適用', '表示領域取得'],
    ['init-bind', 'pipe_bind', 'viewport_apply', 'ガード接合', '表示領域適用'],
  ]) test(`Portable限定: 初期化境界 ${mode} の単独失敗と正常join`, { timeout: 80_000 }, async t => {
    const { runPortableLimitedGui } = await import('./support/portable-limited-gui-fixture.mjs');
    const r = await runPortableLimitedGui(t, mode);
    assert.equal(r.firstOpen.code, 'browser_open_failed');
    assert.deepEqual(startupBase(r.startup), { record: 'complete', lastReached: 'pipe_attached', pipe: 'attached', outcome: 'failed',
      failure: { stage: 'reader_initialize', code: mode === 'init-ready' ? 'operation_timeout' : mode === 'init-viewport-read' ? 'unclassified' : 'target_changed' },
      initialization: { started, completed } });
    assert.deepEqual(r.diskStartup, r.startup);
    assert.match(r.guidance, new RegExp(`初期化境界：開始 ${label} / 完了 ${previous}`));
    assert.match(r.sessionStatus, new RegExp(`開始 ${label} / 完了 ${previous}`));
    assert.equal(r.images, 0); assert.equal(r.exports, 0); assert.equal(r.screenshots, 0); assert.equal(r.sends, 0);
    assert.equal(r.browserOpen, false); assert.equal(r.releasePending, false); assert.equal(r.nextDisabled, true);
    assert.equal(r.claimUnchanged, true); assert.equal(r.startupUnchanged, true); assert.equal(r.recordSecretAbsent, true);
    for (const value of [r.retry, r.reuse, ...r.forbidden]) assert.deepEqual(value, { status: 400, code: 'portable_limited_review_only' });
  });

  if (enabled) test('Portable限定: 初期化境界のない旧記録は通常GUIでも未記録のまま', { timeout: 80_000 }, async t => {
    const { runPortableLimitedGui } = await import('./support/portable-limited-gui-fixture.mjs');
    const r = await runPortableLimitedGui(t, 'legacy-init');
    assert.deepEqual(startupBase(r.startup), { record: 'complete', lastReached: 'pipe_attached', pipe: 'attached', outcome: 'failed',
      failure: { stage: 'reader_initialize', code: 'operation_timeout' } });
    assert.deepEqual(r.diskStartup, r.startup); assert.match(r.guidance, /初期化境界：未記録/);
    assert.match(r.message, /初期化境界：未記録/);
    assert.deepEqual(r.retry, { status: 400, code: 'portable_limited_review_only' });
    assert.equal(r.unchanged, true); assert.equal(r.browserOpen, false);
    assert.equal(r.images, 0); assert.equal(r.screenshots, 0); assert.equal(r.sends, 0);
  });

  if (enabled) for (const mode of ['browser-failure', 'pipe-failure', 'record-error', 'scale-failure']) test(`Portable限定: ${mode === 'scale-failure' ? '準備到達 ' : ''}初回記録の公開GUI停止と非秘密分類 ${mode}`, { timeout: 80_000 }, async t => {
    const { runPortableLimitedGui } = await import('./support/portable-limited-gui-fixture.mjs');
    const r = await runPortableLimitedGui(t, mode);
    assert.equal(r.images, 0); assert.equal(r.exports, 0); assert.equal(r.screenshots, 0); assert.equal(r.sends, 0);
    assert.equal(r.consumed, true); assert.equal(r.available, false); assert.equal(r.nextDisabled, true);
    assert.equal(r.claimUnchanged, true); assert.equal(r.startupUnchanged, true); assert.equal(r.recordSecretAbsent, true);
    assert.deepEqual(r.retry, { status: 400, code: mode === 'browser-failure' ? 'reader_release_incomplete' : 'portable_limited_review_only' });
    assert.deepEqual(r.forbidden[0], { status: 400, code: 'portable_limited_review_only' });
    assert.deepEqual(r.forbidden[1], { status: 400, code: mode === 'browser-failure' ? 'reader_release_incomplete' : 'portable_limited_review_only' });
    assert.match(r.guidance, /保存0枚/); assert.match(r.guidance, /保全/); assert.doesNotMatch(r.guidance, /未許可/);
    if (mode === 'browser-failure') {
      assert.equal(r.releasePending, true);
      assert.equal(r.newTrialDisabled, true);
      assert.deepEqual(r.finishAttempt, { status: 400, code: 'reader_close_failed' });
      assert.deepEqual(r.newJobAttempt, { status: 400, code: 'reader_release_incomplete' });
      assert.equal(r.stillReleasePending, true); assert.equal(r.oldManifestUnchanged, true);
      assert.deepEqual(r.afterRestart, { prepare: { status: 400, code: 'login_in_use_or_unknown' },
        connect: { status: 400, code: 'login_in_use_or_unknown' }, newClaimExists: false, oldLockExists: true });
      assert.deepEqual(startupBase(r.startup), { record: 'complete', lastReached: 'claim_consumed', pipe: 'unknown', outcome: 'failed',
        failure: { stage: 'browser_launch', code: 'ENOENT' }, initialization: { started: null, completed: null } });
    } else if (mode === 'pipe-failure') {
      assert.deepEqual(startupBase(r.startup), { record: 'complete', lastReached: 'owner_ready', pipe: 'unknown', outcome: 'failed',
        failure: { stage: 'pipe_attach', code: 'operation_timeout' }, initialization: { started: null, completed: null } });
    } else if (mode === 'scale-failure') {
      const { session, guidance, message, ...pending } = r.scalePendingUi;
      assert.deepEqual(pending, { busy: true, browserOpen: true, activeOperation: 'openBrowser', record: 'pending' });
      assert.match(session, /準備中/); assert.match(guidance, /準備中/);
      assert.doesNotMatch([session, guidance, message].join(' '), /準備が完了|この試行は停止|原因不明/,
        'Reader個体が返っても表示密度適用と初回記録の確定前は準備中であり、成功表示にしない');
      assert.equal(r.releasePending, false); assert.equal(r.browserOpen, false, '初期化後の密度失敗でも同じReaderを正常joinする');
      assert.deepEqual(startupBase(r.startup), { record: 'complete', lastReached: 'reader_initialized', pipe: 'attached', outcome: 'failed',
        failure: { stage: 'capture_scale', code: 'capture_scale_unavailable' }, initialization: { started: 'pipe_bind', completed: 'pipe_bind' } });
    } else if (mode === 'record-error') {
      assert.equal(r.startup.record, 'incomplete'); assert.deepEqual(r.startup.failure, { stage: 'record_finish', code: 'record_failed' });
      assert.equal(r.diskStartup.record, 'incomplete'); assert.equal(r.diskStartup.failure, null);
      assert.match(r.guidance, /記録は未完了/);
    }
    if (!['record-error'].includes(mode)) assert.deepEqual(r.diskStartup, r.startup);
  });

  test('Portable限定: 初回記録は未知code・部分記録・既存リンクを成功に変えない', async t => {
    const { portableStartupRecorder, readPortableStartupRecord, portableStartupFailure } = await import('../app/portable-limited-failure.mjs');
    const { claimPortableLimitedRun } = await import('../app/portable-limited-claim.mjs');
    await mkdir('/tmp/opencode/ktz-refusal-20261103', { recursive: true, mode: 0o700 });
    const root = await mkdtemp('/tmp/opencode/ktz-refusal-20261103/record-'); t.after(() => rm(root, { recursive: true }));
    const id = '0123456789abcdef0123456789abcdef', session = 'saved-01234567-89ab-cdef-0123-456789abcdef';
    async function setup(name) {
      const data = path.join(root, name), jobPath = path.join(data, 'jobs', id), selected = { id: session, root: path.join(data, session) };
      selected.profile = path.join(selected.root, 'owned/profile');
      await mkdir(jobPath, { recursive: true, mode: 0o700 }); await mkdir(selected.profile, { recursive: true, mode: 0o700 });
      await claimPortableLimitedRun(data, selected, { job_path: jobPath, orphan_files: [], issues: [], manifest: {
        job_id: id, state: 'ready', images: [], exports: [], next_capture_id: 1, next_render_version: 1,
        last_capture_id: null, checkpoint: null, capture_settings: { image_format: 'png', page_output_mode: 'single_image' } } });
      return { data, dir: path.join(data, 'portable-reader-startup', id), recorder: portableStartupRecorder(data, id, session) };
    }
    const unknown = await setup('unknown');
    assert.equal((await readPortableStartupRecord(unknown.data, id)).record, 'not-recorded');
    assert.equal(existsSync(path.join(unknown.data, 'portable-reader-startup')), false, '旧記録の読取りは作成しない');
    await unknown.recorder.begin();
    assert.equal((await readPortableStartupRecord(unknown.data, id)).record, 'incomplete', 'startだけでは完了・原因を捏造しない');
    const secret = { code: 'book-secret', message: 'https://private.invalid/cookie', stack: 'profile/private', portableStartupDiagnostic: { stage: 'secret', code: 'book-secret' } };
    assert.deepEqual(portableStartupFailure(secret, 'pipe_attach'), { stage: 'pipe_attach', code: 'unclassified' });
    await unknown.recorder.failed(secret, 'pipe_attach');
    const bytes = await readFile(path.join(unknown.dir, 'result.json'), 'utf8');
    assert.doesNotMatch(bytes, /book-secret|https?:|cookie|profile|message|stack/);
    await unknown.recorder.failed({ code: 'target_changed' }, 'reader_initialize');
    assert.equal(await readFile(path.join(unknown.dir, 'result.json'), 'utf8'), bytes, '後続拒否で最初の結果を上書きしない');
    assert.equal((await readPortableStartupRecord(unknown.data, id)).failure.code, 'unclassified');
    const boundary = await setup('boundary'); await boundary.recorder.begin();
    const startBefore = await readFile(path.join(boundary.dir, 'start.json'), 'utf8');
    boundary.recorder.readerInitialization('pipe_ready', 'start'); // Out of order is not evidence.
    assert.deepEqual(boundary.recorder.snapshot().initialization, { started: null, completed: null });
    boundary.recorder.reached('pipe_attached');
    boundary.recorder.readerInitialization('page_identity', 'start');
    const copied = boundary.recorder.snapshot(); copied.initialization.started = 'private';
    assert.equal(boundary.recorder.snapshot().initialization.started, 'page_identity');
    boundary.recorder.readerInitialization('page_identity', 'complete');
    boundary.recorder.readerInitialization('pipe_ready', 'start');
    await boundary.recorder.failed({ name: 'TimeoutError', message: 'https://private.invalid/book' }, 'reader_initialize');
    const frozen = boundary.recorder.snapshot(), frozenBytes = await readFile(path.join(boundary.dir, 'result.json'), 'utf8');
    assert.deepEqual(frozen.initialization, { started: 'pipe_ready', completed: 'page_identity' });
    assert.deepEqual(frozen.failure, { stage: 'reader_initialize', code: 'operation_timeout' });
    boundary.recorder.readerInitialization('pipe_ready', 'complete'); boundary.recorder.reached('ready');
    await boundary.recorder.failed({ code: 'target_changed' }, 'capture_scale'); await boundary.recorder.ready();
    assert.deepEqual(boundary.recorder.snapshot(), frozen, '後続操作は初回原因と境界を変えない');
    assert.equal(await readFile(path.join(boundary.dir, 'start.json'), 'utf8'), startBefore);
    assert.equal(await readFile(path.join(boundary.dir, 'result.json'), 'utf8'), frozenBytes);
    assert.deepEqual(await readPortableStartupRecord(boundary.data, id), frozen);
    assert.doesNotMatch(frozenBytes, /private|https?:|book|message|stack/);
    const old = await setup('old'); await old.recorder.begin();
    const oldResult = JSON.stringify({ version: 1, lastReached: 'pipe_attached', pipe: 'attached', outcome: 'failed',
      failure: { stage: 'reader_initialize', code: 'operation_timeout' } }) + '\n';
    await writeFile(path.join(old.dir, 'result.json'), oldResult, { flag: 'wx', mode: 0o600 });
    assert.deepEqual(await readPortableStartupRecord(old.data, id), { record: 'complete', lastReached: 'pipe_attached', pipe: 'attached',
      outcome: 'failed', failure: { stage: 'reader_initialize', code: 'operation_timeout' } });
    assert.equal(await readFile(path.join(old.dir, 'result.json'), 'utf8'), oldResult, '旧記録を埋め戻さない');
    const { portableInitialRejectionReasons } = await import('../app/portable-limited-failure.mjs');
    for (const reason of portableInitialRejectionReasons) {
      const classified = await setup(`classified-${reason}`); await classified.recorder.begin();
      classified.recorder.initialRejection('private-secret https://private.invalid');
      classified.recorder.initialRejection(reason); classified.recorder.initialRejection('initial_invalid');
      const copy = classified.recorder.snapshot(); copy.initialRejection = 'private-secret';
      await classified.recorder.failed({ code: 'target_changed' }, 'reader_initialize');
      const result = await readPortableStartupRecord(classified.data, id);
      assert.equal(result.initialRejection, reason, '閉じた分類は最初の1件だけを保持');
      const frozen = await readFile(path.join(classified.dir, 'result.json'), 'utf8');
      classified.recorder.initialRejection('unclassified'); await classified.recorder.ready();
      assert.equal(await readFile(path.join(classified.dir, 'result.json'), 'utf8'), frozen);
      assert.doesNotMatch(frozen, /private-secret|https?:|message|stack/);
    }
    const invalidRejection = await setup('invalid-rejection'); await invalidRejection.recorder.begin();
    await writeFile(path.join(invalidRejection.dir, 'result.json'), JSON.stringify({ version: 3, lastReached: 'pipe_attached',
      pipe: 'attached', outcome: 'failed', failure: { stage: 'reader_initialize', code: 'target_changed' },
      initialization: { started: 'pipe_ready', completed: 'page_identity' }, initialRejection: 'private-secret' }), { flag: 'wx', mode: 0o600 });
    assert.equal((await readPortableStartupRecord(invalidRejection.data, id)).record, 'incomplete', '未知分類を公開しない');
    const invalid = await setup('invalid'); await invalid.recorder.begin();
    await writeFile(path.join(invalid.dir, 'result.json'), JSON.stringify({ version: 2, lastReached: 'pipe_attached', pipe: 'attached',
      outcome: 'failed', failure: { stage: 'reader_initialize', code: 'target_changed' },
      initialization: { started: 'private-secret', completed: null } }), { flag: 'wx', mode: 0o600 });
    assert.equal((await readPortableStartupRecord(invalid.data, id)).record, 'incomplete', '任意文字列を境界として公開しない');
    const linked = await setup('linked'); await linked.recorder.begin();
    const outside = path.join(root, 'preserved'); await writeFile(outside, 'preserve', { mode: 0o600 });
    await symlink(outside, path.join(linked.dir, 'result.json'));
    await linked.recorder.failed({ code: 'target_changed' }, 'reader_initialize');
    assert.equal(linked.recorder.snapshot().record, 'incomplete');
    assert.equal((await readPortableStartupRecord(linked.data, id)).record, 'incomplete');
    assert.equal(await readFile(outside, 'utf8'), 'preserve');
    assert.equal((await stat(path.join(linked.dir, 'pending.json'))).mode & 0o777, 0o600);
    const { ControlOwner } = await import('./support/owned-pipe-control-fixture.mjs');
    const { superviseLinuxOwnedReader } = await import('../app/linux-owned-reader.mjs');
    for (const [given, expected] of [
      [{ stage: 'browser_launch', code: 'ENOENT' }, { stage: 'browser_launch', code: 'ENOENT' }],
      [{ stage: 'browser_launch', code: 'private-code', message: 'private-stack' }, { stage: 'owner_start', code: 'unclassified' }],
    ]) {
      const child = new ControlOwner('normal');
      try {
        const start = superviseLinuxOwnedReader(child, { expectedReader: true, startupTimeoutMs: 100, closeTimeoutMs: 100 });
        queueMicrotask(() => child.emit('message', { event: 'not-started', startupFailure: given }));
        await assert.rejects(start, error => error.code === 'owned_pipe_unconfirmed'
          && JSON.stringify(error.portableStartupDiagnostic) === JSON.stringify(expected));
        assert.equal(child.unreferenced, true, '失敗の分類は既存の保全・所有契約を変えない');
      } finally { child.dispose(); }
    }
  });

  if (enabled) for (const mode of ['positive', 'legacy-stop', 'separate-tab', 'no-selection', 'target-change', 'save-error', 'extra-tab', 'target-close', 'document-reload', 'route-change', 'position-change', 'position-turn-restore', 'cancel', 'turn-reply-lost']) test(`Portable限定: 製品capabilityと通常GUIで単回・PNG・Review停止 ${mode}`, { timeout: 80_000 }, async t => {
    const { runPortableLimitedGui } = await import('./support/portable-limited-gui-fixture.mjs');
      const r = await runPortableLimitedGui(t, mode);
      assert.deepEqual(r.beforeChoice, { screenshots: 0, sends: 0, images: 0 });
      if (mode === 'no-selection') {
        assert.deepEqual(r.preview, { status: 400, code: 'select_reader_tab' }); assert.equal(r.screenshots, 0); assert.equal(r.sends, 0); assert.equal(r.images, 0);
        assert.equal(r.reviewBeforePreview.status, 200); assert.equal(r.selectAfterReview.status, 200);
        assert.deepEqual(r.previewAfterReview, { status: 400, code: 'expected_capture_budget_exhausted' });
        assert.deepEqual(r.afterReview, { screenshots: 0, sends: 0, images: 0 });
        assert.equal(r.reuse.code, 'portable_limited_review_only'); return;
      }
      assert.equal(r.autoSelected, false, '1pageでも新tabでも明示選択を省略しない');
      assert.deepEqual(r.beforeStart, { screenshots: 1, sends: 0, images: 0 });
      assert.equal(r.early.code, 'explicit_start_required');
      for (const value of [...r.blocked, ...r.postBlocked, r.recoveredExport]) assert.deepEqual(value, { status: 400, code: 'portable_limited_review_only' });
      assert.equal(r.reuse.code, 'portable_limited_review_only'); assert.equal(r.profileUnchanged, true);
      assert.equal(r.exports, 0); assert.equal(r.files.some(name => /\.(zip|cbz|jpe?g)$/i.test(name)), false);
      assert.equal(r.repeatPreview.status, 400); assert.deepEqual(r.afterRepeat, { screenshots: r.screenshots, sends: r.sends });
      assert.equal(r.duplicateStart.status, 400);
      if (['positive', 'legacy-stop', 'separate-tab'].includes(mode)) {
        assert.equal(r.start.status, 200); assert.equal(r.state, 'Review'); assert.equal(r.reason, 'capture_limit_reached');
        assert.equal(r.images, 2); assert.equal(r.screenshots, 2); assert.equal(r.sends, 1); assert.equal(r.firstMatches, true);
        assert.equal(r.disabledNext, false); assert.equal(r.savedReviewAction, '保存済み画像を確認');
        assert.equal(r.readerPages, mode === 'separate-tab' ? 2 : 1); assert.equal(r.dispatch, 'not_sent');
        if (['positive', 'legacy-stop'].includes(mode)) {
          if (mode === 'positive') {
            assert.deepEqual(startupBase(r.startup), { record: 'not-recorded', lastReached: 'unknown', pipe: 'unknown', outcome: 'unknown', failure: null });
            assert.deepEqual(r.diskStartup, r.startup);
            assert.equal(r.startupFilePresent, false, '共通adapterで存在しない準備完了記録を作らない');
            assert.equal(r.presetPreserved, true, '古いカスタム設定を上書きせず限定固定設定を使う');
            assert.equal(r.nextTrialEnabled, true);
            assert.deepEqual(r.nextTrial, { empty: true, browserOpen: false, available: true, claimExists: false,
              originalsAndRecordsUnchanged: true, screenshots: 2, sends: 1 });
          }
          assert.equal(r.otherDataRecover, 200); assert.equal(r.otherDataLimited, true);
          for (const value of r.otherDataBlocked) assert.deepEqual(value, { status: 400, code: 'portable_limited_review_only' });
          assert.equal(r.otherDataUnchanged, true, '復帰先dataを変えても限定ジョブは変更しない');
        }
        if (mode === 'legacy-stop') {
          const old = r.legacy;
          assert.deepEqual(old.startup, { record: 'not-recorded', lastReached: 'unknown', pipe: 'unknown', outcome: 'unknown', failure: null });
          assert.match(old.guidance, /初回詳細原因不明（記録なし）/); assert.match(old.message, /初回詳細原因不明/);
          assert.equal(old.percent, '—'); assert.match(old.operationLabel, /試行は停止/);
          assert.deepEqual(old.retry, { status: 400, code: 'portable_limited_review_only' });
          assert.deepEqual(old.edit, { status: 400, code: 'portable_limited_review_only' });
          for (const value of [old.stop, old.pause]) assert.deepEqual(value, { status: 400, code: 'portable_limited_claim_consumed' });
          assert.equal(old.newTrialEnabled, true); assert.equal(old.newJob, r.claimJob);
          assert.equal(old.available, true); assert.equal(old.claimBeforeConnect, false);
          assert.equal(old.claimUnchanged, true); assert.equal(old.manifestUnchanged, true); assert.equal(old.startupUnchanged, true);
          assert.equal(old.otherDataRecover, 200); assert.equal(old.otherDataLimited, true);
          assert.deepEqual(old.otherDataExport, { status: 400, code: 'portable_limited_review_only' });
          assert.equal(old.otherDataReview, 200); assert.equal(old.otherDataReviewUnchanged, true);
        }
      } else if (mode === 'turn-reply-lost') {
        assert.equal(r.images, 1); assert.equal(r.screenshots, 1); assert.equal(r.sends, 1); assert.equal(r.dispatch, 'unknown'); assert.equal(r.firstMatches, true);
      } else {
        assert.equal(r.images, 0); assert.equal(r.screenshots, 1); assert.equal(r.sends, 0);
        if (['target-change', 'position-turn-restore'].includes(mode)) assert.deepEqual(r.start, { status: 400, code: 'target_changed' });
      }
  });

  test('Portable接合: 期待Reader ownerを匿名site capabilityに取り違えない', async () => {
    const { ControlOwner } = await import('./support/owned-pipe-control-fixture.mjs');
    const { superviseLinuxOwnedReader } = await import('../app/linux-owned-reader.mjs');
    const { ownedGuiCapabilityForOwner } = await import('../app/owned-sample.mjs');
    const child = new ControlOwner('normal'); child.pid = 12345;
    try {
      const starting = superviseLinuxOwnedReader(child, { expectedReader: true, startupTimeoutMs: 1000, closeTimeoutMs: 1000 });
      queueMicrotask(() => child.emit('message', { event: 'ready', kind: 'fixed-expected-reader', browserPid: 12346 }));
      const owner = await starting;
      assert.equal(Object.isFrozen(owner), true);
      assert.throws(() => ownedGuiCapabilityForOwner(owner), { code: 'owned_sample_unavailable' });
      await owner.close();
    } finally { child.dispose(); }
  });

  if (enabled) test('Portable接合: 通常GUIと明示保存sessionから匿名所有Readerへ接続し有限取得後に正常終了', { timeout: 150_000 }, async t => {
    assert.ok(process.env.WAYLAND_DISPLAY, '実Snap/Waylandが必要です');
    const base = '/home/user/KTZRC';
    await mkdir(base, { recursive: true, mode: 0o700 });
    const root = await mkdtemp(path.join(base, 'portable-connection-'));
    // Chromium's private SingletonSocket must fit the Unix socket path limit.
    const temp = await mkdtemp('/tmp/opencode/ktzrc-');
    const evidenceBase = path.join(project, 'artifacts/ubuntu-portable/reader-connection');
    await mkdir(evidenceBase, { recursive: true, mode: 0o700 });
    const evidence = await mkdtemp(path.join(evidenceBase, 'anonymous-'));
    const server = net.createServer(), socketPath = path.join(root, 's');
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    const connected = new Promise(resolve => server.once('connection', resolve));
    const guiHook = new URL('./support/portable-connection-hook.mjs', import.meta.url).href;
    const child = spawn('npm', ['--prefix', project, 'start'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, KTZ_USER_DATA_DIR: path.join(root, 'data'), KTZ_TEMP_DIR: temp,
        KTZ_PORTABLE_CONNECTION_ROOT: root, KTZ_PORTABLE_CONNECTION_SOCKET: socketPath, KTZ_PORTABLE_CONNECTION_EVIDENCE: evidence,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${guiHook}` } });
    let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
    const exited = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
    const timeout = ms => new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error(`gui_timeout:${output}`)), ms); timer.unref(); });
    let socket;
    t.after(async () => {
      if (socket && !socket.destroyed) socket.write('{"action":"close"}\n');
      server.close();
      // Request normal app shutdown; never forcibly remove a possibly unknown owner.
      if (child.exitCode === null && child.signalCode === null) {
        await Promise.race([exited, timeout(20_000)]).catch(() => {});
      }
      socket?.destroy();
    });
    socket = await Promise.race([connected, exited.then(() => { throw new Error(`startup_exited:${root}:${output}`); }), timeout(40_000)]);
    let buffer = ''; const queue = [], waiters = [];
    socket.on('data', chunk => {
      buffer += chunk; let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const value = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        const waiter = waiters.shift(); if (waiter) waiter(value); else queue.push(value);
      }
    });
    const receive = () => queue.length ? Promise.resolve(queue.shift()) : new Promise(resolve => waiters.push(resolve));
    const result = await Promise.race([receive(), timeout(110_000)]);
    assert.equal(result.event, 'result', `${result.message ?? ''}\n${output}`);
    assert.deepEqual(result.preOpen, { screenshots: 0, sends: 0, images: 0, reader: false });
    assert.equal(result.opened, true); assert.equal(result.sameIdentity, true);
    assert.equal(result.profile, path.join(root, 'data', result.id, 'owned/profile'));
    assert.deepEqual(result.concurrentLogin, { code: 'login_in_use_or_unknown', launched: false });
    assert.equal(result.early, 'explicit_start_required');
    assert.deepEqual(result.approvalEffects, { screenshots: 1, sends: 0, images: 0 });
    assert.deepEqual(result.stale, [400, 'target_changed']);
    assert.equal(result.firstClose, 200);
    assert.deepEqual(result.invalidated, { preview: false, approved: false });
    assert.equal(result.secondApprovalImages, 0);
    assert.equal(result.state, 'Review'); assert.equal(result.reason, 'capture_limit_reached');
    assert.equal(result.images, 2); assert.equal(result.dispatch, 'not_sent'); assert.equal(result.sends, 1);
    for (const name of ['source.png', 'approval.png', 'review.png']) assert.ok((await stat(path.join(evidence, name))).size > 0);
    socket.write('{"action":"close"}\n');
    assert.equal((await Promise.race([receive(), timeout(5000)])).event, 'closing');
    assert.deepEqual(await Promise.race([exited, timeout(35_000)]), { code: 0, signal: null }, output);
    const events = await pipeTrace(root), owners = events.filter(item => item.event === 'spawn');
    assert.equal(owners.length, 2);
    for (const owner of owners) {
      assert.equal(owner.profile, result.profile);
      assert.equal(owner.lockHeld, true, '選択した同一profileの排他取得後に起動する');
      assert.throws(() => process.kill(owner.owner, 0), { code: 'ESRCH' });
      assert.throws(() => process.kill(-owner.browser, 0), { code: 'ESRCH' });
    }
    await assert.rejects(stat(path.join(path.dirname(result.profile), 'in-use.lock')), { code: 'ENOENT' });
    assert.deepEqual(await readdir(temp), []);
    t.diagnostic(`匿名公開GUI画像: ${evidence}; 固定匿名fixtureだけで検証、実Kindleは未接続`);
  });

  if (enabled) test('Linux一般GUI接合: 通常npm startから匿名所有sourceを有限承認し点検、対象変更を拒否して正常join', { timeout: 150_000 }, async t => {
    assert.ok(process.env.WAYLAND_DISPLAY, '実Snap/Waylandが必要です。検査0件を成功にしません');
    const root = await mkdtemp('/tmp/opencode/ktz-linux-gui-98eefa8d-');
    const temp = path.join(root, 'temp'); await mkdir(temp, { mode: 0o700 });
    const evidenceBase = path.join(project, 'artifacts/image-review-evidence/linux-gui-98eefa8d');
    await mkdir(evidenceBase, { recursive: true, mode: 0o700 });
    const evidence = await mkdtemp(path.join(evidenceBase, 'anonymous-'));
    const server = net.createServer(), socketPath = path.join(root, 's');
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    const connected = new Promise(resolve => server.once('connection', resolve));
    const guiHook = new URL('./support/owned-gui-hook.mjs', import.meta.url).href;
    const child = spawn('npm', ['--prefix', project, 'start'], { cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, KTZ_USER_DATA_DIR: path.join(root, 'data'), KTZ_TEMP_DIR: temp,
        KTZ_GUI_TEST_ROOT: root, KTZ_GUI_TEST_SOCKET: socketPath, KTZ_GUI_TEST_EVIDENCE: evidence,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${guiHook}` } });
    let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
    const exited = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
    const timeout = ms => new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error(`gui_timeout:${output}`)), ms); timer.unref(); });
    let socket;
    t.after(async () => {
      socket?.destroy(); server.close();
      if (child.exitCode === null && child.signalCode === null) {
        try { process.kill(-child.pid, 'SIGTERM'); } catch {}
        await Promise.race([exited, timeout(20_000)]).catch(() => {});
      }
    });
    socket = await Promise.race([connected, exited.then(() => { throw new Error(`startup_exited:${output}`); }), timeout(40_000)]);
    let buffer = ''; const queue = [], waiters = [];
    socket.on('data', chunk => {
      buffer += chunk; let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const value = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        const waiter = waiters.shift(); if (waiter) waiter(value); else queue.push(value);
      }
    });
    const receive = () => queue.length ? Promise.resolve(queue.shift()) : new Promise(resolve => waiters.push(resolve));
    const result = await Promise.race([receive(), timeout(120_000)]);
    assert.equal(result.event, 'result', `${result.message ?? ''}\n${output}`);
    const a = result.first, b = result.second;
    assert.equal(a.sourceRequired, true);
    assert.equal(a.sourceState, '取得元選択待ち'); assert.match(a.trafficNotice, /外部サイトへ接続しません/);
    assert.match(a.english, /Anonymous self-authored fixture/); assert.match(a.chinese, /匿名自制样本/);
    assert.deepEqual(a.invalid, [[400, 'select_saved_session'], ...Array(7).fill([400, 'invalid_browser_mode'])]);
    assert.deepEqual(a.beforePreview, { screenshots: 0, sends: 0, images: 0, canvasReads: 0 });
    assert.equal(a.previewImages, 0); assert.ok(a.canvasReadsAfterPreview > 0, '明示preview中にpaintを照合');
    assert.equal(a.canvasReadsAtApproval, a.canvasReadsAfterPreview, '承認操作はpreview後の追加pixel読取をしない');
    assert.equal(a.changedPaint, 'target_changed'); assert.equal(a.restoredPaint, true);
    assert.equal(a.early, 'explicit_start_required');
    assert.deepEqual(a.approvalEffects, { screenshots: 1, sends: 0, images: 0 }, '承認までは明示previewのみで原本・送りなし');
    assert.deepEqual(a.noLimit, [400, 'invalid_capture_limit']); assert.equal(a.approvedLimit, 2);
    assert.equal(a.revertRequiresApproval, 'approve'); assert.deepEqual(a.invalidReapproval, [400, 'invalid_capture_limit']);
    assert.equal(a.afterInvalidReapproval, 'explicit_start_required'); assert.equal(a.freshApproval, 200);
    assert.equal(a.changedLimit, 'capture_limit_changed');
    assert.equal(a.afterChangedLimit, 'explicit_start_required'); assert.equal(a.settingsStatus, 200); assert.equal(a.staleStart, 'explicit_start_required');
    assert.equal(a.state, 'Review'); assert.equal(a.reason, 'capture_limit_reached');
    assert.equal(a.manifest.images.length, 2); assert.equal(a.manifest.checkpoint.dispatch, 'not_sent'); assert.equal(a.sends, 1); assert.equal(a.screenshots, 3);
    assert.equal(a.crop, true); assert.equal(a.exports, 1); assert.equal(a.originalIntact, true); assert.ok(a.originalBytes > 0 && a.editedBytes > 0);
    assert.deepEqual(a.invalidRegion, [400, 'target_changed']); assert.equal(a.beforeInvalidRegion, a.afterInvalidRegion);
    assert.deepEqual(b.statuses, [200, 200, 200, 200, 200, 200, 200]);
    assert.equal(b.inherited, 'explicit_start_required'); assert.equal(b.fakeSession, 'invalid_browser_mode');
    assert.equal(b.state, 'NeedsAttention'); assert.equal(b.reason, 'target_changed');
    assert.equal(b.failure.stage, 'target_recheck_before_commit'); assert.equal(b.images, 0); assert.equal(b.sends, 1);
    assert.equal(b.events.filter(item => item.kind === 'capture_commit').length, 2);
    assert.equal(b.events.filter(item => item.kind === 'capture_abort').length, 1);
    assert.deepEqual(result.switched, { statuses: [200, 200, 200, 200, 200, 200, 200], finite: false, approved: true, limit: null });
    for (const name of ['source.png', 'approval.png', 'review.png', 'original.png', 'edited.png']) assert.ok((await stat(path.join(evidence, name))).size > 0);
    assert.equal(hash(await readFile(path.join(evidence, 'original.png'))), a.manifest.images[0].sha256);
    assert.notEqual(hash(await readFile(path.join(evidence, 'original.png'))), hash(await readFile(path.join(evidence, 'edited.png'))));
    const archive = entries(await readFile(path.join(root, 'anonymous.zip')));
    assert.equal(archive.length, 2); assert.equal(hash(archive[0].bytes), hash(await readFile(path.join(evidence, 'edited.png'))));
    socket.write('{"action":"close"}\n');
    assert.equal((await Promise.race([receive(), timeout(5000)])).event, 'closing');
    assert.deepEqual(await Promise.race([exited, timeout(35_000)]), { code: 0, signal: null }, output);
    const trace = await pipeTrace(root), browsers = trace.filter(item => item.event === 'spawn');
    assert.equal(browsers.length, 2); assert.equal(trace.filter(item => item.event === 'browser-close').length, 2);
    for (const browser of browsers) {
      assert.throws(() => process.kill(browser.owner, 0), { code: 'ESRCH' });
      assert.throws(() => process.kill(-browser.browser, 0), { code: 'ESRCH' });
      await assert.rejects(stat(path.join(path.dirname(browser.profile), 'in-use.lock')), { code: 'ENOENT' });
    }
    assert.deepEqual(await readdir(temp), []);
    await writeFile(path.join(evidence, 'result.json'), JSON.stringify({ source: 'anonymous-only', finiteImages: 2, sends: 1,
      changedIdentityCommitted: 0, normalOwnersJoined: browsers.length, originalHash: hash(await readFile(path.join(evidence, 'original.png'))),
      editedHash: hash(await readFile(path.join(evidence, 'edited.png'))) }, null, 2));
    t.diagnostic(`匿名GUI・編集比較: ${evidence}`);
  });

  test('Linux一般GUI接合: 偽物の所有sessionと単回予算・synthetic終了不明を拒否保持', async () => {
    const { resolveOwnedSession } = await import('../app/owned-session.mjs');
    const { createGuiCaptureBudget, createExpectedCaptureBudget } = await import('../app/expected-capture-budget.mjs');
    const { ControlOwner } = await import('./support/owned-pipe-control-fixture.mjs');
    const { superviseLinuxOwnedReader } = await import('../app/linux-owned-reader.mjs');
    const { Application } = await import('../app/application.mjs');
    assert.throws(() => resolveOwnedSession({ url: 'http://127.0.0.1:12345/reader.html?asin=B000KTZ001' }), { code: 'owned_sample_unavailable' });
    const budget = createGuiCaptureBudget();
    assert.throws(() => budget.start(1), { code: 'expected_capture_budget_exhausted' });
    await budget.screenshot('preview', async () => 'anonymous');
    assert.throws(() => budget.approve(null), { code: 'expected_capture_budget_exhausted' });
    budget.approve(3); budget.invalidate();
    assert.throws(() => budget.start(3), { code: 'expected_capture_budget_exhausted' });
    await budget.screenshot('preview', async () => 'anonymous'); budget.approve(1); budget.start(1); budget.commit(); budget.finish();
    assert.throws(() => budget.start(1), { code: 'expected_capture_budget_exhausted' });
    const fixed = createExpectedCaptureBudget();
    await fixed.screenshot('preview', async () => 'anonymous');
    assert.throws(() => fixed.approve(3), { code: 'expected_capture_budget_exhausted' }, '旧実本単回の2枚上限を変えない');
    const owner = new ControlOwner('lost-callback');
    try {
      const session = await superviseLinuxOwnedReader(owner, { startupTimeoutMs: 1000, closeTimeoutMs: 40 });
      const root = await mkdtemp('/tmp/opencode/ktz-linux-gui-98eefa8d-unknown-');
      const app = new Application({ dataDir: root });
      const lifecycle = { state: 'active', profile: null };
      let fixtureClosed = false;
      app.reader = { lifecycle, close: () => session.close(), cancelPick: async () => {} };
      app.readerLifecycle = lifecycle; app.ownedPipeFixture = true;
      app.fixture = { close: async () => { fixtureClosed = true; } };
      await assert.rejects(app.command('closeBrowser'), { code: 'reader_close_failed' });
      assert.equal(app.readerReleasePending, true); assert.equal(fixtureClosed, false);
      owner.emit('message', { event: 'normal' }); owner.emit('exit', 0, null);
      await assert.rejects(session.close(), { code: 'owned_pipe_release_unconfirmed' });
      await assert.rejects(app.command('openBrowser', { mode: 'owned-fixture' }), { code: 'reader_release_incomplete' });
      await assert.rejects(app.command('closeBrowser'), { code: 'reader_close_failed' });
      await assert.rejects(app.close(), { code: 'reader_close_failed' });
      assert.equal(fixtureClosed, false); assert.equal(lifecycle.state, 'close_unconfirmed');
      assert.ok(owner.sent.includes('retain')); assert.equal(owner.unreferenced, true);
    } finally { owner.dispose(); }
  });

  async function runOwnedPipeFlow(t, mode) {
      assert.ok(process.env.WAYLAND_DISPLAY, '実Snap/Waylandが必要です。検査0件を成功にしません');
      const artifactDir = path.join(project, 'artifacts/linux-owned-reader');
      await mkdir(artifactDir, { recursive: true });
      const root = await mkdtemp('/tmp/opencode/ktz-owned-reader-');
      const temp = path.join(root, 'temp'); await mkdir(temp, { mode: 0o700 });
      const imagePath = path.join(artifactDir, `${path.basename(root)}-approval.png`);
      const server = net.createServer(), socketPath = path.join(root, 's');
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
      const connected = new Promise(resolve => server.once('connection', resolve));
      const child = spawn('npm', ['--prefix', project, 'start', '--', '--sample-owned-pipe'], {
        cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
          KTZ_USER_DATA_DIR: path.join(root, 'data'), KTZ_TEMP_DIR: temp,
          KTZ_PIPE_TEST_ROOT: root, KTZ_PIPE_TEST_MODE: mode, KTZ_PIPE_TEST_SOCKET: socketPath,
          KTZ_PIPE_TEST_IMAGE: imagePath, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${pipeHook}` },
      });
      let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
      const exited = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
      const timeout = ms => new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error(`timeout ${mode}: ${output}`)), ms); timer.unref(); });
      let socket;
      t.after(async () => {
        socket?.destroy(); server.close();
        if (child.exitCode === null && child.signalCode === null) {
          try { process.kill(-child.pid, 'SIGTERM'); } catch {}
          await Promise.race([exited, timeout(15_000)]).catch(() => {});
        }
      });
      socket = await Promise.race([connected, exited.then(() => { throw new Error(`startup exited: ${output}`); }), timeout(40_000)]);
      let buffer = ''; const queue = [], waiters = [];
      socket.on('data', chunk => {
        buffer += chunk; let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const value = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
          const waiter = waiters.shift(); if (waiter) waiter(value); else queue.push(value);
        }
      });
      const receive = () => queue.length ? Promise.resolve(queue.shift()) : new Promise(resolve => waiters.push(resolve));
      const result = await Promise.race([receive(), timeout(70_000)]);
      assert.equal(result.event, 'result', `${result.message ?? ''}\n${output}`);
      assert.deepEqual(result.invalid, [[400, 'select_saved_session'], ...Array(4).fill([400, 'invalid_browser_mode'])]);
      assert.equal(result.early, 'explicit_start_required');
      assert.deepEqual(result.noLimit, [400, 'invalid_capture_limit']);
      assert.equal(result.blankDisabled, true); assert.equal(result.approvedMax, 2);
      assert.equal(result.changed, 'capture_limit_changed'); assert.equal(result.start, 200); assert.equal(result.previewImages, 0);
      if (mode === 'positive' || mode === 'unknown') {
        assert.equal(result.state, 'Review'); assert.equal(result.reason, 'capture_limit_reached');
        assert.equal(result.manifest.images.length, 2); assert.equal(result.sends, 1); assert.equal(result.position, '2 / 12');
        assert.equal(result.manifest.checkpoint.dispatch, 'not_sent');
        const originals = await readdir(path.join(result.jobPath, 'originals'));
        assert.equal(originals.length, 2);
        for (const item of result.manifest.images) assert.equal(hash(await readFile(path.join(result.jobPath, item.path))), item.sha256);
        if (mode === 'positive') {
          assert.deepEqual(result.modeSwitch, { statuses: [200, 200, 200, 200, 200, 200, 200], finite: false, approved: true, limit: null });
          assert.deepEqual(result.identityStop, { status: 400, code: 'target_changed', screenshotsBefore: 3, screenshotsAfter: 3, sends: 1, images: 2 });
          assert.ok((await stat(imagePath)).size > 0); t.diagnostic(`匿名UI: ${imagePath}`);
        }
      } else {
        assert.equal(result.state, 'NeedsAttention'); assert.equal(result.manifest.images.length, 1);
        assert.equal(result.sends, 1);
        if (['book', 'position', 'document'].includes(mode)) {
          if (mode === 'document') { assert.equal(result.reason, 'browser_target_changed'); assert.equal(result.failure, null); }
          else assert.equal(result.failure.stage, 'target_recheck_before_commit');
          assert.equal(result.events.filter(item => item.kind === 'capture_commit').length, 1);
          assert.equal(result.events.filter(item => item.kind === 'capture_abort').length, 1);
        } else {
          assert.equal(result.failure.advanceDispatch, mode === 'response-loss' ? 'unknown' : 'sent');
          assert.notEqual(result.manifest.checkpoint.dispatch, 'not_sent');
        }
      }
      if (mode === 'unknown') { assert.deepEqual(result.close, [400, 'reader_close_failed']); assert.equal(result.releasePending, true); }
      socket.write('{"action":"close"}\n');
      assert.equal((await Promise.race([receive(), timeout(5000)])).event, 'closing');
      const exit = await Promise.race([exited, timeout(35_000)]);
      assert.equal(exit.signal, null); assert.equal(exit.code, mode === 'unknown' ? 1 : 0, output);
      const trace = await pipeTrace(root), browser = trace.find(item => item.event === 'spawn');
      assert.ok(browser); assert.equal(trace.filter(item => item.event === 'browser-close').length, 1);
      const lock = path.join(path.dirname(browser.profile), 'in-use.lock');
      if (mode === 'unknown') {
        assert.doesNotThrow(() => process.kill(browser.owner, 0)); assert.doesNotThrow(() => process.kill(browser.pid, 0));
        assert.ok(Number.isInteger(browser.inputFd) && Number.isInteger(browser.outputFd));
        for (const [pid, fd] of [[browser.owner, browser.inputFd], [browser.owner, browser.outputFd], [browser.pid, 3], [browser.pid, 4]]) {
          assert.match(await readlink(`/proc/${pid}/fd/${fd}`), /^socket:\[\d+\]$/);
        }
        assert.ok((await stat(lock)).isFile()); assert.ok((await readdir(temp)).some(name => name.startsWith('ktz-')));
        assert.match(output, /安全確認ができなかったため専用一時領域を保持/);
      } else {
        assert.throws(() => process.kill(-browser.pid, 0), { code: 'ESRCH' });
        await assert.rejects(stat(lock), { code: 'ENOENT' });
        assert.deepEqual(await readdir(temp), []);
      }
  }
  if (enabled) for (const mode of ['positive', 'book', 'position', 'document', 'wrong-transition', 'response-loss', 'unknown']) {
    test(`Linux所有pipe: 公開npm start ${mode}`, { timeout: 100_000 }, t => runOwnedPipeFlow(t, mode));
  }
  // The registered expected-session check exercises the same public entry,
  // real Snap/owner, Application, separate approval/start and normal join.
  if (enabled) test('Linux期待本session: 公開npm start 匿名期待本から有限取得と正常終了', { timeout: 100_000 }, t => runOwnedPipeFlow(t, 'positive'));
}

if (process.platform === 'linux') test('Linux所有pipe: 公開CLIはURLやprofileを受け付けない', { timeout: 30_000 }, () => {
  for (const argument of ['--url=http://127.0.0.1:9/reader.html', '--profile=/tmp/not-an-owned-profile']) {
    const run = spawnSync('npm', ['--prefix', project, 'start', '--', '--sample-owned-pipe', argument], { cwd: project, encoding: 'utf8', timeout: 12_000 });
    assert.equal(run.error, undefined); assert.equal(run.signal, null); assert.equal(run.status, 1);
    assert.doesNotMatch(run.stdout, /ローカルMVPを起動しました/);
  }
});

if (enabled) test('Linux所有pipe: closeと親disconnectが競合しても実Snapを一度だけ正常終了', { timeout: 90_000 }, async () => {
  assert.ok(process.env.WAYLAND_DISPLAY);
  const root = await mkdtemp('/tmp/opencode/ktz-owned-reader-');
  const owner = fork(fileURLToPath(new URL('../app/linux-owned-reader-owner.mjs', import.meta.url)), [], {
    execPath: process.execPath, execArgv: [`--import=${pipeHook}`], detached: true,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc', 'pipe', 'pipe'], env: { ...process.env, KTZ_PIPE_TEST_ROOT: root, KTZ_PIPE_TEST_MODE: 'race' },
  });
  owner.stdio[4].on('error', () => {}); owner.stdio[5].on('error', () => {}); owner.stdio[5].resume();
  const timeout = ms => new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('owner_timeout')), ms); timer.unref(); });
  const ready = new Promise((resolve, reject) => { owner.on('message', m => m?.event === 'ready' ? resolve() : m?.event === 'unknown' || m?.event === 'not-started' ? reject(new Error(m.event)) : null); owner.once('error', reject); });
  const exit = new Promise(resolve => owner.once('exit', (code, signal) => resolve({ code, signal })));
  await Promise.race([ready, timeout(45_000)]);
  owner.send({ event: 'close' }); owner.disconnect();
  assert.deepEqual(await Promise.race([exit, timeout(30_000)]), { code: 0, signal: null });
  const trace = await pipeTrace(root), browser = trace.find(item => item.event === 'spawn');
  assert.equal(trace.filter(item => item.event === 'browser-close').length, 1);
  assert.throws(() => process.kill(-browser.pid, 0), { code: 'ESRCH' });
  await assert.rejects(stat(path.join(path.dirname(browser.profile), 'in-use.lock')), { code: 'ENOENT' });
});

if (enabled) test('Linux所有pipe: 起動前の親disconnectも同じ終了処理でjoin', { timeout: 90_000 }, async () => {
  assert.ok(process.env.WAYLAND_DISPLAY);
  const root = await mkdtemp('/tmp/opencode/ktz-owned-reader-');
  const owner = fork(fileURLToPath(new URL('../app/linux-owned-reader-owner.mjs', import.meta.url)), [], {
    execPath: process.execPath, execArgv: [`--import=${pipeHook}`], detached: true,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc', 'pipe', 'pipe'], env: { ...process.env, KTZ_PIPE_TEST_ROOT: root, KTZ_PIPE_TEST_MODE: 'early' },
  });
  owner.stdio[4].on('error', () => {}); owner.stdio[5].on('error', () => {}); owner.stdio[5].resume();
  const exit = new Promise(resolve => owner.once('exit', (code, signal) => resolve({ code, signal })));
  const timeout = new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('owner_timeout')), 45_000); timer.unref(); });
  owner.disconnect();
  assert.deepEqual(await Promise.race([exit, timeout]), { code: 0, signal: null });
  const trace = await pipeTrace(root), browser = trace.find(item => item.event === 'spawn');
  assert.ok(browser); assert.equal(trace.filter(item => item.event === 'browser-close').length, 1);
  assert.throws(() => process.kill(-browser.pid, 0), { code: 'ESRCH' });
  await assert.rejects(stat(path.join(path.dirname(browser.profile), 'in-use.lock')), { code: 'ENOENT' });
});

if (process.platform === 'linux') test('Linux所有pipe: group join中の保持要求はlock解除前に反映', async () => {
  const { runLinuxLogin } = await import('../app/linux-login-core.mjs');
  const root = await mkdtemp('/tmp/opencode/ktz-owned-reader-release-');
  const child = new EventEmitter(); child.pid = 999999;
  let ready, joining, releaseGroup, retain = false;
  const started = new Promise(resolve => { ready = resolve; });
  const joined = new Promise(resolve => { joining = resolve; });
  const group = new Promise(resolve => { releaseGroup = resolve; });
  const run = runLinuxLogin({ root, url: 'about:blank', preflight: async () => {},
    launch: () => child, observe: async () => true, onStarted: ready,
    groupGone: async () => { joining(); await group; return true; },
    beforeRelease: async () => { if (retain) throw new Error('retain_requested'); } });
  await started; child.emit('close', 0, null); await joined;
  retain = true; releaseGroup();
  await assert.rejects(run, /retain_requested/);
  assert.ok((await stat(path.join(root, 'owned/in-use.lock'))).isFile());
});

if (process.platform === 'linux') test('Linux所有pipe: 解除許可の待機中にidentityが変わればlockを残す', async () => {
  const { runLinuxLogin } = await import('../app/linux-login-core.mjs');
  const root = await mkdtemp('/tmp/opencode/ktz-owned-reader-release-');
  const child = new EventEmitter(); child.pid = 999999;
  let ready, waiting, allow;
  const started = new Promise(resolve => { ready = resolve; });
  const waitingForRelease = new Promise(resolve => { waiting = resolve; });
  const permission = new Promise(resolve => { allow = resolve; });
  const run = runLinuxLogin({ root, url: 'about:blank', preflight: async () => {},
    launch: () => child, observe: async () => true, onStarted: ready, groupGone: async () => true,
    beforeRelease: async () => { waiting(); await permission; } });
  const { profile } = await started; child.emit('close', 0, null); await waitingForRelease;
  await chmod(profile, 0o755); allow();
  await assert.rejects(run, { code: 'unsafe_login_directory' });
  assert.ok((await stat(path.join(root, 'owned/in-use.lock'))).isFile());
});

if (enabled) test('Linux所有pipe: 実group終了後のlock解除は親の許可信号を待つ', { timeout: 90_000 }, async () => {
  assert.ok(process.env.WAYLAND_DISPLAY);
  const root = await mkdtemp('/tmp/opencode/ktz-owned-reader-');
  const owner = fork(fileURLToPath(new URL('../app/linux-owned-reader-owner.mjs', import.meta.url)), [], {
    execPath: process.execPath, execArgv: [`--import=${pipeHook}`], detached: true,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc', 'pipe', 'pipe'], env: { ...process.env, KTZ_PIPE_TEST_ROOT: root, KTZ_PIPE_TEST_MODE: 'release' },
  });
  owner.stdio[4].on('error', () => {}); owner.stdio[5].on('error', () => {}); owner.stdio[5].resume();
  const timeout = ms => new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('owner_timeout')), ms); timer.unref(); });
  const event = name => new Promise((resolve, reject) => {
    const receive = message => {
      if (message?.event === name) { owner.off('message', receive); resolve(); }
      else if (message?.event === 'unknown' || message?.event === 'not-started') { owner.off('message', receive); reject(new Error(message.event)); }
    };
    owner.on('message', receive);
  });
  const ready = event('ready'), releaseReady = event('release-ready');
  const exit = new Promise(resolve => owner.once('exit', (code, signal) => resolve({ code, signal })));
  await Promise.race([ready, timeout(45_000)]);
  owner.send({ event: 'close' });
  await Promise.race([releaseReady, timeout(30_000)]);
  const trace = await pipeTrace(root), browser = trace.find(item => item.event === 'spawn');
  assert.equal(trace.filter(item => item.event === 'browser-close').length, 1);
  assert.throws(() => process.kill(-browser.pid, 0), { code: 'ESRCH' });
  const lock = path.join(path.dirname(browser.profile), 'in-use.lock');
  assert.ok((await stat(lock)).isFile()); assert.doesNotThrow(() => process.kill(owner.pid, 0));
  owner.send({ event: 'release' });
  assert.deepEqual(await Promise.race([exit, timeout(30_000)]), { code: 0, signal: null });
  await assert.rejects(stat(lock), { code: 'ENOENT' });
});

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
  // Do not replace an earlier headed-product evidence image.
  const image = path.join(root, 'anonymous-preview.png');
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
        [400, 'select_saved_session'], [400, 'invalid_browser_mode'], [400, 'invalid_browser_mode'], [400, 'invalid_browser_mode'],
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

// Like the existing Linux-only public tests, register native Wayland cases
// only where they apply. Windows full CI requires an unskipped test suite.
if (enabled) test('Linux公開npm start: 専用有頭自作試料の製品縦断と限定故障', { timeout: 480_000 }, async t => {
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

if (enabled) test('有頭自作proxy: 拒否応答中のpeer resetで実processを落とさない', () => {
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

if (process.platform === 'linux') test('Linux匿名白紙: 公開APIの実描画PNGを実Rustで判定し送り前に停止', { timeout: 90_000 }, async t => {
  const { startApplication } = await import('../app/server.mjs');
  const { sampleConfig } = await import('../app/reader.mjs');
  const { PNG } = await import('pngjs');
  for (const timing of ['preview前', 'preview後']) await t.test(timing, async t => {
    const root = await mkdtemp(path.join(existsSync('/tmp/opencode') ? '/tmp/opencode' : tmpdir(), 'ktz-test-blank-'));
    const running = await startApplication({ dataDir: path.join(root, 'data') });
    t.after(() => running.close());
    const api = async (action, input = {}) => {
      const response = await fetch(`${running.origin}/api/command`, { method: 'POST', headers: {
        Authorization: `Bearer ${running.token}`, 'Content-Type': 'application/json', Origin: running.origin,
      }, body: JSON.stringify({ action, input }) });
      const body = await response.json();
      assert.equal(response.status, 200, `${action}: ${body.code}`);
      return body;
    };
    const image = async url => {
      const response = await fetch(`${running.origin}${url}`, { headers: { Authorization: `Bearer ${running.token}` } });
      assert.equal(response.status, 200);
      return Buffer.from(await response.arrayBuffer());
    };
    const counts = bytes => {
      const png = PNG.sync.read(bytes); let opaque = 0, nearWhite = 0;
      for (let i = 0; i < png.data.length; i += 4) {
        if (png.data[i + 3] <= 2) continue;
        opaque++;
        if (png.data[i] >= 251 && png.data[i + 1] >= 251 && png.data[i + 2] >= 251) nearWhite++;
      }
      return { width: png.width, height: png.height, opaque, nearWhite };
    };
    await api('create');
    await api('openBrowser', { mode: 'sample' });
    const reader = running.app.reader, page = reader.page;
    if (timing === 'preview後') await api('preview', { config: sampleConfig });
    await page.locator('#blank').click();
    const rendered = await page.evaluate(() => {
      const canvas = document.querySelector('#sheet'), rect = canvas.getBoundingClientRect();
      const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let nonwhite = 0;
      for (let i = 0; i < pixels.length; i += 4) if (pixels[i] < 251 || pixels[i + 1] < 251 || pixels[i + 2] < 251) nonwhite++;
      return { ready: document.readyState, canvas: [canvas.width, canvas.height],
        rect: [rect.x, rect.y, rect.width, rect.height], nonwhite };
    });
    assert.equal(rendered.ready, 'complete');
    assert.ok(rendered.canvas[0] > 0 && rendered.canvas[1] > 0);
    assert.equal(rendered.canvas[0] * 480, rendered.canvas[1] * 600);
    assert.equal(rendered.nonwhite, 0, 'the actual fixture canvas must have finished painting white');
    assert.equal(Number.isInteger(rendered.rect[1]), true, 'the canvas clip must not include its border through fractional rounding');
    if (timing === 'preview前') {
      const preview = await api('preview', { config: sampleConfig });
      const data = await image('/api/preview'), measured = counts(data);
      assert.deepEqual([measured.width, measured.height], preview.previewInfo.dimensions);
      assert.deepEqual(preview.previewInfo.cssDimensions, rendered.rect.slice(2));
      assert.ok(measured.opaque > 0);
      assert.ok(measured.nearWhite * 1000 >= measured.opaque * 999, JSON.stringify(measured));
      const directory = path.join(project, 'artifacts/linux-owned-reader');
      await mkdir(directory, { recursive: true });
      const artifact = await mkdtemp(path.join(directory, 'blank-regression-'));
      await writeFile(path.join(artifact, 'preview.png'), data, { flag: 'wx', mode: 0o600 });
      t.diagnostic(`匿名白紙プレビュー: ${path.join(artifact, 'preview.png')}`);
    }
    const actualClip = (await reader.read()).clip;
    assert.deepEqual([actualClip.x, actualClip.y, actualClip.width, actualClip.height], rendered.rect);
    let advances = 0;
    const advance = reader.advance.bind(reader);
    reader.advance = (...args) => { advances++; return advance(...args); };
    await api('approve', { confirmed: true, maxCaptures: 1 });
    await api('start', { confirmed: true });
    const until = Date.now() + 25_000; let stopped;
    do {
      stopped = await running.app.snapshot();
      if (!stopped.busy && ['NeedsAttention', 'Review'].includes(stopped.state)) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() < until);
    assert.equal(stopped.state, 'NeedsAttention');
    assert.equal(stopped.reason, 'image_review_required');
    assert.equal(stopped.lastFailure.stage, 'image_review');
    assert.equal(stopped.job.manifest.images.length, 1);
    assert.equal(stopped.job.manifest.images[0].blank_candidate, true);
    assert.equal(stopped.job.manifest.checkpoint.dispatch, 'not_sent');
    assert.equal(advances, 0);
    assert.equal(await page.locator('#position').innerText(), '1 / 12');
    const original = await image('/api/image/1?original=1'), measured = counts(original);
    assert.deepEqual([measured.width, measured.height], reader.bound.dimensions);
    assert.ok(measured.opaque > 0);
    assert.ok(measured.nearWhite * 1000 >= measured.opaque * 999, JSON.stringify(measured));
    assert.equal(hash(original), stopped.job.manifest.images[0].sha256);
  });
});
