// Test-only fault injection into the real public npm start child. The mock
// never starts Chromium; the normal Rust controller and application are used.
import { appendFileSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';

if (process.platform === 'linux' && process.env.KTZ_CLEANUP_TEST_MODE
  && /(?:^|\/)app\/main\.mjs$/.test(process.argv[1] ?? '')) {
  const { chromium } = await import('playwright');
  const { Application } = await import('../../app/application.mjs');
  const mode = process.env.KTZ_CLEANUP_TEST_MODE;
  const record = event => appendFileSync(process.env.KTZ_CLEANUP_TEST_LOG, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  const closeApplication = Application.prototype.close;
  Application.prototype.close = async function () {
    record({ event: 'application.close.start' });
    await closeApplication.call(this);
    record({ event: 'application.close.end' });
    if (mode === 'app-close-fail') throw new Error(`PRIVATE_PATH_TOKEN_SECRET:${process.env.KTZ_TEMP_DIR}`);
  };
  if (mode === 'app-start-fail') {
    const init = Application.prototype.init;
    Application.prototype.init = async function () {
      await init.call(this);
      record({ event: 'application.init.reject' });
      throw new Error(`PRIVATE_PATH_TOKEN_SECRET:${process.env.KTZ_TEMP_DIR}`);
    };
  }
  chromium.launch = async options => {
    const owned = options.env.KTZ_TEMP_DIR;
    record({ event: 'launch', exists: existsSync(owned) });
    if (mode === 'launch-reject') throw new Error(`PRIVATE_PATH_TOKEN_SECRET:${owned}`);
    const page = {
      on() {}, async goto() {},
      once(event, callback) { if (event === 'close') setTimeout(callback, 50); },
    };
    const context = { async route() {}, async newPage() { return page; } };
    return {
      async newContext() {
        if (mode === 'init-close-ok' || mode === 'init-close-fail') {
          record({ event: 'initialization.reject' });
          throw new Error(`PRIVATE_PATH_TOKEN_SECRET:${owned}`);
        }
        return context;
      },
      async close() {
        record({ event: 'control.close' });
        if (mode === 'replace-identity') {
          renameSync(owned, `${owned}-original`);
          mkdirSync(owned, { mode: 0o700 });
          writeFileSync(`${owned}/replacement`, 'do not delete', { mode: 0o600 });
        }
        if (mode === 'init-close-fail' || mode === 'control-close-fail') {
          throw new Error(`PRIVATE_PATH_TOKEN_SECRET:${owned}`);
        }
      },
    };
  };
}
