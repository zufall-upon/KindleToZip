// Fault input for the real public npm start + HTTP + Reader/Application/Rust
// shutdown. Both browser objects and the child IPC are synthetic, no Snap runs.
import { appendFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { ControlOwner, connectOwnedPipeControlSession } from './owned-pipe-control-fixture.mjs';
import { superviseLinuxOwnedReader } from '../../app/linux-owned-reader.mjs';

const root = process.env.KTZ_PIPE_CONTROL_ROOT;
if (!root || !path.basename(root).startsWith('pipe-control-')) throw new Error('anonymous_only');
if (/(?:^|\/)app\/main\.mjs$/.test(process.argv[1] ?? '')) {
  const { Application } = await import('../../app/application.mjs');
  const { Reader } = await import('../../app/reader.mjs');
  const { chromium } = await import('playwright');
  const record = value => appendFileSync(path.join(root, 'events.jsonl'), JSON.stringify(value) + '\n', { mode: 0o600 });
  let app;
  const init = Application.prototype.init;
  Application.prototype.init = async function () { const result = await init.call(this); app = this; return result; };
  const close = Application.prototype.close;
  Application.prototype.close = async function () {
    try { await close.call(this); record({ event: 'app-close', success: true }); }
    catch (error) { record({ event: 'app-close', success: false, storeClosed: this.store.closed }); throw error; }
  };
  chromium.launch = async options => {
    const owned = options.env.KTZ_TEMP_DIR;
    process.once('exit', code => record({ event: 'exit', code, ownedExists: existsSync(owned) }));
    let target;
    const page = {
      on() {}, async goto(url) { target = new URL(url); },
      once(event, callback) {
        if (event !== 'close') return;
        setTimeout(async () => {
          try {
            const api = async (action, input = {}) => {
              const response = await fetch(`${target.origin}/api/command`, { method: 'POST', headers: {
                Authorization: `Bearer ${target.hash.slice(1)}`, Origin: target.origin, 'Content-Type': 'application/json',
              }, body: JSON.stringify({ action, input }) });
              return { status: response.status, body: await response.json() };
            };
            const created = await api('create');
            if (created.status !== 200) throw new Error('create_failed');
            const owner = new ControlOwner('lost-callback');
            const pipe = await superviseLinuxOwnedReader(owner, { startupTimeoutMs: 1000, closeTimeoutMs: 40 });
            const { session } = await connectOwnedPipeControlSession(owner, pipe);
            const lifecycle = { profile: null, state: 'active' };
            const context = new EventEmitter(); context.pages = () => [];
            const readerPage = { evaluate: async () => undefined };
            const reader = new Reader(context, readerPage, pipe.url, () => {}, true, undefined, lifecycle);
            reader.ownedPipe = pipe;
            reader.ownedSampleGuard = { dispose: () => session.detach().catch(() => {}) };
            app.reader = reader; app.readerLifecycle = lifecycle; app.ownedPipeFixture = true;
            let fixtureClosed = false;
            app.fixture = { close: async () => { fixtureClosed = true; } };
            const closed = await api('closeBrowser');
            const firstError = lifecycle.failure;
            owner.emit('message', { event: 'normal' }); owner.emit('exit', 0, null);
            const retried = await api('closeBrowser');
            const denied = await api('start', { confirmed: true });
            record({ event: 'propagation', statuses: [closed.status, retried.status],
              code: closed.body.code, cause: firstError.code, sameFailure: lifecycle.failure === firstError,
              releasePending: app.readerReleasePending, retainedReader: app.reader === reader,
              fixtureClosed, denied: denied.body.code, closeSends: owner.sent.filter(value => value === 'close').length });
          } catch { record({ event: 'hook-failed' }); }
          callback();
        }, 50);
      },
    };
    return { async newContext() { return { async route() {}, async newPage() { return page; } }; }, async close() {} };
  };
}
