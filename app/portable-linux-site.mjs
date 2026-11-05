import { AppError } from './store-client.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { consumePortableArchiveCapture } from './portable-postprocess-ticket.mjs';
import { assertPortableNormalJob } from './portable-normal-job.mjs';
export { startPortableReaderSite } from './portable-reader-site.mjs';
export { portableReaderCapability } from './portable-limited-session.mjs';

// The user's finite per-job trial permission applies to this selected bundle
// only. An existing login/profile or a historical claim is never permission.
// Moving/copying source or setting a flag cannot arm another installation.
const selectedBundle = '/home/user/KTZ-Portable';
const ownRoot = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
// Normal use follows the verified Portable launcher's own relative data root.
// It still requires a new normal job, explicit saved session, preview approval
// and a separate start; the historical one-shot trial is installation-specific.
export function portableNormalAvailable(dataDirectory) {
  return process.platform === 'linux' && process.env.KTZ_PORTABLE_ROOT === ownRoot
    && dataDirectory === path.join(ownRoot, 'data/application');
}
export function portableLimitedAvailable(dataDirectory) {
  return process.platform === 'linux' && ownRoot === selectedBundle
    && process.env.KTZ_PORTABLE_ROOT === ownRoot
    && dataDirectory === path.join(ownRoot, 'data/application');
}
export async function authorizePortableKindle(selected, job, normalJobCheck = null) {
  const data = path.dirname(selected?.root ?? '');
  if (normalJobCheck !== null) {
    if (!portableNormalAvailable(data) || typeof normalJobCheck !== 'function') throw new AppError('linux_kindle_permission_required');
    await normalJobCheck();
    await assertPortableNormalJob(path.dirname(selected.root), job, selected.id);
    return 'portable-normal';
  }
  if (!portableLimitedAvailable(data)) throw new AppError('linux_kindle_permission_required');
  await consumePortableArchiveCapture(path.dirname(selected.root), job, selected.id);
  return 'portable-limited';
}
