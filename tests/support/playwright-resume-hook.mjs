// Anonymous-only interception of the exact production public entry/owner.
import os from 'node:os';
import childProcess from 'node:child_process';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { appendFileSync, readFileSync } from 'node:fs';

const home = process.env.KTZ_PW_RESUME_HOME, origin = process.env.KTZ_PW_RESUME_ORIGIN;
const trace = process.env.KTZ_PW_RESUME_TRACE, scenario = process.env.KTZ_PW_RESUME_CASE;
if (!home?.startsWith('/home/user/snap/chromium/common/ktz-playwright-inspect-test-088aa0b7/run-')
    || !origin?.startsWith('http://127.0.0.1:') || !trace?.startsWith('/tmp/opencode/ktz-playwright-inspect-20261101-088aa0b7/run-'))
  throw new Error('anonymous_only');
const record = value => appendFileSync(trace, JSON.stringify(value) + '\n', { mode: 0o600 });
const info = os.userInfo();
os.userInfo = () => ({ ...info, homedir: home });
const isExpected = scenario.startsWith('expected-');
const ownerName = isExpected ? 'linux-playwright-expected-owner.mjs' : 'linux-playwright-resume-owner.mjs';
const ownerModule = new URL(`../../app/${ownerName}`, import.meta.url).href;
registerHooks({ load(url, context, next) {
  const result = next(url, context);
  if (url !== ownerModule) return result;
  const source = result.source.toString();
  if (source.split("'https://read.amazon.co.jp/'").length !== 2) throw new Error('fixed_origin_changed');
  return { ...result, source: source.replace("'https://read.amazon.co.jp/'", JSON.stringify(origin)) };
} });
const fork = childProcess.fork;
childProcess.fork = (file, args, options) => {
  if (!file.endsWith(`/app/${ownerName}`) || args.length) throw new Error('fixed_owner_changed');
  return fork(file, args, { ...options, execArgv: [`--import=${import.meta.url}`] });
};
const spawn = childProcess.spawn;
childProcess.spawn = (executable, args, options) => {
  if (executable !== '/snap/bin/chromium' || !args.includes(`--user-data-dir=${home}/snap/chromium/common/kindle-to-zip-login/owned/profile`)
      || !args.includes('--restore-last-session') || !args.includes('--remote-debugging-pipe')
      || args.some(arg => /^--remote-debugging-port/.test(arg) || /^(?:https?:|about:)/.test(arg)
        || ['--no-sandbox', '--disable-setuid-sandbox', '--password-store=basic', '--use-mock-keychain'].includes(arg))) throw new Error('unsafe_launch');
  record({ launched: true, restore: true, addedUrl: false });
  const child = spawn(executable, args, options), write = child.stdio[3].write.bind(child.stdio[3]);
  let checkedFlags = false;
  child.stdio[3].write = (data, ...rest) => {
    try {
      const message = JSON.parse(data.toString().replace(/\0$/, ''));
      const method = message.method;
      const forbidden = /^(?:Network\.(?:getCookies|getAllCookies|getResponseBody)|Storage\.getCookies|Page\.(?:captureScreenshot|startScreencast|navigate)|Input\.|Target\.(?:createTarget|closeTarget)|Emulation\.setDeviceMetricsOverride|Emulation\.setFocusEmulationEnabled|Browser\.setDownloadBehavior)/.test(method);
      if (forbidden) record({ forbidden: true });
      if (['Runtime.evaluate', 'Runtime.callFunctionOn'].includes(method)) {
        // Playwright may nest its serialized function in protocol arguments.
        if (JSON.stringify(message).includes('value.read()')) record({ metadataAttempt: true });
        if (JSON.stringify(message).includes('value.prepareChrome()')) record({ preparationAttempt: true });
        if (JSON.stringify(message).includes('location.assign(')) record({ navigationAttempt: true });
      }
      if (!checkedFlags && method !== 'Browser.close') {
        try {
          const flags = readFileSync(`/proc/${child.pid}/cmdline`).toString();
          if (flags.includes('--remote-debugging-pipe')) {
            checkedFlags = true;
            record({ actualFlagsSafe: !/--no-sandbox|--disable-setuid-sandbox|--password-store=basic|--use-mock-keychain|--remote-debugging-port/.test(flags)
              && flags.includes(`--user-data-dir=${home}/snap/chromium/common/kindle-to-zip-login/owned/profile`) });
          }
        } catch { /* Snap may not have exec'd yet */ }
      }
      if (method === 'Browser.close') {
        record({ closeRequested: true });
        if (scenario === 'unknown' || scenario === 'expected-unknown') { setTimeout(() => write(data, ...rest), 4200); return true; }
      }
    } catch { record({ malformed: true }); }
    return write(data, ...rest);
  };
  return child;
};
syncBuiltinESMExports();
