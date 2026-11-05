// Synthetic child/IPC only. Never launches, discovers or connects a browser.
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

export class ControlOwner extends EventEmitter {
  constructor(mode) {
    super();
    this.mode = mode;
    this.connected = true;
    this.sent = [];
    this.unreferenced = false;
    this.channel = { unref: () => { this.channelUnreferenced = true; } };
    this.stdio = [null, null, null, null, new PassThrough(), new PassThrough()];
    queueMicrotask(() => this.emit('message', { event: 'ready', url: 'http://127.0.0.1:12345/reader.html?asin=B000KTZ001' }));
  }
  send(message, callback) {
    this.sent.push(message.event);
    if (message.event === 'close' && !['before-release', 'early-normal', 'early-release-stall', 'early-unknown'].includes(this.mode)) {
      this.emit('message', { event: 'release-ready' });
      this.emit('message', { event: 'release-ready' }); // duplicate does not reauthorize
    }
    if (message.event === 'release') {
      if (this.mode === 'normal' || this.mode === 'early-normal') {
        this.emit('message', { event: 'normal' });
        this.emit('exit', 0, null);
      } else if (this.mode === 'exit-only') this.emit('exit', 0, null);
      else if (this.mode === 'disconnect') this.disconnect();
      else if (this.mode === 'normal-without-exit') this.emit('message', { event: 'normal' });
      else if (this.mode === 'send-error') { callback?.(new Error('synthetic_ipc_failure')); return; }
    }
    // Missing callbacks on both release and retain must not make close infinite.
    if (this.mode !== 'lost-callback') callback?.();
  }
  disconnect() {
    if (!this.connected) return;
    this.connected = false;
    this.emit('disconnect');
  }
  unref() { this.unreferenced = true; }
  dispose() { this.stdio[4].destroy(); this.stdio[5].destroy(); }
}

// Enough anonymous CDP for a real Playwright browser session, with no page,
// content, cookies or network. Deliberately never answer detachFromTarget:
// cleanup of a stalled owner must not precede the bounded pipe shutdown.
export async function connectOwnedPipeControlSession(owner, pipe) {
  const { chromium } = await import('playwright');
  const methods = [];
  let buffered = '';
  owner.stdio[4].on('data', data => {
    buffered += data.toString();
    let end;
    while ((end = buffered.indexOf('\0')) >= 0) {
      const request = JSON.parse(buffered.slice(0, end));
      buffered = buffered.slice(end + 1);
      methods.push(request.method);
      if (request.method === 'Target.detachFromTarget') continue;
      const result = request.method === 'Browser.getVersion'
        ? { product: 'Chrome/140.0.0.0', revision: 'anonymous', userAgent: 'Chrome' }
        : request.method === 'Target.attachToBrowserTarget' ? { sessionId: 'anonymous-session' }
        : request.method === 'Target.getTargetInfo' ? { targetInfo: { type: 'browser', targetId: 'anonymous' } } : {};
      queueMicrotask(() => owner.stdio[5].write(JSON.stringify({ id: request.id, result,
        ...(request.sessionId ? { sessionId: request.sessionId } : {}) }) + '\0'));
    }
  });
  const browser = await chromium.connectOverCDP(pipe.transport, { noDefaults: true, timeout: 1000 });
  return { session: await browser.newBrowserCDPSession(), methods };
}
