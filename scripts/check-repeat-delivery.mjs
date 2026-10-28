import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, open, readdir, stat } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

// Read-only collection of the exact candidate and completed local public-UI
// operations. This never launches a reader or repeats an actual-book action.
const started = performance.now();
const build = 'artifacts/releases/build-20261027-082927-f07f9a61';
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const observation = name => json(`artifacts/portable-repair/${name}.json`);
const metadata = await json(`${build}/KindleToZip-Portable.json`);
const expected = 'f037b1f45ec81d5b414503a0094a6d96380b69774cf3d9d97853a1eed108dd79';
assert.equal(metadata.executableSha256, expected);
async function hash(file, start, end) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file, start === undefined ? {} : { start, end })) digest.update(chunk);
  return digest.digest('hex');
}
for (const file of [`${build}/KindleToZip-Portable.exe`, '_testenv/KindleToZip-Portable.exe']) {
  assert.equal(await hash(file), expected, 'Candidate/deployment hash mismatch');
  assert.equal((await stat(file)).size, metadata.executableBytes);
}
const smoke = await json('artifacts/distribution-tests/run-34173668f148/smoke-result.json');
assert.equal(smoke.executableSha256, expected);
assert.equal(smoke.exitCode, 0);
assert.equal(smoke.firstLaunch.result, 'pass');
assert.equal(smoke.wholeFolderMove.resumed.result, 'pass');
assert.equal(smoke.firstLaunch.publicRepeatTarget.diagnosis, 'reader_library_selected');
assert.equal(smoke.firstLaunch.publicRepeatTarget.images, 0);
assert.equal(smoke.firstLaunch.publicRepeatTarget.approval, false);
assert.deepEqual(smoke.firstLaunch.publicRepeatTarget.previews, Array(3).fill([1120, 720]));
const sources = new Set(smoke.sourceMatched);
async function collect(directory = 'app') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) await collect(`${directory}/${entry.name}`);
    else { assert.ok(entry.isFile()); sources.add(`${directory}/${entry.name}`); }
  }
}
await collect();
const file = await open(`${build}/KindleToZip-Portable.exe`, 'r');
try {
  async function bytes(offset, length) {
    const buffer = Buffer.alloc(length);
    let received = 0;
    while (received < length) {
      const result = await file.read(buffer, received, length - received, offset + received);
      assert.ok(result.bytesRead > 0, 'Truncated package'); received += result.bytesRead;
    }
    return buffer;
  }
  const footer = await bytes(metadata.executableBytes - 56, 56);
  assert.equal(footer.subarray(0, 8).toString(), 'KTZEND01');
  const stub = Number(footer.readBigUInt64LE(8)), payload = Number(footer.readBigUInt64LE(16));
  assert.equal(stub, metadata.launcherStubBytes);
  assert.equal(payload, metadata.payloadBytes);
  assert.equal(stub + payload + 56, metadata.executableBytes);
  assert.equal(footer.subarray(24).toString('hex'), metadata.payloadSha256);
  assert.equal(await hash(`${build}/KindleToZip-Portable.exe`, stub, stub + payload - 1), metadata.payloadSha256);
  const header = await bytes(stub, 12);
  assert.equal(header.subarray(0, 8).toString(), 'KTZBNDL1');
  const pending = new Set(sources), seen = new Set();
  let offset = stub + 12;
  for (let i = 0; i < header.readUInt32LE(8); i++) {
    assert.ok(offset + 10 <= stub + payload);
    const entry = await bytes(offset, 10);
    const nameLength = entry.readUInt16LE(0), length = Number(entry.readBigUInt64LE(2));
    assert.ok(nameLength > 0 && nameLength <= 4096 && Number.isSafeInteger(length) && length >= 0);
    assert.ok(offset + 10 + nameLength + length <= stub + payload);
    const name = (await bytes(offset + 10, nameLength)).toString('utf8');
    assert.ok(!seen.has(name)); seen.add(name); offset += 10 + nameLength;
    if (pending.has(name)) {
      const source = await readFile(name);
      assert.deepEqual(await bytes(offset, length), source, `Candidate source differs: ${name}`);
      assert.deepEqual(await readFile(`_testenv/runtime/0.1.0-${metadata.payloadSha256.slice(0, 12)}/${name}`), source, `Running source differs: ${name}`);
      pending.delete(name);
    } else assert.ok(!name.startsWith('app/'), 'Unexpected app source');
    offset += length;
  }
  assert.equal(offset, stub + payload); assert.equal(pending.size, 0);
} finally { await file.close(); }
const before = await observation('repeat-before-update');
const close = await observation('repeat-normal-close');
const restart = await observation('repeat-restart');
assert.equal(close.normalWindowClose, true);
assert.equal(close.launcherExited, true); assert.equal(close.readerExited, true);
assert.equal(close.controlExited, true); assert.equal(close.forcedTermination, false);
assert.ok(close.launcherExitCode === null || close.launcherExitCode === 0);
assert.equal(restart.candidateSha256, expected);
assert.ok(Date.parse(before.observedAtUtc) < Date.parse(close.observedAtUtc));
assert.ok(Date.parse(close.observedAtUtc) < Date.parse(restart.observedAtUtc));
let last = Date.parse(restart.observedAtUtc);
for (const name of ['repeat-restored-session', 'repeat-session-second', 'repeat-session-third']) {
  const current = await observation(name);
  assert.ok(Date.parse(current.observedAtUtc) > last); last = Date.parse(current.observedAtUtc);
  assert.equal(current.controlPid, restart.controlPid); assert.equal(current.readerPid, restart.readerPid);
  assert.equal(current.quiescent, true); assert.equal(current.persistentProfile, true);
  assert.equal(current.titleVisible, true); assert.equal(current.positionVisible, true);
  for (const key of ['profileDigest', 'bookPositionDigest', 'configurationDigest', 'currentJobPath']) {
    // Never let assertion diagnostics include private comparison values.
    assert.ok(current[key] === before[key], `Preserved ${key} differs`);
  }
  assert.deepEqual(current.settings, before.settings);
  assert.ok(JSON.stringify(current.existingFiles) === JSON.stringify(before.existingFiles), 'Existing jobs/images/outputs changed');
  assert.equal(current.rawBookUrlCredentialsEmitted, false);
}
const durations = [];
for (const [index, name] of ['first', 'second', 'third'].entries()) {
  const result = await observation(`repeat-updated-${name}`);
  assert.equal(result.publicAction, index === 2 ? 'Preview' : 'AutoPreview');
  for (const key of ['previewDisplayed', 'centralNonUniform', 'centralNotBlack', 'approvalRequired', 'approvalUnchecked', 'decisionDisabled']) assert.equal(result[key], true, key);
  assert.equal(result.previewFailed, false); assert.equal(result.inspecting, false);
  assert.deepEqual(result.dimensions, ['1100×850', '2200×1700']);
  assert.deepEqual(result.knownCodes, []); assert.deepEqual(result.causes, []);
  assert.ok(result.operationElapsedMs >= 1800 && result.operationElapsedMs < 15000);
  durations.push(result.operationElapsedMs);
}
const os = await observation('repeat-os-observations');
assert.equal(os.length, 2);
assert.deepEqual(os.map(item => item.action), ['AutoPreview', 'Preview']);
// Observation is not attribution: user activity can change cursor/foreground.
// Preserve actual booleans, never convert them into a claimed invariant.
for (const item of os) { assert.equal(typeof item.cursorUnchanged, 'boolean'); assert.equal(typeof item.foregroundUnchanged, 'boolean'); }
console.log(JSON.stringify({ candidateSha256: expected, sourceFilesMatched: sources.size,
  existingFilesUnchanged: Object.keys(before.existingFiles).length, savedSessionBookPositionUnchanged: true,
  actualBookPreviews: 3, pngDimensions: [2200, 1700], publicActionMs: durations,
  portableSampleResultReused: true, portableSampleElapsedSeconds: smoke.elapsedSeconds,
  osObservations: os, originalAttachmentCauseConfirmed: false, realPageTurningOrAcquisition: false,
  elapsedMs: Math.round(performance.now() - started) }));
