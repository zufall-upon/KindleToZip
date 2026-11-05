// Explicit, anonymous-only check. It uses a new data directory and never
// opens a real profile or service. The ordinary GUI remains app/main.mjs.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startApplication } from '../app/server.mjs';
import { sampleConfig } from '../app/sample-reader-config.mjs';
import { PNG } from 'pngjs';
import { captureOwnedTemp, removeOwnedTemp } from '../app/startup-cleanup.mjs';

export async function selfCheck(base, { headless = false } = {}) {
  // Match main.mjs: this is a newly owned temporary root. Retain it whenever
  // application shutdown or identity confirmation is unknown.
  const temporary = await mkdtemp(path.join(tmpdir(), 'ktz-'));
  const identity = await captureOwnedTemp(temporary);
  for (const key of ['KTZ_TEMP_DIR', 'TMPDIR', 'TMP', 'TEMP', 'HOME', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME']) process.env[key] = temporary;
  const data = path.join(base, `self-check-${randomUUID()}`);
  const running = await startApplication({ dataDir: data, ownsSignals: true });
  const app = running.app;
  try {
    await app.command('create');
    // Portable Kindle is now selectable, but an explicit owned saved ID is
    // mandatory; without it no live Reader or browser may be created.
    await assert.rejects(app.command('openBrowser', { mode: 'kindle' }), { code: 'select_saved_session' });
    assert.equal(app.reader, undefined);
    const opened = await app.command('openBrowser', { mode: headless ? 'sample' : 'owned-fixture' });
    assert.equal(opened.readerTabs.length, 1);
    await app.command('selectReaderTab', { id: opened.readerTabs[0].id });
    const preview = await app.command('preview', { config: sampleConfig });
    assert.equal(preview.job.manifest.images.length, 0);
    await assert.rejects(app.command('start', { confirmed: true }), { code: 'explicit_start_required' });
    if (!headless) await assert.rejects(app.command('approve', { confirmed: true }), { code: 'invalid_capture_limit' });
    const approved = await app.command('approve', { confirmed: true, maxCaptures: 1 });
    assert.equal(approved.job.manifest.images.length, 0);
    await app.command('start', { confirmed: true });
    const deadline = Date.now() + 30_000; let stopped;
    do {
      stopped = await app.snapshot();
      if (stopped.state === 'Review' && !stopped.busy) break;
      if (stopped.state === 'NeedsAttention') throw new Error(`capture_failed:${stopped.reason}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    assert.equal(stopped.state, 'Review');
    assert.equal(stopped.reason, 'capture_limit_reached');
    assert.equal(stopped.job.manifest.images.length, 1);
    const image = stopped.job.manifest.images[0];
    const original = await app.image(image.capture_id, true);
    await app.command('crop', { id: image.capture_id, x: 1, y: 1, width: image.width - 2, height: image.height - 2 });
    const edited = await app.image(image.capture_id);
    assert.notDeepEqual(edited, original);
    assert.deepEqual([PNG.sync.read(edited).width, PNG.sync.read(edited).height], [image.width - 2, image.height - 2]);
    assert.deepEqual(await app.image(image.capture_id, true), original);
    const destination = path.join(data, 'anonymous.zip');
    const exported = await app.command('export', { destination, format: 'zip', rangeConfirmed: true });
    const bytes = await readFile(destination);
    assert.equal(bytes.readUInt32LE(0), 0x04034b50);
    const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    assert.ok(end >= 0);
    assert.equal(bytes.readUInt16LE(end + 10), 1);
    const central = bytes.readUInt32LE(end + 16);
    assert.equal(bytes.readUInt32LE(central), 0x02014b50);
    const local = bytes.readUInt32LE(central + 42), size = bytes.readUInt32LE(central + 24);
    assert.equal(bytes.readUInt16LE(local + 8), 0); // stored PNG, as in the existing archive oracle
    const content = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    assert.deepEqual(bytes.subarray(content, content + size), edited);
    assert.equal(exported.job.manifest.exports.at(-1).sha256, createHash('sha256').update(bytes).digest('hex'));
    await assert.rejects(app.command('export', { destination, format: 'zip', rangeConfirmed: true }), { code: 'output_exists' });
    assert.deepEqual(await readFile(destination), bytes);
    await app.command('closeBrowser');
  } finally {
    await running.close();
    await removeOwnedTemp(identity, data);
  }
  console.log(`匿名self-check成功: 1画面・Review・crop・ZIP、${headless ? '同梱headless reader' : 'Snap所有reader'}正常終了。保存先: ${data}`);
}
