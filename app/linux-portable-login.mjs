// Fixed Portable login or anonymous self-check; neither accepts a URL or path.
import { spawn } from 'node:child_process';
import http from 'node:http';
import { userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLinuxLogin, snapLoginPreflight } from './linux-login-core.mjs';
import { ensurePortablePrivateDirectory, resolvePortableLinuxSession } from './portable-linux-session.mjs';
import { ownedPipeTransport } from './linux-playwright-pipe.mjs';

export async function runPortableLinuxLogin(root, { anonymous = false } = {}) {
  const home = userInfo().homedir;
  await snapLoginPreflight(home);
  const data = path.join(root, 'data');
  await ensurePortablePrivateDirectory(data);
  const directory = path.join(data, anonymous ? 'anonymous-profile-check' : 'application');
  const selected = await resolvePortableLinuxSession(directory);
  if (!anonymous) {
    await runLinuxLogin({ root: selected.root, url: 'https://read.amazon.co.jp/', preflight: () => snapLoginPreflight(home),
      requireExistingProfile: true, requireAbsentSingleton: true, joinUnconfirmedStart: true,
      requiredArgs: ['--ozone-platform=wayland'],
      onStarted: () => console.log('Portable専用ログイン画面を開きました。既存のログイン入口とは別のprofileです。終了は全ウィンドウを閉じてください。') });
    return;
  }

  // Only a newly owned fixture and loopback document are used. Chromium itself
  // stores/reads the anonymous cookie; no browser profile file is inspected.
  const server = http.createServer((_request, response) => response.writeHead(200, { 'content-type': 'text/html' })
    .end('<!doctype html><title>KindleToZip anonymous profile fixture</title>'));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  let retained = false, sandbox = false;
  try {
    await runLinuxLogin({ root: selected.root, url: origin, preflight: () => snapLoginPreflight(home),
      requireExistingProfile: true, requireAbsentSingleton: true, joinUnconfirmedStart: true,
      requiredArgs: ['--ozone-platform=wayland', '--remote-debugging-pipe'],
      launch(executable, args) {
        const env = { ...process.env, DISPLAY: '' }; delete env.CHROMIUM_FLAGS;
        const child = spawn(executable, [...args.slice(0, -1), '--ozone-platform=wayland', '--disable-background-networking', '--remote-debugging-pipe', args.at(-1)],
          { env, detached: true, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
        child.stdio[3].on('error', () => {}); child.stdio[4].on('error', () => {});
        return child;
      },
      async onStarted({ child, assertProcessStillOwned }) {
        await assertProcessStillOwned();
        const { chromium } = await import('playwright');
        const browser = await chromium.connectOverCDP(ownedPipeTransport(child), { noDefaults: true, timeout: 10_000 });
        try {
          const page = browser.contexts()[0].pages()[0];
          await page.waitForURL(`${origin}/`);
          retained = await page.evaluate(() => document.cookie.split('; ').includes('ktz_portable_anonymous=fixture-only'));
          await page.evaluate(() => { document.cookie = 'ktz_portable_anonymous=fixture-only; Max-Age=3600; Path=/; SameSite=Lax'; });
          if (!await page.evaluate(() => document.cookie.split('; ').includes('ktz_portable_anonymous=fixture-only'))) throw new Error('anonymous_cookie_not_saved');
          const statusPage = await browser.contexts()[0].newPage();
          await statusPage.goto('chrome://sandbox/');
          const status = await statusPage.locator('body').innerText();
          sandbox = /Seccomp-BPF sandbox\s+Yes/.test(status) && /PID namespaces\s+Yes/.test(status)
            && /Network namespaces\s+Yes/.test(status) && /You are adequately sandboxed/.test(status);
          if (!sandbox) throw new Error('anonymous_sandbox_unconfirmed');
        } finally {
          const session = await browser.newBrowserCDPSession();
          await session.send('Browser.close');
        }
      },
    });
    // Reader-equivalent resolution is made through the identical saved ID and
    // identity checks, not from a copied or absolute profile path.
    const reader = await resolvePortableLinuxSession(directory);
    if (reader.id !== selected.id || reader.profile !== selected.profile) throw new Error('portable_reader_profile_mismatch');
    console.log(`匿名Portable profile確認: ${JSON.stringify({ id: selected.id, retained, sandbox, readerSameProfile: true })}`);
  } finally { await new Promise(resolve => server.close(resolve)); }
}

// Also permits a minimal, newly-created anonymous fixture to exercise this
// public fixed entry before the large delivery payload is copied.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (process.platform !== 'linux' || process.argv.length !== 3 || process.argv[2] !== '--anonymous-profile-check') throw new Error('invalid_invocation');
    process.umask(0o077);
    await runPortableLinuxLogin(fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, ''), { anonymous: true });
  } catch (error) { console.error(`Portableログインを開始できません: ${error?.code ?? error?.message ?? 'unknown'}`); process.exitCode = 1; }
}
