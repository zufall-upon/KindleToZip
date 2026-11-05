import { inspectKindleDocument, readerMarkerReasons } from './linux-reader-probe.mjs';
import { ownedPipeTransport } from './linux-playwright-pipe.mjs';

const fail = reason => Object.assign(new Error('observation-unavailable'), { reason });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitable = new Set(readerMarkerReasons.filter(reason => reason.endsWith('-missing')));

// Serialized into the top-level document. Only the known route path and the
// asin key are examined; neither the URL nor other query values leave it.
export function expectedRoute(expectedOrigin, expectedAsin) {
  if (location.origin === 'null' && location.protocol === 'about:' && location.pathname === 'blank') return 'starting';
  if (location.origin !== expectedOrigin || document.visibilityState !== 'visible') return 'unavailable';
  const visible = element => {
    if (!element.isConnected) return false;
    for (let node = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility) || Number(style.opacity) === 0) return false;
    }
    const r = element.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight;
  };
  if ([...document.querySelectorAll('input[type="password"], #ap_email, #authportal-main-section, [aria-modal="true"], dialog[open], [role="dialog"]')].some(visible)) return 'blocking';
  if (document.readyState === 'loading') return 'starting';
  const pathname = location.pathname;
  const pathMatch = /^\/(?:manga|kindle-library\/manga-wr)\/([A-Z0-9]{10})\/?$/.exec(pathname);
  if (pathname !== '/' && pathname !== '/kindle-library' && pathname !== '/kindle-library/' && !pathMatch) return 'unavailable';
  const keys = new URLSearchParams(location.search).getAll('asin');
  if (keys.length > 1 || (keys.length && !/^[A-Z0-9]{10}$/.test(keys[0]))) return 'unavailable';
  if (pathMatch && keys.length && keys[0] !== pathMatch[1]) return 'unavailable';
  const asin = pathMatch?.[1] ?? keys[0];
  if (asin) return asin === expectedAsin ? 'match' : 'mismatch';
  if (pathMatch) return 'unavailable';
  // Do not replace an unidentified reader or scan the library's contents.
  if (document.querySelector('#readerChromeTitle, input[type="range"], button[aria-label*="次"], button[aria-label*="next" i]')) return 'unavailable';
  return 'placeholder';
}

// This binding deliberately tracks the expected title, not permanent DOM node
// identities. Records are consumed before and after the sole metadata task, so a
// transient different title (including change-and-restore) revokes the binding.
export function installExpectedWatch(inspect, route, expectedOrigin, expectedBook, titleSelector = '#readerChromeTitle', watchRouteHistory = false) {
  const doc = document;
  const normalize = text => text.normalize('NFKC').replace(/\s+/gu, '');
  const allowed = new Set([expectedBook.title, ...expectedBook.aliases].map(normalize));
  const acceptable = text => !text || allowed.has(normalize(text));
  const watched = new Set();
  const owners = new WeakMap(), titleRecords = [];
  let confirmed = false, changed = false;
  // The long-lived session must also remember same-task route changes that are
  // restored before the next observation. The one-shot observer retains its
  // original route policy and does not install these wrappers.
  const historyMethods = [];
  const routeChanged = () => { if (route(expectedOrigin, expectedBook.asin) !== 'match') changed = true; };
  if (watchRouteHistory) {
    for (const key of ['pushState', 'replaceState']) {
      const original = history[key];
      const wrapped = function (...args) { const value = original.apply(this, args); routeChanged(); return value; };
      history[key] = wrapped;
      historyMethods.push([key, original, wrapped]);
    }
    addEventListener('popstate', routeChanged);
    addEventListener('hashchange', routeChanged);
  }
  // Only fixed title subtrees may retain old text. The document observer needs
  // mutation order/first appearances, not the previous contents of the body.
  const titleObserver = new MutationObserver(records => titleRecords.push(...records));
  const observer = new MutationObserver(records => consume(records));
  observer.observe(doc, { subtree: true, childList: true, characterData: true,
    attributes: true, attributeFilter: ['id'] });
  function remember(title, node = title) {
    owners.set(node, title);
    for (const child of node.childNodes) remember(title, child);
  }
  function track(title, verify = true) {
    if (!watched.has(title)) {
      watched.add(title);
      titleObserver.observe(title, { subtree: true, characterData: true, characterDataOldValue: true });
    }
    remember(title);
    if (watched.size > 256 || (verify && !acceptable((title.textContent ?? '').trim()))) changed = true;
  }
  function capture(root) {
    if (root.nodeType !== 1) return;
    const titles = [...(root.matches(titleSelector) ? [root] : []), ...root.querySelectorAll(titleSelector)];
    for (const title of titles) track(title);
  }
  function consume(records = observer.takeRecords()) {
    const localCounts = new Map();
    for (const record of [...titleRecords.splice(0), ...titleObserver.takeRecords()]) {
      localCounts.set(record.target, (localCounts.get(record.target) ?? 0) + 1);
      if (record.oldValue === record.target.data) continue; // identical assignment, including a later cloned Text node
      const title = owners.get(record.target) ?? [...watched].find(node => node.contains(record.target));
      let found = false;
      const priorText = node => {
        if (node === record.target) { found = true; return record.oldValue ?? ''; }
        return node.nodeType === 3 ? node.data : [...node.childNodes].map(priorText).join('');
      };
      const prior = title ? priorText(title).trim() : '';
      // Reconstruct the full title around a changed Text node: a nested volume
      // fragment is not itself a different book. Detached/unknown fragments
      // cannot establish an allowed full title and remain fail-closed.
      if (!title || !acceptable(found ? prior : (record.oldValue ?? '').trim())) changed = true;
    }
    for (const record of records) {
      for (const title of watched) {
        if (record.target !== title && !title.contains(record.target) && owners.get(record.target) !== title) continue;
        if (record.type === 'characterData') {
          const count = localCounts.get(record.target) ?? 0;
          if (count) localCounts.set(record.target, count - 1);
          // A title first inserted and edited in one task was not yet locally
          // observed. Do not infer its history from only its final text.
          else changed = true;
        }
        if (record.type === 'childList') {
          const removedText = [...record.removedNodes].map(node => node.textContent ?? '').join('');
          const addedText = [...record.addedNodes].map(node => node.textContent ?? '').join('');
          if (removedText === addedText) continue; // identical nested redraw
          for (const node of record.removedNodes) {
            const text = (node.textContent ?? '').trim();
            if (text && !acceptable(text)) changed = true;
          }
        }
      }
      for (const node of record.removedNodes) capture(node);
      for (const node of record.addedNodes) capture(node);
      if (record.type === 'attributes') capture(record.target);
    }
    for (const title of watched) remember(title);
  }
  function current() {
    consume();
    if (watchRouteHistory && historyMethods.some(([key, , wrapped]) => history[key] !== wrapped)) changed = true;
    if (document !== doc || route(expectedOrigin, expectedBook.asin) !== 'match') {
      if (watchRouteHistory) changed = true;
      return 'changed';
    }
    const titles = doc.querySelectorAll(titleSelector);
    if (titles.length > 1) return 'multiple';
    if (titles.length === 1) {
      const title = titles[0], text = (title.textContent ?? '').trim();
      track(title, false);
      if (text && !acceptable(text)) return confirmed || changed ? 'changed' : 'title-mismatch';
      if (text && acceptable(text)) confirmed = true;
    }
    if (changed) return 'changed';
    return confirmed && titles.length === 1 && acceptable((titles[0].textContent ?? '').trim())
      && (titles[0].textContent ?? '').trim() ? 'current' : 'waiting';
  }
  function run(metadata) {
    let state = current();
    if (state !== 'current') return { state };
    const value = inspect({ expectedOrigin, metadata, expectedMode: true });
    state = current();
    if (state !== 'current') return { state };
    if (metadata && value.state === 'ok') {
      if (!allowed.has(normalize(value.title))) return { state: 'changed' };
      return { ...value, asin: expectedBook.asin };
    }
    return value;
  }
  for (const title of doc.querySelectorAll(titleSelector)) track(title, false);
  return { current, probe: () => run(false), read: () => run(true), dispose: () => {
    observer.disconnect(); titleObserver.disconnect();
    for (const [key, original, wrapped] of historyMethods) if (history[key] === wrapped) history[key] = original;
    if (watchRouteHistory) { removeEventListener('popstate', routeChanged); removeEventListener('hashchange', routeChanged); }
  } };
}

// A single deadline covers connection, optional fixed-route recovery, and
// readiness. No user-selected URL, profile, selector or second page is used.
export async function observeExpectedBook(child, expectedOrigin, expectedBook, { deadlineMs, projectMetadata }) {
  const until = performance.now() + deadlineMs;
  let lastReason;
  const timeout = () => Object.assign(fail('readiness-timeout'), { detail: lastReason });
  const bounded = async action => {
    const remaining = until - performance.now();
    if (remaining <= 0) throw timeout();
    let timer;
    try { return await Promise.race([Promise.resolve().then(action), new Promise((_, reject) => { timer = setTimeout(() => reject(timeout()), remaining); })]); }
    finally { clearTimeout(timer); }
  };
  const transport = ownedPipeTransport(child);
  let page, frame, watch, pageChanged = false, navigated = false, navigation = 0;
  try {
    const { chromium } = await bounded(() => import('playwright'));
    const browser = await bounded(() => chromium.connectOverCDP(transport, { noDefaults: true, timeout: Math.max(1, until - performance.now()) }));
    const contexts = browser.contexts();
    if (contexts.length !== 1) throw fail('context-ambiguous');
    const [context] = contexts, earlyPages = new Set();
    context.on('page', candidate => {
      if (page && candidate !== page) pageChanged = true;
      else if (!page) { earlyPages.add(candidate); if (earlyPages.size > 1) pageChanged = true; }
    });
    const checkPage = () => {
      const pages = context.pages();
      if (!page && (pages.length > 1 || pageChanged)) throw fail('multiple-page-targets');
      if (!page && earlyPages.size && (pages.length !== 1 || !earlyPages.has(pages[0]))) throw fail('target-changed');
      if (page && (pageChanged || page.isClosed() || page.mainFrame() !== frame || pages.length !== 1 || pages[0] !== page)) throw fail('target-changed');
      return pages;
    };
    const routeExpression = `(${expectedRoute.toString()})(${JSON.stringify(expectedOrigin)}, ${JSON.stringify(expectedBook.asin)})`;
    while (!watch) {
      const pages = checkPage();
      if (!page && pages.length === 1) {
        [page] = pages; frame = page.mainFrame();
        page.on('close', () => { pageChanged = true; });
        page.on('framenavigated', changed => { if (changed === frame) navigation++; });
      }
      if (!page) { await bounded(() => sleep(50)); continue; }
      const routeNavigation = navigation;
      let route;
      try { route = await bounded(() => page.evaluate(routeExpression)); }
      catch (error) { if (error?.reason === 'readiness-timeout') throw error; await bounded(() => sleep(50)); continue; }
      checkPage();
      if (route === 'starting') { await bounded(() => sleep(50)); continue; }
      if (route === 'blocking') throw fail('blocking-ui');
      if (route === 'mismatch') throw fail('book-mismatch');
      if (route === 'unavailable') throw fail('document-unavailable');
      if (route === 'placeholder') {
        if (navigated) { await bounded(() => sleep(50)); continue; }
        navigated = true; // even an uncertain navigation is never retried
        const expression = `(() => { if (${routeExpression} !== 'placeholder') return false; location.assign(${JSON.stringify(expectedOrigin + '/?asin=' + expectedBook.asin)}); return true; })()`;
        let sent;
        try { sent = await bounded(() => page.evaluate(expression)); }
        catch (error) { if (error?.reason === 'readiness-timeout') throw error; throw fail('target-changed'); }
        if (!sent) throw fail('target-changed');
        await bounded(() => sleep(50)); continue;
      }
      if (route !== 'match') throw fail('document-unavailable');
      if (routeNavigation !== navigation) throw fail('target-changed');
      const expression = `(${installExpectedWatch.toString()})(${inspectKindleDocument.toString()}, ${expectedRoute.toString()}, ${JSON.stringify(expectedOrigin)}, ${JSON.stringify(expectedBook)})`;
      try { watch = await bounded(() => page.evaluateHandle(expression)); }
      catch (error) { if (error?.reason === 'readiness-timeout') throw error; throw fail('target-changed'); }
      if (routeNavigation !== navigation) throw fail('target-changed');
    }
    const evaluate = async callback => {
      checkPage();
      try { return await bounded(() => watch.evaluate(callback)); }
      catch (error) { if (error?.reason === 'readiness-timeout') throw error; throw fail('target-changed'); }
    };
    const validate = state => {
      if (state === 'changed') throw fail('target-changed');
      if (state === 'multiple') throw fail('multiple-markers');
      if (state === 'title-mismatch') throw fail('title-mismatch');
      if (!['current', 'waiting'].includes(state)) throw fail('probe-unavailable');
    };
    while (true) {
      const current = await evaluate(value => value.current());
      validate(current);
      if (current === 'waiting') { lastReason = 'reader-identity-missing'; await bounded(() => sleep(50)); continue; }
      const state = await evaluate(value => value.probe());
      validate(state?.state === 'ready' || state?.state === 'unavailable' ? 'current' : state?.state);
      if (state?.state === 'waiting') { lastReason = 'reader-identity-missing'; await bounded(() => sleep(50)); continue; }
      if (state?.markers && Object.values(state.markers).some(marker => marker.count === 'multiple')) throw fail('multiple-markers');
      if (state?.state === 'ready') {
        const before = await evaluate(value => value.current());
        validate(before);
        if (before !== 'current') throw fail('target-changed');
        const value = await evaluate(value => value.read()); // the only metadata attempt
        const after = await evaluate(value => value.current());
        validate(after);
        if (after !== 'current' || ['changed', 'multiple', 'waiting', 'title-mismatch'].includes(value?.state)) throw fail('target-changed');
        if (value?.state !== 'ok') throw fail(value?.reason ?? 'invalid-metadata');
        return projectMetadata(value, { expected: true });
      }
      if (!waitable.has(state?.reason)) throw fail(state?.reason ?? 'probe-unavailable');
      lastReason = state.reason;
      await bounded(() => sleep(50));
    }
  } catch (error) {
    if (typeof error?.reason === 'string') throw error;
    throw fail('probe-unavailable');
  } finally {
    if (watch && performance.now() < until) {
      try { await bounded(() => watch.evaluate(value => value.dispose())); } catch { /* retain fixed failure */ }
    }
    transport.close();
  }
}
