import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export class AppError extends Error {
  constructor(code, detail) { super(code); this.code = code; this.detail = detail; }
}

// Only this fixed, locally built Rust program may commit job data.
export class StoreClient {
  constructor() {
    const controller = process.env.KTZ_CONTROLLER_PATH || fileURLToPath(new URL('../artifacts/rust-target/debug/ktz-g02-controller.exe', import.meta.url));
    this.child = spawn(controller, [], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
    });
    this.id = 0;
    this.buffer = '';
    this.queue = Promise.resolve();
    this.listeners = new Set();
    this.exited = new Promise(resolve => this.child.once('close', resolve));
    this.child.once('error', () => this.fail());
    this.child.once('exit', () => { if (!this.closed) this.fail(); });
    this.child.stdin.on('error', () => this.fail());
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', text => {
      this.buffer += text;
      if (Buffer.byteLength(this.buffer) > 24 * 1024 * 1024) return this.fail();
      let end;
      while ((end = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        let response;
        try { response = JSON.parse(line); } catch { return this.fail(); }
        const pending = this.pending;
        if (!pending || response.id !== pending.id || response.version !== 1 || typeof response.ok !== 'boolean') return this.fail();
        if (response.progress) {
          const p = response.progress;
          if (pending.kind !== 'export' || !Number.isSafeInteger(p.done) || !Number.isSafeInteger(p.total)
            || p.done < 0 || p.done >= p.total || !['write', 'verify', 'publish'].includes(p.stage)) return this.fail();
          pending.onProgress?.(p);
          continue;
        }
        this.pending = null;
        clearTimeout(pending.timer);
        if (response.ok) pending.resolve(response.payload);
        else pending.reject(new AppError(/^[a-z0-9_]+$/.test(response.code) ? response.code : 'store_rejected'));
      }
    });
  }

  fail() {
    if (this.failed) return;
    this.failed = true;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(new AppError('store_disconnected'));
      this.pending = null;
    }
    for (const listener of this.listeners) listener();
    this.child.kill();
  }

  call(kind, payload = {}, onProgress) {
    const result = this.queue.then(() => {
      if (this.closed || this.failed) throw new AppError('store_unavailable');
      const id = ++this.id;
      const line = JSON.stringify({ version: 1, id, command: { kind, ...payload, ...(kind === 'export' && onProgress ? { progress: true } : {}) } }) + '\n';
      if (Buffer.byteLength(line) > 65_536) throw new AppError('request_too_large');
      return new Promise((resolve, reject) => {
        this.pending = { id, kind, onProgress, resolve, reject, timer: setTimeout(() => this.fail(), 120_000) };
        this.child.stdin.write(line);
      });
    });
    this.queue = result.catch(() => {});
    return result;
  }

  async close() {
    if (this.closed) return;
    if (!this.failed) await this.call('close').catch(() => {});
    this.closed = true;
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill(), 1500);
    await this.exited;
    clearTimeout(timer);
  }
}
