import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ProbeError } from './probe.mjs';

export const guardExecutable = fileURLToPath(new URL('../../artifacts/rust-target/debug/ktz-g02-controller.exe', import.meta.url));

export class RustGuard {
  constructor() {
    this.child = spawn(guardExecutable, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    this.id = 0;
    this.pending = null;
    this.queue = Promise.resolve();
    this.failureListeners = new Set();
    this.buffer = '';
    this.closed = false;
    this.failed = false;
    this.exited = new Promise(resolve => this.child.once('close', resolve));
    this.child.on('error', () => this.fail());
    this.child.stdin.on('error', () => this.fail());
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', text => {
      this.buffer += text;
      if (this.buffer.length > 65_536) return this.fail();
      let end;
      while ((end = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        let message;
        try { message = JSON.parse(line); } catch { return this.fail(); }
        const pending = this.pending;
        if (!pending || message.version !== 1 || message.id !== pending.id || typeof message.ok !== 'boolean') return this.fail();
        clearTimeout(pending.timer);
        this.pending = null;
        if (message.ok) pending.resolve(message.payload);
        else pending.reject(new Error('rust_request_rejected'));
      }
    });
    this.child.on('exit', () => {
      if (!this.closed) this.fail();
    });
  }

  fail() {
    if (this.failed) return;
    this.failed = true;
    for (const listener of this.failureListeners) listener();
    this.failureListeners.clear();
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(new Error('rust_guard_failed'));
      this.pending = null;
    }
    this.child.kill();
  }

  request(command) {
    if (this.closed || this.failed) return Promise.reject(new Error('rust_guard_unavailable'));
    // One bounded wire request at a time. Local cancellation is immediate; its
    // Rust transition must not be dropped just because a read is in flight.
    const result = this.queue.then(() => this.send(command));
    this.queue = result.catch(() => {});
    return result;
  }

  onFailure(listener) {
    if (this.failed) listener();
    else this.failureListeners.add(listener);
  }

  send(command) {
    if (this.pending || this.closed || this.failed) return Promise.reject(new Error('rust_guard_unavailable'));
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending = { id, resolve, reject, timer: setTimeout(() => this.fail(), 3000) };
      this.child.stdin.write(`${JSON.stringify({ version: 1, id, command })}\n`);
    });
  }

  async transition(event) {
    const result = await this.request({ kind: 'transition', event });
    if (typeof result?.state !== 'string') { this.fail(); throw new Error('rust_guard_failed'); }
    return result.state;
  }

  async requireCapturing() {
    const result = await this.request({ kind: 'state' });
    if (result?.state !== 'Capturing') throw new Error('rust_capture_not_authorized');
  }

  async close() {
    if (this.closed) return;
    if (!this.failed) await this.request({ kind: 'close' }).catch(() => {});
    this.closed = true;
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill(), 1000);
    await this.exited;
    clearTimeout(timer);
    this.failureListeners.clear();
  }
}

// The Rust guard authorizes the PoC state; the Node adapter additionally enforces
// live page/PNG checks. This is not yet Rust-owned production file persistence.
export class GuardedSample {
  constructor(sample, guard) {
    this.sample = sample;
    this.guard = guard;
    guard.onFailure(() => {
      // Losing the authorizer invalidates in-flight work, including disk writes.
      // An explicit stop/pause remains the user's chosen state.
      if (sample.closed || ['Review', 'Paused'].includes(sample.state)) sample.epoch += 1;
      else sample.attention('rust_guard_failed');
    });
  }

  requireVisibleWindow(pid) {
    this.sample.readGuard = async () => {
      const { window } = await this.guard.request({ kind: 'window_for_process', pid });
      const { snapshot } = await this.guard.request({ kind: 'snapshot' });
      if (!window || window.minimized || !snapshot.cursor_valid || snapshot.foreground === 0) {
        throw new ProbeError('window_not_available');
      }
    };
  }

  async approveAndStart() {
    await this.sample.preview();
    this.sample.approvePreview(true);
    await this.guard.transition('ApprovePreview');
    await this.guard.transition('ExplicitStart');
    try { await this.sample.start(true); } catch (error) {
      await this.guard.transition('TargetChanged');
      throw error;
    }
  }

  async capture() {
    if (this.sample.state !== 'Capturing') throw new ProbeError('wrong_state');
    const epoch = this.sample.epoch;
    try {
      await this.guard.requireCapturing();
      if (this.sample.epoch !== epoch) throw new ProbeError('cancelled');
      const image = await this.sample.capture();
      if (this.sample.state === 'NeedsAttention') await this.guard.transition('CaptureFailed');
      return image;
    } catch (error) {
      if (this.sample.epoch !== epoch && (this.guard.failed || ['Review', 'Paused'].includes(this.sample.state))) {
        throw new ProbeError('cancelled');
      }
      if (['cancelled', 'busy', 'wrong_state'].includes(error.code)) throw error;
      this.sample.attention('rust_or_capture_failed');
      await this.guard.transition('CaptureFailed').catch(() => {});
      throw error;
    }
  }

  async advance() {
    if (this.sample.state !== 'Capturing') throw new ProbeError('wrong_state');
    const epoch = this.sample.epoch;
    try {
      await this.guard.requireCapturing();
      if (this.sample.epoch !== epoch) throw new ProbeError('cancelled');
      const result = await this.sample.advance();
      if (result.endCandidate) await this.guard.transition('EndCandidate');
      return result;
    } catch (error) {
      if (this.sample.epoch !== epoch && (this.guard.failed || ['Review', 'Paused'].includes(this.sample.state))) {
        throw new ProbeError('cancelled');
      }
      if (['cancelled', 'busy', 'wrong_state'].includes(error.code)) throw error;
      this.sample.attention('rust_or_advance_failed');
      await this.guard.transition('AdvanceUncertain').catch(() => {});
      throw error;
    }
  }

  async pause() {
    this.sample.pause();
    await this.guard.transition('Pause');
  }

  async stop() {
    this.sample.stop();
    await this.guard.transition('Stop');
  }
}
