import { AppError } from './store-client.mjs';

// Per-operation fence for the narrowly authorised expected-book flow. It is
// not an authorisation by itself: the caller must still establish the expected
// identity and separately submit the user's approval and start. The ordinary
// capture path does not construct or use this budget.
export function createExpectedCaptureBudget() {
  let phase = 'preview', screenshots = 0, sends = 0, committed = 0, approved = null;
  const reject = () => { throw new AppError('expected_capture_budget_exhausted'); };
  const fail = () => { phase = 'failed'; };
  return Object.freeze({
    approve(limit) {
      if (phase !== 'previewed' || !Number.isSafeInteger(limit) || limit < 1 || limit > 2) reject();
      approved = limit;
      phase = 'approved';
    },
    start(limit) {
      if (phase !== 'approved' || limit !== approved) reject();
      phase = 'started';
    },
    async screenshot(purpose, send) {
      if (typeof send !== 'function') reject();
      if (purpose === 'preview') {
        if (phase !== 'preview' || screenshots !== 0) reject();
      } else if (purpose === 'capture') {
        // The first original must be the already checked preview. A second
        // image is allowed only after one committed original and one send.
        if (phase !== 'started' || approved !== 2 || committed !== 1 || sends !== 1 || screenshots !== 1) reject();
      } else reject();
      screenshots += 1; // Reserve before dispatch; timeout is still an attempt.
      const pending = purpose === 'preview' ? 'previewing' : 'capturing';
      phase = pending;
      try {
        const value = await send();
        if (phase !== pending) reject(); // A late reply cannot clear a failure.
        phase = purpose === 'preview' ? 'previewed' : 'started';
        return value;
      } catch (error) { fail(); throw error; }
    },
    commit() {
      if (phase !== 'started' || committed >= approved || committed >= screenshots) reject();
      committed += 1;
    },
    async advance(send) {
      if (phase !== 'started' || approved !== 2 || committed !== 1 || screenshots !== 1 || sends !== 0 || typeof send !== 'function') reject();
      sends += 1; // Reserve immediately before the real page input.
      phase = 'turning';
      try { const value = await send(); if (phase !== 'turning') reject(); phase = 'turn-sent'; return value; }
      catch (error) { fail(); throw error; }
    },
    confirmAdvance() {
      if (phase !== 'turn-sent' || sends !== 1 || committed !== 1) reject();
      phase = 'started';
    },
    finish() {
      if (phase !== 'started' || committed < 1 || committed > approved) reject();
      phase = 'finished';
    },
    fail,
    snapshot() { return { phase, screenshots, sends, committed, approved }; },
  });
}

// The Portable one-shot uses the same two-display/one-send accounting, but a
// changed selection or setting after the first preview must not be made usable
// by taking another preview. Changes while the user is still choosing a book
// are not themselves a capture attempt. This object is only a fence; it does
// not issue consent or establish a browser, job, target, or output policy.
export function createPortableLimitedCaptureBudget() {
  const budget = createExpectedCaptureBudget();
  let previewBegun = false;
  const reject = () => { throw new AppError('expected_capture_budget_exhausted'); };
  return Object.freeze({
    ...budget,
    // The guard must call this at the beginning of the explicit preview,
    // before identity/structure checks or any screenshot can be dispatched.
    beginPreview() {
      if (previewBegun || budget.snapshot().phase !== 'preview') reject();
      previewBegun = true;
    },
    async screenshot(purpose, send) {
      if (purpose === 'preview' && !previewBegun) reject();
      return budget.screenshot(purpose, send);
    },
    invalidate() {
      if (previewBegun && !['finished', 'failed'].includes(budget.snapshot().phase)) budget.fail();
    },
    // Application clears its approval when a later start supplies a different
    // limit. Unlike the general anonymous GUI this one-shot cannot re-approve.
    revokeApproval() { budget.fail(); },
  });
}

// Same Reader budget interface, but for a fresh, fixed anonymous GUI owner.
// A preview may be repeated before starting; no approval survives a changed
// target/settings or a finished/failed run. It grants no live-book authority.
export function createGuiCaptureBudget() {
  let phase = 'preview', screenshots = 0, sends = 0, committed = 0, approved = null;
  const reject = () => { throw new AppError('expected_capture_budget_exhausted'); };
  const fail = () => { phase = 'failed'; };
  return Object.freeze({
    invalidate() {
      if (['preview', 'previewed', 'approved'].includes(phase)) {
        phase = 'preview'; screenshots = 0; sends = 0; committed = 0; approved = null;
      } else if (!['finished', 'failed'].includes(phase)) fail();
    },
    approve(limit) {
      if (!['previewed', 'approved'].includes(phase) || !Number.isSafeInteger(limit) || limit < 1) reject();
      approved = limit; phase = 'approved';
    },
    revokeApproval() {
      if (phase === 'approved') { approved = null; phase = 'previewed'; }
    },
    start(limit) {
      if (phase !== 'approved' || limit !== approved) reject();
      phase = 'started';
    },
    async screenshot(purpose, send) {
      if (typeof send !== 'function') reject();
      if (purpose === 'preview') {
        if (phase !== 'preview' || screenshots !== 0) reject();
      } else if (purpose === 'capture') {
        if (phase !== 'started' || committed < 1 || committed >= approved || sends !== committed || screenshots !== committed) reject();
      } else reject();
      screenshots++;
      const pending = purpose === 'preview' ? 'previewing' : 'capturing';
      phase = pending;
      try {
        const value = await send();
        if (phase !== pending) reject();
        phase = purpose === 'preview' ? 'previewed' : 'started';
        return value;
      } catch (error) { fail(); throw error; }
    },
    commit() {
      if (phase !== 'started' || committed >= approved || committed >= screenshots) reject();
      committed++;
    },
    async advance(send) {
      if (phase !== 'started' || committed < 1 || committed >= approved || sends !== committed - 1
          || screenshots !== committed || typeof send !== 'function') reject();
      sends++; phase = 'turning';
      try { const value = await send(); if (phase !== 'turning') reject(); phase = 'turn-sent'; return value; }
      catch (error) { fail(); throw error; }
    },
    confirmAdvance() {
      if (phase !== 'turn-sent' || sends !== committed) reject();
      phase = 'started';
    },
    finish() {
      if (phase !== 'started' || committed < 1 || committed > approved) reject();
      phase = 'finished';
    },
    fail,
    snapshot() { return { phase, screenshots, sends, committed, approved }; },
  });
}

// This separate brand and accounting implementation are not the anonymous
// GUI or one-shot budget above. They still grant no Reader or book authority.
const normalBudgets = new WeakSet();
export const isNormalCaptureBudget = value => normalBudgets.has(value);

// Accounting for one explicitly approved normal capture run. The caller must
// independently bind the owned Reader, job, target and preview.
export function createNormalCaptureBudget() {
  let phase = 'preview', screenshots = 0, sends = 0, committed = 0;
  let approved = null, resumeAdvance = false;
  const reject = () => { throw new AppError('expected_capture_budget_exhausted'); };
  const fail = () => { phase = 'failed'; };
  const atLimit = () => approved !== null && committed >= approved;
  const mode = options => {
    if (!options || Object.keys(options).some(key => key !== 'resumeAdvance')
        || typeof options.resumeAdvance !== 'boolean') reject();
    return options.resumeAdvance;
  };
  const budget = Object.freeze({
    invalidate() {
      if (!['finished', 'failed'].includes(phase)) fail();
    },
    revokeApproval() {
      if (phase === 'approved') { approved = null; phase = 'previewed'; }
    },
    approve(limit, options) {
      if (phase !== 'previewed' || limit !== null && (!Number.isSafeInteger(limit) || limit < 1)) reject();
      resumeAdvance = mode(options);
      approved = limit;
      phase = 'approved';
    },
    start(limit, options) {
      if (phase !== 'approved' || limit !== approved || mode(options) !== resumeAdvance) reject();
      phase = 'started';
    },
    async screenshot(purpose, send) {
      if (typeof send !== 'function') reject();
      const base = Number(resumeAdvance);
      if (purpose === 'preview') {
        if (phase !== 'preview' || screenshots !== 0) reject();
      } else if (purpose === 'capture') {
        if (phase !== 'started' || atLimit() || screenshots !== committed + base
            || sends !== committed + base) reject();
      } else reject();
      screenshots++;
      const pending = purpose === 'preview' ? 'previewing' : 'capturing';
      phase = pending;
      try {
        const value = await send();
        if (phase !== pending) reject();
        phase = purpose === 'preview' ? 'previewed' : 'started';
        return value;
      } catch (error) { fail(); throw error; }
    },
    commit() {
      const base = Number(resumeAdvance);
      if (phase !== 'started' || atLimit() || screenshots !== committed + base + 1
          || sends !== committed + base) reject();
      committed++;
    },
    async advance(send) {
      const base = Number(resumeAdvance);
      if (phase !== 'started' || atLimit() || screenshots !== committed + base
          || sends !== committed + base - 1 || typeof send !== 'function') reject();
      sends++;
      phase = 'turning';
      try {
        const value = await send();
        if (phase !== 'turning') reject();
        phase = 'turn-sent';
        return value;
      } catch (error) { fail(); throw error; }
    },
    confirmAdvance() {
      if (phase !== 'turn-sent' || sends !== committed + Number(resumeAdvance)) reject();
      phase = 'started';
    },
    finish() {
      if (phase !== 'started' || committed < 1 || approved !== null && committed > approved) reject();
      phase = 'finished';
    },
    fail,
    snapshot() { return { phase, screenshots, sends, committed, approved, resumeAdvance }; },
  });
  normalBudgets.add(budget);
  return budget;
}
