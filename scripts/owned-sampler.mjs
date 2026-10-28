import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export class OwnedSampler {
  constructor() {
    this.child = spawn('pwsh.exe', ['-NoProfile', '-File', fileURLToPath(new URL('./sample-owned-processes.ps1', import.meta.url))], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
    });
    this.pending = null;
    this.id = 0;
    this.failed = false;
    this.closing = false;
    this.buffer = '';
    this.exited = new Promise(resolve => this.child.once('close', resolve));
    this.ready = new Promise((resolve, reject) => {
      this.startup = { resolve, reject, timer: setTimeout(() => this.fail(), 15000) };
    });
    this.child.on('error', () => this.fail());
    this.child.stdin.on('error', () => this.fail());
    this.child.on('exit', () => { if (!this.closing) this.fail(); });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', text => {
      this.buffer += text;
      if (this.buffer.length > 65536) return this.fail();
      let end;
      while ((end = this.buffer.indexOf('\n')) >= 0) {
        let message;
        try { message = JSON.parse(this.buffer.slice(0, end)); } catch { return this.fail(); }
        this.buffer = this.buffer.slice(end + 1);
        if (message.version !== 1 || message.ok !== true) return this.fail();
        if (this.startup && message.id === 0) {
          clearTimeout(this.startup.timer);
          this.startup.resolve(message.environment);
          this.startup = null;
        } else if (this.pending && message.id === this.pending.id) {
          clearTimeout(this.pending.timer);
          this.pending.resolve(message.sample);
          this.pending = null;
        } else return this.fail();
      }
    });
  }

  fail() {
    if (this.failed) return;
    this.failed = true;
    for (const slot of [this.startup, this.pending]) {
      if (slot) { clearTimeout(slot.timer); slot.reject(new Error('owned_sampler_failed')); }
    }
    this.startup = this.pending = null;
    this.child.kill();
  }

  async sample(pids) {
    await this.ready;
    if (this.failed || this.pending || this.closing) throw new Error('owned_sampler_unavailable');
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending = { id, resolve, reject, timer: setTimeout(() => this.fail(), 5000) };
      this.child.stdin.write(JSON.stringify({ version: 1, id, pids: [...new Set(pids)] }) + '\n');
    });
  }

  async close() {
    if (this.closing) return;
    this.closing = true;
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill(), 1000);
    await this.exited;
    clearTimeout(timer);
  }
}
