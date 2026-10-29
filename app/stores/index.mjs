import { AppError } from '../store-client.mjs';
import { createKindleAdapter } from './kindle.mjs';

// Kindle is the only public store. A private fixture adapter exercises the same
// visible-DOM contract without enabling other stores or contacting services.
export function createStoreAdapter({ storeId = 'kindle', regionId = 'jp', sampleUrl } = {}) {
  if (storeId !== 'kindle') throw new AppError('unsupported_store');
  const kindle = createKindleAdapter(regionId);
  if (!sampleUrl) return kindle;
  return Object.freeze({
    ...kindle, id: 'sample', startUrl: sampleUrl,
    acceptsUrl: value => value === sampleUrl,
    async isLibrary(page) { return await page.locator('[data-ktz-sample-library="true"]').count() === 1; },
    async assertState(page) {
      const safe = await page.locator('#reader').evaluate(el => el.dataset.book === 'sample-a' && el.dataset.session === 'active' && el.dataset.overlay === 'false');
      if (!safe) throw new AppError('auth_or_target_changed');
    },
  });
}
