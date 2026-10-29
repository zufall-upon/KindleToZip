import { createHash } from 'node:crypto';
import { AppError } from '../store-client.mjs';

// Explicit official Web entrypoints, independently selected from UI language.
// Evidence and deliberately unsupported regions: docs/store-adapters.md.
export const kindleRegions = Object.freeze([
  Object.freeze({ id: 'jp', label: '日本', startUrl: 'https://read.amazon.co.jp/' }),
  Object.freeze({ id: 'us', label: '米国', startUrl: 'https://read.amazon.com/' }),
  Object.freeze({ id: 'uk', label: '英国', startUrl: 'https://read.amazon.co.uk/' }),
]);

export function kindleRegion(id) {
  const region = kindleRegions.find(region => region.id === id);
  if (!region) throw new AppError('invalid_kindle_region');
  return region;
}

export const kindleChromeConfig = Object.freeze({
  frame: '', reader: '#readerChromeTitle >> xpath=ancestor::div[5]', identity: '#readerChromeTitle',
  position: 'input[type="range"]', next: 'button[aria-label*="次"], button[aria-label*="next" i]',
});

function isChromeConfiguration(config) {
  return Boolean(config && !config.frame && !Object.values(config.frames ?? {}).some(Boolean)
    && Object.entries(kindleChromeConfig).every(([key, value]) => config[key] === value));
}

async function validateMarkers({ config, region, identity, position, next }) {
  if (config.reader !== kindleChromeConfig.reader) return;
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

// Explicit preview recovery only. The caller supplies the generic visible-auth
// observation; this adapter owns Kindle-specific chrome and direction semantics.
async function revealChrome(reader, recovery, authIndicators) {
  if (reader.page !== recovery.page || reader.generation !== recovery.generation || reader.config !== recovery.config) throw new AppError('target_changed');
  const config = reader.config;
  if (!isChromeConfiguration(config)) return 'not_preset';
  const auth = await reader.page.evaluate(authIndicators);
  if (auth.password || auth.modal) return 'auth_visible';
  const locators = ['reader', 'identity', 'position', 'next'].map(field => reader.page.locator(config[field]));
  if ((await Promise.all(locators.map(locator => locator.count()))).some(count => count !== 1)) return 'markers_not_unique';
  const handles = await Promise.all(locators.map(locator => locator.elementHandle()));
  try {
    if (handles.some(handle => !handle)) return 'no_handles';
    return await reader.page.evaluate(([region, identity, position, next]) => {
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
      if (!surfaces.some(surface => {
        const box = surface.getBoundingClientRect();
        return x >= box.left && x < box.right && y >= box.top && y < box.bottom;
      }) || !['DIV', 'SPAN', 'CANVAS', 'IMG', 'IFRAME'].includes(hit.tagName)) return 'hit_blocked';
      for (const type of ['pointerover', 'pointermove']) hit.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, pointerType: 'mouse' }));
      for (const type of ['mouseover', 'mousemove']) hit.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y }));
      return 'dispatched';
    }, handles);
  } finally { await Promise.all(handles.map(handle => handle?.dispose().catch(() => {}))); }
}

export function createKindleAdapter(regionId = 'jp') {
  const region = kindleRegion(regionId);
  const origin = new URL(region.startUrl).origin;
  return Object.freeze({
    id: 'kindle', regionId: region.id, startUrl: region.startUrl,
    acceptsUrl(value) {
      try {
        const url = new URL(value);
        return url.origin === origin && !url.username && !url.password;
      } catch { return false; }
    },
    async isLibrary(page) { return /^\/kindle-library(?:\/|$)/.test(new URL(page.url()).pathname); },
    async assertState() {},
    // Visible title and location remain caller-selected; no hidden store APIs.
    identify(url, title, position) {
      return { book: { title, identity: createHash('sha256').update(JSON.stringify([url.origin, title])).digest('hex') }, position };
    },
    isChromeConfiguration, validateMarkers, revealChrome,
    // Shared code owns preflight, bound-node/geometry checks, cancellation,
    // dispatch journaling and post-turn confirmation. No adapter retries.
    async turnPage(page, point) { await page.mouse.click(point.x, point.y); },
  });
}
