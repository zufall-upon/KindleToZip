// Anonymous public-entry hook, inherited explicitly by the private owner. Any
// attempted real-profile launch fails before spawn, even if the home seam fails.
import os from 'node:os';
import childProcess from 'node:child_process';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { appendFileSync } from 'node:fs';

const home = process.env.KTZ_RESUME_TEST_HOME, origin = process.env.KTZ_RESUME_TEST_ORIGIN;
const trace = process.env.KTZ_RESUME_TEST_TRACE, recipe = process.env.KTZ_RESUME_TEST_RECIPE;
if (!home?.startsWith('/home/user/snap/chromium/common/ktz-resume-probe-20261101-8f13e1b6/run-')
    || !origin?.startsWith('http://127.0.0.1:')
    || !trace?.startsWith('/tmp/opencode/ktz-resume-probe-20261101-8f13e1b6/run-')
    || !['settings', 'last-session', 'actual'].includes(recipe)) throw new Error('anonymous_resume_required');
const record = value => appendFileSync(trace, JSON.stringify(value) + '\n', { mode: 0o600 });
const info = os.userInfo();
os.userInfo = () => ({ ...info, homedir: home });
const ownerModule = new URL('../../app/linux-inspect-resume-owner.mjs', import.meta.url).href;
registerHooks({ load(url, context, next) {
  const result = next(url, context);
  if (url !== ownerModule) return result;
  let source = result.source.toString();
  if (source.split("'https://read.amazon.co.jp/'").length !== 2) throw new Error('fixed_origin_changed');
  source = source.replace("'https://read.amazon.co.jp/'", JSON.stringify(origin));
  if (recipe !== 'actual') {
    if (!/const resumeSession = '(?:settings|last-session)';/.test(source)) throw new Error('fixed_recipe_changed');
    source = source.replace(/const resumeSession = '(?:settings|last-session)';/, `const resumeSession = '${recipe}';`);
  }
  return { ...result, source };
} });
const parse = JSON.parse;
JSON.parse = (value, ...args) => {
  if (typeof value === 'string' && value.includes('RESUME_FIXTURE_SENTINEL') && /"targetInfos?"/.test(value)) record({ unsafeTargetParse: true });
  return parse(value, ...args);
};
const fork = childProcess.fork;
childProcess.fork = (file, args, options) => {
  if (!file.endsWith('/app/linux-inspect-resume-owner.mjs') || args.length) throw new Error('fixed_owner_changed');
  return fork(file, args, { ...options, execArgv: [`--import=${import.meta.url}`] });
};
const spawn = childProcess.spawn;
childProcess.spawn = (executable, args, options) => {
  if (executable !== '/snap/bin/chromium') throw new Error('unexpected_executable');
  if (!args.includes(`--user-data-dir=${home}/snap/chromium/common/kindle-to-zip-login/owned/profile`)
      || !args.includes('--remote-debugging-pipe') || args.some(arg => /^--remote-debugging-port/.test(arg)
        || ['--no-sandbox', '--disable-setuid-sandbox', '--password-store=basic', '--use-mock-keychain'].includes(arg))) throw new Error('unsafe_anonymous_launch');
  record({ launch: { restoreFlag: args.includes('--restore-last-session'), addedUrl: args.some(arg => /^(?:https?:|about:)/.test(arg)) } });
  const child = spawn(executable, args, options), write = child.stdio[3].write.bind(child.stdio[3]);
  // Test-only aggregate monitor; synthetic URLs/titles are never recorded.
  let frames = Buffer.alloc(0);
  child.stdio[4].on('data', chunk => {
    frames = Buffer.concat([frames, chunk]);
    if (frames.length > 262144) { frames = Buffer.alloc(0); record({ malformedCommand: true }); return; }
    let end;
    while ((end = frames.indexOf(0)) !== -1) {
      try {
        const message = parse(frames.subarray(0, end).toString());
        if (Array.isArray(message.result?.targetInfos)) record({ pageCount: message.result.targetInfos.filter(item => item.type === 'page').length });
      } catch { record({ malformedCommand: true }); }
      frames = Buffer.from(frames.subarray(end + 1));
    }
  });
  child.stdio[3].write = (data, ...rest) => {
    try {
      const message = parse(data.toString().replace(/\0$/, ''));
      const allowed = ['Target.getTargets', 'Target.attachToTarget', 'Page.createIsolatedWorld', 'Runtime.evaluate', 'Target.detachFromTarget', 'Browser.close'];
      record({ command: allowed.includes(message.method) ? message.method : 'unexpected',
        ...(message.method === 'Runtime.evaluate' ? { mode: message.params.expression === 'true' ? 'context'
          : message.params.expression.includes('"metadata":false') ? 'diagnostic' : 'unexpected' } : {}) });
    } catch { record({ malformedCommand: true }); }
    return write(data, ...rest);
  };
  return child;
};
syncBuiltinESMExports();
