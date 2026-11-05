// ConnectOverCDPTransport for the *already owned* child only. It never opens a
// socket, discovers a browser, logs a frame, or destroys the owner's pipe.
const startupReaders = new WeakMap();
const startupFailure = () => Object.assign(new Error('owned_pipe_unconfirmed'), { code: 'owned_pipe_unconfirmed' });
// Fixed startup exchanges before Playwright owns the same transport. There is
// no arbitrary-command seam, second stream reader, or reusable request router.
export function readOwnedStartupTargets(transport) {
  const read = startupReaders.get(transport);
  if (!read) throw startupFailure();
  return read.first();
}
export function readOwnedStartupTargetsAfterControl(transport) {
  const read = startupReaders.get(transport);
  if (!read) throw startupFailure();
  return read.delayed();
}
export function ownedPipeTransport(child) {
  const input = child.stdio?.[3], output = child.stdio?.[4];
  if (!input?.writable || !output?.readable) throw new Error('pipe-unavailable');
  let buffer = Buffer.alloc(0), deferred = Buffer.alloc(0), stopped = false, messageHandler, startup, startupUsed = 0, firstCompleted = false;
  const transport = {
    onclose: undefined,
    get onmessage() { return messageHandler; },
    set onmessage(handler) {
      if (handler && startup) { stop(); throw startupFailure(); }
      messageHandler = handler;
      if (!handler) output.pause();
      else if (!stopped) queueMicrotask(() => {
        if (messageHandler !== handler || stopped) return;
        drain(); if (!stopped) output.resume();
      });
    },
    send(message) {
      if (stopped || startup || !input.writable) throw new Error('pipe-unavailable');
      input.write(JSON.stringify(message) + '\0', error => { if (error) stop(); });
    },
    close() { stop(); },
  };
  function stop() {
    if (stopped) return;
    stopped = true; buffer = Buffer.alloc(0); deferred = Buffer.alloc(0);
    if (startup) { const pending = startup; startup = undefined; clearTimeout(pending.timer); pending.reject(startupFailure()); }
    output.off('data', onData); output.off('end', stop); output.off('error', stop); input.off('error', stop);
    // Drain, but retain the pipe for the owner's independently verified close.
    output.resume();
    const onclose = transport.onclose;
    if (onclose) { try { onclose(); } catch { /* never reflect protocol errors */ } }
  }
  function onData(chunk) {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length + deferred.length > 4 * 1024 * 1024) { stop(); return; }
    drain();
  }
  function drain() {
    let end;
    while (!stopped && (startup || messageHandler) && (end = buffer.indexOf(0)) !== -1) {
      let message;
      try { message = JSON.parse(buffer.subarray(0, end).toString('utf8')); }
      catch { stop(); return; }
      const frame = buffer.subarray(0, end + 1);
      buffer = Buffer.from(buffer.subarray(end + 1));
      if (!message || typeof message !== 'object' || Array.isArray(message)) { stop(); return; }
      if (startup) {
        if (!Object.hasOwn(message, 'id')) {
          deferred = Buffer.concat([deferred, frame]);
          continue; // Replay events, including a chunk tail, to the next owner.
        }
        if (startup.phase !== 'query' || message.id !== startup.id || message.sessionId !== undefined || message.error || !Array.isArray(message.result?.targetInfos)) { stop(); return; }
        const pending = startup; startup = undefined; clearTimeout(pending.timer);
        if (pending.id === -1) firstCompleted = true;
        buffer = Buffer.concat([deferred, buffer]); deferred = Buffer.alloc(0);
        output.pause();
        pending.resolve(message.result.targetInfos); // Never forward this response to Playwright.
        return;
      }
      try { messageHandler?.(message); } catch { stop(); return; }
      if (stopped) return;
    }
  }
  output.pause();
  output.on('data', onData); output.once('end', stop); output.once('error', stop); input.once('error', stop);
  function query(id, delayed = false) {
    return new Promise((resolve, reject) => {
      const dispatch = () => {
        startup.phase = 'query'; startup.timer = setTimeout(stop, 1500);
        input.write(JSON.stringify({ id, method: 'Target.getTargets' }) + '\0', error => { if (error) stop(); });
        if (!stopped) output.resume();
      };
      startup = { resolve, reject, id, phase: 'delay', timer: undefined };
      if (delayed) startup.timer = setTimeout(dispatch, 10_000);
      else dispatch();
    });
  }
  const available = () => !stopped && !startup && !messageHandler && !transport.onclose && input.writable;
  startupReaders.set(transport, {
    first() {
      if (!available() || startupUsed !== 0) throw startupFailure();
      startupUsed = 1;
      return query(-1);
    },
    delayed() {
      if (!available() || startupUsed !== 1 || !firstCompleted) throw startupFailure();
      startupUsed = 2;
      return query(-2, true); // No configurable delay, command, or third exchange.
    },
  });
  return transport;
}
