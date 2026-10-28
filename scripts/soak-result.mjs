import assert from 'node:assert/strict';

export function inspectSoakResult(result, expectedSeconds = 600) {
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.scope, 'self-authored-soak-reference');
  assert.equal(result.requestedSeconds, expectedSeconds);
  assert.equal(result.termination, 'end_candidate', '中断・失敗を完了扱いにしない');
  assert.equal(result.state, 'NeedsAttention');
  assert.equal(result.kindle, 'not-tested');
  assert.equal(result.at11Acceptance, 'not-claimed');
  assert.ok(Number.isFinite(result.elapsedMs) && result.elapsedMs >= expectedSeconds * 1000);
  assert.deepEqual(result.captures.map(image => image.position), Array.from({ length: 12 }, (_, i) => i + 1));
  for (const [index, image] of result.captures.entries()) {
    assert.equal(image.id, index + 1);
    assert.equal(image.file, `${String(index + 1).padStart(6, '0')}.png`);
    assert.match(image.sha256, /^[0-9a-f]{64}$/);
    assert.ok(Number.isSafeInteger(image.bytes) && image.bytes > 0 && image.bytes <= 32 * 1024 * 1024);
  }
  assert.equal(new Set(result.captures.map(image => image.sha256)).size, 12);
  assert.equal(result.advances.length, 12);
  for (let i = 0; i < 11; i += 1) assert.equal(result.advances[i].position, i + 2);
  assert.equal(result.advances[11].endCandidate, true);
  assert.ok(Number.isInteger(result.environment.logicalProcessors) && result.environment.logicalProcessors > 0);
  assert.ok(Number.isSafeInteger(result.environment.physicalMemoryBytes) && result.environment.physicalMemoryBytes > 0);
  assert.ok(result.resources.length >= Math.floor(expectedSeconds / 5));
  let previousElapsed = -1;
  let previousCpu = -1;
  for (const row of result.resources) {
    for (const key of ['elapsedMs', 'cpuMilliseconds', 'workingSetBytes', 'privateBytes', 'processCount', 'missingProcesses']) {
      assert.ok(Number.isFinite(row[key]) && row[key] >= 0, `不正な計測値 ${key}`);
    }
    assert.ok(row.elapsedMs >= previousElapsed && row.cpuMilliseconds >= previousCpu);
    assert.ok(row.processCount > 0);
    previousElapsed = row.elapsedMs;
    previousCpu = row.cpuMilliseconds;
  }
  const last = result.resources.at(-1);
  assert.ok(last.elapsedMs >= expectedSeconds * 1000);
  return {
    elapsedSeconds: result.elapsedMs / 1000,
    resourceSamples: result.resources.length,
    averageCpuPercentOfMachine: last.cpuMilliseconds / last.elapsedMs / result.environment.logicalProcessors * 100,
    peakSummedWorkingSetBytes: Math.max(...result.resources.map(row => row.workingSetBytes)),
    peakSummedPrivateBytes: Math.max(...result.resources.map(row => row.privateBytes)),
    missingProcessSamples: result.resources.reduce((sum, row) => sum + row.missingProcesses, 0),
    acceptance: 'reference-only',
  };
}
