import { inspectKindleDocument, readerMarkerReasons } from './linux-reader-probe.mjs';
import { ownedPipeTransport } from './linux-playwright-pipe.mjs';
import { observeExpectedBook } from './linux-playwright-expected-observe.mjs';

const fail = reason => Object.assign(new Error('observation-unavailable'), { reason });
const waitable = new Set(readerMarkerReasons.filter(reason => !reason.endsWith('-multiple')));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// This function is serialized into the selected top-level document. It watches
// only the three source-backed selectors, their node identities and title
// mutations; it never traverses unknown frames or shadow roots or reads body.
function installWatch(inspect, expectedOrigin) {
  // Inspect first and capture the document and existing marker nodes in the
  // same browser task, so a same-document change cannot slip into a gap.
  const initial = inspect({ expectedOrigin, metadata: false, allowInitialEmpty: true, diagnostics: true });
  const doc = document;
  const track = initial.state === 'ready' || /^reader-(?:identity|position|next)-(?:missing|multiple|hidden|clipped)$/.test(initial.reason ?? '');
  const href = track ? location.href : undefined;
  const selectors = { identity: '#readerChromeTitle', position: 'input[type="range"]',
    next: 'button[aria-label*="次"], button[aria-label*="next" i]' };
  const nodes = {};
  let changed = false;
  const observer = new MutationObserver(records => consume(records));
  if (track) observer.observe(doc, { subtree: true, childList: true, characterData: true, attributes: true,
    attributeFilter: ['id', 'type', 'aria-label'] });
  function capture(root) {
    if (root.nodeType !== 1) return;
    for (const [field, selector] of Object.entries(selectors)) {
      const matches = [...(root.matches(selector) ? [root] : []), ...root.querySelectorAll(selector)];
      for (const node of matches) {
        if (nodes[field] && nodes[field] !== node) changed = true;
        else nodes[field] = node;
      }
    }
  }
  function consume(records = observer.takeRecords()) {
    for (const record of records) {
      const title = nodes.identity;
      if (title && (record.target === title || title.contains(record.target))) changed = true;
      for (const removed of record.removedNodes) {
        if (Object.values(nodes).some(node => removed === node || (removed.nodeType === 1 && removed.contains(node)))
            || (removed.nodeType === 1 && Object.values(selectors).some(selector => removed.matches(selector) || removed.querySelector(selector)))) changed = true;
      }
      // Bind a first appearance in mutation order, not at the next poll. A title
      // added and changed in this same batch must never become a fresh binding.
      // Removed markers also revoke it: an earlier added subtree is live, so
      // querying it here may already see a replacement rather than its old node.
      for (const added of record.addedNodes) capture(added);
      if (record.type === 'attributes') capture(record.target);
    }
  }
  function current() {
    consume();
    if (document !== doc || location.href !== href) changed = true;
    for (const [field, selector] of Object.entries(selectors)) {
      const matches = doc.querySelectorAll(selector);
      if (matches.length > 1) return 'multiple';
      if (nodes[field] && (matches.length !== 1 || matches[0] !== nodes[field] || !nodes[field].isConnected)) changed = true;
      if (!nodes[field] && matches.length === 1) nodes[field] = matches[0];
    }
    return changed ? 'changed' : 'current';
  }
  function run(metadata) {
    let state = current();
    if (state !== 'current') return { state };
    const value = inspect({ expectedOrigin, metadata, allowInitialEmpty: !metadata, diagnostics: !metadata });
    state = current();
    return state === 'current' ? value : { state };
  }
  function prepareChrome() {
    let eventsSent = 0;
    const done = (state, reason) => ({ state, reason, eventsSent });
    const state = current();
    if (state !== 'current') return done(state, 'target-changed');
    // The hidden chrome is not permission to read it, click it or change CSS.
    // Reuse the preset's shared-ancestor/surface/hit contract before one burst
    // of synthetic move events. No native pointer, key, slider or page action.
    const probe = inspect({ expectedOrigin, metadata: false });
    if (!/^reader-(?:identity|position|next)-hidden$/.test(probe.reason ?? '')
        || !probe.markers || Object.values(probe.markers).some(marker => marker.count !== 'one')) return done('refused', 'marker-state');
    const visible = element => {
      if (!element?.isConnected) return false;
      for (let node = element; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility) || Number(style.opacity) === 0) return false;
      }
      const r = element.getBoundingClientRect();
      return r.width >= 16 && r.height >= 16 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight;
    };
    const { identity, position, next } = nodes;
    let region = identity?.parentElement;
    for (let divs = 0; region; region = region.parentElement) {
      if (region.tagName === 'DIV' && ++divs === 5) break;
    }
    if (!region || !visible(region)) return done('refused', 'region-unavailable');
    if (![identity, position, next].every(node => node?.isConnected && region.contains(node))) return done('refused', 'not-shared');
    const label = next.getAttribute('aria-label') ?? '';
    if (!/次|next/i.test(label) || /前|戻|previous|back/i.test(label)) return done('refused', 'direction-unknown');
    const surfaces = [...region.querySelectorAll('canvas, img, iframe')].filter(visible);
    const rect = region.getBoundingClientRect();
    const left = Math.max(0, rect.left), top = Math.max(0, rect.top);
    const right = Math.min(innerWidth, rect.right), bottom = Math.min(innerHeight, rect.bottom);
    const x = left + (right - left) / 2, y = top + Math.min(8, (bottom - top) / 2);
    const hit = document.elementFromPoint(x, y);
    let hitReason;
    const safeHit = () => {
      hitReason = 'hit-blocked';
      if (!hit?.isConnected || !visible(region) || !region.contains(hit) || document.elementFromPoint(x, y) !== hit
          || next.contains(hit) || position.contains(hit) || hit.closest('button, input, a, [role="button"], [contenteditable="true"]')
          || !['DIV', 'SPAN', 'CANVAS', 'IMG', 'IFRAME'].includes(hit.tagName)) return false;
      hitReason = 'surface-at-hit-unavailable';
      return surfaces.some(surface => { const r = surface.getBoundingClientRect(); return visible(surface) && x >= r.left && x < r.right && y >= r.top && y < r.bottom; });
    };
    if (!safeHit()) return done('refused', hitReason);
    for (const type of ['pointerover', 'pointermove', 'mouseover', 'mousemove']) {
      // Recheck the same document/nodes and blocking UI after each synchronous
      // listener; never finish a burst against a replacement or newly opened UI.
      const before = current();
      if (before !== 'current') return done(before, 'target-changed');
      const guard = inspect({ expectedOrigin, metadata: false });
      if (['document-unavailable', 'blocking-ui'].includes(guard.reason)) return done('interrupted', guard.reason);
      if (!safeHit()) return done('interrupted', hitReason);
      const EventType = type.startsWith('pointer') ? PointerEvent : MouseEvent;
      hit.dispatchEvent(new EventType(type, { bubbles: true, clientX: x, clientY: y,
        ...(type.startsWith('pointer') ? { pointerType: 'mouse' } : {}) }));
      eventsSent++;
    }
    const after = current();
    return after === 'current' ? done('dispatched', 'dispatched') : done(after, 'target-changed');
  }
  const firstCurrent = track ? current() : 'current';
  return { initial: () => firstCurrent === 'current' ? initial : { state: firstCurrent },
    current, probe: () => run(false), prepareChrome, read: () => run(true), dispose: () => observer.disconnect() };
}

function projectMetadata(value, { expected = false } = {}) {
  const p = value?.position, r = value?.region, title = value?.title;
  if (value?.state !== 'ok' || typeof title !== 'string' || title !== title.trim() || !title || title.length > 500
      || /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(title)
      || !p || ![p.value, p.min, p.max].every(n => Number.isFinite(n) && Math.abs(n) <= 1e9)
      || p.max <= p.min || p.value < p.min || p.value > p.max || !r
      || ![r.width, r.height, r.visibleWidth, r.visibleHeight].every(n => Number.isFinite(n) && n > 0 && n <= 100000)
      || r.visibleWidth > r.width || r.visibleHeight > r.height) throw fail('invalid-metadata');
  const result = { title, position: { value: p.value, min: p.min, max: p.max },
    region: { width: r.width, height: r.height, visibleWidth: r.visibleWidth, visibleHeight: r.visibleHeight } };
  if (expected) {
    if (!/^[A-Z0-9]{10}$/.test(value.asin ?? '') || !value.markers) throw fail('invalid-metadata');
    const markers = {};
    for (const field of ['identity', 'position', 'next']) {
      const marker = value.markers[field];
      if (marker?.count !== 'one' || !['visible', 'hidden', 'clipped'].includes(marker.visibility)) throw fail('invalid-metadata');
      markers[field] = { count: 'one', visibility: marker.visibility };
    }
    result.asin = value.asin;
    result.markers = markers;
  }
  return result;
}
export { projectMetadata };

const preparationReasons = new Set(['marker-state', 'region-unavailable', 'not-shared', 'direction-unknown',
  'hit-blocked', 'surface-at-hit-unavailable', 'target-changed', 'document-unavailable', 'blocking-ui', 'dispatched']);
// Geometry comes only from the fixed markers' existing visibility predicates.
// This projection cannot carry node names, text, URLs, arbitrary keys or values.
export function projectUiDiagnostics(value) {
  const result = {};
  if (!value || typeof value !== 'object') throw new Error('invalid_ui_diagnostic');
  if (value.preparation) {
    const p = value.preparation;
    if (!preparationReasons.has(p.reason) || !Number.isInteger(p.eventsSent) || p.eventsSent < 0 || p.eventsSent > 4) throw new Error('invalid_ui_diagnostic');
    result.preparation = { reason: p.reason, eventsSent: p.eventsSent };
  }
  if (value.clipping !== undefined) {
    if (!Array.isArray(value.clipping) || value.clipping.length > 3) throw new Error('invalid_ui_diagnostic');
    const rectangle = r => {
      if (!r || !['left', 'top', 'right', 'bottom'].every(k => Number.isFinite(r[k]) && Math.abs(r[k]) <= 100000)) throw new Error('invalid_ui_diagnostic');
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    };
    result.clipping = value.clipping.map(c => {
      if (!['identity', 'position', 'next'].includes(c?.field)
          || !['outsideClip', 'overflowX', 'overflowY'].every(k => typeof c[k] === 'boolean')
          || !['width', 'height'].every(k => Number.isFinite(c.viewport?.[k]) && c.viewport[k] > 0 && c.viewport[k] <= 100000)) throw new Error('invalid_ui_diagnostic');
      return { field: c.field, rect: rectangle(c.rect), clip: rectangle(c.clip),
        viewport: { width: c.viewport.width, height: c.viewport.height },
        outsideClip: c.outsideClip, overflowX: c.overflowX, overflowY: c.overflowY };
    });
  }
  return result;
}

// One absolute deadline covers Playwright connection, initial restoration and
// SPA readiness. No page is chosen by URL/order when more than one exists.
export async function observeRestoredWithPlaywright(child, expectedOrigin, { deadlineMs = 10000, onPreparation = () => {}, onDiagnostic = () => {}, expectedBook } = {}) {
  if (expectedBook) return observeExpectedBook(child, expectedOrigin, expectedBook, { deadlineMs, projectMetadata });
  const until = performance.now() + deadlineMs;
  const diagnose = value => { try { onDiagnostic(projectUiDiagnostics(value)); } catch { /* diagnostics never relax or change observation */ } };
  let lastReason;
  const timeout = () => Object.assign(fail('readiness-timeout'), { detail: lastReason });
  const bounded = async action => {
    const remaining = until - performance.now();
    if (remaining <= 0) throw timeout();
    let timer;
    try { return await Promise.race([Promise.resolve().then(action), new Promise((_, reject) => {
      timer = setTimeout(() => reject(timeout()), remaining);
    })]); } finally { clearTimeout(timer); }
  };
  const transport = ownedPipeTransport(child);
  let browser, page, context, watch, frame, navigation = 0, boundNavigation, pageChanged = false;
  try {
    const { chromium } = await bounded(() => import('playwright'));
    browser = await bounded(() => chromium.connectOverCDP(transport, { noDefaults: true, timeout: Math.max(1, until - performance.now()) }));
    const contexts = browser.contexts();
    if (contexts.length !== 1) throw fail('context-ambiguous');
    [context] = contexts;
    const earlyPages = new Set();
    context.on('page', candidate => {
      if (page && candidate !== page) pageChanged = true;
      else if (!page) { earlyPages.add(candidate); if (earlyPages.size > 1) pageChanged = true; }
    });
    let prepared = false;
    while (true) {
      const pages = context.pages();
      if (pages.length > 1) throw fail('multiple-page-targets');
      if (!page && pageChanged) throw fail('multiple-page-targets');
      if (!page && earlyPages.size && (pages.length !== 1 || !earlyPages.has(pages[0]))) throw fail('target-changed');
      if (page && (pageChanged || pages.length !== 1 || pages[0] !== page || page.isClosed())) throw fail('target-changed');
      if (!page && pages.length === 1) {
        [page] = pages; frame = page.mainFrame();
        page.on('framenavigated', changed => { if (changed === frame) navigation++; });
        page.on('close', () => { pageChanged = true; });
      }
      if (!page) { await bounded(() => sleep(50)); continue; }
      const before = navigation;
      let initial, candidate;
      const expression = `(${installWatch.toString()})(${inspectKindleDocument.toString()}, ${JSON.stringify(expectedOrigin)})`;
      try { candidate = await bounded(() => page.evaluateHandle(expression)); }
      catch (error) {
        if (error.reason === 'readiness-timeout') throw error;
        // Only before a non-starting document is observed can restoration replace it.
        await bounded(() => sleep(50)); continue;
      }
      try { initial = await bounded(() => candidate.evaluate(value => value.initial())); }
      catch (error) { if (error.reason === 'readiness-timeout') throw error; throw fail('target-changed'); }
      if (initial?.state === 'starting') {
        try { await bounded(() => candidate.dispose()); } catch { /* no page values */ }
        await bounded(() => sleep(50)); continue;
      }
      if (before !== navigation) throw fail('target-changed');
      if (initial?.state === 'changed' || initial?.state === 'multiple') throw fail(initial.state === 'multiple' ? 'multiple-markers' : 'target-changed');
      if (initial?.state === 'unavailable' && !waitable.has(initial.reason)) throw fail(initial.reason);
      if (initial?.markers && Object.values(initial.markers).some(marker => marker.count === 'multiple')) throw fail('multiple-markers');
      boundNavigation = navigation;
      watch = candidate;
      break;
    }
    const evaluateWatch = async callback => {
      try { return await bounded(() => watch.evaluate(callback)); }
      catch (error) {
        if (error?.reason === 'readiness-timeout') throw error;
        // A bound handle that can no longer be evaluated is not a new startup
        // candidate. Invalidate it even if navigation events have not arrived.
        throw fail('target-changed');
      }
    };
    const check = async () => {
      const pages = context.pages();
      if (pageChanged || page.isClosed() || page.mainFrame() !== frame || navigation !== boundNavigation
          || pages.length !== 1 || pages[0] !== page) throw fail('target-changed');
      const state = await evaluateWatch(value => value.current());
      if (state !== 'current') throw fail(state === 'multiple' ? 'multiple-markers' : 'target-changed');
    };
    while (true) {
      await check();
      const state = await evaluateWatch(value => value.probe());
      await check();
      diagnose({ clipping: state?.clipping ?? [] });
      if (state?.state === 'ready') {
        const value = await evaluateWatch(value => value.read()); // one metadata attempt
        await check();
        if (value?.state === 'changed' || value?.state === 'multiple') throw fail('target-changed');
        if (value?.state !== 'ok') throw fail(value?.reason ?? 'invalid-metadata');
        return projectMetadata(value);
      }
      if (state?.state === 'changed' || state?.state === 'multiple') throw fail('target-changed');
      if (state?.markers && Object.values(state.markers).some(marker => marker.count === 'multiple')) throw fail('multiple-markers');
      if (!waitable.has(state?.reason)) throw fail(state?.reason ?? 'probe-unavailable');
      lastReason = state.reason;
      if (!prepared && /^reader-(?:identity|position|next)-hidden$/.test(state.reason)
          && state.markers && Object.values(state.markers).every(marker => marker.count === 'one')) {
        prepared = true; // at most once, including a refused or interrupted burst
        onPreparation('interrupted');
        const preparation = await evaluateWatch(value => value.prepareChrome());
        diagnose({ preparation });
        if (preparation.state === 'changed' || preparation.state === 'multiple') throw fail('target-changed');
        if (!['dispatched', 'refused', 'interrupted'].includes(preparation.state)) throw fail('probe-unavailable');
        onPreparation(preparation.state);
        await check();
      }
      await bounded(() => sleep(50));
    }
  } catch (error) {
    if (typeof error?.reason === 'string') throw error;
    throw fail('probe-unavailable');
  } finally {
    // Closing the public transport detaches Playwright, not the inherited fd.
    // A stuck evaluate/dispose must not defeat the fixed deadline or ownership.
    if (watch && performance.now() < until) {
      try { await bounded(() => watch.evaluate(value => value.dispose())); } catch { /* fixed failure only */ }
    }
    transport.close();
  }
}
