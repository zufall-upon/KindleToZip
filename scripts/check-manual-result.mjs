import assert from 'node:assert/strict';
import { readFile, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { PNG } from 'pngjs';
import { manualResultFiles } from './manual-result-files.mjs';

const baseline = JSON.parse(await readFile('artifacts/manual-baseline.json', 'utf8'));
assert.equal(baseline.schemaVersion, 1);
assert.ok(Number.isFinite(Date.parse(baseline.preparedAt)));
assert.ok(Array.isArray(baseline.existing));
const fresh = (await manualResultFiles()).filter(file => !baseline.existing.includes(file));
assert.equal(fresh.length, 1, '今回の1回の実行に対応する新規レシートを一意に特定する');
const result = JSON.parse(await readFile(fresh[0], 'utf8'));
assert.equal(result.schemaVersion, 1);
assert.equal(result.scope, 'self-authored-manual-trial');
assert.equal(result.termination, 'end_candidate', '不明な終了や取得失敗は完了扱いにしない');
assert.equal(result.humanAssessment, 'pending', '機械検査で利用者の目視所見を代作しない');
assert.equal(result.actualHumanActions, 'not-observed-by-software');
assert.equal(result.kindle, 'not-tested');
assert.deepEqual(result.captures.map(row => row.position), Array.from({ length: 12 }, (_, i) => i + 1));
assert.equal(result.advances.length, 12);
for (const [index, row] of result.advances.entries()) {
  if (index < 11) assert.equal(row.position, index + 2);
  else assert.equal(row.endCandidate, true);
}
for (const row of [...result.captures, ...result.advances]) {
  for (const key of ['samples', 'foreground_changes', 'cursor_changes', 'missing_foreground_samples', 'missing_cursor_samples', 'elapsed_ms']) {
    assert.ok(Number.isSafeInteger(row[key]) && row[key] >= 0, `観測値 ${key}`);
  }
  assert.ok(row.samples > 1 && row.elapsed_ms >= 900);
  assert.equal(row.missing_foreground_samples, 0);
  assert.equal(row.missing_cursor_samples, 0);
}
const forbidden = new Set(['initial', 'last', 'foreground_pid', 'foreground', 'cursor_x', 'cursor_y', 'hwnd', 'pid', 'title', 'inputText']);
function noPrivateFields(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.ok(!forbidden.has(key), '機密情報を収集結果へ保存しない');
    noPrivateFields(child);
  }
}
noPrivateFields(result);
const hashes = [];
for (let id = 1; id <= 12; id += 1) {
  const file = path.join(path.dirname(fresh[0]), `${String(id).padStart(6, '0')}.png`);
  const stat = await lstat(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink());
  assert.ok(stat.size <= 32 * 1024 * 1024);
  const bytes = await readFile(file);
  const png = PNG.sync.read(bytes, { checkCRC: true });
  assert.deepEqual([png.width, png.height], [600, 480]);
  hashes.push(createHash('sha256').update(bytes).digest('hex'));
}
assert.equal(new Set(hashes).size, 12, '番号入り12画面が同一画像の反復ではない');
const sum = (rows, key) => rows.reduce((total, row) => total + row[key], 0);
console.log(JSON.stringify({
  receipt: fresh[0], captures: 12, advances: 11, endCandidates: 1,
  captureForegroundChanges: sum(result.captures, 'foreground_changes'),
  captureCursorChanges: sum(result.captures, 'cursor_changes'),
  advanceForegroundChanges: sum(result.advances, 'foreground_changes'),
  advanceCursorChanges: sum(result.advances, 'cursor_changes'),
  humanAssessment: 'pending', attribution: 'not-determined', kindle: 'not-tested',
}));
