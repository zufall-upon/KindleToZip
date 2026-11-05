import { AppError } from './store-client.mjs';
import { installExpectedWatch } from './linux-playwright-expected-observe.mjs';
import { captureStartupFailure, captureStartupDiagnostic } from './expected-capture-diagnostic.mjs';

// Long-lived document binding, not a capability or consent. The owner supplies
// a fixed expectation and a target-specific route resolver; the page supplies
// the observed title and route. A document exchange or failed observation is sticky.
export async function bindExpectedIdentity(reader, expectedOrigin, expectedBook, route, titleSelector = '#readerChromeTitle', timeoutMs = 2500,
  { initialDeadline, permittedPages, onDocumentChanged } = {}) {
  const { context, page } = reader, frame = page.mainFrame();
  // The default expected-book flow remains strictly single-page. Only a caller
  // which has already pinned its owned context and explicit selected page may
  // supply the exact immutable page set which it permits alongside that page.
  const pages = new Set(permittedPages ?? [page]);
  let revoked = false, navigated = false, watch, navigationSession, disposed = false;
  // Playwright's framenavigated also includes History API changes in the *same*
  // document. This page-scoped CDP event means an actual document commit; only
  // parent presence is examined, never a URL, frame identifier or frame list.
  const onNavigation = event => {
    if (!event?.frame?.parentId && !navigated) {
      navigated = true;
      // Revoke the caller's operation generation synchronously on a real
      // document commit. History API updates do not emit this CDP event.
      onDocumentChanged?.();
    }
  };
  const releaseSession = session => {
    session.off('Page.frameNavigated', onNavigation);
    void Promise.resolve().then(() => session.detach()).catch(() => {});
  };
  const discardWatch = handle => {
    void Promise.resolve().then(() => handle.evaluate(value => value.dispose())).catch(() => {});
    void Promise.resolve().then(() => handle.dispose()).catch(() => {});
  };
  const bounded = async (action, deadline) => {
    let timer;
    try {
      const remaining = deadline === undefined ? timeoutMs : Math.max(0, Math.min(timeoutMs, deadline - Date.now()));
      if (remaining <= 0) throw new Error('identity_timeout');
      return await Promise.race([Promise.resolve().then(action), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('identity_timeout')), remaining);
      })]);
    } finally { clearTimeout(timer); }
  };
  try {
    // Pin the document before asynchronous CDP setup. A document exchange in
    // that setup gap destroys this handle; checking it never adopts a new one.
    const expression = `(${installExpectedWatch.toString()})(null, ${route.toString()}, ${JSON.stringify(expectedOrigin)}, ${JSON.stringify(expectedBook)}, ${JSON.stringify(titleSelector)}, true)`;
    watch = await bounded(async () => {
      const handle = await page.evaluateHandle(expression);
      if (disposed) discardWatch(handle);
      return handle;
    }, initialDeadline);
    await bounded(async () => {
      const session = await context.newCDPSession(page);
      // A timed-out attach can still resolve later. It may only detach, never
      // arm monitoring or install a watch after this binding has been rejected.
      if (disposed) { releaseSession(session); return; }
      navigationSession = session;
      session.on('Page.frameNavigated', onNavigation);
    }, initialDeadline);
    await bounded(() => navigationSession.send('Page.enable'), initialDeadline);
    const check = async (initial = false) => {
      try {
        const current = context.pages();
        if (!pages.has(page) || current.length !== pages.size || current.some(item => !pages.has(item)) || page.isClosed()) {
          throw captureStartupFailure('page', context.pages().length > 1 ? 'multiple_pages' : 'target_replaced');
        }
        if (revoked || navigated || reader.context !== context || reader.page !== page
          || page.mainFrame() !== frame || !context.browser()?.isConnected()) throw captureStartupFailure('identity', navigated ? 'document_changed' : 'identity_changed');
        const state = await bounded(() => watch.evaluate(value => value.current()), initial ? initialDeadline : undefined);
        if (state !== 'current' && !(initial && state === 'waiting')) throw captureStartupFailure('identity', state === 'title-mismatch' ? 'title_mismatch'
          : state === 'multiple' ? 'multiple_titles' : 'identity_changed');
        return state;
      } catch (error) {
        revoked = true;
        if (captureStartupDiagnostic(error)) throw error;
        throw captureStartupFailure('identity', initial && Date.now() >= initialDeadline ? 'title_missing_timeout' : 'identity_unavailable');
      }
    };
    const guard = {
      async assertIdentity() {
        await check();
      },
      async dispose() {
        disposed = true;
        releaseSession(navigationSession);
        await bounded(() => watch.evaluate(value => value.dispose())).catch(() => {});
        void Promise.resolve().then(() => watch.dispose()).catch(() => {});
      },
    };
    if (initialDeadline === undefined) await guard.assertIdentity();
    else {
      // Only an explicitly bounded initial restoration may wait for the first
      // title. Install the watch first so change-and-restore stays sticky even
      // while other reader markers are still being built. Later checks remain
      // strict: a once-bound identity may never return to a waiting state.
      while (await check(true) === 'waiting') {
        const remaining = initialDeadline - Date.now();
        if (remaining <= 0) throw new AppError('expected_reader_not_ready');
        await new Promise(resolve => setTimeout(resolve, Math.min(80, remaining)));
      }
    }
    return guard;
  } catch (error) {
    disposed = true;
    if (navigationSession) releaseSession(navigationSession);
    // A rejected initial identity must reach the owner without waiting for a
    // CDP cleanup response. The owner can then disconnect the transport and
    // enforce its own bounded shutdown even if this document stopped replying.
    if (watch) discardWatch(watch);
    if (captureStartupDiagnostic(error)) throw error;
    throw captureStartupFailure('identity', 'identity_unavailable');
  }
}
