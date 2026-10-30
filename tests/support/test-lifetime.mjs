// Test-only, opt-in tracing. The file channel is needed because node --test
// can buffer a worker's stdout until the test has already finished.
import { appendFileSync, readFileSync } from 'node:fs';
import { isPromise } from 'node:util/types';

// Only data descriptors are inspected: never invoke exception getters or read
// message, stack, cause, paths, URLs, process settings, or command arguments.
const diagnosticErrorCodes = new Set(['ENOENT', 'EACCES', 'EPERM', 'EADDRINUSE',
  'EADDRNOTAVAIL', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EMFILE', 'ENFILE', 'ENOMEM']);
export const isDiagnosticErrorCode = value => typeof value === 'string' && diagnosticErrorCodes.has(value);
function dataProperty(object, key) {
  try {
    for (let i = 0; object != null && i < 8; i++, object = Object.getPrototypeOf(object)) {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (descriptor) return 'value' in descriptor ? descriptor.value : undefined;
    }
  } catch { /* Hostile proxies and accessors are unclassified. */ }
  return undefined;
}
export function classifyDiagnosticError(error) {
  const name = dataProperty(error, 'name'), code = dataProperty(error, 'code');
  const errorCode = isDiagnosticErrorCode(code) ? code : 'unknown';
  return { errorClass: name === 'TimeoutError' ? 'timeout' : errorCode !== 'unknown' ? 'os' : 'unknown', errorCode };
}

export function createLifetime({ enabled = process.env.KTZ_TEST_LIFETIME_DIAGNOSTICS === '1',
  eventFile = process.env.KTZ_LIFETIME_EVENT_FILE } = {}) {
  const stores = new Map();
  const cleanupStarted = new Set();
  function emit(t, boundary, event, extra = {}) {
    if (!enabled) return;
    // Diagnostics must not replace the operation's result or exception even
    // when the file, a test-name getter, serialization, or stdout fails.
    try {
      const record = { pid: process.pid, test: typeof t === 'string' ? t : t.name,
        boundary, event, monotonicMs: performance.now(), ...extra };
      const line = `KTZ_LIFETIME:${JSON.stringify(record)}\n`;
      if (eventFile) appendFileSync(eventFile, line, { mode: 0o600 });
      else process.stdout.write(line);
    } catch { /* The supervisor will treat missing events as incomplete. */ }
  }
  function step(t, boundary, operation) {
    if (!enabled) return operation(); // Preserve the original promise, including rejection identity.
    const began = performance.now();
    emit(t, boundary, 'start');
    try {
      const result = operation();
      if (!isPromise(result)) { emit(t, boundary, 'end', { elapsedMs: performance.now() - began }); return result; }
      // Use the native Promise method, not an arbitrary then getter. If a
      // hostile subclass prevents observation, leave its original promise.
      try {
        return Promise.prototype.then.call(result,
          value => { emit(t, boundary, 'end', { elapsedMs: performance.now() - began }); return value; },
          error => { emit(t, boundary, 'error', { elapsedMs: performance.now() - began, ...classifyDiagnosticError(error) }); throw error; });
      } catch { return result; }
    } catch (error) {
      emit(t, boundary, 'error', { elapsedMs: performance.now() - began, ...classifyDiagnosticError(error) });
      throw error;
    }
  }
  function wrapRegistration(register, receiver) {
    return (...args) => {
      const index = args.findLastIndex(arg => typeof arg === 'function');
      if (index < 0) return register.apply(receiver, args);
      const body = args[index];
      let context;
      args[index] = async function (t, ...rest) {
        context = t;
        emit(t, 'test', 'begin');
        const originalTest = t.test, originalAfter = t.after;
        let hookNumber = 0;
        t.test = wrapRegistration(originalTest, t);
        t.after = (...hookArgs) => {
          const i = hookArgs.findLastIndex(arg => typeof arg === 'function');
          if (i >= 0) {
            const hook = hookArgs[i];
            const boundary = `after_hook.${++hookNumber}`;
            hookArgs[i] = function (...hookContext) {
              cleanupStarted.add(t);
              return step(t, boundary, () => hook.apply(this, hookContext));
            };
          }
          return originalAfter.apply(t, hookArgs);
        };
        try {
          const result = await body.call(this, t, ...rest);
          emit(t, 'test_body', 'complete');
          return result;
        } catch (error) { emit(t, 'test_body', 'error'); throw error; }
      };
      const result = register.apply(receiver, args);
      // test() settles after its hooks. This is not a claim that unrelated
      // workers, subprocesses or all process-level cleanup have finished.
      result?.then(() => { if (context) { emit(context, 'test', 'end'); stores.delete(context); cleanupStarted.delete(context); } },
        () => { if (context) { emit(context, 'test', 'end'); stores.delete(context); cleanupStarted.delete(context); } });
      return result;
    };
  }
  if (enabled) {
    let starttime = null;
    if (process.platform === 'linux') {
      try {
        const stat = readFileSync('/proc/self/stat', 'utf8');
        const candidate = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
        if (/^\d+$/.test(candidate ?? '')) starttime = candidate;
      } catch { /* Snapshot signalling is unavailable without an identity. */ }
    }
    if (starttime) process.on('SIGUSR2', () => {
      const pending = [];
      for (const store of stores.values()) {
        const kind = store?.pending?.kind;
        if (typeof kind === 'string' && /^[a-z_]{1,40}$/.test(kind)) pending.push({ kind, elapsedMs: null });
      }
      emit('process', 'ipc_snapshot', 'captured', { pending, cleanupStarted: cleanupStarted.size > 0 });
    });
    if (starttime) emit('process', 'snapshot_listener', 'ready', { starttime });
    else emit('process', 'snapshot_listener', 'unavailable');
    process.once('exit', code => emit('process', 'process_exit', 'complete', { exitCode: code }));
  }
  return {
    enabled, emit, step,
    instrument: test => enabled ? wrapRegistration(test, undefined) : test,
    trackStore(t, store) { if (enabled) stores.set(t, store); },
  };
}
