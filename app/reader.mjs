import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { AppError } from './store-client.mjs';
import { visibleCaptureGeometry } from './visible-geometry.mjs';
import { translateCopy } from './ui/messages.mjs';

process.env.PLAYWRIGHT_BROWSERS_PATH ||= fileURLToPath(new URL('../artifacts/browsers/', import.meta.url));
const { chromium } = await import('playwright');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const MAX_CAPTURE_PIXELS = 16_000_000;
const MAX_CAPTURE_BYTES = 32 * 1024 * 1024;

function pngDimensions(bytes) {
  if (bytes.length < 24 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || bytes.subarray(12, 16).toString('ascii') !== 'IHDR') {
    throw new AppError('capture_png_invalid');
  }
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (!width || !height || width * height > MAX_CAPTURE_PIXELS || bytes.length > MAX_CAPTURE_BYTES) throw new AppError('capture_resolution_exceeds_limit');
  return [width, height];
}

// Read only the user-selected marker. A visible numeric field exposes its
// displayed value rather than a text child. Never read password/hidden inputs,
// arbitrary attributes, neighboring nodes, or service-internal state.
function markerText(element, { field, allowHidden = false }) {
  if (element.tagName === 'INPUT') {
    if (field !== 'position' || !['text', 'number', 'range'].includes(element.type)) return '';
    return element.value.trim();
  }
  const text = (allowHidden ? element.textContent : element.innerText) ?? '';
  return text.trim();
}

// Runs in the inspected document and returns booleans only. Actionability's
// ':visible' includes zero-opacity/offscreen nodes, which are not visible auth UI.
function authIndicators(root) {
  const doc = root?.nodeType === 9 ? root : root?.ownerDocument ?? document;
  const view = doc.defaultView;
  const present = node => {
    const style = view.getComputedStyle(node);
    if (['hidden', 'collapse'].includes(style.visibility)) return false;
    for (let parent = node; parent; parent = parent.parentElement) {
      const s = view.getComputedStyle(parent);
      if (s.display === 'none' || Number(s.opacity) === 0) return false;
    }
    return [...node.getClientRects()].some(r => r.width > 0 && r.height > 0
      && r.right > 0 && r.bottom > 0 && r.left < view.innerWidth && r.top < view.innerHeight);
  };
  return {
    password: [...doc.querySelectorAll('input[type="password"]')].some(present),
    modal: [...doc.querySelectorAll('[aria-modal="true"]')].some(present),
  };
}

// This function runs only inside the selected document. It returns a DOM
// selector, never text, book metadata or authentication state.
function selectedElementAt({ x, y, field }) {
  let element = document.elementFromPoint(x, y);
  if (!element || element.tagName === 'IFRAME') return null;
  if (field === 'next') element = element.closest('button, [role="button"], a') ?? element;
  if (field === 'reader') element = element.closest('canvas, img, svg, [role="img"]') ?? element;
  const parts = [];
  while (element && element.nodeType === 1) {
    if (element.id && document.querySelectorAll(`#${CSS.escape(element.id)}`).length === 1) { parts.unshift(`#${CSS.escape(element.id)}`); break; }
    let part = element.tagName.toLowerCase();
    const siblings = [...(element.parentElement?.children ?? [])].filter(s => s.tagName === element.tagName);
    if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(element) + 1})`;
    parts.unshift(part); element = element.parentElement;
  }
  const selector = parts.join(' > ');
  return selector && document.querySelectorAll(selector).length === 1 ? selector : null;
}

function uniqueDocumentSelector(element) {
  if (element.id && document.querySelectorAll(`#${CSS.escape(element.id)}`).length === 1) return `#${CSS.escape(element.id)}`;
  const parts = [];
  for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
    let part = node.tagName.toLowerCase();
    const siblings = [...(node.parentElement?.children ?? [])].filter(item => item.tagName === node.tagName);
    if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
    parts.unshift(part);
    const selector = parts.join(' > ');
    if (document.querySelectorAll(selector).length === 1) return selector;
  }
  return '';
}

// Scan only visible, user-facing structures in the inspected document. Return
// unique selectors only: marker text, page content and accessible names never
// leave the browser context. Semantic next labels take precedence over icon
// glyphs, whose left/right shape changes with reading direction.
function visibleConfigurationCandidates() {
  // Playwright serializes this function without its module's lexical scope.
  // Keep the selector builder in the evaluated document as well.
  function uniqueDocumentSelector(element) {
    if (element.id && document.querySelectorAll(`#${CSS.escape(element.id)}`).length === 1) return `#${CSS.escape(element.id)}`;
    const parts = [];
    for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
      let part = node.tagName.toLowerCase();
      const siblings = [...(node.parentElement?.children ?? [])].filter(item => item.tagName === node.tagName);
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      parts.unshift(part);
      const selector = parts.join(' > ');
      if (document.querySelectorAll(selector).length === 1) return selector;
    }
    return '';
  }
  const visible = element => {
    for (let parent = element; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility) || Number(style.opacity) === 0) return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0
      && rect.left < innerWidth && rect.top < innerHeight;
  };
  const once = elements => [...new Set(elements)].filter(visible).map(uniqueDocumentSelector).filter(Boolean);
  const text = element => (element.tagName === 'INPUT' ? element.value : element.innerText ?? '').trim();
  const painting = [...document.querySelectorAll('canvas, img, svg, [role="img"]')].filter(element => {
    const rect = element.getBoundingClientRect();
    return visible(element) && rect.width >= 160 && rect.height >= 120;
  });
  const regions = once(painting);
  const headings = [...document.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"]')]
    .filter(element => { const value = text(element); return visible(element) && value.length > 0 && value.length <= 500; });
  // Some reader layouts omit h1/ARIA heading semantics but expose a visible
  // title container. Use a single title-shaped marker only as a fallback; if
  // several remain, the caller reports ambiguity rather than guessing.
  const identityElements = headings.length ? headings : [...document.querySelectorAll('[id*="title" i], [class*="title" i], [data-testid*="title" i]')]
    .filter(element => { const value = text(element); return value.length > 0 && value.length <= 500; });
  const identities = once(identityElements);
  const positions = once([...document.querySelectorAll('output, [role="status"], input[type="number"], input[type="range"], input[type="text"], [id*="location" i], [id*="position" i], [data-testid*="location" i]')]
    .filter(element => element.tagName === 'INPUT'
      ? /^\s*\d+(?:\s*(?:[/／]|of)\s*\d+)?\s*$/i.test(element.value ?? '')
       : /^(?:(?:位置|ページ|location|page)\s*[:：]?\s*)?\d+(?:\s*[/／]\s*\d+|\s+of\s+\d+)?(?:\s*[・·—-]\s*\d+%)?$/i.test((element.innerText ?? '').trim())));
  const nextPattern = /^(?:次(?:へ|の(?:ページ|画面)(?:へ|に移動)?)|進む|(?:go to\s+)?next(?:\s+(?:page|screen))?|forward)$/i;
  const next = once([...document.querySelectorAll('button, [role="button"], a')].filter(element => {
    const label = (element.getAttribute('aria-label') ?? '').trim()
      || (element.getAttribute('title') ?? '').trim()
      || (element.innerText ?? '').trim();
    return nextPattern.test(label);
  }));
  return { regions, identities, positions, next };
}

export const sampleConfig = {
  frame: '', reader: '#sheet', next: '#next', identity: 'h1', position: '#position',
};

export function readerContextOptions({ sampleUrl, headless = false } = {}) {
  return {
    headless, viewport: { width: 1100, height: 850 }, deviceScaleFactor: 1,
    // The live service owns its standard rendering/cache worker. Blocking it
    // can leave a normal canvas black without any selection/capture occurring.
    // The self-authored fixture retains its deterministic worker-free policy.
    acceptDownloads: false, serviceWorkers: sampleUrl ? 'block' : 'allow',
  };
}

export async function configureReaderNetwork(context, sampleUrl) {
  // The real service owns its rendering/authentication/CDN dependencies. Do not
  // silently break that official browser UI with an app-invented domain filter.
  // This does not grant the site access to app files or the loopback API key.
  // The self-authored test fixture retains its explicit loopback-only policy.
  if (!sampleUrl) return;
  const origin = new URL(sampleUrl).origin;
  await context.route('**/*', route => new URL(route.request().url()).origin === origin
    ? route.continue() : route.abort('blockedbyclient'));
}

// The live adapter uses only visible official UI chosen by the user. Unknown
// layouts are rejected, not replaced by hidden APIs or image extraction.
export class Reader {
  static async open({ profile, sampleUrl, preconfiguredSample = true, headless = false, onChange, readGuard }) {
    const context = await chromium.launchPersistentContext(profile, readerContextOptions({ sampleUrl, headless }));
    try {
      await configureReaderNetwork(context, sampleUrl);
      const page = context.pages()[0] ?? await context.newPage();
      page.setDefaultTimeout(1800);
      const reader = new Reader(context, page, sampleUrl, onChange, preconfiguredSample);
      reader.readGuard = readGuard;
      await page.goto(sampleUrl ?? 'https://read.amazon.co.jp/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
      return reader;
    } catch (error) { await context.close(); throw error; }
  }

  constructor(context, page, sampleUrl, onChange, preconfiguredSample = true) {
    Object.assign(this, { context, page, sampleUrl, onChange });
    this.id = randomUUID();
    this.mappingRevision = 0;
    this.tabRevision = 0;
    this.selections = sampleUrl && preconfiguredSample
      ? Object.fromEntries(['reader', 'identity', 'position', 'next'].map(field => [field, { field, selector: sampleConfig[field], frame: '' }])) : {};
    this.generation = 0;
    this.captureScale = 1;
    this.scaleSession = null;
    this.scalePage = null;
    this.watchedPages = new WeakSet();
    this.pageLabels = new WeakMap();
    this.pageCount = 0;
    this.expectedPages = new Set(context.pages());
    this.pickedMarkers = {};
    this.readerCandidate = null;
    for (const existing of context.pages()) this.watchPage(existing);
    context.on('page', page => { this.watchPage(page); this.changed(); });
    context.on('close', () => { if (!this.closed) this.changed(); });
  }

  watchPage(page) {
    if (this.watchedPages.has(page)) return;
    this.watchedPages.add(page);
    this.pageLabels.set(page, { id: randomUUID(), label: `専用タブ ${++this.pageCount}` });
    page.setDefaultTimeout(1800);
    page.on('close', () => { if (page === this.page) void this.clearReaderCandidate(); this.changed(); });
    page.on('framenavigated', frame => {
      const candidate = this.readerCandidate;
      if (page === this.page && candidate && (frame === page.mainFrame() || frame === candidate.frame)) void this.clearReaderCandidate();
      this.changed();
    });
    page.on('download', download => { void download.cancel(); this.changed(); });
  }

  candidatePages() {
    return this.context.pages().filter(page => {
      if (page.isClosed()) return false;
      try {
        const url = new URL(page.url());
        return this.sampleUrl ? page.url() === this.sampleUrl : url.protocol === 'https:' && url.hostname === 'read.amazon.co.jp';
      } catch { return false; }
    });
  }

  tabs() {
    return this.candidatePages().map(page => ({ ...this.pageLabels.get(page) }));
  }

  selectedTabId() {
    const candidates = this.candidatePages();
    const chosen = this.explicitPage ? candidates.includes(this.explicitPage) ? this.explicitPage : null
      : candidates.length === 1 ? candidates[0] : null;
    return chosen ? this.pageLabels.get(chosen).id : null;
  }

  selectTab(id) {
    const chosen = this.candidatePages().find(page => this.pageLabels.get(page).id === id);
    if (!chosen) throw new AppError('invalid_reader_tab');
    if (chosen !== this.explicitPage) {
      void this.clearReaderCandidate();
      for (const marker of Object.values(this.pickedMarkers)) void marker.handle?.dispose().catch(() => {});
      this.pickedMarkers = {};
      this.selections = {};
      this.config = null;
      this.selectionFailure = null;
      this.mappingRevision += 1;
      this.tabRevision += 1;
      this.explicitPage = chosen;
      this.page = chosen;
      this.changed();
    }
    this.expectedPages = new Set(this.context.pages());
  }

  async setCaptureScale(scale) {
    if (![1, 2].includes(scale)) throw new AppError('invalid_capture_scale');
    if (this.page.isClosed()) throw new AppError('target_changed');
    const viewport = this.page.viewportSize();
    if (!viewport) throw new AppError('capture_scale_unavailable');
    if (this.scaleSession && this.scalePage !== this.page) {
      await this.scaleSession.detach().catch(() => {});
      this.scaleSession = null; this.scalePage = null;
    }
    try {
      this.scaleSession ??= await this.context.newCDPSession(this.page);
      this.scalePage = this.page;
      await this.scaleSession.send('Emulation.setDeviceMetricsOverride', {
        width: viewport.width, height: viewport.height, screenWidth: viewport.width, screenHeight: viewport.height,
        deviceScaleFactor: scale, mobile: false,
      });
      const actual = await this.page.evaluate(() => devicePixelRatio);
      if (actual !== scale) throw new AppError('capture_scale_unavailable');
      if (this.captureScale !== scale) {
        this.captureScale = scale;
        this.bound = null;
        this.generation += 1;
      }
      return actual;
    } catch (error) {
      if (error instanceof AppError) throw error;
      this.scaleSession?.detach().catch(() => {});
      this.scaleSession = null; this.scalePage = null;
      throw new AppError('capture_scale_unavailable');
    }
  }

  async adoptVisibleReaderPage() {
    const candidates = this.candidatePages();
    // Once explicitly selected, a missing/closed target must never fall back to
    // a different page, even when that is the only remaining candidate.
    const chosen = this.explicitPage ?? (candidates.length === 1 ? candidates[0] : null);
    if (!chosen || !candidates.includes(chosen)) throw new AppError('select_reader_tab');
    await this.assertReaderDocument(chosen);
    // Called only by explicit configuration/picking, never by acquisition or
    // resume/start. Known inactive library tabs may remain open. A new page,
    // navigation or closure after binding still invalidates the live target.
    if (chosen !== this.page) { this.page = chosen; this.changed(); }
    this.watchPage(chosen);
    this.expectedPages = new Set(this.context.pages());
  }

  async assertReaderDocument(page) {
    // A library tab can remain explicitly selected after a book opens in a
    // separate tab. Never reinterpret that as missing reader CSS or silently
    // choose a different book. The sample marker represents this tab lifecycle,
    // not copied Kindle markup or a guess about its internal rendering.
    const library = this.sampleUrl
      ? await page.locator('[data-ktz-sample-library="true"]').count() === 1
      : /^\/kindle-library(?:\/|$)/.test(new URL(page.url()).pathname);
    if (library) {
      this.bound = null;
      const error = new AppError('reader_library_selected', { field: 'reader', cause: 'library_selected' });
      error.stage = 'reader_target_check';
      throw error;
    }
  }

  async autoConfiguration() {
    const page = this.page, generation = this.generation;
    const deadline = Date.now() + 1200;
    for (;;) {
      try { return await this.scanAutoConfiguration(); }
      catch (error) {
        // Waiting is observation-only. Never reveal chrome using OS input,
        // synthetic clicks, CSS changes, or an arbitrary hidden text fallback.
        if (error.code !== 'reader_auto_ambiguous' || error.detail?.cause !== 'not_found') throw error;
        if (Date.now() >= deadline) {
          error.stage = 'auto_visibility_wait';
          throw error;
        }
        await sleep(150);
        if (page !== this.page || generation !== this.generation || page.isClosed()) throw new AppError('target_changed');
      }
    }
  }

  async scanAutoConfiguration() {
    if (!this.explicitPage || !this.candidatePages().includes(this.explicitPage)) throw new AppError('select_reader_tab');
    await this.adoptVisibleReaderPage();
    const page = this.page;
    const pageUrl = page.url();
    const mainFrame = page.mainFrame();
    const candidates = { regions: [], identities: [], positions: [], next: [] };
    const frames = page.frames().filter(frame => frame === mainFrame || frame.parentFrame() === mainFrame);
    for (const frame of frames) {
      if (frame.isDetached()) continue;
      let frameSelector = '', frameElement, frameVisible = false;
      try {
        if (frame !== mainFrame) {
          frameElement = await frame.frameElement();
          frameSelector = await frameElement.evaluate(uniqueDocumentSelector);
          const box = await frameElement.boundingBox();
          frameVisible = Boolean(frameSelector && box && box.width >= 160 && box.height >= 120 && await frameElement.isVisible());
          if (!frameSelector) continue;
        }
        const found = await frame.evaluate(visibleConfigurationCandidates);
        for (const [collection, values] of Object.entries(found)) {
          if (collection === 'regions' && frame !== mainFrame && frameVisible && values.length === 1) {
            // A unique large painting surface inside a visible, dedicated
            // reader frame is represented by that frame's actual viewport.
            // This captures only pixels visible in the frame and includes its
            // displayed toolbar for the user's preview, instead of silently
            // stripping or bypassing it.
            candidates.regions.push({ selector: frameSelector, frame: '' });
          } else {
            candidates[collection].push(...values.map(selector => ({ selector, frame: frameSelector })));
          }
        }
      } catch (error) {
        if (!frame.isDetached() && !page.isClosed()) { console.log(`KTZ_AUTO_SCAN_ERROR:${frame === mainFrame ? 'main' : 'child'}:${error?.name ?? 'unknown'}`); throw new AppError('target_changed'); }
      } finally {
        await frameElement?.dispose().catch(() => {});
      }
    }
    if (page !== this.page || page.isClosed() || page.url() !== pageUrl || this.explicitPage !== page || !this.candidatePages().includes(page)) {
      console.log(`KTZ_AUTO_TARGET_CHANGED:${page === this.page}:${!page.isClosed()}:${page.url() === pageUrl}:${this.explicitPage === page}:${this.candidatePages().includes(page)}`);
      throw new AppError('target_changed');
    }
    for (const [collection, field] of Object.entries({ regions: 'reader', identities: 'identity', positions: 'position', next: 'next' })) {
      if (candidates[collection].length !== 1) {
        throw new AppError('reader_auto_ambiguous', { field, cause: candidates[collection].length === 0 ? 'not_found' : 'not_unique' });
      }
    }
    const chosen = Object.fromEntries(Object.entries({
      reader: candidates.regions[0], identity: candidates.identities[0],
      position: candidates.positions[0], next: candidates.next[0],
    }).map(([field, candidate]) => [field, candidate]));
    const config = { frame: '', ...Object.fromEntries(Object.entries(chosen).map(([field, candidate]) => [field, candidate.selector])), frames: {} };
    for (const [field, candidate] of Object.entries(chosen)) if (candidate.frame) config.frames[field] = candidate.frame;
    this.selections = Object.fromEntries(Object.entries(chosen).map(([field, candidate]) => [field, { field, selector: candidate.selector, frame: candidate.frame }]));
    this.selectionFailure = null;
    this.mappingRevision += 1;
    return config;
  }

  async clearPickedMarkers(fields = Object.keys(this.pickedMarkers)) {
    for (const field of fields) {
      const marker = this.pickedMarkers[field];
      delete this.pickedMarkers[field];
      await marker?.handle?.dispose().catch(() => {});
    }
  }

  changed() {
    this.generation += 1;
    this.bound = null;
    void this.clearPickedMarkers();
    this.onChange?.();
  }

  invalidateOutputSettings() {
    this.generation += 1;
    this.bound = null;
    void this.clearPickedMarkers();
  }

  clearReaderCandidate() {
    const candidate = this.readerCandidate;
    this.readerCandidate = null;
    return candidate?.handle?.dispose().catch(() => {}) ?? Promise.resolve();
  }

  async pick(field, { step = '', language = 'ja' } = {}) {
    if (!['reader', 'next', 'identity', 'position'].includes(field)) throw new AppError('invalid_picker_field');
    if (field === 'reader') await this.clearReaderCandidate();
    const cancelEpoch = this.pickCancelEpoch ?? 0;
    await this.adoptVisibleReaderPage();
    if (cancelEpoch !== (this.pickCancelEpoch ?? 0)) throw new AppError('picker_cancelled');
    if (this.page.isClosed()) throw new AppError('target_changed');
    const host = new URL(this.page.url());
    if (!this.sampleUrl && (host.protocol !== 'https:' || host.hostname !== 'read.amazon.co.jp')) throw new AppError('auth_or_target_changed');
    const selectedPage = this.page;
    const selectedUrl = this.page.url();
    const labels = { reader: '読書領域', next: '次へボタン', identity: '本の識別表示', position: '位置表示' };
    const instructions = {
      reader: 'ページ画像の内側をクリックしてください。操作バー・目次・余白の外側は選びません。',
      identity: '画面に表示されている書名の文字をクリックしてください。',
      position: 'ページ・位置番号の文字か数値欄をクリックしてください。',
      next: '次ページの矢印をクリックしてください。この指定ではページを送りません。',
    };
    delete this.selections[field];
    this.pickField = field;
    this.selectionFailure = null;
    this.mappingRevision += 1;
    await this.pickedMarkers[field]?.handle?.dispose().catch(() => {});
    delete this.pickedMarkers[field];
    const stage = value => { this.pickStage = value; console.log(`KTZ_PICK:${value}`); };
    let surface, readerCandidateHandle;
    // An isolated selection document receives the whole gesture. Events do not
    // propagate into pre-existing service handlers on the parent document.
    try {
      stage('preparing');
      surface = (await this.page.evaluateHandle(() => {
        window.__ktzPicker?.();
        const surface = document.createElement('iframe');
        surface.dataset.ktzSelection = 'true';
        surface.setAttribute('sandbox', 'allow-scripts');
        surface.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;border:0;z-index:2147483647;background:transparent;pointer-events:auto;';
        surface.style.colorScheme = getComputedStyle(document.documentElement).colorScheme;
        surface.srcdoc = '<!doctype html><html><body><div id="ktzPickHint"></div></body></html>';
        document.documentElement.append(surface);
        return surface;
      })).asElement();
      const selectionFrame = await surface?.contentFrame();
      if (!selectionFrame) throw new AppError('picker_surface_unavailable');
      await selectionFrame.locator('#ktzPickHint').waitFor({ state: 'attached', timeout: 2500 });
      const colorScheme = await surface.evaluate(element => getComputedStyle(element).colorScheme);
      const hintText = translateCopy(`${step}「${labels[field]}」 ${instructions[field]} Escで取消（90秒）。`, language);
      const choosing = selectionFrame.evaluate(({ hintText, colorScheme }) => new Promise(resolve => {
        const controller = new AbortController();
        // Chromium makes iframe canvases opaque when parent/child color schemes
        // differ. Match the parent and explicitly preserve the transparent root.
        document.documentElement.style.colorScheme = colorScheme;
        document.documentElement.style.background = 'transparent';
        document.body.style.cssText = 'margin:0;width:100vw;height:100vh;background:rgba(70,130,210,.06);cursor:crosshair;';
        const hint = document.querySelector('#ktzPickHint');
        hint.textContent = hintText;
        hint.style.cssText = 'position:fixed;left:10px;right:10px;bottom:10px;padding:12px;background:#ffffff;color:#132238;border:2px solid #2364b0;border-radius:8px;font:16px system-ui;pointer-events:none;';
        const finish = value => { clearTimeout(timer); controller.abort(); resolve(value); };
        const timer = setTimeout(() => finish(null), 90_000);
        document.addEventListener('click', e => { if (e.isTrusted) { e.preventDefault(); e.stopImmediatePropagation(); finish({ x: e.clientX, y: e.clientY }); } }, { signal: controller.signal, capture: true });
        document.addEventListener('keydown', e => { if (e.key === 'Escape' && e.isTrusted) { e.preventDefault(); e.stopImmediatePropagation(); finish(null); } }, { signal: controller.signal, capture: true });
        // DOM-only focus in the explicitly requested selection surface. This
        // neither activates an OS window nor affects acquisition focus policy.
        document.body.tabIndex = -1;
        document.body.focus({ preventScroll: true });
        hint.dataset.ready = 'true';
      }), { hintText, colorScheme }).catch(() => null);
      await selectionFrame.locator('#ktzPickHint[data-ready="true"]').waitFor({ state: 'attached', timeout: 2500 });
      await surface.evaluate(element => { window.__ktzPicker = () => element.remove(); });
      if (cancelEpoch !== (this.pickCancelEpoch ?? 0)) throw new AppError('picker_cancelled');
      stage('waiting_click');
      const point = await choosing;
      if (!point || cancelEpoch !== (this.pickCancelEpoch ?? 0)) throw new AppError('picker_cancelled');
      stage('click_received');
      await surface.evaluate(element => element.remove());
      const frameHit = await this.page.evaluate(({ x, y }) => {
        const element = document.elementFromPoint(x, y);
        if (element?.tagName !== 'IFRAME') return null;
        const frames = [...document.querySelectorAll('iframe')];
        const selector = element.id && document.querySelectorAll(`#${CSS.escape(element.id)}`).length === 1 ? `#${CSS.escape(element.id)}` : `iframe >> nth=${frames.indexOf(element)}`;
        const r = element.getBoundingClientRect();
        return { selector, x: (x - r.x) / (r.width / element.offsetWidth) - element.clientLeft, y: (y - r.y) / (r.height / element.offsetHeight) - element.clientTop };
      }, point);
      let scope = this.page;
      if (frameHit) {
        const handle = await this.page.locator(frameHit.selector).elementHandle();
        scope = await handle?.contentFrame();
        if (!scope || scope.parentFrame() !== this.page.mainFrame()) throw new AppError('picker_frame_unsupported');
      }
      const selector = await scope.evaluate(selectedElementAt, { ...(frameHit ?? point), field });
      if (!selector) throw new AppError('picker_element_unknown');
      const locator = scope.locator(selector);
      if (await locator.count() !== 1 || !await locator.isVisible()) throw new AppError('reader_ui_unknown', { field, cause: 'hidden' });
      if (['identity', 'position'].includes(field)) {
        const text = await locator.evaluate(markerText, { field });
        if (!text) throw new AppError('display_or_position_unknown', { field, cause: 'label_empty' });
        if (text.length > (field === 'identity' ? 500 : 200)) throw new AppError('display_or_position_unknown', { field, cause: 'label_too_long' });
      }
      if (field === 'reader') {
        readerCandidateHandle = await locator.elementHandle();
        if (!readerCandidateHandle) throw new AppError('target_changed');
        const geometry = await visibleCaptureGeometry(this.page, locator);
        if (geometry.clip.width < 16 || geometry.clip.height < 16) throw new AppError('display_or_position_unknown', { field, cause: 'area_too_small' });
        if (!geometry.unobscured) {
          const stillSelected = selectedPage === this.page && !selectedPage.isClosed() && selectedPage.url() === selectedUrl
            && await locator.evaluate((element, expected) => element.isConnected && element === expected, readerCandidateHandle).catch(() => false);
          if (!stillSelected) throw new AppError('target_changed');
          this.readerCandidate = { page: selectedPage, url: selectedUrl, frame: scope, frameSelector: frameHit?.selector ?? '', selector, handle: readerCandidateHandle };
          readerCandidateHandle = null;
          throw new AppError('auth_or_overlay_detected', { field, cause: 'blocked_hit' });
        }
        await readerCandidateHandle.dispose();
        readerCandidateHandle = null;
      }
      if (['identity', 'position', 'next'].includes(field)) {
        const handle = await scope.locator(selector).elementHandle();
        await this.pickedMarkers[field]?.handle?.dispose().catch(() => {});
        this.pickedMarkers[field] = {
          page: this.page, generation: this.generation, selector,
          frame: frameHit?.selector ?? '', handle, point,
        };
      }
      stage('selected');
      const picked = { field, selector, frame: frameHit?.selector ?? '' };
      this.selections[field] = picked;
      this.mappingRevision += 1;
      return picked;
    } catch (error) {
      if (field === 'reader' && !(error instanceof AppError && error.code === 'auth_or_overlay_detected' && error.detail?.cause === 'blocked_hit')) await this.clearReaderCandidate();
      this.selectionFailure = error instanceof AppError ? { field, cause: error.detail?.cause ?? error.code } : { field, cause: 'selection_failed' };
      stage(error instanceof AppError && ['picker_cancelled', 'picker_element_unknown', 'picker_frame_unsupported', 'picker_surface_unavailable'].includes(error.code) ? error.code : 'failed');
      throw error;
    } finally {
      this.pickField = null;
      await readerCandidateHandle?.dispose().catch(() => {});
      await surface?.evaluate(element => element.remove()).catch(() => {});
      await surface?.dispose().catch(() => {});
      await this.page.evaluate(() => window.__ktzPicker?.()).catch(() => {});
      await this.page.evaluate(() => { delete window.__ktzPicker; }).catch(() => {});
    }
  }

  async expandReader() {
    const candidate = this.readerCandidate;
    if (!candidate) throw new AppError('reader_candidate_unavailable');
    let parentHandle;
    const stale = async cause => {
      await this.clearReaderCandidate();
      this.selectionFailure = { field: 'reader', cause };
      this.mappingRevision += 1;
      throw new AppError('reader_candidate_stale');
    };
    try {
      if (candidate.page !== this.page || candidate.page !== this.explicitPage || candidate.page.isClosed()) return await stale('candidate_target_changed');
      if (candidate.page.url() !== candidate.url) return await stale('candidate_navigation_changed');
      if (candidate.frame !== candidate.page && candidate.frame.isDetached()) return await stale('candidate_frame_detached');
      if (this.context.pages().length !== this.expectedPages.size || this.context.pages().some(page => !this.expectedPages.has(page))) return await stale('candidate_tabs_changed');
      await this.adoptVisibleReaderPage();
      const original = candidate.frame.locator(candidate.selector);
      if (await original.count() !== 1) return await stale('candidate_element_missing');
      if (!candidate.allowHidden && !await original.isVisible()) return await stale('candidate_element_hidden');
      if (!await original.evaluate((element, expected) => element.isConnected && element === expected, candidate.handle).catch(() => false)) return await stale('candidate_element_replaced');
      // A layout-only wrapper has no capture box. Skip only those wrappers,
      // not hidden content, document roots or frame boundaries. The first
      // rendered ancestor still passes the normal auth/visible/hit checks.
      const steps = await candidate.handle.evaluate(element => {
        let depth = 0;
        for (let parent = element.parentElement; parent && depth < 32; parent = parent.parentElement) {
          depth += 1;
          if (parent === document.body || parent === document.documentElement) return 0;
          const style = getComputedStyle(parent), rect = parent.getBoundingClientRect();
          if (style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility) || Number(style.opacity) === 0) return 0;
          if (style.display !== 'contents' && rect.width > 0 && rect.height > 0) return depth;
        }
        return 0;
      });
      if (!steps) {
        await this.clearReaderCandidate();
        this.selectionFailure = { field: 'reader', cause: 'candidate_parent_not_rendered' };
        this.mappingRevision += 1;
        throw new AppError('reader_candidate_parent_not_rendered');
      }
      parentHandle = (await candidate.handle.evaluateHandle((element, depth) => {
        while (depth-- > 0 && element) element = element.parentElement;
        return element;
      }, steps)).asElement();
      if (!parentHandle) return await stale('candidate_parent_missing');
      const selector = `${candidate.selector} >> xpath=${Array(steps).fill('..').join('/')}`;
      const parent = candidate.frame.locator(selector);
      if (await parent.count() !== 1) return await stale('candidate_parent_not_unique');
      if (!await parent.evaluate((element, expected) => element.isConnected && element === expected, parentHandle).catch(() => false)) return await stale('candidate_parent_replaced');
      const rendered = await parent.evaluate(element => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.display !== 'contents'
          && !['hidden', 'collapse'].includes(style.visibility) && Number(style.opacity) !== 0
          && rect.width > 0 && rect.height > 0;
      });
      const auth = await parent.evaluate(authIndicators);
      if (auth.password || auth.modal) {
        this.selectionFailure = { field: 'reader', cause: auth.password ? 'reader_password' : 'reader_modal' };
        throw new AppError('auth_or_overlay_detected', { field: 'reader', cause: auth.password ? 'reader_password' : 'reader_modal' });
      }
      if (!rendered) {
        await this.clearReaderCandidate();
        this.selectionFailure = { field: 'reader', cause: 'candidate_parent_not_rendered' };
        this.mappingRevision += 1;
        throw new AppError('reader_candidate_parent_not_rendered');
      }
      const geometry = await visibleCaptureGeometry(this.page, parent);
      if (geometry.clip.width < 16 || geometry.clip.height < 16) throw new AppError('display_or_position_unknown', { field: 'reader', cause: 'area_too_small' });
      if (!geometry.unobscured) {
        await this.clearReaderCandidate();
        this.readerCandidate = { ...candidate, selector, handle: parentHandle, allowHidden: false };
        parentHandle = null;
        this.selectionFailure = { field: 'reader', cause: 'blocked_hit' };
        throw new AppError('auth_or_overlay_detected', { field: 'reader', cause: 'blocked_hit' });
      }

      this.selections.reader = { field: 'reader', selector, frame: candidate.frameSelector };
      this.selectionFailure = null;
      this.mappingRevision += 1;
      this.bound = null;
      this.generation += 1;
      await this.clearReaderCandidate();
      return { field: 'reader', selector, frame: candidate.frameSelector };
    } catch (error) {
      if (error instanceof AppError && error.code !== 'auth_or_overlay_detected') {
        if (!['reader_candidate_unavailable', 'reader_candidate_parent_not_rendered'].includes(error.code)) await this.clearReaderCandidate();
      } else if (error instanceof AppError && error.code === 'auth_or_overlay_detected' && error.detail?.cause !== 'blocked_hit') {
        await this.clearReaderCandidate();
      }
      throw error;
    } finally {
      await parentHandle?.dispose().catch(() => {});
    }
  }

  async cancelPick() {
    this.pickCancelEpoch = (this.pickCancelEpoch ?? 0) + 1;
    await this.clearReaderCandidate();
    await this.page.evaluate(() => window.__ktzPicker?.()).catch(() => {});
  }

  async configure(config) {
    await this.adoptVisibleReaderPage();
    if (!config || typeof config !== 'object') throw new AppError('reader_configuration_required');
    for (const key of ['frame', 'reader', 'next', 'identity', 'position']) {
      if (typeof config[key] !== 'string' || config[key].length > 400 || (key !== 'frame' && !config[key].trim())) throw new AppError('reader_configuration_required');
    }
    const nextConfig = Object.fromEntries(['frame', 'reader', 'next', 'identity', 'position'].map(key => [key, config[key].trim()]));
    if (config.frames) {
      nextConfig.frames = {};
      for (const key of ['reader', 'next', 'identity', 'position']) {
        if (config.frames[key] !== undefined) {
          if (typeof config.frames[key] !== 'string' || config.frames[key].length > 400) throw new AppError('reader_configuration_required');
          nextConfig.frames[key] = config.frames[key];
        }
      }
    }
    const stale = Object.entries(this.pickedMarkers).filter(([key, marker]) =>
      marker.page !== this.page || marker.generation !== this.generation
      || marker.frame !== (nextConfig.frames?.[key] ?? nextConfig.frame));
    await this.clearPickedMarkers(stale.map(([key]) => key));
    this.config = nextConfig;
    this.bound = null;
    // Recovery belongs to this explicit configuration/preview only. Acquisition
    // and approval must not inherit a wait policy from an earlier call.
    return this.preview({ page: this.page, generation: this.generation, config: nextConfig, deadline: Date.now() + 1200 });
  }

  isKindleChromeConfiguration() {
    const config = this.config;
    return Boolean(config && !config.frame && !Object.values(config.frames ?? {}).some(Boolean)
      && config.reader === '#readerChromeTitle >> xpath=ancestor::div[5]'
      && config.identity === '#readerChromeTitle' && config.position === 'input[type="range"]'
      && config.next === 'button[aria-label*="次"], button[aria-label*="next" i]');
  }

  async revealKindleChrome(recovery) {
    // Explicit preview only: never inherited by approval or acquisition. This
    // attempts DOM-only pointer motion, not an OS/browser mouse input, click,
    // visibility override, hidden-value read, or authentication operation.
    if (this.page !== recovery.page || this.generation !== recovery.generation || this.config !== recovery.config) throw new AppError('target_changed');
    const config = this.config;
    if (!this.isKindleChromeConfiguration()) return 'not_preset';
    const auth = await this.page.evaluate(authIndicators);
    if (auth.password || auth.modal) return 'auth_visible';
    const fields = ['reader', 'identity', 'position', 'next'];
    const locators = fields.map(field => this.page.locator(config[field]));
    if ((await Promise.all(locators.map(locator => locator.count()))).some(count => count !== 1)) return 'markers_not_unique';
    const handles = await Promise.all(locators.map(locator => locator.elementHandle()));
    try {
      if (handles.some(handle => !handle)) return 'no_handles';
      return await this.page.evaluate(([region, identity, position, next]) => {
        const visible = element => {
          const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
          return element.isConnected && rect.width >= 16 && rect.height >= 16
            && style.display !== 'none' && style.visibility === 'visible' && Number(style.opacity) > 0;
        };
        if (region.tagName !== 'DIV' || !visible(region)) return 'region_hidden';
        if (![identity, position, next].every(element => element.isConnected && region.contains(element))) return 'not_shared';
        const label = next.getAttribute('aria-label') ?? '';
        if (!/次|next/i.test(label) || /前|戻|previous|back/i.test(label)) return 'next_direction';
        const surfaces = [...region.querySelectorAll('canvas, img, iframe')].filter(visible);
        if (!surfaces.length) return 'no_surface';
        const rect = region.getBoundingClientRect();
        const x = Math.max(0, rect.left) + (Math.min(innerWidth, rect.right) - Math.max(0, rect.left)) / 2;
        const y = Math.max(0, rect.top) + Math.min(8, (Math.min(innerHeight, rect.bottom) - Math.max(0, rect.top)) / 2);
        const hit = document.elementFromPoint(x, y);
        if (!hit || !region.contains(hit) || next.contains(hit) || position.contains(hit)
          || hit.closest('button, input, a, [role="button"], [contenteditable="true"]')) return 'hit_blocked';
        // Kindle may use a non-interactive DIV over the actual painting frame.
        // The point must still lie over a rendered surface, not a toolbar,
        // navigation control, outside overlay, or arbitrary empty layout area.
        if (!surfaces.some(surface => {
          const box = surface.getBoundingClientRect();
          return x >= box.left && x < box.right && y >= box.top && y < box.bottom;
        }) || !['DIV', 'SPAN', 'CANVAS', 'IMG', 'IFRAME'].includes(hit.tagName)) return 'hit_blocked';
        // A single DOM-only entry/motion sequence near the top of the visible
        // reading surface can notify official auto-hiding chrome handlers.
        // Never set CSS, focus, a trusted-event flag, or read a hidden value.
        for (const type of ['pointerover', 'pointermove']) hit.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, pointerType: 'mouse' }));
        for (const type of ['mouseover', 'mousemove']) hit.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y }));
        return 'dispatched';
      }, handles);
    } finally { await Promise.all(handles.map(handle => handle?.dispose().catch(() => {}))); }
  }

  async read(recovery = null) {
    if (this.readGuard) await this.readGuard();
    const pages = this.context.pages();
    if (!this.config || this.page.isClosed() || pages.length !== this.expectedPages.size || pages.some(page => !this.expectedPages.has(page))) throw new AppError('target_changed');
    await this.assertReaderDocument(this.page);
    const url = new URL(this.page.url());
    if (this.sampleUrl ? this.page.url() !== this.sampleUrl : url.protocol !== 'https:' || url.hostname !== 'read.amazon.co.jp') throw new AppError('auth_or_target_changed');
    // Only explicitly configured visible elements are read; no cookies, console,
    // network bodies, hidden service state or complete DOM is collected.
    const markerTexts = {};
    const visible = async key => {
      const selector = this.config[key];
      const frame = this.config.frames?.[key] ?? this.config.frame;
      const scope = frame ? this.page.frameLocator(frame) : this.page;
      let locator = scope.locator(selector);
      const reject = cause => {
        console.log(`KTZ_READ:${key}:${cause}`);
        throw new AppError('reader_ui_unknown', { field: key, cause });
      };
      let count;
      try { count = await locator.count(); }
      catch { reject('invalid_selector'); }
      // Responsive reader chrome may retain a hidden duplicate next control.
      // Never choose the first match: require exactly one visible candidate;
      // bound-node identity, direction, geometry and hit checks still apply.
      if (key === 'next' && count > 1) {
        const visibleNext = locator.filter({ visible: true });
        if (await visibleNext.count() === 1) { locator = visibleNext; count = 1; }
      }
      if (count !== 1) reject(count === 0 ? 'not_found' : 'not_unique');
      const picked = this.pickedMarkers[key];
      const frameSelector = this.config.frames?.[key] ?? this.config.frame;
      // Selectors are only lookup expressions, not node identity. A preset or
      // saved mapping may resolve the exact node the user visibly inspected via
      // a different but equivalent selector; the handle comparison is the
      // authority, fenced by the same page, frame mapping and generation.
      const evidenceMatches = picked?.page === this.page && picked.generation === this.generation
        && picked.frame === frameSelector;
      const same = evidenceMatches && await locator.evaluate((element, original) => element === original, picked.handle).catch(() => false);
      if (same && ['identity', 'position'].includes(key)) markerTexts[key] = await locator.evaluate(markerText, { field: key, allowHidden: true });
      if (!await locator.isVisible()) {
        if (same && ['identity', 'position'].includes(key)) {
          // Only the exact node observed while visibly inspecting this mapping
          // may temporarily hide. Read its current displayed value, never a
          // cached string or a neighboring/hidden service API.
        } else if (same && key === 'next' && (!recovery || picked.point && !this.isKindleChromeConfiguration())) {
          // Normal page-local hover may reveal an auto-hiding official control.
          // Preserve that explicit picker opt-in outside the DOM-only Kindle
          // preset; a preview wait policy must not silently disable it.
          // Do not force CSS visibility or dispatch a hidden/synthetic click.
          if (picked.point) await this.page.mouse.move(picked.point.x, picked.point.y);
          await locator.waitFor({ state: 'visible', timeout: 700 }).catch(() => {});
          if (!await locator.isVisible()) reject('hidden');
        } else if (recovery && ['identity', 'position', 'next'].includes(key)) {
          recovery.initialHiddenField ??= key;
          if (!recovery.revealAttempted) {
            recovery.revealAttempted = true;
            recovery.revealObservation = await this.revealKindleChrome(recovery);
          }
          if (this.page !== recovery.page || this.generation !== recovery.generation || this.config !== recovery.config || this.page.isClosed()) throw new AppError('target_changed');
          while (!await locator.isVisible() && Date.now() < recovery.deadline) {
            await sleep(100);
            if (this.page !== recovery.page || this.generation !== recovery.generation || this.config !== recovery.config || this.page.isClosed()) throw new AppError('target_changed');
            const currentCount = await locator.count();
            if (currentCount !== 1) reject(currentCount === 0 ? 'not_found' : 'not_unique');
          }
          if (!await locator.isVisible()) {
            const error = new AppError('reader_ui_unknown', { field: key, cause: 'hidden' });
            error.stage = 'preview_visibility_wait';
            error.recoveryObservation = recovery.revealObservation;
            throw error;
          }
        } else reject('hidden');
      }
      if (['identity', 'position', 'next'].includes(key) && !same) {
        // A bound preview owns these exact nodes. Only a new explicit preview
        // may establish evidence for a replacement, even if its text is equal.
        if (this.bound) throw new AppError('target_changed');
        // A preset and a manually configured selector acquire identical,
        // short-lived evidence only after this actual visible-node check.
        // Initial hidden content therefore remains untrusted.
        const handle = await locator.elementHandle();
        if (!handle) reject('not_found');
        const previous = this.pickedMarkers[key];
        this.pickedMarkers[key] = {
          page: this.page, generation: this.generation, selector, frame: frameSelector,
          handle, point: previous?.point ?? null,
        };
        await previous?.handle?.dispose().catch(() => {});
      }
      return locator;
    };
    const region = await visible('reader');
    const identity = await visible('identity');
    const position = await visible('position');
    const next = await visible('next');
    // The measured Kindle selector is only meaningful when the fifth div is
    // the shared visible reader chrome, not an unrelated outer layout shell.
    // Recheck on every read (including acquisition), not only preset selection.
    if (this.config.reader === '#readerChromeTitle >> xpath=ancestor::div[5]') {
      const handles = await Promise.all([identity, position, next].map(locator => locator.elementHandle()));
      try {
        const shared = await region.evaluate((element, markers) =>
          element.tagName === 'DIV' && markers.every(marker => marker && element.contains(marker))
          && [...element.querySelectorAll('canvas, img, iframe')].some(surface => {
            const r = surface.getBoundingClientRect(), style = getComputedStyle(surface);
            return r.width >= 16 && r.height >= 16 && style.visibility === 'visible' && style.display !== 'none';
          }), handles);
        if (!shared) throw new AppError('reader_ui_unknown', { field: 'reader', cause: 'kindle_chrome_structure_changed' });
        const direction = await next.getAttribute('aria-label');
        if (!direction || /前|戻|previous|back/i.test(direction)) {
          throw new AppError('reader_ui_unknown', { field: 'next', cause: 'kindle_chrome_structure_changed' });
        }
      } finally { await Promise.all(handles.map(handle => handle?.dispose())); }
    }
    const geometry = await visibleCaptureGeometry(this.page, region);
    const clip = geometry.clip;
    const identityText = markerTexts.identity ?? await identity.evaluate(markerText, { field: 'identity' });
    const positionText = markerTexts.position ?? await position.evaluate(markerText, { field: 'position' });
    const viewport = this.page.viewportSize();
    const invalidDisplay = (field, cause) => { throw new AppError('display_or_position_unknown', { field, cause }); };
    if (!identityText) invalidDisplay('identity', 'label_empty');
    if (!positionText) invalidDisplay('position', 'label_empty');
    if (identityText.length > 500) invalidDisplay('identity', 'label_too_long');
    if (positionText.length > 200) invalidDisplay('position', 'label_too_long');
    if (!clip || clip.width < 16 || clip.height < 16) invalidDisplay('reader', 'area_too_small');
    if (clip.x < -1e-6 || clip.y < -1e-6 || clip.x + clip.width > viewport.width + 1e-6
      || clip.y + clip.height > viewport.height + 1e-6) invalidDisplay('reader', 'outside_view');
    const display = await this.page.evaluate(() => ({ viewport: [innerWidth, innerHeight], dpr: devicePixelRatio, scroll: [scrollX, scrollY] }));
    if (display.dpr !== this.captureScale) throw new AppError('capture_scale_unavailable');
    if (!this.sampleUrl && await this.page.evaluate(() => document.visibilityState !== 'visible')) throw new AppError('window_not_available');
    const rejectSurface = cause => {
      console.log(`KTZ_PREVIEW:${cause}`);
      throw new AppError('auth_or_overlay_detected', { field: 'reader', cause });
    };
    const topAuth = await this.page.evaluate(authIndicators);
    if (topAuth.password) rejectSurface('auth_password');
    if (topAuth.modal) rejectSurface('auth_modal');
    const readerHandle = await region.elementHandle();
    let readerAuth;
    try {
      const contentFrame = await readerHandle?.contentFrame().catch(() => null);
      readerAuth = contentFrame ? await contentFrame.evaluate(authIndicators) : await region.evaluate(authIndicators);
    } finally { await readerHandle?.dispose().catch(() => {}); }
    if (readerAuth.password) rejectSurface('reader_password');
    if (readerAuth.modal) rejectSurface('reader_modal');
    if (!geometry.unobscured) rejectSurface('blocked_hit');
    if (this.sampleUrl) {
      const safe = await this.page.locator('#reader').evaluate(el => el.dataset.book === 'sample-a' && el.dataset.session === 'active' && el.dataset.overlay === 'false');
      if (!safe) throw new AppError('auth_or_target_changed');
    }
    const target = digest(JSON.stringify([url.href, this.config, identityText, clip, display, geometry.viewports, this.captureScale, this.generation]));
    return { target, book: { title: identityText, identity: digest(JSON.stringify([url.origin, identityText])) }, position: positionText, clip, deviceScaleFactor: this.captureScale,
      nextDisabled: !await next.isEnabled() || await next.getAttribute('aria-disabled') === 'true', next };
  }

  same(a, b) { return a.target === b.target && a.position === b.position && a.nextDisabled === b.nextDisabled; }

  async stable(recovery = null) {
    const a = await this.read(recovery);
    await sleep(140);
    const b = await this.read(recovery);
    if (!this.same(a, b)) throw new AppError('display_unstable');
    return b;
  }

  async screenshotVisibleClip(clip) {
    let timeout;
    try {
      if (!this.scaleSession || this.scalePage !== this.page) await this.setCaptureScale(this.captureScale);
      // Geometry is viewport-relative; CDP's screenshot clip is document-relative.
      // Read the offset without scrolling the page or extending the visible area.
      const offset = await this.page.evaluate(() => ({ x: scrollX, y: scrollY }));
      const result = await Promise.race([
        this.scaleSession.send('Page.captureScreenshot', {
          format: 'png',
          clip: { x: clip.x + offset.x, y: clip.y + offset.y, width: clip.width, height: clip.height, scale: 1 },
          captureBeyondViewport: false,
        }),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new AppError('capture_failed')), 2500); }),
      ]);
      if (typeof result?.data !== 'string') throw new AppError('capture_failed');
      return Buffer.from(result.data, 'base64');
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('capture_failed');
    } finally {
      clearTimeout(timeout);
    }
  }

  async preview(recovery = null) {
    const before = await this.stable(recovery);
    const png = await this.screenshotVisibleClip(before.clip);
    const dimensions = pngDimensions(png);
    const expectedWidth = before.clip.width * before.deviceScaleFactor, expectedHeight = before.clip.height * before.deviceScaleFactor;
    if (Math.abs(dimensions[0] - expectedWidth) > 1.1 || Math.abs(dimensions[1] - expectedHeight) > 1.1) throw new AppError('capture_dimensions_mismatch');
    if (!this.same(before, await this.read())) throw new AppError('target_changed');
    this.bound = { target: before.target, position: before.position, dimensions, book: before.book };
    return { png, book: before.book, position: before.position, dimensions, cssDimensions: [before.clip.width, before.clip.height], deviceScaleFactor: before.deviceScaleFactor,
      recovery: { initialHiddenField: recovery?.initialHiddenField ?? null, observation: recovery?.revealObservation ?? 'not_needed' } };
  }

  async requireBound() {
    const s = await this.stable();
    if (!this.bound || s.target !== this.bound.target || s.position !== this.bound.position) throw new AppError('target_changed');
    return s;
  }

  async capture() {
    const before = await this.requireBound();
    const png = await this.screenshotVisibleClip(before.clip);
    const dimensions = pngDimensions(png);
    if (dimensions[0] !== this.bound.dimensions[0] || dimensions[1] !== this.bound.dimensions[1]) throw new AppError('capture_dimensions_mismatch');
    if (!this.same(before, await this.read())) throw new AppError('target_changed');
    return png;
  }

  async advance(cancelled, onDispatchState = () => {}) {
    await onDispatchState({ stage: 'advance_preflight', status: 'not_sent' });
    const before = await this.requireBound();
    if (cancelled()) throw new AppError('cancelled');
    if (before.nextDisabled) throw new AppError('end_candidate');
    const button = await before.next.elementHandle();
    if (!button) throw new AppError('reader_ui_unknown');
    try {
      // A trial may wait for an overlay or animation, but must never send a
      // click. Revalidate cancellation and the bound book after that wait.
      await button.click({ trial: true, timeout: 1800 });
      if (cancelled()) throw new AppError('cancelled');
      const current = await this.requireBound();
      if (!this.same(before, current) || !await current.next.evaluate((element, original) => element === original, button)) throw new AppError('target_changed');
      // Confirm the top document does not cover a configured iframe. Deeper
      // frame nesting has no verified coordinate contract and is rejected.
      const frame = await button.ownerFrame();
      let topElement = button;
      if (frame !== this.page.mainFrame()) {
        if (frame?.parentFrame() !== this.page.mainFrame()) throw new AppError('reader_ui_unknown');
        topElement = await frame.frameElement();
      }
      try {
        // Persist uncertainty before final geometry/identity checks. A crash
        // anywhere after this point must never authorize an automatic resend.
        await onDispatchState({ stage: 'advance_dispatch', status: 'unknown' });
        if (cancelled()) throw new AppError('cancelled');
        await this.requireBound();
        const rectangle = element => {
          const { x, y, width, height } = element.getBoundingClientRect();
          return { x, y, width, height };
        };
        // Keep both coordinate systems stable across the main-frame bounding
        // box query; checking only the new local center can accept stale input
        // coordinates when a button or its containing iframe has moved.
        const topBox = await topElement.evaluate(rectangle);
        const localBox = topElement === button ? topBox : await button.evaluate(rectangle);
        const box = await button.boundingBox();
        if (!box || box.width <= 0 || box.height <= 0) throw new AppError('reader_ui_unknown');
        const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        const local = await button.evaluate((element, expected) => {
          const rect = element.getBoundingClientRect();
          const stable = ['x', 'y', 'width', 'height'].every(key => rect[key] === expected[key]);
          const hit = document.elementFromPoint(expected.x + expected.width / 2, expected.y + expected.height / 2);
          return { stable, clear: element.isConnected && (hit === element || element.contains(hit)) };
        }, localBox);
        if (!local.stable) throw new AppError('advance_geometry_changed');
        if (!local.clear) throw new AppError('advance_obscured');
        const top = await topElement.evaluate((element, { point, expected }) => {
          const rect = element.getBoundingClientRect();
          const stable = ['x', 'y', 'width', 'height'].every(key => rect[key] === expected[key]);
          const hit = document.elementFromPoint(point.x, point.y);
          return { stable, clear: hit === element || element.contains(hit) };
        }, { point, expected: topBox });
        if (!top.stable) throw new AppError('advance_geometry_changed');
        if (!top.clear) throw new AppError('advance_obscured');
        if (cancelled()) throw new AppError('cancelled');
        // Page-scoped trusted input, dispatched once without locator auto-wait
        // or retries. Finish an already dispatched down/up pair before
        // acknowledging cancellation, without another reading action.
        await this.page.mouse.click(point.x, point.y);
        await onDispatchState({ stage: 'advance_confirmation', status: 'sent' });
      } finally { if (topElement !== button) await topElement.dispose(); }
    } finally { await button.dispose(); }
    const deadline = Date.now() + 3000;
    let after;
    do {
      if (cancelled()) throw new AppError('cancelled');
      after = await this.read();
      if (after.target !== before.target) throw new AppError('target_changed');
      if (after.position !== before.position) break;
      await sleep(80);
    } while (Date.now() < deadline);
    if (after.position === before.position) throw new AppError('advance_uncertain');
    const stable = await this.stable();
    if (!this.same(after, stable)) throw new AppError('display_unstable');
    const dimensions = this.bound?.dimensions;
    if (!dimensions) throw new AppError('capture_dimensions_mismatch');
    this.bound = { target: after.target, position: after.position, dimensions, book: before.book };
    await onDispatchState({ stage: 'advance_confirmed', status: 'sent' });
  }

  async close() {
    this.closed = true;
    await this.scaleSession?.detach().catch(() => {});
    await this.clearReaderCandidate();
    await this.clearPickedMarkers();
    await this.context.close();
  }
}
