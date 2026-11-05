// Fixed, serializable Kindle UI probe. This is not a selector/frame/debug API.
// The default returns only fixed readiness categories; text/value reads require
// the explicitly requested metadata mode and all existing structural guards.
export function inspectKindleDocument({ expectedOrigin, metadata = false, allowInitialEmpty = false, diagnostics = false, expectedMode = false }) {
  const clipping = [];
  const unavailable = (reason, markers) => ({ state: 'unavailable', reason, ...(markers ? { markers } : {}),
    ...(!metadata && diagnostics && clipping.length ? { clipping } : {}) });
  // Resume-only startup readiness, not permission to inspect a different site.
  // No href/search/hash or page values are read. The caller bounds this wait.
  // An opaque origin is not necessarily about:blank: data: pathnames contain
  // the document payload. Check the scheme before reading a known blank path.
  if (!metadata && allowInitialEmpty && ((location.origin === 'null' && location.protocol === 'about:' && location.pathname === 'blank')
      || ['chrome://newtab', 'chrome://new-tab-page'].includes(location.origin))) return { state: 'starting' };
  if (location.origin !== expectedOrigin || document.visibilityState !== 'visible') return unavailable('document-unavailable');
  const pathname = location.pathname;
  let expectedLibraryReader = false;
  if (expectedMode && /^\/kindle-library(?:\/|$)/.test(pathname)) {
    const pathAsin = /^\/kindle-library\/manga-wr\/([A-Z0-9]{10})\/?$/.exec(pathname)?.[1];
    if (pathAsin || ['/kindle-library', '/kindle-library/'].includes(pathname)) {
      const keys = new URLSearchParams(location.search).getAll('asin');
      expectedLibraryReader = keys.length <= 1 && (!keys.length || /^[A-Z0-9]{10}$/.test(keys[0]))
        && (!pathAsin || !keys.length || pathAsin === keys[0]) && Boolean(pathAsin || keys[0]);
    }
  }
  if (/^\/(?:ap\/signin|signin|login)(?:\/|$)/i.test(pathname)
      || (/^\/kindle-library(?:\/|$)/i.test(pathname) && !expectedLibraryReader)) return unavailable('document-unavailable');
  if (!metadata && allowInitialEmpty && document.readyState === 'loading') return { state: 'starting' };
  const visible = element => {
    if (!element?.isConnected) return false;
    for (let node = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility) || Number(style.opacity) === 0) return false;
    }
    const r = element.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight;
  };
  const displayed = element => {
    if (!element?.isConnected) return false;
    for (let node = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility) || Number(style.opacity) === 0) return false;
    }
    const r = element.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const partlyVisible = element => {
    if (!visible(element)) return false;
    const rect = element.getBoundingClientRect();
    let left = 0, top = 0, right = innerWidth, bottom = innerHeight;
    for (let node = element.parentElement; node; node = node.parentElement) {
      const style = getComputedStyle(node), bounds = node.getBoundingClientRect();
      if (/^(?:hidden|clip|scroll|auto)$/.test(style.overflowX)) { left = Math.max(left, bounds.left); right = Math.min(right, bounds.right); }
      if (/^(?:hidden|clip|scroll|auto)$/.test(style.overflowY)) { top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom); }
    }
    return Math.min(rect.right, right) > Math.max(rect.left, left) && Math.min(rect.bottom, bottom) > Math.max(rect.top, top);
  };
  const fullyVisible = (element, field) => {
    if (!visible(element)) return false;
    const rect = element.getBoundingClientRect();
    let left = 0, top = 0, right = innerWidth, bottom = innerHeight;
    for (let node = element.parentElement; node; node = node.parentElement) {
      const style = getComputedStyle(node), bounds = node.getBoundingClientRect();
      if (/^(?:hidden|clip|scroll|auto)$/.test(style.overflowX)) { left = Math.max(left, bounds.left); right = Math.min(right, bounds.right); }
      if (/^(?:hidden|clip|scroll|auto)$/.test(style.overflowY)) { top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom); }
    }
    const outsideClip = !(rect.left >= left && rect.top >= top && rect.right <= right && rect.bottom <= bottom);
    const overflowX = element.clientWidth > 0 && element.scrollWidth > element.clientWidth + 1;
    const overflowY = element.clientHeight > 0 && element.scrollHeight > element.clientHeight + 1;
    if (!metadata && diagnostics && (outsideClip || overflowX || overflowY)) clipping.push({ field,
      rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
      clip: { left, top, right, bottom }, viewport: { width: innerWidth, height: innerHeight }, outsideClip, overflowX, overflowY });
    return !outsideClip && !overflowX && !overflowY;
  };
  if ([...document.querySelectorAll('input[type="password"], #ap_email, #authportal-main-section, [aria-modal="true"], dialog[open], [role="dialog"]')].some(visible)) return unavailable('blocking-ui');
  const selectors = { identity: '#readerChromeTitle', position: 'input[type="range"]',
    next: 'button[aria-label*="次"], button[aria-label*="next" i]' };
  const nodes = {}, markers = {};
  for (const [field, selector] of Object.entries(selectors)) {
    const matches = document.querySelectorAll(selector);
    const count = matches.length === 0 ? 'none' : matches.length === 1 ? 'one' : 'multiple';
    const element = count === 'one' ? matches[0] : null;
    nodes[field] = element;
    markers[field] = { count, visibility: !element ? 'not-checked'
      : !(expectedMode ? displayed(element) : visible(element)) ? 'hidden' : !fullyVisible(element, field) ? 'clipped' : 'visible' };
  }
  for (const field of Object.keys(selectors)) {
    const marker = markers[field];
    if (marker.count !== 'one') return unavailable(`reader-${field}-${marker.count === 'none' ? 'missing' : 'multiple'}`, markers);
    // The independently bound expected-book route reports hidden/clipped UI as
    // state, rather than requiring a synthetic action to make the chrome visible.
    // The legacy strict and diagnostic contracts remain unchanged.
    if (!expectedMode && marker.visibility !== 'visible') return unavailable(`reader-${field}-${marker.visibility}`, markers);
  }
  const { identity: title, position, next } = nodes;
  // Preserve the existing preset's DIV ancestor contract and top-level-only
  // frame boundary. Never search unknown frames for a more convenient reader.
  let region = title.parentElement;
  for (let divs = 0; region; region = region.parentElement) {
    if (region.tagName === 'DIV' && ++divs === 5) break;
  }
  if (!region || region.tagName !== 'DIV' || !visible(region)
      || !region.contains(position) || !region.contains(next)) return unavailable('reader-region', markers);
  const direction = next.getAttribute('aria-label') ?? '';
  if (!/次|next/i.test(direction) || /前|戻|previous|back/i.test(direction)) return unavailable('reader-direction', markers);
  if (![...region.querySelectorAll('canvas, img, iframe')].some(surface => {
    const r = surface.getBoundingClientRect();
    return r.width >= 16 && r.height >= 16 && (expectedMode ? partlyVisible(surface) : visible(surface));
  })) return unavailable('reader-surface', markers);
  if (!metadata) return { state: 'ready', markers };
  const renderedTitle = title.innerText ?? '';
  // A hidden chrome title can have an empty innerText while its known marker
  // still contains the book label. Read only this fixed marker, never the body.
  const text = (expectedMode && markers.identity.visibility === 'hidden' && !renderedTitle.trim()
    ? title.textContent ?? '' : renderedTitle).trim();
  if (!text || text.length > 500 || /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(text)) return unavailable('reader-title');
  const value = Number(position.value), min = position.min === '' ? 0 : Number(position.min), max = position.max === '' ? 100 : Number(position.max);
  if (![value, min, max].every(Number.isFinite) || max <= min || value < min || value > max
      || [value, min, max].some(n => Math.abs(n) > 1e9)) return unavailable('reader-position');
  const r = region.getBoundingClientRect(), rounded = n => Math.round(n * 100) / 100;
  const width = rounded(r.width), height = rounded(r.height);
  let left = 0, top = 0, right = innerWidth, bottom = innerHeight;
  if (expectedMode) for (let node = region.parentElement; node; node = node.parentElement) {
    const style = getComputedStyle(node), bounds = node.getBoundingClientRect();
    if (/^(?:hidden|clip|scroll|auto)$/.test(style.overflowX)) { left = Math.max(left, bounds.left); right = Math.min(right, bounds.right); }
    if (/^(?:hidden|clip|scroll|auto)$/.test(style.overflowY)) { top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom); }
  }
  const visibleWidth = rounded(Math.max(0, Math.min(r.right, right) - Math.max(r.left, left)));
  const visibleHeight = rounded(Math.max(0, Math.min(r.bottom, bottom) - Math.max(r.top, top)));
  if (![width, height, visibleWidth, visibleHeight].every(n => Number.isFinite(n) && n > 0 && n <= 100000)) return unavailable('reader-dimensions');
  if (expectedMode) {
    // Getters and synchronous page callbacks may redraw even within this task.
    // Do not combine a detached position or a new container with the earlier
    // title/geometry, while still permitting a same-book redraw between tasks.
    for (const [field, selector] of Object.entries(selectors)) {
      const matches = document.querySelectorAll(selector);
      if (matches.length !== 1 || matches[0] !== nodes[field] || !nodes[field].isConnected) return unavailable('reader-region');
    }
    let finalRegion = title.parentElement;
    for (let divs = 0; finalRegion; finalRegion = finalRegion.parentElement) {
      if (finalRegion.tagName === 'DIV' && ++divs === 5) break;
    }
    const finalDirection = next.getAttribute('aria-label') ?? '';
    if (finalRegion !== region || !region.isConnected || !visible(region) || !region.contains(position) || !region.contains(next)
        || !/次|next/i.test(finalDirection) || /前|戻|previous|back/i.test(finalDirection)
        || ![...region.querySelectorAll('canvas, img, iframe')].some(surface => {
          const bounds = surface.getBoundingClientRect();
          return bounds.width >= 16 && bounds.height >= 16 && partlyVisible(surface);
        })) return unavailable('reader-region');
    if ([...document.querySelectorAll('input[type="password"], #ap_email, #authportal-main-section, [aria-modal="true"], dialog[open], [role="dialog"]')].some(visible)) return unavailable('blocking-ui');
  }
  return { state: 'ok', title: text, position: { value, min, max }, region: { width, height, visibleWidth, visibleHeight },
    ...(expectedMode ? { markers } : {}) };
}

export const readerMarkerReasons = Object.freeze(['identity', 'position', 'next']
  .flatMap(field => ['missing', 'multiple', 'hidden', 'clipped'].map(cause => `reader-${field}-${cause}`)));

const uiProbeReasons = new Set([...readerMarkerReasons, 'document-unavailable', 'blocking-ui',
  'reader-region', 'reader-direction', 'reader-surface', 'startup-incomplete']);

// Use the same closed projection at the private pipe and owner IPC boundaries.
// This intentionally has no title, position value, URL, frame or target ID.
export function projectKindleUiProbe(value) {
  if (!value || !['ready', 'unavailable'].includes(value.state)
      || (value.state === 'unavailable' && !uiProbeReasons.has(value.reason))) throw new Error('invalid_ui_probe');
  const result = { state: value.state, ...(value.state === 'unavailable' ? { reason: value.reason } : {}) };
  if (value.markers) {
    const markers = {};
    for (const field of ['identity', 'position', 'next']) {
      const marker = value.markers[field];
      if (!marker || !['none', 'one', 'multiple'].includes(marker.count)
          || !['not-checked', 'hidden', 'clipped', 'visible'].includes(marker.visibility)
          || (marker.count === 'one') === (marker.visibility === 'not-checked')) throw new Error('invalid_ui_probe');
      if (value.state === 'ready' && (marker.count !== 'one' || marker.visibility !== 'visible')) throw new Error('invalid_ui_probe');
      markers[field] = { count: marker.count, visibility: marker.visibility };
    }
    result.markers = markers;
  } else if (value.state === 'ready' || readerMarkerReasons.includes(value.reason)) throw new Error('invalid_ui_probe');
  return result;
}

const safeReasons = new Set([...readerMarkerReasons, 'document-unavailable', 'blocking-ui', 'reader-region',
  'reader-direction', 'reader-surface', 'reader-title', 'reader-position', 'reader-dimensions']);
const waiting = new Set(readerMarkerReasons.filter(reason => !reason.endsWith('-multiple')));
const failure = (code, reason) => Object.assign(new Error(code), { code, reason });

// Internal capability seam, not used to discover/select a page. The caller must
// already hold an independently established, revocable book/page/frame binding.
// The real public launcher does not yet have such a binding after normal close;
// do not substitute page order, origin, visibility or a reader-shaped DOM for it.
export async function observeBoundKindle({ isCurrent, probe, read, deadlineMs = 2000, intervalMs = 50 }) {
  if (!Number.isFinite(deadlineMs) || deadlineMs < 0 || deadlineMs > 2000
      || !Number.isFinite(intervalMs) || intervalMs < 10 || intervalMs > 100) throw failure('inspect_probe_invalid', 'invalid-probe-bound');
  const until = performance.now() + deadlineMs;
  const deadlineFailure = Object.assign(failure('inspect_readiness_timeout', 'readiness-timeout'), { timedOut: true });
  const bounded = async callback => {
    const remaining = until - performance.now();
    if (remaining <= 0) throw deadlineFailure;
    let timer;
    try {
      return await Promise.race([Promise.resolve().then(callback), new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(deadlineFailure), remaining);
      })]);
    } finally { clearTimeout(timer); }
  };
  const current = async () => {
    try { if (await bounded(isCurrent) === true) return; }
    catch (error) { if (error === deadlineFailure) throw error; }
    throw failure('inspect_binding_changed', 'binding-changed');
  };
  const evaluate = async callback => {
    try { return await bounded(callback); }
    catch (error) { if (error === deadlineFailure) throw error; throw failure('inspect_probe_unavailable', 'probe-unavailable'); }
  };
  while (true) {
    await current();
    const state = await evaluate(probe);
    await current();
    if (state?.state === 'ready') {
      const value = await evaluate(read); // exactly one metadata attempt
      await current();
      if (value?.state !== 'ok') throw failure('inspect_marker_unavailable', safeReasons.has(value?.reason) ? value.reason : 'marker-unavailable');
      const p = value.position, r = value.region;
      if (typeof value.title !== 'string' || value.title !== value.title.trim() || !value.title || value.title.length > 500
          || /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(value.title)
          || !p || !r || ![p.value, p.min, p.max].every(n => Number.isFinite(n) && Math.abs(n) <= 1e9)
          || p.max <= p.min || p.value < p.min || p.value > p.max
          || ![r.width, r.height, r.visibleWidth, r.visibleHeight].every(n => Number.isFinite(n) && n > 0 && n <= 100000)) {
        throw failure('inspect_probe_unavailable', 'invalid-metadata');
      }
      return { title: value.title,
        position: { value: value.position.value, min: value.position.min, max: value.position.max },
        region: { width: value.region.width, height: value.region.height,
          visibleWidth: value.region.visibleWidth, visibleHeight: value.region.visibleHeight } };
    }
    const reason = safeReasons.has(state?.reason) ? state.reason : 'marker-unavailable';
    if (!waiting.has(reason)) throw failure('inspect_marker_unavailable', reason);
    deadlineFailure.reason = reason;
    const remaining = until - performance.now();
    if (remaining <= 0) throw deadlineFailure;
    await new Promise(resolve => setTimeout(resolve, Math.min(intervalMs, remaining)));
  }
}
