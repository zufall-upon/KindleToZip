// 匿名試験プロセス専用。製品にはfixture用の引数・環境変数を追加しない。
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { ownedPipeTransport } from '../../app/linux-playwright-pipe.mjs';

const root = process.env.KTZ_NEW_LOGIN_FIXTURE;
const origin = process.env.KTZ_NEW_LOGIN_ORIGIN;
if (!root?.startsWith('/home/user/KTZ-New-Login-Tests/run-') || !/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) throw new Error('anonymous_fixture_required');
const record = value => writeFileSync(path.join(root, 'login-observation.json'), JSON.stringify(value), { mode: 0o600 });
let ready;
const confirmed = new Promise(resolve => { ready = resolve; });
const log = console.log;
console.log = (...args) => {
  if (String(args[0]).startsWith('Portable専用ログイン画面を開きました。')) ready();
  log(...args);
};
const spawn = childProcess.spawn;
childProcess.spawn = (exe, args, options) => {
  if (exe !== '/snap/bin/chromium') return spawn(exe, args, options);
  const profile = args.find(arg => arg.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length);
  if (!profile?.startsWith(`${root}/data/application/saved-`) || !profile.endsWith('/owned/profile')
      || args.at(-1) !== 'https://read.amazon.co.jp/') throw new Error('unexpected_login_target');
  const normalFlags = args.includes('--ozone-platform=wayland') && options.env.DISPLAY === ''
    && options.env.CHROMIUM_FLAGS === undefined
    && !args.some(arg => /--(?:no-sandbox|disable-setuid-sandbox|password-store|use-mock-keychain|remote-debugging)/.test(arg));
  if (!normalFlags) throw new Error('unsafe_login_arguments');
  // 実サイトへは接続しない。自分の新規profileだけに匿名pipeを追加する。
  const child = spawn(exe, [...args.slice(0, -1), '--disable-background-networking', '--remote-debugging-pipe', origin],
    { ...options, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  child.stdio[3].on('error', () => {}); child.stdio[4].on('error', () => {});
  void (async () => {
    let browser, transport;
    try {
      let timer;
      try { await Promise.race([confirmed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('login_not_confirmed')), 15000); })]); }
      finally { clearTimeout(timer); }
      const { chromium } = await import('playwright');
      transport = ownedPipeTransport(child);
      browser = await chromium.connectOverCDP(transport, { noDefaults: true, timeout: 10000 });
      const page = browser.contexts()[0].pages()[0];
      await page.waitForURL(`${origin}/`);
      const retained = await page.evaluate(() => localStorage.getItem('ktz-new-login-anonymous') === 'fixture-only');
      await page.evaluate(() => localStorage.setItem('ktz-new-login-anonymous', 'fixture-only'));
      const statusPage = await browser.contexts()[0].newPage();
      await statusPage.goto('chrome://sandbox/');
      const status = await statusPage.locator('body').innerText();
      const sandbox = /Seccomp-BPF sandbox\s+Yes/.test(status) && /PID namespaces\s+Yes/.test(status)
        && /Network namespaces\s+Yes/.test(status) && /You are adequately sandboxed/.test(status);
      if (!sandbox) throw new Error('sandbox_unconfirmed');
      record({ retained, sandbox, normalFlags, targetReplacedBeforeSpawn: true });
    } catch (error) { record({ failed: error.message }); process.exitCode = 1; }
    finally {
      if (browser?.isConnected()) {
        const session = await browser.newBrowserCDPSession(); await session.send('Browser.close').catch(() => {});
      } else if (child.stdio[3].writable) {
        child.stdio[3].write(JSON.stringify({ id: 1, method: 'Browser.close' }) + '\0'); child.stdio[4].resume();
      }
      transport?.close();
    }
  })().catch(() => { record({ failed: 'anonymous_close_unconfirmed' }); process.exitCode = 1; });
  return child;
};
syncBuiltinESMExports();
