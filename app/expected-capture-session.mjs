import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { captureBook } from './linux-expected-capture-paths.mjs';
import { superviseLinuxOwnedReader } from './linux-owned-reader.mjs';
import { bindExpectedIdentity } from './expected-identity.mjs';
import { expectedRoute } from './linux-playwright-expected-observe.mjs';
import { inspectKindleDocument, readerMarkerReasons } from './linux-reader-probe.mjs';
import { createKindleAdapter, kindleChromeConfig } from './stores/kindle.mjs';
import { createExpectedCaptureBudget } from './expected-capture-budget.mjs';
import { AppError } from './store-client.mjs';
import { captureStartupFailure } from './expected-capture-diagnostic.mjs';

const sessions = new WeakMap();
export const expectedCaptureSession = value => sessions.get(value);
const origin = 'https://read.amazon.co.jp';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitable = new Set(readerMarkerReasons.filter(reason => reason.endsWith('-missing')));

// Only a private, already captured fixed-path record can supply identity; no
// arbitrary identity, URL or profile is accepted. Claim/consent are separate.
export async function startExpectedCaptureSession(paths) {
  const book = captureBook(paths);
  const env = { ...process.env };
  for (const key of ['NODE_OPTIONS', 'CHROMIUM_FLAGS', 'DEBUG', 'PWDEBUG']) delete env[key];
  const child = fork(fileURLToPath(new URL('./linux-expected-reader-owner.mjs', import.meta.url)), [], {
    execPath: process.execPath, execArgv: [], detached: true, env,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc', 'pipe', 'pipe'],
  });
  const owner = await superviseLinuxOwnedReader(child, { expectedReader: true });
  const capability = Object.freeze({ close: () => owner.close(), retain: () => owner.retain(), processIds: owner.processIds });
  let bound = false, readyUntil, readinessStage = 'route';
  const timeoutFailure = () => captureStartupFailure(readinessStage, readinessStage === 'route' ? 'restore_timeout'
    : readinessStage === 'identity' ? 'title_missing_timeout' : 'markers_missing_timeout', 'expected_reader_not_ready');
  const readiness = async action => {
    const remaining = readyUntil - Date.now();
    if (!(remaining > 0)) throw timeoutFailure();
    let timer;
    try { return await Promise.race([Promise.resolve().then(action), new Promise((_, reject) => {
      timer = setTimeout(() => reject(timeoutFailure()), remaining);
    })]); } finally { clearTimeout(timer); }
  };
  sessions.set(capability, Object.freeze({
    adapter: createKindleAdapter('jp'), transport: owner.transport, close: () => owner.close(), startupDiagnostics: true,
    async ready(page) {
      readyUntil = Date.now() + 10_000;
      const expression = `(() => ({ route: (${expectedRoute.toString()})(${JSON.stringify(origin)}, ${JSON.stringify(book.asin)}), visible: document.visibilityState === 'visible' }))()`;
      // Restoration only: never select a book, navigate, scroll or change UI.
      while (Date.now() < readyUntil) {
        let state, visible;
        try { const value = await readiness(() => page.evaluate(expression)); state = value.route; visible = value.visible; }
        catch (error) { if (error.code === 'expected_reader_not_ready') throw error; state = 'starting'; }
        if (state === 'match') return;
        if (!['starting', 'placeholder'].includes(state)) throw captureStartupFailure('route', state === 'mismatch' ? 'route_mismatch'
          : state === 'blocking' ? 'blocking_ui' : visible === false ? 'initial_visibility_unavailable' : 'route_unavailable');
        await sleep(80);
      }
      throw timeoutFailure();
    },
    async bind(reader) {
      if (bound) throw new AppError('target_changed');
      bound = true;
      readinessStage = 'identity';
      const identity = await readiness(() => bindExpectedIdentity(reader, origin, book, expectedRoute, kindleChromeConfig.identity,
        2500, { initialDeadline: readyUntil }));
      readinessStage = 'structure';
      // A matching restored route is not proof that its asynchronous UI is
      // ready. Poll only known structural readiness, under the same deadline
      // and the already-installed identity watch. No input, metadata or pixels
      // are used to make progress, and only missing initial markers may wait.
      while (true) {
        const state = await readiness(async () => {
          await identity.assertIdentity();
          const value = await reader.page.evaluate(inspectKindleDocument, { expectedOrigin: origin, expectedMode: true });
          await identity.assertIdentity();
          return value;
        });
        if (state.state === 'ready') break;
        if (!waitable.has(state.reason) || Object.values(state.markers ?? {}).some(marker => marker.count === 'multiple')) {
          throw captureStartupFailure('structure', state.reason === 'blocking-ui' ? 'blocking_ui'
            : Object.values(state.markers ?? {}).some(marker => marker.count === 'multiple') ? 'markers_ambiguous' : 'reader_structure_unknown', 'reader_ui_unknown');
        }
        await readiness(() => sleep(80));
      }
      const budget = createExpectedCaptureBudget();
      const browserSession = await reader.context.browser().newBrowserCDPSession();
      const pageSession = await reader.context.newCDPSession(reader.page);
      const target = (await pageSession.send('Target.getTargetInfo')).targetInfo;
      const window = await browserSession.send('Browser.getWindowForTarget', { targetId: target.targetId });
      let bounds, last;
      const guard = {
        singleRunBudget: budget, allowsIdentityRedraw: true, allowsLibraryReader: true,
        validateConfig(config) {
          if (!config || Object.entries(kindleChromeConfig).some(([key, value]) => config[key] !== value)
            || Object.values(config.frames ?? {}).some(Boolean)) throw new AppError('target_changed');
        },
        async assertIdentity() { await identity.assertIdentity(); },
        async observe() {
          await identity.assertIdentity();
          const currentTarget = (await pageSession.send('Target.getTargetInfo')).targetInfo;
          if (currentTarget.targetId !== target.targetId || currentTarget.type !== 'page') throw new AppError('target_changed');
          const currentWindow = await browserSession.send('Browser.getWindowForTarget', { targetId: target.targetId });
          if (currentWindow.windowId !== window.windowId) throw new AppError('window_not_available');
          const state = (await browserSession.send('Browser.getWindowBounds', { windowId: window.windowId })).bounds.windowState;
          if (!['normal', 'maximized', 'fullscreen'].includes(state)) throw new AppError('window_not_available');
          const value = await reader.page.evaluate(inspectKindleDocument, { expectedOrigin: origin, metadata: true, expectedMode: true });
          await identity.assertIdentity();
          if (value.state !== 'ok') throw new AppError('reader_ui_unknown');
          const p = value.position;
          if (!p || ![p.value, p.min, p.max].every(Number.isFinite) || p.min >= p.max || p.value < p.min || p.value > p.max) throw new AppError('target_changed');
          const shape = JSON.stringify([p.min, p.max, value.region]);
          if (bounds && bounds !== shape) throw new AppError('target_changed');
          bounds = shape; last = p;
          // No screenshot, canvas readback, text body or service state is used
          // as a readiness poll. Pixel quality is checked on the two images only.
          return `${shape}:${p.value}`;
        },
        atEnd() { return last && last.value >= last.max; },
        validateTransition(before, after) {
          if (!last || !Number.isFinite(Number(before)) || !Number.isFinite(Number(after))
            || Number(after) <= Number(before) || Number(after) > last.max) throw new AppError('target_changed');
        },
        async dispose() {
          // Owner shutdown already joined before Reader invokes this cleanup.
          await identity.dispose();
          await pageSession.detach().catch(() => {}); await browserSession.detach().catch(() => {});
        },
      };
      await guard.observe();
      return guard;
    },
  }));
  return capability;
}
