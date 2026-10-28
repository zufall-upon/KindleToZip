import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { inspectSoakResult } from '../scripts/soak-result.mjs';
import { SampleProbe } from '../poc/browser/probe.mjs';
import { RustGuard, GuardedSample } from '../poc/browser/rust-guard.mjs';

function fixture() {
  return {
    schemaVersion: 1, scope: 'self-authored-soak-reference', requestedSeconds: 600,
    termination: 'end_candidate', state: 'NeedsAttention', kindle: 'not-tested', at11Acceptance: 'not-claimed',
    elapsedMs: 600010, environment: { logicalProcessors: 8, physicalMemoryBytes: 16 * 1024 ** 3 },
    captures: Array.from({ length: 12 }, (_, i) => ({ id: i + 1, position: i + 1,
      sha256: String(i).padStart(64, '0'), file: `${String(i + 1).padStart(6, '0')}.png`, bytes: 1000 })),
    advances: [...Array.from({ length: 11 }, (_, i) => ({ position: i + 2 })), { endCandidate: true }],
    resources: Array.from({ length: 121 }, (_, i) => ({ elapsedMs: i * 5000, cpuMilliseconds: i * 100,
      workingSetBytes: 1000, privateBytes: 800, processCount: 6, missingProcesses: 0 })),
  };
}

test('全体CPU換算・メモリ集計を計算し、受入成功とは返さない', () => {
  const summary = inspectSoakResult(fixture());
  assert.equal(summary.averageCpuPercentOfMachine, 0.25);
  assert.equal(summary.peakSummedPrivateBytes, 800);
  assert.equal(summary.acceptance, 'reference-only');
});
test('10分未満・画像位置欠落・中断を成功扱いにしない', () => {
  const short = fixture(); short.elapsedMs = 599999;
  assert.throws(() => inspectSoakResult(short));
  const lost = fixture(); lost.captures[5].position = 7;
  assert.throws(() => inspectSoakResult(lost));
  const failed = fixture(); failed.termination = 'operation_failed';
  assert.throws(() => inspectSoakResult(failed));
});
test('カウンタ逆行は拒否し、欠測は隠さず件数を返す', () => {
  const reversed = fixture(); reversed.resources[50].cpuMilliseconds = 1;
  assert.throws(() => inspectSoakResult(reversed));
  const partial = fixture(); partial.resources[1].missingProcesses = 2;
  assert.equal(inspectSoakResult(partial).missingProcessSamples, 2);
});

// Execute the CLI body with an in-memory clock and I/O. This never launches a
// browser/process or touches the run-once index, receipts or saved PNGs.
async function simulateSoakFinalBoundary(event, phase) {
  const source = await readFile(new URL('../poc/browser/soak-probe.mjs', import.meta.url), 'utf8');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const expected = fixture();
  const durationMs = 600000;
  let now = 0;
  let cancel;
  let guard;
  let result;
  let connected = true;
  let fired = false;
  const messages = [];
  const sample = {
    directory: path.resolve('artifacts/poc-runs/sample-simulated'),
    state: 'Preview', epoch: 0, images: [], closed: false,
    attention: SampleProbe.prototype.attention,
    stop: SampleProbe.prototype.stop,
    async preview() {},
    approvePreview() { this.state = 'Ready'; },
    async start() { this.state = 'Capturing'; },
    async capture() {
      const image = { ...expected.captures[this.images.length] };
      this.images.push(image);
      return image;
    },
    async advance() {
      if (this.images.length === 12) {
        this.attention('end_candidate');
        return { endCandidate: true };
      }
      return { position: this.images.length + 1 };
    },
    async close() { this.closed = true; },
    browser: {
      async newBrowserCDPSession() {
        return {
          async send() {
            if (!connected) throw new Error('browser_disconnected');
            return { processInfo: [{ type: 'browser', id: 1004 }] };
          },
          async detach() {},
        };
      },
      version() { return 'simulated'; },
      isConnected() { return connected; },
    },
  };
  class SimulatedSoakGuard {
    constructor() { guard = this; }
    child = { pid: 1002, kill() {} };
    failed = false;
    pending = null;
    failureListeners = new Set();
    onFailure = RustGuard.prototype.onFailure;
    fail = RustGuard.prototype.fail;
    async requireCapturing() { assert.equal(this.state, 'Capturing'); }
    async transition(event) {
      this.state = { ApprovePreview: 'Ready', ExplicitStart: 'Capturing', EndCandidate: 'NeedsAttention' }[event];
      assert.ok(this.state);
    }
    async close() {}
  }
  function interrupt() {
    if (!event || fired) return;
    fired = true;
    if (event === 'cancelled') cancel();
    else if (event === 'rust-child-lost') guard.fail();
    else if (event === 'browser-disconnected') {
      connected = false;
      sample.attention('browser_closed');
    } else assert.fail('unknown_simulated_event');
  }
  class SimulatedSoakSampler {
    child = { pid: 1003 };
    ready = Promise.resolve(expected.environment);
    async sample() {
      if (phase === 'final-resource' && now >= durationMs) interrupt();
      return { elapsedMs: now, cpuMilliseconds: now / 50, workingSetBytes: 1000,
        privateBytes: 800, processCount: 4, missingProcesses: 0 };
    }
    async close() {}
  }
  const processStub = {
    argv: ['node', 'soak-probe.mjs', '--seconds=600'], version: 'simulated', pid: 1001,
    on(name, callback) { assert.equal(name, 'SIGINT'); cancel = callback; },
    off(name, callback) { assert.equal(name, 'SIGINT'); assert.equal(callback, cancel); },
  };
  const bindings = {
    mkdir: async () => {},
    open: async (_, flags) => {
      assert.equal(flags, 'wx');
      return { async writeFile() {}, async close() {} };
    },
    writeFile: async (_, text, options) => {
      assert.equal(options.flag, 'wx');
      result = JSON.parse(text);
    },
    randomUUID: () => 'simulated', path,
    SampleProbe: { async open() { return sample; } },
    RustGuard: SimulatedSoakGuard, GuardedSample, OwnedSampler: SimulatedSoakSampler,
    process: processStub, performance: { now: () => now },
    setTimeout(resolve, ms) {
      now += ms;
      if (phase === 'last-wait' && now >= durationMs) interrupt();
      resolve();
    },
    console: { log(text) { messages.push(text); }, error(text) { messages.push(text); } },
  };
  await new AsyncFunction(...Object.keys(bindings), source.replace(/^import .*;\r?\n/gm, ''))(...Object.values(bindings));
  return { result, exitCode: processStub.exitCode ?? 0, sample, fired, messages };
}

test('終了境界の模擬実行：正常時だけ参考測定を完了する', async () => {
  const run = await simulateSoakFinalBoundary();
  assert.equal(run.exitCode, 0);
  assert.equal(inspectSoakResult(run.result).acceptance, 'reference-only');
  assert.equal(run.sample.images.length, 12);
});

for (const phase of ['last-wait', 'final-resource']) {
  for (const event of ['cancelled', 'rust-child-lost']) {
    test(`終了境界の模擬実行：${phase}中の${event}を完了扱いにしない`, async () => {
      const run = await simulateSoakFinalBoundary(event, phase);
      assert.equal(run.fired, true);
      assert.equal(run.exitCode, 1);
      assert.equal(run.result.termination, event === 'cancelled' ? 'cancelled' : 'operation_failed');
      assert.equal(run.result.state, event === 'cancelled' ? 'Review' : 'NeedsAttention');
      if (event === 'rust-child-lost') assert.equal(run.sample.reason, 'rust_guard_failed');
      assert.throws(() => inspectSoakResult(run.result));
      assert.deepEqual(run.result.captures, run.sample.images);
      assert.equal(run.sample.images.length, 12);
      assert.ok(!run.messages.some(text => text.startsWith('継続測定終了。')));
    });
  }
}

test('終了境界の模擬実行：最終照会中のブラウザ切断を完了扱いにしない', async () => {
  const run = await simulateSoakFinalBoundary('browser-disconnected', 'final-resource');
  assert.equal(run.fired, true);
  assert.equal(run.exitCode, 1);
  assert.equal(run.result.termination, 'operation_failed');
  assert.equal(run.result.state, 'NeedsAttention');
  assert.equal(run.sample.reason, 'browser_closed');
  assert.throws(() => inspectSoakResult(run.result));
  assert.equal(run.sample.images.length, 12);
});
