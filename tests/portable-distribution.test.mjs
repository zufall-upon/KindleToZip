import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { selectLatestPortable } from '../scripts/portable-reports.mjs';

test('Portable固定名: 新旧metadata選択とPowerShell consumerが同じ最新を選ぶ', async () => {
  const root = path.resolve('artifacts/distribution-tests', `selection-${randomUUID()}`);
  const releases = path.join(root, 'artifacts/releases');
  const build = path.join(releases, 'build-20261027-test');
  await mkdir(build, { recursive: true });
  const old = { portable: true, executable: 'old-hash.exe', executablePath: 'artifacts/releases/old-hash.exe', createdAtUtc: '2026-10-26T00:00:00Z' };
  const current = { portable: true, executable: 'KindleToZip-Portable.exe', executablePath: 'artifacts/releases/build-20261027-test/KindleToZip-Portable.exe', createdAtUtc: '2026-10-27T00:00:00Z', executableSha256: 'retained-hash' };
  await writeFile(path.join(releases, 'old-hash.json'), JSON.stringify(old));
  assert.equal((await selectLatestPortable(root)).report.executable, old.executable);
  await writeFile(path.join(build, 'KindleToZip-Portable.json'), JSON.stringify(current));
  await writeFile(path.join(releases, 'escape.json'), JSON.stringify({ ...current, executablePath: '../outside.exe', createdAtUtc: '2099-01-01' }));
  const selected = await selectLatestPortable(root);
  assert.deepEqual(selected.report, current);
  const ps = spawnSync('pwsh', ['-NoProfile', '-Command', `. ./scripts/portable-reports.ps1; (Get-LatestPortableReport '${root.replaceAll("'", "''")}').Report | ConvertTo-Json -Compress`], { encoding: 'utf8' });
  assert.equal(ps.status, 0, ps.stderr);
  assert.deepEqual(JSON.parse(ps.stdout), current);
  const buildSource = await readFile('scripts/build-distribution.ps1', 'utf8');
  assert.match(buildSource, /\$destinationName = "KindleToZip-Portable\.exe"/);
  assert.match(buildSource, /deploy-portable\.ps1/);
});

test('Portable配置: 初回・更新・ロック・hash不一致・missing source・reparse拒否と既存データ保全', () => {
  const result = spawnSync('pwsh', ['-NoProfile', '-File', 'scripts/test-portable-deployment.ps1'], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /deployment-regression: pass/);
});
