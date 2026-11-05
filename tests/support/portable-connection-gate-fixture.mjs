// Test-only consent and site adapter. The product's selected-profile owner,
// lock, process supervision, pipe, Reader and shutdown are not substituted.
// This module is not part of the portable distribution.
import path from 'node:path';
import { startOwnedSample, ownedSampleOptions, ownedGuiCapabilityForOwner } from '../../app/owned-sample.mjs';
import { anonymousExpectedBook } from '../../app/owned-sample-identity.mjs';

const root = process.env.KTZ_PORTABLE_CONNECTION_ROOT;
const base = '/home/user/KTZRC';
if (!root?.startsWith(`${base}/portable-connection-`) || path.dirname(root) !== base) throw new Error('anonymous_only');

export async function authorizePortableKindle(selected) {
  if (selected?.root !== path.join(root, 'data', selected.id)
      || selected.profile !== path.join(selected.root, 'owned/profile')
      || !/^saved-[a-f0-9-]{36}$/.test(selected.id)) throw new Error('anonymous_fixture_only');
  return 'fixed-anonymous';
}

export async function startPortableReaderSite() {
  if (process.env.KTZ_PORTABLE_READER_DATA !== path.join(root, 'data')
      || !/^saved-[a-f0-9-]{36}$/.test(process.argv[3] ?? '')) throw new Error('anonymous_fixture_only');
  const sample = await startOwnedSample();
  const options = ownedSampleOptions(sample);
  return { url: `${sample.url}?asin=${anonymousExpectedBook.asin}`,
    flags: [...options.args, `--proxy-server=${options.proxy.server}`, `--proxy-bypass-list=${options.proxy.bypass}`, '--remote-debugging-pipe'],
    close: () => sample.close() };
}

export function portableReaderCapability(owner) {
  return ownedGuiCapabilityForOwner(owner);
}
