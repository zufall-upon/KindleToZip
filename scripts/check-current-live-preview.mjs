import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { open, readFile, readdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const started = performance.now();
const builds = (await readdir('artifacts/releases', { withFileTypes: true })).filter(item => item.isDirectory() && /^build-[a-z0-9-]+$/.test(item.name)).map(item => item.name).sort();
const buildDirectory = process.argv[2] ?? `artifacts/releases/${builds.at(-1)}`;
assert.match(buildDirectory ?? '', /^artifacts\/releases\/build-[a-z0-9-]+$/);
const report = JSON.parse(await readFile(`${buildDirectory}/KindleToZip-Portable.json`, 'utf8'));
assert.equal(report.executable, 'KindleToZip-Portable.exe');
// A correction may produce a newer delivery without repeating the real-book
// operation. Keep its historical observation bound to the actual observed EXE.
const deliveryDirectory = process.argv[3] ?? buildDirectory;
assert.match(deliveryDirectory, /^artifacts\/releases\/build-[a-z0-9-]+$/);
const delivery = JSON.parse(await readFile(`${deliveryDirectory}/KindleToZip-Portable.json`, 'utf8'));
assert.equal(delivery.executable, 'KindleToZip-Portable.exe');
const observation = JSON.parse(await readFile('artifacts/portable-repair/live-final-preview.json', 'utf8'));
assert.equal(observation.candidateSha256, report.executableSha256);
assert.equal(observation.previewDisplayed, true);
assert.equal(observation.previewFailed, false);
assert.equal(observation.centralNonUniform, true);
assert.equal(observation.centralNotBlack, true);
assert.deepEqual(observation.initialHiddenRecovered, ['identity']);
assert.equal(observation.approvalRequired, true);
assert.equal(observation.approvalUnchecked, true);
assert.equal(observation.decisionDisabled, true);
assert.equal(observation.osCursorUnchanged, true);
assert.equal(observation.foregroundUnchanged, true);
assert.equal(observation.dimensions.length, 2);
const dimensions = observation.dimensions[1].split('×').map(Number);
assert.ok(dimensions.length === 2 && dimensions.every(value => Number.isInteger(value) && value > 0));
async function hashFile(file, start, end) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file, start === undefined ? {} : { start, end })) hash.update(bytes);
  return hash.digest('hex');
}
const sources = [];
async function collect(directory = 'app') {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const file = path.posix.join(directory, item.name);
    if (item.isDirectory()) await collect(file);
    else {
      assert.ok(item.isFile());
      sources.push(file);
    }
  }
}
await collect();
const sourceFiles = sources.length;
sources.push('poc/browser/fixture-server.mjs', 'poc/fixtures/reader-kindle-chrome.html', 'poc/fixtures/reader-kindle-chrome.js');

async function compareBundle(directory, metadata, resolveSource) {
  const executable = `${directory}/KindleToZip-Portable.exe`;
  assert.equal(metadata.executablePath, executable);
  assert.equal((await stat(executable)).size, metadata.executableBytes);
  assert.equal(await hashFile(executable), metadata.executableSha256);
  const file = await open(executable, 'r');
  try {
    const bytes = async (offset, length) => {
      const buffer = Buffer.alloc(length);
      let received = 0;
      while (received < length) {
        const result = await file.read(buffer, received, length - received, offset + received);
        assert.ok(result.bytesRead > 0, 'Truncated bundle');
        received += result.bytesRead;
      }
      return buffer;
    };
    const footer = await bytes(metadata.executableBytes - 56, 56);
    assert.equal(footer.subarray(0, 8).toString('ascii'), 'KTZEND01');
    const stub = Number(footer.readBigUInt64LE(8)), payload = Number(footer.readBigUInt64LE(16));
    assert.equal(stub, metadata.launcherStubBytes);
    assert.equal(payload, metadata.payloadBytes);
    assert.equal(stub + payload + 56, metadata.executableBytes);
    assert.equal(footer.subarray(24).toString('hex'), metadata.payloadSha256);
    assert.equal(await hashFile(executable, stub, stub + payload - 1), metadata.payloadSha256);
    const header = await bytes(stub, 12);
    assert.equal(header.subarray(0, 8).toString('ascii'), 'KTZBNDL1');
    const pending = new Set(sources), seen = new Set();
    let offset = stub + 12;
    for (let index = 0; index < header.readUInt32LE(8); index++) {
      assert.ok(offset + 10 <= stub + payload);
      const entry = await bytes(offset, 10);
      const nameLength = entry.readUInt16LE(0), length = Number(entry.readBigUInt64LE(2));
      assert.ok(nameLength > 0 && nameLength <= 4096 && Number.isSafeInteger(length) && length >= 0);
      assert.ok(offset + 10 + nameLength + length <= stub + payload);
      const name = (await bytes(offset + 10, nameLength)).toString('utf8');
      assert.ok(!seen.has(name), 'Duplicate bundle entry');
      seen.add(name); offset += 10 + nameLength;
      if (pending.has(name)) {
        assert.deepEqual(await bytes(offset, length), await readFile(resolveSource(name)), `Bundle source mismatch: ${name}`);
        pending.delete(name);
      } else assert.ok(!name.startsWith('app/'), `Unexpected app source: ${name}`);
      offset += length;
    }
    assert.equal(offset, stub + payload);
    assert.equal(pending.size, 0, 'Missing bundle sources');
  } finally { await file.close(); }
}
// Historical runtime bytes must match the historically observed payload, not
// the corrected source. Current source bytes must match the delivered payload.
await compareBundle(buildDirectory, report, file => `_testenv/runtime/0.1.0-${report.payloadSha256.slice(0, 12)}/${file}`);
await compareBundle(deliveryDirectory, delivery, file => file);
assert.equal(await hashFile('_testenv/KindleToZip-Portable.exe'), delivery.executableSha256);
console.log(JSON.stringify({ initialHiddenField: 'identity', decodedPngDimensions: dimensions, centralNonUniform: true, centralNotBlack: true,
  approvalUnchecked: true, decisionDisabled: true, osCursorUnchanged: true, foregroundUnchanged: true,
  sourceFiles, fixtureFiles: 3, observedExecutableSha256: report.executableSha256,
  deliveredExecutableSha256: delivery.executableSha256, realOperationRepeated: false,
  elapsedMs: Math.round(performance.now() - started) }));
