import path from 'node:path';
import { AppError } from './store-client.mjs';
import { startLinuxOwnedReader, assertPortableReaderEnvironment } from './linux-owned-reader.mjs';
import { authorizePortableKindle, portableReaderCapability } from './portable-linux-site.mjs';
import { claimPortableLimitedRun } from './portable-limited-claim.mjs';

// A saved profile, successful preparation or previous one-shot claim is not
// consent. The fixed site policy and the new durable claim are both required.
// Authorisation/site policy is distinct from the product's selected-session
// owner. The latter resolves the ID again in its child, acquires the login
// owner's lock, and joins the same browser before releasing it.
export async function startPortableKindleReader(selected, job, checkPreparationState = () => {}, normalJobCheck = null) {
  let authorization;
  try {
    authorization = await authorizePortableKindle(selected, job, normalJobCheck); // before starting any owner or browser
    checkPreparationState();
    if (!['fixed-anonymous', 'fixed-expected-reader', 'portable-limited', 'portable-normal'].includes(authorization)) throw new AppError('linux_kindle_permission_required');
    if (!selected || typeof selected.root !== 'string' || !/^saved-[a-f0-9-]{36}$/.test(selected.id ?? '')
        || selected.root !== path.join(path.dirname(selected.root), selected.id)
        || selected.profile !== path.join(selected.root, 'owned/profile')) throw new AppError('select_saved_session');
    if (authorization === 'portable-limited') {
      // Reject before the claim if the original launch environment is absent.
      assertPortableReaderEnvironment();
      if (process.platform !== 'linux' || !process.env.WAYLAND_DISPLAY) throw new AppError('owned_pipe_unconfirmed');
      await claimPortableLimitedRun(path.dirname(selected.root), selected, job);
      checkPreparationState();
    }
    if (authorization === 'portable-normal') {
      assertPortableReaderEnvironment();
      if (process.platform !== 'linux' || !process.env.WAYLAND_DISPLAY) throw new AppError('owned_pipe_unconfirmed');
      await normalJobCheck();
      checkPreparationState();
    }
  } catch (error) { error.portableReaderNotStarted = true; throw error; }
  // From this point an unsuccessful start can leave an unknown owner behind.
  const owner = await startLinuxOwnedReader({ selected, expectedReader: authorization !== 'fixed-anonymous',
    usePortableEnvironment: ['portable-limited', 'portable-normal'].includes(authorization) });
  try {
    checkPreparationState();
    if (authorization === 'portable-normal') await normalJobCheck();
    return portableReaderCapability(owner, { dataDirectory: path.dirname(selected.root), sessionId: selected.id, jobId: job?.manifest?.job_id }, null,
      authorization === 'portable-normal' ? normalJobCheck : null);
  }
  catch (error) {
    try { await owner.close(); }
    catch (closeError) { throw new AggregateError([error, closeError], 'portable_reader_capability_and_close_failed', { cause: error }); }
    error.portableReaderClosed = true;
    throw error;
  }
}
