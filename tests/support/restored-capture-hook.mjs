// Anonymous-only instrumentation. In particular, never inject a startup URL:
// the browser must restore what its previous normally-closed generation saved.
import os from 'node:os';
import childProcess from 'node:child_process';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { appendFileSync } from 'node:fs';
import path from 'node:path';

const home = process.env.KTZ_RESTORED_CAPTURE_HOME, origin = process.env.KTZ_RESTORED_CAPTURE_ORIGIN;
if (!/^\/home\/user\/snap\/chromium\/common\/kindle-to-zip-owned-sample\/restored-capture-fixtures-v1\/case-[A-Za-z0-9]+$/.test(home ?? '')
  || !/^http:\/\/127\.0\.0\.1:\d+$/.test(origin ?? '')) throw new Error('anonymous_only');
const trace = value => appendFileSync(path.join(home, 'events.ndjson'), JSON.stringify(value) + '\n', { mode: 0o600 });
const info = os.userInfo;
os.userInfo = (...args) => ({ ...info(...args), homedir: home });
registerHooks({ load(url, context, next) {
  const result = next(url, context);
  if (url.endsWith('/app/expected-capture-session.mjs')) return { ...result,
    source: result.source.toString().replace("const origin = 'https://read.amazon.co.jp';", `const origin = ${JSON.stringify(origin)};`) };
  if (url.endsWith('/app/stores/kindle.mjs')) return { ...result,
    source: result.source.toString().replace('https://read.amazon.co.jp/', `${origin}/`) };
  return result;
} });
const fork = childProcess.fork;
childProcess.fork = (file, args, options) => {
  if (!file.endsWith('/app/linux-expected-reader-owner.mjs') || args.length) throw new Error('unexpected_owner');
  return fork(file, args, { ...options, execArgv: [`--import=${import.meta.url}`] });
};
if (/\/app\/linux-expected-reader-owner\.mjs$/.test(process.argv[1] ?? '')) {
  const spawn = childProcess.spawn;
  childProcess.spawn = (executable, args, options) => {
    if (executable !== '/snap/bin/chromium'
      || !args.includes(`--user-data-dir=${home}/snap/chromium/common/kindle-to-zip-login/owned/profile`)
      || !args.includes('--restore-last-session') || !args.includes('--remote-debugging-pipe')
      || args.some(arg => /^(?:https?:|about:)/.test(arg) || /^--remote-debugging-port/.test(arg)
        || ['--no-sandbox', '--disable-setuid-sandbox', '--password-store=basic', '--use-mock-keychain'].includes(arg))) throw new Error('unsafe_restore_launch');
    trace({ event: 'launch', restore: true, addedUrl: false });
    const child = spawn(executable, [...args, '--disable-background-networking', '--disable-quic',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'], options);
    const write = child.stdio[3].write.bind(child.stdio[3]);
    let buffer = '';
    child.stdio[3].write = (data, ...rest) => {
      buffer += data.toString();
      let end;
      while ((end = buffer.indexOf('\0')) >= 0) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          const message = JSON.parse(frame);
          if (message.method === 'Page.captureScreenshot') trace({ event: 'screenshot' });
          if (message.method === 'Browser.close') trace({ event: 'close' });
           if (message.method === 'Page.navigate' || message.method === 'Target.createTarget') trace({ event: 'unexpected_navigation' });
           if (message.method === 'Page.reload' || message.method.startsWith('Input.')) trace({ event: 'unexpected_input' });
        } catch { trace({ event: 'malformed_protocol' }); }
      }
      return write(data, ...rest);
    };
    return child;
  };
}
syncBuiltinESMExports();

// Replacing a bound document is a rejection test, not restoration assistance.
if (/\/app\/linux-expected-capture\.mjs$/.test(process.argv[1] ?? '') && process.env.KTZ_RESTORED_CAPTURE_MODE === 'document') {
  const { Application } = await import('../../app/application.mjs');
  const command = Application.prototype.command;
  Application.prototype.command = async function (action, input) {
    if (action === 'approve') {
      const requireBound = this.reader.requireBound.bind(this.reader);
      let exchanged = false;
      this.reader.requireBound = async (...args) => {
        // Change after approval's initial precondition, at its actual identity
        // boundary. Normal navigation invalidation is never disabled or reset.
        if (!exchanged) { exchanged = true; await this.reader.page.reload({ waitUntil: 'domcontentloaded' }); }
        return requireBound(...args);
      };
    }
    return command.call(this, action, input);
  };
}
