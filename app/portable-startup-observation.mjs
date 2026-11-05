// Local metadata only. This never chooses a tab or grants capture permission.
import { readOwnedStartupTargets, readOwnedStartupTargetsAfterControl } from './linux-playwright-pipe.mjs';

const kinds = ['reader_origin', 'known_auth_origin', 'other_https', 'blank', 'other', 'unknown'];
const counts = ['0', '1', 'multiple', 'unknown'];
const fail = () => Object.assign(new Error('owned_pipe_unconfirmed'), { code: 'owned_pipe_unconfirmed' });
let timeControlArmed = false, timeControlUsed = false;
// Only the validated selected-Portable pilot entry arms this internal one-use
// comparison. Normal startup has neither an extra query nor a ten-second wait.
export function enablePortableStartupTimeControl() {
  if (timeControlUsed) throw fail();
  timeControlUsed = true; timeControlArmed = true;
}
export function startupOriginKind(value) {
  if (value === 'about:blank' || value === '') return 'blank';
  if (typeof value !== 'string' || /[\u0000-\u0020\u007f\\]/.test(value)) return 'other';
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return 'other';
    if (url.origin === 'https://read.amazon.co.jp') return 'reader_origin';
    if (['https://www.amazon.co.jp', 'https://amazon.co.jp'].includes(url.origin)) return 'known_auth_origin';
    return 'other_https';
  } catch { return 'other'; }
}
export function projectStartupConnectionObservation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail();
  const has = key => Object.hasOwn(value, key);
  const keys = Object.keys(value).sort().join(',');
  const expected = [...(has('pre_playwright') ? ['pre_playwright'] : []), ...(has('pre_playwright_10s') ? ['pre_playwright_10s'] : []),
    ...(has('post_playwright') ? ['post_playwright', 'samePage'] : [])].sort().join(',');
  if (keys !== expected || has('pre_playwright_10s') && !has('pre_playwright')) throw fail();
  const result = {};
  if (has('pre_playwright')) {
    const pre = value.pre_playwright;
    if (!pre || Object.keys(pre).join(',') !== 'singlePage' || !kinds.includes(pre.singlePage)) throw fail();
    result.pre_playwright = { singlePage: pre.singlePage };
  }
  if (has('pre_playwright_10s')) {
    const control = value.pre_playwright_10s;
    if (!control || Object.keys(control).sort().join(',') !== 'complete,samePage,singlePage'
        || !kinds.includes(control.singlePage) || ![true, false, 'unknown'].includes(control.samePage)
        || typeof control.complete !== 'boolean' || !control.complete && (control.singlePage !== 'unknown' || control.samePage !== 'unknown')) throw fail();
    result.pre_playwright_10s = { singlePage: control.singlePage, samePage: control.samePage, complete: control.complete };
  }
  if (has('post_playwright')) {
    const post = value.post_playwright;
    if (!post || Object.keys(post).sort().join(',') !== 'ownedContext,readerCandidates,singlePage' || !kinds.includes(post.singlePage)
        || typeof post.ownedContext !== 'boolean' || !counts.includes(post.readerCandidates)
        || ![true, false, 'unknown'].includes(value.samePage)) throw fail();
    result.post_playwright = { singlePage: post.singlePage, ownedContext: post.ownedContext, readerCandidates: post.readerCandidates };
    result.samePage = value.samePage;
  }
  if (Object.keys(result).length === 0) throw fail();
  return result;
}
function target(value) {
  if (!value || value.type !== 'page' || value.subtype) return null;
  if (typeof value.targetId !== 'string' || !value.targetId || value.targetId.length > 512) throw fail();
  // Raw URLs/titles are discarded here. IDs stay private until comparison and
  // are never passed to the recorder, IPC, errors, or assertions.
  return { id: value.targetId, context: typeof value.browserContextId === 'string' && value.browserContextId.length > 0 && value.browserContextId.length <= 512 ? value.browserContextId : null,
    kind: startupOriginKind(value.url), initialBlank: value.url === 'about:blank' };
}
const bounded = async action => {
  let timer;
  try { return await Promise.race([Promise.resolve().then(action), new Promise((_, reject) => { timer = setTimeout(() => reject(fail()), 1500); })]); }
  finally { clearTimeout(timer); }
};

export function portableStartupObservation(owner, recorder) {
  const timeControl = timeControlArmed;
  if (timeControl) timeControlArmed = false;
  let prior, pre, control, initialPage, initialContext, initialBrowser, invalid = false;
  const reject = () => Object.assign(new Error('target_changed'), { code: 'target_changed' });
  const invalidate = () => { invalid = true; };
  const navigation = frame => { if (frame === initialPage.mainFrame()) invalidate(); };
  const dispose = () => {
    initialPage?.off('framenavigated', navigation); initialPage?.off('close', invalidate);
    initialContext?.off('page', invalidate); initialContext?.off('close', invalidate);
    initialBrowser?.off('disconnected', invalidate);
  };
  const assertPage = page => {
    if (invalid || !page || page !== initialPage || page.isClosed() || page.context() !== initialContext || initialContext.browser() !== initialBrowser
        || !initialBrowser?.isConnected() || initialBrowser.contexts().length !== 1
        || initialBrowser.contexts()[0] !== initialContext || initialContext.pages().length !== 1
        || initialContext.pages()[0] !== page || page.url() !== 'about:blank') throw reject();
  };
  return {
    dispose,
    claimInitialPage(page) { assertPage(page); dispose(); },
    async beforeAttach() {
      let refusal;
      const stopComparison = reason => {
        try { recorder?.initialRejection?.(reason); } catch { /* preserve refusal */ }
        refusal = reject();
        throw refusal;
      };
      try {
        await owner.assertOwned();
        prior = (await readOwnedStartupTargets(owner.transport)).map(target).filter(Boolean);
        if (new Set(prior.map(value => value.id)).size !== prior.length) throw fail();
        pre = { singlePage: prior.length === 1 ? prior[0].kind : 'unknown' };
        recorder?.connectionObservation?.({ pre_playwright: pre });
        if (prior.length !== 1 || prior[0].context === null || !prior[0].initialBlank) stopComparison('initial_invalid');
        if (timeControl) {
          if (prior.length !== 1 || prior[0].context === null || !['reader_origin', 'known_auth_origin', 'blank'].includes(prior[0].kind)) stopComparison('initial_invalid');
          const later = (await readOwnedStartupTargetsAfterControl(owner.transport)).map(target).filter(Boolean);
          await owner.assertOwned();
          control = { singlePage: later.length === 1 ? later[0].kind : 'unknown', samePage: later.length === 1 && later[0].context !== null
            ? later[0].id === prior[0].id && later[0].context === prior[0].context : 'unknown', complete: true };
          recorder?.connectionObservation?.({ pre_playwright: pre, pre_playwright_10s: control });
          if (control.samePage !== true) stopComparison('initial_invalid');
          if (control.singlePage === 'known_auth_origin') stopComparison('known_auth_pending');
          if (control.singlePage !== 'reader_origin') stopComparison('initial_invalid');
        }
      } catch (error) {
        if (timeControl && pre && !control) recorder?.connectionObservation?.({ pre_playwright: pre,
          pre_playwright_10s: { singlePage: 'unknown', samePage: 'unknown', complete: false } });
        if (error === refusal) throw error;
        throw fail();
      }
    },
    async afterAttach(browser) {
      let refusal;
      try {
        await owner.assertOwned();
        const contexts = browser.contexts();
        const context = browser.isConnected() && contexts.length === 1 ? contexts[0] : null;
        const pages = context?.pages() ?? [];
        let post = { singlePage: 'unknown', ownedContext: Boolean(context), readerCandidates: 'unknown' }, samePage = 'unknown', current;
        if (context && pages.every(page => !page.isClosed() && page.context() === context)) {
          if (pages.length === 1) {
            initialPage = pages[0]; initialContext = context; initialBrowser = browser;
            initialPage.on('framenavigated', navigation); initialPage.on('close', invalidate);
            initialContext.on('page', invalidate); initialContext.on('close', invalidate);
            initialBrowser.on('disconnected', invalidate);
          }
          const pageKinds = pages.map(page => startupOriginKind(page.url()));
          const readers = pageKinds.filter(kind => kind === 'reader_origin').length;
          post = { singlePage: pages.length === 1 ? pageKinds[0] : 'unknown', ownedContext: true,
            readerCandidates: readers === 0 ? '0' : readers === 1 ? '1' : 'multiple' };
          if (pages.length === 1 && prior?.length === 1) {
            current = await bounded(async () => {
              const session = await context.newCDPSession(pages[0]);
              try { return target((await session.send('Target.getTargetInfo')).targetInfo); }
              finally { await session.detach(); }
            });
            if (current && prior[0].context !== null && current.context !== null)
              samePage = prior[0].id === current.id && prior[0].context === current.context;
          }
          const now = context.pages();
          if (!browser.isConnected() || browser.contexts().length !== 1 || browser.contexts()[0] !== context
              || now.length !== pages.length || now.some((page, index) => page !== pages[index] || page.isClosed())) {
            post = { singlePage: 'unknown', ownedContext: false, readerCandidates: 'unknown' }; samePage = 'unknown';
          }
        }
        await owner.assertOwned();
        recorder?.connectionObservation?.({ ...(pre ? { pre_playwright: pre } : {}), ...(control ? { pre_playwright_10s: control } : {}), post_playwright: post, samePage });
        if (samePage !== true || !current?.initialBlank) { refusal = reject(); throw refusal; }
        try { assertPage(pages[0]); } catch (error) { refusal = error; throw error; }
      } catch (error) { if (error === refusal) throw error; throw fail(); }
      finally { prior = undefined; }
    },
  };
}
