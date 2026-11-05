// Internal, single-use observation path. The public entry fixes both the
// profile and origin. This module never exposes a generic CDP command surface.
import { spawn } from 'node:child_process';
import { runLinuxLogin } from './linux-login-core.mjs';
import { inspectKindleDocument, readerMarkerReasons, projectKindleUiProbe } from './linux-reader-probe.mjs';

const fail = code => Object.assign(new Error(code), { code });
const pipeFlag = '--remote-debugging-pipe';
const stages = new Set(['entry', 'preflight-or-start', 'confirmation', 'ownership-before-observation',
  'target-selection', 'target-attach', 'isolated-world', 'metadata', 'document-recheck', 'target-recheck',
  'detach', 'ownership-after-observation', 'notification', 'browser-close', 'supervision']);
const reasons = new Set(['pipe-unavailable', 'pipe-closed', 'pipe-error', 'response-timeout', 'response-too-large',
  'invalid-response', 'protocol-error', 'invalid-result', 'no-page-target', 'multiple-page-targets', 'target-changed',
  'document-unavailable', 'blocking-ui', 'reader-markers', 'reader-region', 'reader-direction', 'reader-surface',
  'reader-title', 'reader-position', 'reader-dimensions', 'metadata-exception', 'metadata-missing', ...readerMarkerReasons,
  'owner-result-timeout', 'owner-exited-without-result', 'owner-exit-unconfirmed', 'owner-protocol-unavailable', 'normal-close-unconfirmed']);
const failureReasons = new Map([
  ['invalid_inspect_invocation', 'invalid-invocation'],
  ['inspect_confirmation_cancelled', 'confirmation-cancelled'],
  ['inspect_confirmation_unavailable', 'confirmation-unavailable'],
  ['inspect_confirmation_browser_ended', 'browser-ended-during-confirmation'],
  ['inspect_notification_unavailable', 'notification-unavailable'],
  ['inspect_channel_unavailable', 'channel-unavailable'], ['inspect_target_ambiguous', 'target-ambiguous'],
  ['inspect_marker_unavailable', 'marker-unavailable'], ['login_in_use_or_unknown', 'ownership-in-use-or-unknown'],
  ['login_identity_changed', 'ownership-changed'], ['login_lock_changed', 'ownership-changed'],
  ['unsafe_login_directory', 'ownership-unsafe'], ['unsafe_login_marker', 'ownership-unsafe'],
  ['login_start_unconfirmed', 'browser-start-unconfirmed'], ['login_close_unconfirmed', 'browser-close-unconfirmed'],
  ['snap_changed', 'snap-changed'], ['snap_personal_init_exists', 'personal-init-present'],
  ['ENOENT', 'required-path-missing'],
  ['invalid_login_start_mode', 'invalid-start-mode'],
]);

// This is the only diagnostic projection. Never reflect a message, stack, URL,
// protocol error, path or arbitrary code received from a dependency or page.
export function inspectFailureDiagnostic(error) {
  return { stage: stages.has(error?.inspectStage) ? error.inspectStage : 'entry',
    reason: reasons.has(error?.inspectReason) ? error.inspectReason : failureReasons.get(error?.code) ?? 'unclassified' };
}

export function projectInspectDiagnostic(value) {
  if (!stages.has(value?.stage) || !(reasons.has(value?.reason)
      || [...failureReasons.values(), 'unclassified'].includes(value?.reason))) throw new Error('invalid_inspect_diagnostic');
  return { stage: value.stage, reason: value.reason };
}

function atStage(error, stage) {
  const safe = fail(failureReasons.has(error?.code) ? error.code : 'inspect_unclassified');
  safe.inspectStage = stages.has(error?.inspectStage) ? error.inspectStage : stage;
  if (reasons.has(error?.inspectReason)) safe.inspectReason = error.inspectReason;
  return safe;
}

const rejected = (code, reason) => Object.assign(fail(code), { inspectReason: reason });

// The pipe belongs to the just-spawned verified process, not to a discovered
// browser or listening port. Only these fixed requests are ever emitted.
// CDP target responses/events contain unrelated tab titles and full URLs. Strip
// those string values at the byte boundary before UTF-8 decoding/JSON parsing.
// Only the fixed metadata expression's reply may retain a title; URLs never do.
function stripTargetStrings(frame, allowTitle = false) {
  const parts = [], replacement = Buffer.from('null');
  const names = [Buffer.from('"url"'), Buffer.from('"faviconUrl"'), ...(!allowTitle ? [Buffer.from('"title"')] : [])];
  const whitespace = byte => byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
  const endOfString = start => {
    for (let index = start + 1; index < frame.length; index++) {
      if (frame[index] === 0x5c) { index++; continue; }
      if (frame[index] === 0x22) return index + 1;
    }
    throw fail('inspect_channel_unavailable');
  };
  let from = 0;
  for (let index = 0; index < frame.length;) {
    if (frame[index] !== 0x22) { index++; continue; }
    const start = index, end = endOfString(start);
    index = end;
    if (!names.some(name => frame.subarray(start, end).equals(name))) continue;
    let cursor = end;
    while (whitespace(frame[cursor])) cursor++;
    if (frame[cursor++] !== 0x3a) continue;
    while (whitespace(frame[cursor])) cursor++;
    if (frame[cursor] !== 0x22) continue;
    const valueEnd = endOfString(cursor);
    parts.push(frame.subarray(from, cursor), replacement);
    from = valueEnd; index = valueEnd;
  }
  parts.push(frame.subarray(from));
  return Buffer.concat(parts).toString('utf8');
}

// Inspect only a leading protocol response id as ASCII bytes. Do not decode an
// arbitrary prefix of an event, which could itself contain a URL or title.
function leadingResponseId(frame) {
  let index = 0;
  const space = () => { while ([0x20, 0x09, 0x0a, 0x0d].includes(frame[index])) index++; };
  space(); if (frame[index++] !== 0x7b) return null;
  space();
  for (const byte of [0x22, 0x69, 0x64, 0x22]) if (frame[index++] !== byte) return null;
  space(); if (frame[index++] !== 0x3a) return null;
  space(); let id = 0, digits = 0;
  while (frame[index] >= 0x30 && frame[index] <= 0x39) {
    id = id * 10 + frame[index++] - 0x30; digits++;
    if (!Number.isSafeInteger(id)) return null;
  }
  space();
  return digits && (frame[index] === 0x2c || frame[index] === 0x7d) ? id : null;
}

async function observeOnce(child, expectedOrigin, metadata = true) {
  const input = child.stdio[3], output = child.stdio[4];
  let stage = 'target-selection';
  if (!input?.writable || !output?.readable) throw atStage(rejected('inspect_channel_unavailable', 'pipe-unavailable'), stage);
  let buffer = Buffer.alloc(0), serial = 0, pending, stopped = false;
  const stop = reason => {
    stopped = true; buffer = Buffer.alloc(0);
    if (pending) { clearTimeout(pending.timer); pending.reject(rejected('inspect_channel_unavailable', reason)); pending = null; }
  };
  const onEnd = () => stop('pipe-closed');
  const onError = () => stop('pipe-error');
  const onData = chunk => {
    if (stopped) return;
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > 262144) return stop('response-too-large');
    let end;
    while ((end = buffer.indexOf(0)) !== -1) {
      let message;
      try {
        const frame = buffer.subarray(0, end);
        const responseId = leadingResponseId(frame);
        const selectedReply = metadata && pending?.method === 'Runtime.evaluate' && responseId === pending.id;
        message = JSON.parse(stripTargetStrings(frame, selectedReply));
      }
      catch { stop('invalid-response'); return; }
      buffer = Buffer.from(buffer.subarray(end + 1));
      if (!message || typeof message !== 'object' || Array.isArray(message)) { stop('invalid-response'); return; }
      if (pending && message.id === pending.id) {
        const current = pending; pending = null; clearTimeout(current.timer);
        if (message.error || !message.result) current.reject(rejected('inspect_channel_unavailable', 'protocol-error'));
        else if (current.method === 'Target.getTargets') {
          // Chromium's response also contains every tab's URL and title. They
          // are discarded immediately after parsing, never used or logged;
          // only page type and identity are needed to reject ambiguity after
          // the person's explicit confirmation.
          const infos = message.result.targetInfos;
          current.resolve({ targetInfos: Array.isArray(infos) ? infos.map(item => ({ type: item?.type, targetId: item?.targetId })) : null });
        } else current.resolve(message.result);
      }
    }
  };
  output.on('data', onData); output.once('end', onEnd); output.once('error', onError); input.once('error', onError);
  const request = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    if (stopped || pending) return reject(fail('inspect_channel_unavailable'));
    const id = ++serial;
    const timer = setTimeout(() => stop('response-timeout'), metadata ? 5000 : 1000);
    pending = { id, resolve, reject, timer, method };
    const message = { id, method, params, ...(sessionId ? { sessionId } : {}) };
    input.write(JSON.stringify(message) + '\0', error => { if (error) stop('pipe-error'); });
  });
  let sessionId, primaryFailure;
  try {
    const startupDeadline = performance.now() + 4000;
    while (true) {
    stage = 'target-selection';
    const targets = await request('Target.getTargets');
    const pages = targets.targetInfos?.filter(target => target.type === 'page');
    // Wait only before a restored document exists, not for ambiguity to vanish.
    if (!metadata && pages?.length === 0 && performance.now() < startupDeadline) {
      await new Promise(resolve => setTimeout(resolve, 50)); continue;
    }
    if (!pages || pages.some(page => typeof page.targetId !== 'string')) throw rejected('inspect_target_ambiguous', 'invalid-result');
    if (pages.length !== 1) throw rejected('inspect_target_ambiguous', pages.length ? 'multiple-page-targets' : 'no-page-target');
    const targetId = pages[0].targetId;
    let world, response;
    try {
    stage = 'target-attach';
    ({ sessionId } = await request('Target.attachToTarget', { targetId, flatten: true }));
    if (typeof sessionId !== 'string') throw rejected('inspect_channel_unavailable', 'invalid-result');
    // In Chromium a page target ID is its main frame ID. If that contract is
    // not met, createIsolatedWorld fails closed; no other frames are searched.
    stage = 'isolated-world';
    world = await request('Page.createIsolatedWorld', { frameId: targetId, worldName: 'KindleToZip single observation' }, sessionId);
    if (!Number.isInteger(world.executionContextId)) throw rejected('inspect_channel_unavailable', 'invalid-result');
    stage = 'metadata';
    response = await request('Runtime.evaluate', {
      expression: `(${inspectKindleDocument.toString()})(${JSON.stringify({ expectedOrigin, metadata, allowInitialEmpty: !metadata })})`,
      contextId: world.executionContextId, returnByValue: true, silent: true, timeout: metadata ? 3000 : 500,
    }, sessionId);
    } catch (error) {
      // Chromium can replace its initial empty document while restoring. Before
      // any non-startup result, tolerate only that protocol-unavailable window,
      // within one fixed startup deadline. Never retry a completed diagnosis.
      if (metadata || error?.code !== 'inspect_channel_unavailable' || error.inspectReason !== 'protocol-error') throw error;
      if (sessionId && !stopped) {
        try { await request('Target.detachFromTarget', { sessionId }); } catch { /* no page values were read */ }
        sessionId = undefined;
      }
      if (performance.now() >= startupDeadline) return { state: 'unavailable', reason: 'startup-incomplete' };
      await new Promise(resolve => setTimeout(resolve, 50)); continue;
    }
    const value = response.result?.value;
    if (response.exceptionDetails) throw rejected('inspect_marker_unavailable', 'metadata-exception');
    if (!metadata && value?.state === 'starting') {
      try { await request('Target.detachFromTarget', { sessionId }); }
      catch (error) { if (error?.inspectReason !== 'protocol-error') throw error; }
      sessionId = undefined;
      if (performance.now() >= startupDeadline) return { state: 'unavailable', reason: 'startup-incomplete' };
      await new Promise(resolve => setTimeout(resolve, 50)); continue;
    }
    let candidate = value, readinessDeadline;
    while (true) {
      let uiProbe;
      if (metadata) {
        if (candidate?.state !== 'ok') throw rejected('inspect_marker_unavailable', reasons.has(candidate?.reason) ? candidate.reason : 'metadata-missing');
      } else {
        try { uiProbe = projectKindleUiProbe(candidate); }
        catch { throw rejected('inspect_marker_unavailable', 'invalid-result'); }
      }
      // This fixed boolean probe reads no page data. If the selected document
      // navigated, its isolated execution context has been destroyed.
      stage = 'document-recheck';
      const stillInDocument = await request('Runtime.evaluate', {
        expression: 'true', contextId: world.executionContextId, returnByValue: true, silent: true, timeout: 3000,
      }, sessionId);
      if (stillInDocument.exceptionDetails || stillInDocument.result?.value !== true) throw rejected('inspect_target_ambiguous', 'target-changed');
      // Do not publish even the one observation if another page appeared or the
      // selected target disappeared while it was being read.
      stage = 'target-recheck';
      const finalTargets = await request('Target.getTargets');
      const finalPages = finalTargets.targetInfos?.filter(target => target.type === 'page');
      if (!finalPages || finalPages.length !== 1 || finalPages[0].targetId !== targetId) {
        throw rejected('inspect_target_ambiguous', 'target-changed');
      }
      // A complete document may still be building its reader UI. Wait only for
      // missing/hidden/clipped fixed markers, never for ambiguity to disappear.
      // This is diagnostic only: it establishes neither the selected book nor a
      // frame binding and never reads a title or position value.
      const waitable = !metadata && uiProbe.state === 'unavailable'
        && readerMarkerReasons.includes(uiProbe.reason) && !uiProbe.reason.endsWith('-multiple')
        && Object.values(uiProbe.markers).every(marker => marker.count !== 'multiple');
      if (waitable) {
        readinessDeadline ??= performance.now() + 2000;
        const remaining = readinessDeadline - performance.now();
        if (remaining > 0) {
          await new Promise(resolve => setTimeout(resolve, Math.min(50, remaining)));
          stage = 'metadata';
          // Once a document has produced a non-starting result, any protocol
          // error stops this attempt; it cannot be assumed to be navigation or
          // retried as if it were initial restoration.
          response = await request('Runtime.evaluate', {
            expression: `(${inspectKindleDocument.toString()})(${JSON.stringify({ expectedOrigin, metadata: false, allowInitialEmpty: true })})`,
            contextId: world.executionContextId, returnByValue: true, silent: true, timeout: 500,
          }, sessionId);
          if (response.exceptionDetails) throw rejected('inspect_marker_unavailable', 'metadata-exception');
          candidate = response.result?.value;
          if (candidate?.state === 'starting') throw rejected('inspect_target_ambiguous', 'target-changed');
          continue;
        }
      }
      // Copy only the known fields; no error, URL, target info, or page-provided
      // extra keys can be returned to the caller or written to a log.
      if (!metadata) return uiProbe;
      return { title: candidate.title,
        position: { value: candidate.position.value, min: candidate.position.min, max: candidate.position.max },
        region: { width: candidate.region.width, height: candidate.region.height,
          visibleWidth: candidate.region.visibleWidth, visibleHeight: candidate.region.visibleHeight } };
    }
    }
  } catch (error) {
    primaryFailure = atStage(error, stage);
    throw primaryFailure;
  } finally {
    let detachFailure;
    if (sessionId && !stopped) {
      try { await request('Target.detachFromTarget', { sessionId }); } catch (error) { detachFailure = atStage(error, 'detach'); }
    }
    stopped = true; buffer = Buffer.alloc(0); output.off('data', onData); output.off('end', onEnd); output.off('error', onError); input.off('error', onError);
    // Leave the inherited pipe open but inert until the person closes the
    // browser normally. Destroying it can terminate Chromium unexpectedly.
    if (detachFailure && !primaryFailure) throw detachFailure;
  }
}

// Fixed diagnostic capability for a verified, newly owned browser only.
export const observeLinuxUiProbe = (child, expectedOrigin) => observeOnce(child, expectedOrigin, false);

export function launchLinuxInspectBrowser(executable, args) {
  const env = { ...process.env }; delete env.CHROMIUM_FLAGS;
  const child = spawn(executable, [...args.slice(0, -1), pipeFlag, args.at(-1)], {
    env, detached: true, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
  });
  child.stdio[3].on('error', () => {}); child.stdio[4].on('error', () => {});
  return child;
}

// This is an internal dependency-injection seam for anonymous tests, not a
// command-line URL/profile/debug option. The public entry supplies fixed values.
export async function runLinuxInspect({ root, url, expectedOrigin, preflight, confirm, notify }) {
  let observation, failure;
  let stage = 'preflight-or-start';
  try {
    await runLinuxLogin({ root, url, preflight, launch: launchLinuxInspectBrowser, requiredArgs: [pipeFlag], requireAbsentSingleton: true, joinUnconfirmedStart: true, requireExistingProfile: true,
    async onStarted({ child, ended, assertStillOwned }) {
      try {
        stage = 'confirmation';
        await confirm(ended);
        stage = 'ownership-before-observation';
        await assertStillOwned();
        observation = await observeOnce(child, expectedOrigin);
        stage = 'ownership-after-observation';
        await assertStillOwned();
      } catch (error) {
        failure = atStage(error, stage);
      }
      stage = 'notification';
      try { await notify(!failure, ended); }
      catch { failure ??= atStage(fail('inspect_notification_unavailable'), stage); }
      stage = 'browser-close';
      // runLinuxLogin joins the browser and its group, then releases only its
      // own still-identified lock. A failure retains unknown state as before.
    },
    });
    if (failure) throw failure;
    if (!observation) throw fail('inspect_marker_unavailable');
    return observation;
  } catch (error) { throw atStage(error, stage); }
}
