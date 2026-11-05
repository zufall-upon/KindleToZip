// Self-authored sample only. The fixed owner chooses this identity; it is not
// loaded from a user profile, page, IPC message, or an authorization setting.
export const anonymousExpectedBook = Object.freeze({
  asin: 'B000KTZ001', title: '自作試料 / 12画面 / 実書籍ではありません', aliases: Object.freeze([]),
});

// Serialized into the anonymous top-level page; unlike the official route
// resolver, only this exact fixture path and one ASIN query are valid.
export function anonymousExpectedRoute(expectedOrigin, expectedAsin) {
  if (location.origin !== expectedOrigin || location.pathname !== '/reader.html'
    || document.visibilityState !== 'visible' || document.readyState === 'loading') return 'unavailable';
  const params = new URLSearchParams(location.search);
  const asins = params.getAll('asin');
  if (asins.length !== 1 || [...params.keys()].some(key => key !== 'asin') || location.hash) return 'unavailable';
  return asins[0] === expectedAsin ? 'match' : 'mismatch';
}
