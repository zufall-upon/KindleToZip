import { mkdir, open, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { SampleProbe } from './probe.mjs';
import { RustGuard, GuardedSample } from './rust-guard.mjs';
import { OwnedSampler } from '../../scripts/owned-sampler.mjs';

const argument = process.argv[2] ?? '';
if (process.argv.length !== 3 || !/^--seconds=\d+$/.test(argument)) throw new Error('duration_required');
const seconds = Number(argument.slice('--seconds='.length));
if (!Number.isInteger(seconds) || seconds < 6 || seconds > 600) throw new Error('unsupported_duration');
const directory = path.join('artifacts', 'soak-runs', randomUUID());
await mkdir(directory, { recursive: true });
if (seconds === 600) {
  // Reserve one formal run without replacing any previous result.
  const index = await open('artifacts/soak-current.json', 'wx');
  try { await index.writeFile(JSON.stringify({ receipt: path.join(directory, 'receipt.json').replaceAll('\\', '/') }) + '\n'); }
  finally { await index.close(); }
}
const result = {
  schemaVersion: 1, scope: 'self-authored-soak-reference', requestedSeconds: seconds,
  elapsedMs: 0, captures: [], advances: [], resources: [], termination: 'not-started',
  kindle: 'not-tested', at11Acceptance: 'not-claimed',
  resourceDefinition: 'owned-node-rust-chromium-sampler-only; working-set-may-double-count-shared-pages; periodic-cpu-can-miss-exited-process-time',
};
const guard = new RustGuard();
let sample;
let sampler;
let session;
let cancelled = false;
const cancel = () => { cancelled = true; sample?.stop(); };
process.on('SIGINT', cancel);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  sample = await SampleProbe.open({ headless: false });
  result.imageRoot = path.relative('.', sample.directory).replaceAll('\\', '/');
  const bridge = new GuardedSample(sample, guard);
  session = await sample.browser.newBrowserCDPSession();
  const processes = await session.send('SystemInfo.getProcessInfo');
  const browserPid = processes.processInfo.find(row => row.type === 'browser').id;
  bridge.requireVisibleWindow(browserPid);
  await bridge.approveAndStart();
  sampler = new OwnedSampler();
  result.environment = await sampler.ready;
  result.node = process.version;
  result.browser = sample.browser.version();
  const takeResourceSample = async () => {
    const { processInfo } = await session.send('SystemInfo.getProcessInfo');
    const pids = [process.pid, guard.child.pid, sampler.child.pid, ...processInfo.map(row => row.id)];
    const row = await sampler.sample(pids);
    result.resources.push(row);
  };
  await takeResourceSample();
  const started = performance.now();
  const durationMs = seconds * 1000;
  const stepMs = durationMs / 12;
  let nextCapture = 0;
  let nextResource = 5000;
  let nextProgress = 60_000;
  console.log(`自作試料の${seconds}秒継続測定を開始。利用者の操作停止は不要です。`);
  while (performance.now() - started < durationMs || nextCapture < 12) {
    if (cancelled || guard.failed || !sample.browser.isConnected()) throw new Error('soak_interrupted');
    const elapsed = performance.now() - started;
    if (nextCapture < 12 && elapsed >= nextCapture * stepMs) {
      result.captures.push(await bridge.capture());
      result.advances.push(await bridge.advance());
      nextCapture += 1;
    }
    if (elapsed >= nextResource) {
      await takeResourceSample();
      nextResource += 5000;
    }
    if (elapsed >= nextProgress) {
      console.log(`継続測定 ${Math.floor(elapsed / 1000)}秒。確定画像${nextCapture}枚。`);
      nextProgress += 60_000;
    }
    const untilNextCapture = nextCapture < 12 ? nextCapture * stepMs - (performance.now() - started) : 1000;
    await sleep(Math.max(1, Math.min(1000, untilNextCapture, durationMs - (performance.now() - started))));
  }
  await takeResourceSample();
  // The final wait/sample can also lose authorization or receive cancellation.
  // Do not yield between this check and committing the completion status.
  if (cancelled || guard.failed || !sample.browser.isConnected()) throw new Error('soak_interrupted');
  result.elapsedMs = performance.now() - started;
  result.termination = 'end_candidate';
  result.state = sample.state;
  console.log('継続測定終了。数値基準未合意の参考測定で、AT11・G02・Kindle合格ではありません。');
} catch {
  result.termination = cancelled ? 'cancelled' : 'operation_failed';
  result.state = sample?.state ?? 'not-opened';
  console.error('継続測定は未完了で停止しました。取得済み画像と結果を保持します。');
  process.exitCode = 1;
} finally {
  try {
    await writeFile(path.join(directory, 'receipt.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  } finally {
    await sampler?.close();
    await session?.detach().catch(() => {});
    await sample?.close();
    await guard.close();
    process.off('SIGINT', cancel);
  }
  console.log(`参考測定レシート: ${directory.replaceAll('\\', '/')}/receipt.json`);
}
