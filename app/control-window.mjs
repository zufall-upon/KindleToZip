import { fileURLToPath } from 'node:url';

process.env.PLAYWRIGHT_BROWSERS_PATH ||= fileURLToPath(new URL('../artifacts/browsers/', import.meta.url));
const { chromium } = await import('playwright');

// The control UI never uses the user's default browser/profile/extensions.
// Its temporary browser contains only this loopback UI, not Kindle login state.
// Explicit startup may open it; acquisition never activates an OS window.
export async function openControlWindow(url, { headless = false, onClose, handleSignals = true } = {}) {
  const target = new URL(url);
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || target.pathname !== '/'
    || target.search || target.username || target.password || !/^#[a-f0-9]{64}$/.test(target.hash)) throw new Error('invalid_control_url');
  // Playwright's non-persistent launch creates its short-lived Chromium
  // profile below os.tmpdir() and may ask the graphics stack for a home-based
  // shader cache. In a packaged run the launcher supplies EXE-adjacent temp
  // paths; capture them for this launch instead of allowing caller values to
  // redirect browser state.
  const tempDirectory = process.env.KTZ_TEMP_DIR;
  const browserEnvironment = tempDirectory ? {
    ...process.env,
    TEMP: tempDirectory, TMP: tempDirectory, TMPDIR: tempDirectory,
    LOCALAPPDATA: tempDirectory, APPDATA: tempDirectory,
    HOME: tempDirectory, USERPROFILE: tempDirectory,
    XDG_CACHE_HOME: tempDirectory, XDG_CONFIG_HOME: tempDirectory, XDG_DATA_HOME: tempDirectory,
  } : undefined;
  const browser = await chromium.launch({ headless, ...(browserEnvironment ? { env: browserEnvironment } : {}),
    ...(handleSignals ? {} : { handleSIGINT: false, handleSIGTERM: false }) });
  try {
    const context = await browser.newContext({
      viewport: { width: 1100, height: 850 }, colorScheme: 'light',
      acceptDownloads: false, serviceWorkers: 'block',
    });
    await context.route('**/*', route => new URL(route.request().url()).origin === target.origin
      ? route.continue() : route.abort('blockedbyclient'));
    const page = await context.newPage();
    page.on('download', download => { void download.cancel(); });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    let closing = false, closePromise;
    const close = () => {
      closing = true;
      return closePromise ??= browser.close();
    };
    page.once('close', () => {
      if (!closing) {
        void close().catch(() => {});
        onClose?.();
      }
    });
    return { browser, context, page, close };
  } catch (error) { await browser.close(); throw error; }
}
