// Fault injection for the real npm start / real HTTP command / Rust controller.
// Both Chromium objects are synthetic; no browser process is created here.
import { appendFileSync, existsSync } from 'node:fs';

if (process.platform === 'linux' && process.env.KTZ_READER_TEST_MODE
  && /(?:^|\/)app\/main\.mjs$/.test(process.argv[1] ?? '')) {
  const { chromium } = await import('playwright');
  const { Application } = await import('../../app/application.mjs');
  const mode = process.env.KTZ_READER_TEST_MODE;
  const record = event => appendFileSync(process.env.KTZ_READER_TEST_LOG, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  let app, target, profile;
  const init = Application.prototype.init, close = Application.prototype.close;
  Application.prototype.init = async function () { const result = await init.call(this); app = this; return result; };
  Application.prototype.close = async function () {
    try {
      const result = await close.call(this);
      record({ event: 'application.close.resolved', storeClosed: this.store.closed, profileExists: existsSync(profile) });
      return result;
    } catch (error) {
      record({ event: 'application.close.rejected', storeClosed: this.store.closed, profileExists: existsSync(profile) });
      throw error;
    }
  };
  chromium.launchPersistentContext = async () => {
    record({ event: 'reader.launch' });
    if (mode === 'launch-reject') throw new Error('PRIVATE_PATH_TOKEN_SECRET:launch');
    return {
      async route() { throw new Error('PRIVATE_PATH_TOKEN_SECRET:initialization'); },
      async close() {
        record({ event: 'reader.close' });
        if (mode === 'close-reject') throw new Error('PRIVATE_PATH_TOKEN_SECRET:close');
      },
    };
  };
  chromium.launch = async options => {
    const owned = options.env.KTZ_TEMP_DIR;
    process.once('exit', code => record({ event: 'exit', code, ownedExists: existsSync(owned) }));
    const page = {
      on() {}, async goto(url) { target = new URL(url); },
      once(event, callback) {
        if (event === 'close') setTimeout(async () => {
          try {
            const command = async action => {
              const response = await fetch(`${target.origin}/api/command`, { method: 'POST', headers: {
                Authorization: `Bearer ${target.hash.slice(1)}`, Origin: target.origin, 'Content-Type': 'application/json',
              }, body: JSON.stringify({ action, input: action === 'openBrowser' ? { mode: 'sample' } : {} }) });
              return { status: response.status, body: await response.json() };
            };
            const created = await command('create');
            const opened = await command('openBrowser');
            profile = app.profile;
            record({ event: 'commands', createStatus: created.status, openStatus: opened.status, openCode: opened.body.code,
              profileExists: existsSync(profile), readerReturned: Boolean(app.reader) });
            callback();
          } catch {
            record({ event: 'hook.failed' });
            callback();
          }
        }, 50);
      },
    };
    return { async newContext() { return { async route() {}, async newPage() { return page; } }; },
      async close() { record({ event: 'control.close' }); } };
  };
}
