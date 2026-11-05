// Test-only relocation to a freshly created anonymous Snap fixture. Production
// receives no URL/profile override; the real fixed owner, factory and store run.
import os from 'node:os';
import childProcess from 'node:child_process';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { appendFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

const home = process.env.KTZ_EXPECTED_TEST_HOME, url = process.env.KTZ_EXPECTED_TEST_URL;
if (!/^\/home\/user\/snap\/chromium\/common\/kindle-to-zip-owned-sample\/capture-cli-fixtures-v1\/capture-[A-Za-z0-9]+$/.test(home ?? '')
    || !/^http:\/\/127\.0\.0\.1:\d+\/kindle-library\/manga-wr\/B000TEST0[34]$/.test(url ?? '')) throw new Error('anonymous_only');
const info = os.userInfo;
os.userInfo = (...args) => ({ ...info(...args), homedir: home });
syncBuiltinESMExports();
const trace = value => appendFileSync(path.join(home, 'trace.ndjson'), JSON.stringify(value) + '\n', { mode: 0o600 });

registerHooks({ load(moduleUrl, context, nextLoad) {
  const result = nextLoad(moduleUrl, context);
  if (moduleUrl.endsWith('/app/expected-capture-session.mjs')) {
    const source = result.source.toString().replace("const origin = 'https://read.amazon.co.jp';", `const origin = ${JSON.stringify(new URL(url).origin)};`);
    return { ...result, source };
  }
  if (moduleUrl.endsWith('/app/stores/kindle.mjs')) {
    const source = result.source.toString().replace('https://read.amazon.co.jp/', `${new URL(url).origin}/`);
    return { ...result, source };
  }
  return result;
} });

const owner = /\/app\/linux-expected-reader-owner\.mjs$/.test(process.argv[1] ?? '');
const entry = /\/app\/linux-expected-capture\.mjs$/.test(process.argv[1] ?? '');
if (entry) {
  const fork = childProcess.fork;
  childProcess.fork = (file, args, options) => {
    if (file.endsWith('/app/linux-expected-reader-owner.mjs')) {
      const child = fork(file, args, { ...options, execArgv: [`--import=${import.meta.url}`] });
      trace({ event: 'owner', pid: child.pid }); return child;
    }
    return fork(file, args, options);
  };
  syncBuiltinESMExports();
  const { Application } = await import('../../app/application.mjs');
  const command = Application.prototype.command;
  let probed = false;
  Application.prototype.command = async function (action, input) {
    if (action === 'create' && process.env.KTZ_EXPECTED_TEST_MODE === 'changed-identity') {
      const value = await command.call(this, action, input);
      // Only the already-captured identity may govern this call. A later edit
      // changes a future call, never this running one.
      writeFileSync(path.join(home, '.local/state/kindle-to-zip-inspection/expected-book.json'),
        JSON.stringify({ version: 1, asin: 'B000TEST03', title: '匿名の自作試料タイトル', aliases: [] }));
      return value;
    }
    if (action === 'approve' && !probed) {
      probed = true;
      let early, changed;
      try { await command.call(this, 'start', { confirmed: true }); } catch (error) { early = error.code; }
      if (process.env.KTZ_EXPECTED_TEST_MODE === 'document') await this.reader.page.reload({ waitUntil: 'domcontentloaded' });
      if (['positive', 'changed-identity'].includes(process.env.KTZ_EXPECTED_TEST_MODE)) await this.reader.page.locator('#readerChromeTitle').evaluate(node => node.replaceWith(node.cloneNode(true)));
      const value = await command.call(this, action, input);
      try { await command.call(this, 'start', { confirmed: true, maxCaptures: 3 }); } catch (error) { changed = error.code; }
      trace({ event: 'approval', early, changed, approved: value.approvedMaxCaptures, originals: value.job.manifest.images.length,
        previewHash: createHash('sha256').update(this.previewImage).digest('hex') });
      return value;
    }
    return command.call(this, action, input);
  };
  const acquire = Application.prototype.acquire;
  Application.prototype.acquire = async function (...args) {
    const call = this.store.call.bind(this.store);
    let injected = false;
    this.store.call = async (kind, ...rest) => {
      const value = await call(kind, ...rest);
      if (kind === 'capture_chunk' && !injected && process.env.KTZ_EXPECTED_TEST_MODE === 'before-commit') {
        injected = true;
        await this.reader.page.evaluate(() => {
          const node = document.querySelector('#readerChromeTitle'), old = node.textContent;
          node.textContent = '別の匿名本'; node.textContent = old;
        });
      }
      return value;
    };
    try { return await acquire.apply(this, args); } finally { this.store.call = call; }
  };
}
if (owner) {
  const spawn = childProcess.spawn;
  childProcess.spawn = (executable, args, options) => {
    if (executable !== '/snap/bin/chromium' || !args.includes(`--user-data-dir=${home}/snap/chromium/common/kindle-to-zip-login/owned/profile`)
        || !args.includes('--restore-last-session') || !args.includes('--remote-debugging-pipe')
        || args.some(arg => ['--no-sandbox', '--disable-setuid-sandbox', '--password-store=basic'].includes(arg))) throw new Error('unsafe_fixture_launch');
    // Inject only the local self-authored test page into an empty fixture
    // profile. DNS is blocked; the live profile is never addressed.
    const child = spawn(executable, [...args, '--disable-background-networking', '--disable-quic',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', url], options);
    trace({ event: 'browser', pid: child.pid, owner: process.pid });
    return child;
  };
  syncBuiltinESMExports();
}
