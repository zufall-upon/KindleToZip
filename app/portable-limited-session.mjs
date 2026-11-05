import { randomUUID } from 'node:crypto';
import { AppError } from './store-client.mjs';
import { isManagedLinuxReader } from './linux-owned-reader.mjs';
import { createKindleAdapter, kindleChromeConfig } from './stores/kindle.mjs';
import { bindExpectedIdentity } from './expected-identity.mjs';
import { expectedRoute } from './linux-playwright-expected-observe.mjs';
import { inspectKindleDocument } from './linux-reader-probe.mjs';
import { createPortableLimitedCaptureBudget, createNormalCaptureBudget } from './expected-capture-budget.mjs';
import { assertPortableLimitedClaimBinding } from './portable-limited-claim.mjs';
import { portableStartupObservation } from './portable-startup-observation.mjs';
import { captureStartupDiagnostic } from './expected-capture-diagnostic.mjs';

const sessions = new WeakMap();
const normalGuards = new WeakMap();
export const portableLimitedSession = capability => sessions.get(capability);
export const isPortableNormalGuard = (capability, reader, guard) => {
  const binding = normalGuards.get(capability);
  return Boolean(binding && binding.reader === reader && binding.guard === guard);
};
const origin = 'https://read.amazon.co.jp';
// Static official origins already listed in linux-auth-reuse-core.mjs. Only
// their constants are reused: never run its authentication UI/profile probe.
const bootstrapAuthOrigins = new Set(['https://www.amazon.co.jp', 'https://amazon.co.jp']);
const fail = cause => { throw new AppError('target_changed', { cause }); };
function canonicalPageUrl(current) {
  try {
    if (typeof current === 'string' && !/[\u0000-\u0020\u007f\\]/.test(current)) {
      const value = new URL(current);
      if (value.protocol === 'https:' && !value.username && !value.password) return value;
    }
  } catch { /* unknown/ambiguous URLs never grant a role */ }
  return null;
}
// Keep the existing error and refusal. Only the already closed identity
// diagnostic may be carried into the Application's existing detail channel.
const identityDetail = error => {
  const identity = captureStartupDiagnostic(error);
  if (identity && error instanceof AppError && error.code === 'target_changed') {
    error.detail = { cause: 'expected_identity_changed', identity };
  }
  return error;
};
// Never retain or return the actual URL, hostname or path. This observes the
// existing rejection; no category grants permission or changes readiness.
function rejectedOriginKind(value) {
  if (typeof value !== 'string') return 'unknown';
  if (value === '' || value === ':') return 'uncommitted';
  if (value === 'about:blank') return 'blank';
  try {
    const protocol = new URL(value).protocol;
    if (['chrome:', 'chrome-error:', 'chrome-untrusted:', 'devtools:'].includes(protocol)) return 'browser_internal';
    if (protocol === 'https:') return 'other_https';
    if (protocol === 'http:') return 'other_http';
    return 'other_scheme';
  } catch { return 'invalid'; }
}

// The owner, not an HTTP request or matching-shaped object, supplies transport.
// Book identity is deliberately established only on the user's explicit preview.
export function portableReaderCapability(owner, claim, startupRecord, normalJobCheck = null) {
  if (!isManagedLinuxReader(owner) || owner.url !== undefined || !owner.processIds) fail('owner_binding_changed');
  if (normalJobCheck !== null && typeof normalJobCheck !== 'function') fail('owner_binding_changed');
  const normal = normalJobCheck !== null;
  let bound = false, initialPage, initialContext, initialBrowser, initialInvalid = false, reachedOrigin = false;
  let navigationStarted = false, navigationCommitted = false, initialReady = false;
  let initialNavigation = 0, companionPin;
  let firstRejection = null, closing = false;
  const adapter = createKindleAdapter('jp');
  const startup = portableStartupObservation(owner, startupRecord);
  const observeRejection = (reason, originObservation) => {
    if (closing || firstRejection !== null) return;
    firstRejection = reason;
    // Observation is not a guard or permission. A broken observer must neither
    // replace target_changed nor interrupt normal owner shutdown.
    try { startupRecord?.initialRejection?.(reason, originObservation); } catch { /* preserve safety */ }
  };
  const rejectInitial = (reason, observation) => { initialInvalid = true; observeRejection(reason, observation); fail(firstRejection); };
  const checkInitial = ({ allowBootstrap = false } = {}) => {
    // Keep the former short-circuit order and the same target_changed refusal.
    if (initialInvalid) rejectInitial('initial_invalid');
    if (!initialPage) rejectInitial('initial_page_missing');
    if (initialPage.isClosed()) rejectInitial('page_closed');
    if (initialPage.context() !== initialContext) rejectInitial('context_changed');
    if (!initialBrowser?.isConnected()) rejectInitial('browser_disconnected');
    if (initialBrowser.contexts().length !== 1 || initialBrowser.contexts()[0] !== initialContext) rejectInitial('context_changed');
    const pages = initialContext.pages();
    if (!pages.includes(initialPage)) rejectInitial('initial_page_missing');
    if (!initialReady && (pages.length !== 1 || pages[0] !== initialPage)) rejectInitial('initial_invalid');
    const current = initialPage.url();
    if (current === 'about:blank' && allowBootstrap && !navigationCommitted && !reachedOrigin) return false;
    if (navigationStarted && current !== 'about:blank') navigationCommitted = true;
    const parsed = canonicalPageUrl(current);
    // Only preparePreview inside this owner capability can mint this role,
    // before its first asynchronous check. It grants no reading or auth status.
    // An initial page may not navigate, change origin/role or be replaced once
    // pinned, even if the URL/document is restored before the next assertion.
    if (companionPin) {
      if (initialPage !== companionPin.page || initialContext !== companionPin.context
          || initialNavigation !== companionPin.navigation || parsed?.origin !== companionPin.origin) rejectInitial('initial_invalid');
      return false;
    }
    const matches = parsed?.origin === origin;
    if (!matches && allowBootstrap && !reachedOrigin && parsed && bootstrapAuthOrigins.has(parsed.origin)) {
      return false; // The user may continue in the official browser; no capture is granted.
    }
    if (!matches) {
      initialInvalid = true;
      rejectInitial('origin_mismatch', { kind: rejectedOriginKind(current), reachedExpectedOrigin: reachedOrigin });
    }
    reachedOrigin = true;
    return true;
  };
  const onNavigation = frame => {
    if (frame !== initialPage.mainFrame()) return;
    initialNavigation += 1;
    try {
      if (!navigationStarted) rejectInitial('initial_invalid');
      checkInitial({ allowBootstrap: true });
    }
    catch { initialInvalid = true; observeRejection('unclassified'); }
  };
  const onPageLost = () => { initialInvalid = true; observeRejection('page_closed'); };
  const onBrowserLost = () => { initialInvalid = true; observeRejection('browser_disconnected'); };
  const onContextLost = () => { initialInvalid = true; observeRejection('context_changed'); };
  const onAdditionalPage = () => { if (!initialReady) { initialInvalid = true; observeRejection('initial_invalid'); } };
  const close = () => {
    closing = true;
    startup.dispose();
    initialPage?.off('framenavigated', onNavigation); initialPage?.off('close', onPageLost);
    initialContext?.off('close', onContextLost); initialContext?.off('page', onAdditionalPage);
    initialBrowser?.off('disconnected', onBrowserLost);
    return owner.close();
  };
  const capability = Object.freeze({ limited: !normal, normal, close });
  sessions.set(capability, Object.freeze({
    adapter, transport: owner.transport, close, startupRecord,
    ...startup,
    async ready(page) {
      if (initialPage) fail('initial_already_bound');
      startup.claimInitialPage(page);
      initialPage = page; initialContext = page.context(); initialBrowser = initialContext.browser();
      page.on('framenavigated', onNavigation); page.on('close', onPageLost); initialBrowser?.on('disconnected', onBrowserLost);
      initialContext.on('close', onContextLost); initialContext.on('page', onAdditionalPage);
      await owner.assertOwned();
      if (checkInitial({ allowBootstrap: true }) || page.url() !== 'about:blank') rejectInitial('initial_invalid');
      // The normal fixed navigation is enough. Do not add a separate wait for
      // authentication or inspect that page before the user chooses a book.
      navigationStarted = true;
      try { await page.goto(`${origin}/`, { waitUntil: 'commit', timeout: 30_000 }); }
      catch (error) { initialInvalid = true; throw error; }
      navigationCommitted = true;
      await owner.assertOwned();
      checkInitial({ allowBootstrap: true });
      initialReady = true;
    },
    async bind(reader) {
      if (bound) fail('guard_already_bound');
      bound = true;
      const { context } = reader;
      let budget = normal ? createNormalCaptureBudget() : createPortableLimitedCaptureBudget();
      let page, pages, generation, pageSession, browserSession, target, window, documentPin;
      let identity, documentKey, positionWatch, shape, last, failed = false, selecting = true;
      const owned = async () => {
        if (failed || budget.snapshot().phase === 'failed' || reader.context !== context || !context.browser()?.isConnected()) fail('owner_binding_changed');
        if (normal) await normalJobCheck();
        else await assertPortableLimitedClaimBinding(claim?.dataDirectory, claim?.jobId, claim?.sessionId);
        await owner.assertOwned();
        if (context !== initialContext) fail('context_changed');
        checkInitial({ allowBootstrap: selecting });
        if (selecting) return;
        const currentPages = context.pages();
        if (!page || reader.page !== page || reader.explicitPage !== page) fail('selected_page_changed');
        if (reader.generation !== generation) fail('generation_changed');
        if (page.isClosed() || currentPages.length !== pages.size || currentPages.some(item => !pages.has(item))) fail('page_set_changed');
        if (!await documentPin.evaluate(value => value === document).catch(() => false)) fail('document_changed');
        const current = (await pageSession.send('Target.getTargetInfo')).targetInfo;
        if (current.targetId !== target.targetId || current.type !== 'page') fail('target_identity_changed');
        const mapped = await browserSession.send('Browser.getWindowForTarget', { targetId: target.targetId });
        if (mapped.windowId !== window.windowId) fail('window_identity_changed');
        const state = (await browserSession.send('Browser.getWindowBounds', { windowId: window.windowId })).bounds.windowState;
        if (!['normal', 'maximized', 'fullscreen'].includes(state)) throw new AppError('window_not_available');
      };
      const disposePreview = async () => {
        documentKey = undefined;
        await identity?.dispose();
        await positionWatch?.evaluate(value => value.dispose()).catch(() => {});
        await positionWatch?.dispose().catch(() => {});
        await documentPin?.dispose().catch(() => {});
        await pageSession?.detach().catch(() => {}); await browserSession?.detach().catch(() => {});
        identity = positionWatch = documentPin = pageSession = browserSession = undefined;
      };
      const guard = {
        limited: !normal, normal, get singleRunBudget() { return budget; }, allowsIdentityRedraw: true, allowsLibraryReader: true,
        // Only this pinned normal top-level Reader delegates same-document
        // navigation. Generic/iframe mappings and legacy limited runs retain
        // Reader's existing invalidation. The key belongs to this document
        // binding, not just the CDP target (which survives document replacement).
        get documentIdentity() {
          return normal && !failed && !selecting && identity && documentPin
            && reader.page === page && reader.generation === generation ? documentKey : undefined;
        },
        handlesNavigation(candidate, frame) {
          return Boolean(guard.documentIdentity && candidate === page && frame === page.mainFrame()
            && adapter.isChromeConfiguration(reader.config));
        },
        validateConfig(config) {
          if (!config || Object.entries(kindleChromeConfig).some(([key, value]) => config[key] !== value)
              || Object.values(config.frames ?? {}).some(Boolean)) fail('configuration_changed');
        },
        async preparePreview() {
          try {
            if (normal) {
              // A new explicit preview has its own budget and observation pins.
              // An uncertain sent checkpoint is still refused by Application.
              budget.fail();
              await disposePreview();
              budget = createNormalCaptureBudget();
              failed = false; selecting = true; shape = last = undefined;
            } else budget.beginPreview();
            // Pin the chosen role, generation and page set before awaiting
            // owner/claim checks. A change during the pin gap is not adopted.
            page = reader.explicitPage;
            pages = new Set(context.pages()); generation = reader.generation;
            const initialOrigin = canonicalPageUrl(initialPage.url())?.origin;
            if (page && page !== initialPage && !reachedOrigin && bootstrapAuthOrigins.has(initialOrigin)) {
              companionPin = Object.freeze({ page: initialPage, context: initialContext,
                origin: initialOrigin, navigation: initialNavigation });
            }
            await owned();
            // New pages and reselection are ordinary preparation, not consent.
            // Pin only the user's explicit target, never the initial library or
            // the newest/sole candidate automatically. No other context joins.
            const currentPages = context.pages();
            if (!page || page !== reader.page || reader.explicitPage !== page || !currentPages.includes(page) || page.isClosed()
                || page.context() !== context || !adapter.acceptsUrl(page.url())
                || currentPages.some(item => !adapter.acceptsUrl(item.url()) && !(companionPin && item === companionPin.page
                  && item.context() === companionPin.context && canonicalPageUrl(item.url())?.origin === companionPin.origin))) fail('preview_selection_unavailable');
            if (reader.generation !== generation) fail('generation_changed');
            if (currentPages.length !== pages.size || currentPages.some(item => !pages.has(item))) fail('page_set_changed');
            documentPin = await page.evaluateHandle(() => document);
            pageSession = await context.newCDPSession(page);
            browserSession = await context.browser().newBrowserCDPSession();
            target = (await pageSession.send('Target.getTargetInfo')).targetInfo;
            window = await browserSession.send('Browser.getWindowForTarget', { targetId: target.targetId });
            selecting = false;
            await owned();
            // Read only the known public route identity and visible reader
            // markers, never the library contents or a service-private API.
            const book = await page.evaluate(() => {
              const match = /^\/(?:manga|kindle-library\/manga-wr)\/([A-Z0-9]{10})\/?$/.exec(location.pathname);
              const keys = new URLSearchParams(location.search).getAll('asin');
              if (keys.length > 1 || keys.length && !/^[A-Z0-9]{10}$/.test(keys[0])
                  || match && keys.length && match[1] !== keys[0]) return null;
              if (!match && !['/', '/kindle-library', '/kindle-library/'].includes(location.pathname)) return null;
              const asin = match?.[1] ?? keys[0];
              const title = document.querySelector('#readerChromeTitle');
              const text = title?.innerText?.trim();
              if (!asin || !text || text.length > 500 || document.querySelectorAll('#readerChromeTitle').length !== 1) return null;
              return { asin, title: text, aliases: [] };
            });
            if (!book) throw new AppError('reader_ui_unknown');
            identity = await bindExpectedIdentity(reader, origin, book, expectedRoute, kindleChromeConfig.identity, 2500, {
              permittedPages: [...pages],
              ...(normal ? { onDocumentChanged: () => reader.changed() } : {}),
            });
            documentKey = randomUUID();
            // A user position change after preview is sticky even if restored.
            // The app's sole page-turn runs under the separately reserved phase.
            positionWatch = await page.evaluateHandle(nextSelector => {
              let changed = false, allowed = false, clicks = 0;
              const next = document.querySelector(nextSelector);
              // Page buttons normally assign range.value without dispatching a
              // slider input event. Remember navigation intent as well, so a
              // next/previous round trip cannot revive the pinned preview.
              const navigation = 'button[aria-label*="次"], button[aria-label*="next" i], button[aria-label*="前"], button[aria-label*="戻"], button[aria-label*="previous" i], button[aria-label*="back" i]';
              const listener = event => {
                if (event.target?.matches?.('input[type="range"]') && (!allowed || event.isTrusted)) changed = true;
              };
              const click = event => {
                const button = event.target?.closest?.(navigation);
                if (button && (!allowed || button !== next || !event.isTrusted || ++clicks !== 1)) changed = true;
              };
              const key = event => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) changed = true; };
              document.addEventListener('input', listener, true); document.addEventListener('change', listener, true);
              document.addEventListener('click', click, true); document.addEventListener('keydown', key, true);
              return { current: () => !changed, turning: value => {
                if (value) clicks = 0;
                else if (clicks !== 1) changed = true;
                allowed = value;
                return !changed;
              }, dispose() {
                document.removeEventListener('input', listener, true); document.removeEventListener('change', listener, true);
                document.removeEventListener('click', click, true); document.removeEventListener('keydown', key, true);
              } };
            }, kindleChromeConfig.next);
            await guard.observe();
          } catch (error) { failed = true; budget.fail(); throw identityDetail(error); }
        },
        async assertIdentity() {
          try {
            await owned();
            if (!selecting) {
              if (!identity) fail('identity_not_bound');
              await identity.assertIdentity();
              if (!await positionWatch.evaluate(value => value.current())) fail('position_changed');
            }
          } catch (error) { failed = true; budget.fail(); throw error instanceof AppError ? identityDetail(error)
            : new AppError('target_changed', { cause: 'identity_check_unavailable' }); }
        },
        async observe() {
          await guard.assertIdentity();
          if (selecting) fail('identity_not_bound');
          const value = await page.evaluate(inspectKindleDocument, { expectedOrigin: origin, metadata: true, expectedMode: true });
          await guard.assertIdentity();
          if (value.state !== 'ok') throw new AppError('reader_ui_unknown');
          const p = value.position, currentShape = JSON.stringify([p.min, p.max, value.region]);
          if (shape && shape !== currentShape) fail('display_shape_changed');
          if (last && p.value !== last.value && !['turning', 'turn-sent'].includes(budget.snapshot().phase)) fail('position_changed');
          shape = currentShape; last = p;
          return `${shape}:${p.value}`;
        },
        atEnd() { return last && last.value >= last.max; },
        validateTransition(before, after) {
          if (!last || !Number.isFinite(Number(before)) || !Number.isFinite(Number(after))
              || Number(after) <= Number(before) || Number(after) > last.max) fail('position_transition_changed');
        },
        async beforeAdvance() { if (!await positionWatch.evaluate(value => value.turning(true))) fail('position_changed'); },
        async afterAdvance() { if (!await positionWatch.evaluate(value => value.turning(false))) fail('position_changed'); },
        async dispose() { await disposePreview(); },
      };
      await owned();
      if (normal) { Object.freeze(guard); normalGuards.set(capability, { reader, guard }); }
      return guard;
    },
  }));
  return capability;
}
