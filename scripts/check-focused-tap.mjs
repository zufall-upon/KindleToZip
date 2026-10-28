import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const tap = await readFile('artifacts/portable-repair/final-focused.tap', 'utf8');
if (process.argv[2]) assert.equal(tap, await readFile(process.argv[2], 'utf8'), 'Retained TAP differs from the actual native output');
for (const name of ['Kindleプリセットの可視証拠と一時非表示', 'Kindle初回hiddenのページ内復帰候補', 'Kindleプリセット表示候補']) {
  assert.ok(tap.split('\n').some(line => /^ok \d+ - /.test(line) && line.includes(name)), `Missing completed focused test: ${name}`);
}
assert.match(tap, /^# tests 5\r?$/m);
assert.match(tap, /^# pass 5\r?$/m);
assert.match(tap, /^# fail 0\r?$/m);
assert.match(tap, /^# cancelled 0\r?$/m);
assert.match(tap, /^# duration_ms [0-9.]+\s*$/m);
assert.ok(!/^\s*not ok /m.test(tap));
console.log(JSON.stringify({ tests: 5, pass: 5, fail: 0, durationMs: Number(/^# duration_ms ([0-9.]+)/m.exec(tap)[1]), resultCollectionOnly: true }));
