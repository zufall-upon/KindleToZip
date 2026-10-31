import http from 'node:http';
import { createHash } from 'node:crypto';
import { startFixture } from '../poc/browser/fixture-server.mjs';
import { AppError } from './store-client.mjs';

// This capability is minted only around the fixed fixture that this process
// started. A URL, UI field, or fixture DOM attribute cannot mint it.
const owned = new WeakMap();
const listen = server => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const close = server => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));

export async function startOwnedSample() {
  const fixture = await startFixture({ fixture: 'reader' });
  const proxy = http.createServer((_req, res) => res.writeHead(403, { Connection: 'close' }).end());
  proxy.on('connect', (_req, socket) => {
    // A browser may abort a denied background CONNECT while the rejection is
    // being written. It remains denied; the peer reset must not kill the app.
    socket.on('error', () => {});
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
  });
  try { await listen(proxy); }
  catch (error) {
    try { await fixture.close(); } catch (closeError) { throw new AggregateError([error, closeError], 'owned_sample_initialization_and_close_failed', { cause: error }); }
    throw error;
  }
  let closing;
  const result = Object.freeze({ url: fixture.url, close: () => closing ??= (async () => {
    const results = await Promise.allSettled([fixture.close(), close(proxy)]);
    const errors = results.filter(item => item.status === 'rejected').map(item => item.reason);
    if (errors.length) throw new AggregateError(errors, 'owned_sample_cleanup_failed');
  })() });
  owned.set(result, { proxyPort: proxy.address().port });
  return result;
}

export function ownedSampleOptions(fixture) {
  const record = owned.get(fixture);
  if (!record || process.platform !== 'linux' || !process.env.WAYLAND_DISPLAY) throw new AppError('owned_sample_unavailable');
  return {
    headless: false,
    env: { ...process.env, DISPLAY: '' },
    args: ['--ozone-platform=wayland', '--disable-background-networking', '--disable-quic',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'],
    proxy: { server: `http://127.0.0.1:${record.proxyPort}`, bypass: '127.0.0.1' },
  };
}

// Only an owned context, its original page/document/nodes and this exact
// fixture are eligible. CDP window state is a necessary browser report, not an
// assertion about OS foreground, physical input, or other applications.
export async function bindOwnedSample(fixture, reader) {
  if (!owned.has(fixture) || reader.sampleUrl !== fixture.url || reader.adapter.id !== 'sample'
    || reader.adapter.startUrl !== fixture.url) throw new AppError('owned_sample_unavailable');
  const { context, page, adapter } = reader;
  const pageSession = await context.newCDPSession(page);
  const browserSession = await context.browser().newBrowserCDPSession();
  const handles = [];
  try {
    await pageSession.send('Emulation.setFocusEmulationEnabled', { enabled: false });
    const info = (await pageSession.send('Target.getTargetInfo')).targetInfo;
    const window = await browserSession.send('Browser.getWindowForTarget', { targetId: info.targetId });
    if (info.type !== 'page' || info.url !== fixture.url || !info.targetId || !Number.isInteger(window.windowId)) throw new AppError('target_changed');
    for (const selector of ['#reader', '#sheet', 'h1', '#position', '#next']) {
      const locator = page.locator(selector);
      if (await locator.count() !== 1) throw new AppError('target_changed');
      const handle = await locator.elementHandle();
      if (!handle) throw new AppError('target_changed');
      handles.push(handle);
    }
    const guard = {
      async observe() {
        try {
          if (reader.context !== context || reader.page !== page || reader.adapter !== adapter || page.isClosed()
            || !context.browser()?.isConnected() || context.pages().length !== 1 || context.pages()[0] !== page
            || page.url() !== fixture.url) throw new AppError('target_changed');
          const target = (await pageSession.send('Target.getTargetInfo')).targetInfo;
          if (target.targetId !== info.targetId || target.type !== 'page' || target.url !== fixture.url) throw new AppError('target_changed');
          const mapped = await browserSession.send('Browser.getWindowForTarget', { targetId: info.targetId });
          if (mapped.windowId !== window.windowId) throw new AppError('window_not_available');
          const state = (await browserSession.send('Browser.getWindowBounds', { windowId: window.windowId })).bounds.windowState;
          if (!['normal', 'maximized', 'fullscreen'].includes(state)) throw new AppError('window_not_available');
          const pixels = await page.evaluate(nodes => {
            const selectors = ['#reader', '#sheet', 'h1', '#position', '#next'];
            if (nodes.some((node, index) => !node?.isConnected || document.querySelectorAll(selectors[index]).length !== 1
              || document.querySelector(selectors[index]) !== node)) return null;
            const [root, canvas, , position] = nodes;
            if (root.dataset.fixture !== 'ktz-self-authored-v1' || root.dataset.book !== 'sample-a'
              || root.dataset.session !== 'active' || root.dataset.overlay !== 'false' || root.dataset.generation !== '1'
              || !/^(?:[1-9]|1[0-2])$/.test(root.dataset.position)
              || position.innerText.trim() !== `${root.dataset.position} / 12`) return null;
            const context = canvas.getContext('2d', { willReadFrequently: true });
            if (!context || !canvas.width || !canvas.height) return null;
            // A bounded, sparse paint observation, not a byte-exact image oracle.
            const values = [canvas.width, canvas.height];
            for (let y = 0; y < 12; y++) for (let x = 0; x < 16; x++) {
              values.push(...context.getImageData(Math.floor((x + 0.5) * canvas.width / 16), Math.floor((y + 0.5) * canvas.height / 12), 1, 1).data);
            }
            return values;
          }, handles);
          if (!pixels) throw new AppError('target_changed');
          return createHash('sha256').update(JSON.stringify(pixels)).digest('hex');
        } catch (error) {
          if (error instanceof AppError) throw error;
          throw new AppError('window_not_available');
        }
      },
      async dispose() {
        await Promise.all(handles.map(handle => handle.dispose().catch(() => {})));
        await pageSession.detach().catch(() => {});
        await browserSession.detach().catch(() => {});
      },
    };
    await guard.observe();
    return guard;
  } catch (error) {
    await Promise.all(handles.map(handle => handle.dispose().catch(() => {})));
    await pageSession.detach().catch(() => {});
    await browserSession.detach().catch(() => {});
    throw error;
  }
}
