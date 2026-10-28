import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
const started = Date.now();
const [reportPath, evidence] = process.argv.slice(2);
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const report = await json(reportPath);
const result = await json(path.join(evidence, 'result.json'));
const resume = await json(path.join(evidence, 'capture-resume-result.json'));
const hash = async (file, start, end) => {
  const value = createHash('sha256');
  for await (const bytes of createReadStream(file, start === undefined ? {} : { start, end })) value.update(bytes);
  return value.digest('hex');
};
assert.equal(report.executable, 'KindleToZip-Portable.exe');
assert.equal(report.portable, true);
assert.equal((await stat(report.executablePath)).size, report.executableBytes);
for (const file of [report.executablePath, '_testenv/KindleToZip-Portable.exe', path.join(evidence, report.executable)]) {
  assert.equal(await hash(file), report.executableSha256, file);
}
assert.equal(result.executableSha256, report.executableSha256);
for (const field of ['anonymousPortable', 'sameNameDistinctFoldersSaved', 'resetCancelKeepAndConsent', 'zipPreserved', 'retakenZipSaved']) assert.equal(result[field], true);
for (const field of ['userDataOpened', 'realBookAcquisition', 'authenticationPerformed']) assert.equal(result[field], false);
assert.deepEqual(result.nativeLanguages.map(item => item.language), ['English', '简体中文', '日本語']);
assert.ok(result.nativeLanguages.every(item => item.publicSelection === true));
assert.deepEqual({ count: resume.stoppedCount, position: resume.stoppedPosition, failure: resume.failure }, {
  count: 67, position: '136', failure: { stage: 'capture', code: 'reader_ui_unknown', detail: { field: 'next', cause: 'not_unique' }, advanceDispatch: 'sent', committedImages: 67 },
});
assert.equal(resume.continuedCount, 71); assert.equal(resume.finalCount, 73); assert.equal(resume.turns, 72);
assert.equal(resume.retainedOriginals, true); assert.equal(resume.noDuplicateOrMissing, true);
assert.equal(resume.freshResumeConfirmation, true);
assert.equal(resume.samePositionDifferentPixelsBlocked, true);
for (const language of ['ja', 'en', 'zh-CN']) {
  for (const prefix of ['resume-', 'portable-language-']) assert.ok((await stat(path.join(evidence, `${prefix}${language}.png`))).size > 1000);
}
const sources = new Map();
async function add(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = `${directory}/${entry.name}`;
    if (file === 'poc/fixtures/RIGHTS.md') continue;
    if (entry.isDirectory()) await add(file);
    else { assert.equal(entry.isFile(), true); sources.set(file, file); }
  }
}
await add('app'); await add('poc/fixtures');
for (const file of ['poc/browser/fixture-server.mjs', 'poc/browser/public-ui-controls.mjs', 'poc/launcher/smoke.mjs']) sources.set(file, file);
sources.set('controller/ktz-g02-controller.exe', 'artifacts/rust-target/release/ktz-g02-controller.exe');
const count = sources.size;
const exe = await open(report.executablePath, 'r');
try {
  const bytes = async (offset, length) => {
    const buffer = Buffer.alloc(length); let read = 0;
    while (read < length) { const value = await exe.read(buffer, read, length - read, offset + read); assert.ok(value.bytesRead > 0); read += value.bytesRead; }
    return buffer;
  };
  const footer = await bytes(report.executableBytes - 56, 56);
  assert.equal(footer.subarray(0, 8).toString(), 'KTZEND01');
  const stub = Number(footer.readBigUInt64LE(8)), size = Number(footer.readBigUInt64LE(16));
  assert.equal(stub + size + 56, report.executableBytes);
  assert.equal(footer.subarray(24).toString('hex'), report.payloadSha256);
  assert.equal(await hash(report.executablePath, stub, stub + size - 1), report.payloadSha256);
  assert.equal(await hash(report.executablePath, 0, stub - 1), await hash('artifacts/toolchains/launcher-target/release/kindle-to-zip-launcher.exe'));
  const header = await bytes(stub, 12); assert.equal(header.subarray(0, 8).toString(), 'KTZBNDL1');
  let offset = stub + 12; const seen = new Set();
  for (let index = 0; index < header.readUInt32LE(8); index++) {
    const metadata = await bytes(offset, 10), nameLength = metadata.readUInt16LE(0), length = Number(metadata.readBigUInt64LE(2));
    assert.ok(nameLength > 0 && nameLength <= 4096 && Number.isSafeInteger(length) && length >= 0);
    const name = (await bytes(offset + 10, nameLength)).toString(); assert.ok(!seen.has(name)); seen.add(name);
    offset += 10 + nameLength; assert.ok(offset + length <= stub + size);
    if (sources.has(name)) { assert.deepEqual(await bytes(offset, length), await readFile(sources.get(name)), name); sources.delete(name); }
    else assert.ok(!name.startsWith('app/'));
    offset += length;
  }
  assert.equal(offset, stub + size); assert.equal(sources.size, 0, [...sources.keys()].join(', '));
} finally { await exe.close(); }
console.log(JSON.stringify({ executable: report.executablePath, sha256: report.executableSha256, matchedSourceFiles: count,
  retainedNativeEvidence: evidence, elapsedSeconds: (Date.now() - started) / 1000, reranBuildOrApp: false }));
