import { mkdir, mkdtemp, writeFile, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';
import { PNG } from 'pngjs';
import { startFixture } from './fixture-server.mjs';

// Install and run the exact Playwright browser in this project's disposable area.
process.env.PLAYWRIGHT_BROWSERS_PATH = fileURLToPath(new URL('../../artifacts/browsers', import.meta.url));
const { chromium } = await import('playwright');
const require = createRequire(import.meta.url);
const MAX_PNG = 32 * 1024 * 1024;
const MAX_PIXELS = 16_000_000;
const hash = data => createHash('sha256').update(data).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export class ProbeError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function targetKey(s) {
  return JSON.stringify([s.fixture, s.book, s.session, s.generation, s.overlay, s.viewport, s.dpr, s.clip]);
}

export class SampleProbe {
  static async open({ headless = true } = {}) {
    const fixture = await startFixture();
    let browser;
    try {
      browser = await chromium.launch({ headless, args: headless ? [] : ['--window-position=40,40', '--window-size=1100,900'] });
      const context = await browser.newContext({
        viewport: { width: 1024, height: 768 },
        deviceScaleFactor: 1,
        serviceWorkers: 'block',
        acceptDownloads: false,
      });
      const origin = new URL(fixture.url).origin;
      await context.route('**/*', route => {
        const url = new URL(route.request().url());
        return url.origin === origin && ['/reader.html', '/reader.js', '/reader.css'].includes(url.pathname)
          && url.search === '' ? route.continue() : route.abort('blockedbyclient');
      });
      const page = await context.newPage();
      page.setDefaultTimeout(1500);
      await page.goto(fixture.url);
      await page.locator('#sheet').waitFor();
      const base = fileURLToPath(new URL('../../artifacts/poc-runs/', import.meta.url));
      await mkdir(base, { recursive: true });
      const directory = await mkdtemp(path.join(base, 'sample-'));
      const probe = new SampleProbe({ fixture, browser, context, page, directory });
      context.on('page', () => probe.attention('unexpected_tab'));
      page.on('framenavigated', frame => {
        if (frame === page.mainFrame()) probe.attention('navigation');
      });
      page.on('close', () => probe.attention('page_closed'));
      browser.on('disconnected', () => { if (!probe.closed) probe.attention('browser_closed'); });
      return probe;
    } catch {
      await browser?.close().catch(() => {});
      await fixture.close();
      throw new ProbeError('browser_start_failed');
    }
  }

  constructor(resources) {
    Object.assign(this, resources);
    this.state = 'Preview';
    this.reason = null;
    this.bound = null;
    this.position = null;
    this.lastCapturedPosition = null;
    this.images = [];
    this.epoch = 0;
    this.busy = false;
    this.closed = false;
    this.captureRequests = 0;
    this.advanceRequests = 0;
    this.readGuard = null;
  }

  attention(code) {
    this.epoch += 1;
    this.state = 'NeedsAttention';
    this.reason = code;
  }

  async read() {
    if (this.readGuard) await this.readGuard();
    if (this.page.isClosed() || this.context.pages().length !== 1 || this.page.url() !== this.fixture.url) {
      throw new ProbeError('target_changed');
    }
    const s = await this.page.locator('#reader').evaluate(element => {
      const canvas = element.querySelector('canvas');
      const r = canvas.getBoundingClientRect();
      return {
        fixture: element.dataset.fixture, book: element.dataset.book,
        session: element.dataset.session, generation: element.dataset.generation,
        overlay: element.dataset.overlay,
        position: Number(element.dataset.position), total: Number(element.dataset.total),
        viewport: [innerWidth, innerHeight], dpr: devicePixelRatio,
        clip: { x: r.x, y: r.y, width: r.width, height: r.height },
        nextDisabled: document.querySelector('#next').disabled,
      };
    });
    if (s.session !== 'active') throw new ProbeError('auth_required');
    if (s.fixture !== 'ktz-self-authored-v1' || s.book !== 'sample-a' || s.overlay !== 'false') {
      throw new ProbeError('target_changed');
    }
    if (!Number.isSafeInteger(s.position) || s.position < 1 || s.position > s.total
      || s.total !== 12 || s.clip.width !== 600 || s.clip.height !== 480
      || s.clip.x < 0 || s.clip.y < 0 || s.clip.x + s.clip.width > s.viewport[0]
      || s.clip.y + s.clip.height > s.viewport[1]) throw new ProbeError('display_changed');
    return s;
  }

  async stable() {
    const before = await this.read();
    await sleep(40);
    const after = await this.read();
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new ProbeError('display_unstable');
    return after;
  }

  check(s, epoch) {
    if (this.epoch !== epoch) throw new ProbeError('cancelled');
    if (this.bound !== targetKey(s) || this.position !== s.position) throw new ProbeError('target_changed');
  }

  async exclusive(action) {
    if (this.busy) throw new ProbeError('busy');
    if (this.closed) throw new ProbeError('closed');
    this.busy = true;
    const epoch = this.epoch;
    try {
      return await action(epoch);
    } catch (error) {
      const code = this.epoch !== epoch ? 'cancelled'
        : error instanceof ProbeError ? error.code : 'operation_failed';
      if (code !== 'cancelled' && code !== 'wrong_state') this.attention(code);
      throw new ProbeError(code);
    } finally {
      this.busy = false;
    }
  }

  async preview() {
    return this.exclusive(async epoch => {
      if (this.state !== 'Preview') throw new ProbeError('wrong_state');
      const s = await this.stable();
      const png = await this.page.screenshot({ type: 'png', clip: s.clip, timeout: 1500 });
      const after = await this.read();
      if (this.epoch !== epoch) throw new ProbeError('cancelled');
      if (JSON.stringify(after) !== JSON.stringify(s)) throw new ProbeError('target_changed');
      this.bound = targetKey(s);
      this.position = s.position;
      // Memory only: neither preview nor opening the browser creates a saved image.
      return { png, position: s.position, dimensions: [600, 480] };
    });
  }

  approvePreview(approved) {
    if (this.busy || this.state !== 'Preview' || !this.bound || approved !== true) throw new ProbeError('confirmation_required');
    this.state = 'Ready';
  }

  async start(confirmed) {
    return this.exclusive(async epoch => {
      if (this.state !== 'Ready' || confirmed !== true) throw new ProbeError('wrong_state');
      this.check(await this.stable(), epoch);
      this.state = 'Capturing';
    });
  }

  async capture() {
    return this.exclusive(async epoch => {
      if (this.state !== 'Capturing') throw new ProbeError('wrong_state');
      const before = await this.stable();
      this.check(before, epoch);
      this.captureRequests += 1;
      const png = await this.page.screenshot({ type: 'png', clip: before.clip, timeout: 1500 });
      const after = await this.read();
      this.check(after, epoch);
      if (JSON.stringify(before) !== JSON.stringify(after)) throw new ProbeError('target_changed');
      if (png.length > MAX_PNG) throw new ProbeError('image_too_large');
      const decoded = PNG.sync.read(png, { checkCRC: true });
      if (decoded.width !== 600 || decoded.height !== 480 || decoded.width * decoded.height > MAX_PIXELS) {
        throw new ProbeError('invalid_png');
      }
      let black = 0;
      let white = 0;
      for (let i = 0; i < decoded.data.length; i += 4) {
        if (decoded.data[i] < 8 && decoded.data[i + 1] < 8 && decoded.data[i + 2] < 8) black += 1;
        if (decoded.data[i] > 247 && decoded.data[i + 1] > 247 && decoded.data[i + 2] > 247) white += 1;
      }
      if (black / (decoded.width * decoded.height) > 0.98) throw new ProbeError('capture_rejected');
      const sha256 = hash(png);
      const flags = [];
      if (white / (decoded.width * decoded.height) > 0.98) flags.push('blank_candidate');
      if (this.images.some(image => image.sha256 === sha256)) flags.push('duplicate_candidate');
      this.check(await this.read(), epoch);
      const image = { id: this.images.length + 1, position: before.position, sha256, flags, bytes: png.length };
      image.file = `${String(image.id).padStart(6, '0')}.png`;
      // Only a successful exclusive create grants ownership for cancellation cleanup.
      // No existing or previously committed image is removed or overwritten.
      const filename = path.join(this.directory, image.file);
      await writeFile(filename, png, { flag: 'wx' });
      if (this.epoch !== epoch) {
        await unlink(filename);
        throw new ProbeError('cancelled');
      }
      // No await between the final cancellation check and the in-memory commit.
      this.images.push(image);
      this.lastCapturedPosition = before.position;
      if (this.epoch === epoch && flags.length) this.attention('image_review_required');
      return image;
    });
  }

  async advance() {
    return this.exclusive(async epoch => {
      if (this.state !== 'Capturing') throw new ProbeError('wrong_state');
      const before = await this.stable();
      this.check(before, epoch);
      if (this.lastCapturedPosition !== before.position) throw new ProbeError('capture_required');
      if (before.nextDisabled) { this.attention('end_candidate'); return { endCandidate: true }; }
      this.advanceRequests += 1;
      // Scoped official UI of the self-authored fixture; no global input or retry.
      await this.page.locator('#next').click({ timeout: 1500 });
      const deadline = Date.now() + 700;
      let after;
      do {
        after = await this.read();
        if (this.epoch !== epoch) throw new ProbeError('cancelled');
        if (targetKey(after) !== this.bound) throw new ProbeError('target_changed');
        if (after.position !== before.position) break;
        await sleep(40);
      } while (Date.now() < deadline);
      if (after.position !== before.position + 1) throw new ProbeError('advance_uncertain');
      const settled = await this.stable();
      if (this.epoch !== epoch) throw new ProbeError('cancelled');
      if (JSON.stringify(after) !== JSON.stringify(settled)) throw new ProbeError('display_unstable');
      this.position = after.position;
      return { position: this.position };
    });
  }

  pause() {
    if (this.state !== 'Capturing') throw new ProbeError('wrong_state');
    this.epoch += 1;
    this.state = 'Paused';
  }

  async confirmResume(confirmed) {
    return this.exclusive(async epoch => {
      if (this.state !== 'Paused' || confirmed !== true) throw new ProbeError('confirmation_required');
      this.state = 'ResumeCheck';
      this.check(await this.stable(), epoch);
      this.state = 'Ready';
    });
  }

  stop() {
    this.epoch += 1;
    this.state = 'Review';
  }

  receipt() {
    return {
      schemaVersion: 1, scope: 'self-authored-sample-only',
      playwright: require('playwright/package.json').version,
      browser: this.browser.version(), node: process.version,
      viewport: [1024, 768], sampleScreens: 12,
      state: this.state, reason: this.reason,
      captureRequests: this.captureRequests, advanceRequests: this.advanceRequests,
      images: this.images,
      windowsNonInterference: 'not-tested', kindle: 'not-tested',
    };
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.epoch += 1;
    // Never writes cookies, storageState, trace, HAR, URLs or raw exception strings.
    try { await this.browser.close(); } finally { await this.fixture.close(); }
  }
}
