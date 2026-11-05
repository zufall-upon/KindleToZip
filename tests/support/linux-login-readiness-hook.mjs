// Test-process preload only. The delivered entry has no fixture env/CLI seam.
// Never attach to the real login profile: substitute a newly owned anonymous home.
import os from 'node:os';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { ownedPipeTransport } from '../../app/linux-playwright-pipe.mjs';

const fixture = process.env.KTZ_READINESS_FIXTURE;
const run = process.env.KTZ_READINESS_RUN;
const origin = process.env.KTZ_READINESS_ORIGIN;
const info = os.userInfo();
os.userInfo = () => ({ ...info, homedir: path.join(fixture, 'home') });
const record = (name, value) => writeFileSync(path.join(fixture, `${run}-${name}.json`), JSON.stringify(value), { mode: 0o600 });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let confirm;
const confirmed = new Promise(resolve => { confirm = resolve; });
const log = console.log;
console.log = (...args) => {
  if (String(args[0]).startsWith('専用ログイン画面を開きました。')) confirm(true);
  log(...args);
};
const error = console.error;
console.error = (...args) => { record('message', String(args[0])); confirm(false); error(...args); };
const spawn = childProcess.spawn;
childProcess.spawn = (exe, args, options) => {
  // Only the owned failure notification, never another app's dialog.
  if (exe === '/usr/bin/zenity') return spawn('/usr/bin/true', [], options);
  if (exe !== '/snap/bin/chromium') return spawn(exe, args, options);
  const profile = args.find(arg => arg.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
  if (!profile.startsWith(`${fixture}/home/`)) throw new Error('fixture_profile_required');
  record('launch', { target: args.at(-1), profile, flagsCleared: options.env.CHROMIUM_FLAGS === undefined,
    wayland: args.includes('--ozone-platform=wayland') && options.env.DISPLAY === '',
    unsafeArgs: args.some(arg => /--(?:no-sandbox|disable-setuid-sandbox|password-store=basic|use-mock-keychain|remote-debugging)/.test(arg)) });
  // Anonymous-only inherited pipes, not a TCP debugging listener.
  const child = spawn(exe, [...args.slice(0, -1), '--disable-background-networking', '--remote-debugging-pipe', origin],
    { ...options, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  child.stdio[3].on('error', () => {}); child.stdio[4].on('error', () => {});
  void (async () => {
    let browser;
    try {
      const ready = await Promise.race([confirmed, sleep(12_000).then(() => false)]);
      if (!ready) throw new Error('public_start_unconfirmed');
      const { chromium } = await import('playwright');
      browser = await chromium.connectOverCDP(ownedPipeTransport(child), { noDefaults: true, timeout: 10_000 });
      const page = browser.contexts()[0].pages()[0];
      await page.waitForURL(`${origin}/`);
      const retained = await page.evaluate(() => localStorage.getItem('ktz-anonymous-persistence') === 'fixture-only');
      if (run === 'first') await page.evaluate(() => localStorage.setItem('ktz-anonymous-persistence', 'fixture-only'));
      const sandbox = await browser.contexts()[0].newPage();
      await sandbox.goto('chrome://sandbox/');
      const status = await sandbox.locator('body').innerText();
      await sandbox.close();
      // Preserve the browser's own non-secret status, not an invented UI label.
      record('ready', { retained, sandboxStatus: status });
      // Let the parent exercise a concurrent desktop invocation, without asking
      // the user to close or approve an anonymous test window.
      if (run === 'first') {
        const until = Date.now() + 15_000;
        while (!existsSync(path.join(fixture, 'release-first')) && Date.now() < until) await sleep(50);
      }
    } catch (failure) {
      record('failure', { reason: failure.message });
      process.exitCode = 1;
    } finally {
      if (browser?.isConnected()) {
        const session = await browser.newBrowserCDPSession();
        await session.send('Browser.close').catch(() => {});
      } else if (child.stdio[3].writable) {
        child.stdio[3].write(JSON.stringify({ id: 1, method: 'Browser.close' }) + '\0');
        child.stdio[4].resume();
      }
    }
  })().catch(() => { record('failure', { reason: 'fixture_close_unconfirmed' }); process.exitCode = 1; });
  return child;
};
syncBuiltinESMExports();
process.once('exit', code => record('exit', { code }));
