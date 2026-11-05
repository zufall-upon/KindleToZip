import { AppError } from './store-client.mjs';

// Dependency errors are untrusted, including their `code` property. A plausible
// identifier is not proof that it contains no account information or secret.
const codes = new Set(['operation_failed', 'operation_timeout', 'target_changed',
  'owned_pipe_unconfirmed', 'owned_pipe_release_unconfirmed', 'expected_reader_not_ready',
  'expected_capture_budget_exhausted', 'expected_capture_new_job_required',
  'reader_ui_unknown', 'window_not_available', 'display_unstable',
  'display_or_position_unknown', 'capture_failed', 'capture_dimensions_mismatch',
  'black_image', 'image_review_required', 'advance_uncertain', 'end_candidate',
  'capture_limit_reached', 'storage_durability_uncertain', 'storage_reopen_required']);

export function safeCaptureCode(error) {
  return codes.has(error?.code) ? error.code : 'operation_failed';
}

const reasons = Object.freeze({
  connection: ['connection_failed'],
  context: ['no_context', 'multiple_contexts'],
  page: ['initial_zero_pages', 'multiple_pages', 'target_replaced'],
  route: ['restore_timeout', 'route_mismatch', 'route_unavailable', 'blocking_ui', 'initial_visibility_unavailable'],
  identity: ['identity_changed', 'document_changed', 'title_mismatch', 'multiple_titles', 'title_missing_timeout', 'identity_unavailable'],
  structure: ['markers_missing_timeout', 'markers_ambiguous', 'blocking_ui', 'reader_structure_unknown'],
  viewport: ['viewport_unavailable'],
});

// Strict closed projection shared with the public result collector. No value
// from a URL, exception message, title or DOM can become a diagnostic string.
export function projectCaptureStartupDiagnostic(value) {
  if (!value || Object.keys(value).sort().join(',') !== 'reason,stage'
    || !Object.hasOwn(reasons, value.stage) || !reasons[value.stage].includes(value.reason)) throw new Error('invalid_capture_diagnostic');
  return { stage: value.stage, reason: value.reason };
}

export function captureStartupFailure(stage, reason, code = 'target_changed') {
  return Object.assign(new AppError(code), { startupDiagnostic: projectCaptureStartupDiagnostic({ stage, reason }) });
}

export function captureStartupDiagnostic(error) {
  try { return projectCaptureStartupDiagnostic(error?.startupDiagnostic); } catch { return null; }
}

// Immediate selection contract: zero is classified, not silently replaced by a
// newly created page. A future wait policy needs its own restoration evidence.
export function singleCaptureContext(browser) {
  const contexts = browser.contexts();
  if (contexts.length !== 1) throw captureStartupFailure('context', contexts.length ? 'multiple_contexts' : 'no_context');
  const [context] = contexts, pages = context.pages();
  if (pages.length !== 1) throw captureStartupFailure('page', pages.length ? 'multiple_pages' : 'initial_zero_pages');
  return context;
}
