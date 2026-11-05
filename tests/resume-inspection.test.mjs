import './chromium-test-log-sink.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Writable, PassThrough } from 'node:stream';
import { runInNewContext } from 'node:vm';
import { mkdir, mkdtemp, lstat, readFile, rm, realpath, writeFile, link, unlink, symlink, chmod } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeOwnedInspectionBrowser, runResumeController, projectResumeResult, resumeDiagnosticSucceeded } from '../app/linux-inspect-resume-core.mjs';
import { observeLinuxUiProbe } from '../app/linux-inspect-core.mjs';
import { inspectKindleDocument } from '../app/linux-reader-probe.mjs';
import { ownedPipeTransport, readOwnedStartupTargets, readOwnedStartupTargetsAfterControl } from '../app/linux-playwright-pipe.mjs';
import { projectPlaywrightResult, runPlaywrightController, playwrightObservationSucceeded } from '../app/linux-playwright-resume-core.mjs';
import { loadExpectedBook } from '../app/linux-expected-book.mjs';
import { expectedBook, otherAsin } from './support/expected-book-fixture.mjs';

const ready = { state: 'ready', markers: Object.fromEntries(['identity', 'position', 'next'].map(field => [field, { count: 'one', visibility: 'visible' }])) };
const report = { kind: 'reader-ui-probe', scope: 'diagnostic-only', binding: 'unverified', metadataCount: 0,
  probe: ready, shutdown: 'normal', lock: 'released' };
test('復元診断: 正常要求の応答とnative終端・unknownの所有保持を区別する', async t => {
  await t.test('固定入口の引数はbrowser起動前に拒否する', () => {
    const entry = fileURLToPath(new URL('../app/linux-inspect-resume.mjs', import.meta.url));
    for (const argument of ['https://example.invalid/', '--profile=/tmp/other', '--metadata=true']) {
      const run = spawnSync(process.execPath, [entry, argument], { encoding: 'utf8', timeout: 5000 });
      assert.equal(run.status, 1); assert.equal(run.stderr, '');
      const value = JSON.parse(run.stdout);
      assert.equal(value.diagnostic.reason, 'invalid-invocation'); assert.equal(value.shutdown, 'not-started');
      assert.equal(value.metadataCount, 0); assert.equal(value.owner.retained, false);
      assert.doesNotMatch(run.stdout, /example\.invalid|\/tmp\/other/);
    }
  });
  await t.test('応答がなくても正常終端をjoinし、pipeを破棄しない', async () => {
    const writes = [], ended = Promise.resolve({ code: 0, signal: null });
    await closeOwnedInspectionBrowser({ child: { stdio: [null, null, null, { writable: true, write: value => writes.push(value) }] },
      closed: { done: false }, ended, assertProcessStillOwned: async () => {}, onUnknown: () => assert.fail('unexpected unknown') });
    assert.deepEqual(writes, ['{"id":999999,"method":"Browser.close"}\0']);
  });
  await t.test('応答相当があっても生存中ならunknownでpipe所有を継続', async () => {
    let resolveEnd, sawUnknown;
    const unknown = new Promise(resolve => { sawUnknown = resolve; });
    let settled = false, writes = 0, acknowledgementSent = false;
    const output = new EventEmitter();
    const operation = closeOwnedInspectionBrowser({ child: { stdio: [null, null, null, { writable: true, write: () => {
      writes++; acknowledgementSent = true; output.emit('data', Buffer.from('{"id":999999,"result":{}}\0'));
    } }, output] },
      closed: { done: false }, ended: new Promise(resolve => { resolveEnd = resolve; }), assertProcessStillOwned: async () => {},
      timeoutMs: 20, onUnknown: sawUnknown }).then(() => { settled = true; });
    await unknown; assert.equal(settled, false); assert.equal(writes, 1); assert.equal(acknowledgementSent, true);
    resolveEnd({ code: 0, signal: null }); await operation;
  });
  await t.test('所有不明は終了要求しない', async () => {
    let writes = 0;
    await assert.rejects(closeOwnedInspectionBrowser({ child: { stdio: [null, null, null, { writable: true, write: () => { writes++; } }] },
      closed: { done: false }, ended: new Promise(() => {}), assertProcessStillOwned: async () => { throw new Error('unknown'); }, onUnknown: () => {} }));
    assert.equal(writes, 0);
  });
  await t.test('IPC投影はmetadataに昇格せず秘密fieldを落とす', () => {
    assert.deepEqual(projectResumeResult({ ...report, title: 'PRIVATE_BODY_URL', probe: { ...ready, title: 'PRIVATE_BODY_URL' } }), report);
    assert.throws(() => projectResumeResult({ ...report, metadataCount: 1 }));
  });
  await t.test('同じdocumentの遅延準備は有限待機し、対象変更や曖昧さで停止する', async t => {
    const missingMarkers = Object.fromEntries(['identity', 'position', 'next'].map(field => [field, { count: 'none', visibility: 'not-checked' }]));
    const missing = { state: 'unavailable', reason: 'reader-identity-missing', markers: missingMarkers };
    const pipe = ({ probes, targets = ['page'], failProbe = 0 }) => {
      const output = new PassThrough(), commands = [];
      let probeCount = 0, targetCount = 0;
      const input = new Writable({ write(data, encoding, done) {
        const { id, method, params } = JSON.parse(data.toString().replace(/\0$/, ''));
        commands.push({ method, expression: method === 'Runtime.evaluate' ? params.expression : undefined });
        let result, error;
        if (method === 'Target.getTargets') {
          const target = targets[Math.min(targetCount++, targets.length - 1)];
          result = { targetInfos: [{ type: 'page', targetId: target }] };
        } else if (method === 'Target.attachToTarget') result = { sessionId: 'session' };
        else if (method === 'Page.createIsolatedWorld') result = { executionContextId: 1 };
        else if (method === 'Runtime.evaluate') {
          if (params.expression === 'true') result = { result: { value: true } };
          else {
            probeCount++;
            if (probeCount === failProbe) error = { message: 'PRIVATE_BODY_ACCOUNT_URL' };
            else result = { result: { value: probes[Math.min(probeCount - 1, probes.length - 1)] } };
          }
        } else if (method === 'Target.detachFromTarget') result = {};
        else throw new Error('unexpected_anonymous_command');
        setImmediate(() => output.write(JSON.stringify(error ? { id, error } : { id, result }) + '\0'));
        done();
      } });
      return { child: { stdio: [null, null, null, input, output] }, commands, get probeCount() { return probeCount; },
        close() { input.end(); output.end(); } };
    };
    await t.test('遅れて作られたUIを同じ実行contextで診断しmetadataを読まない', async () => {
      const mock = pipe({ probes: [missing, missing, ready] });
      try {
        assert.deepEqual(await observeLinuxUiProbe(mock.child, 'https://read.amazon.co.jp'), ready);
        assert.equal(mock.probeCount, 3);
        assert.equal(mock.commands.filter(command => command.method === 'Target.attachToTarget').length, 1);
        assert.equal(mock.commands.filter(command => command.method === 'Page.createIsolatedWorld').length, 1);
        assert.ok(mock.commands.filter(command => command.expression && command.expression !== 'true')
          .every(command => command.expression.includes('"metadata":false')));
      } finally { mock.close(); }
    });
    await t.test('待機中に別targetへ変われば再選択せず失敗する', async () => {
      const mock = pipe({ probes: [missing], targets: ['page', 'page', 'different-page'] });
      try {
        await assert.rejects(observeLinuxUiProbe(mock.child, 'https://read.amazon.co.jp'), { inspectReason: 'target-changed' });
        assert.equal(mock.probeCount, 2);
        assert.equal(mock.commands.filter(command => command.method === 'Target.attachToTarget').length, 1);
      } finally { mock.close(); }
    });
    await t.test('待機中の実行contextのprotocol errorは原因を断定せずやり直さない', async () => {
      const mock = pipe({ probes: [missing], failProbe: 2 });
      try {
        await assert.rejects(observeLinuxUiProbe(mock.child, 'https://read.amazon.co.jp'), error => {
          assert.equal(error.inspectReason, 'protocol-error');
          assert.doesNotMatch(JSON.stringify(error) + error.message, /PRIVATE_BODY_ACCOUNT_URL/); return true;
        });
        assert.equal(mock.probeCount, 2);
        assert.equal(mock.commands.filter(command => command.method === 'Target.attachToTarget').length, 1);
      } finally { mock.close(); }
    });
    await t.test('別markerが重複している間はmissingを待機理由にしない', async () => {
      const ambiguous = { ...missing, markers: { ...missingMarkers, next: { count: 'multiple', visibility: 'not-checked' } } };
      const mock = pipe({ probes: [ambiguous, ready] });
      try {
        assert.deepEqual(await observeLinuxUiProbe(mock.child, 'https://read.amazon.co.jp'), ambiguous);
        assert.equal(mock.probeCount, 1);
      } finally { mock.close(); }
    });
  });
  await t.test('不透明originは本文を含むpathnameやdocumentを読まずpipeで拒否する', async t => {
    for (const protocol of ['data:', 'file:']) await t.test(protocol, async () => {
      let forbiddenReads = 0;
      const denyRead = () => { forbiddenReads++; throw new Error('anonymous_forbidden_read'); };
      const location = { origin: 'null', protocol };
      for (const field of ['pathname', 'href', 'search', 'hash']) Object.defineProperty(location, field, { get: denyRead });
      const sandbox = { location, get document() { return denyRead(); } };
      const commands = [], output = new PassThrough();
      const input = new Writable({ write(data, encoding, done) {
        const { id, method, params } = JSON.parse(data.toString().replace(/\0$/, ''));
        commands.push(method);
        let result;
        if (method === 'Target.getTargets') result = { targetInfos: [{ type: 'page', targetId: 'opaque-page' }] };
        else if (method === 'Target.attachToTarget') result = { sessionId: 'opaque-session' };
        else if (method === 'Page.createIsolatedWorld') result = { executionContextId: 1 };
        else if (method === 'Runtime.evaluate') {
          try { result = { result: { value: runInNewContext(params.expression, sandbox) } }; }
          catch { result = { exceptionDetails: { text: 'anonymous-exception' } }; }
        } else if (method === 'Target.detachFromTarget') result = {};
        else throw new Error('unexpected_anonymous_command');
        setImmediate(() => output.write(JSON.stringify({ id, result }) + '\0'));
        done();
      } });
      try {
        assert.deepEqual(await observeLinuxUiProbe({ stdio: [null, null, null, input, output] }, 'https://read.amazon.co.jp'),
          { state: 'unavailable', reason: 'document-unavailable' });
        assert.equal(forbiddenReads, 0);
        assert.deepEqual(commands, ['Target.getTargets', 'Target.attachToTarget', 'Page.createIsolatedWorld',
          'Runtime.evaluate', 'Runtime.evaluate', 'Target.getTargets', 'Target.detachFromTarget']);
      } finally { input.end(); output.end(); }
    });
  });
  await t.test('既知about:blankだけを起動待ちとし従来モードは待たない', () => {
    const expression = `(${inspectKindleDocument.toString()})`;
    const location = { origin: 'null', protocol: 'about:', pathname: 'blank' };
    const sandbox = { location, get document() { throw new Error('must_not_read_document'); } };
    const inspect = runInNewContext(expression, sandbox);
    assert.equal(inspect({ expectedOrigin: 'https://read.amazon.co.jp', allowInitialEmpty: true }).state, 'starting');
    for (const options of [{ allowInitialEmpty: false }, { metadata: true, allowInitialEmpty: true }]) {
      Object.defineProperty(location, 'pathname', { configurable: true, get() { throw new Error('must_not_read_pathname'); } });
      const value = inspect({ expectedOrigin: 'https://read.amazon.co.jp', ...options });
      assert.equal(value.state, 'unavailable'); assert.equal(value.reason, 'document-unavailable');
    }
  });
  const mockOwner = () => {
    const child = new EventEmitter(); child.connected = true;
    child.disconnect = () => { child.connected = false; }; child.unref = () => {};
    return child;
  };
  await t.test('owner終了前に成功を返さず、監督期限はguardianを破棄しない', async () => {
    const owner = mockOwner(); let settled = false;
    const operation = runResumeController({ createOwner: () => owner, timeoutMs: 30 }).then(value => { settled = true; return value; });
    owner.emit('message', { event: 'owner-ready', pid: 12345 });
    owner.emit('message', { event: 'result', result: report });
    await Promise.resolve(); assert.equal(settled, false);
    const value = await operation;
    assert.equal(value.shutdown, 'unknown'); assert.equal(value.owner.retained, true); assert.equal(value.owner.exited, false);
    assert.equal(value.metadataCount, 0);
  });
  await t.test('正常owner終端をjoinした場合だけ正常結果を返す', async () => {
    const owner = mockOwner();
    const operation = runResumeController({ createOwner: () => owner });
    owner.emit('message', { event: 'result', result: report }); owner.emit('close', 0, null);
    const value = await operation;
    assert.equal(value.shutdown, 'normal'); assert.equal(value.owner.exited, true); assert.equal(value.owner.retained, false);
    assert.equal(resumeDiagnosticSucceeded(value), true);
    assert.equal(resumeDiagnosticSucceeded({ ...value, diagnostic: { stage: 'ownership-after-observation', reason: 'browser-close-unconfirmed' } }), false);
    assert.equal(resumeDiagnosticSucceeded({ ...value, owner: { exited: false, retained: true } }), false);
  });
  await t.test('別PIDを名乗るIPC結果を採用しない', async () => {
    const owner = mockOwner(); owner.pid = 123;
    const operation = runResumeController({ createOwner: () => owner });
    owner.emit('message', { event: 'owner-ready', pid: 999 });
    const value = await operation;
    assert.equal(value.shutdown, 'unknown'); assert.equal(value.owner.pid, 123); assert.equal(value.owner.retained, true);
  });
});

if (process.platform === 'linux' && process.env.KTZ_DESKTOP_TESTS === '1') test('復元診断: 匿名の選択終了から同じ公開入口で自律復元・分類・正常終了', { timeout: 180_000 }, async t => {
  const profiles = '/home/user/snap/chromium/common/ktz-resume-probe-20261101-8f13e1b6';
  const outputs = '/tmp/opencode/ktz-resume-probe-20261101-8f13e1b6';
  for (const base of [profiles, outputs]) {
    await mkdir(base, { recursive: true, mode: 0o700 });
    const info = await lstat(base);
    assert.ok(info.isDirectory() && !info.isSymbolicLink() && info.uid === process.geteuid() && (info.mode & 0o7777) === 0o700);
    assert.equal(await realpath(base), base);
  }
  const fixture = fileURLToPath(new URL('./support/resume-inspection-fixture.mjs', import.meta.url));
  // Each browser fixture has a fresh private tree; no session/history/auth file
  // is read or rewritten by the test. The browser itself saves/restores state.
  let safeToContinue = true, completed = 0;
  for (const name of ['single', 'other', 'multiple', 'nonkindle', 'auth', 'frame', 'clipped', 'delayed', 'document-change']) {
    if (!safeToContinue) break;
    safeToContinue = false;
    await t.test(name, async () => {
    const root = await mkdtemp(path.join(profiles, 'run-')), before = await lstat(root);
    const output = path.join(await mkdtemp(path.join(outputs, 'run-')), 'result.json');
    const run = spawnSync(process.execPath, [fixture], { cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8', timeout: 80000,
      env: { ...process.env, NODE_OPTIONS: '', DEBUG: '', PWDEBUG: '', KTZ_RESUME_ROOT: root, KTZ_RESUME_OUTPUT: output, KTZ_RESUME_CASE: name, KTZ_RESUME_RECIPE: 'actual' } });
    assert.equal(run.error, undefined); assert.doesNotMatch(run.stdout + run.stderr, /RESUME_FIXTURE|PRIVATE_BODY|PASSWORD|pw:protocol/);
    const value = JSON.parse(await readFile(output, 'utf8'));
    if (value.status === 'ok' && value.lockReleased && value.result.owner.exited) {
      const current = await lstat(root);
      assert.ok(current.dev === before.dev && current.ino === before.ino && current.mode === before.mode && current.uid === before.uid);
      await rm(root, { recursive: true });
    }
    assert.equal(run.status, 0, JSON.stringify({ name, phase: value.failurePhase }));
    assert.equal(value.status, 'ok');
    if (name !== 'multiple') assert.equal(value.browserRestoredSeed, true, name);
    assert.equal(value.result.metadataCount, 0); assert.equal(value.result.binding, 'unverified');
    assert.equal(value.actualExit, ['single', 'other', 'delayed'].includes(name) ? 0 : 1);
    assert.equal(value.events.find(event => event.launch).launch.restoreFlag, true, '正式recipeはブラウザ自身へ明示復元を要求');
    assert.equal(value.result.shutdown, 'normal'); assert.equal(value.result.owner.exited, true);
    if (['single', 'other', 'delayed'].includes(name)) assert.equal(value.result.probe.state, 'ready');
    if (name === 'delayed') assert.ok(value.events.filter(event => event.mode === 'diagnostic').length > 1, '同じ公開入口で遅延したUIを待つ');
    if (name === 'multiple') {
      assert.equal(value.result.diagnostic.reason, 'multiple-page-targets');
      const ambiguous = value.events.findIndex(event => event.pageCount > 1);
      assert.ok(ambiguous >= 0);
      assert.ok(value.events.slice(ambiguous + 1).filter(event => event.command).every(event => event.command === 'Browser.close'), '曖昧さの判明後にattach/evaluateやtabcloseをしない');
    }
    if (name === 'nonkindle' || name === 'auth') assert.equal(value.result.probe.reason, 'document-unavailable');
    if (name === 'frame') assert.equal(value.result.probe.reason, 'reader-identity-missing');
    if (name === 'clipped') assert.equal(value.result.probe.reason, 'reader-identity-clipped');
    if (name === 'document-change') {
      assert.ok(['protocol-error', 'target-changed'].includes(value.result.diagnostic?.reason));
      assert.ok(value.events.filter(event => event.mode === 'diagnostic').length >= 1, '同型の別documentへ変わる前に待機を開始');
    }
    completed++; safeToContinue = true;
    });
  }
  assert.equal(completed, 9);
});

test('Playwright表示確認: pipe時間対照は固定10秒・二照会だけで同じparserへ直列引渡し', async t => {
  for (const mode of ['handoff', 'close-during-delay', 'wrong-response']) await t.test(mode, async sub => {
    const input = new PassThrough(), output = new PassThrough(), requests = [], events = [];
    const transport = ownedPipeTransport({ stdio: [null, null, null, input, output] });
    assert.throws(() => readOwnedStartupTargetsAfterControl(transport), { code: 'owned_pipe_unconfirmed' });
    input.on('data', bytes => {
      const request = JSON.parse(bytes.toString().slice(0, -1)); requests.push(request);
      assert.equal(request.method, 'Target.getTargets');
      const id = mode === 'wrong-response' && request.id === -2 ? -1 : request.id;
      queueMicrotask(() => {
        output.write(`{"method":"event${requests.length}"}\0{"id":${id},"result":{"targetInfos":[]}}\0{"meth`);
        output.write('od":"tail"}\0');
      });
    });
    sub.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      await readOwnedStartupTargets(transport);
      const pending = readOwnedStartupTargetsAfterControl(transport);
      assert.throws(() => readOwnedStartupTargetsAfterControl(transport), { code: 'owned_pipe_unconfirmed' });
      const failure = mode === 'handoff' ? null : assert.rejects(pending, { code: 'owned_pipe_unconfirmed' });
      sub.mock.timers.tick(9999); assert.equal(requests.length, 1, '10秒より前は二照会目なし');
      if (mode === 'close-during-delay') transport.close();
      sub.mock.timers.tick(1);
      if (failure) await failure;
      else {
        await pending;
        assert.throws(() => readOwnedStartupTargetsAfterControl(transport), { code: 'owned_pipe_unconfirmed' });
        transport.onmessage = message => events.push(message.method);
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(events, ['event1', 'tail', 'event2', 'tail']);
        assert.equal(output.listenerCount('data'), 1);
      }
      assert.deepEqual(requests.map(request => request.id), mode === 'close-during-delay' ? [-1] : [-1, -2]);
      assert.equal(input.destroyed || output.destroyed, false, 'ownerの正常終了に使うpipeは保持');
    } finally { sub.mock.timers.reset(); transport.close(); input.end(); output.end(); }
  });
});

test('Playwright表示確認: pipe分割・閉鎖と監督結果は秘密や不確実なmetadataを出さない', async t => {
  await t.test('固定事前照会は一度だけ、応答を消費しeventと分割残りを同じtransportへ渡す', async () => {
    const input = new PassThrough(), output = new PassThrough(), writes = [], delivered = [];
    input.on('data', value => writes.push(value.toString()));
    const transport = ownedPipeTransport({ stdio: [null, null, null, input, output] });
    const pending = readOwnedStartupTargets(transport);
    const targets = [{ type: 'page', targetId: 'private-target', browserContextId: 'private-context', url: 'https://www.amazon.co.jp/private', title: 'private-title' }];
    output.write('{"method":"first"}\0{"id":-');
    output.write(`1,"result":{"targetInfos":${JSON.stringify(targets)}}}\0{"method":"sec`);
    const value = await pending;
    assert.equal(value.length === 1 && value[0].targetId === 'private-target', true, '内部だけで比較');
    assert.throws(() => readOwnedStartupTargets(transport), { code: 'owned_pipe_unconfirmed' });
    transport.onmessage = message => delivered.push(message);
    output.write('ond"}\0');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(delivered, [{ method: 'first' }, { method: 'second' }], '事前応答は後続へ漏れない');
    transport.send({ id: 1, method: 'Browser.getVersion' });
    assert.deepEqual(writes, ['{"id":-1,"method":"Target.getTargets"}\0', '{"id":1,"method":"Browser.getVersion"}\0']);
    assert.equal(output.listenerCount('data'), 1, '物理pipeのread ownerは一つ');
    transport.close(); assert.equal(input.destroyed || output.destroyed, false);
    input.end(); output.end();
  });
  await t.test('事前照会timeoutと別応答は引渡しせず基礎pipeを保全する', async sub => {
    for (const mode of ['timeout', 'wrong-response', 'concurrent-handler', 'oversize']) {
      const input = new PassThrough(), output = new PassThrough();
      const transport = ownedPipeTransport({ stdio: [null, null, null, input, output] });
      sub.mock.timers.enable({ apis: ['setTimeout'] });
      try {
        const pending = readOwnedStartupTargets(transport);
        const rejected = assert.rejects(pending, error => error.code === 'owned_pipe_unconfirmed' && !/private/.test(error.message));
        if (mode === 'timeout') sub.mock.timers.tick(1500);
        if (mode === 'wrong-response') output.write('{"id":1,"error":{"message":"private-secret"}}\0');
        if (mode === 'concurrent-handler') assert.throws(() => { transport.onmessage = () => {}; }, { code: 'owned_pipe_unconfirmed' });
        if (mode === 'oversize') output.write(Buffer.alloc(4 * 1024 * 1024 + 1, 32));
        await rejected;
        assert.throws(() => transport.send({ id: 1, method: 'Browser.getVersion' }));
        assert.equal(input.destroyed || output.destroyed, false);
      } finally { sub.mock.timers.reset(); transport.close(); input.end(); output.end(); }
    }
  });
  await t.test('公開transportはNUL分割を扱い基礎pipeを閉じない', async () => {
    const output = new PassThrough(), written = [];
    const input = new Writable({ write(chunk, encoding, done) { written.push(chunk.toString()); done(); } });
    const transport = ownedPipeTransport({ stdio: [null, null, null, input, output] });
    const messages = [], closed = [];
    transport.onmessage = value => messages.push(value); transport.onclose = () => closed.push(true);
    transport.send({ id: 1, method: 'Browser.getVersion' });
    output.write('{"id":'); output.write('1,"result":{}}\0{"method":"test"}\0');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(messages, [{ id: 1, result: {} }, { method: 'test' }]);
    assert.deepEqual(written, ['{"id":1,"method":"Browser.getVersion"}\0']);
    transport.close(); transport.close();
    assert.equal(closed.length, 1); assert.equal(input.destroyed, false); assert.equal(output.destroyed, false);
    input.end(); output.end();
  });
  await t.test('metadataは正常結果だけに投影し監督timeoutなら破棄する', async () => {
    const result = { kind: 'reader-ui-observation', scope: 'restored-session', binding: 'continuity-unverified', metadataCount: 1,
      observation: { title: '匿名', position: { value: 1, min: 0, max: 2, extra: 'PRIVATE_BODY' },
        region: { width: 20, height: 20, visibleWidth: 20, visibleHeight: 20 }, extra: 'PRIVATE_BODY' },
      shutdown: 'normal', lock: 'released', extra: 'PRIVATE_BODY' };
    const projected = projectPlaywrightResult(result);
    assert.doesNotMatch(JSON.stringify(projected), /PRIVATE_BODY/);
    assert.throws(() => projectPlaywrightResult({ ...result, shutdown: 'unknown', lock: 'retained-or-unknown' }));
    assert.equal(projectPlaywrightResult({ ...result, preparation: 'dispatched' }).preparation, 'dispatched');
    assert.throws(() => projectPlaywrightResult({ ...result, preparation: 'PRIVATE_BODY' }));
    const diagnosticResult = projectPlaywrightResult({ ...result, diagnostics: { clipping: [],
      preparation: { reason: 'hit-blocked', eventsSent: 0, title: 'PRIVATE_BODY' }, body: 'PRIVATE_BODY' } });
    assert.deepEqual(diagnosticResult.diagnostics, { preparation: { reason: 'hit-blocked', eventsSent: 0 }, clipping: [] });
    assert.doesNotMatch(JSON.stringify(diagnosticResult), /PRIVATE_BODY/);
    assert.throws(() => projectPlaywrightResult({ ...result, diagnostics: { preparation: { reason: 'PRIVATE_BODY', eventsSent: 0 } } }));
    const owner = new EventEmitter(); owner.connected = true; owner.disconnect = () => { owner.connected = false; }; owner.unref = () => {};
    const operation = runPlaywrightController({ createOwner: () => owner, timeoutMs: 30 });
    owner.emit('message', { event: 'result', result });
    const unknown = await operation;
    assert.equal(unknown.shutdown, 'unknown'); assert.equal(unknown.metadataCount, 0);
    assert.equal(unknown.owner.retained, true); assert.equal(playwrightObservationSucceeded(unknown), false);
    assert.doesNotMatch(JSON.stringify(unknown), /匿名|PRIVATE_BODY/);
  });
  await t.test('不正フレームは秘密を投影せず接続を閉じpipeを保持する', async () => {
    const input = new PassThrough(), output = new PassThrough();
    const transport = ownedPipeTransport({ stdio: [null, null, null, input, output] });
    let closed = 0, delivered = 0;
    transport.onmessage = () => { delivered++; }; transport.onclose = () => { closed++; };
    output.write('{"private":"PRIVATE_BODY"\0');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(closed, 1); assert.equal(delivered, 0);
    assert.equal(input.destroyed, false); assert.equal(output.destroyed, false);
    input.end(); output.end();
  });
  await t.test('固定入口はURLとprofile引数を起動前に拒否する', () => {
    for (const name of ['linux-playwright-resume.mjs', 'linux-playwright-expected.mjs']) {
      const entry = fileURLToPath(new URL(`../app/${name}`, import.meta.url));
      for (const argument of ['https://example.invalid/', '--profile=/tmp/other']) {
        const run = spawnSync(process.execPath, [entry, argument], { encoding: 'utf8', timeout: 5000 });
        assert.equal(run.status, 1); assert.equal(run.stderr, '');
        assert.equal(JSON.parse(run.stdout).reason, 'invalid-invocation');
        assert.doesNotMatch(run.stdout, /example\.invalid|\/tmp\/other/);
      }
    }
  });
});

test('Playwright表示確認: 私有期待本は安全な固定設定だけを各呼出しで取得', async () => {
  const base = '/tmp/opencode/ktz-expected-book-088aa0b7';
  await mkdir(base, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(path.join(base, 'run-'));
  try {
    const directory = path.join(root, '.local/state/kindle-to-zip-inspection');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, 'expected-book.json'), copy = path.join(directory, 'hardlink');
    await writeFile(file, JSON.stringify(expectedBook), { flag: 'wx', mode: 0o600 });
    const captured = await loadExpectedBook(root);
    assert.equal(captured.asin, expectedBook.asin);
    await writeFile(file, JSON.stringify({ ...expectedBook, asin: otherAsin }));
    assert.equal(captured.asin, expectedBook.asin, '開始済みの呼出しは捕捉した期待値を保持');
    assert.equal((await loadExpectedBook(root)).asin, otherAsin, '次の呼出しは現在の設定を取得');
    await link(file, copy);
    await assert.rejects(loadExpectedBook(root));
    await unlink(copy);
    await chmod(file, 0o644);
    await assert.rejects(loadExpectedBook(root));
    await chmod(file, 0o600);
    await unlink(file); await symlink('missing', file);
    await assert.rejects(loadExpectedBook(root));
  } finally { await rm(root, { recursive: true }); }
});

async function checkAnonymousDisplayCases(t, names) {
  const profiles = '/home/user/snap/chromium/common/ktz-playwright-inspect-test-088aa0b7';
  const outputs = '/tmp/opencode/ktz-playwright-inspect-20261101-088aa0b7';
  for (const base of [profiles, outputs]) {
    await mkdir(base, { recursive: true, mode: 0o700 });
    const info = await lstat(base);
    assert.ok(info.isDirectory() && !info.isSymbolicLink() && info.uid === process.geteuid() && (info.mode & 0o7777) === 0o700);
    assert.equal(await realpath(base), base);
  }
  const fixture = fileURLToPath(new URL('./support/playwright-resume-fixture.mjs', import.meta.url));
  let safe = true, completed = 0;
  for (const name of names) {
    if (!safe) break;
    safe = false;
    await t.test(name, async () => {
      const root = await mkdtemp(path.join(profiles, 'run-'));
      const outdir = await mkdtemp(path.join(outputs, 'run-'));
      assert.ok(root.startsWith(`${profiles}/run-`) && outdir.startsWith(`${outputs}/run-`));
      const output = path.join(outdir, 'result.json');
      const run = spawnSync(process.execPath, [fixture], { cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8', timeout: 65000,
        env: { ...process.env, NODE_OPTIONS: '', DEBUG: '', PWDEBUG: '', KTZ_PW_RESUME_ROOT: root, KTZ_PW_RESUME_OUTPUT: output, KTZ_PW_RESUME_CASE: name } });
      assert.equal(run.error, undefined); assert.doesNotMatch(run.stdout + run.stderr, /ANONYMOUS_PRIVATE_BODY|ANONYMOUS_PASSWORD|anonymous-foreign-lock|pw:protocol/);
      const value = JSON.parse(await readFile(output, 'utf8'));
      assert.equal(run.status, 0, JSON.stringify({ name, phase: value.failurePhase }));
      assert.equal(value.status, 'ok'); assert.equal(value.inputEvents, 0, JSON.stringify(value.inputDetails)); assert.equal(value.forbidden, false);
      if (!['multiple', 'locked', 'expected-missing-config'].includes(name)) assert.equal(value.restored, true);
      if (name.startsWith('expected-')) {
        assert.equal(value.unscopedOldValueObservers, 0, '旧文字列の収集は固定titleのsubtreeだけ');
        const succeeds = ['expected-match', 'expected-redraw', 'expected-placeholder', 'expected-hidden', 'expected-clipped', 'expected-offscreen',
          'expected-nested-redraw', 'expected-library-reader', 'expected-library-reader-slash', 'expected-library-query', 'expected-library-query-slash', 'expected-manga-slash'].includes(name);
        assert.equal(value.actualExit, succeeds ? 0 : 1);
        assert.equal(value.result.metadataCount, succeeds ? 1 : 0);
        assert.equal(value.routeRequests, name === 'expected-placeholder' ? 1 : 0, '期待ASINへの限定復帰以外はしない');
        assert.equal(value.invalidRouteRequest, false);
        assert.equal(value.navigationAttempts, name === 'expected-placeholder' ? 1 : 0);
        assert.equal(value.preparationAttempts, 0);
        if (succeeds) {
          assert.equal(value.result.binding, 'expected-book-required');
          assert.deepEqual(value.result.observation, { title: expectedBook.title, asin: expectedBook.asin,
            position: { value: 42, min: 0, max: 100 }, region: { width: 640, height: 480, visibleWidth: 640, visibleHeight: 480 },
            markers: { identity: { count: 'one', visibility: name === 'expected-hidden' ? 'hidden' : 'visible' },
              position: { count: 'one', visibility: name === 'expected-clipped' ? 'clipped' : 'visible' },
              next: { count: 'one', visibility: name === 'expected-offscreen' ? 'clipped' : 'visible' } } });
          assert.equal(value.metadataReads, 1); assert.equal(value.metadataAttempts, 1);
          if (['expected-redraw', 'expected-nested-redraw'].includes(name)) assert.ok(value.resumeElapsedMs >= 1200);
        } else {
          assert.equal(value.metadataAttempts, ['expected-read-change', 'expected-read-character-change', 'expected-read-position-swap', 'expected-unknown'].includes(name) ? 1 : 0);
          assert.equal(value.metadataReads, ['expected-read-change', 'expected-read-character-change', 'expected-read-position-swap', 'expected-unknown'].includes(name) ? 1 : 0);
          if (name === 'expected-volume-mismatch') assert.equal(value.result.reason, 'book-mismatch');
          if (name === 'expected-title-mismatch') assert.equal(value.result.reason, 'title-mismatch');
          if (['expected-change', 'expected-read-change', 'expected-nested-change', 'expected-read-character-change', 'expected-added-character-change', 'expected-document-change', 'expected-route-change'].includes(name)) assert.equal(value.result.reason, 'target-changed');
          if (['expected-unshared', 'expected-read-position-swap'].includes(name)) assert.equal(value.result.reason, 'reader-region');
          if (name === 'expected-duplicate') assert.equal(value.result.reason, 'multiple-markers');
          if (['expected-surface', 'expected-surface-clipped'].includes(name)) assert.equal(value.result.reason, 'reader-surface');
          if (name === 'expected-auth') assert.equal(value.result.reason, 'blocking-ui');
          if (name === 'expected-missing-config') { assert.equal(value.result.reason, 'preflight-or-start'); assert.equal(value.result.shutdown, 'not-started'); }
          if (name === 'expected-conflicting-asin') assert.equal(value.result.reason, 'document-unavailable');
          if (name === 'expected-unknown') assert.equal(value.unknownLockAndOwnerAlive, true);
        }
      } else {
      if (['single', 'delayed', 'hidden-chrome'].includes(name)) {
        assert.equal(value.actualExit, 0); assert.equal(value.result.metadataCount, 1); assert.equal(value.result.binding, 'continuity-unverified');
        assert.deepEqual(value.result.observation, { title: '匿名の保存済み本', position: { value: 42, min: 0, max: 100 },
          region: { width: 640, height: 480, visibleWidth: 640, visibleHeight: 480 } });
        assert.equal(value.metadataReads, 1); assert.equal(value.metadataAttempts, 1);
        if (name === 'delayed') assert.ok(value.resumeElapsedMs >= 1200);
      } else {
        assert.equal(value.actualExit, 1); assert.equal(value.result.metadataCount, 0);
        assert.equal(value.metadataReads, name === 'unknown' ? 1 : 0);
        assert.equal(value.metadataAttempts, name === 'unknown' ? 1 : 0);
        if (name === 'multiple') assert.equal(value.result.reason, 'multiple-page-targets');
        if (name === 'marker-duplicate') assert.equal(value.result.reason, 'multiple-markers');
        if (name === 'auth' || name === 'nonkindle') assert.equal(value.result.reason, 'document-unavailable');
        if (name === 'hidden-auth') assert.equal(value.result.reason, 'blocking-ui');
        if (name === 'frame' || name === 'shadow') {
          assert.equal(value.result.reason, 'readiness-timeout'); assert.equal(value.result.detail, 'reader-identity-missing');
          assert.ok(value.resumeElapsedMs >= 9000 && value.resumeElapsedMs < 23000);
        }
        if (['document-change', 'node-change', 'same-document-book', 'delayed-book-change', 'delayed-node-change', 'hidden-change'].includes(name)) assert.equal(value.result.reason, 'target-changed');
        if (['hidden-blocked', 'hidden-unchanged'].includes(name)) {
          assert.equal(value.result.reason, 'readiness-timeout'); assert.equal(value.result.detail, 'reader-identity-hidden');
        }
        if (name === 'position-clipped') {
          assert.equal(value.result.reason, 'readiness-timeout'); assert.equal(value.result.detail, 'reader-position-clipped');
          assert.equal(value.preparationEvents, 0);
          assert.equal(value.result.diagnostics.clipping.length, 1);
          const c = value.result.diagnostics.clipping[0];
          assert.equal(c.field, 'position'); assert.equal(c.outsideClip, true);
          assert.ok(c.rect.right > c.clip.right && c.clip.right - c.clip.left === 8);
          assert.equal(c.overflowX, false); assert.equal(c.overflowY, false);
          assert.ok(c.viewport.width > c.rect.right && c.viewport.height > c.rect.bottom);
        }
        if (name === 'locked') { assert.equal(value.foreignLockPreserved, true); assert.equal(value.result.reason, 'ownership-in-use-or-unknown'); }
        if (name === 'unknown') assert.equal(value.unknownLockAndOwnerAlive, true);
      }
      if (name.startsWith('hidden-')) {
        assert.equal(value.preparationAttempts, name === 'hidden-auth' ? 0 : 1);
        assert.ok(value.preparationEvents <= 4);
        if (['hidden-blocked', 'hidden-auth'].includes(name)) assert.equal(value.preparationEvents, 0);
        if (name === 'hidden-blocked') assert.equal(value.result.preparation, 'refused');
        if (name === 'hidden-change') assert.equal(value.result.preparation, 'interrupted');
        if (['hidden-chrome', 'hidden-unchanged'].includes(name)) {
          assert.equal(value.result.preparation, 'dispatched'); assert.equal(value.preparationEvents, 4);
        }
        if (name !== 'hidden-auth') {
          const diagnostic = value.result.diagnostics.preparation;
          assert.equal(diagnostic.eventsSent, value.preparationEvents);
          assert.equal(diagnostic.reason, name === 'hidden-blocked' ? 'hit-blocked' : name === 'hidden-change' ? 'target-changed' : 'dispatched');
        }
      } else assert.equal(value.preparationAttempts, 0);
      }
      // Only this test's fresh anonymous tree is removed, after the fixture has
      // joined its browser/group (also after the delayed normal unknown close).
      await assert.rejects(lstat(path.join(root, 'home/snap/chromium/common/kindle-to-zip-login/owned/profile/SingletonLock')), { code: 'ENOENT' });
      await rm(root, { recursive: true });
      completed++; safe = true;
    });
  }
  assert.equal(completed, names.length);
}
if (process.platform === 'linux' && process.env.KTZ_DESKTOP_TESTS === '1') {
  test('Playwright表示確認: 匿名の実公開入口で復元・限定観測・変更停止・所有を検証', { timeout: 240_000 }, t =>
    checkAnonymousDisplayCases(t, ['single', 'delayed', 'multiple', 'marker-duplicate', 'frame', 'shadow', 'auth', 'nonkindle', 'document-change', 'node-change', 'same-document-book', 'delayed-book-change', 'delayed-node-change', 'locked', 'unknown']));
  test('Playwright表示確認: 表示バー準備は非破壊で一回だけ・不明時は拒否', { timeout: 120_000 }, t =>
    checkAnonymousDisplayCases(t, ['hidden-chrome', 'hidden-blocked', 'hidden-auth', 'hidden-change', 'hidden-unchanged', 'position-clipped']));
  test('Playwright表示確認: 期待巻の独立照合・限定復帰・再描画と本変更・終了保護', { timeout: 150_000 }, t =>
    checkAnonymousDisplayCases(t, ['expected-match', 'expected-volume-mismatch', 'expected-title-mismatch', 'expected-redraw',
      'expected-change', 'expected-read-change', 'expected-document-change', 'expected-placeholder', 'expected-hidden', 'expected-clipped',
      'expected-unshared', 'expected-conflicting-asin', 'expected-unknown', 'expected-auth', 'expected-duplicate', 'expected-surface',
       'expected-route-change', 'expected-read-position-swap', 'expected-offscreen', 'expected-surface-clipped', 'expected-missing-config']));
  test('Playwright表示確認: 期待巻の局所監視・同内容再描画・既知route整合', { timeout: 120_000 }, t =>
    checkAnonymousDisplayCases(t, ['expected-nested-redraw', 'expected-nested-change', 'expected-read-character-change', 'expected-added-character-change',
      'expected-library-reader', 'expected-library-reader-slash', 'expected-library-query', 'expected-library-query-slash', 'expected-manga-slash']));
}

test('Playwright表示確認: 期待本route追加後も既定probeは本棚を拒否', () => {
  for (const pathname of ['/kindle-library', '/kindle-library/', '/kindle-library/manga-wr/B000TEST04', '/kindle-library/manga-wr/B000TEST04/']) {
    const probe = runInNewContext(`(${inspectKindleDocument.toString()})`, {
      location: { origin: 'https://read.amazon.co.jp', pathname, search: '?asin=B000TEST04' },
      document: { visibilityState: 'visible', get readyState() { throw new Error('must_not_inspect_library'); } },
    });
    const value = probe({ expectedOrigin: 'https://read.amazon.co.jp' });
    assert.equal(value.state, 'unavailable'); assert.equal(value.reason, 'document-unavailable');
    assert.deepEqual(Object.keys(value).sort(), ['reason', 'state']);
  }
});
