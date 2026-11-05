// Test-process-only preload: exercise the actual desktop file and public entry
// with a synthetic home/profile. It is never read by the public entry itself.
import os from 'node:os';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const fixture = process.env.KTZ_GIO_FIXTURE;
const run = process.env.KTZ_GIO_RUN;
const home = path.join(fixture, 'home');
const info = os.userInfo();
os.userInfo = () => ({ ...info, homedir: home });
let started;
const verified = new Promise(resolve => { started = resolve; });
const log = console.log;
console.log = (...args) => {
  if (String(args[0]).startsWith('専用ログイン画面を開きました。')) {
    writeFileSync(path.join(fixture, `${run}-started.json`), '{}');
    started(true);
  }
  log(...args);
};
const reportError = console.error;
console.error = (...args) => {
  writeFileSync(path.join(fixture, `${run}-message.txt`), String(args[0]));
  started(false);
  reportError(...args);
};
const spawn = childProcess.spawn;
childProcess.spawn = (executable, args, options) => {
  if (executable !== '/snap/bin/chromium') return spawn(executable, args, options);
  const target = args.at(-1);
  const profile = args.find(arg => arg.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
  writeFileSync(path.join(fixture, `${run}-target.json`), JSON.stringify({ target, profile, flagsCleared: options.env.CHROMIUM_FLAGS === undefined }));
  let previousPortFile = '';
  try { previousPortFile = readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8'); } catch {}
  const child = spawn(executable, [...args.slice(0, -1), '--disable-background-networking', '--remote-debugging-port=0', 'about:blank'], options);
  writeFileSync(path.join(fixture, `${run}-spawn.json`), JSON.stringify({ pid: child.pid }));
  void (async () => {
    let port;
    for (let n = 0; n < 200; n++) {
      try {
        const contents = await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8');
        if (contents !== previousPortFile) { port = Number(contents.split('\n')[0]); if (port) break; }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!port) throw new Error('fixture_debug_port_unavailable');
    const { chromium } = await import('playwright');
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    // Closing before the entry has identified its owned browser correctly
    // leaves the launch unknown, rather than proving the normal-close path.
    if (!await verified) {
      const session = await browser.newBrowserCDPSession();
      await session.send('Browser.close').catch(() => {});
      throw new Error('fixture_public_start_unconfirmed');
    }
    const context = browser.contexts()[0];
    const url = 'http://127.0.0.1/';
    const retained = (await context.cookies(url)).some(cookie => cookie.name === 'ktz_gio_anonymous' && cookie.value === 'fixture-only');
    if (run === 'first') await context.addCookies([{ name: 'ktz_gio_anonymous', value: 'fixture-only', url, expires: Math.floor(Date.now() / 1000) + 86400 }]);
    await writeFile(path.join(fixture, `${run}-fixture.json`), JSON.stringify({ retained }));
    const session = await browser.newBrowserCDPSession();
    await session.send('Browser.close').catch(() => {});
  })().catch(error => writeFile(path.join(fixture, `${run}-fixture-error.txt`), error.message));
  return child;
};
syncBuiltinESMExports();
process.once('exit', code => writeFileSync(path.join(fixture, `${run}-exit.json`), JSON.stringify({ code })));
