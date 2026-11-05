// Test-only synthetic public-entry transport. No browser, profile, network or
// authentication data is used. Any unexpected executable is rejected.
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import childProcess from 'node:child_process';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { Writable, PassThrough } from 'node:stream';
import { runInNewContext } from 'node:vm';

const mode = process.env.KTZ_INSPECT_PROTOCOL_CASE;
const modes = new Set(['ok', 'cancel', 'dialog-unavailable', 'browser-ended', 'unknown-preflight',
  'confirmation-exit-error', 'confirmation-display-error', 'confirmation-signal',
  'notification-exit-error', 'notification-display-error', 'notification-signal',
  'notification-dismissed', 'notification-browser-ended', 'marker-and-notification-display-error',
  'no-targets', 'multiple-targets', 'invalid-targets', 'attach-error', 'world-invalid',
  'missing-marker', 'blocking-ui', 'wrong-origin', 'metadata-exception', 'metadata-missing', 'unknown-reason',
  'pipe-closed', 'pipe-error', 'malformed', 'null-response', 'oversized', 'timeout',
  'document-changed', 'target-changed', 'detach-error', 'marker-and-detach-error',
  'notification-unavailable', 'marker-and-notification-error', 'close-unconfirmed']);
if (!modes.has(mode)) throw new Error('anonymous_protocol_fixture_required');
const trace = { commands: [], dialogs: [], dialogKills: 0, titleReads: 0, childClosed: false };
process.once('exit', () => process.stdout.write(JSON.stringify({ fixture: trace }) + '\n'));
const loginModule = new URL('../../app/linux-login-core.mjs', import.meta.url).href;
registerHooks({
  load(url, context, next) {
    if (url !== loginModule) return next(url, context);
    return { format: 'module', shortCircuit: true,
      source: `export const linuxLoginRoot = home => home + '/snap/chromium/common/kindle-to-zip-login'; export { syntheticLogin as runLinuxLogin, syntheticPreflight as snapLoginPreflight } from ${JSON.stringify(import.meta.url)};` };
  },
});
os.userInfo = () => ({ homedir: '/tmp/opencode/ktz-inspect-tests/synthetic-home' });
const secret = 'FIXTURE_PRIVATE_BODY_ACCOUNT_PASSWORD_URL_TOKEN';
export async function syntheticPreflight() {
  if (mode === 'unknown-preflight') throw Object.assign(new Error(secret), { code: secret });
}
let browser, endBrowser;
export async function syntheticLogin(options) {
  if (!options.requireExistingProfile || !options.requireAbsentSingleton || !options.joinUnconfirmedStart
      || JSON.stringify(options.requiredArgs) !== '["--remote-debugging-pipe"]') throw new Error('ownership_options_changed');
  await options.preflight();
  browser = options.launch('/snap/bin/chromium', [`--user-data-dir=${options.root}/owned/profile`, '--no-first-run', '--no-default-browser-check', options.url]);
  const ended = new Promise(resolve => {
    endBrowser = () => {
      if (trace.childClosed) return;
      trace.childClosed = true; browser.emit('close', 0, null); resolve({ code: 0, signal: null });
    };
  });
  await options.onStarted({ child: browser, ended, assertStillOwned: async () => {
    if (trace.childClosed) throw Object.assign(new Error(secret), { code: 'login_close_unconfirmed' });
  } });
  await ended;
  if (mode === 'close-unconfirmed') throw Object.assign(new Error(secret), { code: 'login_close_unconfirmed' });
}

function metadataContext() {
  const rect = (width = 100, height = 20) => ({ left: 0, top: 0, right: width, bottom: height, width, height });
  const element = (tagName, parentElement = null, bounds = rect()) => ({
    tagName, parentElement, isConnected: true, getBoundingClientRect: () => bounds,
  });
  const region = element('DIV', null, rect(640, 480));
  let parent = region;
  for (let index = 0; index < 4; index++) parent = element('DIV', parent);
  const title = element('SPAN', parent);
  Object.defineProperty(title, 'innerText', { get() {
    trace.titleReads++;
    if (mode === 'metadata-exception') throw new Error(secret);
    return '架空の本';
  } });
  const position = Object.assign(element('INPUT', region), { value: '42', min: '0', max: '100' });
  const next = Object.assign(element('BUTTON', region), { getAttribute: () => '次のページ' });
  const surface = element('CANVAS', region, rect(600, 300));
  region.contains = item => [position, next].includes(item);
  region.querySelectorAll = selector => {
    if (selector !== 'canvas, img, iframe') throw new Error(secret);
    return [surface];
  };
  const document = { visibilityState: 'visible', querySelectorAll(selector) {
    if (selector === '#readerChromeTitle') return ['missing-marker', 'marker-and-detach-error', 'marker-and-notification-error', 'marker-and-notification-display-error'].includes(mode) ? [] : [title];
    if (selector === 'input[type="range"]') return [position];
    if (selector === 'button[aria-label*="次"], button[aria-label*="next" i]') return [next];
    if (selector === 'input[type="password"], #ap_email, #authportal-main-section, [aria-modal="true"], dialog[open], [role="dialog"]') return mode === 'blocking-ui' ? [element('DIALOG')] : [];
    throw new Error(secret);
  } };
  Object.defineProperty(document, 'body', { get() { throw new Error(secret); } });
  const location = { origin: mode === 'wrong-origin' ? 'https://example.invalid' : 'https://read.amazon.co.jp', pathname: '/reader' };
  for (const key of ['href', 'search', 'hash', 'username', 'password']) Object.defineProperty(location, key, { get() { throw new Error(secret); } });
  return { document, location, innerWidth: 1000, innerHeight: 800,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1', overflowX: 'visible', overflowY: 'visible' }) };
}

childProcess.spawn = (executable, args, options) => {
  if (executable === '/usr/bin/zenity') {
    if (JSON.stringify(options.stdio) !== '["ignore","ignore","pipe"]') throw new Error('dialog_stdio_changed');
    const kind = args[0] === '--question' ? 'confirmation' : args[0] === '--info' ? 'notification' : null;
    if (!kind) throw new Error('unexpected_dialog');
    trace.dialogs.push(kind);
    const dialog = new EventEmitter();
    dialog.stderr = new PassThrough();
    let closed = false;
    const close = (code, signal = null) => {
      if (closed) return;
      closed = true; dialog.stderr.end(); dialog.emit('close', code, signal);
      if (kind === 'notification') setImmediate(endBrowser);
    };
    dialog.kill = signal => { trace.dialogKills++; setImmediate(() => close(null, signal)); return true; };
    setImmediate(() => {
      if (kind === 'confirmation' && mode === 'browser-ended') { endBrowser(); return; }
      if (kind === 'notification' && mode === 'notification-browser-ended') { endBrowser(); return; }
      if (mode === `${kind}-exit-error`) { close(255); return; }
      if (mode === `${kind}-display-error` || (kind === 'notification' && mode === 'marker-and-notification-display-error')) {
        dialog.stderr.write(secret); close(1); return;
      }
      if (mode === `${kind}-signal`) { close(null, 'SIGTERM'); return; }
      if (kind === 'notification' && mode === 'notification-dismissed') { close(1); return; }
      const unavailable = kind === 'confirmation' ? mode === 'dialog-unavailable'
        : ['notification-unavailable', 'marker-and-notification-error'].includes(mode);
      if (unavailable) { dialog.emit('error', new Error(secret)); close(-2); }
      else close(kind === 'confirmation' && mode === 'cancel' ? 1 : 0);
    });
    return dialog;
  }
  if (executable !== '/snap/bin/chromium' || !args.includes('--remote-debugging-pipe')
      || options.stdio.join(',') !== 'ignore,ignore,ignore,pipe,pipe') throw new Error('unexpected_executable');
  const child = new EventEmitter(), output = new PassThrough();
  let targets = 0;
  const input = new Writable({ write(data, encoding, done) {
    const command = JSON.parse(data.toString().replace(/\0$/, ''));
    const { id, method, params } = command;
    const allowed = ['Target.getTargets', 'Target.attachToTarget', 'Page.createIsolatedWorld', 'Runtime.evaluate', 'Target.detachFromTarget'];
    if (!allowed.includes(method)) throw new Error('unexpected_command');
    trace.commands.push(method);
    setImmediate(() => {
      const reply = result => output.write(JSON.stringify({ id, result }) + '\0');
      const protocolError = () => output.write(JSON.stringify({ id, error: { message: secret, data: secret } }) + '\0');
      if (method === 'Target.getTargets') {
        if (++targets === 1) {
          if (mode === 'pipe-closed') { output.end(); return; }
          if (mode === 'pipe-error') { output.emit('error', new Error(secret)); return; }
          if (mode === 'malformed') { output.write(`${secret}\0`); return; }
          if (mode === 'null-response') { output.write('null\0'); return; }
          if (mode === 'oversized') { output.write('x'.repeat(262145)); return; }
          if (mode === 'timeout') return;
        }
        if (mode === 'invalid-targets') { reply({}); return; }
        const page = targetId => ({ type: 'page', targetId, title: secret, url: `https://example.invalid/?${secret}` });
        reply({ targetInfos: mode === 'no-targets' ? [] : mode === 'multiple-targets' ? [page('one'), page('two')]
          : [page(mode === 'target-changed' && targets > 1 ? 'other' : 'one')] });
      } else if (method === 'Target.attachToTarget') {
        if (mode === 'attach-error') protocolError(); else reply({ sessionId: 'synthetic-session' });
      } else if (method === 'Page.createIsolatedWorld') reply({ executionContextId: mode === 'world-invalid' ? null : 1 });
      else if (method === 'Target.detachFromTarget') {
        if (['detach-error', 'marker-and-detach-error'].includes(mode)) protocolError(); else reply({});
      } else if (params.expression === 'true') {
        if (mode === 'document-changed') reply({ exceptionDetails: { text: secret } }); else reply({ result: { value: true } });
      } else if (mode === 'metadata-missing') reply({ result: {} });
      else if (mode === 'unknown-reason') reply({ result: { value: { state: 'unavailable', reason: secret } } });
      else {
        try { reply({ result: { value: runInNewContext(params.expression, metadataContext(), { timeout: 1000 }) } }); }
        catch { reply({ exceptionDetails: { text: secret } }); }
      }
    });
    done();
  } });
  child.stdio = [null, null, null, input, output];
  child.kill = () => { throw new Error('browser_must_not_be_signalled'); };
  return child;
};
syncBuiltinESMExports();
