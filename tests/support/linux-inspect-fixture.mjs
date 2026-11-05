// Anonymous test-process preload only. The real public entry is loaded with a
// private synthetic home and its one hard-coded origin replaced with the local
// fixture. Nothing here is imported by the application in normal execution.
import os from 'node:os';
import childProcess from 'node:child_process';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const fixtureHome = process.env.KTZ_INSPECT_TEST_HOME;
const fixtureUrl = process.env.KTZ_INSPECT_TEST_URL;
const trace = process.env.KTZ_INSPECT_TEST_TRACE;
const lifecycle = process.env.KTZ_INSPECT_TEST_LIFECYCLE;
if (!fixtureHome?.includes('/kindle-to-zip-inspect-tests/') || !fixtureUrl?.startsWith('http://127.0.0.1:') || !trace?.includes('/ktz-inspect-tests/')) {
  throw new Error('anonymous_fixture_required');
}
if (lifecycle && !['library-popup', 'opener-closed', 'two-readers', 'single-worker'].includes(lifecycle)) throw new Error('anonymous_lifecycle_required');
const entry = pathToFileURL(path.resolve('app/linux-inspect.mjs')).href;
registerHooks({
  load(url, context, next) {
    const result = next(url, context);
    if (url !== entry) return result;
    const source = result.source.toString();
    const fixed = "'https://read.amazon.co.jp/'";
    if (source.split(fixed).length !== 2) throw new Error('fixed_entry_changed');
    return { ...result, source: source.replace(fixed, JSON.stringify(fixtureUrl)) };
  },
});
const realInfo = os.userInfo();
os.userInfo = () => ({ ...realInfo, homedir: fixtureHome });
const record = value => appendFileSync(trace, JSON.stringify(value) + '\n', { mode: 0o600 });
const nativeParse = JSON.parse;
JSON.parse = (value, ...args) => {
  if (typeof value === 'string' && /"targetInfos?"/.test(value) && /FIXTURE_TARGET_(?:TITLE|QUERY)/.test(value)) {
    record({ unsafeTargetJsonParse: true });
  }
  return nativeParse(value, ...args);
};
const originalSpawn = childProcess.spawn;
let closeFixtureBrowser;
let prepareLifecycle;
let fixtureChildClosed = false;
childProcess.spawn = (...args) => {
  if (args[0] === '/usr/bin/zenity') {
    if (args[1]?.[0] === '--info') {
      const messages = ['一回の表示確認を終えました。専用ブラウザを通常終了してください。終了確認後に結果を表示します。',
        '表示確認を中止しました。専用ブラウザを通常終了してください。'];
      if (args[1].length !== 4 || args[1][1] !== '--title=KindleToZip 表示状態の確認'
          || !messages.some(message => args[1][2] === `--text=${message}`) || args[1][3] !== '--ok-label=閉じる'
          || JSON.stringify(args[2]?.stdio) !== '["ignore","ignore","pipe"]') throw new Error('fixed_notification_dialog_changed');
      const dialog = originalSpawn(process.execPath, ['-e', 'process.exit(0)'],
        { env: { ...process.env, NODE_OPTIONS: '' }, stdio: args[2].stdio });
      record({ notificationDialogOpened: true });
      dialog.once('close', (code, signal) => record({ notificationDialogClosed: { code, signal } }));
      return dialog;
    }
    const expected = ['--question', '--title=KindleToZip 表示状態の確認',
      '--text=専用ブラウザで対象の本を一冊開いてから、表示状態だけを確認してください。取得・保存・ページ送りは行いません。',
      '--ok-label=表示状態だけを確認', '--cancel-label=確認せず終了'];
    if (JSON.stringify(args[1]) !== JSON.stringify(expected) || JSON.stringify(args[2]?.stdio) !== '["ignore","ignore","pipe"]') throw new Error('fixed_confirmation_dialog_changed');
    // Test-only stand-in for the person's dialog click. The real application
    // does not consume stdin and invokes only the fixed system dialog above.
    const dialog = originalSpawn(process.execPath, ['-e', 'let done=false;process.stdin.once("data",()=>{done=true;process.exit(0)});process.stdin.once("end",()=>{if(!done)process.exit(1)});'],
      { env: { ...process.env, NODE_OPTIONS: '' }, stdio: ['pipe', 'ignore', 'pipe'] });
    if (lifecycle) {
      // The first signal prepares a known anonymous transition. The second is
      // the person's confirmation stand-in; no product CDP is sent before it.
      process.stdin.once('data', () => {
        prepareLifecycle().then(() => {
          process.stdin.once('data', () => dialog.stdin.end('\n'));
          record({ testOnly: 'lifecycle-ready' });
        }, () => { record({ testOnly: 'lifecycle-setup-failed' }); closeFixtureBrowser?.(); });
      });
    } else if (process.env.KTZ_INSPECT_TEST_CLOSE_DURING_CONFIRM === '1') {
      // After the harness has seen the anonymous document load, simulate the
      // person's normal browser close instead of acknowledging the dialog.
      process.stdin.once('data', () => closeFixtureBrowser?.());
    } else process.stdin.pipe(dialog.stdin);
    dialog.stdin.on('error', () => {});
    dialog.once('close', (code, signal) => { process.stdin.unpipe(dialog.stdin); record({ confirmationDialogClosed: { code, signal } }); });
    record({ confirmationDialogOpened: true });
    return dialog;
  }
  const child = originalSpawn(...args);
  if (args[0] !== '/snap/bin/chromium') return child;
  const write = child.stdio[3].write.bind(child.stdio[3]);
  let lifecycleSerial = 900000;
  const lifecyclePending = new Map();
  const lifecycleRequest = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++lifecycleSerial;
    const timer = setTimeout(() => { lifecyclePending.delete(id); reject(new Error('fixture_request_timeout')); }, 3000);
    lifecyclePending.set(id, { resolve, reject, timer, method });
    // These test-only commands are outside the application's command trace.
    write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
  });
  prepareLifecycle = async () => {
    let initial;
    const snapshot = async stage => {
      const { targetInfos } = await lifecycleRequest('Target.getTargets');
      if (!Array.isArray(targetInfos)) throw new Error('fixture_targets_missing');
      const knownTypes = new Set(['page', 'service_worker', 'shared_worker', 'worker', 'background_page', 'iframe', 'browser', 'tab']);
      const types = {};
      for (const item of targetInfos) {
        const type = knownTypes.has(item.type) ? item.type : 'other';
        types[type] = (types[type] ?? 0) + 1;
      }
      const pages = targetInfos.filter(item => item.type === 'page');
      record({ lifecycle: { stage, types, ...(initial ? { initialPresent: pages.some(page => page.targetId === initial) } : {}) } });
      return pages;
    };
    const pages = await snapshot('startup');
    if (pages.length !== 1) throw new Error('fixture_initial_target_not_unique');
    initial = pages[0].targetId;
    if (lifecycle === 'single-worker') return;
    const { sessionId } = await lifecycleRequest('Target.attachToTarget', { targetId: initial, flatten: true });
    try {
      const world = await lifecycleRequest('Page.createIsolatedWorld', { frameId: initial, worldName: 'anonymous lifecycle setup' }, sessionId);
      const response = await lifecycleRequest('Runtime.evaluate', {
        expression: 'document.getElementById("fixture-open").click(); true',
        contextId: world.executionContextId, userGesture: true, returnByValue: true,
      }, sessionId);
      if (response.exceptionDetails || response.result?.value !== true) throw new Error('fixture_open_failed');
    } finally { await lifecycleRequest('Target.detachFromTarget', { sessionId }); }
    const opened = await snapshot('opened');
    if (opened.length !== 2 || !opened.some(page => page.targetId === initial)) throw new Error('fixture_open_count_unexpected');
    if (lifecycle === 'opener-closed') {
      const closed = await lifecycleRequest('Target.closeTarget', { targetId: initial });
      if (closed.success !== true) throw new Error('fixture_close_unconfirmed');
      const remaining = await snapshot('opener-closed');
      if (remaining.length !== 1 || remaining[0].targetId === initial) throw new Error('fixture_close_count_unexpected');
    }
  };
  child.stdio[3].write = (data, ...rest) => {
    try {
      const command = nativeParse(data.toString().replace(/\0$/, ''));
      record({ command: command.method, ...(command.method === 'Runtime.evaluate' ? { evaluation: command.params.expression === 'true' ? 'context-only' : 'metadata' } : {}) });
    } catch { record({ malformed: true }); }
    return write(data, ...rest);
  };
  // Only the count of top-level pages is recorded: no title, URL or response.
  let buffer = '';
  child.stdio[4].on('data', chunk => {
    buffer += chunk.toString(); let end;
    while ((end = buffer.indexOf('\0')) !== -1) {
      try {
        const reply = nativeParse(buffer.slice(0, end));
        const pending = lifecyclePending.get(reply.id);
        if (pending) {
          lifecyclePending.delete(reply.id); clearTimeout(pending.timer);
          if (reply.error || !reply.result) pending.reject(new Error('fixture_protocol_unavailable'));
          else pending.resolve(pending.method === 'Target.getTargets'
            ? { targetInfos: reply.result.targetInfos?.map(item => ({ type: item.type, targetId: item.targetId })) }
            : reply.result);
        }
        if (!pending && Array.isArray(reply.result?.targetInfos)) {
          record({ pageCount: reply.result.targetInfos.filter(target => target.type === 'page').length });
          if (reply.result.targetInfos.some(target => /FIXTURE_TARGET_(?:TITLE|QUERY)/.test(target.title) || /FIXTURE_TARGET_(?:TITLE|QUERY)/.test(target.url))) {
            record({ testOnly: 'target-sentinel-present' });
          }
        }
        if (reply.id === 999998 && reply.result?.targetId) record({ testOnly: 'extra-page-ready' });
      } catch { record({ malformed: true }); }
      buffer = buffer.slice(end + 1);
    }
  });
  // Simulates the person's normal window close, after the actual entry has
  // completed its one observation. This test-only command bypasses the trace
  // of application commands and is never available to the product entry.
  closeFixtureBrowser = () => {
    record({ testOnly: 'graceful-browser-close' });
    write(JSON.stringify({ id: 999999, method: 'Browser.close' }) + '\0', () => {});
  };
  if (process.env.KTZ_INSPECT_TEST_EXTRA_PAGE === '1') {
    // Test-only stand-in for a person opening a second tab. It is sent before
    // confirmation, is not an application command, and returns only its status.
    setTimeout(() => write(JSON.stringify({ id: 999998, method: 'Target.createTarget', params: { url: 'about:blank' } }) + '\0', () => {}), 250);
  }
  const fallback = setTimeout(() => closeFixtureBrowser?.(), 20_000);
  child.once('close', (code, signal) => { fixtureChildClosed = true; clearTimeout(fallback); record({ childClose: { code, signal } }); });
  return child;
};
syncBuiltinESMExports();
const stdoutWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...args) => {
  const result = stdoutWrite(chunk, ...args);
  if (String(chunk).startsWith('{"種別"')) record({ resultAfterChildClose: fixtureChildClosed });
  if (/^(?:一回の表示確認を終えました|表示確認を中止しました)/.test(String(chunk))) {
    setTimeout(() => closeFixtureBrowser?.(), 50);
  }
  return result;
};
